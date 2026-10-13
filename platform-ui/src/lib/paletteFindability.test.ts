// DW-2e: the workspace shell's command palette is built from the registry (plan §2.6 rule 3, "⌘K finds
// everything a person may open"). The findability test builds the entry list exactly as `Shell` does
// and checks it against what the person can open: the nav and every tab of the model.
import { describe, it, expect } from "vitest";
import type { Me } from "./platform";
import { navFor } from "@/components/shell/nav";
import { can } from "./rbac";
import { resolveMyWorkspaces, type ConcreteRow, type OrgTreeNode } from "./workspaceAccess";
import { buildShellModel, type ShellModel, type ShellWorkspace } from "./shellModel";
import { buildDeptEntries, buildNavEntries, buildWorkspaceEntries, mergePaletteEntries, workspacePaletteEntries } from "./palette";
import { activeCompany } from "./companyContext";
import { AGENCY, HOTEL, ROOT, agencyTree, me, member, node, person } from "./workspaceFixtures";

const departmentsOf = (root: OrgTreeNode) => root.children.filter((n) => n.kind === "department").map((n) => ({ id: n.id, name: n.name }));

/** Everything `Shell` does for the workspace shell, from a persona. */
function build(m: Me, tenantId: string, root: OrgTreeNode) {
  const departments = departmentsOf(root);
  const model = buildShellModel({ me: m, tenantId, workspaces: resolveMyWorkspaces({ me: m, tenantId, root }) });
  const nav = navFor(m, tenantId, departments);
  const today = [...buildNavEntries(nav), ...buildDeptEntries(departments, activeCompany(m, tenantId)?.vertical, (t) => !t.requires || can(m, t.requires, tenantId))];
  return { model, nav, entries: workspacePaletteEntries(model, today) };
}

const modelHrefs = (model: ShellModel) => [
  ...model.workspaces.flatMap((w) => [...w.rows.top, ...w.rows.work, ...w.rows.performance, ...w.rows.you]),
  ...model.company, ...model.admin,
].flatMap((r) => r.tabs.map((t) => t.href));

const AGENCY_ROOT = { ...AGENCY, id: "co-root", name: "Group", rootCompanyId: "co-root" };
const owner = { role: "owner", scopeType: "company", scopeId: "co-root" };
const hotelTree = node("root", "Hotel", "company", [node("d-hk", "Housekeeping", "department", [person("p-1", "u-1")])]);

const PERSONAS: [string, Me, string, OrgTreeNode][] = [
  ["a placed Web Dev employee in an agency company", me([member()]), "co-a", agencyTree({ web: ["u-1"] })],
  ["an unplaced owner of the operator root", me([owner], [{ ...AGENCY_ROOT, isOperatorRoot: true }]), "co-root", agencyTree()],
  ["an owner of a customer root", me([owner], [AGENCY_ROOT]), "co-root", agencyTree()],
  ["HR staff with no HR org node", me([member(), { role: "hr_staff", scopeType: "company", scopeId: "co-a" }]), "co-a", agencyTree()],
  ["a member of a generic-pack company", me([member("co-h")], [HOTEL]), "co-h", hotelTree],
  ["platform_admin", me([{ role: "platform_admin", scopeType: "global", scopeId: null }], [ROOT, AGENCY]), "co-root", agencyTree()],
];

describe.each(PERSONAS)("the workspace shell's palette finds everything: %s", (_name, m, tenantId, root) => {
  const { model, nav, entries } = build(m, tenantId, root);
  const hrefs = entries.map((e) => e.href);

  it("has an entry for every page navFor offers", () => {
    for (const href of nav.flatMap((g) => g.items.map((i) => i.href))) expect(hrefs, href).toContain(href);
  });

  it("has an entry for every concrete tab of every workspace, Company and Admin", () => {
    for (const href of modelHrefs(model)) expect(hrefs, href).toContain(href);
  });

  it("offers no unfilled placeholder", () => {
    for (const e of entries) expect(e.href, e.id).not.toMatch(/[{}]/);
  });

  it("has unique ids and no duplicate hrefs", () => {
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

// ── Labels and sections ──────────────────────────────────────────────────────────────────────────

const tab = (key: string, label: string, href: string) => ({ key, label, href, icon: "home" as const });
const row = (key: string, label: string, tabs: ConcreteRow["tabs"]): ConcreteRow => ({ key, label, icon: "home", tabs });
function ws(id: string, label: string, over: Partial<ShellWorkspace["rows"]> = {}, home = false): ShellWorkspace {
  return {
    id, key: id, label, kind: "department", deptId: id, mine: home, home, lead: false,
    rows: {
      top: [row("overview", "Overview", [tab("overview", "Overview", "/departments/" + id)])],
      work: [], performance: [row("learning", "My learning", [tab("learning", "My learning", "/learning")])],
      you: [row("reports", "Reports", [tab("mine", "Mine", "/reports/mine")])], ...over,
    },
  };
}
const synthetic = (workspaces: ShellWorkspace[], company: ConcreteRow[] = [], admin: ConcreteRow[] = []): ShellModel =>
  ({ workspaces, company, admin, home: { kind: "company" } as ShellModel["home"], homeLabel: "Company", homeHref: null });

describe("buildWorkspaceEntries: labels and sections", () => {
  const work = [
    row("pm", "Board", [tab("board", "Board", "/d/web/board"), tab("timeline", "Timeline", "/d/web/timeline")]),
    row("build", "Build", [tab("build", "Build", "/d/web/build")]),
  ];
  const entries = buildWorkspaceEntries(synthetic([ws("web", "Web Dev", { work }, true), ws("seo", "SEO")]));
  const by = (href: string) => entries.find((e) => e.href === href)!;

  it("prefixes a department tab with its workspace, under that workspace's section", () => {
    expect(by("/d/web/board")).toMatchObject({ label: "Web Dev · Board", section: "Web Dev", id: "ws:/d/web/board" });
    expect(by("/d/web/timeline").label).toBe("Web Dev · Timeline");
  });

  it("uses the row's label once when its only tab carries it", () => {
    expect(by("/d/web/build").label).toBe("Web Dev · Build");
  });

  it("lists the shared blocks once, from the home workspace, labelled plainly", () => {
    expect(entries.filter((e) => e.href === "/learning")).toHaveLength(1);
    expect(by("/learning")).toMatchObject({ label: "My learning", section: "Performance" });
    expect(by("/reports/mine")).toMatchObject({ label: "Reports · Mine", section: "You" });
  });

  it("still offers another workspace's own Overview, under that workspace's name", () => {
    expect(by("/departments/web")).toMatchObject({ label: "Overview", section: "Web Dev" });
    expect(by("/departments/seo")).toMatchObject({ label: "SEO · Overview", section: "SEO" });
  });

  it("takes the shared blocks from the first workspace when home is Company", () => {
    const e = buildWorkspaceEntries(synthetic([ws("a", "Alpha"), ws("b", "Beta")]));
    expect(e.find((x) => x.href === "/learning")?.label).toBe("My learning");
    expect(e.filter((x) => x.href === "/learning")).toHaveLength(1);
  });

  it("puts the workspaces first, then Company, then Admin", () => {
    const e = buildWorkspaceEntries(synthetic([ws("web", "Web Dev", {}, true)],
      [row("clients", "Clients", [tab("clients", "Clients", "/clients")])],
      [row("admin", "Admin", [tab("users", "Users", "/admin/users")])]));
    expect(e.slice(-2).map((x) => [x.label, x.section])).toEqual([["Clients", "Company"], ["Admin · Users", "Admin"]]);
  });
});

describe("workspacePaletteEntries: the union with today's entries", () => {
  it("lets the registry's entry win a clash and keeps what only today's lists offer", () => {
    const model = synthetic([ws("web", "Web Dev", {}, true)]);
    const today = [
      { id: "nav:/learning", label: "Learning", href: "/learning", section: "Workspace", icon: "home" as const },
      { id: "nav:/old", label: "Old", href: "/old", section: "Workspace", icon: "home" as const },
    ];
    const e = workspacePaletteEntries(model, today);
    expect(e.find((x) => x.href === "/learning")?.label).toBe("My learning");
    expect(e.find((x) => x.href === "/old")?.id).toBe("nav:/old");
  });

  it("mergePaletteEntries keeps the first of a repeated href", () => {
    const a = { id: "1", label: "A", href: "/x", section: "s", icon: "home" as const };
    expect(mergePaletteEntries([a], [{ ...a, id: "2" }])).toEqual([a]);
  });
});
