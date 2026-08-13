import "server-only";
// Monitoring (Plane B) data layer — property/service monitoring for the tenant's clients.
// Frontend-first: the backend `monitoring` module does not exist yet, so every reader DEGRADES
// gracefully (null/[] on 404/403) and the pages render an explicit empty state rather than
// crashing — same pattern as lib/it.ts and lib/admin.ts.
//
// ⚠ THE ONE RULE THIS FILE EXISTS TO ENFORCE: an absent backend must never render as "healthy".
// Gaia Nexus's monitoring dashboard was a hash function that always looked green, and that is the
// failure this module replaces. `skipUnavailable` therefore returns EMPTY, never a synthesised
// "up" — and every surface distinguishes "no monitors" from "all monitors passing".
//
// PLANE SEPARATION (docs/blueprints/monitoring-program.md §0): this is Plane B — the tenant's
// websites and services. Plane A (our own containers) lives in Grafana and is NOT surfaced here.
//
// BFF CONTRACT (implement in platform-nest to match — docs/FRONTEND-BFF-CONTRACT.md §Monitoring):
//   GET   /api/:t/monitoring/monitors?clientId&kind&status   -> Monitor[]
//   POST  /api/:t/monitoring/monitors        body {..}       -> { id }     (monitoring.write)
//   GET   /api/:t/monitoring/monitors/:id                    -> MonitorDetail | 404
//   PATCH /api/:t/monitoring/monitors/:id    body {..}       -> { id }     (monitoring.write)
//   GET   /api/:t/monitoring/monitors/:id/results?window     -> MonitorResult[]
//   GET   /api/:t/monitoring/incidents?status&limit          -> Incident[]
//   POST  /api/:t/monitoring/incidents/:id/ack               -> { id }     (monitoring.ack)
//   GET   /api/:t/monitoring/summary                         -> MonitoringSummary
//   GET   /api/:t/monitoring/kinds                           -> MonitorKindSpec[]
//   GET   /api/:t/monitoring/maintenance                     -> MaintenanceWindow[]
//   POST  /api/:t/monitoring/maintenance     body {..}       -> { id }     (monitoring.write)
// Readable by any member of :t holding `monitoring.read`; writes are Cerbos-gated.
// RLS + Cerbos are the real boundary — the UI gate is a mirror, never the source.
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

export async function listResults(
  u: string,
  t: string,
  id: string,
  window: "24h" | "7d" | "30d" = "24h",
): Promise<MonitorResult[]> {
  return skipUnavailable(
    platformFetch<MonitorResult[]>(`/api/${t}/monitoring/monitors/${id}/results?window=${window}`, u),
    [] as MonitorResult[],
  );
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
