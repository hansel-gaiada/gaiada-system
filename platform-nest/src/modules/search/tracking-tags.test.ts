// M5-P4 (WSK-D92) — the tracking-tags service against the in-memory GitHub and fake seams (no database, no Cerbos, no network).
// The HTTP layer (403 before the body, the wire shape) is tracking-tags.db.test.ts, which needs the Linux gate.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BadGatewayException, ForbiddenException } from "@nestjs/common";
import { FakeGithub } from "../../core/github/git-data.testkit";
import { GithubApiError } from "../../core/github/errors";
import { GOOGLE_ADS_CONVERSIONS_VARIABLE, GOOGLE_ADS_IDS_VARIABLE, LINKEDIN_PARTNER_ID_VARIABLE } from "../../core/github/repo-variables";
import type { Principal } from "../../rbac/principal";
import {
  TRACKING_WORDS, TrackingTagsError, environmentDomains, formatAdsConversions, formatAdsIds, hostOf, parseAdsConversionsValue, parseAdsIdsValue,
  parseAdsPutBody, parsePutBody, parseSiteQuery, partnerIdOfValue, propertyMatchesSite,
  findTrackingSite, putGoogleAds, putLinkedinPartnerId, readTrackingTags, setTrackingTagsDeps, type CompanySite,
} from "./tracking-tags.service";
import { asHttp } from "./tracking-tags.controller";

const TENANT = "dddddddd-7050-0000-0000-000000000001";
const ORG = "dddddddd-7050-0000-0000-0000000000a0";
const PROP = "dddddddd-7050-0000-0000-0000000000b1";
const SITE = "dddddddd-7050-0000-0000-0000000000c1";
const SLUG = "gaiada";
const VAR = LINKEDIN_PARTNER_ID_VARIABLE;
const IDS = GOOGLE_ADS_IDS_VARIABLE;
const CONV = GOOGLE_ADS_CONVERSIONS_VARIABLE;
const NO_ADS = { ids: [], conversions: {} };
const principal = { userId: "u-1" } as unknown as Principal;
const q = { webdeskTenant: SLUG, site: SITE };
const body = (over: Record<string, unknown> = {}) => ({ webdeskTenant: SLUG, site: SITE, partnerId: "123456", ...over });
const adsBody = (over: Record<string, unknown> = {}) => ({ webdeskTenant: SLUG, site: SITE, ids: ["AW-123456789"], conversions: {}, ...over });

interface Audit { verb: string; propertyId: string; meta: Record<string, unknown>; actor: string | null }

describe("pure rules", () => {
  it("hostOf and propertyMatchesSite follow the Analytics page rule (www and scheme and path ignored)", () => {
    expect(hostOf(" HTTPS://www.Gaiada.com/en ")).toBe("gaiada.com");
    expect(propertyMatchesSite("gaiada.com", ["stg.gaiada.com", "https://www.gaiada.com"])).toBe(true);
    expect(propertyMatchesSite("gaiada.com", ["stg.gaiada.com"])).toBe(false);
    expect(propertyMatchesSite("", [""])).toBe(false);
    expect(environmentDomains([{ domain: "a.test" }, { domain: " " }, { name: "x" }, null, "str"])).toEqual(["a.test"]);
  });

  it("the partner id is digits only, 1 to 15, after trimming; null clears; anything else is typed 400", () => {
    expect(parsePutBody(body({ partnerId: " 98765 " })).partnerId).toBe("98765");
    expect(parsePutBody(body({ partnerId: null })).partnerId).toBeNull();
    expect(parsePutBody(body({ partnerId: "1".repeat(15) })).partnerId).toBe("1".repeat(15));
    for (const bad of ["", "   ", "12a", "1".repeat(16), "-1", "1.5", "１２３", 123456, undefined, {}, ["1"]]) {
      expect(() => parsePutBody(body({ partnerId: bad })), String(bad)).toThrowError(expect.objectContaining({ reason: "partner_id_invalid" }));
    }
  });

  it("the body is EXACTLY {webdeskTenant, site, partnerId}: extras, omissions and non-objects are tracking_body_invalid", () => {
    for (const bad of [null, "x", [], {}, { webdeskTenant: SLUG, site: SITE }, { ...body(), name: "SOMETHING_ELSE" }, { ...body(), variable: "X" }]) {
      expect(() => parsePutBody(bad)).toThrowError(expect.objectContaining({ reason: "tracking_body_invalid" }));
    }
    expect(() => parsePutBody(body({ site: "not-a-uuid" }))).toThrowError(expect.objectContaining({ reason: "tracking_query_invalid" }));
    expect(() => parsePutBody(body({ webdeskTenant: "Bad Slug!" }))).toThrowError(expect.objectContaining({ reason: "tracking_query_invalid" }));
    expect(() => parseSiteQuery({ webdeskTenant: SLUG })).toThrowError(expect.objectContaining({ reason: "tracking_query_invalid" }));
  });

  it("partnerIdOfValue reads a stored value the way the site does: digits or no id", () => {
    expect(partnerIdOfValue(" 42 ")).toBe("42");
    expect(partnerIdOfValue("abc")).toBeNull();
    expect(partnerIdOfValue(null)).toBeNull();
  });

  it("ads ids are read like the site: split on comma, trim, keep valid, first wins, first 5", () => {
    expect(parseAdsIdsValue(null)).toEqual([]);
    expect(parseAdsIdsValue("")).toEqual([]);
    expect(parseAdsIdsValue(" AW-123456 , aw-999999, AW-12345, AW-123456,AW-1234567890123456, AW-777777 ,,junk")).toEqual(["AW-123456", "AW-777777"]);
    expect(parseAdsIdsValue("AW-111111,AW-222222,AW-333333,AW-444444,AW-555555,AW-666666,AW-777777")).toEqual(
      ["AW-111111", "AW-222222", "AW-333333", "AW-444444", "AW-555555"]);
    expect(parseAdsIdsValue("AW-123456\nAW-654321")).toEqual([]);
  });

  it("ads conversions are read like the site: first '=', known key, valid value, AW id among the ids, first kept key wins", () => {
    const ids = ["AW-111111", "AW-222222"];
    expect(parseAdsConversionsValue(null, ids)).toEqual({});
    expect(parseAdsConversionsValue(" lead = AW-111111/abc , whatsapp=AW-222222/x_y-Z,phone=AW-333333/nope,fax=AW-111111/a,email=AW-111111/", ids))
      .toEqual({ lead: "AW-111111/abc", whatsapp: "AW-222222/x_y-Z" });
    expect(parseAdsConversionsValue("lead=AW-111111/first,lead=AW-111111/second", ids)).toEqual({ lead: "AW-111111/first" });
    expect(parseAdsConversionsValue("lead=bad,lead=AW-111111/ok", ids)).toEqual({ lead: "AW-111111/ok" });
    expect(parseAdsConversionsValue("lead", ids)).toEqual({});
    expect(parseAdsConversionsValue("lead=AW-111111/a=b", ids)).toEqual({});
    expect(parseAdsConversionsValue("lead=AW-111111/abc", [])).toEqual({});
    expect(parseAdsConversionsValue("lead=AW-111111/" + "a".repeat(65), ids)).toEqual({});
  });

  it("ads formatters write the canonical form: ids joined by comma, conversions in the order lead, whatsapp, phone, email; empty is null", () => {
    expect(formatAdsIds([])).toBeNull();
    expect(formatAdsIds(["AW-111111", "AW-222222"])).toBe("AW-111111,AW-222222");
    expect(formatAdsConversions({})).toBeNull();
    expect(formatAdsConversions({ email: "AW-111111/e", lead: "AW-111111/l", phone: "AW-111111/p", whatsapp: "AW-111111/w" }))
      .toBe("lead=AW-111111/l,whatsapp=AW-111111/w,phone=AW-111111/p,email=AW-111111/e");
    expect(formatAdsConversions({ phone: "AW-111111/p" })).toBe("phone=AW-111111/p");
  });

  it("the ads PUT body: trims, accepts null/[] ids and null/'' conversions, and refuses by the three reasons", () => {
    expect(parseAdsPutBody(adsBody({ ids: [" AW-123456789 ", "AW-987654321"], conversions: { lead: " AW-123456789/abc ", phone: "", email: null } }))).toEqual({
      webdeskTenant: SLUG, site: SITE, ids: ["AW-123456789", "AW-987654321"], conversions: { lead: "AW-123456789/abc" },
    });
    expect(parseAdsPutBody(adsBody({ ids: null })).ids).toEqual([]);
    expect(parseAdsPutBody(adsBody({ ids: [] })).ids).toEqual([]);
    const reason = (over: Record<string, unknown>) => { try { parseAdsPutBody(adsBody(over)); return "ok"; } catch (e) { return (e as TrackingTagsError).reason; } };
    // wrong shape or unknown key
    for (const bad of [null, "x", [], {}, { webdeskTenant: SLUG, site: SITE, ids: [] }, { ...adsBody(), partnerId: "1" }, { ...adsBody(), variable: "X" }]) {
      expect(() => parseAdsPutBody(bad)).toThrowError(expect.objectContaining({ reason: "ads_body_invalid" }));
    }
    expect(reason({ ids: "AW-123456789" })).toBe("ads_body_invalid");
    expect(reason({ ids: undefined })).toBe("ads_body_invalid");
    expect(reason({ conversions: null })).toBe("ads_body_invalid");
    expect(reason({ conversions: [] })).toBe("ads_body_invalid");
    expect(reason({ conversions: { fax: "AW-123456789/a" } })).toBe("ads_body_invalid");
    expect(reason({ conversions: { lead: 5 } })).toBe("ads_body_invalid");
    // ids
    for (const bad of [["aw-123456789"], ["AW-12345"], ["AW-1234567890123456"], ["AW-12a456"], ["123456789"], [""], ["AW-123456789", "AW-123456789"], [5], [null], ["AW-123456789,AW-987654321"],
      ["AW-111111", "AW-222222", "AW-333333", "AW-444444", "AW-555555", "AW-666666"]]) {
      expect(reason({ ids: bad }), JSON.stringify(bad)).toBe("ads_id_invalid");
    }
    expect(reason({ ids: ["AW-111111", "AW-222222", "AW-333333", "AW-444444", "AW-555555"] })).toBe("ok");
    // conversions
    for (const bad of ["AW-123456789", "AW-123456789/", "123456789/abc", "AW-123456789/a b", "AW-123456789/" + "a".repeat(65), "AW-111111/abc", "lead=AW-123456789/abc"]) {
      expect(reason({ conversions: { lead: bad } }), bad).toBe("ads_conversion_invalid");
    }
    expect(reason({ ids: [], conversions: { lead: "AW-123456789/abc" } })).toBe("ads_conversion_invalid");
    expect(reason({ ids: null, conversions: { email: "AW-123456789/abc" } })).toBe("ads_conversion_invalid");
    expect(reason({ ids: [], conversions: { lead: null, phone: "  " } })).toBe("ok");
    expect(() => parseAdsPutBody(adsBody({ site: "nope" }))).toThrowError(expect.objectContaining({ reason: "tracking_query_invalid" }));
  });

  it("the ads refusals are 400 with plain words", () => {
    for (const r of ["ads_body_invalid", "ads_id_invalid", "ads_conversion_invalid"] as const) {
      const e = asHttp(new TrackingTagsError(r, TRACKING_WORDS[r])) as { getStatus(): number; getResponse(): Record<string, unknown> };
      expect(e.getStatus()).toBe(400);
      expect(e.getResponse()).toMatchObject({ reason: r, message: TRACKING_WORDS[r] });
      expect(TRACKING_WORDS[r].length).toBeGreaterThan(20);
    }
  });

  it("refusals map to the documented statuses and carry reason + words", () => {
    const e = asHttp(new TrackingTagsError("tracking_site_mismatch", TRACKING_WORDS.tracking_site_mismatch)) as { getStatus(): number; getResponse(): Record<string, unknown> };
    expect(e.getStatus()).toBe(409);
    expect(e.getResponse()).toMatchObject({ reason: "tracking_site_mismatch", message: TRACKING_WORDS.tracking_site_mismatch });
    const p = asHttp(new TrackingTagsError("github_permission_missing", TRACKING_WORDS.github_permission_missing, "actions_variables")) as { getStatus(): number; getResponse(): Record<string, unknown> };
    expect(p.getStatus()).toBe(503);
    expect(p.getResponse()).toMatchObject({ detail: { permission: "actions_variables" } });
    const other = new Error("boom");
    expect(asHttp(other)).toBe(other);
  });
});

describe("tracking tags service (fake GitHub + fake seams)", () => {
  let gh: FakeGithub;
  let audits: Audit[];
  let manage: boolean;
  let pushDenied: boolean;
  let siteDomains: string[] | null;
  let propertyDomain: string;
  let property: { id: string; domain: string } | null;
  let target: { ok: true; repo: string } | { ok: false; detail: string };
  let org: { ok: true; tenantId: string } | { ok: false; reason: "unconfigured" | "not_in_root" };
  let orgSeen: string[];

  beforeEach(() => {
    gh = new FakeGithub("gaiadabali", "gaiada-web-revamp");
    audits = [];
    manage = true;
    pushDenied = false;
    siteDomains = ["cms-proof.gaiada.com", "www.gaiada.com"];
    propertyDomain = "gaiada.com";
    property = { id: PROP, domain: propertyDomain };
    target = { ok: true, repo: "gaiadabali/gaiada-web-revamp" };
    org = { ok: true, tenantId: ORG };
    orgSeen = [];
    setTrackingTagsDeps({
      loadProperty: async () => property,
      siteDomains: async () => siteDomains,
      stagingRepo: async () => target,
      resolveOrg: async () => org,
      git: (orgTenantId) => {
        orgSeen.push(orgTenantId);
        return gh.caller();
      },
      canManage: async () => manage,
      authorizePush: async (_p, orgTenantId) => {
        orgSeen.push(`push@${orgTenantId}`);
        if (pushDenied) throw new ForbiddenException("not authorized: github_repo push");
      },
      audit: async (_t, actor, verb, propertyId, meta) => {
        audits.push({ verb, propertyId, meta, actor });
      },
    });
  });
  afterEach(() => setTrackingTagsDeps(null));

  describe("GET", () => {
    it("unset: partnerId null, the repo and variable named, state ok, and the repo was confirmed visible", async () => {
      const v = await readTrackingTags(principal, TENANT, PROP, q);
      expect(v).toEqual({ linkedin: { partnerId: null }, googleAds: NO_ADS, target: { repo: "gaiadabali/gaiada-web-revamp", variable: VAR }, canManage: true, state: "ok" });
      expect(gh.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        `GET /repos/gaiadabali/gaiada-web-revamp/actions/variables/${VAR}`,
        `GET /repos/gaiadabali/gaiada-web-revamp/actions/variables/${IDS}`,
        `GET /repos/gaiadabali/gaiada-web-revamp/actions/variables/${CONV}`,
        "GET /repos/gaiadabali/gaiada-web-revamp",
      ]);
    });

    it("set: the stored id; canManage mirrors the Cerbos probe; reads write nothing and audit nothing", async () => {
      gh.variables.set(VAR, { value: "778899", updatedAt: "x" });
      manage = false;
      const v = await readTrackingTags(principal, TENANT, PROP, q);
      expect(v).toMatchObject({ linkedin: { partnerId: "778899" }, canManage: false, state: "ok" });
      expect(gh.calls.every((c) => c.method === "GET")).toBe(true);
      expect(audits).toEqual([]);
    });

    it("all three variables set: the card reads what the site would use (invalid and unmatched entries dropped)", async () => {
      gh.variables.set(VAR, { value: "778899", updatedAt: "x" });
      gh.variables.set(IDS, { value: "AW-123456789, AW-123456789,bad,AW-987654321", updatedAt: "x" });
      gh.variables.set(CONV, { value: "lead=AW-123456789/abc,whatsapp=AW-555555555/zzz,phone=AW-987654321/p_1,fax=AW-123456789/q", updatedAt: "x" });
      const v = await readTrackingTags(principal, TENANT, PROP, q);
      expect(v).toMatchObject({
        linkedin: { partnerId: "778899" }, state: "ok",
        googleAds: { ids: ["AW-123456789", "AW-987654321"], conversions: { lead: "AW-123456789/abc", phone: "AW-987654321/p_1" } },
      });
      // all three set: no null read, so the repo is never probed
      expect(gh.calls.map((c) => c.path)).not.toContain("/repos/gaiadabali/gaiada-web-revamp");
    });

    it("the repo is confirmed visible at most once, however many variables are unset", async () => {
      gh.variables.set(IDS, { value: "AW-123456789", updatedAt: "x" });
      const v = await readTrackingTags(principal, TENANT, PROP, q);
      expect(v.googleAds).toEqual({ ids: ["AW-123456789"], conversions: {} });
      expect(gh.calls.filter((c) => c.path === "/repos/gaiadabali/gaiada-web-revamp")).toHaveLength(1);
    });

    it("conversions with no ids read as none (the site would drop them)", async () => {
      gh.variables.set(CONV, { value: "lead=AW-123456789/abc", updatedAt: "x" });
      expect((await readTrackingTags(principal, TENANT, PROP, q)).googleAds).toEqual(NO_ADS);
    });

    it("a stored value that is not digits reads as no id (the site would ignore it too)", async () => {
      gh.variables.set(VAR, { value: "oops", updatedAt: "x" });
      expect((await readTrackingTags(principal, TENANT, PROP, q)).linkedin.partnerId).toBeNull();
    });

    it("no build target: state no_build_target in words, no target, canManage false, and GitHub is never called", async () => {
      target = { ok: false, detail: "no provisioned site" };
      const v = await readTrackingTags(principal, TENANT, PROP, q);
      expect(v).toMatchObject({ target: null, canManage: false, state: "no_build_target", googleAds: NO_ADS, reason: TRACKING_WORDS.no_build_target });
      expect(gh.calls).toHaveLength(0);
    });

    it("the App missing the variables permission is state github_unavailable in words (the page still draws), never 'Not set'", async () => {
      gh.variablesPermission = false;
      const v = await readTrackingTags(principal, TENANT, PROP, q);
      expect(v).toMatchObject({ state: "github_unavailable", linkedin: { partnerId: null }, googleAds: NO_ADS, target: { repo: "gaiadabali/gaiada-web-revamp" } });
      expect(v.reason).toContain("actions_variables");
    });

    it("a repository the App cannot see is github_unavailable (App not installed), not an empty value", async () => {
      target = { ok: true, repo: "gaiadabali/unseen-repo" };
      const v = await readTrackingTags(principal, TENANT, PROP, q);
      expect(v.state).toBe("github_unavailable");
      expect(v.googleAds).toEqual(NO_ADS);
      expect(v.reason).toBe(TRACKING_WORDS.github_app_not_installed);
    });

    it("an unresolvable GitHub org is github_unavailable", async () => {
      org = { ok: false, reason: "unconfigured" };
      expect((await readTrackingTags(principal, TENANT, PROP, q)).reason).toBe(TRACKING_WORDS.github_org_unavailable);
    });

    it("the call runs under the ORG tenant the resolver names, not the URL tenant", async () => {
      await readTrackingTags(principal, TENANT, PROP, q);
      expect(orgSeen).toEqual([ORG]);
    });

    it("binding: a property whose domain is not the site's is 409 tracking_site_mismatch and GitHub is never called", async () => {
      property = { id: PROP, domain: "other.example" };
      await expect(readTrackingTags(principal, TENANT, PROP, q)).rejects.toMatchObject({ reason: "tracking_site_mismatch", status: 409 });
      siteDomains = null; // a (tenant, site) pair that is not this company's
      property = { id: PROP, domain: "gaiada.com" };
      await expect(readTrackingTags(principal, TENANT, PROP, q)).rejects.toMatchObject({ reason: "tracking_site_mismatch" });
      expect(gh.calls).toHaveLength(0);
    });

    it("an unknown property is 404 property_not_found", async () => {
      property = null;
      await expect(readTrackingTags(principal, TENANT, PROP, q)).rejects.toMatchObject({ reason: "property_not_found", status: 404 });
    });
  });

  describe("PUT", () => {
    it("sets the id: creates the variable, audits one row (who, property, repo, variable, from -> to), takes effect on the next rebuild", async () => {
      const r = await putLinkedinPartnerId(principal, TENANT, PROP, body());
      expect(r).toEqual({ linkedin: { partnerId: "123456" }, target: { repo: "gaiadabali/gaiada-web-revamp", variable: VAR }, result: "set", takesEffect: "next_rebuild" });
      expect(gh.variables.get(VAR)?.value).toBe("123456");
      expect(audits).toEqual([{
        verb: "tracking_tag_set", propertyId: PROP, actor: "u-1",
        meta: { repo: "gaiadabali/gaiada-web-revamp", variable: VAR, from: null, to: "123456", webdeskTenant: SLUG, site: SITE },
      }]);
      expect(orgSeen).toContain(`push@${ORG}`);
    });

    it("the same value twice is 'unchanged': no write, no audit row", async () => {
      await putLinkedinPartnerId(principal, TENANT, PROP, body());
      gh.calls.length = 0;
      audits.length = 0;
      const r = await putLinkedinPartnerId(principal, TENANT, PROP, body({ partnerId: " 123456 " }));
      expect(r.result).toBe("unchanged");
      expect(gh.calls.filter((c) => c.method !== "GET")).toEqual([]);
      expect(audits).toEqual([]);
    });

    it("a different value updates the variable and records old -> new", async () => {
      gh.variables.set(VAR, { value: "111", updatedAt: "x" });
      const r = await putLinkedinPartnerId(principal, TENANT, PROP, body({ partnerId: "222" }));
      expect(r.result).toBe("set");
      expect(gh.variables.get(VAR)?.value).toBe("222");
      expect(audits).toHaveLength(1);
      expect(audits[0]!.meta).toMatchObject({ from: "111", to: "222" });
    });

    it("null clears (DELETE) and audits; clearing what is not set is 'unchanged' with no write", async () => {
      gh.variables.set(VAR, { value: "111", updatedAt: "x" });
      const r = await putLinkedinPartnerId(principal, TENANT, PROP, body({ partnerId: null }));
      expect(r).toMatchObject({ result: "cleared", linkedin: { partnerId: null } });
      expect(gh.variables.has(VAR)).toBe(false);
      expect(audits).toEqual([expect.objectContaining({ verb: "tracking_tag_cleared", meta: expect.objectContaining({ from: "111", to: null }) })]);
      gh.calls.length = 0;
      audits.length = 0;
      expect((await putLinkedinPartnerId(principal, TENANT, PROP, body({ partnerId: null }))).result).toBe("unchanged");
      expect(gh.calls.filter((c) => c.method !== "GET")).toEqual([]);
      expect(audits).toEqual([]);
    });

    it("only the one allow-listed variable is ever touched", async () => {
      await putLinkedinPartnerId(principal, TENANT, PROP, body());
      await putLinkedinPartnerId(principal, TENANT, PROP, body({ partnerId: null }));
      const paths = gh.calls.filter((c) => c.path.includes("/actions/")).map((c) => c.path);
      for (const p of paths) expect(p).toMatch(/\/actions\/variables(\/PUBLIC_LINKEDIN_PARTNER_ID)?$/);
      expect([...gh.variables.keys()]).toEqual([]);
    });

    it("binding: a mismatched site is 409 tracking_site_mismatch and nothing is read or written", async () => {
      property = { id: PROP, domain: "not-this-site.example" };
      await expect(putLinkedinPartnerId(principal, TENANT, PROP, body())).rejects.toMatchObject({ reason: "tracking_site_mismatch", status: 409 });
      expect(gh.calls).toHaveLength(0);
      expect(audits).toEqual([]);
    });

    it("no build target is 409 no_build_target", async () => {
      target = { ok: false, detail: "rebuild_not_configured" };
      await expect(putLinkedinPartnerId(principal, TENANT, PROP, body())).rejects.toMatchObject({ reason: "no_build_target", status: 409 });
      expect(gh.calls).toHaveLength(0);
    });

    it("the github_repo push check at the org tenant refuses before any GitHub call", async () => {
      pushDenied = true;
      await expect(putLinkedinPartnerId(principal, TENANT, PROP, body())).rejects.toBeInstanceOf(ForbiddenException);
      expect(gh.calls).toHaveLength(0);
      expect(audits).toEqual([]);
    });

    it("an unresolvable org is 503 github_org_unavailable", async () => {
      org = { ok: false, reason: "not_in_root" };
      await expect(putLinkedinPartnerId(principal, TENANT, PROP, body())).rejects.toMatchObject({ reason: "github_org_unavailable", status: 503 });
    });

    it("the App missing actions_variables is 503 github_permission_missing naming the permission; nothing is audited as written", async () => {
      gh.variablesPermission = false;
      await expect(putLinkedinPartnerId(principal, TENANT, PROP, body())).rejects.toMatchObject({
        reason: "github_permission_missing", status: 503, permission: "actions_variables",
      });
      expect(audits).toEqual([]);
    });

    it("a repo the App cannot see is 503 github_app_not_installed (a create would not have landed)", async () => {
      target = { ok: true, repo: "gaiadabali/unseen-repo" };
      await expect(putLinkedinPartnerId(principal, TENANT, PROP, body())).rejects.toMatchObject({ reason: "github_app_not_installed" });
      expect(audits).toEqual([]);
    });

    it("validation happens before any lookup: a bad id never reaches the property or GitHub", async () => {
      await expect(putLinkedinPartnerId(principal, TENANT, PROP, body({ partnerId: "12ab" }))).rejects.toMatchObject({ reason: "partner_id_invalid", status: 400 });
      expect(gh.calls).toHaveLength(0);
    });
  });

  describe("PUT google-ads", () => {
    const full = () => adsBody({
      ids: ["AW-123456789", "AW-987654321"],
      conversions: { email: "AW-987654321/e", lead: "AW-123456789/l", whatsapp: "AW-123456789/w" },
    });
    const writes = () => gh.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path.split("/variables")[1] || "(create)"}`);

    it("sets ids then conversions in canonical form, audits one row per variable with tag google_ads, takes effect on the next rebuild", async () => {
      const r = await putGoogleAds(principal, TENANT, PROP, full());
      expect(r).toEqual({
        googleAds: { ids: ["AW-123456789", "AW-987654321"], conversions: { email: "AW-987654321/e", lead: "AW-123456789/l", whatsapp: "AW-123456789/w" } },
        target: { repo: "gaiadabali/gaiada-web-revamp", variables: [IDS, CONV] },
        result: "set", takesEffect: "next_rebuild",
      });
      expect(gh.variables.get(IDS)?.value).toBe("AW-123456789,AW-987654321");
      expect(gh.variables.get(CONV)?.value).toBe("lead=AW-123456789/l,whatsapp=AW-123456789/w,email=AW-987654321/e");
      const meta = { tag: "google_ads", repo: "gaiadabali/gaiada-web-revamp", webdeskTenant: SLUG, site: SITE };
      expect(audits).toEqual([
        { verb: "tracking_tag_set", propertyId: PROP, actor: "u-1", meta: { ...meta, variable: IDS, from: null, to: "AW-123456789,AW-987654321" } },
        { verb: "tracking_tag_set", propertyId: PROP, actor: "u-1", meta: { ...meta, variable: CONV, from: null, to: "lead=AW-123456789/l,whatsapp=AW-123456789/w,email=AW-987654321/e" } },
      ]);
      // ids are created before conversions; the LinkedIn variable is never touched
      expect(gh.calls.filter((c) => c.method === "PATCH").map((c) => c.path.split("/").pop())).toEqual([IDS, CONV]);
      expect(gh.variables.has(VAR)).toBe(false);
      expect(orgSeen).toContain(`push@${ORG}`);
    });

    it("the same values twice are 'unchanged': no write, no audit row; a stored non-canonical value that reads the same is left alone", async () => {
      await putGoogleAds(principal, TENANT, PROP, full());
      gh.calls.length = 0;
      audits.length = 0;
      expect((await putGoogleAds(principal, TENANT, PROP, full())).result).toBe("unchanged");
      expect(writes()).toEqual([]);
      expect(audits).toEqual([]);
      gh.variables.set(IDS, { value: " AW-123456789 , AW-987654321,AW-123456789", updatedAt: "x" });
      expect((await putGoogleAds(principal, TENANT, PROP, full())).result).toBe("unchanged");
      expect(writes()).toEqual([]);
    });

    it("writes only the variable that changed: conversions only, then ids only", async () => {
      await putGoogleAds(principal, TENANT, PROP, full());
      gh.calls.length = 0;
      audits.length = 0;
      const onlyConv = full();
      (onlyConv.conversions as Record<string, string>).phone = "AW-123456789/p";
      expect((await putGoogleAds(principal, TENANT, PROP, onlyConv)).result).toBe("set");
      expect(writes()).toEqual([`PATCH /${CONV}`]);
      expect(audits.map((a) => a.meta.variable)).toEqual([CONV]);
      expect(audits[0]!.meta.to).toBe("lead=AW-123456789/l,whatsapp=AW-123456789/w,phone=AW-123456789/p,email=AW-987654321/e");
      gh.calls.length = 0;
      audits.length = 0;
      const onlyIds = { ...onlyConv, ids: ["AW-123456789", "AW-987654321", "AW-111111"] };
      expect((await putGoogleAds(principal, TENANT, PROP, onlyIds)).result).toBe("set");
      expect(writes()).toEqual([`PATCH /${IDS}`]);
      expect(audits.map((a) => a.meta.variable)).toEqual([IDS]);
    });

    it("ids with no conversions deletes a stored conversions variable, never writes it empty", async () => {
      await putGoogleAds(principal, TENANT, PROP, full());
      gh.calls.length = 0;
      audits.length = 0;
      const r = await putGoogleAds(principal, TENANT, PROP, adsBody({ ids: ["AW-123456789"], conversions: { lead: null, whatsapp: "", email: " " } }));
      expect(r.result).toBe("set");
      expect(gh.variables.has(CONV)).toBe(false);
      expect(gh.variables.get(IDS)?.value).toBe("AW-123456789");
      expect(writes()).toEqual([`PATCH /${IDS}`, `DELETE /${CONV}`]);
      expect(audits.map((a) => [a.verb, a.meta.variable])).toEqual([["tracking_tag_set", IDS], ["tracking_tag_cleared", CONV]]);
    });

    it("clear (ids null or []): deletes conversions first, then ids, audits both as cleared; clearing again is 'unchanged'", async () => {
      await putGoogleAds(principal, TENANT, PROP, full());
      gh.calls.length = 0;
      audits.length = 0;
      const r = await putGoogleAds(principal, TENANT, PROP, adsBody({ ids: null, conversions: {} }));
      expect(r).toMatchObject({ result: "cleared", googleAds: NO_ADS });
      expect(writes()).toEqual([`DELETE /${CONV}`, `DELETE /${IDS}`]);
      expect(gh.variables.has(IDS) || gh.variables.has(CONV)).toBe(false);
      expect(audits.map((a) => [a.verb, a.meta.variable, a.meta.to])).toEqual([["tracking_tag_cleared", CONV, null], ["tracking_tag_cleared", IDS, null]]);
      gh.calls.length = 0;
      audits.length = 0;
      expect((await putGoogleAds(principal, TENANT, PROP, adsBody({ ids: [], conversions: {} }))).result).toBe("unchanged");
      expect(writes()).toEqual([]);
      expect(audits).toEqual([]);
    });

    it("a clear removes a stored value that reads as nothing (junk is deleted, not called unchanged)", async () => {
      gh.variables.set(IDS, { value: "junk", updatedAt: "x" });
      const r = await putGoogleAds(principal, TENANT, PROP, adsBody({ ids: [], conversions: {} }));
      expect(r.result).toBe("cleared");
      expect(gh.variables.has(IDS)).toBe(false);
    });

    it("partial failure: the ids landed, the conversions write failed; the ids write is audited and the failure is typed", async () => {
      gh.beforeRequest = (method, path) => {
        if (method === "PATCH" && path.endsWith(`/${CONV}`)) throw new GithubApiError(`${method} ${path}`, 500, "boom");
      };
      await expect(putGoogleAds(principal, TENANT, PROP, full())).rejects.toMatchObject({ reason: "github_request_failed", status: 503 });
      expect(gh.variables.get(IDS)?.value).toBe("AW-123456789,AW-987654321");
      expect(gh.variables.has(CONV)).toBe(false);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ verb: "tracking_tag_set", meta: { tag: "google_ads", variable: IDS, from: null, to: "AW-123456789,AW-987654321" } });
    });

    it("partial failure on a clear: the conversions delete landed and the ids delete failed; the first is audited", async () => {
      await putGoogleAds(principal, TENANT, PROP, full());
      audits.length = 0;
      gh.beforeRequest = (method, path) => {
        if (method === "DELETE" && path.endsWith(`/${IDS}`)) throw new GithubApiError(`${method} ${path}`, 500, "boom");
      };
      await expect(putGoogleAds(principal, TENANT, PROP, adsBody({ ids: null, conversions: {} }))).rejects.toMatchObject({ reason: "github_request_failed" });
      expect(gh.variables.has(CONV)).toBe(false);
      expect(gh.variables.has(IDS)).toBe(true);
      expect(audits.map((a) => [a.verb, a.meta.variable])).toEqual([["tracking_tag_cleared", CONV]]);
    });

    it("a first-write failure audits nothing", async () => {
      gh.variablesPermission = false;
      await expect(putGoogleAds(principal, TENANT, PROP, full())).rejects.toMatchObject({ reason: "github_permission_missing", permission: "actions_variables" });
      expect(audits).toEqual([]);
    });

    it("each refusal is a 400 before any lookup: no property read, no GitHub call", async () => {
      for (const [payload, reason] of [
        [{ ...adsBody(), partnerId: "1" }, "ads_body_invalid"],
        [adsBody({ conversions: { fax: "AW-123456789/a" } }), "ads_body_invalid"],
        [adsBody({ ids: ["AW-12"] }), "ads_id_invalid"],
        [adsBody({ ids: ["AW-123456789", "AW-123456789"] }), "ads_id_invalid"],
        [adsBody({ conversions: { lead: "AW-999999999/x" } }), "ads_conversion_invalid"],
        [adsBody({ ids: [], conversions: { lead: "AW-123456789/x" } }), "ads_conversion_invalid"],
      ] as const) {
        await expect(putGoogleAds(principal, TENANT, PROP, payload), reason).rejects.toMatchObject({ reason, status: 400 });
      }
      expect(gh.calls).toHaveLength(0);
      expect(audits).toEqual([]);
    });

    it("binding: a mismatched site is 409 tracking_site_mismatch and nothing is read or written", async () => {
      property = { id: PROP, domain: "not-this-site.example" };
      await expect(putGoogleAds(principal, TENANT, PROP, full())).rejects.toMatchObject({ reason: "tracking_site_mismatch", status: 409 });
      siteDomains = null;
      property = { id: PROP, domain: "gaiada.com" };
      await expect(putGoogleAds(principal, TENANT, PROP, full())).rejects.toMatchObject({ reason: "tracking_site_mismatch", status: 409 });
      expect(gh.calls).toHaveLength(0);
      expect(audits).toEqual([]);
    });

    it("no build target is 409; the org push check refuses before any GitHub call; an unresolvable org is 503", async () => {
      target = { ok: false, detail: "rebuild_not_configured" };
      await expect(putGoogleAds(principal, TENANT, PROP, full())).rejects.toMatchObject({ reason: "no_build_target", status: 409 });
      target = { ok: true, repo: "gaiadabali/gaiada-web-revamp" };
      pushDenied = true;
      await expect(putGoogleAds(principal, TENANT, PROP, full())).rejects.toBeInstanceOf(ForbiddenException);
      pushDenied = false;
      org = { ok: false, reason: "not_in_root" };
      await expect(putGoogleAds(principal, TENANT, PROP, full())).rejects.toMatchObject({ reason: "github_org_unavailable", status: 503 });
      expect(gh.calls).toHaveLength(0);
    });

    it("a repo the App cannot see is 503 github_app_not_installed", async () => {
      target = { ok: true, repo: "gaiadabali/unseen-repo" };
      await expect(putGoogleAds(principal, TENANT, PROP, full())).rejects.toMatchObject({ reason: "github_app_not_installed" });
      expect(audits).toEqual([]);
    });

    it("only the three allow-listed variables are ever touched", async () => {
      await putGoogleAds(principal, TENANT, PROP, full());
      await putGoogleAds(principal, TENANT, PROP, adsBody({ ids: null, conversions: {} }));
      for (const c of gh.calls.filter((x) => x.path.includes("/actions/"))) {
        expect(c.path).toMatch(/\/actions\/variables(\/PUBLIC_GOOGLE_ADS_(IDS|CONVERSIONS))?$/);
      }
      expect([...gh.variables.keys()]).toEqual([]);
    });
  });
});

describe("findTrackingSite (M5-P4g)", () => {
  let property: { id: string; domain: string } | null;
  let sites: CompanySite[] | Error;
  const site = (webdeskTenant: string, id: string, domains: string[], name = id): CompanySite => ({ webdeskTenant, site: id, name, domains });
  beforeEach(() => {
    property = { id: PROP, domain: "Gaiada.com" };
    sites = [site("gaiada", SITE, ["cms-proof.gaiada.com", "https://WWW.gaiada.com/en"], "gaiada.com")];
    setTrackingTagsDeps({
      loadProperty: async () => property,
      companySites: async () => { if (sites instanceof Error) throw sites; return sites; },
    });
  });
  afterEach(() => setTrackingTagsDeps(null));

  it("a match: the site's tenant slug, id and name (case, scheme, path and www. ignored)", async () => {
    expect(await findTrackingSite(TENANT, PROP)).toEqual({ site: { webdeskTenant: "gaiada", site: SITE, name: "gaiada.com" } });
  });

  it("no match is an answer: site null", async () => {
    sites = [site("gaiada", SITE, ["other.example"]), site("gaiada", "s2", [])];
    expect(await findTrackingSite(TENANT, PROP)).toEqual({ site: null });
    sites = [];
    expect(await findTrackingSite(TENANT, PROP)).toEqual({ site: null });
  });

  it("the first match in Zone B's order wins", async () => {
    sites = [site("a", "s1", ["nope.example"]), site("b", "s2", ["www.gaiada.com"], "second"), site("c", "s3", ["gaiada.com"], "third")];
    expect(await findTrackingSite(TENANT, PROP)).toEqual({ site: { webdeskTenant: "b", site: "s2", name: "second" } });
  });

  it("an unknown property is 404 property_not_found and Zone B is not asked", async () => {
    property = null;
    let asked = false;
    setTrackingTagsDeps({ loadProperty: async () => null, companySites: async () => { asked = true; return []; } });
    await expect(findTrackingSite(TENANT, PROP)).rejects.toMatchObject({ reason: "property_not_found", status: 404 });
    expect(asked).toBe(false);
  });

  it("Zone B failing (a typed HTTP error) is 503 tracking_sites_unavailable in words, never site null", async () => {
    sites = new BadGatewayException({ message: "webdesk_error", reason: "tenant_list_shape" });
    await expect(findTrackingSite(TENANT, PROP)).rejects.toMatchObject({ reason: "tracking_sites_unavailable", status: 503 });
    expect(TRACKING_WORDS.tracking_sites_unavailable).toMatch(/could not list this company's websites/);
  });

  it("any other error is rethrown (a bug stays loud)", async () => {
    const boom = new Error("boom");
    sites = boom;
    await expect(findTrackingSite(TENANT, PROP)).rejects.toBe(boom);
  });
});

describe("the real companySites seam (Zone B stubbed)", () => {
  afterEach(() => { vi.restoreAllMocks(); setTrackingTagsDeps(null); });
  it("skips an inactive tenant and an archived site, keeps a tenant or site with no status, and reads env domains", async () => {
    const { webdeskZoneB } = await import("../webdev/webdesk-content.service");
    vi.spyOn(webdeskZoneB, "tenantsOf").mockResolvedValue([
      { slug: "old", status: "archived", defaultLocale: "en", locales: ["en"], sites: [{ siteId: "x1", name: "x1", kind: "static", environments: [{ domain: "gaiada.com" }] }] },
      { slug: "gaiada", status: "active", defaultLocale: "en", locales: ["en"], sites: [
        { siteId: "x2", name: "dead", kind: "static", status: "archived", environments: [{ domain: "gaiada.com" }] },
        { siteId: "x3", name: "live", kind: "static", status: "active", environments: [{ domain: "gaiada.com" }, { domain: null }, { name: "no-domain" }] },
        { siteId: "x4", name: "legacy", kind: "static", environments: [{ domain: "legacy.example" }] },
      ] },
      { slug: "nostatus", defaultLocale: "en", locales: ["en"], sites: [{ siteId: "x5", name: "older zone b", kind: "static", environments: [{ domain: "older.example" }] }] },
    ] as never);
    const ask = async (domain: string) => { setTrackingTagsDeps({ loadProperty: async () => ({ id: PROP, domain }) }); return findTrackingSite(TENANT, PROP); };
    expect(await ask("gaiada.com")).toEqual({ site: { webdeskTenant: "gaiada", site: "x3", name: "live" } });
    expect(await ask("legacy.example")).toEqual({ site: { webdeskTenant: "gaiada", site: "x4", name: "legacy" } });
    expect(await ask("older.example")).toEqual({ site: { webdeskTenant: "nostatus", site: "x5", name: "older zone b" } });
  });

  it("a Zone B read that throws a typed HTTP error is tracking_sites_unavailable", async () => {
    const { webdeskZoneB } = await import("../webdev/webdesk-content.service");
    vi.spyOn(webdeskZoneB, "tenantsOf").mockRejectedValue(new BadGatewayException({ message: "webdesk_error" }));
    setTrackingTagsDeps({ loadProperty: async () => ({ id: PROP, domain: "gaiada.com" }) });
    await expect(findTrackingSite(TENANT, PROP)).rejects.toMatchObject({ reason: "tracking_sites_unavailable" });
  });
});
