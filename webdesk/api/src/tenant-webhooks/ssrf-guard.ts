// WSK-37 — THE SECURITY QUESTION this ticket exists to answer. A per-tenant webhook target is
// CLIENT-CONTROLLED outbound HTTP from inside Zone B — a brand-new egress class the design §03
// allowlist table does not cover (that table enumerates a fixed, operator-controlled destination
// list; this is the first destination a tenant themselves gets to type in). Left unchecked, a
// malicious or compromised tenant could point a webhook at:
//   - a cloud metadata endpoint (169.254.169.254 — the canonical SSRF-to-credential-theft path)
//   - loopback (127.0.0.1 / ::1 — hits whatever else listens on the box itself)
//   - RFC1918 / link-local / unique-local ranges (10.x, 172.16-31.x, 192.168.x, fc00::/7,
//     fe80::/10) — the Zone B compose network's OWN services (postgres, redis, the control-plane
//     proxy) sit on exactly this kind of address
//   - a DNS name that resolves to any of the above (the DNS REBINDING case: the hostname passes
//     validation at registration time by resolving to a public IP, then a second lookup at
//     dispatch time — or a 302 partway through delivery — resolves somewhere private instead)
//
// This module is the ONE place that decides "is it safe to open a connection to this URL right
// now" — called twice per delivery attempt: once on the original `target_url`, and once more for
// EVERY redirect hop the dispatcher follows (a redirect is a second, attacker-influenced URL that
// gets exactly the same scrutiny as the first — see tenant-webhook-sender.processor.ts). It is
// NOT called only at registration time, because DNS is not a fact you get to check once: a name
// that resolved public at registration can resolve private ten minutes later (TTL=0 rebinding),
// so §03's egress table for THIS class must read "re-validated at every dispatch attempt and
// every redirect hop, not memoized" — see webdesk/api/README.md's WSK-37 section for the exact
// wording this ticket proposes adding there.
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

export type SsrfCheck = { ok: true; resolvedIp: string; hostname: string } | { ok: false; reason: string };

function ipv4Octets(ip: string): number[] {
  return ip.split(".").map((p) => Number(p));
}

/** RFC1918 + loopback + link-local (incl. the 169.254.169.254 cloud-metadata address) + CGNAT +
 *  documentation/test-net + multicast + broadcast + "this network" (0.0.0.0/8). Anything NOT
 *  globally-routable public unicast space is refused — an allowlist of "known-bad" ranges would
 *  age worse than a denylist of "known-safe" shapes, so this is deliberately the inverse: only
 *  ordinary public unicast IPv4 passes. */
function isDisallowedIPv4(ip: string): boolean {
  const [a, b, c] = ipv4Octets(ip);
  if ([a, b, c].some((n) => Number.isNaN(n))) return true; // malformed — refuse, don't guess
  if (a === 0) return true; // 0.0.0.0/8 — "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC6598)
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254 cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking (RFC2544)
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224 && a <= 239) return true; // multicast
  if (a === 255) return true; // broadcast (255.255.255.255)
  return false;
}

function isDisallowedIPv6(ipRaw: string): boolean {
  const ip = ipRaw.toLowerCase();
  if (ip === "::1") return true; // loopback
  if (ip === "::") return true; // unspecified
  // IPv4-mapped (::ffff:a.b.c.d) or IPv4-compatible (::a.b.c.d) — unwrap and re-check as IPv4, so
  // a webhook target cannot smuggle a private IPv4 address past the IPv6 branch of this function.
  const mapped = ip.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isDisallowedIPv4(mapped[1]);
  const firstHextet = ip.split(":")[0];
  if (ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb")) return true; // fe80::/10 link-local
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // fc00::/7 unique local
  if (firstHextet === "ff" || ip.startsWith("ff")) return true; // multicast ff00::/8
  return false;
}

function isDisallowedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isDisallowedIPv4(ip);
  if (family === 6) return isDisallowedIPv6(ip);
  return true; // not a recognizable IP at all — refuse rather than guess
}

/**
 * Validates a candidate webhook URL (the original `target_url`, OR a redirect `Location`) is safe
 * to open a connection to RIGHT NOW. Resolves the hostname (or accepts a literal IP directly,
 * still range-checked) and refuses if:
 *   - the scheme is not `https:` (§03: "enforce HTTPS")
 *   - the hostname is empty, a literal `localhost`, or fails to resolve
 *   - EVERY resolved address is disallowed (if a name resolves to a mix of public and private
 *     addresses, refusing only when ALL are private would still let an attacker win a race by
 *     controlling which address the eventual `fetch()` picks — so this refuses if ANY resolved
 *     address is disallowed, the conservative reading of "safe to connect to this hostname").
 */
export async function checkSsrfSafe(urlString: string): Promise<SsrfCheck> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }

  if (url.protocol !== "https:") {
    return { ok: false, reason: "only https:// targets are allowed" };
  }

  const hostname = url.hostname.toLowerCase();

  // TEST-ONLY escape hatch — proves retry/backoff and signature-verification against a REAL local
  // HTTP sink (test/helpers/tenant-webhook-sink.ts necessarily binds to loopback) without weakening
  // the guard itself. Two independent conditions gate it, both required: (1) NODE_ENV is anything
  // OTHER than "production" — so a value accidentally left set in a prod environment is inert by
  // construction, not just "unlikely to be set"; (2) the caller must separately opt in via
  // TENANT_WEBHOOK_SSRF_TEST_ALLOWLIST, an exact "host:port" (or bare "host") comma list — nothing
  // is allowlisted by default even in dev. This is the ONLY place in this file that can return
  // `ok: true` for a loopback/private address, and it is loud: every allowlist hit is logged so it
  // can never be mistaken for the guard silently doing nothing.
  if (process.env.NODE_ENV !== "production") {
    const allowlist = (process.env.TENANT_WEBHOOK_SSRF_TEST_ALLOWLIST || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const hostPort = `${hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
    if (allowlist.includes(hostPort) || allowlist.includes(hostname)) {
      // eslint-disable-next-line no-console
      console.warn(`[ssrf-guard] TEST ALLOWLIST hit for ${hostPort} — never active when NODE_ENV=production`);
      return { ok: true, resolvedIp: hostname, hostname };
    }
  }

  if (!hostname || hostname === "localhost") {
    return { ok: false, reason: "refused hostname" };
  }

  // A literal IP in the URL — no DNS involved, so no rebinding risk on THIS check, but still
  // subject to the exact same range rules.
  if (isIP(hostname)) {
    if (isDisallowedIp(hostname)) {
      return { ok: false, reason: `resolves to a disallowed address range (${hostname})` };
    }
    return { ok: true, resolvedIp: hostname, hostname };
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    return { ok: false, reason: "DNS resolution failed" };
  }
  if (addresses.length === 0) {
    return { ok: false, reason: "DNS resolution returned no addresses" };
  }
  const bad = addresses.find((a) => isDisallowedIp(a.address));
  if (bad) {
    return { ok: false, reason: `resolves to a disallowed address range (${bad.address})` };
  }

  return { ok: true, resolvedIp: addresses[0].address, hostname };
}
