import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  bannerSentence, compareByConditionThenName, conditionLabel, conditionTone, explainDecisionError, formatKpiValue, formatMonth,
  formatTolerance, fromFraction, isMonthStart, monthStartsFrom, nextMonthStart, parseProposal, ratioParts, reasonText, tileFoot,
  toFraction, unavailableWhy, worstKpi, type DeptKpi,
} from "./deptKpis";

// DW-4e-2 — the pure side of lib/deptKpis (types are BFF §40.3a), and the two honest readers run for real against the
// DEMO_MODE fixture (lib/demoDeptKpis.ts), the way lms-readers.test.ts does: a wrong path lands on a catch-all and the
// content assertions fail.

const kpi = (over: Partial<DeptKpi> & Pick<DeptKpi, "key" | "label">): DeptKpi => ({
  unit: "percent", direction: "up_good", value: null, target: null, tolerance: null, targetSource: "none", condition: "unavailable", ...over,
});

describe("formatKpiValue", () => {
  it("shows a percent fraction as a whole percent", () => {
    expect(formatKpiValue(0.79, "percent")).toBe("79%");
    expect(formatKpiValue(0.995, "percent")).toBe("100%");
    expect(formatKpiValue(0, "percent")).toBe("0%");
  });
  it("shows a count, and a duration in minutes, hours and days", () => {
    expect(formatKpiValue(3, "count")).toBe("3");
    expect(formatKpiValue(2.5, "count")).toBe("2.5");
    expect(formatKpiValue(45, "minutes")).toBe("45 min");
    expect(formatKpiValue(200, "minutes")).toBe("3h 20m");
    expect(formatKpiValue(120, "minutes")).toBe("2h");
    expect(formatKpiValue(2880, "minutes")).toBe("2 d");
  });
  it("shows a missing value as a dash, never a zero", () => {
    expect(formatKpiValue(null, "percent")).toBe("—");
    expect(formatKpiValue(undefined, "count")).toBe("—");
    expect(formatKpiValue(Number.NaN, "minutes")).toBe("—");
  });
  it("words a tolerance in points for a percent KPI", () => {
    expect(formatTolerance(0.05, "percent")).toBe("5 pts");
    expect(formatTolerance(3, "count")).toBe("3");
    expect(formatTolerance(null, "percent")).toBe("—");
  });
});

describe("condition wording", () => {
  it("labels the four conditions and maps them to a tone", () => {
    expect(conditionLabel("on_track")).toBe("On track");
    expect(conditionLabel("at_risk")).toBe("At risk");
    expect(conditionLabel("off_track")).toBe("Off track");
    expect(conditionLabel("unavailable")).toBe("Unavailable");
    expect([conditionTone("on_track"), conditionTone("at_risk"), conditionTone("off_track"), conditionTone("unavailable")])
      .toEqual(["ok", "warning", "danger", "idle"]);
  });
  it("says why a KPI has no condition", () => {
    expect(reasonText("no_target")).toBe("No target yet");
    expect(reasonText("no_reader")).toBe("Not measured yet");
    expect(reasonText("no_data")).toBe("No data this period");
    expect(reasonText("read_failed")).toBe("Couldn't be read right now");
    expect(reasonText(undefined)).toBe("");
  });
});

describe("bannerSentence", () => {
  const web = { id: "dept-1", name: "Web Dev" };
  it("names the worst KPI of an at-risk department", () => {
    const kpis = [
      kpi({ key: "a", label: "Projects on time", value: 0.81, target: 0.85, tolerance: 0.05, condition: "at_risk", targetSource: "approved" }),
      kpi({ key: "b", label: "Reopened work rate", direction: "down_good", value: 0.04, target: 0.05, tolerance: 0.03, condition: "on_track", targetSource: "approved" }),
      kpi({ key: "c", label: "Uptime", reason: "no_reader" }),
    ];
    expect(bannerSentence({ unit: web, condition: "at_risk", kpis })).toBe("Web Dev: at risk · Projects on time 81% against 85%");
  });
  it("picks the off-track KPI over an at-risk one, and the larger shortfall among equals", () => {
    const a = kpi({ key: "a", label: "A", value: 0.8, target: 0.85, tolerance: 0.1, condition: "at_risk", targetSource: "approved" });
    const b = kpi({ key: "b", label: "B", value: 0.7, target: 0.85, tolerance: 0.1, condition: "at_risk", targetSource: "approved" });
    const c = kpi({ key: "c", label: "C", value: 0.1, target: 0.85, tolerance: 0.05, condition: "off_track", targetSource: "approved" });
    expect(worstKpi([a, b])!.key).toBe("b");
    expect(worstKpi([a, b, c])!.key).toBe("c");
    expect(bannerSentence({ unit: web, condition: "off_track", kpis: [a, b, c] })).toBe("Web Dev: off track · C 10% against 85%");
  });
  it("uses the shortfall in the right direction for a down-good KPI", () => {
    const a = kpi({ key: "a", label: "Reopens", direction: "down_good", value: 0.12, target: 0.05, tolerance: 0.1, condition: "at_risk", targetSource: "approved" });
    const b = kpi({ key: "b", label: "Overdue", unit: "count", direction: "down_good", value: 5, target: 0, tolerance: 6, condition: "at_risk", targetSource: "approved" });
    expect(worstKpi([a, b])!.key).toBe("b");
  });
  it("says only 'on track' for an on-track department", () => {
    const k = kpi({ key: "a", label: "A", value: 0.9, target: 0.85, tolerance: 0.05, condition: "on_track", targetSource: "approved" });
    expect(bannerSentence({ unit: web, condition: "on_track", kpis: [k] })).toBe("Web Dev: on track");
  });
  it("says why when the condition is unavailable", () => {
    expect(bannerSentence({ unit: web, condition: "unavailable", kpis: [kpi({ key: "a", label: "A", value: 0.9, reason: "no_target" })] }))
      .toBe("Web Dev: condition unavailable · No KPI has an approved target yet");
    expect(bannerSentence({ unit: web, condition: "unavailable", kpis: [kpi({ key: "a", label: "A", reason: "no_reader" })] }))
      .toBe("Web Dev: condition unavailable · None of its KPIs is measured yet");
    expect(unavailableWhy([kpi({ key: "a", label: "A", reason: "no_data" })])).toBe("No data this period");
    expect(unavailableWhy([kpi({ key: "a", label: "A", reason: "read_failed" })])).toBe("Some KPIs could not be read right now");
    expect(unavailableWhy([])).toBe("This department has no KPIs yet");
  });
});

describe("tile text", () => {
  it("shows the target and tolerance, or the reason", () => {
    expect(tileFoot(kpi({ key: "a", label: "A", value: 0.8, target: 0.85, tolerance: 0.05 }))).toBe("Target 85% (tolerance 5 pts)");
    expect(tileFoot(kpi({ key: "a", label: "A", value: 0.8, reason: "no_target" }))).toBe("No target yet");
    expect(tileFoot(kpi({ key: "a", label: "A", reason: "no_reader" }))).toBe("Not measured yet");
  });
  it("shows a ratio's parts", () => {
    expect(ratioParts(kpi({ key: "a", label: "A", numerator: 17, denominator: 21 }))).toBe("17 of 21");
    expect(ratioParts(kpi({ key: "a", label: "A" }))).toBeNull();
  });
});

describe("overview order", () => {
  it("sorts worst first, unavailable last, then by name then id", () => {
    const row = (id: string, name: string, condition: DeptKpi["condition"]) => ({ condition, unit: { id, name } });
    const sorted = [
      row("d4", "Social Media", "unavailable"), row("d3", "SEO", "on_track"), row("d1", "Web Dev", "at_risk"),
      row("d5", "GM", "on_track"), row("d2", "Creatives", "off_track"),
    ].sort(compareByConditionThenName);
    expect(sorted.map((r) => r.unit.name)).toEqual(["Creatives", "Web Dev", "GM", "SEO", "Social Media"]);
  });
});

describe("target form helpers", () => {
  it("moves a percent between the whole-percent UI and the fraction on the wire", () => {
    expect(toFraction("percent", 85)).toBe(0.85);
    expect(toFraction("percent", 99.5)).toBe(0.995);
    expect(fromFraction("percent", 0.85)).toBe(85);
    expect(fromFraction("percent", 0.995)).toBe(99.5);
    expect(toFraction("count", 3)).toBe(3);
    expect(fromFraction("minutes", 2880)).toBe(2880);
  });
  it("finds month starts", () => {
    expect(isMonthStart("2026-11-01")).toBe(true);
    expect(isMonthStart("2026-11-02")).toBe(false);
    expect(isMonthStart("2026-13-01")).toBe(false);
    expect(nextMonthStart("2026-10-14")).toBe("2026-11-01");
    expect(nextMonthStart("2026-12-31")).toBe("2027-01-01");
    expect(monthStartsFrom("2026-10-01", 3)).toEqual(["2026-11-01", "2026-12-01", "2027-01-01"]);
    expect(formatMonth("2026-11-01")).toBe("November 2026");
  });
  const raw = { unitNodeId: "dept-1", kpiKey: "projects-on-time", effectiveFrom: "2026-11-01", target: "85", tolerance: "5" };
  it("sends a percent proposal as fractions", () => {
    expect(parseProposal("percent", { ...raw, note: "  from the new rota " })).toEqual({
      ok: true, body: { unitNodeId: "dept-1", kpiKey: "projects-on-time", effectiveFrom: "2026-11-01", target: 0.85, tolerance: 0.05, note: "from the new rota" },
    });
    const noNote = parseProposal("percent", raw);
    expect(noNote.ok && "note" in noNote.body).toBe(false);
  });
  it("refuses what the server would refuse, naming the field", () => {
    expect(parseProposal("percent", { ...raw, target: "" })).toMatchObject({ ok: false, field: "target" });
    expect(parseProposal("percent", { ...raw, target: "150" })).toMatchObject({ ok: false, field: "target" });
    expect(parseProposal("percent", { ...raw, tolerance: "-1" })).toMatchObject({ ok: false, field: "tolerance" });
    expect(parseProposal("percent", { ...raw, effectiveFrom: "2026-11-15" })).toMatchObject({ ok: false, field: "effectiveFrom" });
    expect(parseProposal("count", { ...raw, target: "-2" })).toMatchObject({ ok: false, field: "target" });
  });
  it("accepts a count target above 100", () => {
    expect(parseProposal("count", { ...raw, target: "250", tolerance: "10" })).toMatchObject({ ok: true, body: { target: 250, tolerance: 10 } });
  });
  it("words the two machine codes and passes any other message through verbatim", () => {
    expect(explainDecisionError("cannot_approve_own_proposal")).toMatch(/someone else/);
    expect(explainDecisionError("not_proposed")).toMatch(/already decided/);
    expect(explainDecisionError("outside your reporting line")).toBe("outside your reporting line");
  });
});

describe("honest readers (against the demo fixture)", () => {
  const prev = process.env.DEMO_MODE;
  beforeAll(() => { process.env.DEMO_MODE = "1"; });
  afterAll(() => { process.env.DEMO_MODE = prev; });
  beforeEach(async () => { (await import("./demoDeptKpis")).resetDeptKpiDemo(); });

  const T = "co-agency";
  const Q = { periodKind: "month", start: "2026-10-14" };

  it("getDeptKpis returns the unit's real tiles", async () => {
    const { getDeptKpis } = await import("./deptKpis");
    const res = await getDeptKpis("demo-hansel", T, { unit: "dept-1", ...Q });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.data.unit.name).toBe("Web Dev");
    expect(res.data.condition).toBe("at_risk");
    expect(res.data.kpis.map((k) => k.key)).toEqual(["projects-on-time", "requests-within-sla", "client-site-uptime", "reopened-work-rate"]);
  });

  it("maps a refusal, a missing unit and a bad range to three different answers, never an empty list", async () => {
    const { getDeptKpis, getDeptKpiTargets } = await import("./deptKpis");
    expect(await getDeptKpis("seo-staff", T, { unit: "dept-1", ...Q })).toEqual({ kind: "forbidden" });
    expect(await getDeptKpis("demo-hansel", T, { unit: "dept-99", ...Q })).toEqual({ kind: "not_found" });
    expect(await getDeptKpiTargets("u-dev", T, "dept-3")).toEqual({ kind: "forbidden" });
    expect(await getDeptKpiTargets("demo-hansel", T, "dept-99")).toEqual({ kind: "not_found" });
  });

  it("getDeptKpiTargets returns the in-force target and the open proposal", async () => {
    const { getDeptKpiTargets } = await import("./deptKpis");
    const res = await getDeptKpiTargets("demo-hansel", T, "dept-1");
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    const on = res.data.kpis.find((k) => k.key === "projects-on-time")!;
    expect(on.inForce).toMatchObject({ target: 0.85, tolerance: 0.05, status: "approved" });
    const sla = res.data.kpis.find((k) => k.key === "requests-within-sla")!;
    expect(sla.inForce).toBeNull();
    expect(sla.proposals).toHaveLength(1);
  });
});
