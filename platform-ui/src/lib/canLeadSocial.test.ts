import { describe, it, expect } from "vitest";
import type { Me } from "./platform";
import { canLeadSocial } from "./rbac";
import { gateAllows, resolveMyWorkspaces, workspaceUnitsOf, type OrgTreeNode } from "./workspaceAccess";
import { AGENCY, lead, me, member, node, person, type Company } from "./workspaceFixtures";

// SCP-Q19 (owner, 2026-10-26), PERMISSION §53.4: the Social approvers are EXACTLY the Social Media head (lead seat), the GM (lead
// seat), the owner and platform_admin. The UI mirror hides rows; the server decides.

const OTHER: Company = { id: "co-b", name: "Other", type: null, vertical: "agency", rootCompanyId: "co-root" };
const units = { social: ["d-soc"], gm: ["d-gm"] };

/** An agency company with Social Media, Web Dev and the Office of the GM. */
const tree: OrgTreeNode = node("root", "Agency", "company", [
  node("d-soc", "Social Media", "department", [person("p-soc-0", "u-1")]),
  node("d-web", "Web Dev", "department"),
  node("d-gm", "GM", "department"),
]);

describe("canLeadSocial: the four Social approvers", () => {
  it("the Social Media head, by their lead seat in this company", () => {
    expect(canLeadSocial(me([member(), lead("d-soc")]), "co-a", units)).toBe(true);
  });

  it("the GM, by their lead seat on the company's GM unit", () => {
    expect(canLeadSocial(me([member(), lead("d-gm")]), "co-a", units)).toBe(true);
  });

  it("the owner, at global scope or on this company", () => {
    expect(canLeadSocial(me([{ role: "owner", scopeType: "company", scopeId: "co-a" }]), "co-a", units)).toBe(true);
    expect(canLeadSocial(me([{ role: "owner", scopeType: "global", scopeId: null as unknown as string }]), "co-a", units)).toBe(true);
  });

  it("platform_admin", () => {
    expect(canLeadSocial(me([{ role: "platform_admin", scopeType: "global", scopeId: null as unknown as string }]), "co-a", units)).toBe(true);
  });

  it("nobody else: a member, a head of another unit, company_admin, manager", () => {
    expect(canLeadSocial(me([member()]), "co-a", units)).toBe(false);
    expect(canLeadSocial(me([member(), lead("d-web")]), "co-a", units)).toBe(false);
    expect(canLeadSocial(me([member(), { role: "company_admin", scopeType: "company", scopeId: "co-a" }]), "co-a", units)).toBe(false);
    expect(canLeadSocial(me([member(), { role: "manager", scopeType: "company", scopeId: "co-a" }]), "co-a", units)).toBe(false);
  });

  it("is per company: an owner of another company, or a lead seat backed by another company, does not count", () => {
    expect(canLeadSocial(me([{ role: "owner", scopeType: "company", scopeId: "co-b" }], [AGENCY, OTHER]), "co-a", units)).toBe(false);
    expect(canLeadSocial(me([member(), lead("d-soc", ["co-b"])], [AGENCY, OTHER]), "co-a", units)).toBe(false);
    expect(canLeadSocial(me([member(), lead("d-soc")]), null, units)).toBe(false);
  });

  it("without the company's units, only the owner and platform_admin arms can allow", () => {
    const none = { social: [], gm: [] };
    expect(canLeadSocial(me([member(), lead("d-soc")]), "co-a", none)).toBe(false);
    expect(canLeadSocial(me([{ role: "owner", scopeType: "company", scopeId: "co-a" }]), "co-a", none)).toBe(true);
  });
});

describe("the leadSocial gate", () => {
  const gate = { kind: "leadSocial" } as const;
  const ctxFor = (m: Me) => ({ me: m, tenantId: "co-a", unitPath: [], units: workspaceUnitsOf(resolveMyWorkspaces({ me: m, tenantId: "co-a", root: tree })) });

  it("finds the company's Social Media and GM units by the workspace each department resolves to", () => {
    const u = workspaceUnitsOf(resolveMyWorkspaces({ me: me([member()]), tenantId: "co-a", root: tree }));
    expect(u["social-media"]).toEqual(["d-soc"]);
    expect(u.gm).toEqual(["d-gm"]);
  });

  it("allows the Social head and the GM, refuses another unit's head", () => {
    expect(gateAllows(gate, ctxFor(me([member(), lead("d-soc")])))).toBe(true);
    expect(gateAllows(gate, ctxFor(me([member(), lead("d-gm")])))).toBe(true);
    expect(gateAllows(gate, ctxFor(me([member(), lead("d-web")])))).toBe(false);
    expect(gateAllows(gate, ctxFor(me([member()])))).toBe(false);
  });

  it("hides the lead arm when the units are not known", () => {
    expect(gateAllows(gate, { me: me([member(), lead("d-soc")]), tenantId: "co-a", unitPath: [] })).toBe(false);
  });
});
