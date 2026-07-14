import { describe, it, expect } from "vitest";
import { canViewEmployee } from "./people";
import type { Me } from "./platform";

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
