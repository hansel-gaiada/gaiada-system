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
  "u-pm": "Dewi Santoso", "u-dev": "Made Putra", "u-finance": "Rina Wibawa",
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

/** Calendar-kind label ("16 Jul 2026" / "Week 29 2026" / "July 2026") vs a custom range's
 *  "16 Jul – 3 Aug 2026" — mirrors `report-document.ts`'s own `periodLabel` doc comment closely
 *  enough for a demo fixture (exact week/month-number formatting isn't the point here). */
function periodLabel(periodKind: ReportPeriodKind, start: string, end: string): string {
  if (periodKind === "custom") return formatDateRange(start, end);
  const d = new Date(`${start}T00:00:00Z`);
  if (periodKind === "day") return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  if (periodKind === "month") return d.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  return `Week of ${formatDateRange(start, end)}`;
}

function buildKpis(grain: ReportGrain, days: string[]): ReportKpi[] {
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
  if (grain === "person") {
    // §15 (TR-08 ruling): person-grain packs are where billable-share is appraisal-UNSAFE — scoring
    // someone on it rewards whoever assigns the billable work, not how well they did it.
    kpis.push({ metricKey: "effort.billable_share", label: "Billable share", unit: "percent", value: 0.64, numerator: Math.round(completed * 0.64), denominator: completed, appraisalSafe: false });
  }
  return kpis;
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

  const comparisonStart = addDaysIso(start, -dayCount);
  const comparisonEnd = addDaysIso(start, -1);

  const header: ReportDocument["header"] = {
    tenantId, grain, scopeRef, scopeName: scopeName(grain, scopeRef, tenantId),
    periodKind, periodStart: start, periodEnd: end, dayCount,
    periodLabel: periodLabel(periodKind, start, end),
    generatedAt: new Date().toISOString(),
    sealed,
    ...(sealed ? { periodId: `demo-period-${grain}-${scopeRef}`, revision: 2 } : {}),
    comparison: { periodStart: comparisonStart, periodEnd: comparisonEnd, dayCount },
    ...(servedTenantId ? { providerView: { servedTenantId, servedTenantName: COMPANY_NAMES[servedTenantId] ?? servedTenantId } } : {}),
    ...(Object.keys(warnings).length > 0 ? { warnings } : {}),
  };

  const kpis = buildKpis(grain, days);
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
function isAuthorized(userId: string, grain: ReportGrain, scopeRef: string): boolean {
  const elevated = userId === "demo-hansel";
  if (grain === "person") return elevated || scopeRef === userId;
  if (grain === "project") return true; // demo: project membership isn't modelled finely enough to deny here
  if (grain === "department") return elevated;
  return elevated; // company
}

// Mirrors `document-builder.ts`'s `resolveCalendarRange` exactly (§6.2: "for non-custom kinds,
// `end` is ignored and derived from `start`"). Getting this wrong is not cosmetic: the FIRST bug
// this file shipped with returned a ONE-DAY range for `periodKind=month` (just `start`, unexpanded)
// — every series had a single point, so `TrendLine` correctly refused to draw a line ("not enough
// history yet") and the whole demo looked broken. Caught by actually screenshotting the page
// (ruling 1), not by the unit tests, which never asserted `header.dayCount` against a real month.
function mondayOnOrBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
function resolveCalendarRange(periodKind: "day" | "week" | "month", start: string): { start: string; end: string } {
  if (periodKind === "day") return { start, end: start };
  if (periodKind === "week") {
    const s = mondayOnOrBefore(start);
    return { start: s, end: addDaysIso(s, 6) };
  }
  const monthStart = `${start.slice(0, 7)}-01`;
  const d = new Date(`${monthStart}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0); // last day of the ORIGINAL month
  return { start: monthStart, end: d.toISOString().slice(0, 10) };
}

function validateRange(periodKind: string, start: string | null, end: string | null): { periodKind: ReportPeriodKind; start: string; end: string } | DemoResult {
  if (!["day", "week", "month", "custom"].includes(periodKind)) return err(400, "periodKind must be one of day, week, month, custom", "periodKind");
  if (!start) return err(400, "start must be a YYYY-MM-DD date", "start");
  if (periodKind !== "custom") {
    const resolved = resolveCalendarRange(periodKind as "day" | "week" | "month", start);
    return { periodKind: periodKind as ReportPeriodKind, ...resolved };
  }
  if (!end) return err(400, "end is required when periodKind=custom", "end");
  if (end < start) return err(400, "end must be on or after start", "end");
  if (dayCountOf(start, end) > MAX_CUSTOM_DAYS) return err(422, "range_too_large", "end");
  return { periodKind: "custom", start, end };
}

// `userId` is threaded in as a 5th param (the other demo dispatchers — pmDemo/meetingsDemo/
// pipelineDemo — don't need per-caller identity, so they don't carry it; this one does, purely to
// exercise the §8 access matrix's 403 branch under DEMO_MODE, per TR-17's acceptance bar "403
// renders a limited-access state, not a crash").
export function reportsDemo(method: string, p: string, params: URLSearchParams, _body: string | undefined, userId: string): DemoResult | null {
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
    const range = validateRange(params.get("periodKind") ?? "", params.get("start"), params.get("end"));
    if ("status" in range) return range;
    // §6.2: overview has no single scopeRef, so it's evaluated against the grain generally — a
    // plain member is correctly denied for department/company (mirrors the real controller's own
    // comment: "a plain self/member principal is correctly denied by Cerbos... which this call
    // never sets"). Approximated here as "would the caller be denied for ANY scope of this grain".
    if ((grain === "department" || grain === "company") && !isAuthorized(userId, grain, "*")) return err(403, "forbidden");
    const catalog: Record<string, Record<string, string>> = { project: PROJECT_NAMES, department: DEPARTMENT_NAMES, person: PERSON_NAMES };
    const names = grain === "company" ? { [tenantId]: COMPANY_NAMES[tenantId] ?? tenantId } : catalog[grain] ?? {};
    const scopes = Object.entries(names).map(([scopeRef, name]) => {
      const doc = buildDocument(tenantId, grain, scopeRef, range.periodKind, range.start, range.end);
      return { scopeRef, scopeName: name, kpis: doc.kpis.slice(0, 3) };
    });
    return ok({ periodKind: range.periodKind, start: range.start, end: range.end, scopes });
  }

  return null;
}
