// M5-P5a — IndexNow on publish + the Bing Webmaster connector against LIVE Postgres and the real HTTP layer
// (needs DATABASE_URL_TEST and the Cerbos env, see platform-nest/CLAUDE.md; skipped without it; NOT run on the
// author's laptop, which has no Docker: it needs the Linux gate). Every network call is a fake fetch that records
// what it was asked; a test that must prove "no network" uses a fetch that fails the test if it is touched.
//
// Cerbos `check` is mocked but its call arguments are captured, so a denial test proves WHICH kind/action gates
// each route, and every denial is sent a VALID request (valid property id, valid body) so validation can never
// pre-empt the authz check. A positive control (the same request, allowed) runs beside each denial.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { randomBytes } from "node:crypto";
import { config } from "../../config";
import { withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { searchModule } from "./index";
import { resetCoreRollupProviders, syncMetricDefinitions } from "../../rollups/engine";
import { INDEXNOW_ENDPOINT } from "./indexnow";
import { notifyContentChange, runIndexNowSweep, setIndexNowDepsForTests, type IndexNowDeps } from "./indexnow-service";
import { setBingDepsForTests } from "./bing-service";
import { handlePublishApprovalDecided } from "./indexnow-webdesk";
import type { OutboxEvent } from "../../events/types";

const calls: Array<{ kind: string; action: string; tenantId?: string }> = [];
let denyAll = false;
let useRealCerbos = false;
vi.mock("../../rbac/cerbos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../rbac/cerbos")>();
  return {
    ...actual,
    check: vi.fn(async (p: never, resource: { kind: string; tenantId?: string }, action: string, ...rest: unknown[]) => {
      if (useRealCerbos) return (actual.check as (...a: unknown[]) => Promise<unknown>)(p, resource, action, ...rest) as never;
      calls.push({ kind: resource.kind, action, tenantId: resource.tenantId });
      return denyAll ? { allow: false as const, reason: "test-forced-deny" } : { allow: true as const };
    }),
  };
});

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const SEARCH = { modules: ["search"] };
const BING_KEY = "0123456789abcdef0123456789abcdef";
const NOW = new Date("2026-10-12T09:00:00.000Z");
const addMs = (d: Date, ms: number) => new Date(d.getTime() + ms);

// ── the fake network ─────────────────────────────────────────────────────────────────────────────
interface NetCall { url: string; method: string; body: unknown }
const net = {
  calls: [] as NetCall[],
  indexnowStatus: 200,
  keyFile: { status: 200, body: null as string | null }, // body null = serve the property's real key
  keyOf: (_host: string): string | null => null as string | null,
  bing: ((_u: URL, _init: RequestInit | undefined): Response => new Response("{}", { status: 404 })) as (u: URL, init: RequestInit | undefined) => Response,
};
const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  net.calls.push({ url, method: init?.method ?? "GET", body });
  if (url === INDEXNOW_ENDPOINT) return new Response("body that must never surface", { status: net.indexnowStatus });
  if (url.endsWith(".txt")) return new Response(net.keyFile.body ?? net.keyOf(new URL(url).host) ?? "", { status: net.keyFile.status });
  if (url.startsWith("https://ssl.bing.com/")) return net.bing(new URL(url), init);
  throw new Error(`unexpected fetch to ${url}`);
};
const indexnowPosts = () => net.calls.filter((c) => c.url === INDEXNOW_ENDPOINT);
const PUBLIC = async () => ["93.184.216.34"];

function useDeps(o: { flag?: boolean; bingLive?: boolean; now?: Date } = {}): IndexNowDeps {
  const env = { ...(o.flag === false ? {} : { SEARCH_INDEXNOW_ENABLED: "1" }), ...(o.bingLive ? { SEARCH_BING_MODE: "live" } : {}) } as NodeJS.ProcessEnv;
  const d: IndexNowDeps = { env, fetchImpl: fakeFetch as never, resolve: PUBLIC, ...(o.now ? { now: () => o.now! } : {}) };
  setIndexNowDepsForTests(d);
  setBingDepsForTests({ env, fetchImpl: fakeFetch as never, ...(o.now ? { now: () => o.now! } : {}) });
  return d;
}

describe.skipIf(!TEST_URL)("M5-P5a · IndexNow on publish + Bing Webmaster", () => {
  let app: NestFastifyApplication;
  let A: string;
  let C: string;
  let uA: string;
  let uC: string;
  let clientA: string;
  let clientC: string;
  let main: string;       // verified, key proven, IndexNow enabled
  let unverified: string; // not verified
  let noKey: string;      // verified, no key yet
  let propC: string;      // another company's
  const base = (t: string, p: string) => `/api/${t}/modules/search/properties/${p}`;

  const mkProp = async (tenant: string, client: string, domain: string, o: { verified?: boolean } = {}): Promise<string> => {
    const r = await app.inject({ method: "POST", url: `/api/${tenant}/modules/search/properties`, headers: asUser(tenant === A ? uA : uC), payload: { clientId: client, domain, siteUrl: `https://${domain}` } });
    expect(r.statusCode).toBe(201);
    const id = r.json().id as string;
    if (o.verified !== false) await withTenants([tenant], (c) => c.query(`UPDATE search_properties SET verified_at = now() WHERE id = $1`, [id]), SEARCH);
    return id;
  };
  const prop = async (id: string) => (await withTenants([A], (c) => c.query(
    `SELECT indexnow_key AS key, indexnow_enabled AS enabled, indexnow_key_verified_at AS "verifiedAt", bing_connection_id AS "bing" FROM search_properties WHERE id = $1`, [id]), SEARCH)).rows[0] as
    { key: string | null; enabled: boolean; verifiedAt: Date | null; bing: string | null };
  const rows = async (id: string, where = "") => (await withTenants([A], (c) => c.query(
    `SELECT url, engine, status, attempts, http_status AS "httpStatus", error_code AS "errorCode", transition, version, simulated, next_attempt_at AS "nextAt"
       FROM search_indexnow_submissions WHERE property_id = $1 ${where} ORDER BY url, version`, [id]), SEARCH)).rows as Array<{
    url: string; engine: string; status: string; attempts: number; httpStatus: number | null; errorCode: string | null; transition: string; version: string; simulated: boolean; nextAt: Date }>;
  /** Generate the key, serve it, and enable IndexNow through the real routes. */
  const enable = async (id: string, host: string) => {
    useDeps();
    const k = await app.inject({ method: "POST", url: `${base(A, id)}/indexnow/key`, headers: asUser(uA), payload: {} });
    expect([200, 201]).toContain(k.statusCode);
    net.keyOf = (h) => (h === host ? (k.json().key as string) : null);
    net.keyFile = { status: 200, body: null };
    const e = await app.inject({ method: "PATCH", url: `${base(A, id)}/indexnow`, headers: asUser(uA), payload: { enabled: true } });
    expect(e.statusCode).toBe(200);
    return k.json().key as string;
  };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.integrationTokenKey = randomBytes(32).toString("base64"); // the vault is fail-closed without it
    resetModules();
    resetCoreRollupProviders();
    registerModule(searchModule);
    await syncMetricDefinitions();
    A = await createCompany("P5a Co A", ["search"]);
    C = await createCompany("P5a Co C", ["search"]);
    uA = await createUser("p5a-a@a.test");
    uC = await createUser("p5a-c@c.test");
    await addMembership(A, uA);
    await addMembership(C, uC);
    clientA = await createClient(A, "P5a Client A");
    clientC = await createClient(C, "P5a Client C");
    app = await buildApp();
    main = await mkProp(A, clientA, "idx.example.com");
    unverified = await mkProp(A, clientA, "unverified.example.com", { verified: false });
    noKey = await mkProp(A, clientA, "nokey.example.com");
    propC = await mkProp(C, clientC, "other.example.org");
  });
  afterAll(async () => {
    setIndexNowDepsForTests(null);
    setBingDepsForTests(null);
    await app?.close();
    await teardownTestDb();
  });
  beforeEach(() => {
    calls.length = 0; denyAll = false; useRealCerbos = false;
    net.calls.length = 0; net.indexnowStatus = 200; net.keyFile = { status: 200, body: null }; net.keyOf = () => null;
    net.bing = () => new Response("{}", { status: 404 });
    useDeps();
  });

  // ── the flag ───────────────────────────────────────────────────────────────────────────────────
  it("flag OFF: a content change sends nothing and writes nothing; the routes refuse with a typed reason", async () => {
    const guard = vi.fn(async () => { throw new Error("the network must not be touched with the flag off"); });
    const d: IndexNowDeps = { env: {}, fetchImpl: guard as never, resolve: PUBLIC };
    setIndexNowDepsForTests(d);
    const r = await notifyContentChange(A, { propertyId: main, transition: "publish", ref: "off-1", items: [{ slug: "a", locale: "en", defaultLocale: "en", routePattern: "/blog/{slug}/", version: 1 }] }, d);
    expect(r).toMatchObject({ status: "disabled", urls: 0 });
    expect(await rows(main)).toEqual([]);
    // an empty / junk flag value is OFF too
    for (const v of ["", "true", "0"]) {
      expect((await notifyContentChange(A, { propertyId: main, transition: "publish", items: [] }, { ...d, env: { SEARCH_INDEXNOW_ENABLED: v } })).status).toBe("disabled");
    }
    const sub = await app.inject({ method: "POST", url: `${base(A, main)}/indexnow/submit`, headers: asUser(uA), payload: { urls: ["/x/"] } });
    expect(sub.statusCode).toBe(409);
    expect(sub.json().reason).toBe("indexnow_platform_disabled");
    const en = await app.inject({ method: "PATCH", url: `${base(A, main)}/indexnow`, headers: asUser(uA), payload: { enabled: true } });
    expect(en.statusCode).toBe(409);
    expect(en.json().reason).toBe("indexnow_platform_disabled");
    expect(guard).not.toHaveBeenCalled();
    expect(await runIndexNowSweep(d)).toMatchObject({ groups: 0, sent: 0 });
    const st = await app.inject({ method: "GET", url: `${base(A, main)}/indexnow`, headers: asUser(uA) });
    expect(st.statusCode).toBe(200);
    expect(st.json()).toMatchObject({ platformEnabled: false, enabled: false });
  });

  // ── the key and the switch ─────────────────────────────────────────────────────────────────────
  it("the key: 404 until generated, 201 then 200 (idempotent), a public key file description, rotate switches IndexNow off", async () => {
    const miss = await app.inject({ method: "GET", url: `${base(A, noKey)}/indexnow/key`, headers: asUser(uA) });
    expect(miss.statusCode).toBe(404);
    expect(miss.json().reason).toBe("indexnow_key_missing");
    const g1 = await app.inject({ method: "POST", url: `${base(A, noKey)}/indexnow/key`, headers: asUser(uA), payload: {} });
    expect(g1.statusCode).toBe(201);
    const k1 = g1.json();
    expect(k1.key).toMatch(/^[0-9a-f]{32}$/);
    expect(k1).toMatchObject({ created: true, fileName: `${k1.key}.txt`, fileBody: k1.key, location: `https://nokey.example.com/${k1.key}.txt`, enabled: false });
    const g2 = await app.inject({ method: "POST", url: `${base(A, noKey)}/indexnow/key`, headers: asUser(uA), payload: {} });
    expect(g2.statusCode).toBe(200);
    expect(g2.json()).toMatchObject({ created: false, rotated: false, key: k1.key });
    const read = await app.inject({ method: "GET", url: `${base(A, noKey)}/indexnow/key`, headers: asUser(uA) });
    expect(read.json()).toMatchObject({ key: k1.key, contentType: "text/plain; charset=utf-8" });
    const rot = await app.inject({ method: "POST", url: `${base(A, noKey)}/indexnow/key`, headers: asUser(uA), payload: { rotate: true } });
    expect(rot.json()).toMatchObject({ rotated: true, created: false, enabled: false });
    expect(rot.json().key).not.toBe(k1.key);
    // a body with an unknown member is a 400
    expect((await app.inject({ method: "POST", url: `${base(A, noKey)}/indexnow/key`, headers: asUser(uA), payload: { rotate: true, junk: 1 } })).statusCode).toBe(400);
    expect(net.calls).toEqual([]); // generating a key is not a network event
  });

  it("enabling is REFUSED until the key file is served by the site, with a typed reason, and changes nothing", async () => {
    const id = await mkProp(A, clientA, "proof.example.com");
    // no key yet
    const nokey = await app.inject({ method: "PATCH", url: `${base(A, id)}/indexnow`, headers: asUser(uA), payload: { enabled: true } });
    expect([nokey.statusCode, nokey.json().reason]).toEqual([409, "indexnow_key_missing"]);
    // unverified property
    const un = await app.inject({ method: "PATCH", url: `${base(A, unverified)}/indexnow`, headers: asUser(uA), payload: { enabled: true } });
    expect([un.statusCode, un.json().reason]).toEqual([409, "property_not_verified"]);

    const k = (await app.inject({ method: "POST", url: `${base(A, id)}/indexnow/key`, headers: asUser(uA), payload: {} })).json().key as string;
    const attempt = () => app.inject({ method: "PATCH", url: `${base(A, id)}/indexnow`, headers: asUser(uA), payload: { enabled: true } });

    net.keyFile = { status: 404, body: "not found" };
    const r404 = await attempt();
    expect([r404.statusCode, r404.json().reason, r404.json().existing.check]).toEqual([409, "indexnow_key_file_unreachable", "not_found"]);
    expect(r404.json().existing.location).toBe(`https://proof.example.com/${k}.txt`);
    net.keyFile = { status: 200, body: "some-other-key-entirely" };
    const rBad = await attempt();
    expect([rBad.statusCode, rBad.json().existing.check]).toEqual([409, "key_mismatch"]);
    net.keyFile = { status: 200, body: `<html>${k}</html>` };
    expect((await attempt()).json().existing.check).toBe("key_mismatch");
    expect(await prop(id)).toMatchObject({ enabled: false, verifiedAt: null }); // nothing changed

    // a private host never gets a request
    useDeps();
    setIndexNowDepsForTests({ env: { SEARCH_INDEXNOW_ENABLED: "1" }, fetchImpl: fakeFetch as never, resolve: async () => ["10.0.0.7"] });
    net.calls.length = 0;
    const priv = await attempt();
    expect([priv.statusCode, priv.json().existing.check]).toEqual([409, "host_not_public"]);
    expect(net.calls).toEqual([]);

    // the site serves the key: it is enabled, with the proof recorded
    useDeps();
    net.keyFile = { status: 200, body: k };
    const ok = await attempt();
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ propertyId: id, enabled: true });
    expect(net.calls.at(-1)).toMatchObject({ url: `https://proof.example.com/${k}.txt`, method: "GET" });
    const p = await prop(id);
    expect(p.enabled).toBe(true);
    expect(p.verifiedAt).not.toBeNull();
    // disabling always works and keeps the key
    const off = await app.inject({ method: "PATCH", url: `${base(A, id)}/indexnow`, headers: asUser(uA), payload: { enabled: false } });
    expect(off.json()).toMatchObject({ enabled: false });
    expect((await prop(id)).key).toBe(k);
  });

  it("the database refuses 'enabled' without a key and a proof (the CHECK is the backstop)", async () => {
    await expect(withTenants([A], (c) => c.query(`UPDATE search_properties SET indexnow_enabled = true WHERE id = $1`, [unverified]), SEARCH)).rejects.toThrow(/search_properties_indexnow_enabled_needs_proof/);
    await expect(withTenants([A], (c) => c.query(`UPDATE search_properties SET indexnow_key = 'short' WHERE id = $1`, [unverified]), SEARCH)).rejects.toThrow(/search_properties_indexnow_key_format/);
  });

  // ── publish -> ping ────────────────────────────────────────────────────────────────────────────
  describe("publish -> ping", () => {
    let key: string;
    beforeAll(async () => { key = await enable(main, "idx.example.com"); });
    const item = (slug: string, o: Record<string, unknown> = {}) => ({ slug, locale: "en", defaultLocale: "en", routePattern: "/blog/{slug}/", version: 2, ...o });

    it("builds the page URLs, skips an item with no route pattern (with a reason), posts ONE batch with the property's host and key", async () => {
      const d = useDeps({ now: NOW });
      const r = await notifyContentChange(A, {
        domains: ["www.idx.example.com"], transition: "publish", ref: "appr-1",
        items: [item("hello"), item("nopattern", { routePattern: undefined }), item("salam", { locale: "id", routePattern: "/{locale}/blog/{slug}/", version: 1 })],
      }, d);
      expect(r).toMatchObject({ status: "queued", engine: "indexnow", propertyId: main, urls: 2, duplicates: 0, skipped: [{ itemIndex: 1, reason: "no_route_pattern" }] });
      expect(r.dispatch).toMatchObject({ sent: 2, retrying: 0, rejected: 0 });
      expect(indexnowPosts()).toHaveLength(1);
      expect(indexnowPosts()[0]!.body).toEqual({
        host: "idx.example.com", key, keyLocation: `https://idx.example.com/${key}.txt`,
        urlList: ["https://idx.example.com/blog/hello/", "https://idx.example.com/id/blog/salam/"],
      });
      const got = await rows(main, "AND version LIKE 'publish:%:appr-1'");
      expect(got.map((x) => [x.url, x.status, x.attempts, x.httpStatus, x.transition])).toEqual([
        ["https://idx.example.com/blog/hello/", "sent", 1, 200, "publish"],
        ["https://idx.example.com/id/blog/salam/", "sent", 1, 200, "publish"],
      ]);
      expect(got.map((x) => x.version)).toEqual(["publish:v2:appr-1", "publish:v1:appr-1"]); // in URL order
    });

    it("is IDEMPOTENT per (property, url, version): the same event again inserts nothing and sends nothing", async () => {
      const d = useDeps({ now: NOW });
      const ev = { domains: ["idx.example.com"], transition: "publish" as const, ref: "appr-1", items: [item("hello")] };
      const before = (await rows(main)).length;
      const again = await notifyContentChange(A, ev, d);
      expect(again).toMatchObject({ status: "queued", urls: 1, duplicates: 1 });
      expect(again.dispatch).toBeUndefined();
      expect(indexnowPosts()).toHaveLength(0);
      expect((await rows(main)).length).toBe(before);
      // a DIFFERENT event for the same page and version is a new fact: it is sent
      const other = await notifyContentChange(A, { ...ev, ref: "appr-2" }, d);
      expect(other.duplicates).toBe(0);
      expect(indexnowPosts()).toHaveLength(1);
      // an unpublish of the same page is its own row
      const un = await notifyContentChange(A, { ...ev, transition: "unpublish", ref: "appr-2" }, d);
      expect(un.duplicates).toBe(0);
      expect((await rows(main, "AND transition = 'unpublish'")).map((x) => x.status)).toEqual(["sent"]);
    });

    it("the notify ROUTE: items in, URLs out, a retry within the hour is a duplicate (no ref = the UTC hour names the event)", async () => {
      useDeps({ now: NOW });
      const body = { transition: "publish", items: [{ slug: "routecheck", locale: "en", defaultLocale: "en", routePattern: "/blog/{slug}/", version: 9 }, { slug: "nopat", locale: "en", defaultLocale: "en", version: 1 }] };
      const first = await app.inject({ method: "POST", url: `${base(A, main)}/indexnow/notify`, headers: asUser(uA), payload: body });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ status: "queued", urls: 1, duplicates: 0, skipped: [{ itemIndex: 1, reason: "no_route_pattern" }] });
      expect(indexnowPosts()).toHaveLength(1);
      const again = await app.inject({ method: "POST", url: `${base(A, main)}/indexnow/notify`, headers: asUser(uA), payload: body });
      expect(again.json()).toMatchObject({ status: "queued", duplicates: 1 });
      expect(indexnowPosts()).toHaveLength(1); // nothing sent the second time
      expect((await app.inject({ method: "POST", url: `${base(A, main)}/indexnow/notify`, headers: asUser(uA), payload: { transition: "later", items: body.items } })).statusCode).toBe(400);
    });

    it("sends big changes in batches of 500", async () => {
      const d = useDeps({ now: NOW });
      const items = Array.from({ length: 1200 }, (_, i) => item(`bulk-${String(i).padStart(4, "0")}`));
      const r = await notifyContentChange(A, { propertyId: main, transition: "publish", ref: "bulk", items }, d);
      expect(r.dispatch).toMatchObject({ sent: 1200 });
      expect(indexnowPosts().map((c) => (c.body as { urlList: string[] }).urlList.length)).toEqual([500, 500, 200]);
    });

    it("says why nothing was sent: unknown site, unverified property, IndexNow not enabled, no routable page", async () => {
      const d = useDeps({ now: NOW });
      expect((await notifyContentChange(A, { domains: ["nobody.example.net"], transition: "publish", items: [item("a")] }, d)).status).toBe("no_property");
      expect((await notifyContentChange(A, { propertyId: unverified, transition: "publish", items: [item("a")] }, d)).status).toBe("property_not_verified");
      expect((await notifyContentChange(A, { propertyId: noKey, transition: "publish", items: [item("a")] }, d)).status).toBe("not_enabled");
      const none = await notifyContentChange(A, { propertyId: main, transition: "publish", ref: "np", items: [item("a", { routePattern: undefined })] }, d);
      expect(none).toMatchObject({ status: "nothing_to_send", skipped: [{ itemIndex: 0, reason: "no_route_pattern" }] });
      expect(net.calls).toEqual([]);
    });

    it("a failure is retried with backoff by the sweep, a refusal is not, and the retries run out", async () => {
      net.indexnowStatus = 503;
      let d = useDeps({ now: NOW });
      const r = await notifyContentChange(A, { propertyId: main, transition: "publish", ref: "retry-1", items: [item("flaky")] }, d);
      expect(r.dispatch).toMatchObject({ sent: 0, retrying: 1 });
      const row = (await rows(main, "AND version LIKE '%:retry-1'"))[0]!;
      expect([row.status, row.attempts, row.errorCode, row.httpStatus]).toEqual(["failed", 1, "http_503", 503]);
      expect(new Date(row.nextAt).getTime()).toBe(addMs(NOW, 60_000).getTime()); // one minute of backoff

      // too early: nothing is due, nothing is sent
      net.calls.length = 0;
      d = useDeps({ now: addMs(NOW, 30_000) });
      expect(await runIndexNowSweep(d)).toMatchObject({ sent: 0 });
      expect(indexnowPosts()).toHaveLength(0);

      // due, and the engine recovered: the SAME row is sent, once
      net.indexnowStatus = 200;
      d = useDeps({ now: addMs(NOW, 2 * 60_000) });
      expect(await runIndexNowSweep(d)).toMatchObject({ sent: 1 });
      expect(indexnowPosts()).toHaveLength(1);
      const done = (await rows(main, "AND version LIKE '%:retry-1'"))[0]!;
      expect([done.status, done.attempts]).toEqual(["sent", 2]);
      expect(await runIndexNowSweep(d)).toMatchObject({ sent: 0 }); // nothing left to send

      // a 403 (bad key) is REJECTED: never retried
      net.indexnowStatus = 403;
      d = useDeps({ now: NOW });
      await notifyContentChange(A, { propertyId: main, transition: "publish", ref: "reject-1", items: [item("refused")] }, d);
      const rej = (await rows(main, "AND version LIKE '%:reject-1'"))[0]!;
      expect([rej.status, rej.errorCode]).toEqual(["rejected", "http_403"]);
      net.calls.length = 0;
      await runIndexNowSweep(useDeps({ now: addMs(NOW, 24 * 3600_000) }));
      expect(indexnowPosts()).toHaveLength(0);

      // an engine that never recovers: gave_up after 6 attempts
      net.indexnowStatus = 500;
      let t = NOW;
      await notifyContentChange(A, { propertyId: main, transition: "publish", ref: "dead-1", items: [item("dead")] }, useDeps({ now: t }));
      for (let i = 0; i < 8; i++) { t = addMs(t, 7 * 3600_000); await runIndexNowSweep(useDeps({ now: t })); }
      const dead = (await rows(main, "AND version LIKE '%:dead-1'"))[0]!;
      expect([dead.status, dead.attempts]).toEqual(["gave_up", 6]);
      // the ledger holds ids, URLs of the client's own pages and typed tokens: no response body
      expect(JSON.stringify(await rows(main))).not.toContain("must never surface");
    });

    it("the rolling daily cap defers instead of dropping", async () => {
      const id = await mkProp(A, clientA, "cap.example.com");
      const k = await enable(id, "cap.example.com");
      await withTenants([A], (c) => c.query(
        `INSERT INTO search_indexnow_submissions (tenant_id, property_id, engine, url, url_hash, version, transition, status, attempts, sent_at, next_attempt_at)
         SELECT $1::uuid, $2::uuid, 'indexnow', 'https://cap.example.com/old/' || g, md5(g::text) || md5(g::text), 'publish:v1:seed', 'publish', 'sent', 1, $3::timestamptz, $3::timestamptz FROM generate_series(1, 5000) g`,
        [A, id, NOW]), SEARCH);
      net.calls.length = 0;
      const d = useDeps({ now: NOW });
      const r = await notifyContentChange(A, { propertyId: id, transition: "publish", ref: "cap-1", items: [item("late")] }, d);
      expect(r.dispatch).toMatchObject({ sent: 0, deferred: 1 });
      expect(indexnowPosts()).toHaveLength(0);
      const row = (await rows(id, "AND version LIKE '%:cap-1'"))[0]!;
      expect(row.status).toBe("pending");
      expect(new Date(row.nextAt).getTime()).toBe(addMs(NOW, 3600_000).getTime());
      expect(k).toBeTruthy();
    });

    it("manual submit: only this property's own URLs, 100 per call, 300 per hour (429), idempotent within the hour", async () => {
      const id = await mkProp(A, clientA, "manual.example.com");
      await enable(id, "manual.example.com");
      useDeps(); // the real clock: the hourly limit compares with the rows' database timestamps
      const post = (urls: unknown) => app.inject({ method: "POST", url: `${base(A, id)}/indexnow/submit`, headers: asUser(uA), payload: { urls } });
      const mixed = await post(["/a/", "https://manual.example.com/b/", "https://evil.example.org/c/", "javascript:alert(1)"]);
      expect(mixed.statusCode).toBe(200);
      expect(mixed.json()).toMatchObject({ engine: "indexnow", accepted: 2, duplicates: 0 });
      expect(mixed.json().rejected).toEqual([{ index: 2, reason: "wrong_host" }, { index: 3, reason: "bad_scheme" }]);
      expect(indexnowPosts().at(-1)!.body).toMatchObject({ urlList: ["https://manual.example.com/a/", "https://manual.example.com/b/"] });
      const again = await post(["/a/"]);
      expect(again.json()).toMatchObject({ accepted: 1, duplicates: 1 });
      const none = await post(["https://evil.example.org/x"]);
      expect([none.statusCode, none.json().reason]).toEqual([400, "url_not_on_property"]);
      expect(none.json().existing.rejected).toEqual([{ index: 0, reason: "wrong_host" }]);
      expect((await post([])).statusCode).toBe(400);
      expect((await post(Array.from({ length: 101 }, (_, i) => `/p${i}/`))).statusCode).toBe(400);
      for (let batch = 0; batch < 2; batch++) expect((await post(Array.from({ length: 100 }, (_, i) => `/b${batch}-${i}/`))).statusCode).toBe(200);
      // 2 + 200 so far; 100 more would make 302 > 300
      const limited = await post(Array.from({ length: 100 }, (_, i) => `/c-${i}/`));
      expect([limited.statusCode, limited.json().reason]).toEqual([429, "rate_limited"]);
    });

    it("the WebDesk hook: an executed approved publish pings once; a redelivery sends nothing", async () => {
      const id = await mkProp(A, clientA, "hook.example.com");
      await enable(id, "hook.example.com");
      const d = useDeps({ now: NOW });
      const ev = (): OutboxEvent => ({
        id: "evt-1", tenantId: A, entityType: "automation_approval", entityId: "11111111-aaaa-4bbb-8ccc-111111111111", eventType: "automation_approval.decided",
        payload: { decision: "approved", origin: "webdesk", workflowId: "content.publish", toolArgs: { command: "content.publish", tenantSlug: "hook", siteId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", items: [{ itemId: "11111111-2222-4333-8444-555555555555", version: 4 }] } },
        originSite: "central", schemaVersion: 1, createdAt: NOW.toISOString(),
      });
      const resolver = { resolve: vi.fn(async () => ({ domains: ["hook.example.com"], notLive: 0, items: [{ slug: "launch", locale: "en", defaultLocale: "en", routePattern: "/blog/{slug}/", localized: true, version: 4 }] })) };
      const deps = { ...d, resolver, executionStatus: async () => "executed" };
      expect(await handlePublishApprovalDecided(ev(), deps)).toBe("queued");
      expect(indexnowPosts()).toHaveLength(1);
      expect(indexnowPosts()[0]!.body).toMatchObject({ urlList: ["https://hook.example.com/blog/launch/"] });
      expect((await rows(id)).map((x) => [x.status, x.version])).toEqual([["sent", "publish:v4:11111111-aaaa-4bbb-8ccc-111111111111"]]);
      net.calls.length = 0;
      expect(await handlePublishApprovalDecided(ev(), deps)).toBe("queued"); // redelivered by the bus
      expect(indexnowPosts()).toHaveLength(0);
      expect((await rows(id)).length).toBe(1);
    });
  });

  // ── Bing ───────────────────────────────────────────────────────────────────────────────────────
  describe("Bing Webmaster", () => {
    it("SIMULATE (the default): connect seals the key, pull writes simulated rows idempotently, nothing leaves the process, disconnect revokes", async () => {
      const id = await mkProp(A, clientA, "bing-sim.example.com");
      useDeps({ now: NOW });
      const bad = await app.inject({ method: "POST", url: `${base(A, id)}/bing`, headers: asUser(uA), payload: { apiKey: "short" } });
      expect([bad.statusCode, bad.json().reason]).toEqual([400, "bing_key_malformed"]);
      const c = await app.inject({ method: "POST", url: `${base(A, id)}/bing`, headers: asUser(uA), payload: { apiKey: BING_KEY } });
      expect(c.statusCode).toBe(200);
      expect(c.json()).toMatchObject({ propertyId: id, mode: "simulate", verifiedWithBing: false });
      expect(JSON.stringify(c.json())).not.toContain(BING_KEY);
      const conn = (await withTenants([A], (cl) => cl.query(`SELECT provider, owner_kind, owner_id, status, access_token_enc FROM integration_connections WHERE id = $1`, [c.json().connectionId]))).rows[0];
      expect(conn).toMatchObject({ provider: "bing_webmaster", owner_kind: "client", owner_id: clientA, status: "linked" });
      expect(conn.access_token_enc).toMatch(/^enc:v1:/);
      expect(conn.access_token_enc).not.toContain(BING_KEY);
      expect((await prop(id)).bing).toBe(c.json().connectionId);

      const pull = await app.inject({ method: "POST", url: `${base(A, id)}/bing/pull`, headers: asUser(uA), payload: { days: 7 } });
      expect(pull.statusCode).toBe(200);
      expect(pull.json()).toMatchObject({ mode: "simulate", simulated: true, window: { from: "2026-10-06", to: "2026-10-12" }, fetched: 42, written: 42 });
      const pull2 = await app.inject({ method: "POST", url: `${base(A, id)}/bing/pull`, headers: asUser(uA), payload: { days: 7 } });
      expect(pull2.json()).toMatchObject({ fetched: 42 });
      const count = async () => Number((await withTenants([A], (cl) => cl.query(`SELECT count(*) AS n FROM search_bing_performance WHERE property_id = $1`, [id]), SEARCH)).rows[0].n);
      expect(await count()).toBe(42); // a re-pull converges, never duplicates
      expect((await app.inject({ method: "POST", url: `${base(A, id)}/bing/pull`, headers: asUser(uA), payload: { days: 0 } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: `${base(A, id)}/bing/pull`, headers: asUser(uA), payload: { days: 181 } })).statusCode).toBe(400);

      const st = await app.inject({ method: "GET", url: `${base(A, id)}/bing`, headers: asUser(uA) });
      expect(st.json()).toMatchObject({ connected: true, mode: "simulate", rows: { real: 0, simulated: 42 } });
      const list = await app.inject({ method: "GET", url: `${base(A, id)}/bing/performance?kind=page&from=2026-10-06&to=2026-10-12&limit=5`, headers: asUser(uA) });
      expect(list.statusCode).toBe(200);
      expect(list.json().rows).toHaveLength(5);
      expect(list.json().rows.every((r: { kind: string; simulated: boolean }) => r.kind === "page" && r.simulated === true)).toBe(true);
      const range = await app.inject({ method: "GET", url: `${base(A, id)}/bing/performance/query/2026-10-06/2026-10-12`, headers: asUser(uA) });
      expect(range.json().totals.impressions).toBeGreaterThan(0);
      expect((await app.inject({ method: "GET", url: `${base(A, id)}/bing/performance?kind=nope`, headers: asUser(uA) })).statusCode).toBe(400);
      expect(net.calls).toEqual([]); // not one request to Bing

      const del = await app.inject({ method: "DELETE", url: `${base(A, id)}/bing`, headers: asUser(uA) });
      expect(del.json()).toMatchObject({ disconnected: true, revoked: true });
      const after = (await withTenants([A], (cl) => cl.query(`SELECT status, access_token_enc FROM integration_connections WHERE id = $1`, [c.json().connectionId]))).rows[0];
      expect(after).toMatchObject({ status: "revoked", access_token_enc: null });
      expect((await prop(id)).bing).toBeNull();
      const gone = await app.inject({ method: "POST", url: `${base(A, id)}/bing/pull`, headers: asUser(uA), payload: {} });
      expect([gone.statusCode, gone.json().reason]).toEqual([409, "bing_not_connected"]);
    });

    it("LIVE: a connect is proven against the account first; the key goes only to ssl.bing.com; a pull stores real rows", async () => {
      const id = await mkProp(A, clientA, "bing-live.example.com");
      useDeps({ now: NOW, bingLive: true });
      const connect = () => app.inject({ method: "POST", url: `${base(A, id)}/bing`, headers: asUser(uA), payload: { apiKey: BING_KEY } });
      const conns = async () => Number((await withTenants([A], (cl) => cl.query(`SELECT count(*) AS n FROM integration_connections WHERE provider = 'bing_webmaster' AND owner_id = $1 AND status = 'linked' AND meta->>'siteOrigin' = 'https://bing-live.example.com'`, [clientA]))).rows[0].n);
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

      net.bing = () => json({}, 401);
      let r = await connect();
      expect([r.statusCode, r.json().reason]).toEqual([409, "bing_key_rejected"]);
      net.bing = () => json({ d: [{ Url: "https://other.example.com/", IsVerified: true }] });
      r = await connect();
      expect([r.statusCode, r.json().reason]).toEqual([409, "bing_site_not_in_account"]);
      net.bing = () => json({ d: [{ Url: "https://bing-live.example.com/", IsVerified: false }] });
      r = await connect();
      expect([r.statusCode, r.json().reason]).toEqual([409, "bing_site_not_verified"]);
      net.bing = () => json({}, 503);
      r = await connect();
      expect([r.statusCode, r.json().reason]).toEqual([502, "bing_unreachable"]);
      expect(await conns()).toBe(0); // nothing was stored by any refusal
      expect(JSON.stringify(r.json())).not.toContain(BING_KEY);
      for (const c of net.calls) expect(c.url.startsWith("https://ssl.bing.com/webmaster/api.svc/json/")).toBe(true);

      net.bing = () => json({ d: [{ Url: "https://bing-live.example.com/", IsVerified: true }] });
      r = await connect();
      expect(r.json()).toMatchObject({ mode: "live", verifiedWithBing: true });
      expect(await conns()).toBe(1);

      const day = (iso: string) => `/Date(${Date.parse(`${iso}T00:00:00Z`)})/`;
      net.bing = (u) => {
        const m = u.pathname.split("/").pop();
        if (m === "GetQueryStats") return json({ d: [
          { Query: "gaiada", Date: day("2026-10-10"), Clicks: 4, Impressions: 50, AvgClickPosition: 3.2, AvgImpressionPosition: 6.1 },
          { Query: "too old", Date: day("2025-01-01"), Clicks: 9, Impressions: 99 },
        ] });
        if (m === "GetPageStats") return json({ d: [{ Query: "https://bing-live.example.com/", Date: day("2026-10-11"), Clicks: 2, Impressions: 20 }] });
        return json({}, 404);
      };
      net.calls.length = 0;
      const pull = await app.inject({ method: "POST", url: `${base(A, id)}/bing/pull`, headers: asUser(uA), payload: { days: 28 } });
      expect(pull.json()).toMatchObject({ mode: "live", simulated: false, fetched: 2, written: 2 }); // the out-of-window row is dropped
      for (const c of net.calls) {
        const u = new URL(c.url);
        expect(u.origin).toBe("https://ssl.bing.com");
        expect(u.searchParams.get("apikey")).toBe(BING_KEY);
        expect(u.searchParams.get("siteUrl")).toBe("https://bing-live.example.com/");
      }
      const got = (await withTenants([A], (cl) => cl.query(`SELECT kind, key, clicks, simulated FROM search_bing_performance WHERE property_id = $1 ORDER BY kind`, [id]), SEARCH)).rows;
      expect(got).toEqual([{ kind: "page", key: "https://bing-live.example.com/", clicks: 2, simulated: false }, { kind: "query", key: "gaiada", clicks: 4, simulated: false }]);
      // a key Bing no longer accepts is a typed 409, not a 500
      net.bing = () => json({}, 403);
      const rej = await app.inject({ method: "POST", url: `${base(A, id)}/bing/pull`, headers: asUser(uA), payload: {} });
      expect([rej.statusCode, rej.json().reason]).toEqual([409, "bing_key_rejected"]);
    });

    it("the non-IndexNow fallback: with only Bing connected, a publish is submitted through the URL Submission API (simulated by default: no call)", async () => {
      const id = await mkProp(A, clientA, "bing-fallback.example.com");
      useDeps({ now: NOW });
      await app.inject({ method: "POST", url: `${base(A, id)}/bing`, headers: asUser(uA), payload: { apiKey: BING_KEY } });
      const it1 = { slug: "news", locale: "en", defaultLocale: "en", routePattern: "/blog/{slug}/", version: 1 };
      let r = await notifyContentChange(A, { propertyId: id, transition: "publish", ref: "bf-1", items: [it1] }, useDeps({ now: NOW }));
      expect(r).toMatchObject({ status: "queued", engine: "bing" });
      expect(net.calls).toEqual([]);
      expect((await rows(id)).map((x) => [x.engine, x.status, x.simulated])).toEqual([["bing", "sent", true]]);
      // LIVE: quota is read, then SubmitUrlBatch carries the property's own URLs
      net.bing = (u) => new Response(JSON.stringify(u.pathname.endsWith("GetUrlSubmissionQuota") ? { d: { DailyQuota: 100, MonthlyQuota: 3000 } } : { d: null }), { status: 200 });
      r = await notifyContentChange(A, { propertyId: id, transition: "publish", ref: "bf-2", items: [it1] }, useDeps({ now: NOW, bingLive: true }));
      expect(r.dispatch).toMatchObject({ sent: 1 });
      const submit = net.calls.find((c) => c.url.includes("SubmitUrlBatch"));
      expect(submit?.body).toEqual({ siteUrl: "https://bing-fallback.example.com/", urlList: ["https://bing-fallback.example.com/blog/news/"] });
      expect(net.calls.some((c) => c.url.includes("GetUrlSubmissionQuota"))).toBe(true);
      // an exhausted daily quota defers, never drops
      net.bing = (u) => new Response(JSON.stringify(u.pathname.endsWith("GetUrlSubmissionQuota") ? { d: { DailyQuota: 0, MonthlyQuota: 3000 } } : { d: null }), { status: 200 });
      r = await notifyContentChange(A, { propertyId: id, transition: "publish", ref: "bf-3", items: [it1] }, useDeps({ now: NOW, bingLive: true }));
      expect(r.dispatch).toMatchObject({ sent: 0, deferred: 1 });
      expect((await rows(id, "AND version LIKE '%:bf-3'"))[0]).toMatchObject({ status: "pending", errorCode: "quota" });
    });
  });

  // ── authorization, tenancy ─────────────────────────────────────────────────────────────────────
  describe("authorization and tenancy", () => {
    const WRITES: Array<{ name: string; method: "POST" | "PATCH" | "DELETE"; path: string; payload?: unknown }> = [
      { name: "generate key", method: "POST", path: "/indexnow/key", payload: {} },
      { name: "enable/disable", method: "PATCH", path: "/indexnow", payload: { enabled: false } },
      { name: "manual submit", method: "POST", path: "/indexnow/submit", payload: { urls: ["/x/"] } },
      { name: "notify", method: "POST", path: "/indexnow/notify", payload: { transition: "publish", items: [{ slug: "a", locale: "en", defaultLocale: "en" }] } },
      { name: "bing connect", method: "POST", path: "/bing", payload: { apiKey: BING_KEY } },
      { name: "bing disconnect", method: "DELETE", path: "/bing" },
      { name: "bing pull", method: "POST", path: "/bing/pull", payload: {} },
    ];
    const READS = ["/indexnow", "/indexnow/key", "/bing", "/bing/performance", "/bing/performance/all/2026-10-01/2026-10-12"];

    it("every write is gated by resource_search_property · update and a denial (valid request) is a 403 that does nothing", async () => {
      const id = await mkProp(A, clientA, "authz.example.com");
      useDeps({ now: NOW });
      for (const w of WRITES) {
        calls.length = 0; net.calls.length = 0; denyAll = true;
        const denied = await app.inject({ method: w.method, url: base(A, id) + w.path, headers: asUser(uA), ...(w.payload !== undefined ? { payload: w.payload as never } : {}) });
        expect(denied.statusCode, `${w.name}: denied`).toBe(403);
        expect(calls, w.name).toContainEqual({ kind: "resource_search_property", action: "update", tenantId: A });
        expect(net.calls, `${w.name}: no network on a denial`).toEqual([]);
        // positive control: the SAME request, allowed, is not a 403 (it may be a typed 409 for state, never an authz refusal)
        denyAll = false; calls.length = 0;
        const allowed = await app.inject({ method: w.method, url: base(A, id) + w.path, headers: asUser(uA), ...(w.payload !== undefined ? { payload: w.payload as never } : {}) });
        expect(allowed.statusCode, `${w.name}: allowed (${allowed.body.slice(0, 120)})`).toBeLessThan(500);
        expect(allowed.statusCode, `${w.name}: control`).not.toBe(403);
        expect(allowed.statusCode, `${w.name}: control`).not.toBe(400);
        expect(calls, w.name).toContainEqual({ kind: "resource_search_property", action: "update", tenantId: A });
      }
      // nothing the denied calls attempted landed
      expect((await prop(id)).bing).toBeNull(); // the allowed connect ran, then the allowed disconnect undid it
    });

    it("every read is gated by resource_search_property · read", async () => {
      for (const p of READS) {
        calls.length = 0; denyAll = true;
        const denied = await app.inject({ method: "GET", url: base(A, main) + p, headers: asUser(uA) });
        expect(denied.statusCode, p).toBe(403);
        expect(calls, p).toContainEqual({ kind: "resource_search_property", action: "read", tenantId: A });
        denyAll = false;
        const ok = await app.inject({ method: "GET", url: base(A, main) + p, headers: asUser(uA) });
        expect([200, 404], `${p} control`).toContain(ok.statusCode); // 404 only for the key of a property with none
      }
    });

    it("authorization runs BEFORE the body: a denied caller gets 403 for an invalid body too, an allowed one 400", async () => {
      denyAll = true;
      const denied = await app.inject({ method: "POST", url: `${base(A, main)}/indexnow/submit`, headers: asUser(uA), payload: { urls: "not-an-array", junk: 1 } });
      expect(denied.statusCode).toBe(403);
      denyAll = false;
      const allowed = await app.inject({ method: "POST", url: `${base(A, main)}/indexnow/submit`, headers: asUser(uA), payload: { urls: "not-an-array", junk: 1 } });
      expect(allowed.statusCode).toBe(400);
    });

    it("cross-company: another company's user is refused by the tenant wall; A's property id is invisible through C (404); the ledger is invisible to C", async () => {
      useRealCerbos = true;
      const viaA = await app.inject({ method: "GET", url: `${base(A, main)}/indexnow`, headers: asUser(uC) });
      expect(viaA.statusCode).toBe(403);
      const write = await app.inject({ method: "PATCH", url: `${base(A, main)}/indexnow`, headers: asUser(uC), payload: { enabled: false } });
      expect(write.statusCode).toBe(403);
      useRealCerbos = false;
      const viaC = await app.inject({ method: "GET", url: `${base(C, main)}/indexnow`, headers: asUser(uC) });
      expect(viaC.statusCode).toBe(404);
      const viaC2 = await app.inject({ method: "POST", url: `${base(C, main)}/bing/pull`, headers: asUser(uC), payload: {} });
      expect(viaC2.statusCode).toBe(404);
      // and from A's own tenant, C's property is just as invisible
      expect((await app.inject({ method: "GET", url: `${base(A, propC)}/indexnow`, headers: asUser(uA) })).statusCode).toBe(404);
      const seenByC = await withTenants([C], (c) => c.query(`SELECT count(*) AS n FROM search_indexnow_submissions`), SEARCH);
      expect(Number(seenByC.rows[0].n)).toBe(0);
      const seenByA = await withTenants([A], (c) => c.query(`SELECT count(*) AS n FROM search_indexnow_submissions`), SEARCH);
      expect(Number(seenByA.rows[0].n)).toBeGreaterThan(0);
    });
  });
});
