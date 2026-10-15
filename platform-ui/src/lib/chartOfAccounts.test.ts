import { describe, it, expect } from "vitest";
import { ACCOUNT_CODE_PATTERN, ACCOUNT_TYPES, canEditChart, defaultNormalBalance, isAccountType, usedByWords } from "./chartOfAccounts";
import type { Me } from "./platform";

// DW-7g-2: the pure rules behind Finance > Chart of accounts.
const me = (roles: Me["roles"]): Me => ({ userId: "u", name: "U", email: "u@x", title: null, assurance: "high", companies: [], roles });

describe("defaultNormalBalance", () => {
  it("is debit for asset and expense and credit for the rest (§49.2)", () => {
    expect(ACCOUNT_TYPES.map((t) => [t.type, defaultNormalBalance(t.type)])).toEqual([
      ["asset", "debit"], ["liability", "credit"], ["equity", "credit"], ["revenue", "credit"], ["expense", "debit"],
    ]);
    expect(isAccountType("asset")).toBe(true);
    expect(isAccountType("income")).toBe(false);
  });
});

describe("ACCOUNT_CODE_PATTERN", () => {
  it("is 1-20 characters of letters, digits, dot and dash", () => {
    for (const ok of ["1120", "T-100", "6.1.2", "a", "X".repeat(20)]) expect(ACCOUNT_CODE_PATTERN.test(ok), ok).toBe(true);
    for (const bad of ["", "has space", "6_100", "X".repeat(21), "é1"]) expect(ACCOUNT_CODE_PATTERN.test(bad), bad).toBe(false);
  });
});

describe("usedByWords", () => {
  it("names the tables in a finance user's words, and keeps an unknown table's own name", () => {
    expect(usedByWords([{ table: "finance_posting_rules", count: 2 }, { table: "finance_tax_codes", count: 1 }]))
      .toBe("posting rules (2), tax codes (1)");
    expect(usedByWords([{ table: "some_new_table", count: 3 }])).toBe("some_new_table (3)");
  });
});

describe("canEditChart", () => {
  it("offers the controls to company.manage, an elevated role, and a finance_manager grant that covers the company", () => {
    expect(canEditChart(me([{ role: "company_admin", scopeType: "company", scopeId: "co-1" }]), "co-1")).toBe(true);
    expect(canEditChart(me([{ role: "platform_admin", scopeType: "global", scopeId: null }]), "co-1")).toBe(true);
    expect(canEditChart(me([{ role: "owner", scopeType: "global", scopeId: null }]), "co-1")).toBe(true);
    expect(canEditChart(me([{ role: "finance_manager", scopeType: "company", scopeId: "co-1" }]), "co-1")).toBe(true);
  });
  it("hides them from finance staff, a reader, a manager of another company and nobody", () => {
    expect(canEditChart(me([{ role: "finance_staff", scopeType: "company", scopeId: "co-1" }]), "co-1")).toBe(false);
    expect(canEditChart(me([{ role: "member", scopeType: "company", scopeId: "co-1" }]), "co-1")).toBe(false);
    expect(canEditChart(me([{ role: "finance_manager", scopeType: "company", scopeId: "co-2" }]), "co-1")).toBe(false);
    expect(canEditChart(me([{ role: "company_admin", scopeType: "company", scopeId: "co-2" }]), "co-1")).toBe(false);
    expect(canEditChart(me([]), "co-1")).toBe(false);
  });
});
