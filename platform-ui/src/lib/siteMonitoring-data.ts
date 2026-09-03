import "server-only";
import { platformFetch, PlatformError } from "./platform";
import type { Monitor } from "./monitoringShared";
import type { MonitoringFeed, PropertyRef } from "./siteMonitoring";

// The server-side half of the site ↔ monitor bridge. See `siteMonitoring.ts` for why the join
// happens in the BFF rather than in the database.
//
// ── WHY THIS DOES NOT CALL `lib/monitoring.ts`'s `listMonitors` ────────────────────────────────
// That reader wraps its fetch in `skipUnavailable`, which collapses 404 / 403 / 405 into `[]`. On
// the monitoring board that is correct and documented: an empty board and an absent backend are
// both "nothing to show here yet". On the PORTFOLIO it is a false claim — every row would print
// "No monitor" whether nothing is watched or nobody was allowed to ask, and "uncovered" is the
// most consequential thing this column can say. So availability is carried explicitly, which is
// the same split MON-20 made for `listResults` after the monitor detail page got it wrong.
//
// Two reads, and the SECOND is allowed to fail on its own. Monitors are the answer; properties only
// sharpen it (they resolve a monitor's `propertyId` to a domain, and they supply the client id that
// makes a monitor creatable). If the search module is off or refused, the bridge still works off
// each monitor's `target` — a slightly weaker join, never a wrong one.

/** Monitors, WITHOUT collapsing "couldn't ask" into "none". */
async function readMonitors(userId: string, tenant: string): Promise<
  { ok: true; monitors: Monitor[] } | { ok: false; reason: "not_enabled" | "refused" }
> {
  try {
    const monitors = await platformFetch<Monitor[]>(`/api/${tenant}/monitoring/monitors`, userId);
    // A 200 carrying the wrong SHAPE is the dangerous case (the same guard `searchMarketing.ts`
    // documents): an array is truthy, so a malformed payload would sail into `.map()`. Treat a
    // non-array as "couldn't ask" rather than as an empty estate.
    if (!Array.isArray(monitors)) return { ok: false, reason: "not_enabled" };
    return { ok: true, monitors };
  } catch (e) {
    if (e instanceof PlatformError && e.status === 403) return { ok: false, reason: "refused" };
    // 404/405 = the module is not mounted or not enabled for this company.
    if (e instanceof PlatformError && (e.status === 404 || e.status === 405)) return { ok: false, reason: "not_enabled" };
    // A 500 or a transport fault must propagate. A monitoring surface that swallows its own errors
    // is the failure mode this whole module replaces.
    throw e;
  }
}

/** `search_properties`, reduced to the three fields the bridge uses. Degrades to `[]` — and that IS
 *  right here, unlike for monitors: without properties the join falls back to `target` parsing and
 *  the create link loses its client prefill, but nothing it reports becomes untrue. */
async function readProperties(userId: string, tenant: string): Promise<PropertyRef[]> {
  try {
    const rows = await platformFetch<{ id: string; domain: string; clientId: string }[]>(
      `/api/${tenant}/modules/search/properties`,
      userId,
    );
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((r) => r && typeof r.domain === "string" && typeof r.id === "string")
      .map((r) => ({ id: r.id, domain: r.domain, clientId: r.clientId }));
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 403 || e.status === 405)) return [];
    throw e;
  }
}

/** Everything the portfolio needs to say something honest about health. */
export async function fetchMonitoringFeed(userId: string, tenant: string): Promise<MonitoringFeed> {
  // Sequenced deliberately: if monitors are unavailable the properties read is pointless, and
  // skipping it saves a round trip on every portfolio load for a company without monitoring.
  const monitors = await readMonitors(userId, tenant);
  if (!monitors.ok) return { available: false, reason: monitors.reason };
  const properties = await readProperties(userId, tenant);
  return { available: true, monitors: monitors.monitors, properties };
}
