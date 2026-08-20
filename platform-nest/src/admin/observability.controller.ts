// MON-09i — the ERP's window onto PLANE A: this box's own health.
//
// WHY THIS EXISTS. Plane A telemetry (node-exporter, cAdvisor, the datastore exporters) has been
// collected for weeks and displayed NOWHERE: all four provisioned Grafana dashboards are
// application-level, and not one of them reads a node_*, container_*, pg_* or redis_* series. The
// only way to see whether the server was healthy was to SSH-tunnel to Prometheus and write PromQL.
// That is precisely why a completely broken datastore exporter went unnoticed: nothing looked.
//
// WHY THIS DOES NOT BREAK THE TWO-PLANE RULE (docs/blueprints/monitoring-program.md §8.1). Plane A
// is OUR infrastructure and must never become a tenant surface. So this endpoint is:
//   * platform-admin only (`isElevated`), exactly like the other /api/admin consoles,
//   * NOT tenant-scoped and NOT company-filtered — there is nothing per-tenant here to filter,
//   * read-only, and deliberately a SUMMARY. Grafana remains the analysis tool; this answers
//     "is the box healthy right now" without an SSH tunnel. We are not rebuilding Grafana.
// Plane B (clients' sites — tenant-scoped, Cerbos-gated, sellable) is a separate module.
//
// IT NEVER FABRICATES. If Prometheus is unreachable or unconfigured this returns available:false
// with a reason and null metrics. A null renders as "unknown", never as a zero and never as green —
// a monitoring surface that looks healthy while blind is the exact failure this programme exists to
// eliminate.
import { Controller, ForbiddenException, Get, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../auth/guards";
import { isElevated } from "./elevated";
import { config } from "../config";

/** A single scalar reading. `value: null` means "we asked and got nothing" — NOT zero. */
export interface Reading {
  value: number | null;
  /** Set when the query could not be answered, so the UI can say why instead of showing a dash. */
  note?: string | null;
}

export interface HostHealth {
  cpuBusyPct: Reading;
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
  /** Per-instance on purpose: this estate runs two Postgres and two Redis instances. */
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
  /** Where an operator goes for the full picture. A hand-off, deliberately not proxied. */
  grafanaHint: string;
  host: HostHealth | null;
  targets: TargetSummary | null;
  datastores: DatastoreHealth | null;
  /** Watchdog is EXCLUDED — it always fires by design (D15) and would read as a permanent fault. */
  alerts: FiringAlert[] | null;
  collectedAt: string;
}

const TIMEOUT_MS = 4000;

async function promQuery(base: string, query: string): Promise<unknown[]> {
  const url = `${base}/api/v1/query?query=${encodeURIComponent(query)}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`prometheus HTTP ${res.status}`);
    const body = (await res.json()) as { status?: string; data?: { result?: unknown[] } };
    if (body.status !== "success") throw new Error("prometheus returned a non-success status");
    return body.data?.result ?? [];
  } finally {
    clearTimeout(timer);
  }
}

/** First scalar of a vector result, or null. Never coerces an empty result into 0. */
function scalar(result: unknown[]): number | null {
  const first = result[0] as { value?: [number, string] } | undefined;
  const raw = first?.value?.[1];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

async function reading(base: string, query: string): Promise<Reading> {
  try {
    const v = scalar(await promQuery(base, query));
    return { value: v, note: v === null ? "no data for this query" : null };
  } catch (e) {
    return { value: null, note: (e as Error).message };
  }
}

// The disk queries pin fstype + mountpoint the SAME way the alert rules do (see
// prometheus/rules/alerts.yml DiskSpaceLow). node-exporter runs with --path.rootfs=/host but still
// labels the root filesystem "/", and an earlier hand-query keyed on mountpoint="/host" silently
// returned nothing — the identical shape of mistake. Keeping the two in step matters beyond
// tidiness: a console that disagrees with the alert that pages you is worse than having neither.
const FS = '{fstype!~"tmpfs|overlay|squashfs",mountpoint="/"}';

@Controller("api/admin/observability")
@UseGuards(AuthGuard)
export class ObservabilityController {
  @Get()
  async snapshot(@Req() req: FastifyRequest): Promise<ObservabilitySnapshot> {
    if (!isElevated(req)) throw new ForbiddenException("platform admin required");

    const collectedAt = new Date().toISOString();
    const base = (config.observability?.prometheusUrl ?? "").replace(/\/$/, "");
    const grafanaHint = config.observability?.grafanaUrl || "http://localhost:3001 (via SSH tunnel)";

    if (!base) {
      return {
        available: false,
        reason:
          "PROMETHEUS_URL is not set on the platform, so this box's own metrics cannot be read. " +
          "The metrics are still being collected — only this view is unconfigured.",
        grafanaHint,
        host: null,
        targets: null,
        datastores: null,
        alerts: null,
        collectedAt,
      };
    }

    try {
      const [cpu, mem, diskUsed, diskFree, diskProj, load, uptime, targets, pg, redis, alerts] =
        await Promise.all([
          reading(base, '100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)'),
          reading(base, "(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100"),
          reading(base, `(1 - (node_filesystem_avail_bytes${FS} / node_filesystem_size_bytes${FS})) * 100`),
          reading(base, `node_filesystem_avail_bytes${FS} / 1024 / 1024 / 1024`),
          reading(base, `predict_linear(node_filesystem_avail_bytes${FS}[6h], 24 * 3600) / 1024 / 1024 / 1024`),
          reading(base, "node_load1"),
          reading(base, "(time() - node_boot_time_seconds) / 86400"),
          promQuery(base, "up"),
          promQuery(base, "pg_up"),
          promQuery(base, "redis_up"),
          promQuery(base, 'ALERTS{alertstate="firing"}'),
        ]);

      const upRows = targets as { metric?: Record<string, string>; value?: [number, string] }[];
      const downRows = upRows.filter((r) => Number(r.value?.[1]) === 0);
      const instances = (rows: unknown[]) =>
        (rows as { metric?: Record<string, string>; value?: [number, string] }[]).map((r) => ({
          instance: r.metric?.instance ?? "unknown",
          up: Number(r.value?.[1]) === 1,
        }));

      const alertRows = alerts as { metric?: Record<string, string> }[];
      return {
        available: true,
        grafanaHint,
        host: {
          cpuBusyPct: cpu,
          memUsedPct: mem,
          diskUsedPct: diskUsed,
          diskFreeGb: diskFree,
          diskFreeGb24h: diskProj,
          load1: load,
          uptimeDays: uptime,
        },
        targets: {
          up: upRows.length - downRows.length,
          down: downRows.length,
          downJobs: [...new Set(downRows.map((r) => r.metric?.job ?? "unknown"))].sort(),
        },
        datastores: { postgres: instances(pg), redis: instances(redis) },
        // Watchdog always fires (the D15 dead-man's-switch). Showing it would put a permanent red
        // on a healthy box, which is exactly how operators learn to ignore an alert list.
        alerts: alertRows
          .filter((a) => (a.metric?.alertname ?? "") !== "Watchdog")
          .map((a) => ({
            name: a.metric?.alertname ?? "unknown",
            severity: a.metric?.severity ?? "unknown",
          })),
        collectedAt,
      };
    } catch (e) {
      return {
        available: false,
        reason: `Prometheus at ${base} could not be read: ${(e as Error).message}`,
        grafanaHint,
        host: null,
        targets: null,
        datastores: null,
        alerts: null,
        collectedAt,
      };
    }
  }
}
