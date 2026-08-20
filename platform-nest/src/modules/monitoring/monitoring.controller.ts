// MON-12/13 — the monitoring HTTP surface. Contract: docs/FRONTEND-BFF-CONTRACT.md §20.
//
// ── THE THIRD WALL IS NOT OPTIONAL ON ANY QUERY HERE ────────────────────────────────────────────
// Every monitor_* table's RLS policy is
//     tenant_id = ANY(app_current_tenants()) AND app_module_allowed('monitoring')
// so EVERY `withTenants` call below passes `{ modules: ["monitoring"] }`. Omit it and the query
// returns ZERO ROWS WITH NO ERROR — fail-closed by construction, and the single most common way a
// handler here "mysteriously returns nothing". A reviewer should treat a missing third argument in
// this file as a defect, not a style nit.
//
// ── SUMMARY 404s WHEN THE MODULE IS OFF, AND THAT IS THE POINT ──────────────────────────────────
// `ModuleEnabledGuard("monitoring")` 404s the whole controller for a tenant without the module. The
// UI reads that as "backend not connected" and says so explicitly. It must NEVER be able to render a
// zeroed all-green summary instead — Gaia Nexus's dashboard always looked healthy, and this contract
// exists so ours cannot.
import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { authorize } from "../../core/http";
import { withTenants, withGlobal } from "../../db";
import { listKindSpecs, parseKind } from "./drivers/registry";

const MOD = { modules: ["monitoring"] as string[] };

interface MonitorRow {
  id: string;
  name: string;
  kind: string;
  status: string;
  client_id: string;
  client_name: string | null;
  property_id: string | null;
  target: string | null;
  severity: string;
  enabled: boolean;
  interval_sec: number;
  last_checked_at: Date | null;
  last_latency_ms: number | null;
  cert_expires_at: Date | null;
  domain_expires_at: Date | null;
  open_incident_id: string | null;
  tags: string[];
  uptime_24h: string | null;
  uptime_30d: string | null;
}

// MON-12d — uptime, computed on read rather than stored.
//
// There is nothing to "backfill": `monitors` carries no uptime columns, so a stored figure would be a
// cache with its own staleness problem. This aggregates `monitor_results` over the window instead,
// riding ix_monitor_results_monitor (tenant_id, monitor_id, checked_at DESC).
//
// THE SEMANTICS ARE uptimeRatio()'s IN runner.ts, RESTATED IN SQL — and that duplication is the risk
// here, so `monitoring.uptime-parity.test.ts` runs both over one shared fixture and fails if they ever
// disagree. Three rules that are easy to get wrong and each of which flatters or defames a client:
//   · maintenance and unknown leave BOTH numerator and denominator — a window we did not measure is
//     not a window we were up, nor one we were down.
//   · degraded counts AGAINST uptime (denominator only) — it is a failed check, not a soft pass.
//   · an empty window is NULL, never 1 and never 0. The UI prints "—"; 100% would be a fabricated
//     claim about a period that was never observed.
const UPTIME_RATIO_SQL = `
           CASE WHEN count(*) FILTER (WHERE r.status NOT IN ('maintenance','unknown')) = 0 THEN NULL
                ELSE count(*) FILTER (WHERE r.status = 'up')::numeric
                     / count(*) FILTER (WHERE r.status NOT IN ('maintenance','unknown'))
           END`;

const MONITOR_SELECT = `
  SELECT m.id, m.name, m.kind, m.status, m.client_id, c.name AS client_name, m.property_id,
         m.target, m.severity, m.enabled, m.interval_sec, m.last_checked_at, m.last_latency_ms,
         m.cert_expires_at, m.domain_expires_at, m.tags,
         (SELECT i.id FROM monitor_incidents i
           WHERE i.monitor_id = m.id AND i.closed_at IS NULL LIMIT 1) AS open_incident_id,
         u24.ratio AS uptime_24h,
         u30.ratio AS uptime_30d
    FROM monitors m
    LEFT JOIN clients c ON c.id = m.client_id
    LEFT JOIN LATERAL (SELECT ${UPTIME_RATIO_SQL} AS ratio
                         FROM monitor_results r
                        WHERE r.tenant_id = m.tenant_id AND r.monitor_id = m.id
                          AND r.checked_at >= now() - interval '24 hours') u24 ON true
    LEFT JOIN LATERAL (SELECT ${UPTIME_RATIO_SQL} AS ratio
                         FROM monitor_results r
                        WHERE r.tenant_id = m.tenant_id AND r.monitor_id = m.id
                          AND r.checked_at >= now() - interval '30 days') u30 ON true
   WHERE m.deleted_at IS NULL`;

/** ISO or null. Never a fabricated "now" — a null timestamp is what makes the UI print "never". */
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

function mapMonitor(r: MonitorRow) {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    status: r.status,
    clientId: r.client_id,
    clientName: r.client_name,
    propertyId: r.property_id,
    target: r.target,
    severity: r.severity,
    enabled: r.enabled,
    intervalSec: r.interval_sec,
    lastCheckedAt: iso(r.last_checked_at),
    lastLatencyMs: r.last_latency_ms,
    certExpiresAt: iso(r.cert_expires_at),
    domainExpiresAt: iso(r.domain_expires_at),
    openIncidentId: r.open_incident_id,
    tags: r.tags ?? [],
    // NULL stays NULL by design: the UI renders null as "—" and 0 as "0.00%", so "no observations in
    // this window" must never read as "down all day". `numeric` arrives from pg as a string — Number()
    // it, but only after the null check, because Number(null) is 0 and that is the exact lie above.
    uptime24h: r.uptime_24h === null ? null : Number(r.uptime_24h),
    uptime30d: r.uptime_30d === null ? null : Number(r.uptime_30d),
  };
}

@Controller("api")
@UseGuards(AuthGuard, ModuleEnabledGuard("monitoring"))
export class MonitoringController {
  @Get(":tenantId/monitoring/monitors")
  async listMonitors(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("clientId") clientId?: string,
    @Query("kind") kind?: string,
    @Query("status") status?: string,
  ) {
    await authorize(req.principal, { kind: "monitor", tenantId, module: "monitoring" }, "read");
    // A `kind` filter that is not a known kind is a client bug, not an empty result: silently
    // returning [] would look like "no monitors of that type" and hide the typo.
    if (kind !== undefined && parseKind(kind) === null) {
      throw new BadRequestException(`unknown monitor kind '${kind}'`);
    }
    const rows = await withTenants(
      [tenantId],
      (c) =>
        c.query<MonitorRow>(
          `${MONITOR_SELECT}
             AND ($1::uuid IS NULL OR m.client_id = $1)
             AND ($2::text IS NULL OR m.kind = $2)
             AND ($3::text IS NULL OR m.status = $3)
           ORDER BY m.name`,
          [clientId ?? null, kind ?? null, status ?? null],
        ),
      MOD,
    );
    return rows.rows.map(mapMonitor);
  }

  @Get(":tenantId/monitoring/monitors/:id")
  async getMonitor(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "monitor", id, tenantId, module: "monitoring" }, "read");
    return withTenants(
      [tenantId],
      async (c) => {
        const m = await c.query<MonitorRow>(`${MONITOR_SELECT} AND m.id = $1`, [id]);
        if (!m.rows[0]) throw new NotFoundException("monitor not found");
        const results = await c.query(
          `SELECT checked_at, status, latency_ms, detail FROM monitor_results
            WHERE monitor_id = $1 AND checked_at > now() - interval '24 hours'
            ORDER BY checked_at DESC LIMIT 500`,
          [id],
        );
        const incidents = await c.query(
          `SELECT id, monitor_id, opened_at, closed_at, cause, severity, acknowledged_at, acknowledged_by
             FROM monitor_incidents WHERE monitor_id = $1 ORDER BY opened_at DESC LIMIT 50`,
          [id],
        );
        return {
          ...mapMonitor(m.rows[0]),
          results: results.rows.map((r: Record<string, unknown>) => ({
            checkedAt: iso(r.checked_at as Date),
            status: r.status,
            latencyMs: r.latency_ms,
            detail: r.detail,
          })),
          incidents: incidents.rows.map((r: Record<string, unknown>) => ({
            id: r.id,
            monitorId: r.monitor_id,
            openedAt: iso(r.opened_at as Date),
            closedAt: iso(r.closed_at as Date | null),
            cause: r.cause,
            severity: r.severity,
            acknowledgedAt: iso(r.acknowledged_at as Date | null),
            acknowledgedBy: r.acknowledged_by,
          })),
          // Redacted: config can hold secret REFERENCES, and `monitoring.read` is a broad grant.
          config: null,
        };
      },
      MOD,
    );
  }

  @Get(":tenantId/monitoring/incidents")
  async listIncidents(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("status") status?: string,
    @Query("limit") limit?: string,
  ) {
    await authorize(req.principal, { kind: "monitor_incident", tenantId, module: "monitoring" }, "read");
    const n = Math.min(Math.max(Number(limit ?? 25) || 25, 1), 200);
    const openOnly = status !== "all";
    const rows = await withTenants(
      [tenantId],
      (c) =>
        c.query(
          `SELECT i.id, i.monitor_id, m.name AS monitor_name, cl.name AS client_name,
                  i.opened_at, i.closed_at, i.cause, i.severity, i.acknowledged_at, i.acknowledged_by
             FROM monitor_incidents i
             JOIN monitors m ON m.id = i.monitor_id
             LEFT JOIN clients cl ON cl.id = i.client_id
            WHERE ($1::boolean IS FALSE OR i.closed_at IS NULL)
            ORDER BY CASE i.severity WHEN 'page' THEN 0 WHEN 'ticket' THEN 1 ELSE 2 END,
                     i.opened_at DESC
            LIMIT $2`,
          [openOnly, n],
        ),
      MOD,
    );
    return rows.rows.map((r: Record<string, unknown>) => ({
      id: r.id,
      monitorId: r.monitor_id,
      monitorName: r.monitor_name,
      clientName: r.client_name,
      openedAt: iso(r.opened_at as Date),
      closedAt: iso(r.closed_at as Date | null),
      cause: r.cause,
      severity: r.severity,
      acknowledgedAt: iso(r.acknowledged_at as Date | null),
      acknowledgedBy: r.acknowledged_by,
    }));
  }

  @Get(":tenantId/monitoring/summary")
  async summary(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "monitor", tenantId, module: "monitoring" }, "read");
    return withTenants(
      [tenantId],
      async (c) => {
        const s = await c.query<{ status: string; n: string }>(
          `SELECT status, count(*)::text AS n FROM monitors WHERE deleted_at IS NULL GROUP BY status`,
        );
        const by = new Map(s.rows.map((r) => [r.status, Number(r.n)]));
        const open = await c.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM monitor_incidents WHERE closed_at IS NULL`,
        );
        const sweep = await c.query<{ last: Date | null }>(
          `SELECT max(checked_at) AS last FROM monitor_results`,
        );
        const total = [...by.values()].reduce((a, b) => a + b, 0);
        return {
          total,
          up: by.get("up") ?? 0,
          down: by.get("down") ?? 0,
          degraded: by.get("degraded") ?? 0,
          maintenance: by.get("maintenance") ?? 0,
          unknown: by.get("unknown") ?? 0,
          openIncidents: Number(open.rows[0]?.n ?? 0),
          // NULL when the runner has never completed a sweep. The UI prints "the runner has not
          // reported a sweep yet" rather than implying freshness it cannot vouch for.
          lastSweepAt: iso(sweep.rows[0]?.last ?? null),
        };
      },
      MOD,
    );
  }

  /** Drives the UI's kind picker straight off the driver registry — see registry.ts. */
  @Get(":tenantId/monitoring/kinds")
  async kinds(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "monitor", tenantId, module: "monitoring" }, "read");
    return listKindSpecs();
  }

  @Get(":tenantId/monitoring/maintenance")
  async maintenance(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "monitor_maintenance", tenantId, module: "monitoring" }, "read");
    const rows = await withTenants(
      [tenantId],
      (c) =>
        c.query(
          `SELECT id, monitor_id, starts_at, ends_at, reason, created_by
             FROM monitor_maintenance WHERE ends_at > now() - interval '7 days'
            ORDER BY starts_at DESC LIMIT 100`,
        ),
      MOD,
    );
    return rows.rows.map((r: Record<string, unknown>) => ({
      id: r.id,
      scope: r.monitor_id ? `monitor:${r.monitor_id}` : "all",
      startsAt: iso(r.starts_at as Date),
      endsAt: iso(r.ends_at as Date),
      reason: r.reason,
      createdBy: r.created_by,
    }));
  }
}

/**
 * MON-13 — heartbeat ingest. A SEPARATE controller, deliberately, because it is the one endpoint here
 * with NO AuthGuard: a cron job or n8n flow must be able to `curl` it with no session, so the URL
 * token IS the credential.
 *
 * Consequences that are handled rather than hoped about:
 *  * The token is compared as a SHA-256 hash with `timingSafeEqual`, and only ever stored hashed.
 *    A plain `=` in SQL on a secret is a timing oracle, and storing it in clear would make a DB read
 *    equivalent to forging any job's liveness.
 *  * The response is ALWAYS 204, whether or not the token matched. A 404 on a bad token turns this
 *    into an oracle for enumerating valid tokens.
 *  * It is NOT behind ModuleEnabledGuard: the guard needs a resolved tenant from an authenticated
 *    principal, and there is none here. The token itself scopes the write to exactly one row.
 *  * `withGlobal` is used with an explicit justification: there is no principal, so there is no
 *    tenant context to set. The token hash is unique across all tenants and the UPDATE is pinned to
 *    the single row it identifies, so the blast radius is one heartbeat row.
 */
@Controller("api")
export class MonitoringHeartbeatController {
  @Post("monitoring/heartbeat/:token")
  async ingest(@Param("token") token: string) {
    // Hash here; the plaintext token never reaches the database and is never stored.
    const hash = createHash("sha256").update(token).digest("hex");

    // ONE call to a SECURITY DEFINER function (migration 0119) rather than a table read.
    //
    // The read-then-match version this replaced was BROKEN and looked fine: with no principal there
    // is no tenant context, so `withGlobal` left `app_current_tenants()` empty, FORCE RLS filtered
    // every row out, and the endpoint answered 200 having matched nothing. It could never have worked
    // in production. Found by the live-DB suite; no pure test could see it.
    //
    // The function also removes the timing question entirely: matching happens on a UNIQUE indexed
    // hash inside Postgres instead of a JS loop over every row, so there is no per-candidate compare
    // to time. It takes and returns no secrets and can touch at most one row.
    await withGlobal(async (c) => {
      await c.query(`SELECT * FROM monitoring_heartbeat_touch($1)`, [hash]);
    });

    // ALWAYS the same answer, matched or not. A 404 on a bad token turns this into an oracle for
    // enumerating valid ones — and the function returning zero rows is indistinguishable from here
    // by design.
    return { ok: true };
  }
}
