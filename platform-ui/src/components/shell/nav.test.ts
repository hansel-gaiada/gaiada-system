import { describe, it, expect } from "vitest";
import { navFor, canManageIT } from "./nav";
import type { Me } from "@/lib/platform";

// PV1-04: what the menu reads off the active company. `c1` is an agency that is its own root, with
// every module on.
const MODULES = ["agency", "pm", "it", "invoice", "clients", "knowledge", "automation-console", "hr", "reports", "monitoring"];
const base: Me = {
  userId: "u1", name: "Clement Hansel", email: "hansel@gaiada.com", title: "AI Manager",
  assurance: "high",
  companies: [{ id: "c1", name: "Gaiada HQ", type: null, vertical: "agency", enabledModules: MODULES, rootCompanyId: "c1" }],
  roles: [],
};

// A group: a holding root with an agency and a hospitality company under it.
const GROUP: Me["companies"] = [
  { id: "co-holding", name: "Holding", type: "holding", vertical: "holding", enabledModules: MODULES, rootCompanyId: "co-holding" },
  { id: "co-agency", name: "Agency", type: "agency", vertical: "agency", enabledModules: MODULES, rootCompanyId: "co-holding" },
  { id: "co-resort", name: "Resort", type: "resort", vertical: "hospitality", enabledModules: MODULES, rootCompanyId: "co-holding" },
];
const inGroup = (roles: Me["roles"]): Me => ({ ...base, companies: GROUP, roles });
const AGENCY_ROWS = ["Clients", "Deliverables", "Timesheets", "Agency", "Meetings", "Delivery Pipeline", "Monitoring"];
const labelsOf = (groups: ReturnType<typeof navFor>, group: string) => groups.find((g) => g.label === group)?.items.map((i) => i.label);

describe("navFor (RBAC-gated visibility)", () => {
  it("member sees Workspace/Organization/Departments/Business/Reports/Intelligence but no Settings, no Platform, no Group", () => {
    const groups = navFor({ ...base, roles: [{ role: "member", scopeType: "company", scopeId: "c1" }] });
    const labels = groups.map((g) => g.label);
    expect(labels).toEqual(["Me", "Workspace", "Organization", "Departments", "Business", "Reports", "Appraisals", "Learning", "Intelligence"]);
    // Employee-portal wave A: "Me" is FIRST and ungated — every principal with a staff surface has a
    // personal hub, and there is no capability to hold. Gating it would gate someone out of their own
    // leave, loans and inbox.
    const meGroup = groups.find((g) => g.label === "Me")!;
    expect(meGroup.items.map((i) => i.label)).toEqual(["Overview", "Inbox", "Leave", "Loans", "Learning"]);
    // LMS L1c: a plain member sees Learning's Overview + Catalogue but NOT Compliance — the
    // catalogue is everybody's (training you cannot see is a support ticket, not a security
    // posture), while Compliance reads other people's progress and is gated on lms.progress.view.
    const learning = groups.find((g) => g.label === "Learning")!;
    expect(learning.items.map((i) => i.label)).toEqual(["Overview", "Catalogue"]);
    const business = groups.find((g) => g.label === "Business")!;
    // PV1-04: Rollups moved out of Business into the Group area, so no one finds it here any more.
    expect(business.items.map((i) => i.label)).not.toContain("Rollups");
    // CC-D8 — Client Centre is the Profile tab of the client hub, not a second sidebar row.
    expect(business.items.map((i) => i.label)).toContain("Clients");
    expect(business.items.map((i) => i.label)).not.toContain("Client Centre");
    // 2026-08-10 owner directive: Business collapses to ONE "Project Management" entry — Projects
    // and Tasks are no longer separate sidebar rows (they're tabs on /project-management now).
    expect(business.items.map((i) => i.label)).not.toContain("Projects");
    expect(business.items.map((i) => i.label)).not.toContain("Tasks");
    expect(business.items[0]).toEqual({ label: "Project Management", href: "/project-management", icon: "projects" });
    // MON — Monitoring (Plane B: the CLIENT's properties) is ungated in the sidebar, so a plain
    // member must see it. Pinned as an equality assertion rather than a `toContain` because the
    // point is that it is NOT capability-gated here: the backend's `monitoring.read` is the real
    // boundary, and adding a UI gate would hide a surface the server would happily serve, which
    // reads to the user as "broken" rather than "forbidden".
    expect(business.items).toContainEqual({ label: "Monitoring", href: "/monitoring", icon: "pulse" });
    // TR-17: a plain member always sees the self/scoped grain reports, never the exec-only Company one.
    const reports = groups.find((g) => g.label === "Reports")!;
    expect(reports.items.map((i) => i.label)).toEqual(["My Report", "Project Reports", "Department Reports"]);
    // TR-26: a plain member always sees their own appraisal history (self-service, no capability
    // gates it — same reasoning as check-ins) but never the manager/HR consoles.
    const appraisals = groups.find((g) => g.label === "Appraisals")!;
    expect(appraisals.items.map((i) => i.label)).toEqual(["My Appraisals"]);
    // Companies moved into the Organization Overview; Organization = Overview only.
    const org = groups.find((g) => g.label === "Organization")!;
    expect(org.items.map((i) => i.label)).toEqual(["Overview"]);
    // No standalone IT group (IT is now a department) and no People in Workspace (now HR).
    // P4-A5: the cross-project scope surface (/pm) sits right after Dashboard — ungated, same as
    // Business's own Project Management row. 2026-08-10: relabelled "PM" -> "Project Management"
    // (PM_TERMS.projectManagement) — the same string Business's row and every department console's
    // Work group now use.
    const workspace = groups.find((g) => g.label === "Workspace")!;
    expect(workspace.items.map((i) => i.label)).toEqual(["Dashboard", "Project Management", "Calendar", "Approvals"]);
    expect(workspace.items.find((i) => i.label === "Project Management")!.href).toBe("/pm");
  });
  it("renders Departments as its own group: business departments plus functional HR/IT", () => {
    const groups = navFor(
      { ...base, roles: [{ role: "member", scopeType: "company", scopeId: "c1" }] },
      "c1",
      [{ id: "dept-1", name: "Web Dev" }, { id: "dept-2", name: "SEO" }],
    );
    const depts = groups.find((g) => g.label === "Departments")!;
    expect(depts.items.map((i) => i.label)).toEqual(["Web Dev", "SEO", "HR", "IT", "Finance"]);
    expect(depts.items.map((i) => i.href)).toEqual(["/departments/dept-1", "/departments/dept-2", "/hr", "/it", "/finance"]);
  });
  // GM-01/OQ-4: GM is the ROOT of the department spine (platform-nest `seed/roster.ts`:
  // `DEPT_PARENT["d-gm"] = null`, every other department parents to it), so it must not sort
  // among its own children.
  it("hoists GM to the top of the Departments group whatever order it arrives in", () => {
    const groups = navFor(
      { ...base, roles: [{ role: "member", scopeType: "company", scopeId: "c1" }] },
      "c1",
      [{ id: "dept-1", name: "Web Dev" }, { id: "dept-2", name: "SEO" }, { id: "dept-5", name: "GM" }],
    );
    const depts = groups.find((g) => g.label === "Departments")!;
    expect(depts.items.map((i) => i.label)).toEqual(["GM", "Web Dev", "SEO", "HR", "IT", "Finance"]);
    // Ordering only — the href is untouched, so every existing deep link still resolves.
    expect(depts.items[0].href).toBe("/departments/dept-5");
  });

  it("keeps the GM row for a plain member — the row is ungated, the CONSOLE gates its content", () => {
    // A UI gate here would hide a department from the org tree, which would lie about the chart.
    // `lib/gm.ts` refuses the CONTENT instead, so a member who clicks gets an explanation.
    const groups = navFor(
      { ...base, roles: [{ role: "member", scopeType: "company", scopeId: "c1" }] },
      "c1",
      [{ id: "dept-5", name: "GM" }],
    );
    const depts = groups.find((g) => g.label === "Departments")!;
    expect(depts.items.map((i) => i.label)).toContain("GM");
  });

  it("keeps GM inside the Departments visual cap by hoisting it", () => {
    // GM arrives LAST from the org structure, so without the hoist it sorts to the bottom of a
    // wide estate's list instead of sitting with its children.
    const many = [
      { id: "d1", name: "Web Dev" }, { id: "d2", name: "SEO" }, { id: "d3", name: "Creatives" },
      { id: "d4", name: "Social Media" }, { id: "d5", name: "Legal" }, { id: "d6", name: "Finance" },
      { id: "d7", name: "GM" },
    ];
    const groups = navFor({ ...base, roles: [{ role: "member", scopeType: "company", scopeId: "c1" }] }, "c1", many);
    const depts = groups.find((g) => g.label === "Departments")!;
    expect(depts.items.map((i) => i.label)).toContain("GM");
  });

  it("still lists HR and IT in the Departments group when no business departments are passed", () => {
    const groups = navFor({ ...base, roles: [{ role: "member", scopeType: "company", scopeId: "c1" }] }, "c1");
    const depts = groups.find((g) => g.label === "Departments")!;
    expect(depts.items.map((i) => i.label)).toEqual(["HR", "IT", "Finance"]);
  });
  // An org structure that already has a Finance department must NOT get a second Finance row —
  // one label, two destinations, is how a nav loses trust. The org row is re-pointed at the
  // bespoke console instead.
  it("re-points an org-structure Finance department at /finance instead of duplicating it", () => {
    const groups = navFor(
      { ...base, roles: [{ role: "member", scopeType: "company", scopeId: "c1" }] },
      "c1",
      [{ id: "d1", name: "Web Dev" }, { id: "d6", name: "Finance" }],
    );
    const depts = groups.find((g) => g.label === "Departments")!;
    const finance = depts.items.filter((i) => i.label === "Finance");
    expect(finance).toHaveLength(1);
    expect(finance[0].href).toBe("/finance");
    expect(depts.items.map((i) => i.label)).toEqual(["Web Dev", "Finance", "HR", "IT"]);
  });

  it("platform_admin gets a Settings entry, Platform and the Group area (with Rollups, no longer in Business)", () => {
    const groups = navFor({ ...base, roles: [{ role: "platform_admin", scopeType: "global", scopeId: null }] });
    expect(groups.flatMap((g) => g.items).some((i) => i.label === "Settings" && i.href === "/admin")).toBe(true);
    expect(labelsOf(groups, "Business")).not.toContain("Rollups");
    // The exec-only company-grain report left Reports for Group > Company reports (§8, PV-D11).
    expect(labelsOf(groups, "Reports")).not.toContain("Company Report");
    expect(groups.find((g) => g.label === "Group")!.items).toEqual([
      { label: "Group report", href: "/group", icon: "chart" },
      { label: "Rollups", href: "/rollups", icon: "pulse" },
      { label: "Company reports", href: "/group/reports", icon: "inventory" },
    ]);
    expect(groups.some((g) => g.label === "Systems")).toBe(false);
    // platform_admin holds every appraisal capability — both the manager/HR console and cycle admin.
    const appraisals = groups.find((g) => g.label === "Appraisals")!;
    expect(appraisals.items.map((i) => i.label)).toEqual(["My Appraisals", "Team Appraisals", "Appraisal Cycles"]);
  });
  // The 64px rail draws ONE glyph per multi-row group (NavGroupSection → RailCategory). A group that
  // forgets `icon` still renders — it silently falls back to a generic `box`, so the rail grows a
  // second anonymous square instead of failing. This is that missing failure. See
  // docs/sidebar-nav-map.md for the placement record this guards.
  it("gives every collapsible group a rail glyph, and pins only Workspace", () => {
    const groups = navFor({ ...base, roles: [{ role: "platform_admin", scopeType: "global", scopeId: null }] }, "c1");
    const needsGlyph = groups.filter((g) => g.label && !g.pinned && g.items.length > 1);
    expect(needsGlyph.filter((g) => !g.icon).map((g) => g.label)).toEqual([]);
    // Two pinned groups would put 7 flat rows above the glyphs and undo the rail.
    expect(groups.filter((g) => g.pinned).map((g) => g.label)).toEqual(["Workspace"]);
    // Distinct glyphs: the same shape twice in a 12-icon column is unreadable.
    const glyphs = needsGlyph.map((g) => g.icon!);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });
});

describe("navFor follows the active company's pack (PV-D15, PV-D17)", () => {
  const member = (companies: Me["companies"]): Me => ({ ...base, companies, roles: [{ role: "member", scopeType: "company", scopeId: companies[0].id }] });

  it("an agency company shows the agency rows", () => {
    const groups = navFor(member(GROUP), "co-agency");
    expect(labelsOf(groups, "Business")).toEqual(["Project Management", ...AGENCY_ROWS]);
  });
  it("shows Invoices in an agency company only with company.manage", () => {
    const admin = inGroup([{ role: "company_admin", scopeType: "company", scopeId: "co-agency" }]);
    expect(labelsOf(navFor(admin, "co-agency"), "Business")).toContain("Invoices");
    expect(labelsOf(navFor(member(GROUP), "co-agency"), "Business")).not.toContain("Invoices");
  });
  it("a hospitality company shows none of the agency rows, only Project Management", () => {
    const groups = navFor(member(GROUP), "co-resort");
    expect(labelsOf(groups, "Business")).toEqual(["Project Management"]);
  });
  it("hides Invoices in a hospitality company even for a company admin", () => {
    const admin = inGroup([{ role: "company_admin", scopeType: "company", scopeId: "co-resort" }]);
    expect(labelsOf(navFor(admin, "co-resort"), "Business")).not.toContain("Invoices");
  });
  it("a holding company shows none of them either", () => {
    expect(labelsOf(navFor(member(GROUP), "co-holding"), "Business")).toEqual(["Project Management"]);
  });
  it("a missing vertical counts as general, so the agency rows are hidden rather than guessed", () => {
    const old: Me = { ...base, companies: [{ id: "c1", name: "Old backend", type: "agency" }], roles: [] };
    expect(labelsOf(navFor(old, "c1"), "Business")).toEqual(["Project Management"]);
  });
  it("reads the ACTIVE company, so switching company changes the rows for the same person", () => {
    const me = member(GROUP);
    expect(labelsOf(navFor(me, "co-agency"), "Business")).toContain("Clients");
    expect(labelsOf(navFor(me, "co-resort"), "Business")).not.toContain("Clients");
  });
  it("a module that is off hides its row; the others stay", () => {
    const noClients = member([{ ...GROUP[1], enabledModules: MODULES.filter((m) => m !== "clients") }]);
    const rows = labelsOf(navFor(noClients, "co-agency"), "Business")!;
    expect(rows).not.toContain("Clients");
    expect(rows).toContain("Deliverables");
    const noAgency = member([{ ...GROUP[1], enabledModules: MODULES.filter((m) => m !== "agency" && m !== "monitoring") }]);
    const rows2 = labelsOf(navFor(noAgency, "co-agency"), "Business")!;
    expect(rows2).not.toContain("Agency");
    expect(rows2).not.toContain("Monitoring");
    expect(rows2).toContain("Clients");
  });
  it("hides the Invoices row when the invoice module is off, even for company.manage", () => {
    const admin: Me = { ...base, companies: [{ ...GROUP[1], enabledModules: MODULES.filter((m) => m !== "invoice") }], roles: [{ role: "company_admin", scopeType: "company", scopeId: "co-agency" }] };
    expect(labelsOf(navFor(admin, "co-agency"), "Business")).not.toContain("Invoices");
  });
  it("treats a missing enabledModules as unknown and hides nothing", () => {
    const { enabledModules: _drop, ...bare } = GROUP[1];
    expect(labelsOf(navFor(member([bare]), "co-agency"), "Business")).toEqual(["Project Management", ...AGENCY_ROWS]);
  });
});

describe("navFor Platform and Group areas (PV-D11, PV-D18, PV-D20)", () => {
  const groupNames = (me: Me, tenant: string) => navFor(me, tenant).map((g) => g.label);
  const rootOwner = inGroup([
    { role: "owner", scopeType: "company", scopeId: "co-holding" },
    { role: "owner", scopeType: "company", scopeId: "co-agency" },
  ]);

  it("a member sees neither Platform nor Group, in any company", () => {
    const me = inGroup([{ role: "member", scopeType: "company", scopeId: "co-holding" }]);
    for (const t of ["co-holding", "co-agency", "co-resort"]) {
      expect(groupNames(me, t)).not.toContain("Platform");
      expect(groupNames(me, t)).not.toContain("Group");
    }
  });
  it("a root owner sees Platform in every company, and Group only while the root is active", () => {
    expect(groupNames(rootOwner, "co-holding")).toContain("Platform");
    expect(groupNames(rootOwner, "co-agency")).toContain("Platform");
    expect(groupNames(rootOwner, "co-resort")).toContain("Platform");
    expect(groupNames(rootOwner, "co-holding")).toContain("Group");
    expect(groupNames(rootOwner, "co-agency")).not.toContain("Group");
    expect(groupNames(rootOwner, "co-resort")).not.toContain("Group");
  });
  it("Platform carries the five former Systems rows, same hrefs", () => {
    const platform = navFor(rootOwner, "co-holding").find((g) => g.label === "Platform")!;
    expect(platform.items.map((i) => [i.label, i.href])).toEqual([
      ["WA/TG Bot", "/systems/bot"], ["AI Gateway", "/systems/gateway"], ["MCP Hub", "/systems/hub"],
      ["Automation", "/systems/automation"], ["Observability", "/systems/observability"],
    ]);
  });
  it("an owner of a CHILD company only is not a root owner", () => {
    const childOwner = inGroup([{ role: "owner", scopeType: "company", scopeId: "co-agency" }]);
    expect(groupNames(childOwner, "co-holding")).not.toContain("Platform");
    expect(groupNames(childOwner, "co-holding")).not.toContain("Group");
  });
  it("a platform_admin sees Platform everywhere and Group on the root", () => {
    const admin = inGroup([{ role: "platform_admin", scopeType: "global", scopeId: null }]);
    expect(groupNames(admin, "co-agency")).toContain("Platform");
    expect(groupNames(admin, "co-agency")).not.toContain("Group");
    expect(groupNames(admin, "co-holding")).toContain("Platform");
    expect(groupNames(admin, "co-holding")).toContain("Group");
  });
  it("keeps the rail glyphs distinct with Platform and Group both present", () => {
    const groups = navFor(rootOwner, "co-holding");
    const glyphs = groups.filter((g) => g.label && !g.pinned && g.items.length > 1).map((g) => g.icon);
    expect(glyphs.every(Boolean)).toBe(true);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });
});

describe("canManageIT", () => {
  const withRoles = (roles: string[]): Me => ({ ...base, roles: roles.map((role) => ({ role, scopeType: "global", scopeId: null })) });
  it("is true for elevated (platform_admin — IAM-15 removed the second elevated role)", () => {
    expect(canManageIT(withRoles(["platform_admin"]))).toBe(true);
  });
  it("is true for a dedicated IT role", () => {
    expect(canManageIT(withRoles(["it_admin"]))).toBe(true);
    expect(canManageIT(withRoles(["it_manager"]))).toBe(true);
  });
  it("is false for a plain member", () => {
    expect(canManageIT(withRoles(["member"]))).toBe(false);
  });
});
