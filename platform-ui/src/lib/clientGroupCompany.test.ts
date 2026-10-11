import { describe, it, expect } from "vitest";
import type { Me } from "./platform";
import { groupCompanyOptions } from "./clientGroupCompany";

const company = (id: string, name: string, rootCompanyId: string | null) => ({ id, name, type: null, rootCompanyId });
const me = (roles: Me["roles"]): Me => ({
  userId: "u", name: "U", email: "u@x.test", title: null, assurance: "high",
  companies: [
    company("root", "Root", "root"), company("agency", "Agency", "root"), company("sib", "Sibling", "root"),
    company("other", "Elsewhere", "root-2"), company("loose", "No root", null),
  ],
  roles,
});

describe("PV3-04 · group-company picker options", () => {
  it("a platform_admin gets the active company's same-root siblings, never itself or another group", () => {
    const opts = groupCompanyOptions(me([{ role: "platform_admin", scopeType: "global", scopeId: null }]), "agency");
    expect(opts).toEqual([{ id: "root", name: "Root" }, { id: "sib", name: "Sibling" }]);
  });

  it("the owner of the ROOT gets it; the owner of a child does not (null = no picker at all)", () => {
    expect(groupCompanyOptions(me([{ role: "owner", scopeType: "company", scopeId: "root" }]), "agency")).not.toBeNull();
    expect(groupCompanyOptions(me([{ role: "owner", scopeType: "company", scopeId: "agency" }]), "agency")).toBeNull();
  });

  it("a member or company_admin gets no picker", () => {
    expect(groupCompanyOptions(me([{ role: "member", scopeType: "company", scopeId: "agency" }]), "agency")).toBeNull();
    expect(groupCompanyOptions(me([{ role: "company_admin", scopeType: "company", scopeId: "agency" }]), "agency")).toBeNull();
  });

  it("the current link stays selectable even when the person is not a member of that company", () => {
    const admin = me([{ role: "platform_admin", scopeType: "global", scopeId: null }]);
    const opts = groupCompanyOptions(admin, "agency", { id: "hidden", name: "Not In Switcher" });
    expect(opts?.[0]).toEqual({ id: "hidden", name: "Not In Switcher" });
    // Already present: not duplicated.
    expect(groupCompanyOptions(admin, "agency", { id: "sib", name: "Sibling" })?.filter((o) => o.id === "sib")).toHaveLength(1);
  });
});
