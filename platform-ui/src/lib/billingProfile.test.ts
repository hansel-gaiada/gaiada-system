import { describe, it, expect } from "vitest";
import { profileBody, validateProfileForm, type BillingProfileFormValues } from "./billingProfile";

// PV5-09 — the billing profile form's field rules and its PUT body. The server repeats every rule; these pin that the
// browser says the same thing in words before the round trip, and that the non-bank body can never carry a bank key.

const v = (over: Partial<BillingProfileFormValues> = {}): BillingProfileFormValues => ({
  legalName: "Example Agency Ltd", address: "1 Example Street", invoicePrefix: "EX", defaultPaymentTermsDays: "30",
  currencyCode: "IDR", bankLedgerAccountCode: "1010", defaultRevenueAccountCode: "4000", ...over,
});

describe("validateProfileForm", () => {
  it("accepts a complete profile, with both ledger codes optional", () => {
    expect(validateProfileForm(v())).toBeNull();
    expect(validateProfileForm(v({ bankLedgerAccountCode: "", defaultRevenueAccountCode: "" }))).toBeNull();
  });

  it("names the field that is wrong", () => {
    expect(validateProfileForm(v({ legalName: " " }))?.field).toBe("legalName");
    expect(validateProfileForm(v({ address: "" }))?.field).toBe("address");
    expect(validateProfileForm(v({ invoicePrefix: "ex" }))?.field).toBe("invoicePrefix");
    expect(validateProfileForm(v({ invoicePrefix: "A".repeat(17) }))?.field).toBe("invoicePrefix");
    expect(validateProfileForm(v({ invoicePrefix: "A/B" }))?.field).toBe("invoicePrefix");
    expect(validateProfileForm(v({ defaultPaymentTermsDays: "366" }))?.field).toBe("defaultPaymentTermsDays");
    expect(validateProfileForm(v({ defaultPaymentTermsDays: "1.5" }))?.field).toBe("defaultPaymentTermsDays");
    expect(validateProfileForm(v({ defaultPaymentTermsDays: "" }))?.field).toBe("defaultPaymentTermsDays");
    expect(validateProfileForm(v({ currencyCode: "RP" }))?.field).toBe("currencyCode");
    expect(validateProfileForm(v({ defaultRevenueAccountCode: "4 000" }))?.field).toBe("defaultRevenueAccountCode");
  });

  it("zero days is a legitimate term (due on issue)", () => {
    expect(validateProfileForm(v({ defaultPaymentTermsDays: "0" }))).toBeNull();
  });
});

describe("profileBody", () => {
  it("🔴 never carries a bank key: a body without one needs only the ordinary update permission", () => {
    expect(profileBody(v())).not.toHaveProperty("bank");
  });

  it("trims, upper-cases the currency, makes terms a number and sends a blank ledger code as null", () => {
    expect(profileBody(v({ legalName: "  Example Agency Ltd ", currencyCode: "idr", bankLedgerAccountCode: " ", defaultPaymentTermsDays: "14" })))
      .toEqual({
        legalName: "Example Agency Ltd", address: "1 Example Street", invoicePrefix: "EX", defaultPaymentTermsDays: 14,
        currencyCode: "IDR", bankLedgerAccountCode: null, defaultRevenueAccountCode: "4000",
      });
  });
});
