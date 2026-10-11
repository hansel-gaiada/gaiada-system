import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: () => undefined, set: vi.fn() })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    const e = new Error("NEXT_REDIRECT") as Error & { digest: string };
    e.digest = `NEXT_REDIRECT;push;${url};307;`;
    throw e;
  }),
}));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./portal-company", () => ({ getActivePortalCompany: vi.fn(async () => ({ id: "co-1", name: "Gaia" })) }));
vi.mock("./portal-data", () => ({ getPortalOverview: vi.fn() }));
vi.mock("./entities", () => ({ listMembers: vi.fn() }));
vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn() };
});

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getMe, platformFetch, PlatformError } from "./platform";
import {
  portalApproveRequestAction, portalCreateItemAndOpenAction, portalMintUploadTokenAction, portalPreviewItemAction, portalPublishItemAction,
  portalRequestPublishAction, portalRestoreVersionAndOpenAction, portalSaveItemAction, portalUpdateMediaAction, portalWithdrawRequestAction,
} from "./portalWebsiteActions";
import { isNextRedirect } from "./webdeskContentModel";

const fetchMock = vi.mocked(platformFetch);
const redirectMock = vi.mocked(redirect);
const SCOPE = { tenantSlug: "gaiada", siteId: "site-1" };
const CLIENT = "c1";
const BASE = `/api/co-1/portal/clients/${CLIENT}/website`;
const SITE = `${BASE}/sites/gaiada/site-1`;
const grant = (id: string) => ({ role: "client_website_editor", scopeType: "client", scopeId: id });
const ref = (over: Record<string, unknown> = {}) => ({ itemId: "i2", collectionKey: "service", locale: "en", slug: "service.new", localizationGroupId: "g1", headVersion: 1, publishedVersion: null, publishState: "draft", publishAt: null, unpublishAt: null, deletedAt: null, updatedAt: "t", ...over });
const written = (over: Record<string, unknown> = {}) => ({ item: ref(over), version: { version: 1, contentHash: "h", createdAt: "t" }, unchanged: false, lint: {}, replayed: false });
const approvedBody = { approvalId: "a1", status: "approved", executionStatus: "executed", selfPublish: true, reconciled: false, items: [] };

beforeEach(() => {
  fetchMock.mockReset(); redirectMock.mockClear(); vi.mocked(revalidatePath).mockClear();
  vi.mocked(getMe).mockResolvedValue({ userId: "u1", name: "Dana", email: "d@x", title: null, assurance: "x", companies: [], roles: [{ role: "client", scopeType: "company", scopeId: "co-1" }, grant(CLIENT)], clientOf: [{ companyId: "co-1", companyName: "Gaia" }] } as never);
});

describe("every action refuses a client the viewer holds no website-editor grant for, BEFORE any network call", () => {
  it("a forged or ungranted clientId never reaches the BFF", async () => {
    for (const forged of ["other-client", "", "../../etc", "c1/../x", "c 1"]) {
      const calls = [
        await portalSaveItemAction(forged, SCOPE, "i1", { baseVersion: 1, fields: {} }),
        await portalPublishItemAction(forged, SCOPE, "i1", 1),
        await portalRequestPublishAction(forged, SCOPE, [{ itemId: "i1", version: 1 }]),
        await portalApproveRequestAction(forged, "a1"),
        await portalWithdrawRequestAction(forged, SCOPE, "a1"),
        await portalPreviewItemAction(forged, SCOPE, "i1", 1),
        await portalMintUploadTokenAction(forged, SCOPE, "media"),
        await portalUpdateMediaAction(forged, SCOPE, "m1", { title: "x" }),
      ];
      for (const r of calls) expect(r).toEqual({ kind: "forbidden", reason: "no website editing access" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a staff viewer (no client_website_editor grant) is refused the same way", async () => {
    vi.mocked(getMe).mockResolvedValue({ userId: "u1", roles: [{ role: "platform_admin", scopeType: "global", scopeId: null }], companies: [] } as never);
    expect(await portalPublishItemAction(CLIENT, SCOPE, "i1", 1)).toMatchObject({ kind: "forbidden" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no session is a typed 'unavailable', and no portal company is too", async () => {
    const { getSessionUserId } = await import("./session-server");
    vi.mocked(getSessionUserId).mockResolvedValueOnce(null as never);
    expect(await portalPublishItemAction(CLIENT, SCOPE, "i1", 1)).toMatchObject({ kind: "unavailable", reason: "session_expired" });
    const { getActivePortalCompany } = await import("./portal-company");
    vi.mocked(getActivePortalCompany).mockResolvedValueOnce(null);
    expect(await portalPublishItemAction(CLIENT, SCOPE, "i1", 1)).toMatchObject({ kind: "unavailable", reason: "no_active_company" });
  });
});

describe("save: { baseVersion, fields, note } and NEVER seo or blocks", () => {
  it("PUTs the §16j update route with only those keys, even when the caller passes seo and blocks", async () => {
    fetchMock.mockResolvedValue(written());
    const r = await portalSaveItemAction(CLIENT, SCOPE, "i1", { baseVersion: 3, fields: { h1: "x" }, blocks: [{ type: "hero" }], seo: { title: "t" }, note: " tidy " });
    expect(r.kind).toBe("ok");
    const [path, user, init] = fetchMock.mock.calls[0];
    expect(path).toBe(`${SITE}/items/i1`);
    expect(user).toBe("u1");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({ baseVersion: 3, fields: { h1: "x" }, note: "tidy" });
  });
  it("a missing base version is refused before any call", async () => {
    expect(await portalSaveItemAction(CLIENT, SCOPE, "i1", { baseVersion: undefined as never, fields: {} })).toMatchObject({ kind: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("a 409 version-conflict comes back as DATA with the slug", async () => {
    fetchMock.mockRejectedValue(new PlatformError(409, "version-conflict", undefined, undefined, undefined, { type: "https://webdesk.gaiada.online/errors/version-conflict", title: "t", status: 409, currentHeadVersion: 6 }));
    expect(await portalSaveItemAction(CLIENT, SCOPE, "i1", { baseVersion: 3, fields: {} })).toMatchObject({ kind: "conflict", slug: "version-conflict", currentHeadVersion: 6 });
  });
});

describe("create: no seo, no twinOf, the collection in the path; the SERVER opens the new page", () => {
  const input = { collectionKey: "service", locale: "en", slug: "service.new", twinOf: "i1", fields: { h1: "x" }, blocks: [], seo: { title: "t" } };

  it("POSTs { locale, slug, fields } and redirects to the new page from the server", async () => {
    fetchMock.mockResolvedValue(written());
    let e: unknown;
    try { await portalCreateItemAndOpenAction(CLIENT, SCOPE, input, "/portal/website/gaiada/site-1"); } catch (x) { e = x; }
    expect(isNextRedirect(e)).toBe(true);
    expect(redirectMock).toHaveBeenCalledWith("/portal/website/gaiada/site-1/service/service.new?locale=en");
    const [path, , init] = fetchMock.mock.calls[0];
    expect(path).toBe(`${SITE}/collections/service/items`);
    expect(JSON.parse(String(init?.body))).toEqual({ locale: "en", slug: "service.new", fields: { h1: "x" } });
  });

  it("a destination that is not a Website page is refused BEFORE anything is written", async () => {
    for (const bad of ["https://evil.example/x", "/departments/d/website/content/a/b", "/portal/website/a", "/portal/website/a/b/c", "//evil"]) {
      expect(await portalCreateItemAndOpenAction(CLIENT, SCOPE, input, bad)).toMatchObject({ kind: "invalid", message: "Not a page in the Website area." });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a refusal (422 field-not-client-editable) returns as DATA and nothing redirects", async () => {
    fetchMock.mockRejectedValue(new PlatformError(422, "x", undefined, undefined, undefined, { type: "https://webdesk.gaiada.online/errors/field-not-client-editable", title: "t", status: 422, issues: [{ path: "/blocks/0/props/template", message: "m" }] }));
    const r = await portalCreateItemAndOpenAction(CLIENT, SCOPE, input, "/portal/website/gaiada/site-1");
    expect(r).toMatchObject({ kind: "invalid", slug: "field-not-client-editable" });
    expect(redirectMock).not.toHaveBeenCalled();
  });
});

describe("restore", () => {
  it("POSTs { version, baseVersion, note } to the restore route, then opens the editor from the server", async () => {
    fetchMock.mockResolvedValue(written());
    let e: unknown;
    try { await portalRestoreVersionAndOpenAction(CLIENT, SCOPE, "i1", 2, 5, "/portal/website/gaiada/site-1/service/service.seo?locale=en", "Restored from v2"); } catch (x) { e = x; }
    expect(isNextRedirect(e)).toBe(true);
    const [path, , init] = fetchMock.mock.calls[0];
    expect(path).toBe(`${SITE}/items/i1/restore`);
    expect(JSON.parse(String(init?.body))).toEqual({ version: 2, baseVersion: 5, note: "Restored from v2" });
  });
  it("refuses an editor href outside the Website area", async () => {
    expect(await portalRestoreVersionAndOpenAction(CLIENT, SCOPE, "i1", 2, 5, "/departments/x/website/content/a/b/c/d", "n")).toMatchObject({ kind: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("publishing: the §16j routes, and nothing the client BFF does not have", () => {
  it("self-publish ONE item: POST …/items/:id/publish { version }, and the page data is dropped", async () => {
    fetchMock.mockResolvedValue(approvedBody);
    const r = await portalPublishItemAction(CLIENT, SCOPE, "i1", 4);
    expect(r).toMatchObject({ kind: "ok", data: { executionStatus: "executed", selfPublish: true } });
    const [path, , init] = fetchMock.mock.calls[0];
    expect(path).toBe(`${SITE}/items/i1/publish`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ version: 4 });
    expect(revalidatePath).toHaveBeenCalledWith("/portal/website", "layout");
  });

  it("a request for a batch: POST …/publish-requests { items }, with NO publishAt / unpublishAt anywhere (a client never schedules)", async () => {
    fetchMock.mockResolvedValue({ approvalId: "a2", command: "content.publish", itemCount: 2 });
    const r = await portalRequestPublishAction(CLIENT, SCOPE, [{ itemId: "i1", version: 4 }, { itemId: "i2", version: 1 }], "monthly update");
    expect(r).toMatchObject({ kind: "ok", data: { itemCount: 2 } });
    const [path, , init] = fetchMock.mock.calls[0];
    expect(path).toBe(`${SITE}/publish-requests`);
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ items: [{ itemId: "i1", version: 4 }, { itemId: "i2", version: 1 }], note: "monthly update" });
    expect(Object.keys(body)).not.toContain("publishAt");
    expect(Object.keys(body)).not.toContain("unpublishAt");
  });

  it("an empty, oversized or malformed batch is refused before any call", async () => {
    expect(await portalRequestPublishAction(CLIENT, SCOPE, [])).toMatchObject({ kind: "invalid" });
    expect(await portalRequestPublishAction(CLIENT, SCOPE, [{ itemId: "i1", version: 0 }])).toMatchObject({ kind: "invalid" });
    expect(await portalRequestPublishAction(CLIENT, SCOPE, Array.from({ length: 101 }, (_, n) => ({ itemId: `i${n}`, version: 1 })))).toMatchObject({ kind: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("approve is POST …/publish-requests/:id/approve on the CLIENT route (not the site's)", async () => {
    fetchMock.mockResolvedValue(approvedBody);
    await portalApproveRequestAction(CLIENT, "a1");
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/publish-requests/a1/approve`);
    expect(fetchMock.mock.calls[0][2]?.method).toBe("POST");
  });

  it("an approve answer that is neither executed nor failed is contract drift, never 'published'", async () => {
    fetchMock.mockResolvedValue({ ...approvedBody, executionStatus: "pending" });
    expect(await portalApproveRequestAction(CLIENT, "a1")).toMatchObject({ kind: "unavailable", code: "contract_drift" });
  });

  it("a self-approved batch is a 403 from the server: returned as data, and nothing is revalidated", async () => {
    fetchMock.mockRejectedValue(new PlatformError(403, "forbidden"));
    expect(await portalApproveRequestAction(CLIENT, "a1")).toMatchObject({ kind: "forbidden" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("withdraw is POST …/sites/:slug/:siteId/publish-requests/:id/withdraw", async () => {
    fetchMock.mockResolvedValue({ approvalId: "a1", status: "cancelled" });
    expect(await portalWithdrawRequestAction(CLIENT, SCOPE, "a1")).toMatchObject({ kind: "ok", data: { status: "cancelled" } });
    expect(fetchMock.mock.calls[0][0]).toBe(`${SITE}/publish-requests/a1/withdraw`);
  });

  it("an approval id that is not an id is refused before any call", async () => {
    expect(await portalApproveRequestAction(CLIENT, "../x")).toMatchObject({ kind: "invalid" });
    expect(await portalWithdrawRequestAction(CLIENT, SCOPE, "a/../b")).toMatchObject({ kind: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("preview and media", () => {
  it("preview is POST …/items/:id/preview { version }, and a malformed link in the answer is drift (no tab is opened)", async () => {
    fetchMock.mockResolvedValue({ previewUrl: "https://stg.example/preview/#t=abc", expiresAt: "2026-10-11T09:00:00Z", version: 4 });
    expect(await portalPreviewItemAction(CLIENT, SCOPE, "i1", 4)).toMatchObject({ kind: "ok", data: { version: 4 } });
    expect(fetchMock.mock.calls[0][0]).toBe(`${SITE}/items/i1/preview`);
    fetchMock.mockResolvedValue({ previewUrl: "http://evil.example/x", expiresAt: "2026-10-11T09:00:00Z", version: 4 });
    expect(await portalPreviewItemAction(CLIENT, SCOPE, "i1", 4)).toMatchObject({ kind: "unavailable", code: "contract_drift" });
  });

  it("an upload token comes from the portal route, for one bucket", async () => {
    fetchMock.mockResolvedValue({ uploadUrl: "https://webdesk.example/v1/t/gaiada/media/upload/T", expiresAt: "2026-10-11T09:00:00Z", maxBytes: 1000, allowedMimes: ["image/png"] });
    expect(await portalMintUploadTokenAction(CLIENT, SCOPE, "media")).toMatchObject({ kind: "ok" });
    expect(fetchMock.mock.calls[0][0]).toBe(`${SITE}/media/upload-token`);
    expect(JSON.parse(String(fetchMock.mock.calls[0][2]?.body))).toEqual({ bucket: "media" });
    expect(await portalMintUploadTokenAction(CLIENT, SCOPE, "files" as never)).toMatchObject({ kind: "invalid" });
  });

  it("a media update is PATCH …/media/:id with only title / alt / tags", async () => {
    const asset = { assetId: "m1", url: "/v1/t/gaiada/media/m1", mime: "image/png", sizeBytes: 1, scanStatus: "clean", title: "T", alt: {}, tags: [], originalFilename: null, width: null, height: null, createdBy: null, createdAt: "t", updatedAt: "t", deletedAt: null };
    fetchMock.mockResolvedValue({ asset });
    await portalUpdateMediaAction(CLIENT, SCOPE, "m1", { title: "T", extra: "x" } as never);
    expect(fetchMock.mock.calls[0][0]).toBe(`${SITE}/media/m1`);
    expect(fetchMock.mock.calls[0][2]?.method).toBe("PATCH");
    expect(JSON.parse(String(fetchMock.mock.calls[0][2]?.body))).toEqual({ title: "T" });
    expect(await portalUpdateMediaAction(CLIENT, SCOPE, "m1", {})).toMatchObject({ kind: "invalid", message: "Nothing to change." });
  });
});

describe("there is no way to do what a client may not", () => {
  it("the actions module exports no delete / unpublish / schedule / rebuild / key action", async () => {
    const mod = await import("./portalWebsiteActions");
    const names = Object.keys(mod);
    expect(names.filter((n) => /delete|unpublish|schedule|rebuild|key|schema/i.test(n))).toEqual([]);
  });
});
