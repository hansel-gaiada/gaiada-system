// DW-7h (FRONTEND-BFF-CONTRACT §52.2) — the ONE place this app decides which network address and browser a request
// came from, for the IT security view (who is connected, IP blocks). Compare `mail/client-ip.ts`, which keys rate limits
// for the public mail endpoints and shares the same reading of nginx.
//
// The topology on the live ERP (infra/nginx/erp.gaiada.online.conf):
//   * A browser reaches platform-ui through nginx `location /`, which sets `X-Real-IP $remote_addr`, the true peer
//     (erp.gaiada.com resolves straight to the box, with no CDN in front). platform-ui's server code then calls this app
//     DIRECTLY over the internal network (PLATFORM_URL), with no nginx in between, and passes the browser's address and
//     user agent on as `x-gaiada-client-ip` / `x-gaiada-client-ua` (lib/platform.ts).
//   * The only nginx location that reaches this app from outside is `/api/webhooks/`. nginx sets `X-Real-IP` there and
//     appends to `X-Forwarded-For`.
//
// So the rule: a request that carries `X-Real-IP` or `X-Forwarded-For` came through nginx, and anything it says in the
// `x-gaiada-client-*` headers is the caller's own claim, so it is IGNORED. The address is nginx's `X-Real-IP` (it
// replaces, never appends), else the RIGHTMOST `X-Forwarded-For` entry (the one nginx appended). A request with neither
// header came from inside (platform-ui), and its `x-gaiada-client-*` headers are what platform-ui saw. With none of those
// either (a test, a script on the box), the socket peer is the answer. An address that does not parse is null, never
// a guess.
import { isIP } from "node:net";
import type { FastifyRequest } from "fastify";

export interface ClientContext {
  /** The client's address, or null when it cannot be told. IPv4-mapped IPv6 (`::ffff:1.2.3.4`) is unwrapped. */
  ip: string | null;
  /** The browser's user agent, cut to 512 characters, or null. */
  userAgent: string | null;
  /** Where the answer came from: platform-ui's forwarded headers, nginx's headers, or the socket itself. */
  via: "bff" | "nginx" | "peer";
}

export const USER_AGENT_MAX = 512;

function header(req: Pick<FastifyRequest, "headers">, name: string): string | undefined {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s.trim() !== "" ? s.trim() : undefined;
}

export function cleanIp(value: string | undefined | null): string | null {
  if (!value) return null;
  let s = value.trim();
  if (s.toLowerCase().startsWith("::ffff:") && isIP(s.slice(7)) === 4) s = s.slice(7);
  return isIP(s) ? s : null;
}

const cleanUa = (value: string | undefined): string | null => (value ? value.slice(0, USER_AGENT_MAX) : null);

export function clientContextOf(req: Pick<FastifyRequest, "headers" | "ip">): ClientContext {
  const realIp = header(req, "x-real-ip");
  const forwardedFor = header(req, "x-forwarded-for");
  if (realIp !== undefined || forwardedFor !== undefined) {
    const rightmost = forwardedFor?.split(",").map((s) => s.trim()).filter(Boolean).pop();
    return { ip: cleanIp(realIp) ?? cleanIp(rightmost), userAgent: cleanUa(header(req, "user-agent")), via: "nginx" };
  }
  const bffIp = header(req, "x-gaiada-client-ip");
  const bffUa = header(req, "x-gaiada-client-ua");
  if (bffIp !== undefined || bffUa !== undefined) {
    return { ip: cleanIp(bffIp), userAgent: cleanUa(bffUa), via: "bff" };
  }
  return { ip: cleanIp(req.ip), userAgent: cleanUa(header(req, "user-agent")), via: "peer" };
}
