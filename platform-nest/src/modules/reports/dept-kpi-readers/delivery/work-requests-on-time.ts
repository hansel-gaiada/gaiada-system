// DW-6n n1 and n10 (docs/FRONTEND-BFF-CONTRACT.md §40.5.3): requests delivered by the date needed. One implementation,
// parameterised by the request's kind: n1 reads `engineering` requests (Web Dev), n10 reads `assets` requests (Creatives).
//
//   Denominator: requests of the kind, `to_unit_id` in S(u), not deleted, status `open` or `delivered`, `needed_by`
//   inside the inclusive window dates, and delivered OR already due (`needed_by <= asOf`: an item due today and not
//   delivered counts as late today).
//   Numerator:   those `delivered` whose `closed_at`, as a date in REPORTS_TZ, is on or before `needed_by`.
//   `closed_at` is cleared when a request is reopened (work-requests.service.ts), and a reopened request is `open`
//   again, so it only counts once it is due; a delivered one always carries `closed_at` (work_requests_closed_ck).
//   A request with no `needed_by` is not counted (§40.5.4). A zero denominator is `null`, never 0 or 1.
//   The reader never reads the clock: `asOf` comes from the context.
import { config } from "../../../../config";
import { withTenants } from "../../../../db";
import type { KpiValue } from "../../dept-kpis";
import type { ModuleKpiReader, ReaderCtx } from "../types";
import { localDateSql, unitSubtreeSql } from "../scope";

type RequestKind = "engineering" | "assets";

async function readRequestsOnTime(kind: RequestKind, ctx: ReaderCtx): Promise<KpiValue | null> {
  // $1 tenant, $2 unit, $3 start, $4 end, $5 zone, $6 asOf, $7 kind
  const sql =
    `SELECT count(*)::int AS denominator,
            (count(*) FILTER (WHERE r.status = 'delivered' AND r.closed_at IS NOT NULL
                                AND ${localDateSql("r.closed_at", 5)} <= r.needed_by))::int AS numerator
       FROM work_requests r
      WHERE r.tenant_id = $1::uuid
        AND r.kind = $7::text
        AND ${unitSubtreeSql("r.to_unit_id", 1, 2)}
        AND r.deleted_at IS NULL
        AND r.status IN ('open', 'delivered')
        AND r.needed_by IS NOT NULL
        AND r.needed_by >= $3::date AND r.needed_by <= $4::date
        AND (r.status = 'delivered' OR r.needed_by <= $6::date)`;
  const row = await withTenants([ctx.tenantId], async (c) => {
    const { rows } = await c.query<{ denominator: number; numerator: number }>(sql, [
      ctx.tenantId, ctx.unitId, ctx.start, ctx.end, config.reportsTz, ctx.asOf, kind,
    ]);
    return rows[0];
  });
  const denominator = Number(row?.denominator ?? 0);
  if (denominator === 0) return null;
  const numerator = Number(row.numerator);
  return { value: numerator / denominator, numerator, denominator };
}

/** n1 · `webdev.requests_delivered_by_needed` */
export const webdevRequestsDeliveredByNeeded: ModuleKpiReader = (ctx) => readRequestsOnTime("engineering", ctx);

/** n10 · `creatives.asset_requests_on_time` */
export const assetRequestsOnTime: ModuleKpiReader = (ctx) => readRequestsOnTime("assets", ctx);
