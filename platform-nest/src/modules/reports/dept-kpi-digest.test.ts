// DW-4j-3 — the PURE half of the weekly digest and of "behind the miss" (dept-kpi-digest.ts, dept-kpi-drivers.ts,
// docs/FRONTEND-BFF-CONTRACT.md §43.8): the week arithmetic, the digest text (golden lines), the severity, and the driver
// selection and ordering. No DB, no Cerbos. The live half (the ledger, recipients, concurrency, the routes and the gate) is
// dept-kpi-digest.controller.db.test.ts.
import { describe, it, expect } from "vitest";
import type { BadRequestException } from "@nestjs/common";
import type { RollupRow } from "../contract";
import type { DeptKpiDef, KpiCondition, UnavailableReason } from "./dept-kpis";
import { DEPT_KPI_SETS } from "./dept-kpis";
import type { KpiRead, UnitKpis } from "./dept-kpi-targets";
import { todayIsoInTz } from "./person-scope";
import {
  buildDigestNotice,
  changeNote,
  digestHref,
  digestKpiLine,
  digestSeverity,
  lastCompleteWeekStart,
  resolveDigestWeek,
  unavailableSummary,
} from "./dept-kpi-digest";
import { MAX_DRIVERS, driverRows, noDriversReason, topDrivers, type DriverRow } from "./dept-kpi-drivers";

const UP = "▲";
const DOWN = "▼";
const DOT = "·";

/** The `field` of the 400 a call throws (or fails the test when it does not throw a 400). */
function badField(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    const res = (e as BadRequestException).getResponse() as { field?: string };
    return res.field;
  }
  throw new Error("expected a 400");
}

describe("the week (§43.8): the last COMPLETE ISO week in REPORTS_TZ", () => {
  // 2026-10-05 is a Monday, 2026-10-11 a Sunday, 2026-10-12 a Monday.
  it("a Monday morning: the week that ended yesterday", () => {
    expect(lastCompleteWeekStart("2026-10-12")).toBe("2026-10-05");
  });

  it("a Sunday night: this week is not over yet, so still the week before", () => {
    expect(lastCompleteWeekStart("2026-10-11")).toBe("2026-09-28");
  });

  it("midweek: the week before this one", () => {
    expect(lastCompleteWeekStart("2026-10-13")).toBe("2026-10-05");
    expect(lastCompleteWeekStart("2026-10-14")).toBe("2026-10-05");
  });

  it("crosses a month and a year boundary", () => {
    expect(lastCompleteWeekStart("2026-01-01")).toBe("2025-12-22");
    expect(lastCompleteWeekStart("2026-03-02")).toBe("2026-02-23");
  });

  it("is read in REPORTS_TZ: the same instant is a Sunday night in UTC and a Monday morning in Makassar", () => {
    const instant = new Date("2026-10-11T17:00:00Z");
    expect(lastCompleteWeekStart(todayIsoInTz("UTC", instant))).toBe("2026-09-28");
    expect(lastCompleteWeekStart(todayIsoInTz("Asia/Makassar", instant))).toBe("2026-10-05");
  });

  it("the default and an explicit last complete week resolve to a Monday to Sunday pair", () => {
    expect(resolveDigestWeek(undefined, "2026-10-14")).toEqual({ weekStart: "2026-10-05", weekEnd: "2026-10-11" });
    expect(resolveDigestWeek(null, "2026-10-14")).toEqual({ weekStart: "2026-10-05", weekEnd: "2026-10-11" });
    expect(resolveDigestWeek("2026-10-05", "2026-10-14")).toEqual({ weekStart: "2026-10-05", weekEnd: "2026-10-11" });
    expect(resolveDigestWeek("2026-10-05", "2026-10-12")).toEqual({ weekStart: "2026-10-05", weekEnd: "2026-10-11" }); // Monday morning
  });

  it("an older complete Monday is fine", () => {
    expect(resolveDigestWeek("2026-09-28", "2026-10-14")).toEqual({ weekStart: "2026-09-28", weekEnd: "2026-10-04" });
    expect(resolveDigestWeek("2025-12-29", "2026-10-14")).toEqual({ weekStart: "2025-12-29", weekEnd: "2026-01-04" });
  });

  it("a non-Monday is a 400 on weekStart", () => {
    for (const d of ["2026-10-06", "2026-10-04", "2026-10-11", "2026-10-07"]) expect(badField(() => resolveDigestWeek(d, "2026-10-14"))).toBe("weekStart");
  });

  it("the current week and any future week are a 400 on weekStart", () => {
    expect(badField(() => resolveDigestWeek("2026-10-12", "2026-10-14"))).toBe("weekStart"); // this week, not over
    expect(badField(() => resolveDigestWeek("2026-10-12", "2026-10-12"))).toBe("weekStart"); // it has only begun
    expect(badField(() => resolveDigestWeek("2026-10-19", "2026-10-14"))).toBe("weekStart");
    expect(badField(() => resolveDigestWeek("2027-01-04", "2026-10-14"))).toBe("weekStart");
  });

  it("anything that is not a real date written YYYY-MM-DD is a 400 on weekStart", () => {
    for (const v of ["", "garbage", "2026-02-30", "2026-13-01", "2026-9-28", "20260928", " 2026-09-28", 20260928, {}, []]) {
      expect(badField(() => resolveDigestWeek(v, "2026-10-14"))).toBe("weekStart");
    }
  });
});

describe("the text (§43.8): the change against the week before", () => {
  it("a percent moves in whole points, between the two whole percents the head reads", () => {
    expect(changeNote(0.71, 0.77, "percent")).toBe(`${DOWN} 6 pts from the week before`);
    expect(changeNote(0.8, 0.75, "percent")).toBe(`${UP} 5 pts from the week before`);
    expect(changeNote(0.714, 0.7142, "percent")).toBe("no change from the week before"); // equal once shown
    expect(changeNote(0.5, 0.5, "percent")).toBe("no change from the week before");
  });

  it("a count moves in the KPI's own unit", () => {
    expect(changeNote(5, 3.5, "count")).toBe(`${UP} 1.5 from the week before`);
    expect(changeNote(2, 7, "count")).toBe(`${DOWN} 5 from the week before`);
    expect(changeNote(4, 4, "count")).toBe("no change from the week before");
    expect(changeNote(4.001, 4, "count")).toBe("no change from the week before");
  });

  it("a duration moves in the KPI's own unit, formatted as the value is", () => {
    expect(changeNote(1440, 1640, "minutes")).toBe(`${DOWN} 3h 20m from the week before`);
    expect(changeNote(4320, 2880, "minutes")).toBe(`${UP} 1 d from the week before`);
    expect(changeNote(90, 90.2, "minutes")).toBe("no change from the week before");
  });

  it("no value the week before says so", () => {
    for (const unit of ["percent", "count", "minutes"] as const) {
      expect(changeNote(0.5, null, unit)).toBe("no data the week before");
      expect(changeNote(0.5, undefined, unit)).toBe("no data the week before");
    }
  });
});

function read(over: Partial<KpiRead> & Pick<KpiRead, "key" | "label" | "condition">): KpiRead {
  return {
    unit: "percent",
    direction: "up_good",
    value: null,
    target: null,
    tolerance: null,
    targetSource: "none",
    ...over,
  };
}
const unavailable = (key: string, reason: UnavailableReason, label = key): KpiRead => read({ key, label, condition: "unavailable", reason });

describe("the text (§43.8): the lines", () => {
  it("a percent that fell: the contract's golden line", () => {
    const k = read({ key: "projects-on-time", label: "Projects on time", value: 0.71, target: 0.85, tolerance: 0.05, targetSource: "approved", condition: "at_risk" });
    expect(digestKpiLine(k, 0.77)).toBe(`Projects on time: 71% against 85% ${DOT} at risk (${DOWN} 6 pts from the week before)`);
  });

  it("a percent that rose, no change, and no data the week before", () => {
    const k = read({ key: "a", label: "Projects on time", value: 0.9, target: 0.85, targetSource: "approved", condition: "on_track" });
    expect(digestKpiLine(k, 0.84)).toBe(`Projects on time: 90% against 85% ${DOT} on track (${UP} 6 pts from the week before)`);
    expect(digestKpiLine(k, 0.9)).toBe(`Projects on time: 90% against 85% ${DOT} on track (no change from the week before)`);
    expect(digestKpiLine(k, null)).toBe(`Projects on time: 90% against 85% ${DOT} on track (no data the week before)`);
  });

  it("a count and a duration", () => {
    const count = read({ key: "overdue-tasks", label: "Overdue tasks", unit: "count", direction: "down_good", value: 7, target: 0, targetSource: "approved", condition: "off_track" });
    expect(digestKpiLine(count, 5)).toBe(`Overdue tasks: 7 against 0 ${DOT} off track (${UP} 2 from the week before)`);
    const mins = read({ key: "t", label: "Client approval turnaround", unit: "minutes", direction: "down_good", value: 4320, target: 2880, targetSource: "approved", condition: "at_risk" });
    expect(digestKpiLine(mins, 5760)).toBe(`Client approval turnaround: 3 d against 2 d ${DOT} at risk (${DOWN} 1 d from the week before)`);
  });

  it("a KPI with no condition has no line of its own", () => {
    expect(digestKpiLine(unavailable("x", "no_reader"), 0.5)).toBeNull();
    expect(digestKpiLine(unavailable("x", "no_data"), 0.5)).toBeNull();
    expect(digestKpiLine(unavailable("x", "no_target"), 0.5)).toBeNull();
  });

  it("the unavailable KPIs are summed up in ONE line, only the non-zero kinds", () => {
    const four = [1, 2, 3, 4].map((i) => unavailable(`m${i}`, "no_reader"));
    expect(unavailableSummary(four)).toBe("4 KPIs not measured yet");
    expect(unavailableSummary([...four, unavailable("t1", "no_target"), unavailable("t2", "no_target"), unavailable("d", "no_data")])).toBe(
      "4 KPIs not measured yet; 2 KPIs have no target; 1 KPI has no data",
    );
    expect(unavailableSummary([unavailable("m", "no_reader")])).toBe("1 KPI not measured yet");
    expect(unavailableSummary([unavailable("t", "no_target")])).toBe("1 KPI has no target");
    expect(unavailableSummary([unavailable("a", "no_data"), unavailable("b", "no_data"), unavailable("c", "no_data")])).toBe("3 KPIs have no data");
    expect(unavailableSummary([read({ key: "ok", label: "Ok", value: 1, target: 1, condition: "on_track" })])).toBeNull();
    expect(unavailableSummary([])).toBeNull();
    // a reason this code does not know is counted in its own words, never dropped and never a crash
    const odd = { condition: "unavailable", reason: "read_failed" } as unknown as KpiRead;
    expect(unavailableSummary([odd])).toBe("1 KPI could not be read");
    expect(unavailableSummary([odd, odd, unavailable("m", "no_reader")])).toBe("1 KPI not measured yet; 2 KPIs could not be read");
  });
});

describe("the notice (§43.8): title, body, href, severity", () => {
  const unit = { id: "d-web", name: "Web Dev" };
  const web = (kpis: KpiRead[], condition: KpiCondition): UnitKpis => ({ unit, workspace: "web-dev", condition, kpis });

  const thisWeek = web(
    [
      read({ key: "projects-on-time", label: "Projects on time", value: 0.79, target: 0.85, tolerance: 0.05, targetSource: "approved", condition: "at_risk" }),
      unavailable("requests-within-sla", "no_reader", "Requests delivered by the date needed"),
      unavailable("client-site-uptime", "no_reader", "Client site uptime"),
      read({ key: "reopened-work-rate", label: "Reopened work rate", direction: "down_good", value: 0.03, target: 0.05, tolerance: 0.03, targetSource: "approved", condition: "on_track" }),
    ],
    "at_risk",
  );
  const weekBefore = web(
    [
      read({ key: "projects-on-time", label: "Projects on time", value: 0.85, target: 0.85, targetSource: "approved", condition: "on_track" }),
      unavailable("requests-within-sla", "no_reader"),
      unavailable("client-site-uptime", "no_reader"),
      read({ key: "reopened-work-rate", label: "Reopened work rate", direction: "down_good", value: null, condition: "unavailable", reason: "no_data" }),
    ],
    "on_track",
  );

  it("the golden notice", () => {
    expect(buildDigestNotice(thisWeek, weekBefore, "2026-10-05")).toEqual({
      title: "Web Dev this week: at risk",
      body: [
        `Projects on time: 79% against 85% ${DOT} at risk (${DOWN} 6 pts from the week before)`,
        `Reopened work rate: 3% against 5% ${DOT} on track (no data the week before)`,
        "2 KPIs not measured yet",
      ].join("\n"),
      href: "/appraisals/department?unit=d-web&periodKind=week&start=2026-10-05",
      severity: "warning",
    });
  });

  it("a department not evaluated the week before says 'no data the week before' on every line", () => {
    const body = buildDigestNotice(thisWeek, undefined, "2026-10-05").body.split("\n");
    expect(body[0]).toBe(`Projects on time: 79% against 85% ${DOT} at risk (no data the week before)`);
    expect(body[1]).toBe(`Reopened work rate: 3% against 5% ${DOT} on track (no data the week before)`);
  });

  it("a department with nothing measured still gets its notice: the title says unavailable, the body is the one summing-up line", () => {
    const empty = web([unavailable("a", "no_reader"), unavailable("b", "no_target"), unavailable("c", "no_data")], "unavailable");
    expect(buildDigestNotice(empty, undefined, "2026-10-05")).toEqual({
      title: "Web Dev this week: unavailable",
      body: "1 KPI not measured yet; 1 KPI has no target; 1 KPI has no data",
      href: "/appraisals/department?unit=d-web&periodKind=week&start=2026-10-05",
      severity: "info",
    });
  });

  it("the payload is exactly {title, body, href, severity}: no entityType, no person", () => {
    expect(Object.keys(buildDigestNotice(thisWeek, weekBefore, "2026-10-05")).sort()).toEqual(["body", "href", "severity", "title"]);
  });

  it("the severity follows the department's condition that week", () => {
    expect(digestSeverity("off_track")).toBe("critical");
    expect(digestSeverity("at_risk")).toBe("warning");
    expect(digestSeverity("on_track")).toBe("info");
    expect(digestSeverity("unavailable")).toBe("info");
  });

  it("the href opens the unit's appraisal page on that week, the unit id encoded", () => {
    expect(digestHref("d-web", "2026-10-05")).toBe("/appraisals/department?unit=d-web&periodKind=week&start=2026-10-05");
    expect(digestHref("d web/1", "2026-10-05")).toBe("/appraisals/department?unit=d%20web%2F1&periodKind=week&start=2026-10-05");
  });
});

describe("behind the miss (§43.8): which KPIs have drivers", () => {
  const defOf = (slug: keyof typeof DEPT_KPI_SETS, key: string): DeptKpiDef => DEPT_KPI_SETS[slug].find((d) => d.key === key)!;

  it("the four department-grain report-fact KPIs have drivers to look for", () => {
    expect(noDriversReason(defOf("web-dev", "projects-on-time"))).toBeNull();
    expect(noDriversReason(defOf("web-dev", "reopened-work-rate"))).toBeNull();
    expect(noDriversReason(defOf("generic", "overdue-tasks"))).toBeNull();
    expect(noDriversReason(defOf("generic", "check-in-compliance"))).toBeNull();
  });

  it("a module KPI without a reader has no reader; one with a reader, the company-grain and the derived KPIs have no drivers", () => {
    // Web Dev's client site uptime has a reader since DW-6n (06db3f0b); HR's payroll has one since DW-7j f4, IT's uptime since f10, the GM's revenue against plan since f1.
    expect(noDriversReason(defOf("web-dev", "client-site-uptime"))).toBe("no_drivers");
    expect(noDriversReason(defOf("hr", "payroll-on-time"))).toBe("no_drivers");
    expect(noDriversReason(defOf("it", "uptime"))).toBe("no_drivers");
    expect(noDriversReason(defOf("gm", "revenue-vs-plan"))).toBe("no_drivers");
    // DW-7j f1 was the last: every module KPI in the catalogue now names a reader, so none is `no_reader` any more
    // (a module KPI without a readerId still is, which is pinned just below and in dept-kpis.test.ts).
    const noReader = Object.entries(DEPT_KPI_SETS).flatMap(([slug, defs]) => defs.filter((d) => noDriversReason(d) === "no_reader").map((d) => `${slug}/${d.key}`));
    expect(noReader).toEqual([]);
    expect(noDriversReason({ reader: { kind: "module" } as unknown as DeptKpiDef["reader"] })).toBe("no_reader");
    // a module KPI that has a reader of its own has a value but no drivers
    expect(noDriversReason({ reader: { kind: "module", readerId: "x" } as unknown as DeptKpiDef["reader"] })).toBe("no_drivers");
    expect(noDriversReason(defOf("gm", "utilization"))).toBe("no_drivers");
    expect(noDriversReason(defOf("gm", "departments-in-good-condition"))).toBe("no_drivers");
  });
});

const person = (id: string, name: string, value: number): DriverRow => ({ kind: "person", id, name, value });

describe("behind the miss (§43.8): worst first, at most five", () => {
  it("an up-is-good KPI lists the lowest first", () => {
    const rows = [person("c", "Cara", 0.9), person("a", "Ayu", 0.4), person("b", "Budi", 0.7)];
    expect(topDrivers(rows, "up_good").map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("a down-is-good KPI lists the highest first", () => {
    const rows = [person("c", "Cara", 3), person("a", "Ayu", 9), person("b", "Budi", 5)];
    expect(topDrivers(rows, "down_good").map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("ties break by name, then by id", () => {
    const rows = [person("z", "Budi", 0.5), person("y", "Ayu", 0.5), person("b", "Budi", 0.5), person("x", "Cara", 0.2)];
    expect(topDrivers(rows, "up_good").map((r) => r.id)).toEqual(["x", "y", "b", "z"]);
    expect(topDrivers(rows, "down_good").map((r) => r.id)).toEqual(["y", "b", "z", "x"]);
  });

  it("at most five, and the input is not mutated", () => {
    const rows = Array.from({ length: 9 }, (_, i) => person(`p${i}`, `Person ${i}`, i / 10));
    const before = JSON.stringify(rows);
    const top = topDrivers(rows, "up_good");
    expect(top).toHaveLength(MAX_DRIVERS);
    expect(top.map((r) => r.id)).toEqual(["p0", "p1", "p2", "p3", "p4"]);
    expect(JSON.stringify(rows)).toBe(before);
    expect(topDrivers([], "up_good")).toEqual([]);
  });
});

describe("behind the miss (§43.8): which rows are a driver", () => {
  const row = (metricKey: string, dimensions: Record<string, unknown>, numerator: number, denominator?: number): RollupRow => ({ metricKey, numerator, denominator, dimensions });
  const names = new Map([
    ["u1", "Ayu"],
    ["u2", "Budi"],
    ["p1", "Alpha"],
    ["p2", "Beta"],
  ]);

  it("projects on time: project rows of the unit's projects with a missed milestone, with their numbers", () => {
    const rows = [
      row("delivery.milestone_hit_rate", { projectId: "p1" }, 1, 4), // missed 3 of 4
      row("delivery.milestone_hit_rate", { projectId: "p2" }, 3, 3), // every milestone hit: not behind the miss
      row("delivery.milestone_hit_rate", { projectId: "p9" }, 0, 2), // another department's project
      row("delivery.milestone_hit_rate", { unit: "d-web" }, 4, 7), // the department's own row
      row("delivery.milestone_hit_rate", {}, 4, 9), // the company's
    ];
    expect(driverRows("delivery.milestone_hit_rate", rows, new Set(["p1", "p2"]), names)).toEqual([
      { kind: "project", id: "p1", name: "Alpha", value: 0.25, numerator: 1, denominator: 4 },
    ]);
  });

  it("reopened work: people of the roster with a reopen and data; a rate of 0 or a 0 denominator is not a driver", () => {
    const rows = [
      row("flow.reopen_rate", { userId: "u1" }, 2, 8),
      row("flow.reopen_rate", { userId: "u2" }, 0, 5), // no reopen: no miss
      row("flow.reopen_rate", { userId: "u3" }, 1, 4), // not on the roster
      row("flow.reopen_rate", { userId: "u4" }, 0, 0), // nothing completed: no data
      row("flow.reopen_rate", { projectId: "p1" }, 5, 5), // a project row is never a person
    ];
    expect(driverRows("flow.reopen_rate", rows, new Set(["u1", "u2", "u4"]), names)).toEqual([
      { kind: "person", id: "u1", name: "Ayu", value: 0.25, numerator: 2, denominator: 8 },
    ]);
  });

  it("overdue tasks: a count, no denominator; a person with none has no row", () => {
    const rows = [row("discipline.overdue_open", { userId: "u1" }, 3), row("discipline.overdue_open", { userId: "u2" }, 0), row("discipline.overdue_open", { unit: "d-web" }, 3)];
    expect(driverRows("discipline.overdue_open", rows, new Set(["u1", "u2"]), names)).toEqual([{ kind: "person", id: "u1", name: "Ayu", value: 3 }]);
  });

  it("check-in compliance: below full compliance with expected days; full compliance and no expected days are not drivers", () => {
    const rows = [
      row("discipline.checkin_compliance", { userId: "u1" }, 3, 5),
      row("discipline.checkin_compliance", { userId: "u2" }, 5, 5), // full
      row("discipline.checkin_compliance", { userId: "u3" }, 0, 0), // no expected day: no data
    ];
    expect(driverRows("discipline.checkin_compliance", rows, new Set(["u1", "u2", "u3"]), names)).toEqual([
      { kind: "person", id: "u1", name: "Ayu", value: 0.6, numerator: 3, denominator: 5 },
    ]);
  });

  it("a name that cannot be resolved reads as the id; an unknown metric has no drivers", () => {
    expect(driverRows("discipline.overdue_open", [row("discipline.overdue_open", { userId: "u7" }, 1)], new Set(["u7"]), new Map())).toEqual([
      { kind: "person", id: "u7", name: "u7", value: 1 },
    ]);
    expect(driverRows("effort.capacity_utilization", [row("effort.capacity_utilization", { userId: "u1" }, 1, 2)], new Set(["u1"]), names)).toEqual([]);
  });
});
