import { describe, it, expect } from "vitest";
import { pickPortalCompany } from "./portal-company-pick";

const A = { companyId: "co-agency", companyName: "Gaia Digital Agency" };
const B = { companyId: "co-bank", companyName: "Bank Co" };

describe("pickPortalCompany", () => {
  it("one company, no cookie: that company", () => {
    expect(pickPortalCompany([A], undefined)).toEqual({ id: "co-agency", name: "Gaia Digital Agency" });
  });
  it("two companies, valid cookie: the cookie's company", () => {
    expect(pickPortalCompany([A, B], "co-agency")).toEqual({ id: "co-agency", name: "Gaia Digital Agency" });
  });
  it("a cookie naming a company outside clientOf is ignored, first by name wins", () => {
    expect(pickPortalCompany([A, B], "co-resort")).toEqual({ id: "co-bank", name: "Bank Co" });
  });
  it("two companies, no cookie: first by name", () => {
    expect(pickPortalCompany([A, B], null)).toEqual({ id: "co-bank", name: "Bank Co" });
  });
  it("empty or missing clientOf: null, even with a cookie", () => {
    expect(pickPortalCompany([], undefined)).toBeNull();
    expect(pickPortalCompany([], "co-agency")).toBeNull();
    expect(pickPortalCompany(undefined, "co-agency")).toBeNull();
  });
});
