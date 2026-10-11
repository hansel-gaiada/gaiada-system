// PV1-06a — the group report's summing rule, pure (no DB, no Cerbos). The live HTTP + authz half is
// group-report.db.test.ts. This file pins the one thing a wrong edit here would silently get wrong:
// which figures may be added across companies. Ratios and distinct unions never; counts and minutes
// yes; the point-in-time overdue count yes.
import { describe, it, expect } from "vitest";
import { assembleGroupReport, isAdditiveAcrossCompanies, sumOfCompanies, type GroupCompany } from "./group-report";
import type { ReportDocument, ReportKpi } from "./report-document";

const kpi = (metricKey: string, value: number, extra: Partial<ReportKpi> = {}): ReportKpi => ({
  metricKey,
  label: metricKey,
  unit: "count",
  value,
  appraisalSafe: false,
  ...extra,
});

/** Only `kpis` is read by the assembly; the rest of the document is irrelevant here. */
const docWith = (kpis: ReportKpi[]): ReportDocument => ({ kpis } as unknown as ReportDocument);

const co = (id: string): GroupCompany => ({ id, name: `Co ${id}`, vertical: "general" });

describe("PV1-06a · group report summing rule", () => {
  it("additive counts and minutes are additive across companies", () => {
    expect(isAdditiveAcrossCompanies(kpi("delivery.tasks_completed", 3))).toBe(true);
    expect(isAdditiveAcrossCompanies(kpi("delivery.throughput_weighted", 180, { unit: "minutes" }))).toBe(true);
    expect(isAdditiveAcrossCompanies(kpi("effort.minutes_logged", 0, { unit: "minutes" }))).toBe(true);
  });

  it("🔴 a ratio is NEVER additive, even when it carries no denominator", () => {
    expect(isAdditiveAcrossCompanies(kpi("delivery.on_time_rate", 1, { unit: "percent", numerator: 3, denominator: 3 }))).toBe(false);
    expect(isAdditiveAcrossCompanies(kpi("effort.capacity_utilization", 0.5, { unit: "percent" }))).toBe(false);
    // `flow.wip_open_avg` is a COUNT-unit average — the unit alone would mis-classify it.
    expect(isAdditiveAcrossCompanies(kpi("flow.wip_open_avg", 4))).toBe(false);
  });

  it("🔴 a distinct union (#22) is never additive; the point-in-time overdue count (#20) is", () => {
    expect(isAdditiveAcrossCompanies(kpi("evidence.source_diversity", 2, { distinctOver: true }))).toBe(false);
    expect(isAdditiveAcrossCompanies(kpi("discipline.overdue_open", 5, { pointInTime: true }))).toBe(true);
  });

  it("an unknown metric key is not additive (fail closed)", () => {
    expect(isAdditiveAcrossCompanies(kpi("not.a.metric", 1))).toBe(false);
  });

  it("sums additive figures only, counts contributors, and skips a card with no figures", () => {
    const report = assembleGroupReport({
      rootCompanyId: "root",
      periodKind: "month",
      start: "2026-07-01",
      end: "2026-07-31",
      companies: [
        { company: co("root"), document: docWith([kpi("delivery.tasks_completed", 1), kpi("delivery.on_time_rate", 1, { unit: "percent", numerator: 1, denominator: 1 })]) },
        { company: co("a"), document: docWith([kpi("delivery.tasks_completed", 2), kpi("delivery.on_time_rate", 0.5, { unit: "percent", numerator: 1, denominator: 2 })]) },
        { company: co("b"), document: null },
      ],
    });

    expect(report.companies).toHaveLength(3);
    expect(report.companies[2]).toMatchObject({ companyId: "b", figures: null, figuresUnavailable: "reports_module_not_enabled" });
    expect(report.sumOfCompanies).toEqual([
      { metricKey: "delivery.tasks_completed", label: "delivery.tasks_completed", unit: "count", value: 3, companyCount: 2 },
    ]);
    expect(report.sumOfCompanies.find((s) => s.metricKey === "delivery.on_time_rate")).toBeUndefined();
    expect(report.consolidated).toBeNull();
    expect(report.consolidatedReason).toBe("needs F9 eliminations");
  });

  it("each card's figures say which ones fed the sum", () => {
    const cards = assembleGroupReport({
      rootCompanyId: "root",
      periodKind: "month",
      start: "2026-07-01",
      end: "2026-07-31",
      companies: [{ company: co("root"), document: docWith([kpi("delivery.tasks_completed", 1), kpi("delivery.on_time_rate", 1, { unit: "percent", numerator: 1, denominator: 1 })]) }],
    }).companies;
    expect(cards[0].figures!.map((f) => [f.metricKey, f.additive])).toEqual([
      ["delivery.tasks_completed", true],
      ["delivery.on_time_rate", false],
    ]);
    expect(cards[0].figures![1]).toMatchObject({ numerator: 1, denominator: 1 });
    expect(sumOfCompanies([])).toEqual([]);
  });
});
