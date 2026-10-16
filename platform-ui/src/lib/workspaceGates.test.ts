// DW-9d: the gate cases of the retired `components/shell/nav.test.ts`, ported to the workspace shell (DW-D38, plan §13 trap 3:
// never simplify a gate). Each case asks the shell model, or `gateAllows`, for an explicit expected answer; `navFor` is not an
// oracle any more. Every `describe` names the nav.test case it carries. Classic-only cases (the rail glyph per group, the
// single pinned Workspace group, the disclosure shape of the Departments nav group) have no workspace-shell counterpart.
import { describe, it, expect } from "vitest";
import type { Me } from "./platform";
import { resolveMyWorkspaces, type OrgTreeNode } from "./workspaceAccess";
import { buildShellModel, type ShellModel } from "./shellModel";
import { gateAllows } from "./workspaceAccess";
import type { Gate } from "./workspaces";
import { agencyTree, node, person } from "./workspaceFixtures";

// What nav.test.ts fixed: `c1` is an agency that is its own root with every module on; GROUP is a holding root (the OPERATOR
// root, PV-D31) with an agency and a hospitality company under it.
const MODULES = ["agency", "pm", "it", "invoice", "clients", "knowledge", "automation-console", "hr", "reports", "monitoring"];
const base: Me = {
  userId: "u1", name: "Clement Hansel", email: "hansel@gaiada.com", title: "AI Manager", assurance: "high",
  companies: [{ id: "c1", name: "Gaiada HQ", type: null, vertical: "agency", enabledModules: MODULES, rootCompanyId: "c1" }],
  roles: [],
};
const GROUP: Me["companies"] = [
  { id: "co-holding", name: "Holding", type: "holding", vertical: "holding", enabledModules: MODULES, rootCompanyId: "co-holding", isOperatorRoot: true },
  { id: "co-agency", name: "Agency", type: "agency", vertical: "agency", enabledModules: MODULES, rootCompanyId: "co-holding" },
  { id: "co-resort", name: "Resort", type: "resort", vertical: "hospitality", enabledModules: MODULES, rootCompanyId: "co-holding" },
];
const inGroup = (roles: Me["roles"]): Me => ({ ...base, companies: GROUP, roles });
const grant = (role: string, scopeId: string) => ({ role, scopeType: "company", scopeId });
const asMember = (companies: Me["companies"]): Me => ({ ...base, companies, roles: [grant("member", companies[0].id)] });

function modelFor(m: Me, tenantId: string, root: OrgTreeNode | null = agencyTree()): ShellModel {
  return buildShellModel({ me: m, tenantId, workspaces: resolveMyWorkspaces({ me: m, tenantId, root }), approvals: { pending: 0 } });
}
/** Every href the person is offered anywhere in the shell: workspaces (own and others'), Company and Admin. */
const hrefsOf = (model: ShellModel) => [
  ...model.workspaces.flatMap((w) => [...w.rows.top, ...w.rows.work, ...w.rows.performance, ...w.rows.you]),
  ...model.company, ...model.admin,
].flatMap((r) => r.tabs.map((t) => t.href.split("?")[0]));
const offered = (m: Me, tenantId: string, root?: OrgTreeNode | null) => hrefsOf(modelFor(m, tenantId, root));
const adminKeys = (m: Me, tenantId: string) => modelFor(m, tenantId).admin.map((r) => r.key);
const ctx = (m: Me, tenantId: string) => ({ me: m, tenantId, unitPath: [] as string[] });

const AGENCY_ROW_HREFS = ["/clients", "/deliverables", "/timesheets", "/agency", "/meetings", "/pipeline", "/monitoring"];

// nav.test: "member sees Workspace/Organization/Departments/Business/Reports/Intelligence but no Settings, no Platform, no Group"
describe("a plain member's reach (nav.test 'member sees ...')", () => {
  const member = { ...base, roles: [grant("member", "c1")] };
  const model = modelFor(member, "c1");
  const hrefs = hrefsOf(model);

  it("has no Settings, Platform or Group: the Admin area is empty", () => {
    expect(model.admin).toEqual([]);
  });

  it("has the personal hub with no gate (nav 'Me' group is ungated)", () => {
    for (const href of ["/me", "/me/inbox", "/me/leave", "/me/loans", "/me/learning"]) expect(hrefs, href).toContain(href);
  });

  it("has Project Management twice-reachable: the Company Projects row (/project-management) and the cross-project scope (/pm), ungated", () => {
    expect(model.company.find((r) => r.key === "projects")!.tabs.map((t) => t.href).slice(0, 2)).toEqual(["/project-management", "/pm"]);
    expect(hrefs).toContain("/calendar");
  });

  it("keeps Monitoring ungated by capability (only the pack row and module gate it)", () => {
    expect(hrefs).toContain("/monitoring");
  });

  it("offers the agency rows, and the client hub as ONE Clients row (CC-D8: no separate Client Centre)", () => {
    for (const href of AGENCY_ROW_HREFS) expect(hrefs, href).toContain(href);
    expect(hrefs).not.toContain("/client-centre");
  });

  it("does not offer Rollups outside the Group area, nor the exec-only company reports", () => {
    expect(hrefs).not.toContain("/rollups");
    expect(hrefs).not.toContain("/group/reports");
  });

  it("offers a member their own report and appraisal history, never the manager or HR consoles", () => {
    expect(hrefs).toContain("/reports/person");
    expect(hrefs).toContain("/appraisals/mine");
    expect(hrefs).not.toContain("/appraisals");
    expect(hrefs).not.toContain("/appraisals/cycles");
  });

  it("offers the Organization overview, Positions and Access to a member in the active company (member holds people.directory there)", () => {
    // nav.test asserted Overview only, but called navFor with NO active company, where a company-scoped grant does not apply.
    expect(model.company.find((r) => r.key === "organization")!.tabs.map((t) => t.href)).toEqual(["/organization", "/organization/positions", "/organization/access"]);
  });

  it("offers the Organization overview alone, and no People row, to someone without people.directory", () => {
    const none = modelFor({ ...base, roles: [] }, "c1");
    expect(none.company.find((r) => r.key === "organization")!.tabs.map((t) => t.href)).toEqual(["/organization"]);
    expect(none.company.map((r) => r.key)).not.toContain("people");
  });

  it("offers the Learning catalogue but not Authoring or Compliance (lms.* gates)", () => {
    expect(hrefs).toContain("/learning/catalogue");
    expect(hrefs).not.toContain("/learning/authoring");
    expect(hrefs).not.toContain("/learning/compliance");
  });
});

describe("Organization's directory rights (nav.test 'Organization')", () => {
  it("shows Positions, Access and People to a holder of people.directory, and to platform_admin", () => {
    const hr = { ...base, roles: [grant("hr_staff", "c1")] };
    const admin = { ...base, roles: [{ role: "platform_admin", scopeType: "global", scopeId: null }] };
    for (const m of [hr, admin]) {
      const model = modelFor(m, "c1");
      expect(model.company.find((r) => r.key === "organization")!.tabs.map((t) => t.href), m.roles[0].role).toEqual(["/organization", "/organization/positions", "/organization/access"]);
      expect(model.company.map((r) => r.key)).toContain("people");
    }
  });
});

// nav.test: "renders Departments as its own group ...", "hoists GM ...", "keeps the GM row for a plain member",
// "keeps GM inside the Departments visual cap", "still lists HR and IT ...", "opens the Departments group with the directory",
// "re-points an org-structure Finance department ...", "re-points tree HR and IT nodes ...", "a tree with HR, Finance and IT ...",
// "keeps the tree's own label ..."
describe("the departments a person can switch to (nav.test 'Departments')", () => {
  const member = { ...base, roles: [grant("member", "c1")] };
  const tree = (...depts: [string, string][]): OrgTreeNode => node("root", "Agency", "company", depts.map(([id, name]) => node(id, name, "department")));
  const ids = (m: ShellModel) => m.workspaces.map((w) => w.id);

  it("lists the business departments, then HR, IT and Finance when the tree lacks them", () => {
    expect(ids(modelFor(member, "c1", tree(["dept-1", "Web Dev"], ["dept-2", "SEO"])))).toEqual(["dept-1", "dept-2", "slug:hr", "slug:it", "slug:finance"]);
  });

  it("hoists GM to the top, whatever order the tree gives, and keeps its href", () => {
    const m = modelFor(member, "c1", tree(["dept-1", "Web Dev"], ["dept-2", "SEO"], ["dept-5", "GM"]));
    expect(ids(m)).toEqual(["dept-5", "dept-1", "dept-2", "slug:hr", "slug:it", "slug:finance"]);
    expect(m.workspaces[0].rows.top.find((r) => r.key === "overview")!.tabs[0].href).toBe("/departments/dept-5");
  });

  it("keeps the GM workspace for a plain member: the row is ungated, the console gates its content", () => {
    expect(ids(modelFor(member, "c1", tree(["dept-5", "GM"])))).toContain("dept-5");
  });

  it("keeps GM first in a wide estate", () => {
    const wide = tree(["d1", "Web Dev"], ["d2", "SEO"], ["d3", "Creatives"], ["d4", "Social Media"], ["d5", "Legal"], ["d6", "Finance"], ["d7", "GM"]);
    expect(ids(modelFor(member, "c1", wide))[0]).toBe("d7");
  });

  it("lists HR, IT and Finance even when the org tree cannot be read", () => {
    expect(ids(modelFor(member, "c1", null))).toEqual(["slug:hr", "slug:it", "slug:finance"]);
  });

  it("offers the directory of departments to everyone, ungated", () => {
    expect(modelFor(member, "c1").company.find((r) => r.key === "departments")!.tabs[0].href).toBe("/departments");
  });

  it("re-points a tree Finance department at /finance: one Finance workspace, no second one", () => {
    const m = modelFor(member, "c1", tree(["d1", "Web Dev"], ["d6", "Finance"]));
    expect(m.workspaces.filter((w) => w.key === "finance").map((w) => w.id)).toEqual(["d6"]);
    expect(m.workspaces.find((w) => w.id === "d6")!.rows.top.find((r) => r.key === "overview")!.tabs[0].href).toBe("/finance");
  });

  it("re-points tree HR and IT nodes at /hr and /it: one workspace each, Finance appended, tree order kept", () => {
    const m = modelFor(member, "c1", tree(["d-hr-c1", "HR"], ["d1", "Web Dev"], ["d-it-c1", "IT"]));
    expect(ids(m)).toEqual(["d-hr-c1", "d1", "d-it-c1", "slug:finance"]);
    const overview = (id: string) => m.workspaces.find((w) => w.id === id)!.rows.top.find((r) => r.key === "overview")!.tabs[0].href;
    expect(overview("d-hr-c1")).toBe("/hr");
    expect(overview("d-it-c1")).toBe("/it");
    expect(overview("d1")).toBe("/departments/d1");
  });

  it("a tree with HR, Finance and IT yields exactly those three workspaces and nothing appended", () => {
    const m = modelFor(member, "c1", tree(["d-hr-c1", "HR"], ["d-finance-c1", "Finance"], ["d-it-c1", "IT"], ["d1", "Web Dev"]));
    expect(ids(m)).toEqual(["d-hr-c1", "d-finance-c1", "d-it-c1", "d1"]);
  });

  it("keeps a hand-built name that does not slug to a functional one as a plain department, and appends HR", () => {
    const m = modelFor(member, "c1", tree(["d9", "Human Resources"], ["d-finance", "Finance"]));
    expect(ids(m)).toEqual(["d9", "d-finance", "slug:hr", "slug:it"]);
    expect(m.workspaces.find((w) => w.id === "d9")!.rows.top.find((r) => r.key === "overview")!.tabs[0].href).toBe("/departments/d9");
  });
});

// nav.test: "platform_admin gets a Settings entry, Platform and the Group area ..."
describe("platform_admin (nav.test 'platform_admin gets ...')", () => {
  const admin = { ...base, roles: [{ role: "platform_admin", scopeType: "global", scopeId: null }] };
  const model = modelFor(admin, "c1");

  it("gets Settings, the Group area with its three rows, and Platform", () => {
    expect(model.admin.map((r) => r.key)).toEqual(["settings", "group", "platform"]);
    expect(model.admin.find((r) => r.key === "settings")!.tabs.map((t) => t.href)).toEqual(["/admin"]);
    expect(model.admin.find((r) => r.key === "group")!.tabs.map((t) => [t.label, t.href])).toEqual([
      ["Group report", "/group"], ["Rollups", "/rollups"], ["Company reports", "/group/reports"],
    ]);
  });

  it("holds every appraisal right: the team console and the cycles administration are offered", () => {
    const hrefs = hrefsOf(model);
    expect(hrefs).toContain("/appraisals");
    expect(hrefs).toContain("/appraisals/cycles");
  });
});

describe("the appraisal consoles' gates (nav.test 'TR-26', 'appraisals')", () => {
  it("offers Team appraisals to appraisal.score or appraisal.read holders, and cycles only to appraisal.cycle.admin", () => {
    const hrManager = { ...base, roles: [grant("member", "c1"), grant("hr_manager", "c1")] };
    const hrefs = offered(hrManager, "c1");
    expect(hrefs).toContain("/appraisals");
    expect(offered({ ...base, roles: [grant("member", "c1")] }, "c1")).not.toContain("/appraisals");
  });
});

// nav.test: "navFor follows the active company's pack (PV-D15, PV-D17)"
describe("the active company's pack and modules decide the agency rows (nav.test 'follows the active company's pack')", () => {
  it("an agency company shows the agency rows", () => {
    const hrefs = offered(asMember(GROUP.slice(1)), "co-agency");
    for (const href of AGENCY_ROW_HREFS) expect(hrefs, href).toContain(href);
  });

  it("shows Invoices in an agency company only with company.manage", () => {
    const admin = inGroup([grant("company_admin", "co-agency")]);
    expect(offered(admin, "co-agency")).toContain("/invoices");
    expect(offered(inGroup([grant("member", "co-holding")]), "co-agency")).not.toContain("/invoices");
  });

  it.each([["a hospitality company", "co-resort"], ["a holding company", "co-holding"]])("%s shows none of the agency rows", (_n, tenant) => {
    const hrefs = offered(inGroup([grant("member", "co-holding")]), tenant);
    for (const href of AGENCY_ROW_HREFS) expect(hrefs, href).not.toContain(href);
  });

  it("hides Invoices in a hospitality company even for a company admin", () => {
    expect(offered(inGroup([grant("company_admin", "co-resort")]), "co-resort")).not.toContain("/invoices");
  });

  it("a missing vertical counts as general, so the agency rows are hidden rather than guessed", () => {
    const old: Me = { ...base, companies: [{ id: "c1", name: "Old backend", type: "agency" }], roles: [] };
    const hrefs = offered(old, "c1");
    for (const href of AGENCY_ROW_HREFS) expect(hrefs, href).not.toContain(href);
  });

  it("reads the ACTIVE company, so switching company changes the rows for the same person", () => {
    const m = inGroup([grant("member", "co-agency")]);
    expect(offered(m, "co-agency")).toContain("/clients");
    expect(offered(m, "co-resort")).not.toContain("/clients");
  });

  it("a module that is off hides its row; the others stay", () => {
    const noClients = asMember([{ ...GROUP[1], enabledModules: MODULES.filter((x) => x !== "clients") }]);
    const rows = offered(noClients, "co-agency");
    expect(rows).not.toContain("/clients");
    expect(rows).toContain("/deliverables");
    const noAgency = asMember([{ ...GROUP[1], enabledModules: MODULES.filter((x) => x !== "agency" && x !== "monitoring") }]);
    const rows2 = offered(noAgency, "co-agency");
    expect(rows2).not.toContain("/agency");
    expect(rows2).not.toContain("/monitoring");
    expect(rows2).toContain("/clients");
  });

  it("hides the Invoices row when the invoice module is off, even for company.manage", () => {
    const admin: Me = { ...base, companies: [{ ...GROUP[1], enabledModules: MODULES.filter((x) => x !== "invoice") }], roles: [grant("company_admin", "co-agency")] };
    expect(offered(admin, "co-agency")).not.toContain("/invoices");
  });

  it("treats a missing enabledModules as unknown and hides nothing", () => {
    const { enabledModules: _drop, ...bare } = GROUP[1];
    const hrefs = offered(asMember([bare]), "co-agency");
    for (const href of AGENCY_ROW_HREFS) expect(hrefs, href).toContain(href);
  });
});

// nav.test: "navFor Platform and Group areas (PV-D11, PV-D18, PV-D20, PV-D31)"
describe("Platform and Group areas (nav.test 'Platform and Group areas')", () => {
  const rootOwner = inGroup([grant("owner", "co-holding"), grant("owner", "co-agency")]);

  it("a member sees neither Platform nor Group, in any company", () => {
    const m = inGroup([grant("member", "co-holding")]);
    for (const t of ["co-holding", "co-agency", "co-resort"]) {
      expect(adminKeys(m, t)).not.toContain("platform");
      expect(adminKeys(m, t)).not.toContain("group");
    }
  });

  it("the OPERATOR root's owner sees Platform in every company, and Group only while the root is active", () => {
    for (const t of ["co-holding", "co-agency", "co-resort"]) expect(adminKeys(rootOwner, t), t).toContain("platform");
    expect(adminKeys(rootOwner, "co-holding")).toContain("group");
    expect(adminKeys(rootOwner, "co-agency")).not.toContain("group");
    expect(adminKeys(rootOwner, "co-resort")).not.toContain("group");
  });

  it("Platform carries the five former Systems rows, same hrefs", () => {
    const platform = modelFor(rootOwner, "co-holding").admin.find((r) => r.key === "platform")!;
    expect(platform.tabs.map((t) => [t.label, t.href])).toEqual([
      ["WA/TG Bot", "/systems/bot"], ["AI Gateway", "/systems/gateway"], ["MCP Hub", "/systems/hub"],
      ["Automation", "/systems/automation"], ["Observability", "/systems/observability"],
    ]);
  });

  it("an owner of a CHILD company only is not a root owner", () => {
    const childOwner = inGroup([grant("owner", "co-agency")]);
    expect(adminKeys(childOwner, "co-holding")).not.toContain("platform");
    expect(adminKeys(childOwner, "co-holding")).not.toContain("group");
  });

  // PV-D31: a second, UNMARKED root (a customer organization): its owner keeps Group on their own root, never Platform.
  const CUSTOMER: Me["companies"] = [
    { id: "cust-root", name: "Customer", type: "holding", vertical: "holding", enabledModules: MODULES, rootCompanyId: "cust-root", isOperatorRoot: false },
    { id: "cust-co", name: "Customer Agency", type: "agency", vertical: "agency", enabledModules: MODULES, rootCompanyId: "cust-root", isOperatorRoot: false },
  ];
  const customerOwner: Me = { ...base, companies: CUSTOMER, roles: [grant("owner", "cust-root")] };

  it("PV-D31: the owner of a CUSTOMER root never sees Platform, but keeps Group on their own root", () => {
    expect(adminKeys(customerOwner, "cust-root")).not.toContain("platform");
    expect(adminKeys(customerOwner, "cust-co")).not.toContain("platform");
    expect(adminKeys(customerOwner, "cust-root")).toContain("group");
    expect(adminKeys(customerOwner, "cust-co")).not.toContain("group");
  });

  it("PV-D31: an older backend that sends no isOperatorRoot hides Platform from a root owner (fails closed)", () => {
    const old: Me = { ...rootOwner, companies: GROUP.map((c) => ({ ...c, isOperatorRoot: undefined })) };
    expect(adminKeys(old, "co-holding")).not.toContain("platform");
    expect(adminKeys(old, "co-holding")).toContain("group");
  });

  it("a platform_admin sees Platform everywhere and Group on the root", () => {
    const admin = inGroup([{ role: "platform_admin", scopeType: "global", scopeId: null }]);
    expect(adminKeys(admin, "co-agency")).toContain("platform");
    expect(adminKeys(admin, "co-agency")).not.toContain("group");
    expect(adminKeys(admin, "co-holding")).toContain("platform");
    expect(adminKeys(admin, "co-holding")).toContain("group");
  });

  it("answers the same through gateAllows directly (the gates the Admin rows carry)", () => {
    const gates: Record<string, Gate> = { group: { kind: "rootGroup" }, platform: { kind: "platformOperator" }, settings: { kind: "cap", cap: "admin.access" } };
    expect(gateAllows(gates.group, ctx(rootOwner, "co-holding"))).toBe(true);
    expect(gateAllows(gates.group, ctx(rootOwner, "co-agency"))).toBe(false);
    expect(gateAllows(gates.platform, ctx(rootOwner, "co-resort"))).toBe(true);
    expect(gateAllows(gates.platform, ctx(customerOwner, "cust-root"))).toBe(false);
    expect(gateAllows(gates.settings, ctx(rootOwner, "co-holding"))).toBe(true);
    expect(gateAllows(gates.settings, ctx(inGroup([grant("member", "co-holding")]), "co-holding"))).toBe(false);
  });
});

// Departments (nav.test 'person nodes') are exercised with person leaves elsewhere; this keeps the helper honest.
describe("fixture sanity", () => {
  it("a placed person is offered their own department first", () => {
    const m = { ...base, roles: [grant("member", "c1")], userId: "u-9" };
    const model = modelFor(m, "c1", node("root", "Agency", "company", [node("d-web", "Web Dev", "department", [person("p", "u-9")])]));
    expect(model.workspaces[0]).toMatchObject({ id: "d-web", mine: true, home: true });
  });
});
