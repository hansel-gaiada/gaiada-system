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

// DW-4j-2 — the KPI alerts in the demo (BFF §43.5, §43.6a). The fixture must model the server's reads, gates and 409s, and its open alert must be on a KPI
// that is really off track in the fixture above.
describe("GET dept-kpis/alerts (the caller's own: Needs you)", () => {
  type A = { id: string; kpiKey: string; unit: { id: string }; resolvedAt: string | null; acknowledgedAt: string | null };
  const mine = (user: string) => (get("/alerts", {}, user).json as { alerts: A[] }).alerts;

  it("is empty for the head of Web Dev, who has no open alert: that is true, and honest", () => {
    expect(get("/alerts", {}, "u-webhead").status).toBe(200);
    expect(mine("u-webhead")).toEqual([]);
  });
  it("is empty for the company-wide tiers and for everyone who heads no unit (the list is personal, §43.5)", () => {
    for (const u of ["demo-hansel", "demo-owner", "dept-manager", "u-dev", "gede-ic"]) expect(mine(u)).toEqual([]);
  });
  it("has the one open alert on Creatives, whom no demo user heads, so no demo user's Needs you shows it", () => {
    const open = (get("/alerts", { unitNodeId: "dept-2" }).json as { alerts: A[] }).alerts.filter((a) => !a.resolvedAt && !a.acknowledgedAt);
    expect(open).toHaveLength(1);
    expect(mine("dept-manager")).toEqual([]);
  });
});

describe("GET dept-kpis/alerts?unitNodeId= (one unit's history)", () => {
  type A = { id: string; kpiKey: string; kpiLabel: string; kpiUnit: string | null; unit: { id: string; name: string }; openedAt: string; value: number | null; target: number | null;
    acknowledgedBy: string | null; acknowledgedByName: string | null; acknowledgedAt: string | null; ackNote: string | null; resolvedAt: string | null; resolvedCondition: string | null };
  const hist = (unit: string, user = "demo-hansel") => (get("/alerts", { unitNodeId: unit }, user).json as { alerts: A[] }).alerts;

  it("gives Creatives an OPEN alert on a KPI that is off track in the fixture, with the reading the tile shows", () => {
    const open = hist("dept-2").filter((a) => !a.resolvedAt);
    expect(open).toHaveLength(1);
    const view = get("", { unitNodeId: "dept-2", ...Q }).json as { kpis: Kpi[] };
    const k = view.kpis.find((x) => x.key === open[0].kpiKey)!;
    expect(k.condition).toBe("off_track");
    expect(open[0]).toMatchObject({ unit: { id: "dept-2", name: "Creatives" }, kpiLabel: "Asset requests delivered on time", kpiUnit: "percent", value: k.value, target: k.target, acknowledgedAt: null });
    expect(open[0].openedAt.slice(0, 10)).toBe("2026-10-03");
  });
  it("gives Web Dev history for its head: one alert resolved as back on track after an acknowledgement with a note, one resolved as unavailable that nobody acknowledged", () => {
    const rows = hist("dept-1", "u-webhead");
    expect(rows.map((a) => a.kpiKey)).toEqual(["client-site-uptime", "projects-on-time"]); // newest opened first
    expect(rows.every((a) => a.resolvedAt)).toBe(true); // Web Dev has no off-track KPI, so nothing of it is open
    expect(rows[1]).toMatchObject({ acknowledgedBy: "u-webhead", acknowledgedByName: "Ketut Arta", resolvedCondition: "on_track" });
    expect(rows[1].ackNote).toBeTruthy();
    expect(rows[0]).toMatchObject({ acknowledgedBy: null, acknowledgedByName: null, acknowledgedAt: null, ackNote: null, resolvedCondition: "unavailable" });
  });
  it("returns an ok with no rows for a unit with no alerts yet", () => {
    expect(get("/alerts", { unitNodeId: "dept-3" }).json).toEqual({ alerts: [] });
  });
  it("applies the unit read's gate: 400 for an empty id, 403 before any word on whether the unit exists, then 404", () => {
    expect(get("/alerts", { unitNodeId: "" }).status).toBe(400);
    expect(get("/alerts", { unitNodeId: "dept-99" }, "dept-manager").status).toBe(403);
    expect(get("/alerts", { unitNodeId: "dept-99" }).status).toBe(404);
    expect(get("/alerts", { unitNodeId: "dept-99" }).json).toEqual({ error: "unit_not_found", field: "unitNodeId" });
    expect(get("/alerts", { unitNodeId: "dept-1" }, "dept-manager").status).toBe(403);
    expect(get("/alerts", { unitNodeId: "dept-1" }, "u-dev").status).toBe(200); // staff of the unit read it, as the unit read allows
    expect(get("/alerts", { unitNodeId: "dept-2" }, "u-dev").status).toBe(403);
  });
  it("is reached through getDemoResponse", () => {
    const r = getDemoResponse("GET", `${base}/alerts?unitNodeId=dept-2`, "demo-hansel");
    expect(r.status).toBe(200);
    expect((r.json as { alerts: unknown[] }).alerts).toHaveLength(1);
  });
});

describe("POST dept-kpis/alerts/:id/acknowledge", () => {
  const ackPath = (id: string) => `/alerts/${id}/acknowledge`;
  const creatives = () => ((get("/alerts", { unitNodeId: "dept-2" }).json as { alerts: Array<{ id: string }> }).alerts[0].id);

  it("records who, when and the trimmed note, returns the alert row, and the alert stays open", () => {
    const id = creatives();
    const r = post(ackPath(id), { note: "  Seen, vendor chased.  " }, "demo-hansel");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id, acknowledgedBy: "demo-hansel", acknowledgedByName: "Hansel", ackNote: "Seen, vendor chased.", resolvedAt: null });
    expect((r.json as { acknowledgedAt: string }).acknowledgedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const after = (get("/alerts", { unitNodeId: "dept-2" }).json as { alerts: Array<{ id: string; acknowledgedAt: string | null; resolvedAt: string | null }> }).alerts[0];
    expect(after).toMatchObject({ id, resolvedAt: null });
    expect(after.acknowledgedAt).not.toBeNull();
  });
  it("stores no note for an empty one and accepts a missing note", () => {
    expect((post(ackPath(creatives()), { note: "   " }, "demo-owner").json as { ackNote: string | null }).ackNote).toBeNull();
    resetDeptKpiDemo();
    expect(post(ackPath(creatives()), {}, "demo-owner").status).toBe(200);
  });
  it("409 already_acknowledged the second time", () => {
    const id = creatives();
    expect(post(ackPath(id), {}).status).toBe(200);
    const again = post(ackPath(id), {});
    expect(again.status).toBe(409);
    expect(again.json).toEqual({ error: "already_acknowledged" });
  });
  it("409 resolved for a resolved alert, acknowledged or not (checked before already_acknowledged)", () => {
    const rows = (get("/alerts", { unitNodeId: "dept-1" }).json as { alerts: Array<{ id: string; kpiKey: string }> }).alerts;
    const acknowledgedAndResolved = rows.find((a) => a.kpiKey === "projects-on-time")!;
    const unacknowledgedResolved = rows.find((a) => a.kpiKey === "client-site-uptime")!;
    expect(post(ackPath(acknowledgedAndResolved.id), {}, "u-webhead")).toEqual({ status: 409, json: { error: "resolved" } });
    expect(post(ackPath(unacknowledgedResolved.id), {}, "u-webhead")).toEqual({ status: 409, json: { error: "resolved" } });
  });
  it("404 alert_not_found for an unknown id", () => {
    expect(post(ackPath("nope"), {})).toEqual({ status: 404, json: { error: "alert_not_found", field: "id" } });
  });
  it("403 for anyone who does not head the alert's unit and is not company-wide, before any 409", () => {
    const id = creatives();
    for (const u of ["u-webhead", "dept-manager", "u-dev", "gede-ic"]) {
      const r = post(ackPath(id), {}, u);
      expect(r.status).toBe(403);
      expect(r.json).toEqual({ error: "outside your reporting line" });
    }
    // and still open: a refusal changed nothing
    expect((get("/alerts", { unitNodeId: "dept-2" }).json as { alerts: Array<{ acknowledgedAt: string | null }> }).alerts[0].acknowledgedAt).toBeNull();
  });
  it("400 on a note that is too long or not a string, only after the 403 and the 409", () => {
    const id = creatives();
    expect(post(ackPath(id), { note: "x".repeat(1001) }).status).toBe(400);
    expect(post(ackPath(id), { note: "x".repeat(1001) }).json).toEqual({ error: "note must be a string of at most 1000 characters", field: "note" });
    expect(post(ackPath(id), { note: 5 }).status).toBe(400);
    expect(post(ackPath(id), { note: "x".repeat(1001) }, "u-dev").status).toBe(403);
    expect(post(ackPath(id), { note: "x".repeat(1000) }).status).toBe(200); // exactly 1000 is allowed
    expect(post(ackPath(id), { note: "x".repeat(1001) }).status).toBe(409);
  });
  it("is reset by resetDeptKpiDemo", () => {
    const id = creatives();
    post(ackPath(id), {});
    resetDeptKpiDemo();
    expect(post(ackPath(id), {}).status).toBe(200);
  });
});

// DW-4j-3 — "behind the miss" (BFF §43.8a). The gate is the head-only unit read's; the payloads are the two KPIs in trouble above.
describe("GET dept-kpis/drivers", () => {
  type D = { kind: string; id: string; name: string; value: number; numerator?: number; denominator?: number };
  type View = { kpi: { key: string; label: string; unit: string; direction: string }; period: { periodKind: string; start: string; end: string }; drivers: D[] | null; reason?: string };
  const drivers = (unit: string, kpi: string, user = "demo-hansel", extra: Record<string, string> = {}) =>
    get("/drivers", { unitNodeId: unit, kpiKey: kpi, ...Q, ...extra }, user);

  it("gives Web Dev's at-risk 'Projects on time' two projects, worst first, that add up to the department's four misses", () => {
    const r = drivers("dept-1", "projects-on-time");
    expect(r.status).toBe(200);
    const j = r.json as View;
    expect(j.kpi).toEqual({ key: "projects-on-time", label: "Projects on time", unit: "percent", direction: "up_good" });
    expect(j.period).toEqual({ periodKind: "month", start: "2026-10-01", end: "2026-10-31" });
    expect(j.reason).toBeUndefined();
    expect(j.drivers!.map((d) => [d.kind, d.name, d.numerator, d.denominator])).toEqual([
      ["project", "Client site redesign", 3, 5],
      ["project", "Mobile app revamp", 4, 6],
    ]);
    expect(j.drivers![0].value).toBeLessThan(j.drivers![1].value); // up-is-good: the lowest first
    expect(j.drivers!.reduce((n, d) => n + (d.denominator! - d.numerator!), 0)).toBe(4); // 21 due - 17 hit
  });
  it("never shows what the server cannot answer: Creatives' off-track module KPI has no breakdown (no_drivers), though it is off track in the unit read", () => {
    const j = drivers("dept-2", "asset-requests-on-time").json as View;
    expect(j.drivers).toBeNull();
    expect(j.reason).toBe("no_drivers");
    const view = get("", { unitNodeId: "dept-2", ...Q }).json as { kpis: Kpi[] };
    expect(view.kpis.find((k) => k.key === "asset-requests-on-time")!.condition).toBe("off_track");
  });
  it("has drivers only for the report-fact KPIs that have them: Web Dev's projects on time and reopened work, nothing else", () => {
    for (const unit of ["dept-1", "dept-2", "dept-3", "dept-4", "dept-5"]) {
      const kpis = (get("", { unitNodeId: unit, ...Q }).json as { kpis: Kpi[] }).kpis;
      for (const k of kpis) {
        const j = drivers(unit, k.key).json as View;
        const expected = unit === "dept-1" && (k.key === "projects-on-time" || k.key === "reopened-work-rate");
        expect(Array.isArray(j.drivers), `${unit} ${k.key}`).toBe(expected);
      }
    }
    const reopened = (drivers("dept-1", "reopened-work-rate").json as View).drivers!;
    expect(reopened.map((d) => [d.kind, d.id])).toEqual([["person", "u-dev"]]);
  });
  it("answers a module KPI with no_reader and a KPI that has a reader and no breakdown with no_drivers; both have drivers null", () => {
    expect(drivers("dept-1", "client-site-uptime").json).toMatchObject({ drivers: null, reason: "no_reader" });
    expect(drivers("dept-2", "assets-delivered").json).toMatchObject({ drivers: null, reason: "no_reader" });
    expect(drivers("dept-1", "requests-within-sla").json).toMatchObject({ drivers: null, reason: "no_drivers" });
    expect(drivers("dept-5", "utilization").json).toMatchObject({ drivers: null, reason: "no_drivers" });
    expect(drivers("dept-5", "departments-in-good-condition").json).toMatchObject({ drivers: null, reason: "no_drivers" });
    expect(drivers("dept-3", "client-reports-on-time").json).toMatchObject({ drivers: null, reason: "no_drivers" });
  });
  it("is for the company-wide demo users and the unit's own head only", () => {
    expect(drivers("dept-1", "projects-on-time", "demo-hansel").status).toBe(200);
    expect(drivers("dept-1", "projects-on-time", "demo-owner").status).toBe(200);
    expect(drivers("dept-1", "projects-on-time", "u-webhead").status).toBe(200);
    expect(drivers("dept-3", "client-reports-on-time", "dept-manager").status).toBe(200);
  });
  it("is 403 for a unit's placed staff, another unit's head and anyone else: they never see a ranking", () => {
    for (const [u, unit] of [["u-dev", "dept-1"], ["seo-staff", "dept-3"], ["dept-manager", "dept-1"], ["u-webhead", "dept-2"], ["gede-ic", "dept-1"]]) {
      const r = drivers(unit, "projects-on-time", u);
      expect(r.status).toBe(403);
      expect(r.json).toEqual({ error: "outside your reporting line" });
    }
  });
  it("has the server's order of checks: parameters 400, then the period 400, then 403 before any word on the unit, then 404, then a KPI outside the set 400", () => {
    expect(get("/drivers", { kpiKey: "projects-on-time", ...Q }).json).toEqual({ error: "unitNodeId is required", field: "unitNodeId" });
    expect(get("/drivers", { unitNodeId: "dept-1", ...Q }).json).toEqual({ error: "kpiKey is required", field: "kpiKey" });
    expect(get("/drivers", { unitNodeId: "dept-1", kpiKey: "projects-on-time", start: "2026-10-14" }).json).toMatchObject({ field: "periodKind" });
    expect(get("/drivers", { unitNodeId: "dept-1", kpiKey: "projects-on-time", periodKind: "month" }).json).toMatchObject({ field: "start" });
    expect(get("/drivers", { unitNodeId: "dept-1", kpiKey: "projects-on-time", periodKind: "custom", start: "2026-10-01" }).json).toMatchObject({ field: "end" });
    // a bad parameter is 400 even for a caller who would be refused: there is no unit to authorize yet
    expect(drivers("dept-1", "projects-on-time", "u-dev", { start: "yesterday" }).status).toBe(400);
    expect(drivers("dept-99", "projects-on-time", "dept-manager").status).toBe(403);
    expect(drivers("dept-99", "projects-on-time").json).toEqual({ error: "unit_not_found", field: "unitNodeId" });
    expect(drivers("dept-1", "no-such-kpi").json).toMatchObject({ field: "kpiKey" });
    expect(drivers("dept-1", "no-such-kpi").status).toBe(400);
  });
  it("carries a week period as the unit read does (the digest's link)", () => {
    const j = drivers("dept-1", "projects-on-time", "demo-hansel", { periodKind: "week", start: "2026-10-05" }).json as View;
    expect(j.period).toMatchObject({ periodKind: "week", start: "2026-10-05" });
  });
  it("changes no condition, value, lead or target: the unit read is as before, and the route is reached through getDemoResponse", () => {
    const j = get("", { unitNodeId: "dept-1", ...Q }).json as { condition: string; kpis: Kpi[] };
    expect(j.condition).toBe("at_risk");
    const r = getDemoResponse("GET", `${base}/drivers?unitNodeId=dept-1&kpiKey=projects-on-time&periodKind=month&start=2026-10-14`, "demo-hansel");
    expect(r.status).toBe(200);
    expect((r.json as View).drivers).toHaveLength(2);
  });
});
