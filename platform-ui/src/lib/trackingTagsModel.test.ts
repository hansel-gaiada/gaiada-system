import { describe, it, expect } from "vitest";
import {
  PARTNER_ID_RE, TAGS_HELP, TrackingTagsShapeError, checkPartnerId, parsePutResponse, parseTrackingTags, savedSentence,
  trackingReadSentence, trackingRefusalSentence,
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

describe("parseTrackingTags", () => {
  it("reads each state", () => {
    expect(parseTrackingTags({ linkedin: { partnerId: "42" }, target, canManage: true, state: "ok" })).toEqual({ linkedin: { partnerId: "42" }, target, canManage: true, state: "ok", reason: null });
    expect(parseTrackingTags({ linkedin: { partnerId: null }, target: null, canManage: false, state: "no_build_target", reason: "no repo" }).target).toBeNull();
    expect(parseTrackingTags({ linkedin: { partnerId: null }, target, canManage: true, state: "github_unavailable", reason: "GitHub is down" }).reason).toBe("GitHub is down");
  });
  it("is strict: off-contract is a defect, never read as 'not set'", () => {
    for (const bad of [
      null, "x", {},
      { linkedin: { partnerId: 5 }, target, canManage: true, state: "ok" },
      { linkedin: { partnerId: null }, target, canManage: "yes", state: "ok" },
      { linkedin: { partnerId: null }, target, canManage: true, state: "weird" },
      { linkedin: { partnerId: null }, target, canManage: true, state: "github_unavailable" },
      { linkedin: { partnerId: null }, target: { repo: 1 }, canManage: true, state: "ok" },
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
