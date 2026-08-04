// CP-5 — `GET /api/:t/portal/stream`: the portal's Server-Sent Events endpoint.
//
// Frames carry a topic and a timestamp and nothing else — see portal-live.service.ts's header for why
// that is the whole security argument. The browser's job on receiving one is to re-run its ordinary
// server-rendered reads, which re-authorize from scratch.
//
// ── FOUR OPERATIONAL DETAILS THAT ARE EASY TO GET WRONG AND EXPENSIVE TO DEBUG ────────────────────
//  1. `X-Accel-Buffering: no`. nginx buffers proxied responses by default, so an SSE stream behind it
//     delivers NOTHING until the buffer fills or the connection closes — the endpoint looks broken
//     while being perfectly correct. This header disables it per-response, which means the portal
//     works even on a vhost nobody remembered to configure. The vhost `proxy_buffering off` block in
//     infra/nginx/ is belt-and-braces, not the mechanism.
//  2. A heartbeat comment every 25s. Idle connections are reaped by proxies and load balancers
//     (nginx's default `proxy_read_timeout` is 60s). A `:` comment line is a no-op to EventSource and
//     resets those timers.
//  3. `retry:` in the opening frame. Sets the browser's own reconnect backoff, so a server restart
//     produces a paced reconnect rather than a thundering herd from every open portal tab.
//  4. A hard connection lifetime. Access is resolved ONCE at connect (the subscriber holds a client-id
//     set), so an indefinitely-open connection would keep a revoked contact's hint stream alive
//     forever. Capping it forces a reconnect — and therefore a fresh authorize() + scope resolution —
//     on a bounded schedule. EventSource reconnects on its own, so this is invisible to the client.
import { Controller, Get, Param, Req, Res, UseGuards } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { withTenants } from "../db";
import { authorize } from "./http";
import { AuthGuard } from "../auth/guards";
import { resolvePortalScope } from "./portal-scope";
import { portalLiveAvailable, subscribePortal, type PortalFrame } from "./portal-live.service";

const HEARTBEAT_MS = 25_000;
/** 30 minutes. Long enough that reconnects are rare, short enough that a revoked contact's stream is
 *  not open for a working day. */
const MAX_CONNECTION_MS = 30 * 60 * 1000;
/** Browser reconnect delay hint (ms). */
const RETRY_MS = 5_000;

@Controller("api")
@UseGuards(AuthGuard)
export class PortalStreamController {
  @Get(":tenantId/portal/stream")
  async stream(@Req() req: FastifyRequest, @Res() reply: FastifyReply, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    // Resolve the caller's clients before a single byte goes out: a non-client gets the ordinary 403
    // from resolvePortalScope rather than an open stream that never emits, which would be
    // indistinguishable from "nothing has happened yet".
    const scope = await withTenants([tenantId], (c) => resolvePortalScope(c, req.principal));

    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      // `no-transform` matters as much as `no-cache`: a transforming proxy that gzips this stream
      // reintroduces buffering through the compressor.
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    const write = (line: string): void => {
      // `raw.write` after the socket is gone throws ERR_STREAM_WRITE_AFTER_END, which would surface as
      // an unhandled rejection in the fan-out loop. Guarded here, once, rather than at each call site.
      if (!raw.destroyed) raw.write(line);
    };

    // The opening frame tells the client whether it is genuinely live or must poll. `mode: "poll"`
    // happens with no REDIS_URL — a legitimate configuration (the local stack runs without it), and one
    // the client must be able to detect rather than infer from silence.
    const live = portalLiveAvailable();
    write(`retry: ${RETRY_MS}\n`);
    write(`event: hello\ndata: ${JSON.stringify({ mode: live ? "live" : "poll", at: new Date().toISOString() })}\n\n`);

    const unsubscribe = live
      ? subscribePortal({
          tenantId,
          clientIds: new Set(scope.clientIds),
          send: (frame: PortalFrame) => write(`event: change\ndata: ${JSON.stringify(frame)}\n\n`),
        })
      : () => {};

    const heartbeat = setInterval(() => write(`: ping ${Date.now()}\n\n`), HEARTBEAT_MS);
    // `unref()` so an open portal connection never holds the process open during shutdown; the socket
    // close below is what actually ends the stream.
    heartbeat.unref?.();

    const lifetime = setTimeout(() => {
      write(`event: bye\ndata: ${JSON.stringify({ reason: "rotate" })}\n\n`);
      raw.end();
    }, MAX_CONNECTION_MS);
    lifetime.unref?.();

    const cleanup = (): void => {
      clearInterval(heartbeat);
      clearTimeout(lifetime);
      unsubscribe();
    };
    // Both events, not just `close`: a client that aborts mid-write emits `error` and, on some Node
    // versions, no `close` — leaking a subscriber and its timers for the process's lifetime. The
    // unsubscribe is idempotent (Set.delete), so being called twice is harmless and being called zero
    // times is the bug worth guarding against.
    raw.on("close", cleanup);
    raw.on("error", cleanup);
  }
}
