import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { deptKpisDemo, resetDeptKpiDemo } from "./demoDeptKpis";
import { getDemoResponse } from "./demoFixtures";

// DW-10b-2 (BFF section 58): the demo store's monthly series and batch writes. It must keep the server's gates, windows and orders of checks, because the
// page and the e2e spec are only as honest as the fixture that stands in for the API in DEMO_MODE and the CI smoke build.

const T = "co-agency";
const base = `/api/${T}/dept-kpis`;
const q = (o: Record<string, string>) => new URLSearchParams(o);
const get = (path: string, params: Record<string, string>, user = "demo-hansel") => deptKpisDemo("GET", `${base}${path}`, q(params), undefined, user)!;
const post = (path: string, body: unknown, user = "demo-hansel") => deptKpisDemo("POST", `${base}${path}`, q({}), JSON.stringify(body), user)!;

interface Cell { month: string; value: number | null; target: number | null; tolerance: number | null; targetSource: string; condition: string; reason?: string; numerator?: number; denominator?: number }
interface Series {
  unit: { id: string; name: string }; workspace: string;
  months: { month: string; start: string; end: string; partial: boolean; condition: string }[];
  kpis: { key: string; label: string; unit: string; direction: string; cells: Cell[] }[];
}
const series = (params: Record<string, string> = {}, user = "demo-hansel") => get("/months", { unitNodeId: "dept-1", ...params }, user).json as Series;
type Targets = { kpis: { key: string; proposals: { id: string; proposedBy: string; effectiveFrom: string }[] }[] };
const proposalsOf = (unit: string, kpi: string) => (get("/targets", { unitNodeId: unit }).json as Targets).kpis.find((k) => k.key === kpi)!.proposals;
const item = (over: Record<string, unknown> = {}) => ({ kpiKey: "projects-on-time", effectiveFrom: "2026-11-01", target: 0.85, tolerance: 0.05, ...over });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-14T10:00:00Z"));
  resetDeptKpiDemo();
});
afterEach(() => vi.useRealTimers());

describe("GET dept-kpis/months", () => {
  it("is reached through getDemoResponse and answers the 12 months ending with the current month, oldest first, the current one partial", () => {
    const r = getDemoResponse("GET", `${base}/months?unitNodeId=dept-1`, "demo-hansel");
    expect(r.status).toBe(200);
    const j = r.json as Series;
    expect(j.unit).toEqual({ id: "dept-1", name: "Web Dev" });
    expect(j.workspace).toBe("web-dev");
    expect(j.months.map((m) => m.month)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(j.months[0]).toMatchObject({ start: "2025-11-01", end: "2025-11-30", partial: false });
    expect(j.months[11]).toMatchObject({ start: "2026-10-01", end: "2026-10-31", partial: true });
    expect(j.months.filter((m) => m.partial)).toHaveLength(1);
  });

  it("has one cell per KPI per month, in the catalogue's order", () => {
    const j = series();
    expect(j.kpis.map((k) => k.key)).toEqual(["projects-on-time", "requests-within-sla", "client-site-uptime", "reopened-work-rate"]);
    for (const k of j.kpis) expect(k.cells.map((c) => c.month)).toEqual(j.months.map((m) => m.month));
  });

  it("judges each month against the target in force THAT month: no target, then 82% from July, then 85% from September", () => {
    const cells = series().kpis.find((k) => k.key === "projects-on-time")!.cells;
    const by = Object.fromEntries(cells.map((c) => [c.month, c]));
    expect(by["2026-02"]).toMatchObject({ target: null, targetSource: "none", condition: "unavailable", reason: "no_target" });
    expect(by["2026-02"].value).not.toBeNull();
    expect(by["2026-07"]).toMatchObject({ target: 0.82, targetSource: "approved" });
    expect(by["2026-08"].target).toBe(0.82);
    expect(by["2026-09"].target).toBe(0.85);
    expect(by["2026-10"].target).toBe(0.85);
  });

  it("is unavailable with a reason, never 0, for a month before the fact history and for a sync gap", () => {
    const cells = series().kpis.find((k) => k.key === "projects-on-time")!.cells;
    const by = Object.fromEntries(cells.map((c) => [c.month, c]));
    for (const m of ["2025-11", "2025-12", "2026-05"]) expect(by[m]).toMatchObject({ value: null, condition: "unavailable", reason: "no_data" });
    expect(cells.some((c) => c.value === 0)).toBe(false);
    // a KPI with no reader says so in every month
    const uptime = series().kpis.find((k) => k.key === "client-site-uptime")!.cells;
    expect(uptime.every((c) => c.value === null && c.condition === "unavailable" && c.reason === "no_reader")).toBe(true);
  });

  it("agrees with the unit read for the current month: the same value, target and condition as the page's tile", () => {
    const tile = (get("", { unitNodeId: "dept-1", periodKind: "month", start: "2026-10-14" }).json as { kpis: Cell[] & { key: string }[] }).kpis as unknown as (Cell & { key: string })[];
    for (const k of series().kpis) {
      const now = k.cells[11];
      const t = tile.find((x) => x.key === k.key)!;
      expect({ v: now.value, t: now.target, c: now.condition, r: now.reason }).toEqual({ v: t.value, t: t.target, c: t.condition, r: t.reason });
    }
  });

  it("carries a real trend: the values of Projects on time differ from month to month, and a ratio keeps its parts", () => {
    const cells = series().kpis.find((k) => k.key === "projects-on-time")!.cells.filter((c) => c.value !== null);
    expect(new Set(cells.map((c) => c.value)).size).toBeGreaterThanOrEqual(5);
    for (const c of cells) expect(c.value).toBeCloseTo((c.numerator as number) / (c.denominator as number), 10);
    expect(series().months.map((m) => m.condition)).toContain("unavailable");
  });

  it("takes a window: from and to", () => {
    const j = series({ from: "2026-06", to: "2026-08" });
    expect(j.months.map((m) => m.month)).toEqual(["2026-06", "2026-07", "2026-08"]);
    expect(j.months.every((m) => !m.partial)).toBe(true);
    expect(series({ from: "2026-10", to: "2026-10" }).months).toHaveLength(1);
  });

  it("names the bad field: a non-month, from after to, more than 12 months, a future to", () => {
    const bad = (p: Record<string, string>) => get("/months", { unitNodeId: "dept-1", ...p });
    expect(bad({ from: "2026-13", to: "2026-10" })).toMatchObject({ status: 400, json: { field: "from" } });
    expect(bad({ from: "2026-01", to: "october" })).toMatchObject({ status: 400, json: { field: "to" } });
    expect(bad({ from: "2026-09", to: "2026-03" })).toMatchObject({ status: 400, json: { field: "from" } });
    expect(bad({ from: "2025-09", to: "2026-10" })).toMatchObject({ status: 400, json: { field: "from" } }); // 14 months
    expect(bad({ from: "2025-10", to: "2026-09" }).status).toBe(200); // exactly 12
    expect(bad({ from: "2026-09", to: "2026-11" })).toMatchObject({ status: 400, json: { field: "to" } });
    expect(bad({ from: "2026-13" })).toMatchObject({ status: 400, json: { field: "from" } }); // the one that was sent is still checked
    expect(bad({ from: "2026-01" }).status).toBe(200); // one bound only: the default window
  });

  it("has the unit read's gate: 400 without a unit, 403 before any word on whether it exists, then 404", () => {
    expect(get("/months", {}).status).toBe(400);
    expect(get("/months", { unitNodeId: "dept-99" }, "dept-manager").status).toBe(403);
    expect(get("/months", { unitNodeId: "dept-99" })).toMatchObject({ status: 404, json: { error: "unit_not_found" } });
    expect(get("/months", { unitNodeId: "dept-1", from: "bad" }, "dept-manager").status).toBe(403); // the gate comes before the window
    // staff read their own department, a head theirs, another unit's head and an unplaced member nothing
    expect(series({}, "u-dev").unit.id).toBe("dept-1");
    expect(series({}, "u-webhead").unit.id).toBe("dept-1");
    expect(get("/months", { unitNodeId: "dept-1" }, "dept-manager").status).toBe(403);
    expect(get("/months", { unitNodeId: "dept-1" }, "gede-ic").status).toBe(403);
  });
});

describe("POST dept-kpis/targets/batch", () => {
  it("proposes every month in one request, 201 with the ids in item order, and they list as the head's proposals", () => {
    const r = post("/targets/batch", { unitNodeId: "dept-1", items: [item(), item({ effectiveFrom: "2026-12-01", target: 0.87 })] }, "u-webhead");
    expect(r.status).toBe(201);
    const { ids } = r.json as { ids: string[] };
    expect(ids).toHaveLength(2);
    const mine = proposalsOf("dept-1", "projects-on-time");
    expect(mine.map((p) => [p.id, p.proposedBy, p.effectiveFrom])).toEqual([[ids[0], "u-webhead", "2026-11-01"], [ids[1], "u-webhead", "2026-12-01"]]);
  });

  it("is 403, never 400, for someone who may not propose, even with an invalid body; another unit's head is 403 too", () => {
    expect(post("/targets/batch", { unitNodeId: "dept-1", items: [] }, "u-dev").status).toBe(403);
    expect(post("/targets/batch", { unitNodeId: "dept-1", items: [item()] }, "dept-manager").status).toBe(403);
    expect(post("/targets/batch", { unitNodeId: "dept-1", items: [item({ effectiveFrom: "x" })] }, "demo-owner").status).toBe(403);
  });

  it("names the first invalid item by index, and inserts nothing", () => {
    const before = proposalsOf("dept-1", "projects-on-time").length;
    const bad = (items: unknown[], user = "u-webhead") => post("/targets/batch", { unitNodeId: "dept-1", items }, user);
    const dec = item({ effectiveFrom: "2026-12-01" });
    expect(bad([item(), dec, item({ effectiveFrom: "2027-01-01", target: "x" })])).toMatchObject({ status: 400, json: { field: "items[2].target" } });
    expect(bad([item(), item({ effectiveFrom: "2026-12-15" })])).toMatchObject({ status: 400, json: { field: "items[1].effectiveFrom" } });
    expect(bad([item({ tolerance: -1 })])).toMatchObject({ status: 400, json: { field: "items[0].tolerance" } });
    expect(bad([item({ kpiKey: "nope" })])).toMatchObject({ status: 400, json: { field: "items[0].kpiKey" } });
    expect(bad([item(), item({ effectiveFrom: "2026-12-01", target: 85 })])).toMatchObject({ status: 400, json: { field: "items[1].target" } }); // a percent is a fraction
    expect(bad([item(), "nope"])).toMatchObject({ status: 400, json: { field: "items[1]" } });
    expect(proposalsOf("dept-1", "projects-on-time")).toHaveLength(before);
  });

  it("refuses a duplicate month (400, the later item), no items and more than 36", () => {
    const dup = post("/targets/batch", { unitNodeId: "dept-1", items: [item(), item()] }, "u-webhead");
    expect(dup).toMatchObject({ status: 400, json: { field: "items[1].effectiveFrom" } });
    expect(post("/targets/batch", { unitNodeId: "dept-1", items: [] }, "u-webhead")).toMatchObject({ status: 400, json: { field: "items" } });
    const many = Array.from({ length: 37 }, (_, i) => item({ effectiveFrom: `${2027 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}-01` }));
    expect(post("/targets/batch", { unitNodeId: "dept-1", items: many }, "u-webhead")).toMatchObject({ status: 400, json: { field: "items" } });
    expect(post("/targets/batch", { unitNodeId: "dept-1", items: many.slice(0, 36) }, "u-webhead").status).toBe(201);
  });

  it("answers 404 for a unit that does not exist, for the company admin who passed the gate", () => {
    expect(post("/targets/batch", { unitNodeId: "dept-99", items: [item()] })).toMatchObject({ status: 404, json: { error: "unit_not_found" } });
  });
});

describe("POST dept-kpis/targets/decide-batch", () => {
  const plan = (user = "u-webhead") => (post("/targets/batch", { unitNodeId: "dept-1", items: [item(), item({ effectiveFrom: "2026-12-01", target: 0.9 })] }, user).json as { ids: string[] }).ids;

  it("approves several proposals in one request, 200 with decided in the order given", () => {
    const [a, b] = plan();
    const r = post("/targets/decide-batch", { decision: "approve", ids: [b, a] });
    expect(r.status).toBe(200);
    expect((r.json as { decided: { id: string; status: string }[] }).decided.map((d) => [d.id, d.status])).toEqual([[b, "approved"], [a, "approved"]]);
    expect(proposalsOf("dept-1", "projects-on-time")).toHaveLength(0);
    // the months are now in force in the series
    const cells = series({ from: "2026-10", to: "2026-10" }).kpis[0].cells;
    expect(cells[0].target).toBe(0.85);
  });

  it("supersedes the approved rows from each month on and leaves an earlier month's alone", () => {
    const [a] = plan();
    // November's proposal (0.85) supersedes nothing earlier: the September row (0.85) stays approved
    const r = post("/targets/decide-batch", { decision: "approve", ids: [a] });
    expect((r.json as { decided: { superseded: string[] }[] }).decided[0].superseded).toEqual([]);
    const [c] = (post("/targets/batch", { unitNodeId: "dept-1", items: [item({ effectiveFrom: "2026-09-01", target: 0.88 })] }, "u-webhead").json as { ids: string[] }).ids;
    const r2 = post("/targets/decide-batch", { decision: "approve", ids: [c] });
    expect((r2.json as { decided: { superseded: string[] }[] }).decided[0].superseded.length).toBeGreaterThanOrEqual(2); // the September row and the later November row
  });

  it("rejects several proposals, superseding nothing", () => {
    const ids = plan();
    const r = post("/targets/decide-batch", { decision: "reject", ids });
    expect((r.json as { decided: { status: string; superseded: string[] }[] }).decided).toEqual(ids.map((id) => ({ id, status: "rejected", superseded: [] })));
  });

  it("refuses the whole set, naming the row (failedId): own proposal 409, decided row 409, unknown id 404, not an approver 403", () => {
    const [a, b] = plan("demo-hansel"); // the admin's own proposals: approving them is refused
    const own = post("/targets/decide-batch", { decision: "approve", ids: [a, b] });
    expect(own).toMatchObject({ status: 409, json: { error: "cannot_approve_own_proposal", failedId: a } });
    expect(proposalsOf("dept-1", "projects-on-time")).toHaveLength(2); // nothing decided
    // but the admin may reject their own (as the single route)
    expect(post("/targets/decide-batch", { decision: "reject", ids: [a] }).status).toBe(200);
    expect(post("/targets/decide-batch", { decision: "approve", ids: [a] })).toMatchObject({ status: 409, json: { error: "not_proposed", failedId: a } });
    expect(post("/targets/decide-batch", { decision: "approve", ids: ["demo-dkt-9999", b] })).toMatchObject({ status: 404, json: { failedId: "demo-dkt-9999" } });
    const [c] = plan();
    expect(post("/targets/decide-batch", { decision: "approve", ids: [c] }, "dept-manager")).toMatchObject({ status: 403, json: { failedId: c } });
  });

  it("is all or nothing: one refused id leaves the others open", () => {
    const [a] = plan();
    const own = (post("/targets/batch", { unitNodeId: "dept-1", items: [item({ effectiveFrom: "2027-01-01" })] }).json as { ids: string[] }).ids[0]; // the admin's own
    const r = post("/targets/decide-batch", { decision: "approve", ids: [a, own] });
    expect(r).toMatchObject({ status: 409, json: { failedId: own } });
    expect(proposalsOf("dept-1", "projects-on-time").map((p) => p.id)).toContain(a);
  });

  it("validates the body: a decision, 1 to 36 distinct ids", () => {
    expect(post("/targets/decide-batch", { decision: "maybe", ids: ["x"] })).toMatchObject({ status: 400, json: { field: "decision" } });
    expect(post("/targets/decide-batch", { decision: "approve", ids: [] })).toMatchObject({ status: 400, json: { field: "ids" } });
    expect(post("/targets/decide-batch", { decision: "approve", ids: ["x", "x"] })).toMatchObject({ status: 400, json: { field: "ids" } });
    expect(post("/targets/decide-batch", { decision: "approve", ids: Array.from({ length: 37 }, (_, i) => `x${i}`) })).toMatchObject({ status: 400, json: { field: "ids" } });
  });
});
