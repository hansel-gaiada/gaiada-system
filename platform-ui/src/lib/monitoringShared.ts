// MON-20 — the client-safe half of `lib/monitoring.ts`: every type and every PURE presentation
// helper, none of which touch `platformFetch`/`PlatformError`. Deliberately its own file with NO
// `"server-only"` import.
//
// ── WHY THIS FILE HAD TO EXIST ────────────────────────────────────────────────────────────────
// `lib/monitoring.ts` carries `import "server-only"` at its top — correct, since it also holds the
// data-fetching functions that must never ship credentials/fetch logic to the browser. But
// `"server-only"` poisons the WHOLE MODULE, not just the functions that need it: the moment a
// `"use client"` component imports even a single pure value (a function, a runtime `const` array)
// from that file, Next's bundler pulls the entire module — including the `"server-only"` marker —
// into the client bundle and the build fails outright ("You're importing a component that needs
// 'server-only'..."). `type`-only imports are fine (erased at compile time, e.g. `NewMonitorForm.tsx`'s
// pre-existing `import type { MonitorKindSpec } from "@/lib/monitoring"`), but `ChannelManager.tsx`/
// `RouteManager.tsx`/`MaintenanceManager.tsx` (MON-20) need REAL runtime helpers —
// `channelHealth`, `isCatchAll`, `maintenanceState`, `describeMaintenanceScope`, `ageSeconds`,
// `formatAge`, `CHANNEL_KINDS` — client-side, to render health badges and format dates without a
// round trip. This file is where those live, so a client component can import them directly and
// never touch `monitoring.ts` at all. `monitoring.ts` re-exports everything here (`export * from
// "./monitoringShared"`) so every EXISTING server-side caller is unaffected.
//
// Keep this invariant when adding to either file: if it calls `platformFetch` (or imports
// `PlatformError`), it belongs in `monitoring.ts`. If it is a type, a constant, or a pure function
// of already-fetched data, it belongs here.

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

export interface MonitorFilter {
  clientId?: string;
  kind?: string;
  status?: MonitorStatus;
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
