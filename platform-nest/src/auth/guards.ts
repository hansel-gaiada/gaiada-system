// Auth guards (Nest port of server.ts serviceAuth + authenticate). Same two credential
// shapes and fail-closed semantics; guards populate request.principal and throw
// UnauthorizedException (401) instead of writing a Fastify reply.
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { config } from "../config";
import { assemblePrincipal, ANONYMOUS } from "../rbac/principal";
import { setRequestVia } from "../core/request-context";
import { principalFromToken } from "./oidc";
import { withGlobal } from "../db";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function bearerOf(req: FastifyRequest): string {
  const h = req.headers.authorization ?? "";
  const s = Array.isArray(h) ? h[0] : h;
  return s?.startsWith("Bearer ") ? s.slice(7) : "";
}

/** Service-token-only routes (bot/hub): /principal/resolve, /identity/enroll/confirm, /dev/*. */
@Injectable()
export class ServiceGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    if (!config.serviceToken || !safeEqual(bearerOf(req), config.serviceToken)) {
      throw new UnauthorizedException("unauthorized");
    }
    return true;
  }
}

/** Authenticated-user gate for /api + user-initiated routes. OIDC JWT, or service token +
 *  (x-user-id in dev | OBO envelope). Populates request.principal. */
@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const bearer = bearerOf(req);

    // OIDC user path — a valid IdP token authenticates the user directly.
    // "hybrid" (local dev) accepts BOTH an IdP JWT here AND the dev x-user-id path below,
    // so real SSO and the service-token/dev-login BFF can coexist. Prod uses "oidc".
    if ((config.authMode === "oidc" || config.authMode === "hybrid") && bearer && bearer !== config.serviceToken) {
      try {
        const principal = await principalFromToken(bearer);
        if (principal) {
          req.principal = principal;
          return true;
        }
        throw new UnauthorizedException("unknown or inactive user");
      } catch (e) {
        if (e instanceof UnauthorizedException) throw e;
        // not a JWT — fall through to service-credential paths
      }
    }

    // Everything below is a SERVICE call and must present the service token (fail-closed).
    if (!config.serviceToken || !safeEqual(bearer, config.serviceToken)) {
      throw new UnauthorizedException("unauthorized");
    }

    // Dev mode: the acting user is named by x-user-id (local + tests). Also allowed in "hybrid".
    const userId = req.headers["x-user-id"];
    if ((config.authMode === "dev" || config.authMode === "hybrid") && typeof userId === "string" && userId) {
      const principal = await assemblePrincipal(userId, "high");
      if (!principal) throw new UnauthorizedException("unknown or inactive user");
      req.principal = principal;
      return true;
    }

    // OBO envelope (D4): verified link → 'linked'; unverified/unknown → minimal principal.
    const provider = req.headers["x-obo-provider"];
    const externalId = req.headers["x-obo-external-id"];
    if (typeof provider === "string" && typeof externalId === "string" && provider && externalId) {
      // ── THE CO-AUTHOR (2026-08-20) ──────────────────────────────────────────────────────────────
      // `x-obo-agent` names the AGENT driving this call, when one is. The envelope still names the
      // human, so authority is unchanged — this is recorded alongside, never instead
      // ([agent-attribution-gate]). It is read from a header rather than inferred because the platform
      // genuinely cannot tell: `runAgent` sends the requesting human's envelope verbatim, so
      // `provider` is `whatsapp`/`platform` whether a person or their agent is driving.
      //
      // Trusting a header is safe HERE and only here: this block already requires the service token
      // (checked above), so the caller is the hub or another first-party service, not a browser. And
      // the value is authorization-NEUTRAL — nothing reads `via` to decide anything; it only ever
      // makes a write more attributable. A client that lies about it gains nothing and incriminates
      // an agent that did not act.
      const agentHeader = req.headers["x-obo-agent"];
      const via = {
        provider,
        externalId,
        ...(typeof agentHeader === "string" && agentHeader.trim() ? { agent: agentHeader.trim() } : {}),
      };
      const link = await withGlobal((c) =>
        c.query<{ user_id: string; verified_at: string | null }>(
          `SELECT user_id, verified_at FROM identity_links WHERE provider = $1 AND external_id = $2`,
          [provider, externalId],
        ),
      );
      // Ambient too, not only on the principal: `writeActivity` has 263 call sites and reads this from
      // request context rather than from a parameter nobody would remember to pass.
      setRequestVia(via);
      const row = link.rows[0];
      if (row?.verified_at) {
        const principal = await assemblePrincipal(row.user_id, "linked");
        if (principal) {
          req.principal = { ...principal, via };
          return true;
        }
      }
      // The anonymous principal keeps `via` too: an unauthenticated agent-driven call is still
      // agent-driven, and that is exactly the request whose provenance is worth recording.
      req.principal = { ...ANONYMOUS, via };
      return true;
    }
    throw new UnauthorizedException("x-user-id or an OBO envelope required");
  }
}
