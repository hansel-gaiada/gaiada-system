import { describe, it, expect } from "vitest";
import {
  acrossLabel, cardBody, consolidatedNote, displayableSums, formatFigureValue, isRatioFigure, MODULE_OFF_TEXT,
  sumRows, verticalLabel, type GroupCompanyCard, type GroupFigure, type GroupSum,
} from "./groupReport";

const count = (metricKey: string, label: string, value: number): GroupFigure => ({ metricKey, label, unit: "count", value, additive: true });
const ratio = (metricKey: string, label: string, num: number, den: number): GroupFigure => ({
  metricKey, label, unit: "percent", value: num / den, numerator: num, denominator: den, additive: false,
});
const card = (companyId: string, figures: GroupFigure[] | null): GroupCompanyCard => ({ companyId, name: companyId, vertical: "agency", figures });
const sum = (metricKey: string, label: string, value: number, companyCount: number): GroupSum => ({ metricKey, label, unit: "count", value, companyCount });

describe("groupReport: sums", () => {
  const companies = [
    card("a", [count("delivery.tasks_completed", "Tasks completed", 10), ratio("delivery.on_time_rate", "On-time rate", 4, 5)]),
    card("b", [count("delivery.tasks_completed", "Tasks completed", 5), ratio("delivery.on_time_rate", "On-time rate", 1, 5)]),
    card("c", null),
  ];

  it("shows a sum with `across N companies`", () => {
    const rows = sumRows({ companies, sumOfCompanies: [sum("delivery.tasks_completed", "Tasks completed", 15, 2)] });
    expect(rows).toEqual([{ key: "delivery.tasks_completed", label: "Tasks completed", value: "15", across: "across 2 companies" }]);
  });

  it("says `company`, not `companies`, for one", () => {
    expect(acrossLabel(1)).toBe("across 1 company");
    expect(acrossLabel(3)).toBe("across 3 companies");
  });

  it("never presents a ratio as a sum, even when the backend sends one", () => {
    const bad: GroupSum = { metricKey: "delivery.on_time_rate", label: "On-time rate", unit: "percent", value: 1.0, companyCount: 2 };
    const sums = displayableSums({ companies, sumOfCompanies: [sum("delivery.tasks_completed", "Tasks completed", 15, 2), bad] });
    expect(sums.map((s) => s.metricKey)).toEqual(["delivery.tasks_completed"]);
  });

  it("drops a sum whose figures are not additive on the cards, whatever its unit", () => {
    const distinct: GroupFigure = { ...count("evidence.source_diversity", "Source diversity", 4), additive: false };
    const sums = displayableSums({
      companies: [card("a", [distinct])],
      sumOfCompanies: [sum("evidence.source_diversity", "Source diversity", 4, 1)],
    });
    expect(sums).toEqual([]);
  });

  it("classifies a ratio by its parts or its percent unit", () => {
    expect(isRatioFigure(ratio("m", "M", 1, 2))).toBe(true);
    expect(isRatioFigure({ unit: "percent" })).toBe(true);
    expect(isRatioFigure({ unit: "count", numerator: 1, denominator: 2 })).toBe(true);
    expect(isRatioFigure({ unit: "count" })).toBe(false);
  });
});

describe("groupReport: company cards", () => {
  it("`figures: null` is the module-off text and never a row of zeros", () => {
    expect(cardBody(card("c", null))).toEqual({ kind: "off", text: MODULE_OFF_TEXT });
    expect(MODULE_OFF_TEXT).toBe("Report module off for this company");
  });

  it("an empty figure list is an empty card, not the module-off text and not zeros", () => {
    expect(cardBody(card("c", []))).toEqual({ kind: "figures", rows: [] });
  });

  it("a real zero stays a zero (the company has the module and did nothing)", () => {
    const body = cardBody(card("a", [count("delivery.tasks_completed", "Tasks completed", 0)]));
    expect(body).toEqual({ kind: "figures", rows: [{ key: "delivery.tasks_completed", label: "Tasks completed", value: "0", parts: null }] });
  });

  it("a ratio shows its parts beside the percent", () => {
    const body = cardBody(card("a", [ratio("delivery.on_time_rate", "On-time rate", 4, 5)]));
    expect(body).toMatchObject({ kind: "figures", rows: [{ value: "80%", parts: "4/5" }] });
  });
});

describe("groupReport: formatting", () => {
  it("formats by unit", () => {
    expect(formatFigureValue("percent", 0.826)).toBe("83%");
    expect(formatFigureValue("minutes", 1234.4)).toBe("1,234 min");
    expect(formatFigureValue("count", 1200)).toBe("1,200");
  });

  it("labels verticals, defaulting to General", () => {
    expect(verticalLabel("hospitality")).toBe("Hospitality");
    expect(verticalLabel(undefined)).toBe("General");
    expect(verticalLabel("")).toBe("General");
  });

  it("states the F9 consolidated note from the reason", () => {
    expect(consolidatedNote("needs F9 eliminations")).toBe("Consolidated figures need F9 eliminations");
    expect(consolidatedNote("something else")).toBe("Consolidated figures are not available: something else");
    expect(consolidatedNote(undefined)).toBe("Consolidated figures are not available yet");
  });
});
