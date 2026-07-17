import { describe, it, expect } from "vitest";
import { canViewEmployee, findPlacement } from "./people";
import type { Me } from "./platform";
import type { OrgNode } from "./org";

function me(userId: string, roles: string[]): Me {
  return {
    userId,
    name: "T",
    email: "t@x.com",
    title: null,
    assurance: "high",
    companies: [],
    roles: roles.map((role) => ({ role, scopeType: "global", scopeId: null })),
  };
}

describe("canViewEmployee", () => {
  it("lets an employee view their own page", () => {
    expect(canViewEmployee(me("u-1", ["member"]), "u-1")).toBe(true);
  });

  it("blocks a plain member from viewing someone else", () => {
    expect(canViewEmployee(me("u-1", ["member"]), "u-2")).toBe(false);
  });

  it("lets a superadmin (platform_admin) view anyone", () => {
    expect(canViewEmployee(me("admin", ["platform_admin"]), "u-2")).toBe(true);
  });

  it("lets an owner (group_executive) view anyone", () => {
    expect(canViewEmployee(me("owner", ["group_executive"]), "u-2")).toBe(true);
  });
});

describe("findPlacement", () => {
  const tree: OrgNode = {
    id: "root", name: "Gaia Digital Agency", kind: "company", children: [
      { id: "d1", name: "Web Dev", kind: "department", children: [
        { id: "v1", name: "Frontend", kind: "division", children: [
          { id: "r1", name: "Senior Developer", kind: "role", children: [
            { id: "p1", name: "Made Putra", kind: "person", assigneeId: "u-dev", assigneeName: "Made Putra", children: [] },
          ] },
        ] },
      ] },
    ],
  };

  it("returns the ancestor chain (excluding the company root) for a placed person", () => {
    const chain = findPlacement(tree, "u-dev");
    expect(chain.map((s) => s.name)).toEqual(["Web Dev", "Frontend", "Senior Developer"]);
    expect(chain.map((s) => s.kind)).toEqual(["department", "division", "role"]);
  });

  it("returns an empty chain when the person isn't placed", () => {
    expect(findPlacement(tree, "u-nobody")).toEqual([]);
  });
});
