// DW-4j-3 — the weekly KPI digest to each department head (docs/FRONTEND-BFF-CONTRACT.md §43.8; plan
// docs/plans/2026-10-13-department-workspaces.md §5.5, "A weekly digest"). The I/O half and the pure text. The route is
// dept-kpi-watch.controller.ts (`POST /dept-kpis/digest`); the engine is `evaluateUnits` in dept-kpi-targets.ts (§40.3a),
// unchanged; the recipients, the value formatter and the severity are the watch's (dept-kpi-watch.ts), reused and not copied.
//
// ══════════════════════════ THE RUN (§43.8) ══════════════════════════
// `runDeptKpiDigest(tenantId, weekStart?, now?)` is what `POST /dept-kpis/digest` calls, Mondays at 07:00, from n8n:
//   1. THE WEEK. `weekStart` is a Monday `YYYY-MM-DD`; the default is the Monday of the last COMPLETE ISO week in REPORTS_TZ
//      (`lastCompleteWeekStart`). A non-Monday, or a week that is not over yet (the current or a future one), is a 400
//      `field: "weekStart"` (`resolveDigestWeek`).
//   2. EVALUATE, read-only and outside any transaction: `evaluateUnits` over every `department` node for that week
//      (`resolveRange("week", weekStart)`), and, for the departments that have a head, for the week before. So a digest line
//      agrees with what `GET /dept-kpis?periodKind=week&start=` answers for the same week.
//   3. CLAIM, in ONE transaction serialised per tenant by `pg_advisory_xact_lock(hashtext('dept_kpi_digest:' || tenant_id))`
//      (a different key from the watch's): insert the ledger row (`dept_kpi_digests`) of each department that has a head,
//      `ON CONFLICT DO NOTHING`; the rows actually inserted are the departments to tell, the others were `alreadySent`.
//   4. NOTIFY after the commit, per head, each in its own try/catch (`notifyBestEffort`, `actorId` null: a scheduler). So a
//      retried or redelivered run never sends a week twice, and a crash between the commit and the send LOSES that
//      notification rather than doubling it. A department with no head is never claimed, so a head appointed later still
//      gets that week's digest on the next run for it.
// `now` is a parameter of the SERVICE only (the tests pin the clock with it); the HTTP route never takes one.
//
// ══════════════════════════ WHAT IT SAYS (§43.8) ══════════════════════════
// One Inbox notification per head per department, `type: "dept_kpi.weekly_digest"`, payload `{title, body, href, severity}`
// and no `entityType`. The body is the department's own numbers: no person is named and no person-level figure appears
// (blueprint §11; the ranking of people lives behind the drivers read, which is a page and never an Inbox row).
import { BadRequestException } from "@nestjs/common";
import { withTenants } from "../../db";
import { config } from "../../config";
import { notifyBestEffort } from "../../core/client-notify";
import { addDaysIso } from "../../core/dept-resolution";
import { resolveRange } from "./reports.controller";
import { mondayOnOrBefore } from "./report-calendar";
import { loadOrgStructure, todayIsoInTz } from "./person-scope";
import { departmentUnits, type KpiCondition, type KpiUnit } from "./dept-kpis";
import { DEPT_KPI_MODULES, companyVertical, evaluateUnits, type KpiRead, type UnitKpis } from "./dept-kpi-targets";
import { conditionWord, formatKpiValue, loadLeadUserIdsByUnit, noticeSeverity, type NoticePayload } from "./dept-kpi-watch";

export const DIGEST_NOTIFICATION_TYPE = "dept_kpi.weekly_digest";

// ═══════════════════════════════ pure: the week ═══════════════════════════════

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** PURE. The Monday of the last COMPLETE ISO week as of `today` (a `YYYY-MM-DD` in REPORTS_TZ): the Monday on or before today,
 *  one week back. On a Monday morning that is the week that ended yesterday; on a Sunday night it is still the week before
 *  (this week is not over until the day is). */
export function lastCompleteWeekStart(today: string): string {
  return addDaysIso(mondayOnOrBefore(today), -7);
}

/** PURE. A real calendar date written `YYYY-MM-DD`. */
function isRealIsoDate(s: string): boolean {
  if (!DATE_SHAPE.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * PURE. The week a digest is for. `raw` absent (undefined or null) is the default, the last complete ISO week as of `today`.
 * Otherwise it must be a Monday written `YYYY-MM-DD` that is not later than that default (the current and any future week are
 * not complete): anything else is a 400 `field: "weekStart"`.
 */
export function resolveDigestWeek(raw: unknown, today: string): { weekStart: string; weekEnd: string } {
  const last = lastCompleteWeekStart(today);
  let weekStart = last;
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== "string" || !isRealIsoDate(raw) || mondayOnOrBefore(raw) !== raw) {
      throw new BadRequestException({ message: "weekStart must be a Monday written YYYY-MM-DD", field: "weekStart" });
    }
    if (raw > last) {
      throw new BadRequestException({ message: "weekStart must be a week that is already complete", field: "weekStart" });
    }
    weekStart = raw;
  }
  return { weekStart, weekEnd: addDaysIso(weekStart, 6) };
}

// ═══════════════════════════════ pure: the text ═══════════════════════════════

const UP = "▲";
const DOWN = "▼";
const DOT = "·";

/** PURE. How a KPI moved against the week before, in words, for the line's parenthesis:
 *   - no value the week before: "no data the week before";
 *   - a percent: the change in WHOLE points between the two whole percents the head reads ("▼ 6 pts from the week before");
 *   - a count or a duration: the change in the KPI's own unit, formatted as the value is ("▲ 1.5 from the week before",
 *     "▼ 3h 20m from the week before");
 *   - nothing to show at that precision (equal, or equal once rounded as it is shown): "no change from the week before". */
export function changeNote(value: number, previous: number | null | undefined, unit: KpiUnit): string {
  if (previous === null || previous === undefined || !Number.isFinite(previous)) return "no data the week before";
  if (unit === "percent") {
    const points = Math.round(value * 100) - Math.round(previous * 100);
    if (points === 0) return "no change from the week before";
    return `${points > 0 ? UP : DOWN} ${Math.abs(points)} pts from the week before`;
  }
  const delta = value - previous;
  const magnitude = Math.abs(delta);
  const nothing = unit === "minutes" ? Math.round(magnitude) === 0 : Math.round(magnitude * 100) / 100 === 0;
  if (nothing) return "no change from the week before";
  return `${delta > 0 ? UP : DOWN} ${formatKpiValue(magnitude, unit)} from the week before`;
}

/** PURE. One KPI's line, or null when the KPI has no condition: "Projects on time: 71% against 85% · at risk (▼ 6 pts from the
 *  week before)". `previousValue` is the KPI's value the week before (null: none). The numbers are the department's own. */
export function digestKpiLine(read: Pick<KpiRead, "label" | "unit" | "value" | "target" | "condition">, previousValue: number | null | undefined): string | null {
  if (read.condition === "unavailable" || read.value === null || read.target === null) return null;
  return `${read.label}: ${formatKpiValue(read.value, read.unit)} against ${formatKpiValue(read.target, read.unit)} ${DOT} ${conditionWord(read.condition)} (${changeNote(read.value, previousValue, read.unit)})`;
}

/** PURE. The ONE line that sums up the KPIs with no condition, only the non-zero kinds, or null when there are none:
 *  "4 KPIs not measured yet; 2 KPIs have no target; 1 KPI has no data" (reasons `no_reader`, `no_target`, `no_data`). */
export function unavailableSummary(reads: ReadonlyArray<Pick<KpiRead, "condition" | "reason">>): string | null {
  const count = { no_reader: 0, no_target: 0, no_data: 0, other: 0 };
  for (const k of reads) {
    if (k.condition !== "unavailable") continue;
    // A reason this code does not know (a later engine can add one, e.g. a reader that failed) is counted under its own
    // generic words, never dropped and never a crash. An absent reason reads as no data, as before.
    const reason: string = k.reason ?? "no_data";
    if (reason === "no_reader" || reason === "no_target" || reason === "no_data") count[reason] += 1;
    else count.other += 1;
  }
  const plural = (n: number) => (n === 1 ? "1 KPI" : `${n} KPIs`);
  const parts: string[] = [];
  if (count.no_reader > 0) parts.push(`${plural(count.no_reader)} not measured yet`);
  if (count.no_target > 0) parts.push(`${plural(count.no_target)} ${count.no_target === 1 ? "has" : "have"} no target`);
  if (count.no_data > 0) parts.push(`${plural(count.no_data)} ${count.no_data === 1 ? "has" : "have"} no data`);
  if (count.other > 0) parts.push(`${plural(count.other)} could not be read`);
  return parts.length > 0 ? parts.join("; ") : null;
}

/** PURE. The digest's `href`: the department's appraisal page with that week as its period. */
export function digestHref(unitNodeId: string, weekStart: string): string {
  return `/appraisals/department?unit=${encodeURIComponent(unitNodeId)}&periodKind=week&start=${weekStart}`;
}

/** PURE. The `severity` of a digest: the watch's rule applied to the department's condition that week (critical when off
 *  track, warning when at risk, info otherwise, `unavailable` included). */
export function digestSeverity(condition: KpiCondition): NoticePayload["severity"] {
  return noticeSeverity([condition]);
}

/** PURE. The one notification of a department for a week: "Web Dev this week: at risk", one line per KPI that has a condition (the
 *  workspace set's order), then the one line summing up the KPIs with none. `previous` is the same department a week earlier
 *  (undefined: not evaluated). No `entityType`, so the Inbox opens no thread panel; no person is named. */
export function buildDigestNotice(read: UnitKpis, previous: UnitKpis | undefined, weekStart: string): NoticePayload {
  const lines: string[] = [];
  for (const k of read.kpis) {
    const before = previous?.kpis.find((p) => p.key === k.key)?.value ?? null;
    const line = digestKpiLine(k, before);
    if (line) lines.push(line);
  }
  const summary = unavailableSummary(read.kpis);
  if (summary) lines.push(summary);
  return {
    title: `${read.unit.name} this week: ${conditionWord(read.condition)}`,
    body: lines.join("\n"),
    href: digestHref(read.unit.id, weekStart),
    severity: digestSeverity(read.condition),
  };
}

// ═══════════════════════════════ the run (§43.8) ═══════════════════════════════

export interface DigestResult {
  weekStart: string;
  weekEnd: string;
  evaluatedUnits: number;
  /** One entry per department told, in the org tree's order: how many heads were addressed (a count, never user ids). */
  sent: Array<{ unitNodeId: string; recipients: number }>;
  /** The departments whose digest for this week was already sent by an earlier run (sorted). */
  alreadySent: string[];
  /** Every evaluated department with no head today (sorted): nobody is told for it, and it is not claimed in the ledger. */
  unitsWithoutHead: string[];
}

/** The scheduled digest (§43.8): evaluate the week and the week before, claim the ledger rows under the tenant's lock, notify
 *  after the commit. Throws a 400 `field: "weekStart"` for a bad week (see `resolveDigestWeek`). */
export async function runDeptKpiDigest(tenantId: string, weekStartRaw?: unknown, now: Date = new Date()): Promise<DigestResult> {
  const today = todayIsoInTz(config.reportsTz, now);
  const { weekStart, weekEnd } = resolveDigestWeek(weekStartRaw, today);
  const range = resolveRange("week", weekStart);
  const previousRange = resolveRange("week", addDaysIso(weekStart, -7));

  // (1) Evaluate: read-only, outside the transaction.
  const structure = await withTenants([tenantId], (c) => loadOrgStructure(c, tenantId), { modules: DEPT_KPI_MODULES });
  const departments = departmentUnits(structure);
  const vertical = await companyVertical(tenantId);
  // `today` pins what the module readers count as already due (§40.5.1), so a pinned `now` gives a deterministic run.
  const reads = await evaluateUnits(tenantId, vertical, departments, departments, range, range.start, today);
  const heads = await loadLeadUserIdsByUnit(tenantId, departments.map((d) => d.id));
  const withHead = departments.filter((d) => (heads.get(d.id)?.length ?? 0) > 0);
  const previousReads = withHead.length > 0 ? await evaluateUnits(tenantId, vertical, withHead, departments, previousRange, previousRange.start, today) : [];

  // (2) Claim, serialised per tenant: the rows this run actually inserts are the departments it tells.
  const claimed = await withTenants(
    [tenantId],
    async (c) => {
      if (withHead.length === 0) return new Set<string>();
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('dept_kpi_digest:' || $1::text))`, [tenantId]);
      const { rows } = await c.query<{ unit_node_id: string }>(
        `INSERT INTO dept_kpi_digests (tenant_id, unit_node_id, week_start, sent_at, recipients, origin_site)
         SELECT $1::uuid, u.unit, $2::date, now(), u.recipients, $3::text
           FROM unnest($4::text[], $5::int[]) AS u(unit, recipients)
         ON CONFLICT (tenant_id, unit_node_id, week_start) DO NOTHING
         RETURNING unit_node_id`,
        [tenantId, weekStart, config.originSite, withHead.map((d) => d.id), withHead.map((d) => heads.get(d.id)!.length)],
      );
      return new Set(rows.map((r) => r.unit_node_id));
    },
    { modules: DEPT_KPI_MODULES },
  );

  // (3) Notify, after the commit: each claimed department's heads, one notification each.
  const sent: DigestResult["sent"] = [];
  for (const dept of withHead) {
    if (!claimed.has(dept.id)) continue;
    const recipients = heads.get(dept.id)!;
    const read = reads.find((r) => r.unit.id === dept.id)!;
    const previous = previousReads.find((r) => r.unit.id === dept.id);
    // actorId null: a scheduler. notify() skips a recipient equal to a non-null actor, and a non-member.
    await notifyBestEffort(tenantId, null, recipients, DIGEST_NOTIFICATION_TYPE, buildDigestNotice(read, previous, weekStart));
    sent.push({ unitNodeId: dept.id, recipients: recipients.length });
  }
  return {
    weekStart,
    weekEnd,
    evaluatedUnits: reads.length,
    sent,
    alreadySent: withHead.filter((d) => !claimed.has(d.id)).map((d) => d.id).sort(),
    unitsWithoutHead: departments.filter((d) => !heads.has(d.id)).map((d) => d.id).sort(),
  };
}
