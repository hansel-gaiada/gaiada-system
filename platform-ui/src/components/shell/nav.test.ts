import { describe, it, expect } from "vitest";
import { navFor, canManageIT } from "./nav";
import type { Me } from "@/lib/platform";

const base: Me = {
  userId: "u1", name: "Clement Hansel", email: "hansel@gaiada.com", title: "AI Manager",
  assurance: "high", companies: [{ id: "c1", name: "Gaiada HQ", type: null }], roles: [],
};

describe("navFor (RBAC-gated visibility)", () => {
  it("member sees Workspace/Organization/Business/Intelligence/Systems but no Settings, no Rollups", () => {
    const groups = navFor({ ...base, roles: [{ role: "member", scopeType: "company", scopeId: "c1" }] });
    const labels = groups.map((g) => g.label);
    expect(labels).toEqual(["Workspace", "Organization", "Business", "Intelligence", "Systems"]);
    const business = groups.find((g) => g.label === "Business")!;
    expect(business.items.map((i) => i.label)).not.toContain("Rollups");
    // Companies moved into the Organization Overview; Organization = Overview + Departments.
    const org = groups.find((g) => g.label === "Organization")!;
    expect(org.items.map((i) => i.label)).toEqual(["Overview", "Departments"]);
    // No standalone IT group (IT is now a department) and no People in Workspace (now HR).
    const workspace = groups.find((g) => g.label === "Workspace")!;
    expect(workspace.items.map((i) => i.label)).toEqual(["My Work", "Calendar", "Approvals"]);
  });
  it("attaches business departments plus the functional HR/IT departments as children", () => {
    const groups = navFor(
      { ...base, roles: [{ role: "member", scopeType: "company", scopeId: "c1" }] },
      "c1",
      [{ id: "dept-1", name: "Web Dev" }, { id: "dept-2", name: "SEO" }],
    );
    const depts = groups.find((g) => g.label === "Organization")!.items.find((i) => i.label === "Departments")!;
    expect(depts.children?.map((c) => c.label)).toEqual(["Web Dev", "SEO", "HR", "IT"]);
    expect(depts.children?.map((c) => c.href)).toEqual(["/departments/dept-1", "/departments/dept-2", "/hr", "/it"]);
  });
  it("still lists HR and IT when no business departments are passed", () => {
    const groups = navFor({ ...base, roles: [{ role: "member", scopeType: "company", scopeId: "c1" }] }, "c1");
    const depts = groups.find((g) => g.label === "Organization")!.items.find((i) => i.label === "Departments")!;
    expect(depts.children?.map((c) => c.label)).toEqual(["HR", "IT"]);
  });
  it("platform_admin gets a Settings entry and Rollups", () => {
    const groups = navFor({ ...base, roles: [{ role: "platform_admin", scopeType: "global", scopeId: null }] });
    expect(groups.flatMap((g) => g.items).some((i) => i.label === "Settings" && i.href === "/admin")).toBe(true);
    const business = groups.find((g) => g.label === "Business")!;
    expect(business.items.map((i) => i.label)).toContain("Rollups");
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
