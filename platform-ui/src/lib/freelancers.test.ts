import { describe, it, expect } from "vitest";
import {
  blockerFix, formatAmount, formatHours, isIsoDate, isReady, lastMonthRange, periodProblem, rangeLabel, readyFreelancers,
  refusalSentence, splitBills, type FlPreview, type FreelancerBill, type PreviewFreelancer,
} from "./freelancers";

// DW-10f-4b — the pure half of Finance > Payables > Freelancers. What matters: no figure is computed here (only formatted), the
// period the server would refuse is refused first, and every machine refusal reason the server sends reads as a sentence.

const user = { id: "u1", name: "Made Putra", email: "made@gaiada.com" };
const line = { project: { id: "p1", name: "Site" }, minutes: 60, hours: 1, hourlyRate: 150000, amount: 150000, firstDate: "2026-09-01", lastDate: "2026-09-30" };
const fl = (over: Partial<PreviewFreelancer> = {}): PreviewFreelancer => ({
  user, vendor: { id: "v1", code: "V-001", name: "Vendor", withholdingCode: null }, lines: [line], subtotal: 150000, withholding: null,
  amountPayable: 150000, currency: "IDR", entryCount: 1, earlierUnbilled: null, blockers: [], warnings: [], ...over,
});

describe("lastMonthRange", () => {
  it("is the whole calendar month before today", () => {
    expect(lastMonthRange("2026-10-19")).toEqual({ periodStart: "2026-09-01", periodEnd: "2026-09-30" });
    expect(lastMonthRange("2026-03-01")).toEqual({ periodStart: "2026-02-01", periodEnd: "2026-02-28" });
    expect(lastMonthRange("2028-03-31")).toEqual({ periodStart: "2028-02-01", periodEnd: "2028-02-29" });
  });
  it("wraps January to the December before", () => {
    expect(lastMonthRange("2026-01-15")).toEqual({ periodStart: "2025-12-01", periodEnd: "2025-12-31" });
  });
});

describe("isIsoDate and periodProblem", () => {
  it("accepts real calendar dates only", () => {
    expect(isIsoDate("2026-02-28")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-2-3")).toBe(false);
    expect(isIsoDate(undefined)).toBe(false);
  });
  it("names the problem the server would refuse, and is null for a good period", () => {
    expect(periodProblem("2026-09-01", "2026-09-30")).toBeNull();
    expect(periodProblem("2026-09-01", undefined)).toMatch(/both dates/);
    expect(periodProblem("2026-09-30", "2026-09-01")).toMatch(/ends before it starts/);
    expect(periodProblem("2025-01-01", "2026-01-02")).toMatch(/at most 366 days/);
    // 366 days inclusive is allowed (a whole leap year, or a year and a day), 367 is not.
    expect(periodProblem("2028-01-01", "2028-12-31")).toBeNull();
    expect(periodProblem("2027-01-01", "2028-01-01")).toBeNull();
    expect(periodProblem("2027-01-01", "2028-01-02")).toMatch(/at most 366 days/);
  });
});

describe("formatAmount and formatHours", () => {
  it("formats IDR with no decimals and other currencies with two, from a number or a string", () => {
    // Intl puts a no-break space between the code and the figure.
    expect(formatAmount(150000, "IDR")).toMatch(/^IDR\s150,000$/);
    expect(formatAmount("4410000", "IDR")).toMatch(/^IDR\s4,410,000$/);
    expect(formatAmount(12.5, "USD")).toContain("12.50");
  });
  it("shows an absent or unreadable amount as a dash, never as 0", () => {
    expect(formatAmount(null)).toBe("—");
    expect(formatAmount(undefined)).toBe("—");
    expect(formatAmount("")).toBe("—");
    expect(formatAmount("abc")).toBe("—");
  });
  it("shows hours without trailing zeros", () => {
    expect(formatHours(20)).toBe("20");
    expect(formatHours(5.5)).toBe("5.5");
    expect(formatHours("0.3333")).toBe("0.3333");
  });
});

describe("rangeLabel", () => {
  it("says an open rate has no end", () => {
    expect(rangeLabel({ validFrom: "2026-04-01", validTo: null })).toBe("from 2026-04-01, no end");
    expect(rangeLabel({ validFrom: "2025-09-01", validTo: "2026-03-31" })).toBe("2025-09-01 to 2026-03-31");
  });
});

describe("what may be drafted", () => {
  it("is ready with no blocker and at least one line; a warning does not block", () => {
    expect(isReady(fl())).toBe(true);
    expect(isReady(fl({ warnings: [{ code: "NO_WITHHOLDING", message: "m" }] }))).toBe(true);
    expect(isReady(fl({ blockers: [{ code: "NO_VENDOR", message: "m" }] }))).toBe(false);
    expect(isReady(fl({ lines: [] }))).toBe(false);
  });
  it("lists the ready ones of a preview, and none for an absent preview", () => {
    const p: FlPreview = {
      periodStart: "2026-09-01", periodEnd: "2026-09-30",
      freelancers: [fl(), fl({ user: { ...user, id: "u2" }, blockers: [{ code: "NO_RATE", message: "m" }] })],
    };
    expect(readyFreelancers(p).map((f) => f.user.id)).toEqual(["u1"]);
    expect(readyFreelancers(null)).toEqual([]);
  });
  it("points a blocker at its fix only when there is one", () => {
    expect(blockerFix("NO_VENDOR")).toBe("link_vendor");
    expect(blockerFix("NO_RATE")).toBe("add_rate");
    expect(blockerFix("NO_OPEN_PERIOD")).toBeNull();
  });
});

describe("splitBills", () => {
  const bill = (billId: string, status: string, periodStart: string, periodEnd: string): FreelancerBill => ({
    billId, billNo: billId, user, vendor: { id: "v1", code: "V-001", name: "V" }, periodStart, periodEnd, minutes: 60, subtotal: 1,
    withholdingAmount: 0, amountPayable: 1, currency: "IDR", status, createdAt: "2026-10-01T00:00:00Z", createdBy: null, warnings: [],
  });
  it("keeps every draft (any period) apart from the other bills that overlap the picked period", () => {
    const bills = [
      bill("d-old", "draft", "2026-07-01", "2026-07-31"),
      bill("a-in", "approved", "2026-09-01", "2026-09-30"),
      bill("a-edge", "paid", "2026-08-15", "2026-09-01"),
      bill("a-out", "approved", "2026-06-01", "2026-06-30"),
    ];
    const s = splitBills(bills, "2026-09-01", "2026-09-30");
    expect(s.drafts.map((b) => b.billId)).toEqual(["d-old"]);
    expect(s.inPeriod.map((b) => b.billId)).toEqual(["a-in", "a-edge"]);
  });
});

describe("refusalSentence", () => {
  it("turns each §61 refusal reason into a sentence", () => {
    for (const reason of [
      "rate_overlap", "rate_used", "person_has_vendor", "person_not_found", "freelancer_on_payroll", "rate_invalid", "date_invalid",
      "currency_not_functional", "expense_account_invalid", "note_invalid", "vendor_not_found", "rate_not_found", "user_id_required",
      "period_invalid", "bill_date_invalid", "nothing_to_bill", "bill_not_draft", "freelancer_bill_not_found", "conflict", "status_invalid",
    ]) {
      const s = refusalSentence(reason, "SERVER WORDS");
      expect(s, reason).not.toBe("SERVER WORDS");
      expect(s, reason).toMatch(/^[A-Z].*[.]$/);
    }
  });
  it("passes the server's own words for a reason it does not know, or none", () => {
    expect(refusalSentence("brand_new_reason", "the server said this")).toBe("the server said this");
    expect(refusalSentence(undefined, "plain 400 text")).toBe("plain 400 text");
  });
});
