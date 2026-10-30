import { describe, it, expect } from "vitest";
import type { Me } from "./platform";
import { ADMIN_ROWS, ASSISTANT_ROW, COMPANY_ROWS, GENERIC_WORKSPACE, PERFORMANCE_ROWS, WORKSPACES, sidebarRows, workspaceBySlug, type Gate } from "./workspaces";
import { approvalsGateInput, concreteRows, functionalConsoleFor, gateAllows, holdsDecideRight, homeArea, resolveMyWorkspaces } from "./workspaceAccess";
import { areaFor, resolveArea } from "./areas";
import { AGENCY, HOTEL, ROOT, agencyTree, lead, me, member, node, person } from "./workspaceFixtures";

const ctx = (m: Me, tenantId: string, unitPath: string[] = []) => ({ me: m, tenantId, unitPath });

// DW-9d: these were parity tests against the classic `navFor`. It is gone (DW-D38), so each case now states the answer the classic nav gave
// (pinned from its output before removal). The wider gate cases of nav.test.ts live in `workspaceGates.test.ts`.
describe("gateAllows keeps the gates the classic nav had (gates unchanged, plan §2.6 rule 4)", () => {
  const ROWS: Record<string, string> = {
    clients: "/clients", deliverables: "/deliverables", timesheets: "/timesheets", agency: "/agency",
    meetings: "/meetings", pipeline: "/pipeline", monitoring: "/monitoring",
  };
  const ALL = Object.keys(ROWS);
  // The rows the classic nav listed for each case, pinned. `invoices` is the Invoices row (agency row AND company.manage).
  const cases: [string, Me, string, { rows: string[]; invoices: boolean }][] = [
    ["agency company", me([{ role: "company_admin", scopeType: "company", scopeId: "co-a" }]), "co-a", { rows: ALL, invoices: true }],
    ["hospitality company", me([{ role: "company_admin", scopeType: "company", scopeId: "co-h" }], [HOTEL]), "co-h", { rows: [], invoices: false }],
    ["agency with the agency module off", me([member()], [{ ...AGENCY, enabledModules: ["pm", "clients"] }]), "co-a",
      { rows: ["clients", "deliverables", "timesheets", "meetings", "pipeline"], invoices: false }],
  ];

  it.each(cases)("shows the agency rows exactly as the classic nav did: %s", (_name, m, tenant, expected) => {
    for (const row of ALL) {
      expect(gateAllows({ kind: "agencyRow", row: row as never }, ctx(m, tenant)), row).toBe(expected.rows.includes(row));
    }
    const invoices: Gate = { kind: "all", gates: [{ kind: "agencyRow", row: "invoices" }, { kind: "cap", cap: "company.manage" }] };
    expect(gateAllows(invoices, ctx(m, tenant))).toBe(expected.invoices);
  });

  const rootOwner = me([{ role: "owner", scopeType: "company", scopeId: "co-root" }], [ROOT, AGENCY]);
  it.each([
    ["the root owner in the root", rootOwner, "co-root", { group: true, platform: false, settings: true }],
    ["the root owner in a child", rootOwner, "co-a", { group: false, platform: false, settings: false }],
    // PV-D31: only the owner of the OPERATOR root gets Platform.
    ["the operator root's owner", me([{ role: "owner", scopeType: "company", scopeId: "co-root" }], [{ ...ROOT, isOperatorRoot: true }, AGENCY]), "co-root", { group: true, platform: true, settings: true }],
    ["platform_admin in the root", me([{ role: "platform_admin", scopeType: "global", scopeId: null }], [ROOT, AGENCY]), "co-root", { group: true, platform: true, settings: true }],
    ["a member", me([member()]), "co-a", { group: false, platform: false, settings: false }],
  ] as [string, Me, string, { group: boolean; platform: boolean; settings: boolean }][])("shows Group, Platform and Settings as the classic nav did: %s", (_name, m, tenant, expected) => {
    expect(gateAllows({ kind: "rootGroup" }, ctx(m, tenant))).toBe(expected.group);
    expect(gateAllows({ kind: "platformOperator" }, ctx(m, tenant))).toBe(expected.platform);
    expect(gateAllows({ kind: "cap", cap: "admin.access" }, ctx(m, tenant))).toBe(expected.settings);
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
    // The company-wide question the classic nav asked stays false for the head.
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

// AIP-13b (BFF section 65): "Department guidance", at /departments/{dept}/assistant-guidance, is the LAST tab of the Overview strip (after
// Notices and the department calendar). It was the AI Assistant row's second tab until the AIP-13d live walk (2026-10-30) found that row
// opens the drawer, so the tab showed only on its own page. Offered through `unitCap` to the unit's head (or an enclosing unit's), the
// company admin and the owner; never to anyone else; dropped with no department id.
describe("the Overview strip's Department guidance tab (AIP-13b)", () => {
  const webDev = workspaceBySlug("web-dev")!;
  const overviewTabs = (m: Me, unitPath: string[], deptId: string | null) => {
    // With no department id every tab of the strip needs one, so the whole row drops: that reads as no tabs.
    const row = concreteRows([sidebarRows(webDev).top[0]], { ...ctx(m, "co-a", unitPath), deptId })[0];
    return (row?.tabs ?? []).map((t) => t.label);
  };
  const BASE = ["Overview", "Notices", "Department calendar"];
  const WITH = [...BASE, "Department guidance"];
  const admin = me([{ role: "company_admin", scopeType: "company", scopeId: "co-a" }]);
  const owner = me([{ role: "owner", scopeType: "company", scopeId: "co-a" }]);

  it("is the Overview strip's last tab, gated by unitCap, and the AI Assistant row is the drawer alone", () => {
    const tab = sidebarRows(webDev).top[0].tabs.at(-1)!;
    expect(tab).toMatchObject({ key: "guidance", href: "/departments/{dept}/assistant-guidance", gate: { kind: "unitCap", cap: "assistant.preamble.edit" } });
    expect(ASSISTANT_ROW.tabs.map((t) => t.key)).toEqual(["assistant"]);
    expect(overviewTabs(admin, ["d-web", "root"], "d-web")).toEqual(WITH);
  });
  it("is offered to the company admin and the owner on any unit", () => {
    expect(overviewTabs(admin, ["d-seo", "root"], "d-web")).toEqual(WITH);
    expect(overviewTabs(owner, ["d-web", "root"], "d-web")).toEqual(WITH);
  });
  it("is offered to the head of the unit and of an enclosing one", () => {
    expect(overviewTabs(me([member(), lead("d-web")]), ["d-web", "root"], "d-web")).toEqual(WITH);
    expect(overviewTabs(me([member(), lead("d-web")]), ["d-web-fe", "d-web", "root"], "d-web")).toEqual(WITH);
  });
  it("is not offered to a member, a head of a sibling or of a unit below, or a manager", () => {
    expect(overviewTabs(me([member()]), ["d-web", "root"], "d-web")).toEqual(BASE);
    expect(overviewTabs(me([member(), lead("d-seo")]), ["d-web", "root"], "d-web")).toEqual(BASE);
    expect(overviewTabs(me([member(), lead("d-web-fe")]), ["d-web", "root"], "d-web")).toEqual(BASE);
    expect(overviewTabs(me([{ role: "manager", scopeType: "company", scopeId: "co-a" }]), ["d-web", "root"], "d-web")).toEqual(BASE);
  });
  it("is dropped for a workspace with no department id, even for the company admin", () => {
    expect(overviewTabs(admin, [], null)).not.toContain("Department guidance");
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
  // Approvals, which stays ungated as today until DW-8 rules on it; so 19 here (Campaigns landed with
  // DW-5b, Clients with DW-6d, My tasks with DW-8a, so no planned row is left hidden in this list). PV7-06 added
  // "My performance" at the head of the Performance block: 20.
  it("gives a Web Dev employee 20 rows, the same with the planned rows included", () => {
    expect(rowsFor(employee).map((r) => r.key)).toEqual([
      "overview", "assistant", "pm", "build", "run", "website", "requests", "campaigns", "clients", "tools",
      "performance", "reports", "analytics", "appraisals", "learning", "tasks", "inbox", "calendar", "approvals", "me",
    ]);
    expect(rowsFor(employee, true)).toHaveLength(20);
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

describe("the decider gate: Approvals when it concerns you (DW-D23)", () => {
  const plain = me([member()]);
  // A member of the agency who is company_admin of the hotel: a decider, though not in the active company.
  const deciderElsewhere = me([member(), { role: "company_admin", scopeType: "company", scopeId: "co-h" }], [AGENCY, HOTEL]);
  const decider: Gate = { kind: "decider" };

  it("allows when the approvals were not read (the palette, the classic shell) or the read failed", () => {
    expect(gateAllows(decider, ctx(plain, "co-a"))).toBe(true);
    expect(gateAllows(decider, { ...ctx(plain, "co-a"), approvals: null })).toBe(true);
  });

  it("hides the row from someone with nothing waiting and no right to decide", () => {
    expect(gateAllows(decider, { ...ctx(plain, "co-a"), approvals: { pending: 0 } })).toBe(false);
  });

  it("shows it when something waits on the person, whatever their rights", () => {
    expect(gateAllows(decider, { ...ctx(plain, "co-a"), approvals: { pending: 2 } })).toBe(true);
  });

  it("shows it to someone who decides in another of their companies (the inbox is cross-company)", () => {
    expect(gateAllows(decider, { ...ctx(deciderElsewhere, "co-a"), approvals: { pending: 0 } })).toBe(true);
  });

  it("counts only the items that wait on this person's own decision, and a failed read is null", () => {
    expect(approvalsGateInput({ items: [{ decidable: true }, { decidable: false }, { decidable: true }], unavailable: false })).toEqual({ pending: 2 });
    expect(approvalsGateInput({ items: [], unavailable: true })).toBeNull();
  });

  it("puts the pending count on the Approvals row, only when above 0", () => {
    const you = sidebarRows(workspaceBySlug("web-dev")!).you;
    const approvalsRow = (m: Me, approvals: { pending: number } | null | undefined) =>
      concreteRows(you, { ...ctx(m, "co-a"), deptId: null, approvals }).find((r) => r.key === "approvals");
    expect(approvalsRow(plain, { pending: 3 })?.count).toBe(3);
    expect(approvalsRow(plain, { pending: 0 })).toBeUndefined();
    expect(approvalsRow(deciderElsewhere, { pending: 0 })).toMatchObject({ key: "approvals" });
    expect(approvalsRow(deciderElsewhere, { pending: 0 })?.count).toBeUndefined();
    expect(approvalsRow(plain, undefined)?.count).toBeUndefined();
  });
});

describe("the decider gate while the approvals read is in flight (DW-9d)", () => {
  const plain = me([member()]);
  const admin = me([member(), { role: "company_admin", scopeType: "company", scopeId: "co-a" }]);
  const you = sidebarRows(workspaceBySlug("web-dev")!).you;
  const inflightRow = (m: Me) => concreteRows(you, { ...ctx(m, "co-a"), deptId: null, approvals: "inflight" }).find((r) => r.key === "approvals");

  it("holdsDecideRight is the server-side boolean: a decide right, in any reachable company, with no read", () => {
    expect(holdsDecideRight(plain)).toBe(false);
    expect(holdsDecideRight(admin)).toBe(true);
  });

  it("keeps the row for everyone (the client settles it) and records the boolean and the badge on it", () => {
    expect(inflightRow(plain)).toMatchObject({ key: "approvals", awaitsApprovals: { decider: false, badge: true } });
    expect(inflightRow(admin)).toMatchObject({ key: "approvals", awaitsApprovals: { decider: true, badge: true } });
    expect(inflightRow(plain)?.count).toBeUndefined();
  });

  it("marks no other row of the You block as waiting on the read", () => {
    const rows = concreteRows(you, { ...ctx(plain, "co-a"), deptId: null, approvals: "inflight" });
    expect(rows.filter((r) => r.awaitsApprovals).map((r) => r.key)).toEqual(["approvals"]);
  });

  it("a settled read leaves no row marked", () => {
    for (const approvals of [{ pending: 2 }, null, undefined] as const) {
      expect(concreteRows(you, { ...ctx(plain, "co-a"), deptId: null, approvals }).some((r) => r.awaitsApprovals)).toBe(false);
    }
  });

  // `concreteRows` marks a row whose OWN gate (or badge) is the decider; `applyApprovals` settles whole rows. A decider gate on a tab alone
  // would be neither marked nor settled, so the registry must keep the decider on the Approvals row (and its one tab) only.
  it("is used by the Approvals row and its tab only, anywhere in the registry", () => {
    const rows = [...WORKSPACES, GENERIC_WORKSPACE].flatMap((w) => { const r = sidebarRows(w); return [...r.top, ...r.work, ...r.performance, ...r.you]; })
      .concat(COMPANY_ROWS, ADMIN_ROWS);
    for (const row of rows) {
      const uses = (g: Gate | undefined) => JSON.stringify(g ?? null).includes('"decider"');
      if (uses(row.gate) || row.tabs.some((t) => uses(t.gate))) expect(row.key).toBe("approvals");
    }
  });
});

describe("functionalConsoleFor (DW-7d: one home for HR, Finance and IT)", () => {
  it("sends a functional department's Home to its console, whatever its node id", () => {
    expect(functionalConsoleFor("HR")).toBe("/hr");
    expect(functionalConsoleFor("Finance")).toBe("/finance");
    expect(functionalConsoleFor("IT")).toBe("/it");
    expect(functionalConsoleFor(" finance ")).toBe("/finance");
  });
  it("leaves every other department on the generic Home", () => {
    expect(functionalConsoleFor("Web Dev")).toBeNull();
    expect(functionalConsoleFor("GM")).toBeNull();
    expect(functionalConsoleFor("Human Resources")).toBeNull();
    expect(functionalConsoleFor("")).toBeNull();
  });
});

// AIP-05 and AIP-16 (BFF section 66): who is OFFERED the AI usage tabs and the company page. A mirror of PERMISSION-CONTRACT section 58, never the
// authority: the server decides every read. The department tab is `any` of the unit's head (`unitCap`) and the company read; the company row is the
// company read or the GM SEAT (`leadGm`, because the GM is a seat and no capability can name it); My AI use is offered to everyone.
describe("the AI usage tabs and the company page (AIP-05, AIP-16)", () => {
  const analytics = PERFORMANCE_ROWS.find((r) => r.key === "analytics")!;
  const companyRow = COMPANY_ROWS.find((r) => r.key === "ai-usage")!;
  const tabs = (m: Me, unitPath: string[], deptId: string | null) =>
    concreteRows([analytics], { ...ctx(m, "co-a", unitPath), deptId })[0].tabs
      .filter((t) => t.key === "ai-use" || t.key === "ai-usage")
      .map((t) => `${t.label} ${t.href}`);
  const MINE = "My AI use /analytics/ai-usage";
  const DEPT = "AI usage /analytics/ai-usage/department?unit=d-web";
  const admin = me([{ role: "company_admin", scopeType: "company", scopeId: "co-a" }]);
  const owner = me([{ role: "owner", scopeType: "company", scopeId: "co-a" }]);
  const superadmin = me([{ role: "platform_admin", scopeType: "global", scopeId: null as unknown as string }]);
  const GM_UNITS = { gm: ["d-gm"], "social-media": ["d-soc"] };
  const companyRowOffered = (m: Me, units: Record<string, string[]> = GM_UNITS) => gateAllows(companyRow.gate, { ...ctx(m, "co-a"), units });

  it("offers a member only My AI use, whatever department they are looking at", () => {
    expect(tabs(me([member()]), ["d-web", "root"], "d-web")).toEqual([MINE]);
    expect(tabs(me([{ role: "manager", scopeType: "company", scopeId: "co-a" }]), ["d-web", "root"], "d-web")).toEqual([MINE]);
  });
  it("offers the head of the unit, and of an enclosing unit, AI usage for it", () => {
    expect(tabs(me([member(), lead("d-web")]), ["d-web", "root"], "d-web")).toEqual([MINE, DEPT]);
    expect(tabs(me([member(), lead("d-web")]), ["d-web-fe", "d-web", "root"], "d-web")).toEqual([MINE, DEPT]);
  });
  it("does not offer the head of a sibling, or of a unit only below, AI usage for this department", () => {
    expect(tabs(me([member(), lead("d-seo")]), ["d-web", "root"], "d-web")).toEqual([MINE]);
    expect(tabs(me([member(), lead("d-web-fe")]), ["d-web", "root"], "d-web")).toEqual([MINE]);
  });
  it("offers the company read (a company admin, the owner, the superadmin) both tabs on any department", () => {
    expect(tabs(admin, ["d-seo", "root"], "d-web")).toEqual([MINE, DEPT]);
    expect(tabs(owner, ["d-web", "root"], "d-web")).toEqual([MINE, DEPT]);
    expect(tabs(superadmin, ["d-web", "root"], "d-web")).toEqual([MINE, DEPT]);
  });
  it("drops the department tab, and keeps My AI use, for a workspace with no department id", () => {
    expect(tabs(admin, [], null)).toEqual([MINE]);
  });

  it("offers the company page in the Company area to the company read and the GM seat, and to no one else", () => {
    expect(companyRowOffered(admin)).toBe(true);
    expect(companyRowOffered(owner)).toBe(true);
    expect(companyRowOffered(superadmin)).toBe(true);
    expect(companyRowOffered(me([member(), lead("d-gm")]))).toBe(true);
  });
  it("does not offer the company page to a member, a manager, a Social head or a head of another department", () => {
    expect(companyRowOffered(me([member()]))).toBe(false);
    expect(companyRowOffered(me([{ role: "manager", scopeType: "company", scopeId: "co-a" }]))).toBe(false);
    expect(companyRowOffered(me([member(), lead("d-soc")]))).toBe(false);
    expect(companyRowOffered(me([member(), lead("d-web")]))).toBe(false);
  });
  it("offers the GM seat nothing when the company's GM unit is not known, and not a head whose lead seat is in another company", () => {
    expect(companyRowOffered(me([member(), lead("d-gm")]), {})).toBe(false);
    expect(companyRowOffered(me([member(), lead("d-gm", ["co-b"])]))).toBe(false);
  });
  it("is in the Company area's rows for the company read and out of them for a member", () => {
    const rowKeys = (m: Me) => concreteRows(COMPANY_ROWS, { ...ctx(m, "co-a"), units: GM_UNITS, deptId: null }).map((r) => r.key);
    expect(rowKeys(admin)).toContain("ai-usage");
    expect(rowKeys(me([member(), lead("d-gm")]))).toContain("ai-usage");
    expect(rowKeys(me([member()]))).not.toContain("ai-usage");
  });
});
