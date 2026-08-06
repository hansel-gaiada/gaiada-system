// The hub's ONE platform identity lookup, serving two concerns from a single cached round-trip.
//
// (1) D11 per-call revocation (WS2 §5 / gap register). Platform-fronting tools already inherit the
//     platform's authoritative revocation on every call; gateway-backed tools do NOT (they never
//     re-hit the platform). This closes that gap: before a call, the hub asks the platform whether the
//     caller is a REVOKED identity (a verified link whose user was deactivated/deleted) via
//     POST /principal/resolve, and denies if so.
//
// (2) Assurance elevation (design §2, 2026-08-06) — conjunct 3, the platform's vouching. The same
//     answer says whether the envelope resolves to a real active user through a DUAL-PROOF-VERIFIED
//     link, which is what `principal.ts`'s elevateAssurance needs.
//
// ⚠ ONE CACHE, ON PURPOSE — and the reason is not just load. Two caches over the same endpoint could
// disagree inside one window (a `revoked:false` cached in an earlier window while a later window says
// verified), and the two concerns fail in OPPOSITE directions:
//
//   - revocation fails OPEN   — the platform being down is a separate degraded state, and the
//                               platform-fronting tools would fail on their own anyway.
//   - elevation  fails CLOSED — an unproven identity must never be `verified`.
//
// So the cached value MUST distinguish "the platform said no" from "the platform never answered".
// That is the whole reason for the explicit union below rather than a bare boolean, and it is why
// `unavailable` is never cached: caching it would convert one transient blip into a TTL-long window
// where a revoked identity reads as live.
import { config } from "./config";
import type { Principal } from "./principal";

/** What the platform knows about an envelope. `unavailable` means we learned NOTHING (down, non-OK,
 *  unparsable, or the lookup is switched off) — deliberately distinct from a resolved negative. */
export type PlatformIdentity =
  | { status: "unavailable" }
  | { status: "resolved"; revoked: boolean; userId: string | null; platformAssurance: string | null };

const UNAVAILABLE: PlatformIdentity = { status: "unavailable" };

interface CacheEntry {
  identity: PlatformIdentity;
  expires: number;
}
const cache = new Map<string, CacheEntry>();

function key(p: Principal): string {
  return `${p.provider}:${p.externalId}`;
}

/**
 * Resolve this envelope against the platform, cached per principal for `revocationTtlMs`.
 *
 * `now`/`fetchImpl` are injectable for tests. Anonymous principals are never looked up (they hold no
 * elevated access to revoke and cannot be vouched for), so they short-circuit to `unavailable`
 * without a platform call — which is also the correct answer for both consumers.
 *
 * NOTE ON THE `revocationCheck` GATE: switching it off suppresses the lookup entirely, so it also
 * caps assurance at `low`. That is the fail-closed direction for elevation and the documented
 * fail-open direction for revocation, so one flag remains honest for both — but it does mean
 * HUB_REVOCATION_CHECK=false silently disables verified-assurance minting. Stated here so nobody has
 * to re-derive it from an `approvals.resolveExecute` that suddenly denies everything.
 */
export async function resolvePlatformIdentity(
  p: Principal,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<PlatformIdentity> {
  if (!config.revocationCheck || !config.platformUrl) return UNAVAILABLE;
  if (p.provider === "none" || !p.externalId || p.externalId === "anonymous") return UNAVAILABLE;

  const k = key(p);
  const hit = cache.get(k);
  if (hit && hit.expires > now) return hit.identity;

  let identity: PlatformIdentity;
  try {
    const res = await fetchImpl(`${config.platformUrl}/principal/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.platformToken}` },
      body: JSON.stringify({ provider: p.provider, externalId: p.externalId }),
    });
    if (!res.ok) return UNAVAILABLE; // non-OK ⇒ nothing learned, don't cache a transient failure
    const data = (await res.json()) as { revoked?: boolean; userId?: string | null; assurance?: string | null };
    identity = {
      status: "resolved",
      revoked: data.revoked === true,
      userId: data.userId ?? null,
      platformAssurance: data.assurance ?? null,
    };
  } catch {
    return UNAVAILABLE; // transport error / unparsable body ⇒ fail-soft, uncached
  }
  cache.set(k, { identity, expires: now + config.revocationTtlMs });
  return identity;
}

/** D11: is this principal a revoked identity? Fail-OPEN — only an explicit `revoked:true` denies. */
export function identityRevoked(identity: PlatformIdentity): boolean {
  return identity.status === "resolved" && identity.revoked;
}

/**
 * Elevation conjunct 3: does the platform vouch that this envelope is a real, active, non-revoked
 * user reached through a DUAL-PROOF-VERIFIED identity link? Fail-CLOSED — anything short of an
 * explicit yes is a no.
 *
 * Each part is derived, not assumed (`platform-nest/src/identity/identity.controller.ts#resolve`):
 *   - `userId` non-null + assurance `linked`  ⇒ an identity_links row with `verified_at IS NOT NULL`.
 *     An UNVERIFIED link returns `{...ANONYMOUS, userId}` — assurance `"low"` — so it is refused here
 *     even though it carries a userId. That distinction is the entire point of the tier.
 *   - the endpoint only reaches `linked` via `assemblePrincipal`, which returns null unless the user
 *     row is `status='active'` and `deleted_at IS NULL` ⇒ active, existing user.
 *   - a verified link on a now-inactive user comes back `revoked: true` (D11), refused below.
 *
 * `high` is accepted alongside `linked` because it is strictly stronger (an MFA'd IdP session), though
 * this endpoint only ever mints `linked` today. Both map to the single hub tier `verified`: the hub
 * vocabulary has three tiers and adding a fourth would ripple into the Cerbos `mcp_tool` policy and
 * every module's `minAssurance` declaration for no gain (design §6).
 */
export function platformVouchesFor(identity: PlatformIdentity): boolean {
  if (identity.status !== "resolved") return false;
  if (identity.revoked || !identity.userId) return false;
  return identity.platformAssurance === "linked" || identity.platformAssurance === "high";
}

/** D11 convenience wrapper (the pre-existing call shape, unchanged semantics). */
export async function isRevoked(p: Principal, fetchImpl: typeof fetch = fetch, now: number = Date.now()): Promise<boolean> {
  return identityRevoked(await resolvePlatformIdentity(p, fetchImpl, now));
}

export function resetRevocationCache(): void {
  cache.clear();
}
