import { describe, it, expect, vi, beforeEach } from "vitest";

// The writes that LEAVE the page (create, twin-create, restore) navigate from the SERVER: on success the action calls
// `redirect()` (Next applies the destination inside the action's own response), on failure it returns the SAME typed
// result as the plain action. See the header of webdeskContentActions.ts for why a client `router.push` was not enough.

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    const e = new Error("NEXT_REDIRECT") as Error & { digest: string };
    e.digest = `NEXT_REDIRECT;push;${url};307;`;
    throw e;
  }),
}));
vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn(async () => ({ id: "u1", companies: [], roles: [] })) };
});
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("./entities", () => ({ listMembers: vi.fn() }));

import { redirect } from "next/navigation";
import { platformFetch, PlatformError } from "./platform";
import { createItemAndOpenAction, restoreVersionAndOpenAction } from "./webdeskContentActions";
import { isNextRedirect } from "./webdeskContentModel";

const fetchMock = vi.mocked(platformFetch);
const redirectMock = vi.mocked(redirect);
const SCOPE = { tenantSlug: "gaiada", siteId: "site-1" };
const BASE = "/departments/dept-1/website/content/gaiada/site-gaiada-com";
const ref = (over: Record<string, unknown> = {}) => ({
  itemId: "i2", collectionKey: "service", locale: "id", slug: "service.local-seo", localizationGroupId: "g1",
  headVersion: 1, publishedVersion: null, publishState: "draft", publishAt: null, unpublishAt: null, deletedAt: null, updatedAt: "2026-10-11T08:00:00Z", ...over,
});
const written = (over: Record<string, unknown> = {}) => ({ item: ref(over), version: { version: 1, contentHash: "h1", createdAt: "2026-10-11T08:00:00Z" }, unchanged: false, lint: {}, replayed: false });
const createInput = { collectionKey: "service", locale: "id", slug: "service.local-seo", twinOf: "i1", fields: { h1: "x" }, blocks: [], seo: {} };

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try { await p; } catch (e) { return e; }
  throw new Error("expected the action to redirect");
}

beforeEach(() => { fetchMock.mockReset(); redirectMock.mockClear(); });

describe("createItemAndOpenAction", () => {
  it("success: the create is written, then the action redirects to the NEW item's editor (server's slug and locale)", async () => {
    fetchMock.mockResolvedValue(written({ slug: "service.local-seo", locale: "id" }));
    const e = await rejection(createItemAndOpenAction(SCOPE, createInput, BASE));
    expect(isNextRedirect(e)).toBe(true);
    expect(redirectMock).toHaveBeenCalledWith(`${BASE}/service/service.local-seo?locale=id`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/modules/webdev/content/sites/gaiada/site-1/collections/service/items");
  });

  it("encodes the path parts it builds", async () => {
    fetchMock.mockResolvedValue(written({ slug: "a b", locale: "id" }));
    await rejection(createItemAndOpenAction(SCOPE, { ...createInput, collectionKey: "my coll" }, BASE));
    expect(redirectMock).toHaveBeenCalledWith(`${BASE}/my%20coll/a%20b?locale=id`);
  });

  it("every failure is the plain action's typed result, unchanged, and nothing redirects (409, 422, 403, 503)", async () => {
    const cases: [PlatformError, string][] = [
      [new PlatformError(409, "slug-taken", undefined, undefined, undefined, { type: "https://webdesk.gaiada.online/errors/slug-taken", title: "x", status: 409 }), "conflict"],
      [new PlatformError(422, "composition-violation", undefined, undefined, undefined, { type: "https://webdesk.gaiada.online/errors/composition-violation", title: "x", status: 422, issues: [] }), "invalid"],
      [new PlatformError(403, "forbidden"), "forbidden"],
      [new PlatformError(503, "editorial_unavailable", "circuit_open"), "unavailable"],
    ];
    for (const [err, kind] of cases) {
      fetchMock.mockReset();
      fetchMock.mockRejectedValue(err);
      const r = await createItemAndOpenAction(SCOPE, createInput, BASE);
      expect(r.kind, kind).toBe(kind);
    }
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("refuses a destination outside the Website workspace BEFORE writing anything (no open redirect)", async () => {
    for (const bad of ["https://evil.example/x", "//evil.example", "/approvals", `${BASE}/extra`, `${BASE}?x=1`, "/departments/d/website/content/t"]) {
      const r = await createItemAndOpenAction(SCOPE, createInput, bad);
      expect(r, bad).toEqual({ kind: "invalid", issues: [], message: "Not a page in the Website workspace." });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });
});

describe("restoreVersionAndOpenAction", () => {
  const HREF = `${BASE}/service/service.seo?locale=en`;

  it("success: restores, then redirects to the given editor URL", async () => {
    fetchMock.mockResolvedValue(written({ itemId: "i1", slug: "service.seo", locale: "en", headVersion: 4 }));
    const e = await rejection(restoreVersionAndOpenAction(SCOPE, "i1", 2, 3, HREF, "Restored from v2"));
    expect(isNextRedirect(e)).toBe(true);
    expect(redirectMock).toHaveBeenCalledWith(HREF);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/modules/webdev/content/sites/gaiada/site-1/items/i1/restore");
  });

  it("a conflict comes back typed and nothing redirects", async () => {
    fetchMock.mockRejectedValue(new PlatformError(409, "version-conflict", undefined, undefined, undefined, { type: "https://webdesk.gaiada.online/errors/version-conflict", title: "x", status: 409, currentHeadVersion: 5 }));
    const r = await restoreVersionAndOpenAction(SCOPE, "i1", 2, 3, HREF);
    expect(r.kind).toBe("conflict");
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("refuses an editor URL that is not one (before writing)", async () => {
    for (const bad of ["/x", "https://evil.example/a/b", `${BASE}/service`, `${HREF}&next=/evil`, `${BASE}/service/service.seo?locale=en#x`]) {
      expect((await restoreVersionAndOpenAction(SCOPE, "i1", 2, 3, bad)).kind, bad).toBe("invalid");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("isNextRedirect", () => {
  it("recognises only Next's redirect error", () => {
    expect(isNextRedirect(Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;push;/a;307;" }))).toBe(true);
    for (const v of [new Error("boom"), { digest: "NEXT_NOT_FOUND" }, null, undefined, "NEXT_REDIRECT", { digest: 1 }]) expect(isNextRedirect(v)).toBe(false);
  });
});
