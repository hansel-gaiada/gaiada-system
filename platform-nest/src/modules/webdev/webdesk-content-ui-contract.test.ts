// WSK-44b — "re-verified against the REAL BFF": the Website editor's own code (platform-ui `lib/webdeskContent.ts`,
// `lib/webdeskContentActions.ts`) driven against the REAL WSK-59 controller.
//
// WHY THIS EXISTS. This estate's recurring bug is "frontend-first drift": a UI reads a field the backend never sends,
// renders a confident wrong answer, and nothing throws. WSK-44 was written against a stub transcribed from the design;
// WSK-59 then built the real thing. This file closes the gap with evidence: every route the UI calls is driven through
// the UI's REAL egress (`platformFetch` over a real socket), the REAL controller, REAL Postgres (RLS, the approval rows,
// the activities ledger) and REAL Cerbos, with the strict in-process Zone B fake (`webdesk-content-testkit.ts`, whose read
// shapes were re-diffed against `webdesk/api/src/control/**` in this ticket). Each real response body goes through the
// UI's REAL `parse*` validators; a body that does not match is `unavailable/contract_drift` and fails the test.
//
// WHICH SIDE THE TEST LIVES ON (the decision this ticket asked to be explained):
//   platform-nest, loading the UI by absolute path at RUN time. The UI package cannot host it: it has four runtime deps
//   and no NestJS/Fastify/pg, and its CI job has no Postgres or Cerbos. Nest already owns all of that (initTestDb,
//   buildApp, the Cerbos container, the fixtures). The UI files are pulled in with a computed dynamic `import()`, NOT a
//   static one, for three reasons: (1) `tsc -p tsconfig.json` (the Nest build) must not follow the import into
//   platform-ui, or it would type-check another package under Nest's options and move `rootDir` up a level, breaking
//   `dist/main.js`; (2) the UI has no dependency on the Nest packages in the other direction; (3) the file is skipped
//   cleanly when platform-ui is not checked out beside platform-nest. The UI files start with `import "server-only"`,
//   which throws outside a react-server build, so `vitest.config.ts` aliases it to an empty stub.
//
// WHAT IS REAL AND WHAT IS NOT. Real: the UI's `platformFetch` (so `PlatformError.body`, `reason`, `existing` are built by
// the real code from the real response), every `parse*`, `problemOf`, `resultFromError`, the readers, and the SERVER
// ACTIONS (`saveItemAction`, `createItemAction`, … : their paths and request bodies are what the real BFF's strict body
// validation judges). Mocked: only the three session seams the actions read (`session-server`'s user id, `tenant`'s
// active company, `platform`'s `getMe`), because there is no browser session here. Stand-in: Zone B (WebDesk) itself.
//
// WSK-46: also the editor's Preview (`previewItemAction` -> `POST …/items/:itemId/preview`, parsed by the STRICT `parsePreviewLink`,
// which refuses anything but an https link to the site's /preview/ page with the token in the fragment) and its refusals.
// 2026-10-11: also the control plane's "Request an API key" (`requestKeyAction` -> `POST …/control/sites/:siteId/keys`) and the
// decide façade's once-only key block (`parseKeyMintDecision`); see the "API keys" describe and the `key-request` route-table entry.
//
// Needs DATABASE_URL_TEST + CERBOS_URL (skips otherwise) and platform-ui's sources beside platform-nest.
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { resetModules } from "../registry";
import { resetCoreRollupProviders } from "../../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { EditorialUnavailableError } from "./webdesk-control-client";
import { setWebdeskApprovedCommandDepsForTests } from "./webdesk-approved-command";
import { webdeskZoneB } from "./webdesk-content.service";
import { setPreviewProbeForTests } from "./webdesk-preview";
import { FakeZoneB, GAIADA_ENV, GAIADA_SITE, GAIADA_SLUG, OTHER_ENV, OTHER_SITE, OTHER_SLUG, makeTestSigner, type FakeItem } from "./webdesk-content-testkit";

const UI_LIB = resolve(__dirname, "../../../../platform-ui/src/lib");
const UI_COMPOSITIONS = resolve(__dirname, "../../../../platform-ui/e2e/webdesk-stub/compositions");
const uiPresent = existsSync(join(UI_LIB, "webdeskContent.ts")) && existsSync(join(UI_COMPOSITIONS, "service.json"));
const live = !!TEST_URL && !!process.env.CERBOS_URL;

// ── the UI, loosely typed on purpose (a type import would drag platform-ui into this package's tsc) ────────────────
type Wd = { kind: string; [k: string]: any };
interface UiContent {
  listSites(u: string, c: string): Promise<Wd>;
  listCollections(u: string, c: string, t: string, s: string): Promise<Wd>;
  listItems(u: string, c: string, t: string, s: string, collection: string, q?: Record<string, unknown>): Promise<Wd>;
  getItem(u: string, c: string, t: string, s: string, id: string, v?: "head" | "live" | number): Promise<Wd>;
  listVersions(u: string, c: string, t: string, s: string, id: string): Promise<Wd>;
  getVersion(u: string, c: string, t: string, s: string, id: string, n: number): Promise<Wd>;
  getBuildStatus(u: string, c: string, t: string, s: string): Promise<Wd>;
  loadSiteContext(u: string, c: string, t: string, s: string): Promise<Wd>;
  resolveItemBySlug(u: string, c: string, t: string, s: string, collection: string, slug: string, locale: string): Promise<Wd>;
  listOwnPublishRequests(u: string, c: string, t: string, s: string, status?: string): Promise<Wd>;
  findPendingPublishRequests(u: string, c: string, t: string, s: string, itemId: string): Promise<Wd>;
  getApprovalRow(u: string, c: string, id: string): Promise<Wd>;
  stagingBaseUrl(site: unknown): string | null;
  wdCall(path: string, u: string, parse: (raw: unknown) => unknown, init?: RequestInit): Promise<Wd>;
  siteBase(c: string, t: string, s: string): string;
  problemOf(e: unknown): { slug: string | null; message: string; ext: Record<string, any> };
  resultFromError(e: unknown): Wd;
  WireDrift: new (...a: any[]) => Error;
  [parser: string]: any;
}
interface UiActions {
  saveItemAction(scope: Scope, itemId: string, input: Record<string, unknown>): Promise<Wd>;
  createItemAction(scope: Scope, input: Record<string, unknown>): Promise<Wd>;
  restoreVersionAction(scope: Scope, itemId: string, version: number, baseVersion: number, note?: string): Promise<Wd>;
  unpublishItemAction(scope: Scope, itemId: string, expected: number): Promise<Wd>;
  deleteItemAction(scope: Scope, itemId: string, baseVersion: number): Promise<Wd>;
  requestPublishAction(scope: Scope, items: { itemId: string; version: number }[], publishAt?: string | null): Promise<Wd>;
  withdrawPublishRequestAction(scope: Scope, approvalId: string): Promise<Wd>;
  requestRebuildAction(scope: Scope): Promise<Wd>;
  requestKeyAction(scope: Scope, envId: string, keyScope: string): Promise<Wd>;
  previewItemAction(scope: Scope, itemId: string, version?: number): Promise<Wd>;
  pollApprovalAction(scope: Scope, approvalId: string): Promise<Wd>;
  pollBuildStatusAction(scope: Scope): Promise<Wd>;
  getItemHeadAction(scope: Scope, itemId: string): Promise<Wd>;
  refreshEditorAction(scope: Scope, collectionKey: string, slug: string, locale: string): Promise<Wd>;
}
interface UiModel {
  phaseOf(row: Record<string, unknown>): { phase: string; [k: string]: unknown };
  [helper: string]: any;
}
interface UiPlatform {
  platformFetch<T>(path: string, userId: string, init?: RequestInit): Promise<T>;
  PlatformError: new (...a: any[]) => Error & { status: number; body?: unknown; reason?: string };
}
type Scope = { tenantSlug: string; siteId: string };

// ── the traffic recorder: every request the UI makes to the real controller, with the real response body ──────────
interface Rec { method: string; path: string; status: number; body: unknown; user: string }
const recs: Rec[] = [];
const evidence: Array<{ step: string; http: string[]; ui: string }> = [];
/** route label → the key paths whose absence from a real body makes the UI's parser throw (what the UI REQUIRES). */
const fieldsRequired = new Map<string, string[]>();

const STRIP = (p: string) => p.split("?")[0];
/** Route label + the UI parser that must accept its 2xx body (null: the UI has no reader for it). */
function routeOf(method: string, rawPath: string): { label: string; parser: string | null } | null {
  const p = STRIP(rawPath);
  const m = (re: RegExp) => re.test(p);
  const base = /^\/api\/[^/]+\/modules\/webdev\/content/;
  // The control plane's key-request filing (not a content route): `POST …/control/sites/:siteId/keys`.
  if (/^\/api\/[^/]+\/modules\/webdev\/control\/sites\/[^/]+\/keys$/.test(p)) return method === "POST" ? { label: "key-request", parser: "parseKeyRequest" } : null;
  if (!base.test(p) && !/^\/api\/[^/]+\/automation-approvals\/[^/]+$/.test(p)) return null;
  if (m(/\/automation-approvals\/[^/]+$/)) return method === "GET" ? { label: "approval.detail", parser: "parseApprovalRow" } : null;
  if (m(/\/content\/sites$/)) return { label: "sites", parser: "parseSites" };
  if (m(/\/collections$/)) return { label: "collections", parser: "parseCollections" };
  if (m(/\/collections\/[^/]+\/items$/)) return method === "GET" ? { label: "items", parser: "parseItemList" } : { label: "create", parser: "parseItemWriteResult" };
  if (m(/\/items\/[^/]+\/versions\/\d+$/)) return { label: "versionGet", parser: "parseVersionFull" };
  if (m(/\/items\/[^/]+\/versions$/)) return { label: "versions", parser: "parseVersionList" };
  if (m(/\/items\/[^/]+\/restore$/)) return { label: "restore", parser: "parseItemWriteResult" };
  if (m(/\/items\/[^/]+\/unpublish$/)) return { label: "unpublish", parser: "parseItemOnly" };
  if (m(/\/items\/[^/]+\/delete$/)) return { label: "delete", parser: "parseItemOnly" };
  if (m(/\/items\/[^/]+\/preview$/)) return { label: "preview", parser: "parsePreviewLink" };
  if (m(/\/items\/[^/]+$/)) return method === "GET" ? { label: "item.get", parser: "parseItemDetail" } : { label: "update", parser: "parseItemWriteResult" };
  if (m(/\/publish-requests\/[^/]+\/withdraw$/)) return { label: "withdraw", parser: "parseWithdraw" };
  if (m(/\/publish-requests$/)) return method === "GET" ? { label: "publish-requests.list", parser: "parsePublishRequests" } : { label: "publish-requests", parser: "parseApprovalId" };
  if (m(/\/media$/)) return { label: "media", parser: null };
  if (m(/\/build-status$/)) return { label: "build-status (WSK-60, not built)", parser: "parseBuildStatus" };
  if (m(/\/rebuild-requests$/)) return { label: "rebuild-requests (WSK-60, not built)", parser: "parseApprovalId" };
  return { label: "?", parser: null };
}

const summarize = (r: Wd): string =>
  r.kind === "ok" ? "ok" : `${r.kind}${r.code ? `/${r.code}` : ""}${r.slug ? `:${r.slug}` : ""}${r.reason ? ` (${r.reason})` : ""}`;

describe.skipIf(!live || !uiPresent)("WSK-44b · the Website editor's code against the REAL WSK-59 controller", () => {
  let app: NestFastifyApplication;
  let A: string;
  let B: string;
  let adminA: string, editorA: string, publisherA: string, memberA: string;
  let zb: FakeZoneB;
  const signer = makeTestSigner();
  const cur = { userId: "", company: "" };
  const previewHead = { status: 200 };
  const prev = { fetch: globalThis.fetch, url: process.env.PLATFORM_URL, token: process.env.PLATFORM_SERVICE_TOKEN, demo: process.env.DEMO_MODE };

  let ui: UiContent;
  let actions: UiActions;
  let model: UiModel;
  let platform: UiPlatform;
  let baseUrl = "";
  const SCOPE: Scope = { tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE };
  const OTHER_SCOPE: Scope = { tenantSlug: OTHER_SLUG, siteId: OTHER_SITE };

  let item: FakeItem; // a DRAFT service page (head v1)
  let live1: FakeItem; // a LIVE service page (published v1)
  let pre: FakeItem; // a PRE-0009 row: head version 0, no version row

  const as = (userId: string) => { cur.userId = userId; cur.company = A; };

  /** One UI call; records which real routes it hit and what the UI made of the answer. */
  async function step(name: string, fn: () => Promise<Wd>): Promise<Wd> {
    const before = recs.length;
    const r = await fn();
    evidence.push({
      step: name,
      http: recs.slice(before).map((c) => `${c.method} ${routeOf(c.method, c.path)?.label ?? c.path} → ${c.status}`),
      ui: summarize(r),
    });
    return r;
  }
  const okData = (r: Wd): any => {
    expect(r, JSON.stringify(r).slice(0, 400)).toMatchObject({ kind: "ok" });
    return r.data;
  };
  /** The REAL `PlatformError` the UI's egress builds for a refusal (for `problemOf`). */
  async function refusal(path: string, userId: string, init: RequestInit = {}) {
    const before = recs.length;
    try {
      await platform.platformFetch(path, userId, init);
    } catch (e) {
      evidence.push({ step: `raw ${init.method ?? "GET"} ${routeOf(init.method ?? "GET", path)?.label ?? path}`, http: recs.slice(before).map((c) => `${c.method} ${c.status}`), ui: `PlatformError ${(e as { status: number }).status}` });
      return e as Error & { status: number; body?: any; reason?: string };
    }
    throw new Error(`expected ${path} to be refused`);
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    A = await createCompany("WSK-44b Co A", ["webdev"]);
    B = await createCompany("WSK-44b Co B", ["webdev"]);
    const mk = async (co: string, email: string, role: string) => {
      const id = await createUser(email);
      await addMembership(co, id);
      await grantRole(id, await createRole(role), "company", co);
      return id;
    };
    adminA = await mk(A, "wsk44b-admin-a@ex.test", "company_admin");
    editorA = await mk(A, "wsk44b-editor-a@ex.test", "webdev_staff");
    publisherA = await mk(A, "wsk44b-publisher-a@ex.test", "webdev_manager");
    memberA = await mk(A, "wsk44b-member-a@ex.test", "member");
    zb = new FakeZoneB(A, B);
    for (const k of ["service", "navigation", "company", "token-registry", "redirect"]) {
      zb.compositions.set(k, JSON.parse(readFileSync(join(UI_COMPOSITIONS, `${k}.json`), "utf8")));
    }
    app = await buildApp();
    await app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    // The UI's own egress points at the real server, on the dev-BFF path (service bearer + x-user-id).
    process.env.PLATFORM_URL = baseUrl;
    process.env.PLATFORM_SERVICE_TOKEN = "svc-token";
    delete process.env.DEMO_MODE;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const res = await prev.fetch(input, init);
      const url = String(input);
      if (url.startsWith(baseUrl)) {
        let body: unknown = null;
        try { body = JSON.parse(await res.clone().text()); } catch { /* not JSON */ }
        recs.push({ method: (init?.method ?? "GET").toUpperCase(), path: url.slice(baseUrl.length), status: res.status, body, user: cur.userId });
      }
      return res;
    }) as typeof fetch;

    // Only the three session seams the server actions read are replaced; everything else is the UI's real code.
    vi.doMock(join(UI_LIB, "session-server.ts"), () => ({ getSessionUserId: async () => cur.userId, getSession: async () => null }));
    vi.doMock(join(UI_LIB, "tenant.ts"), () => ({ getActiveTenant: async () => cur.company }));
    vi.doMock(join(UI_LIB, "platform.ts"), async (importOriginal: () => Promise<Record<string, unknown>>) => ({
      ...(await importOriginal()),
      getMe: async () => ({ id: cur.userId }),
    }));
    // A computed specifier on purpose (see the header): tsc must not follow it, vite-node still transforms the .ts.
    const load = (f: string) => import(/* @vite-ignore */ join(UI_LIB, f));
    ui = (await load("webdeskContent.ts")) as unknown as UiContent;
    actions = (await load("webdeskContentActions.ts")) as unknown as UiActions;
    model = (await load("webdeskContentModel.ts")) as unknown as UiModel;
    platform = (await load("platform.ts")) as unknown as UiPlatform;
  }, 180_000);

  beforeEach(async () => {
    // WSK-60: an unpublish of live content marks staging stale in Postgres, which zb.reset() does not touch.
    await adminPool().query(`DELETE FROM webdev_site_staging_marks WHERE tenant_id = $1`, [A]);
    zb.reset();
    signer.calls.length = 0;
    signer.configured = true;
    webdeskZoneB.clearSiteCache();
    setWebdeskApprovedCommandDepsForTests({ client: zb.asClient(), signer });
    // WSK-46: the site's /preview/ page, as a stub HEAD (the global fetch here is the recorder for the UI's own egress).
    previewHead.status = 200;
    setPreviewProbeForTests({ fetchImpl: (async () => new Response(null, { status: previewHead.status })) as unknown as typeof fetch });
    item = zb.seedItem({ siteId: GAIADA_SITE, slug: "service.seo" });
    live1 = zb.seedItem({ siteId: GAIADA_SITE, slug: "service.live", publishedVersion: 1, publishState: "published" });
    pre = zb.seedPreVersioned({ siteId: GAIADA_SITE, slug: "service.legacy" });
    as(editorA);
  });
  afterEach(() => {
    setWebdeskApprovedCommandDepsForTests(null);
    setPreviewProbeForTests(null);
    process.env.PLATFORM_SERVICE_TOKEN = "svc-token";
  });
  afterAll(async () => {
    globalThis.fetch = prev.fetch;
    if (prev.url === undefined) delete process.env.PLATFORM_URL; else process.env.PLATFORM_URL = prev.url;
    if (prev.token === undefined) delete process.env.PLATFORM_SERVICE_TOKEN; else process.env.PLATFORM_SERVICE_TOKEN = prev.token;
    if (prev.demo !== undefined) process.env.DEMO_MODE = prev.demo;
    vi.doUnmock(join(UI_LIB, "session-server.ts"));
    vi.doUnmock(join(UI_LIB, "tenant.ts"));
    vi.doUnmock(join(UI_LIB, "platform.ts"));
    await app?.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("reads: sites · collections · items · item.get · versions · versionGet · media", () => {
    it("sites: a real tenant list parses, including an environment with `domain: null` (WebDesk's column is nullable)", async () => {
      const r = await step("listSites", () => ui.listSites(editorA, A));
      const tenants = okData(r).tenants;
      expect(tenants.map((t: { slug: string }) => t.slug)).toEqual([GAIADA_SLUG]);
      const envs = tenants[0].sites[0].environments as Array<{ name: string; domain: string | null }>;
      expect(envs.find((e) => e.name === "production")!.domain).toBeNull();
      expect(ui.stagingBaseUrl(tenants[0].sites[0])).toBe("https://staging.gaiada.test"); // a null-domain env never becomes "https://null"
    });

    it("collections: the gaiada.com compositions (service, navigation, company, token-registry, redirect) parse as the UI's FieldDefs", async () => {
      const cols = okData(await step("listCollections", () => ui.listCollections(editorA, A, GAIADA_SLUG, GAIADA_SITE)));
      expect(cols.map((c: { key: string }) => c.key).sort()).toEqual(["company", "navigation", "redirect", "service", "token-registry"]);
      const service = cols.find((c: { key: string }) => c.key === "service");
      expect(service.composition.fields.length).toBeGreaterThan(3);
      expect(service.counts).toMatchObject({ items: 3, live: 1 });
    });

    it("items: the list parses, and the pre-0009 row's `headCreatedAt: null` is accepted (not drift)", async () => {
      const list = okData(await step("listItems", () => ui.listItems(editorA, A, GAIADA_SLUG, GAIADA_SITE, "service", { locale: "en" })));
      const bySlug = new Map<string, any>(list.items.map((i: { slug: string }) => [i.slug, i]));
      expect([...bySlug.keys()].sort()).toEqual(["service.legacy", "service.live", "service.seo"]);
      expect(bySlug.get("service.legacy")).toMatchObject({ headVersion: 0, headCreatedAt: null, headCreatedBy: null, pendingChanges: false });
      expect(bySlug.get("service.seo").headCreatedAt).toEqual(expect.any(String));
      expect(list.page).toEqual({ cursor: null, hasMore: false, limit: 100 });
      okData(await step("resolveItemBySlug", () => ui.resolveItemBySlug(editorA, A, GAIADA_SLUG, GAIADA_SITE, "service", "service.legacy", "en")));
    });

    it("item.get: head, live, a specific version and a pre-0009 row (version 0) all parse; a missing version is a typed 404, not 'not served'", async () => {
      const head = okData(await step("getItem head", () => ui.getItem(editorA, A, GAIADA_SLUG, GAIADA_SITE, item.itemId, "head")));
      expect(head).toMatchObject({ item: { itemId: item.itemId, headVersion: 1 }, version: { n: 1 }, group: [{ locale: "en" }], lint: { unresolvedTokens: [], markers: {} } });
      okData(await step("getItem live", () => ui.getItem(editorA, A, GAIADA_SLUG, GAIADA_SITE, live1.itemId, "live")));
      okData(await step("getItem v1", () => ui.getItem(editorA, A, GAIADA_SLUG, GAIADA_SITE, item.itemId, 1)));
      const legacy = okData(await step("getItem pre-0009", () => ui.getItem(editorA, A, GAIADA_SLUG, GAIADA_SITE, pre.itemId, "head")));
      expect(legacy).toMatchObject({ item: { headVersion: 0 }, version: { n: 0, createdBy: null } }); // (the UI keeps ItemRef, not the summary extras)
      // `?version=live` on a draft: WebDesk answers 404 `version-not-found`. Before WSK-44b this read as not_enabled/not_served.
      const none = await step("getItem live on a draft", () => ui.getItem(editorA, A, GAIADA_SLUG, GAIADA_SITE, item.itemId, "live"));
      expect(none).toEqual({ kind: "not_found", slug: "version-not-found" });
      expect(await step("getItem unknown id", () => ui.getItem(editorA, A, GAIADA_SLUG, GAIADA_SITE, randomUUID()))).toEqual({ kind: "not_found", slug: "item-not-found" });
    });

    it("versions + versionGet: full rows (contentHash, createdAt, createdBy, note) parse; a missing version is not_found", async () => {
      await actions.saveItemAction(SCOPE, item.itemId, { baseVersion: 1, fields: { h1: "v2" }, blocks: [], seo: {} });
      const list = okData(await step("listVersions", () => ui.listVersions(editorA, A, GAIADA_SLUG, GAIADA_SITE, item.itemId)));
      expect(list.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
      expect(list.versions[0]).toMatchObject({ contentHash: expect.any(String), createdAt: expect.any(String), createdBy: editorA });
      const one = okData(await step("getVersion", () => ui.getVersion(editorA, A, GAIADA_SLUG, GAIADA_SITE, item.itemId, 2)));
      expect(one).toMatchObject({ version: 2, blocks: [{ type: "fields", props: { h1: "v2" } }] });
      expect(await step("getVersion 9", () => ui.getVersion(editorA, A, GAIADA_SLUG, GAIADA_SITE, item.itemId, 9))).toEqual({ kind: "not_found", slug: "version-not-found" });
    });

    it("media: the UI has NO media reader, so the contract is checked here against §27 directly (assetId, bucketKey, mime, sizeBytes, scanStatus, createdAt)", async () => {
      const res = await app.inject({ method: "GET", url: `/api/${A}/modules/webdev/content/sites/${GAIADA_SLUG}/${GAIADA_SITE}/media?mime=image/*`, headers: { authorization: "Bearer svc-token", "x-user-id": editorA } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { assets: Array<Record<string, unknown>>; page: Record<string, unknown> };
      expect(Object.keys(body).sort()).toEqual(["assets", "page"]);
      expect(Object.keys(body.assets[0]).sort()).toEqual(["assetId", "bucketKey", "createdAt", "mime", "scanStatus", "sizeBytes"]);
      expect(Object.keys(body.page).sort()).toEqual(["cursor", "hasMore", "limit"]);
      evidence.push({ step: "media (no UI reader)", http: ["GET media → 200"], ui: "n/a (§27 shape asserted)" });
      recs.push({ method: "GET", path: `/api/${A}/modules/webdev/content/sites/${GAIADA_SLUG}/${GAIADA_SITE}/media`, status: 200, body, user: editorA });
    });

    it("the editor bundle (page load + Refresh): site, composition, item, own pending requests and the build status assemble from real bodies", async () => {
      const b = okData(await step("refreshEditorAction", () => actions.refreshEditorAction(SCOPE, "service", "service.seo", "en")));
      expect(b.detail.item.itemId).toBe(item.itemId);
      expect(b.pendingRequests).toEqual([]);
      expect(b.pendingProblem).toBeNull();
      // build-status is WSK-60's real route now: a site that has never been rebuilt reads as "no build yet", not stale,
      // and not as a problem. (Before WSK-60 merged, the BFF's 404 degraded to "not available".)
      expect(b.build).toEqual({ build: null, stagingStale: false });
      expect(b.buildProblem).toBeNull();
      okData(await step("loadSiteContext", () => ui.loadSiteContext(editorA, A, GAIADA_SLUG, GAIADA_SITE)));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("writes: create · update · restore · unpublish · delete (the UI's real actions and request bodies)", () => {
    it("create / update / restore: the exact bodies the actions send pass the BFF's strict validation, and the write results parse", async () => {
      const created = okData(await step("createItemAction", () => actions.createItemAction(SCOPE, { collectionKey: "service", locale: "en", slug: "service.new", twinOf: null, fields: { h1: "New" }, blocks: [], seo: {}, note: "first" })));
      expect(created).toMatchObject({ item: { slug: "service.new", headVersion: 1 }, version: { version: 1 }, unchanged: false, replayed: false });
      const saved = okData(await step("saveItemAction", () => actions.saveItemAction(SCOPE, item.itemId, { baseVersion: 1, fields: { h1: "v2" }, blocks: [], seo: { title: "t" }, note: "n" })));
      expect(saved).toMatchObject({ item: { headVersion: 2 }, version: { version: 2 } });
      const restored = okData(await step("restoreVersionAction", () => actions.restoreVersionAction(SCOPE, item.itemId, 1, 2, "back")));
      expect(restored).toMatchObject({ item: { headVersion: 3 } });
      okData(await step("getItemHeadAction", () => actions.getItemHeadAction(SCOPE, item.itemId)));
    });

    it("a write whose link died after it landed comes back 200 with `reconciled:true`, and the UI still parses it", async () => {
      zb.dropAfterApply = true;
      const r = okData(await step("saveItemAction (reconciled)", () => actions.saveItemAction(SCOPE, item.itemId, { baseVersion: 1, fields: { h1: "landed" }, blocks: [], seo: {} })));
      expect(r.item.headVersion).toBe(2);
      expect(recs.filter((c) => c.method === "PUT").at(-1)!.body).toMatchObject({ reconciled: true });
    });

    it("unpublish and delete (the publisher tier): {item, replayed} parses", async () => {
      as(publisherA);
      const un = okData(await step("unpublishItemAction", () => actions.unpublishItemAction(SCOPE, live1.itemId, 1)));
      expect(un.item).toMatchObject({ publishState: "unpublished", publishedVersion: null });
      // WSK-60: taking live content down raises the stale-staging banner; the editor's own bundle (page load +
      // Refresh) reads it through the real build-status route and the UI's real parser.
      const bundle = okData(await step("refreshEditorAction (after unpublish)", () => actions.refreshEditorAction(SCOPE, "service", "service.live", "en")));
      expect(bundle.build).toEqual({ build: null, stagingStale: true });
      const del = okData(await step("deleteItemAction", () => actions.deleteItemAction(SCOPE, item.itemId, 1)));
      expect(del.item.deletedAt).toEqual(expect.any(String));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("publish requests: request · own list · poll · withdraw · approve (the three WSK-44b fixes, end to end)", () => {
    it("request → own pending list → the editor bundle shows it after a reload → withdraw → `cancelled` reads as Withdrawn", async () => {
      const filed = okData(await step("requestPublishAction", () => actions.requestPublishAction(SCOPE, [{ itemId: item.itemId, version: 1 }])));
      expect(filed.approvalId).toMatch(/^[0-9a-f-]{36}$/);
      const own = okData(await step("listOwnPublishRequests", () => ui.listOwnPublishRequests(editorA, A, GAIADA_SLUG, GAIADA_SITE, "pending")));
      expect(own).toEqual([{ approvalId: filed.approvalId, status: "pending", createdAt: expect.any(String), itemIds: [item.itemId], items: [{ itemId: item.itemId, version: 1 }], executionStatus: "not_applicable" }]);
      expect(okData(await step("findPendingPublishRequests", () => ui.findPendingPublishRequests(editorA, A, GAIADA_SLUG, GAIADA_SITE, item.itemId)))).toEqual([{ approvalId: filed.approvalId, version: 1 }]);
      const bundle = okData(await step("refreshEditorAction (after reload)", () => actions.refreshEditorAction(SCOPE, "service", "service.seo", "en")));
      expect(bundle.pendingRequests).toEqual([{ approvalId: filed.approvalId, version: 1 }]);

      // FIX 3, the poll: since WebDesk M3 T7 the requester CAN read their own /automation-approvals/:id
      // (Cerbos own-row read), so the poll reads it directly; the own-list fallback stays for anyone else.
      const detail = await platform.platformFetch(`/api/${A}/automation-approvals/${filed.approvalId}`, editorA);
      expect(detail).toMatchObject({ id: filed.approvalId, status: "pending" });
      const polled = okData(await step("pollApprovalAction (editor: 403 → own list)", () => actions.pollApprovalAction(SCOPE, filed.approvalId)));
      expect(polled).toMatchObject({ id: filed.approvalId, status: "pending", executionStatus: "not_applicable" });
      expect(model.phaseOf(polled).phase).toBe("pending");

      // FIX 1: a withdrawn approval is `cancelled`
      const wd = okData(await step("withdrawPublishRequestAction", () => actions.withdrawPublishRequestAction(SCOPE, filed.approvalId)));
      expect(wd).toEqual({ approvalId: filed.approvalId, status: "cancelled" });
      const afterEditor = okData(await step("pollApprovalAction (editor, cancelled)", () => actions.pollApprovalAction(SCOPE, filed.approvalId)));
      expect(afterEditor.status).toBe("cancelled");
      expect(model.phaseOf(afterEditor)).toMatchObject({ phase: "withdrawn" });
      as(adminA); // an approver reads the DETAIL row: `cancelled` must parse there too
      const afterAdmin = okData(await step("pollApprovalAction (admin: detail row)", () => actions.pollApprovalAction(SCOPE, filed.approvalId)));
      expect(afterAdmin).toMatchObject({ id: filed.approvalId, status: "cancelled", workflowId: "content.publish", requestedBy: editorA });
      expect(model.phaseOf(afterAdmin).phase).toBe("withdrawn");
      as(editorA);
      expect(okData(await ui.listOwnPublishRequests(editorA, A, GAIADA_SLUG, GAIADA_SITE, "pending"))).toEqual([]); // no longer "pending after reload"
      expect(okData(await step("listOwnPublishRequests cancelled", () => ui.listOwnPublishRequests(editorA, A, GAIADA_SLUG, GAIADA_SITE, "cancelled"))).map((q: { approvalId: string }) => q.approvalId)).toEqual([filed.approvalId]);
    });

    it("a scheduled request files `content.schedule`; an approver approves a publish; the requester's poll sees approved/executed, the admin's detail row agrees", async () => {
      const when = new Date(Date.now() + 86_400_000).toISOString();
      const sched = okData(await step("requestPublishAction (scheduled)", () => actions.requestPublishAction(SCOPE, [{ itemId: item.itemId, version: 1 }], when)));
      const own = okData(await ui.listOwnPublishRequests(editorA, A, GAIADA_SLUG, GAIADA_SITE, "all"));
      expect(own.map((q: { approvalId: string }) => q.approvalId)).toContain(sched.approvalId);

      const second = zb.seedItem({ siteId: GAIADA_SITE, slug: "service.second" });
      const filed = okData(await actions.requestPublishAction(SCOPE, [{ itemId: second.itemId, version: 1 }]));
      const decided = await app.inject({ method: "POST", url: `/api/${A}/approvals/${filed.approvalId}/decide`, headers: { authorization: "Bearer svc-token", "x-user-id": adminA }, payload: { origin: "webdesk", decision: "approved" } });
      expect(decided.statusCode).toBe(200);
      const viaOwn = okData(await step("pollApprovalAction (editor, executed)", () => actions.pollApprovalAction(SCOPE, filed.approvalId)));
      expect(viaOwn).toMatchObject({ status: "approved", executionStatus: "executed" });
      expect(model.phaseOf(viaOwn).phase).toBe("executed");
      as(adminA);
      const viaDetail = okData(await step("pollApprovalAction (admin, executed)", () => actions.pollApprovalAction(SCOPE, filed.approvalId)));
      expect(viaDetail).toMatchObject({ status: "approved", executionStatus: "executed", decidedBy: adminA });
      expect(model.phaseOf(viaDetail)).toMatchObject({ phase: "executed" });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // 2026-10-11 — "Request an API key" (platform-ui `requestKeyAction`) and the approver's once-only reveal
  // (`parseKeyMintDecision`, which reads the decide façade's in-band `webdesk` block). The filing route is the CONTROL plane's
  // (`POST …/control/sites/:siteId/keys`, tenantSlug in the body), not a content route, so it has its own route-table entry.
  // Real: the controller, Cerbos (`promote` on webdev_provisioned_site), Postgres, the UI's egress/parsers/action. Stand-in: Zone B.
  describe("API keys: requestKeyAction files a key.mint approval; the decide response carries the key once", () => {
    const BOGUS_ENV = "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f";
    beforeEach(async () => {
      // Each test starts with no open key.mint request (the de-dup would otherwise hand back an earlier test's id).
      await adminPool().query(`UPDATE automation_approvals SET deleted_at = now() WHERE tenant_id = $1 AND workflow_id = 'key.mint' AND deleted_at IS NULL`, [A]);
    });
    const lastKeyRec = () => recs.filter((c) => routeOf(c.method, c.path)?.label === "key-request").at(-1)!;

    it("a new filing is `{approvalId}` (not alreadyPending); filing again is the SAME request with `alreadyPending: true`; another scope is a new one — each through the UI's real parser", async () => {
      as(publisherA);
      const first = okData(await step("requestKeyAction (new)", () => actions.requestKeyAction(SCOPE, GAIADA_ENV.production, "read")));
      expect(first).toEqual({ approvalId: expect.stringMatching(/^[0-9a-f-]{36}$/), alreadyPending: false });
      expect(lastKeyRec()).toMatchObject({ method: "POST", status: 202 });
      expect(Object.keys(lastKeyRec().body as object)).toEqual(["approvalId"]); // a new filing carries no `alreadyPending`
      expect(lastKeyRec().path).toBe(`/api/${A}/modules/webdev/control/sites/${GAIADA_SITE}/keys`);

      const again = okData(await step("requestKeyAction (again)", () => actions.requestKeyAction(SCOPE, GAIADA_ENV.production, "read")));
      expect(again).toEqual({ approvalId: first.approvalId, alreadyPending: true });
      expect(lastKeyRec().body).toEqual({ approvalId: first.approvalId, alreadyPending: true });

      const write = okData(await step("requestKeyAction (write: a different request)", () => actions.requestKeyAction(SCOPE, GAIADA_ENV.production, "write")));
      expect(write.alreadyPending).toBe(false);
      expect(write.approvalId).not.toBe(first.approvalId);

      // Nothing was minted at filing: the row is a pending key.mint and Zone B saw no write.
      const { rows } = await adminPool().query<{ status: string; workflow_id: string }>(`SELECT status, workflow_id FROM automation_approvals WHERE id = $1`, [first.approvalId]);
      expect(rows[0]).toEqual({ status: "pending", workflow_id: "key.mint" });
      expect(zb.mintedKeys).toEqual([]);
    });

    it("404 environment-not-found (an env that is not this site's) and 404 site-not-found (another company's site) are typed not_found", async () => {
      as(publisherA);
      expect(await step("requestKeyAction (random env)", () => actions.requestKeyAction(SCOPE, BOGUS_ENV, "read"))).toEqual({ kind: "not_found", slug: "environment-not-found" });
      expect(await step("requestKeyAction (another tenant's env)", () => actions.requestKeyAction(SCOPE, OTHER_ENV.production, "read"))).toEqual({ kind: "not_found", slug: "environment-not-found" });
      expect(await step("requestKeyAction (foreign site)", () => actions.requestKeyAction(OTHER_SCOPE, OTHER_ENV.production, "read"))).toEqual({ kind: "not_found", slug: "site-not-found" });
      const raw = await refusal(`/api/${A}/modules/webdev/control/sites/${GAIADA_SITE}/keys`, publisherA, { method: "POST", body: JSON.stringify({ tenantSlug: GAIADA_SLUG, envId: BOGUS_ENV, scope: "read" }) });
      expect(raw.status).toBe(404);
      expect(ui.problemOf(raw)).toMatchObject({ slug: "environment-not-found" });
    });

    it("403: a webdev editor and a plain member are forbidden for BOTH scopes (the promote gate), and a malformed envId is `invalid`", async () => {
      for (const who of [editorA, memberA]) {
        as(who);
        for (const scope of ["read", "write"]) {
          expect(await step(`requestKeyAction (${scope}, no promote)`, () => actions.requestKeyAction(SCOPE, GAIADA_ENV.production, scope)), who).toMatchObject({ kind: "forbidden" });
        }
      }
      as(publisherA);
      expect(await step("requestKeyAction (envId not a uuid)", () => actions.requestKeyAction(SCOPE, "production", "read"))).toMatchObject({ kind: "invalid" });
    });

    it("503 editorial_unavailable (breaker open on the site read) is the workspace's unavailable state, never drift", async () => {
      as(publisherA);
      zb.failWith = new EditorialUnavailableError(25_000);
      webdeskZoneB.clearSiteCache();
      try {
        const r = await step("requestKeyAction (breaker open)", () => actions.requestKeyAction(SCOPE, GAIADA_ENV.production, "read"));
        expect(r).toMatchObject({ kind: "unavailable", code: "editorial_unavailable" });
      } finally {
        zb.failWith = null;
      }
    });

    it("approve by a DIFFERENT user: the façade's decide response parses through the UI's real parseKeyMintDecision to the key (once); the approval row, the detail read and the summary helpers never hold it", async () => {
      as(publisherA);
      const filed = okData(await step("requestKeyAction (for the decide round trip)", () => actions.requestKeyAction(SCOPE, GAIADA_ENV.staging, "read")));
      const path = `/api/${A}/approvals/${filed.approvalId}/decide`;
      const decideBody = (decision: string) => ({ method: "POST", body: JSON.stringify({ origin: "webdesk", decision }) });

      // maker != checker: the requester's own decide is refused, and nothing was minted.
      expect((await refusal(path, publisherA, decideBody("approved"))).status).toBe(403);
      expect(zb.mintedKeys).toEqual([]);

      // The UI's real egress, as the approver; the body is what `decideKeyMintApproval` hands to `parseKeyMintDecision`.
      const raw = await platform.platformFetch<unknown>(path, adminA, decideBody("approved"));
      expect(zb.mintedKeys).toHaveLength(1);
      const outcome = ui.parseKeyMintDecision(raw);
      expect(outcome).toEqual({ status: "executed", envId: GAIADA_ENV.staging, scope: "read", apiKeyId: expect.any(String), plaintextOnce: zb.mintedKeys[0] });
      evidence.push({ step: "decide key.mint via the façade (UI parseKeyMintDecision)", http: ["POST /approvals/:id/decide → 200"], ui: "ok (executed, key present once)" });

      // The decided row (what every later server render reads) has no key.
      const row = okData(await step("getApprovalRow (decided key.mint)", () => ui.getApprovalRow(adminA, A, filed.approvalId)));
      expect(row).toMatchObject({ status: "approved", executionStatus: "executed", workflowId: "key.mint" });
      expect(JSON.stringify(row)).not.toContain(zb.mintedKeys[0]);
      const detailRaw = await platform.platformFetch<unknown>(`/api/${A}/automation-approvals/${filed.approvalId}`, adminA);
      expect(JSON.stringify(detailRaw)).not.toContain(zb.mintedKeys[0]);

      // The approvals page's labelling helpers read this real row.
      expect((model as any).isKeyMintApproval({ workflowId: row.workflowId, toolName: (detailRaw as { toolName: string }).toolName })).toBe(true);
      expect((model as any).parseKeyMintArgs(row.toolArgs)).toEqual({ tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, envId: GAIADA_ENV.staging, scope: "read" });
      expect(await ui.findKeyTarget(adminA, A, GAIADA_SLUG, GAIADA_SITE, GAIADA_ENV.staging)).toMatchObject({ environmentName: "staging" });
    });

    it("a rejection carries no in-band `webdesk` block: parseKeyMintDecision reads it as 'nothing to show'", async () => {
      as(publisherA);
      const filed = okData(await actions.requestKeyAction(SCOPE, GAIADA_ENV.production, "write"));
      const raw = await platform.platformFetch<unknown>(`/api/${A}/approvals/${filed.approvalId}/decide`, adminA, { method: "POST", body: JSON.stringify({ origin: "webdesk", decision: "rejected" }) });
      expect(ui.parseKeyMintDecision(raw)).toBeNull();
      expect(zb.mintedKeys).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // WSK-46 — the editor's Preview. Real: the controller, Cerbos (`update` on webdesk_content_item), Postgres, the UI's egress,
  // `parsePreviewLink`, `problemOf`/`resultFromError` and `previewRefusalCopy`. Stand-ins: Zone B, and the site's /preview/ HEAD.
  describe("preview: previewItemAction mints a one-time draft link; the refusals reach the editor as typed results with plain words", () => {
    const lastPreview = () => recs.filter((c) => routeOf(c.method, c.path)?.label === "preview").at(-1)!;

    it("ok: the answer is exactly {previewUrl, expiresAt, version}, the link is https://<staging>/preview/#t=<token>, and the UI's STRICT parser accepts it", async () => {
      const r = okData(await step("previewItemAction", () => actions.previewItemAction(SCOPE, item.itemId, 1)));
      expect(Object.keys(r).sort()).toEqual(["expiresAt", "previewUrl", "version"]);
      expect(r.version).toBe(1);
      expect(r.previewUrl).toBe(`https://staging.gaiada.test/preview/#t=${zb.mintedPreviewTokens[0]}`);
      const rec = lastPreview();
      expect(rec).toMatchObject({ method: "POST", status: 200 });
      expect(rec.path).toBe(`/api/${A}/modules/webdev/content/sites/${GAIADA_SLUG}/${GAIADA_SITE}/items/${item.itemId}/preview`); // no token in the request URL
      expect(rec.path).not.toContain(zb.mintedPreviewTokens[0]);
    });

    it("the head (no version) previews the head; the request body carries only what was asked", async () => {
      const r = okData(await step("previewItemAction (head)", () => actions.previewItemAction(SCOPE, item.itemId)));
      expect(r.version).toBe(1);
      expect(zb.calls.filter((c) => c.command === "content.previewToken")[0].body).toEqual({});
    });

    it("the strict parser refuses a link that is not safe to open: a query-string token, http, another page, a javascript: URL, an extra key", () => {
      const good = { previewUrl: "https://stg.example/preview/#t=abc", expiresAt: "2026-10-11T09:00:00Z", version: 1 };
      expect(ui.parsePreviewLink(good)).toEqual(good);
      for (const bad of [
        { ...good, previewUrl: "https://stg.example/preview/?t=abc" },
        { ...good, previewUrl: "https://stg.example/preview/?t=abc#t=abc" },
        { ...good, previewUrl: "http://stg.example/preview/#t=abc" },
        { ...good, previewUrl: "https://stg.example/other/#t=abc" },
        { ...good, previewUrl: "https://stg.example/preview/#t=" },
        { ...good, previewUrl: "https://stg.example/preview/" },
        { ...good, previewUrl: "javascript:alert(1)//preview/#t=abc" },
        { ...good, previewUrl: "https://u:p@stg.example/preview/#t=abc" },
        { ...good, previewUrl: "not a url" },
        { ...good, expiresAt: "soon" },
        { ...good, version: 1.5 },
        { ...good, previewPath: "/v1/t/gaiada/preview/abc" },
      ]) expect(() => ui.parsePreviewLink(bad), JSON.stringify(bad)).toThrow(ui.WireDrift);
      // and a drift message names a path and a type, never the value (so a token cannot reach an error or a log)
      try { ui.parsePreviewLink({ ...good, previewUrl: "https://stg.example/preview/?t=SECRETVALUE" }); } catch (e) { expect((e as Error).message).not.toContain("SECRETVALUE"); }
    });

    it("preview_not_configured: a site with no staging address is a typed `conflict` the editor renders in plain words, and nothing was minted", async () => {
      zb.stagingDomain = null;
      webdeskZoneB.clearSiteCache();
      const r = await step("previewItemAction (no staging)", () => actions.previewItemAction(SCOPE, item.itemId));
      expect(r).toMatchObject({ kind: "conflict", slug: "preview_not_configured", message: "Preview isn't set up for this site yet" });
      expect(model.previewRefusalCopy(r)).toMatchObject({ tone: "info", text: expect.stringContaining("Preview isn't set up for this site yet") });
      expect(zb.mintedPreviewTokens).toHaveLength(0);
    });

    it("preview_page_missing: the site answers 404 for /preview/ (the honest live state today) is a typed `conflict` in plain words, and nothing was minted", async () => {
      previewHead.status = 404;
      const r = await step("previewItemAction (no /preview/ page)", () => actions.previewItemAction(SCOPE, item.itemId));
      expect(r).toMatchObject({ kind: "conflict", slug: "preview_page_missing", message: "This site doesn't have a preview page yet" });
      expect(model.previewRefusalCopy(r)).toMatchObject({ tone: "info", text: expect.stringContaining("doesn't have a preview page yet") });
      expect(zb.calls.filter((c) => c.command === "content.previewToken")).toHaveLength(0);
      expect(zb.mintedPreviewTokens).toHaveLength(0);
    });

    it("preview_site_unreachable: the site 5xx's, so the editor says so and mints nothing (an `unavailable`, never a link)", async () => {
      previewHead.status = 503;
      const r = await step("previewItemAction (site down)", () => actions.previewItemAction(SCOPE, item.itemId));
      expect(r).toMatchObject({ kind: "unavailable", code: "upstream_error", reason: "preview_site_unreachable" });
      expect(model.previewRefusalCopy(r)).toMatchObject({ tone: "bad", text: expect.stringContaining("site didn't answer") });
      expect(zb.mintedPreviewTokens).toHaveLength(0);
    });

    it("a reader is `forbidden` (Cerbos `update`); a foreign site is `not_found/site-not-found`; an unknown item is `not_found/item-not-found`; a deleted item is `conflict/item-deleted`; an unknown version is `not_found/version-not-found`", async () => {
      as(memberA);
      expect(await step("previewItemAction (reader)", () => actions.previewItemAction(SCOPE, item.itemId))).toMatchObject({ kind: "forbidden" });
      as(editorA);
      expect(await step("previewItemAction (foreign site)", () => actions.previewItemAction(OTHER_SCOPE, item.itemId))).toEqual({ kind: "not_found", slug: "site-not-found" });
      expect(await step("previewItemAction (unknown item)", () => actions.previewItemAction(SCOPE, randomUUID()))).toEqual({ kind: "not_found", slug: "item-not-found" });
      expect(await step("previewItemAction (unknown version)", () => actions.previewItemAction(SCOPE, item.itemId, 9))).toEqual({ kind: "not_found", slug: "version-not-found" });
      item.deletedAt = new Date().toISOString();
      const deleted = await step("previewItemAction (deleted)", () => actions.previewItemAction(SCOPE, item.itemId));
      expect(deleted).toMatchObject({ kind: "conflict", slug: "item-deleted" });
      expect(model.previewRefusalCopy(deleted).text).toContain("has been deleted");
      expect(zb.mintedPreviewTokens).toHaveLength(0);
    });

    it("breaker open: `unavailable/editorial_unavailable`; an ambiguous mint: an outcome-unknown `unavailable`, which the copy calls \"couldn't confirm\"", async () => {
      zb.dropAfterApply = true;
      const amb = await step("previewItemAction (ambiguous)", () => actions.previewItemAction(SCOPE, item.itemId));
      expect(amb).toMatchObject({ kind: "unavailable", code: "upstream_error", reason: "not_observed" }); // the BFF's machine cause, kept as the reason
      expect(model.isOutcomeUnknown(amb)).toBe(true);
      expect(model.previewRefusalCopy(amb).text).toContain("couldn't confirm");
      zb.failWith = new EditorialUnavailableError(25_000);
      webdeskZoneB.clearSiteCache();
      const down = await step("previewItemAction (breaker open)", () => actions.previewItemAction(SCOPE, item.itemId));
      expect(down).toMatchObject({ kind: "unavailable", code: "editorial_unavailable" });
      expect(model.previewRefusalCopy(down).text).toContain("Couldn't reach WebDesk");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("error paths: each is a TYPED result (or a typed refusal), never contract_drift", () => {
    const notDrift = (r: Wd) => expect(r).not.toMatchObject({ kind: "unavailable", code: "contract_drift" });
    const siteUrl = () => ui.siteBase(A, GAIADA_SLUG, GAIADA_SITE);

    it("409 version-conflict: slug, currentHeadVersion, currentContentHash and updatedAt reach the conflict dialog", async () => {
      const stale = await step("saveItemAction (stale base)", () => actions.saveItemAction(SCOPE, item.itemId, { baseVersion: 99, fields: { h1: "x" }, blocks: [], seo: {} }));
      expect(stale).toMatchObject({ kind: "conflict", slug: "version-conflict", currentHeadVersion: 1, currentContentHash: expect.any(String), updatedAt: expect.any(String) });
      const raw = await refusal(`${siteUrl()}/items/${item.itemId}`, editorA, { method: "PUT", body: JSON.stringify({ baseVersion: 99, fields: {} }) });
      expect(raw.status).toBe(409);
      expect(ui.problemOf(raw)).toMatchObject({ slug: "version-conflict", ext: { currentHeadVersion: 1, currentContentHash: expect.any(String) } });
    });

    it("422 composition-violation: `issues` located by JSON pointer survive the pass-through", async () => {
      const bad = await step("createItemAction (422)", () => actions.createItemAction(SCOPE, { collectionKey: "service", locale: "en", slug: "service.bad", twinOf: null, fields: { h1: 42 }, blocks: [], seo: {} }));
      expect(bad).toMatchObject({ kind: "invalid", issues: [{ path: "/blocks/0/props/h1", message: "must be a string", expected: "text" }] });
      const raw = await refusal(`${siteUrl()}/collections/service/items`, editorA, { method: "POST", body: JSON.stringify({ locale: "en", slug: "service.bad2", fields: { h1: 42 } }) });
      expect(raw.status).toBe(422);
      expect(ui.problemOf(raw)).toMatchObject({ slug: "composition-violation", ext: { issues: [{ path: "/blocks/0/props/h1" }] } });
    });

    it("404 site-not-found (another company's tenant, and a real tenant with a wrong site id) and 404 item/collection-not-found", async () => {
      expect(await step("listCollections (foreign site)", () => ui.listCollections(editorA, A, OTHER_SLUG, OTHER_SITE))).toEqual({ kind: "not_found", slug: "site-not-found" });
      expect(await step("saveItemAction (foreign site)", () => actions.saveItemAction(OTHER_SCOPE, item.itemId, { baseVersion: 1, fields: {}, blocks: [], seo: {} }))).toEqual({ kind: "not_found", slug: "site-not-found" });
      expect(await ui.getItem(editorA, A, GAIADA_SLUG, randomUUID(), item.itemId)).toEqual({ kind: "not_found", slug: "site-not-found" });
      expect(await step("createItemAction (no such collection)", () => actions.createItemAction(SCOPE, { collectionKey: "nope", locale: "en", slug: "x", twinOf: null, fields: {}, blocks: [], seo: {} }))).toEqual({ kind: "not_found", slug: "collection-not-found" });
      const raw = await refusal(`${ui.siteBase(A, OTHER_SLUG, OTHER_SITE)}/collections`, editorA);
      expect(raw.status).toBe(404);
      expect(ui.problemOf(raw)).toMatchObject({ slug: "site-not-found" });
    });

    it("503 editorial_unavailable (breaker open) on a read AND a write; 503 webdesk_not_configured (no signer) on a write", async () => {
      zb.failWith = new EditorialUnavailableError(25_000);
      webdeskZoneB.clearSiteCache();
      const read = await step("listSites (breaker open)", () => ui.listSites(editorA, A));
      expect(read).toMatchObject({ kind: "unavailable", code: "editorial_unavailable", reason: "circuit_open" });
      const write = await step("saveItemAction (breaker open)", () => actions.saveItemAction(SCOPE, item.itemId, { baseVersion: 1, fields: {}, blocks: [], seo: {} }));
      expect(write).toMatchObject({ kind: "unavailable", code: "editorial_unavailable", reason: "circuit_open" });
      const raw = await refusal(`${ui.contentBase(A)}/sites`, editorA);
      expect(raw.status).toBe(503);
      expect(ui.problemOf(raw)).toMatchObject({ slug: "circuit_open", message: "editorial_unavailable" });
      zb.failWith = null;
      signer.configured = false;
      const noSigner = await step("saveItemAction (no signer)", () => actions.saveItemAction(SCOPE, item.itemId, { baseVersion: 1, fields: { h1: "x" }, blocks: [], seo: {} }));
      expect(noSigner).toMatchObject({ kind: "unavailable", code: "editorial_unavailable", reason: "editorial_signer_not_configured" });
    });

    it("502 webdesk_ambiguous: a typed `unavailable` that names the cause, never success; and the write did NOT land", async () => {
      zb.dropBeforeApply = true;
      const r = await step("saveItemAction (ambiguous)", () => actions.saveItemAction(SCOPE, item.itemId, { baseVersion: 1, fields: { h1: "never" }, blocks: [], seo: {} }));
      // The UI has no distinct "couldn't confirm the save" code: it is `unavailable/upstream_error`, which sends the editor
      // to its STALE state (Save disabled until a re-read). The machine reason is kept. See the report's follow-ups.
      expect(r).toMatchObject({ kind: "unavailable", code: "upstream_error", reason: "not_observed" });
      zb.dropBeforeApply = true;
      const raw = await refusal(`${siteUrl()}/items/${item.itemId}`, editorA, { method: "PUT", body: JSON.stringify({ baseVersion: 1, fields: { h1: "never2" } }) });
      expect(raw.status).toBe(502);
      expect(ui.problemOf(raw)).toMatchObject({ slug: "not_observed", message: "webdesk_ambiguous" });
      expect(zb.items.get(item.itemId)!.headVersion).toBe(1);
    });

    it("403 (Cerbos denial: a member, and an editor on a publisher-tier action) → forbidden; 401 → session_expired; 400 invalid_request → invalid", async () => {
      as(memberA);
      expect(await step("listSites (member)", () => ui.listSites(memberA, A))).toMatchObject({ kind: "forbidden" });
      as(editorA);
      expect(await step("unpublishItemAction (editor)", () => actions.unpublishItemAction(SCOPE, live1.itemId, 1))).toMatchObject({ kind: "forbidden" });
      process.env.PLATFORM_SERVICE_TOKEN = "wrong-token";
      expect(await step("listSites (bad token)", () => ui.listSites(editorA, A))).toMatchObject({ kind: "unavailable", code: "upstream_error", reason: "session_expired" });
      process.env.PLATFORM_SERVICE_TOKEN = "svc-token";
      const bad = await step("PUT with an unknown body key", () => ui.wdCall(`${siteUrl()}/items/${item.itemId}`, editorA, ui.parseItemWriteResult, { method: "PUT", body: JSON.stringify({ baseVersion: 1, bogus: true }) }));
      expect(bad).toMatchObject({ kind: "invalid", message: expect.stringMatching(/unknown body key "bogus"/) });
    });

    it("withdraw refusals: another user's request → forbidden, not pending → conflict `approval_not_pending`, unknown id → not_found (a real answer, not 'not served')", async () => {
      const filed = okData(await actions.requestPublishAction(SCOPE, [{ itemId: item.itemId, version: 1 }]));
      as(publisherA);
      expect(await step("withdraw (not the requester)", () => actions.withdrawPublishRequestAction(SCOPE, filed.approvalId))).toMatchObject({ kind: "forbidden" });
      as(editorA);
      okData(await actions.withdrawPublishRequestAction(SCOPE, filed.approvalId));
      expect(await step("withdraw (twice)", () => actions.withdrawPublishRequestAction(SCOPE, filed.approvalId))).toMatchObject({ kind: "conflict", slug: "approval_not_pending" });
      expect(await step("withdraw (unknown id)", () => actions.withdrawPublishRequestAction(SCOPE, randomUUID()))).toEqual({ kind: "not_found", slug: "approval_not_found" });
    });

    it("WSK-60's build routes through the UI's own parsers: a build with no staging target reads as failed, never live; a rebuild request is a typed 503 refusal, never drift", async () => {
      const bs = await step("pollBuildStatusAction", () => actions.pollBuildStatusAction(SCOPE));
      expect(bs).toMatchObject({ kind: "ok", data: { stagingStale: false } });
      // An earlier test in this file approves a publish. With no WEBDESK_REBUILD_TARGETS, WSK-60 records that publish's
      // build as `failed`: no staging URL, never verified, never "live on staging". Before any publish there is no build.
      const build = okData(bs).build;
      if (build !== null) expect(build).toMatchObject({ kind: "publish", state: "failed", stagingUrl: null, verifiedAt: null });
      expect(await step("getBuildStatus", () => ui.getBuildStatus(editorA, A, GAIADA_SLUG, GAIADA_SITE))).toEqual(bs);
      // This suite configures no WEBDESK_REBUILD_TARGETS, so the route refuses before filing an approval that could only fail.
      const rb = await step("requestRebuildAction", () => actions.requestRebuildAction(SCOPE));
      expect(rb).toEqual({ kind: "unavailable", code: "editorial_unavailable", reason: "webdesk_not_configured" });
      notDrift(bs);
      notDrift(rb);
    });

    it("the module switched off for the company: 404 → not_enabled (a refusal the page renders as one)", async () => {
      const off = await createCompany("WSK-44b No Webdev", ["pm"]);
      const u = await createUser("wsk44b-nomod@ex.test");
      await addMembership(off, u);
      const r = await step("listSites (module off)", () => ui.listSites(u, off));
      expect(r.kind).toBe("not_enabled");
      notDrift(r);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("the verdict: every real 2xx body parsed; no contract_drift anywhere; the harness is not vacuous", () => {
    it("pipes EVERY recorded real response body through the UI's real parse* and none throws", () => {
      const failures: string[] = [];
      let parsed = 0;
      for (const c of recs) {
        const r = routeOf(c.method, c.path);
        if (!r || c.status < 200 || c.status >= 300) continue;
        if (r.parser === null) continue;
        try {
          ui[r.parser](c.body);
          parsed++;
        } catch (e) {
          failures.push(`${c.method} ${r.label} → ${r.parser}: ${(e as Error).message}`);
        }
      }
      expect(failures).toEqual([]);
      expect(parsed).toBeGreaterThanOrEqual(40);
    });

    it("covers every route the UI calls (with a real 2xx) and every error class the UI renders", () => {
      const ok2xx = new Set(recs.filter((c) => c.status >= 200 && c.status < 300).map((c) => routeOf(c.method, c.path)?.label));
      for (const label of ["sites", "collections", "items", "item.get", "versions", "versionGet", "media", "create", "update", "restore", "publish-requests", "publish-requests.list", "withdraw", "unpublish", "delete", "approval.detail", "key-request", "preview"]) {
        expect(ok2xx, `no real 2xx recorded for ${label}`).toContain(label);
      }
      const statuses = new Set(recs.map((c) => c.status));
      for (const s of [200, 201, 202, 400, 401, 403, 404, 409, 422, 502, 503]) expect(statuses, `no ${s} recorded`).toContain(s);
      expect(evidence.filter((e) => e.ui.includes("contract_drift")), "contract_drift anywhere").toEqual([]);
    });

    it("negative control + the field diff: for each route, deleting a real key makes the parser throw WireDrift, and the keys that do are the ones the UI REQUIRES (all present in the real body, by construction)", () => {
      /** Every key path in `body` (first array element only) whose removal makes `parse` throw. */
      const requiredPaths = (parse: (v: unknown) => unknown, body: unknown): string[] => {
        const out: string[] = [];
        const walk = (node: unknown, path: Array<string | number>) => {
          if (Array.isArray(node)) {
            if (node.length > 0) walk(node[0], [...path, 0]);
            return;
          }
          if (node === null || typeof node !== "object") return;
          for (const k of Object.keys(node)) {
            const mutated = JSON.parse(JSON.stringify(body));
            let t = mutated;
            for (const seg of path) t = t[seg];
            delete t[k];
            let threw = false;
            try { parse(mutated); } catch (e) { threw = e instanceof ui.WireDrift; if (!threw) throw e; }
            if (threw) out.push([...path, k].join(".").replace(/\.(\d+)(?=\.|$)/g, "[$1]"));
            walk((node as Record<string, unknown>)[k], [...path, k]);
          }
        };
        walk(body, []);
        return out;
      };
      const seen = new Set<string>();
      for (const c of recs) {
        const r = routeOf(c.method, c.path);
        if (!r || !r.parser || c.status < 200 || c.status >= 300 || seen.has(r.label) || typeof c.body !== "object" || c.body === null) continue;
        seen.add(r.label);
        const req = requiredPaths((v) => ui[r.parser as string](v), c.body);
        expect(req.length, `${r.label}: no key removal made ${r.parser} throw, so it validates nothing`).toBeGreaterThan(0);
        fieldsRequired.set(r.label, req);
      }
      expect(seen.size).toBeGreaterThanOrEqual(15);
    });

    it("negative control: the three drifts WSK-59 found are accepted now, and an invalid status is still refused", () => {
      expect(() => ui.parseApprovalRow({ id: "a", workflowId: "content.publish", status: "withdrawn", createdAt: "t" })).toThrow(ui.WireDrift);
      expect(ui.parseApprovalRow({ id: "a", workflowId: "content.publish", status: "cancelled", createdAt: "t" }).status).toBe("cancelled");
    });

    it("prints the per-route evidence table (read it in the log: `route → HTTP status → what the UI made of it`)", () => {
      const lines = evidence.map((e) => `${e.step.padEnd(52)} ${e.http.join(" ; ").padEnd(70)} UI: ${e.ui}`);
      const reads = [...fieldsRequired].map(([label, paths]) => `${label.padEnd(24)} ${paths.length} required key paths: ${paths.join(", ").slice(0, 700)}`);
      console.log(
        `\nWSK-44b real-contract evidence (${evidence.length} UI calls, ${recs.length} real HTTP exchanges)\n${lines.join("\n")}\n` +
        `\nFields the UI REQUIRES per route (each one is present in the real response, or the parse above would have failed):\n${reads.join("\n")}\n`,
      );
      expect(evidence.length).toBeGreaterThan(40);
    });
  });
});
