// M5-V6-c — the Content-Security-Policy of the session-replay player page, and how `proxy.ts` learns the property's domains.
// Design 2026-10-12 §6.3: "the player is `rrweb-player` on a page whose CSP allows images only from the property's own domains; the
// replayer runs no scripts."
//
// ── WHY A SIGNED LINK AND NOT A LOOKUP ───────────────────────────────────────────────────────────────────────────
// This app sets headers in two places: `next.config.ts` `headers()` (static: one value for every route) and `proxy.ts`. A page cannot
// set a response header in the App Router. The player's `img-src` has to name THIS site's domains, which only a server read can
// find (the Website workspace's environments), and `proxy.ts` is a cookie-presence check that must stay cheap and fail-open: it
// must not call the BFF. So the page does the read, and hands the answer to the proxy in its own URL, signed:
//
//     …/recordings/<id>?d=gaiada.com,staging.gaiada.com&s=<HMAC>
//
// The proxy only VERIFIES (pure crypto, no network): a valid signature gives a CSP naming exactly those domains, anything else
// (no params, a forged or stale list, no secret) gives the FLOOR: images from `'self'` and `data:` only. The page recomputes the
// list on every request and redirects to the canonical signed URL when the params differ, so a hand-typed URL or a domain that
// changed settles itself in one redirect. A forged `d` cannot widen anything: it cannot carry a valid signature.
//
// The signing key is derived from SESSION_SECRET with a label, so a value signed here is never valid as a session cookie.
//
// ── WHAT THE POLICY SAYS, AND DELIBERATELY DOES NOT ───────────────────────────────────────────────────────────────
//   img-src / media-src  'self', data: and https://<each property domain>: the replayed page's own images, from its own domains only.
//   frame-ancestors      'self'. A proxy-set CSP replaces next.config's `frame-ancestors 'self'` for this route, so it is repeated here.
//   object-src 'none', base-uri 'self'.
//   NO script-src. The ERP sets no script policy anywhere (Next's inline bootstrap needs 'unsafe-inline' without a nonce), so widening
//   or narrowing it here would be a global-style change on one page. The recorded page's scripts cannot run for a different reason:
//   rrweb replays into an iframe sandboxed to `allow-same-origin` only (no `allow-scripts`), turns every <script> into <noscript>,
//   and `UNSAFE_replayCanvas` stays off (see components/webdesk/visitors/ReplayPlayer.tsx).
// A CSP only governs the DOCUMENT it arrives with. The player is therefore reached and left by plain links (a full page load), never
// a client-side navigation, which would keep the previous page's (weaker) policy or carry this one into the rest of the app.
import { createHmac, timingSafeEqual } from "node:crypto";

/** `/departments/:deptId/website/visitors/:tenant/:site/:visitorId/recordings/:recordingId` */
const PLAYER_PATH = /^\/departments\/[^/]+\/website\/visitors\/([^/]+)\/([^/]+)\/[^/]+\/recordings\/[^/]+\/?$/;

/** The tenant and site of a player URL, decoded; null for any other path. */
export function playerPathParts(pathname: string): { tenant: string; site: string } | null {
  const m = PLAYER_PATH.exec(pathname);
  if (!m) return null;
  try { return { tenant: decodeURIComponent(m[1]), site: decodeURIComponent(m[2]) }; } catch { return null; }
}

const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** At most this many domains go into a policy: a site has a handful of environments. */
export const MAX_DOMAINS = 20;

/**
 * The hostnames a policy may name: lower-case, a plain dotted hostname (no scheme, port, path, wildcard, quote, space or semicolon, so a
 * value can never add a directive or a source), de-duplicated and sorted so the same set always signs the same.
 */
export function cleanDomains(list: ReadonlyArray<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const h = raw.trim().toLowerCase();
    if (HOST_RE.test(h)) out.add(h);
  }
  return [...out].sort().slice(0, MAX_DOMAINS);
}

/** The player page's policy. `domains` must already be clean (`cleanDomains`); with none it is the floor. */
export function buildReplayCsp(domains: readonly string[]): string {
  const hosts = cleanDomains(domains).map((d) => `https://${d}`);
  const media = ["'self'", "data:", ...hosts].join(" ");
  return [
    "frame-ancestors 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    `img-src ${media}`,
    `media-src ${media}`,
  ].join("; ");
}

// ── the signed link ──────────────────────────────────────────────────────────────────────────────────────────────
function key(): Buffer {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET not set");
  return createHmac("sha256", s).update("replay-csp-v1").digest();
}

const message = (tenant: string, site: string, d: string) => `${tenant}\n${site}\n${d}`;

/** The two query values for a player URL: the domains (comma-joined, clean) and their signature, bound to this tenant and site. */
export function signedDomainParams(tenant: string, site: string, domains: ReadonlyArray<string | null | undefined>): { d: string; s: string } {
  const d = cleanDomains(domains).join(",");
  return { d, s: createHmac("sha256", key()).update(message(tenant, site, d)).digest("base64url") };
}

/** The domains a request's params prove, or null when they prove nothing (missing, forged, for another site, or no secret). Never throws. */
export function verifiedDomains(tenant: string, site: string, d: string | null | undefined, s: string | null | undefined): string[] | null {
  if (typeof d !== "string" || typeof s !== "string" || d.length > 4096 || s.length > 128) return null;
  try {
    const expected = Buffer.from(createHmac("sha256", key()).update(message(tenant, site, d)).digest("base64url"));
    const got = Buffer.from(s);
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  } catch { return null; }
  const list = d === "" ? [] : d.split(",");
  const clean = cleanDomains(list);
  // A signed list is always the canonical one; anything else (a hand-built signature over junk) is refused.
  return clean.length === list.length && clean.join(",") === d ? clean : null;
}

/**
 * What `proxy.ts` sets as the response's Content-Security-Policy for this request: null when the path is not a player page, else the
 * policy for its verified domains, else the floor. Never throws (a proxy that throws is every page down).
 */
export function replayCspFor(pathname: string, search: URLSearchParams): string | null {
  const parts = playerPathParts(pathname);
  if (!parts) return null;
  const domains = verifiedDomains(parts.tenant, parts.site, search.get("d"), search.get("s")) ?? [];
  return buildReplayCsp(domains);
}
