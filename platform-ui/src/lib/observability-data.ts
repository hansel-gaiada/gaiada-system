import "server-only";
// MON-09i / MSO-06 — the `X-data.ts` half of the observability module trio (see `observability.ts`'s
// header for why the split exists). This file is the only one that touches the network.
//
// MSO-06: switched from `ObservabilitySnapshot` (§20.1, single unnamed box) to
// `EstateObservabilitySnapshot` (§20.1a, multi-host estate). The route and gate are unchanged —
// same `GET /api/admin/observability` — only the response shape grew. The BE still carries §20.1's
// legacy single-host fields for one release (expand/contract, note 6); this reader does not type
// them at all, so nothing here can accidentally start depending on a field due to drop.
import { platformFetch, PlatformError } from "./platform";
import type { EstateObservabilitySnapshot } from "./observability";

/**
 * Returns null ONLY when the caller may not see this (403) or the endpoint is absent (404/405).
 * A 500 propagates: this page must be allowed to look broken. Note it does NOT synthesise an
 * `available:false` snapshot on 403 — "you cannot see it" and "the box is unmonitored" are
 * different facts and the page words them differently.
 */
export async function getObservability(userId: string): Promise<EstateObservabilitySnapshot | null> {
  try {
    return await platformFetch<EstateObservabilitySnapshot>("/api/admin/observability", userId);
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 403 || e.status === 404 || e.status === 405)) {
      return null;
    }
    throw e;
  }
}
