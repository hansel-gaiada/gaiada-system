import { describe, it, expect, vi, beforeEach } from "vitest";

// WSK-46 — the editor's Preview: the strict link parser, the server action's route/body and its error mapping, and the plain-words
// copy. The REAL BFF is driven through these same functions by platform-nest's `webdesk-content-ui-contract.test.ts`
// ("preview: previewItemAction …"); this file pins the UI side without a server.

vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn(async () => ({ id: "u1", companies: [], roles: [] })) };
});
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("./entities", () => ({ listMembers: vi.fn() }));

import { platformFetch, PlatformError } from "./platform";
import { getSessionUserId } from "./session-server";
import { parsePreviewLink, WireDrift } from "./webdeskContent";
import { previewItemAction } from "./webdeskContentActions";
import { previewRefusalCopy, type PreviewLink, type WdResult } from "./webdeskContentModel";

const fetchMock = vi.mocked(platformFetch);
const session = vi.mocked(getSessionUserId);
const SCOPE = { tenantSlug: "gaiada", siteId: "site-1" };
const GOOD = { previewUrl: "https://stg.example/preview/#t=tok_ABC-123", expiresAt: "2026-10-11T09:00:00Z", version: 3 };
const refusal = (r: WdResult<PreviewLink>) => r as Exclude<WdResult<PreviewLink>, { kind: "ok" }>;

/** What the BFF sends for its `{message, reason}` exceptions (the global filter renames `message` to `error`). */
const nestError = (status: number, error: string, reason: string) => new PlatformError(status, error, undefined, undefined, reason, { error, reason });

beforeEach(() => { fetchMock.mockReset(); session.mockResolvedValue("u1"); });

describe("parsePreviewLink: strict, because the answer is OPENED IN A NEW TAB", () => {
  it("accepts exactly {previewUrl, expiresAt, version} with an https /preview/ link carrying the token in the fragment", () => {
    expect(parsePreviewLink(GOOD)).toEqual(GOOD);
    expect(parsePreviewLink({ ...GOOD, previewUrl: "https://stg.example/some/base/preview/#t=x" }).previewUrl).toContain("#t=x"); // a site served under a base path
  });

  it.each<[string, unknown, RegExp]>([
    ["not an object", "x", /preview: expected object/],
    ["a missing previewUrl", { expiresAt: GOOD.expiresAt, version: 1 }, /preview\.previewUrl: expected present/],
    ["a missing expiresAt", { previewUrl: GOOD.previewUrl, version: 1 }, /preview\.expiresAt: expected present/],
    ["a missing version", { previewUrl: GOOD.previewUrl, expiresAt: GOOD.expiresAt }, /preview\.version: expected present/],
    ["a non-integer version", { ...GOOD, version: 1.5 }, /preview\.version: expected integer/],
    ["an expiry that is not a timestamp", { ...GOOD, expiresAt: "soon" }, /preview\.expiresAt: expected an ISO timestamp/],
    ["an extra key (Zone B's previewPath embeds the token and must never be forwarded)", { ...GOOD, previewPath: "/v1/t/x/preview/y" }, /preview\.previewPath/],
    ["the token in a QUERY STRING", { ...GOOD, previewUrl: "https://stg.example/preview/?t=abc" }, /preview\.previewUrl/],
    ["a query string AND a fragment", { ...GOOD, previewUrl: "https://stg.example/preview/?t=abc#t=abc" }, /preview\.previewUrl/],
    ["http", { ...GOOD, previewUrl: "http://stg.example/preview/#t=abc" }, /preview\.previewUrl/],
    ["a javascript: URL", { ...GOOD, previewUrl: "javascript:alert(1)//preview/#t=abc" }, /preview\.previewUrl/],
    ["credentials in the URL", { ...GOOD, previewUrl: "https://u:p@stg.example/preview/#t=abc" }, /preview\.previewUrl/],
    ["another page than /preview/", { ...GOOD, previewUrl: "https://stg.example/admin/#t=abc" }, /preview\.previewUrl/],
    ["an empty token", { ...GOOD, previewUrl: "https://stg.example/preview/#t=" }, /preview\.previewUrl/],
    ["no token", { ...GOOD, previewUrl: "https://stg.example/preview/" }, /preview\.previewUrl/],
    ["not a URL at all", { ...GOOD, previewUrl: "preview" }, /preview\.previewUrl/],
  ])("drift: %s", (_n, body, re) => {
    expect(() => parsePreviewLink(body)).toThrow(WireDrift);
    expect(() => parsePreviewLink(body)).toThrow(re);
  });

  it("a drift message names the path and the TYPE, never the value (a token cannot reach an error or a log)", () => {
    for (const body of [{ ...GOOD, previewUrl: "https://stg.example/preview/?t=SECRETVALUE" }, { ...GOOD, previewUrl: "SECRETVALUE" }, { ...GOOD, previewPath: "SECRETVALUE" }]) {
      try { parsePreviewLink(body); throw new Error("expected drift"); } catch (e) { expect((e as Error).message).not.toContain("SECRETVALUE"); }
    }
  });
});

describe("previewItemAction: route, body, and the existing error machinery", () => {
  it("POSTs …/items/:itemId/preview through the BFF as the signed-in user, with the version pinned when given", async () => {
    fetchMock.mockResolvedValue(GOOD);
    const r = await previewItemAction(SCOPE, "item-1", 3);
    expect(r).toEqual({ kind: "ok", data: GOOD });
    const [path, userId, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/co-1/modules/webdev/content/sites/gaiada/site-1/items/item-1/preview");
    expect(userId).toBe("u1");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ version: 3 });
  });

  it("with no version the body is {} (the head), and the item id is URL-encoded", async () => {
    fetchMock.mockResolvedValue(GOOD);
    await previewItemAction(SCOPE, "a/b c");
    const [path, , init] = fetchMock.mock.calls[0];
    expect(path).toContain("/items/a%2Fb%20c/preview");
    expect(JSON.parse(String(init?.body))).toEqual({});
  });

  it("never calls the BFF for a request it can see is malformed (no site, no item, a version that is not a positive integer)", async () => {
    expect((await previewItemAction({ tenantSlug: "", siteId: "s" }, "i", 1)).kind).toBe("invalid");
    expect((await previewItemAction(SCOPE, "", 1)).kind).toBe("invalid");
    expect((await previewItemAction(SCOPE, "i", 0)).kind).toBe("invalid");
    expect((await previewItemAction(SCOPE, "i", 1.5)).kind).toBe("invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an expired session is the workspace's existing `session_expired`, and the BFF is not called", async () => {
    session.mockResolvedValue(null as never);
    expect(await previewItemAction(SCOPE, "i", 1)).toMatchObject({ kind: "unavailable", reason: "session_expired" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("409 preview_not_configured and preview_page_missing are typed `conflict`s with those slugs (the BFF's {error, reason} body)", async () => {
    fetchMock.mockRejectedValueOnce(nestError(409, "Preview isn't set up for this site yet", "preview_not_configured"));
    const nc = await previewItemAction(SCOPE, "i", 1);
    expect(nc).toMatchObject({ kind: "conflict", slug: "preview_not_configured", message: "Preview isn't set up for this site yet" });
    fetchMock.mockRejectedValueOnce(nestError(409, "This site doesn't have a preview page yet", "preview_page_missing"));
    const pm = await previewItemAction(SCOPE, "i", 1);
    expect(pm).toMatchObject({ kind: "conflict", slug: "preview_page_missing" });
    expect(previewRefusalCopy(refusal(nc)).tone).toBe("info");
    expect(previewRefusalCopy(refusal(pm)).tone).toBe("info");
  });

  it("502 preview_site_unreachable is `unavailable/upstream_error` with that reason (not WebDesk's own `editorial_unavailable`)", async () => {
    fetchMock.mockRejectedValue(nestError(502, "The site didn't answer, so a preview link can't be made right now", "preview_site_unreachable"));
    expect(await previewItemAction(SCOPE, "i", 1)).toMatchObject({ kind: "unavailable", code: "upstream_error", reason: "preview_site_unreachable" });
  });

  it("403 is forbidden, 404 item/version/site are not_found, 503 is editorial_unavailable", async () => {
    fetchMock.mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await previewItemAction(SCOPE, "i", 1)).kind).toBe("forbidden");
    const problem = (status: number, slug: string) => new PlatformError(status, slug, undefined, undefined, undefined, { type: `https://webdesk.gaiada.online/errors/${slug}`, title: slug, status });
    for (const slug of ["item-not-found", "version-not-found", "site-not-found"]) {
      fetchMock.mockRejectedValueOnce(problem(404, slug));
      expect(await previewItemAction(SCOPE, "i", 1)).toEqual({ kind: "not_found", slug });
    }
    fetchMock.mockRejectedValueOnce(new PlatformError(503, "editorial_unavailable", undefined, undefined, "circuit_open", { error: "editorial_unavailable", reason: "circuit_open" }));
    expect(await previewItemAction(SCOPE, "i", 1)).toMatchObject({ kind: "unavailable", code: "editorial_unavailable" });
  });

  it("a 2xx that breaks the contract (a query-string token, a missing key) is loud drift and yields NO link", async () => {
    fetchMock.mockResolvedValueOnce({ ...GOOD, previewUrl: "https://stg.example/preview/?t=abc" });
    expect(await previewItemAction(SCOPE, "i", 1)).toMatchObject({ kind: "unavailable", code: "contract_drift" });
    fetchMock.mockResolvedValueOnce({ expiresAt: GOOD.expiresAt, version: 1 });
    expect(await previewItemAction(SCOPE, "i", 1)).toMatchObject({ kind: "unavailable", code: "contract_drift" });
  });
});

describe("previewRefusalCopy: plain words, never a code", () => {
  const cases: Array<[string, WdResult<PreviewLink>, "info" | "bad", RegExp]> = [
    ["not configured", { kind: "conflict", slug: "preview_not_configured", message: "m", currentHeadVersion: null, currentContentHash: null, updatedAt: null }, "info", /Preview isn't set up for this site yet/],
    ["page missing", { kind: "conflict", slug: "preview_page_missing", message: "m", currentHeadVersion: null, currentContentHash: null, updatedAt: null }, "info", /doesn't have a preview page yet.*No link was made/],
    ["item deleted", { kind: "conflict", slug: "item-deleted", message: "m", currentHeadVersion: null, currentContentHash: null, updatedAt: null }, "bad", /has been deleted/],
    ["another conflict", { kind: "conflict", slug: "x", message: "something moved", currentHeadVersion: null, currentContentHash: null, updatedAt: null }, "bad", /something moved/],
    ["forbidden", { kind: "forbidden", reason: "r" }, "bad", /don't have permission/],
    ["not found", { kind: "not_found", slug: "item-not-found" }, "bad", /no longer exists/],
    ["not enabled", { kind: "not_enabled", reason: "not_served" }, "info", /isn't available on this deployment/],
    ["invalid", { kind: "invalid", issues: [], message: "version must be an integer" }, "bad", /version must be an integer/],
    ["unreachable site", { kind: "unavailable", code: "upstream_error", reason: "preview_site_unreachable" }, "bad", /site didn't answer/],
    ["ambiguous", { kind: "unavailable", code: "upstream_error", reason: "not_observed" }, "bad", /couldn't confirm/],
    ["drift", { kind: "unavailable", code: "contract_drift", reason: "preview.previewUrl: expected an https URL" }, "bad", /answered unexpectedly/],
    ["webdesk down", { kind: "unavailable", code: "editorial_unavailable", reason: "circuit_open" }, "bad", /Couldn't reach WebDesk/],
  ];
  it.each(cases)("%s", (_n, r, tone, re) => {
    const c = previewRefusalCopy(refusal(r));
    expect(c.tone).toBe(tone);
    expect(c.text).toMatch(re);
  });
});
