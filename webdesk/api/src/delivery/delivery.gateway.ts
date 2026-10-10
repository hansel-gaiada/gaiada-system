// WSK-48a — the HTTP edge of the /v1 delivery path: a RAW Fastify route, not a Nest controller.
//
// WHY RAW: the contract is byte-for-byte what the Payload-hosted router produced (status, body
// bytes, `content-type`, `Cache-Tag`, RFC 9457 problem+json). A Nest controller would put four
// framework behaviours between the router and the wire, each of which changes bytes:
//   - the exception filter rewrites any thrown error to { statusCode, message } JSON;
//   - Fastify's `reply.send(string)` can append `; charset=utf-8` to a content-type that the
//     contract fixes as exactly `application/json` / `application/xml` / `application/problem+json`;
//   - unmatched paths/methods get Nest's/Fastify's own 404/405 instead of the router's problem body;
//   - a request body with an unsupported (or malformed JSON) content-type is refused with Fastify's
//     415/400 before any handler runs, so "unknown method -> the router's own 405" would not hold
//     for a POST that carries a body.
// So: one encapsulated Fastify plugin owns `/v1/*` outright, drops every content-type parser (the
// router never reads a body — every non-GET is answered 405 without one), hands the router a Web
// Request, and writes the Web Response to the underlying Node response itself (`reply.hijack()`),
// with an explicit content-length and exactly the headers the router set.
//
// Route precedence (find-my-way): the more specific Nest routes that also live under /v1
// (`/v1/t/:tenantSlug/forms/...`, `/v1/t/:tenantSlug/media/...`) win over this wildcard; everything
// else under /v1 is the router's. See test/delivery/delivery-routing.spec.ts.
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DbService } from "../db/db.service";
import { TenantQuotaService } from "../rate-limit/tenant-quota.service";
import { DeliveryAuthService } from "./delivery-auth.service";
import { deliveryDbFrom } from "./db";
import { createV1Handler, type AuthGate } from "./router";
import { problemDetails, problemResponse } from "./vocabulary/problem-details";

const logger = new Logger("DeliveryGateway");

// Every method Fastify 4 can route. The router (not Fastify) decides that all but GET are 405.
const ALL_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

// Only authorization and x-request-id can matter to the router — but copying every header is
// harmless and keeps the adapter free of a second allowlist to maintain.
function toWebRequest(req: FastifyRequest): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    try {
      headers.append(name, Array.isArray(value) ? value.join(", ") : value);
    } catch {
      /* a header value the Web Headers API refuses can never be one the router reads */
    }
  }
  // Fixed authority on purpose: the router only reads pathname + searchParams, and the Host header
  // is client-controlled.
  return new Request(`http://delivery.internal${req.raw.url ?? "/"}`, { method: req.method, headers });
}

@Injectable()
export class DeliveryGateway implements OnModuleInit {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly db: DbService,
    private readonly auth: DeliveryAuthService,
    private readonly quota: TenantQuotaService,
  ) {}

  onModuleInit(): void {
    const fastify = this.adapterHost.httpAdapter.getInstance() as FastifyInstance;

    const handleV1 = createV1Handler({
      db: deliveryDbFrom(this.db),
      resolveTenantBySlug: (slug) => this.auth.resolveTenantBySlug(slug),
      resolveApiKey: (tenant, key) => this.auth.resolveApiKey(tenant, key),
      // The api's per-tenant READ quota (WSK-05 amendment), the same TenantQuotaService counter the
      // guarded routes use — keyed by tenant, shared across that tenant's keys. In-quota requests
      // get the same X-RateLimit-* headers TenantQuotaGuard sets and an otherwise untouched
      // response (status/body/content-type/Cache-Tag identical). Over quota: 429 in the frozen
      // problem+json envelope (not TenantQuotaGuard's ad-hoc `{ error, resetAt }`), because /v1's
      // contract is "one error shape for every failure".
      onAuthenticated: async (auth, { instance, requestId }): Promise<AuthGate> => {
        const d = await this.quota.consume(auth.tenantId);
        const headers: Record<string, string> = {
          "x-ratelimit-limit": String(d.limit),
          "x-ratelimit-remaining": String(d.remaining),
          "x-ratelimit-reset": String(Math.ceil(d.resetAt / 1000)),
        };
        if (d.allowed) return { headers };
        headers["retry-after"] = String(Math.max(1, Math.ceil((d.resetAt - Date.now()) / 1000)));
        return {
          headers,
          reject: problemResponse(
            problemDetails({
              slug: "rate-limited",
              title: "Too many requests",
              status: 429,
              detail: "Per-tenant read quota exceeded; retry after the window resets.",
              instance,
              requestId,
            }),
          ),
        };
      },
    });

    const handler = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      reply.hijack(); // from here the Node response is ours: no Fastify serializer, hooks or charset
      const raw = reply.raw;
      let status: number;
      let headers: Record<string, string>;
      let body: Buffer;
      try {
        const response = await handleV1(toWebRequest(req));
        status = response.status;
        headers = {};
        response.headers.forEach((value, name) => {
          headers[name] = value;
        });
        body = Buffer.from(await response.arrayBuffer());
      } catch (err) {
        // The router answers its own failures as problem+json; this is only reachable if building
        // the Request itself threw. Same shape, same status the router uses for "internal error" —
        // and, like the router, never the thrown message (M3 T1): that goes to the server log.
        logger.error(`delivery edge failure on ${String(req.raw.url ?? "/").split("?")[0]}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        const response = problemResponse(
          problemDetails({
            slug: "internal-error",
            title: "Internal error",
            status: 500,
            detail: "The server could not complete this request.",
            instance: String(req.raw.url ?? "/").split("?")[0],
            requestId: String(req.headers["x-request-id"] ?? req.id),
          }),
        );
        status = response.status;
        headers = { "content-type": "application/problem+json" };
        body = Buffer.from(await response.arrayBuffer());
      }
      headers["content-length"] = String(body.length);
      raw.writeHead(status, headers);
      raw.end(req.method === "HEAD" ? undefined : body);
    };

    // Encapsulated: the parser reset below must not leak into the rest of the api (media upload,
    // the control plane etc. depend on the default JSON parser and its 400/415 behaviour).
    void fastify.register(async (scope) => {
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser("*", (_req, payload, done) => {
        payload.resume(); // the router never reads a body; drain it so the socket is reusable
        done(null, undefined);
      });
      scope.route({ method: [...ALL_METHODS], url: "/v1/*", handler });
    });
  }
}
