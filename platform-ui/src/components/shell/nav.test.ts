import { describe, it, expect } from "vitest";
import { navFor, canManageIT } from "./nav";
import type { Me } from "@/lib/platform";

const base: Me = {
  userId: "u1", name: "Clement Hansel", email: "hansel@gaiada.com", title: "AI Manager",
  assurance: "high", companies: [{ id: "c1", name: "Gaiada HQ", type: null }], roles: [],
};

describe("navFor (RBAC-gated visibility)", () => {
  it("member sees Workspace/Organization/Business/Intelligence/Systems but no Admin, no Rollups", () => {
    const groups = navFor({ ...base, roles: [{ role: "member", scopeType: "company", scopeId: "c1" }] });
    const labels = groups.map((g) => g.label);
    expect(labels).toEqual(["Workspace", "Organization", "Business", "Intelligence", "Systems", "IT"]);
    const business = groups.find((g) => g.label === "Business")!;
    expect(business.items.map((i) => i.label)).not.toContain("Rollups");
    // Companies moved under the new Organization group.
    const org = groups.find((g) => g.label === "Organization")!;
    expect(org.items.map((i) => i.label)).toEqual(["Overview", "Companies"]);
    // IT section is visible to everyone (read-only for non-managers).
    const itGroup = groups.find((g) => g.label === "IT")!;
    expect(itGroup.items.map((i) => i.label)).toEqual(["Overview", "Devices", "Topology", "Workflows"]);
  });
  it("platform_admin sees Admin group and Rollups", () => {
    const groups = navFor({ ...base, roles: [{ role: "platform_admin", scopeType: "global", scopeId: null }] });
    expect(groups.map((g) => g.label)).toContain("Admin");
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
