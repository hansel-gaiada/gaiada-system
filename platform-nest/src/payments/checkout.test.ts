// PV5-10 — the online-payment decision (design decision 16), pure. The portal flag and the checkout route both call it,
// so these rows are the whole rule. The DB suite (online-payment.db.test.ts) drives the same reasons through HTTP.
//
// TEETH: drop the `!facts.whole` clause -> "part of a rupiah" fails; drop the headroom check -> "being verified" fails.
import { describe, expect, it } from "vitest";
import { ONLINE_PAYMENT_MESSAGES, decideOnlinePayment, type OnlinePaymentFacts } from "./checkout";

const ok: OnlinePaymentFacts = {
  issued: true, status: "sent", currency: "IDR", minorUnit: 0, outstandingPositive: true, headroomPositive: true,
  whole: true, headroom: "150000.0000", clearingReady: true,
};

describe("decideOnlinePayment", () => {
  it("offers an issued IDR invoice with a whole-rupiah balance, for the balance less claims being verified", () => {
    expect(decideOnlinePayment(true, ok)).toEqual({ available: true, amount: "150000.0000", currency: "IDR" });
  });

  it.each([
    ["switched off", false, ok, "not_offered"],
    ["no facts", true, null, "not_offered"],
    ["not issued", true, { ...ok, issued: false }, "not_issued"],
    ["voided", true, { ...ok, status: "void" }, "void"],
    ["not IDR", true, { ...ok, currency: "USD", minorUnit: 2 }, "not_idr"],
    ["paid", true, { ...ok, status: "paid", outstandingPositive: false }, "nothing_outstanding"],
    ["nothing outstanding", true, { ...ok, outstandingPositive: false, headroomPositive: false }, "nothing_outstanding"],
    ["part of a rupiah", true, { ...ok, whole: false }, "fractional_amount"],
    ["a currency with a minor unit", true, { ...ok, minorUnit: 2 }, "fractional_amount"],
    ["being verified", true, { ...ok, headroomPositive: false }, "payment_being_verified"],
    ["no clearing account", true, { ...ok, clearingReady: false }, "not_ready"],
  ] as const)("%s", (_label, offered, facts, reason) => {
    const d = decideOnlinePayment(offered, facts as OnlinePaymentFacts | null);
    expect(d.available).toBe(false);
    if (!d.available) {
      expect(d.reason).toBe(reason);
      expect(d.message).toBe(ONLINE_PAYMENT_MESSAGES[reason]);
    }
  });

  it("speaks plain words to the client and never says 'Card'", () => {
    for (const m of Object.values(ONLINE_PAYMENT_MESSAGES)) {
      expect(m).not.toMatch(/card/i);
      expect(m).toMatch(/[.]$/);
    }
  });
});
