import { describe, it, expect, vi, beforeEach } from "vitest";

// DW-10a-2 (BFF §57.4): the notice readers. A refusal or a failure is data the page can word; it is never an empty list.
vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn() };
});

import { platformFetch, PlatformError } from "./platform";
import { NOTICE_NOT_FOUND, getNotice, listNotices } from "./notices-data";
import type { NoticeRow } from "./notices";

const fetchMock = vi.mocked(platformFetch);
const row = (over: Partial<NoticeRow> = {}): NoticeRow => ({
  id: "n1", scope: "unit", unitNodeId: "dept-1", unitName: "Web Dev", title: "T", body: "B", pinned: false, endsOn: null, state: "current",
  author: { id: "u1", name: "Ketut" }, createdAt: "2026-10-16T08:00:00.000Z", editedAt: null, canEdit: false, ...over,
});

beforeEach(() => fetchMock.mockReset());

describe("listNotices", () => {
  it("asks for a unit's current notices and returns the items and the cursor", async () => {
    fetchMock.mockResolvedValue({ items: [row()], nextCursor: "c2" });
    const r = await listNotices("u1", "co-a", { unitNodeId: "dept-1" });
    expect(r).toEqual({ kind: "ok", data: { items: [row()], nextCursor: "c2" } });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-a/notices?unitNodeId=dept-1&state=current");
    expect(fetchMock.mock.calls[0][1]).toBe("u1");
  });

  it("asks for the company-wide ones with scope=company, and carries state, limit and cursor", async () => {
    fetchMock.mockResolvedValue({ items: [], nextCursor: null });
    await listNotices("u1", "co-a", { scope: "company" }, { state: "past", limit: 3, cursor: "abc" });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-a/notices?scope=company&state=past&limit=3&cursor=abc");
  });

  it("encodes the unit and the tenant", async () => {
    fetchMock.mockResolvedValue({ items: [], nextCursor: null });
    await listNotices("u1", "co a", { unitNodeId: "d/1" });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co%20a/notices?unitNodeId=d%2F1&state=current");
  });

  it("an empty list from a successful read is ok with no items (evidence of emptiness)", async () => {
    fetchMock.mockResolvedValue({ items: [], nextCursor: null });
    expect(await listNotices("u1", "co-a", { unitNodeId: "dept-1" })).toEqual({ kind: "ok", data: { items: [], nextCursor: null } });
  });

  it("a 403 is forbidden, never an empty list", async () => {
    fetchMock.mockRejectedValueOnce(new PlatformError(403, "outside your reporting line"));
    expect(await listNotices("u1", "co-a", { unitNodeId: "dept-9" })).toEqual({ kind: "forbidden" });
  });

  it("a 404 (an unknown unit), a 500 and a network failure are unavailable with their words, never an empty list", async () => {
    fetchMock.mockRejectedValueOnce(new PlatformError(404, "unit_not_found", "unitNodeId"));
    expect(await listNotices("u1", "co-a", { unitNodeId: "gone" })).toEqual({ kind: "unavailable", reason: "unit_not_found" });
    fetchMock.mockRejectedValueOnce(new PlatformError(500, "boom"));
    expect(await listNotices("u1", "co-a", { unitNodeId: "dept-1" })).toEqual({ kind: "unavailable", reason: "boom" });
    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await listNotices("u1", "co-a", { unitNodeId: "dept-1" })).toEqual({ kind: "unavailable", reason: "socket hang up" });
  });

  it("an answer without items (an old platform, a proxy page) is unavailable, not an empty list", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    expect(await listNotices("u1", "co-a", { unitNodeId: "dept-1" })).toMatchObject({ kind: "unavailable" });
    fetchMock.mockResolvedValue([row()]);
    expect(await listNotices("u1", "co-a", { unitNodeId: "dept-1" })).toMatchObject({ kind: "unavailable" });
  });
});

describe("getNotice", () => {
  it("returns the notice", async () => {
    fetchMock.mockResolvedValue(row());
    expect(await getNotice("u1", "co-a", "n1")).toEqual({ kind: "ok", data: row() });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-a/notices/n1");
  });
  it("words a 404 as one sentence (no such notice, withdrawn and not yours read the same)", async () => {
    fetchMock.mockRejectedValueOnce(new PlatformError(404, "notice_not_found"));
    expect(await getNotice("u1", "co-a", "n1")).toEqual({ kind: "unavailable", reason: NOTICE_NOT_FOUND });
  });
  it("keeps a 403 forbidden and another failure unavailable", async () => {
    fetchMock.mockRejectedValueOnce(new PlatformError(403, "no"));
    expect(await getNotice("u1", "co-a", "n1")).toEqual({ kind: "forbidden" });
    fetchMock.mockRejectedValueOnce(new PlatformError(500, "boom"));
    expect(await getNotice("u1", "co-a", "n1")).toEqual({ kind: "unavailable", reason: "boom" });
  });
});
