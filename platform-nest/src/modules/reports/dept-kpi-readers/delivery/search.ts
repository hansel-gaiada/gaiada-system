// DW-6n n3, n4 and n5 (docs/FRONTEND-BFF-CONTRACT.md §40.5.3, DW-D27): the SEO department's three module readers.
// Every table here sits behind the `search` module wall, so each query declares `{ modules: ["search"] }`. A tenant
// without the module has no search rows, so the reader finds nothing and answers `null`, never an error.
// Scope is C(u), the department's clients (`deptClientIdsSql`); a search engagement and a search property link to a client
// through their own `client_id` (migration 0034). A reader never reads the clock: `asOf` comes from the context.
import { config } from "../../../../config";
import { withTenants } from "../../../../db";
import type { ModuleKpiReader } from "../types";
import { deptClientIdsSql, windowEndSql, windowStartSql } from "../scope";

const MODULES = { modules: ["search"] };

/** n3 · `search.clients_ranking_growth`: the share of the department's clients whose tracked keywords improved.
 *
 *  For each client in C(u) with a (not deleted) `search_properties` row, a keyword is `(keyword_id, engine, device)`.
 *  Its position at the window's start is the LAST non-simulated `search_rank_snapshots` row captured at or before the
 *  window's first instant; at the end, the last one captured before the window's end (the instant after `end`). A keyword
 *  counts only when BOTH those last snapshots found it (position not null). A client "grew" when the mean position over its
 *  counted keywords fell (a lower number is better). Denominator: clients with at least one counted keyword. */
export const clientsRankingGrowth: ModuleKpiReader = async (ctx) => {
  // $1 tenant, $2 unit, $3 start, $4 end, $5 zone
  const lastBefore = (cmp: string, instant: string) =>
    `SELECT DISTINCT ON (c.client_id, s.keyword_id, s.engine, s.device)
            c.client_id, s.keyword_id, s.engine, s.device, s."position" AS pos
       FROM prop c
       JOIN search_rank_snapshots s
         ON s.tenant_id = $1::uuid AND s.property_id = c.property_id AND NOT s.simulated AND s.captured_at ${cmp} ${instant}
      ORDER BY c.client_id, s.keyword_id, s.engine, s.device, s.captured_at DESC, s.id DESC`;
  const sql =
    `WITH prop AS (
       SELECT p.client_id, p.id AS property_id
         FROM search_properties p
        WHERE p.tenant_id = $1::uuid AND p.deleted_at IS NULL
          AND p.client_id IN ${deptClientIdsSql(1, 2)}
     ),
     first_pos AS (${lastBefore("<=", windowStartSql(3, 5))}),
     last_pos AS (${lastBefore("<", windowEndSql(4, 5))}),
     per_client AS (
       SELECT f.client_id, avg(f.pos) AS before_mean, avg(l.pos) AS after_mean
         FROM first_pos f
         JOIN last_pos l ON l.client_id = f.client_id AND l.keyword_id = f.keyword_id AND l.engine = f.engine AND l.device = f.device
        WHERE f.pos IS NOT NULL AND l.pos IS NOT NULL
        GROUP BY f.client_id
     )
     SELECT count(*)::int AS denominator, (count(*) FILTER (WHERE after_mean < before_mean))::int AS numerator FROM per_client`;
  const row = await withTenants(
    [ctx.tenantId],
    async (c) => (await c.query<{ denominator: number; numerator: number }>(sql, [ctx.tenantId, ctx.unitId, ctx.start, ctx.end, config.reportsTz])).rows[0],
    MODULES,
  );
  const denominator = Number(row?.denominator ?? 0);
  if (denominator === 0) return null;
  const numerator = Number(row.numerator);
  return { value: numerator / denominator, numerator, denominator };
};

/** n4 · `search.client_reports_on_time`: monthly reports delivered by the 5th of the following month (DW-D27).
 *
 *  A `search_reports` row of an engagement whose client is in C(u), not deleted, with `period` `YYYY-MM` is due on the 5th
 *  of the month after `period`, end of that day in REPORTS_TZ. It counts when its due DATE is inside the inclusive window
 *  and it is delivered (`delivered_at` set) or already due (`due <= asOf`). Numerator: `delivered_at` before the instant
 *  that day ends. A month in which no report exists is not counted (§40.5.4). */
export const clientReportsOnTime: ModuleKpiReader = async (ctx) => {
  // $1 tenant, $2 unit, $3 start, $4 end, $5 zone, $6 asOf
  const sql =
    `WITH r AS (
       SELECT sr.delivered_at,
              CASE WHEN sr.period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
                   THEN (to_date(sr.period || '-01', 'YYYY-MM-DD') + interval '1 month' + interval '4 days')::date
              END AS due_date
         FROM search_reports sr
         JOIN search_engagements e ON e.id = sr.engagement_id AND e.tenant_id = sr.tenant_id
        WHERE sr.tenant_id = $1::uuid AND sr.deleted_at IS NULL AND e.deleted_at IS NULL
          AND e.client_id IN ${deptClientIdsSql(1, 2)}
     )
     SELECT count(*)::int AS denominator,
            (count(*) FILTER (WHERE delivered_at IS NOT NULL
                                AND delivered_at < ((due_date + 1)::timestamp AT TIME ZONE $5::text)))::int AS numerator
       FROM r
      WHERE due_date >= $3::date AND due_date <= $4::date
        AND (delivered_at IS NOT NULL OR due_date <= $6::date)`;
  const row = await withTenants(
    [ctx.tenantId],
    async (c) =>
      (await c.query<{ denominator: number; numerator: number }>(sql, [ctx.tenantId, ctx.unitId, ctx.start, ctx.end, config.reportsTz, ctx.asOf])).rows[0],
    MODULES,
  );
  const denominator = Number(row?.denominator ?? 0);
  if (denominator === 0) return null;
  const numerator = Number(row.numerator);
  return { value: numerator / denominator, numerator, denominator };
};

/** n5 · `search.ad_budgets_on_pace` (DW-D27): a campaign's `budget_minor` is a MONTHLY budget.
 *
 *  Judged in the month that contains `asOf`, from its 1st to `asOf` (inclusive). Over campaigns `live`, not deleted, with a
 *  budget above 0, of engagements (not deleted) whose client is in C(u), with at least one NON-simulated daily metrics row in
 *  that span. Spend is the sum of those rows' `cost_minor`; expected is `budget_minor * daysElapsed / daysInMonth`.
 *  On pace: `0.9 <= spend / expected <= 1.1`, tested in exact integer arithmetic (`spend * 10 * days` between `9` and `11`
 *  times `budget * elapsed`), so a campaign exactly on a boundary is on pace. A campaign any of whose counted metrics rows
 *  has a currency different from the budget's (a NULL counts as different: it cannot be compared) is left out. The window
 *  (`start`, `end`) is not used: this KPI is a month-to-date reading. */
export const adBudgetsOnPace: ModuleKpiReader = async (ctx) => {
  // $1 tenant, $2 unit, $3 asOf
  const sql =
    `WITH m AS (
       SELECT c.id, c.budget_minor, sum(d.cost_minor) AS spend,
              bool_or(d.currency IS DISTINCT FROM c.currency) AS mismatch
         FROM search_campaigns c
         JOIN search_engagements e ON e.id = c.engagement_id AND e.tenant_id = c.tenant_id
         JOIN search_campaign_metrics_daily d ON d.campaign_id = c.id AND d.tenant_id = c.tenant_id
              AND NOT d.simulated
              AND d.date >= date_trunc('month', $3::date)::date AND d.date <= $3::date
        WHERE c.tenant_id = $1::uuid AND c.deleted_at IS NULL AND c.status = 'live' AND c.budget_minor > 0
          AND e.deleted_at IS NULL AND e.client_id IN ${deptClientIdsSql(1, 2)}
        GROUP BY c.id, c.budget_minor
     ),
     k AS (
       SELECT m.*,
              extract(day FROM $3::date)::numeric AS elapsed,
              extract(day FROM (date_trunc('month', $3::date) + interval '1 month' - interval '1 day'))::numeric AS days_in_month
         FROM m WHERE NOT mismatch
     )
     SELECT count(*)::int AS denominator,
            (count(*) FILTER (WHERE spend::numeric * 10 * days_in_month >= 9 * budget_minor::numeric * elapsed
                                AND spend::numeric * 10 * days_in_month <= 11 * budget_minor::numeric * elapsed))::int AS numerator
       FROM k`;
  const row = await withTenants(
    [ctx.tenantId],
    async (c) => (await c.query<{ denominator: number; numerator: number }>(sql, [ctx.tenantId, ctx.unitId, ctx.asOf])).rows[0],
    MODULES,
  );
  const denominator = Number(row?.denominator ?? 0);
  if (denominator === 0) return null;
  const numerator = Number(row.numerator);
  return { value: numerator / denominator, numerator, denominator };
};
