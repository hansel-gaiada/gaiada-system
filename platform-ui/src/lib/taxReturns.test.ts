import { describe, it, expect } from "vitest";
import {
  canWorkTaxReturns, defaultReturnPeriod, driftFor, figureLabels, formatTaxAmount, isAnnualKind, returnLabel,
  TAX_RETURN_KINDS, type TaxReturn,
} from "./taxReturns";
import type { Me } from "./platform";

// DW-7g-1: the pure rules behind Finance > Tax > Returns.
const me = (roles: Me["roles"]): Me => ({ userId: "u", name: "U", email: "u@x", title: null, assurance: "high", companies: [], roles });
const ret = (over: Partial<TaxReturn> = {}): TaxReturn => ({
  id: "r1", kind: "ppn", periodYear: 2026, periodMonth: 3, periodStart: "2026-03-01", periodEnd: "2026-03-31", status: "filed",
  filedOutput: "1000.0000", filedInput: "400.0000", filedNet: "600.0000", filedAt: "2026-04-20T03:00:00.000Z", filingReference: "NTPN-1", notes: null,
  ...over,
});

describe("returnLabel", () => {
  it("is the string the server makes the reader echo: KIND YYYY-MM, or KIND YYYY for the annual return", () => {
    expect(returnLabel({ kind: "ppn", periodYear: 2026, periodMonth: 3 })).toBe("PPN 2026-03");
    expect(returnLabel({ kind: "pph21", periodYear: 2026, periodMonth: 11 })).toBe("PPH21 2026-11");
    expect(returnLabel({ kind: "pph_badan", periodYear: 2026, periodMonth: null })).toBe("PPH_BADAN 2026");
  });
});

describe("kinds", () => {
  it("are the five the backend accepts; only pph_badan is annual", () => {
    expect([...TAX_RETURN_KINDS]).toEqual(["ppn", "pph21", "pph23", "pph42", "pph_badan"]);
    expect(TAX_RETURN_KINDS.filter(isAnnualKind)).toEqual(["pph_badan"]);
  });
  it("PPN figures are VAT; a withholding return has nothing to offset", () => {
    expect(figureLabels("ppn").net).toBe("Net payable");
    expect(figureLabels("pph23")).toEqual({ output: "Withheld", input: "Offset", net: "To remit" });
  });
});

describe("defaultReturnPeriod", () => {
  const periods = [
    { startDate: "2026-08-01", endDate: "2026-08-31", state: "HARD_LOCK" },
    { startDate: "2026-09-01", endDate: "2026-09-30", state: "SOFT_LOCK" },
    { startDate: "2026-10-01", endDate: "2026-10-31", state: "OPEN" },
  ];
  it("is the latest period that is no longer open and has ended", () => {
    expect(defaultReturnPeriod(periods, "2026-10-15")).toEqual({ year: 2026, month: 9 });
  });
  it("never offers a period that has not ended, even if it is locked", () => {
    expect(defaultReturnPeriod([{ startDate: "2026-10-01", endDate: "2026-10-31", state: "HARD_LOCK" }], "2026-10-15")).toEqual({ year: 2026, month: 9 });
  });
  it("falls back to the last whole calendar month, across a year end", () => {
    expect(defaultReturnPeriod([], "2026-10-15")).toEqual({ year: 2026, month: 9 });
    expect(defaultReturnPeriod([], "2027-01-05")).toEqual({ year: 2026, month: 12 });
  });
});

describe("driftFor", () => {
  const drift = { clean: false, problems: [{ problem: "TAX_RETURN_LEDGER_DRIFT", detail: "ppn 2026-03: filed net 600 but the ledger now computes 650 (difference 50)" }] };
  it("matches a return by the kind-and-period prefix the server writes", () => {
    expect(driftFor(ret(), drift)).toContain("difference 50");
    expect(driftFor(ret({ periodMonth: 4 }), drift)).toBeNull();
    expect(driftFor(ret({ kind: "pph23" }), drift)).toBeNull();
    expect(driftFor(ret(), null)).toBeNull();
  });
  it("matches the annual return as `annual`", () => {
    const d = { clean: false, problems: [{ problem: "x", detail: "pph_badan 2025-annual: filed net 1 but the ledger now computes 2" }] };
    expect(driftFor(ret({ kind: "pph_badan", periodYear: 2025, periodMonth: null }), d)).not.toBeNull();
  });
});

describe("canWorkTaxReturns", () => {
  it("offers the controls to company.manage, an operator, and a finance staff or manager grant that covers the company", () => {
    expect(canWorkTaxReturns(me([{ role: "company_admin", scopeType: "company", scopeId: "co-1" }]), "co-1")).toBe(true);
    expect(canWorkTaxReturns(me([{ role: "platform_admin", scopeType: "global", scopeId: null }]), "co-1")).toBe(true);
    expect(canWorkTaxReturns(me([{ role: "finance_manager", scopeType: "company", scopeId: "co-1" }]), "co-1")).toBe(true);
    expect(canWorkTaxReturns(me([{ role: "finance_staff", scopeType: "global", scopeId: null }]), "co-1")).toBe(true);
  });
  it("hides them from a reader and from a grant on another company", () => {
    expect(canWorkTaxReturns(me([{ role: "member", scopeType: "company", scopeId: "co-1" }]), "co-1")).toBe(false);
    expect(canWorkTaxReturns(me([{ role: "viewer", scopeType: "company", scopeId: "co-1" }]), "co-1")).toBe(false);
    expect(canWorkTaxReturns(me([{ role: "finance_manager", scopeType: "company", scopeId: "co-2" }]), "co-1")).toBe(false);
    expect(canWorkTaxReturns(me([]), "co-1")).toBe(false);
  });
});

describe("formatTaxAmount", () => {
  it("formats what the server sent and is a dash for what it did not", () => {
    // Intl puts a no-break space after the currency code.
    const plain = (v: string) => v.replace(/ /g, " ");
    expect(plain(formatTaxAmount("1000.0000"))).toBe("IDR 1,000");
    expect(plain(formatTaxAmount(0))).toBe("IDR 0");
    expect(formatTaxAmount(null)).toBe("—");
    expect(formatTaxAmount("abc")).toBe("—");
  });
});
