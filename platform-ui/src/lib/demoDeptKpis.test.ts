import { describe, it, expect, beforeEach } from "vitest";
import { deptKpisDemo, resetDeptKpiDemo } from "./demoDeptKpis";
import { getDemoResponse } from "./demoFixtures";
import { nextMonthStart } from "./deptKpiFormat";

// DW-4e-2 — the department KPI demo fixture (BFF §40). It must model the server's gates and orders, because the page
// is only as honest as the fixture that stands in for the API in DEMO_MODE and in the CI smoke build.

const T = "co-agency";
const base = `/api/${T}/dept-kpis`;
const q = (o: Record<string, string>) => new URLSearchParams(o);
const get = (path: string, params: Record<string, string>, user = "demo-hansel") => deptKpisDemo("GET", `${base}${path}`, q(params), undefined, user)!;
const post = (path: string, body: unknown, user = "demo-hansel") => deptKpisDemo("POST", `${base}${path}`, q({}), JSON.stringify(body), user)!;
const Q = { periodKind: "month", start: "2026-10-14" };
type Kpi = { key: string; condition: string; reason?: string; value: number | null; target: number | null };

beforeEach(() => resetDeptKpiDemo());

describe("routing", () => {
  it("ignores paths that are not dept-kpis", () => {
    expect(deptKpisDemo("GET", `/api/${T}/modules/lms/me`, q({}))).toBeNull();
    expect(deptKpisDemo("GET", `/api/${T}/dept-kpisx`, q({}))).toBeNull();
  });
  it("is reached through getDemoResponse", () => {
    const r = getDemoResponse("GET", `${base}?unitNodeId=dept-1&periodKind=month&start=2026-10-14`, "demo-hansel");
    expect(r.status).toBe(200);
    expect((r.json as { unit: { name: string } }).unit.name).toBe("Web Dev");
  });
});

describe("GET dept-kpis (unit read)", () => {
  it("serves Web Dev with every state the page renders", () => {
    const r = get("", { unitNodeId: "dept-1", ...Q });
    expect(r.status).toBe(200);
    const j = r.json as { unit: { id: string; name: string }; workspace: string; period: { periodKind: string; start: string; end: string }; condition: string; kpis: Kpi[] };
    expect(j.unit).toEqual({ id: "dept-1", name: "Web Dev" });
    expect(j.workspace).toBe("web-dev");
    expect(j.period).toEqual({ periodKind: "month", start: "2026-10-01", end: "2026-10-31" });
    expect(j.condition).toBe("at_risk");
    const by = Object.fromEntries(j.kpis.map((k) => [k.key, k]));
    expect(by["projects-on-time"]).toMatchObject({ condition: "at_risk", target: 0.85 });
    expect(by["reopened-work-rate"]).toMatchObject({ condition: "on_track", target: 0.05 });
    expect(by["client-site-uptime"]).toMatchObject({ condition: "unavailable", reason: "no_reader", value: null });
    expect(by["requests-within-sla"]).toMatchObject({ condition: "unavailable", reason: "no_target", target: null });
    expect(by["requests-within-sla"].value).not.toBeNull();
  });
  it("keeps the catalogue's order and percent fractions", () => {
    const j = get("", { unitNodeId: "dept-1", ...Q }).json as { kpis: Kpi[] };
    expect(j.kpis.map((k) => k.key)).toEqual(["projects-on-time", "requests-within-sla", "client-site-uptime", "reopened-work-rate"]);
    expect(j.kpis[0].value).toBeGreaterThan(0.8);
    expect(j.kpis[0].value).toBeLessThan(0.82);
  });
  it("applies a target only from its month: before July 2026 nothing is in force", () => {
    const j = get("", { unitNodeId: "dept-1", periodKind: "month", start: "2026-06-10" }).json as { kpis: Kpi[]; condition: string };
    expect(j.kpis.find((k) => k.key === "projects-on-time")).toMatchObject({ condition: "unavailable", reason: "no_target", target: null });
    expect(j.kpis.every((k) => k.condition === "unavailable")).toBe(true);
    expect(j.condition).toBe("unavailable");
  });
  it("requires unitNodeId (400), then 403 before it says whether a unit exists, then 404 for a company-wide caller", () => {
    expect(get("", Q).status).toBe(400);
    expect(get("", { unitNodeId: "dept-99", ...Q }, "dept-manager").status).toBe(403);
    expect(get("", { unitNodeId: "dept-99", ...Q }).status).toBe(404);
    expect(get("", { unitNodeId: "dept-99", ...Q }).json).toEqual({ error: "unit_not_found", field: "unitNodeId" });
  });
  it("lets staff read their own department only, and a head theirs", () => {
    expect(get("", { unitNodeId: "dept-1", ...Q }, "u-dev").status).toBe(200);
    expect(get("", { unitNodeId: "dept-3", ...Q }, "u-dev").status).toBe(403);
    expect(get("", { unitNodeId: "dept-3", ...Q }, "dept-manager").status).toBe(200);
    expect(get("", { unitNodeId: "dept-1", ...Q }, "dept-manager").status).toBe(403);
    expect(get("", { unitNodeId: "dept-1", ...Q }, "gede-ic").status).toBe(403);
    // DW-3k: the head of Web Dev reads Web Dev (at risk in the fixture) and no other department.
    const head = get("", { unitNodeId: "dept-1", ...Q }, "u-webhead");
    expect(head.status).toBe(200);
    expect((head.json as { condition: string }).condition).toBe("at_risk");
    expect(get("", { unitNodeId: "dept-3", ...Q }, "u-webhead").status).toBe(403);
  });
});

describe("GET dept-kpis/overview", () => {
  type Row = { unit: { id: string; name: string }; workspace: string; condition: string; kpis: Kpi[] };
  const rows = () => (get("/overview", Q).json as { period: unknown; departments: Row[] }).departments;
  it("lists the five departments worst first, unavailable last, then by name", () => {
    expect(rows().map((r) => [r.unit.name, r.condition])).toEqual([
      ["Creatives", "off_track"], ["Web Dev", "at_risk"], ["GM", "on_track"], ["SEO", "on_track"], ["Social Media", "unavailable"],
    ]);
  });
  it("has the §40 shape with the period and every department's KPIs", () => {
    const j = get("/overview", Q).json as { period: { periodKind: string; start: string; end: string }; departments: Row[] };
    expect(j.period.periodKind).toBe("month");
    expect(j.departments.map((d) => d.unit.id)).toEqual(["dept-2", "dept-1", "dept-5", "dept-3", "dept-4"]);
    for (const d of j.departments) {
      expect(typeof d.workspace).toBe("string");
      expect(d.kpis.length).toBeGreaterThan(0);
    }
  });
  it("matches the per-unit read for the same department", () => {
    for (const d of rows()) {
      const one = get("", { unitNodeId: d.unit.id, ...Q }).json as { condition: string; kpis: Kpi[]; workspace: string };
      expect(one.condition).toBe(d.condition);
      expect(one.kpis).toEqual(d.kpis);
      expect(one.workspace).toBe(d.workspace);
    }
  });
  it("covers all four conditions", () => {
    expect(new Set(rows().map((r) => r.condition))).toEqual(new Set(["off_track", "at_risk", "on_track", "unavailable"]));
  });
  it("is company-wide callers only", () => {
    expect(get("/overview", Q, "demo-hansel").status).toBe(200);
    expect(get("/overview", Q, "demo-owner").status).toBe(200);
    for (const u of ["dept-manager", "u-dev", "seo-staff", "gede-ic", "demo-client"]) expect(get("/overview", Q, u).status, u).toBe(403);
  });
  it("an approved proposal changes nothing until its month: approving Web Dev's next-month proposal leaves October as it was", () => {
    const before = rows().find((r) => r.unit.id === "dept-1")!.condition;
    const open = (get("/targets", { unitNodeId: "dept-1" }).json as { kpis: { proposals: { id: string }[] }[] }).kpis.flatMap((k) => k.proposals)[0];
    expect(post(`/targets/${open.id}/approve`, {}).status).toBe(200);
    expect(rows().find((r) => r.unit.id === "dept-1")!.condition).toBe(before);
  });
});

describe("GET dept-kpis/targets", () => {
  type TK = { key: string; suggestedTarget: number | null; inForce: { target: number } | null; proposals: { id: string; proposedBy: string; status: string }[]; history: unknown[] };
  const view = (user = "demo-hansel", unit = "dept-1") => get("/targets", { unitNodeId: unit }, user);
  it("has the §40.3a shape, with the suggested target on every KPI that has one", () => {
    const j = view().json as { unit: { id: string }; workspace: string; asOf: string; kpis: TK[] };
    expect(j.unit.id).toBe("dept-1");
    expect(j.asOf).toMatch(/^\d{4}-\d{2}-01$/);
    expect(j.kpis.find((k) => k.key === "projects-on-time")!.suggestedTarget).toBe(0.85);
    expect(j.kpis.find((k) => k.key === "projects-on-time")!.inForce!.target).toBe(0.85);
    expect(j.kpis.find((k) => k.key === "client-site-uptime")!.inForce).toBeNull();
  });
  it("holds one open proposal, by a head who is not a login, for next month", () => {
    const j = view().json as { kpis: TK[] };
    const open = j.kpis.flatMap((k) => k.proposals);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ proposedBy: "demo-head-webdev", status: "proposed" });
  });
  it("has no suggested target where the catalogue has none (assets-delivered)", () => {
    const j = view("demo-hansel", "dept-2").json as { kpis: TK[] };
    expect(j.kpis.find((k) => k.key === "assets-delivered")!.suggestedTarget).toBeNull();
  });
  it("gates like the unit read", () => {
    expect(view("u-dev").status).toBe(200);
    expect(view("seo-staff").status).toBe(403);
    expect(view("demo-hansel", "dept-99").status).toBe(404);
    expect(get("/targets", {}).status).toBe(400);
  });
});

describe("POST propose / approve / reject", () => {
  const next = nextMonthStart(new Date().toISOString().slice(0, 10));
  const body = { unitNodeId: "dept-3", kpiKey: "client-retention", effectiveFrom: next, target: 0.9, tolerance: 0.05 };
  const targetsOf = (unit: string) => (get("/targets", { unitNodeId: unit }).json as { kpis: { key: string; proposals: { id: string; proposedBy: string }[]; inForce: { target: number } | null; history: { status: string }[] }[] }).kpis;

  it("lets the head of the unit propose, and the proposal is listed with who proposed it", () => {
    const r = post("/targets", body, "dept-manager");
    expect(r.status).toBe(201);
    const j = r.json as { id: string; status: string };
    expect(j.status).toBe("proposed");
    expect(targetsOf("dept-3").find((k) => k.key === "client-retention")!.proposals).toEqual([expect.objectContaining({ id: j.id, proposedBy: "dept-manager" })]);
  });
  it("lets the company_admin tier propose for any unit, but not an owner, a head elsewhere or staff", () => {
    expect(post("/targets", body, "demo-hansel").status).toBe(201);
    for (const u of ["demo-owner", "u-dev", "seo-staff", "gede-ic"]) expect(post("/targets", body, u).status, u).toBe(403);
    expect(post("/targets", { ...body, unitNodeId: "dept-1", kpiKey: "projects-on-time" }, "dept-manager").status).toBe(403);
  });
  it("authorizes before it validates (a refusal is 403 whatever the body)", () => {
    expect(post("/targets", { unitNodeId: "dept-1", effectiveFrom: "nope" }, "u-dev").status).toBe(403);
  });
  it("validates: month start 400, negative tolerance 400, unknown unit 404, KPI outside the unit's set 400, percent range 400", () => {
    expect(post("/targets", { ...body, effectiveFrom: `${next.slice(0, 8)}02` }).status).toBe(400);
    expect(post("/targets", { ...body, tolerance: -0.1 }).status).toBe(400);
    expect(post("/targets", { ...body, unitNodeId: "dept-99" }).status).toBe(404);
    expect(post("/targets", { ...body, kpiKey: "projects-on-time" }).status).toBe(400);
    expect(post("/targets", { ...body, target: 85 }).status).toBe(400);
    expect(post("/targets", { ...body, target: 85 }).json).toMatchObject({ field: "target" });
  });

  it("lets the approver approve a head's proposal, which supersedes an approved row from the same month on", () => {
    const open = targetsOf("dept-1").flatMap((k) => k.proposals)[0];
    const r = post(`/targets/${open.id}/approve`, {});
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: open.id, status: "approved", decidedBy: "demo-hansel", superseded: [] });
    const sla = targetsOf("dept-1").find((k) => k.key === "requests-within-sla")!;
    expect(sla.proposals).toEqual([]);
    // a second proposal from an earlier month leaves the first approved row alone; one from the same month supersedes it
    const a = post("/targets", { unitNodeId: "dept-1", kpiKey: "requests-within-sla", effectiveFrom: next, target: 0.95, tolerance: 0.03 }, "dept-manager");
    expect(a.status).toBe(403); // dept-manager does not lead dept-1
    const b = post("/targets", { unitNodeId: "dept-1", kpiKey: "requests-within-sla", effectiveFrom: next, target: 0.95, tolerance: 0.03 }, "demo-hansel");
    const bid = (b.json as { id: string }).id;
    expect(post(`/targets/${bid}/approve`, {}, "demo-owner").json).toMatchObject({ status: "approved", superseded: [open.id] });
  });
  it("refuses a proposer approving or rejecting their own proposal with 409 cannot_approve_own_proposal", () => {
    const mine = (post("/targets", { ...body, unitNodeId: "dept-1", kpiKey: "client-site-uptime" }, "demo-hansel").json as { id: string }).id;
    for (const verb of ["approve", "reject"]) {
      const r = post(`/targets/${mine}/${verb}`, {}, "demo-hansel");
      expect(r.status).toBe(409);
      expect(r.json).toEqual({ error: "cannot_approve_own_proposal" });
    }
  });
  it("refuses a head who is not the approver (403), even for another person's proposal", () => {
    const open = targetsOf("dept-1").flatMap((k) => k.proposals)[0];
    expect(post(`/targets/${open.id}/approve`, {}, "dept-manager").status).toBe(403);
    expect(post(`/targets/${open.id}/approve`, {}, "u-dev").status).toBe(403);
  });
  it("rejects a proposal, and a decided one cannot be decided again (409 not_proposed)", () => {
    const open = targetsOf("dept-1").flatMap((k) => k.proposals)[0];
    expect(post(`/targets/${open.id}/reject`, { note: "not this quarter" }).json).toMatchObject({ status: "rejected" });
    const again = post(`/targets/${open.id}/approve`, {});
    expect(again.status).toBe(409);
    expect(again.json).toEqual({ error: "not_proposed" });
    expect(targetsOf("dept-1").find((k) => k.key === "requests-within-sla")!.history.map((h) => h.status)).toEqual(["rejected"]);
  });
  it("404s an unknown proposal", () => {
    expect(post("/targets/demo-dkt-9999/approve", {}).status).toBe(404);
  });
  it("answers an unknown dept-kpis route with 404, not an empty 200", () => {
    expect(get("/nothing", {}).status).toBe(404);
  });
});
