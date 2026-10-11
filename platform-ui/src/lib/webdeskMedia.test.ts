import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn(async () => ({ userId: "u1" })) };
});
vi.mock("./entities", () => ({ listMembers: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));

import { platformFetch, PlatformError } from "./platform";
import { getMediaUsage, listMedia, mediaCall, mediaListQuery, mediaPublicBase } from "./webdeskMedia";
import { parseMediaDeleted, parseMediaList } from "./webdeskMediaModel";
import {
  deleteMediaAction, listMediaAction, mediaUsageAction, mintUploadTokenAction, updateMediaAction,
} from "./webdeskMediaActions";

const fetchMock = vi.mocked(platformFetch);
const SCOPE = { tenantSlug: "gaiada", siteId: "site-1" };
const BASE = "/api/co-1/modules/webdev/content/sites/gaiada/site-1/media";

const wireAsset = (over: Record<string, unknown> = {}) => ({
  assetId: "a1", url: "/v1/t/gaiada/media/a1", bucket: "media", bucketKey: "k", mime: "image/png", sizeBytes: 10, scanStatus: "clean", title: null, alt: {}, tags: [],
  originalFilename: "a.png", width: 1, height: 1, createdBy: "u1", createdAt: "2026-10-11T08:00:00.000Z", updatedAt: "2026-10-11T08:00:00.000Z", deletedAt: null, ...over,
});
const page = { cursor: null, hasMore: false, limit: 48 };
const problem = (status: number, slug: string, ext: Record<string, unknown> = {}) =>
  new PlatformError(status, slug, undefined, undefined, undefined, { type: `https://webdesk.gaiada.online/errors/${slug}`, title: slug, status, ...ext });

beforeEach(() => { fetchMock.mockReset(); });
afterEach(() => { delete process.env.WEBDESK_PUBLIC_BASE_URL; });

describe("reads", () => {
  it("lists with only the filters WebDesk takes, a bounded limit, and validates the body", async () => {
    fetchMock.mockResolvedValue({ assets: [wireAsset()], page });
    const r = await listMedia("u1", "co-1", "gaiada", "site-1", { mime: "image/*", q: "hero", tag: "x", cursor: "c1", limit: 9999 });
    expect(r.kind).toBe("ok");
    const url = new URL(`http://x${fetchMock.mock.calls[0][0]}`);
    expect(url.pathname).toBe(BASE);
    expect(Object.fromEntries(url.searchParams)).toEqual({ mime: "image/*", q: "hero", tag: "x", cursor: "c1", limit: "100" });
    expect(mediaListQuery()).toBe("limit=48");
  });

  it("a 2xx body that breaks the contract is drift, never an empty list", async () => {
    fetchMock.mockResolvedValue({ assets: "nope", page });
    const r = await listMedia("u1", "co-1", "gaiada", "site-1");
    expect(r).toMatchObject({ kind: "unavailable", code: "contract_drift", reason: expect.stringContaining("media.assets") });
  });

  it.each([
    [503, { error: "editorial_unavailable", reason: "circuit_open" }, "unavailable"],
    [403, { error: "not authorized: webdesk_media_asset:read" }, "forbidden"],
    [404, { type: "https://webdesk.gaiada.online/errors/site-not-found", title: "x", status: 404 }, "not_found"],
    [404, { error: "module webdev not enabled for this company" }, "not_enabled"],
  ])("HTTP %i is its own state, not an empty list (%s)", async (status, body, kind) => {
    fetchMock.mockRejectedValue(new PlatformError(status, "x", undefined, undefined, (body as { reason?: string }).reason, body));
    expect((await listMedia("u1", "co-1", "gaiada", "site-1")).kind).toBe(kind);
  });

  it("usage: validates; an unknown asset is a real answer (not 'not served')", async () => {
    fetchMock.mockResolvedValueOnce({ assetId: "a1", url: "/v1/t/gaiada/media/a1", total: 1, items: [{ itemId: "i", collectionKey: "service", locale: "en", slug: "service.seo", in: "live" }] });
    expect(await getMediaUsage("u1", "co-1", "gaiada", "site-1", "a1")).toMatchObject({ kind: "ok", data: { total: 1 } });
    fetchMock.mockRejectedValueOnce(problem(404, "media-asset-not-found"));
    expect(await getMediaUsage("u1", "co-1", "gaiada", "site-1", "nope")).toEqual({ kind: "not_found", slug: "media-asset-not-found" });
  });

  it("the preview base: a plain https origin, or loopback http in dev; anything else is none", () => {
    expect(mediaPublicBase()).toBeNull();
    for (const [raw, want] of [
      ["https://webdesk.gaiada.online", "https://webdesk.gaiada.online"], ["https://webdesk.gaiada.online/", "https://webdesk.gaiada.online"],
      ["http://127.0.0.1:3991", "http://127.0.0.1:3991"], ["http://webdesk.gaiada.online", null], ["https://u:p@h.example", null], ["https://h.example/?q=1", null], ["nope", null],
    ] as const) {
      process.env.WEBDESK_PUBLIC_BASE_URL = raw;
      expect(mediaPublicBase()).toBe(want);
    }
  });
});

describe("mediaCall: the two answers `resultFromError` cannot express", () => {
  it("409 media-in-use carries the items that use the asset, and the full total", async () => {
    const items = [{ itemId: "i1", collectionKey: "service", locale: "en", slug: "service.seo", in: "live" }, { itemId: "i2", collectionKey: "service", locale: "id", slug: "service.seo", in: "head" }];
    fetchMock.mockRejectedValue(problem(409, "media-in-use", { detail: "still used", total: 7, items }));
    const r = await mediaCall(`${BASE}/a1`, "u1", parseMediaDeleted, { method: "DELETE" });
    expect(r).toEqual({ kind: "in_use", message: "still used", total: 7, items });
  });

  it("a 409 media-in-use whose items are malformed is drift, never a quiet empty list", async () => {
    fetchMock.mockRejectedValue(problem(409, "media-in-use", { total: 1, items: [{ itemId: 3 }] }));
    expect(await mediaCall(`${BASE}/a1`, "u1", parseMediaDeleted, { method: "DELETE" })).toMatchObject({ kind: "unavailable", code: "contract_drift" });
  });

  it("404 media-asset-not-found is not_found; a 409 media-asset-deleted stays a conflict", async () => {
    fetchMock.mockRejectedValueOnce(problem(404, "media-asset-not-found"));
    expect(await mediaCall(`${BASE}/a1`, "u1", parseMediaList)).toEqual({ kind: "not_found", slug: "media-asset-not-found" });
    fetchMock.mockRejectedValueOnce(problem(409, "media-asset-deleted", { detail: "gone" }));
    expect(await mediaCall(`${BASE}/a1`, "u1", parseMediaList)).toMatchObject({ kind: "conflict", slug: "media-asset-deleted" });
  });
});

describe("server actions", () => {
  it("mint: POST {bucket} and nothing else; the token comes back only in the result", async () => {
    fetchMock.mockResolvedValue({ uploadUrl: "https://webdesk.example/v1/t/gaiada/media/upload/T0K", expiresAt: "2026-10-11T08:10:00Z", maxBytes: 5242880, allowedMimes: ["image/png"] });
    const r = await mintUploadTokenAction(SCOPE, "media");
    expect(r.kind).toBe("ok");
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/upload-token`, "u1", { method: "POST", body: JSON.stringify({ bucket: "media" }) });
    expect((await mintUploadTokenAction(SCOPE, "audio" as never)).kind).toBe("invalid");
  });

  it("mint when WebDesk's public URL is not configured: the reason survives, so the UI can say uploads are not enabled", async () => {
    fetchMock.mockRejectedValue(new PlatformError(503, "webdesk_not_configured", undefined, undefined, "webdesk_public_url_not_configured", { error: "webdesk_not_configured", reason: "webdesk_public_url_not_configured" }));
    expect(await mintUploadTokenAction(SCOPE, "media")).toMatchObject({ kind: "unavailable", reason: "webdesk_public_url_not_configured" });
  });

  it("update: PATCH with only the keys given, replace-all values, and the Idempotency-Key", async () => {
    fetchMock.mockResolvedValue({ asset: wireAsset({ alt: { en: "x" } }) });
    const r = await updateMediaAction(SCOPE, "a1", { alt: { en: "x", id: "y" }, tags: ["a"] }, "key-12345678");
    expect(r.kind).toBe("ok");
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/a1`, "u1", { method: "PATCH", body: JSON.stringify({ alt: { en: "x", id: "y" }, tags: ["a"] }), headers: { "idempotency-key": "key-12345678" } });
    // a title can be cleared with null; nothing to change is refused before it is sent
    fetchMock.mockClear(); fetchMock.mockResolvedValue({ asset: wireAsset() });
    await updateMediaAction(SCOPE, "a1", { title: null });
    expect(JSON.parse(fetchMock.mock.calls[0][2]!.body as string)).toEqual({ title: null });
    expect(fetchMock.mock.calls[0][2]!.headers).toEqual({});
    fetchMock.mockClear();
    expect(await updateMediaAction(SCOPE, "a1", {})).toMatchObject({ kind: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a malformed Idempotency-Key is dropped, never forwarded", async () => {
    fetchMock.mockResolvedValue({ asset: wireAsset() });
    await updateMediaAction(SCOPE, "a1", { title: "x" }, "short");
    expect(fetchMock.mock.calls[0][2]!.headers).toEqual({});
  });

  it("delete: DELETE, no body; a 409 comes back as in_use with its items", async () => {
    fetchMock.mockResolvedValueOnce({ assetId: "a1", deletedAt: "2026-10-11T08:00:00.000Z", purgeAfter: "2026-10-12T08:00:00.000Z", alreadyDeleted: false });
    expect(await deleteMediaAction(SCOPE, "a1", "key-12345678")).toMatchObject({ kind: "ok", data: { alreadyDeleted: false } });
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/a1`, "u1", { method: "DELETE", headers: { "idempotency-key": "key-12345678" } });
    fetchMock.mockRejectedValueOnce(problem(409, "media-in-use", { total: 1, items: [{ itemId: "i", collectionKey: "service", locale: "en", slug: "service.seo", in: "head" }] }));
    expect(await deleteMediaAction(SCOPE, "a1")).toMatchObject({ kind: "in_use", total: 1, items: [{ slug: "service.seo" }] });
  });

  it("list: unknown filter keys and an out-of-shape mime are dropped before they reach the BFF (it 400s unknown keys)", async () => {
    fetchMock.mockResolvedValue({ assets: [], page });
    await listMediaAction(SCOPE, { mime: "not a mime", q: "  hero  ", tag: "t", evil: "x" } as never);
    const url = new URL(`http://x${fetchMock.mock.calls[0][0]}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "hero", tag: "t", limit: "48" });
  });

  it("a missing site or asset is refused before anything is sent", async () => {
    expect((await listMediaAction({ tenantSlug: "", siteId: "" })).kind).toBe("invalid");
    expect((await mediaUsageAction(SCOPE, " ")).kind).toBe("invalid");
    expect((await deleteMediaAction(SCOPE, "")).kind).toBe("invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
