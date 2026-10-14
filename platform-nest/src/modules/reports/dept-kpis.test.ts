// DW-4e-1 — the PURE half of department KPIs (dept-kpis.ts): the catalogue and its parity with the UI registry, the
// workspace slug golden table, the condition engine at every boundary, and the value rules. No DB, no Cerbos.
// The live half (targets, authorization, reads over HTTP) is dept-kpis.controller.db.test.ts.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONDITION_RANK,
  DEPT_KPI_SETS,
  WORKSPACE_SLUGS,
  compareByConditionThenName,
  departmentCondition,
  departmentUnits,
  departmentsInGoodCondition,
  deptSlug,
  findOrgUnit,
  kpiCondition,
  kpiDefFor,
  reportFactValue,
  windowHasNoFacts,
  workspaceSlugFor,
  type DeptKpiDef,
  type KpiCondition,
  type UnavailableReason,
} from "./dept-kpis";
import { REPORT_METRICS } from "./metrics";
import type { ReportDocument, ReportKpi } from "./report-document";

const REPO_ROOT = join(__dirname, "../../../..");
const UI_WORKSPACES = join(REPO_ROOT, "platform-ui/src/lib/workspaces.ts");
const UI_GOLDEN_TWIN = join(REPO_ROOT, "platform-ui/src/lib/dept-workspace-slugs.test.ts");
const THIS_FILE = join(__dirname, "dept-kpis.test.ts");

// ═══════════════════════════════ the slug golden table ═══════════════════════════════
// TWIN: platform-ui/src/lib/dept-workspace-slugs.test.ts holds the SAME block, byte for byte, and checks it against
// the UI's `workspaceFor`; this file checks it against the server's `workspaceSlugFor`. Each test also compares the
// two blocks' text, so editing one side alone fails both suites.
// <golden:dept-workspace-slugs>
const GOLDEN: ReadonlyArray<readonly [string | null, string, string]> = [
  ["agency", "Web Dev", "web-dev"],
  ["agency", "SEO", "seo"],
  ["agency", "Social Media", "social-media"],
  ["agency", "Creatives", "creatives"],
  ["agency", "GM", "gm"],
  ["agency", "Office of the GM", "generic"],
  ["agency", "HR", "hr"],
  ["agency", "Finance", "finance"],
  ["agency", "IT", "it"],
  ["agency", "Human Resources", "generic"],
  ["agency", "Sales", "generic"],
  ["agency", "  Web   Dev!! ", "web-dev"],
  ["holding", "Web Dev", "generic"],
  ["holding", "HR", "hr"],
  ["general", "Finance", "finance"],
  ["hospitality", "Front Office", "generic"],
  ["catering", "IT", "it"],
  ["unknown-vertical", "SEO", "generic"],
  [null, "Creatives", "generic"],
  [null, "it", "it"],
];
// </golden:dept-workspace-slugs>

function goldenBlock(file: string): string {
  const m = /\/\/ <golden:dept-workspace-slugs>\n([\s\S]*?)\n\/\/ <\/golden:dept-workspace-slugs>/.exec(readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
  if (!m) throw new Error(`no golden block in ${file}`);
  return m[1];
}

describe("DW-4e-1 · workspace slug resolution (the server twin of workspaceFor)", () => {
  it("the golden block is byte-identical to its platform-ui twin", () => {
    const mine = goldenBlock(THIS_FILE);
    expect(mine.split("\n").length).toBeGreaterThan(15);
    expect(goldenBlock(UI_GOLDEN_TWIN)).toBe(mine);
  });

  it.each(GOLDEN.map((row) => [...row]))("vertical %s, %j -> %s", (vertical, name, slug) => {
    expect(workspaceSlugFor(vertical as string | null, name as string)).toBe(slug);
  });

  it("deptSlug is the UI's rule", () => {
    expect(deptSlug("Web Dev")).toBe("web-dev");
    expect(deptSlug("Social Media")).toBe("social-media");
    expect(deptSlug("GM")).toBe("gm");
    expect(deptSlug("--R&D / Lab--")).toBe("r-d-lab");
  });
});

// ═══════════════════════════════ the catalogue ═══════════════════════════════

/** Each workspace's `kpis` keys, read from the UI registry's source text (no import: the nest suite does not load
 *  Next-only modules). Every `const X: Workspace = {...};` block names its slug as `key:` and its set as `kpis: [...]`. */
function uiRegistryKpiKeys(): Map<string, string[]> {
  const text = readFileSync(UI_WORKSPACES, "utf8").replace(/\r\n/g, "\n");
  const out = new Map<string, string[]>();
  for (const m of text.matchAll(/^const [A-Z_]+: Workspace = \{\n([\s\S]*?)^\};/gm)) {
    const body = m[1];
    const key = /^ {2}key: "([^"]+)",/m.exec(body)?.[1];
    const kpis = /^ {2}kpis: \[\n([\s\S]*?)^ {2}\],/m.exec(body)?.[1];
    if (!key || kpis === undefined) continue;
    out.set(key, [...kpis.matchAll(/\{ key: "([^"]+)"/g)].map((x) => x[1]));
  }
  return out;
}

describe("DW-4e-1 · the catalogue (§40.1)", () => {
  it("every UI registry workspace's kpis key list equals the catalogue's, in order, and no slug is on one side only", () => {
    const ui = uiRegistryKpiKeys();
    expect(ui.size).toBe(9);
    expect([...ui.keys()].sort()).toEqual([...WORKSPACE_SLUGS].sort());
    for (const slug of WORKSPACE_SLUGS) {
      expect(DEPT_KPI_SETS[slug].map((d) => d.key), slug).toEqual(ui.get(slug));
    }
  });

  it("every definition is complete: label, unit, direction, reader, and a suggested tolerance whenever there is a suggested target", () => {
    for (const slug of WORKSPACE_SLUGS) {
      const keys = DEPT_KPI_SETS[slug].map((d) => d.key);
      expect(new Set(keys).size, `${slug}: duplicate key`).toBe(keys.length);
      for (const d of DEPT_KPI_SETS[slug]) {
        expect(d.label.length, `${slug}/${d.key}`).toBeGreaterThan(0);
        expect(["percent", "count", "minutes"]).toContain(d.unit);
        expect(["up_good", "down_good"]).toContain(d.direction);
        expect(d.suggestedTarget === null).toBe(d.suggestedTolerance === null);
        if (d.suggestedTolerance !== null) expect(d.suggestedTolerance).toBeGreaterThanOrEqual(0);
        if (d.unit === "percent" && d.suggestedTarget !== null) {
          expect(d.suggestedTarget).toBeGreaterThanOrEqual(0);
          expect(d.suggestedTarget).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("only §40.1's table has a reader: four report_fact KPIs (department grain), utilization (company grain), one derived; all others module", () => {
    const readers: string[] = [];
    for (const slug of WORKSPACE_SLUGS) {
      for (const d of DEPT_KPI_SETS[slug]) {
        if (d.reader.kind === "report_fact") readers.push(`${slug}/${d.key}=${d.reader.metricKey}@${d.reader.grain}`);
        if (d.reader.kind === "derived") readers.push(`${slug}/${d.key}=derived`);
      }
    }
    expect(readers.sort()).toEqual(
      [
        "web-dev/projects-on-time=delivery.milestone_hit_rate@department",
        "web-dev/reopened-work-rate=flow.reopen_rate@department",
        "generic/projects-on-time=delivery.milestone_hit_rate@department",
        "generic/overdue-tasks=discipline.overdue_open@department",
        "generic/check-in-compliance=discipline.checkin_compliance@department",
        "gm/utilization=effort.capacity_utilization@company",
        "gm/departments-in-good-condition=derived",
      ].sort(),
    );
  });

  it("every report_fact metric exists in the metric registry at its grain, with a matching unit and direction", () => {
    const DIRECTION: Record<string, "up_good" | "down_good"> = {
      "delivery.milestone_hit_rate": "up_good",
      "flow.reopen_rate": "down_good",
      "discipline.overdue_open": "down_good",
      "discipline.checkin_compliance": "up_good",
      "effort.capacity_utilization": "up_good",
    };
    for (const slug of WORKSPACE_SLUGS) {
      for (const d of DEPT_KPI_SETS[slug]) {
        if (d.reader.kind !== "report_fact") continue;
        const reader = d.reader;
        const m = REPORT_METRICS.find((x) => x.metricKey === reader.metricKey);
        expect(m, reader.metricKey).toBeTruthy();
        expect(m!.grains).toContain(reader.grain);
        expect(d.unit).toBe(m!.displayUnit);
        expect(d.direction).toBe(DIRECTION[reader.metricKey]);
      }
    }
  });

  it("kpiDefFor finds a KPI only in its own workspace's set", () => {
    expect(kpiDefFor("web-dev", "projects-on-time")?.reader.kind).toBe("report_fact");
    expect(kpiDefFor("web-dev", "overdue-tasks")).toBeUndefined();
    // the same key in two sets is two definitions (Web Dev's SLA is a client one, IT's an internal one)
    expect(kpiDefFor("web-dev", "requests-within-sla")?.label).not.toBe(kpiDefFor("it", "requests-within-sla")?.label);
  });
});

// ═══════════════════════════════ condition (§40.3) ═══════════════════════════════

const UP: Pick<DeptKpiDef, "direction" | "reader"> = { direction: "up_good", reader: { kind: "report_fact", metricKey: "x", grain: "department" } };
const DOWN: Pick<DeptKpiDef, "direction" | "reader"> = { direction: "down_good", reader: { kind: "report_fact", metricKey: "x", grain: "department" } };
const MOD: Pick<DeptKpiDef, "direction" | "reader"> = { direction: "up_good", reader: { kind: "module" } };
const T = { target: 0.85, tolerance: 0.05 };

describe("DW-4e-1 · a KPI's condition at each boundary", () => {
  it("up_good: equal to target is on track; better is on track", () => {
    expect(kpiCondition(UP, 0.85, T)).toEqual({ condition: "on_track" });
    expect(kpiCondition(UP, 0.9, T)).toEqual({ condition: "on_track" });
    expect(kpiCondition(UP, 17 / 20, T)).toEqual({ condition: "on_track" }); // a derived ratio exactly at target
  });

  it("up_good: worse but inside the tolerance is at risk, INCLUDING exactly at the tolerance (no float miss)", () => {
    expect(kpiCondition(UP, 0.84, T)).toEqual({ condition: "at_risk" });
    expect(kpiCondition(UP, 0.8, T)).toEqual({ condition: "at_risk" }); // 0.85 - 0.8 = 0.05000000000000004 in floats
    expect(kpiCondition(UP, 16 / 20, T)).toEqual({ condition: "at_risk" });
  });

  it("up_good: worse by more than the tolerance is off track", () => {
    expect(kpiCondition(UP, 0.79, T)).toEqual({ condition: "off_track" });
    expect(kpiCondition(UP, 0, T)).toEqual({ condition: "off_track" });
  });

  it("down_good mirrors it: at or below target on track, above within tolerance at risk, beyond off track", () => {
    const D = { target: 0.05, tolerance: 0.03 };
    expect(kpiCondition(DOWN, 0.05, D)).toEqual({ condition: "on_track" });
    expect(kpiCondition(DOWN, 0.01, D)).toEqual({ condition: "on_track" });
    expect(kpiCondition(DOWN, 0.08, D)).toEqual({ condition: "at_risk" });
    expect(kpiCondition(DOWN, 0.081, D)).toEqual({ condition: "off_track" });
    // a count: 0 overdue against target 0 tolerance 3
    const C = { target: 0, tolerance: 3 };
    expect(kpiCondition(DOWN, 0, C)).toEqual({ condition: "on_track" });
    expect(kpiCondition(DOWN, 3, C)).toEqual({ condition: "at_risk" });
    expect(kpiCondition(DOWN, 4, C)).toEqual({ condition: "off_track" });
  });

  it("a zero tolerance: anything worse than the target is off track", () => {
    expect(kpiCondition(UP, 0.999, { target: 1, tolerance: 0 })).toEqual({ condition: "off_track" });
    expect(kpiCondition(UP, 1, { target: 1, tolerance: 0 })).toEqual({ condition: "on_track" });
  });

  it("unavailable, with its reason, in precedence order: no_reader, then no_data, then no_target", () => {
    expect(kpiCondition(MOD, 0.9, T)).toEqual({ condition: "unavailable", reason: "no_reader" });
    expect(kpiCondition(MOD, null, null)).toEqual({ condition: "unavailable", reason: "no_reader" });
    expect(kpiCondition(UP, null, T)).toEqual({ condition: "unavailable", reason: "no_data" });
    expect(kpiCondition(UP, null, null)).toEqual({ condition: "unavailable", reason: "no_data" });
    expect(kpiCondition(UP, Number.NaN, T)).toEqual({ condition: "unavailable", reason: "no_data" });
    expect(kpiCondition(UP, 0.9, null)).toEqual({ condition: "unavailable", reason: "no_target" });
  });
});

describe("DW-6n0 · a module KPI with a readerId reads like a report_fact KPI (§40.5.1)", () => {
  const WITH_READER: Pick<DeptKpiDef, "direction" | "reader"> = { direction: "up_good", reader: { kind: "module", readerId: "delivery.x" } };

  it("a value gives a condition against the target", () => {
    expect(kpiCondition(WITH_READER, 0.9, T)).toEqual({ condition: "on_track" });
    expect(kpiCondition(WITH_READER, 0.8, T)).toEqual({ condition: "at_risk" });
    expect(kpiCondition(WITH_READER, 0.5, T)).toEqual({ condition: "off_track" });
    expect(kpiCondition(WITH_READER, 0.9, null)).toEqual({ condition: "unavailable", reason: "no_target" });
  });

  it("null is no_data, before no_target", () => {
    expect(kpiCondition(WITH_READER, null, T)).toEqual({ condition: "unavailable", reason: "no_data" });
    expect(kpiCondition(WITH_READER, null, null)).toEqual({ condition: "unavailable", reason: "no_data" });
  });

  it("a module KPI without a readerId stays no_reader, whatever the value", () => {
    expect(kpiCondition({ direction: "up_good", reader: { kind: "module" } }, 0.9, T)).toEqual({ condition: "unavailable", reason: "no_reader" });
  });

  it("read_failed is a valid reason", () => {
    const reason: UnavailableReason = "read_failed";
    expect(reason).toBe("read_failed");
  });

  it("the web-dev label changed, its key did not (§40.5.5)", () => {
    expect(kpiDefFor("web-dev", "requests-within-sla")?.label).toBe("Requests delivered by the date needed");
    expect(kpiDefFor("it", "requests-within-sla")?.label).toBe("Account and device requests resolved within the SLA");
  });
});

describe("DW-4e-1 · the department's condition", () => {
  const cases: Array<[string, KpiCondition[], KpiCondition]> = [
    ["one at risk -> at risk", ["on_track", "at_risk", "unavailable"], "at_risk"],
    ["two at risk -> off track", ["at_risk", "on_track", "at_risk"], "off_track"],
    ["one off track -> off track", ["on_track", "off_track"], "off_track"],
    ["off track beats everything", ["off_track", "unavailable", "unavailable"], "off_track"],
    ["all on track -> on track", ["on_track", "on_track"], "on_track"],
    ["one on track, the rest unavailable -> on track", ["on_track", "unavailable", "unavailable"], "on_track"],
    ["all unavailable -> unavailable", ["unavailable", "unavailable", "unavailable"], "unavailable"],
    ["no KPIs -> unavailable", [], "unavailable"],
  ];
  it.each(cases)("%s", (_label, input, expected) => {
    expect(departmentCondition(input)).toBe(expected);
  });

  it("the standing order: worst first, unavailable last, then by name, then id", () => {
    const rows = [
      { condition: "on_track" as const, unit: { id: "d-a", name: "Alpha" } },
      { condition: "unavailable" as const, unit: { id: "d-b", name: "Aardvark" } },
      { condition: "off_track" as const, unit: { id: "d-c", name: "Zulu" } },
      { condition: "at_risk" as const, unit: { id: "d-d", name: "Mike" } },
      { condition: "off_track" as const, unit: { id: "d-e", name: "Bravo" } },
      { condition: "off_track" as const, unit: { id: "d-0", name: "Bravo" } },
    ];
    expect([...rows].sort(compareByConditionThenName).map((r) => r.unit.id)).toEqual(["d-0", "d-e", "d-c", "d-d", "d-a", "d-b"]);
    expect(CONDITION_RANK.off_track).toBeLessThan(CONDITION_RANK.at_risk);
  });
});

// ═══════════════════════════════ values ═══════════════════════════════

function doc(kpis: Partial<ReportKpi>[], opts: { dayCount?: number; precedes?: number } = {}): ReportDocument {
  const dayCount = opts.dayCount ?? 31;
  return {
    header: {
      tenantId: "t", grain: "department", scopeRef: "d-web", scopeName: "Web", periodKind: "month",
      periodStart: "2026-10-01", periodEnd: "2026-10-31", dayCount, periodLabel: "October 2026",
      generatedAt: "2026-10-14T00:00:00.000Z", sealed: false,
      ...(opts.precedes !== undefined ? { warnings: { precedesFactHistory: { firstFactDate: "2026-11-01", affectedDays: opts.precedes } } } : {}),
    },
    kpis: kpis.map((k) => ({ label: "", unit: "percent", value: 0, appraisalSafe: true, metricKey: "x", ...k })) as ReportKpi[],
  } as unknown as ReportDocument;
}

describe("DW-4e-1 · values from the report document", () => {
  it("a ratio carries value, numerator and denominator", () => {
    expect(reportFactValue("delivery.milestone_hit_rate", doc([{ metricKey: "delivery.milestone_hit_rate", value: 0.8, numerator: 4, denominator: 5 }])))
      .toEqual({ value: 0.8, numerator: 4, denominator: 5 });
  });

  it("a ratio with a 0 denominator is no data, never the builder's honest-zero value", () => {
    expect(reportFactValue("flow.reopen_rate", doc([{ metricKey: "flow.reopen_rate", value: 0, numerator: 0, denominator: 0 }]))).toBeNull();
  });

  it("a count is its value (0 is a real zero)", () => {
    expect(reportFactValue("discipline.overdue_open", doc([{ metricKey: "discipline.overdue_open", unit: "count", value: 0 }]))).toEqual({ value: 0 });
  });

  it("a metric absent from the document, or no document, is no data", () => {
    expect(reportFactValue("flow.reopen_rate", doc([]))).toBeNull();
    expect(reportFactValue("flow.reopen_rate", null)).toBeNull();
  });

  it("a window wholly before fact history is no data for every metric; a partly-covered window still reads", () => {
    const k = [{ metricKey: "discipline.overdue_open", unit: "count" as const, value: 2 }];
    expect(windowHasNoFacts(doc(k, { dayCount: 31, precedes: 31 }))).toBe(true);
    expect(reportFactValue("discipline.overdue_open", doc(k, { dayCount: 31, precedes: 31 }))).toBeNull();
    expect(windowHasNoFacts(doc(k, { dayCount: 31, precedes: 10 }))).toBe(false);
    expect(reportFactValue("discipline.overdue_open", doc(k, { dayCount: 31, precedes: 10 }))).toEqual({ value: 2 });
  });

  it("departments in good condition: on-track share of the departments that HAVE a condition; none -> no data", () => {
    expect(departmentsInGoodCondition(["on_track", "at_risk", "unavailable", "on_track", "off_track"])).toEqual({ value: 0.5, numerator: 2, denominator: 4 });
    expect(departmentsInGoodCondition(["unavailable", "unavailable"])).toBeNull();
    expect(departmentsInGoodCondition([])).toBeNull();
  });
});

describe("DW-4e-1 · the org tree", () => {
  const ROOT = {
    id: "co", kind: "company", name: "Co",
    children: [
      { id: "d-web", kind: "department", name: "Web Dev", children: [{ id: "dv-fe", kind: "division", name: "Frontend", children: [] }] },
      { id: "d-gm", kind: "department", name: "GM", children: [{ id: "d-nested", kind: "department", name: "Nested", children: [] }] },
      { id: "r-x", kind: "role", name: "Role", children: [] },
    ],
  };

  it("findOrgUnit reads the stored {root} shape and the bare shape; an unknown id is null", () => {
    expect(findOrgUnit({ root: ROOT }, "dv-fe")).toEqual({ id: "dv-fe", name: "Frontend", kind: "division" });
    expect(findOrgUnit(ROOT, "d-web")).toEqual({ id: "d-web", name: "Web Dev", kind: "department" });
    expect(findOrgUnit({ root: ROOT }, "nope")).toBeNull();
    expect(findOrgUnit(null, "d-web")).toBeNull();
  });

  it("departmentUnits lists every department node in tree order, nested ones included, nothing else", () => {
    expect(departmentUnits({ root: ROOT }).map((u) => u.id)).toEqual(["d-web", "d-gm", "d-nested"]);
    expect(departmentUnits(null)).toEqual([]);
  });
});
