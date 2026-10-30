// M5-P4 (WSK-D92) — the tracking-tags routes against REAL Postgres and the real HTTP layer, with the in-memory GitHub behind the service's
// seams. Needs DATABASE_URL_TEST: the Linux gate. NOT run on the dev laptop (owner order 2026-10-12: no local Docker); skipped without it.
// Written without being run locally: the first CI run is its first run.
//
// Acceptance:
//   * the PUT asks `manage_tags` on the property BEFORE the body is looked at (a denial with a valid body, and a denial with an invalid one,
//     are both 403, with no GitHub call and no audit row); the GET asks `read`;
//   * a write asks `github_repo . push` at the GitHub ORG tenant (not the URL tenant);
//   * the binding: a property whose domain is not the site's is 409 `tracking_site_mismatch` on both routes; another company's property is 404;
//   * no build target is 409 `no_build_target` (PUT) / state `no_build_target` (GET);
//   * one `activities` row per actual write (who, property, repo, variable, from -> to); `unchanged` writes none;
//   * every refusal is `{error, reason}` in words.
// Authorization uses the Cerbos double (as replays.db.test.ts does): what is asserted is WHICH kind/action each route asks for.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { resetCoreRollupProviders, syncMetricDefinitions } from "../../rollups/engine";
import { FakeGithub } from "../../core/github/git-data.testkit";
import { LINKEDIN_PARTNER_ID_VARIABLE } from "../../core/github/repo-variables";
import { searchModule } from "./index";
import { setTrackingTagsDeps } from "./tracking-tags.service";

const calls: Array<{ kind: string; action: string; id?: string; tenantId?: string }> = [];
/** "<kind>:<action>" pairs the double denies. */
const denied = new Set<string>();
vi.mock("../../rbac/cerbos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../rbac/cerbos")>();
  return {
    ...actual,
    check: vi.fn(async (_p: never, resource: { kind: string; id?: string; tenantId?: string }, action: string) => {
      calls.push({ kind: resource.kind, action, id: resource.id, tenantId: resource.tenantId });
      return denied.has(`${resource.kind}:${action}`) ? { allow: false as const, reason: "test-forced-deny" } : { allow: true as const };
    }),
  };
});

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const S = { modules: ["search"] };
const SLUG = "tags-co";
const SITE = "55555555-5555-4555-8555-555555555555";
const VAR = LINKEDIN_PARTNER_ID_VARIABLE;
const REPO = "acme-org/acme-site";

describe.skipIf(!TEST_URL)("M5-P4 · tracking tags routes", () => {
  let app: NestFastifyApplication;
  let A: string;
  let B: string;
  let ORG: string;
  let u: string;
  let propA: string;
  let propOther: string;
  let propB: string;
  let gh: FakeGithub;
  let siteDomains: string[] | null;
  let target: { ok: true; repo: string } | { ok: false; detail: string };

  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => adminPool().query(sql, params).then((r) => r.rows as T[]);
  const url = (prop = propA, qs = `webdeskTenant=${SLUG}&site=${SITE}`) => `/api/${A}/modules/search/properties/${prop}/tracking-tags${qs ? `?${qs}` : ""}`;
  const get = (prop = propA, qs?: string) => app.inject({ method: "GET", url: url(prop, qs), headers: asUser(u) });
  const put = (payload: unknown, prop = propA) =>
    app.inject({ method: "PUT", url: `/api/${A}/modules/search/properties/${prop}/tracking-tags/linkedin`, headers: { ...asUser(u), "content-type": "application/json" }, payload: JSON.stringify(payload) });
  const body = (over: Record<string, unknown> = {}) => ({ webdeskTenant: SLUG, site: SITE, partnerId: "123456", ...over });
  const rows = () => q<{ actor_id: string; verb: string; target_entity_id: string; metadata: Record<string, unknown> }>(
    `SELECT actor_id, verb, target_entity_id, metadata FROM activities WHERE tenant_id = $1 AND verb IN ('tracking_tag_set','tracking_tag_cleared') ORDER BY occurred_at`, [A]);

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    registerModule(searchModule);
    await syncMetricDefinitions();
    A = await createCompany("Tags Co A", ["search"]);
    B = await createCompany("Tags Co B", ["search"]);
    ORG = await createCompany("Tags Org Operator", ["search"]);
    u = await createUser("tags-a@a.test");
    await addMembership(A, u);
    const clientA = await createClient(A, "Tags Client A");
    const clientB = await createClient(B, "Tags Client B");
    app = await buildApp();
    const mkProp = async (tenant: string, client: string, domain: string): Promise<string> => {
      const id = newId();
      await withTenants([tenant], (c) => c.query(
        `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, verified_at) VALUES ($1,$2,$3,$4,$5,now())`,
        [id, tenant, client, domain, `https://${domain}`]), S);
      return id;
    };
    propA = await mkProp(A, clientA, "tags-a.example.com");
    propOther = await mkProp(A, clientA, "somebody-else.example.com");
    propB = await mkProp(B, clientB, "tags-b.example.com");
  }, 120000);

  afterAll(async () => {
    setTrackingTagsDeps(null);
    await app?.close();
    await teardownTestDb();
  });

  beforeEach(() => {
    calls.length = 0;
    denied.clear();
    gh = new FakeGithub("acme-org", "acme-site");
    siteDomains = ["stg.tags-a.example.com", "www.tags-a.example.com"];
    target = { ok: true, repo: REPO };
    // Only the outside world is faked: the property read, the audit write and the Cerbos double are the real wiring.
    setTrackingTagsDeps({
      siteDomains: async () => siteDomains,
      stagingRepo: async () => target,
      resolveOrg: async () => ({ ok: true, tenantId: ORG }),
      git: () => gh.caller(),
    });
  });
  afterEach(async () => {
    await q(`DELETE FROM activities WHERE tenant_id = $1 AND verb IN ('tracking_tag_set','tracking_tag_cleared')`, [A]);
  });

  describe("authorization (authorize before validate)", () => {
    it("positive control: the PUT asks manage_tags on the property (module search, the URL tenant), then github_repo push at the ORG tenant", async () => {
      const res = await put(body());
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ result: "set", linkedin: { partnerId: "123456" }, takesEffect: "next_rebuild", target: { repo: REPO, variable: VAR } });
      expect(calls[0]).toMatchObject({ kind: "resource_search_property", action: "manage_tags", id: propA, tenantId: A });
      expect(calls).toContainEqual(expect.objectContaining({ kind: "github_repo", action: "push", tenantId: ORG }));
      expect(gh.variables.get(VAR)?.value).toBe("123456");
    });

    it("a manage_tags denial with a VALID body is 403: no GitHub call, no audit row", async () => {
      denied.add("resource_search_property:manage_tags");
      const res = await put(body());
      expect(res.statusCode).toBe(403);
      expect(gh.calls).toHaveLength(0);
      expect(await rows()).toEqual([]);
    });

    it("authorize comes BEFORE validate: a denial with an INVALID body is still 403, not 400", async () => {
      denied.add("resource_search_property:manage_tags");
      expect((await put(body({ partnerId: "nope" }))).statusCode).toBe(403);
      expect((await put({ junk: true })).statusCode).toBe(403);
      expect(gh.calls).toHaveLength(0);
    });

    it("a github_repo push denial at the org tenant is 403 and nothing is written", async () => {
      denied.add("github_repo:push");
      const res = await put(body());
      expect(res.statusCode).toBe(403);
      expect(gh.calls).toHaveLength(0);
      expect(await rows()).toEqual([]);
    });

    it("the GET asks read (not manage_tags) and still answers when manage_tags is denied, with canManage false", async () => {
      denied.add("resource_search_property:manage_tags");
      const res = await get();
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ linkedin: { partnerId: null }, target: { repo: REPO, variable: VAR }, canManage: false, state: "ok" });
      expect(calls[0]).toMatchObject({ kind: "resource_search_property", action: "read", id: propA, tenantId: A });
    });

    it("a read denial is 403", async () => {
      denied.add("resource_search_property:read");
      expect((await get()).statusCode).toBe(403);
    });
  });

  describe("validation (after authorization)", () => {
    it("a bad partner id, an extra field, a missing field and a bad site are typed 400s", async () => {
      for (const [payload, reason] of [
        [body({ partnerId: "12ab" }), "partner_id_invalid"],
        [body({ partnerId: "" }), "partner_id_invalid"],
        [body({ partnerId: 12345 }), "partner_id_invalid"],
        [{ ...body(), variable: "OTHER" }, "tracking_body_invalid"],
        [{ webdeskTenant: SLUG, site: SITE }, "tracking_body_invalid"],
        [body({ site: "nope" }), "tracking_query_invalid"],
      ] as const) {
        const res = await put(payload);
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
        expect(res.json()).toMatchObject({ reason });
        expect(typeof res.json().error).toBe("string");
      }
      expect(gh.calls).toHaveLength(0);
    });

    it("the GET needs webdeskTenant and site", async () => {
      const res = await get(propA, "");
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ reason: "tracking_query_invalid" });
    });
  });

  describe("the binding", () => {
    it("a property whose domain is not one of the site's environment domains is 409 tracking_site_mismatch on both routes", async () => {
      const g = await get(propOther);
      expect(g.statusCode).toBe(409);
      expect(g.json()).toMatchObject({ reason: "tracking_site_mismatch" });
      const p = await put(body(), propOther);
      expect(p.statusCode).toBe(409);
      expect(p.json()).toMatchObject({ reason: "tracking_site_mismatch" });
      expect(gh.calls).toHaveLength(0);
    });

    it("a site that is not this company's (the wall answers none) is the same 409", async () => {
      siteDomains = null;
      expect((await put(body())).statusCode).toBe(409);
      expect((await get()).statusCode).toBe(409);
    });

    it("another company's property is 404 from this company's URL", async () => {
      const res = await put(body(), propB);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ reason: "property_not_found" });
      expect(gh.calls).toHaveLength(0);
    });
  });

  describe("the build target", () => {
    it("no target: the PUT is 409 no_build_target and the GET says state no_build_target", async () => {
      target = { ok: false, detail: "rebuild_not_configured" };
      const p = await put(body());
      expect(p.statusCode).toBe(409);
      expect(p.json()).toMatchObject({ reason: "no_build_target" });
      const g = await get();
      expect(g.statusCode).toBe(200);
      expect(g.json()).toMatchObject({ state: "no_build_target", target: null, canManage: false });
      expect(gh.calls).toHaveLength(0);
    });

    it("GitHub unable to answer is words on the GET (state github_unavailable) and a typed 503 on the PUT, never an empty value", async () => {
      gh.variablesPermission = false;
      const g = await get();
      expect(g.json()).toMatchObject({ state: "github_unavailable", linkedin: { partnerId: null } });
      expect(g.json().reason).toContain("actions_variables");
      const p = await put(body());
      expect(p.statusCode).toBe(503);
      expect(p.json()).toMatchObject({ reason: "github_permission_missing", detail: { permission: "actions_variables" } });
      expect(await rows()).toEqual([]);
    });
  });

  describe("writes and the audit trail", () => {
    it("one activities row per actual write, with who, property, repo, variable and from -> to; unchanged writes none", async () => {
      expect((await put(body({ partnerId: "111" }))).json().result).toBe("set");
      expect((await put(body({ partnerId: "111" }))).json().result).toBe("unchanged");
      expect((await put(body({ partnerId: " 222 " }))).json().result).toBe("set");
      expect((await put(body({ partnerId: null }))).json().result).toBe("cleared");
      expect((await put(body({ partnerId: null }))).json().result).toBe("unchanged");
      const r = await rows();
      expect(r.map((x) => x.verb)).toEqual(["tracking_tag_set", "tracking_tag_set", "tracking_tag_cleared"]);
      expect(r.every((x) => x.actor_id === u && x.target_entity_id === propA)).toBe(true);
      expect(r.map((x) => [x.metadata.from, x.metadata.to])).toEqual([[null, "111"], ["111", "222"], ["222", null]]);
      expect(r[0]!.metadata).toMatchObject({ repo: REPO, variable: VAR, webdeskTenant: SLUG, site: SITE });
      expect(gh.variables.has(VAR)).toBe(false);
    });

    it("the GET returns what the PUT stored", async () => {
      await put(body({ partnerId: "424242" }));
      const g = await get();
      expect(g.json()).toMatchObject({ linkedin: { partnerId: "424242" }, state: "ok", canManage: true });
    });
  });
});
