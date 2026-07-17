// IT department subsystem (BFF §6) — device registry, status events, heartbeat ingest.
// Backs platform-ui lib/it.ts. Devices readable by any member; register/edit/heartbeat is
// company-admin or IT-staff only (Cerbos resource `device`). Topology is computed client-side.
// The n8n workflow viewer (/api/admin/automation/workflows*) lives in AdminSystemsController.
import {
  BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { authorize, writeActivity } from "../../core/http";
import { emitEvent } from "../../events/outbox.service";
import { AuthGuard } from "../../auth/guards";

const KINDS = new Set(["cctv", "printer", "server", "workstation", "network", "sensor", "iot", "other"]);
const STATUSES = new Set(["online", "offline", "degraded", "unknown"]);
const HEARTBEAT_WINDOW = 40; // series length kept for the sparkline

const DEVICE_SELECT = `
  SELECT id, name, kind, status, site, network, ip, mac, vendor, model, firmware,
         to_char(last_heartbeat_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "lastHeartbeatAt",
         to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "registeredAt",
         uptime_sec::text AS "uptimeSecText", labels
  FROM it_devices WHERE deleted_at IS NULL`;

interface DeviceRow {
  id: string; name: string; kind: string; status: string; site: string | null; network: string | null;
  ip: string | null; mac: string | null; vendor: string | null; model: string | null; firmware: string | null;
  lastHeartbeatAt: string | null; registeredAt: string | null; uptimeSecText: string | null; labels: string[];
}

function mapDevice(r: DeviceRow) {
  const { uptimeSecText, ...rest } = r;
  return { ...rest, uptimeSec: uptimeSecText == null ? null : Number(uptimeSecText) };
}

async function recordEvent(
  c: PoolClient, tenantId: string, deviceId: string, type: string, severity: string, message: string,
): Promise<void> {
  await c.query(
    `INSERT INTO it_device_events (id, tenant_id, device_id, type, severity, message, origin_site)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [newId(), tenantId, deviceId, type, severity, message, config.originSite],
  );
  // Status-change events also flow onto the platform event backbone → /admin/audit + bell.
  if (type !== "heartbeat") await emitEvent(c, tenantId, "device", deviceId, `device.${type}`, { severity, message });
}

@Controller("api")
@UseGuards(AuthGuard)
export class ItController {
  @Get(":tenantId/it/devices")
  async listDevices(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "device", tenantId }, "read");
    const rows = await withTenants([tenantId], (c) => c.query<DeviceRow>(`${DEVICE_SELECT} ORDER BY name`));
    return rows.rows.map(mapDevice);
  }

  @Get(":tenantId/it/devices/:deviceId")
  async getDevice(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("deviceId") deviceId: string) {
    await authorize(req.principal, { kind: "device", id: deviceId, tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const dev = await c.query<DeviceRow & { heartbeats: number[] }>(
        `${DEVICE_SELECT} AND id = $1`, [deviceId],
      );
      if (!dev.rows[0]) throw new NotFoundException("device not found");
      const hb = await c.query<{ heartbeats: number[] }>(`SELECT heartbeats FROM it_devices WHERE id = $1`, [deviceId]);
      const events = await c.query(
        `SELECT e.id, e.device_id AS "deviceId", d.name AS "deviceName", e.type, e.severity, e.message,
                e.occurred_at AS "occurred_at"
         FROM it_device_events e JOIN it_devices d ON d.id = e.device_id
         WHERE e.device_id = $1 ORDER BY e.occurred_at DESC LIMIT 50`,
        [deviceId],
      );
      return { ...mapDevice(dev.rows[0]), events: events.rows, heartbeats: hb.rows[0]?.heartbeats ?? [] };
    });
  }

  @Post(":tenantId/it/devices")
  @HttpCode(201)
  async registerDevice(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() b: { name?: string; kind?: string; site?: string; network?: string; ip?: string; vendor?: string; model?: string; mac?: string; firmware?: string; labels?: string[] },
  ) {
    const name = b?.name?.trim();
    if (!name) throw new BadRequestException("name required");
    const kind = b?.kind && KINDS.has(b.kind) ? b.kind : "other";
    await authorize(req.principal, { kind: "device", tenantId }, "create");
    const id = newId();
    const labels = Array.isArray(b?.labels) ? b.labels.filter((l) => typeof l === "string").slice(0, 20) : [];
    await withTenants([tenantId], async (c) => {
      await c.query(
        `INSERT INTO it_devices (id, tenant_id, name, kind, site, network, ip, mac, vendor, model, firmware, labels, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [id, tenantId, name, kind, b.site ?? null, b.network ?? null, b.ip ?? null, b.mac ?? null,
         b.vendor ?? null, b.model ?? null, b.firmware ?? null, labels, config.originSite],
      );
      await recordEvent(c, tenantId, id, "registered", "info", `${name} registered`);
    });
    await writeActivity(tenantId, req.principal.userId, "registered", "device", id, { name, kind });
    return { id };
  }

  @Get(":tenantId/it/events")
  async listEvents(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("deviceId") deviceId?: string,
    @Query("limit") limit?: string,
  ) {
    await authorize(req.principal, { kind: "device", tenantId }, "read");
    const lim = Math.max(1, Math.min(Number(limit ?? 50) || 50, 200));
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT e.id, e.device_id AS "deviceId", d.name AS "deviceName", e.type, e.severity, e.message,
                e.occurred_at AS "occurred_at"
         FROM it_device_events e JOIN it_devices d ON d.id = e.device_id
         WHERE ($1::uuid IS NULL OR e.device_id = $1) ORDER BY e.occurred_at DESC LIMIT $2`,
        [deviceId ?? null, lim],
      ),
    );
    return rows.rows;
  }

  // Heartbeat ingest (devices/agents push here). Backend-only surface; the UI only reads.
  // Appends to the reachability series, refreshes status, and emits a status-change event.
  @Post(":tenantId/it/devices/:deviceId/heartbeat")
  @HttpCode(200)
  async heartbeat(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("deviceId") deviceId: string,
    @Body() b: { status?: string; latencyMs?: number; uptimeSec?: number },
  ) {
    await authorize(req.principal, { kind: "device", id: deviceId, tenantId }, "update");
    const status = b?.status && STATUSES.has(b.status) ? b.status : "online";
    const sample = typeof b?.latencyMs === "number" && Number.isFinite(b.latencyMs) ? Math.max(0, Math.round(b.latencyMs)) : status === "online" ? 1 : 0;
    await withTenants([tenantId], async (c) => {
      const prev = await c.query<{ status: string; name: string }>(`SELECT status, name FROM it_devices WHERE id = $1 AND deleted_at IS NULL`, [deviceId]);
      if (!prev.rows[0]) throw new NotFoundException("device not found");
      await c.query(
        `UPDATE it_devices SET
           status = $2,
           uptime_sec = COALESCE($3, uptime_sec),
           last_heartbeat_at = now(),
           heartbeats = (array_append(heartbeats, $4))[GREATEST(1, array_length(array_append(heartbeats, $4), 1) - ${HEARTBEAT_WINDOW} + 1):],
           updated_at = now()
         WHERE id = $1`,
        [deviceId, status, b?.uptimeSec ?? null, sample],
      );
      if (prev.rows[0].status !== status) {
        const sev = status === "offline" ? "critical" : status === "degraded" ? "warn" : "info";
        await recordEvent(c, tenantId, deviceId, status, sev, `${prev.rows[0].name} is ${status}`);
      }
    });
    return { ok: true };
  }
}
