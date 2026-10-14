import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

// DW-4e-3 — the honest readers of lib/deptAppraisals run for real against the DEMO_MODE fixtures (lib/demoDeptAppraisals.ts and the
// appraisal cycles fixture), the way deptKpis.test.ts does: a wrong path lands on a catch-all and the content assertions fail.
// The three answers a failed read can give (not yours to read, does not exist, failed) must stay three different answers, and
// none of them may become an empty appraisal.

describe("honest readers (against the demo fixtures)", () => {
  const prev = process.env.DEMO_MODE;
  beforeAll(() => { process.env.DEMO_MODE = "1"; });
  afterAll(() => { process.env.DEMO_MODE = prev; });
  beforeEach(async () => {
    (await import("./demoDeptKpis")).resetDeptKpiDemo();
    (await import("./demoDeptAppraisals")).resetDeptAppraisalDemo();
  });

  const T = "co-agency";

  it("getDeptAppraisal returns the unit's real appraisal for the cycle", async () => {
    const { getDeptAppraisal } = await import("./deptAppraisals");
    const res = await getDeptAppraisal("demo-hansel", T, { unit: "dept-1", cycleId: "demo-cycle-h2" });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.data.unit.name).toBe("Web Dev");
    expect(res.data.cycle.status).toBe("open");
    expect(res.data.condition).toBe("at_risk");
    expect(res.data.history).toHaveLength(6);
    expect(res.data.people.total).toBe(6);
  });

  it("maps a refusal, a missing cycle and a missing unit to three different answers, never an empty appraisal", async () => {
    const { getDeptAppraisal } = await import("./deptAppraisals");
    expect(await getDeptAppraisal("u-dev", T, { unit: "dept-1", cycleId: "demo-cycle-h2" })).toEqual({ kind: "forbidden" });
    expect(await getDeptAppraisal("demo-hansel", T, { unit: "dept-1", cycleId: "demo-cycle-nope" })).toEqual({ kind: "not_found", what: "cycle" });
    expect(await getDeptAppraisal("demo-hansel", T, { unit: "dept-99", cycleId: "demo-cycle-h2" })).toEqual({ kind: "not_found", what: "unit" });
  });

  it("a head reads their own unit's appraisal and not another's", async () => {
    const { getDeptAppraisal } = await import("./deptAppraisals");
    expect((await getDeptAppraisal("dept-manager", T, { unit: "dept-3", cycleId: "demo-cycle-h2" })).kind).toBe("ok");
    expect(await getDeptAppraisal("dept-manager", T, { unit: "dept-1", cycleId: "demo-cycle-h2" })).toEqual({ kind: "forbidden" });
  });

  it("getCyclePicks lists the company's cycles newest first for an appraisal administrator", async () => {
    const { getCyclePicks } = await import("./deptAppraisals");
    const res = await getCyclePicks("demo-hansel", T);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.data.map((c) => [c.id, c.status])).toEqual([["demo-cycle-h2", "open"], ["demo-cycle-h1", "closed"]]);
    expect(Object.keys(res.data[0]).sort()).toEqual(["id", "name", "periodEnd", "periodStart", "status"]);
  });

  it("getCyclePicks says forbidden, not 'no cycles', for anyone else", async () => {
    const { getCyclePicks } = await import("./deptAppraisals");
    expect(await getCyclePicks("dept-manager", T)).toEqual({ kind: "forbidden" });
    expect(await getCyclePicks("u-dev", T)).toEqual({ kind: "forbidden" });
  });
});
