// D11 per-call revocation for the hub (WS2 §5 / gap register). Platform-fronting tools already
// inherit the platform's authoritative revocation on every call; gateway-backed tools do NOT
// (they never re-hit the platform). This closes that gap: before a call, the hub asks the platform
// whether the caller is a REVOKED identity (a verified link whose user was deactivated/deleted) via
// POST /principal/resolve, and denies if so. Results are cached per principal for a short TTL, so
// it is one platform round-trip per principal per window regardless of call volume.
//
// Fail-open on a transport error (the platform being down is a separate degraded state, and its
// own tools would fail anyway); fail-CLOSED on an explicit revoked:true.
import { config } from "./config";
import type { Principal } from "./principal";

interface CacheEntry {
  revoked: boolean;
  expires: number;
}
const cache = new Map<string, CacheEntry>();

function key(p: Principal): string {
  return `${p.provider}:${p.externalId}`;
}

/** Is this principal a revoked identity? Anonymous principals are never "revoked" (they hold no
 *  elevated access to revoke). Cached; `now`/`fetchImpl` injectable for tests. */
export async function isRevoked(p: Principal, fetchImpl: typeof fetch = fetch, now: number = Date.now()): Promise<boolean> {
  if (!config.revocationCheck || !config.platformUrl) return false;
  if (p.provider === "none" || !p.externalId || p.externalId === "anonymous") return false;

  const k = key(p);
  const hit = cache.get(k);
  if (hit && hit.expires > now) return hit.revoked;

  let revoked = false;
  try {
    const res = await fetchImpl(`${config.platformUrl}/principal/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.platformToken}` },
      body: JSON.stringify({ provider: p.provider, externalId: p.externalId }),
    });
    if (res.ok) {
      const data = (await res.json()) as { revoked?: boolean };
      revoked = data.revoked === true;
    } // non-OK ⇒ fail-open (leave revoked=false), don't cache a transient failure
    else {
      return false;
    }
  } catch {
    return false; // transport error ⇒ fail-open, uncached
  }
  cache.set(k, { revoked, expires: now + config.revocationTtlMs });
  return revoked;
}

export function resetRevocationCache(): void {
  cache.clear();
}
