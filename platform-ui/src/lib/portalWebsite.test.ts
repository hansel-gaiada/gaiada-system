import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: () => undefined })) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn((u: string) => { throw new Error(`redirect:${u}`); }) }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./portal-company", () => ({ getActivePortalCompany: vi.fn(async () => ({ id: "co-1", name: "Gaia" })) }));
vi.mock("./portal-data", () => ({ getPortalOverview: vi.fn() }));
vi.mock("./entities", () => ({ listMembers: vi.fn() }));
vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn() };
});

import { getPortalOverview } from "./portal-data";
import { getMe, platformFetch, PlatformError } from "./platform";
import {
  buildRequestViews, listPortalItems, listPortalSites, listPortalVersions, loadPortalEditorBundle, parseApproveResult, parseAuthors, parseClientEditable,
  parsePortalCollections, parsePortalItemDetail, parsePortalRequests, portalAuthorNames, portalCall, portalResultFromError, portalSiteBase, resolvePortalItemBySlug, resolveWebsiteAccess,
} from "./portalWebsite";

const fetchMock = vi.mocked(platformFetch);
const CE = { fields: { h1: true, url: false }, blocks: false, seo: false, create: { allowed: true, reason: null, blockedBy: [] } };
const problem = (status: number, slug: string, extra: Record<string, unknown> = {}) =>
  new PlatformError(status, slug, undefined, undefined, undefined, { type: `https://webdesk.gaiada.online/errors/${slug}`, title: "t", status, ...extra });

describe("paths: every call is the §16j portal route for ONE client", () => {
  it("builds /api/:t/portal/clients/:clientId/website/sites/:slug/:siteId, encoded", () => {
    expect(portalSiteBase("co 1", "c/1", "gaiada", "site-1")).toBe("/api/co%201/portal/clients/c%2F1/website/sites/gaiada/site-1");
  });
});

describe("clientEditable is parsed STRICTLY: a missing or malformed verdict is drift, never 'editable'", () => {
  it("accepts the §16j shape", () => {
    expect(parseClientEditable(CE, "x")).toEqual(CE);
    expect(parseClientEditable({ ...CE, create: { allowed: false, reason: "required-fields-not-editable", blockedBy: ["title"] } }, "x").create.blockedBy).toEqual(["title"]);
  });
  it.each([
    ["no fields", { ...CE, fields: undefined }],
    ["a non-boolean field verdict", { ...CE, fields: { h1: "yes" } }],
    ["seo not false", { ...CE, seo: true }],
    ["no create", { ...CE, create: undefined }],
    ["an unknown create reason", { ...CE, create: { allowed: false, reason: "because", blockedBy: [] } }],
    ["blockedBy not a list", { ...CE, create: { allowed: false, reason: null, blockedBy: "title" } }],
  ])("rejects %s", (_name, v) => {
    expect(() => parseClientEditable(v, "x")).toThrow();
  });

  it("a collections body whose collection lacks clientEditable is drift", () => {
    const col = { key: "service", composition: {}, vocabularyVersion: "1.2.0", counts: { items: 1, byLocale: { en: 1 }, live: 0, pendingChanges: 1 }, updatedAt: "t" };
    expect(parsePortalCollections({ collections: [{ ...col, clientEditable: CE }] })[0].clientEditable).toEqual(CE);
    expect(() => parsePortalCollections({ collections: [col] })).toThrow(/clientEditable/);
  });

  it("an item read without composition or clientEditable is drift", () => {
    const item = { itemId: "i1", collectionKey: "service", locale: "en", slug: "s", localizationGroupId: "g", headVersion: 1, publishedVersion: null, publishState: "draft", publishAt: null, unpublishAt: null, deletedAt: null, updatedAt: "t" };
    const body = { item, version: { n: 1, contentHash: "h", createdAt: "t", createdBy: "u", note: null, blocks: [], seo: {} }, group: [], lint: {} };
    expect(parsePortalItemDetail({ ...body, composition: {}, clientEditable: CE }).clientEditable).toEqual(CE);
    expect(() => parsePortalItemDetail({ ...body, composition: {} })).toThrow(/clientEditable/);
    expect(() => parsePortalItemDetail({ ...body, clientEditable: CE })).toThrow(/composition/);
  });
});

describe("publish requests and the approve answer", () => {
  const row = { approvalId: "a1", status: "pending", createdAt: "t", tenantSlug: "gaiada", siteId: "s1", itemCount: 2, itemIds: ["i1", "i2"], requestedBy: { userId: "u2", name: "Dewi" }, requestedByMe: false, canApprove: true, executionStatus: null };
  it("parses the list row", () => {
    expect(parsePortalRequests({ requests: [row] })[0]).toMatchObject({ approvalId: "a1", requestedBy: { name: "Dewi" }, canApprove: true });
  });
  it("rejects an unknown status and a row without the 'mine' flag", () => {
    expect(() => parsePortalRequests({ requests: [{ ...row, status: "weird" }] })).toThrow();
    expect(() => parsePortalRequests({ requests: [{ ...row, requestedByMe: undefined }] })).toThrow();
  });
  it("the approve answer is executed|failed; anything else is drift, never 'published'", () => {
    expect(parseApproveResult({ approvalId: "a1", status: "approved", executionStatus: "executed", selfPublish: true, reconciled: false, items: [] })).toMatchObject({ executionStatus: "executed", selfPublish: true });
    expect(parseApproveResult({ approvalId: "a1", status: "approved", executionStatus: "failed", error: "version-conflict" }).error).toBe("version-conflict");
    expect(() => parseApproveResult({ approvalId: "a1", status: "approved", executionStatus: "pending" })).toThrow();
  });
});

describe("the portal's error mapper keeps the §16j slug where the staff mapper drops it", () => {
  it("422 field-not-client-editable and publish-not-client-editable stay distinguishable", () => {
    const a = portalResultFromError(problem(422, "field-not-client-editable", { issues: [{ path: "/seo", message: "m" }] }));
    expect(a).toMatchObject({ kind: "invalid", slug: "field-not-client-editable" });
    expect(portalResultFromError(problem(422, "publish-not-client-editable", { issues: [{ path: "/items/0", message: "m" }] }))).toMatchObject({ kind: "invalid", slug: "publish-not-client-editable" });
  });
  it("403 client-command-not-allowed is told apart from a plain 403", () => {
    expect(portalResultFromError(problem(403, "client-command-not-allowed"))).toMatchObject({ kind: "forbidden", slug: "client-command-not-allowed" });
    expect(portalResultFromError(new PlatformError(403, "forbidden"))).toMatchObject({ kind: "forbidden" });
  });
  it("409 version-conflict and item-deleted keep the staff mapper's shape", () => {
    expect(portalResultFromError(problem(409, "version-conflict", { currentHeadVersion: 5 }))).toMatchObject({ kind: "conflict", slug: "version-conflict", currentHeadVersion: 5 });
    expect(portalResultFromError(problem(409, "item-deleted"))).toMatchObject({ kind: "conflict", slug: "item-deleted" });
  });
  it("a 503 is 'unavailable' (never an empty list), and a network failure too", () => {
    expect(portalResultFromError(new PlatformError(503, "editorial_unavailable"))).toMatchObject({ kind: "unavailable", code: "editorial_unavailable" });
    expect(portalResultFromError(new Error("ECONNRESET"))).toMatchObject({ kind: "unavailable", code: "network" });
  });
  it("portalCall: a refusal is a result, and a body that is not the shape is contract_drift", async () => {
    fetchMock.mockRejectedValueOnce(problem(422, "field-not-client-editable", { issues: [] }));
    expect(await portalCall("/x", "u1", (v) => v)).toMatchObject({ kind: "invalid", slug: "field-not-client-editable" });
    fetchMock.mockResolvedValueOnce({ clientId: "c1" });
    expect(await listPortalSites("u1", "co-1", "c1")).toMatchObject({ kind: "unavailable", code: "contract_drift" });
  });
});

describe("reads", () => {
  beforeEach(() => fetchMock.mockReset());
  it("the item list sends the slug and locale filters, and caps the limit", async () => {
    fetchMock.mockResolvedValue({ items: [], page: { cursor: null, hasMore: false, limit: 100 } });
    await listPortalItems("u1", "co-1", "c1", "gaiada", "s1", "service", { slug: "service.seo", locale: "en", limit: 500 });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/api/co-1/portal/clients/c1/website/sites/gaiada/s1/collections/service/items?");
    expect(url).toContain("slug=service.seo");
    expect(url).toContain("locale=en");
    expect(url).toContain("limit=100");
  });

  it("a slug resolves only on an exact slug + locale match (a backend that ignores the filter still works), and walks the pages", async () => {
    const it = (slug: string, locale: string, id: string) => ({ itemId: id, slug, locale, localizationGroupId: "g", title: null, headVersion: 1, publishedVersion: null, publishState: "draft", publishAt: null, unpublishAt: null, deletedAt: null, updatedAt: "t", headCreatedAt: null, headCreatedBy: null, pendingChanges: true });
    fetchMock
      .mockResolvedValueOnce({ items: [it("other", "en", "i0")], page: { cursor: "1", hasMore: true, limit: 100 } })
      .mockResolvedValueOnce({ items: [it("service.seo", "id", "i1"), it("service.seo", "en", "i2")], page: { cursor: null, hasMore: false, limit: 100 } });
    const r = await resolvePortalItemBySlug("u1", "co-1", "c1", "gaiada", "s1", "service", "service.seo", "en");
    expect(r).toMatchObject({ kind: "ok", data: { itemId: "i2" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("no match is item-not-found (a deleted item is never listed to a client)", async () => {
    fetchMock.mockResolvedValue({ items: [], page: { cursor: null, hasMore: false, limit: 100 } });
    expect(await resolvePortalItemBySlug("u1", "co-1", "c1", "gaiada", "s1", "service", "nope", "en")).toEqual({ kind: "not_found", slug: "item-not-found" });
  });

  it("the editor bundle: a site that is not one of THIS client's linked sites is site-not-found, and the collections read is not trusted before it", async () => {
    fetchMock.mockImplementation(async (...args: unknown[]) => { const path = String(args[0]);
      if (path.endsWith("/website")) return { clientId: "c1", sites: [{ tenantSlug: "gaiada", siteId: "mine", name: "Mine", kind: "static", defaultLocale: "en", locales: ["en"], linkedAt: null }] };
      return { collections: [] };
    });
    expect(await loadPortalEditorBundle("u1", "co-1", "c1", "gaiada", "someone-elses", "service", "s", null)).toEqual({ kind: "not_found", slug: "site-not-found" });
  });
});

describe("the page guard: resolveWebsiteAccess", () => {
  const me = (roles: { role: string; scopeType: string; scopeId: string | null }[]) => ({ userId: "u1", name: "Dana", email: "d@x", title: null, assurance: "x", companies: [], roles, clientOf: [{ companyId: "co-1", companyName: "Gaia" }] });
  beforeEach(() => {
    vi.mocked(getPortalOverview).mockResolvedValue({ isPortalClient: true, overview: { clients: [{ id: "c1", name: "Northwind", status: "active" }, { id: "c2", name: "Other", status: "active" }] } as never });
  });

  it("a viewer WITHOUT the grant is 'denied' (the plain no-access page), never an empty list", async () => {
    vi.mocked(getMe).mockResolvedValue(me([{ role: "client", scopeType: "company", scopeId: "co-1" }]) as never);
    expect(await resolveWebsiteAccess()).toEqual({ refused: "denied" });
  });
  it("a staff viewer is denied", async () => {
    vi.mocked(getMe).mockResolvedValue(me([{ role: "platform_admin", scopeType: "global", scopeId: null }]) as never);
    expect(await resolveWebsiteAccess()).toEqual({ refused: "denied" });
  });
  it("the grant for one of the company's clients opens that client", async () => {
    vi.mocked(getMe).mockResolvedValue(me([{ role: "client", scopeType: "company", scopeId: "co-1" }, { role: "client_website_editor", scopeType: "client", scopeId: "c2" }]) as never);
    const a = await resolveWebsiteAccess();
    expect(a).toMatchObject({ tenant: "co-1", clientId: "c2", clientName: "Other", clients: [{ id: "c2", name: "Other" }] });
  });
  it("a grant for a client of ANOTHER company does not count", async () => {
    vi.mocked(getMe).mockResolvedValue(me([{ role: "client_website_editor", scopeType: "client", scopeId: "elsewhere" }]) as never);
    expect(await resolveWebsiteAccess()).toEqual({ refused: "denied" });
  });
  it("an outage while the client list is read: a viewer who HOLDS the grant is told it is unavailable (never 'no access'); anyone else is denied", async () => {
    vi.mocked(getPortalOverview).mockRejectedValue(new Error("down"));
    vi.mocked(getMe).mockResolvedValue(me([{ role: "client_website_editor", scopeType: "client", scopeId: "c1" }]) as never);
    expect(await resolveWebsiteAccess()).toEqual({ refused: "unavailable" });
    vi.mocked(getMe).mockResolvedValue(me([{ role: "client", scopeType: "company", scopeId: "co-1" }]) as never);
    expect(await resolveWebsiteAccess()).toEqual({ refused: "denied" });
  });
  it("a viewer with no client account here is denied", async () => {
    vi.mocked(getMe).mockResolvedValue({ ...me([{ role: "client_website_editor", scopeType: "client", scopeId: "c1" }]), clientOf: [] } as never);
    const { getActivePortalCompany } = await import("./portal-company");
    vi.mocked(getActivePortalCompany).mockResolvedValueOnce(null);
    expect(await resolveWebsiteAccess()).toEqual({ refused: "denied" });
  });
});

describe("authors the portal can name", () => {
  it("the viewer ('you') and requesters; anyone else reads as authorLabel's short id", () => {
    const names = portalAuthorNames({ userId: "u1", name: "Dana" }, [{ requestedBy: { userId: "u2", name: "Dewi" } } as never]);
    expect(names).toEqual({ u2: "Dewi", u1: "Dana (you)" });
  });
});

describe("WSK-359 · requested versions, the rebuild state and author labels on the wire", () => {
  const row = { approvalId: "a1", status: "pending", createdAt: "t", tenantSlug: "gaiada", siteId: "s1", itemCount: 2, itemIds: ["i1", "i2"], requestedBy: { userId: "u2", name: "Dewi" }, requestedByMe: false, canApprove: true, executionStatus: null };

  it("the request row's `items` are the requested versions; a BFF that sends none parses to [] (versions unknown, never guessed)", () => {
    const withItems = parsePortalRequests({ requests: [{ ...row, items: [{ itemId: "i1", version: 4 }, { itemId: "i2", version: 2 }] }] })[0];
    expect(withItems.items).toEqual([{ itemId: "i1", version: 4 }, { itemId: "i2", version: 2 }]);
    expect(parsePortalRequests({ requests: [row] })[0].items).toEqual([]);
    expect(() => parsePortalRequests({ requests: [{ ...row, items: [{ itemId: "i1", version: "4" }] }] })).toThrow();
    expect(() => parsePortalRequests({ requests: [{ ...row, items: [{ itemId: "i1" }] }] })).toThrow();
  });

  it("the approve answer's `build` is {state, failureReason}; absent is null; an unknown state is drift, never 'live'", () => {
    const base = { approvalId: "a1", status: "approved", executionStatus: "executed", selfPublish: true, reconciled: false, items: [] };
    expect(parseApproveResult({ ...base, build: { state: "rebuilding", failureReason: null } }).build).toEqual({ state: "rebuilding", failureReason: null });
    expect(parseApproveResult({ ...base, build: { state: "failed", failureReason: "rebuild_not_configured" } }).build).toEqual({ state: "failed", failureReason: "rebuild_not_configured" });
    expect(parseApproveResult(base).build).toBeNull();
    expect(parseApproveResult({ ...base, build: null }).build).toBeNull();
    expect(() => parseApproveResult({ ...base, build: { state: "deployed", failureReason: null } })).toThrow(/state/);
    expect(() => parseApproveResult({ ...base, build: { state: "live" } })).toThrow(/failureReason/);
  });

  it("`authors` is a map of strings; absent is {}; a non-string label is drift", () => {
    expect(parseAuthors({ authors: { u1: "Ayu", u2: "Gaiada" } })).toEqual({ u1: "Ayu", u2: "Gaiada" });
    expect(parseAuthors({})).toEqual({});
    expect(() => parseAuthors({ authors: { u1: 3 } })).toThrow();
  });

  it("the versions list read carries the BFF's author labels next to the versions", async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ versions: [{ version: 2, contentHash: "h", createdAt: "t", createdBy: "u9", note: null }], page: { cursor: null, hasMore: false, limit: 100 }, authors: { u9: "Gaiada" } });
    const r = await listPortalVersions("u1", "co-1", "c1", "gaiada", "s1", "i1");
    expect(r).toMatchObject({ kind: "ok", data: { versions: [{ version: 2, createdBy: "u9" }], authors: { u9: "Gaiada" } } });
  });

  it("the item list read carries the labels too, and without them it is {}", async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce({ items: [], page: { cursor: null, hasMore: false, limit: 100 }, authors: { u9: "Someone else" } });
    expect(await listPortalItems("u1", "co-1", "c1", "gaiada", "s1", "service")).toMatchObject({ kind: "ok", data: { authors: { u9: "Someone else" } } });
    fetchMock.mockResolvedValueOnce({ items: [], page: { cursor: null, hasMore: false, limit: 100 } });
    expect(await listPortalItems("u1", "co-1", "c1", "gaiada", "s1", "service")).toMatchObject({ kind: "ok", data: { authors: {} } });
  });

  it("portalAuthorNames: the BFF's labels first, then requesters, and the viewer ('you') always wins", () => {
    const names = portalAuthorNames({ userId: "u1", name: "Dana" }, [{ requestedBy: { userId: "u2", name: "Dewi" } } as never], { u1: "Dana Smith", u2: "Someone else", u3: "Gaiada" });
    expect(names).toEqual({ u1: "Dana (you)", u2: "Dewi", u3: "Gaiada" });
  });

  describe("buildRequestViews reads each page AT the version the request named", () => {
    const detail = (itemId: string, version: number, h1: string) => ({
      item: { itemId, collectionKey: "service", locale: "en", slug: `slug-${itemId}`, localizationGroupId: "g", headVersion: 9, publishedVersion: 1, publishState: "published", publishAt: null, unpublishAt: null, deletedAt: null, updatedAt: "t" },
      version: { n: version, contentHash: "h", createdAt: "t", createdBy: "u", note: null, blocks: [{ type: "fields", props: { h1 } }], seo: { title: h1 } },
      group: [], lint: {}, composition: {}, clientEditable: CE,
    });
    const asRow = (over: Record<string, unknown> = {}) => ({
      approvalId: "a1", status: "pending", createdAt: "t", tenantSlug: "gaiada", siteId: "s1", itemCount: 2, itemIds: ["i1", "i2"], items: [{ itemId: "i1", version: 4 }],
      requestedBy: { userId: "u2", name: "Dewi" }, requestedByMe: false, canApprove: true, executionStatus: null, ...over,
    });

    it("asks for ?version=<requested> (never the head) when the request names one, shows that version, and the title is that version's", async () => {
      fetchMock.mockReset();
      fetchMock.mockImplementation(async (...args: unknown[]) => {
        const url = String(args[0]);
        if (url.includes("/items/i1") && url.includes("version=4")) return detail("i1", 4, "Home as requested");
        return detail("i2", 9, "About head");
      });
      const views = await buildRequestViews("u1", "co-1", "c1", [asRow()] as never, [{ tenantSlug: "gaiada", siteId: "s1", name: "gaiada.com" }] as never);
      const urls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("/items/i1?version=4"))).toBe(true);
      expect(urls.some((u) => u.includes("/items/i1?version=head"))).toBe(false);
      expect(views[0].items[0]).toEqual({ itemId: "i1", title: "Home as requested", version: 4, available: true });
      // i2 is in `itemIds` but the stored request names no version for it: its title is read from the head and NO version is claimed.
      expect(urls.some((u) => u.includes("/items/i2?version=head"))).toBe(true);
      expect(views[0].items[1]).toEqual({ itemId: "i2", title: "About head", version: null, available: true });
      expect(views[0].siteName).toBe("gaiada.com");
    });

    it("a page that cannot be read stays in the card as unavailable and keeps its requested version", async () => {
      fetchMock.mockReset();
      fetchMock.mockRejectedValue(new PlatformError(404, "item-not-found", undefined, undefined, undefined, { type: "https://webdesk.gaiada.online/errors/item-not-found", title: "t", status: 404 }));
      const views = await buildRequestViews("u1", "co-1", "c1", [asRow({ itemIds: ["i1"], itemCount: 1 })] as never, []);
      expect(views[0].items).toEqual([{ itemId: "i1", title: "i1", version: 4, available: false }]);
    });
  });
});
