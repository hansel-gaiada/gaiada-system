import { describe, it, expect, vi, beforeEach } from "vitest";
import service from "../../e2e/webdesk-stub/compositions/service.json";
import navigation from "../../e2e/webdesk-stub/compositions/navigation.json";

vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn() };
});
vi.mock("./entities", () => ({ listMembers: vi.fn() }));

import { platformFetch, PlatformError } from "./platform";
import { listMembers } from "./entities";
import {
  findPendingPublishRequests, getApprovalRow, getBuildStatus, getItem, getVersion, listCollections, listItems, listOwnPublishRequests, listSites,
  listVersions, loadEditorBundle, loadSiteContext, parseApprovalRow, parseBuildStatus, parseCollections, parseComposition,
  parseItemDetail, parseItemList, parseItemWriteResult, parseLint, parsePublishRequests, parseSites, pollApproval, problemOf, resolveAuthorNames,
  resolveItemBySlug, resultFromError, stagingBaseUrl, wdCall, WireDrift,
} from "./webdeskContent";

const fetchMock = vi.mocked(platformFetch);
const members = vi.mocked(listMembers);

// ── spec-shaped bodies (§3.2 / §4) ─────────────────────────────────────────────────────────────────
const ref = (over: Record<string, unknown> = {}) => ({
  itemId: "i1", collectionKey: "service", locale: "en", slug: "service.seo", localizationGroupId: "g1",
  headVersion: 3, publishedVersion: 2, publishState: "published", publishAt: null, unpublishAt: null, deletedAt: null, updatedAt: "2026-10-10T08:00:00Z", ...over,
});
const summary = (over: Record<string, unknown> = {}) => ({
  itemId: "i1", slug: "service.seo", locale: "en", localizationGroupId: "g1", title: "SEO", headVersion: 3, publishedVersion: 2, publishState: "published",
  publishAt: null, unpublishAt: null, deletedAt: null, updatedAt: "2026-10-10T08:00:00Z", headCreatedAt: "2026-10-10T08:00:00Z", headCreatedBy: "u1", pendingChanges: true, ...over,
});
const tenants = () => ({ tenants: [{ slug: "gaiada", status: "active", defaultLocale: "en", locales: ["en", "id"], sites: [{ siteId: "s1", name: "gaiada.com", kind: "static", environments: [{ envId: "e1", name: "staging", domain: "24-pyevq.gaiada.com", status: "active" }] }] }] });
const collections = () => ({ collections: [
  { key: "service", composition: service, vocabularyVersion: "1.1.0", counts: { items: 2, byLocale: { en: 1, id: 1 }, live: 1, pendingChanges: 1 }, updatedAt: "2026-10-10T08:00:00Z" },
  { key: "navigation", composition: navigation, vocabularyVersion: "1.1.0", counts: { items: 2, byLocale: { en: 1, id: 1 }, live: 1, pendingChanges: 0 }, updatedAt: "2026-10-10T08:00:00Z" },
] });
const detail = (over: Record<string, unknown> = {}) => ({
  item: ref(), version: { n: 3, contentHash: "h3", createdAt: "2026-10-10T08:00:00Z", createdBy: "u1", attribution: { pk: "human" }, note: null, blocks: [{ type: "fields", props: { h1: "SEO" } }], seo: {} },
  live: null, group: [{ locale: "en", itemId: "i1", slug: "service.seo", headVersion: 3, publishedVersion: 2, publishState: "published" }], lint: { placeholders: { unresolvedTokens: ["{{X}}"], markers: { CONFIRM: 1 } } }, ...over,
});
const writeResult = () => ({ item: ref(), version: { version: 4, contentHash: "h4", createdAt: "2026-10-10T09:00:00Z" }, unchanged: false, lint: {}, replayed: false });

function problem(status: number, slug: string, ext: Record<string, unknown> = {}) {
  return new PlatformError(status, slug, undefined, undefined, undefined, { type: `https://webdesk.gaiada.online/errors/${slug}`, title: slug, status, ...ext });
}

beforeEach(() => { fetchMock.mockReset(); members.mockReset(); });

describe("wire validation: a 2xx body that does not match the spec is DRIFT, never data", () => {
  it("accepts the spec'd shapes", () => {
    expect(parseSites(tenants()).tenants[0].sites[0].environments[0].domain).toBe("24-pyevq.gaiada.com");
    expect(parseCollections(collections())).toHaveLength(2);
    expect(parseItemList({ items: [summary()], page: { cursor: null, hasMore: false, limit: 100 } }).items[0].pendingChanges).toBe(true);
    expect(parseItemDetail(detail()).lint).toEqual({ unresolvedTokens: ["{{X}}"], markers: { CONFIRM: 1 } });
    expect(parseItemWriteResult(writeResult()).lint).toEqual({ unresolvedTokens: [], markers: {} });
  });

  it("WSK-44b: the three nullable/enum drifts the real BFF exposed are accepted, not drift", () => {
    // headCreatedAt is null for a pre-0009 row (no version row)
    const pre = parseItemList({ items: [summary({ headCreatedAt: null, headCreatedBy: null })], page: { cursor: null, hasMore: false, limit: 100 } });
    expect(pre.items[0].headCreatedAt).toBeNull();
    // environments.domain is nullable in WebDesk
    const t = tenants(); (t.tenants[0].sites[0].environments[0] as Record<string, unknown>).domain = null;
    expect(parseSites(t).tenants[0].sites[0].environments[0].domain).toBeNull();
    // a withdrawn approval reads `cancelled`
    expect(parseApprovalRow({ id: "a", workflowId: "content.publish", status: "cancelled", createdAt: "t", executionStatus: "not_applicable" }).status).toBe("cancelled");
    expect(() => parseApprovalRow({ id: "a", workflowId: "w", status: "withdrawn", createdAt: "t" })).toThrow(WireDrift);
  });

  it.each([
    ["a missing required key", () => { const b = tenants(); delete (b.tenants[0] as Record<string, unknown>).defaultLocale; return () => parseSites(b); }, "defaultLocale"],
    ["a wrongly typed key", () => { const b = collections(); (b.collections[0].counts as Record<string, unknown>).live = "1"; return () => parseCollections(b); }, "live"],
    ["a null where a string is required", () => () => parseItemList({ items: [summary({ slug: null })], page: { cursor: null, hasMore: false, limit: 1 } }), "slug"],
    ["publishedVersion omitted (undefined must not read as null)", () => { const s = summary(); delete (s as Record<string, unknown>).publishedVersion; return () => parseItemList({ items: [s], page: { cursor: null, hasMore: false, limit: 1 } }); }, "publishedVersion"],
    ["the bare array a demo catch-all returns", () => () => parseSites([]), "object"],
    ["an unknown primitive in a composition", () => () => parseComposition({ fields: [{ name: "x", primitive: "hologram" }] }), "primitive"],
    ["a group with no sub-fields", () => () => parseComposition({ fields: [{ name: "x", primitive: "group" }] }), "fields"],
    ["a version without `n`", () => { const d = detail(); delete (d.version as Record<string, unknown>).n; return () => parseItemDetail(d); }, "version.n"],
  ])("%s", (_n, mk, mention) => {
    const run = mk();
    expect(run).toThrow(WireDrift);
    expect(run).toThrow(new RegExp(mention));
  });

  it("lint with no placeholder rules is empty, but a malformed placeholders block is drift", () => {
    expect(parseLint({}, "lint")).toEqual({ unresolvedTokens: [], markers: {} });
    expect(() => parseLint({ placeholders: { unresolvedTokens: "x", markers: {} } }, "lint")).toThrow(WireDrift);
  });

  it("validates the real gaiada compositions (the shapes the editor is proven on)", () => {
    for (const c of [service, navigation]) expect(() => parseComposition(c)).not.toThrow();
    expect(parseComposition(navigation).fields?.find((f) => f.name === "primary")?.itemKey).toBe("url");
  });

  it("parseBuildStatus refuses an invented state, and a missing `build` key", () => {
    expect(parseBuildStatus({ build: null, stagingStale: true })).toEqual({ build: null, stagingStale: true });
    expect(() => parseBuildStatus({ build: { approvalId: null, kind: "publish", requestedAt: "t", publishedAt: null, state: "done", stagingUrl: null, verifiedAt: null }, stagingStale: false })).toThrow(/state/);
    expect(() => parseBuildStatus({ stagingStale: false })).toThrow(/build/);
  });

  it("parseApprovalRow keeps a missing executionStatus as null (unknown), never `not_applicable`", () => {
    const row = parseApprovalRow({ id: "a", workflowId: "content.publish", status: "approved", createdAt: "t", toolArgs: {} });
    expect(row.executionStatus).toBeNull();
    expect(() => parseApprovalRow({ id: "a", workflowId: "w", status: "weird", createdAt: "t" })).toThrow(/status/);
  });
});

describe("resultFromError: every failure is a typed result (§3.4 / §10)", () => {
  const pe = (status: number, body?: unknown, msg = `platform ${status}`) => new PlatformError(status, msg, undefined, undefined, undefined, body);
  it.each([
    ["503 editorial_unavailable", pe(503, { error: "editorial_unavailable" }, "editorial_unavailable"), { kind: "unavailable", code: "editorial_unavailable" }],
    ["any 503 (replay store down)", problem(503, "editorial-replay-store-unavailable"), { kind: "unavailable", code: "editorial_unavailable" }],
    ["403 Cerbos", pe(403, { error: "forbidden" }, "forbidden"), { kind: "forbidden" }],
    ["404 module guard", pe(404, { error: "module webdev not enabled for this company" }, "module webdev not enabled for this company"), { kind: "not_enabled", reason: "module_disabled" }],
    ["404 route not served", pe(404, { error: "Cannot GET /x" }, "Cannot GET /x"), { kind: "not_enabled", reason: "not_served" }],
    ["404 item-not-found problem", problem(404, "item-not-found"), { kind: "not_found", slug: "item-not-found" }],
    ["404 site-not-found problem", problem(404, "site-not-found"), { kind: "not_found", slug: "site-not-found" }],
    ["401 (session)", pe(401), { kind: "unavailable", code: "upstream_error", reason: "session_expired" }],
    ["editorial-assertion refusal is a config fault, not 'you may not'", problem(403, "editorial-assertion-expired"), { kind: "unavailable", code: "upstream_error" }],
    ["500", pe(500, { error: "boom" }, "boom"), { kind: "unavailable", code: "upstream_error", reason: "boom" }],
    ["a thrown network error", new Error("ECONNREFUSED"), { kind: "unavailable", code: "network", reason: "ECONNREFUSED" }],
    ["a WireDrift", new WireDrift("a.b", "string", 1), { kind: "unavailable", code: "contract_drift" }],
  ])("%s", (_n, err, want) => {
    expect(resultFromError(err)).toMatchObject(want);
  });

  it("409 version-conflict carries the head the BFF reported (RFC 9457 passthrough)", () => {
    const r = resultFromError(problem(409, "version-conflict", { currentHeadVersion: 13, currentContentHash: "hh", updatedAt: "2026-10-10T10:41:00Z" }));
    expect(r).toEqual({ kind: "conflict", slug: "version-conflict", message: "version-conflict", currentHeadVersion: 13, currentContentHash: "hh", updatedAt: "2026-10-10T10:41:00Z" });
  });
  it("…and ALSO through HttpErrorFilter's `{ error, reason, existing }` reshape", () => {
    const r = resultFromError(new PlatformError(409, "version conflict", undefined, { currentHeadVersion: 5 }, "version-conflict", { error: "version conflict", reason: "version-conflict", existing: { currentHeadVersion: 5 } }));
    expect(r).toMatchObject({ kind: "conflict", slug: "version-conflict", currentHeadVersion: 5 });
  });
  it("404 version-not-found is a not_found (a real answer), not 'not served on this deployment'", () => {
    expect(resultFromError(problem(404, "version-not-found"))).toEqual({ kind: "not_found", slug: "version-not-found" });
  });
  it("other 409 slugs stay distinct from version-conflict", () => {
    expect(resultFromError(problem(409, "slug-taken"))).toMatchObject({ kind: "conflict", slug: "slug-taken", currentHeadVersion: null });
  });
  it("422 composition-violation yields issues located by pointer", () => {
    const r = resultFromError(problem(422, "composition-violation", { issues: [{ path: "/blocks/0/props/faq/2/answer", message: "required", expected: "text" }] }));
    expect(r).toEqual({ kind: "invalid", issues: [{ path: "/blocks/0/props/faq/2/answer", message: "required", expected: "text" }], message: "composition-violation" });
  });
  it("a 422 with no usable issues still produces ONE issue, never an empty (silently valid-looking) list", () => {
    const r = resultFromError(problem(422, "composition-violation", { issues: "nope" }));
    expect(r.kind === "invalid" && r.issues.length).toBe(1);
  });
  it("413 reads as a size problem in plain words", () => {
    expect(resultFromError(problem(413, "payload-too-large"))).toMatchObject({ kind: "invalid", message: expect.stringMatching(/too large/) });
  });
  it("problemOf reads the slug from `type`, `reason`, or a token `error`, in that order", () => {
    expect(problemOf(problem(409, "slug-taken")).slug).toBe("slug-taken");
    expect(problemOf(new PlatformError(409, "m", undefined, undefined, "twin-locale-taken", { error: "m", reason: "twin-locale-taken" })).slug).toBe("twin-locale-taken");
    expect(problemOf(new PlatformError(503, "editorial_unavailable", undefined, undefined, undefined, { error: "editorial_unavailable" })).slug).toBe("editorial_unavailable");
    expect(problemOf(new PlatformError(500, "Something went wrong badly", undefined, undefined, undefined, { error: "Something went wrong badly" })).slug).toBeNull();
  });
});

describe("NO path turns a refusal into []  (the library's one rule)", () => {
  const statuses = [401, 403, 404, 409, 500, 503];
  const readers: [string, () => Promise<{ kind: string }>][] = [
    ["listSites", () => listSites("u", "c")],
    ["listCollections", () => listCollections("u", "c", "gaiada", "s1")],
    ["listItems", () => listItems("u", "c", "gaiada", "s1", "service", {})],
    ["getItem", () => getItem("u", "c", "gaiada", "s1", "i1", "head")],
    ["listVersions", () => listVersions("u", "c", "gaiada", "s1", "i1")],
    ["getVersion", () => getVersion("u", "c", "gaiada", "s1", "i1", 2)],
    ["getBuildStatus", () => getBuildStatus("u", "c", "gaiada", "s1")],
    ["getApprovalRow", () => getApprovalRow("u", "c", "a1")],
    ["findPendingPublishRequests", () => findPendingPublishRequests("u", "c", "gaiada", "s1", "i1")],
    ["listOwnPublishRequests", () => listOwnPublishRequests("u", "c", "gaiada", "s1", "all")],
    ["resolveItemBySlug", () => resolveItemBySlug("u", "c", "gaiada", "s1", "service", "service.seo", "en")],
    ["loadSiteContext", () => loadSiteContext("u", "c", "gaiada", "s1")],
    ["loadEditorBundle", () => loadEditorBundle("u", "c", "gaiada", "s1", "service", "service.seo", "en")],
  ];
  for (const [name, call] of readers) {
    it(`${name}: every refusal status is a non-ok result with no \`data\``, async () => {
      for (const s of statuses) {
        fetchMock.mockRejectedValue(new PlatformError(s, `platform ${s}`));
        const r = await call();
        expect(r.kind, `${name} @ ${s}`).not.toBe("ok");
        expect("data" in r, `${name} @ ${s} must not carry data`).toBe(false);
      }
    });
    it(`${name}: a socket failure is unavailable/network, not an empty list`, async () => {
      fetchMock.mockRejectedValue(new Error("socket hang up"));
      expect(await call()).toMatchObject({ kind: "unavailable", code: "network" });
    });
  }
  it("a successful EMPTY read is `ok` with an empty list — emptiness is evidence only there", async () => {
    fetchMock.mockResolvedValue({ items: [], page: { cursor: null, hasMore: false, limit: 100 } });
    expect(await listItems("u", "c", "gaiada", "s1", "service", {})).toEqual({ kind: "ok", data: { items: [], page: { cursor: null, hasMore: false, limit: 100 } } });
  });
  it("findPendingPublishRequests: a 403 is a refusal, never 'none pending'", async () => {
    fetchMock.mockRejectedValue(new PlatformError(403, "not authorized"));
    const r = await findPendingPublishRequests("u", "c", "gaiada", "s1", "i1");
    expect(r.kind).not.toBe("ok");
    expect("data" in r).toBe(false);
  });
});

describe("request shapes", () => {
  it("encodes every path segment (an item id or slug can never escape its position)", async () => {
    fetchMock.mockResolvedValue(detail());
    await getItem("u", "co/../x", "ga iada", "s?1", "i/1", 3);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe("/api/co%2F..%2Fx/modules/webdev/content/sites/ga%20iada/s%3F1/items/i%2F1?version=3");
  });
  it("caps the list page size at 100 and forwards the filters", async () => {
    fetchMock.mockResolvedValue({ items: [], page: { cursor: null, hasMore: false, limit: 100 } });
    await listItems("u", "c", "gaiada", "s1", "service", { locale: "id", state: "pending", q: "seo", cursor: "100", limit: 5000 });
    const url = new URL(fetchMock.mock.calls[0][0] as string, "http://x");
    expect(Object.fromEntries(url.searchParams)).toEqual({ locale: "id", state: "pending", q: "seo", cursor: "100", limit: "100" });
  });
  it("wdCall forwards init (method/body) untouched and validates the response", async () => {
    fetchMock.mockResolvedValue(writeResult());
    const r = await wdCall("/p", "u", parseItemWriteResult, { method: "PUT", body: "{}" });
    expect(r.kind).toBe("ok");
    expect(fetchMock.mock.calls[0][2]).toEqual({ method: "PUT", body: "{}" });
  });
});

describe("resolveItemBySlug pages through the list (WSK-59 has no by-slug read)", () => {
  it("finds an item on a later page", async () => {
    fetchMock
      .mockResolvedValueOnce({ items: [summary({ itemId: "a", slug: "a" })], page: { cursor: "1", hasMore: true, limit: 1 } })
      .mockResolvedValueOnce({ items: [summary({ itemId: "b", slug: "service.seo" })], page: { cursor: null, hasMore: false, limit: 1 } });
    const r = await resolveItemBySlug("u", "c", "gaiada", "s1", "service", "service.seo", "en");
    expect(r).toMatchObject({ kind: "ok", data: { itemId: "b" } });
    expect(new URL(fetchMock.mock.calls[1][0] as string, "http://x").searchParams.get("cursor")).toBe("1");
  });
  it("reports not_found only after the list is exhausted — and an error mid-walk is NOT 'not found'", async () => {
    const empty = { items: [], page: { cursor: null, hasMore: false, limit: 100 } };
    fetchMock.mockResolvedValueOnce(empty).mockResolvedValueOnce(empty); // live list, then the deleted list
    expect(await resolveItemBySlug("u", "c", "gaiada", "s1", "service", "nope", "en")).toEqual({ kind: "not_found", slug: "item-not-found" });
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce({ items: [], page: { cursor: "1", hasMore: true, limit: 1 } })
      .mockRejectedValueOnce(new PlatformError(503, "editorial_unavailable", undefined, undefined, undefined, { error: "editorial_unavailable" }));
    expect(await resolveItemBySlug("u", "c", "gaiada", "s1", "service", "x", "en")).toMatchObject({ kind: "unavailable", code: "editorial_unavailable" });
  });
  it("matches the slug AND the locale (twins share a slug)", async () => {
    fetchMock.mockResolvedValueOnce({ items: [summary({ itemId: "id-twin", locale: "id" }), summary({ itemId: "en-item", locale: "en" })], page: { cursor: null, hasMore: false, limit: 100 } });
    expect(await resolveItemBySlug("u", "c", "gaiada", "s1", "service", "service.seo", "en")).toMatchObject({ data: { itemId: "en-item" } });
  });
});

describe("loadEditorBundle", () => {
  const navList = () => ({ items: [summary({ itemId: "i1id", slug: "navigation", locale: "id" }), summary({ itemId: "i1en", slug: "navigation", locale: "en" })], page: { cursor: null, hasMore: false, limit: 100 } });
  function route(over: Record<string, () => unknown> = {}) {
    fetchMock.mockImplementation(async (path: string) => {
      const p = String(path);
      for (const [needle, fn] of Object.entries(over)) if (p.includes(needle)) return fn();
      if (p.endsWith("/content/sites")) return tenants();
      if (p.endsWith("/collections")) return collections();
      if (p.includes("/collections/service/items") || p.includes("/collections/navigation/items")) return { items: [summary({ itemId: "i1" }), summary({ itemId: "i1id", locale: "id" })], page: { cursor: null, hasMore: false, limit: 100 } };
      if (p.includes("/items/i1")) return detail();
      if (p.includes("/publish-requests")) return { requests: [] };
      if (p.endsWith("/build-status")) return { build: null, stagingStale: false };
      throw new PlatformError(404, `unrouted ${p}`);
    });
  }

  it("assembles tenant, site, composition, item, pending requests and build status", async () => {
    route();
    const r = await loadEditorBundle("u", "c", "gaiada", "s1", "service", "service.seo", "en");
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.data.collection.key).toBe("service");
    expect(r.data.detail.item.itemId).toBe("i1");
    expect(r.data.pendingRequests).toEqual([]);
    expect(r.data.build).toEqual({ build: null, stagingStale: false });
    expect(stagingBaseUrl(r.data.site)).toBe("https://24-pyevq.gaiada.com");
  });

  it("defaults to the tenant's default locale when none is asked for", async () => {
    route();
    await loadEditorBundle("u", "c", "gaiada", "s1", "service", "service.seo", null);
    const list = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes("/items?"));
    expect(new URL(list as string, "http://x").searchParams.get("locale")).toBe("en");
  });

  it("a failed SECONDARY read (pending lookup, build status) degrades that panel only and says why", async () => {
    route({ "/publish-requests": () => { throw new PlatformError(403, "not authorized"); }, "/build-status": () => { throw new PlatformError(404, "Cannot GET"); } });
    const r = await loadEditorBundle("u", "c", "gaiada", "s1", "service", "service.seo", "en");
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.data.pendingRequests).toBeNull();
    expect(r.data.pendingProblem).toMatch(/do not have access/);
    expect(r.data.build).toBeNull();
    expect(r.data.buildProblem).toMatch(/not available/);
  });

  it("a failed PRIMARY read is the page's refusal — no bundle at all", async () => {
    route({ "/items/i1": () => { throw new PlatformError(503, "editorial_unavailable", undefined, undefined, undefined, { error: "editorial_unavailable" }); } });
    const r = await loadEditorBundle("u", "c", "gaiada", "s1", "service", "service.seo", "en");
    expect(r).toMatchObject({ kind: "unavailable", code: "editorial_unavailable" });
  });

  it("an unknown site or collection is not_found, distinguishable from a refusal", async () => {
    route();
    expect(await loadEditorBundle("u", "c", "gaiada", "nope", "service", "x", "en")).toEqual({ kind: "not_found", slug: "site-not-found" });
    expect(await loadEditorBundle("u", "c", "gaiada", "s1", "ghost", "x", "en")).toEqual({ kind: "not_found", slug: "collection-not-found" });
  });

  it("non-default locale + locale-neutral members: loads the default-locale twin as the authoritative copy", async () => {
    route({
      "/collections/navigation/items": navList,
      "/items/i1id": () => detail({ item: ref({ itemId: "i1id", collectionKey: "navigation", locale: "id" }), group: [{ locale: "en", itemId: "i1en", slug: "navigation", headVersion: 1, publishedVersion: 1, publishState: "published" }] }),
      "/items/i1en": () => detail({ item: ref({ itemId: "i1en", collectionKey: "navigation" }), version: { n: 1, contentHash: "h", createdAt: "t", createdBy: "u", attribution: {}, note: null, blocks: [{ type: "fields", props: { cta: { label: "EN", url: "/free-audit/" } } }], seo: {} } }),
    });
    const r = await loadEditorBundle("u", "c", "gaiada", "s1", "navigation", "navigation", "id");
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.data.authoritative).toEqual({ locale: "en", fields: { cta: { label: "EN", url: "/free-audit/" } } });
    expect(r.data.authoritativeProblem).toBeNull();
  });

  it("…and says so when the default-locale twin does not exist or cannot be read", async () => {
    route({ "/collections/navigation/items": navList, "/items/i1id": () => detail({ item: ref({ itemId: "i1id", collectionKey: "navigation", locale: "id" }), group: [] }) });
    const r = await loadEditorBundle("u", "c", "gaiada", "s1", "navigation", "navigation", "id");
    expect(r.kind === "ok" && r.data.authoritative).toBeNull();
    expect(r.kind === "ok" && r.data.authoritativeProblem).toMatch(/no en version yet/);
  });

  it("does not look for an authoritative copy on the default locale or a composition with no neutral members", async () => {
    route();
    const r = await loadEditorBundle("u", "c", "gaiada", "s1", "service", "service.seo", "id");
    expect(r.kind === "ok" && r.data.authoritative).toBeNull();
    expect(r.kind === "ok" && r.data.authoritativeProblem).toBeNull();
  });
});

const reqRow = (over: Record<string, unknown> = {}) => ({ approvalId: "a1", status: "pending", createdAt: "2026-10-10T08:00:00Z", itemIds: ["i1"], executionStatus: "not_applicable", ...over });

describe("findPendingPublishRequests (WSK-44b: the caller's OWN requests route, not the generic approvals list)", () => {
  it("keeps only pending requests that name the item", async () => {
    fetchMock.mockResolvedValue({ requests: [
      reqRow(),
      reqRow({ approvalId: "a2", itemIds: ["other"] }),
      reqRow({ approvalId: "a3", status: "approved", itemIds: ["i1"] }),
    ] });
    expect(await findPendingPublishRequests("u", "c", "gaiada", "s1", "i1")).toEqual({ kind: "ok", data: [{ approvalId: "a1" }] });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/c/modules/webdev/content/sites/gaiada/s1/publish-requests?status=pending");
  });
  it("a body that is not {requests:[...]} is drift", async () => {
    fetchMock.mockResolvedValue([]);
    expect(await findPendingPublishRequests("u", "c", "gaiada", "s1", "i1")).toMatchObject({ kind: "unavailable", code: "contract_drift" });
    expect(() => parsePublishRequests({ requests: [reqRow({ itemIds: "i1" })] })).toThrow(WireDrift);
    expect(() => parsePublishRequests({ requests: [reqRow({ status: "withdrawn" })] })).toThrow(WireDrift);
    expect(() => parsePublishRequests({ requests: [reqRow({ executionStatus: undefined })] })).toThrow(WireDrift);
  });
  it("accepts every status the BFF can send, and a null executionStatus", () => {
    const rows = parsePublishRequests({ requests: ["pending", "approved", "rejected", "cancelled"].map((status) => reqRow({ status, executionStatus: null })) });
    expect(rows.map((r) => r.status)).toEqual(["pending", "approved", "rejected", "cancelled"]);
  });
});

describe("pollApproval: the detail route needs automation_approval:read, so a requester falls back to their own requests", () => {
  const detailRow = { id: "a1", workflowId: "content.publish", status: "approved", executionStatus: "executed", createdAt: "t", toolArgs: {} };
  it("uses the detail row when it is readable", async () => {
    fetchMock.mockResolvedValue(detailRow);
    expect(await pollApproval("u", "c", "gaiada", "s1", "a1")).toMatchObject({ kind: "ok", data: { id: "a1", status: "approved" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("on 403 reads the requester's own request (status + executionStatus survive; names do not)", async () => {
    fetchMock.mockImplementation(async (p: string) => {
      if (String(p).includes("/automation-approvals/")) throw new PlatformError(403, "not authorized");
      return { requests: [reqRow({ status: "approved", executionStatus: "executed" })] };
    });
    const r = await pollApproval("u", "c", "gaiada", "s1", "a1");
    expect(r).toMatchObject({ kind: "ok", data: { id: "a1", status: "approved", executionStatus: "executed", decidedByName: null, executionError: null } });
    expect(String(fetchMock.mock.calls[1][0])).toBe("/api/c/modules/webdev/content/sites/gaiada/s1/publish-requests?status=all");
  });
  it("on 403 for an id that is not the caller's own request: still forbidden, never a fabricated row", async () => {
    fetchMock.mockImplementation(async (p: string) => {
      if (String(p).includes("/automation-approvals/")) throw new PlatformError(403, "not authorized");
      return { requests: [reqRow({ approvalId: "someone-elses" })] };
    });
    expect(await pollApproval("u", "c", "gaiada", "s1", "a1")).toMatchObject({ kind: "forbidden" });
  });
  it("a 404 or 5xx on the detail is NOT retried through the list", async () => {
    fetchMock.mockRejectedValue(new PlatformError(404, "approval not found"));
    expect((await pollApproval("u", "c", "gaiada", "s1", "a1")).kind).not.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("resolveAuthorNames is COSMETIC, and the only read here that swallows a failure", () => {
  it("maps user ids to names", async () => {
    members.mockResolvedValue([{ user_id: "u1", name: "Dewi" }] as never);
    expect(await resolveAuthorNames("u", "c")).toEqual({ u1: "Dewi" });
  });
  it("returns an empty map on failure so authors fall back to short ids (it never states anything about content)", async () => {
    members.mockRejectedValue(new Error("403"));
    expect(await resolveAuthorNames("u", "c")).toEqual({});
  });
});
