import { describe, it, expect } from "vitest";
import { navFor, canManageIT, cappedGroupItems, DEPARTMENTS_CAP, DEPARTMENTS_OVERFLOW_HREF } from "./nav";
import type { Me } from "@/lib/platform";

const base: Me = {
  userId: "u1", name: "Clement Hansel", email: "hansel@gaiada.com", title: "AI Manager",
  assurance: "high", companies: [{ id: "c1", name: "Gaiada HQ", type: null }], roles: [],
};

describe("navFor (RBAC-gated visibility)", () => {
  it("member sees Workspace/Organization/Departments/Business/Reports/Intelligence/Systems but no Settings, no Rollups", () => {
    const groups = navFor({ ...base, roles: [{ role: "member", scopeType: "company", scopeId: "c1" }] });
    const labels = groups.map((g) => g.label);
    expect(labels).toEqual(["Me", "Workspace", "Organization", "Departments", "Business", "Reports", "Appraisals", "Intelligence", "Systems"]);
    // Employee-portal wave A: "Me" is FIRST and ungated — every principal with a staff surface has a
    // personal hub, and there is no capability to hold. Gating it would gate someone out of their own
    // leave, loans and inbox.
    const meGroup = groups.find((g) => g.label === "Me")!;
    expect(meGroup.items.map((i) => i.label)).toEqual(["Overview", "Inbox", "Leave", "Loans"]);
    const business = groups.find((g) => g.label === "Business")!;
    expect(business.items.map((i) => i.label)).not.toContain("Rollups");
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
    expect(depts.items.map((i) => i.label)).toEqual(["Web Dev", "SEO", "HR", "IT"]);
    expect(depts.items.map((i) => i.href)).toEqual(["/departments/dept-1", "/departments/dept-2", "/hr", "/it"]);
  });
  it("still lists HR and IT in the Departments group when no business departments are passed", () => {
    const groups = navFor({ ...base, roles: [{ role: "member", scopeType: "company", scopeId: "c1" }] }, "c1");
    const depts = groups.find((g) => g.label === "Departments")!;
    expect(depts.items.map((i) => i.label)).toEqual(["HR", "IT"]);
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

// UI redesign §3.1 — the Departments visual cap is a RENDER-time concern (see nav.ts's own
// comment): navFor() itself must keep returning every department uncapped (a capability check
// must never be truncated), and this is a separate pure helper the render layer calls.
describe("cappedGroupItems (Sidebar §3.1 Departments overflow)", () => {
  const wideDepts = Array.from({ length: 9 }, (_, i) => ({ label: `Dept ${i}`, href: `/departments/d${i}`, icon: "hr" as const }));
  const wideGroup = { label: "Departments", icon: "hr" as const, items: wideDepts };

  it("leaves a group at or under the cap untouched", () => {
    const short = { label: "Departments", icon: "hr" as const, items: wideDepts.slice(0, 3) };
    expect(cappedGroupItems(short)).toEqual({ items: short.items, overflowCount: 0 });
  });

  it("truncates a wide Departments group and reports the overflow count", () => {
    const result = cappedGroupItems(wideGroup);
    expect(result.items).toHaveLength(DEPARTMENTS_CAP);
    expect(result.items).toEqual(wideDepts.slice(0, DEPARTMENTS_CAP));
    expect(result.overflowCount).toBe(wideDepts.length - DEPARTMENTS_CAP);
  });

  it("never caps a group that isn't Departments, however wide", () => {
    const business = { label: "Business", icon: "briefcase" as const, items: wideDepts };
    expect(cappedGroupItems(business).overflowCount).toBe(0);
  });

  it("points the overflow link at Organization, not a dead end", () => {
    expect(DEPARTMENTS_OVERFLOW_HREF).toBe("/organization");
  });
});

describe("canManageIT", () => {
  const withRoles = (roles: string[]): Me => ({ ...base, roles: roles.map((role) => ({ role, scopeType: "global", scopeId: null })) });
  it("is true for elevated (platform_admin / group_executive)", () => {
    expect(canManageIT(withRoles(["platform_admin"]))).toBe(true);
    expect(canManageIT(withRoles(["group_executive"]))).toBe(true);
  });
  it("is true for a dedicated IT role", () => {
    expect(canManageIT(withRoles(["it_admin"]))).toBe(true);
    expect(canManageIT(withRoles(["it_manager"]))).toBe(true);
  });
  it("is false for a plain member", () => {
    expect(canManageIT(withRoles(["member"]))).toBe(false);
  });
});
