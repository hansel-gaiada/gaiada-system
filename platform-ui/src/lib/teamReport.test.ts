import { describe, it, expect } from "vitest";
import { formatTeamKpi, NO_DATA } from "./teamReport";
import type { ReportKpi } from "./reports";

function kpi(over: Partial<ReportKpi>): ReportKpi {
  return { metricKey: "delivery.on_time_rate", label: "On Time Rate", unit: "percent", value: 0, appraisalSafe: true, ...over };
}

describe("formatTeamKpi — a Team report cell never fakes a number (DW-4l)", () => {
  it("a ratio with nothing to measure reads —, never 0%", () => {
    expect(formatTeamKpi(kpi({ value: 0, numerator: 0, denominator: 0 }))).toBe(NO_DATA);
  });

  it("a measured ratio reads as a whole percentage, including a real 0%", () => {
    expect(formatTeamKpi(kpi({ value: 0.75, numerator: 3, denominator: 4 }))).toBe("75%");
    expect(formatTeamKpi(kpi({ value: 0, numerator: 0, denominator: 2 }))).toBe("0%");
  });

  it("minutes and counts read whole; a real 0 count stays 0", () => {
    expect(formatTeamKpi(kpi({ metricKey: "delivery.throughput_weighted", unit: "minutes", value: 1234.6 }))).toBe((1235).toLocaleString() + "m");
    expect(formatTeamKpi(kpi({ metricKey: "delivery.tasks_completed", unit: "count", value: 0 }))).toBe("0");
  });

  it("a KPI the person does not carry reads —", () => {
    expect(formatTeamKpi(undefined)).toBe(NO_DATA);
  });
});
