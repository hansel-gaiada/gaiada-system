import { describe, it, expect } from "vitest";
import {
  ADS_HELP, PARTNER_ID_RE, TAGS_HELP, TrackingTagsShapeError, adsSavedSentence, checkGoogleAds, checkPartnerId, parseAdsPutResponse, parseFoundSite, siteLookupSentence,
  parsePutResponse, parseTrackingTags, savedSentence, splitAdsIds, trackingReadSentence, trackingRefusalSentence,
} from "./trackingTagsModel";

// M5-P4 (WSK-D92): the Tracking tags contract, strictly parsed, and every refusal as a sentence.

const target = { repo: "gaiadabali/gaiada-web-revamp", variable: "PUBLIC_LINKEDIN_PARTNER_ID" };

describe("checkPartnerId", () => {
  it("accepts digits (trimmed), 1 to 15 of them", () => {
    expect(checkPartnerId(" 1234567 ")).toEqual({ ok: true, value: "1234567" });
    expect(checkPartnerId("1".repeat(15))).toEqual({ ok: true, value: "1".repeat(15) });
  });
  it("refuses anything else with a plain message (never a code)", () => {
    for (const bad of ["12a", "1".repeat(16), "-5", "1.5", "１２３", "1 2"]) {
      const r = checkPartnerId(bad);
      expect(r.ok, bad).toBe(false);
      expect((r as { message: string }).message).toMatch(/digits only/);
    }
    expect((checkPartnerId("   ") as { message: string }).message).toMatch(/Clear/);
  });
  it("is the same rule as the server's and the site's", () => {
    expect(PARTNER_ID_RE.source).toBe("^[0-9]{1,15}$");
  });
});

const NO_ADS = { ids: [], conversions: {} };

describe("parseTrackingTags", () => {
  it("reads each state", () => {
    expect(parseTrackingTags({ linkedin: { partnerId: "42" }, googleAds: NO_ADS, target, canManage: true, state: "ok" })).toEqual({ linkedin: { partnerId: "42" }, googleAds: NO_ADS, target, canManage: true, state: "ok", reason: null });
    expect(parseTrackingTags({ linkedin: { partnerId: null }, googleAds: NO_ADS, target: null, canManage: false, state: "no_build_target", reason: "no repo" }).target).toBeNull();
    expect(parseTrackingTags({ linkedin: { partnerId: null }, googleAds: NO_ADS, target, canManage: true, state: "github_unavailable", reason: "GitHub is down" }).reason).toBe("GitHub is down");
  });
  it("reads the Google Ads ids and conversions", () => {
    const googleAds = { ids: ["AW-123456789", "AW-987654321"], conversions: { lead: "AW-123456789/abc", email: "AW-987654321/e_1" } };
    expect(parseTrackingTags({ linkedin: { partnerId: null }, googleAds, target, canManage: true, state: "ok" }).googleAds).toEqual(googleAds);
  });
  it("is strict: off-contract is a defect, never read as 'not set'", () => {
    const base = { linkedin: { partnerId: null }, googleAds: NO_ADS, target, canManage: true, state: "ok" };
    for (const bad of [
      null, "x", {},
      { ...base, linkedin: { partnerId: 5 } },
      { ...base, canManage: "yes" },
      { ...base, state: "weird" },
      { ...base, state: "github_unavailable" },
      { ...base, target: { repo: 1 } },
      { ...base, googleAds: undefined },
      { ...base, googleAds: { ids: "AW-123456789", conversions: {} } },
      { ...base, googleAds: { ids: ["bad"], conversions: {} } },
      { ...base, googleAds: { ids: [], conversions: null } },
      { ...base, googleAds: { ids: [], conversions: { fax: "AW-123456789/a" } } },
      { ...base, googleAds: { ids: [], conversions: { lead: "nope" } } },
    ]) expect(() => parseTrackingTags(bad), JSON.stringify(bad)).toThrow(TrackingTagsShapeError);
  });
});

describe("parsePutResponse", () => {
  it("reads set, cleared and unchanged", () => {
    expect(parsePutResponse({ linkedin: { partnerId: "9" }, target, result: "set", takesEffect: "next_rebuild" })).toEqual({ partnerId: "9", result: "set", repo: target.repo });
    expect(parsePutResponse({ linkedin: { partnerId: null }, target, result: "cleared", takesEffect: "next_rebuild" }).result).toBe("cleared");
  });
  it("refuses an unknown result or a missing target", () => {
    expect(() => parsePutResponse({ linkedin: { partnerId: "9" }, target, result: "ok" })).toThrow(TrackingTagsShapeError);
    expect(() => parsePutResponse({ linkedin: { partnerId: "9" }, target: null, result: "set" })).toThrow(TrackingTagsShapeError);
  });
});

describe("sentences", () => {
  it("a save says when it reaches the site and never 'done'", () => {
    expect(savedSentence("set", "42", target.repo)).toMatch(/next rebuild/);
    expect(savedSentence("cleared", null, target.repo)).toMatch(/next rebuild/);
    expect(savedSentence("unchanged", "42", target.repo)).toMatch(/Nothing changed/);
    for (const r of ["set", "cleared", "unchanged"] as const) expect(savedSentence(r, "42", target.repo)).not.toMatch(/\bdone\b/i);
  });

  it("every reason token the server can send has its own sentence, never the token", () => {
    const tokens = [
      "partner_id_invalid", "tracking_body_invalid", "tracking_query_invalid", "tracking_site_mismatch", "property_not_found", "no_build_target",
      "github_org_unavailable", "github_not_configured", "github_app_not_installed", "github_permission_missing", "github_rate_limited", "github_request_failed",
    ];
    const seen = new Set<string>();
    for (const t of tokens) {
      const s = trackingRefusalSentence(409, t);
      expect(s.length, t).toBeGreaterThan(20);
      expect(s, t).not.toContain(t);
      expect(s, t).toMatch(/Nothing was saved|reload/i);
      seen.add(s);
    }
    expect(seen.size).toBeGreaterThanOrEqual(10);
  });

  it("the missing App permission names it, so the owner knows what to grant", () => {
    expect(trackingRefusalSentence(503, "github_permission_missing")).toContain("actions_variables");
  });

  it("statuses without a token still get words (never an empty or silent state)", () => {
    for (const status of [0, 400, 401, 403, 404, 409, 500, 503]) expect(trackingRefusalSentence(status, null).length).toBeGreaterThan(20);
    expect(trackingRefusalSentence(403, null)).toMatch(/not allowed/);
  });

  it("a failed read drops the 'Nothing was saved' tail", () => {
    const s = trackingReadSentence(503, "github_app_not_installed");
    expect(s).toMatch(/^The tracking tags could not be read:/);
    expect(s).not.toMatch(/Nothing was saved/);
    expect(trackingReadSentence(403, null)).toMatch(/do not have access/);
    expect(trackingReadSentence(500, null)).toMatch(/could not be read/);
  });

  it("the help text is the owner's wording", () => {
    expect(TAGS_HELP).toBe(
      "The LinkedIn partner id comes from LinkedIn Campaign Manager → Insight Tag. Only needed if you run LinkedIn ads. "
      + "The tag loads only after a visitor accepts marketing cookies, and only once the site's tracking is live. "
      + "A change takes effect on the next rebuild of the site.",
    );
  });
});

const draft = (over: { ids?: string; lead?: string; whatsapp?: string; phone?: string; email?: string } = {}) => ({
  ids: over.ids ?? "", conversions: { lead: over.lead ?? "", whatsapp: over.whatsapp ?? "", phone: over.phone ?? "", email: over.email ?? "" },
});

describe("Google Ads (M5-P4g)", () => {
  it("splitAdsIds takes commas, spaces and new lines", () => {
    expect(splitAdsIds(" AW-111111,AW-222222\nAW-333333  AW-444444 ,, ")).toEqual(["AW-111111", "AW-222222", "AW-333333", "AW-444444"]);
    expect(splitAdsIds("  ")).toEqual([]);
  });

  it("checkGoogleAds accepts the server's shapes and returns trimmed values", () => {
    expect(checkGoogleAds(draft({ ids: " AW-123456789,\nAW-987654321 ", lead: " AW-123456789/abc ", email: "AW-987654321/x_y-Z" }))).toEqual({
      ok: true, ids: ["AW-123456789", "AW-987654321"], conversions: { lead: "AW-123456789/abc", email: "AW-987654321/x_y-Z" },
    });
    expect(checkGoogleAds(draft())).toEqual({ ok: true, ids: [], conversions: {} });
    expect(checkGoogleAds(draft({ ids: "AW-111111,AW-222222,AW-333333,AW-444444,AW-555555" })).ok).toBe(true);
  });

  it("checkGoogleAds refuses with a plain message, mirroring the server", () => {
    const msg = (d: ReturnType<typeof draft>) => { const r = checkGoogleAds(d); return r.ok ? "ok" : r.message; };
    for (const ids of ["aw-123456789", "AW-12345", "AW-1234567890123456", "123456789", "AW-12a456"]) expect(msg(draft({ ids })), ids).toMatch(/is not a Google Ads tag id/);
    expect(msg(draft({ ids: "AW-123456789 AW-123456789" }))).toMatch(/listed twice/);
    expect(msg(draft({ ids: "AW-111111,AW-222222,AW-333333,AW-444444,AW-555555,AW-666666" }))).toMatch(/at most 5/);
    expect(msg(draft({ ids: "AW-123456789", lead: "AW-123456789" }))).toMatch(/Form lead.*is not a conversion/);
    expect(msg(draft({ ids: "AW-123456789", phone: "AW-123456789/a b" }))).toMatch(/Phone click/);
    expect(msg(draft({ ids: "AW-123456789", whatsapp: "AW-123456789/" + "a".repeat(65) }))).toMatch(/WhatsApp click/);
    expect(msg(draft({ ids: "AW-123456789", email: "AW-999999999/x" }))).toMatch(/Email click.*not one of the tag ids/);
    expect(msg(draft({ lead: "AW-123456789/x" }))).toMatch(/not one of the tag ids/); // a conversion without any id
    for (const bad of [draft({ ids: "x" }), draft({ ids: "AW-123456789", lead: "z" })]) expect(msg(bad)).toMatch(/Nothing was saved/);
  });

  it("parseAdsPutResponse is strict", () => {
    const ads = { ids: ["AW-123456789"], conversions: { lead: "AW-123456789/abc" } };
    const tg = { repo: target.repo, variables: ["PUBLIC_GOOGLE_ADS_IDS", "PUBLIC_GOOGLE_ADS_CONVERSIONS"] };
    expect(parseAdsPutResponse({ googleAds: ads, target: tg, result: "set", takesEffect: "next_rebuild" })).toEqual({ googleAds: ads, result: "set", repo: target.repo });
    expect(() => parseAdsPutResponse({ googleAds: ads, target: tg, result: "ok" })).toThrow(TrackingTagsShapeError);
    expect(() => parseAdsPutResponse({ googleAds: ads, target: null, result: "set" })).toThrow(TrackingTagsShapeError);
    expect(() => parseAdsPutResponse({ target: tg, result: "set" })).toThrow(TrackingTagsShapeError);
  });

  it("the help text and the save sentences say next rebuild and never 'done'", () => {
    expect(ADS_HELP).toBe("Takes effect on the site's next rebuild. Google Ads loads only for visitors who accept marketing cookies.");
    const ads = { ids: ["AW-123456789"], conversions: { lead: "AW-123456789/abc" } };
    expect(adsSavedSentence("set", ads, target.repo)).toMatch(/1 tag id, 1 conversion.*next rebuild/);
    expect(adsSavedSentence("cleared", { ids: [], conversions: {} }, target.repo)).toMatch(/removed.*next rebuild/);
    expect(adsSavedSentence("unchanged", ads, target.repo)).toMatch(/Nothing changed/);
    for (const r of ["set", "cleared", "unchanged"] as const) expect(adsSavedSentence(r, ads, target.repo)).not.toMatch(/\bdone\b/i);
  });

  it("each Google Ads refusal token is a sentence that says nothing was saved", () => {
    for (const reason of ["ads_body_invalid", "ads_id_invalid", "ads_conversion_invalid"]) {
      expect(trackingRefusalSentence(400, reason)).toMatch(/Google Ads.*Nothing was saved/);
    }
  });
});

describe("parseFoundSite and siteLookupSentence (M5-P4g)", () => {
  it("reads a site or null and refuses anything else", () => {
    expect(parseFoundSite({ site: null })).toEqual({ site: null });
    expect(parseFoundSite({ site: { webdeskTenant: "g", site: "s", name: "n", extra: 1 } })).toEqual({ site: { webdeskTenant: "g", site: "s", name: "n" } });
    for (const bad of [null, {}, "x", { site: 5 }, { site: { webdeskTenant: "g", site: "s" } }, { site: { webdeskTenant: "", site: "s", name: "n" } }]) {
      expect(() => parseFoundSite(bad), JSON.stringify(bad)).toThrow(TrackingTagsShapeError);
    }
  });
  it("every failure is a sentence", () => {
    expect(siteLookupSentence(403, null)).toMatch(/do not have access/);
    expect(siteLookupSentence(503, "tracking_sites_unavailable")).toMatch(/could not list/);
    expect(siteLookupSentence(404, "property_not_found")).toMatch(/not found/);
    expect(siteLookupSentence(0, null)).toMatch(/could not be looked up/);
  });
});
