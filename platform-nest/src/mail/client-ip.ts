// MAIL-37 — the ONE `x-forwarded-for` resolution path for every mail-subsystem endpoint that keys
// anything (rate limiting, audit) off a caller's IP. Extracted from `magic-link/controller.ts`'s
// original `clientIp()` (MAIL-24 / QA-MAIL-11 Finding 3) so `inbound.controller.ts`'s
// `checkInboundRate` — which had the SAME unconditional-trust bug but was never ported when MAIL-24
// fixed the sibling — shares one implementation instead of drifting into a second, slightly
// different copy the way these two already had once.
//
// THE GATE (shared, unconditionally): `req.ip` is Fastify's own view of the raw TCP peer. This app
// never sets `trustProxy` (see main.ts), so `req.ip` is NEVER itself header-influenced — it is
// always the address of whoever opened the socket. Only when THAT address is in the caller-supplied
// allowlist do we even look at `x-forwarded-for`; otherwise the header is ignored outright and the
// socket address is the key. Default posture (empty allowlist) is "trust nothing" — every caller
// shares one bucket per NAT/proxy hop, the honest pre-existing trade-off, never a NEW hole.
//
// THE ONE THING THAT IS *NOT* SHARED — which entry of a comma-separated header to trust — because
// the two call sites sit behind genuinely different topologies:
//
//   * magic-link's caller is platform-ui's own server-side code, over a direct internal call. There
//     is no intermediary between platform-ui and this app that appends anything to the header — the
//     ENTIRE value is authored, once, by the one trusted caller. So the first (and normally only)
//     entry is what the trusted caller actually put there: 'leftmost'.
//   * inbound's caller, once nginx sits in front of it, is the open internet. nginx's own
//     `X-Forwarded-For` directive is `$proxy_add_x_forwarded_for`, which APPENDS nginx's perceived
//     peer to whatever the client already sent — it does not strip or replace. That means the
//     LEFTMOST entry is whatever the client (attacker included) put there, fully forgeable, and the
//     RIGHTMOST entry is the one nginx itself appended: the true, unspoofable address of whoever
//     connected to nginx. Picking 'leftmost' here would look fixed (the socket-trust gate genuinely
//     blocks an untrusted peer) while remaining exploitable through a trusted one — an attacker who
//     hits nginx directly can still set their own `X-Forwarded-For` and have it appended-to, not
//     replaced. So inbound must pick 'rightmost'.
//
//   Porting magic-link's exact parsing (index 0) unmodified would have been the duplicated-but-
//   slightly-wrong copy this ticket exists to prevent — the two need the same GATE, not the same
//   INDEX.
import type { FastifyRequest } from "fastify";

export interface ClientIpOptions {
  /** Exact-string allowlist of peer addresses allowed to have their `x-forwarded-for` honoured.
   *  Empty (default posture everywhere in this app) = trust nothing, always fall back to the socket
   *  address. No CIDR — see the callers' config comments for why that widening is a deliberate
   *  non-goal until a real multi-hop proxy tier exists. */
  trustedProxies: string[];
  /** Which comma-separated entry of `x-forwarded-for` to trust once the peer clears the allowlist.
   *  See the module comment above — this is topology-dependent, not a stylistic choice. */
  xffPosition: "leftmost" | "rightmost";
}

/** The one resolver. Returns the socket address whenever the peer is untrusted, the header is
 *  absent, or the header is present but empty/whitespace-only after parsing — never throws, never
 *  returns an empty string (falls back to `"unknown"` only if `req.ip` itself is falsy, matching
 *  both controllers' pre-existing fallback). */
export function resolveClientIp(req: FastifyRequest, opts: ClientIpOptions): string {
  const socketIp = req.ip || "unknown";
  if (!opts.trustedProxies.includes(socketIp)) return socketIp;
  const raw = req.headers["x-forwarded-for"] as string | undefined;
  if (!raw) return socketIp;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return socketIp;
  const picked = opts.xffPosition === "rightmost" ? parts[parts.length - 1] : parts[0];
  return picked || socketIp;
}
