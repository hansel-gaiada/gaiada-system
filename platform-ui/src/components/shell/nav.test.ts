import { describe, it, expect } from "vitest";
import { navFor, canManageIT } from "./nav";
import type { Me } from "@/lib/platform";

const base: Me = {
  userId: "u1", name: "Clement Hansel", email: "hansel@gaiada.com", title: "AI Manager",
  assurance: "high", companies: [{ id: "c1", name: "Gaiada HQ", type: null }], roles: [],
};

describe("navFor (RBAC-gated visibility)", () => {
  it("member sees Workspace/Organization/Departments/Business/Reports/Intelligence — Systems is admin/manager territory", () => {
    const groups = navFor({ ...base, roles: [{ role: "member", scopeType: "company", scopeId: "c1" }] });
    const labels = groups.map((g) => g.label);
    // Mirror trim 2026-09-08: every Systems row's backing read is admin- or manager-tier, so for a
    // member the whole group is empty and an empty group renders no header.
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
    expect(business.items.map((i) => i.label)).not.toContain("Rollups");
    // CC-D8 — Client Centre is the Profile tab of the client hub, not a second sidebar row.
    expect(business.items.map((i) => i.label)).toContain("Clients");
    expect(business.items.map((i) => i.label)).not.toContain("Client Centre");
    // 2026-08-10 owner directive: Business collapses to ONE "Project Management" entry — Projects
    // and Tasks are no longer separate sidebar rows (they're tabs on /project-management now).
    expect(business.items.map((i) => i.label)).not.toContain("Projects");
    expect(business.items.map((i) => i.label)).not.toContain("Tasks");
    expect(business.items[0]).toEqual({ label: "Project Management", href: "/project-management", icon: "projects" });
    // Owner decision 2026-09-08 (mirror trim, reversing the 2026-08 "ungated Plane B" call): the
    // sidebar mirrors Cerbos. A plain member's monitor READ is denied (resource_monitor.yaml lists
    // company_admin/manager/module tiers only), and the pipeline-run READ is manager-tier — so
    // neither row renders for a member. The rows come back with the role, not with a click.
    expect(business.items.map((i) => i.label)).not.toContain("Monitoring");
    expect(business.items.map((i) => i.label)).not.toContain("Delivery Pipeline");
    // TR-17 + mirror trim: self/scoped grains stay (their reads are attr-narrowed server-side);
    // the department grain is a role-tier read a plain member does not hold.
    const reports = groups.find((g) => g.label === "Reports")!;
    expect(reports.items.map((i) => i.label)).toEqual(["My Report", "Project Reports"]);
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
      "dept-1",
    );
    const depts = groups.find((g) => g.label === "Departments")!;
    // Mirror trim + own-department scope (owner decision 2026-09-08): a member sees the department
    // they are PLACED in, nothing else; the functional HR and Finance console rows require
    // hr.view / finance.statement.view; IT stays — a member may read devices.
    expect(depts.items.map((i) => i.label)).toEqual(["Web Dev", "IT"]);
    expect(depts.items.map((i) => i.href)).toEqual(["/departments/dept-1", "/it"]);
  });

  it("a manager keeps the full department list — pm.manage is the cross-department tier", () => {
    const groups = navFor(
      { ...base, roles: [{ role: "manager", scopeType: "company", scopeId: "c1" }] },
      "c1",
      [{ id: "dept-1", name: "Web Dev" }, { id: "dept-2", name: "SEO" }],
      "dept-1",
    );
    const depts = groups.find((g) => g.label === "Departments")!;
    expect(depts.items.map((i) => i.label)).toEqual(expect.arrayContaining(["Web Dev", "SEO"]));
  });

  it("an unplaced member gets no department rows, only the consoles their caps allow", () => {
    const groups = navFor(
      { ...base, roles: [{ role: "member", scopeType: "company", scopeId: "c1" }] },
      "c1",
      [{ id: "dept-1", name: "Web Dev" }],
    );
    const depts = groups.find((g) => g.label === "Departments")!;
    expect(depts.items.map((i) => i.label)).toEqual(["IT"]);
  });

  it("shows the functional HR and Finance rows to the roles whose reads they are", () => {
    // Module staff without pm.manage: no org-structure rows beyond their own placement (none here),
    // but the functional consoles their module tiers back are present.
    const groups = navFor(
      { ...base, roles: [
        { role: "hr_staff", scopeType: "company", scopeId: "c1" },
        { role: "finance_staff", scopeType: "company", scopeId: "c1" },
      ] },
      "c1",
      [{ id: "dept-1", name: "Web Dev" }],
    );
    const depts = groups.find((g) => g.label === "Departments")!;
    expect(depts.items.map((i) => i.label)).toEqual(["HR", "IT", "Finance"]);
  });

  it("manager keeps Delivery Pipeline and Monitoring — those reads are manager-tier", () => {
    const groups = navFor({ ...base, roles: [{ role: "manager", scopeType: "company", scopeId: "c1" }] }, "c1");
    const business = groups.find((g) => g.label === "Business")!;
    expect(business.items.map((i) => i.label)).toContain("Delivery Pipeline");
    expect(business.items.map((i) => i.label)).toContain("Monitoring");
  });

  it("Systems narrows by tier: manager gets Automation only, company_admin the full set; Knowledge is admin-tier", () => {
    const managerGroups = navFor({ ...base, roles: [{ role: "manager", scopeType: "company", scopeId: "c1" }] }, "c1");
    expect(managerGroups.find((g) => g.label === "Systems")!.items.map((i) => i.label)).toEqual(["Automation"]);
    expect(managerGroups.find((g) => g.label === "Intelligence")!.items.map((i) => i.label)).toEqual(["Assistant", "AI Agents", "The Office"]);
    const adminGroups = navFor({ ...base, roles: [{ role: "company_admin", scopeType: "company", scopeId: "c1" }] }, "c1");
    expect(adminGroups.find((g) => g.label === "Systems")!.items.map((i) => i.label)).toEqual(["WA/TG Bot", "AI Gateway", "MCP Hub", "Automation", "Observability"]);
    expect(adminGroups.find((g) => g.label === "Intelligence")!.items.map((i) => i.label)).toEqual(["Assistant", "Knowledge", "AI Agents", "The Office"]);
  });
  // GM-01/OQ-4: GM is the ROOT of the department spine (platform-nest `seed/roster.ts`:
  // `DEPT_PARENT["d-gm"] = null`, every other department parents to it), so it must not sort
  // among its own children.
  it("hoists GM to the top of the Departments group whatever order it arrives in", () => {
    const groups = navFor(
      { ...base, roles: [{ role: "manager", scopeType: "company", scopeId: "c1" }] },
      "c1",
      [{ id: "dept-1", name: "Web Dev" }, { id: "dept-2", name: "SEO" }, { id: "dept-5", name: "GM" }],
    );
    const depts = groups.find((g) => g.label === "Departments")!;
    expect(depts.items.map((i) => i.label)).toEqual(["GM", "Web Dev", "SEO", "IT"]);
    // Ordering only — the href is untouched, so every existing deep link still resolves.
    expect(depts.items[0].href).toBe("/departments/dept-5");
  });

  it("keeps the GM row for a member PLACED in GM — the scope is placement, the CONSOLE gates content", () => {
    // Own-department scope (2026-09-08): a member sees the department they are placed in. For the
    // person placed in GM that IS the GM row; `lib/gm.ts` still refuses the exec content on click.
    const groups = navFor(
      { ...base, roles: [{ role: "member", scopeType: "company", scopeId: "c1" }] },
      "c1",
      [{ id: "dept-5", name: "GM" }],
      "dept-5",
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
    const groups = navFor({ ...base, roles: [{ role: "manager", scopeType: "company", scopeId: "c1" }] }, "c1", many);
    const depts = groups.find((g) => g.label === "Departments")!;
    expect(depts.items.map((i) => i.label)).toContain("GM");
  });

  it("still lists IT in the Departments group when no business departments are passed (HR/Finance are cap-gated)", () => {
    const groups = navFor({ ...base, roles: [{ role: "member", scopeType: "company", scopeId: "c1" }] }, "c1");
    const depts = groups.find((g) => g.label === "Departments")!;
    expect(depts.items.map((i) => i.label)).toEqual(["IT"]);
  });
  // An org structure that already has a Finance department must NOT get a second Finance row —
  // one label, two destinations, is how a nav loses trust. The org row is re-pointed at the
  // bespoke console instead.
  it("re-points an org-structure Finance department at /finance only for someone the console serves", () => {
    // One label, one destination either way. For finance_staff the org row IS the money console; for
    // a plain member it stays an ordinary department read — the org chart is never hidden, and the
    // console the member's reads would refuse is never linked.
    const staff = navFor(
      { ...base, roles: [{ role: "finance_staff", scopeType: "company", scopeId: "c1" }] },
      "c1",
      [{ id: "d1", name: "Web Dev" }, { id: "d6", name: "Finance" }],
      "d6",
    );
    const staffFinance = staff.find((g) => g.label === "Departments")!.items.filter((i) => i.label === "Finance");
    expect(staffFinance).toHaveLength(1);
    expect(staffFinance[0].href).toBe("/finance");

    const member = navFor(
      { ...base, roles: [{ role: "member", scopeType: "company", scopeId: "c1" }] },
      "c1",
      [{ id: "d1", name: "Web Dev" }, { id: "d6", name: "Finance" }],
      "d6",
    );
    const memberFinance = member.find((g) => g.label === "Departments")!.items.filter((i) => i.label === "Finance");
    expect(memberFinance).toHaveLength(1);
    expect(memberFinance[0].href).toBe("/departments/d6");
  });

  it("platform_admin gets a Settings entry and Rollups", () => {
    const groups = navFor({ ...base, roles: [{ role: "platform_admin", scopeType: "global", scopeId: null }] });
    expect(groups.flatMap((g) => g.items).some((i) => i.label === "Settings" && i.href === "/admin")).toBe(true);
    const business = groups.find((g) => g.label === "Business")!;
    expect(business.items.map((i) => i.label)).toContain("Rollups");
    // Same `rollups.view` grant also unlocks the exec-only Company Report (§8: company-grain = exec-only).
    const reports = groups.find((g) => g.label === "Reports")!;
    expect(reports.items.map((i) => i.label)).toContain("Company Report");
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
