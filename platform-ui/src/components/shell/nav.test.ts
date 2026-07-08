import { describe, it, expect } from "vitest";
import { navFor } from "./nav";
import type { Me } from "@/lib/platform";

const base: Me = {
  userId: "u1", name: "Clement Hansel", email: "hansel@gaiada.com", title: "AI Manager",
  assurance: "high", companies: [{ id: "c1", name: "Gaiada HQ", type: null }], roles: [],
};

describe("navFor (RBAC-gated visibility)", () => {
  it("member sees Workspace/Business/Intelligence/Systems but no Admin, no Rollups", () => {
    const groups = navFor({ ...base, roles: [{ role: "member", scopeType: "company", scopeId: "c1" }] });
    const labels = groups.map((g) => g.label);
    expect(labels).toEqual(["Workspace", "Business", "Intelligence", "Systems"]);
    const business = groups.find((g) => g.label === "Business")!;
    expect(business.items.map((i) => i.label)).not.toContain("Rollups");
  });
  it("platform_admin sees Admin group and Rollups", () => {
    const groups = navFor({ ...base, roles: [{ role: "platform_admin", scopeType: "global", scopeId: null }] });
    expect(groups.map((g) => g.label)).toContain("Admin");
    const business = groups.find((g) => g.label === "Business")!;
    expect(business.items.map((i) => i.label)).toContain("Rollups");
  });
});
