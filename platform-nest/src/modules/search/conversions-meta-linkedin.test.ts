// M5-P3 (Meta Conversions API) and M5-P4 (LinkedIn Conversions API, ERP side): the pure half, with no services. Per-adapter request
// builders (normalisation and hashing per each vendor's documented rules, de-dupe ids, consent gating of the browser identifiers, value
// only on `won`), the gate's per-platform identifier rules, the dispatcher, and the boot guard that keeps both SIMULATE-ONLY.
// The DB half is conversions-meta-linkedin.db.test.ts (Linux gate).
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import type { LeadConversionFacts } from "../../core/agency-lead-pipeline.service";
import { REASON, SEARCH_CONVERSIONS_LIVE_PLATFORMS_ENV, evaluateGate, identifierKindsFor, type PlanLedger } from "./conversions";
import {
  buildMetaUploadRequest, isMetaEventName, metaEventId, metaEventSourceUrl, metaIdentifierKinds, normalizeEmailForMeta, normalizePhoneForMeta,
} from "./conversions-meta";
import {
  buildLinkedInUploadRequest, isLinkedInConversionRef, linkedInAmount, linkedInConversionUrn, linkedInEventId, linkedInIdentifierKinds,
  normalizeEmailForLinkedIn,
} from "./conversions-linkedin";
import {
  ConversionsWriteModeBootError, SIMULATE_ONLY_PLATFORMS, assertConversionsBootSafe, buildConversionPlan, getLiveConversionUploader,
  resetLiveConversionUploaders, wireSearchConversionsWriteMode,
} from "./conversions-uploaders";
import { parseTargetBody } from "./conversions.controller";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

const SUB = "22222222-2222-4222-8222-222222222222";
const EMAIL = "  Jane.Doe+Promo@Example.COM ";
const PHONE = "+62 812-3456-7890";
const FBC = "fb.1.1696000000000.IwAR3abcDEF_ghi-123";
const FBP = "fb.1.1696000000000.1234567890";
const FAT = "7f1c2a9e-0b3d-4c5e-8f6a-1b2c3d4e5f60";
const CONSENT = { analytics: true, marketing: true, version: "3", decided_at: "2026-10-11T09:00:00Z" };

function facts(over: Partial<LeadConversionFacts> = {}): LeadConversionFacts {
  return {
    leadId: "11111111-1111-4111-8111-111111111111", source: "web", status: "in_review", stage: "won", deletedAt: null,
    submissionRef: SUB, originForm: "contact", webSiteSlug: "gaiada",
    attribution: { landing: "/services/", fbc: FBC, fbp: FBP, li_fat_id: FAT, utm_source: "x" },
    visitorConsent: CONSENT, contactEmail: EMAIL, contactPhone: PHONE, dealValue: null, dealCurrency: null,
    ...over,
  };
}
const ledger = (over: Partial<PlanLedger> = {}): PlanLedger => ({
  submissionRef: SUB, conversionKey: "lead_won", occurredAt: "2026-10-12T03:04:05.000Z", stage: "won", dealValue: "2500.5000", dealCurrency: "USD", ...over,
});

type MetaEvent = { event_name: string; event_time: number; event_id: string; action_source: string; user_data: Record<string, unknown>; custom_data?: Record<string, unknown>; event_source_url?: string };
const metaEvent = (body: Record<string, unknown>): MetaEvent => (body.data as MetaEvent[])[0];

// ═════════════════════════════════════════════════════════════════════════════════════════════ Meta
describe("Meta: normalisation and hashing (Meta's own rules, not Google's)", () => {
  it("em: trim and lower-case ONLY; gmail dots are kept (that is Google's rule)", () => {
    expect(normalizeEmailForMeta("  Jane.Doe@Example.COM ")).toBe("jane.doe@example.com");
    expect(normalizeEmailForMeta("J.a.n.e@gmail.com")).toBe("j.a.n.e@gmail.com");
    expect(normalizeEmailForMeta("not an email")).toBeNull();
    expect(normalizeEmailForMeta("@x.com")).toBeNull();
    expect(normalizeEmailForMeta("a@")).toBeNull();
    expect(normalizeEmailForMeta(null)).toBeNull();
    expect(normalizeEmailForMeta(7)).toBeNull();
  });
  it("ph: digits only with the country code, no plus; 00 prefix dropped; a national number is never guessed at", () => {
    expect(normalizePhoneForMeta("+62 812-3456-7890")).toBe("6281234567890");
    expect(normalizePhoneForMeta("0062 812 3456 7890")).toBe("6281234567890");
    expect(normalizePhoneForMeta("+(1) 415-555-0100")).toBe("14155550100");
    expect(normalizePhoneForMeta("0812 3456 7890")).toBeNull();
    expect(normalizePhoneForMeta("+12")).toBeNull();
    expect(normalizePhoneForMeta("call me")).toBeNull();
    expect(normalizePhoneForMeta(null)).toBeNull();
  });
  it("event names: a letter first, then letters, digits and underscores, at most 50", () => {
    for (const ok of ["Lead", "Purchase", "lead_won", "Qualified2"]) expect(isMetaEventName(ok), ok).toBe(true);
    for (const bad of ["", "1Lead", "Lead Won", "Lead-Won", "a".repeat(51), 5, null]) expect(isMetaEventName(bad), String(bad)).toBe(false);
  });
});

describe("Meta: the request (simulate sends nothing; this is what WOULD be sent)", () => {
  it("builds one event: name from the target, seconds, event_id, action_source website, hashed em and ph, raw fbc and fbp", () => {
    const p = buildMetaUploadRequest({ facts: facts(), ledger: ledger(), conversionAction: "Purchase", sendValue: true });
    const e = metaEvent(p.body);
    expect(e).toMatchObject({ event_name: "Purchase", event_time: Date.parse("2026-10-12T03:04:05.000Z") / 1000, event_id: `${SUB}:lead_won`, action_source: "website" });
    expect(e.user_data).toEqual({ em: [sha("jane.doe+promo@example.com")], ph: [sha("6281234567890")], fbc: FBC, fbp: FBP });
    expect(p.summary.identifierKinds).toEqual(["email", "phone", "fbc", "fbp"]);
    expect(p.summary.identifierFields).toEqual(["user_data.em", "user_data.ph", "user_data.fbc", "user_data.fbp"]);
  });

  it("event_id: the BARE submission id for the platform's own Lead (Pixel merge), else ${submissionRef}:${conversionKey}", () => {
    expect(metaEventId(SUB, "lead", "Lead")).toBe(SUB);
    expect(metaEventId(SUB, "lead_won", "Lead")).toBe(`${SUB}:lead_won`); // two Lead-named targets can never share the bare id
    expect(metaEventId(SUB, "lead", "Contact")).toBe(`${SUB}:lead`);
    expect(metaEventId(SUB, "lead_won", "Purchase")).toBe(`${SUB}:lead_won`);
    const bare = buildMetaUploadRequest({ facts: facts(), ledger: ledger({ conversionKey: "lead", stage: "enquiry", dealValue: null, dealCurrency: null }), conversionAction: "Lead", sendValue: false });
    expect(metaEvent(bare.body).event_id).toBe(SUB);
    expect(bare.summary.mergesWithPixelLead).toBe(true);
    const own = buildMetaUploadRequest({ facts: facts(), ledger: ledger(), conversionAction: "Purchase", sendValue: false });
    expect(own.summary.mergesWithPixelLead).toBe(false);
  });

  it("fbc and fbp ride ONLY with marketing consent: false, absent, null, \"true\" and malformed all drop them (the builder re-checks what the gate checked)", () => {
    for (const consent of [{ analytics: true, marketing: false }, { analytics: true }, null, undefined, { marketing: "true" }, "yes", []]) {
      const p = buildMetaUploadRequest({ facts: facts({ visitorConsent: consent }), ledger: ledger(), conversionAction: "Lead", sendValue: false });
      const ud = metaEvent(p.body).user_data;
      expect(ud, JSON.stringify(consent)).not.toHaveProperty("fbc");
      expect(ud, JSON.stringify(consent)).not.toHaveProperty("fbp");
      expect(p.summary.identifierKinds, JSON.stringify(consent)).not.toContain("fbc");
      expect(p.summary.identifierKinds, JSON.stringify(consent)).not.toContain("fbp");
      expect(metaIdentifierKinds(facts({ visitorConsent: consent })), JSON.stringify(consent)).toEqual(["email", "phone"]);
    }
    const yes = buildMetaUploadRequest({ facts: facts({ visitorConsent: { marketing: true } }), ledger: ledger(), conversionAction: "Lead", sendValue: false });
    expect(metaEvent(yes.body).user_data).toMatchObject({ fbc: FBC, fbp: FBP });
  });

  it("a malformed cookie is ignored, never trusted", () => {
    for (const bad of ["fbclid-raw", "fb.1.12.abc", "fb.9.1696000000000.x", "fb.1.1696000000000.has space", `fb.1.1696000000000.${"a".repeat(201)}`, 5, null]) {
      expect(metaIdentifierKinds(facts({ contactEmail: null, contactPhone: null, attribution: { fbc: bad, fbp: bad } })), String(bad)).toEqual([]);
    }
  });

  it("value and currency ride only on `won`, only when the target sends value, only when the ledger row has one; currency is lower-case", () => {
    const won = buildMetaUploadRequest({ facts: facts(), ledger: ledger(), conversionAction: "Purchase", sendValue: true });
    expect(metaEvent(won.body).custom_data).toEqual({ value: 2500.5, currency: "usd" });
    expect(won.summary).toMatchObject({ valueSent: true, currency: "USD" });
    const notWon = buildMetaUploadRequest({ facts: facts(), ledger: ledger({ stage: "qualified" }), conversionAction: "Lead", sendValue: true });
    expect(metaEvent(notWon.body)).not.toHaveProperty("custom_data");
    expect(notWon.summary).toMatchObject({ valueSent: false, currency: null });
    const targetOff = buildMetaUploadRequest({ facts: facts(), ledger: ledger(), conversionAction: "Purchase", sendValue: false });
    expect(metaEvent(targetOff.body)).not.toHaveProperty("custom_data");
    const noValue = buildMetaUploadRequest({ facts: facts(), ledger: ledger({ dealValue: null, dealCurrency: null }), conversionAction: "Purchase", sendValue: true });
    expect(metaEvent(noValue.body)).not.toHaveProperty("custom_data");
  });

  it("omits the user_data keys it has nothing for (no empty hash is ever sent)", () => {
    const p = buildMetaUploadRequest({ facts: facts({ contactEmail: "nope", contactPhone: "0812 000", attribution: { fbp: FBP } }), ledger: ledger(), conversionAction: "Lead", sendValue: false });
    expect(metaEvent(p.body).user_data).toEqual({ fbp: FBP });
    expect(p.summary.identifierKinds).toEqual(["fbp"]);
  });

  it("event_source_url is the property's origin plus the form page PATH; anything else yields none", () => {
    expect(metaEventSourceUrl("https://www.gaiada.com/some/where?x=1", { form_page: "/contact/" })).toBe("https://www.gaiada.com/contact/");
    expect(metaEventSourceUrl("https://www.gaiada.com", { form_page: "/contact/?q=a@b.c" })).toBeNull();
    expect(metaEventSourceUrl("https://www.gaiada.com", { form_page: "https://evil.example/" })).toBeNull();
    expect(metaEventSourceUrl("javascript:alert(1)", { form_page: "/c/" })).toBeNull();
    expect(metaEventSourceUrl("not a url", { form_page: "/c/" })).toBeNull();
    expect(metaEventSourceUrl(null, { form_page: "/c/" })).toBeNull();
    expect(metaEventSourceUrl("https://x.com", null)).toBeNull();
    const withUrl = buildMetaUploadRequest({ facts: facts(), ledger: ledger(), conversionAction: "Lead", sendValue: false, eventSourceUrl: "https://www.gaiada.com/contact/" });
    expect(metaEvent(withUrl.body).event_source_url).toBe("https://www.gaiada.com/contact/");
    expect(withUrl.summary.eventSourceUrlSent).toBe(true);
    const without = buildMetaUploadRequest({ facts: facts(), ledger: ledger(), conversionAction: "Lead", sendValue: false });
    expect(metaEvent(without.body)).not.toHaveProperty("event_source_url");
    expect(without.summary.eventSourceUrlSent).toBe(false);
  });

  it("the summary (the only part that is persisted) holds no email, phone, hash, cookie or value", () => {
    const p = buildMetaUploadRequest({ facts: facts(), ledger: ledger(), conversionAction: "Purchase", sendValue: true });
    const text = JSON.stringify(p.summary).toLowerCase();
    for (const secret of ["jane", "example.com", "6281234567890", "81234567890", sha("jane.doe+promo@example.com"), sha("6281234567890"), FBC, FBP, "2500"]) {
      expect(text, secret).not.toContain(secret.toLowerCase());
    }
    // ...while the body (memory only) does hold them, which is the point of keeping the two apart.
    expect(JSON.stringify(p.body)).toContain(sha("jane.doe+promo@example.com"));
  });

  it("a conversion action that is not a Meta event name, or a bad date, throws BEFORE anything is built", () => {
    expect(() => buildMetaUploadRequest({ facts: facts(), ledger: ledger(), conversionAction: "customers/1/conversionActions/2", sendValue: false })).toThrow();
    expect(() => buildMetaUploadRequest({ facts: facts(), ledger: ledger({ occurredAt: "yesterday" }), conversionAction: "Lead", sendValue: false })).toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════ LinkedIn
describe("LinkedIn: normalisation, the conversion rule and the id rules", () => {
  it("email: trim and lower-case, then SHA-256", () => {
    expect(normalizeEmailForLinkedIn(" Jane.Doe@Example.COM ")).toBe("jane.doe@example.com");
    expect(normalizeEmailForLinkedIn("J.a.n.e@gmail.com")).toBe("j.a.n.e@gmail.com");
    expect(normalizeEmailForLinkedIn("nope")).toBeNull();
    expect(normalizeEmailForLinkedIn(null)).toBeNull();
  });
  it("the conversion rule: the URN, or its numeric id expanded to the URN; nothing else", () => {
    expect(linkedInConversionUrn("12345")).toBe("urn:lla:llaPartnerConversion:12345");
    expect(linkedInConversionUrn("urn:lla:llaPartnerConversion:12345")).toBe("urn:lla:llaPartnerConversion:12345");
    expect(linkedInConversionUrn("urn:li:organization:5")).toBeNull();
    expect(linkedInConversionUrn("Lead")).toBeNull();
    expect(isLinkedInConversionRef("999")).toBe(true);
    expect(isLinkedInConversionRef("urn:lla:llaPartnerConversion:9")).toBe(true);
    expect(isLinkedInConversionRef("customers/1/conversionActions/2")).toBe(false);
    expect(isLinkedInConversionRef(5)).toBe(false);
  });
  it("amount: a decimal string with the trailing zeros trimmed", () => {
    expect(linkedInAmount("2500.5000")).toBe("2500.5");
    expect(linkedInAmount("2500.0000")).toBe("2500");
    expect(linkedInAmount("2500")).toBe("2500");
    expect(linkedInAmount("0.1250")).toBe("0.125");
  });
  it("eventId: the bare submission id for the `lead` key (Insight-tag merge), else ${submissionRef}:${conversionKey}", () => {
    expect(linkedInEventId(SUB, "lead")).toBe(SUB);
    expect(linkedInEventId(SUB, "lead_won")).toBe(`${SUB}:lead_won`);
  });
});

describe("LinkedIn: the request (simulate sends nothing; this is what WOULD be sent)", () => {
  it("builds one conversionEvents element: URN, epoch millis, eventId, SHA256_EMAIL and the first-party tracking id", () => {
    const p = buildLinkedInUploadRequest({ facts: facts(), ledger: ledger(), conversionAction: "12345", sendValue: true });
    expect(p.body).toEqual({
      conversion: "urn:lla:llaPartnerConversion:12345",
      conversionHappenedAt: Date.parse("2026-10-12T03:04:05.000Z"),
      eventId: `${SUB}:lead_won`,
      user: { userIds: [
        { idType: "SHA256_EMAIL", idValue: sha("jane.doe+promo@example.com") },
        { idType: "LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID", idValue: FAT },
      ] },
      conversionValue: { currencyCode: "USD", amount: "2500.5" },
    });
    expect(p.summary.identifierKinds).toEqual(["email", "li_fat_id"]);
  });

  it("li_fat_id rides ONLY with marketing consent (the builder re-checks what the gate checked); the email still rides, the gate having passed", () => {
    for (const consent of [{ marketing: false }, { analytics: true }, null, undefined, { marketing: "true" }]) {
      const p = buildLinkedInUploadRequest({ facts: facts({ visitorConsent: consent }), ledger: ledger(), conversionAction: "12345", sendValue: false });
      expect(JSON.stringify(p.body), JSON.stringify(consent)).not.toContain(FAT);
      expect(p.summary.identifierKinds, JSON.stringify(consent)).toEqual(["email"]);
      expect(linkedInIdentifierKinds(facts({ visitorConsent: consent })), JSON.stringify(consent)).toEqual(["email"]);
    }
  });

  it("with no email, the li_fat_id alone is a usable identifier; with neither there is none", () => {
    expect(linkedInIdentifierKinds(facts({ contactEmail: null }))).toEqual(["li_fat_id"]);
    expect(linkedInIdentifierKinds(facts({ contactEmail: null, attribution: { li_fat_id: "has space" } }))).toEqual([]);
    expect(linkedInIdentifierKinds(facts({ contactEmail: "nope", attribution: null }))).toEqual([]);
    // A phone number is NOT a LinkedIn identifier.
    expect(linkedInIdentifierKinds(facts({ contactEmail: null, attribution: null, contactPhone: PHONE }))).toEqual([]);
  });

  it("conversionValue rides only on `won`, only when the target sends value, only when the ledger row has one", () => {
    const notWon = buildLinkedInUploadRequest({ facts: facts(), ledger: ledger({ stage: "qualified" }), conversionAction: "12345", sendValue: true });
    expect(notWon.body).not.toHaveProperty("conversionValue");
    expect(notWon.summary).toMatchObject({ valueSent: false, currency: null });
    expect(buildLinkedInUploadRequest({ facts: facts(), ledger: ledger(), conversionAction: "12345", sendValue: false }).body).not.toHaveProperty("conversionValue");
    expect(buildLinkedInUploadRequest({ facts: facts(), ledger: ledger({ dealValue: null, dealCurrency: null }), conversionAction: "12345", sendValue: true }).body)
      .not.toHaveProperty("conversionValue");
    expect(buildLinkedInUploadRequest({ facts: facts(), ledger: ledger(), conversionAction: "12345", sendValue: true }).summary).toMatchObject({ valueSent: true, currency: "USD" });
  });

  it("the summary (the only part that is persisted) holds no email, hash, tracking id or value", () => {
    const p = buildLinkedInUploadRequest({ facts: facts(), ledger: ledger(), conversionAction: "12345", sendValue: true });
    const text = JSON.stringify(p.summary).toLowerCase();
    for (const secret of ["jane", "example.com", sha("jane.doe+promo@example.com"), FAT, "2500"]) expect(text, secret).not.toContain(secret.toLowerCase());
    expect(JSON.stringify(p.body)).toContain(sha("jane.doe+promo@example.com"));
  });

  it("a conversion action that is not a LinkedIn rule throws BEFORE anything is built", () => {
    expect(() => buildLinkedInUploadRequest({ facts: facts(), ledger: ledger(), conversionAction: "Lead", sendValue: false })).toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════ the gate and the dispatcher
describe("the gate, per platform (design §8.4)", () => {
  it("Meta needs em, ph, fbc or fbp; LinkedIn needs an email or li_fat_id; a lead with neither is `no_identifier`", () => {
    const bare = facts({ contactEmail: null, contactPhone: null, attribution: { landing: "/x/" } });
    expect(evaluateGate(bare, "meta_capi", false)).toEqual({ ok: false, reason: REASON.noIdentifier });
    expect(evaluateGate(bare, "linkedin_capi", false)).toEqual({ ok: false, reason: REASON.noIdentifier });
    expect(evaluateGate(facts({ contactEmail: null, contactPhone: null, attribution: { fbp: FBP } }), "meta_capi", false)).toEqual({ ok: true, identifierKinds: ["fbp"] });
    expect(evaluateGate(facts({ contactEmail: null, contactPhone: PHONE, attribution: null }), "meta_capi", false)).toEqual({ ok: true, identifierKinds: ["phone"] });
    expect(evaluateGate(facts({ contactEmail: null, contactPhone: PHONE, attribution: null }), "linkedin_capi", false)).toEqual({ ok: false, reason: REASON.noIdentifier });
    expect(evaluateGate(facts({ contactEmail: null, attribution: { li_fat_id: FAT } }), "linkedin_capi", false)).toEqual({ ok: true, identifierKinds: ["li_fat_id"] });
    // Google's click id is not a Meta or LinkedIn identifier.
    expect(identifierKindsFor("meta_capi", facts({ contactEmail: null, contactPhone: null, attribution: { gclid: "G1" } }))).toEqual([]);
  });

  it("consent and suppression refuse BEFORE the identifier question, on every platform", () => {
    for (const platform of ["meta_capi", "linkedin_capi"] as const) {
      expect(evaluateGate(facts({ visitorConsent: { marketing: false } }), platform, false), platform).toEqual({ ok: false, reason: REASON.consentNotGiven });
      expect(evaluateGate(facts({ visitorConsent: null }), platform, false), platform).toEqual({ ok: false, reason: REASON.consentUnknown });
      expect(evaluateGate(facts(), platform, true), platform).toEqual({ ok: false, reason: REASON.suppressed });
      expect(evaluateGate(null, platform, false), platform).toEqual({ ok: false, reason: REASON.leadNotFound });
      expect(evaluateGate(facts({ deletedAt: "2026-10-01T00:00:00.000Z" }), platform, false), platform).toEqual({ ok: false, reason: REASON.leadDeleted });
    }
  });
});

describe("the dispatcher and the boot guard", () => {
  it("buildConversionPlan dispatches by platform and returns a plan whose summary names the platform", () => {
    const input = { facts: facts(), ledger: ledger(), sendValue: true };
    expect(buildConversionPlan("meta_capi", { ...input, conversionAction: "Purchase" }).summary.platform).toBe("meta_capi");
    expect(buildConversionPlan("linkedin_capi", { ...input, conversionAction: "12345" }).summary.platform).toBe("linkedin_capi");
    expect(buildConversionPlan("google_ads", { ...input, conversionAction: "customers/1/conversionActions/2" }).summary.platform).toBe("google_ads");
  });

  it("a target whose action the platform cannot take throws (the service turns it into a skipped `conversion_request_invalid`, never a send)", () => {
    const input = { facts: facts(), ledger: ledger(), sendValue: false };
    expect(() => buildConversionPlan("meta_capi", { ...input, conversionAction: "12345" })).toThrow();
    expect(() => buildConversionPlan("linkedin_capi", { ...input, conversionAction: "Lead" })).toThrow();
  });

  it("Meta and LinkedIn are SIMULATE-ONLY: no live uploader is registered, and boot REFUSES either listed as live", () => {
    expect([...SIMULATE_ONLY_PLATFORMS]).toEqual(["meta_capi", "linkedin_capi"]);
    resetLiveConversionUploaders();
    expect(() => wireSearchConversionsWriteMode({})).not.toThrow();
    expect(getLiveConversionUploader("meta_capi")).toBeUndefined();
    expect(getLiveConversionUploader("linkedin_capi")).toBeUndefined();
    expect(getLiveConversionUploader("google_ads")).toBeDefined();
    for (const p of ["meta_capi", "linkedin_capi", "google_ads,meta_capi"]) {
      expect(() => wireSearchConversionsWriteMode({ [SEARCH_CONVERSIONS_LIVE_PLATFORMS_ENV]: p }), p).toThrow(ConversionsWriteModeBootError);
    }
    expect(() => assertConversionsBootSafe("meta_capi", () => false)).toThrow(/SIMULATE-ONLY/);
    expect(() => assertConversionsBootSafe("linkedin_capi", () => false)).toThrow(/SIMULATE-ONLY/);
    // A future live uploader that registers is let through (the guard checks registration, not the platform's name).
    expect(() => assertConversionsBootSafe("meta_capi", (p) => p === "meta_capi")).not.toThrow();
  });
});

describe("the config route accepts the new platforms with each platform's own conversion action", () => {
  const base = { webSiteSlug: "gaiada", stage: "won", conversionKey: "lead_won" };
  it("meta_capi: a Meta event name", () => {
    expect(parseTargetBody({ ...base, platform: "meta_capi", conversionAction: "Purchase" })).toMatchObject({ ok: true, input: { platform: "meta_capi", conversionAction: "Purchase" } });
    for (const bad of ["customers/1/conversionActions/2", "Lead Won", "1Lead", ""]) {
      expect(parseTargetBody({ ...base, platform: "meta_capi", conversionAction: bad }), bad).toMatchObject({ ok: false, reason: "conversion_action_invalid" });
    }
  });
  it("linkedin_capi: a conversion rule id or URN", () => {
    expect(parseTargetBody({ ...base, platform: "linkedin_capi", conversionAction: " 12345 " })).toMatchObject({ ok: true, input: { platform: "linkedin_capi", conversionAction: "12345" } });
    expect(parseTargetBody({ ...base, platform: "linkedin_capi", conversionAction: "urn:lla:llaPartnerConversion:7" })).toMatchObject({ ok: true });
    for (const bad of ["Lead", "customers/1/conversionActions/2", "urn:li:organization:5"]) {
      expect(parseTargetBody({ ...base, platform: "linkedin_capi", conversionAction: bad }), bad).toMatchObject({ ok: false, reason: "conversion_action_invalid" });
    }
  });
  it("google_ads is unchanged, and an unknown platform is still platform_unknown", () => {
    expect(parseTargetBody({ ...base, platform: "google_ads", conversionAction: "123" })).toMatchObject({ ok: true });
    expect(parseTargetBody({ ...base, platform: "google_ads", conversionAction: "Purchase" })).toMatchObject({ ok: false, reason: "conversion_action_invalid" });
    expect(parseTargetBody({ ...base, platform: "tiktok", conversionAction: "1" })).toMatchObject({ ok: false, reason: "platform_unknown" });
  });
});
