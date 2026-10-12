// M5-W8 — the writer dashboard over the REAL surface: HTTP (`app.inject`), the real Cerbos with the W1a policies, the real principal
// assembly (scope rows from Postgres), the real content service and the real data sources (Postgres: search_properties,
// search_gsc_performance, search_decay_findings, agency_leads). Stand-ins: Zone B (the in-process FakeZoneB) and Umami (a fake fetch).
//
// What it proves: a writer sees only their own articles, an editor and a staff tier everything in scope; the lead count is a NUMBER
// (a lead seeded with a name, an address, a phone, click ids and an id never appears in any response); an Umami outage is null-with-reason
// and not zero; a denied caller is 403 with a valid request beside a positive control; >50 (collection, language) pairs still work.
// Needs DATABASE_URL_TEST + CERBOS_URL, the test Cerbos restarted on the W1a policies. NOT RUN LOCALLY (owner order: no docker on
// the laptop); it runs on the Linux gate (CI).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { buildApp } from "../../main";
import { resetModules } from "../registry";
import { resetCoreRollupProviders } from "../../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createClient, createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { setWebdeskApprovedCommandDepsForTests } from "./webdesk-approved-command";
import { webdeskZoneB } from "./webdesk-content.service";
import { WebdeskControlTransportError } from "./webdesk-control-client";
import { webdeskWritersDashboard } from "./webdesk-writers-dashboard.service";
import { DbDashboardSources } from "./webdesk-writers-dashboard-sources";
import { FakeZoneB, GAIADA_SITE, GAIADA_SLUG, OTHER_SITE, makeTestSigner } from "./webdesk-content-testkit";

const live = !!TEST_URL && !!process.env.CERBOS_URL;
const asUser = (id: string) => ({ authorization: "Bearer svc-token", "x-user-id": id });
const S = { modules: ["search"] };
const DAY = 86_400_000;

// What the seeded lead is, in every field a response must never carry.
const LEAD = { org: "Zanzibar Dental Org", name: "Quentin Prospect", email: "quentin.prospect@lead-secret.test", phone: "+62-811-555-0199", utm: "secretutm-77", gclid: "gclid-SECRET-123" };

describe.skipIf(!live)("M5-W8 · the writer dashboard over HTTP, real Cerbos and Postgres", () => {
  let app: NestFastifyApplication;
  let A: string;
  let B: string;
  let publisherA: string, writerA: string, otherWriter: string, editorAll: string, nobody: string, editorB: string;
  let propertyId: string;
  const leadIds: string[] = [];
  let zb: FakeZoneB;
  let umami: "ok" | "down" = "ok";
  const signer = makeTestSigner();

  const dash = (as: string, qs = "") => app.inject({ method: "GET", url: `/api/${A}/modules/webdev/content/sites/${GAIADA_SLUG}/${GAIADA_SITE}/writers/dashboard${qs}`, headers: asUser(as) });

  async function editorial(tenant: string, userId: string, role: string, siteId: string, collections: string[] | "all", locales: string[] | "all") {
    const roleId = await createRole(role);
    await grantRole(userId, roleId, "company", tenant);
    const g = (await adminPool().query(`SELECT id FROM user_roles WHERE user_id = $1 AND role_id = $2`, [userId, roleId])).rows[0].id;
    await adminPool().query(
      `INSERT INTO user_role_editorial_scopes (user_role_id, tenant_id, webdesk_tenant_slug, site_id, all_collections, collections, all_locales, locales, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [g, tenant, siteId === OTHER_SITE ? "othertenant" : GAIADA_SLUG, siteId, collections === "all", collections === "all" ? [] : collections, locales === "all", locales === "all" ? [] : locales, config.originSite],
    );
  }

  const seed = (slug: string, collectionKey: string, author: string | null, over: { published?: boolean; locale?: string } = {}) =>
    zb.seedItem({
      siteId: GAIADA_SITE, slug, collectionKey, locale: over.locale ?? "en",
      publishedVersion: over.published === false ? null : 1, publishState: over.published === false ? "draft" : "published",
      editorial: { reviewRequired: false, state: "draft", approvedVersion: null, authorSub: author, submittedVersion: null },
    });

  const umamiFetch = (async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    if (umami === "down") return new Response("{}", { status: 503 });
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    if (u.pathname.endsWith("/metrics/expanded")) return json([{ name: "/blog/hello/", pageviews: 120, visitors: 90, visits: 100, bounces: 10, totaltime: 21000 }]);
    const current = Number(u.searchParams.get("startAt")) > Date.now() - 29 * DAY;
    return json(current ? [{ x: "/blog/hello/", y: 120 }, { x: "/blog/world/", y: 8 }] : [{ x: "/blog/hello/", y: 60 }]);
  }) as typeof fetch;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    A = await createCompany("W8 Co A", ["webdev", "search"]);
    B = await createCompany("W8 Co B", ["webdev", "search"]);
    const mk = async (co: string, email: string, role: string) => {
      const id = await createUser(email);
      await addMembership(co, id);
      await grantRole(id, await createRole(role), "company", co);
      return id;
    };
    publisherA = await mk(A, "publisher@w8.test", "webdev_manager");
    writerA = await mk(A, "writer@w8.test", "member");
    otherWriter = await mk(A, "other-writer@w8.test", "member");
    editorAll = await mk(A, "editor@w8.test", "member");
    nobody = await mk(A, "nobody@w8.test", "member");
    editorB = await mk(B, "editor-b@w8.test", "member");
    await editorial(A, writerA, "webdesk_writer", GAIADA_SITE, ["post"], ["en"]);
    await editorial(A, otherWriter, "webdesk_writer", GAIADA_SITE, ["post"], ["en"]);
    await editorial(A, editorAll, "webdesk_editor", GAIADA_SITE, "all", "all");
    await editorial(B, editorB, "webdesk_editor", OTHER_SITE, "all", "all");

    // The search property of the site: the FakeZoneB's staging domain is the only environment with a hostname.
    const clientA = await createClient(A, "W8 Client");
    propertyId = newId();
    await withTenants([A], (c) => c.query(
      `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, umami_site_id, verified_at)
       VALUES ($1, $2, $3, 'staging.gaiada.test', 'https://staging.gaiada.test', '0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4', now())`, [propertyId, A, clientA]), S);
    // Search Console: per query, 2 clicks a day in the current window (CURRENT_DATE-30..-3) and 1 in the one before; real rows only count.
    const gsc = (query: string, simulated: boolean, perDay: number) => withTenants([A], (c) => c.query(
      `INSERT INTO search_gsc_performance (id, tenant_id, property_id, date, query, page, device, clicks, impressions, position, row_hash, simulated)
       SELECT gen_random_uuid(), $1, $2, d::date, $3, 'https://staging.gaiada.test/blog/hello/', 'DESKTOP',
              CASE WHEN d::date >= CURRENT_DATE - 30 THEN $5::int * 2 ELSE $5::int END, CASE WHEN d::date >= CURRENT_DATE - 30 THEN $5::int * 40 ELSE $5::int * 20 END,
              8, md5($2::uuid::text || $3 || d::text), $4::boolean
         FROM generate_series(CURRENT_DATE - 58, CURRENT_DATE - 3, interval '1 day') AS d`,
      [A, propertyId, query, simulated, perDay]), S);
    await gsc("villa bali", false, 1);
    await gsc("bali seo agency", false, 1);
    await gsc("a simulated query", true, 50); // simulated rows must never be counted
    await withTenants([A], (c) => c.query(
      `INSERT INTO search_gsc_performance (id, tenant_id, property_id, date, query, page, device, clicks, impressions, position, row_hash, simulated)
       VALUES (gen_random_uuid(), $1, $2, CURRENT_DATE - 5, 'one person query', 'https://staging.gaiada.test/blog/hello/', 'DESKTOP', 1, 4, 8, md5('rare'), false)`, [A, propertyId]), S);
    await withTenants([A], (c) => c.query(
      `INSERT INTO search_decay_findings (tenant_id, property_id, page_path, window_from, window_to, window_days, status, reason, reasons)
       VALUES ($1, $2, '/blog/hello', CURRENT_DATE - 30, CURRENT_DATE - 3, 28, 'open', 'Search clicks fell by 40 %.', '[]')`, [A, propertyId]), S);

    // Web leads (company A, site slug "gaiada"): every identity field is filled in so a leak would show.
    const lead = async (tenant: string, owner: string, o: { landing: string; formPage: string; createdAt?: string; deleted?: boolean }) => {
      const id = newId();
      leadIds.push(id);
      await withTenants([tenant], (c) => c.query(
        `INSERT INTO agency_leads (id, tenant_id, org_name, contact_name, contact_email, contact_phone, source, status, stage, owner_id, origin_site,
                                   submission_ref, origin_form, attribution, web_site_slug, created_at, deleted_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'web', 'in_review', 'enquiry', $7, 'test', $8, 'contact', $9::jsonb, $10, COALESCE($11::timestamptz, now()), $12)`,
        [id, tenant, LEAD.org, LEAD.name, LEAD.email, LEAD.phone, owner, newId(),
          JSON.stringify({ landing: o.landing, form_page: o.formPage, utm_source: LEAD.utm, gclid: LEAD.gclid, sections_seen: ["home.hero"] }),
          GAIADA_SLUG, o.createdAt ?? null, o.deleted ? new Date() : null]));
      return id;
    };
    await lead(A, publisherA, { landing: "/blog/hello/", formPage: "/contact/" });          // landing page
    await lead(A, publisherA, { landing: "/services/", formPage: "/blog/hello" });          // form page
    await lead(A, publisherA, { landing: "/blog/hello/", formPage: "/blog/hello/" });       // both: counts once
    await lead(A, publisherA, { landing: "/blog/world/", formPage: "/contact/" });          // another article
    await lead(A, publisherA, { landing: "/blog/hello/", formPage: "/contact/", deleted: true }); // removed: not counted
    await lead(A, publisherA, { landing: "/blog/hello/", formPage: "/contact/", createdAt: new Date(Date.now() - 40 * DAY).toISOString() }); // the period before
    await lead(B, editorB, { landing: "/blog/hello/", formPage: "/contact/" });             // another company, the same slug: never counted

    zb = new FakeZoneB(A, B);
    zb.compositions.set("post", { ui: { label: "Posts", routePattern: "/blog/{slug}/" } });
    zb.compositions.set("guide", { ui: { label: "Guides" } });
    webdeskWritersDashboard.setSourcesForTests(new DbDashboardSources({ umami: { settings: { baseUrl: "http://umami.test", apiKey: "umami_k", timeoutMs: 2000 }, fetchImpl: umamiFetch }, decayEnabled: () => true }));
    app = await buildApp();
  }, 180_000);

  beforeEach(async () => {
    zb.reset();
    zb.listRowsCarryEditorial = true;
    umami = "ok";
    signer.calls.length = 0;
    webdeskZoneB.clearSiteCache();
    setWebdeskApprovedCommandDepsForTests({ client: zb.asClient(), signer });
    seed("hello", "post", writerA);
    seed("world", "post", otherWriter);
    seed("unpublished", "post", writerA, { published: false });
    seed("g1", "guide", writerA);
  });
  afterAll(async () => {
    webdeskWritersDashboard.setSourcesForTests(null);
    setWebdeskApprovedCommandDepsForTests(null);
    await app?.close();
    await teardownTestDb();
  });

  const body = (r: { body: string }) => JSON.parse(r.body) as { scope: string; items: Array<Record<string, any>>; sources: Record<string, any>; page: Record<string, any> };
  const bySlug = (b: ReturnType<typeof body>, slug: string) => b.items.find((i) => i.slug === slug);

  it("a STAFF tier sees every published article with its page path and its figures from all four sources", async () => {
    const r = await dash(publisherA);
    expect(r.statusCode, r.body).toBe(200);
    const b = body(r);
    expect(b.scope).toBe("all_site");
    expect(b.items.map((i) => i.slug).sort()).toEqual(["g1", "hello", "world"]); // the unpublished draft is not an article yet
    const hello = bySlug(b, "hello")!;
    expect(hello.pagePath).toBe("/blog/hello/");
    expect(hello.metrics.views.value).toEqual({ current: 120, previous: 60, trend: "up" });
    expect(hello.metrics.avgSeconds.value).toEqual({ seconds: 210 });
    // two real queries x 2 clicks x 28 days + the one-person query's 1 click = 113; x 1 click x 28 days = 56 before; simulated rows are not counted
    expect(hello.metrics.clicks.value).toMatchObject({ current: 113, previous: 56, trend: "up" });
    expect(hello.metrics.topQueries.value.map((q: { query: string }) => q.query)).toEqual(["bali seo agency", "villa bali"]); // the 4-impression query is left out
    expect(hello.metrics.leads.value).toEqual({ current: 3, previous: 1, trend: "up" }); // another company's and a removed lead are not counted
    expect(hello.decay.value).toMatchObject({ status: "open", reason: "Search clicks fell by 40 %." });
    expect(bySlug(b, "world")!.metrics.leads.value).toMatchObject({ current: 1 });
    // a collection with no page address says so in words and every figure carries that reason
    const g1 = bySlug(b, "g1")!;
    expect(g1.pagePath).toBeNull();
    expect(g1.pagePathReason.code).toBe("no_route_pattern");
    expect(g1.metrics.views).toMatchObject({ value: null, reason: { code: "no_route_pattern" } });
  });

  it("LEAD COUNTS NEVER EXPOSE IDENTITIES: no lead id, name, organisation, address, phone, click id or UTM anywhere in the response", async () => {
    for (const who of [publisherA, editorAll, writerA]) {
      const raw = (await dash(who)).body;
      for (const secret of [LEAD.org, LEAD.name, LEAD.email, LEAD.phone, LEAD.utm, LEAD.gclid, "home.hero", ...leadIds]) expect(raw).not.toContain(secret);
    }
  });

  it("a WRITER sees only their own articles; another writer sees theirs; neither sees a collection outside their grant", async () => {
    const a = body(await dash(writerA));
    expect(a.scope).toBe("scoped");
    expect(a.items.map((i) => i.slug)).toEqual(["hello"]);
    expect(a.items[0].mine).toBe(true);
    expect(body(await dash(otherWriter)).items.map((i) => i.slug)).toEqual(["world"]);
  });

  it("an EDITOR (assign on the pair) sees everything in scope; ?mine=true narrows an editor to their own", async () => {
    expect(body(await dash(editorAll)).items.map((i) => i.slug).sort()).toEqual(["g1", "hello", "world"]);
    expect(body(await dash(editorAll, "?mine=true")).items).toEqual([]);
    expect(body(await dash(publisherA, "?collection=post&period=7d")).items.map((i) => i.slug).sort()).toEqual(["hello", "world"]);
  });

  it("DENIAL with a valid request: a caller with no editorial grant is 403 for any query; the staff positive control is 200", async () => {
    expect((await dash(nobody)).statusCode).toBe(403);
    expect((await dash(nobody, "?period=7d&limit=10")).statusCode).toBe(403);
    expect((await dash(nobody, "?period=banana")).statusCode).toBe(403); // authz before validation
    expect((await dash(publisherA, "?period=banana")).statusCode).toBe(400);
    expect((await dash(publisherA)).statusCode).toBe(200);
    expect(zb.writes).toHaveLength(0); // the dashboard writes nothing to WebDesk
  });

  it("another company's editor cannot read this company's dashboard", async () => {
    const r = await dash(editorB);
    expect([403, 404]).toContain(r.statusCode);
    expect(r.body).not.toContain("hello");
  });

  it("an Umami OUTAGE is null with a reason on the views and the time, never zero; the rows and the other sources stay", async () => {
    umami = "down";
    const r = await dash(publisherA);
    expect(r.statusCode).toBe(200);
    const b = body(r);
    const hello = bySlug(b, "hello")!;
    expect(hello.metrics.views).toMatchObject({ value: null, reason: { code: "umami_unreachable" } });
    expect(hello.metrics.avgSeconds.value).toBeNull();
    expect(hello.metrics.clicks.value).toMatchObject({ current: 113 });
    expect(hello.metrics.leads.value).toMatchObject({ current: 3 });
    expect(b.sources.umami).toMatchObject({ state: "unavailable", reason: { code: "umami_unreachable" } });
    expect(b.sources.search).toEqual({ state: "ok" });
  });

  it("a property with no Search Console rows for the period is 'unavailable', not 0 clicks", async () => {
    await withTenants([A], (c) => c.query(`UPDATE search_gsc_performance SET simulated = true WHERE property_id = $1`, [propertyId]), S);
    try {
      const hello = bySlug(body(await dash(publisherA)), "hello")!;
      expect(hello.metrics.clicks).toMatchObject({ value: null, reason: { code: "gsc_no_data" } });
      expect(hello.metrics.topQueries.value).toBeNull();
    } finally {
      await withTenants([A], (c) => c.query(`UPDATE search_gsc_performance SET simulated = (query = 'a simulated query') WHERE property_id = $1`, [propertyId]), S);
    }
  });

  it("WebDesk itself failing is the whole read's 503", async () => {
    zb.failWith = new WebdeskControlTransportError("connect ECONNREFUSED", 3, false, "ECONNREFUSED");
    expect((await dash(publisherA)).statusCode).toBe(503);
  });

  it("more than 50 (collection, language) pairs: an editor still gets every article, in pages", async () => {
    for (let i = 0; i < 26; i++) {
      const key = `bulk${String(i).padStart(2, "0")}`;
      zb.compositions.set(key, { ui: { label: key, routePattern: `/${key}/{slug}/` } });
      seed(`${key}-en`, key, editorAll, { locale: "en" });
      seed(`${key}-id`, key, editorAll, { locale: "id" });
    }
    try {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 20; i++) {
        const r = await dash(editorAll, `?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        expect(r.statusCode, r.body).toBe(200);
        const b = body(r);
        seen.push(...b.items.map((x) => x.slug));
        if (!b.page.hasMore) break;
        cursor = b.page.cursor;
      }
      expect(seen.filter((s) => s.startsWith("bulk"))).toHaveLength(52);
      expect(seen).toEqual(expect.arrayContaining(["hello", "world", "g1"]));
    } finally {
      for (let i = 0; i < 26; i++) zb.compositions.delete(`bulk${String(i).padStart(2, "0")}`);
    }
  });
});
