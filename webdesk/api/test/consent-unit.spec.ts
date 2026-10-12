// M5-G6 — the pure parts of the consent log: the body allow-list, the coarse user-agent bucket, the retention
// config (an empty env must never become 0), the optional consentId on a submission's visitor_consent, and the
// privacy identifier resolving a uuid as a consent id. No database, no Nest, no Redis.
import { describe, expect, it } from "vitest";
import { CONSENT_ALLOWED_KEYS, classifyUserAgent, isUuid, parseConsentBody } from "../src/consent/consent-body";
import { ConsentConfigError, RETENTION_MONTHS, resolveConsentRetentionMonths } from "../src/consent/consent.config";
import { sanitizeVisitorConsent } from "../src/forms/attribution";
import { resolveSubject } from "../src/privacy/identifier";

const ID = "3f2b8c1e-5a4d-4e6f-9a0b-1c2d3e4f5a6b";
const base = { analytics: true, marketing: false, version: "3" };

describe("parseConsentBody", () => {
  it("accepts the documented body and keeps a supplied uuid (lower-cased)", () => {
    const r = parseConsentBody({ ...base, consentId: ID.toUpperCase(), action: "update" });
    expect(r).toEqual({ ok: true, value: { consentId: ID, minted: false, analytics: true, marketing: false, version: "3", action: "update", droppedKeys: 0 } });
  });

  it("mints a uuid when consentId is absent, and defaults the action to grant", () => {
    const r = parseConsentBody(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(isUuid(r.value.consentId)).toBe(true);
      expect(r.value.minted).toBe(true);
      expect(r.value.action).toBe("grant");
    }
  });

  it("a supplied id with no action defaults to update", () => {
    const r = parseConsentBody({ ...base, consentId: ID });
    expect(r.ok && r.value.action).toBe("update");
  });

  it("a bad uuid is replaced by a minted one, never an error and never stored", () => {
    for (const bad of ["not-a-uuid", "", 42, null, {}, ID + "x", `${ID}'; DROP TABLE consent_records;--`]) {
      const r = parseConsentBody({ ...base, consentId: bad });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.minted).toBe(true);
        expect(r.value.consentId).not.toBe(bad);
        expect(isUuid(r.value.consentId)).toBe(true);
      }
    }
  });

  it("unknown keys are dropped and counted, not stored", () => {
    const r = parseConsentBody({ ...base, ip: "1.2.3.4", email: "a@b.co", userAgent: "x", nested: { a: 1 } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.droppedKeys).toBe(4);
      expect(Object.keys(r.value).sort()).toEqual(["action", "analytics", "consentId", "droppedKeys", "marketing", "minted", "version"]);
    }
    expect(CONSENT_ALLOWED_KEYS).toEqual(["consentId", "analytics", "marketing", "version", "action"]);
  });

  it("a withdraw stores both categories off whatever the body said", () => {
    const r = parseConsentBody({ analytics: true, marketing: true, version: "3", action: "withdraw", consentId: ID });
    expect(r.ok && [r.value.analytics, r.value.marketing]).toEqual([false, false]);
  });

  it("refuses wrong types (consent is never coerced), a bad version and a bad action", () => {
    for (const body of [
      { ...base, analytics: "true" },
      { ...base, marketing: 1 },
      { marketing: false, version: "3" },
      { ...base, version: "" },
      { ...base, version: "x".repeat(33) },
      { ...base, version: 3 },
      { ...base, version: "a\nb" },
      { ...base, action: "delete" },
      { ...base, action: null },
    ]) {
      expect(parseConsentBody(body).ok, JSON.stringify(body)).toBe(false);
    }
    for (const notObject of [null, undefined, "x", 5, [], [base]]) expect(parseConsentBody(notObject).ok).toBe(false);
  });
});

describe("classifyUserAgent (a coarse bucket; the header itself is never stored)", () => {
  it.each([
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/118 Safari/537.36", "desktop"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148", "mobile"],
    ["Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/118 Mobile Safari/537.36", "mobile"],
    ["Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15", "tablet"],
    ["Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Chrome/118 Safari/537.36", "tablet"],
    ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "bot"],
    ["Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X) Mobile (compatible; Googlebot/2.1)", "bot"],
    ["curl/8.4.0", "bot"],
    ["", "unknown"],
    ["   ", "unknown"],
    [undefined, "unknown"],
    [["array"], "unknown"],
  ])("%s -> %s", (ua, expected) => {
    expect(classifyUserAgent(ua)).toBe(expected);
  });
});

describe("consent retention config: an empty env must NOT become 0", () => {
  const env = (v: string | undefined) => ({ WEBDESK_CONSENT_RETENTION_MONTHS: v }) as NodeJS.ProcessEnv;

  it("unset, empty or whitespace is the default of 26 months (data lifetime 14 + 12)", () => {
    expect(RETENTION_MONTHS.default).toBe(26);
    expect(resolveConsentRetentionMonths(env(undefined))).toBe(26);
    expect(resolveConsentRetentionMonths(env(""))).toBe(26);
    expect(resolveConsentRetentionMonths(env("   "))).toBe(26);
  });

  it("a value inside the range is taken, boundaries included", () => {
    expect(resolveConsentRetentionMonths(env("1"))).toBe(1);
    expect(resolveConsentRetentionMonths(env(" 36 "))).toBe(36);
    expect(resolveConsentRetentionMonths(env("120"))).toBe(120);
  });

  it("0, negative, fractional, text and over-range values are refused loudly, naming the variable", () => {
    for (const bad of ["0", "-1", "1.5", "abc", "12 months", "121", "0x10"]) {
      expect(() => resolveConsentRetentionMonths(env(bad)), bad).toThrow(ConsentConfigError);
      expect(() => resolveConsentRetentionMonths(env(bad)), bad).toThrow(/WEBDESK_CONSENT_RETENTION_MONTHS/);
    }
  });
});

describe("visitor_consent.consentId on a submission (M5-G6)", () => {
  const consent = { analytics: true, marketing: false, version: "3", decided_at: "2026-10-11T09:00:00Z" };

  it("a uuid consentId is kept, lower-cased", () => {
    const r = sanitizeVisitorConsent({ ...consent, consentId: ID.toUpperCase() });
    expect(r.malformed).toBe(false);
    expect(r.value?.consentId).toBe(ID);
  });

  it("absent, or not a uuid, drops THAT key only: the snapshot stays valid", () => {
    expect(sanitizeVisitorConsent(consent).value).toEqual({ ...consent, decided_at: "2026-10-11T09:00:00.000Z" });
    for (const bad of ["nope", 7, null, "", ID + "0"]) {
      const r = sanitizeVisitorConsent({ ...consent, consentId: bad });
      expect(r.malformed).toBe(false);
      expect(r.value && "consentId" in r.value).toBe(false);
      expect(r.value?.analytics).toBe(true);
    }
  });

  it("other unknown keys inside visitor_consent are still not carried", () => {
    const r = sanitizeVisitorConsent({ ...consent, consentId: ID, ip: "1.2.3.4" });
    expect(Object.keys(r.value!).sort()).toEqual(["analytics", "consentId", "decided_at", "marketing", "version"]);
  });
});

describe("privacy identifier: a uuid is also a consent id", () => {
  it("a uuid resolves a consentId (lower-cased); every other identifier has no consentId key at all", () => {
    expect(resolveSubject(`  ${ID.toUpperCase()} `).consentId).toBe(ID);
    expect(resolveSubject(ID).phoneRef).toBeNull();
    for (const other of ["jane@example.com", "+62 812-3456-7890", "Budi", ID + "x"]) {
      expect("consentId" in resolveSubject(other), other).toBe(false);
    }
  });
});
