import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { deptAppraisalsDemo, resetDeptAppraisalDemo } from "./demoDeptAppraisals";
import { resetDeptKpiDemo } from "./demoDeptKpis";
import { appraisalsDemo } from "./demoAppraisals";
import { getDemoResponse } from "./demoFixtures";

// DW-4e-3 — the department appraisal demo fixture (BFF §41). It must model the server's gates and orders, because the page is only
// as honest as the fixture that stands in for the API in DEMO_MODE and in the CI smoke build: one OPEN cycle (demo-cycle-h2) and
// one CLOSED cycle (demo-cycle-h1), the unit's heads and the company-wide tiers reading, staff refused, writes ended on a closed cycle.

const T = "co-agency";
const base = `/api/${T}/dept-appraisals`;
const q = (o: Record<string, string>) => new URLSearchParams(o);
const OPEN = "demo-cycle-h2";
const CLOSED = "demo-cycle-h1";
const get = (params: Record<string, string>, user = "demo-hansel") => deptAppraisalsDemo("GET", base, q(params), undefined, user)!;
const put = (cycle: string, unit: string, half: "commentary" | "assessment", body: unknown, user = "demo-hansel") =>
  deptAppraisalsDemo("PUT", `${base}/${cycle}/${unit}/${half}`, q({}), JSON.stringify(body), user)!;
type View = {
  cycle: { id: string; name: string; periodStart: string; periodEnd: string; status: string };
  unit: { id: string; name: string };
  workspace: string;
  condition: string;
  kpis: Array<{ key: string; condition: string; target: number | null }>;
  history: Array<{ month: string; condition: string; kpis: Array<{ key: string; condition: string }> }>;
  people: { total: number; byStatus: Record<string, number>; distribution: Array<{ band: number; count: number }> | null; reason?: string };
  hodCommentary: { text: string; by: string; byName: string | null; at: string } | null;
  gmAssessment: { text: string; condition: string; by: string; byName: string | null; at: string } | null;
};

beforeEach(() => {
  resetDeptKpiDemo();
  resetDeptAppraisalDemo();
});

describe("routing", () => {
  it("ignores paths that are not dept-appraisals", () => {
    expect(deptAppraisalsDemo("GET", `/api/${T}/dept-kpis`, q({}))).toBeNull();
    expect(deptAppraisalsDemo("GET", `/api/${T}/dept-appraisalsx`, q({}))).toBeNull();
    expect(deptAppraisalsDemo("GET", `/api/${T}/appraisals/cycles`, q({}))).toBeNull();
  });
  it("is reached through getDemoResponse, for the read and the writes", () => {
    const r = getDemoResponse("GET", `${base}?cycleId=${OPEN}&unitNodeId=dept-1`, "demo-hansel");
    expect(r.status).toBe(200);
    expect((r.json as View).unit.name).toBe("Web Dev");
    const w = getDemoResponse("PUT", `${base}/${OPEN}/dept-1/commentary`, "demo-hansel", JSON.stringify({ text: "Via the router." }));
    expect(w.status).toBe(200);
  });
  it("an unknown route under the prefix is 404", () => {
    expect(deptAppraisalsDemo("GET", `${base}/nope`, q({}))!.status).toBe(404);
  });
});

describe("GET dept-appraisals/cycles (the picker's list)", () => {
  const list = (user = "demo-hansel") => deptAppraisalsDemo("GET", `${base}/cycles`, q({}), undefined, user)!;
  type Pick = { id: string; name: string; periodStart: string; periodEnd: string; status: string };
  it("lists the open and the closed cycle, newest first, with only the picker's fields", () => {
    const r = list();
    expect(r.status).toBe(200);
    const cycles = (r.json as { cycles: Pick[] }).cycles;
    expect(cycles.map((c) => [c.id, c.status])).toEqual([[OPEN, "open"], [CLOSED, "closed"]]);
    expect(Object.keys(cycles[0]).sort()).toEqual(["id", "name", "periodEnd", "periodStart", "status"]);
  });
  it("is for the company-wide tiers and a unit's head; a unit's staff and anyone else get 403", () => {
    expect(list("demo-owner").status).toBe(200);
    expect(list("dept-manager").status).toBe(200);
    expect(list("u-dev").status).toBe(403);
    expect(list("seo-staff").status).toBe(403);
    expect(list("someone-else").status).toBe(403);
  });
  it("is reached through getDemoResponse", () => {
    expect(getDemoResponse("GET", `${base}/cycles`, "demo-hansel").status).toBe(200);
    expect(getDemoResponse("GET", `${base}/cycles`, "u-dev").status).toBe(403);
  });
});

describe("GET dept-appraisals: the open cycle", () => {
  it("serves Web Dev's appraisal with every block the page renders", () => {
    const r = get({ cycleId: OPEN, unitNodeId: "dept-1" });
    expect(r.status).toBe(200);
    const v = r.json as View;
    expect(Object.keys(v).sort()).toEqual(["condition", "cycle", "gmAssessment", "history", "hodCommentary", "kpis", "people", "unit", "workspace"]);
    expect(v.cycle).toMatchObject({ id: OPEN, name: "2026 H2 Performance Review", periodStart: "2026-07-01", periodEnd: "2026-12-31", status: "open" });
    expect(v.unit).toEqual({ id: "dept-1", name: "Web Dev" });
    expect(v.workspace).toBe("web-dev");
    expect(v.kpis.map((k) => k.key)).toEqual(["projects-on-time", "requests-within-sla", "client-site-uptime", "reopened-work-rate"]);
    expect(v.hodCommentary).toBeNull();
    expect(v.gmAssessment).toBeNull();
  });

  it("the KPIs are the engine fixture's, judged against the target in force for the cycle's LAST month", () => {
    const v = get({ cycleId: OPEN, unitNodeId: "dept-1" }).json as View;
    const on = v.kpis.find((k) => k.key === "projects-on-time")!;
    expect(on).toMatchObject({ target: 0.85, condition: "at_risk" });
    expect(v.condition).toBe("at_risk");
  });

  it("the history is one entry per calendar month of the cycle, agreeing with the KPI fixture month by month", () => {
    const v = get({ cycleId: OPEN, unitNodeId: "dept-1" }).json as View;
    expect(v.history.map((h) => h.month)).toEqual(["2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01", "2026-11-01", "2026-12-01"]);
    for (const h of v.history) {
      expect(h.condition).toBe("at_risk");
      expect(h.kpis.find((k) => k.key === "projects-on-time")!.condition).toBe("at_risk");
    }
  });

  it("the people block is counts only: a distribution when 3 or more are scored, withheld below that", () => {
    const web = (get({ cycleId: OPEN, unitNodeId: "dept-1" }).json as View).people;
    expect(web.total).toBe(6);
    expect(web.byStatus).toEqual({ draft: 1, submitted: 2, acknowledged: 1, disputed: 0, finalized: 2 });
    expect(web.distribution).toEqual([
      { band: 1, count: 0 }, { band: 2, count: 0 }, { band: 3, count: 1 }, { band: 4, count: 3 }, { band: 5, count: 1 },
    ]);
    expect(web.reason).toBeUndefined();
    const seo = (get({ cycleId: OPEN, unitNodeId: "dept-3" }, "dept-manager").json as View).people;
    expect(seo.total).toBe(2);
    expect(seo.distribution).toBeNull();
    expect(seo.reason).toBe("too_few");
    expect(JSON.stringify(seo)).not.toContain("band");
    // a unit with no appraisals reads as an empty block, withheld, never an invented one
    const none = (get({ cycleId: OPEN, unitNodeId: "dept-5" }).json as View).people;
    expect(none.total).toBe(0);
    expect(none.distribution).toBeNull();
  });
});

describe("GET dept-appraisals: the closed cycle", () => {
  it("is the record: its status is closed and the halves written while it was open are kept", () => {
    const v = get({ cycleId: CLOSED, unitNodeId: "dept-1" }).json as View;
    expect(v.cycle.status).toBe("closed");
    expect(v.hodCommentary).toMatchObject({ by: "demo-head-webdev" });
    expect(v.hodCommentary!.text).toMatch(/^Sample commentary/);
    expect(v.gmAssessment).toMatchObject({ condition: "on_track", by: "demo-hansel" });
    expect(v.history.map((h) => h.month)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01"]);
  });
  it("months before any approved target read unavailable, never an invented condition", () => {
    const v = get({ cycleId: CLOSED, unitNodeId: "dept-1" }).json as View;
    expect(v.history.every((h) => h.condition === "unavailable")).toBe(true);
    expect(v.condition).toBe("unavailable");
  });
});

describe("who may read (§41.3) and the order of refusals", () => {
  it("the unit's head and the company-wide tiers read; staff and other units' heads are refused (403)", () => {
    expect(get({ cycleId: OPEN, unitNodeId: "dept-3" }, "dept-manager").status).toBe(200); // the SEO head, their unit
    expect(get({ cycleId: OPEN, unitNodeId: "dept-1" }, "demo-owner").status).toBe(200); // a company-wide tier
    expect(get({ cycleId: OPEN, unitNodeId: "dept-1" }, "u-dev").status).toBe(403); // the unit's own staff read the KPI page, not this
    expect(get({ cycleId: OPEN, unitNodeId: "dept-3" }, "seo-staff").status).toBe(403);
    expect(get({ cycleId: OPEN, unitNodeId: "dept-1" }, "dept-manager").status).toBe(403); // another unit's head
    expect(get({ cycleId: OPEN, unitNodeId: "dept-1" }, "someone-else").status).toBe(403);
  });
  it("a refused caller learns nothing about whether the unit or cycle exists (403 first), a company-wide one gets the typed 404", () => {
    expect(get({ cycleId: OPEN, unitNodeId: "dept-99" }, "u-dev").status).toBe(403);
    expect(get({ cycleId: "demo-cycle-nope", unitNodeId: "dept-1" }, "u-dev").status).toBe(403);
    const noUnit = get({ cycleId: OPEN, unitNodeId: "dept-99" });
    expect(noUnit.status).toBe(404);
    expect(noUnit.json).toEqual({ error: "unit_not_found", field: "unitNodeId" });
    const noCycle = get({ cycleId: "demo-cycle-nope", unitNodeId: "dept-1" });
    expect(noCycle.status).toBe(404);
    expect(noCycle.json).toEqual({ error: "cycle_not_found", field: "cycleId" });
  });
  it("missing cycleId or unitNodeId is 400", () => {
    expect(get({ unitNodeId: "dept-1" }).status).toBe(400);
    expect(get({ cycleId: OPEN }).status).toBe(400);
  });
});

describe("PUT commentary and assessment", () => {
  it("a head comments on their own unit (200, by and at set) and the read shows it; another unit is 403", () => {
    const r = put(OPEN, "dept-3", "commentary", { text: "  A good half for SEO.  " }, "dept-manager");
    expect(r.status).toBe(200);
    expect((r.json as { hodCommentary: { text: string; by: string } }).hodCommentary).toMatchObject({ text: "A good half for SEO.", by: "dept-manager", byName: "SEO head" });
    expect((get({ cycleId: OPEN, unitNodeId: "dept-3" }, "dept-manager").json as View).hodCommentary!.text).toBe("A good half for SEO.");
    expect(put(OPEN, "dept-1", "commentary", { text: "not mine" }, "dept-manager").status).toBe(403);
  });
  it("saving replaces the previous commentary", () => {
    put(OPEN, "dept-1", "commentary", { text: "First." });
    put(OPEN, "dept-1", "commentary", { text: "Second." });
    expect((get({ cycleId: OPEN, unitNodeId: "dept-1" }).json as View).hodCommentary!.text).toBe("Second.");
  });
  it("only the approver tier assesses: a head is refused (403), the owner is not (it mirrors company_admin)", () => {
    expect(put(OPEN, "dept-3", "assessment", { text: "Fine.", condition: "on_track" }, "dept-manager").status).toBe(403);
    expect(put(OPEN, "dept-1", "assessment", { text: "Fine.", condition: "on_track" }, "u-dev").status).toBe(403);
    const r = put(OPEN, "dept-1", "assessment", { text: "Judged well.", condition: "off_track" }, "demo-owner");
    expect(r.status).toBe(200);
    const v = get({ cycleId: OPEN, unitNodeId: "dept-1" }).json as View;
    expect(v.gmAssessment).toMatchObject({ text: "Judged well.", condition: "off_track", by: "demo-owner" });
    expect(v.condition).toBe("at_risk"); // the GM's judgement sits BESIDE the computed condition
  });
  it("the owner cannot comment (no appraisal_comment mirror), company_admin can on any unit", () => {
    expect(put(OPEN, "dept-1", "commentary", { text: "x" }, "demo-owner").status).toBe(403);
    expect(put(OPEN, "dept-3", "commentary", { text: "The GM tier may comment." }, "demo-hansel").status).toBe(200);
  });
  it("validates after authorizing: 400 for a bad text or condition, never in place of a 403", () => {
    for (const bad of [{}, { text: "" }, { text: "   " }, { text: 4 }, { text: "x".repeat(4001) }]) {
      const r = put(OPEN, "dept-1", "commentary", bad);
      expect(r.status).toBe(400);
      expect((r.json as { field: string }).field).toBe("text");
    }
    expect(put(OPEN, "dept-1", "assessment", { text: "Fine.", condition: "unavailable" }).json).toMatchObject({ field: "condition" });
    expect(put(OPEN, "dept-1", "assessment", { text: "Fine." }).status).toBe(400);
    expect(put(OPEN, "dept-1", "commentary", { text: "" }, "u-dev").status).toBe(403);
    expect(put(OPEN, "dept-1", "assessment", {}, "dept-manager").status).toBe(403);
  });
  it("an unknown unit or cycle is the typed 404 for the approver", () => {
    expect(put(OPEN, "dept-99", "commentary", { text: "x" }).json).toEqual({ error: "unit_not_found", field: "unitNodeId" });
    expect(put("demo-cycle-nope", "dept-1", "commentary", { text: "x" }).json).toEqual({ error: "cycle_not_found", field: "cycleId" });
  });
});

describe("writes end when the cycle is closed (§41.2)", () => {
  it("the closed demo cycle refuses both halves with 409 cycle_closed, and keeps its record", () => {
    const c = put(CLOSED, "dept-1", "commentary", { text: "Too late." });
    expect(c.status).toBe(409);
    expect(c.json).toEqual({ error: "cycle_closed" });
    expect(put(CLOSED, "dept-1", "assessment", { text: "Too late.", condition: "on_track" }).status).toBe(409);
    expect((get({ cycleId: CLOSED, unitNodeId: "dept-1" }).json as View).hodCommentary!.text).toMatch(/^Sample commentary/);
  });

  describe("closing the open cycle", () => {
    const patch = (status: string) =>
      appraisalsDemo("PATCH", `/api/${T}/appraisals/cycles/${OPEN}`, new URLSearchParams(), JSON.stringify({ status }), "demo-hansel");
    afterEach(() => { patch("open"); });
    it("is seen here: the writes stop and the status reads closed, while what was written stays", () => {
      expect(put(OPEN, "dept-1", "commentary", { text: "Written while open." }).status).toBe(200);
      expect(patch("closed")!.status).toBe(200);
      expect(put(OPEN, "dept-1", "commentary", { text: "Edited after close." }).status).toBe(409);
      const v = get({ cycleId: OPEN, unitNodeId: "dept-1" }).json as View;
      expect(v.cycle.status).toBe("closed");
      expect(v.hodCommentary!.text).toBe("Written while open.");
    });
  });
});
