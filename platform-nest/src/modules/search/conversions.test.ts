// M5-P2 — ad-platform conversion uploads: the pure half, with no services. The gate, the normalisation and hashing, the request
// Google would receive (in simulate, nothing is sent), the content binding, the write-mode switch and its boot guard, the typed
// body of the one config route, the MCP tool defs, and the STATIC wiring pins (main.ts lists the stream, decide() calls the executor,
// the D14 registry bars the tool). The DB half is conversions.db.test.ts (Linux gate); the consumer loop is
// conversions-consumer-wiring.test.ts.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LeadConversionFacts } from "../../core/agency-lead-pipeline.service";
import {
  ALL_PLATFORMS, CONVERSION_UPLOAD_TOOL, CONVERSION_UPLOAD_WORKFLOW, NO_PERSONAL_DATA_KEYS, REASON, SEARCH_CONVERSIONS_LIVE_PLATFORMS_ENV,
  SUPPORTED_PLATFORMS, approvalReason, clickIdOf, conversionContentHash, conversionModeFor, evaluateGate, googleIdentifierKinds,
  isConversionUploadRequest, normalizeEmailForGoogle, normalizePhoneE164, parseConversionToolArgs, parseLivePlatforms, sha256Hex,
  type ConversionBinding,
} from "./conversions";
import { buildGoogleUploadRequest, conversionActionResource, googleAdsConversionUploader, googleDateTime } from "./conversions-google";
import {
  ConversionsWriteModeBootError, assertConversionsBootSafe, getLiveConversionUploader, resetLiveConversionUploaders,
  wireSearchConversionsWriteMode,
} from "./conversions-uploaders";
import { parseTargetBody } from "./conversions.controller";
import { CONVERSION_MCP_TOOLS } from "./conversions-mcp-tools";
import { searchModule } from "./index";
import { getExecutable, isBarredExecutable } from "../../core/approval-executables";

const src = (...p: string[]): string => readFileSync(join(__dirname, "..", "..", ...p), "utf8");

const EMAIL = "Jane.Doe+promo@Gmail.com";
const PHONE = "+62 812-3456-7890";
const GCLID = "Cj0KCQjwGCLIDvalue_123-abc";

function facts(over: Partial<LeadConversionFacts> = {}): LeadConversionFacts {
  return {
    leadId: "11111111-1111-4111-8111-111111111111", source: "web", status: "in_review", stage: "proposal", deletedAt: null,
    submissionRef: "22222222-2222-4222-8222-222222222222", originForm: "contact", webSiteSlug: "gaiada",
    attribution: { gclid: GCLID, utm_source: "google" }, visitorConsent: { analytics: true, marketing: true, version: "3" },
    contactEmail: EMAIL, contactPhone: PHONE, dealValue: null, dealCurrency: null,
    ...over,
  };
}

describe("normalisation and hashing (Google's rules)", () => {
  it("email: trim, lower-case, gmail dots removed before the @ (the + tag is kept: UNVERIFIED until staging)", () => {
    expect(normalizeEmailForGoogle("  Jane.Doe@Example.COM ")).toBe("jane.doe@example.com");
    expect(normalizeEmailForGoogle("J.a.n.e@gmail.com")).toBe("jane@gmail.com");
    expect(normalizeEmailForGoogle("J.a.n.e@googlemail.com")).toBe("jane@googlemail.com");
    expect(normalizeEmailForGoogle("not an email")).toBeNull();
    expect(normalizeEmailForGoogle("@x.com")).toBeNull();
    expect(normalizeEmailForGoogle(null)).toBeNull();
    expect(normalizeEmailForGoogle(42)).toBeNull();
  });

  it("phone: E.164 only when the number was written WITH a country code; a national number is never guessed at", () => {
    expect(normalizePhoneE164("+62 812-3456-7890")).toBe("+6281234567890");
    expect(normalizePhoneE164("0062 812 3456 7890")).toBe("+6281234567890");
    expect(normalizePhoneE164("0812 3456 7890")).toBeNull();
    expect(normalizePhoneE164("+12")).toBeNull();
    expect(normalizePhoneE164("call me")).toBeNull();
    expect(normalizePhoneE164(null)).toBeNull();
  });

  it("sha256 is plain hex over the UTF-8 string (the standard test vector)", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("clickIdOf: gclid beats gbraid beats wbraid, and a malformed value is ignored, never trusted", () => {
    expect(clickIdOf({ gclid: "g1", gbraid: "b1", wbraid: "w1" })).toEqual({ kind: "gclid", value: "g1" });
    expect(clickIdOf({ gbraid: "b1", wbraid: "w1" })).toEqual({ kind: "gbraid", value: "b1" });
    expect(clickIdOf({ wbraid: "w1" })).toEqual({ kind: "wbraid", value: "w1" });
    expect(clickIdOf({ gclid: "has space" })).toBeNull();
    expect(clickIdOf({ gclid: "x".repeat(201) })).toBeNull();
    expect(clickIdOf({ gclid: 5 })).toBeNull();
    expect(clickIdOf(null)).toBeNull();
    expect(clickIdOf("gclid")).toBeNull();
    expect(clickIdOf([])).toBeNull();
  });
});

describe("the gate (design §8.4), pure", () => {
  it("consent is STRICTLY marketing === true: absent, false, \"true\", malformed and a missing key all refuse", () => {
    const refused = (visitorConsent: unknown) => evaluateGate(facts({ visitorConsent }), "google_ads", false);
    expect(refused(null)).toEqual({ ok: false, reason: REASON.consentUnknown });
    expect(refused(undefined)).toEqual({ ok: false, reason: REASON.consentUnknown });
    expect(refused({ analytics: true })).toEqual({ ok: false, reason: REASON.consentUnknown });
    expect(refused({ marketing: "true" })).toEqual({ ok: false, reason: REASON.consentUnknown });
    expect(refused({ marketing: 1 })).toEqual({ ok: false, reason: REASON.consentUnknown });
    expect(refused("marketing")).toEqual({ ok: false, reason: REASON.consentUnknown });
    expect(refused([true])).toEqual({ ok: false, reason: REASON.consentUnknown });
    expect(refused({ marketing: false })).toEqual({ ok: false, reason: REASON.consentNotGiven });
    expect(evaluateGate(facts(), "google_ads", false)).toMatchObject({ ok: true });
  });

  it("no lead, a deleted lead, a suppressed contact and a lead with nothing to send are each refused with their own reason", () => {
    expect(evaluateGate(null, "google_ads", false)).toEqual({ ok: false, reason: REASON.leadNotFound });
    expect(evaluateGate(facts({ deletedAt: "2026-10-01T00:00:00.000Z" }), "google_ads", false)).toEqual({ ok: false, reason: REASON.leadDeleted });
    expect(evaluateGate(facts(), "google_ads", true)).toEqual({ ok: false, reason: REASON.suppressed });
    const bare = facts({ attribution: { utm_source: "google" }, contactEmail: null, contactPhone: null });
    expect(evaluateGate(bare, "google_ads", false)).toEqual({ ok: false, reason: REASON.noIdentifier });
    // A national number cannot be made E.164, a malformed email is not one: neither counts as an identifier.
    expect(evaluateGate(facts({ attribution: null, contactEmail: "nope", contactPhone: "0812 3456 7890" }), "google_ads", false))
      .toEqual({ ok: false, reason: REASON.noIdentifier });
  });

  it("the order is: lead, deleted, consent, suppression, identifier (consent is judged before suppression)", () => {
    const f = facts({ visitorConsent: { marketing: false }, attribution: null, contactEmail: null, contactPhone: null });
    expect(evaluateGate(f, "google_ads", true)).toEqual({ ok: false, reason: REASON.consentNotGiven });
  });

  it("identifier kinds: a click id alone, an email alone, a phone alone, or all three each pass", () => {
    expect(googleIdentifierKinds(facts({ contactEmail: null, contactPhone: null }))).toEqual(["gclid"]);
    expect(googleIdentifierKinds(facts({ attribution: null, contactPhone: null }))).toEqual(["email"]);
    expect(googleIdentifierKinds(facts({ attribution: null, contactEmail: null }))).toEqual(["phone"]);
    expect(googleIdentifierKinds(facts())).toEqual(["gclid", "email", "phone"]);
    expect(evaluateGate(facts({ attribution: null, contactPhone: null }), "google_ads", false)).toEqual({ ok: true, identifierKinds: ["email"] });
  });

  it("Meta (P3) and LinkedIn (P4) have adapters: the gate asks each platform's own identifier rules (their detail is conversions-meta-linkedin.test.ts)", () => {
    expect(evaluateGate(facts(), "meta_capi", false)).toEqual({ ok: true, identifierKinds: ["email", "phone"] });
    expect(evaluateGate(facts({ contactPhone: null }), "linkedin_capi", false)).toEqual({ ok: true, identifierKinds: ["email"] });
    expect(SUPPORTED_PLATFORMS).toEqual(["google_ads", "meta_capi", "linkedin_capi"]);
    expect(ALL_PLATFORMS).toHaveLength(3);
  });
});

describe("the Google request (simulate sends nothing; this is what WOULD be sent)", () => {
  const ledger = {
    submissionRef: "22222222-2222-4222-8222-222222222222", conversionKey: "lead_won", occurredAt: "2026-10-12T09:00:00.000Z",
    dealValue: "15000000.0000", dealCurrency: "IDR",
  };

  it("carries ONE click id, hashed email and phone, the order id, the consent flag, partial failure; the value only when the target sends it", () => {
    const withValue = buildGoogleUploadRequest({ facts: facts(), ledger, conversionAction: "customers/123/conversionActions/456", customerId: null, sendValue: true });
    const conv = (withValue.body.conversions as Array<Record<string, unknown>>)[0];
    expect(withValue.body.partialFailure).toBe(true);
    expect(conv).toMatchObject({
      conversionAction: "customers/123/conversionActions/456",
      conversionDateTime: "2026-10-12 09:00:00+00:00",
      orderId: "22222222-2222-4222-8222-222222222222:lead_won",
      gclid: GCLID,
      conversionValue: 15000000,
      currencyCode: "IDR",
      consent: { adUserData: "GRANTED" },
    });
    expect(conv).not.toHaveProperty("gbraid");
    expect(conv).not.toHaveProperty("wbraid");
    expect(conv.userIdentifiers).toEqual([
      { userIdentifierSource: "FIRST_PARTY", hashedEmail: sha256Hex("janedoe+promo@gmail.com") },
      { userIdentifierSource: "FIRST_PARTY", hashedPhoneNumber: sha256Hex("+6281234567890") },
    ]);

    const noValue = buildGoogleUploadRequest({ facts: facts(), ledger, conversionAction: "customers/123/conversionActions/456", customerId: null, sendValue: false });
    const c2 = (noValue.body.conversions as Array<Record<string, unknown>>)[0];
    expect(c2).not.toHaveProperty("conversionValue");
    expect(c2).not.toHaveProperty("currencyCode");
    expect(noValue.summary.valueSent).toBe(false);
    // A target that sends value but a lead with none: nothing rides.
    const none = buildGoogleUploadRequest({ facts: facts(), ledger: { ...ledger, dealValue: null, dealCurrency: null }, conversionAction: "1", customerId: null, sendValue: true });
    expect(none.summary.valueSent).toBe(false);
  });

  it("with no click id the upload is an ENHANCED CONVERSION FOR LEADS: hashed identifiers, no click id field", () => {
    const p = buildGoogleUploadRequest({
      facts: facts({ attribution: { utm_source: "google" } }), ledger, conversionAction: "456", customerId: "123", sendValue: false,
    });
    const conv = (p.body.conversions as Array<Record<string, unknown>>)[0];
    expect(conv).not.toHaveProperty("gclid");
    expect(conv.conversionAction).toBe("customers/123/conversionActions/456");
    expect(p.summary.identifierKinds).toEqual(["email", "phone"]);
  });

  it("gbraid is used when there is no gclid (one click id only)", () => {
    const p = buildGoogleUploadRequest({ facts: facts({ attribution: { gbraid: "GB1", wbraid: "WB1" } }), ledger, conversionAction: "1", customerId: null, sendValue: false });
    const conv = (p.body.conversions as Array<Record<string, unknown>>)[0];
    expect(conv).toMatchObject({ gbraid: "GB1" });
    expect(conv).not.toHaveProperty("wbraid");
  });

  it("THE SUMMARY (what the ledger stores) holds kinds and field names, and NO identifier value or hash", () => {
    const p = buildGoogleUploadRequest({ facts: facts(), ledger, conversionAction: "customers/123/conversionActions/456", customerId: null, sendValue: true });
    const text = JSON.stringify(p.summary);
    expect(p.summary.identifierKinds).toEqual(["gclid", "email", "phone"]);
    expect(p.summary.identifierFields).toEqual(["gclid", "userIdentifiers.hashedEmail", "userIdentifiers.hashedPhoneNumber"]);
    for (const secret of [GCLID, "gmail.com", "jane", "6281234567890", "812", sha256Hex("janedoe+promo@gmail.com"), sha256Hex("+6281234567890")]) {
      expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
    }
    expect(p.summary).toMatchObject({ platform: "google_ads", valueSent: true, currency: "IDR", consent: { adUserData: "GRANTED" } });
  });

  it("date time and conversion-action helpers", () => {
    expect(googleDateTime("2026-01-02T03:04:05.678Z")).toBe("2026-01-02 03:04:05+00:00");
    expect(() => googleDateTime("not a date")).toThrow();
    expect(conversionActionResource("customers/1/conversionActions/2", "9")).toBe("customers/1/conversionActions/2");
    expect(conversionActionResource("2", "9")).toBe("customers/9/conversionActions/2");
    expect(conversionActionResource("2", null)).toBe("2");
  });

  it("the live uploader refuses BEFORE any network or database call when no developer token is configured", async () => {
    const r = await googleAdsConversionUploader({ tenantId: "t", propertyId: "p", conversionAction: "1", body: { conversions: [{ conversionAction: "1" }] } });
    expect(r).toEqual({ ok: false, error: REASON.notConfigured, ambiguous: false });
  });
});

describe("the content binding and the stored args", () => {
  const b: ConversionBinding = {
    ledgerId: "33333333-3333-4333-8333-333333333333", tenantId: "44444444-4444-4444-8444-444444444444",
    propertyId: "55555555-5555-4555-8555-555555555555", leadId: "11111111-1111-4111-8111-111111111111",
    stageEventId: "66666666-6666-4666-8666-666666666666", submissionRef: "22222222-2222-4222-8222-222222222222",
    platform: "google_ads", stage: "won", conversionKey: "lead_won", dealValue: "10.0000", dealCurrency: "USD",
  };

  it("the hash is stable and changes with every bound field", () => {
    const h = conversionContentHash(b);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(conversionContentHash({ ...b })).toBe(h);
    for (const [k, v] of Object.entries({
      ledgerId: "33333333-3333-4333-8333-33333333333a", tenantId: "44444444-4444-4444-8444-44444444444a", propertyId: "55555555-5555-4555-8555-55555555555a",
      leadId: "11111111-1111-4111-8111-11111111111a", stageEventId: "66666666-6666-4666-8666-66666666666a",
      submissionRef: "22222222-2222-4222-8222-22222222222a", platform: "meta_capi", stage: "lost", conversionKey: "other",
      dealValue: "11.0000", dealCurrency: "EUR",
    })) {
      expect(conversionContentHash({ ...b, [k]: v } as ConversionBinding), `${k} must be bound`).not.toBe(h);
    }
    // null value and empty value are the same absence; a value without a currency cannot be built (the table forbids it).
    expect(conversionContentHash({ ...b, dealValue: null, dealCurrency: null })).not.toBe(h);
  });

  const good = {
    ledgerId: b.ledgerId, propertyId: b.propertyId, leadId: b.leadId, stageEventId: b.stageEventId, platform: "google_ads",
    conversionKey: "lead_won", stage: "won", dealValue: "10.0000", dealCurrency: "USD", contentHash: conversionContentHash(b),
  };

  it("parseConversionToolArgs accepts exactly the filed shape and REFUSES any extra key, so a contact field can never ride along", () => {
    expect(parseConversionToolArgs(good)).toEqual(good);
    expect(parseConversionToolArgs({ ...good, dealValue: null, dealCurrency: null })).toMatchObject({ dealValue: null, dealCurrency: null });
    for (const key of NO_PERSONAL_DATA_KEYS) expect(parseConversionToolArgs({ ...good, [key]: "x" }), key).toBeNull();
    expect(parseConversionToolArgs({ ...good, email: "a@b.c" })).toBeNull();
    expect(parseConversionToolArgs({ ...good, ledgerId: "nope" })).toBeNull();
    expect(parseConversionToolArgs({ ...good, platform: "tiktok" })).toBeNull();
    expect(parseConversionToolArgs({ ...good, dealValue: "1.5", dealCurrency: null })).toBeNull();
    expect(parseConversionToolArgs({ ...good, dealValue: "abc" })).toBeNull();
    expect(parseConversionToolArgs({ ...good, contentHash: "short" })).toBeNull();
    expect(parseConversionToolArgs(null)).toBeNull();
    expect(parseConversionToolArgs([])).toBeNull();
  });

  it("the approval's reason is words and a value: no name, no contact", () => {
    const r = approvalReason("google_ads", "won", "lead_won", "10.0000", "USD");
    expect(r).toContain("Google Ads");
    expect(r).toContain("10.0000 USD");
    expect(r).not.toMatch(/@|gclid|\+\d/);
    expect(approvalReason("google_ads", "qualified", "lead_qualified", null, null)).not.toContain("value");
  });

  it("recognises the row by origin AND workflow", () => {
    expect(isConversionUploadRequest("search", CONVERSION_UPLOAD_WORKFLOW)).toBe(true);
    expect(isConversionUploadRequest("search", "search:probe_consent")).toBe(false);
    expect(isConversionUploadRequest("automation", CONVERSION_UPLOAD_WORKFLOW)).toBe(false);
    expect(isConversionUploadRequest("search", null)).toBe(false);
    expect(CONVERSION_UPLOAD_TOOL).toBe("search.conversions.upload");
  });
});

describe("the write-mode switch (design §8.7): simulate unless a platform is listed", () => {
  it("the default is simulate for every platform", () => {
    for (const p of ALL_PLATFORMS) expect(conversionModeFor(p, {})).toBe("simulate");
    expect(conversionModeFor("google_ads", { [SEARCH_CONVERSIONS_LIVE_PLATFORMS_ENV]: "" })).toBe("simulate");
  });
  it("only a listed platform is live, and the campaign switch does not leak into it", () => {
    const env = { [SEARCH_CONVERSIONS_LIVE_PLATFORMS_ENV]: " google_ads , bogus", SEARCH_ADS_WRITE_MODE: "live" };
    expect(conversionModeFor("google_ads", env)).toBe("live");
    expect(conversionModeFor("meta_capi", env)).toBe("simulate");
    expect(conversionModeFor("google_ads", { SEARCH_ADS_WRITE_MODE: "live" })).toBe("simulate");
    expect(parseLivePlatforms("google_ads, bogus")).toEqual({ platforms: new Set(["google_ads"]), unknown: ["bogus"] });
  });
  it("boot REFUSES a listed platform with no registered live uploader, and an unknown token", () => {
    expect(() => assertConversionsBootSafe(undefined, () => false)).not.toThrow();
    expect(() => assertConversionsBootSafe("", () => false)).not.toThrow();
    expect(() => assertConversionsBootSafe("google_ads", () => true)).not.toThrow();
    expect(() => assertConversionsBootSafe("google_ads", () => false)).toThrow(ConversionsWriteModeBootError);
    expect(() => assertConversionsBootSafe("meta_capi", () => false)).toThrow(/no live conversion uploader/);
    expect(() => assertConversionsBootSafe("gogle_ads", () => true)).toThrow(/unknown platform/);
  });
  it("the real boot wiring registers Google's uploader, lets google_ads go live, and refuses meta_capi until P3 exists", () => {
    resetLiveConversionUploaders();
    expect(getLiveConversionUploader("google_ads")).toBeUndefined();
    expect(() => wireSearchConversionsWriteMode({})).not.toThrow();
    expect(getLiveConversionUploader("google_ads")).toBe(googleAdsConversionUploader);
    expect(() => wireSearchConversionsWriteMode({ [SEARCH_CONVERSIONS_LIVE_PLATFORMS_ENV]: "google_ads" })).not.toThrow();
    expect(() => wireSearchConversionsWriteMode({ [SEARCH_CONVERSIONS_LIVE_PLATFORMS_ENV]: "meta_capi" })).toThrow(ConversionsWriteModeBootError);
    expect(() => wireSearchConversionsWriteMode({ [SEARCH_CONVERSIONS_LIVE_PLATFORMS_ENV]: "google_ads,linkedin_capi" })).toThrow(ConversionsWriteModeBootError);
  });
  it("main.ts calls the wiring at function scope of wireSearchProviderModeAndAdsWriteMode, outside any mode branch", () => {
    const main = src("main.ts");
    const fn = main.slice(main.indexOf("export function wireSearchProviderModeAndAdsWriteMode"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toContain("\n  wireSearchConversionsWriteMode();");
  });
});

describe("the config route's body (typed, strict)", () => {
  const ok = { webSiteSlug: "gaiada", platform: "google_ads", stage: "won", conversionKey: "lead_won", conversionAction: "customers/1/conversionActions/2" };
  it("accepts a valid body and defaults sendValue false, enabled true", () => {
    expect(parseTargetBody(ok)).toEqual({ ok: true, input: { ...ok, sendValue: false, enabled: true } });
    expect(parseTargetBody({ ...ok, conversionAction: " 123 ", sendValue: true, enabled: false })).toEqual({
      ok: true, input: { ...ok, conversionAction: "123", sendValue: true, enabled: false },
    });
  });
  it("each bad field is its own typed reason", () => {
    const reason = (over: Record<string, unknown>) => { const r = parseTargetBody({ ...ok, ...over }); return r.ok ? "ok" : r.reason; };
    expect(reason({ webSiteSlug: "Bad Slug" })).toBe("web_site_slug_invalid");
    expect(reason({ platform: "tiktok" })).toBe("platform_unknown");
    expect(reason({ stage: "Won!" })).toBe("stage_unknown");
    expect(reason({ conversionKey: "Lead Won" })).toBe("conversion_key_invalid");
    expect(reason({ conversionAction: "customers/1" })).toBe("conversion_action_invalid");
    expect(reason({ sendValue: "yes" })).toBe("send_value_invalid");
    expect(reason({ enabled: 1 })).toBe("enabled_invalid");
    expect(parseTargetBody(null)).toMatchObject({ ok: false, reason: "web_site_slug_invalid" });
  });
});

describe("the MCP tools and the module contract", () => {
  it("one LOW verified write and three reads; every write carries an impact; paths are the controller's", () => {
    expect(CONVERSION_MCP_TOOLS.map((t) => t.name).sort()).toEqual([
      "search.listConversionTargets", "search.listConversionUploads", "search.listLeadConversionUploads", "search.setConversionTarget",
    ]);
    for (const t of CONVERSION_MCP_TOOLS) {
      expect(t.pathTemplate, t.name).toMatch(/^\/api\/:tenantId\/modules\/search\//);
      if (t.write) {
        expect(t.impact, t.name).toBe("low");
        expect(t.minAssurance, t.name).toBe("verified");
      } else {
        expect(t.minAssurance, t.name).toBe("low");
        expect(t.method, t.name).toBe("GET");
      }
    }
    // No tool uploads anything and none accepts an identifier.
    for (const t of CONVERSION_MCP_TOOLS) expect(JSON.stringify(t.inputSchema)).not.toMatch(/email|phone|gclid|contact/i);
    const names = new Set((searchModule.mcpTools ?? []).map((t) => t.name));
    for (const t of CONVERSION_MCP_TOOLS) expect(names.has(t.name), `${t.name} must be on the search module`).toBe(true);
  });

  it("the search module registers the stage-changed handler and NOT an automation_approval.decided one (search-sem-apply's money guard)", () => {
    expect(typeof searchModule.eventHandlers?.["agency.lead.stage_changed"]).toBe("function");
    expect(Object.keys(searchModule.eventHandlers ?? {}).some((k) => k.startsWith("automation_approval."))).toBe(false);
    expect(searchModule.migrations).toContain("202610131200_search_conversion_uploads.sql");
  });
});

describe("static wiring pins", () => {
  it("main.ts's startConsumerLoop([...]) lists \"agency_lead\" (the SMM-14 trap: registered and never invoked without it)", () => {
    const main = src("main.ts");
    const start = main.indexOf("startConsumerLoop([");
    expect(start).toBeGreaterThan(-1);
    const call = main.slice(start);
    // Comments stripped: a comment that merely MENTIONS "agency_lead" must not satisfy the pin.
    const list = call.slice(0, call.indexOf("]);") + 3).replace(/\/\/.*$/gm, "");
    expect([...list.matchAll(/"([a-z_]+)"/g)].map((m) => m[1])).toContain("agency_lead");
  });

  it("decide() recognises the row, authorizes the property, sets pending, executes in-band and closes a rejection", () => {
    const c = src("core/automation-approvals.controller.ts");
    expect(c).toContain("isConversionUploadRequest(rowOrigin");
    expect(c).toContain("conversionPropertyIdOf(existing.rows[0].tool_args)");
    expect(c).toMatch(/isReveal \|\| isWebdesk \|\| isConversionUpload\) && decision === "approved"\) \? "pending"/);
    expect(c).toContain("executeApprovedConversionUpload(tenantId, id, res.tool_args, req.principal)");
    expect(c).toContain("recordConversionUploadRejected(tenantId, id)");
  });

  it("the D14 registry BARS the tool: it can never be re-driven through the hub, and registering it throws", () => {
    expect(isBarredExecutable(CONVERSION_UPLOAD_TOOL)).toBe(true);
    expect(getExecutable(CONVERSION_UPLOAD_TOOL)).toBeUndefined();
  });

  it("no conversion file owns a network primitive (the live call goes through the sanctioned Ads transport)", () => {
    for (const f of ["conversions.ts", "conversions-google.ts", "conversions-meta.ts", "conversions-linkedin.ts", "conversions-uploaders.ts", "conversions.service.ts", "conversions.controller.ts"]) {
      const text = src("modules", "search", f).replace(/\/\/.*$/gm, "");
      expect(text, f).not.toMatch(/\bfetch\s*\(|\baxios\b|node:https?|XMLHttpRequest/);
    }
  });

  it("no SQL that writes the ledger names a contact field, a hash or a click id (those are read at execution and kept in memory)", () => {
    const svc = src("modules", "search", "conversions.service.ts");
    const writes = [...svc.matchAll(/`((?:INSERT INTO|UPDATE)\s+search_conversion_uploads[^`]*)`/g)].map((m) => m[1]);
    expect(writes.length).toBeGreaterThanOrEqual(6);
    // `content_hash` is the sha256 of ids (the binding), not of a contact: strip it before looking for contact data.
    for (const sql of writes) expect(sql.replace(/content_hash/g, "")).not.toMatch(/email|phone|contact|hash|gclid|gbraid|wbraid|attribution|consent/i);
  });
});
