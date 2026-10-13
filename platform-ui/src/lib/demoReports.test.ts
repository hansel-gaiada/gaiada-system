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
    expect(q.comparison).toEqual({ periodStart: "2026-04-01", periodEnd: "2026-06-30", dayCount: 91 });
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
