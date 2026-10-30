// M5-P4 (WSK-D92) — the tracking-tags service against the in-memory GitHub and fake seams (no database, no Cerbos, no network).
// The HTTP layer (403 before the body, the wire shape) is tracking-tags.db.test.ts, which needs the Linux gate.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import { FakeGithub } from "../../core/github/git-data.testkit";
import { LINKEDIN_PARTNER_ID_VARIABLE } from "../../core/github/repo-variables";
import type { Principal } from "../../rbac/principal";
import {
  TRACKING_WORDS, TrackingTagsError, environmentDomains, hostOf, parsePutBody, parseSiteQuery, partnerIdOfValue, propertyMatchesSite,
  putLinkedinPartnerId, readTrackingTags, setTrackingTagsDeps,
} from "./tracking-tags.service";
import { asHttp } from "./tracking-tags.controller";

const TENANT = "dddddddd-7050-0000-0000-000000000001";
const ORG = "dddddddd-7050-0000-0000-0000000000a0";
const PROP = "dddddddd-7050-0000-0000-0000000000b1";
const SITE = "dddddddd-7050-0000-0000-0000000000c1";
const SLUG = "gaiada";
const VAR = LINKEDIN_PARTNER_ID_VARIABLE;
const principal = { userId: "u-1" } as unknown as Principal;
const q = { webdeskTenant: SLUG, site: SITE };
const body = (over: Record<string, unknown> = {}) => ({ webdeskTenant: SLUG, site: SITE, partnerId: "123456", ...over });

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
      expect(v).toEqual({ linkedin: { partnerId: null }, target: { repo: "gaiadabali/gaiada-web-revamp", variable: VAR }, canManage: true, state: "ok" });
      expect(gh.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        `GET /repos/gaiadabali/gaiada-web-revamp/actions/variables/${VAR}`,
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

    it("a stored value that is not digits reads as no id (the site would ignore it too)", async () => {
      gh.variables.set(VAR, { value: "oops", updatedAt: "x" });
      expect((await readTrackingTags(principal, TENANT, PROP, q)).linkedin.partnerId).toBeNull();
    });

    it("no build target: state no_build_target in words, no target, canManage false, and GitHub is never called", async () => {
      target = { ok: false, detail: "no provisioned site" };
      const v = await readTrackingTags(principal, TENANT, PROP, q);
      expect(v).toMatchObject({ target: null, canManage: false, state: "no_build_target", reason: TRACKING_WORDS.no_build_target });
      expect(gh.calls).toHaveLength(0);
    });

    it("the App missing the variables permission is state github_unavailable in words (the page still draws), never 'Not set'", async () => {
      gh.variablesPermission = false;
      const v = await readTrackingTags(principal, TENANT, PROP, q);
      expect(v).toMatchObject({ state: "github_unavailable", linkedin: { partnerId: null }, target: { repo: "gaiadabali/gaiada-web-revamp" } });
      expect(v.reason).toContain("actions_variables");
    });

    it("a repository the App cannot see is github_unavailable (App not installed), not an empty value", async () => {
      target = { ok: true, repo: "gaiadabali/unseen-repo" };
      const v = await readTrackingTags(principal, TENANT, PROP, q);
      expect(v.state).toBe("github_unavailable");
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
});
