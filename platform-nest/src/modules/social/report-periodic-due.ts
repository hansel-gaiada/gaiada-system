// SCP-5 W5-A2 (docs/FRONTEND-BFF-CONTRACT.md §63.24.4) — the periodic reports that are due: the officer's Needs you
// (`periodic_report_due`) and the Team dashboard's `report_due` items with a `reportKind` read the same facts here.
//
// A client is due a kind when the kind is in its `report_kinds` (the periodic kinds besides the monthly, SCP-Q26) AND the company has
// the kind on. For each such client and kind ONE period is looked at: the most recent period whose due day (the kind's rule, from the
// company's CURRENT rules: no report exists yet to keep its own) has been reached. An older overdue period does not carry on, as
// the monthly's dashboard item does not. The item stays until a report of that client, kind and period is `delivered`.
//
//   mode 'reached'  due day <= today     the officer's Needs you: "from the period's due day" (63.24.4)
//   mode 'after'    due day <  today     the dashboard: "from the day after its due day" (63.24.4), whatever `month`
//
// The internal sentinel client gets no client report (M5-G0b), so it is never due. A closed engagement is never due; which of the
// others count is the caller's (`statuses`): the officer's Needs you reads active and paused engagements, as the monthly item does;
// the dashboard every engagement that is not closed, as its monthly item does.
import type { PoolClient } from "pg";
import { withTenants } from "../../db";
import { addDays } from "../hr/working-days";
import type { WorkingCalendar } from "../hr/working-days";
import { loadWorkingCalendar } from "../reports/dept-kpi-readers/functional/working-calendar";
import { declareSocialModuleScope } from "./module-scope";
import { CLIENT_REPORT_KINDS } from "./report-kinds";
import { enabledReportKinds, reportKindRules, socialRules, type PeriodicKind, type ReportDueRule, type RulesDoc } from "./pipeline/rules";
import { periodOf, periodRange, reportDueDate } from "./pipeline/rules-periods";

/** How many periods before the current one are looked at (a kind's due day is at most a month or so after its period, so a few suffice). */
const PERIODS_BACK = 4;

export interface PeriodicDue {
  engagementId: string;
  clientName: string;
  reportDueDay: number | null;
  kind: PeriodicKind;
  period: string;
  /** The due day. */
  due: string;
  /** The newest report of that client, kind and period that is not delivered; null when none exists yet. */
  reportId: string | null;
  reportStatus: string | null;
}

/** The period of `kind` that is due now, by `due` on `today`; null when none of the periods looked at is (or the client has no day for a rule that needs one). PURE. */
export function pickDuePeriod(
  kind: PeriodicKind, today: string, fiscalYearStartMonth: number, due: ReportDueRule,
  ctx: { reportDueDay: number | null; calendar: WorkingCalendar }, mode: "reached" | "after",
): { period: string; due: string } | null {
  let period = periodOf(kind, today, fiscalYearStartMonth);
  for (let i = 0; i <= PERIODS_BACK; i++) {
    const range = periodRange(kind, period, fiscalYearStartMonth);
    if (!range) return null;
    const d = reportDueDate(due, range, ctx);
    if (d !== null && (mode === "reached" ? d <= today : d < today)) return { period, due: d };
    period = periodOf(kind, addDays(range.start, -1), fiscalYearStartMonth);
  }
  return null;
}

/** The periods `pickDuePeriod` may choose for `kind` on `today`, with their ranges' ends (the calendar window's anchors). PURE. */
export function candidatePeriods(kind: PeriodicKind, today: string, fiscalYearStartMonth: number): Array<{ period: string; end: string }> {
  const out: Array<{ period: string; end: string }> = [];
  let period = periodOf(kind, today, fiscalYearStartMonth);
  for (let i = 0; i <= PERIODS_BACK; i++) {
    const range = periodRange(kind, period, fiscalYearStartMonth);
    if (!range) break;
    out.push({ period, end: range.end });
    period = periodOf(kind, addDays(range.start, -1), fiscalYearStartMonth);
  }
  return out;
}

export interface PeriodicDueQuery {
  today: string;
  /** Only this officer's clients (Needs you); every client when absent (the dashboard). */
  officerId?: string | null;
  statuses: readonly string[];
  mode: "reached" | "after";
  /** A comment the statement starts with (the dashboard's tag, which its tests count). */
  sqlTag?: string;
}

/** The company's calendar over the days the candidate periods' due days can fall on, read only when a due rule needs working days. */
async function calendarFor(tenantId: string, rules: RulesDoc, kinds: readonly PeriodicKind[], today: string): Promise<WorkingCalendar> {
  const fy = rules.reports.fiscalYearStartMonth;
  const needing = kinds.filter((k) => reportKindRules(rules, k).due.rule === "working_days_after");
  if (needing.length === 0) return {};
  const ends = needing.flatMap((k) => candidatePeriods(k, today, fy).map((c) => c.end)).sort();
  return loadWorkingCalendar(tenantId, ends[0], addDays(ends[ends.length - 1], 90));
}

/**
 * The periodic reports due (see the header). Opens its own `withTenants` calls (social for the rules and the one read, hr for the
 * calendar), so the caller needs no transaction of its own.
 */
export async function readPeriodicDue(tenantId: string, q: PeriodicDueQuery): Promise<PeriodicDue[]> {
  const rules = (await withTenants([tenantId], (c) => socialRules(c, tenantId), { modules: ["social"] })).rules;
  const fy = rules.reports.fiscalYearStartMonth;
  const kinds = enabledReportKinds(rules).filter((k): k is PeriodicKind => (CLIENT_REPORT_KINDS as readonly string[]).includes(k));
  if (kinds.length === 0) return [];
  const calendar = await calendarFor(tenantId, rules, kinds, q.today);

  const pairs = kinds.flatMap((k) => candidatePeriods(k, q.today, fy).map((c) => ({ kind: k, period: c.period })));
  type Row = {
    engagement_id: string; client_name: string; report_due_day: number | null; report_kinds: string[];
    report_id: string | null; r_kind: string | null; r_period: string | null; r_status: string | null;
  };
  const { rows } = await withTenants([tenantId], async (c: PoolClient) => {
    await declareSocialModuleScope(c);
    return c.query<Row>(
      `${q.sqlTag ?? ""}
       SELECT e.id::text AS engagement_id, cl.name AS client_name, e.report_due_day, e.report_kinds,
              r.id::text AS report_id, r.kind AS r_kind, r.period AS r_period, r.status AS r_status
         FROM social_engagements e
         JOIN clients cl ON cl.id = e.client_id AND cl.tenant_id = e.tenant_id AND NOT cl.is_internal
         LEFT JOIN social_reports r ON r.tenant_id = e.tenant_id AND r.engagement_id = e.id AND r.deleted_at IS NULL
              AND (r.kind, r.period) IN (SELECT t.k, t.p FROM unnest($4::text[], $5::text[]) AS t(k, p))
        WHERE e.tenant_id = $1::uuid AND e.deleted_at IS NULL AND e.status = ANY($3::text[]) AND e.report_kinds && $2::text[]
          AND ($6::text IS NULL OR e.owner_id::text = $6)
        ORDER BY lower(cl.name), e.id, r.created_at DESC, r.id
        LIMIT 5000`,
      [tenantId, kinds, [...q.statuses], pairs.map((p) => p.kind), pairs.map((p) => p.period), q.officerId ? q.officerId.toLowerCase() : null],
    );
  }, { modules: ["social"] });

  // One row per client and matched report: group by client, in the order read.
  const byClient = new Map<string, { name: string; day: number | null; kinds: string[]; reports: Array<{ id: string; kind: string; period: string; status: string }> }>();
  for (const r of rows) {
    const e = byClient.get(r.engagement_id) ?? { name: r.client_name, day: r.report_due_day === null ? null : Number(r.report_due_day), kinds: r.report_kinds ?? [], reports: [] };
    if (r.report_id && r.r_kind && r.r_period && r.r_status) e.reports.push({ id: r.report_id, kind: r.r_kind, period: r.r_period, status: r.r_status });
    byClient.set(r.engagement_id, e);
  }
  const out: PeriodicDue[] = [];
  for (const [engagementId, e] of byClient) {
    for (const kind of kinds) {
      if (!e.kinds.includes(kind)) continue;
      const pick = pickDuePeriod(kind, q.today, fy, reportKindRules(rules, kind).due, { reportDueDay: e.day, calendar }, q.mode);
      if (!pick) continue;
      const of = e.reports.filter((x) => x.kind === kind && x.period === pick.period);
      if (of.some((x) => x.status === "delivered")) continue;
      const open = of[0] ?? null; // the newest (the read orders them so)
      out.push({
        engagementId, clientName: e.name, reportDueDay: e.day, kind, period: pick.period, due: pick.due,
        reportId: open?.id ?? null, reportStatus: open?.status ?? null,
      });
    }
  }
  return out;
}
