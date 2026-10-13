import { describe, it, expect } from "vitest";
import type { Me } from "./platform";
import { navFor } from "@/components/shell/nav";
import { sidebarRows, workspaceBySlug, type Gate } from "./workspaces";
import { concreteRows, gateAllows, homeArea, resolveMyWorkspaces } from "./workspaceAccess";
import { areaFor, resolveArea } from "./areas";
import { AGENCY, HOTEL, ROOT, agencyTree, lead, me, member, node, person } from "./workspaceFixtures";

const navHrefs = (m: Me, tenant: string) => navFor(m, tenant).flatMap((g) => g.items.map((i) => i.href));
const navGroups = (m: Me, tenant: string) => navFor(m, tenant).map((g) => g.label);
const ctx = (m: Me, tenantId: string, unitPath: string[] = []) => ({ me: m, tenantId, unitPath });

describe("gateAllows mirrors nav.ts (gates unchanged, plan §2.6 rule 4)", () => {
  const ROWS: Record<string, string> = {
    clients: "/clients", deliverables: "/deliverables", timesheets: "/timesheets", agency: "/agency",
    meetings: "/meetings", pipeline: "/pipeline", monitoring: "/monitoring",
  };
  const cases: [string, Me, string][] = [
    ["agency company", me([{ role: "company_admin", scopeType: "company", scopeId: "co-a" }]), "co-a"],
    ["hospitality company", me([{ role: "company_admin", scopeType: "company", scopeId: "co-h" }], [HOTEL]), "co-h"],
    ["agency with the agency module off", me([member()], [{ ...AGENCY, enabledModules: ["pm", "clients"] }]), "co-a"],
  ];

  it.each(cases)("shows the agency rows exactly where nav.ts does: %s", (_name, m, tenant) => {
    const nav = navHrefs(m, tenant);
    for (const [row, href] of Object.entries(ROWS)) {
      expect(gateAllows({ kind: "agencyRow", row: row as never }, ctx(m, tenant)), row).toBe(nav.includes(href));
    }
    const invoices: Gate = { kind: "all", gates: [{ kind: "agencyRow", row: "invoices" }, { kind: "cap", cap: "company.manage" }] };
    expect(gateAllows(invoices, ctx(m, tenant))).toBe(nav.includes("/invoices"));
  });

  it.each([
    ["the root owner in the root", me([{ role: "owner", scopeType: "company", scopeId: "co-root" }], [ROOT, AGENCY]), "co-root"],
    ["the root owner in a child", me([{ role: "owner", scopeType: "company", scopeId: "co-root" }], [ROOT, AGENCY]), "co-a"],
    ["platform_admin in the root", me([{ role: "platform_admin", scopeType: "global", scopeId: null }], [ROOT, AGENCY]), "co-root"],
    ["a member", me([member()]), "co-a"],
  ] as [string, Me, string][])("shows Group, Platform and Settings exactly where nav.ts does: %s", (_name, m, tenant) => {
    const groups = navGroups(m, tenant);
    expect(gateAllows({ kind: "rootGroup" }, ctx(m, tenant))).toBe(groups.includes("Group"));
    expect(gateAllows({ kind: "platformOperator" }, ctx(m, tenant))).toBe(groups.includes("Platform"));
    expect(gateAllows({ kind: "cap", cap: "admin.access" }, ctx(m, tenant))).toBe(navHrefs(m, tenant).includes("/admin"));
  });

  it("answers the pack and module gates from the active company", () => {
    expect(gateAllows({ kind: "pack", pack: "agency" }, ctx(me([member()]), "co-a"))).toBe(true);
    expect(gateAllows({ kind: "pack", pack: "agency" }, ctx(me([member("co-h")], [HOTEL]), "co-h"))).toBe(false);
    expect(gateAllows({ kind: "module", module: "hr" }, ctx(me([member()], [{ ...AGENCY, enabledModules: ["pm"] }]), "co-a"))).toBe(false);
    // An older backend that sends no module list hides nothing (`moduleOn`).
    expect(gateAllows({ kind: "module", module: "hr" }, ctx(me([member()]), "co-a"))).toBe(true);
  });

  it("offers a head their unit's learning authoring through unitCap only (DW-D15)", () => {
    const authoring: Gate = { kind: "unitCap", cap: "lms.authoring" };
    const head = me([member(), lead("d-web")]);
    expect(gateAllows(authoring, ctx(head, "co-a", ["d-web", "root"]))).toBe(true);
    expect(gateAllows(authoring, ctx(head, "co-a", ["d-seo", "root"]))).toBe(false);
    // Today's heads hold `manager`, which has no learning right: still not offered.
    expect(gateAllows(authoring, ctx(me([{ role: "manager", scopeType: "company", scopeId: "co-a" }]), "co-a", ["d-web", "root"]))).toBe(false);
    // The company-wide question nav.ts asks today stays false for the head.
    expect(gateAllows({ kind: "cap", cap: "lms.authoring" }, ctx(head, "co-a", ["d-web", "root"]))).toBe(false);
  });
});

describe("resolveMyWorkspaces: home (plan §2.1)", () => {
  const keyOf = (r: { workspace: { key: string }; deptId: string | null }) => `${r.workspace.key}:${r.deptId}`;

  it("puts a placed employee in their department, found inside a division", () => {
    const res = resolveMyWorkspaces({ me: me([member()]), tenantId: "co-a", root: agencyTree({ frontend: ["u-1"] }) });
    expect(res.home.kind === "workspace" && keyOf(res.home.ref)).toBe("web-dev:d-web");
    expect(res.home.kind === "workspace" && res.home.ref.unitPath).toEqual(["d-web", "root"]);
    expect(res.mine.map(keyOf)).toEqual(["web-dev:d-web"]);
  });

  it("homes someone in two departments in the first, and lists both", () => {
    const res = resolveMyWorkspaces({ me: me([member()]), tenantId: "co-a", root: agencyTree({ seo: ["u-1"], web: ["u-1"] }) });
    expect(res.mine.map(keyOf)).toEqual(["web-dev:d-web", "seo:d-seo"]);
  });

  it("homes an unplaced head in the department holding the unit they lead", () => {
    const division = resolveMyWorkspaces({ me: me([member(), lead("dv-fe")]), tenantId: "co-a", root: agencyTree() });
    expect(division.mine.map(keyOf)).toEqual(["web-dev:d-web"]);
    // Leading a division is not leading the department.
    expect(division.home.kind === "workspace" && division.home.ref.lead).toBe(false);
    const dept = resolveMyWorkspaces({ me: me([member(), lead("d-web")]), tenantId: "co-a", root: agencyTree() });
    expect(dept.home.kind === "workspace" && dept.home.ref.lead).toBe(true);
  });

  it("homes functional staff in HR, Finance or IT, which are not in the org tree yet (DW-D6)", () => {
    const hr = resolveMyWorkspaces({ me: me([member(), { role: "hr_staff", scopeType: "company", scopeId: "co-a" }]), tenantId: "co-a", root: agencyTree() });
    expect(hr.home.kind === "workspace" && keyOf(hr.home.ref)).toBe("hr:null");
    const it = resolveMyWorkspaces({ me: me([member(), { role: "it_admin", scopeType: "company", scopeId: "co-a" }]), tenantId: "co-a", root: agencyTree() });
    expect(it.home.kind === "workspace" && keyOf(it.home.ref)).toBe("it:null");
  });

  it("counts a functional role only in the company it is granted in, or a service scope serving it", () => {
    const elsewhere = me([member(), { role: "finance_staff", scopeType: "company", scopeId: "co-other" }]);
    expect(resolveMyWorkspaces({ me: elsewhere, tenantId: "co-a", root: agencyTree() }).home).toEqual({ kind: "company" });
    const served = me([member()], [AGENCY], {
      serviceScopes: [{ companyId: "co-a", companyName: "Agency", assignmentId: "as-1", module: "hr", unitName: "HR", role: "staff" }],
    });
    const res = resolveMyWorkspaces({ me: served, tenantId: "co-a", root: agencyTree() });
    expect(res.home.kind === "workspace" && res.home.ref.workspace.key).toBe("hr");
  });

  it("homes an unplaced owner or company admin in the Office of the GM (DW-D1)", () => {
    const admin = me([{ role: "company_admin", scopeType: "company", scopeId: "co-a" }]);
    const res = resolveMyWorkspaces({ me: admin, tenantId: "co-a", root: agencyTree() });
    expect(res.home.kind === "workspace" && keyOf(res.home.ref)).toBe("gm:d-gm");
  });

  it("keeps a placed company admin in their department, with the Office of the GM in their switcher", () => {
    const admin = me([{ role: "company_admin", scopeType: "company", scopeId: "co-a" }]);
    const res = resolveMyWorkspaces({ me: admin, tenantId: "co-a", root: agencyTree({ seo: ["u-1"] }) });
    expect(res.mine.map(keyOf)).toEqual(["seo:d-seo", "gm:d-gm"]);
  });

  it("sends anyone else with no placement to the Company area", () => {
    expect(resolveMyWorkspaces({ me: me([member()]), tenantId: "co-a", root: agencyTree() }).home).toEqual({ kind: "company" });
  });

  it("gives another vertical's departments the generic workspace, and no Office of the GM (PV-D15)", () => {
    const tree = node("root", "Hotel", "company", [node("d-gm", "GM", "department"), node("d-hk", "Housekeeping", "department", [person("p", "u-1")])]);
    const placed = resolveMyWorkspaces({ me: me([member("co-h")], [HOTEL]), tenantId: "co-h", root: tree });
    expect(placed.home.kind === "workspace" && [placed.home.ref.workspace.key, placed.home.ref.workspace.label]).toEqual(["generic", "Housekeeping"]);
    // An unplaced company admin: the hotel's GM department is generic, so there is no Office to land in.
    const admin = me([{ role: "company_admin", scopeType: "company", scopeId: "co-h" }], [HOTEL], { userId: "u-admin" });
    expect(resolveMyWorkspaces({ me: admin, tenantId: "co-h", root: tree }).home).toEqual({ kind: "company" });
  });
});

describe("resolveMyWorkspaces: the switcher list (DW-D2, GM-01)", () => {
  it("lists every department, the Office of the GM first, then HR, IT and Finance", () => {
    const res = resolveMyWorkspaces({ me: me([member()]), tenantId: "co-a", root: agencyTree() });
    expect(res.all.map((r) => [r.workspace.key, r.deptId])).toEqual([
      ["gm", "d-gm"], ["web-dev", "d-web"], ["seo", "d-seo"], ["hr", null], ["it", null], ["finance", null],
    ]);
  });

  it("uses the org tree's own Finance department instead of adding a second one", () => {
    const tree = agencyTree();
    const withFinance = { ...tree, children: [...tree.children, node("d-fin", "Finance", "department")] };
    const res = resolveMyWorkspaces({ me: me([member()]), tenantId: "co-a", root: withFinance });
    expect(res.all.filter((r) => r.workspace.key === "finance").map((r) => r.deptId)).toEqual(["d-fin"]);
  });

  it("still offers the functional workspaces when the org tree cannot be read", () => {
    const res = resolveMyWorkspaces({ me: me([member()]), tenantId: "co-a", root: null });
    expect(res.all.map((r) => r.workspace.key)).toEqual(["hr", "it", "finance"]);
    expect(res.home).toEqual({ kind: "company" });
  });
});

describe("concreteRows", () => {
  const webDev = workspaceBySlug("web-dev")!;
  const employee = me([member()]);
  const rowsFor = (m: Me, includePlanned = false) => {
    const model = sidebarRows(webDev);
    const c = { ...ctx(m, "co-a", ["d-web", "root"]), deptId: "d-web" };
    return [...model.top, ...model.work, ...model.performance, ...model.you].flatMap((r) => concreteRows([r], c, { includePlanned }));
  };

  // Plan §0: a Web Dev employee goes from 38 rows to 19. The 19 count the Company door and not
  // Approvals, which stays ungated as today until DW-8 rules on it; so 19 here, and 16 while
  // Campaigns, Clients and My tasks are not built.
  it("gives a Web Dev employee 16 rows today and 19 once the planned rows land", () => {
    expect(rowsFor(employee).map((r) => r.key)).toEqual([
      "overview", "assistant", "pm", "build", "run", "website", "requests", "tools",
      "reports", "analytics", "appraisals", "learning", "inbox", "calendar", "approvals", "me",
    ]);
    expect(rowsFor(employee, true)).toHaveLength(19);
  });

  it("fills the department id and drops planned and gated tabs", () => {
    const build = rowsFor(employee).find((r) => r.key === "build")!;
    expect(build.tabs.map((t) => t.href)).toEqual(["/departments/d-web/prd", "/pipeline", "/departments/d-web/repositories", "/departments/d-web/deliverables"]);
    const learning = rowsFor(employee).find((r) => r.key === "learning")!;
    expect(learning.tabs.map((t) => t.key)).toEqual(["mine", "courses"]);
    const headLearning = rowsFor(me([member(), lead("d-web")])).find((r) => r.key === "learning")!;
    expect(headLearning.tabs.map((t) => t.key)).toEqual(["mine", "courses", "add", "team"]);
  });

  it("drops a {dept} tab when the workspace has no department id (HR before DW-7d)", () => {
    const hr = workspaceBySlug("hr")!;
    const c = { ...ctx(me([member(), { role: "hr_manager", scopeType: "company", scopeId: "co-a" }]), "co-a"), deptId: null };
    const rows = concreteRows(sidebarRows(hr).work, c);
    expect(rows.map((r) => r.key)).not.toContain("pm");
    expect(rows.map((r) => r.key)).not.toContain("tools");
    expect(rows.find((r) => r.key === "people")!.tabs.map((t) => t.href)).toEqual(["/hr/people", "/hr/onboarding", "/companies/co-a/org"]);
  });
});

describe("homeArea feeds the last-area rule (lib/areas.ts)", () => {
  it("is the home department, the functional slug, or the Company area", () => {
    const placed = resolveMyWorkspaces({ me: me([member()]), tenantId: "co-a", root: agencyTree({ web: ["u-1"] }) });
    expect(homeArea(placed.home)).toEqual({ kind: "workspace", deptId: "d-web" });
    const hr = resolveMyWorkspaces({ me: me([{ role: "hr_staff", scopeType: "company", scopeId: "co-a" }]), tenantId: "co-a", root: agencyTree() });
    expect(homeArea(hr.home)).toEqual({ kind: "workspace", slug: "hr" });
    expect(homeArea({ kind: "company" })).toEqual({ kind: "company" });
  });

  it("draws a personal page on a fresh load inside the home workspace", () => {
    const placed = resolveMyWorkspaces({ me: me([member()]), tenantId: "co-a", root: agencyTree({ web: ["u-1"] }) });
    expect(resolveArea(areaFor("/me/inbox"), null, homeArea(placed.home))).toEqual({ kind: "workspace", deptId: "d-web" });
  });
});
