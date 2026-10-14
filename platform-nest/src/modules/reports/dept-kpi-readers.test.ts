// DW-6n0 (docs/FRONTEND-BFF-CONTRACT.md §40.5.1) — the parity of the department KPI catalogue and the module reader registry:
// a typo in a readerId is a failed build, never a silent `no_reader`. Pure: no DB.
import { describe, it, expect } from "vitest";
import { DEPT_KPI_SETS, type DeptKpiDef } from "./dept-kpis";
import { MODULE_KPI_READERS, readerParityProblems, setModuleKpiReadersForTests, moduleKpiReaders } from "./dept-kpi-readers";
import type { ModuleKpiReader } from "./dept-kpi-readers/types";

const fake: ModuleKpiReader = async () => null;
const def = (key: string, readerId?: string): DeptKpiDef => ({
  key,
  label: key,
  unit: "percent",
  direction: "up_good",
  reader: readerId === undefined ? { kind: "module" } : { kind: "module", readerId },
  suggestedTarget: 1,
  suggestedTolerance: 0,
});

describe("DW-6n0 · reader parity (§40.5.1)", () => {
  it("every readerId in the catalogue has a registered reader, and every registered reader is named once", () => {
    expect(readerParityProblems(DEPT_KPI_SETS, MODULE_KPI_READERS)).toEqual([]);
  });

  it("the checker names a missing reader, an orphan reader and a reader named twice", () => {
    const sets = { a: [def("k1", "r.ok"), def("k2", "r.missing"), def("k3")], b: [def("k4", "r.twice"), def("k5", "r.twice")] };
    const readers = { "r.ok": fake, "r.twice": fake, "r.orphan": fake };
    const problems = readerParityProblems(sets, readers);
    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toContain('readerId "r.missing" (a/k2) has no registered reader');
    expect(problems.join("\n")).toContain('readerId "r.twice" is named by 2 catalogue entries (b/k4, b/k5)');
    expect(problems.join("\n")).toContain('registered reader "r.orphan" is named by no catalogue entry');
  });

  it("a catalogue and registry that agree have no problems", () => {
    expect(readerParityProblems({ a: [def("k1", "r.ok"), def("k2")] }, { "r.ok": fake })).toEqual([]);
  });

  it("the test seam swaps the registry and restores it", () => {
    setModuleKpiReadersForTests({ "x.y": fake });
    expect(Object.keys(moduleKpiReaders())).toEqual(["x.y"]);
    setModuleKpiReadersForTests(null);
    expect(moduleKpiReaders()).toBe(MODULE_KPI_READERS);
  });
});
