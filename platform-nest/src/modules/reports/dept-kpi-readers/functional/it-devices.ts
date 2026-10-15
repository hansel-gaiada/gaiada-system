// DW-7j f10 and f12 (docs/FRONTEND-BFF-CONTRACT.md §40.6.2): the IT estate's uptime and the devices that are not up. Company grain
// (§40.6.1): the unit in the context is ignored. Register both as `gated("it", ...)`: a company that turned IT off reads `null`.
//
// Walls: the IT tables (`it_devices`, `it_device_events`) carry the tenant wall only (0019, 0025), and IT's own controller reads them
// through `withTenants` with no `modules` option, so these readers declare none either. The module gate is `gated("it", ...)`.
//
// What a device's state is. `it_device_events` of type `online`, `offline` or `degraded` are the STATE CHANGES: the heartbeat handler
// (it.controller.ts) writes one only when the status moves, and `registered`, `alert` and `heartbeat` events say nothing about the
// state, so they are ignored. A device is DOWN while its last state change at that instant is `offline`; `degraded` is up, and a device
// with no state change is `online` from registration. Ties on the same instant go to the later row (`id` breaks them: the order is a
// total order, so a tie never reads two ways).
//
//   `it.uptime` (f10): every not-deleted device is measured over the window [start 00:00, end + 1 day 00:00) in REPORTS_TZ, clipped
//   to the device's life (it starts at `created_at`) and capped at the end of `asOf` (the future is never counted). Each `offline`
//   change is a down segment from its time to the next state change (or the cap); the segment is clipped to the same span, so the
//   state at the window's start is the last change before it and an `offline` before the window runs into it. Value: up-seconds over
//   device-seconds, both summed across devices, as `{value, numerator: upSeconds, denominator: deviceSeconds}`. `null` when no device
//   has any time in the span. The heartbeat writes an event only on a transition, so a device that went silent without a recorded
//   `offline` reads up: the UI note says so (§40.6.3).
//
//   `it.devices_alerting` (f12, a PROXY: DW-D30, devices offline or degraded, not threats): a point in time at the END of `asOf`. The
//   devices are the not-deleted ones created before that instant, and one alerts when its last state change before it is `offline` or
//   `degraded`. `{value: count}`, a real 0 when there are devices and all are up; `null` when no device existed at that instant (a
//   company with no device, or only devices registered after `asOf`). The window's start does not matter: it is a reading as of `asOf`.
import { config } from "../../../../config";
import { withTenants } from "../../../../db";
import type { ModuleKpiReader } from "../types";
import { windowEndSql, windowStartSql } from "../scope";

/** f10 · `it.uptime` */
export const itUptime: ModuleKpiReader = async (ctx) => {
  // $1 tenant, $2 start, $3 end, $4 zone, $5 asOf. `b.we` is the cap: the window's end, or the end of asOf when that is earlier.
  const sql =
    `WITH b AS (
       SELECT ${windowStartSql(2, 4)} AS ws, least(${windowEndSql(3, 4)}, ${windowEndSql(5, 4)}) AS we
     ), dev AS (
       SELECT d.id, greatest(b.ws, d.created_at) AS lo, b.we AS hi
         FROM it_devices d CROSS JOIN b
        WHERE d.tenant_id = $1::uuid AND d.deleted_at IS NULL
          AND greatest(b.ws, d.created_at) < b.we
     ), ev AS (
       SELECT e.device_id, e.type, e.occurred_at AS s,
              lead(e.occurred_at) OVER (PARTITION BY e.device_id ORDER BY e.occurred_at, e.id) AS nxt
         FROM it_device_events e CROSS JOIN b
        WHERE e.tenant_id = $1::uuid AND e.type IN ('online','offline','degraded') AND e.occurred_at < b.we
     )
     SELECT coalesce(sum(extract(epoch FROM (dev.hi - dev.lo))), 0)::float8 AS device_secs,
            coalesce(sum(x.down), 0)::float8 AS down_secs
       FROM dev
       LEFT JOIN LATERAL (
         SELECT sum(greatest(0, extract(epoch FROM (least(coalesce(ev.nxt, dev.hi), dev.hi) - greatest(ev.s, dev.lo))))) AS down
           FROM ev WHERE ev.device_id = dev.id AND ev.type = 'offline'
       ) x ON true`;
  const row = await withTenants([ctx.tenantId], async (c) => {
    const { rows } = await c.query<{ device_secs: number; down_secs: number }>(sql, [
      ctx.tenantId, ctx.start, ctx.end, config.reportsTz, ctx.asOf,
    ]);
    return rows[0];
  });
  const denominator = Number(row?.device_secs ?? 0);
  if (!(denominator > 0)) return null;
  const numerator = denominator - Number(row.down_secs);
  return { value: numerator / denominator, numerator, denominator };
};

/** f12 · `it.devices_alerting` */
export const itDevicesAlerting: ModuleKpiReader = async (ctx) => {
  // $1 tenant, $2 zone, $3 asOf. `cap` is the end of asOf: the first instant of the next day in the zone.
  const cap = windowEndSql(3, 2);
  const sql =
    `SELECT count(*)::int AS devices,
            (count(*) FILTER (WHERE last.type IN ('offline','degraded')))::int AS alerting
       FROM it_devices d
       LEFT JOIN LATERAL (
         SELECT e.type FROM it_device_events e
          WHERE e.tenant_id = $1::uuid AND e.device_id = d.id
            AND e.type IN ('online','offline','degraded') AND e.occurred_at < ${cap}
          ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1
       ) last ON true
      WHERE d.tenant_id = $1::uuid AND d.deleted_at IS NULL AND d.created_at < ${cap}`;
  const row = await withTenants([ctx.tenantId], async (c) => {
    const { rows } = await c.query<{ devices: number; alerting: number }>(sql, [ctx.tenantId, config.reportsTz, ctx.asOf]);
    return rows[0];
  });
  if (Number(row?.devices ?? 0) === 0) return null;
  return { value: Number(row.alerting) };
};
