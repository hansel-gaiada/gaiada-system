import { describe, it, expect } from "vitest";
import { gateAllows, resolveMyWorkspaces, routeActionsFor, type GateContext } from "./workspaceAccess";
import { buildShellModel } from "./shellModel";
import { selectBands, selectQuickActions, subjectOfRef } from "./overview";
import { agencyTree, HOTEL, me as meFixture, member, node, person } from "./workspaceFixtures";
import { GENERIC_WORKSPACE } from "./workspaces";
import type { RequestRoute } from "./requests";

// DW-10e (BFF §60.9): the shell reads the company's routes once, and a new gate, `hasRoutes`, reads them. The pack gate widens and nothing
// else does: the requests surfaces (the Overview's Requests block, Requests › Sent) are the agency pack's OR a company with routes, and the
// requesting company need not be agency-pack. Unknown or a failed read hides, like `hasWorkspace`.
const route = (over: Partial<RequestRoute> = {}): RequestRoute => ({
  routeId: "5a0c0000-0000-4000-8000-000000000001", kind: "assets", company: { id: "co-a", name: "Gaia Digital Agency" }, unit: { name: "Creatives" }, ...over,
});
const ROUTES: RequestRoute[] = [route(), route({ routeId: "5a0c0000-0000-4000-8000-000000000002", kind: "engineering", unit: { name: "Web Dev" } })];

const hotelMember = meFixture([member("co-h")], [HOTEL]);
const hotelViewer = meFixture([{ role: "viewer", scopeType: "company", scopeId: "co-h" }], [HOTEL]);
/** Viceroy-like: a hospitality company, a Front Office department with the person in it (no bespoke workspace: the generic one). */
const hotelTree = () => node("root", "Hotel", "company", [node("d-fo", "Front Office", "department", [person("p-1", "u-1")])]);
const hotelWs = (m = hotelMember) => resolveMyWorkspaces({ me: m, tenantId: "co-h", root: hotelTree() });
const agencyWs = () => resolveMyWorkspaces({ me: meFixture([member()]), tenantId: "co-a", root: agencyTree({ web: ["u-1"] }) });

const ctxOf = (routes: GateContext["routes"], m = hotelMember): GateContext => ({ me: m, tenantId: "co-h", unitPath: [], routes });

describe("the hasRoutes gate", () => {
  it("allows when the company has a route, of the kind asked when one is given", () => {
    expect(gateAllows({ kind: "hasRoutes" }, ctxOf(ROUTES))).toBe(true);
    expect(gateAllows({ kind: "hasRoutes", routeKind: "assets" }, ctxOf(ROUTES))).toBe(true);
    expect(gateAllows({ kind: "hasRoutes", routeKind: "engineering" }, ctxOf([route()]))).toBe(false);
    expect(gateAllows({ kind: "hasRoutes", routeKind: "engineering" }, ctxOf(ROUTES))).toBe(true);
  });

  it("hides when the routes are unknown (not read), failed (null) or empty, like hasWorkspace", () => {
    expect(gateAllows({ kind: "hasRoutes" }, ctxOf(undefined))).toBe(false);
    expect(gateAllows({ kind: "hasRoutes" }, ctxOf(null))).toBe(false);
    expect(gateAllows({ kind: "hasRoutes" }, ctxOf([]))).toBe(false);
    expect(gateAllows({ kind: "hasRoutes", routeKind: "assets" }, ctxOf(undefined))).toBe(false);
  });
});

describe("the Overview's Requests block", () => {
  const requestsBlock = (ws: ReturnType<typeof hotelWs>, tenantId: string, m: typeof hotelMember, routes: GateContext["routes"]) => {
    const subject = { ...subjectOfRef(ws.mine[0], {}, ws), routes };
    const ctx = { me: m, tenantId, unitPath: subject.unitPath, workspaces: subject.workspaces, routes: subject.routes };
    return selectBands(subject.widgets, ctx).flatMap((b) => b.widgets).some((w) => w.key === "requests");
  };

  it("is placed for a non-agency company only when it has routes", () => {
    const ws = hotelWs();
    expect(ws.mine[0].workspace.key).toBe("generic");
    expect(requestsBlock(ws, "co-h", hotelMember, ROUTES)).toBe(true);
    expect(requestsBlock(ws, "co-h", hotelMember, undefined)).toBe(false);
    expect(requestsBlock(ws, "co-h", hotelMember, null)).toBe(false);
    expect(requestsBlock(ws, "co-h", hotelMember, [])).toBe(false);
  });

  it("is placed for the agency pack with or without routes (the pack gate is unchanged)", () => {
    const m = meFixture([member()]);
    expect(requestsBlock(agencyWs(), "co-a", m, undefined)).toBe(true);
    expect(requestsBlock(agencyWs(), "co-a", m, null)).toBe(true);
  });
});

describe("Requests › Sent in the generic workspace", () => {
  const workRows = (routes: GateContext["routes"], m = hotelMember) =>
    buildShellModel({ me: m, tenantId: "co-h", workspaces: hotelWs(m), approvals: { pending: 0 }, routes }).workspaces.find((w) => w.id === "d-fo")!.rows.work.map((r) => r.key);

  it("has the Requests row for a company with routes, and no row for one without (or when the read failed)", () => {
    expect(workRows(ROUTES)).toContain("requests");
    expect(workRows(undefined)).not.toContain("requests");
    expect(workRows(null)).not.toContain("requests");
    expect(workRows([])).not.toContain("requests");
  });

  it("draws the Sent tab alone, at the department's own address", () => {
    const m = buildShellModel({ me: hotelMember, tenantId: "co-h", workspaces: hotelWs(), approvals: { pending: 0 }, routes: ROUTES });
    const row = m.workspaces.find((w) => w.id === "d-fo")!.rows.work.find((r) => r.key === "requests")!;
    expect(row.tabs.map((t) => [t.label, t.href])).toEqual([["Sent", "/departments/d-fo/requests/sent"]]);
  });

  it("is a registry fact: the generic workspace has it, gated by routes", () => {
    const row = GENERIC_WORKSPACE.work.find((r) => r.key === "requests")!;
    expect(row.gate).toEqual({ kind: "hasRoutes" });
  });

  it("does not change the agency pack's rows", () => {
    const rows = buildShellModel({ me: meFixture([member()]), tenantId: "co-a", workspaces: agencyWs(), approvals: { pending: 0 } })
      .workspaces.find((w) => w.id === "d-web")!.rows.work.map((r) => r.key);
    expect(rows).toContain("requests");
  });
});

describe("one quick action per active route (§60.9)", () => {
  it("is 'Ask <unit> at <company> for assets' and 'Ask <unit> at <company>', each linking to the form with the route", () => {
    expect(routeActionsFor({ me: hotelMember, tenantId: "co-h", routes: ROUTES })).toEqual([
      { key: "ask-route-5a0c0000-0000-4000-8000-000000000001", label: "Ask Creatives at Gaia Digital Agency for assets", href: "/requests/new?route=5a0c0000-0000-4000-8000-000000000001" },
      { key: "ask-route-5a0c0000-0000-4000-8000-000000000002", label: "Ask Web Dev at Gaia Digital Agency", href: "/requests/new?route=5a0c0000-0000-4000-8000-000000000002" },
    ]);
  });

  it("is offered only to a person who may send across (the mirror of PERMISSION-CONTRACT §49), and only for routes that were read", () => {
    expect(routeActionsFor({ me: hotelViewer, tenantId: "co-h", routes: ROUTES })).toEqual([]);
    expect(routeActionsFor({ me: hotelMember, tenantId: "co-h", routes: undefined })).toEqual([]);
    expect(routeActionsFor({ me: hotelMember, tenantId: "co-h", routes: null })).toEqual([]);
    expect(routeActionsFor({ me: hotelMember, tenantId: "co-h", routes: [] })).toEqual([]);
  });

  it("appears in the header's quick actions beside the same-company ones, and in the sidebar's '+ New'", () => {
    const ws = hotelWs();
    const ctx = { ...ctxOf(ROUTES), deptId: "d-fo", unitPath: ["d-fo", "root"] };
    expect(selectQuickActions(GENERIC_WORKSPACE.quickActions, ctx).map((a) => a.label)).toEqual([
      "New task", "Ask Creatives at Gaia Digital Agency for assets", "Ask Web Dev at Gaia Digital Agency",
    ]);
    const creates = buildShellModel({ me: hotelMember, tenantId: "co-h", workspaces: ws, approvals: { pending: 0 }, routes: ROUTES })
      .workspaces.find((w) => w.id === "d-fo")!.creates.map((c) => c.label);
    expect(creates).toEqual(["New task", "Ask Creatives at Gaia Digital Agency for assets", "Ask Web Dev at Gaia Digital Agency"]);
  });

  it("is not there without routes: the header and '+ New' are as they were", () => {
    const ctx = { ...ctxOf(undefined), deptId: "d-fo", unitPath: ["d-fo", "root"] };
    expect(selectQuickActions(GENERIC_WORKSPACE.quickActions, ctx).map((a) => a.label)).toEqual(["New task"]);
    const creates = buildShellModel({ me: hotelMember, tenantId: "co-h", workspaces: hotelWs(), approvals: { pending: 0 } }).workspaces.find((w) => w.id === "d-fo")!.creates;
    expect(creates.map((c) => c.label)).toEqual(["New task"]);
  });
});
