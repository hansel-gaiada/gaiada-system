// M5-P1-b — pure unit tests for core/agency-lead-pipeline.service.ts (no DB). The writer itself, the
// convert/decline/intake threading and the race are proven against real Postgres in
// agency-lead-pipeline.db.test.ts (Linux gate).
import { describe, it, expect } from "vitest";
import { BadRequestException } from "@nestjs/common";
import {
  dealPrecisionOk, marketingConsentState, normalizeDeal, normalizeOptionalDeal, parseStageChangedV1,
  STAGE_CHANGED, STAGE_CHANGED_V1_KEYS, OPEN_LEAD_STATUSES, type StageChangedV1,
} from "./agency-lead-pipeline.service";

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof BadRequestException) return (e.getResponse() as { reason?: string }).reason;
    throw e;
  }
  throw new Error("expected a typed 400");
}

describe("M5-P1 — the event contract", () => {
  it("the event name and the exact v1 key set match the design (§5)", () => {
    expect(STAGE_CHANGED).toBe("agency.lead.stage_changed");
    expect([...STAGE_CHANGED_V1_KEYS]).toEqual([
      "v", "leadId", "stageEventId", "submissionRef", "fromStage", "toStage", "dealValue", "dealCurrency", "occurredAt",
    ]);
  });

  it("decline's open statuses are exactly the AD-1 non-terminal ones", () => {
    expect([...OPEN_LEAD_STATUSES]).toEqual(["new", "invited", "submitted", "in_review", "nurturing"]);
  });

  const good: StageChangedV1 = {
    v: 1, leadId: "0b6f6a0e-9d0c-4f55-8f1e-4d1a2b3c4d5e", stageEventId: "1c7f7b1f-0e1d-4a66-9a2f-5e2b3c4d5e6f",
    submissionRef: null, fromStage: "qualified", toStage: "proposal", dealValue: "15000000.0000", dealCurrency: "IDR",
    occurredAt: "2026-10-11T09:00:00.000Z",
  };

  it("parseStageChangedV1 accepts a well-formed payload and returns only the v1 keys", () => {
    expect(parseStageChangedV1(good)).toEqual(good);
    const withExtra = { ...good, email: "someone@example.test" };
    const parsed = parseStageChangedV1(withExtra);
    expect(parsed).toEqual(good);
    expect(Object.keys(parsed!)).toEqual([...STAGE_CHANGED_V1_KEYS]);
  });

  it("parseStageChangedV1 refuses every malformed shape rather than trusting it", () => {
    const bad: unknown[] = [
      null, "x", [], { ...good, v: 2 }, { ...good, leadId: "nope" }, { ...good, stageEventId: undefined },
      { ...good, submissionRef: "not-a-uuid" }, { ...good, fromStage: "Proposal" }, { ...good, toStage: good.fromStage },
      { ...good, dealValue: 15000000 }, { ...good, dealValue: null }, { ...good, dealCurrency: "idr" },
      { ...good, dealValue: "-1", dealCurrency: "IDR" }, { ...good, occurredAt: "yesterday" },
    ];
    for (const b of bad) expect(parseStageChangedV1(b)).toBeNull();
    expect(parseStageChangedV1({ ...good, dealValue: null, dealCurrency: null })).not.toBeNull();
  });
});

describe("M5-P1 — marketingConsentState (the P2 gate's one reading)", () => {
  it("is 'given' only for the boolean true", () => {
    expect(marketingConsentState({ marketing: true, analytics: false })).toBe("given");
    expect(marketingConsentState({ marketing: false })).toBe("not_given");
    expect(marketingConsentState({ marketing: "true" })).toBe("unknown");
    expect(marketingConsentState({ marketing: 1 })).toBe("unknown");
    expect(marketingConsentState({ marketing: null })).toBe("unknown");
    expect(marketingConsentState({ analytics: true })).toBe("unknown"); // absent key
    expect(marketingConsentState(null)).toBe("unknown");
    expect(marketingConsentState(undefined)).toBe("unknown");
    expect(marketingConsentState([{ marketing: true }])).toBe("unknown");
    expect(marketingConsentState("{\"marketing\":true}")).toBe("unknown");
  });
});

describe("M5-P1 — deal value shape (design §3)", () => {
  it("accepts a decimal string or a finite number, and upper-cases the currency", () => {
    expect(normalizeDeal({ value: "10.25", currency: "usd" })).toEqual({ value: "10.25", currency: "USD" });
    expect(normalizeDeal({ value: 1500, currency: "IDR" })).toEqual({ value: "1500", currency: "IDR" });
    expect(normalizeDeal({ value: " 15000000.0000 ", currency: "IDR" })).toEqual({ value: "15000000.0000", currency: "IDR" });
  });

  it("an explicit {null, null} is the clear; absent deal on a move/convert is 'leave it alone'", () => {
    expect(normalizeDeal({ value: null, currency: null })).toBeNull();
    expect(normalizeOptionalDeal(undefined)).toBeUndefined();
    expect(normalizeOptionalDeal(null)).toBeUndefined();
  });

  it("refuses with typed reasons", () => {
    expect(reasonOf(() => normalizeDeal({ value: "10" }))).toBe("deal_incomplete");
    expect(reasonOf(() => normalizeDeal({ currency: "USD" }))).toBe("deal_incomplete");
    expect(reasonOf(() => normalizeDeal("10 USD"))).toBe("deal_incomplete");
    expect(reasonOf(() => normalizeDeal({}))).toBe("deal_incomplete"); // only two explicit nulls clear
    expect(reasonOf(() => normalizeDeal({ value: null, currency: "USD" }))).toBe("deal_incomplete");
    expect(reasonOf(() => normalizeDeal({ value: "-5", currency: "USD" }))).toBe("deal_value_invalid");
    expect(reasonOf(() => normalizeDeal({ value: "1e5", currency: "USD" }))).toBe("deal_value_invalid");
    expect(reasonOf(() => normalizeDeal({ value: 1e21, currency: "USD" }))).toBe("deal_value_invalid");
    expect(reasonOf(() => normalizeDeal({ value: 0.1 + 0.2, currency: "USD" }))).toBe("deal_value_invalid");
    expect(reasonOf(() => normalizeDeal({ value: Number.NaN, currency: "USD" }))).toBe("deal_value_invalid");
    expect(reasonOf(() => normalizeDeal({ value: "1.23456", currency: "USD" }))).toBe("deal_value_invalid");
    expect(reasonOf(() => normalizeDeal({ value: "12345678901234567", currency: "USD" }))).toBe("deal_value_invalid");
    expect(reasonOf(() => normalizeDeal({ value: "10", currency: "DOLLARS" }))).toBe("deal_currency_unknown");
    expect(reasonOf(() => normalizeDeal({ value: "10", currency: 840 }))).toBe("deal_currency_unknown");
  });

  it("precision is exact at the currency's minor unit; trailing zeros do not count", () => {
    expect(dealPrecisionOk("1500.5", 0)).toBe(false); // IDR
    expect(dealPrecisionOk("1500", 0)).toBe(true);
    expect(dealPrecisionOk("1500.000", 0)).toBe(true);
    expect(dealPrecisionOk("10.25", 2)).toBe(true); // USD
    expect(dealPrecisionOk("10.255", 2)).toBe(false);
    expect(dealPrecisionOk("10.2500", 2)).toBe(true);
    expect(dealPrecisionOk("0.0001", 4)).toBe(true);
  });
});
