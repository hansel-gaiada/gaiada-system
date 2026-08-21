import "server-only";
// MON-09i — the `X-data.ts` half of the observability module trio (see `observability.ts`'s header
// for why the split exists). This file is the only one that touches the network.
import { platformFetch, PlatformError } from "./platform";
import type { ObservabilitySnapshot } from "./observability";

/**
 * Returns null ONLY when the caller may not see this (403) or the endpoint is absent (404/405).
 * A 500 propagates: this page must be allowed to look broken. Note it does NOT synthesise an
 * `available:false` snapshot on 403 — "you cannot see it" and "the box is unmonitored" are
 * different facts and the page words them differently.
 */
export async function getObservability(userId: string): Promise<ObservabilitySnapshot | null> {
  try {
    return await platformFetch<ObservabilitySnapshot>("/api/admin/observability", userId);
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 403 || e.status === 404 || e.status === 405)) {
      return null;
    }
    throw e;
  }
}
