// MSO-05 — pure types + logic for the multi-host estate observability view
// (docs/plans/2026-08-21-multi-server-observability.md, contract docs/FRONTEND-BFF-CONTRACT.md
// §20.1a). Deliberately split out of observability.controller.ts: everything in this file is a
// PURE FUNCTION over already-fetched Prometheus/Alertmanager/DB data, so the null-vs-zero mapping
// and the freshness state machine — the two things this console class has shipped wrong repeatedly
// (see the controller's own header) — can be unit-tested without a live Prometheus, a live
// Alertmanager, or a database at all.
//
// THE CENTRAL RULE, restated because it is the whole point of this file: an ABSENT Prometheus
// series and a MEASURED ZERO are different facts and must never collapse into the same `0`. Every
// function here that turns a raw vector into a `Reading` keeps that distinction explicit.

/** A single scalar reading. `value: null` means "we asked and got nothing" — NOT zero. */
export interface Reading {
  value: number | null;
  /** Set when the query could not be answered, so the UI can say why instead of showing a dash. */
  note?: string | null;
}

export interface HostHealth {
  cpuBusyPct: Reading;
  /** §20.1a: HostHealth gains `cores` over §20.1 — load1 without a core count is unreadable across
   *  heterogeneous boxes once more than one host is on the board. */
  cores: Reading;
  memUsedPct: Reading;
  diskUsedPct: Reading;
  diskFreeGb: Reading;
  /** Linear projection of free space 24h out, in GB. Negative means projected to fill. */
  diskFreeGb24h: Reading;
  load1: Reading;
  uptimeDays: Reading;
}

export interface TargetSummary {
  up: number;
  down: number;
  /** Jobs with at least one target down — the actionable half of the count. */
  downJobs: string[];
}

export interface DatastoreHealth {
  /** Per-instance on purpose: this estate can run more than one Postgres/Redis instance per host. */
  postgres: { instance: string; up: boolean }[];
  redis: { instance: string; up: boolean }[];
}

/** §20.1's legacy per-box alert shape. Kept for the expand-phase fields only — see note in
 *  observability.controller.ts about why it cannot ALSO be named `alerts` at the wire level. */
export interface FiringAlert {
  name: string;
  severity: string;
}

export type FreshnessState = "fresh" | "stale" | "dark" | "never";

export interface Freshness {
  state: FreshnessState;
  /** null iff state === "never" (contract §20.1a note 2, last bullet). */
  lastSampleAgeSeconds: number | null;
}

export type HostEnv = "production" | "staging" | "ops" | "dev";
export type HostStatus = "active" | "onboarding" | "decommissioned";

export interface HostSnapshot {
  key: string;
  displayName: string;
  env: HostEnv | null;
  role: string | null;
  registered: boolean;
  status: HostStatus | null;
  envDrift: boolean;
  freshness: Freshness;
  host: HostHealth | null;
  targets: TargetSummary | null;
  containersRunning: Reading;
  datastores: DatastoreHealth | null;
}

export interface EstateSummary {
  hosts: { total: number; fresh: number; stale: number; dark: number; never: number };
  alertsActive: number | null;
  alertsSuppressed: number | null;
}

export interface EstateAlert {
  name: string;
  severity: string;
  state: "active" | "suppressed";
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
  // §20.1's legacy single-estate fields, kept for ONE release (expand phase, contract note 6),
  // derived from the `gda-aicenter` row — see LEGACY_HOST_KEY below. `alerts` is deliberately NOT
  // duplicated here; see the controller header for why.
  host: HostHealth | null;
  targets: TargetSummary | null;
  datastores: DatastoreHealth | null;
}

// ── Freshness state machine ─────────────────────────────────────────────────────────────────────
// Thresholds per contract §20.1a note 1: fresh <= 90s, stale <= 600s, dark > 600s. The 600s (10m)
// dark boundary is DELIBERATELY the same number as the `RemoteWriteStalled` alert's `> 600` so the
// console and the pager can never disagree about what "the feed stopped" means.
export const FRESH_MAX_AGE_SECONDS = 90;
export const DARK_BOUNDARY_SECONDS = 600; // shared with RemoteWriteStalled — do not drift these apart

/** Pure freshness classification. `lastSampleEpochSeconds` is `undefined`/`null` exactly when the
 *  host had NO sample in the 48h lookback the freshness query uses — that is "never", not "dark",
 *  because dark/stale both require having a last-known timestamp to measure age FROM. */
export function computeFreshness(
  nowEpochSeconds: number,
  lastSampleEpochSeconds: number | undefined | null,
): Freshness {
  if (lastSampleEpochSeconds === undefined || lastSampleEpochSeconds === null) {
    return { state: "never", lastSampleAgeSeconds: null };
  }
  // Clock skew / a sample stamped fractionally in the future must not read as negative age.
  const ageSeconds = Math.max(0, nowEpochSeconds - lastSampleEpochSeconds);
  if (ageSeconds <= FRESH_MAX_AGE_SECONDS) return { state: "fresh", lastSampleAgeSeconds: ageSeconds };
  if (ageSeconds <= DARK_BOUNDARY_SECONDS) return { state: "stale", lastSampleAgeSeconds: ageSeconds };
  return { state: "dark", lastSampleAgeSeconds: ageSeconds };
}

// ── Null-vs-zero mapping ────────────────────────────────────────────────────────────────────────

interface PromSample {
  metric?: Record<string, string>;
  value?: [number, string];
}

/** First scalar of a single (non-host-grouped) vector result, or `null`. Never coerces an empty
 *  result into 0 — mirrors observability.controller.ts's pre-existing `scalar()`, exported here so
 *  it is unit-testable without a live Prometheus. */
export function firstScalar(result: unknown[]): number | null {
  const first = (result[0] as PromSample | undefined);
  const raw = first?.value?.[1];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Turn an already-fetched Prometheus instant-query result into a `Reading`, distinguishing:
 *   - an EMPTY result (`[]`, or a result whose value cannot be parsed) → `{value: null, note: "no
 *     data for this query"}` — "asked, got nothing", never a zero.
 *   - a MEASURED ZERO (`value: [ts, "0"]` present) → `{value: 0, note: null}`.
 *   - a fetch that itself failed (caller passes the caught error) → `{value: null, note: <message>}`.
 *  This is the single choke point the estate-wide null-vs-zero discipline runs through; every Reading
 *  in the response is built by this function or by `hostReading` below, never by ad-hoc `?? 0`. */
export function readingFromResult(result: unknown[], errorMessage?: string): Reading {
  if (errorMessage) return { value: null, note: errorMessage };
  const v = firstScalar(result);
  return { value: v, note: v === null ? "no data for this query" : null };
}

/** Parse a `by (host)` instant-query result into a `Map<host, value>`. Rows with no `host` label
 *  (or `host: ""`, the pre-MSO-01 legacy series identity) are DROPPED — contract §20.1a note 4:
 *  "Host key `""` ... is never emitted." A non-finite value is treated as absent rather than NaN,
 *  so a malformed sample degrades to "not measured" instead of poisoning a comparison downstream. */
export function scalarsByHost(result: unknown[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of result as PromSample[]) {
    const host = row.metric?.host;
    if (!host) continue;
    const raw = row.value?.[1];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (Number.isFinite(n)) out.set(host, n);
  }
  return out;
}

/** Read one host's value out of a `by (host)` map as a `Reading`. Absence of the host key means
 *  "no data for this host" — the map itself may be non-empty (other hosts measured fine) while THIS
 *  host's reading is null, e.g. a `dark` host whose instant vectors have gone stale. Never falls
 *  back to 0. */
export function hostReading(map: Map<string, number>, host: string, note = "no data for this host"): Reading {
  return map.has(host) ? { value: map.get(host)!, note: null } : { value: null, note };
}

// ── containersRunning: estate-wide broken today (MON-09n) ──────────────────────────────────────
/** Always {value: null, note}, for EVERY host, regardless of freshness. Not a per-host measurement
 *  at all: cAdvisor's per-container discovery is broken estate-wide under the containerd
 *  snapshotter (verified: `count(container_last_seen{name!=""})` is empty everywhere), so a `0`
 *  here would mean "measured: nothing runs", which is false on every host that has containers up. */
export const CONTAINERS_RUNNING_UNAVAILABLE: Reading = {
  value: null,
  note:
    "per-container discovery broken estate-wide (MON-09n): cAdvisor cannot enumerate containers " +
    "under the containerd snapshotter",
};

// ── Target / datastore grouping (by host) ──────────────────────────────────────────────────────

export interface TargetRow {
  host: string;
  job: string;
  up: boolean;
}

/** Group a raw `up{host!=""}` vector by host, dropping host:"" rows same as scalarsByHost. */
export function groupTargetsByHost(result: unknown[]): Map<string, TargetRow[]> {
  const out = new Map<string, TargetRow[]>();
  for (const row of result as PromSample[]) {
    const host = row.metric?.host;
    if (!host) continue;
    const up = Number(row.value?.[1]) === 1;
    const job = row.metric?.job ?? "unknown";
    const list = out.get(host) ?? [];
    list.push({ host, job, up });
    out.set(host, list);
  }
  return out;
}

/** `null` (not `{up:0,down:0}`) when the host has NO rows at all — contract §20.1a note 2: "targets:
 *  null = no scrape data for this host (dark/never) — never emitted as {up:0,down:0}." */
export function buildTargetSummary(rows: TargetRow[] | undefined): TargetSummary | null {
  if (!rows || rows.length === 0) return null;
  const down = rows.filter((r) => !r.up);
  return {
    up: rows.length - down.length,
    down: down.length,
    downJobs: [...new Set(down.map((r) => r.job))].sort(),
  };
}

export interface InstanceRow {
  host: string;
  instance: string;
  up: boolean;
}

/** Group a raw `pg_up`/`redis_up` vector by host. */
export function groupInstancesByHost(result: unknown[]): Map<string, InstanceRow[]> {
  const out = new Map<string, InstanceRow[]>();
  for (const row of result as PromSample[]) {
    const host = row.metric?.host;
    if (!host) continue;
    const instance = row.metric?.instance ?? "unknown";
    const up = Number(row.value?.[1]) === 1;
    const list = out.get(host) ?? [];
    list.push({ host, instance, up });
    out.set(host, list);
  }
  return out;
}

/** `null` when the host ships NEITHER a postgres nor a redis exporter — contract §20.1a note 2:
 *  "datastores: null = nothing to measure (no exporters shipped) — distinct from {…, up:false},
 *  which is measured-and-down." If a host ships only one of the two, the other renders as `[]`
 *  (measured: none of that kind), not null. */
export function buildDatastoreHealth(
  pgRows: InstanceRow[] | undefined,
  redisRows: InstanceRow[] | undefined,
): DatastoreHealth | null {
  if ((!pgRows || pgRows.length === 0) && (!redisRows || redisRows.length === 0)) return null;
  const toEntries = (rows: InstanceRow[] | undefined) =>
    (rows ?? []).map((r) => ({ instance: r.instance, up: r.up }));
  return { postgres: toEntries(pgRows), redis: toEntries(redisRows) };
}

/** Extract the `env` external label the SERIES themselves carry, per host, from a `by`-preserving
 *  vector like `up{host!=""}` (design doc §4: the collector stamps BOTH `host` and `env` as
 *  remote_write external_labels, so any series carries both). Used only for drift detection
 *  (contract §20.1a note: "Row `env` != series `env` label -> drift badge on the row. The table is
 *  authoritative for env"); never used to populate `HostSnapshot.env` itself. */
export function seriesEnvByHost(result: unknown[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of result as PromSample[]) {
    const host = row.metric?.host;
    const env = row.metric?.env;
    if (!host || !env || out.has(host)) continue;
    out.set(host, env);
  }
  return out;
}

// ── Alertmanager v2 mapping ─────────────────────────────────────────────────────────────────────

export interface AlertmanagerAlert {
  labels?: Record<string, string>;
  status?: { state?: string; silencedBy?: string[]; inhibitedBy?: string[] };
}

/** Watchdog always fires by design (D15) and would read as a permanent fault (§20.1 note 3,
 *  carried over unchanged by §20.1a note 7). `RemoteWriteStalled` is DELIBERATELY never excluded —
 *  contract §20.1a note 3: the UI renders it as the whole-board "everything below is UNKNOWN"
 *  banner, so dropping it here would hide the one alert that means the rest of the board is lying. */
export function mapAlertmanagerAlerts(raw: AlertmanagerAlert[]): EstateAlert[] {
  return raw
    .filter((a) => (a.labels?.alertname ?? "") !== "Watchdog")
    .map((a) => ({
      name: a.labels?.alertname ?? "unknown",
      severity: a.labels?.severity ?? "unknown",
      // Alertmanager v2's own state vocabulary also has "unprocessed" (received, not yet routed);
      // that is not yet a silence/inhibition decision, so it renders as "active" rather than being
      // dropped or invented as a third UI state the contract doesn't define.
      state: a.status?.state === "suppressed" ? "suppressed" : "active",
      host: a.labels?.host ?? null,
    }));
}

// ── Host inventory merge ────────────────────────────────────────────────────────────────────────

export interface InfraHostRow {
  key: string;
  display_name: string;
  env: HostEnv;
  role: string;
  status: HostStatus;
}

export interface HostMetricMaps {
  freshness: Map<string, number>; // host -> last-sample epoch seconds
  cpuBusyPct: Map<string, number>;
  cores: Map<string, number>;
  memUsedPct: Map<string, number>;
  diskUsedPct: Map<string, number>;
  diskFreeGb: Map<string, number>;
  diskFreeGb24h: Map<string, number>;
  load1: Map<string, number>;
  uptimeDays: Map<string, number>;
  targetsByHost: Map<string, TargetRow[]>;
  pgByHost: Map<string, InstanceRow[]>;
  redisByHost: Map<string, InstanceRow[]>;
  seriesEnvByHost: Map<string, string>; // host -> env label as reported by the series themselves
}

function buildHostHealth(maps: HostMetricMaps, host: string): HostHealth {
  return {
    cpuBusyPct: hostReading(maps.cpuBusyPct, host),
    cores: hostReading(maps.cores, host),
    memUsedPct: hostReading(maps.memUsedPct, host),
    diskUsedPct: hostReading(maps.diskUsedPct, host),
    diskFreeGb: hostReading(maps.diskFreeGb, host),
    diskFreeGb24h: hostReading(maps.diskFreeGb24h, host),
    load1: hostReading(maps.load1, host),
    uptimeDays: hostReading(maps.uptimeDays, host),
  };
}

/** The core inventory-driven merge (contract §20.1a note 4). Pure over already-fetched data so it
 *  can be unit-tested without a database or a live Prometheus:
 *   - every non-decommissioned `infra_hosts` row appears, even with zero series ever (`never`);
 *   - a decommissioned row appears ONLY while its series have not yet aged out of the freshness
 *     lookback (rendered muted by the UI via `status: "decommissioned"`) — once its host key drops
 *     out of `maps.freshness` it simply disappears, matching "muted until their series age out";
 *   - any host key present in series but with NO `infra_hosts` row is emitted as `registered:false`
 *     ("unregistered host"), visibly abnormal;
 *   - host key `""` never appears (the by-host grouping helpers above already drop it at the source).
 *  `nowEpochSeconds` is threaded through rather than read from `Date.now()` here so freshness stays
 *  deterministic under test. */
export function mergeHostInventory(
  rows: InfraHostRow[],
  maps: HostMetricMaps,
  nowEpochSeconds: number,
): HostSnapshot[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  // The "unregistered host" case (contract §20.1a note 4) must fire for ANY host key seen in ANY
  // series, not only the freshness aggregate — in the ordinary case every host contributing to `up`
  // also contributes to the freshness subquery (it is derived from the same metric), but a partial
  // upstream failure or a query-specific staleness edge could see one query answer for a host and
  // another not. Union across every host-keyed map so a host can never be silently dropped just
  // because ONE of several queries happened not to mention it this round.
  const allKeys = new Set<string>([
    ...byKey.keys(),
    ...maps.freshness.keys(),
    ...maps.cpuBusyPct.keys(),
    ...maps.cores.keys(),
    ...maps.memUsedPct.keys(),
    ...maps.diskUsedPct.keys(),
    ...maps.diskFreeGb.keys(),
    ...maps.diskFreeGb24h.keys(),
    ...maps.load1.keys(),
    ...maps.uptimeDays.keys(),
    ...maps.targetsByHost.keys(),
    ...maps.pgByHost.keys(),
    ...maps.redisByHost.keys(),
  ]);

  const snapshots: HostSnapshot[] = [];
  for (const key of allKeys) {
    if (key === "") continue; // defence in depth; the source maps already drop this
    const row = byKey.get(key);
    const hasSeries = maps.freshness.has(key);

    // A decommissioned row with no live series left is fully aged out — drop it rather than pin it
    // to the board forever (contract §20.1a note 4: "decommissioned rows muted until their series
    // age out").
    if (row?.status === "decommissioned" && !hasSeries) continue;

    const freshness = computeFreshness(nowEpochSeconds, maps.freshness.get(key));
    const registered = row !== undefined;

    const seriesEnv = maps.seriesEnvByHost.get(key);
    const envDrift = registered && seriesEnv !== undefined && seriesEnv !== row!.env;

    const isLive = freshness.state === "fresh" || freshness.state === "stale";
    snapshots.push({
      key,
      displayName: row?.display_name ?? key,
      env: row?.env ?? null,
      role: row?.role ?? null,
      registered,
      status: row?.status ?? null,
      envDrift,
      freshness,
      // dark/never hosts: Prometheus's own 5m staleness already empties these instant vectors, so
      // the *Maps naturally have no entry — but we also gate explicitly here so a stale-but-still-
      // inside-5m-staleness edge case can't leak a reading for a host the board is about to mark
      // dark (contract §20.1a note 2, last row of the §7 table).
      host: isLive ? buildHostHealth(maps, key) : null,
      targets: isLive ? buildTargetSummary(maps.targetsByHost.get(key)) : null,
      containersRunning: CONTAINERS_RUNNING_UNAVAILABLE,
      datastores: isLive ? buildDatastoreHealth(maps.pgByHost.get(key), maps.redisByHost.get(key)) : null,
    });
  }

  snapshots.sort((a, b) => a.key.localeCompare(b.key));
  return snapshots;
}

export function computeEstateSummary(
  hosts: HostSnapshot[],
  alertsActive: number | null,
  alertsSuppressed: number | null,
): EstateSummary {
  const counts = { total: hosts.length, fresh: 0, stale: 0, dark: 0, never: 0 };
  for (const h of hosts) counts[h.freshness.state]++;
  return { hosts: counts, alertsActive, alertsSuppressed };
}
