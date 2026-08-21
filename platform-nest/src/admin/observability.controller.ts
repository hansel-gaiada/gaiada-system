// MON-09i (single-host) -> MSO-05 (estate) — the ERP's window onto PLANE A: OUR OWN infrastructure.
//
// WHY THIS EXISTS. Plane A telemetry (node-exporter, cAdvisor, the datastore exporters) has been
// collected for weeks and displayed NOWHERE: all four provisioned Grafana dashboards are
// application-level, and not one of them reads a node_*, container_*, pg_* or redis_* series. The
// only way to see whether a server was healthy was to SSH-tunnel to Prometheus and write PromQL.
// That is precisely why a completely broken datastore exporter went unnoticed: nothing looked.
//
// WHY THIS DOES NOT BREAK THE TWO-PLANE RULE (docs/blueprints/monitoring-program.md §8.1). Plane A
// is OUR infrastructure and must never become a tenant surface. So this endpoint is:
//   * platform-admin only (`isElevated`), exactly like the other /api/admin consoles,
//   * NOT tenant-scoped and NOT company-filtered — there is nothing per-tenant here to filter,
//   * read-only, and deliberately a SUMMARY. Grafana remains the analysis tool; this answers
//     "is the estate healthy right now" without an SSH tunnel. We are not rebuilding Grafana.
// Plane B (clients' sites — tenant-scoped, Cerbos-gated, sellable) is a separate module.
//
// IT NEVER FABRICATES. If Prometheus is unreachable or unconfigured this returns available:false
// with a reason and null metrics. A null renders as "unknown", never as a zero and never as green —
// a monitoring surface that looks healthy while blind is the exact failure this programme exists to
// eliminate.
//
// ── MSO-05: single host -> estate (docs/plans/2026-08-21-multi-server-observability.md, contract
// docs/FRONTEND-BFF-CONTRACT.md §20.1a) ───────────────────────────────────────────────────────────
// Everything host-shaped now comes from `estate-observability.ts`'s PURE functions (unit-testable
// without a live Prometheus/Alertmanager/DB); this file is the NestJS wiring: fetch the three
// upstreams (Prometheus, Alertmanager, `infra_hosts` via withGlobal), hand the raw results to those
// pure functions, and assemble the wire response — including the §20.1 LEGACY fields, kept for one
// release per the contract's expand/contract note.
//
// ⚠ ONE DELIBERATE CONTRACT DEVIATION, recorded here and in FRONTEND-BFF-CONTRACT.md §20.1a: the
// ratified design's TypeScript block defines a NEW `alerts: EstateAlert[] | null` field and its own
// prose then says the expand phase ALSO carries forward "§20.1's legacy host/targets/datastores/
// alerts fields" — but a JSON object cannot carry two fields both named `alerts` with different
// shapes. `host`/`targets`/`datastores` don't collide and are kept verbatim (derived from the
// `gda-aicenter` row, LEGACY_HOST_KEY below). For `alerts`, the NEW Alertmanager-sourced shape wins:
// it is a superset of the old `{name, severity}` shape for any consumer that only reads those two
// fields, and — unlike re-deriving the old Prometheus-`ALERTS`-sourced list — it cannot render a
// SILENCED alert as firing, which is the one failure mode §20.1a note 3 is written to prevent. A
// second, differently-named legacy alerts field was not invented; nothing in the design or the
// currently-deployed UI asked for one.
import { Controller, ForbiddenException, Get, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../auth/guards";
import { isElevated } from "./elevated";
import { config } from "../config";
import { withGlobal } from "../db";
import {
  computeEstateSummary,
  groupInstancesByHost,
  groupTargetsByHost,
  mapAlertmanagerAlerts,
  mergeHostInventory,
  scalarsByHost,
  seriesEnvByHost,
  type AlertmanagerAlert,
  type EstateAlert,
  type EstateObservabilitySnapshot,
  type HostMetricMaps,
  type InfraHostRow,
} from "./estate-observability";

// The estate-observability module owns every type; re-exported here so a caller that only knows
// this controller's file path (the pre-MSO-05 import habit) still finds them.
export type {
  Reading,
  HostHealth,
  TargetSummary,
  DatastoreHealth,
  FiringAlert,
  EstateAlert,
  EstateSummary,
  HostSnapshot,
  FreshnessState,
  Freshness,
  EstateObservabilitySnapshot,
} from "./estate-observability";

/** §20.1's response shape is now a subset of the estate shape — kept as an alias, not a second
 *  type, so nothing can define it incompatibly with `EstateObservabilitySnapshot`. */
export type ObservabilitySnapshot = EstateObservabilitySnapshot;

const TIMEOUT_MS = 4000;

async function fetchJson(url: string): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function promQuery(base: string, query: string): Promise<unknown[]> {
  const body = (await fetchJson(`${base}/api/v1/query?query=${encodeURIComponent(query)}`)) as {
    status?: string;
    data?: { result?: unknown[] };
  };
  if (body.status !== "success") throw new Error("prometheus returned a non-success status");
  return body.data?.result ?? [];
}

// The disk queries pin fstype + mountpoint the SAME way the single-host alert rule does (see
// infra/observability/prometheus/rules/alerts.yml's DiskSpaceLow) — node-exporter runs with
// --path.rootfs=/host but still labels the root filesystem "/", and an earlier hand-query keyed on
// mountpoint="/host" silently returned nothing. `host!=""` additionally excludes the pre-MSO-01
// legacy unlabeled series (contract §20.1a note 4: host key "" is never emitted). NOTE (recorded
// per this ticket's "trust reality" instruction): the LIVE alerts.yml rule has not yet been
// generalized to `by (host)` — that is MSO-02, not built as of this ticket — so this by-host query
// and the still-single-host DiskSpaceLow rule are not byte-identical today. They share the same
// filter/threshold shape and will converge automatically once MSO-02 lands the host label onto the
// rule; flagged rather than silently assumed complete.
const FS = '{fstype!~"tmpfs|overlay|squashfs",mountpoint="/",host!=""}';

// LEGACY_HOST_KEY: which HostSnapshot backs the §20.1 single-estate fields during the expand phase
// (contract §20.1a: "derived from the gda-aicenter row"). gda-aicenter is the box the platform
// itself runs on — the one §20.1 was originally built to describe.
const LEGACY_HOST_KEY = "gda-aicenter";

async function readInfraHosts(): Promise<InfraHostRow[]> {
  const { rows } = await withGlobal((c) =>
    c.query<{ key: string; display_name: string; env: string; role: string; status: string }>(
      `SELECT key, display_name, env, role, status FROM infra_hosts ORDER BY key`,
    ),
  );
  return rows.map((r) => ({
    key: r.key,
    display_name: r.display_name,
    env: r.env as InfraHostRow["env"],
    role: r.role,
    status: r.status as InfraHostRow["status"],
  }));
}

interface AlertmanagerResult {
  alerts: EstateAlert[] | null;
  note: string | null;
  activeCount: number | null;
  suppressedCount: number | null;
}

/** Alertmanager is fetched INDEPENDENTLY of Prometheus's own reachability (contract §20.1a note 5:
 *  "available covers only the central Prometheus... Alertmanager failing does not flip available").
 *  Reading this the other way round too: a Prometheus outage should not blind an operator to
 *  currently-firing alerts if Alertmanager itself is still reachable, so this is called even when
 *  the main Prometheus Promise.all below has failed. */
async function fetchAlertmanagerAlerts(): Promise<AlertmanagerResult> {
  const base = (config.observability?.alertmanagerUrl ?? "").replace(/\/$/, "");
  if (!base) {
    return {
      alerts: null,
      note: "ALERTMANAGER_URL is not set, so notification/silence state cannot be read.",
      activeCount: null,
      suppressedCount: null,
    };
  }
  try {
    const raw = (await fetchJson(`${base}/api/v2/alerts`)) as AlertmanagerAlert[];
    const alerts = mapAlertmanagerAlerts(Array.isArray(raw) ? raw : []);
    const activeCount = alerts.filter((a) => a.state === "active").length;
    const suppressedCount = alerts.filter((a) => a.state === "suppressed").length;
    return { alerts, note: null, activeCount, suppressedCount };
  } catch (e) {
    return {
      alerts: null,
      note: `Alertmanager at ${base} could not be read: ${(e as Error).message}`,
      activeCount: null,
      suppressedCount: null,
    };
  }
}

@Controller("api/admin/observability")
@UseGuards(AuthGuard)
export class ObservabilityController {
  @Get()
  async snapshot(@Req() req: FastifyRequest): Promise<EstateObservabilitySnapshot> {
    if (!isElevated(req)) throw new ForbiddenException("platform admin required");

    const collectedAt = new Date().toISOString();
    const base = (config.observability?.prometheusUrl ?? "").replace(/\/$/, "");
    const grafanaHint = config.observability?.grafanaUrl || "http://localhost:3001 (via SSH tunnel)";

    // Alertmanager and Prometheus are fetched independently — see fetchAlertmanagerAlerts's header.
    const amResult = await fetchAlertmanagerAlerts();

    if (!base) {
      return {
        available: false,
        reason:
          "PROMETHEUS_URL is not set on the platform, so the estate's own metrics cannot be read. " +
          "The metrics are still being collected — only this view is unconfigured.",
        grafanaHint,
        collectedAt,
        hosts: null,
        estate: null,
        alerts: amResult.alerts,
        alertsNote: amResult.note,
        host: null,
        targets: null,
        datastores: null,
      };
    }

    try {
      const nowEpochSeconds = Date.now() / 1000;

      const [
        infraHosts,
        freshnessResult,
        cpuResult,
        coresResult,
        memResult,
        diskUsedResult,
        diskFreeResult,
        diskProjResult,
        load1Result,
        uptimeResult,
        upResult,
        pgResult,
        redisResult,
      ] = await Promise.all([
        readInfraHosts(),
        // §6: the lead signal. Same 48h:1m subquery + max-by-host shape the design ratifies, and
        // the same 600s dark boundary RemoteWriteStalled uses (estate-observability.ts).
        promQuery(base, 'max by (host) (last_over_time(timestamp(up{host!=""})[48h:1m]))'),
        promQuery(base, '100 - (avg by (host) (rate(node_cpu_seconds_total{mode="idle",host!=""}[5m])) * 100)'),
        promQuery(base, 'count by (host) (node_cpu_seconds_total{mode="idle",host!=""})'),
        promQuery(base, '(1 - (node_memory_MemAvailable_bytes{host!=""} / node_memory_MemTotal_bytes{host!=""})) * 100'),
        promQuery(base, `(1 - (node_filesystem_avail_bytes${FS} / node_filesystem_size_bytes${FS})) * 100`),
        promQuery(base, `node_filesystem_avail_bytes${FS} / 1024 / 1024 / 1024`),
        promQuery(base, `predict_linear(node_filesystem_avail_bytes${FS}[6h], 24 * 3600) / 1024 / 1024 / 1024`),
        promQuery(base, 'node_load1{host!=""}'),
        promQuery(base, '(time() - node_boot_time_seconds{host!=""}) / 86400'),
        promQuery(base, 'up{host!=""}'),
        promQuery(base, 'pg_up{host!=""}'),
        promQuery(base, 'redis_up{host!=""}'),
      ]);

      const maps: HostMetricMaps = {
        freshness: scalarsByHost(freshnessResult),
        cpuBusyPct: scalarsByHost(cpuResult),
        cores: scalarsByHost(coresResult),
        memUsedPct: scalarsByHost(memResult),
        diskUsedPct: scalarsByHost(diskUsedResult),
        diskFreeGb: scalarsByHost(diskFreeResult),
        diskFreeGb24h: scalarsByHost(diskProjResult),
        load1: scalarsByHost(load1Result),
        uptimeDays: scalarsByHost(uptimeResult),
        targetsByHost: groupTargetsByHost(upResult),
        pgByHost: groupInstancesByHost(pgResult),
        redisByHost: groupInstancesByHost(redisResult),
        seriesEnvByHost: seriesEnvByHost(upResult),
      };

      const hosts = mergeHostInventory(infraHosts, maps, nowEpochSeconds);
      const estate = computeEstateSummary(hosts, amResult.activeCount, amResult.suppressedCount);

      const legacyHost = hosts.find((h) => h.key === LEGACY_HOST_KEY) ?? null;

      return {
        available: true,
        grafanaHint,
        collectedAt,
        hosts,
        estate,
        alerts: amResult.alerts,
        alertsNote: amResult.note,
        // §20.1 legacy expand-phase fields — derived from the gda-aicenter HostSnapshot rather than
        // re-queried, so the two views can never disagree about this one box's numbers.
        host: legacyHost?.host ?? null,
        targets: legacyHost?.targets ?? null,
        datastores: legacyHost?.datastores ?? null,
      };
    } catch (e) {
      return {
        available: false,
        reason: `Prometheus at ${base} could not be read: ${(e as Error).message}`,
        grafanaHint,
        collectedAt,
        hosts: null,
        estate: null,
        alerts: amResult.alerts,
        alertsNote: amResult.note,
        host: null,
        targets: null,
        datastores: null,
      };
    }
  }
}
