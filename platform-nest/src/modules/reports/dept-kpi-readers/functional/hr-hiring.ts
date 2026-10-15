// DW-7j f5 (docs/FRONTEND-BFF-CONTRACT.md §40.6.2): time to hire. Company grain (§40.6.1). Register as `gated("hr", timeToHire)`.
//
//   `hr.time_to_hire`: over `hr_offers` with `converted_at` inside the window (the half-open interval [start 00:00, end + 1 day
//   00:00) in REPORTS_TZ), reached through offers -> applications (`application_id`) -> requisitions (`requisition_id`), the
//   tenant carried through both composite FKs. The value is the MEAN of `converted_at - start` in MINUTES, where `start` is the
//   requisition's `opened_at`, or its `approved_at` when it was never opened. A hire with no usable start (both null) or whose
//   start is AFTER its conversion (a backfilled or corrected clock) is skipped, never counted as 0 or negative. There is no
//   numerator or denominator: it is an average. `null` when no hire has a usable start.
//
//   A deleted application or requisition does not unmake the hire: the offer was converted, so it counts. The unit is minutes
//   because the catalogue's `time-to-hire` is a duration KPI (30 days is 43200).
import { config } from "../../../../config";
import { withTenants } from "../../../../db";
import type { ModuleKpiReader } from "../types";
import { windowEndSql, windowStartSql } from "../scope";
import { HR_WALLS } from "./hr-leave";

/** f5 · `hr.time_to_hire` */
export const timeToHire: ModuleKpiReader = async (ctx) => {
  // $1 tenant, $2 start, $3 end, $4 zone
  const sql =
    `SELECT avg(extract(epoch FROM (x.converted_at - x.started_at)) / 60.0)::float8 AS minutes
       FROM (
         SELECT o.converted_at, coalesce(r.opened_at, r.approved_at) AS started_at
           FROM hr_offers o
           JOIN hr_applications a ON a.id = o.application_id AND a.tenant_id = o.tenant_id
           JOIN hr_requisitions r ON r.id = a.requisition_id AND r.tenant_id = a.tenant_id
          WHERE o.tenant_id = $1::uuid
            AND o.converted_at >= ${windowStartSql(2, 4)} AND o.converted_at < ${windowEndSql(3, 4)}
       ) x
      WHERE x.started_at IS NOT NULL AND x.started_at <= x.converted_at`;
  const row = await withTenants(
    [ctx.tenantId],
    async (c) => {
      const { rows } = await c.query<{ minutes: number | null }>(sql, [ctx.tenantId, ctx.start, ctx.end, config.reportsTz]);
      return rows[0];
    },
    HR_WALLS,
  );
  if (row?.minutes === null || row?.minutes === undefined) return null;
  return { value: Number(row.minutes) };
};
