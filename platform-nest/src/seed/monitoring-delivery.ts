// MONITORING DELIVERY seed — makes "where do alerts go" and "what's under maintenance" render
// something, for any tenant that already has monitors but almost no delivery config.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────────
// 0116_module_monitoring.sql (MON-10) ships nine tables. The probe side is well populated in the
// dev-stage dataset — real monitors, real monitor_results, real monitor_incidents — but the
// DELIVERY side (monitor_channels / monitor_routes) and the SUPPRESSION side (monitor_maintenance)
// were essentially untouched: one hand-made channel/route pair from console testing, and zero
// maintenance windows. A monitoring console with probes but no delivery config and no maintenance
// history renders those two panels empty, which looks like a missing feature rather than missing
// data.
//
// ── WHAT THIS SEEDS, PER TENANT THAT HAS AT LEAST ONE MONITOR ────────────────────────────────────
//   - two more monitor_channels (a Slack-style webhook + a second email), on top of whatever
//     already exists — never touches an existing channel;
//   - a catch-all monitor_route to each channel this run creates, so the new channel actually
//     receives something instead of sitting configured-but-silent (0116's own words: "a channel
//     that exists and is enabled while quietly failing is worse than no channel — it looks like
//     coverage", and an unrouted channel is the delivery-side version of that);
//   - two `monitor_maintenance` demonstration windows (one already-closed, one upcoming), tied to
//     real monitor rows, so the maintenance surface has a past example and a future example rather
//     than a permanent empty state.
//
// ── IDEMPOTENT ────────────────────────────────────────────────────────────────────────────────
// `monitor_channels` has UNIQUE(tenant_id, name) — used as the natural key, so re-running never
// creates a duplicate channel and never touches a channel a human later renames or reconfigures.
// `monitor_routes` and `monitor_maintenance` carry no natural unique key, so this checks for an
// equivalent row (same channel + same catch-all shape; same monitor + same seed-authored reason)
// before inserting.
//
// ⚠ MONITORING IS MODULE-GATED, LIKE finance/hr/lms. Every table here composes
// `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('monitoring')` (0116 §"RLS: one
// loop, one predicate"). A `withTenants([t], fn)` WITHOUT `{ modules: ["monitoring"] }` leaves
// `app.scopes` unset, every row fails the predicate, and a read/write silently sees/affects ZERO
// rows — the RLS zero-row trap. Every call below passes it.
//
// ⚠ NEVER discover candidate tenants by querying a monitoring table under `withGlobal`. `withGlobal`
// sets no GUC at all, so `monitors` would silently read ZERO rows under FORCE RLS and this script
// would conclude no tenant has any monitors. Tenants are discovered from the GLOBAL `companies`
// table instead, then each candidate is checked for monitors from INSIDE a properly-scoped
// `withTenants(..., { modules: ["monitoring"] })` call.
import { withTenants, withGlobal, closePool } from "../db";

interface ChannelSeed {
  name: string;
  kind: string;
  destination: string;
}

/** Seed-authored channels. Deliberately generic ("Ops Alerts", "On-call") rather than naming a real
 *  person's inbox a second time — `monitor_channels` already has one hand-made channel
 *  ("Hansel (email)") from console testing, and this must not collide with or shadow it. */
const WANTED_CHANNELS: ChannelSeed[] = [
  { name: "Ops Alerts (Slack)", kind: "slack_webhook", destination: "#ops-alerts" },
  { name: "On-call (email)", kind: "email", destination: "oncall@gaiada.com" },
];

export interface MonitoringDeliveryResult {
  tenantId: string;
  tenantName: string;
  monitorCount: number;
  channelsCreated: string[];
  routesCreated: number;
  maintenanceCreated: string[];
}

export async function seedMonitoringDelivery(): Promise<MonitoringDeliveryResult[]> {
  const companies = await withGlobal((c) =>
    c.query<{ id: string; name: string }>(
      `SELECT id, name FROM companies WHERE deleted_at IS NULL ORDER BY name`,
    ),
  );

  const results: MonitoringDeliveryResult[] = [];

  for (const company of companies.rows) {
    const result = await withTenants(
      [company.id],
      async (c): Promise<MonitoringDeliveryResult | null> => {
        const monitorCount = await c.query<{ n: string }>(
          `SELECT count(*) AS n FROM monitors WHERE tenant_id = $1 AND deleted_at IS NULL`,
          [company.id],
        );
        const nMonitors = Number(monitorCount.rows[0]?.n ?? 0);
        if (nMonitors === 0) return null; // nothing to deliver alerts FOR — leave this tenant alone

        const out: MonitoringDeliveryResult = {
          tenantId: company.id,
          tenantName: company.name,
          monitorCount: nMonitors,
          channelsCreated: [],
          routesCreated: 0,
          maintenanceCreated: [],
        };

        // ── channels + a catch-all route each ────────────────────────────────────────────────────
        for (const ch of WANTED_CHANNELS) {
          const existing = await c.query<{ id: string }>(
            `SELECT id FROM monitor_channels WHERE tenant_id = $1 AND name = $2`,
            [company.id, ch.name],
          );
          if (existing.rows[0]) continue;

          const inserted = await c.query<{ id: string }>(
            `INSERT INTO monitor_channels (tenant_id, kind, name, config, destination, enabled, origin_site)
             VALUES ($1, $2, $3, '{}'::jsonb, $4, true, 'central')
             RETURNING id`,
            [company.id, ch.kind, ch.name, ch.destination],
          );
          out.channelsCreated.push(ch.name);
          const channelId = inserted.rows[0].id;

          const dupRoute = await c.query<{ id: string }>(
            `SELECT id FROM monitor_routes
              WHERE tenant_id = $1 AND channel_id = $2
                AND match_client_id IS NULL AND match_severity IS NULL AND match_kind IS NULL`,
            [company.id, channelId],
          );
          if (!dupRoute.rows[0]) {
            await c.query(
              `INSERT INTO monitor_routes
                 (tenant_id, channel_id, match_client_id, match_severity, match_kind, enabled)
               VALUES ($1, $2, NULL, NULL, NULL, true)`,
              [company.id, channelId],
            );
            out.routesCreated += 1;
          }
        }

        // ── two demonstration maintenance windows, tied to real monitors ────────────────────────
        const candidateMonitors = await c.query<{ id: string; name: string }>(
          `SELECT id, name FROM monitors WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY name LIMIT 2`,
          [company.id],
        );
        const windows: Array<{ monitor: { id: string; name: string }; hoursFromNow: [number, number]; reason: string }> = [];
        if (candidateMonitors.rows[0]) {
          windows.push({
            monitor: candidateMonitors.rows[0],
            hoursFromNow: [-48, -46], // already closed — a past example
            reason: "seed:monitoring-delivery — completed maintenance demo",
          });
        }
        if (candidateMonitors.rows[1]) {
          windows.push({
            monitor: candidateMonitors.rows[1],
            hoursFromNow: [72, 76], // upcoming — a future example
            reason: "seed:monitoring-delivery — scheduled maintenance demo",
          });
        }

        for (const w of windows) {
          const dup = await c.query<{ id: string }>(
            `SELECT id FROM monitor_maintenance WHERE tenant_id = $1 AND monitor_id = $2 AND reason = $3`,
            [company.id, w.monitor.id, w.reason],
          );
          if (dup.rows[0]) continue;
          await c.query(
            `INSERT INTO monitor_maintenance (tenant_id, client_id, monitor_id, starts_at, ends_at, reason)
             SELECT $1, m.client_id, $2,
                    now() + ($3 || ' hours')::interval,
                    now() + ($4 || ' hours')::interval,
                    $5
               FROM monitors m WHERE m.id = $2`,
            [company.id, w.monitor.id, String(w.hoursFromNow[0]), String(w.hoursFromNow[1]), w.reason],
          );
          out.maintenanceCreated.push(`${w.monitor.name}: ${w.reason}`);
        }

        return out;
      },
      { modules: ["monitoring"] },
    );

    if (result) results.push(result);
  }

  return results;
}

async function main(): Promise<void> {
  const results = await seedMonitoringDelivery();
  if (!results.length) {
    console.log("no tenant has any monitors — nothing to seed delivery config for.");
  }
  for (const r of results) {
    console.log(
      `${r.tenantName} (${r.monitorCount} monitors): ` +
        `+${r.channelsCreated.length} channel(s) [${r.channelsCreated.join(", ") || "none new"}], ` +
        `+${r.routesCreated} route(s), ` +
        `+${r.maintenanceCreated.length} maintenance window(s) [${r.maintenanceCreated.join("; ") || "none new"}]`,
    );
  }
  await closePool();
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
if (require.main === module) void main();
