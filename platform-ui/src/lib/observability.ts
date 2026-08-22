// MON-09i / MON-10 / MSO-06 — client-safe types + pure helpers for the Plane A (our infrastructure)
// console.
//
// Split out of what used to be a single `server-only` file: this half holds ONLY types and pure,
// zero-I/O functions (the `X.ts` slot of the module-trio convention documented in
// platform-ui/CLAUDE.md), because the dense host table (`components/systems/ObservabilityHostTable.tsx`)
// is a client component and needs these helpers at sort/filter/render time in the browser.
// `server-only` guards would make this whole file unimportable from there. The actual network call
// (`getObservability`) lives in the sibling `observability-data.ts`.
//
// Plane A vs Plane B, because the distinction is the whole design and easy to lose:
//   * THIS file  = our own boxes. Staff/platform-admin only. Never tenant-scoped, never sellable.
//   * lib/monitoring.ts = the CLIENT's websites and services. Tenant-scoped, Cerbos-gated, product.
// They must never be merged into one surface (docs/blueprints/monitoring-program.md §8.1); Gaia
// Nexus merged them and that is the root cause of its fabricated dashboard.
//
// BFF CONTRACT: GET /api/admin/observability -> EstateObservabilitySnapshot (403 unless platform
// admin). Shapes mirror `platform-nest/src/admin/estate-observability.ts`, contract
// `docs/FRONTEND-BFF-CONTRACT.md` §20.1a. That § superseded the old single-host §20.1 shape
// (`ObservabilitySnapshot`) via expand/contract; this file now consumes ONLY the estate shape
// (MSO-06) — §20.1a note 6 is explicit that new consumers must not read the legacy fields the BE
// still carries for one release. `HostRow` remains the table/drilldown's per-row view, now built by
// `hostRowFromEstateHost` from a real `HostSnapshot` instead of a single synthesized row.

/** `value: null` means "asked, got nothing" — never zero, and never rendered as healthy. */
export interface Reading {
  value: number | null;
  note?: string | null;
}

export interface HostHealth {
  cpuBusyPct: Reading;
  /** §20.1a: load1 without a core count is unreadable across heterogeneous boxes once more than
   *  one host is on the board. */
  cores: Reading;
  memUsedPct: Reading;
  diskUsedPct: Reading;
  diskFreeGb: Reading;
  diskFreeGb24h: Reading;
  load1: Reading;
  uptimeDays: Reading;
}

export interface TargetSummary {
  up: number;
  down: number;
  downJobs: string[];
}

export interface DatastoreHealth {
  postgres: { instance: string; up: boolean }[];
  redis: { instance: string; up: boolean }[];
}

// ── Freshness — the LEAD signal, a separate axis from health (contract §20.1a note 1) ────────────
// A host reading `ok` on data 40 minutes old is the most dangerous state on the board because it
// looks calm. This state machine is computed server-side (estate-observability.ts); the UI only
// consumes and renders it — never re-derives it from a client clock, which would drift from the
// server's view of "how long ago".
export type HostFreshnessState = "fresh" | "stale" | "dark" | "never";

export interface HostFreshness {
  state: HostFreshnessState;
  /** null iff state === "never" (contract §20.1a note 2, last bullet). */
  lastSampleAgeSeconds: number | null;
}

export const FRESHNESS_LABEL: Record<HostFreshnessState, string> = {
  fresh: "Fresh",
  stale: "Stale",
  dark: "Dark",
  never: "Never reported",
};

export type HostEnv = "production" | "staging" | "ops" | "dev";
export type HostStatus = "active" | "onboarding" | "decommissioned";

/** Wire shape of one host, per contract §20.1a. */
export interface HostSnapshot {
  key: string;
  displayName: string;
  env: HostEnv | null;
  role: string | null;
  registered: boolean;
  status: HostStatus | null;
  envDrift: boolean;
  freshness: HostFreshness;
  host: HostHealth | null;
  targets: TargetSummary | null;
  containersRunning: Reading;
  datastores: DatastoreHealth | null;
}

export interface EstateSummary {
  hosts: { total: number; fresh: number; stale: number; dark: number; never: number };
  /** null when Alertmanager is unreadable — NEVER 0. A 0 means "asked, nothing firing". */
  alertsActive: number | null;
  alertsSuppressed: number | null;
}

export interface EstateAlert {
  name: string;
  severity: string;
  state: "active" | "suppressed";
  /** null = not attributable to one host (app-level alert) — rendered estate-wide, not dropped. */
  host: string | null;
}

export interface EstateObservabilitySnapshot {
  available: boolean;
  reason?: string | null;
  grafanaHint: string;
  collectedAt: string;
  hosts: HostSnapshot[] | null;
  estate: EstateSummary | null;
  alerts: EstateAlert[] | null;
  alertsNote?: string | null;
}

// --- Pure presentation helpers (unit-testable, no I/O) -------------------------------------------

/** One decimal, or an em dash. Never prints "0" for missing data. */
export function fmt(r: Reading | undefined, suffix = ""): string {
  if (!r || r.value === null) return "—";
  return `${r.value.toFixed(1)}${suffix}`;
}

export type Tier = "ok" | "warn" | "critical" | "unknown";

/**
 * Utilisation tier for a percentage. Thresholds match `DiskSpaceLow` (fires below 15% free, i.e.
 * above 85% used) so the console and the pager agree — a console that stays green while an alert
 * fires teaches people to distrust the console.
 */
export function utilLevel(pct: number | null): Tier {
  if (pct === null) return "unknown";
  if (pct >= 85) return "critical";
  if (pct >= 70) return "warn";
  return "ok";
}

/** Maps a tier onto the shared STATUS_FAMILY vocabulary in components/ui.tsx. */
export function levelLabel(level: Tier): string {
  switch (level) {
    case "ok": return "active";
    case "warn": return "at risk";
    case "critical": return "critical";
    default: return "draft"; // renders as the idle/unknown family, never as a pass
  }
}

/**
 * The projection is only worth showing when it says something actionable. Free space that is
 * stable or growing produces a large positive number that reads as noise beside the current value.
 */
export function diskProjectionNote(current: Reading, projected: Reading): string | null {
  if (current.value === null || projected.value === null) return null;
  if (projected.value < 0) return "projected to fill within 24h";
  const delta = current.value - projected.value;
  if (delta <= 0.2) return null; // flat or recovering
  return `trending down ~${delta.toFixed(1)} GB/day`;
}

// --- Alerts: per-host attribution vs estate-level ------------------------------------------------

/** Alerts Alertmanager attributed to this specific host. */
export function hostAlerts(all: EstateAlert[] | null, hostKey: string): EstateAlert[] {
  return (all ?? []).filter((a) => a.host === hostKey);
}

/** Alerts with no host label — app-level, rendered estate-wide rather than dropped. */
export function unattributedAlerts(all: EstateAlert[] | null): EstateAlert[] {
  return (all ?? []).filter((a) => a.host === null);
}

/**
 * `RemoteWriteStalled` is deliberately never excluded from `alerts` (contract §20.1a note 3): when
 * it fires — on ANY host, or estate-level — the console must stop implying the rest of the board is
 * trustworthy. This is checked across the WHOLE alerts list, not per host, because a stalled write
 * pipe on one host is reason to distrust freshness reasoning generally.
 */
export function remoteWriteStalledActive(alerts: EstateAlert[] | null): boolean {
  return (alerts ?? []).some((a) => a.name === "RemoteWriteStalled" && a.state === "active");
}

// --- Host row (table/drilldown view) --------------------------------------------------------------

/**
 * One row of the host table — built from a real `HostSnapshot` (MSO-06) plus the alerts
 * Alertmanager attributed to it. `env`/`role`/`status`/`registered`/`envDrift` all ride straight
 * from the inventory-merged snapshot; there is no more "environment: null means the backend hasn't
 * built this yet" placeholder (§20.1a's own doc on `HostSnapshot.env`: null now means exactly one
 * real thing — this host has no `infra_hosts` row).
 */
export interface HostRow {
  id: string;
  label: string;
  env: HostEnv | null;
  role: string | null;
  registered: boolean;
  status: HostStatus | null;
  envDrift: boolean;
  freshness: HostFreshness;
  tier: Tier;
  host: HostHealth | null;
  targets: TargetSummary | null;
  containersRunning: Reading;
  datastores: DatastoreHealth | null;
  alerts: EstateAlert[];
}

function readingsAllNull(h: HostHealth | null): boolean {
  if (!h) return true;
  return [h.cpuBusyPct, h.memUsedPct, h.diskUsedPct, h.load1, h.uptimeDays].every((r) => r.value === null);
}

/**
 * Rolls one host's measured signals into a HEALTH tier — deliberately a SEPARATE axis from
 * `freshness` (contract §20.1a note 1). A `dark`/`never` host always measures nothing (the *Maps
 * are empty past staleness), so it naturally falls to `unknown` here — but `unknown` must never be
 * read as "healthy"; the freshness badge is what carries the real alarm for that case, this tier is
 * about "of what we CAN currently read, is anything past a threshold".
 */
export function estateHostTier(h: HostSnapshot, alerts: EstateAlert[]): Tier {
  const cpu = utilLevel(h.host?.cpuBusyPct.value ?? null);
  const mem = utilLevel(h.host?.memUsedPct.value ?? null);
  const disk = utilLevel(h.host?.diskUsedPct.value ?? null);
  const pgDown = (h.datastores?.postgres ?? []).some((d) => !d.up);
  const redisDown = (h.datastores?.redis ?? []).some((d) => !d.up);
  const pageAlert = alerts.some((a) => a.state === "active" && a.severity === "page");
  const targetsDown = (h.targets?.down ?? 0) > 0;
  if (cpu === "critical" || mem === "critical" || disk === "critical" || pgDown || redisDown || pageAlert || targetsDown) {
    return "critical";
  }
  // A SUPPRESSED alert is still a real, tracked issue (contract §20.1a note 3's whole point is that
  // silence state must stay visible, not vanish) — it just must never read with the same urgency as
  // an active one, so it caps out at `warn` rather than `critical` regardless of severity.
  const anyAlert = alerts.length > 0;
  if (cpu === "warn" || mem === "warn" || disk === "warn" || anyAlert) return "warn";
  const noDatastoreRows = (h.datastores?.postgres.length ?? 0) + (h.datastores?.redis.length ?? 0) === 0;
  const noTargets = !h.targets;
  if (readingsAllNull(h.host) && noDatastoreRows && noTargets) return "unknown";
  return "ok";
}

/** Today's producer of a `HostRow` from one estate `HostSnapshot` — the mapping function §20.1a
 *  designed the whole module trio around swapping in. `allAlerts` is the estate's flat list;
 *  this narrows it to the alerts attributed to `snapshot.key`. */
export function hostRowFromEstateHost(snapshot: HostSnapshot, allAlerts: EstateAlert[] | null): HostRow {
  const alerts = hostAlerts(allAlerts, snapshot.key);
  return {
    id: snapshot.key,
    label: snapshot.displayName,
    env: snapshot.env,
    role: snapshot.role,
    registered: snapshot.registered,
    status: snapshot.status,
    envDrift: snapshot.envDrift,
    freshness: snapshot.freshness,
    tier: estateHostTier(snapshot, alerts),
    host: snapshot.host,
    targets: snapshot.targets,
    containersRunning: snapshot.containersRunning,
    datastores: snapshot.datastores,
    alerts,
  };
}

/** Ascending severity rank for the health-tier column/legend. */
export function tierRank(t: Tier): number {
  switch (t) {
    case "critical": return 0;
    case "warn": return 1;
    case "unknown": return 2;
    default: return 3; // ok
  }
}

// --- Alarm state: freshness + inventory status, combined for row-level triage ---------------------

/**
 * Non-negotiable #1/#2 of MSO-06: an expected host gone dark must be impossible to miss, and it must
 * read differently from a host that was NEVER expected yet (`status: "onboarding"`, still waiting
 * for its first sample — that is expected-pending, not an incident) and differently again from a
 * host with no inventory row at all (`registered: false` — drift in the OTHER direction: something
 * is sending us data we didn't provision). This is deliberately independent of `tier`: a `dark` host
 * always measures `unknown` on the health axis (nothing to read), but "unknown" alone reads as
 * bland/idle — this function is what makes the console say "the host you expect is GONE" instead.
 */
export type HostAlarmState =
  | "reporting"           // registered, live (fresh or stale), status active
  | "expected-pending"    // registered, onboarding, no sample yet (never) or dark before first sample
  | "stopped-reporting"   // registered, status active, but freshness dark/never — the dangerous case
  | "decommissioned-muted"// registered, status decommissioned — kept visible only until series age out
  | "unregistered";       // series exist with no infra_hosts row at all

export function hostAlarmState(row: Pick<HostRow, "registered" | "status" | "freshness">): HostAlarmState {
  if (!row.registered) return "unregistered";
  if (row.status === "decommissioned") return "decommissioned-muted";
  const isDark = row.freshness.state === "dark" || row.freshness.state === "never";
  if (isDark) return row.status === "onboarding" ? "expected-pending" : "stopped-reporting";
  return "reporting";
}

/**
 * Default triage ordering: an expected host gone dark outranks even a measured-critical host — you
 * cannot page an on-call engineer about high CPU on a box you can no longer read anything from, and
 * "everything about this host is now unknown" is a worse fact than "this host has one hot metric".
 * Unregistered (drift in the other direction) ranks next, then measured health, then the two calm
 * states (expected-pending, decommissioned) sort to the bottom deliberately — the whole point of
 * those two labels is "seen, understood, not urgent".
 */
export function alarmRank(row: HostRow): number {
  const state = hostAlarmState(row);
  if (state === "stopped-reporting") return 0;
  if (state === "unregistered") return 1;
  // These two calm states override the tier-based ranks below EVEN THOUGH their tier is `unknown`
  // (nothing to measure) — the whole point of the label is "seen, understood, not urgent", so an
  // onboarding host waiting for its first sample must not sort next to a host that stopped
  // reporting unexpectedly, just because both currently measure nothing.
  if (state === "expected-pending") return 6;
  if (state === "decommissioned-muted") return 7;
  if (row.tier === "critical") return 2;
  if (row.tier === "warn") return 3;
  if (row.tier === "unknown") return 4;
  return 5; // ok, live ("reporting"), nothing to flag
}

/** Compact "how long ago" for a table cell / drilldown meta line. Never hides an unparseable or
 *  absent age behind "0s ago" — `null` (the `never` case) renders as an explicit dash. */
export function formatAge(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return "—";
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m ago`;
  const hh = Math.round(m / 60);
  if (hh < 48) return `${hh}h ago`;
  return `${Math.round(hh / 24)}d ago`;
}

/** Seconds since `iso`. NaN (never a negative or a false "0") when the timestamp cannot be parsed.
 *  Used for the snapshot-level `collectedAt` ("as of") stamp, and as the elapsed-since-fetch term in
 *  `liveSampleAgeSeconds` below — per-host recency is otherwise `HostRow.freshness`, a real
 *  server-side measurement, never a guess from the response's own timestamp. */
export function ageSeconds(iso: string, now: number = Date.now()): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return NaN;
  return Math.max(0, Math.round((now - t) / 1000));
}

/**
 * A host's freshness age keeps advancing while the page sits open, even between real fetches — the
 * console ticks `now` every 10s (see ObservabilityConsole) purely to move this number, never to
 * reclassify `freshness.state` (that stays the server's call). `lastSampleAgeSeconds` was measured
 * AS OF `collectedAt`; add however long has elapsed since then. Never invents an age for `never`
 * (still null in, null out).
 */
export function liveSampleAgeSeconds(freshness: HostFreshness, collectedAt: string, now: number): number | null {
  if (freshness.lastSampleAgeSeconds === null) return null;
  const elapsed = ageSeconds(collectedAt, now);
  return freshness.lastSampleAgeSeconds + (Number.isNaN(elapsed) ? 0 : elapsed);
}
