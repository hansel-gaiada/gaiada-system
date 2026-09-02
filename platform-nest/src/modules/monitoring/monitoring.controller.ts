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
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { config } from "../../config";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { authorize } from "../../core/http";
import { withTenants, withGlobal } from "../../db";
import { getDriver, hasDriver, listKindSpecs, parseKind } from "./drivers/registry";
import {
  assertHostAllowlisted,
  buildRawDriverConfig,
  extractTargetHost,
  parseChannelKind,
  parseIntervalSec,
  parseMaintenanceScope,
  parseMaintenanceWindow,
  parseOptionalMatchKind,
  parseOptionalMatchSeverity,
  parseResultWindow,
  parseSeverity,
  parseTags,
  type MonitorChannelKind,
  MonitorValidationError,
} from "./write-validation";
import { enqueueMail } from "../../mail/queue";
import { isPlausibleEmail } from "../../mail/sanitize";

const MOD = { modules: ["monitoring"] as string[] };
// MON-19 — the SSRF allowlist (constraint 2) is resolved from `search_properties`, a table owned by
// the `search` module. Declaring BOTH scopes here is deliberate, not a widening: this transaction
// genuinely reads a search-owned table AND writes a monitoring-owned one, and `opts.modules` exists
// precisely so a handler states which module-sliced tables it is allowed to touch — omitting `search`
// would make the allowlist query return ZERO rows with no error (the same fail-closed trap the third
// wall imposes on `monitoring` itself), which would then read as "no verified properties" and refuse
// every legitimate create. This does NOT require the tenant's `search` module to be enabled in
// `enabled_modules` — that is a separate, product-level gate (isModuleEnabled), not this
// request-scope declaration wall (0028's §2.4 distinction, restated for a cross-module read).
const MOD_WITH_SEARCH = { modules: ["monitoring", "search"] as string[] };

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

interface MonitorChannelRow {
  id: string;
  kind: string;
  name: string;
  destination: string | null;
  enabled: boolean;
  last_delivery_at: Date | null;
  last_delivery_ok: boolean | null;
  failure_count: number;
}

/** Mirrors `MonitorChannel` in platform-ui/src/lib/monitoring.ts. `destination` is returned exactly
 *  as stored — the DISPLAY-SAFE convention (contract note 7) is enforced at write time (callers must
 *  never put a secret in this column), not by truncating on the way out here. */
function mapChannel(r: MonitorChannelRow) {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    enabled: r.enabled,
    destination: r.destination,
    lastDeliveryAt: iso(r.last_delivery_at),
    lastDeliveryOk: r.last_delivery_ok,
    failureCount: r.failure_count,
  };
}

interface MonitorRouteRow {
  id: string;
  channel_id: string;
  channel_name: string | null;
  match_client_id: string | null;
  match_client_name: string | null;
  match_severity: string | null;
  match_kind: string | null;
  enabled: boolean;
}

/** Mirrors `MonitorRoute` in platform-ui/src/lib/monitoring.ts. */
function mapRoute(r: MonitorRouteRow) {
  return {
    id: r.id,
    channelId: r.channel_id,
    channelName: r.channel_name,
    matchClientId: r.match_client_id,
    matchClientName: r.match_client_name,
    matchSeverity: r.match_severity,
    matchKind: r.match_kind,
    enabled: r.enabled,
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

  /**
   * Results by an explicit window — separate from `MonitorDetail`'s embedded (fixed 24h, 500-row)
   * `results`, so the uptime strip / recent-checks views can ask for exactly the window they render
   * instead of re-slicing a fixed sample. `window` is one of a fixed literal set (write-validation.ts's
   * `RESULT_WINDOWS`) so it is never spliced into SQL as a caller-supplied string.
   */
  @Get(":tenantId/monitoring/monitors/:id/results")
  async monitorResults(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Query("window") window?: string,
  ) {
    await authorize(req.principal, { kind: "monitor", id, tenantId, module: "monitoring" }, "read");
    let interval: string;
    try {
      interval = parseResultWindow(window);
    } catch (e) {
      if (e instanceof MonitorValidationError) throw new BadRequestException(e.message);
      throw e;
    }
    return withTenants(
      [tenantId],
      async (c) => {
        const m = await c.query(`SELECT 1 FROM monitors WHERE id = $1 AND deleted_at IS NULL`, [id]);
        if (!m.rows[0]) throw new NotFoundException("monitor not found");
        const results = await c.query(
          `SELECT checked_at, status, latency_ms, detail FROM monitor_results
             WHERE monitor_id = $1 AND checked_at > now() - $2::interval
           ORDER BY checked_at DESC LIMIT 2000`,
          [id, interval],
        );
        return results.rows.map((r: Record<string, unknown>) => ({
          checkedAt: iso(r.checked_at as Date),
          status: r.status,
          latencyMs: r.latency_ms,
          detail: r.detail,
        }));
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

  /**
   * Schedules a window that suppresses BOTH alerting and SLA math for its duration (K7) — the one
   * write in this module that can make monitoring lie, which is why `monitoring.maintenance.create`
   * sits a tier above `monitoring.monitor.update` in the Cerbos policy (manager-tier only). `scope`
   * round-trips the exact string `GET /maintenance` renders (`"all"` or `"monitor:<uuid>"`), matching
   * `platform-ui/src/lib/monitoringActions.ts`'s `scheduleMaintenance` form field.
   */
  @Post(":tenantId/monitoring/maintenance")
  async createMaintenance(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: Record<string, unknown>,
  ) {
    await authorize(req.principal, { kind: "monitor_maintenance", tenantId, module: "monitoring" }, "create");

    let scope: { monitorId: string | null };
    let window: { startsAt: Date; endsAt: Date };
    try {
      scope = parseMaintenanceScope(body?.scope);
      window = parseMaintenanceWindow(body?.startsAt, body?.endsAt);
    } catch (e) {
      if (e instanceof MonitorValidationError) throw new BadRequestException(e.message);
      throw e;
    }
    const reason = typeof body?.reason === "string" && body.reason.trim() ? body.reason.trim() : null;

    return withTenants(
      [tenantId],
      async (c) => {
        // A tenant-wide window (`scope: "all"`) has no single client to hang off, and that is
        // correct — it suppresses every client's monitors at once. A monitor-scoped window inherits
        // that monitor's client, both because the column expects one and because it is genuinely
        // true: this window is scoped to that client's property.
        let clientId: string | null = null;
        if (scope.monitorId) {
          const m = await c.query<{ client_id: string }>(
            `SELECT client_id FROM monitors WHERE id = $1 AND deleted_at IS NULL`,
            [scope.monitorId],
          );
          if (!m.rows[0]) throw new BadRequestException("scope names a monitor that does not exist in this tenant");
          clientId = m.rows[0].client_id;
        }
        const ins = await c.query<{ id: string }>(
          `INSERT INTO monitor_maintenance (tenant_id, client_id, monitor_id, starts_at, ends_at, reason, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [
            tenantId, clientId, scope.monitorId,
            window.startsAt.toISOString(), window.endsAt.toISOString(),
            reason, req.principal.userId ?? null,
          ],
        );
        return { id: ins.rows[0].id };
      },
      MOD,
    );
  }

  /**
   * Ends suppression early — it cannot hide an outage that already happened, only stop hiding
   * future ones (`monitoring.maintenance.delete`'s own catalog description). No soft-delete column
   * exists on this table (unlike monitors/channels): a maintenance window is a schedule, not a
   * record anything else references, so a real DELETE is the honest operation.
   */
  @Delete(":tenantId/monitoring/maintenance/:id")
  async deleteMaintenance(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "monitor_maintenance", id, tenantId, module: "monitoring" }, "delete");
    return withTenants(
      [tenantId],
      async (c) => {
        const r = await c.query<{ id: string }>(`DELETE FROM monitor_maintenance WHERE id = $1 RETURNING id`, [id]);
        if (!r.rows[0]) throw new NotFoundException("maintenance window not found");
        return { id: r.rows[0].id };
      },
      MOD,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // MON-19 — monitor create / update / delete.
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  /**
   * A monitor definition written here IS the standing authorization for the platform to probe that
   * target on a schedule (design §4.3) — see the class-level comment. Two refusals are load-bearing
   * and NOT the same failure:
   *   · unknown kind, or a known kind with no registered driver -> 400. registry.ts's own rule
   *     ("absent, not silently inert") restated at the write boundary: accepting either would create
   *     a monitor that sits on the board forever reporting `unknown`.
   *   · a target whose host is not on the tenant+client's VERIFIED `search_properties` allowlist ->
   *     400. Without this, "create a monitor" is a scheduled SSRF primitive (constraint 2).
   */
  @Post(":tenantId/monitoring/monitors")
  async createMonitor(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: Record<string, unknown>,
  ) {
    await authorize(req.principal, { kind: "monitor", tenantId, module: "monitoring" }, "create");

    const name = String(body?.name ?? "").trim();
    if (!name) throw new BadRequestException("name is required");

    const kind = parseKind(body?.kind);
    if (kind === null) throw new BadRequestException(`unknown monitor kind '${String(body?.kind)}'`);
    if (!hasDriver(kind)) {
      throw new BadRequestException(
        `no monitor driver is registered for kind '${kind}' on this deployment — it cannot run`,
      );
    }

    const clientId = String(body?.clientId ?? "").trim();
    if (!clientId) throw new BadRequestException("clientId is required");

    let severity: string, intervalSec: number, tags: string[];
    const target = typeof body?.target === "string" ? body.target.trim() : "";
    let host: string | null;
    let rawConfig: unknown;
    try {
      severity = parseSeverity(body?.severity);
      intervalSec = parseIntervalSec(body?.intervalSec);
      tags = parseTags(body?.tags);
      host = extractTargetHost(kind, target);
      rawConfig = buildRawDriverConfig(kind, { target, assertions: body?.assertions, graceSec: body?.graceSec });
    } catch (e) {
      if (e instanceof MonitorValidationError) throw new BadRequestException(e.message);
      throw e;
    }

    let validatedConfig: unknown;
    try {
      validatedConfig = getDriver(kind).validate(rawConfig);
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : "invalid monitor configuration");
    }

    return withTenants(
      [tenantId],
      async (c) => {
        const clientRow = await c.query(`SELECT 1 FROM clients WHERE id = $1 AND deleted_at IS NULL`, [clientId]);
        if (!clientRow.rows[0]) throw new BadRequestException("clientId not found in this tenant");

        // ── THE SSRF FLOOR (constraint 2) ─────────────────────────────────────────────────────
        // Mirrors runner.ts's DUE_SELECT allowlist subquery exactly: VERIFIED properties for this
        // tenant+client ONLY. An unverified property contributes nothing, so typing a target is
        // never itself sufficient authorization to probe it — someone had to pass verification.
        if (host !== null) {
          const allow = await c.query<{ allowlist: string[] }>(
            `SELECT COALESCE(array_agg(DISTINCT p.domain), ARRAY[]::text[]) AS allowlist
               FROM search_properties p
              WHERE p.tenant_id = $1 AND p.client_id = $2
                AND p.verified_at IS NOT NULL AND p.deleted_at IS NULL`,
            [tenantId, clientId],
          );
          try {
            assertHostAllowlisted(host, allow.rows[0]?.allowlist ?? []);
          } catch (e) {
            throw new BadRequestException(e instanceof Error ? e.message : "target not allowlisted");
          }
        }

        const ins = await c.query<{ id: string }>(
          `INSERT INTO monitors
             (tenant_id, client_id, name, kind, config, target, interval_sec, severity, tags, created_by, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING id`,
          [
            tenantId, clientId, name, kind, JSON.stringify(validatedConfig), target || null,
            intervalSec, severity, tags, req.principal.userId ?? null, config.originSite,
          ],
        );
        const id = ins.rows[0].id;

        // MON-13's ingest token, minted only for heartbeat monitors. Returned ONCE, in plaintext,
        // exactly like the design of the ingest endpoint itself demands — it is never stored except
        // as a SHA-256 hash, and there is no read path that can recover it afterwards.
        let heartbeatToken: string | undefined;
        if (kind === "heartbeat") {
          heartbeatToken = randomBytes(24).toString("hex");
          const hash = createHash("sha256").update(heartbeatToken).digest("hex");
          const cfg = validatedConfig as { graceSec: number };
          await c.query(
            `INSERT INTO monitor_heartbeats (tenant_id, client_id, monitor_id, token_hash, grace_sec)
             VALUES ($1,$2,$3,$4,$5)`,
            [tenantId, clientId, id, hash, cfg.graceSec],
          );
        }

        // ── "AFTER ANY WRITE, ASSERT WHAT YOU WROTE" (constraint 1) ───────────────────────────
        // Reads the row back through the EXACT SAME tenant+module scope the INSERT just used. If
        // `opts.modules` were ever accidentally dropped from this call, the INSERT itself would
        // still throw (FORCE RLS's WITH CHECK), but a future refactor that swaps this to a looser
        // wrapper would not be caught by that — this line is the one that would catch it, because a
        // write that "succeeded" but is invisible under the scope that made it is exactly the silent
        // failure mode this module's tests are written to make loud.
        const check = await c.query(`SELECT id FROM monitors WHERE id = $1 AND deleted_at IS NULL`, [id]);
        if (!check.rows[0]) {
          throw new Error(`monitor ${id} was inserted but is not readable under its own write scope`);
        }

        return heartbeatToken ? { id, heartbeatToken } : { id };
      },
      MOD_WITH_SEARCH,
    );
  }

  /**
   * `kind` is intentionally NOT editable here. Changing what a monitor probes mid-life is close
   * enough to "a different monitor" that reusing the id would silently discard the driver contract
   * (and the config shape) the row was created under — delete and recreate is the correct path, and
   * an explicit refusal here is cheaper than a config-validation edge case nobody asked for.
   */
  @Patch(":tenantId/monitoring/monitors/:id")
  async updateMonitor(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    await authorize(req.principal, { kind: "monitor", id, tenantId, module: "monitoring" }, "update");

    return withTenants(
      [tenantId],
      async (c) => {
        const existing = await c.query<{
          kind: string; config: Record<string, unknown>; client_id: string; target: string | null;
        }>(`SELECT kind, config, client_id, target FROM monitors WHERE id = $1 AND deleted_at IS NULL`, [id]);
        if (!existing.rows[0]) throw new NotFoundException("monitor not found");
        if (body?.kind !== undefined && parseKind(body.kind) !== parseKind(existing.rows[0].kind)) {
          throw new BadRequestException("kind cannot be changed after creation — delete and recreate instead");
        }
        const kind = parseKind(existing.rows[0].kind);
        // Cannot be null: only a known, driver-registered kind is ever stored (createMonitor's own
        // gate), so a row reaching here always parses. Still checked, never assumed.
        if (kind === null || !hasDriver(kind)) {
          throw new BadRequestException(
            `monitor's stored kind '${existing.rows[0].kind}' has no registered driver — it cannot be updated safely`,
          );
        }

        const name = body?.name !== undefined ? String(body.name).trim() : undefined;
        if (name !== undefined && !name) throw new BadRequestException("name cannot be blank");

        let severity: string | undefined, intervalSec: number | undefined, tags: string[] | undefined;
        let enabled: boolean | undefined;
        let target = existing.rows[0].target ?? "";
        let host: string | null = null;
        let validatedConfig: unknown = existing.rows[0].config;
        const clientId = existing.rows[0].client_id;

        try {
          if (body?.severity !== undefined) severity = parseSeverity(body.severity);
          if (body?.intervalSec !== undefined) intervalSec = parseIntervalSec(body.intervalSec);
          if (body?.tags !== undefined) tags = parseTags(body.tags);
          if (body?.enabled !== undefined) enabled = Boolean(body.enabled);

          const targetProvided = typeof body?.target === "string";
          if (targetProvided) target = (body.target as string).trim();
          // Re-validated on EVERY update that can affect what gets dialled, not only when `target`
          // is present in the body: an assertion/graceSec-only edit still re-runs the SSRF check
          // (cheap, and closes the window where a property is un-verified after creation but the
          // monitor keeps its original, now-stale, authorization).
          if (targetProvided || body?.assertions !== undefined || body?.graceSec !== undefined) {
            const raw = buildRawDriverConfig(kind, { target, assertions: body?.assertions, graceSec: body?.graceSec });
            validatedConfig = getDriver(kind).validate(raw) as Record<string, unknown>;
          }
          host = extractTargetHost(kind, target);
        } catch (e) {
          if (e instanceof MonitorValidationError) throw new BadRequestException(e.message);
          throw e;
        }

        if (host !== null) {
          const allow = await c.query<{ allowlist: string[] }>(
            `SELECT COALESCE(array_agg(DISTINCT p.domain), ARRAY[]::text[]) AS allowlist
               FROM search_properties p
              WHERE p.tenant_id = $1 AND p.client_id = $2
                AND p.verified_at IS NOT NULL AND p.deleted_at IS NULL`,
            [tenantId, clientId],
          );
          try {
            assertHostAllowlisted(host, allow.rows[0]?.allowlist ?? []);
          } catch (e) {
            throw new BadRequestException(e instanceof Error ? e.message : "target not allowlisted");
          }
        }

        const sets: string[] = ["updated_at = now()", "config = $2"];
        const params: unknown[] = [id, JSON.stringify(validatedConfig)];
        if (name !== undefined) { params.push(name); sets.push(`name = $${params.length}`); }
        if (target !== undefined) { params.push(target || null); sets.push(`target = $${params.length}`); }
        if (severity !== undefined) { params.push(severity); sets.push(`severity = $${params.length}`); }
        if (intervalSec !== undefined) { params.push(intervalSec); sets.push(`interval_sec = $${params.length}`); }
        if (tags !== undefined) { params.push(tags); sets.push(`tags = $${params.length}`); }
        if (enabled !== undefined) { params.push(enabled); sets.push(`enabled = $${params.length}`); }

        const upd = await c.query<{ id: string }>(
          `UPDATE monitors SET ${sets.join(", ")} WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
          params,
        );
        // Cross-tenant is proven here: company B's request runs inside `withTenants([tenantB])`, so
        // RLS makes company A's row invisible and this UPDATE matches zero rows — a 404, never a 200
        // that quietly touched nothing and never a leak of company A's data to construct the 403/404
        // decision. Same shape as the read suite's cross-tenant assertion, restated for a write.
        if (!upd.rows[0]) throw new NotFoundException("monitor not found");

        const check = await c.query<MonitorRow>(`${MONITOR_SELECT} AND m.id = $1`, [id]);
        if (!check.rows[0]) {
          throw new Error(`monitor ${id} was updated but is not readable under its own write scope`);
        }
        return mapMonitor(check.rows[0]);
      },
      MOD_WITH_SEARCH,
    );
  }

  /**
   * SOFT DELETE, matching every neighbouring module's convention for a user-facing entity
   * (`search_properties`, `clients`, `hr_cases`, `pm_tasks`, … all set `deleted_at = now()` rather
   * than issuing a `DELETE`) and matching this table's own DDL, which already carries `deleted_at`
   * for exactly this purpose. Two reasons this is the right call here specifically, not just
   * "because that's the house style":
   *   1. `monitor_results` is PARTITIONED and carries NO foreign key to `monitors` (0116's own
   *      header: retention is a partition DROP, not a row-level DELETE). A hard delete of the parent
   *      would either leave orphaned result rows with no monitor to belong to, or require an
   *      unindexed cross-partition scan to clean them up — fighting the entire reason the table is
   *      partitioned in the first place.
   *   2. An incident/uptime history is exactly the evidence an SLA figure or a postmortem depends
   *      on; the permission catalog's own description ("Delete monitors and their history") means
   *      "stop counting it and take it off the active board", not "make the outage undiscoverable"
   *      — a distinction the soft-delete + `enabled=false` combination makes true without a second
   *      code path.
   * `enabled = false` is set alongside `deleted_at` as defence in depth: every read path already
   * filters `deleted_at IS NULL`, but the runner's DUE_SELECT filters on `enabled = true` too, so a
   * reader that ever forgets the `deleted_at` half still cannot schedule a probe against this row.
   */
  @Delete(":tenantId/monitoring/monitors/:id")
  async deleteMonitor(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "monitor", id, tenantId, module: "monitoring" }, "delete");
    return withTenants(
      [tenantId],
      async (c) => {
        const r = await c.query<{ id: string; deleted_at: Date }>(
          `UPDATE monitors SET deleted_at = now(), enabled = false, updated_at = now()
             WHERE id = $1 AND deleted_at IS NULL
           RETURNING id, deleted_at`,
          [id],
        );
        if (!r.rows[0]) throw new NotFoundException("monitor not found");
        return { id: r.rows[0].id, deletedAt: iso(r.rows[0].deleted_at) };
      },
      MOD,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // MON-20 — incident acknowledge: an ACCOUNTABILITY RECORD, not an edit and not a close.
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  /**
   * Records that a named person has seen this incident. Deliberately NOT idempotent-overwriting:
   * once `acknowledged_at` is set, a second call (from anyone) leaves it untouched and returns the
   * ORIGINAL claim — the first person who saw it is the fact being recorded, and a later click must
   * not silently reassign credit/accountability to someone else. There is no `close` action and this
   * endpoint never touches `closed_at`: an incident closes when the monitor recovers, and letting an
   * acknowledge (or an update) double as a close would let a human mark a still-failing check
   * resolved, which is exactly the false-green failure mode this whole module exists to prevent.
   */
  @Post(":tenantId/monitoring/incidents/:id/ack")
  async acknowledgeIncident(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "monitor_incident", id, tenantId, module: "monitoring" }, "acknowledge");
    return withTenants(
      [tenantId],
      async (c) => {
        const claimed = await c.query<{ id: string; acknowledged_at: Date; acknowledged_by: string }>(
          `UPDATE monitor_incidents SET acknowledged_at = now(), acknowledged_by = $2
             WHERE id = $1 AND acknowledged_at IS NULL
           RETURNING id, acknowledged_at, acknowledged_by`,
          [id, req.principal.userId ?? null],
        );
        if (claimed.rows[0]) {
          return {
            id: claimed.rows[0].id,
            acknowledgedAt: iso(claimed.rows[0].acknowledged_at),
            acknowledgedBy: claimed.rows[0].acknowledged_by,
          };
        }
        // Not updated: either it does not exist under this tenant (cross-tenant / bad id -> 404), or
        // it is already acknowledged (return the EXISTING claim, unchanged — see the doc comment).
        const existing = await c.query<{ id: string; acknowledged_at: Date | null; acknowledged_by: string | null }>(
          `SELECT id, acknowledged_at, acknowledged_by FROM monitor_incidents WHERE id = $1`,
          [id],
        );
        if (!existing.rows[0]) throw new NotFoundException("incident not found");
        return {
          id: existing.rows[0].id,
          acknowledgedAt: iso(existing.rows[0].acknowledged_at),
          acknowledgedBy: existing.rows[0].acknowledged_by,
        };
      },
      MOD,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // Channel + route management — the missing middle. Before these, `monitor_channels` /
  // `monitor_routes` rows could only be created by hand-SQL, so runner.ts:293-345's incident
  // fan-out (`monitor_routes -> monitor_channels -> enqueueMail("monitoring.alert")`) had nothing
  // to fan out to in practice.
  //
  // Authorized under `monitor_channel` for BOTH channels and routes, on purpose: there is no
  // dedicated `monitor_route` Cerbos kind, and there is not meant to be one — a route is a
  // channel's own routing rule, not an independently-owned resource, and minting a sixth Cerbos
  // kind for it would be six more artifacts (policy + derived-role wiring + pinned count tests)
  // for a resource with no ownership semantics of its own. `monitoring.channel.manage` covers
  // create/edit/delete/test uniformly — the Cerbos policy comment states this explicitly ("manage
  // also covers the test-send"), and the permission catalog has no separate channel/route delete
  // key, so delete reuses `manage` rather than inventing one.
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  @Get(":tenantId/monitoring/channels")
  async listChannels(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "monitor_channel", tenantId, module: "monitoring" }, "read");
    const rows = await withTenants(
      [tenantId],
      (c) =>
        c.query<MonitorChannelRow>(
          `SELECT id, kind, name, destination, enabled, last_delivery_at, last_delivery_ok, failure_count
             FROM monitor_channels WHERE deleted_at IS NULL ORDER BY name`,
        ),
      MOD,
    );
    return rows.rows.map(mapChannel);
  }

  @Post(":tenantId/monitoring/channels")
  async createChannel(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: Record<string, unknown>,
  ) {
    await authorize(req.principal, { kind: "monitor_channel", tenantId, module: "monitoring" }, "manage");

    const name = String(body?.name ?? "").trim();
    if (!name) throw new BadRequestException("name is required");

    let kind: MonitorChannelKind;
    try {
      kind = parseChannelKind(body?.kind);
    } catch (e) {
      if (e instanceof MonitorValidationError) throw new BadRequestException(e.message);
      throw e;
    }

    const destination = typeof body?.destination === "string" && body.destination.trim() ? body.destination.trim() : null;
    // An email channel with no address (or an implausible one) would sit on the console looking
    // like coverage and then silently never deliver — runner.ts's notifyIncidents skips any row
    // with `!ch.destination`. Only `email` is checked because it is the only kind with meaning for
    // "is this a valid address"; the others store an opaque display string.
    if (kind === "email") {
      if (!destination) throw new BadRequestException("destination (an email address) is required for an email channel");
      if (!isPlausibleEmail(destination)) throw new BadRequestException("destination is not a plausible email address");
    }
    const cfg = body?.config && typeof body.config === "object" && !Array.isArray(body.config) ? body.config : {};

    return withTenants(
      [tenantId],
      async (c) => {
        const ins = await c.query<{ id: string }>(
          `INSERT INTO monitor_channels (tenant_id, kind, name, config, destination, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [tenantId, kind, name, JSON.stringify(cfg), destination, config.originSite],
        );
        const id = ins.rows[0].id;
        // "After any write, assert what you wrote" (constraint 1) — same idiom as createMonitor.
        const check = await c.query(`SELECT id FROM monitor_channels WHERE id = $1 AND deleted_at IS NULL`, [id]);
        if (!check.rows[0]) {
          throw new Error(`monitor_channel ${id} was inserted but is not readable under its own write scope`);
        }
        return { id };
      },
      MOD,
    );
  }

  @Patch(":tenantId/monitoring/channels/:id")
  async updateChannel(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    await authorize(req.principal, { kind: "monitor_channel", id, tenantId, module: "monitoring" }, "manage");

    return withTenants(
      [tenantId],
      async (c) => {
        const existing = await c.query<{ kind: string }>(
          `SELECT kind FROM monitor_channels WHERE id = $1 AND deleted_at IS NULL`,
          [id],
        );
        if (!existing.rows[0]) throw new NotFoundException("channel not found");
        let kind = existing.rows[0].kind;

        const sets: string[] = ["updated_at = now()"];
        const params: unknown[] = [id];

        if (body?.kind !== undefined) {
          try {
            kind = parseChannelKind(body.kind);
          } catch (e) {
            if (e instanceof MonitorValidationError) throw new BadRequestException(e.message);
            throw e;
          }
          params.push(kind);
          sets.push(`kind = $${params.length}`);
        }
        if (body?.name !== undefined) {
          const name = String(body.name).trim();
          if (!name) throw new BadRequestException("name cannot be blank");
          params.push(name);
          sets.push(`name = $${params.length}`);
        }
        if (body?.destination !== undefined) {
          const destination =
            typeof body.destination === "string" && body.destination.trim() ? body.destination.trim() : null;
          if (kind === "email" && destination && !isPlausibleEmail(destination)) {
            throw new BadRequestException("destination is not a plausible email address");
          }
          params.push(destination);
          sets.push(`destination = $${params.length}`);
        }
        if (body?.config !== undefined) {
          const cfg = body.config && typeof body.config === "object" && !Array.isArray(body.config) ? body.config : {};
          params.push(JSON.stringify(cfg));
          sets.push(`config = $${params.length}`);
        }
        if (body?.enabled !== undefined) {
          params.push(Boolean(body.enabled));
          sets.push(`enabled = $${params.length}`);
        }

        const upd = await c.query<{ id: string }>(
          `UPDATE monitor_channels SET ${sets.join(", ")} WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
          params,
        );
        // Cross-tenant is proven here exactly as updateMonitor proves it: company B's request runs
        // inside withTenants([tenantB]), so RLS makes company A's row invisible and this UPDATE
        // matches zero rows — a 404, never a 200 that quietly touched nothing.
        if (!upd.rows[0]) throw new NotFoundException("channel not found");

        const row = await c.query<MonitorChannelRow>(
          `SELECT id, kind, name, destination, enabled, last_delivery_at, last_delivery_ok, failure_count
             FROM monitor_channels WHERE id = $1`,
          [id],
        );
        return mapChannel(row.rows[0]);
      },
      MOD,
    );
  }

  /**
   * SOFT DELETE, matching monitors/status_pages: `monitor_routes` rows keep referencing this
   * channel_id (no cascade on a soft delete), but `notifyIncidents`'s own join already filters
   * `ch.deleted_at IS NULL`, so a deleted channel simply stops receiving events without a second
   * code path to keep in sync.
   */
  @Delete(":tenantId/monitoring/channels/:id")
  async deleteChannel(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "monitor_channel", id, tenantId, module: "monitoring" }, "manage");
    return withTenants(
      [tenantId],
      async (c) => {
        const r = await c.query<{ id: string; deleted_at: Date }>(
          `UPDATE monitor_channels SET deleted_at = now(), enabled = false, updated_at = now()
             WHERE id = $1 AND deleted_at IS NULL
           RETURNING id, deleted_at`,
          [id],
        );
        if (!r.rows[0]) throw new NotFoundException("channel not found");
        return { id: r.rows[0].id, deletedAt: iso(r.rows[0].deleted_at) };
      },
      MOD,
    );
  }

  /**
   * Sends a REAL notification through the exact path a real incident would use —
   * `enqueueMail("monitoring.alert")`, the same template runner.ts's `notifyIncidents` uses — rather
   * than a health check that proves nothing about whether the destination actually receives mail.
   * Only `email` has a wired delivery driver today (`parseChannelKind`'s doc comment; runner.ts's own
   * comment: "Email is the only channel kind wired today"), so any other kind refuses loudly instead
   * of reporting a fake `{ok:true}` for a send that never happened.
   *
   * `channel.destination` is NEVER logged — it is a webhook URL / address, and
   * `monitoring.channel.manage` is a broad grant.
   */
  @Post(":tenantId/monitoring/channels/:id/test")
  async testChannel(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "monitor_channel", id, tenantId, module: "monitoring" }, "manage");

    const channel = await withTenants(
      [tenantId],
      async (c) => {
        const row = await c.query<{ id: string; kind: string; name: string; destination: string | null }>(
          `SELECT id, kind, name, destination FROM monitor_channels WHERE id = $1 AND deleted_at IS NULL`,
          [id],
        );
        if (!row.rows[0]) throw new NotFoundException("channel not found");
        return row.rows[0];
      },
      MOD,
    );

    if (channel.kind !== "email") {
      throw new BadRequestException(
        `no notification driver is registered for channel kind '${channel.kind}' on this deployment — it cannot deliver a test`,
      );
    }
    if (!channel.destination) {
      throw new BadRequestException("channel has no destination configured");
    }

    await enqueueMail({
      stream: "notify",
      templateKey: "monitoring.alert",
      toEmail: channel.destination,
      tenantId,
      entityType: "monitor_channel",
      entityId: channel.id,
      payload: {
        event: "opened",
        siteName: `Test notification — ${channel.name}`,
        target: "monitoring channel test",
        status: "test",
        reason:
          "This is a test notification triggered from the monitoring channel console. No real incident is open.",
        href: `${config.mail.linkBaseUrl}/monitoring/channels`,
      },
    });

    return { ok: true };
  }

  @Get(":tenantId/monitoring/routes")
  async listRoutes(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "monitor_channel", tenantId, module: "monitoring" }, "read");
    const rows = await withTenants(
      [tenantId],
      (c) =>
        c.query<MonitorRouteRow>(
          `SELECT r.id, r.channel_id, ch.name AS channel_name, r.match_client_id,
                  cl.name AS match_client_name, r.match_severity, r.match_kind, r.enabled
             FROM monitor_routes r
             JOIN monitor_channels ch ON ch.id = r.channel_id
             LEFT JOIN clients cl ON cl.id = r.match_client_id
            WHERE ch.deleted_at IS NULL
            ORDER BY ch.name, r.created_at`,
        ),
      MOD,
    );
    return rows.rows.map(mapRoute);
  }

  @Post(":tenantId/monitoring/routes")
  async createRoute(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: Record<string, unknown>,
  ) {
    await authorize(req.principal, { kind: "monitor_channel", tenantId, module: "monitoring" }, "manage");

    const channelId = String(body?.channelId ?? "").trim();
    if (!channelId) throw new BadRequestException("channelId is required");

    let matchSeverity: string | null;
    let matchKind: string | null;
    try {
      matchSeverity = parseOptionalMatchSeverity(body?.matchSeverity);
      matchKind = parseOptionalMatchKind(body?.matchKind);
    } catch (e) {
      if (e instanceof MonitorValidationError) throw new BadRequestException(e.message);
      throw e;
    }
    const matchClientId =
      typeof body?.matchClientId === "string" && body.matchClientId.trim() ? body.matchClientId.trim() : null;
    const enabled = body?.enabled === undefined ? true : Boolean(body.enabled);

    return withTenants(
      [tenantId],
      async (c) => {
        const ch = await c.query(`SELECT 1 FROM monitor_channels WHERE id = $1 AND deleted_at IS NULL`, [channelId]);
        if (!ch.rows[0]) throw new BadRequestException("channelId not found in this tenant");
        if (matchClientId) {
          const cl = await c.query(`SELECT 1 FROM clients WHERE id = $1 AND deleted_at IS NULL`, [matchClientId]);
          if (!cl.rows[0]) throw new BadRequestException("matchClientId not found in this tenant");
        }
        const ins = await c.query<{ id: string }>(
          `INSERT INTO monitor_routes (tenant_id, channel_id, match_client_id, match_severity, match_kind, enabled)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [tenantId, channelId, matchClientId, matchSeverity, matchKind, enabled],
        );
        return { id: ins.rows[0].id };
      },
      MOD,
    );
  }

  @Patch(":tenantId/monitoring/routes/:id")
  async updateRoute(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    await authorize(req.principal, { kind: "monitor_channel", id, tenantId, module: "monitoring" }, "manage");

    return withTenants(
      [tenantId],
      async (c) => {
        const sets: string[] = [];
        const params: unknown[] = [id];

        if (body?.matchClientId !== undefined) {
          const matchClientId =
            typeof body.matchClientId === "string" && body.matchClientId.trim() ? body.matchClientId.trim() : null;
          if (matchClientId) {
            const cl = await c.query(`SELECT 1 FROM clients WHERE id = $1 AND deleted_at IS NULL`, [matchClientId]);
            if (!cl.rows[0]) throw new BadRequestException("matchClientId not found in this tenant");
          }
          params.push(matchClientId);
          sets.push(`match_client_id = $${params.length}`);
        }
        if (body?.matchSeverity !== undefined) {
          let matchSeverity: string | null;
          try {
            matchSeverity = parseOptionalMatchSeverity(body.matchSeverity);
          } catch (e) {
            if (e instanceof MonitorValidationError) throw new BadRequestException(e.message);
            throw e;
          }
          params.push(matchSeverity);
          sets.push(`match_severity = $${params.length}`);
        }
        if (body?.matchKind !== undefined) {
          params.push(parseOptionalMatchKind(body.matchKind));
          sets.push(`match_kind = $${params.length}`);
        }
        if (body?.enabled !== undefined) {
          params.push(Boolean(body.enabled));
          sets.push(`enabled = $${params.length}`);
        }
        if (sets.length === 0) throw new BadRequestException("nothing to update");

        const upd = await c.query<{ id: string }>(
          `UPDATE monitor_routes SET ${sets.join(", ")} WHERE id = $1 RETURNING id`,
          params,
        );
        if (!upd.rows[0]) throw new NotFoundException("route not found");

        const row = await c.query<MonitorRouteRow>(
          `SELECT r.id, r.channel_id, ch.name AS channel_name, r.match_client_id,
                  cl.name AS match_client_name, r.match_severity, r.match_kind, r.enabled
             FROM monitor_routes r
             JOIN monitor_channels ch ON ch.id = r.channel_id
             LEFT JOIN clients cl ON cl.id = r.match_client_id
            WHERE r.id = $1`,
          [id],
        );
        return mapRoute(row.rows[0]);
      },
      MOD,
    );
  }

  /** Hard delete: `monitor_routes` has no `deleted_at` column — it is a routing rule, not a record
   *  anything else references or that history depends on (unlike monitors/channels/incidents). */
  @Delete(":tenantId/monitoring/routes/:id")
  async deleteRoute(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "monitor_channel", id, tenantId, module: "monitoring" }, "manage");
    return withTenants(
      [tenantId],
      async (c) => {
        const r = await c.query<{ id: string }>(`DELETE FROM monitor_routes WHERE id = $1 RETURNING id`, [id]);
        if (!r.rows[0]) throw new NotFoundException("route not found");
        return { id: r.rows[0].id };
      },
      MOD,
    );
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
