// DW-6n n2 (docs/FRONTEND-BFF-CONTRACT.md §40.5.3): web-dev `client-site-uptime`, reader id `monitoring.client_uptime`.
// The pooled uptime ratio over every monitor_results row inside the window, of enabled, not-deleted monitors whose
// client is one of the department's clients C(u). The ratio text is monitoring.controller.ts's UPTIME_RATIO_SQL, reused:
// maintenance and unknown leave both sides, degraded counts against, an empty window is NULL (never 1, never 0).
//
// MON-00 (migrations/0116 header): the query is scoped to ONE tenant by RLS, and the monitor is joined on
// (id, tenant_id) with the result's own tenant, so a row of another root can never be counted here.
import { config } from "../../../../config";
import { withTenants } from "../../../../db";
import { UPTIME_RATIO_SQL } from "../../../monitoring/monitoring.controller";
import type { KpiValue } from "../../dept-kpis";
import type { ModuleKpiReader, ReaderCtx } from "../types";
import { deptClientIdsSql, windowEndSql, windowStartSql } from "../scope";

// $1 tenant, $2 unit, $3 start, $4 end, $5 zone.
const SQL = `
  SELECT count(*) FILTER (WHERE r.status = 'up')::text AS up,
         count(*) FILTER (WHERE r.status NOT IN ('maintenance','unknown'))::text AS counted,
         (${UPTIME_RATIO_SQL})::text AS ratio
    FROM monitor_results r
    JOIN monitors m ON m.id = r.monitor_id AND m.tenant_id = r.tenant_id
   WHERE r.tenant_id = $1::uuid
     AND m.enabled AND m.deleted_at IS NULL
     AND m.client_id IN ${deptClientIdsSql(1, 2)}
     AND r.checked_at >= ${windowStartSql(3, 5)}
     AND r.checked_at <  ${windowEndSql(4, 5)}`;

export const clientSiteUptime: ModuleKpiReader = async (ctx: ReaderCtx): Promise<KpiValue | null> => {
  const row = await withTenants(
    [ctx.tenantId],
    async (c) =>
      (
        await c.query<{ up: string; counted: string; ratio: string | null }>(SQL, [
          ctx.tenantId,
          ctx.unitId,
          ctx.start,
          ctx.end,
          config.reportsTz,
        ])
      ).rows[0],
    { modules: ["monitoring"] },
  );
  if (!row || row.ratio === null) return null;
  const counted = Number(row.counted);
  if (counted === 0) return null;
  return { value: Number(row.ratio), numerator: Number(row.up), denominator: counted };
};
