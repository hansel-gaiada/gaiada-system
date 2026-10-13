import { describe, it, expect } from "vitest";
import { activeCompany, isRootCompany, isRootOwner, isOperatorRootOwner, isPlatformOperator, moduleOn } from "./companyContext";
import type { Me } from "./platform";

// PV-D31: `root` is the OPERATOR root. `cust` is a second root (a future subscriber's organization),
// unmarked, used by the PV-D31 cases below.
const companies: Me["companies"] = [
  { id: "root", name: "Holding", type: "holding", vertical: "holding", enabledModules: ["pm"], rootCompanyId: "root", isOperatorRoot: true },
  { id: "kid", name: "Agency", type: "agency", vertical: "agency", enabledModules: ["pm", "clients"], rootCompanyId: "root", isOperatorRoot: false },
];
const withCustomer: Me["companies"] = [
  ...companies,
  { id: "cust", name: "Customer", type: "holding", vertical: "holding", rootCompanyId: "cust", isOperatorRoot: false },
];
const me = (roles: Me["roles"], cs = companies): Me => ({
  userId: "u", name: "U", email: "u@x", title: null, assurance: "high", companies: cs, roles,
});
const owner = (scopeId: string | null, scopeType = "company") => ({ role: "owner", scopeType, scopeId });

describe("activeCompany", () => {
  it("returns the company matching the tenant, else the first", () => {
    expect(activeCompany(me([]), "kid")?.id).toBe("kid");
    expect(activeCompany(me([]), "unknown")?.id).toBe("root");
    expect(activeCompany(me([]), null)?.id).toBe("root");
    expect(activeCompany(me([]))?.id).toBe("root");
  });
  it("is undefined when the person has no company", () => {
    expect(activeCompany(me([], []), "kid")).toBeUndefined();
  });
});

describe("isRootCompany", () => {
  it("is true only when the company is its own root", () => {
    expect(isRootCompany(companies[0])).toBe(true);
    expect(isRootCompany(companies[1])).toBe(false);
  });
  it("is false for a missing root id (older backend) and for no company", () => {
    expect(isRootCompany({ id: "x", name: "X", type: null })).toBe(false);
    expect(isRootCompany({ id: "x", name: "X", type: null, rootCompanyId: null })).toBe(false);
    expect(isRootCompany(undefined)).toBe(false);
  });
});

describe("isRootOwner (PV-D20)", () => {
  it("is true for owner, company-scoped, on a root", () => {
    expect(isRootOwner(me([owner("root")]))).toBe(true);
  });
  it("is false for owner of a child only", () => {
    expect(isRootOwner(me([owner("kid")]))).toBe(false);
  });
  it("is false for another role on the root, a global owner grant, or a grant on a company not in me.companies", () => {
    expect(isRootOwner(me([{ role: "company_admin", scopeType: "company", scopeId: "root" }]))).toBe(false);
    expect(isRootOwner(me([owner(null, "global")]))).toBe(false);
    expect(isRootOwner(me([owner("elsewhere")]))).toBe(false);
  });
});

describe("isOperatorRootOwner (PV-D31)", () => {
  it("is true for owner of the operator root only", () => {
    expect(isOperatorRootOwner(me([owner("root")], withCustomer))).toBe(true);
    expect(isOperatorRootOwner(me([owner("cust")], withCustomer))).toBe(false);
    expect(isOperatorRootOwner(me([owner("kid")], withCustomer))).toBe(false);
  });
  it("fails closed on an older backend that sends no isOperatorRoot", () => {
    const old = companies.map((c) => ({ ...c, isOperatorRoot: undefined }));
    expect(isOperatorRootOwner(me([owner("root")], old))).toBe(false);
  });
  it("needs the marked company to also BE a root (a marker on a non-root is ignored)", () => {
    const odd: Me["companies"] = [{ id: "kid", name: "Agency", type: "agency", rootCompanyId: "root", isOperatorRoot: true }];
    expect(isOperatorRootOwner(me([owner("kid")], odd))).toBe(false);
  });
});

describe("isPlatformOperator (PV-D18, narrowed by PV-D31)", () => {
  it("is false for the owner of a CUSTOMER root, who is still a root owner for the Group area", () => {
    const custOwner = me([owner("cust")], withCustomer);
    expect(isRootOwner(custOwner)).toBe(true);
    expect(isPlatformOperator(custOwner)).toBe(false);
  });
  it("is true for platform_admin at global scope", () => {
    expect(isPlatformOperator(me([{ role: "platform_admin", scopeType: "global", scopeId: null }]))).toBe(true);
  });
  it("is true for a root owner and false for a child owner or a member", () => {
    expect(isPlatformOperator(me([owner("root")]))).toBe(true);
    expect(isPlatformOperator(me([owner("kid")]))).toBe(false);
    expect(isPlatformOperator(me([{ role: "member", scopeType: "company", scopeId: "root" }]))).toBe(false);
  });
  it("is false for platform_admin scoped to one company (not a global grant)", () => {
    expect(isPlatformOperator(me([{ role: "platform_admin", scopeType: "company", scopeId: "kid" }]))).toBe(false);
  });
});

describe("moduleOn", () => {
  it("is true when the module is listed and false when it is not", () => {
    expect(moduleOn(companies[1], "clients")).toBe(true);
    expect(moduleOn(companies[0], "clients")).toBe(false);
  });
  it("treats a missing enabledModules (and a missing company) as unknown, which hides nothing", () => {
    expect(moduleOn({ id: "x", name: "X", type: null }, "clients")).toBe(true);
    expect(moduleOn(undefined, "clients")).toBe(true);
  });
  it("treats an EMPTY list as 'nothing is on', not as unknown", () => {
    expect(moduleOn({ id: "x", name: "X", type: null, enabledModules: [] }, "clients")).toBe(false);
  });
});
