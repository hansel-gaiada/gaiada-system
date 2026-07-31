// Pure, unit-testable guards for the two things standing between this sidecar and becoming an
// SSRF proxy against the internal network: the shared bearer token, and an origin allowlist that
// pins every render request to PLATFORM_UI_INTERNAL_URL (TR-19 security requirement — this
// service will fetch whatever URL it is handed, so both checks are load-bearing).

/** Extracts and compares a `Bearer <token>` Authorization header. Constant-shape comparison is
 * not attempted here (a shared internal token, not a customer secret) — timing side-channels
 * against an internal-network-only sidecar are not this ticket's threat model. */
export function isAuthorized(authHeader: string | undefined, expectedToken: string): boolean {
  if (!expectedToken) return false; // never fail open on a missing/blank server-side token
  if (!authHeader) return false;
  const match = /^Bearer\s+(.+)$/.exec(authHeader);
  if (!match) return false;
  return match[1] === expectedToken;
}

/** Returns true only if `candidateUrl` is a well-formed http(s) URL whose origin exactly matches
 * `allowedOrigin` (scheme+host+port). A leaked RENDERER_TOKEN then still cannot be used to make
 * this sidecar fetch arbitrary internal or external hosts — the whole point of TR-19's egress
 * constraint, mirroring ai-gateway-go's DialContext allowlist / search-crawl-go's guard. */
export function isAllowedRenderUrl(candidateUrl: string, allowedOrigin: string): boolean {
  let candidate: URL;
  let allowed: URL;
  try {
    candidate = new URL(candidateUrl);
    allowed = new URL(allowedOrigin);
  } catch {
    return false;
  }
  if (candidate.protocol !== "http:" && candidate.protocol !== "https:") return false;
  return candidate.origin === allowed.origin;
}
