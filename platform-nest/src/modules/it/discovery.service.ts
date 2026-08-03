// IT-03/IT-05 — network-discovery ingest, server-side classification, derived status, stale reaper.
// Design: docs/superpowers/specs/2026-08-03-it-network-discovery-design.md
//
// The collector (it-site-collector) runs INSIDE the office because the ERP cannot route to the
// UniFi controller at all (10.10.0.1 is RFC1918 behind NAT; curl from gda-aicenter → HTTP 000,
// verified). It therefore pushes here. Everything in this file treats the report as UNTRUSTED
// input from an agent on a user network: classification is recomputed server-side, BYOD is dropped
// before it can ever become a row, and the agent is not permitted to set `status`.
import type { PoolClient } from "pg";
import { newId, withGlobal, withTenants } from "../../db";
import { config } from "../../config";
import { emitEvent } from "../../events/outbox.service";

export type DeviceClass = "infrastructure" | "managed" | "byod";
export type DeviceStatus = "online" | "offline" | "degraded" | "unknown";

// One client/device as the collector reports it. `status` is deliberately absent — see file header.
export interface ReportedDevice {
  externalId: string;
  name?: string | null;
  hostname?: string | null;
  kind?: string | null;
  mac?: string | null;
  ip?: string | null;
  vendor?: string | null;
  model?: string | null;
  firmware?: string | null;
  isWired?: boolean | null;
  ssid?: string | null;
  network?: string | null;
  site?: string | null;
  uplinkMac?: string | null;
  uplinkPort?: number | null;
  /** True when the controller reports this as an ADOPTED UniFi device (gateway/AP/switch). */
  adopted?: boolean | null;
  lastSeenAt?: string | null;
  latencyMs?: number | null;
  uptimeSec?: number | null;
}

export interface DiscoveryReport {
  source?: string;
  site?: string | null;
  devices?: ReportedDevice[];
  error?: string | null;
}

export interface IngestResult {
  runId: string;
  devicesSeen: number;
  devicesUpserted: number;
  byodCount: number;
  linksUpserted: number;
}

const HEARTBEAT_WINDOW = 40; // must match it.controller.ts — same sparkline series
const VALID_KINDS = new Set(["cctv", "printer", "server", "workstation", "network", "sensor", "iot", "other"]);

// ═══════════════════════ Pure helpers (unit-tested in discovery.test.ts) ═══════════════════════

/** Compile the configured managed-hostname patterns once, skipping any that don't compile so one
 *  bad env value can't take the whole ingest path down. */
export function compilePatterns(patterns: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p, "i"));
    } catch {
      // An unparseable pattern is a config error, not a request error: ignore it rather than
      // failing every poll. It surfaces as devices classifying 'byod' (default-deny), never as
      // an over-permissive classification.
    }
  }
  return out;
}

/**
 * Classify a reported host. DEFAULT-DENY: anything that isn't adopted infrastructure and doesn't
 * match a corporate hostname pattern is 'byod', which (with persistByod off) is counted and
 * discarded. Recomputed server-side — the agent's own opinion is never trusted, because a
 * mis-set or compromised collector would otherwise be able to launder personal phones into the
 * registry and defeat the §6 privacy gate.
 */
export function classifyDevice(d: ReportedDevice, patterns: RegExp[]): DeviceClass {
  if (d.adopted) return "infrastructure";
  const candidates = [d.hostname, d.name].filter((s): s is string => typeof s === "string" && s.trim() !== "");
  for (const c of candidates) {
    if (patterns.some((re) => re.test(c.trim()))) return "managed";
  }
  return "byod";
}

/**
 * Derive status from last-seen freshness. This replaces the old dead-end where a device registered
 * through the UI sat at 'unknown' forever (nothing ever called the heartbeat endpoint), so the
 * whole topology rendered grey.
 *
 * NOTE: freshness comes from the controller's client table, never from an ICMP probe — only 12 of
 * the 58 real office hosts answer ping, so a ping-based liveness check would report most of the
 * network as offline.
 */
export function deriveStatus(
  lastSeenAt: Date | string | null | undefined,
  now: Date = new Date(),
  windows: { onlineWindowMs: number; degradedWindowMs: number } = config.itDiscovery,
): DeviceStatus {
  if (lastSeenAt == null) return "unknown";
  const seen = lastSeenAt instanceof Date ? lastSeenAt : new Date(lastSeenAt);
  if (Number.isNaN(seen.getTime())) return "unknown";
  const age = now.getTime() - seen.getTime();
  // A clock-skewed agent reporting the future is still "seen"; clamp rather than fall through to
  // offline, which would flap the whole estate on a bad NTP day.
  if (age < 0) return "online";
  if (age <= windows.onlineWindowMs) return "online";
  if (age <= windows.degradedWindowMs) return "degraded";
  return "offline";
}

/** Collector-owned columns an operator may pin via PATCH. Anything outside this set is not an
 *  override — it's a plain column write (see it.controller.ts patchDevice). */
export const OVERRIDABLE = ["name", "kind", "site", "network", "vendor", "model", "firmware", "labels"] as const;
export type OverridableKey = (typeof OVERRIDABLE)[number];

/**
 * Merge operator overrides over collector-reported values. Without this, every human correction to
 * a discovered row would be silently reverted by the next poll ~5 minutes later, which presents as
 * "the edit button doesn't work".
 */
export function applyOverrides<T extends Record<string, unknown>>(
  row: T,
  overrides: Record<string, unknown> | null | undefined,
): T {
  if (!overrides) return row;
  const out = { ...row };
  for (const k of OVERRIDABLE) {
    if (Object.prototype.hasOwnProperty.call(overrides, k) && overrides[k] !== undefined) {
      (out as Record<string, unknown>)[k] = overrides[k];
    }
  }
  return out;
}

/** Map a reported kind onto the it_devices CHECK set; adopted infrastructure is always 'network'. */
export function normalizeKind(d: ReportedDevice): string {
  if (d.adopted) return "network";
  const k = (d.kind ?? "").trim().toLowerCase();
  return VALID_KINDS.has(k) ? k : "other";
}

// ═══════════════════════════════════ Ingest ═══════════════════════════════════

/**
 * Apply one discovery report. Idempotent per device: re-posting the same report upserts the same
 * rows and produces no new events, so a collector retry after a network blip is harmless.
 */
export async function ingestReport(
  tenantId: string,
  report: DiscoveryReport,
  now: Date = new Date(),
): Promise<IngestResult> {
  const patterns = compilePatterns(config.itDiscovery.managedHostnamePatterns);
  const reported = Array.isArray(report.devices) ? report.devices : [];
  const seen = reported.filter((d) => typeof d?.externalId === "string" && d.externalId.trim() !== "");

  // Classify first, then split. BYOD never reaches a write statement unless explicitly enabled.
  const classified = seen.map((d) => ({ d, cls: classifyDevice(d, patterns) }));
  const byodCount = classified.filter((c) => c.cls === "byod").length;
  const keep = config.itDiscovery.persistByod ? classified : classified.filter((c) => c.cls !== "byod");

  return withTenants([tenantId], async (c) => {
    const runId = newId();
    await c.query(
      `INSERT INTO it_discovery_runs (id, tenant_id, source, started_at, devices_seen, byod_count, origin_site)
       VALUES ($1, $2, 'unifi', $3, $4, $5, $6)`,
      [runId, tenantId, now.toISOString(), seen.length, byodCount, config.originSite],
    );

    let upserted = 0;
    // mac -> device id, for uplink resolution after every row exists.
    const macToId = new Map<string, string>();
    const pendingLinks: { childId: string; uplinkMac: string; port: number | null; wired: boolean }[] = [];

    for (const { d, cls } of keep) {
      const status = deriveStatus(d.lastSeenAt ?? now, now);
      const sample = typeof d.latencyMs === "number" && Number.isFinite(d.latencyMs)
        ? Math.max(0, Math.round(d.latencyMs))
        : status === "online" ? 1 : 0;
      const kind = normalizeKind(d);
      const lastSeen = d.lastSeenAt ?? now.toISOString();

      const existing = await c.query<{ id: string; status: string; name: string }>(
        `SELECT id, status, name FROM it_devices
          WHERE tenant_id = $1 AND external_id = $2 AND discovery_source = 'unifi' AND deleted_at IS NULL`,
        [tenantId, d.externalId],
      );

      let deviceId: string;
      if (existing.rows[0]) {
        deviceId = existing.rows[0].id;
        await c.query(
          `UPDATE it_devices SET
             name = $2, hostname = $3, kind = $4, status = $5, device_class = $6,
             site = $7, network = $8, ip = $9, mac = $10, vendor = $11, model = $12, firmware = $13,
             is_wired = $14, ssid = $15, uplink_mac = $16, uplink_port = $17,
             last_seen_at = $18, last_heartbeat_at = $18,
             uptime_sec = COALESCE($19, uptime_sec),
             heartbeats = (array_append(heartbeats, $20))[GREATEST(1, array_length(array_append(heartbeats, $20), 1) - ${HEARTBEAT_WINDOW} + 1):],
             updated_at = now()
           WHERE id = $1`,
          [deviceId, d.name ?? d.hostname ?? d.externalId, d.hostname ?? null, kind, status, cls,
           d.site ?? report.site ?? null, d.network ?? null, d.ip ?? null, d.mac ?? null,
           d.vendor ?? null, d.model ?? null, d.firmware ?? null, d.isWired ?? null, d.ssid ?? null,
           d.uplinkMac ?? null, d.uplinkPort ?? null, lastSeen, d.uptimeSec ?? null, sample],
        );
        if (existing.rows[0].status !== status) {
          await recordEvent(c, tenantId, deviceId, status,
            status === "offline" ? "critical" : status === "degraded" ? "warn" : "info",
            `${existing.rows[0].name} is ${status}`);
        }
      } else {
        deviceId = newId();
        await c.query(
          `INSERT INTO it_devices
             (id, tenant_id, name, hostname, kind, status, device_class, discovery_source, external_id,
              site, network, ip, mac, vendor, model, firmware, is_wired, ssid, uplink_mac, uplink_port,
              heartbeats, first_seen_at, last_seen_at, last_heartbeat_at, uptime_sec, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'unifi',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
                   $20,$21,$21,$21,$22,$23)`,
          [deviceId, tenantId, d.name ?? d.hostname ?? d.externalId, d.hostname ?? null, kind, status, cls,
           d.externalId, d.site ?? report.site ?? null, d.network ?? null, d.ip ?? null, d.mac ?? null,
           d.vendor ?? null, d.model ?? null, d.firmware ?? null, d.isWired ?? null, d.ssid ?? null,
           d.uplinkMac ?? null, d.uplinkPort ?? null, [sample], lastSeen, d.uptimeSec ?? null,
           config.originSite],
        );
        await recordEvent(c, tenantId, deviceId, "registered", "info",
          `${d.name ?? d.hostname ?? d.externalId} discovered on the network`);
      }
      upserted += 1;
      if (d.mac) macToId.set(d.mac.toLowerCase(), deviceId);
      if (d.uplinkMac) {
        pendingLinks.push({
          childId: deviceId,
          uplinkMac: d.uplinkMac.toLowerCase(),
          port: d.uplinkPort ?? null,
          wired: d.isWired === true,
        });
      }
    }

    // Uplink parents may be devices we already had rather than ones in this batch (e.g. an AP
    // adopted months ago), so fall back to the tenant's existing MAC index before giving up.
    if (pendingLinks.length) {
      const known = await c.query<{ id: string; mac: string }>(
        `SELECT id, lower(mac) AS mac FROM it_devices
          WHERE tenant_id = $1 AND mac IS NOT NULL AND deleted_at IS NULL`,
        [tenantId],
      );
      for (const r of known.rows) if (!macToId.has(r.mac)) macToId.set(r.mac, r.id);
    }

    let linksUpserted = 0;
    for (const l of pendingLinks) {
      const parentId = macToId.get(l.uplinkMac);
      // An unresolved uplink is normal on a first poll (parent not yet adopted/reported) — skip it
      // rather than inventing a placeholder node that would show up as a phantom in the graph.
      if (!parentId || parentId === l.childId) continue;
      await c.query(
        `INSERT INTO it_device_links (id, tenant_id, child_device_id, parent_device_id, port, medium, observed_at, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,now(),$7)
         ON CONFLICT (tenant_id, child_device_id)
           DO UPDATE SET parent_device_id = EXCLUDED.parent_device_id,
                         port = EXCLUDED.port,
                         medium = EXCLUDED.medium,
                         observed_at = now()`,
        [newId(), tenantId, l.childId, parentId, l.port, l.wired ? "wired" : "wireless", config.originSite],
      );
      linksUpserted += 1;
    }

    await c.query(
      `UPDATE it_discovery_runs
          SET finished_at = now(), ok = $2, devices_upserted = $3, error = $4
        WHERE id = $1`,
      [runId, !report.error, upserted, report.error ?? null],
    );

    return { runId, devicesSeen: seen.length, devicesUpserted: upserted, byodCount, linksUpserted };
  });
}

// ═══════════════════════════════════ Stale reaper ═══════════════════════════════════

/**
 * Sweep one tenant: recompute status from last_seen_at and record transitions. This is what makes
 * "offline" mean something — without it a device that silently vanished would keep displaying the
 * last status the collector wrote before it disappeared.
 */
export async function sweepTenantStatuses(tenantId: string, now: Date = new Date()): Promise<number> {
  return withTenants([tenantId], async (c) => {
    const rows = await c.query<{ id: string; name: string; status: string; last_seen_at: Date | null }>(
      `SELECT id, name, status, last_seen_at FROM it_devices
        WHERE tenant_id = $1 AND deleted_at IS NULL AND discovery_source = 'unifi'`,
      [tenantId],
    );
    let changed = 0;
    for (const r of rows.rows) {
      const next = deriveStatus(r.last_seen_at, now);
      if (next === r.status) continue;
      await c.query(`UPDATE it_devices SET status = $2, updated_at = now() WHERE id = $1`, [r.id, next]);
      await recordEvent(c, tenantId, r.id, next,
        next === "offline" ? "critical" : next === "degraded" ? "warn" : "info",
        `${r.name} is ${next}`);
      changed += 1;
    }
    return changed;
  });
}

/** Sweep every company. Companies carry no tenant_id (they ARE the tenants), so the company list is
 *  read via withGlobal and each sweep then runs inside its own RLS-scoped withTenants transaction —
 *  same contract as modules/pm/burndown-job.ts. Per-tenant failures are logged and swallowed so one
 *  bad tenant cannot abort the sweep for the rest of the estate. */
export async function runStaleSweep(now: Date = new Date()): Promise<{ tenants: number; changed: number; errors: number }> {
  const { rows: tenants } = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL`),
  );
  let changed = 0;
  let errors = 0;
  for (const { id } of tenants) {
    try {
      changed += await sweepTenantStatuses(id, now);
    } catch (err) {
      errors += 1;
      // eslint-disable-next-line no-console
      console.error(`[IT-DISCOVERY-REAPER] tenant ${id} failed:`, (err as Error).message);
    }
  }
  return { tenants: tenants.length, changed, errors };
}

/** Reaper loop. Only started by main.ts when config.itDiscovery.reaperEnabled is set. Uses a
 *  self-rescheduling setTimeout rather than setInterval so a slow sweep can never overlap itself. */
export function startStaleReaperLoop(intervalMs: number): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const result = await runStaleSweep();
      if (result.errors > 0) {
        // eslint-disable-next-line no-console
        console.warn("[IT-DISCOVERY-REAPER] completed with errors:", result);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[IT-DISCOVERY-REAPER] tick failed:", (err as Error).message);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);
  timer.unref?.();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

// ═══════════════════════════════════ Shared ═══════════════════════════════════

/** Status/lifecycle event + platform event-backbone emit. Shared with it.controller.ts. */
export async function recordEvent(
  c: PoolClient, tenantId: string, deviceId: string, type: string, severity: string, message: string,
): Promise<void> {
  await c.query(
    `INSERT INTO it_device_events (id, tenant_id, device_id, type, severity, message, origin_site)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [newId(), tenantId, deviceId, type, severity, message, config.originSite],
  );
  if (type !== "heartbeat") await emitEvent(c, tenantId, "device", deviceId, `device.${type}`, { severity, message });
}
