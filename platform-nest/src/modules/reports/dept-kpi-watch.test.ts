// DW-4j-1 — the PURE half of the KPI watch (dept-kpi-watch.ts, docs/FRONTEND-BFF-CONTRACT.md §43.4 and §43.5): the change
// rule over every pair of conditions, the notification text and severity (three golden strings), and the decision to
// open and resolve alerts. No DB, no Cerbos. The live half (recipients, the run, idempotence, the alerts read and
// the acknowledgement) is dept-kpi-watch.controller.db.test.ts.
import { describe, it, expect } from "vitest";
import type { KpiCondition } from "./dept-kpis";
import type { KpiRead, UnitKpis } from "./dept-kpi-targets";
import {
  KPI_KEY_DEPARTMENT,
  buildNotice,
  classifyChange,
  conditionWord,
  formatKpiValue,
  kpiChangeLine,
  noticeSeverity,
  planWatch,
  stateKey,
  type ChangeVerdict,
  type OpenAlertRef,
  type PreviousStates,
} from "./dept-kpi-watch";

const REAL: KpiCondition[] = ["on_track", "at_risk", "off_track"];
const ALL: KpiCondition[] = ["on_track", "at_risk", "off_track", "unavailable"];

describe("classifyChange — §43.4, every pair", () => {
  // The whole table, written out: previous (rows) x next (columns). "T" is tell, "s" is store.
  const TABLE: Record<KpiCondition, Record<KpiCondition, ChangeVerdict>> = {
    on_track: { on_track: "store", at_risk: "tell", off_track: "tell", unavailable: "store" },
    at_risk: { on_track: "tell", at_risk: "store", off_track: "tell", unavailable: "store" },
    off_track: { on_track: "tell", at_risk: "tell", off_track: "store", unavailable: "store" },
    unavailable: { on_track: "store", at_risk: "tell", off_track: "tell", unavailable: "store" },
  };

  for (const prev of ALL) {
    for (const next of ALL) {
      it(`${prev} -> ${next} is ${TABLE[prev][next]}`, () => {
        expect(classifyChange(prev, next)).toBe(TABLE[prev][next]);
      });
    }
  }

  it("no previous row stores and tells nothing, whatever the new condition", () => {
    for (const next of ALL) expect(classifyChange(null, next)).toBe("store");
  });

  it("nothing ever tells a move TO unavailable, and only a real condition is ever told", () => {
    for (const prev of [null, ...ALL]) expect(classifyChange(prev, "unavailable")).toBe("store");
    for (const prev of [null, ...ALL]) {
      for (const next of ALL) if (classifyChange(prev, next) === "tell") expect(REAL).toContain(next);
    }
  });
});

describe("the text (§43.4): the labels and the value formatting of the KPI page", () => {
  it("the condition words", () => {
    expect(ALL.map(conditionWord)).toEqual(["on track", "at risk", "off track", "unavailable"]);
  });

  it("formats a value by its unit as platform-ui deptKpiFormat.ts does", () => {
    expect(formatKpiValue(0.71, "percent")).toBe("71%");
    expect(formatKpiValue(4, "count")).toBe("4");
    expect(formatKpiValue(2.5, "count")).toBe("2.5");
    expect(formatKpiValue(45, "minutes")).toBe("45 min");
    expect(formatKpiValue(200, "minutes")).toBe("3h 20m");
    expect(formatKpiValue(64800, "minutes")).toBe("45 d");
    expect(formatKpiValue(null, "percent")).toBe("—");
  });

  // Three golden strings: they are the contract's example and two other units, so a formatter that drifts fails here.
  it("golden line 1: a percent KPI, worse", () => {
    expect(kpiChangeLine("Projects on time", "at_risk", "off_track", 0.71, 0.85, "percent")).toBe(
      "Projects on time: at risk → off track (71% against 85%)",
    );
  });
  it("golden line 2: a count KPI, back to on track", () => {
    expect(kpiChangeLine("Overdue tasks", "off_track", "on_track", 0, 0, "count")).toBe("Overdue tasks: off track → on track (0 against 0)");
  });
  it("golden line 3: a duration KPI, the first real reading of a month", () => {
    expect(kpiChangeLine("Time to hire", "unavailable", "off_track", 64800, 43200, "minutes")).toBe(
      "Time to hire: unavailable → off track (45 d against 30 d)",
    );
  });

  it("a line with no value or no target carries no numbers (never an invented one)", () => {
    expect(kpiChangeLine("Projects on time", "on_track", "at_risk", null, 0.85, "percent")).toBe("Projects on time: on track → at risk");
  });

  it("the notice: title, the KPI lines then the department line, the appraisal link", () => {
    const n = buildNotice(
      "d-web",
      "Web Dev",
      "off_track",
      [
        {
          kpiKey: "projects-on-time",
          label: "Projects on time",
          from: "at_risk",
          to: "off_track",
          line: kpiChangeLine("Projects on time", "at_risk", "off_track", 0.71, 0.85, "percent"),
        },
      ],
      { from: "at_risk", to: "off_track" },
    );
    expect(n.title).toBe("Web Dev: off track");
    expect(n.body).toBe("Projects on time: at risk → off track (71% against 85%)\nDepartment: at risk → off track");
    expect(n.href).toBe("/appraisals/department?unit=d-web");
    expect(n.severity).toBe("critical");
    expect(Object.keys(n).sort()).toEqual(["body", "href", "severity", "title"]); // no entityType, no entityId
  });

  it("the href encodes a node id", () => {
    expect(buildNotice("d web/1", "X", "on_track", [], { from: "at_risk", to: "on_track" }).href).toBe("/appraisals/department?unit=d%20web%2F1");
  });
});

describe("severity (§43.4)", () => {
  it("critical when anything told is now off track", () => {
    expect(noticeSeverity(["at_risk", "off_track"])).toBe("critical");
    expect(noticeSeverity(["off_track"])).toBe("critical");
  });
  it("warning when something told is now at risk and nothing is off track", () => {
    expect(noticeSeverity(["on_track", "at_risk"])).toBe("warning");
  });
  it("info when every change told is an improvement to on track", () => {
    expect(noticeSeverity(["on_track"])).toBe("info");
    expect(noticeSeverity(["on_track", "on_track"])).toBe("info");
  });
});

// ── planWatch: the whole decision for a run ──────────────────────────────────────────────────────

const kpi = (key: string, label: string, condition: KpiCondition, value: number | null = null, target: number | null = null, unit: KpiRead["unit"] = "percent"): KpiRead => ({
  key,
  label,
  unit,
  direction: "up_good",
  value,
  target,
  tolerance: target === null ? null : 0.05,
  targetSource: target === null ? "none" : "approved",
  condition,
  ...(condition === "unavailable" ? { reason: "no_target" as const } : {}),
});
const unitRead = (id: string, name: string, condition: KpiCondition, kpis: KpiRead[]): UnitKpis => ({ unit: { id, name }, workspace: "generic", condition, kpis });
const memory = (rows: Array<[string, string, KpiCondition]>): PreviousStates => new Map(rows.map(([u, k, c]) => [stateKey(u, k), c]));
const openAlert = (id: string, unit: string, key: string): OpenAlertRef => ({ id, unitNodeId: unit, kpiKey: key });

describe("planWatch — what one run does", () => {
  it("a first run (no memory) tells nothing, stores every row, and opens alerts for KPIs already off track", () => {
    const plan = planWatch(
      [unitRead("d-web", "Web Dev", "off_track", [kpi("projects-on-time", "Projects on time", "off_track", 0.5, 0.85), kpi("overdue-tasks", "Overdue tasks", "on_track", 0, 0, "count")])],
      memory([]),
      [],
    );
    expect(plan.notices).toEqual([]);
    expect(plan.upserts.map((u) => [u.unitNodeId, u.kpiKey, u.condition])).toEqual([
      ["d-web", "projects-on-time", "off_track"],
      ["d-web", "overdue-tasks", "on_track"],
      ["d-web", KPI_KEY_DEPARTMENT, "off_track"],
    ]);
    expect(plan.alertsToOpen).toEqual([{ unitNodeId: "d-web", kpiKey: "projects-on-time", value: 0.5, target: 0.85 }]);
    expect(plan.alertsToResolve).toEqual([]);
  });

  it("a KPI that turns off track is told once, with the department line, and opens one alert", () => {
    const plan = planWatch(
      [unitRead("d-web", "Web Dev", "off_track", [kpi("projects-on-time", "Projects on time", "off_track", 0.71, 0.95)])],
      memory([["d-web", "projects-on-time", "at_risk"], ["d-web", KPI_KEY_DEPARTMENT, "at_risk"]]),
      [],
    );
    expect(plan.notices).toHaveLength(1);
    expect(plan.notices[0].changes).toBe(2);
    expect(plan.notices[0].payload.title).toBe("Web Dev: off track");
    expect(plan.notices[0].payload.body).toBe("Projects on time: at risk → off track (71% against 95%)\nDepartment: at risk → off track");
    expect(plan.notices[0].payload.severity).toBe("critical");
    expect(plan.alertsToOpen).toHaveLength(1);
  });

  it("the same state again tells nothing and opens no second alert", () => {
    const plan = planWatch(
      [unitRead("d-web", "Web Dev", "off_track", [kpi("projects-on-time", "Projects on time", "off_track", 0.71, 0.95)])],
      memory([["d-web", "projects-on-time", "off_track"], ["d-web", KPI_KEY_DEPARTMENT, "off_track"]]),
      [openAlert("a1", "d-web", "projects-on-time")],
    );
    expect(plan.notices).toEqual([]);
    expect(plan.alertsToOpen).toEqual([]);
    expect(plan.alertsToResolve).toEqual([]);
  });

  it("back within tolerance is told as an improvement (info) and resolves the alert with the new condition", () => {
    const plan = planWatch(
      [unitRead("d-web", "Web Dev", "on_track", [kpi("projects-on-time", "Projects on time", "on_track", 0.9, 0.85)])],
      memory([["d-web", "projects-on-time", "off_track"], ["d-web", KPI_KEY_DEPARTMENT, "off_track"]]),
      [openAlert("a1", "d-web", "projects-on-time")],
    );
    expect(plan.notices).toHaveLength(1);
    expect(plan.notices[0].payload.severity).toBe("info");
    expect(plan.notices[0].payload.title).toBe("Web Dev: on track");
    expect(plan.alertsToResolve).toEqual([{ id: "a1", unitNodeId: "d-web", kpiKey: "projects-on-time", condition: "on_track" }]);
  });

  it("a KPI that goes unavailable (a new month with no data) is silent, and its alert resolves as unavailable", () => {
    const plan = planWatch(
      [unitRead("d-web", "Web Dev", "unavailable", [kpi("projects-on-time", "Projects on time", "unavailable")])],
      memory([["d-web", "projects-on-time", "off_track"], ["d-web", KPI_KEY_DEPARTMENT, "off_track"]]),
      [openAlert("a1", "d-web", "projects-on-time")],
    );
    expect(plan.notices).toEqual([]);
    expect(plan.alertsToResolve).toEqual([{ id: "a1", unitNodeId: "d-web", kpiKey: "projects-on-time", condition: "unavailable" }]);
  });

  it("the month's first real reading is told when it is at risk or off track, not when it is on track", () => {
    const worse = planWatch(
      [unitRead("d-web", "Web Dev", "at_risk", [kpi("projects-on-time", "Projects on time", "at_risk", 0.82, 0.85)])],
      memory([["d-web", "projects-on-time", "unavailable"], ["d-web", KPI_KEY_DEPARTMENT, "unavailable"]]),
      [],
    );
    expect(worse.notices).toHaveLength(1);
    expect(worse.notices[0].payload.severity).toBe("warning");
    const fine = planWatch(
      [unitRead("d-web", "Web Dev", "on_track", [kpi("projects-on-time", "Projects on time", "on_track", 0.9, 0.85)])],
      memory([["d-web", "projects-on-time", "unavailable"], ["d-web", KPI_KEY_DEPARTMENT, "unavailable"]]),
      [],
    );
    expect(fine.notices).toEqual([]);
  });

  it("a new KPI or a new department (no row yet) is stored silently while the rest of the unit is told", () => {
    const plan = planWatch(
      [unitRead("d-web", "Web Dev", "at_risk", [kpi("projects-on-time", "Projects on time", "at_risk", 0.82, 0.85), kpi("brand-new", "Brand new", "off_track", 0.1, 0.9)])],
      memory([["d-web", "projects-on-time", "on_track"], ["d-web", KPI_KEY_DEPARTMENT, "on_track"]]),
      [],
    );
    expect(plan.notices[0].payload.body).toContain("Projects on time");
    expect(plan.notices[0].payload.body).not.toContain("Brand new");
    expect(plan.alertsToOpen.map((a) => a.kpiKey)).toEqual(["brand-new"]); // an alert is a state: the new KPI is off track now
  });

  it("an open alert whose unit or KPI is no longer evaluated resolves as unavailable", () => {
    const plan = planWatch([], memory([]), [openAlert("a1", "d-gone", "projects-on-time")]);
    expect(plan.alertsToResolve).toEqual([{ id: "a1", unitNodeId: "d-gone", kpiKey: "projects-on-time", condition: "unavailable" }]);
  });

  it("one notice per unit, and a unit with nothing to tell has none", () => {
    const plan = planWatch(
      [
        unitRead("d-a", "A", "at_risk", [kpi("k", "K", "at_risk", 0.8, 0.85)]),
        unitRead("d-b", "B", "on_track", [kpi("k", "K", "on_track", 0.9, 0.85)]),
      ],
      memory([["d-a", "k", "on_track"], ["d-a", KPI_KEY_DEPARTMENT, "on_track"], ["d-b", "k", "on_track"], ["d-b", KPI_KEY_DEPARTMENT, "on_track"]]),
      [],
    );
    expect(plan.notices.map((n) => n.unitNodeId)).toEqual(["d-a"]);
  });

  it("a payload names no person: only the unit, the KPI labels and the numbers", () => {
    const plan = planWatch(
      [unitRead("d-web", "Web Dev", "off_track", [kpi("projects-on-time", "Projects on time", "off_track", 0.5, 0.85)])],
      memory([["d-web", "projects-on-time", "on_track"], ["d-web", KPI_KEY_DEPARTMENT, "on_track"]]),
      [],
    );
    expect(Object.keys(plan.notices[0].payload).sort()).toEqual(["body", "href", "severity", "title"]);
  });
});
