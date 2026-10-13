// PV5-10 — the Midtrans Snap adapter, pure (no database, no network: the in-process fake Midtrans answers every call).
//
// TEETH (each proven in the PV5-10 hand-back by breaking the code and watching these fail):
//   (a) sign over a re-formatted gross_amount (Number(x).toString())  -> "a genuine notice verifies" fails;
//   (b) compare signatures with === on the raw string (no lower-casing) -> "an upper-case hex signature verifies" fails;
//   (c) treat `capture` as paid without fraud_status accept            -> the capture/challenge row fails.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  MIDTRANS_ORDER_ID, MidtransSnapProvider, interpretMidtransStatus, midtransSignature, mintMidtransOrderId,
  signatureMatches, wholeAmount, type FetchLike,
} from "./midtrans";
import { ProviderRequestError, ProviderUnavailableError } from "./provider";
import { FakeMidtrans } from "../testing/fake-midtrans";

const KEY = "SB-Mid-server-UNIT-TEST-KEY";
const provider = (fetchImpl: FetchLike, environment: "sandbox" | "production" = "sandbox") =>
  new MidtransSnapProvider({ serverKey: KEY, environment, fetchImpl, timeoutMs: 1000 });

describe("Midtrans notification signature", () => {
  it("is hex SHA-512 of order_id + status_code + gross_amount + server key, in that order", () => {
    const expected = createHash("sha512").update("ck-1" + "200" + "150000.00" + KEY, "utf8").digest("hex");
    expect(midtransSignature("ck-1", "200", "150000.00", KEY)).toBe(expected);
    expect(midtransSignature("ck-1", "200", "150000", KEY)).not.toBe(expected);
  });

  it("compares in constant time and refuses anything that is not 128 hex characters", () => {
    const sig = midtransSignature("ck-1", "200", "150000.00", KEY);
    expect(signatureMatches(sig, sig)).toBe(true);
    expect(signatureMatches(sig.toUpperCase(), sig)).toBe(true);
    expect(signatureMatches(sig.slice(0, 127), sig)).toBe(false);
    expect(signatureMatches(`${sig.slice(0, 127)}g`, sig)).toBe(false);
    expect(signatureMatches(undefined, sig)).toBe(false);
    expect(signatureMatches(12345, sig)).toBe(false);
    expect(signatureMatches(midtransSignature("ck-1", "200", "150000.00", "another-key"), sig)).toBe(false);
  });
});

describe("verifyNotice", () => {
  const fake = new FakeMidtrans(KEY);
  fake.setStatus("ck-abc", { grossAmount: "150000.00" });
  const p = provider(fake.fetch);

  it("a genuine notice verifies, with a dedupe key of order:status:code and a summary without card data", () => {
    const v = p.verifyNotice(fake.notice("ck-abc", { transactionStatus: "settlement", transactionId: "t-1" }));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.notice.eventKey).toBe("ck-abc:settlement:200");
    expect(v.notice.ref).toBe("ck-abc");
    expect(v.notice.summary).toMatchObject({ order_id: "ck-abc", transaction_status: "settlement", gross_amount: "150000.00", transaction_id: "t-1" });
    expect(v.notice.summary).not.toHaveProperty("masked_card");
    expect(v.notice.summary).not.toHaveProperty("signature_key");
  });

  it("an upper-case hex signature verifies (hex is case-insensitive)", () => {
    const body = fake.notice("ck-abc", { transactionStatus: "settlement" });
    body.signature_key = body.signature_key.toUpperCase();
    expect(p.verifyNotice(body).ok).toBe(true);
  });

  it("a changed signed field, a wrong key, a missing signature or a non-string field is refused", () => {
    const good = fake.notice("ck-abc", { transactionStatus: "settlement" });
    expect(p.verifyNotice({ ...good, gross_amount: "150000" }).ok).toBe(false);          // re-formatted amount
    expect(p.verifyNotice({ ...good, gross_amount: "1.00" }).ok).toBe(false);
    expect(p.verifyNotice({ ...good, order_id: "ck-other" }).ok).toBe(false);
    expect(p.verifyNotice({ ...good, status_code: "201" }).ok).toBe(false);
    const { signature_key: _sig, ...unsigned } = good;
    expect(p.verifyNotice(unsigned).ok).toBe(false);
    expect(p.verifyNotice({ ...good, gross_amount: 150000 }).ok).toBe(false);
    expect(new MidtransSnapProvider({ serverKey: "other", environment: "sandbox", fetchImpl: fake.fetch }).verifyNotice(good).ok).toBe(false);
    expect(p.verifyNotice(null).ok).toBe(false);
    expect(p.verifyNotice([good]).ok).toBe(false);
    expect(p.verifyNotice({ ...good, order_id: "bad id with spaces" }).ok).toBe(false);
  });

  it("the UNSIGNED transaction_status cannot mint unbounded dedupe keys: unknown words normalise to 'other'", () => {
    const good = fake.notice("ck-abc", { transactionStatus: "settlement" });
    const a = p.verifyNotice({ ...good, transaction_status: "made-up-1" });
    const b = p.verifyNotice({ ...good, transaction_status: "made-up-2" });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.notice.eventKey).toBe("ck-abc:other:200");
      expect(b.notice.eventKey).toBe(a.notice.eventKey);
    }
  });
});

describe("interpretMidtransStatus: paid is settlement, or capture with fraud_status accept", () => {
  it.each([
    ["settlement", undefined, "paid"],
    ["settlement", "accept", "paid"],
    ["settlement", "challenge", "pending"],
    ["capture", "accept", "paid"],
    ["capture", "challenge", "pending"],
    ["capture", undefined, "pending"],
    ["capture", "deny", "failed"],
    ["pending", undefined, "pending"],
    ["authorize", undefined, "pending"],
    ["expire", undefined, "expired"],
    ["deny", undefined, "failed"],
    ["cancel", undefined, "failed"],
    ["failure", undefined, "failed"],
    ["refund", undefined, "reversed"],
    ["partial_chargeback", undefined, "reversed"],
    ["something-new", undefined, "unknown"],
    [undefined, undefined, "unknown"],
  ])("%s / %s -> %s", (ts, fs, want) => {
    expect(interpretMidtransStatus(ts as string | undefined, fs as string | undefined)).toBe(want);
  });
});

describe("order ids and amounts", () => {
  it("mints single-use ids in Midtrans' alphabet, at most 50 characters, never twice", () => {
    const ids = new Set(Array.from({ length: 200 }, () => mintMidtransOrderId()));
    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(id).toMatch(MIDTRANS_ORDER_ID);
      expect(id.length).toBeLessThanOrEqual(50);
      expect(id).toMatch(/^ck-[0-9a-f]{32}$/);
    }
  });

  it("takes whole rupiah only, and never rounds", () => {
    expect(wholeAmount("150000")).toBe(150000);
    expect(wholeAmount("150000.0000")).toBe(150000);
    expect(() => wholeAmount("150000.5")).toThrow(ProviderRequestError);
    expect(() => wholeAmount("0")).toThrow(ProviderRequestError);
    expect(() => wholeAmount("-5")).toThrow(ProviderRequestError);
    expect(() => wholeAmount("1e5")).toThrow(ProviderRequestError);
  });
});

describe("Snap create", () => {
  it("POSTs to the sandbox Snap host with Basic auth (key as user, empty password) and an integer gross_amount", async () => {
    const fake = new FakeMidtrans(KEY);
    const out = await provider(fake.fetch).createCheckout({
      orderId: "ck-0123", amount: "150000.0000", currency: "IDR", finishUrl: "https://erp.example.test/portal/invoices/x?checkout=finished", expiryMinutes: 1440,
    });
    expect(out.providerCheckoutId).toBe("ck-0123");
    expect(out.checkoutUrl).toMatch(/^https:\/\/app\.sandbox\.midtrans\.com\/snap\//);
    const [call] = fake.snapCreates();
    expect(call.url).toBe("https://app.sandbox.midtrans.com/snap/v1/transactions");
    expect(call.authorization).toBe(`Basic ${Buffer.from(`${KEY}:`).toString("base64")}`);
    expect(call.body).toEqual({
      transaction_details: { order_id: "ck-0123", gross_amount: 150000 },
      expiry: { unit: "minutes", duration: 1440 },
      callbacks: { finish: "https://erp.example.test/portal/invoices/x?checkout=finished" },
    });
  });

  it("production uses the production hosts", async () => {
    const seen: string[] = [];
    const f: FetchLike = async (url) => {
      seen.push(url);
      return { status: 201, text: async () => JSON.stringify({ token: "t", redirect_url: "https://app.midtrans.com/snap/v4/redirection/t" }) };
    };
    await provider(f, "production").createCheckout({ orderId: "ck-9", amount: "10", currency: "IDR", finishUrl: null, expiryMinutes: 60 });
    expect(seen).toEqual(["https://app.midtrans.com/snap/v1/transactions"]);
  });

  it("refuses a redirect_url that is not the provider's own https host", async () => {
    const f: FetchLike = async () => ({ status: 201, text: async () => JSON.stringify({ token: "t", redirect_url: "https://evil.example/pay" }) });
    await expect(provider(f).createCheckout({ orderId: "ck-1", amount: "10", currency: "IDR", finishUrl: null, expiryMinutes: 60 }))
      .rejects.toBeInstanceOf(ProviderRequestError);
  });

  it("a 5xx or a network failure is transient; a 4xx is a refusal; non-IDR never leaves the adapter", async () => {
    const fake = new FakeMidtrans(KEY);
    fake.snapFailure = 503;
    const req = { orderId: "ck-2", amount: "10", currency: "IDR", finishUrl: null, expiryMinutes: 60 };
    await expect(provider(fake.fetch).createCheckout(req)).rejects.toBeInstanceOf(ProviderUnavailableError);
    fake.snapFailure = 400;
    await expect(provider(fake.fetch).createCheckout(req)).rejects.toBeInstanceOf(ProviderRequestError);
    const down: FetchLike = async () => { throw new TypeError("fetch failed"); };
    await expect(provider(down).createCheckout(req)).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(provider(fake.fetch).createCheckout({ ...req, currency: "USD" })).rejects.toBeInstanceOf(ProviderRequestError);
  });
});

describe("status re-fetch", () => {
  it("GETs /v2/{order_id}/status and reads settlement as paid, dated by settlement_time", async () => {
    const fake = new FakeMidtrans(KEY);
    fake.setStatus("ck-5", { grossAmount: "150000.00" });
    fake.settle("ck-5", "txn-5", { settlementTime: "2026-10-12 23:30:00" });
    const st = await provider(fake.fetch).fetchStatus("ck-5");
    expect(fake.statusChecks("ck-5")[0].url).toBe("https://api.sandbox.midtrans.com/v2/ck-5/status");
    expect(st).toEqual({
      ref: "ck-5", state: "paid", providerStatus: "settlement", paymentId: "txn-5", amount: "150000.00", currency: "IDR",
      paidOn: "2026-10-12", method: "bank_transfer",
    });
  });

  it("no transaction yet (404) is `unknown`, never paid", async () => {
    const fake = new FakeMidtrans(KEY);
    fake.setStatus("ck-6", { grossAmount: "10.00" });
    const st = await provider(fake.fetch).fetchStatus("ck-6");
    expect(st.state).toBe("unknown");
    expect(st.paymentId).toBeNull();
  });

  it("a 5xx, a wrong key (401) or an answer about another order is transient (retried), never acted on", async () => {
    const fake = new FakeMidtrans(KEY);
    fake.setStatus("ck-7", { grossAmount: "10.00", transactionStatus: "settlement", transactionId: "t" });
    fake.statusFailure = 502;
    await expect(provider(fake.fetch).fetchStatus("ck-7")).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(new MidtransSnapProvider({ serverKey: "wrong", environment: "sandbox", fetchImpl: fake.fetch }).fetchStatus("ck-7"))
      .rejects.toBeInstanceOf(ProviderUnavailableError);
    const liar: FetchLike = async () => ({ status: 200, text: async () => JSON.stringify({ order_id: "ck-other", transaction_status: "settlement" }) });
    await expect(provider(liar).fetchStatus("ck-7")).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("a malformed gross_amount reads as no amount (the processor then refuses to write)", async () => {
    const f: FetchLike = async () => ({
      status: 200,
      text: async () => JSON.stringify({ order_id: "ck-8", transaction_status: "settlement", gross_amount: "1e9", transaction_id: "t" }),
    });
    expect((await provider(f).fetchStatus("ck-8")).amount).toBeNull();
  });
});
