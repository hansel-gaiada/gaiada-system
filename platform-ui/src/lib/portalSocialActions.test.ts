import { describe, it, expect, vi, beforeEach } from "vitest";

// SCP-2 (BFF §63.9): the client's writes on the post approval page. What is pinned: the exact body each call sends (the hash the client was shown, the note
// trimmed, the pin only when there is one), the company in the path, that a refusal comes back as its CODE and as words (never a raw token), that the pages a
// decision touches are revalidated, and that a lost session says so.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./portal-company", () => ({ getActivePortalCompany: vi.fn(async () => ({ id: "co-1", name: "Example" })) }));
vi.mock("./portal-data", () => ({ getPortalSocialPost: vi.fn() }));
vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn(async () => ({ userId: "u1" })) };
});

import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { platformFetch, PlatformError } from "./platform";
import { getPortalSocialPost } from "./portal-data";
import { portalSocialApproveAll, portalSocialDecide, portalSocialReloadPost, portalSocialUndo } from "./portalSocialActions";

const fetchMock = vi.mocked(platformFetch);
const bodyOfCall = (n = 0) => JSON.parse(String(fetchMock.mock.calls[n][2]?.body));
const revalidated = () => vi.mocked(revalidatePath).mock.calls.map((c) => c[0]);

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(revalidatePath).mockClear();
  vi.mocked(getSessionUserId).mockResolvedValue("u1");
});

describe("portalSocialDecide", () => {
  it("approve: POSTs the decision and the hash the client was shown to the company's decide route, and revalidates the page, the post and the front page", async () => {
    fetchMock.mockResolvedValue({ decisionId: "d-1", postId: "p-1", state: "approved", undoUntil: "2026-10-16T04:00:10.000Z" });
    const r = await portalSocialDecide({ postId: "p-1", decision: "approve", seenHash: "h1" });
    expect(r).toEqual({ ok: true, data: { decisionId: "d-1", postId: "p-1", state: "approved", undoUntil: "2026-10-16T04:00:10.000Z" } });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/portal/social/posts/p-1/decide");
    expect(fetchMock.mock.calls[0][2]?.method).toBe("POST");
    expect(bodyOfCall()).toEqual({ decision: "approve", seenHash: "h1" });
    expect(revalidated()).toEqual(["/portal/social", "/portal/social/p-1", "/portal"]);
  });

  it("change: sends the kind, the trimmed note and the pin; an approval sends none of them", async () => {
    fetchMock.mockResolvedValue({ decisionId: "d-2" });
    await portalSocialDecide({ postId: "p-1", decision: "change", seenHash: "h1", changeKind: "design", note: "  Larger logo.  ", anchor: { x: 0.25, y: 0.5, fileId: "f-1" } });
    expect(bodyOfCall()).toEqual({ decision: "change", seenHash: "h1", changeKind: "design", note: "Larger logo.", anchor: { x: 0.25, y: 0.5, fileId: "f-1" } });
    fetchMock.mockClear();
    await portalSocialDecide({ postId: "p-1", decision: "change", seenHash: "h1", changeKind: "copy", note: "Fix it." });
    expect(bodyOfCall()).toEqual({ decision: "change", seenHash: "h1", changeKind: "copy", note: "Fix it." });
    fetchMock.mockClear();
    await portalSocialDecide({ postId: "p-1", decision: "approve", seenHash: "h1", changeKind: "copy", note: "ignored" });
    expect(bodyOfCall()).toEqual({ decision: "approve", seenHash: "h1" });
  });

  it("a replay is a success with alreadyDecided", async () => {
    fetchMock.mockResolvedValue({ alreadyDecided: true, decisionId: "d-1" });
    expect(await portalSocialDecide({ postId: "p-1", decision: "approve", seenHash: "h1" })).toEqual({ ok: true, data: { alreadyDecided: true, decisionId: "d-1" } });
  });

  it("content_changed comes back as its code and as words, and the post's pages are revalidated (the client re-reads it)", async () => {
    fetchMock.mockRejectedValue(new PlatformError(409, "content_changed"));
    const r = await portalSocialDecide({ postId: "p-1", decision: "approve", seenHash: "old" });
    expect(r).toEqual({ ok: false, code: "content_changed", error: "This post changed while you were looking; here is the new version.", field: undefined });
    expect(revalidated()).toContain("/portal/social/p-1");
  });

  it("post_not_with_client refreshes the list; client_review_already_decided does not", async () => {
    fetchMock.mockRejectedValueOnce(new PlatformError(409, "post_not_with_client"));
    expect((await portalSocialDecide({ postId: "p-1", decision: "approve", seenHash: "h" })).code).toBe("post_not_with_client");
    expect(revalidated()).toContain("/portal/social");
    vi.mocked(revalidatePath).mockClear();
    fetchMock.mockRejectedValueOnce(new PlatformError(409, "client_review_already_decided"));
    const r = await portalSocialDecide({ postId: "p-1", decision: "approve", seenHash: "h" });
    expect(r).toMatchObject({ ok: false, code: "client_review_already_decided", error: expect.stringMatching(/already decided differently/) });
    expect(revalidated()).toEqual([]);
  });

  it("a 400 carries its field, worded for the client", async () => {
    fetchMock.mockRejectedValue(new PlatformError(400, "invalid_field", "note"));
    expect(await portalSocialDecide({ postId: "p-1", decision: "change", seenHash: "h", changeKind: "copy", note: "x" }))
      .toMatchObject({ ok: false, field: "note", error: expect.stringMatching(/1 to 2,000 characters/) });
  });

  it("an error that is not the server's refusal is thrown, never swallowed", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(portalSocialDecide({ postId: "p-1", decision: "approve", seenHash: "h" })).rejects.toThrow("ECONNREFUSED");
  });

  it("a lost session is said so and nothing is sent", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null as never);
    expect(await portalSocialDecide({ postId: "p-1", decision: "approve", seenHash: "h" })).toMatchObject({ ok: false, code: "session_expired" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("portalSocialApproveAll", () => {
  it("POSTs exactly the listed posts with their hashes and returns the per-post results", async () => {
    const answer = { results: [{ postId: "a", outcome: "approved", decisionId: "d-a" }, { postId: "b", outcome: "skipped", reason: "content_changed" }], undoUntil: "2026-10-16T04:00:10.000Z" };
    fetchMock.mockResolvedValue(answer);
    const r = await portalSocialApproveAll([{ postId: "a", seenHash: "ha" }, { postId: "b", seenHash: "hb" }]);
    expect(r).toEqual({ ok: true, data: answer });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/portal/social/posts/approve-all");
    expect(bodyOfCall()).toEqual({ items: [{ postId: "a", seenHash: "ha" }, { postId: "b", seenHash: "hb" }] });
    expect(revalidated()).toContain("/portal/social");
  });
  it("refuses an empty list and more than 50 before sending", async () => {
    expect(await portalSocialApproveAll([])).toMatchObject({ ok: false, field: "items" });
    expect(await portalSocialApproveAll(Array.from({ length: 51 }, (_, i) => ({ postId: `p${i}`, seenHash: "h" })))).toMatchObject({ ok: false, field: "items" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("portalSocialUndo", () => {
  it("POSTs to the decision's undo route and revalidates the post", async () => {
    fetchMock.mockResolvedValue({});
    expect(await portalSocialUndo("d-1", "p-1")).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/portal/social/decisions/d-1/undo");
    expect(fetchMock.mock.calls[0][2]?.method).toBe("POST");
    expect(revalidated()).toContain("/portal/social/p-1");
  });
  it("a refused undo comes back in words, and the page is refreshed (the post is not where the client left it)", async () => {
    fetchMock.mockRejectedValue(new PlatformError(409, "undo_window_passed"));
    expect(await portalSocialUndo("d-1", "p-1")).toMatchObject({ ok: false, code: "undo_window_passed", error: expect.stringMatching(/too late to undo/) });
    expect(revalidated()).toContain("/portal/social");
    fetchMock.mockRejectedValue(new PlatformError(403, "not_your_decision"));
    expect(await portalSocialUndo("d-1")).toMatchObject({ ok: false, code: "not_your_decision" });
  });
});

describe("portalSocialReloadPost", () => {
  it("reads the post again for the company", async () => {
    vi.mocked(getPortalSocialPost).mockResolvedValue({ id: "p-1", reviewHash: "new" } as never);
    expect(await portalSocialReloadPost("p-1")).toEqual({ ok: true, data: { post: { id: "p-1", reviewHash: "new" } } });
    expect(vi.mocked(getPortalSocialPost)).toHaveBeenCalledWith("u1", "co-1", "p-1");
  });
});
