// IT department subsystem (BFF §6) — device registry, status events, heartbeat ingest, network
// discovery ingest, and the server-computed topology graph.
//
// Backs platform-ui lib/it.ts. Devices readable by any member; register/edit/delete/heartbeat and
// discovery-report ingest are company-admin or IT-staff only (Cerbos resource `device`).
// The n8n workflow viewer (/api/admin/automation/workflows*) lives in AdminSystemsController.
//
// IT-05 note — WHY THE DISCOVERY ENDPOINT AUTHORIZES ON `create`, NOT A NEW `discover` ACTION:
// the design doc proposed a dedicated Cerbos action. cerbos/policies/resource_device.yaml lists
// explicit actions, and an UNLISTED action is a silent DENY that presents as a logic bug — and a
// new policy file/action is not hot-reloaded over the Windows bind mount, so it needs a Cerbos
// restart to take effect (memory cerbos-new-policy-needs-restart). `create` and `update` are
// already granted to exactly the intended principals (company_admin, it_staff), so reusing them
// keeps this deployable without a policy change or a restart. Revisit only if the collector needs
// rights that genuinely differ from "register/edit devices".
import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post,
  Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { authorize, writeActivity } from "../../core/http";
import { emitEvent } from "../../events/outbox.service";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import {
  applyOverrides, deriveStatus, ingestReport, recordEvent, OVERRIDABLE,
  type DiscoveryReport, type OverridableKey,
} from "./discovery.service";

const KINDS = new Set(["cctv", "printer", "server", "workstation", "network", "sensor", "iot", "other"]);
const STATUSES = new Set(["online", "offline", "degraded", "unknown"]);
const HEARTBEAT_WINDOW = 40; // series length kept for the sparkline

const DEVICE_SELECT = `
  SELECT id, name, kind, status, site, network, ip, mac, vendor, model, firmware,
         discovery_source AS "discoverySource", device_class AS "deviceClass", hostname,
         is_wired AS "isWired", ssid, uplink_mac AS "uplinkMac", uplink_port AS "uplinkPort",
         to_char(last_heartbeat_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "lastHeartbeatAt",
         to_char(last_seen_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "lastSeenAt",
         to_char(first_seen_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "firstSeenAt",
         to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "registeredAt",
         uptime_sec::text AS "uptimeSecText", labels, overrides
  FROM it_devices WHERE deleted_at IS NULL`;

interface DeviceRow {
  id: string; name: string; kind: string; status: string; site: string | null; network: string | null;
  ip: string | null; mac: string | null; vendor: string | null; model: string | null; firmware: string | null;
  discoverySource: string; deviceClass: string; hostname: string | null; isWired: boolean | null;
  ssid: string | null; uplinkMac: string | null; uplinkPort: number | null;
  lastHeartbeatAt: string | null; lastSeenAt: string | null; firstSeenAt: string | null;
  registeredAt: string | null; uptimeSecText: string | null; labels: string[];
  overrides: Record<string, unknown> | null;
}

// Operator overrides win over collector-reported values on the way OUT, so a human correction to a
// discovered row is what everyone sees even though the next poll rewrites the underlying column.
function mapDevice(r: DeviceRow) {
  const { uptimeSecText, overrides, ...rest } = r;
  const merged = applyOverrides(rest as unknown as Record<string, unknown>, overrides);
  return { ...merged, uptimeSec: uptimeSecText == null ? null : Number(uptimeSecText) };
}

@Controller("api")
@UseGuards(AuthGuard, ModuleEnabledGuard("it"))
export class ItController {
  @Get(":tenantId/it/devices")
  async listDevices(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("deviceClass") deviceClass?: string,
    @Query("q") q?: string,
  ) {
    await authorize(req.principal, { kind: "device", tenantId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query<DeviceRow>(
        `${DEVICE_SELECT}
           AND ($1::text IS NULL OR device_class = $1)
           AND ($2::text IS NULL OR name ILIKE '%' || $2 || '%' OR hostname ILIKE '%' || $2 || '%'
                OR ip ILIKE '%' || $2 || '%' OR mac ILIKE '%' || $2 || '%')
         ORDER BY name`,
        [deviceClass ?? null, q?.trim() || null],
      ),
    );
    return rows.rows.map(mapDevice);
  }

  @Get(":tenantId/it/devices/:deviceId")
  async getDevice(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("deviceId") deviceId: string) {
    await authorize(req.principal, { kind: "device", id: deviceId, tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const dev = await c.query<DeviceRow>(`${DEVICE_SELECT} AND id = $1`, [deviceId]);
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

  // IT-02 — the missing edit half. 0019_it_devices.sql and platform-ui lib/it.ts both promised
  // "register/edit"; only register was ever built, so a typo'd device was permanent.
  //
  // Two write modes, discriminated by discovery_source:
  //  - 'manual' rows: plain column writes (nothing else owns them).
  //  - 'unifi' rows: descriptive fields land in `overrides` instead, because the collector rewrites
  //    the real columns every interval — a direct write would silently revert within ~5 minutes.
  //    Collector-owned FACTS (ip, mac, hostname, uplink, status) are not editable on such a row;
  //    letting an operator pin them would make the registry disagree with the network and look
  //    like a discovery bug.
  @Patch(":tenantId/it/devices/:deviceId")
  async patchDevice(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("deviceId") deviceId: string,
    @Body() b: Record<string, unknown>,
  ) {
    await authorize(req.principal, { kind: "device", id: deviceId, tenantId }, "update");
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new BadRequestException("body required");
    if (b.kind !== undefined && !(typeof b.kind === "string" && KINDS.has(b.kind))) {
      throw new BadRequestException("invalid kind");
    }
    if (b.status !== undefined && !(typeof b.status === "string" && STATUSES.has(b.status))) {
      throw new BadRequestException("invalid status");
    }

    const MANUAL_COLUMNS: Record<string, string> = {
      name: "name", kind: "kind", status: "status", site: "site", network: "network", ip: "ip",
      mac: "mac", vendor: "vendor", model: "model", firmware: "firmware", labels: "labels",
    };

    await withTenants([tenantId], async (c) => {
      const cur = await c.query<{ id: string; name: string; discovery_source: string; overrides: Record<string, unknown> }>(
        `SELECT id, name, discovery_source, overrides FROM it_devices
          WHERE id = $1 AND deleted_at IS NULL`,
        [deviceId],
      );
      if (!cur.rows[0]) throw new NotFoundException("device not found");
      const discovered = cur.rows[0].discovery_source === "unifi";

      if (discovered) {
        const patch: Record<string, unknown> = {};
        for (const k of Object.keys(b)) {
          if (!(OVERRIDABLE as readonly string[]).includes(k)) {
            throw new BadRequestException(
              `"${k}" is reported by network discovery and cannot be edited; editable: ${OVERRIDABLE.join(", ")}`,
            );
          }
          patch[k] = b[k as OverridableKey];
        }
        if (!Object.keys(patch).length) throw new BadRequestException("no editable fields supplied");
        await c.query(
          `UPDATE it_devices SET overrides = overrides || $2::jsonb, updated_at = now() WHERE id = $1`,
          [deviceId, JSON.stringify(patch)],
        );
      } else {
        const sets: string[] = [];
        const vals: unknown[] = [deviceId];
        for (const k of Object.keys(b)) {
          const col = MANUAL_COLUMNS[k];
          if (!col) throw new BadRequestException(`unknown field "${k}"`);
          if (k === "name" && !String(b[k] ?? "").trim()) throw new BadRequestException("name cannot be empty");
          if (k === "labels") {
            const labels = Array.isArray(b[k]) ? (b[k] as unknown[]).filter((l) => typeof l === "string").slice(0, 20) : [];
            vals.push(labels);
          } else {
            vals.push(b[k] === "" ? null : b[k]);
          }
          sets.push(`${col} = $${vals.length}`);
        }
        if (!sets.length) throw new BadRequestException("no fields supplied");
        await c.query(`UPDATE it_devices SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, vals);
      }
    });
    await writeActivity(tenantId, req.principal.userId, "updated", "device", deviceId, { fields: Object.keys(b) });
    return { ok: true };
  }

  // IT-02 — soft delete. `deleted_at` has existed since 0019 and every read path already filters on
  // it, but nothing ever wrote it, so devices were immortal.
  @Delete(":tenantId/it/devices/:deviceId")
  async deleteDevice(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("deviceId") deviceId: string,
  ) {
    await authorize(req.principal, { kind: "device", id: deviceId, tenantId }, "delete");
    await withTenants([tenantId], async (c) => {
      const cur = await c.query<{ name: string }>(
        `SELECT name FROM it_devices WHERE id = $1 AND deleted_at IS NULL`, [deviceId],
      );
      if (!cur.rows[0]) throw new NotFoundException("device not found");
      await c.query(`UPDATE it_devices SET deleted_at = now(), updated_at = now() WHERE id = $1`, [deviceId]);
      // Drop its topology edges in both directions. Orphaned children simply re-link on the next
      // poll; leaving stale edges behind would draw the graph through a device that no longer exists.
      await c.query(
        `DELETE FROM it_device_links WHERE child_device_id = $1 OR parent_device_id = $1`, [deviceId],
      );
      // NOT recordEvent: it_device_events.type has a CHECK set that has no 'deleted' member, so the
      // lifecycle notice goes straight onto the platform event backbone instead.
      await emitEvent(c, tenantId, "device", deviceId, "device.deleted", { name: cur.rows[0].name });
    });
    await writeActivity(tenantId, req.principal.userId, "deleted", "device", deviceId, {});
    return { ok: true };
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

  // IT-05 — the real topology: nodes plus the resolved edge set, computed server-side. The old
  // client-side buildTopology() could only regroup rows by two free-text strings and had no way to
  // express an uplink, so it was a grouped list wearing the name "topology".
  //
  // `lastRun` is load-bearing, not decoration: without it a DEAD COLLECTOR and an EMPTY NETWORK
  // render identically, and an operator reads silence as "all clear".
  @Get(":tenantId/it/topology")
  async topology(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "device", tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const devices = await c.query<DeviceRow>(`${DEVICE_SELECT} ORDER BY name`);
      const links = await c.query<{ childDeviceId: string; parentDeviceId: string; port: number | null; medium: string }>(
        `SELECT l.child_device_id AS "childDeviceId", l.parent_device_id AS "parentDeviceId",
                l.port, l.medium
           FROM it_device_links l
           JOIN it_devices cd ON cd.id = l.child_device_id AND cd.deleted_at IS NULL
           JOIN it_devices pd ON pd.id = l.parent_device_id AND pd.deleted_at IS NULL
          WHERE l.tenant_id = $1`,
        [tenantId],
      );
      const run = await c.query<{ startedAt: string | null; finishedAt: string | null; ok: boolean; devicesSeen: number; byodCount: number; error: string | null }>(
        `SELECT to_char(started_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "startedAt",
                to_char(finished_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "finishedAt",
                ok, devices_seen AS "devicesSeen", byod_count AS "byodCount", error
           FROM it_discovery_runs WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT 1`,
        [tenantId],
      );
      return {
        devices: devices.rows.map(mapDevice),
        links: links.rows,
        lastRun: run.rows[0] ?? null,
      };
    });
  }

  // IT-05 — discovery ingest. Pushed by it-site-collector from inside the office; see the file
  // header for why this is push-based and why it authorizes on `create`.
  @Post(":tenantId/it/discovery/report")
  @HttpCode(200)
  async discoveryReport(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() b: DiscoveryReport,
  ) {
    await authorize(req.principal, { kind: "device", tenantId }, "create");
    if (!b || typeof b !== "object" || !Array.isArray(b.devices)) {
      throw new BadRequestException("devices[] required");
    }
    if (b.devices.length > 5000) throw new BadRequestException("report too large");
    const result = await ingestReport(tenantId, b);
    await writeActivity(tenantId, req.principal.userId, "reported", "device", result.runId, {
      devicesSeen: result.devicesSeen, devicesUpserted: result.devicesUpserted, byodCount: result.byodCount,
    });
    return result;
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
           last_seen_at = now(),
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

// Re-exported so callers that only need the freshness rule don't import the whole service.
export { deriveStatus };
