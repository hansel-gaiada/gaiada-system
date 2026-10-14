// DW-6n n11 and n12 (docs/FRONTEND-BFF-CONTRACT.md §40.5.3, DW-D27): the Creatives department's review numbers.
//
// A "delivered" asset is a VERSION GROUP approved in review. The review table carries the group key itself
// (`creative_asset_reviews.group_id` = COALESCE(version_group_id, id) of the versions it covers, migration 202610140730),
// so no join is needed to find a group. Its department is the department of the version that was approved
// (`creative_assets.department_id` of the round's `asset_id`), and an approved version that was since deleted is not counted.
//
// A group can be approved more than once (a later version is reviewed and approved again). The group is then counted ONCE,
// by its LATEST approved round whose `decided_at` falls inside the window [start 00:00, end + 1 day 00:00) in REPORTS_TZ.
import { config } from "../../../../config";
import { withTenants } from "../../../../db";
import type { KpiValue } from "../../dept-kpis";
import type { ModuleKpiReader, ReaderCtx } from "../types";
import { unitSubtreeSql, windowEndSql, windowStartSql } from "../scope";

// $1 tenant, $2 unit, $3 start, $4 end, $5 zone
const APPROVED_GROUPS_SQL =
  `SELECT DISTINCT ON (r.group_id) r.group_id
     FROM creative_asset_reviews r
     JOIN creative_assets a ON a.id = r.asset_id AND a.tenant_id = r.tenant_id
    WHERE r.tenant_id = $1::uuid
      AND r.status = 'approved'
      AND r.decided_at >= ${windowStartSql(3, 5)} AND r.decided_at < ${windowEndSql(4, 5)}
      AND a.deleted_at IS NULL
      AND ${unitSubtreeSql("a.department_id", 1, 2)}
    ORDER BY r.group_id, r.decided_at DESC, r.round DESC`;

const params = (ctx: ReaderCtx) => [ctx.tenantId, ctx.unitId, ctx.start, ctx.end, config.reportsTz];

/** n11 · `creatives.revision_rounds`: the mean number of `changes_requested` rounds of the groups approved in the window.
 *  `withdrawn` and `superseded` rounds are not revisions; a first-time approval counts 0. An average: no numerator or
 *  denominator. `null` when no group was approved in the window. */
export const revisionRounds: ModuleKpiReader = async (ctx) => {
  const sql =
    `WITH approved AS (${APPROVED_GROUPS_SQL})
     SELECT count(*)::int AS groups,
            (COALESCE(sum((SELECT count(*) FROM creative_asset_reviews x
                            WHERE x.tenant_id = $1::uuid AND x.group_id = approved.group_id
                              AND x.status = 'changes_requested')), 0))::float8 AS rounds
       FROM approved`;
  const row = await withTenants([ctx.tenantId], async (c) => {
    const { rows } = await c.query<{ groups: number; rounds: number }>(sql, params(ctx));
    return rows[0];
  });
  const groups = Number(row?.groups ?? 0);
  if (groups === 0) return null;
  return { value: Number(row.rounds) / groups };
};

/** n12 · `creatives.assets_delivered`: the number of version groups approved in the window. A count of 0 is a real 0 when
 *  the department has at least one (not deleted) creative asset at all; `null` when it has none. */
export const assetsDelivered: ModuleKpiReader = async (ctx) => {
  const sql =
    `SELECT (SELECT count(*) FROM (${APPROVED_GROUPS_SQL}) g)::int AS delivered,
            EXISTS (SELECT 1 FROM creative_assets d
                     WHERE d.tenant_id = $1::uuid AND d.deleted_at IS NULL
                       AND ${unitSubtreeSql("d.department_id", 1, 2)}) AS has_assets`;
  const row = await withTenants([ctx.tenantId], async (c) => {
    const { rows } = await c.query<{ delivered: number; has_assets: boolean }>(sql, params(ctx));
    return rows[0];
  });
  const delivered = Number(row?.delivered ?? 0);
  if (delivered === 0 && !row?.has_assets) return null;
  return { value: delivered };
};
