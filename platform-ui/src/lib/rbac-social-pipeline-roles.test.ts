// SCP-1b (docs/PERMISSION-CONTRACT.md §53.9, §53.4) — the UI mirror of the two scope-only Social Media roles.
// Their bundles (platform-nest role-permission-bundles.json) are social.post.read, social.engagement.read and one pipeline
// step each, so the mirror gives them `social.view` and nothing else (rbac-capability-parity.test.ts proves the biconditional
// for every capability). Neither makes anyone a social approver: canLeadSocial is unchanged.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { can, canLeadSocial, isStaff, CAPABILITIES, ROLE_CAPS } from "./rbac";
import type { Me } from "./platform";

const companies = [
  { id: "co-a", name: "Company A", type: "agency" },
  { id: "co-b", name: "Company B", type: "agency" },
];
function me(roles: Me["roles"]): Me {
  return { userId: "u", name: "U", email: "u@x.com", title: null, assurance: "high", companies, roles };
}
const units = { social: ["d-social-media"], gm: ["d-gm"] };

describe("SCP-1b: social_copywriter and social_designer in the UI mirror", () => {
  for (const role of ["social_copywriter", "social_designer"] as const) {
    it(`${role} reads Social Media work in its own company only, and gains no other capability`, () => {
      const m = me([{ role, scopeType: "company", scopeId: "co-a" }]);
      expect(can(m, "social.view", "co-a")).toBe(true);
      expect(can(m, "social.view", "co-b")).toBe(false);
      for (const cap of CAPABILITIES.filter((c) => c !== "social.view")) expect(can(m, cap, "co-a"), cap).toBe(false);
      expect(ROLE_CAPS[role]).toEqual(["social.view"]);
      expect(isStaff(m)).toBe(true);
    });

    it(`${role} is not a social approver (canLeadSocial unchanged)`, () => {
      expect(canLeadSocial(me([{ role, scopeType: "company", scopeId: "co-a" }]), "co-a", units)).toBe(false);
    });
  }

  it("the bundles the mirror follows carry exactly these keys", () => {
    const bundles = JSON.parse(
      readFileSync(join(__dirname, "../../../platform-nest/src/rbac/role-permission-bundles.json"), "utf8"),
    ) as { roles: Record<string, string[]> };
    expect(bundles.roles.social_copywriter).toEqual(["social.engagement.read", "social.post.proofread", "social.post.read"]);
    expect(bundles.roles.social_designer).toEqual(["social.engagement.read", "social.post.design", "social.post.read"]);
  });
});
