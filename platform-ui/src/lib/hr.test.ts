import { describe, it, expect } from "vitest";
import {
  checklistProgress, hrScopeCompanies, hasHrScopeChoice, resolveHrScopeParam, fanOutHr,
  type HrCase, type HrScopeCompany,
} from "./hr";
import { PlatformError, type Me } from "./platform";

function me(over: Partial<Me>): Me {
  return {
    userId: "u1", name: "U", email: "u@x.com", title: null, assurance: "high",
    companies: [], roles: [], ...over,
  };
}
const kase = (items: { done: boolean }[]): Pick<HrCase, "details"> => ({ details: { items: items.map((i, n) => ({ label: `i${n}`, done: i.done })) } });

describe("checklistProgress", () => {
  it("counts done vs total, 0/0 when no items", () => {
    expect(checklistProgress(kase([]))).toEqual({ done: 0, total: 0 });
    expect(checklistProgress(kase([{ done: true }, { done: false }, { done: true }]))).toEqual({ done: 2, total: 3 });
  });
});

describe("hrScopeCompanies", () => {
  const companies = [
    { id: "co-a", name: "Agency", type: "agency" },
    { id: "co-b", name: "Resort", type: "resort" },
  ];

  it("elevated users reach every company they belong to", () => {
    const admin = me({ companies, roles: [{ role: "platform_admin", scopeType: "global", scopeId: null }] });
    expect(hrScopeCompanies(admin, "co-a").map((c) => c.id).sort()).toEqual(["co-a", "co-b"]);
  });

  it("a plain member with no hr grant and no service scope reaches nothing", () => {
    const member = me({ companies, roles: [{ role: "member", scopeType: "company", scopeId: "co-a" }] });
    expect(hrScopeCompanies(member, "co-a")).toEqual([]);
  });

  it("company_admin reaches hr.view in their own company only", () => {
    const admin = me({ companies, roles: [{ role: "company_admin", scopeType: "company", scopeId: "co-a" }] });
    expect(hrScopeCompanies(admin, "co-a").map((c) => c.id)).toEqual(["co-a"]);
  });

  it("adds served companies from serviceScopes (module='hr' only) with staff/manager role, active tenant first", () => {
    const staffer = me({
      companies: [{ id: "co-hold", name: "Holding", type: "holding" }],
      roles: [{ role: "company_admin", scopeType: "company", scopeId: "co-hold" }],
      serviceScopes: [
        { companyId: "co-a", companyName: "Agency", assignmentId: "a1", module: "hr", unitName: "HR", role: "staff" },
        { companyId: "co-b", companyName: "Resort", assignmentId: "a2", module: "hr", unitName: "HR", role: "manager" },
        { companyId: "co-c", companyName: "Other module", assignmentId: "a3", module: "it", unitName: "IT", role: "staff" },
      ],
    });
    const scope = hrScopeCompanies(staffer, "co-hold");
    expect(scope[0].id).toBe("co-hold"); // active tenant sorted first
    expect(scope.map((c) => c.id).sort()).toEqual(["co-a", "co-b", "co-hold"]);
    expect(scope.find((c) => c.id === "co-a")?.role).toBe("staff");
    expect(scope.find((c) => c.id === "co-b")?.role).toBe("manager");
  });

  it("never silently drops non-hr service scopes into the HR selector", () => {
    const staffer = me({
      companies: [{ id: "co-hold", name: "Holding", type: "holding" }],
      roles: [],
      serviceScopes: [{ companyId: "co-c", companyName: "IT co", assignmentId: "a3", module: "it", unitName: "IT", role: "staff" }],
    });
    expect(hrScopeCompanies(staffer, "co-hold")).toEqual([]);
  });
});

describe("hasHrScopeChoice / resolveHrScopeParam", () => {
  const one: HrScopeCompany[] = [{ id: "co-a", name: "Agency", role: "home" }];
  const many: HrScopeCompany[] = [{ id: "co-a", name: "Agency", role: "home" }, { id: "co-b", name: "Resort", role: "staff" }];

  it("single company -> no choice, defaults to that company (never a dropdown)", () => {
    expect(hasHrScopeChoice(one)).toBe(false);
    expect(resolveHrScopeParam(undefined, one)).toBe("co-a");
    expect(resolveHrScopeParam("all", one)).toBe("co-a");
  });

  it("multiple companies -> defaults to 'all' (owner decision 4)", () => {
    expect(hasHrScopeChoice(many)).toBe(true);
    expect(resolveHrScopeParam(undefined, many)).toBe("all");
  });

  it("an unreachable requested company falls back to the default rather than widening scope", () => {
    expect(resolveHrScopeParam("co-z", many)).toBe("all");
    expect(resolveHrScopeParam("co-b", many)).toBe("co-b");
  });
});

describe("fanOutHr — the inclusion envelope", () => {
  const companies: HrScopeCompany[] = [
    { id: "co-a", name: "Agency", role: "home" },
    { id: "co-b", name: "Resort", role: "staff" },
  ];

  it("merges successful legs and never silently drops a failing one", async () => {
    const env = await fanOutHr(companies, async (id) => {
      if (id === "co-b") throw Object.assign(new Error("nope"), { status: 403 });
      return [{ id: "x1" }];
    });
    expect(env.items.map((r) => r.tenantId)).toEqual(["co-a"]);
    expect(env.companies).toEqual([
      { id: "co-a", name: "Agency", included: true, reason: undefined },
      { id: "co-b", name: "Resort", included: false, reason: "error" }, // plain Error, not PlatformError, so generic reason
    ]);
  });

  it("all succeeding -> every company included, nothing excluded", async () => {
    const env = await fanOutHr(companies, async () => [{ id: "x" }]);
    expect(env.companies.every((c) => c.included)).toBe(true);
    expect(env.items).toHaveLength(2);
  });

  it("tags a real 403/404 PlatformError with the matching reason", async () => {
    const env = await fanOutHr(companies, async (id) => {
      if (id === "co-a") throw new PlatformError(403, "forbidden");
      throw new PlatformError(404, "not found");
    });
    expect(env.companies.find((c) => c.id === "co-a")).toEqual({ id: "co-a", name: "Agency", included: false, reason: "no_access" });
    expect(env.companies.find((c) => c.id === "co-b")).toEqual({ id: "co-b", name: "Resort", included: false, reason: "not_served" });
  });
});
