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

/** A monitor's health at last check. `unknown` is a first-class state, not a synonym for `up`. */
export type MonitorStatus = "up" | "down" | "degraded" | "maintenance" | "unknown";
export const MONITOR_STATUSES: MonitorStatus[] = ["up", "down", "degraded", "maintenance", "unknown"];

/**
 * Monitor kinds. Backed by the driver registry (monitoring-program.md §3.2) — the backend returns
 * the kinds it can actually probe via GET /kinds, so a kind added there (mqtt, grpc, snmp, steam,
 * docker, database) appears in the UI with NO frontend change. This union is the v1 set; treat an
 * unrecognised kind from the backend as valid-but-unstyled rather than an error.
 */
export type MonitorKind = "http" | "keyword" | "tcp" | "dns" | "tls" | "heartbeat";
export const MONITOR_KINDS: MonitorKind[] = ["http", "keyword", "tcp", "dns", "tls", "heartbeat"];

export type MonitorSeverity = "page" | "ticket" | "info";

export interface Monitor {
  id: string;
  name: string;
  kind: MonitorKind | string;
  status: MonitorStatus;
  /** The client this monitor belongs to — company → client → property (monitoring-program.md §1.2). */
  clientId: string;
  clientName?: string | null;
  propertyId?: string | null;
  /** Display target. NEVER rendered on a public status page (§3.5 field allowlist). */
  target?: string | null;
  severity: MonitorSeverity;
  enabled: boolean;
  intervalSec: number;
  /** Last successful check. Null means never checked — render as "never", never as "up". */
  lastCheckedAt?: string | null;
  lastLatencyMs?: number | null;
  /** Rolling availability over the stated window, 0..1. Null when there is not enough history. */
  uptime24h?: number | null;
  uptime30d?: number | null;
  /** Set while a maintenance window suppresses this monitor (K7). */
  inMaintenanceUntil?: string | null;
  /** TLS/domain expiry, surfaced on the board because it is the classic silent outage. */
  certExpiresAt?: string | null;
  domainExpiresAt?: string | null;
  openIncidentId?: string | null;
  tags?: string[];
}

export interface MonitorResult {
  checkedAt: string;
  status: MonitorStatus;
  latencyMs?: number | null;
  /** Why it failed, from the driver. Free-form and NOT public-safe. */
  detail?: string | null;
}

export interface MonitorDetail extends Monitor {
  results: MonitorResult[];
  incidents: Incident[];
  /** Driver-specific config, redacted server-side. May contain secret REFERENCES, never secrets. */
  config?: Record<string, unknown> | null;
  createdAt?: string | null;
  createdBy?: string | null;
}

export interface Incident {
  id: string;
  monitorId: string;
  monitorName?: string | null;
  clientName?: string | null;
  openedAt: string;
  closedAt?: string | null;
  cause?: string | null;
  severity: MonitorSeverity;
  acknowledgedAt?: string | null;
  acknowledgedBy?: string | null;
}

export interface MonitoringSummary {
  total: number;
  up: number;
  down: number;
  degraded: number;
  maintenance: number;
  unknown: number;
  openIncidents: number;
  /** When the runner last completed a sweep. Null ⇒ the runner has never reported: show it. */
  lastSweepAt?: string | null;
}

/** What the backend's driver registry can actually probe. Drives the kind picker. */
export interface MonitorKindSpec {
  kind: string;
  label: string;
  /** Assertion types this kind supports — the UI only offers these. */
  capabilities: string[];
  available: boolean;
}

export interface MaintenanceWindow {
  id: string;
  scope: string;
  startsAt: string;
  endsAt: string;
  reason?: string | null;
  createdBy?: string | null;
}

/**
 * Notification channel kinds. `webhook` and `mcp` are the agentic seam — monitoring events reach
 * n8n flows and Hermes/agents through the platform outbox, not through a second notification path
 * (monitoring-program.md §4.1). Adding a channel kind here does NOT add a delivery path; the
 * backend's outbox consumers own that.
 */
export type ChannelKind = "email" | "telegram" | "ntfy" | "webhook" | "wa" | "mcp";
export const CHANNEL_KINDS: ChannelKind[] = ["email", "telegram", "ntfy", "webhook", "wa", "mcp"];

export interface MonitorChannel {
  id: string;
  kind: ChannelKind | string;
  name: string;
  enabled: boolean;
  /**
   * Display-safe summary of where this delivers ("ops@…", "#alerts", "https://n8n…/webhook/xyz").
   * The backend redacts it. The full config holds secret REFERENCES only — a webhook URL with an
   * embedded token IS a credential and must never reach this field in full.
   */
  destination?: string | null;
  lastDeliveryAt?: string | null;
  lastDeliveryOk?: boolean | null;
  /** Consecutive failures. Non-zero means the channel is degraded even though it still "exists". */
  failureCount?: number | null;
}

export interface MonitorRoute {
  id: string;
  channelId: string;
  channelName?: string | null;
  /** Match predicate — any subset. An empty match means "everything", which the UI calls out. */
  matchClientId?: string | null;
  matchClientName?: string | null;
  matchSeverity?: MonitorSeverity | null;
  matchKind?: string | null;
  enabled: boolean;
}

/**
 * A channel is only as good as its last delivery. A channel that exists, is enabled, and has been
 * failing for a week is worse than no channel — it is the false assurance this whole module exists
 * to eliminate. Anything non-zero here is surfaced, not buried in a detail view.
 */
export function channelHealth(c: MonitorChannel): "ok" | "degraded" | "failing" | "unused" {
  if (!c.enabled) return "unused";
  const fails = c.failureCount ?? 0;
  if (fails >= 3) return "failing";
  if (fails > 0) return "degraded";
  if (!c.lastDeliveryAt) return "unused";
  return c.lastDeliveryOk === false ? "degraded" : "ok";
}

/**
 * Routes whose match is empty catch every event. That is occasionally intended (a catch-all pager)
 * and is usually an accident that floods one channel — either way the operator should be told,
 * because alert fatigue is what kills an alerting system.
 */
export function isCatchAll(r: MonitorRoute): boolean {
  return !r.matchClientId && !r.matchSeverity && !r.matchKind;
}

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

export interface MonitorFilter {
  clientId?: string;
  kind?: string;
  status?: MonitorStatus;
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

export type ResultsWindow = "24h" | "7d" | "30d";
export const RESULTS_WINDOWS: ResultsWindow[] = ["24h", "7d", "30d"];

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
export interface WindowedResults {
  /** False only for 404/403/405 — the endpoint itself isn't there (or not visible to this caller).
   *  Never conflate with "true and results is []", which means the window was queried and is clean. */
  available: boolean;
  results: MonitorResult[];
}

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

// ---------------------------------------------------------------------------
// Presentation helpers — pure, unit-testable, and deliberately conservative.
// ---------------------------------------------------------------------------

/** Rank for sorting the board: worst first. Maintenance sits below real failures on purpose. */
export function severityRank(s: MonitorStatus): number {
  switch (s) {
    case "down": return 0;
    case "degraded": return 1;
    case "unknown": return 2;
    case "maintenance": return 3;
    case "up": return 4;
    default: return 5;
  }
}

export function sortForBoard(monitors: Monitor[]): Monitor[] {
  return [...monitors].sort(
    (a, b) =>
      severityRank(a.status) - severityRank(b.status) ||
      (a.clientName ?? "").localeCompare(b.clientName ?? "") ||
      a.name.localeCompare(b.name),
  );
}

/**
 * Freshness of a check, in seconds. Null when never checked.
 * The board renders this next to every status because a stale probe MUST look stale — provenance
 * is a UI property, not just a data property (monitoring-program.md §5.3).
 */
export function ageSeconds(iso: string | null | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((now - t) / 1000));
}

/**
 * A check is stale once it is more than 3 intervals old — at that point the displayed status is
 * no longer evidence of anything and the UI must say so rather than keep showing a green tile.
 */
export function isStale(m: Monitor, now: number = Date.now()): boolean {
  const age = ageSeconds(m.lastCheckedAt, now);
  if (age === null) return true;
  return age > Math.max(m.intervalSec * 3, 60);
}

export function formatAge(sec: number | null): string {
  if (sec === null) return "never";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

/** Days until an expiry timestamp; negative when already expired. Null when unknown. */
export function daysUntil(iso: string | null | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((t - now) / 86400000);
}

/** Expiry warning thresholds, matching the MON-01/MON-03 alert rules so UI and alerts agree. */
export function expiryLevel(days: number | null): "none" | "warn" | "critical" {
  if (days === null) return "none";
  if (days <= 7) return "critical";
  if (days <= 30) return "warn";
  return "none";
}

export function formatUptime(u: number | null | undefined): string {
  if (u === null || u === undefined) return "—";
  return `${(u * 100).toFixed(u >= 0.9995 ? 3 : 2)}%`;
}

/**
 * A window's lifecycle, purely from its own start/end — there is no separate "status" field to
 * drift from the timestamps. `active` is the state K7 exists for (alerting is suppressed RIGHT NOW);
 * `upcoming` and `ended` are both informational, but kept distinct so an ended window doesn't read
 * as "still protecting you" on a stale list.
 */
export function maintenanceState(w: MaintenanceWindow, now: number = Date.now()): "upcoming" | "active" | "ended" {
  const starts = Date.parse(w.startsAt);
  const ends = Date.parse(w.endsAt);
  if (now < starts) return "upcoming";
  if (now > ends) return "ended";
  return "active";
}

/** `scope` is either the literal `"all"` or `"monitor:<id>"` (monitoring-program.md's K7 shape).
 *  `names` resolves the id to a label for display; falls back to the raw scope when it cannot. */
export function describeMaintenanceScope(scope: string, names: Map<string, string>): string {
  if (scope === "all" || !scope) return "All monitors";
  const m = scope.match(/^monitor:(.+)$/);
  if (!m) return scope;
  return names.get(m[1]) ?? `Monitor ${m[1]}`;
}
