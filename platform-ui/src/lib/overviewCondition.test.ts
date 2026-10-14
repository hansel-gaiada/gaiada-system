import { describe, it, expect } from "vitest";
import { lead, me, member } from "./workspaceFixtures";
import { conditionAudience, conditionHref, conditionView, conditionWidgetPlaced } from "./overviewCondition";
import { bannerSentence, conditionLabel, type DeptKpi, type DeptKpisView, type KpiCondition } from "./deptKpiFormat";

const WEB = { deptId: "d-web", unitPath: ["d-web", "root"] };
const HREF = "/appraisals/department?unit=d-web";

const kpi = (over: Partial<DeptKpi> = {}): DeptKpi => ({
  key: "projects-on-time", label: "Projects on time", unit: "percent", direction: "up_good", value: 0.79, target: 0.85, tolerance: 0.05,
  targetSource: "approved", condition: "at_risk", ...over,
});
const noTarget = (key: string): DeptKpi => kpi({ key, label: key, value: null, target: null, tolerance: null, targetSource: "none", condition: "unavailable", reason: "no_target" });
const viewOf = (condition: KpiCondition, kpis: DeptKpi[]): DeptKpisView => ({
  unit: { id: "d-web", name: "Web Dev" }, workspace: "web-dev", period: { periodKind: "month", start: "2026-10-01", end: "2026-10-31" }, condition, kpis,
});
const ok = (v: DeptKpisView) => ({ kind: "ok" as const, data: v });

describe("who sees the banner, the strip or nothing (DW-3k, plan §5.5)", () => {
  it("a head of THIS unit, or of a unit above it, is the head audience", () => {
    expect(conditionAudience(me([member(), lead("d-web")]), "co-a", WEB)).toBe("head");
    expect(conditionAudience(me([member(), lead("root")]), "co-a", WEB)).toBe("head");
  });

  it("staff, a head of another department, a head of a unit inside and a company admin are the staff audience: the strip, never the tiles", () => {
    expect(conditionAudience(me([member()]), "co-a", WEB)).toBe("staff");
    expect(conditionAudience(me([member(), lead("d-seo")]), "co-a", WEB)).toBe("staff");
    expect(conditionAudience(me([member(), lead("dv-fe")]), "co-a", WEB)).toBe("staff");
    expect(conditionAudience(me([{ role: "company_admin", scopeType: "company", scopeId: "co-a" }]), "co-a", WEB)).toBe("staff");
  });

  it("is placed only for a workspace with a department unit; no other key is its business", () => {
    expect(conditionWidgetPlaced("condition", { deptId: "d-web" })).toBe(true);
    expect(conditionWidgetPlaced("condition", { deptId: null })).toBe(false);
    expect(conditionWidgetPlaced("pulse", { deptId: null })).toBe(true);
  });

  it("a head sees the banner with a tile per KPI, in the department KPI page's words", () => {
    const v = viewOf("at_risk", [kpi(), kpi({ key: "uptime", label: "Client site uptime", value: 0.999, target: 0.995, tolerance: 0.005, condition: "on_track" })]);
    const view = conditionView("head", ok(v), HREF);
    if (view.kind !== "banner") throw new Error("expected the banner");
    expect(view.sentence).toBe(bannerSentence(v));
    expect(view.sentence).toBe("Web Dev: at risk · Projects on time 79% against 85%");
    expect(view).toMatchObject({ conditionText: "At risk", tone: "warning", condition: "at_risk", href: HREF });
    expect(view.tiles.map((t) => [t.key, t.value, t.conditionText, t.tone])).toEqual([
      ["projects-on-time", "79%", "At risk", "warning"], ["uptime", "100%", "On track", "ok"],
    ]);
    expect(view.tiles[0].foot).toBe("Target 85% (tolerance 5 pts)");
  });

  it("staff see the strip: the same sentence, one line, and no tiles", () => {
    const v = viewOf("at_risk", [kpi()]);
    const view = conditionView("staff", ok(v), HREF);
    expect(view).toEqual({ kind: "strip", sentence: "Web Dev: at risk · Projects on time 79% against 85%", conditionText: "At risk", tone: "warning", condition: "at_risk" });
    expect("tiles" in view).toBe(false);
    expect("href" in view).toBe(false);
  });

  it("a refused read is nothing at all, for a head and for staff: no No-access box on someone else's department", () => {
    for (const audience of ["head", "staff"] as const) {
      expect(conditionView(audience, { kind: "forbidden" }, HREF)).toEqual({ kind: "none" });
      expect(conditionView(audience, { kind: "not_found" }, HREF)).toEqual({ kind: "none" });
    }
  });
});

describe("the three read states", () => {
  it("ok draws the condition, forbidden draws nothing, a failure says Unavailable and never a condition", () => {
    expect(conditionView("head", ok(viewOf("on_track", [kpi({ condition: "on_track" })])), HREF).kind).toBe("banner");
    expect(conditionView("head", { kind: "forbidden" }, HREF).kind).toBe("none");
    expect(conditionView("head", { kind: "error", reason: "boom" }, HREF)).toEqual({ kind: "unavailable", audience: "head" });
    expect(conditionView("staff", { kind: "error", reason: "boom" }, HREF)).toEqual({ kind: "unavailable", audience: "staff" });
  });
});

describe("the banner sentence for every condition", () => {
  const sentence = (c: KpiCondition, kpis: DeptKpi[]) => {
    const v = conditionView("staff", ok(viewOf(c, kpis)), HREF);
    if (v.kind !== "strip") throw new Error("expected the strip");
    return v.sentence;
  };

  it("at risk and off track name the worst KPI against its target", () => {
    expect(sentence("at_risk", [kpi()])).toBe("Web Dev: at risk · Projects on time 79% against 85%");
    expect(sentence("off_track", [kpi({ value: 0.62, condition: "off_track" })])).toBe("Web Dev: off track · Projects on time 62% against 85%");
  });

  it("on track says only that", () => {
    expect(sentence("on_track", [kpi({ value: 0.9, condition: "on_track" })])).toBe("Web Dev: on track");
  });

  it("unavailable says so and why, never on track: with no approved target, the live state", () => {
    const s = sentence("unavailable", [noTarget("a"), noTarget("b")]);
    expect(s).toBe("Web Dev: condition unavailable · No KPI has an approved target yet");
    expect(s).not.toMatch(/on track/i);
    const view = conditionView("staff", ok(viewOf("unavailable", [noTarget("a")])), HREF);
    expect(view).toMatchObject({ conditionText: "Unavailable", tone: "idle", condition: "unavailable" });
  });

  it("a head's tiles for a department with no target each say why, never a figure or a colour they have not earned", () => {
    const view = conditionView("head", ok(viewOf("unavailable", [noTarget("a")])), HREF);
    if (view.kind !== "banner") throw new Error("expected the banner");
    expect(view.tiles[0]).toMatchObject({ value: "—", conditionText: conditionLabel("unavailable"), tone: "idle", foot: "No target yet" });
  });

  it("a department with no KPIs is a banner with no tiles", () => {
    const view = conditionView("head", ok(viewOf("unavailable", [])), HREF);
    if (view.kind !== "banner") throw new Error("expected the banner");
    expect(view.tiles).toEqual([]);
    expect(view.sentence).toBe("Web Dev: condition unavailable · This department has no KPIs yet");
  });
});

describe("the link to the department KPI page", () => {
  it("opens it for the unit, in the Overview's period", () => {
    expect(conditionHref("d-web", "month", "2026-10-14")).toBe("/appraisals/department?unit=d-web&periodKind=month&start=2026-10-14");
    expect(conditionHref("a/b", "week", "2026-10-14")).toBe("/appraisals/department?unit=a%2Fb&periodKind=week&start=2026-10-14");
  });
});
