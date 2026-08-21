// MON-09i / MON-10 — client-safe types + pure helpers for the Plane A (our infrastructure) console.
//
// Split out of what used to be a single `server-only` file: this half holds ONLY types and pure,
// zero-I/O functions (the `X.ts` slot of the module-trio convention documented in
// platform-ui/CLAUDE.md), because the dense host table (`components/systems/ObservabilityHostTable.tsx`)
// is a client component and needs `hostTier`/`formatAge`/etc. at sort/filter time in the browser.
// `server-only` guards would make this whole file unimportable from there. The actual network call
// (`getObservability`) lives in the sibling `observability-data.ts`.
//
// Plane A vs Plane B, because the distinction is the whole design and easy to lose:
//   * THIS file  = our own boxes. Staff/platform-admin only. Never tenant-scoped, never sellable.
//   * lib/monitoring.ts = the CLIENT's websites and services. Tenant-scoped, Cerbos-gated, product.
// They must never be merged into one surface (docs/blueprints/monitoring-program.md §8.1); Gaia
// Nexus merged them and that is the root cause of its fabricated dashboard.
//
// BFF CONTRACT: GET /api/admin/observability -> ObservabilitySnapshot (403 unless platform admin).
// Shapes mirror platform-nest/src/admin/observability.controller.ts. That endpoint answers for
// exactly ONE box today — there is no multi-host endpoint yet (a multi-host/environment-tagged
// contract is being designed separately; check docs/FRONTEND-BFF-CONTRACT.md §20.1 and
// docs/plans/ for whether it has landed before assuming otherwise). `HostRow` below is this
// component's forward-shaped seam: today exactly one is built, by `hostRowFromSnapshot`, from the
// one real endpoint. When a multi-host list endpoint exists, only the mapping function changes —
// the table, the sort/filter logic and the drilldown all already operate on `HostRow[]`.

/** `value: null` means "asked, got nothing" — never zero, and never rendered as healthy. */
export interface Reading {
  value: number | null;
  note?: string | null;
}

export interface HostHealth {
  cpuBusyPct: Reading;
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

export interface FiringAlert {
  name: string;
  severity: string;
}

export interface ObservabilitySnapshot {
  available: boolean;
  reason?: string | null;
  grafanaHint: string;
  host: HostHealth | null;
  targets: TargetSummary | null;
  datastores: DatastoreHealth | null;
  alerts: FiringAlert[] | null;
  collectedAt: string;
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

// --- Multi-host shape (forward-designed; today always length 1) ----------------------------------

/**
 * One row of the host table. Deliberately host-shaped rather than snapshot-shaped so a future
 * multi-host endpoint can hand this component an array with zero rework to the table/drilldown —
 * only `hostRowFromSnapshot` (or its eventual multi-host sibling) changes.
 *
 * `environment` is `string | null` where `null` means ONE specific thing: **the backend does not
 * send this field yet**. It is not "measured and found blank" — there is no such reading for
 * environment. The table renders that distinctly ("not tagged"), never as an empty cell and never
 * grouped as though it were a real environment named "unknown".
 */
export interface HostRow {
  id: string;
  label: string;
  environment: string | null;
  available: boolean;
  reason?: string | null;
  collectedAt: string;
  tier: Tier;
  host: HostHealth | null;
  targets: TargetSummary | null;
  datastores: DatastoreHealth | null;
  alerts: FiringAlert[] | null;
  grafanaHint: string;
}

function readingsAllNull(h: HostHealth | null): boolean {
  if (!h) return true;
  return [h.cpuBusyPct, h.memUsedPct, h.diskUsedPct, h.load1, h.uptimeDays].every((r) => r.value === null);
}

/**
 * Rolls a whole snapshot up into ONE severity tier for the table's status column and default sort.
 * `unknown` is a first-class outcome, not a fallback bucket: it means "available, but nothing this
 * function looked at actually measured anything" (or the snapshot itself said `available:false`) —
 * the exact "not measured" state that must never be allowed to read as calm.
 */
export function hostTier(snap: ObservabilitySnapshot): Tier {
  if (!snap.available) return "unknown";
  const h = snap.host;
  const cpu = utilLevel(h?.cpuBusyPct.value ?? null);
  const mem = utilLevel(h?.memUsedPct.value ?? null);
  const disk = utilLevel(h?.diskUsedPct.value ?? null);
  const pgDown = (snap.datastores?.postgres ?? []).some((d) => !d.up);
  const redisDown = (snap.datastores?.redis ?? []).some((d) => !d.up);
  const pageAlert = (snap.alerts ?? []).some((a) => a.severity === "page");
  const targetsDown = (snap.targets?.down ?? 0) > 0;
  if (cpu === "critical" || mem === "critical" || disk === "critical" || pgDown || redisDown || pageAlert || targetsDown) {
    return "critical";
  }
  const anyAlert = (snap.alerts ?? []).length > 0;
  if (cpu === "warn" || mem === "warn" || disk === "warn" || anyAlert) return "warn";
  const noDatastoreRows = (snap.datastores?.postgres.length ?? 0) + (snap.datastores?.redis.length ?? 0) === 0;
  const noTargets = !snap.targets;
  if (readingsAllNull(h) && noDatastoreRows && noTargets) return "unknown";
  return "ok";
}

/**
 * Today's ONLY producer of a `HostRow` — wraps the single real `/api/admin/observability` reading.
 * `environment` is always `null` here on purpose (see the field doc on `HostRow`): this endpoint has
 * no concept of environment or of "which box", so inventing one would be exactly the frontend-first
 * drift this estate keeps getting burned by. `id`/`label` are deliberately generic ("this box") for
 * the same reason — the backend never names the host it read.
 */
export function hostRowFromSnapshot(snap: ObservabilitySnapshot, id = "this-box", label = "This box"): HostRow {
  return {
    id,
    label,
    environment: null,
    available: snap.available,
    reason: snap.reason ?? null,
    collectedAt: snap.collectedAt,
    tier: hostTier(snap),
    host: snap.host,
    targets: snap.targets,
    datastores: snap.datastores,
    alerts: snap.alerts,
    grafanaHint: snap.grafanaHint,
  };
}

/** Ascending severity rank for the default table sort — most-unhappy host first. */
export function tierRank(t: Tier): number {
  switch (t) {
    case "critical": return 0;
    case "warn": return 1;
    case "unknown": return 2;
    default: return 3; // ok
  }
}

/** Seconds since `iso`. NaN (never a negative or a false "0") when the timestamp cannot be parsed. */
export function ageSeconds(iso: string, now: number = Date.now()): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return NaN;
  return Math.max(0, Math.round((now - t) / 1000));
}

/** Compact "how long ago" for a table cell. Never hides an unparseable timestamp behind "0s ago". */
export function formatAge(sec: number): string {
  if (!Number.isFinite(sec)) return "—";
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m ago`;
  const hh = Math.round(m / 60);
  if (hh < 48) return `${hh}h ago`;
  return `${Math.round(hh / 24)}d ago`;
}

/**
 * Freshness is a SEPARATE axis from health tier — the whole point of "scrape staleness is the most
 * dangerous state" is that a host can be reading `ok` on data that is 40 minutes stale, and must
 * still be flagged. Thresholds: <2min fresh, <15min aging, >=15min stale (matches the Prometheus
 * default 15s-60s scrape interval family — anything past 15 minutes has missed dozens of scrapes,
 * not one slow one).
 */
export type Freshness = "fresh" | "aging" | "stale";
export function freshnessTier(sec: number): Freshness {
  if (!Number.isFinite(sec)) return "stale";
  if (sec < 120) return "fresh";
  if (sec < 900) return "aging";
  return "stale";
}
