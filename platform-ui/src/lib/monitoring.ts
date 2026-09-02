import "server-only";
// Monitoring (Plane B) data layer — property/service monitoring for the tenant's clients.
// The backend `monitoring` module exists (monitors/incidents/summary/kinds/maintenance shipped
// first; channels/routes/maintenance-write landed with MON-20, 2026-09-02). Every reader still
// DEGRADES gracefully (null/[] on 404/403) rather than crashing — same pattern as lib/it.ts and
// lib/admin.ts — because a module can be disabled per-company (`enabled_modules`), so "the backend
// doesn't exist" and "this company hasn't enabled it" look identical from here and both must render
// an explicit empty state, never a synthesised healthy one.
//
// ⚠ THE ONE RULE THIS FILE EXISTS TO ENFORCE: an absent backend must never render as "healthy".
// Gaia Nexus's monitoring dashboard was a hash function that always looked green, and that is the
// failure this module replaces. `skipUnavailable` therefore returns EMPTY, never a synthesised
// "up" — and every surface distinguishes "no monitors" from "all monitors passing".
//
// PLANE SEPARATION (docs/blueprints/monitoring-program.md §0): this is Plane B — the tenant's
// websites and services. Plane A (our own containers) lives in Grafana and is NOT surfaced here.
//
// ── THIS FILE IS SERVER-ONLY; `lib/monitoringShared.ts` IS THE CLIENT-SAFE HALF ────────────────
// `import "server-only"` above poisons the WHOLE MODULE for bundling purposes — the moment a
// `"use client"` component imports even one pure value (not just a type) from here, Next's bundler
// pulls this entire file, marker included, into the client bundle and the build fails outright.
// That is exactly what happened before this split: `ChannelManager.tsx`/`RouteManager.tsx`/
// `MaintenanceManager.tsx` (MON-20) imported `channelHealth`/`ageSeconds`/`formatAge`/
// `CHANNEL_KINDS`/`isCatchAll`/`maintenanceState`/`describeMaintenanceScope` as runtime VALUES from
// this file and every route depending on them 500'd in a real `next build`/`next dev` (`tsc`/
// `vitest` never caught it — neither exercises Next's client/server bundling boundary). Every type
// and every pure presentation helper now lives in `monitoringShared.ts`, which carries no
// `"server-only"` import; this file re-exports all of it (`export * from "./monitoringShared"`) so
// no existing server-side caller changes. New client-side code MUST import runtime values from
// `monitoringShared.ts` directly, never from this file — a `type`-only import from here is still
// fine (erased at compile time), which is how the pre-existing `NewMonitorForm.tsx` survives on
// `import type { MonitorKindSpec } from "@/lib/monitoring"`.
//
// BFF CONTRACT — canonical detail lives in docs/FRONTEND-BFF-CONTRACT.md §20; this is the quick
// reference, and per that doc's own rule it must never drift from it again (a contract comment that
// lies is worse than no comment — it reads as documentation while actively misleading):
//   GET   /api/:t/monitoring/monitors?clientId&kind&status    -> Monitor[]                                  (monitoring.monitor.read)
//   POST  /api/:t/monitoring/monitors        body {..}        -> { id }                                     (monitoring.monitor.create) — ⏳ PENDING
//   GET   /api/:t/monitoring/monitors/:id                     -> MonitorDetail | 404                        (monitoring.monitor.read)
//   PATCH /api/:t/monitoring/monitors/:id    body {..}        -> { id }                                     (monitoring.monitor.update) — ⏳ PENDING
//   GET   /api/:t/monitoring/monitors/:id/results?window      -> MonitorResult[]                            (monitoring.monitor.read)
//   GET   /api/:t/monitoring/incidents?status&limit           -> Incident[]                                 (monitoring.incident.read)
//   POST  /api/:t/monitoring/incidents/:id/ack                -> { id }                                     (monitoring.incident.acknowledge) — ⏳ PENDING
//   GET   /api/:t/monitoring/summary                          -> MonitoringSummary                          (monitoring.monitor.read)
//   GET   /api/:t/monitoring/kinds                            -> MonitorKindSpec[]                          (monitoring.monitor.read)
//   GET   /api/:t/monitoring/maintenance                      -> MaintenanceWindow[]                        (monitoring.maintenance.read)
//   POST  /api/:t/monitoring/maintenance     body {..}        -> { id }                                     (monitoring.maintenance.create)  [MON-20]
//   DELETE /api/:t/monitoring/maintenance/:id                 -> { id }                                     (monitoring.maintenance.delete)  [MON-20]
//   GET   /api/:t/monitoring/channels                         -> MonitorChannel[]                           (monitoring.channel.read)        [MON-20]
//   POST  /api/:t/monitoring/channels        body {..}        -> { id }, HTTP 201                           (monitoring.channel.manage)      [MON-20]
//   PATCH /api/:t/monitoring/channels/:id    body {..}        -> MonitorChannel                             (monitoring.channel.manage)      [MON-20]
//   DELETE /api/:t/monitoring/channels/:id                    -> { id, deletedAt } — SOFT delete             (monitoring.channel.manage)      [MON-20]
//   POST  /api/:t/monitoring/channels/:id/test                -> { ok } | 400 — a REAL send (same enqueueMail path runner.ts uses); 400 for
//                                                                 any non-`email` kind (no delivery driver exists yet) — the UI must not
//                                                                 imply those kinds will deliver.                                            (monitoring.channel.manage)      [MON-20]
//   GET   /api/:t/monitoring/routes                           -> MonitorRoute[]                             (monitoring.channel.read)        [MON-20]
//   POST  /api/:t/monitoring/routes          body {..}        -> { id }, HTTP 201                           (monitoring.channel.manage)      [MON-20 — routes authorize under the `monitor_channel` Cerbos kind, confirmed by the backend; there is no separate "route" permission, by design, not by omission]
//   PATCH /api/:t/monitoring/routes/:id      body {..}        -> MonitorRoute                                (monitoring.channel.manage)      [MON-20]
//   DELETE /api/:t/monitoring/routes/:id                      -> { id } — HARD delete                        (monitoring.channel.manage)      [MON-20]
// RLS + Cerbos are the real boundary — the UI gate is a mirror, never the source.
//
// ⚠ MON-20 known backend gaps, NOT fixable from here — see each write action's own comment:
//   - `MonitorChannel.destination` for `email` is validated server-side at create time (400 on
//     missing/implausible); every other kind accepts anything, because no delivery driver exists
//     for telegram/ntfy/webhook/wa/mcp yet, so there is nothing to validate a destination against.
//   - `lastDeliveryAt`/`lastDeliveryOk`/`failureCount` are schema-only columns nothing writes yet —
//     `channelHealth()` will read "unused" for every channel even right after a successful test
//     send. Do not paper over this: if a surface shows health, it must say plainly that delivery
//     status isn't tracked, not imply a green channel is a verified one.
import { platformFetch, PlatformError } from "./platform";
import type {
  Monitor,
  MonitorDetail,
  MonitorFilter,
  MonitorResult,
  Incident,
  MonitoringSummary,
  MonitorKindSpec,
  MaintenanceWindow,
  MonitorChannel,
  MonitorRoute,
  ResultsWindow,
  WindowedResults,
} from "./monitoringShared";

export * from "./monitoringShared";

/**
 * Degrade on "the backend isn't there / you may not see it" — 404, 403, 405 — and ONLY those.
 * A 500 or a network fault must propagate: a broken monitoring page has to look broken, because a
 * monitoring surface that silently swallows its own errors is the exact failure mode being replaced.
 */
async function skipUnavailable<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 403 || e.status === 405)) {
      return fallback;
    }
    throw e;
  }
}

export async function listMonitors(u: string, t: string, f: MonitorFilter = {}): Promise<Monitor[]> {
  const qs = new URLSearchParams();
  if (f.clientId) qs.set("clientId", f.clientId);
  if (f.kind) qs.set("kind", f.kind);
  if (f.status) qs.set("status", f.status);
  const q = qs.toString();
  return skipUnavailable(
    platformFetch<Monitor[]>(`/api/${t}/monitoring/monitors${q ? `?${q}` : ""}`, u),
    [] as Monitor[],
  );
}

export async function getMonitor(u: string, t: string, id: string): Promise<MonitorDetail | null> {
  return skipUnavailable(
    platformFetch<MonitorDetail>(`/api/${t}/monitoring/monitors/${id}`, u),
    null as MonitorDetail | null,
  );
}

/**
 * MON-20 — deliberately NOT `skipUnavailable`. The plain "collapse 404/403/405 into []" helper is
 * correct for a board-wide list (an empty board and an absent backend are both "nothing to show
 * here yet"), but it is the WRONG shape for a single monitor's history: a genuinely quiet window
 * ("0 incidents in the last 24h") and "this endpoint doesn't exist yet" render identically as an
 * empty array, and this is exactly the surface `[id]/page.tsx:70` used to get wrong — a caller that
 * cannot tell "clean" from "couldn't ask" and picks "clean" is the false-green failure this whole
 * module exists to replace. `available` carries that distinction explicitly so the page can render
 * "not available yet" instead of a confident empty history strip.
 */
export async function listResults(
  u: string,
  t: string,
  id: string,
  window: ResultsWindow = "24h",
): Promise<WindowedResults> {
  try {
    const results = await platformFetch<MonitorResult[]>(
      `/api/${t}/monitoring/monitors/${id}/results?window=${window}`,
      u,
    );
    return { available: true, results };
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 403 || e.status === 405)) {
      return { available: false, results: [] };
    }
    throw e;
  }
}

export async function listIncidents(u: string, t: string, limit = 25): Promise<Incident[]> {
  return skipUnavailable(
    platformFetch<Incident[]>(`/api/${t}/monitoring/incidents?status=open&limit=${limit}`, u),
    [] as Incident[],
  );
}

/**
 * The board's counters. Returns null (not a zeroed summary) when the backend is absent, so the page
 * can say "monitoring backend not connected" instead of rendering a confident all-zero all-clear.
 */
export async function getSummary(u: string, t: string): Promise<MonitoringSummary | null> {
  return skipUnavailable(
    platformFetch<MonitoringSummary>(`/api/${t}/monitoring/summary`, u),
    null as MonitoringSummary | null,
  );
}

export async function listKinds(u: string, t: string): Promise<MonitorKindSpec[]> {
  return skipUnavailable(
    platformFetch<MonitorKindSpec[]>(`/api/${t}/monitoring/kinds`, u),
    [] as MonitorKindSpec[],
  );
}

export async function listMaintenance(u: string, t: string): Promise<MaintenanceWindow[]> {
  return skipUnavailable(
    platformFetch<MaintenanceWindow[]>(`/api/${t}/monitoring/maintenance`, u),
    [] as MaintenanceWindow[],
  );
}

export async function listChannels(u: string, t: string): Promise<MonitorChannel[]> {
  return skipUnavailable(
    platformFetch<MonitorChannel[]>(`/api/${t}/monitoring/channels`, u),
    [] as MonitorChannel[],
  );
}

export async function listRoutes(u: string, t: string): Promise<MonitorRoute[]> {
  return skipUnavailable(
    platformFetch<MonitorRoute[]>(`/api/${t}/monitoring/routes`, u),
    [] as MonitorRoute[],
  );
}
