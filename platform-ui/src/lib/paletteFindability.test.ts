// DW-2e, DW-9d: the workspace shell's command palette is built from the registry (plan §2.6 rule 3, "⌘K finds
// everything a person may open") plus a small explicit list of gated pages (`STATIC_PALETTE_ENTRIES`). The findability
// test builds the entry list exactly as `Shell` does and checks it against what the person can open.
//
// The classic nav is gone (DW-D38), so it can no longer be the oracle. `WAS_FINDABLE` is its output, PINNED from the real
// `navFor` for these personas immediately before it was deleted: every page that was findable then must still be.
import { describe, it, expect } from "vitest";
import type { Me } from "./platform";
import { resolveMyWorkspaces, type ConcreteRow, type OrgTreeNode } from "./workspaceAccess";
import { buildShellModel, type ShellModel, type ShellWorkspace } from "./shellModel";
import { buildWorkspaceEntries, mergePaletteEntries, workspacePaletteEntries } from "./palette";
import { AGENCY, HOTEL, ROOT, agencyTree, me, member, node, person } from "./workspaceFixtures";

/** Everything `Shell` does for the workspace shell, from a persona. */
function build(m: Me, tenantId: string, root: OrgTreeNode) {
  const model = buildShellModel({ me: m, tenantId, workspaces: resolveMyWorkspaces({ me: m, tenantId, root }) });
  return { model, entries: workspacePaletteEntries(model, m, tenantId) };
}

const modelHrefs = (model: ShellModel) => [
  ...model.workspaces.flatMap((w) => [...w.rows.top, ...w.rows.work, ...w.rows.performance, ...w.rows.you]),
  ...model.company, ...model.admin,
].flatMap((r) => r.tabs.map((t) => t.href));

const AGENCY_ROOT = { ...AGENCY, id: "co-root", name: "Group", rootCompanyId: "co-root" };
const owner = { role: "owner", scopeType: "company", scopeId: "co-root" };
const hotelTree = node("root", "Hotel", "company", [node("d-hk", "Housekeeping", "department", [person("p-1", "u-1")])]);

// ── The pinned oracle: every href the classic nav offered, per persona ───────────────────────────
// ("/" is left out on purpose: it only redirects to the home Overview or the Company area, both of which are entries.)
const EVERYONE = [
  "/me", "/me/inbox", "/me/leave", "/me/loans", "/me/learning", "/pm", "/calendar", "/approvals",
  "/organization", "/organization/positions", "/organization/access", "/departments", "/hr", "/it", "/finance", "/project-management",
  "/reports/person", "/reports/project", "/reports/department", "/appraisals/mine",
  "/learning", "/learning/catalogue", "/assistant", "/knowledge", "/agents", "/office",
];
const AGENCY_ROWS = ["/clients", "/deliverables", "/timesheets", "/agency", "/meetings", "/pipeline", "/monitoring"];
const AGENCY_DEPTS = ["/departments/d-gm", "/departments/d-web", "/departments/d-seo"];
const COMPANY_ADMIN_TIER = ["/appraisals", "/learning/authoring", "/learning/compliance"];
const GROUP_AREA = ["/group", "/rollups", "/group/reports"];
const PLATFORM_AREA = ["/systems/bot", "/systems/gateway", "/systems/hub", "/systems/automation", "/systems/observability"];

const PERSONAS: [string, Me, string, OrgTreeNode, string[]][] = [
  ["a placed Web Dev employee in an agency company", me([member()]), "co-a", agencyTree({ web: ["u-1"] }),
    [...EVERYONE, ...AGENCY_ROWS, ...AGENCY_DEPTS]],
  ["an unplaced owner of the operator root", me([owner], [{ ...AGENCY_ROOT, isOperatorRoot: true }]), "co-root", agencyTree(),
    [...EVERYONE, ...AGENCY_ROWS, ...AGENCY_DEPTS, "/invoices", ...COMPANY_ADMIN_TIER, ...GROUP_AREA, ...PLATFORM_AREA, "/admin"]],
  ["an owner of a customer root", me([owner], [AGENCY_ROOT]), "co-root", agencyTree(),
    [...EVERYONE, ...AGENCY_ROWS, ...AGENCY_DEPTS, "/invoices", ...COMPANY_ADMIN_TIER, ...GROUP_AREA, "/admin"]],
  ["HR staff with no HR org node", me([member(), { role: "hr_staff", scopeType: "company", scopeId: "co-a" }]), "co-a", agencyTree(),
    [...EVERYONE, ...AGENCY_ROWS, ...AGENCY_DEPTS, "/learning/compliance"]],
  ["a member of a generic-pack company", me([member("co-h")], [HOTEL]), "co-h", hotelTree,
    [...EVERYONE, "/departments/d-hk"]],
  ["platform_admin", me([{ role: "platform_admin", scopeType: "global", scopeId: null }], [ROOT, AGENCY]), "co-root", agencyTree(),
    [...EVERYONE, ...AGENCY_DEPTS, ...COMPANY_ADMIN_TIER, "/appraisals/cycles", ...GROUP_AREA, ...PLATFORM_AREA, "/admin"]],
];

describe.each(PERSONAS)("the workspace shell's palette finds everything: %s", (_name, m, tenantId, root, wasFindable) => {
  const { model, entries } = build(m, tenantId, root);
  const hrefs = entries.map((e) => e.href);

  it("still finds every page the classic nav offered (pinned from navFor before its removal)", () => {
    for (const href of wasFindable) expect(hrefs, href).toContain(href);
  });

  it("has an entry for every concrete tab of every workspace, Company and Admin", () => {
    for (const href of modelHrefs(model)) expect(hrefs, href).toContain(href);
  });

  it("finds the client health board and the client report wherever the person is offered them (PV7-05)", () => {
    for (const href of ["/clients/health", "/reports/client"]) {
      if (modelHrefs(model).includes(href)) expect(entries.filter((e) => e.href === href), href).toHaveLength(1);
    }
  });

  it("finds My performance (PV7-06), once, under Performance", () => {
    const mine = entries.filter((e) => e.href === "/me/performance");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ label: "My performance", section: "Performance" });
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
    id, key: id, label, kind: "department", deptId: id, mine: home, home, lead: false, creates: [], withheld: [],
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

describe("workspacePaletteEntries: the model, then the explicit static entries", () => {
  it("lets the model's entry win a clash and keeps the static entries the model lacks", () => {
    const m = me([member()]);
    const e = workspacePaletteEntries(synthetic([ws("web", "Web Dev", {}, true)]), m, "co-a");
    // The synthetic model carries "/learning" as "My learning": that label wins over the static "Learning overview".
    expect(e.find((x) => x.href === "/learning")?.label).toBe("My learning");
    expect(e.find((x) => x.href === "/reports/project")?.id).toBe("static:/reports/project");
  });

  it("mergePaletteEntries keeps the first of a repeated href", () => {
    const a = { id: "1", label: "A", href: "/x", section: "s", icon: "home" as const };
    expect(mergePaletteEntries([a], [{ ...a, id: "2" }])).toEqual([a]);
  });
});

describe("Approvals stays findable where its row is hidden (DW-D23)", () => {
  // The row hides from a member with nothing waiting and no right to decide; the page must stay reachable by the palette.
  // The explicit static entry carries it now that the classic nav's entries are gone.
  it("finds /approvals, from the explicit entry, for a member whose sidebar has no Approvals row", () => {
    const m = me([member()]);
    const root = agencyTree({ web: ["u-1"] });
    const model = buildShellModel({ me: m, tenantId: "co-a", workspaces: resolveMyWorkspaces({ me: m, tenantId: "co-a", root }), approvals: { pending: 0 } });
    expect(model.workspaces[0].rows.you.map((r) => r.key)).not.toContain("approvals");
    expect(buildWorkspaceEntries(model).map((e) => e.href)).not.toContain("/approvals");
    const entries = workspacePaletteEntries(model, m, "co-a");
    expect(entries.find((e) => e.href === "/approvals")).toMatchObject({ id: "static:/approvals", label: "Approvals" });
  });

  it("offers it once, as the model's own entry, to someone the sidebar row is shown to", () => {
    const m = me([member()]);
    const root = agencyTree({ web: ["u-1"] });
    const model = buildShellModel({ me: m, tenantId: "co-a", workspaces: resolveMyWorkspaces({ me: m, tenantId: "co-a", root }), approvals: { pending: 2 } });
    const found = workspacePaletteEntries(model, m, "co-a").filter((e) => e.href === "/approvals");
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe("ws:/approvals");
  });
});

describe("a tab the person may not open is not offered (M5-V3-i, ported from buildDeptEntries)", () => {
  const web = agencyTree({ web: ["u-1"] });
  const visitors = "/departments/d-web/website/visitors";
  const hrefsFor = (roles: Me["roles"]) => build(me(roles), "co-a", web).entries.map((e) => e.href);

  it("leaves Visitors (search.visitors.read) out for a plain member, and offers it to a holder", () => {
    expect(hrefsFor([member()])).not.toContain(visitors);
    expect(hrefsFor([member(), { role: "search_manager", scopeType: "company", scopeId: "co-a" }])).toContain(visitors);
  });

  it("still offers the Website tabs that carry no gate", () => {
    expect(hrefsFor([member()])).toContain("/departments/d-web/website/analytics");
  });
});
