// MON-11b — the SSRF floor for monitor probes. This is the security core of Plane B.
//
// Mirrors `search-crawl-go/internal/egress` deliberately and closely, including its edge cases. Go
// gets `net.IP.IsPrivate()/IsLoopback()/IsLinkLocalUnicast()` from the stdlib; Node has none of
// those, so every range is spelled out here. Where the Go version documents a hole it had to close,
// that reasoning is reproduced rather than re-derived, because the whole value of this file is being
// right about EVERY spelling of a private address.
//
// ── WHY A MONITOR NEEDS THIS AT ALL ─────────────────────────────────────────────────────────────
// Every probe dials a hostname a TENANT supplied. That makes this module an SSRF primitive by
// construction: without a floor, "monitor this URL" becomes "fetch anything my server can reach",
// and 169.254.169.254 is a cloud credential endpoint. A monitoring feature that can read instance
// metadata is an exfiltration tool with a dashboard.
//
// ── THE TWO NON-OBVIOUS RULES ───────────────────────────────────────────────────────────────────
// 1. VALIDATE THE ADDRESS ACTUALLY DIALLED, NOT THE HOSTNAME. `guardedLookup` is installed as the
//    agent's `lookup`, so Node connects to exactly the address this code approved. Checking the
//    hostname and then letting Node resolve it again leaves a DNS-rebind window: first resolution
//    public, second private. There is no second resolution here.
// 2. FAIL CLOSED ON ANYTHING UNPARSEABLE. An address we cannot classify is denied. The alternative
//    — "allow what we don't understand" — is how a novel encoding becomes a bypass.
import { lookup as dnsLookup } from "node:dns";
import type { LookupAddress } from "node:dns";

export const ReasonNotAllowlisted = "not_allowlisted";
export const ReasonPrivateIP = "private_ip";
export const ReasonUnresolvable = "unresolvable";
export const ReasonUnparseable = "unparseable_ip";

export interface EgressDecision {
  host: string;
  ip: string | null;
  allowed: boolean;
  reason: string;
}

/** Append-only audit sink. EVERY attempt is reported, allowed or refused. */
export type EgressAudit = (decision: EgressDecision) => void;

function parseIPv4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    // Reject empty, non-numeric, leading zeros (037 is octal in some resolvers) and out-of-range.
    if (!/^\d{1,3}$/.test(p)) return null;
    if (p.length > 1 && p[0] === "0") return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** Expands an IPv6 literal to 16 bytes, or null. Handles `::` compression and mapped/compat forms. */
function parseIPv6(s: string): number[] | null {
  let str = s;
  if (str.startsWith("[") && str.endsWith("]")) str = str.slice(1, -1);
  // A trailing dotted-quad (::ffff:1.2.3.4 and ::1.2.3.4) becomes two hextets.
  const dotted = str.match(/^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (dotted) {
    const v4 = parseIPv4(dotted[2]);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    str = `${dotted[1]}${hi}:${lo}`;
  }
  const halves = str.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  return bytes;
}

function v4Denied(b: number[]): boolean {
  const [a, second] = b;
  if (a === 0) return true;                                  // 0.0.0.0/8 unspecified
  if (a === 10) return true;                                 // RFC1918
  if (a === 127) return true;                                // loopback
  if (a === 169 && second === 254) return true;              // link-local — INCLUDES 169.254.169.254
  if (a === 172 && second >= 16 && second <= 31) return true; // RFC1918
  if (a === 192 && second === 168) return true;              // RFC1918
  if (a === 100 && second >= 64 && second <= 127) return true; // CGNAT 100.64/10 — some metadata
                                                               // services answer here too
  if (a >= 224) return true;                                 // multicast 224/4 + reserved 240/4
  return false;
}

/**
 * The classifier. `true` = must never be dialled.
 *
 * Covers every spelling: dotted IPv4, IPv6 literals, IPv4-MAPPED IPv6 (::ffff:a.b.c.d) and the
 * deprecated IPv4-COMPATIBLE form (::a.b.c.d). The compatible form is the hole the Go version had to
 * close: its `To4()` only unwraps the MAPPED form, so `::7f00:1` (127.0.0.1) was classified PUBLIC by
 * a function whose entire job is the opposite. Modern kernels no longer route it, which makes it a
 * logic hole rather than a demonstrated bypass — but a classifier that must be right about every
 * encoding should never depend on OS behaviour to stay safe.
 */
export function isDeniedAddress(addr: string): boolean {
  if (!addr) return true; // fail closed
  const v4 = parseIPv4(addr);
  if (v4) return v4Denied(v4);

  const b = parseIPv6(addr);
  if (!b) return true; // unparseable => denied

  const allZeroTop12 = b.slice(0, 12).every((x) => x === 0);
  const isUnspecified = b.every((x) => x === 0);
  if (isUnspecified) return true;                                     // ::
  if (allZeroTop12 && b[12] === 0 && b[13] === 0 && b[14] === 0 && b[15] === 1) return true; // ::1

  // IPv4-mapped: ::ffff:a.b.c.d
  const isMapped = b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;
  if (isMapped) return v4Denied([b[12], b[13], b[14], b[15]]);

  // Deprecated IPv4-compatible: ::a.b.c.d. Excludes :: and ::1, handled above, so they are not
  // re-read as 0.0.0.0 / 0.0.0.1 here.
  if (allZeroTop12) return v4Denied([b[12], b[13], b[14], b[15]]);

  if ((b[0] & 0xfe) === 0xfc) return true;                 // ULA fc00::/7
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // link-local fe80::/10
  if (b[0] === 0xff) return true;                          // multicast ff00::/8
  return false;
}

/** Normalises a host for allowlist comparison: lowercase, strip brackets and a trailing dot. */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/**
 * Exact-match allowlist. NOT a suffix match: `evil-example.com` must not pass for `example.com`, and
 * a suffix rule would let an attacker register one. Subdomains are therefore separate entries by
 * design — a monitor is registered against a specific property, not a domain tree.
 */
export function isHostAllowlisted(host: string, allowlist: readonly string[]): boolean {
  const h = normalizeHost(host);
  return allowlist.some((a) => normalizeHost(a) === h);
}

/**
 * Builds the `lookup` to hand an http/https Agent. Node connects to exactly what this returns, which
 * is what makes "validate the address actually dialled" true rather than aspirational.
 *
 * Refuses when: the host is not allowlisted, DNS fails, or ANY returned address is denied. Note the
 * ANY: a hostname resolving to one public and one private address is refused outright rather than
 * filtered down to the public one. Filtering would let an attacker keep a public A record purely to
 * get past the check while the private one is what they actually want dialled.
 */
export function createGuardedLookup(allowlist: readonly string[], audit: EgressAudit) {
  return function guardedLookup(
    hostname: string,
    options: unknown,
    callback: (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void,
  ): void {
    const host = normalizeHost(hostname);

    if (!isHostAllowlisted(host, allowlist)) {
      audit({ host, ip: null, allowed: false, reason: ReasonNotAllowlisted });
      callback(Object.assign(new Error(`egress refused: ${host} is not allowlisted`), { code: "EACCES" }));
      return;
    }

    dnsLookup(hostname, { all: true }, (err, addresses) => {
      if (err || !addresses || addresses.length === 0) {
        audit({ host, ip: null, allowed: false, reason: ReasonUnresolvable });
        callback(Object.assign(new Error(`egress refused: ${host} did not resolve`), { code: "ENOTFOUND" }));
        return;
      }
      for (const a of addresses) {
        if (isDeniedAddress(a.address)) {
          // Named in the audit line: "which private address did it try" is the first question asked
          // during an incident, and a generic refusal cannot answer it.
          audit({ host, ip: a.address, allowed: false, reason: ReasonPrivateIP });
          callback(
            Object.assign(new Error(`egress refused: ${host} resolved to non-public ${a.address}`), {
              code: "EACCES",
            }),
          );
          return;
        }
      }
      for (const a of addresses) audit({ host, ip: a.address, allowed: true, reason: "allowed" });
      callback(null, addresses);
    });
  };
}

/**
 * Per-host request cap. Applied per REQUEST, not per dial: a dial-level cap misses every request
 * that reuses a keep-alive connection, so a single socket could hammer a client's site while the
 * counter sat still. Same reasoning as `search-crawl-go/internal/egress/ratelimit.go`.
 */
export class HostRateLimiter {
  private last = new Map<string, number>();
  constructor(private readonly minGapMs: number) {}

  /** Milliseconds to wait before the next request to `host` (0 when it may proceed now). */
  delayFor(host: string, now: number = Date.now()): number {
    const h = normalizeHost(host);
    const prev = this.last.get(h);
    if (prev === undefined) return 0;
    const gap = now - prev;
    return gap >= this.minGapMs ? 0 : this.minGapMs - gap;
  }

  record(host: string, now: number = Date.now()): void {
    this.last.set(normalizeHost(host), now);
  }
}
