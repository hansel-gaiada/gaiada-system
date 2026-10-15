import { describe, it, expect } from "vitest";
import { reportsDemo, resolveDemoPeriod } from "./demoReports";
import type { ReportDocument } from "./reports";

function call(path: string, query: Record<string, string>, userId = "demo-hansel") {
  return reportsDemo("GET", path, new URLSearchParams(query), undefined, userId);
}

describe("demoReports — reportsDemo (DEMO_MODE fixtures, TR-17)", () => {
  // Regression pin for the bug the Playwright visual pass (ruling 1) actually caught: a
  // `periodKind=month`/`week` request with only `start` given (no `end` — exactly what a grain
  // page sends by default, §6.2: "for non-custom kinds, `end` is ignored and derived from `start`")
  // must expand to the FULL calendar period, not a one-day range. The one-day version passed every
  // existing assertion here (status 200, right grain, right keys) because none of them checked
  // `dayCount` against a real month — only rendering the page in a browser surfaced it (every
  // series had a single point, so `TrendLine` correctly showed "not enough history yet" and the
  // whole demo looked broken).
  it("expands periodKind=month with only `start` to the full calendar month (mirrors resolveCalendarRange)", () => {
    const doc = call("/api/co-agency/reports/document", { grain: "person", scopeRef: "demo-hansel", periodKind: "month", start: "2026-07-15" })!.json as ReportDocument;
    expect(doc.header.periodStart).toBe("2026-07-01");
    expect(doc.header.periodEnd).toBe("2026-07-31");
    expect(doc.header.dayCount).toBe(31);
  });

  it("expands periodKind=week to the Monday-anchored ISO week", () => {
    const doc = call("/api/co-agency/reports/document", { grain: "person", scopeRef: "demo-hansel", periodKind: "week", start: "2026-07-16" })!.json as ReportDocument; // a Thursday
    expect(doc.header.periodStart).toBe("2026-07-13"); // the preceding Monday
    expect(doc.header.periodEnd).toBe("2026-07-19");
    expect(doc.header.dayCount).toBe(7);
  });

  it("returns a live (unsealed) document for a current custom range, with ad-hoc + partial-period warnings", () => {
    const res = call("/api/co-agency/reports/document", {
      grain: "person", scopeRef: "demo-hansel", periodKind: "custom", start: "2026-07-01", end: "2026-07-20",
    });
    expect(res?.status).toBe(200);
    const doc = res!.json as ReportDocument;
    expect(doc.header.sealed).toBe(false);
    expect(doc.header.warnings?.adHoc).toBe(true);
    expect(doc.header.dayCount).toBe(20);
  });

  it("returns a SEALED document for a fully-past calendar month, with a revision", () => {
    const res = call("/api/co-agency/reports/document", { grain: "person", scopeRef: "demo-hansel", periodKind: "month", start: "2020-01-01" });
    const doc = res!.json as ReportDocument;
    expect(doc.header.sealed).toBe(true);
    expect(doc.header.revision).toBe(2);
    expect(doc.header.periodId).toBeTruthy();
  });

  it("marks discipline.overdue_open pointInTime and evidence.source_diversity distinctOver (§5.4 / ruling 4)", () => {
    const res = call("/api/co-agency/reports/document", { grain: "person", scopeRef: "demo-hansel", periodKind: "month", start: "2026-07-01" });
    const doc = res!.json as ReportDocument;
    const overdue = doc.kpis.find((k) => k.metricKey === "discipline.overdue_open")!;
    const diversity = doc.kpis.find((k) => k.metricKey === "evidence.source_diversity")!;
    expect(overdue.pointInTime).toBe(true);
    expect(diversity.distinctOver).toBe(true);
  });

  it("marks effort.billable_share appraisal-UNSAFE on the person grain (TR-08 ruling)", () => {
    const res = call("/api/co-agency/reports/document", { grain: "person", scopeRef: "demo-hansel", periodKind: "month", start: "2026-07-01" });
    const doc = res!.json as ReportDocument;
    const billable = doc.kpis.find((k) => k.metricKey === "effort.billable_share")!;
    expect(billable.appraisalSafe).toBe(false);
  });

  it("emits the same series/distribution/table KEYS the real document-builder.ts uses, per grain", () => {
    const person = call("/api/co-agency/reports/document", { grain: "person", scopeRef: "demo-hansel", periodKind: "month", start: "2026-07-01" })!.json as ReportDocument;
    expect(person.series.map((s) => s.key)).toEqual(expect.arrayContaining(["activity_events", "tasks_completed_on_time", "tasks_completed_with_due_date", "on_time_rate"]));
    expect(person.distributions.map((d) => d.key)).toEqual(expect.arrayContaining(["evidence_by_source", "time_by_project"]));
    expect(person.tables.map((t) => t.key)).toEqual(expect.arrayContaining(["contributions"]));

    const project = call("/api/co-agency/reports/document", { grain: "project", scopeRef: "p-web-1", periodKind: "month", start: "2026-07-01" })!.json as ReportDocument;
    expect(project.tables.map((t) => t.key)).toEqual(expect.arrayContaining(["overdue_tasks"]));
    expect(project.distributions.map((d) => d.key)).not.toContain("time_by_project"); // person-grain only (§7)

    const department = call("/api/co-agency/reports/document", { grain: "department", scopeRef: "dept-1", periodKind: "month", start: "2026-07-01" })!.json as ReportDocument;
    expect(department.tables.map((t) => t.key)).toEqual(expect.arrayContaining(["per_person"]));
    expect(department.distributions.map((d) => d.key)).toEqual(expect.arrayContaining(["served_companies_split"]));

    const company = call("/api/co-agency/reports/document", { grain: "company", scopeRef: "co-agency", periodKind: "month", start: "2026-07-01" })!.json as ReportDocument;
    expect(company.tables.map((t) => t.key)).toEqual(expect.arrayContaining(["department_portfolio"]));
  });

  it("403s a person-grain read for someone else's scope, unless the caller is the elevated demo identity", () => {
    const denied = call("/api/co-agency/reports/document", { grain: "person", scopeRef: "u-dev", periodKind: "month", start: "2026-07-01" }, "gede-ic");
    expect(denied?.status).toBe(403);
    const allowed = call("/api/co-agency/reports/document", { grain: "person", scopeRef: "u-dev", periodKind: "month", start: "2026-07-01" }, "demo-hansel");
    expect(allowed?.status).toBe(200);
  });

  it("403s department-grain and company-grain reads for a non-elevated identity", () => {
    expect(call("/api/co-agency/reports/document", { grain: "department", scopeRef: "dept-1", periodKind: "month", start: "2026-07-01" }, "gede-ic")?.status).toBe(403);
    expect(call("/api/co-agency/reports/document", { grain: "company", scopeRef: "co-agency", periodKind: "month", start: "2026-07-01" }, "gede-ic")?.status).toBe(403);
  });

  it("422s a custom range past the 400-day ceiling as the flat {error, field} shape (§15 ruling ③)", () => {
    const res = call("/api/co-agency/reports/document", { grain: "person", scopeRef: "demo-hansel", periodKind: "custom", start: "2020-01-01", end: "2026-07-01" });
    expect(res?.status).toBe(422);
    expect(res?.json).toEqual({ error: "range_too_large", field: "end" });
  });

  it("400s when periodKind=custom is missing `end`", () => {
    const res = call("/api/co-agency/reports/document", { grain: "person", scopeRef: "demo-hansel", periodKind: "custom", start: "2026-07-01" });
    expect(res?.status).toBe(400);
  });

  it("overview lists scopes with headline KPIs for the project/department scope pickers", () => {
    const res = call("/api/co-agency/reports/overview", { grain: "project", periodKind: "month", start: "2026-07-01" });
    expect(res?.status).toBe(200);
    const overview = res!.json as { scopes: { scopeRef: string; scopeName: string; kpis: unknown[] }[] };
    expect(overview.scopes.length).toBeGreaterThan(0);
    expect(overview.scopes[0].kpis.length).toBeGreaterThan(0);
  });

  it("returns null for a path it doesn't own, so the dispatch chain can fall through", () => {
    expect(reportsDemo("GET", "/api/co-agency/pm/tasks", new URLSearchParams(), undefined, "demo-hansel")).toBeNull();
  });
});

// DW-4a — the golden table. BYTE-IDENTICAL to the one in
// platform-nest/src/modules/reports/report-calendar.test.ts (its twin): the demo backend
// re-implements the backend's calendar math, so both must give the same snapped range, label and
// comparison for the same input. Change one table and you must change the other.
// ---- GOLDEN TABLE (byte-identical twin) ----
const GOLDEN = [
  { kind: "day", input: "2026-10-14", start: "2026-10-14", end: "2026-10-14", dayCount: 1, label: "14 Oct 2026", prevStart: "2026-10-13", prevEnd: "2026-10-13", prevDayCount: 1 },
  { kind: "week", input: "2026-10-14", start: "2026-10-12", end: "2026-10-18", dayCount: 7, label: "Week 42 2026", prevStart: "2026-10-05", prevEnd: "2026-10-11", prevDayCount: 7 },
  { kind: "month", input: "2026-02-10", start: "2026-02-01", end: "2026-02-28", dayCount: 28, label: "February 2026", prevStart: "2026-01-01", prevEnd: "2026-01-31", prevDayCount: 31 },
  { kind: "quarter", input: "2026-08-17", start: "2026-07-01", end: "2026-09-30", dayCount: 92, label: "Q3 2026", prevStart: "2026-04-01", prevEnd: "2026-06-30", prevDayCount: 91 },
  { kind: "quarter", input: "2027-01-15", start: "2027-01-01", end: "2027-03-31", dayCount: 90, label: "Q1 2027", prevStart: "2026-10-01", prevEnd: "2026-12-31", prevDayCount: 92 },
  { kind: "quarter", input: "2026-12-31", start: "2026-10-01", end: "2026-12-31", dayCount: 92, label: "Q4 2026", prevStart: "2026-07-01", prevEnd: "2026-09-30", prevDayCount: 92 },
  { kind: "quarter", input: "2028-02-29", start: "2028-01-01", end: "2028-03-31", dayCount: 91, label: "Q1 2028", prevStart: "2027-10-01", prevEnd: "2027-12-31", prevDayCount: 92 },
  { kind: "semester", input: "2026-03-03", start: "2026-01-01", end: "2026-06-30", dayCount: 181, label: "Semester 1 2026", prevStart: "2025-07-01", prevEnd: "2025-12-31", prevDayCount: 184 },
  { kind: "semester", input: "2026-12-31", start: "2026-07-01", end: "2026-12-31", dayCount: 184, label: "Semester 2 2026", prevStart: "2026-01-01", prevEnd: "2026-06-30", prevDayCount: 181 },
  { kind: "semester", input: "2028-02-29", start: "2028-01-01", end: "2028-06-30", dayCount: 182, label: "Semester 1 2028", prevStart: "2027-07-01", prevEnd: "2027-12-31", prevDayCount: 184 },
  { kind: "year", input: "2026-06-15", start: "2026-01-01", end: "2026-12-31", dayCount: 365, label: "Year 2026", prevStart: "2025-01-01", prevEnd: "2025-12-31", prevDayCount: 365 },
  { kind: "year", input: "2028-07-01", start: "2028-01-01", end: "2028-12-31", dayCount: 366, label: "Year 2028", prevStart: "2027-01-01", prevEnd: "2027-12-31", prevDayCount: 365 },
  { kind: "year", input: "2029-01-01", start: "2029-01-01", end: "2029-12-31", dayCount: 365, label: "Year 2029", prevStart: "2028-01-01", prevEnd: "2028-12-31", prevDayCount: 366 },
] as const;
// ---- END GOLDEN TABLE ----

describe("demoReports — DW-4a calendar periods (golden table, twin of report-calendar.test.ts)", () => {
  it.each(GOLDEN)("$kind $input -> $label", (row) => {
    const p = resolveDemoPeriod(row.kind, row.input);
    expect({ start: p.start, end: p.end }).toEqual({ start: row.start, end: row.end });
    expect(p.dayCount).toBe(row.dayCount);
    expect(p.label).toBe(row.label);
    expect(p.comparison).toEqual({ periodStart: row.prevStart, periodEnd: row.prevEnd, dayCount: row.prevDayCount });
  });

  it("serves a quarter, semester and year document with the snapped range, label and comparison", () => {
    const get = (periodKind: string, start: string) =>
      call("/api/co-agency/reports/document", { grain: "person", scopeRef: "demo-hansel", periodKind, start })!.json as ReportDocument;
    const q = get("quarter", "2026-08-17").header;
    expect([q.periodStart, q.periodEnd, q.dayCount, q.periodLabel]).toEqual(["2026-07-01", "2026-09-30", 92, "Q3 2026"]);
    // DW-4m: Q2 starts before the demo's first fact date (2026-05-01), so its flag is set; April has 30 days.
    expect(q.comparison).toEqual({ periodStart: "2026-04-01", periodEnd: "2026-06-30", dayCount: 91, precedesFactHistory: { firstFactDate: "2026-05-01", affectedDays: 30 } });
    const s = get("semester", "2026-12-31").header;
    expect([s.periodStart, s.periodEnd, s.periodLabel]).toEqual(["2026-07-01", "2026-12-31", "Semester 2 2026"]);
    const y = get("year", "2028-07-01").header;
    expect([y.periodStart, y.periodEnd, y.dayCount, y.periodLabel]).toEqual(["2028-01-01", "2028-12-31", 366, "Year 2028"]);
  });

  it("400s an unknown periodKind with the message that lists all seven kinds", () => {
    const res = call("/api/co-agency/reports/document", { grain: "person", scopeRef: "demo-hansel", periodKind: "decade", start: "2026-07-01" });
    expect(res?.status).toBe(400);
    expect((res!.json as { error: string }).error).toBe("periodKind must be one of day, week, month, quarter, semester, year, custom");
  });
});

describe("demoReports — the department document for a head (DW-3h)", () => {
  const dept = (scopeRef: string, userId: string) =>
    call("/api/co-agency/reports/document", { grain: "department", scopeRef, periodKind: "month", start: "2026-07-01" }, userId)!;

  it("serves the head of Web Dev their own department and refuses another, like the server's led-unit narrowing", () => {
    expect(dept("dept-1", "u-webhead").status).toBe(200);
    expect(dept("dept-3", "u-webhead").status).toBe(403);
  });

  it("carries the department KPIs the Overview's Team numbers reads, each a ratio with both parts or a plain figure", () => {
    const doc = dept("dept-1", "u-webhead").json as ReportDocument;
    const kpi = (k: string) => doc.kpis.find((x) => x.metricKey === k)!;
    for (const k of ["delivery.on_time_rate", "flow.blocked_share", "effort.capacity_utilization", "discipline.checkin_compliance"]) {
      expect(kpi(k), k).toBeDefined();
      expect(kpi(k).denominator, k).toBeGreaterThan(0);
    }
    expect(kpi("effort.minutes_logged").value).toBeGreaterThan(0);
    // The listing's headline slice (first three) is unchanged by the additions.
    expect(doc.kpis.slice(0, 3).map((k) => k.metricKey)).toEqual(["delivery.tasks_completed", "delivery.throughput_weighted", "delivery.on_time_rate"]);
  });

  it("keeps the person grain as it was: no department KPIs there", () => {
    const person = call("/api/co-agency/reports/document", { grain: "person", scopeRef: "demo-hansel", periodKind: "month", start: "2026-07-01" })!.json as ReportDocument;
    expect(person.kpis.map((k) => k.metricKey)).not.toContain("flow.blocked_share");
  });
});

describe("demoReports — overview?grain=person&unit= (DW-4b, BFF §37)", () => {
  const base = { grain: "person", periodKind: "month", start: "2026-07-01" };
  type Scope = { scopeRef: string; scopeName: string; kpis: unknown[]; activity?: boolean };
  const unitCall = (query: Record<string, string>, userId = "demo-hansel") => call("/api/co-agency/reports/overview", query, userId)!;

  it("lists the unit's whole roster by name, a quiet member as activity:false with kpis []", () => {
    const res = unitCall({ ...base, unit: "dept-1" });
    expect(res.status).toBe(200);
    const body = res.json as { unit: string; scopes: Scope[] };
    expect(body.unit).toBe("dept-1");
    expect(body.scopes.map((s) => s.scopeName)).toEqual(["Dewi Santoso", "Made Putra"]);
    const quiet = body.scopes.find((s) => s.scopeRef === "u-pm")!;
    expect(quiet.activity).toBe(false);
    expect(quiet.kpis).toEqual([]);
    const active = body.scopes.find((s) => s.scopeRef === "u-dev")!;
    expect(active.activity).toBe(true);
    expect(active.kpis.length).toBe(3);
  });

  it("a real unit nobody is placed in answers an empty roster, not a 404", () => {
    const res = unitCall({ ...base, unit: "dept-5" });
    expect(res.status).toBe(200);
    expect((res.json as { scopes: Scope[] }).scopes).toEqual([]);
  });

  it("validates in the server's order: grain, then range, then 403 before 404", () => {
    expect(unitCall({ ...base, grain: "department", unit: "dept-1" }).status).toBe(400);
    expect((unitCall({ ...base, grain: "department", unit: "dept-1" }).json as { field: string }).field).toBe("unit");
    expect(unitCall({ grain: "person", periodKind: "bogus", start: "2026-07-01", unit: "dept-1" }).status).toBe(400);
    expect(unitCall({ ...base, unit: "dept-1" }, "gede-ic").status).toBe(403); // a plain member
    expect(unitCall({ ...base, unit: "dept-1" }, "dept-manager").status).toBe(403); // leads dept-3 only
    expect(unitCall({ ...base, unit: "dept-nope" }, "dept-manager").status).toBe(403); // no existence leak
    const missing = unitCall({ ...base, unit: "dept-nope" });
    expect(missing.status).toBe(404);
    expect(missing.json).toMatchObject({ error: "unit_not_found", field: "unit" });
  });

  it("a unit lead reads their own unit's roster", () => {
    const res = unitCall({ ...base, unit: "dept-3" }, "dept-manager");
    expect(res.status).toBe(200);
    expect((res.json as { scopes: Scope[] }).scopes.map((s) => s.scopeRef).sort()).toEqual(["gede-ic", "seo-staff"]);
  });

  it("without `unit` the person overview is unchanged: no `unit`, no `activity`", () => {
    const body = unitCall(base).json as Record<string, unknown> & { scopes: Array<Record<string, unknown>> };
    expect(body).not.toHaveProperty("unit");
    for (const s of body.scopes) expect(s).not.toHaveProperty("activity");
  });
});

// DW-4m — a comparison says when its baseline is not real (same rules as platform-nest's buildKpis).
describe("demoReports — DW-4m comparison honesty (previous, omitted delta, comparison flags)", () => {
  const get = (periodKind: string, start: string, grain = "person", scopeRef = "demo-hansel") =>
    call("/api/co-agency/reports/document", { grain, scopeRef, periodKind, start })!.json as ReportDocument;

  it("every KPI carries previous; a ratio carries the previous parts; a real baseline keeps its delta", () => {
    const doc = get("month", "2026-07-01"); // comparison = June, after the demo's first fact date
    expect(doc.header.comparison?.noFacts).toBeUndefined();
    expect(doc.header.comparison?.precedesFactHistory).toBeUndefined();
    for (const k of doc.kpis) expect(k.previous, k.metricKey).toBeDefined();
    const onTime = doc.kpis.find((k) => k.metricKey === "delivery.on_time_rate")!;
    expect(onTime.previous?.numerator).toBeDefined();
    expect(onTime.previous?.denominator).toBeGreaterThan(0);
    expect(onTime.delta).toBe(0.04);
    const completed = doc.kpis.find((k) => k.metricKey === "delivery.tasks_completed")!;
    expect(completed.previous).toEqual({ value: completed.value - completed.delta! });
  });

  it("a comparison wholly before the first fact date (April vs 2026-05-01): noFacts, no KPI has a delta, previous is zero", () => {
    const doc = get("month", "2026-05-15"); // May, compared with April
    expect(doc.header.comparison).toEqual({
      periodStart: "2026-04-01", periodEnd: "2026-04-30", dayCount: 30,
      precedesFactHistory: { firstFactDate: "2026-05-01", affectedDays: 30 }, noFacts: true,
    });
    for (const k of doc.kpis) {
      expect("delta" in k, k.metricKey).toBe(false);
      expect(k.previous?.value, k.metricKey).toBe(0);
    }
    const onTime = doc.kpis.find((k) => k.metricKey === "delivery.on_time_rate")!;
    expect(onTime.previous).toEqual({ value: 0, numerator: 0, denominator: 0 });
    expect(doc.kpis.find((k) => k.metricKey === "evidence.source_diversity")!.previous).toEqual({ value: 0 });
  });

  it("a comparison that straddles the first fact date: precedesFactHistory only, the deltas are kept", () => {
    const doc = get("quarter", "2026-08-17"); // Q3, compared with Q2 (starts 2026-04-01)
    expect(doc.header.comparison?.precedesFactHistory).toEqual({ firstFactDate: "2026-05-01", affectedDays: 30 });
    expect(doc.header.comparison?.noFacts).toBeUndefined();
    expect(doc.kpis.find((k) => k.metricKey === "delivery.tasks_completed")!.delta).toBeDefined();
  });

  it("the overview listing's headline KPIs carry no previous, as the real listing does", () => {
    const res = call("/api/co-agency/reports/overview", { grain: "project", periodKind: "month", start: "2026-07-01" });
    const scopes = (res!.json as { scopes: { kpis: { previous?: unknown }[] }[] }).scopes;
    for (const s of scopes) for (const k of s.kpis) expect("previous" in k).toBe(false);
  });
});

// PV7-01 — the client grain in the demo store (mirrors the backend's document and overview).
describe("demoReports — client grain (PV7-01)", () => {
  it("serves a client document: grain, name, the Projects table, and never source_diversity", () => {
    const res = call("/api/co-agency/reports/document", { grain: "client", scopeRef: "c-acme", periodKind: "month", start: "2026-07-01" });
    expect(res!.status).toBe(200);
    const doc = res!.json as ReportDocument;
    expect(doc.header.grain).toBe("client");
    expect(doc.header.scopeName).toBe("Acme Hospitality");
    expect(doc.kpis.map((k) => k.metricKey)).not.toContain("evidence.source_diversity");
    expect(doc.tables.map((t) => t.key)).toContain("client_projects");
  });

  it("lists the demo clients in the overview and names the grain in its 400", () => {
    const res = call("/api/co-agency/reports/overview", { grain: "client", periodKind: "month", start: "2026-07-01" });
    expect(res!.status).toBe(200);
    const scopes = (res!.json as { scopes: { scopeRef: string; scopeName: string }[] }).scopes;
    expect(scopes.map((s) => s.scopeRef).sort()).toEqual(["c-acme", "c-sunrise"]);
    const bad = call("/api/co-agency/reports/document", { grain: "account", scopeRef: "x", periodKind: "month", start: "2026-07-01" });
    expect(bad!.status).toBe(400);
    expect(JSON.stringify(bad!.json)).toContain("client");
  });
});
