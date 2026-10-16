import { describe, it, expect } from "vitest";
import type { Me } from "./platform";
import { GENERIC_WORKSPACE, isPlanned, sidebarRows, workspaceBySlug } from "./workspaces";
import { resolveMyWorkspaces, type OrgTreeNode } from "./workspaceAccess";
import { activeLocation, allRows, buildShellModel, overviewHref, workspaceForArea, type ShellModel, type ShellWorkspace } from "./shellModel";
import { HOTEL, agencyTree, me, member, node, person, type Company } from "./workspaceFixtures";

/** A root company of the agency vertical, so its owner has an Office of the GM to land in. */
const AGENCY_ROOT: Company = { id: "co-root", name: "Group", type: null, vertical: "agency", rootCompanyId: "co-root" };

function model(m: Me, tenantId: string, root: OrgTreeNode | null): ShellModel {
  return buildShellModel({ me: m, tenantId, workspaces: resolveMyWorkspaces({ me: m, tenantId, root }) });
}
const keys = (rows: { key: string }[]) => rows.map((r) => r.key);
const byId = (mod: ShellModel, id: string) => mod.workspaces.find((w) => w.id === id)!;

/** Every rendered row and tab must be a built registry item: nothing with a ticket, nothing unfilled. */
function expectNothingPlanned(ws: ShellWorkspace) {
  const reg = sidebarRows(workspaceBySlug(ws.key) ?? GENERIC_WORKSPACE);
  const regRows = [...reg.top, ...reg.work, ...reg.performance, ...reg.you];
  for (const row of allRows(ws)) {
    const r = regRows.find((x) => x.key === row.key)!;
    expect(r, `${ws.id}/${row.key}`).toBeDefined();
    expect(isPlanned(r), `${ws.id}/${row.key}`).toBe(false);
    for (const tab of row.tabs) {
      const t = r.tabs.find((x) => x.key === tab.key)!;
      expect(isPlanned(t), `${ws.id}/${row.key}/${tab.key}`).toBe(false);
      expect(tab.href, `${ws.id}/${row.key}/${tab.key}`).not.toMatch(/[{}]/);
    }
  }
}

describe("buildShellModel: a placed Web Dev employee in an agency company", () => {
  const mod = model(me([member()]), "co-a", agencyTree({ web: ["u-1"] }));
  const web = byId(mod, "d-web");

  it("lists their own workspace first, then every other department once", () => {
    expect(mod.workspaces.map((w) => w.id)).toEqual(["d-web", "d-gm", "d-seo", "slug:hr", "slug:it", "slug:finance"]);
    expect(mod.workspaces.map((w) => w.mine)).toEqual([true, false, false, false, false, false]);
    expect(web).toMatchObject({ key: "web-dev", label: "Web Dev", kind: "department", deptId: "d-web", home: true, lead: false });
  });

  it("offers its own create action first, made concrete (DW-2f)", () => {
    // The gate-free "prd" action, with {dept} filled from the fixture's department id d-web.
    expect(web.creates).toEqual([{ label: "New briefing", href: "/departments/d-web/prd" }]);
  });

  it("draws the four blocks of the Web Dev sidebar (plan §2.2)", () => {
    expect(keys(web.rows.top)).toEqual(["overview", "assistant"]);
    expect(keys(web.rows.work)).toEqual(["pm", "build", "run", "website", "requests", "campaigns", "clients", "tools"]);
    expect(keys(web.rows.performance)).toEqual(["performance", "reports", "analytics", "appraisals", "learning"]);
    expect(keys(web.rows.you)).toEqual(["tasks", "inbox", "calendar", "approvals", "me"]);
    expect(overviewHref(web)).toBe("/departments/d-web");
  });

  it("renders nothing planned, in any workspace", () => {
    for (const ws of mod.workspaces) expectNothingPlanned(ws);
  });

  it("gives each workspace its own department id and gates (another department's rows are its own)", () => {
    const seo = byId(mod, "d-seo");
    expect(overviewHref(seo)).toBe("/departments/d-seo");
    expect(allRows(seo).flatMap((r) => r.tabs.map((t) => t.href)).filter((h) => h.startsWith("/departments/"))
      .every((h) => h.startsWith("/departments/d-seo"))).toBe(true);
  });

  it("offers the Company rows with their gates, and no Admin row without admin.access", () => {
    expect(keys(mod.company)).toEqual(expect.arrayContaining(["departments", "organization", "projects", "clients", "campaigns"]));
    expect(mod.admin).toEqual([]);
  });

  it("homes them in Web Dev", () => {
    expect(mod.home).toEqual({ kind: "workspace", deptId: "d-web" });
    expect(mod.homeLabel).toBe("Web Dev");
    expect(mod.homeHref).toBe("/departments/d-web");
  });

  it("is plain data that survives the trip to the client", () => {
    expect(JSON.parse(JSON.stringify(mod))).toEqual(mod);
  });
});

describe("buildShellModel: an unplaced root owner", () => {
  const owner = me([{ role: "owner", scopeType: "company", scopeId: "co-root" }], [AGENCY_ROOT]);
  const mod = model(owner, "co-root", agencyTree());

  it("homes them in the Office of the GM", () => {
    expect(mod.workspaces[0]).toMatchObject({ id: "d-gm", key: "gm", kind: "office", mine: true, home: true });
    expect(mod.home).toEqual({ kind: "workspace", deptId: "d-gm" });
    expect(mod.homeLabel).toBe("Office of the GM");
    expect(keys(mod.workspaces[0].rows.work)).toEqual(expect.arrayContaining(["command", "oversight"]));
  });

  it("offers Settings and Group by their own gates, and Platform only to the operator root's owner (PV-D31)", () => {
    expect(keys(mod.admin)).toEqual(["settings", "group"]);
    const operatorOwner = me([{ role: "owner", scopeType: "company", scopeId: "co-root" }], [{ ...AGENCY_ROOT, isOperatorRoot: true }]);
    expect(keys(model(operatorOwner, "co-root", agencyTree()).admin)).toEqual(["settings", "group", "platform"]);
  });

  it("gives the Office of the GM no create action (DW-2f)", () => {
    expect(mod.workspaces[0].creates).toEqual([]);
  });

  it("lists the GM once, as theirs", () => {
    expect(mod.workspaces.filter((w) => w.key === "gm")).toHaveLength(1);
  });
});

describe("buildShellModel: HR staff with no HR node in the org tree", () => {
  const hrStaff = me([member(), { role: "hr_staff", scopeType: "company", scopeId: "co-a" }]);
  const mod = model(hrStaff, "co-a", agencyTree());
  const hr = mod.workspaces[0];

  it("homes them in the functional HR workspace, keyed by slug", () => {
    expect(hr).toMatchObject({ id: "slug:hr", key: "hr", kind: "functional", deptId: null, mine: true, home: true });
    expect(mod.home).toEqual({ kind: "workspace", slug: "hr" });
    expect(mod.homeHref).toBe("/hr");
  });

  it("leaves out every row that needs a department id", () => {
    expect(keys(hr.rows.work)).not.toContain("pm");
    expect(keys(hr.rows.work)).not.toContain("tools");
    // Analytics keeps HR's own tab and My activity (DW-4i: it needs no department), and loses the {dept} Work and Team activity tabs.
    expect(hr.rows.performance.find((r) => r.key === "analytics")?.tabs.map((t) => t.href)).toEqual(["/analytics/activity", "/hr/analytics"]);
    expectNothingPlanned(hr);
  });

  it("offers HR's New hire only if its gate allows it (gate: module hr, HR_ON)", () => {
    // The agency fixture company has no enabledModules, so moduleOn("hr") is true and the action is offered.
    expect(hr.creates).toEqual([{ label: "New hire", href: "/hr/onboarding" }]);
  });

  it("does not list HR a second time among the departments", () => {
    expect(mod.workspaces.filter((w) => w.key === "hr")).toHaveLength(1);
  });
});

describe("buildShellModel: a generic-pack company", () => {
  const tree = node("root", "Hotel", "company", [node("d-gm", "GM", "department"), node("d-hk", "Housekeeping", "department", [person("p", "u-1")])]);
  const mod = model(me([member("co-h")], [HOTEL]), "co-h", tree);
  const hk = mod.workspaces[0];

  it("gives the department the generic workspace under its own name", () => {
    expect(hk).toMatchObject({ id: "d-hk", key: "generic", label: "Housekeeping", mine: true, home: true });
    expect(keys(hk.rows.work)).toEqual(["pm", "tools"]);
  });

  it("keeps two generic departments apart (same key, different department)", () => {
    expect(mod.workspaces.filter((w) => w.key === "generic").map((w) => w.id)).toEqual(["d-hk", "d-gm"]);
  });

  it("shows no agency-only row anywhere", () => {
    expect(keys(mod.company)).not.toContain("clients");
    expect(keys(mod.company)).not.toContain("campaigns");
    expect(hk.rows.you.find((r) => r.key === "calendar")?.tabs.map((t) => t.key)).toEqual(["calendar"]);
    expect(allRows(hk).flatMap((r) => r.tabs.map((t) => t.href))).not.toContain("/pipeline");
  });
});

describe("buildShellModel: order and dedupe", () => {
  it("puts every own workspace first, in home order, and lists each department once", () => {
    const mod = model(me([member()]), "co-a", agencyTree({ seo: ["u-1"], web: ["u-1"] }));
    expect(mod.workspaces.map((w) => w.id)).toEqual(["d-web", "d-seo", "d-gm", "slug:hr", "slug:it", "slug:finance"]);
    expect(mod.workspaces.filter((w) => w.home).map((w) => w.id)).toEqual(["d-web"]);
  });

  it("keeps a placed company admin's Office of the GM among their own, once", () => {
    const admin = me([{ role: "company_admin", scopeType: "company", scopeId: "co-a" }]);
    const mod = model(admin, "co-a", agencyTree({ seo: ["u-1"] }));
    expect(mod.workspaces.map((w) => [w.id, w.mine])).toEqual([
      ["d-seo", true], ["d-gm", true], ["d-web", false], ["slug:hr", false], ["slug:it", false], ["slug:finance", false],
    ]);
  });

  it("sends someone with no workspace to the Company area", () => {
    const mod = model(me([member()]), "co-a", agencyTree());
    expect(mod.home).toEqual({ kind: "company" });
    expect(mod.homeLabel).toBe("Company");
    expect(mod.homeHref).toBe("/departments");
    expect(mod.workspaces.every((w) => !w.mine)).toBe(true);
  });
});

describe("workspaceForArea", () => {
  const mod = model(me([member()]), "co-a", agencyTree({ web: ["u-1"] }));

  it("finds a workspace by department id, then by slug", () => {
    expect(workspaceForArea(mod, { kind: "workspace", deptId: "d-seo" })?.id).toBe("d-seo");
    expect(workspaceForArea(mod, { kind: "workspace", slug: "web-dev" })?.id).toBe("d-web");
    expect(workspaceForArea(mod, { kind: "workspace", slug: "hr" })?.id).toBe("slug:hr");
  });

  it("answers null for an unknown department and for the Company and Admin areas", () => {
    expect(workspaceForArea(mod, { kind: "workspace", deptId: "d-nope" })).toBeNull();
    expect(workspaceForArea(mod, { kind: "company" })).toBeNull();
    expect(workspaceForArea(mod, { kind: "admin" })).toBeNull();
  });
});

describe("activeLocation (the deepest tab prefix, like SectionTabs)", () => {
  const mod = model(me([member()]), "co-a", agencyTree({ web: ["u-1"] }));
  const rows = allRows(byId(mod, "d-web"));

  it.each([
    ["/departments/d-web", "overview", "overview"],
    ["/departments/d-web/prd", "build", "prd"],
    ["/departments/d-web/prd/abc", "build", "prd"],
    ["/pipeline", "build", "pipeline"],
    ["/me", "me", "summary"],
    ["/me/inbox", "inbox", "inbox"],
    ["/me/mail", "inbox", "mail"],
    ["/me/mail/t-1", "inbox", "mail"],
    ["/me/mail/new", "inbox", "mail"],
    ["/me/leave", "me", "leave"],
    ["/me/learning?x=1", "learning", "mine"],
    ["/appraisals/mine", "appraisals", "mine"],
  ])("%s lights %s / %s", (path, rowKey, tabKey) => {
    expect(activeLocation(rows, path)).toEqual({ rowKey, tabKey });
  });

  it("lights nothing on a page no row holds", () => {
    expect(activeLocation(rows, "/")).toBeNull();
    expect(activeLocation(rows, "/meetings-other")).toBeNull();
  });

  it("never treats '/' as a prefix", () => {
    expect(activeLocation([{ key: "home", label: "Home", icon: "home", tabs: [{ key: "home", label: "Home", href: "/", icon: "home" }] }], "/me")).toBeNull();
  });
});

describe("buildShellModel: the Approvals row (DW-8m, DW-D23)", () => {
  const plain = me([member()]);
  const webOf = (approvals: { pending: number } | null | undefined) =>
    buildShellModel({ me: plain, tenantId: "co-a", workspaces: resolveMyWorkspaces({ me: plain, tenantId: "co-a", root: agencyTree({ web: ["u-1"] }) }), approvals }).workspaces[0];

  it("hides it from a member with nothing waiting and no right to decide", () => {
    expect(keys(webOf({ pending: 0 }).rows.you)).not.toContain("approvals");
  });

  it("shows it with the count when something waits", () => {
    expect(webOf({ pending: 4 }).rows.you.find((r) => r.key === "approvals")?.count).toBe(4);
  });

  it("shows it with no count when the read failed or was not made", () => {
    for (const approvals of [null, undefined]) {
      const row = webOf(approvals).rows.you.find((r) => r.key === "approvals");
      expect(row).toBeDefined();
      expect(row?.count).toBeUndefined();
    }
  });
});

describe("buildShellModel: the Company area by pack (DW-8e)", () => {
  it("opens on Departments, with Clients and Campaigns for an agency company and neither for a generic-pack one", () => {
    const agency = model(me([member()]), "co-a", agencyTree({ web: ["u-1"] }));
    expect(keys(agency.company)[0]).toBe("departments");
    expect(keys(agency.company)).toEqual(expect.arrayContaining(["clients", "campaigns"]));
    const hotel = model(me([member("co-h")], [HOTEL]), "co-h", node("root", "Hotel", "company", [node("d-hk", "Housekeeping", "department", [person("p", "u-1")])]));
    expect(keys(hotel.company)[0]).toBe("departments");
    expect(keys(hotel.company)).not.toContain("clients");
    expect(keys(hotel.company)).not.toContain("campaigns");
  });
});

describe("buildShellModel: the Notices tab on the Overview row (DW-10a-2, BFF section 57.8)", () => {
  const overviewTabs = (ws: ShellWorkspace) => ws.rows.top.find((r) => r.key === "overview")!.tabs.map((t) => [t.label, t.href]);
  const mod = model(me([member()]), "co-a", agencyTree({ web: ["u-1"] }));

  it("gives every department workspace with an org node Overview then Notices, at its own unit's page", () => {
    expect(overviewTabs(byId(mod, "d-web"))).toEqual([["Overview", "/departments/d-web"], ["Notices", "/departments/d-web/notices"]]);
    expect(overviewTabs(byId(mod, "d-seo"))).toEqual([["Overview", "/departments/d-seo"], ["Notices", "/departments/d-seo/notices"]]);
  });

  it("gives the Company workspace (the Office of the GM) the company-wide board, not its own unit's", () => {
    expect(overviewTabs(byId(mod, "d-gm"))).toEqual([["Overview", "/departments/d-gm"], ["Notices", "/notices"]]);
  });

  it("gives a workspace with no org node no department Notices tab (the shell drops a {dept} href with no id), and keeps its own Overview", () => {
    for (const id of ["slug:hr", "slug:it", "slug:finance"]) expect(overviewTabs(byId(mod, id)).map(([label]) => label), id).toEqual(["Overview"]);
  });

  it("gives HR, Finance and IT the tab once they are org nodes (DW-7d)", () => {
    const base = agencyTree({ web: ["u-1"] });
    const tree = node("root", "Agency", "company", [...base.children, node("d-hr", "HR", "department"), node("d-fin", "Finance", "department"), node("d-it", "IT", "department")]);
    const withNodes = model(me([member()]), "co-a", tree);
    expect(overviewTabs(byId(withNodes, "d-hr"))).toEqual([["Overview", "/hr"], ["Notices", "/departments/d-hr/notices"]]);
    expect(overviewTabs(byId(withNodes, "d-fin"))).toEqual([["Overview", "/finance"], ["Notices", "/departments/d-fin/notices"]]);
    expect(overviewTabs(byId(withNodes, "d-it"))).toEqual([["Overview", "/it"], ["Notices", "/departments/d-it/notices"]]);
  });

  it("keeps the Overview tab first, so the switcher still opens a workspace on its Overview", () => {
    for (const ws of mod.workspaces) expect(overviewHref(ws), ws.id).toBe(ws.rows.top.find((r) => r.key === "overview")!.tabs[0].href);
    expect(overviewHref(byId(mod, "d-web"))).toBe("/departments/d-web");
  });

  it("offers the tab to every person: it carries no gate", () => {
    for (const ws of mod.workspaces.filter((w) => w.deptId)) expect(ws.rows.top.find((r) => r.key === "overview")!.tabs.map((t) => t.label), ws.id).toContain("Notices");
    const viewer = model(me([{ role: "viewer", scopeType: "company", scopeId: "co-a" }]), "co-a", agencyTree());
    expect(viewer.workspaces.length).toBeGreaterThan(0);
    for (const ws of viewer.workspaces.filter((w) => w.deptId)) expect(ws.rows.top[0].tabs.map((t) => t.label), ws.id).toContain("Notices");
  });
});
