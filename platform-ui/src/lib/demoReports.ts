import "server-only";
// TR-17 — DEMO_MODE fixtures for the tracker/reporting grain pages. Routed from
// demoFixtures.getDemoResponse for every `/api/:t/reports/{document,overview}` path, mirroring the
// demoPm.ts/demoMeetings.ts/demoPipeline.ts convention exactly (own file, `(method, p, params,
// body) => DemoResult | null`, one-way dependency — demoReports must NOT import demoFixtures).
//
// Why this file exists at all, given the real backend endpoints are live (TR-13 landed 2026-07-31):
// `header.sealed` is ALWAYS `false` from the real `document-builder.ts` builder today — sealing is
// TR-15's job, not yet shipped. DEMO_MODE is therefore the ONLY place the sealed/revision UI
// (`ReportViewer`'s "Sealed · rev N" badge, `RevisionNote`) can be exercised in a browser before
// TR-15 lands, plus it's the fastest way to drive every honesty-chrome state (warnings, a
// `pointInTime`/`distinctOver` KPI, a too-wide custom range) without seeding a real Postgres.
//
// Field-for-field the same `ReportDocument` shape `lib/reports.ts`/the real backend emit — same
// series/distribution/table KEYS as `document-builder.ts` (`activity_events`, `on_time_rate`,
// `evidence_by_source`, `time_by_project`, `contributions`, `overdue_tasks`, `per_person`,
// `department_portfolio`, ...) so `components/reports/GrainCharts.tsx`'s key-based lookups behave
// identically whether DEMO_MODE is on or the real backend answers.
import type {
  ReportDocument, ReportGrain, ReportPeriodKind, ReportKpi, ReportSeries, ReportSeriesPoint,
} from "./reports";
import { dayCountOf, formatDateRange } from "./reports";
import { formatPeriodLabel, isCalendarKind, previousPeriodRange, resolveCalendarRange } from "./reportCalendar";
import type { GroupCompanyCard, GroupFigure, GroupReport } from "./groupReport";

interface DemoResult { status: number; json: unknown }
const ok = (json: unknown): DemoResult => ({ status: 200, json });
const err = (status: number, error: string, field?: string): DemoResult => ({ status, json: { error, field } });

const DAY_MS = 86_400_000;
const MAX_CUSTOM_DAYS = 400;
// The demo tenant's earliest computed fact date (mirrors `report_work_facts`' real go-live gap,
// §13 risk 2 / `warnings.precedesFactHistory`) — a range starting before this gets the warning.
const FACT_HISTORY_START = "2026-05-01";

// Small local identity/scope name maps — duplicated rather than imported from demoFixtures.ts
// (same one-way-dependency rule demoPm.ts documents: demo modules never import demoFixtures).
const PERSON_NAMES: Record<string, string> = {
  "demo-hansel": "Clement Hansel", "gede-ic": "Gede Kusuma", "seo-staff": "Nyoman Ari",
  "u-pm": "Dewi Santoso", "u-dev": "Made Putra", "u-finance": "Rina Wibawa", "u-webhead": "Ketut Arta",
};
const PROJECT_NAMES: Record<string, string> = {
  "p-web-1": "Client site redesign", "p-web-2": "Mobile app revamp",
  "p-seo-1": "SEO audit — Q3", "p-int-1": "Internal brand refresh",
};
const DEPARTMENT_NAMES: Record<string, string> = {
  "dept-1": "Web Dev", "dept-2": "Design Graphic", "dept-3": "SEO", "dept-4": "SMM", "dept-5": "Video Editor",
};
const COMPANY_NAMES: Record<string, string> = {
  "co-holding": "D & A Syrowatka", "co-agency": "Gaia Digital Agency", "co-resort": "Viceroy",
};

function scopeName(grain: ReportGrain, scopeRef: string, tenantId: string): string {
  if (grain === "person") return PERSON_NAMES[scopeRef] ?? scopeRef;
  if (grain === "project") return PROJECT_NAMES[scopeRef] ?? scopeRef;
  if (grain === "department") return DEPARTMENT_NAMES[scopeRef] ?? scopeRef;
  return COMPANY_NAMES[tenantId] ?? tenantId;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function addDaysIso(iso: string, n: number): string {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * DAY_MS).toISOString().slice(0, 10);
}
function allDaysInRange(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDaysIso(d, 1)) out.push(d);
  return out;
}
// Deterministic, gently-varying pseudo-data — a day index folded through a small integer wave so
// numbers look like real activity (not a flat line, not random noise that would change on refresh
// within the same day-of-range position).
function wave(i: number, base: number, amp: number): number {
  return Math.max(0, Math.round(base + amp * Math.sin(i / 2.3) + ((i * 7) % 5) - 2));
}

function additiveSeries(key: string, label: string, unit: ReportSeries["unit"], kind: ReportSeries["kind"], days: string[], today: string, base: number, amp: number): ReportSeries {
  const points: ReportSeriesPoint[] = days.map((d, i) => ({ t: d, v: d > today ? null : wave(i, base, amp) }));
  return { key, label, unit, kind, points };
}

/** The header's `periodLabel`: the same strings as the backend's `formatPeriodLabel`
 *  (report-calendar.ts) — "14 Oct 2026" | "Week 42 2026" | "February 2026" | "Q3 2026" |
 *  "Semester 2 2026" | "Year 2026" — except a custom range, which keeps this demo's own en-dash
 *  `formatDateRange` ("16 Jul – 3 Aug 2026"). */
function periodLabel(periodKind: ReportPeriodKind, start: string, end: string): string {
  if (periodKind === "custom") return formatDateRange(start, end);
  return formatPeriodLabel(periodKind, start, end);
}

/** A resolved report period as the demo backend serves it: the snapped range (`end` derived from
 *  `start` for every calendar kind), its day count, label and comparison baseline. Exported so the
 *  golden-table test can pin it against platform-nest's report-calendar.test.ts. */
export function resolveDemoPeriod(periodKind: ReportPeriodKind, start: string, end?: string): {
  start: string; end: string; dayCount: number; label: string;
  comparison: { periodStart: string; periodEnd: string; dayCount: number };
} {
  const range = isCalendarKind(periodKind) ? resolveCalendarRange(periodKind, start) : { start, end: end ?? start };
  const dayCount = dayCountOf(range.start, range.end);
  const prev = previousPeriodRange(periodKind, range.start, range.end, dayCount);
  return {
    ...range, dayCount, label: periodLabel(periodKind, range.start, range.end),
    comparison: { periodStart: prev.start, periodEnd: prev.end, dayCount: prev.dayCount },
  };
}

/** DW-4m: the comparison window's own honesty flags, by the backend's arithmetic (`factHistoryGap` /
 *  `computeComparisonFlags` in document-builder.ts) against this demo's one `FACT_HISTORY_START`:
 *  `precedesFactHistory` when the window starts before it, `noFacts` only when the WHOLE window does. */
function comparisonFlags(start: string, end: string, dayCount: number): { precedesFactHistory?: { firstFactDate: string; affectedDays: number }; noFacts?: true } {
  if (start >= FACT_HISTORY_START) return {};
  const lastBefore = addDaysIso(FACT_HISTORY_START, -1);
  const affectedDays = dayCountOf(start, end < lastBefore ? end : lastBefore);
  const precedesFactHistory = { firstFactDate: FACT_HISTORY_START, affectedDays };
  return affectedDays === dayCount ? { precedesFactHistory, noFacts: true } : { precedesFactHistory };
}

/** DW-4m: adds `previous` (the comparison window's parts) and applies the backend's omission rule.
 *  `delta` is left out, never 0, when the comparison has no records or a ratio has a 0 denominator on
 *  either side. The demo's deltas are fixed numbers, so the previous value is `value - delta` and a
 *  ratio's previous parts are a plausible 90% of today's denominator. */
function withBaseline(k: ReportKpi, noFacts: boolean): ReportKpi {
  const { delta, ...rest } = k;
  const isRatio = k.numerator !== undefined && k.denominator !== undefined;
  let previous: NonNullable<ReportKpi["previous"]>;
  if (noFacts) {
    previous = isRatio ? { value: 0, numerator: 0, denominator: 0 } : { value: 0 };
  } else {
    const value = k.value - (delta ?? 0);
    if (isRatio) {
      const denominator = Math.round((k.denominator ?? 0) * 0.9);
      previous = { value, numerator: Math.round(value * denominator), denominator };
    } else {
      previous = { value };
    }
  }
  const unmeasured = isRatio && (k.denominator === 0 || previous.denominator === 0);
  const out: ReportKpi = { ...rest, previous };
  if (delta !== undefined && !noFacts && !unmeasured) out.delta = delta;
  return out;
}

function buildKpis(grain: ReportGrain, days: string[], comparisonNoFacts = false): ReportKpi[] {
  const n = days.length;
  const completed = 8 * n + (n % 5);
  const onTimeDenom = Math.max(1, Math.round(completed * 0.7));
  const onTimeNum = Math.round(onTimeDenom * 0.82);
  const overdue = 3 + (n % 4); // point-in-time — never scale this with n the way an additive KPI would
  const kpis: ReportKpi[] = [
    { metricKey: "delivery.tasks_completed", label: "Tasks completed", unit: "count", value: completed, delta: Math.round(completed * 0.08), direction: "up_good", appraisalSafe: true },
    { metricKey: "delivery.throughput_weighted", label: "Throughput (weighted)", unit: "minutes", value: completed * 42, delta: completed * 3, direction: "up_good", appraisalSafe: true },
    {
      metricKey: "delivery.on_time_rate", label: "On-time rate", unit: "percent",
      value: onTimeNum / onTimeDenom, numerator: onTimeNum, denominator: onTimeDenom,
      delta: 0.04, direction: "up_good", appraisalSafe: true,
    },
    // §5.4 #20 — evaluated AT RANGE END, never summed across the range (ruling 4: must show the
    // "as of range end" label or a reader assumes it's a period total).
    { metricKey: "discipline.overdue_open", label: "Overdue (open)", unit: "count", value: overdue, delta: -1, direction: "down_good", appraisalSafe: true, pointInTime: true },
    // §5.4 #22 — a distinct union over the range, never a sum of daily distinct counts (ruling 4).
    { metricKey: "evidence.source_diversity", label: "Source diversity", unit: "count", value: 4, delta: 1, direction: "up_good", appraisalSafe: true, distinctOver: true },
    { metricKey: "flow.reopen_rate", label: "Reopen rate", unit: "percent", value: 0.06, numerator: Math.round(completed * 0.06), denominator: completed, delta: -0.01, direction: "down_good", appraisalSafe: true },
  ];
  if (grain === "department") {
    // DW-3h: the department-grain KPIs the Overview's Team numbers reads. The real builder emits every registry metric valid
    // for the grain (`buildKpis`), so these exist there; the numbers are fixtures. Appended AFTER the six above, so the
    // overview listing's first-three headline slice is unchanged. `capacity_utilization` is logged minutes over expected
    // calendar minutes (a presence proxy); `blocked_share` is blocked task-days over open task-days.
    const expectedMinutes = n * 8 * 60 * 3;
    const loggedMinutes = Math.round(expectedMinutes * 0.78);
    const openDays = Math.max(1, n * 12);
    kpis.push(
      { metricKey: "effort.minutes_logged", label: "Minutes logged", unit: "minutes", value: loggedMinutes, delta: Math.round(loggedMinutes * 0.05), direction: "neutral", appraisalSafe: false },
      { metricKey: "effort.capacity_utilization", label: "Capacity utilization", unit: "percent", value: loggedMinutes / expectedMinutes, numerator: loggedMinutes, denominator: expectedMinutes, delta: 0.02, direction: "neutral", appraisalSafe: false },
      { metricKey: "flow.blocked_share", label: "Blocked share", unit: "percent", value: Math.round(openDays * 0.09) / openDays, numerator: Math.round(openDays * 0.09), denominator: openDays, delta: -0.01, direction: "down_good", appraisalSafe: false },
      { metricKey: "discipline.checkin_compliance", label: "Check-in compliance", unit: "percent", value: 0.88, numerator: Math.round(n * 3 * 0.88), denominator: n * 3, delta: 0.03, direction: "up_good", appraisalSafe: true },
    );
  }
  if (grain === "person") {
    // §15 (TR-08 ruling): person-grain packs are where billable-share is appraisal-UNSAFE — scoring
    // someone on it rewards whoever assigns the billable work, not how well they did it.
    kpis.push({ metricKey: "effort.billable_share", label: "Billable share", unit: "percent", value: 0.64, numerator: Math.round(completed * 0.64), denominator: completed, appraisalSafe: false });
  }
  return kpis.map((k) => withBaseline(k, comparisonNoFacts));
}

function buildDocument(tenantId: string, grain: ReportGrain, scopeRef: string, periodKind: ReportPeriodKind, start: string, end: string, servedTenantId?: string): ReportDocument {
  const today = todayIso();
  const days = allDaysInRange(start, end);
  const dayCount = days.length;

  const activity = additiveSeries("activity_events", "Activity", "count", "line", days, today, 14, 5);
  const throughput = additiveSeries("throughput_weighted", "Throughput (weighted minutes)", "minutes", "bar", days, today, 240, 60);
  const onTimeN = additiveSeries("tasks_completed_on_time", "Completed on time", "count", "bar", days, today, 5, 2);
  const onTimeD = additiveSeries("tasks_completed_with_due_date", "Completed with a due date", "count", "bar", days, today, 6, 2);
  const onTimeRate: ReportSeries = {
    key: "on_time_rate", label: "On-time rate", unit: "percent", kind: "line",
    numeratorKey: "tasks_completed_on_time", denominatorKey: "tasks_completed_with_due_date",
    points: days.map((d, i) => {
      if (d > today) return { t: d, v: null };
      const n = onTimeN.points[i].v ?? 0;
      const dd = onTimeD.points[i].v ?? 0;
      return { t: d, v: dd > 0 ? n / dd : null };
    }),
  };
  const series = [activity, throughput, onTimeN, onTimeD, onTimeRate];

  const distributions: ReportDocument["distributions"] = [
    { key: "evidence_by_source", label: "Evidence by source", kind: "stacked", slices: [
      { label: "task_comment", value: 34 }, { label: "doc_edit", value: 21 }, { label: "time_entry", value: 58 }, { label: "status_change", value: 17 },
    ] },
  ];
  if (grain === "person") {
    distributions.push({
      key: "time_by_project", label: "Time by project", kind: "donut",
      slices: [
        { label: PROJECT_NAMES["p-web-1"], value: 620, ref: { kind: "project", id: "p-web-1" } },
        { label: PROJECT_NAMES["p-seo-1"], value: 340, ref: { kind: "project", id: "p-seo-1" } },
        { label: "Non-project work", value: 95 },
      ],
    });
  }
  if (grain === "department" && !servedTenantId) {
    distributions.push({
      key: "served_companies_split", label: "Served companies", kind: "stacked",
      slices: [{ label: COMPANY_NAMES["co-resort"], value: 180 }, { label: COMPANY_NAMES["co-holding"], value: 90 }],
    });
  }

  const tables: ReportDocument["tables"] = [];
  if (grain === "person") {
    tables.push({
      key: "contributions", label: "Contributions to others' work",
      columns: [{ key: "project", label: "Project", unit: "text", align: "left" }, { key: "minutes", label: "Minutes contributed", unit: "minutes", align: "right" }],
      rows: [{ project: PROJECT_NAMES["p-web-2"], minutes: 145 }, { project: "Non-project work", minutes: 30 }],
      totalRow: { project: "Total", minutes: 175 },
    });
  }
  if (grain === "project") {
    tables.push({
      key: "overdue_tasks", label: "Overdue tasks (as of range end)",
      columns: [{ key: "title", label: "Task", unit: "text", align: "left" }, { key: "dueDate", label: "Due", unit: "text", align: "left" }],
      rows: [{ title: "QA checkout flow", dueDate: addDaysIso(end, -6) }, { title: "Wire homepage hero", dueDate: addDaysIso(end, -2) }],
    });
  }
  if (grain === "department" && !servedTenantId) {
    tables.push({
      key: "per_person", label: "Per-person summary",
      columns: [
        { key: "person", label: "Person", unit: "text", align: "left" },
        { key: "throughput", label: "Throughput (min)", unit: "minutes", align: "right" },
        { key: "onTimeRate", label: "On-time rate", unit: "percent", align: "right" },
      ],
      rows: [
        { person: PERSON_NAMES["u-dev"], throughput: 980, onTimeRate: 0.86 },
        { person: PERSON_NAMES["gede-ic"], throughput: 640, onTimeRate: 0.74 },
      ],
    });
  }
  if (grain === "company") {
    tables.push({
      key: "department_portfolio", label: "Department portfolio",
      columns: [
        { key: "department", label: "Department", unit: "text", align: "left" },
        { key: "throughput", label: "Throughput (min)", unit: "minutes", align: "right" },
        { key: "onTimeRate", label: "On-time rate", unit: "percent", align: "right" },
        { key: "reopenRate", label: "Reopen rate", unit: "percent", align: "right" },
      ],
      rows: [
        { department: DEPARTMENT_NAMES["dept-1"], throughput: 4200, onTimeRate: 0.81, reopenRate: 0.05 },
        { department: DEPARTMENT_NAMES["dept-3"], throughput: 2600, onTimeRate: 0.77, reopenRate: 0.09 },
      ],
    });
  }

  const warnings: NonNullable<ReportDocument["header"]["warnings"]> = {};
  if (periodKind === "custom") { warnings.adHoc = true; warnings.partialPeriod = true; }
  if (end > today) warnings.endsInFuture = true;
  if (start < FACT_HISTORY_START) {
    warnings.precedesFactHistory = { firstFactDate: FACT_HISTORY_START, affectedDays: dayCountOf(start, addDaysIso(FACT_HISTORY_START, -1)) };
  }
  if (grain === "department" && periodKind === "custom" && dayCount > 45) warnings.spansMembershipChange = true;

  // A demo-only stand-in for "the first period the business would seal": any fully-past calendar
  // month. Real sealing is TR-15's job (never done by this live builder) — this exists purely so
  // the sealed/live visual distinction and the revision affordance have something to light up
  // against in a browser today, per TR-17's acceptance bar.
  const currentMonthStart = `${today.slice(0, 7)}-01`;
  const sealed = periodKind === "month" && end < currentMonthStart;

  // DW-4a: a calendar kind compares to the preceding period of the same kind over its own day
  // count (as the backend does); a custom range to the equal-length window right before it.
  const prev = previousPeriodRange(periodKind, start, end, dayCount);
  const cmpFlags = comparisonFlags(prev.start, prev.end, prev.dayCount);

  const header: ReportDocument["header"] = {
    tenantId, grain, scopeRef, scopeName: scopeName(grain, scopeRef, tenantId),
    periodKind, periodStart: start, periodEnd: end, dayCount,
    periodLabel: periodLabel(periodKind, start, end),
    generatedAt: new Date().toISOString(),
    sealed,
    ...(sealed ? { periodId: `demo-period-${grain}-${scopeRef}`, revision: 2 } : {}),
    comparison: { periodStart: prev.start, periodEnd: prev.end, dayCount: prev.dayCount, ...cmpFlags },
    ...(servedTenantId ? { providerView: { servedTenantId, servedTenantName: COMPANY_NAMES[servedTenantId] ?? servedTenantId } } : {}),
    ...(Object.keys(warnings).length > 0 ? { warnings } : {}),
  };

  const kpis = buildKpis(grain, days, cmpFlags.noFacts === true);
  const highlights: ReportDocument["highlights"] = [
    { kind: "achievement", text: `${scopeName(grain, scopeRef, tenantId)} completed ${kpis[0].value.toLocaleString()} tasks this period, up from last period.` },
  ];
  if (Number(kpis[3]?.value ?? 0) > 0) {
    highlights.push({ kind: "risk", text: `${kpis[3].value} task(s) are overdue as of range end.` });
  }

  return {
    header, kpis, series, distributions, tables, highlights,
    // Mirrors the real `buildNarrative`'s shape (kpi-driven, no embedded scope name — the viewer
    // already shows the scope as its own heading) rather than interpolating `scopeName` mid-sentence,
    // which needed an ad-hoc `.toLowerCase()` to avoid "Over July 2026, D & A Syrowatka completed..."
    // reading like two sentence-starts glued together.
    narrative: { source: "deterministic", text: `Over ${periodLabel(periodKind, start, end)}: completed ${kpis[0].value.toLocaleString()} tasks at a ${Math.round((kpis[2].value ?? 0) * 100)}% on-time rate.` },
  };
}

// Rough, honest stand-in for §8's Cerbos matrix — not a re-implementation of Cerbos, just enough
// to let DEMO_MODE exercise the 403 branch (person-for-someone-else, department, company are
// exec/lead/self-only) the same way a real backend would deny a plain member. `demo-hansel` is the
// only demo identity modelled with the elevated (platform_admin + group_executive) grant.
/** Which units a non-elevated caller LEADS, keyed by demo identity.
 *
 *  This exists because §8's department grain is NOT simply "elevated or nothing": the real controller
 *  admits a unit lead and then **narrows the result to the led subtree** (TR-25 slices the grid; the
 *  `reports.department.view` capability comment states it outright). A fixture that answered
 *  all-or-nothing would let a consumer look correct while never exercising the narrowing — and the GM
 *  console's narrowed view (GM-02b) is built entirely on it.
 *
 *  `dept-manager` is the SEO Manager (see `demoFixtures.ts`'s ME_MANAGER), so it leads `dept-3`. */
const LED_UNITS: Record<string, string[]> = {
  "dept-manager": ["dept-3"],
  // DW-3h: the head of Web Dev (ME_WEBHEAD holds `org_unit_lead` on dept-1), the Overview's Team mode.
  "u-webhead": ["dept-1"],
};

const GROUP_OWNER_ID = "demo-owner";

/** DW-4b (BFF §37) — the demo roster of a unit: the demo people who sit in it, keyed by the
 *  department node id (`dept-N`, the same ids the workspace `{dept}` resolves to). Built from the
 *  existing `PERSON_NAMES` only, so no person appears that the other demo reports do not know. A
 *  department with no entry (dept-2, dept-4, dept-5) is a real unit with nobody placed, so the Team
 *  page's "Nobody is placed in this department." state is reachable. */
const DEMO_ROSTERS: Record<string, string[]> = {
  "dept-1": ["u-dev", "u-pm"],
  "dept-3": ["gede-ic", "seo-staff"],
};
/** The overview listing's headline KPI: no `previous` (DW-4m: the real listing has no comparison). */
function headlineKpi(k: ReportKpi): ReportKpi {
  const out = { ...k };
  delete out.previous;
  return out;
}

/** Roster members with NO fact rows in the demo range: `activity: false`, `kpis: []`, never zeros. */
const DEMO_QUIET = new Set(["u-pm", "seo-staff"]);

function isAuthorized(userId: string, grain: ReportGrain, scopeRef: string): boolean {
  const elevated = userId === "demo-hansel";
  if (grain === "person") return elevated || scopeRef === userId;
  if (grain === "project") return true; // demo: project membership isn't modelled finely enough to deny here
  if (grain === "department") {
    if (elevated) return true;
    const led = LED_UNITS[userId];
    if (!led) return false;
    // `"*"` is the overview's "would this caller be denied for ANY scope of this grain" probe — a
    // lead is not denied wholesale, they are narrowed, so it must answer true for them.
    return scopeRef === "*" || led.includes(scopeRef);
  }
  // company — exec only, §8's tightest tier, no lead carve-out. PV1-06a adds the owner of the group
  // (`demo-owner`, an `owner` grant on each company), so the Group pages' per-company links open.
  return elevated || userId === GROUP_OWNER_ID;
}

// §6.2: "for non-custom kinds, `end` is ignored and derived from `start`" — `resolveCalendarRange`
// (./reportCalendar, a mirror of platform-nest's report-calendar.ts) does the snapping. Getting this
// wrong is not cosmetic: the FIRST bug this file shipped with returned a ONE-DAY range for
// `periodKind=month` (just `start`, unexpanded) — every series had a single point, so `TrendLine`
// correctly refused to draw a line ("not enough history yet") and the whole demo looked broken.
// Caught by actually screenshotting the page (ruling 1), not by the unit tests, which never
// asserted `header.dayCount` against a real month.
function validateRange(periodKind: string, start: string | null, end: string | null): { periodKind: ReportPeriodKind; start: string; end: string } | DemoResult {
  if (!isCalendarKind(periodKind) && periodKind !== "custom") return err(400, "periodKind must be one of day, week, month, quarter, semester, year, custom", "periodKind");
  if (!start) return err(400, "start must be a YYYY-MM-DD date", "start");
  if (isCalendarKind(periodKind)) {
    return { periodKind, ...resolveCalendarRange(periodKind, start) };
  }
  if (!end) return err(400, "end is required when periodKind=custom", "end");
  if (end < start) return err(400, "end must be on or after start", "end");
  if (dayCountOf(start, end) > MAX_CUSTOM_DAYS) return err(422, "range_too_large", "end");
  return { periodKind: "custom", start, end };
}

// PV1-06b — `GET /api/:rootId/reports/group`, field-for-field the shape `group-report.ts` returns.
// Mirrors the controller's ORDER: authz first (403: only the owner of the root, `demo-owner`, or the
// platform admin, `demo-hansel`), then 404 unless `:rootId` is a root, then the range. The cards are
// the company-grain KPIs scaled per company, so a card matches what that company's own report shows
// in demo mode; `co-resort` has no `reports` module, so its card is `figures: null`, never zeros.
// `additive` follows the real rule: ratios and distinct unions never add, point-in-time counts do.
// Each root lists its whole tree, root first. `scale: null` is a company without the `reports` module.
const GROUP_ROOTS: Record<string, { id: string; vertical: string; scale: number | null }[]> = {
  "co-holding": [
    { id: "co-holding", vertical: "holding", scale: 0.4 },
    { id: "co-agency", vertical: "agency", scale: 1 },
    { id: "co-resort", vertical: "hospitality", scale: null },
  ],
};

function groupFigures(days: string[], scale: number): GroupFigure[] {
  return buildKpis("company", days).map((k) => {
    const isRatio = k.numerator !== undefined && k.denominator !== undefined;
    const additive = !isRatio && !k.distinctOver;
    const scaled = additive && !k.pointInTime ? Math.round(k.value * scale) : k.value;
    const f: GroupFigure = { metricKey: k.metricKey, label: k.label, unit: k.unit, value: scaled, additive };
    if (isRatio) { f.numerator = k.numerator; f.denominator = k.denominator; }
    return f;
  });
}

function groupReportDemo(rootId: string, params: URLSearchParams, userId: string): DemoResult {
  if (userId !== GROUP_OWNER_ID && userId !== "demo-hansel") return err(403, "forbidden");
  const members = GROUP_ROOTS[rootId];
  if (!members) return err(404, "not a root company");
  const range = validateRange(params.get("periodKind") ?? "month", params.get("start") ?? todayIso(), params.get("end"));
  if ("status" in range) return range;
  const days = allDaysInRange(range.start, range.end);
  const companies: GroupCompanyCard[] = members.map((m) => {
    const base = { companyId: m.id, name: COMPANY_NAMES[m.id] ?? m.id, vertical: m.vertical };
    return m.scale === null
      ? { ...base, figures: null, figuresUnavailable: "reports_module_not_enabled" as const }
      : { ...base, figures: groupFigures(days, m.scale) };
  });
  // Sum of companies: additive figures only, first-seen order, per metric (the real `sumOfCompanies`).
  const sums = new Map<string, GroupReport["sumOfCompanies"][number]>();
  for (const c of companies) {
    for (const f of c.figures ?? []) {
      if (!f.additive) continue;
      const cur = sums.get(f.metricKey);
      if (cur) { cur.value += f.value; cur.companyCount += 1; }
      else sums.set(f.metricKey, { metricKey: f.metricKey, label: f.label, unit: f.unit, value: f.value, companyCount: 1 });
    }
  }
  return ok({
    rootCompanyId: rootId, periodKind: range.periodKind, start: range.start, end: range.end,
    companies, sumOfCompanies: [...sums.values()], consolidated: null, consolidatedReason: "needs F9 eliminations",
  } satisfies GroupReport);
}

// `userId` is threaded in as a 5th param (the other demo dispatchers — pmDemo/meetingsDemo/
// pipelineDemo — don't need per-caller identity, so they don't carry it; this one does, purely to
// exercise the §8 access matrix's 403 branch under DEMO_MODE, per TR-17's acceptance bar "403
// renders a limited-access state, not a crash").
export function reportsDemo(method: string, p: string, params: URLSearchParams, _body: string | undefined, userId: string): DemoResult | null {
  const groupMatch = p.match(/^\/api\/([^/]+)\/reports\/group$/);
  if (groupMatch && method === "GET") return groupReportDemo(groupMatch[1], params, userId);

  const docMatch = p.match(/^\/api\/([^/]+)\/reports\/document$/);
  if (docMatch && method === "GET") {
    const tenantId = docMatch[1];
    const grainRaw = params.get("grain");
    if (!grainRaw || !["person", "project", "department", "company"].includes(grainRaw)) {
      return err(400, "grain must be one of person, project, department, company", "grain");
    }
    const grain = grainRaw as ReportGrain;
    const range = validateRange(params.get("periodKind") ?? "", params.get("start"), params.get("end"));
    if ("status" in range) return range;
    const scopeRef = grain === "company" ? (params.get("scopeRef") || tenantId) : params.get("scopeRef");
    if (!scopeRef) return err(400, "scopeRef is required", "scopeRef");
    if (!isAuthorized(userId, grain, scopeRef)) return err(403, "forbidden");
    const servedTenant = params.get("servedTenant") ?? undefined;
    return ok(buildDocument(tenantId, grain, scopeRef, range.periodKind, range.start, range.end, servedTenant));
  }

  const overviewMatch = p.match(/^\/api\/([^/]+)\/reports\/overview$/);
  if (overviewMatch && method === "GET") {
    const tenantId = overviewMatch[1];
    const grainRaw = params.get("grain");
    if (!grainRaw || !["person", "project", "department", "company"].includes(grainRaw)) {
      return err(400, "grain must be one of person, project, department, company", "grain");
    }
    const grain = grainRaw as ReportGrain;
    // DW-4b (§37): same validation order as the server — unit-vs-grain, range, authorization (a plain
    // member is refused; a led caller must lead the unit, before any existence check), then 404.
    const unit = params.get("unit");
    if (unit !== null && grain !== "person") return err(400, "unit is only valid with grain=person", "unit");
    const range = validateRange(params.get("periodKind") ?? "", params.get("start"), params.get("end"));
    if ("status" in range) return range;
    if (unit !== null) {
      const elevated = userId === "demo-hansel";
      const led = LED_UNITS[userId];
      if (!elevated && !led) return err(403, "forbidden");
      if (!elevated && !led!.includes(unit)) return err(403, "forbidden");
      if (!(unit in DEPARTMENT_NAMES)) return err(404, "unit_not_found", "unit");
      const scopes = (DEMO_ROSTERS[unit] ?? [])
        .map((scopeRef) => {
          const activity = !DEMO_QUIET.has(scopeRef);
          const kpis = activity ? buildDocument(tenantId, "person", scopeRef, range.periodKind, range.start, range.end).kpis.slice(0, 3).map(headlineKpi) : [];
          return { scopeRef, scopeName: scopeName("person", scopeRef, tenantId), kpis, activity };
        })
        .sort((a, b) => a.scopeName.localeCompare(b.scopeName));
      return ok({ periodKind: range.periodKind, start: range.start, end: range.end, unit, scopes });
    }
    // §6.2: overview has no single scopeRef, so it's evaluated against the grain generally — a
    // plain member is correctly denied for department/company (mirrors the real controller's own
    // comment: "a plain self/member principal is correctly denied by Cerbos... which this call
    // never sets"). Approximated here as "would the caller be denied for ANY scope of this grain".
    if ((grain === "department" || grain === "company") && !isAuthorized(userId, grain, "*")) return err(403, "forbidden");
    const catalog: Record<string, Record<string, string>> = { project: PROJECT_NAMES, department: DEPARTMENT_NAMES, person: PERSON_NAMES };
    let names = grain === "company" ? { [tenantId]: COMPANY_NAMES[tenantId] ?? tenantId } : catalog[grain] ?? {};
    // THE narrowing, mirrored. A unit lead asking for department grain gets their led subtree, not the
    // whole company — so a consumer that renders "every department" for a lead is visibly wrong here
    // rather than only against the real backend.
    const led = grain === "department" && userId !== "demo-hansel" ? LED_UNITS[userId] : undefined;
    if (led) names = Object.fromEntries(Object.entries(names).filter(([id]) => led.includes(id)));
    const scopes = Object.entries(names).map(([scopeRef, name]) => {
      const doc = buildDocument(tenantId, grain, scopeRef, range.periodKind, range.start, range.end);
      return { scopeRef, scopeName: name, kpis: doc.kpis.slice(0, 3).map(headlineKpi) };
    });
    return ok({ periodKind: range.periodKind, start: range.start, end: range.end, scopes });
  }

  // DW-4k: `POST reports/export`. The demo does NOT render a document: it validates and authorizes like the
  // controller (format, range, scope, then the same read check as `document`) and answers a job whose download
  // (`app/api/reports/exports/[jobId]/route.ts`) is a small text file that says it is a demo placeholder.
  const exportMatch = p.match(/^\/api\/([^/]+)\/reports\/export$/);
  if (exportMatch && method === "POST") {
    let b: { grain?: string; scopeRef?: string; periodKind?: string; start?: string; end?: string; format?: string } = {};
    try { b = _body ? JSON.parse(_body) : {}; } catch { return err(400, "invalid json body"); }
    if (!b.grain || !["person", "project", "department", "company"].includes(b.grain)) {
      return err(400, "grain must be one of person, project, department, company", "grain");
    }
    const grain = b.grain as ReportGrain;
    const range = validateRange(b.periodKind ?? "", b.start ?? null, b.end ?? null);
    if ("status" in range) return range;
    const scopeRef = grain === "company" ? (b.scopeRef || exportMatch[1]) : b.scopeRef;
    if (!scopeRef) return err(400, "scopeRef is required", "scopeRef");
    if (!b.format || !["pdf", "xlsx", "csv"].includes(b.format)) return err(400, "format must be one of xlsx, csv, pdf", "format");
    if (!isAuthorized(userId, grain, scopeRef)) return err(403, "forbidden");
    return ok({ jobId: `demo-${b.format}` });
  }

  return null;
}
