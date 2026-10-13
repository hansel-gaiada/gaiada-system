import { describe, it, expect, vi, beforeEach } from "vitest";

// One page of a recording through the BFF: capability first (no read without `search.replay.view`), strict inputs, the first page asked
// for WITHOUT `from`, later pages with `from` and `opening`, and every refusal as a typed result (never a throw, never an empty page).

vi.mock("./session-server", () => ({ getSessionUserId: vi.fn() }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn() }));
vi.mock("./platform", () => {
  class PlatformError extends Error {
    constructor(public status: number, message: string, public field?: string, public existing?: unknown, public reason?: string, public body?: unknown) { super(message); }
  }
  return { PlatformError, getMe: vi.fn(), platformFetch: vi.fn() };
});

import { getSessionUserId } from "./session-server";
import { getActiveTenant } from "./tenant";
import { PlatformError, getMe, platformFetch } from "./platform";
import { readReplayPageAction } from "./replaysActions";

const P = "0194a3b2-aaaa-7000-8000-00000000000a";
const R = "0194a3b2-bbbb-7000-8000-0000000000b1";
const OPENING = "0194a3b2-cccc-7000-8000-0000000000c1";
const meOf = (role: string) => ({ userId: "u", name: "U", email: "u@x.com", title: null, assurance: "high", companies: [], roles: [{ role, scopeType: "company", scopeId: "co-1" }] });
const body = (o: Record<string, unknown> = {}) => ({
  propertyId: P, recordingId: R, from: 0, chunks: [{ seq: 0, receivedAt: "2026-10-12T09:00:10.000Z", events: [{ type: 4, timestamp: 1 }, { type: 2, timestamp: 2 }] }],
  more: false, nextFrom: null, opened: true, openingId: OPENING, ...o,
});
const fetchMock = vi.mocked(platformFetch);

beforeEach(() => {
  vi.mocked(getSessionUserId).mockReset().mockResolvedValue("u");
  vi.mocked(getActiveTenant).mockReset().mockResolvedValue("co-1");
  vi.mocked(getMe).mockReset().mockResolvedValue(meOf("search_manager") as never);
  fetchMock.mockReset();
});

describe("readReplayPageAction: the gate", () => {
  it("a viewer without search.replay.view gets forbidden and NO read is made", async () => {
    vi.mocked(getMe).mockResolvedValue(meOf("search_staff") as never);
    expect(await readReplayPageAction(P, R, 0, null)).toEqual({ kind: "forbidden" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("signed out and no active company are refusals, with no read", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null);
    expect(await readReplayPageAction(P, R, 0, null)).toEqual({ kind: "signed_out" });
    vi.mocked(getSessionUserId).mockResolvedValue("u");
    vi.mocked(getActiveTenant).mockResolvedValue(null as never);
    expect(await readReplayPageAction(P, R, 0, null)).toEqual({ kind: "forbidden" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a search manager is admitted (the capability, not a role name)", async () => {
    fetchMock.mockResolvedValue(body());
    expect((await readReplayPageAction(P, R, 0, null)).kind).toBe("ok");
  });
});

describe("readReplayPageAction: the request", () => {
  it("page 1 is asked for with NO from and NO opening (that is the opening)", async () => {
    fetchMock.mockResolvedValue(body());
    await readReplayPageAction(P, R, 0, null);
    const [path, userId, init] = fetchMock.mock.calls[0];
    expect(path).toBe(`/api/co-1/modules/search/properties/${P}/recordings/${R}/chunks`);
    expect(userId).toBe("u");
    expect(init).toBeUndefined();
  });

  it("a later page carries from and the opening id", async () => {
    fetchMock.mockResolvedValue(body({ from: 20, opened: false, openingId: null }));
    await readReplayPageAction(P, R, 20, OPENING);
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/co-1/modules/search/properties/${P}/recordings/${R}/chunks?from=20&opening=${OPENING}`);
  });

  it("returns the parsed page", async () => {
    fetchMock.mockResolvedValue(body({ more: true, nextFrom: 20 }));
    const r = await readReplayPageAction(P, R, 0, null);
    expect(r).toMatchObject({ kind: "ok", page: { opened: true, openingId: OPENING, more: true, nextFrom: 20 } });
  });

  it("bad ids, a bad from or a bad opening are refused before any read", async () => {
    expect(await readReplayPageAction("nope", R, 0, null)).toEqual({ kind: "bad_request" });
    expect(await readReplayPageAction(P, "../x", 0, null)).toEqual({ kind: "bad_request" });
    expect(await readReplayPageAction(P, R, -1, null)).toEqual({ kind: "bad_request" });
    expect(await readReplayPageAction(P, R, 1000, OPENING)).toEqual({ kind: "bad_request" });
    expect(await readReplayPageAction(P, R, 1.5, OPENING)).toEqual({ kind: "bad_request" });
    expect(await readReplayPageAction(P, R, 20, "not-a-uuid")).toEqual({ kind: "bad_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a later page with no opening is not_opened without a round trip", async () => {
    expect(await readReplayPageAction(P, R, 20, null)).toEqual({ kind: "not_opened" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("readReplayPageAction: refusals are typed results", () => {
  const refuse = (status: number, reason?: string, msg = "x") => fetchMock.mockRejectedValue(new PlatformError(status, msg, undefined, undefined, reason));

  it("409 not_opened -> not_opened (restart from the beginning)", async () => {
    refuse(409, "not_opened");
    expect(await readReplayPageAction(P, R, 20, OPENING)).toEqual({ kind: "not_opened" });
  });

  it("404 -> not_found, whichever the reason", async () => {
    refuse(404, "recording_not_found");
    expect(await readReplayPageAction(P, R, 20, OPENING)).toEqual({ kind: "not_found", reason: "recording_not_found" });
  });

  it("403 -> forbidden", async () => {
    refuse(403);
    expect(await readReplayPageAction(P, R, 0, null)).toEqual({ kind: "forbidden" });
  });

  it("503 -> unavailable with the words for its reason (the reason may also arrive only in the body)", async () => {
    refuse(503, "collector_unreachable");
    const a = await readReplayPageAction(P, R, 0, null);
    expect(a).toMatchObject({ kind: "unavailable", reason: "collector_unreachable" });
    expect((a as { message: string }).message).toMatch(/did not answer/);
    fetchMock.mockRejectedValue(new PlatformError(503, "x", undefined, undefined, undefined, { reason: "not_configured" }));
    expect(await readReplayPageAction(P, R, 0, null)).toMatchObject({ kind: "unavailable", reason: "not_configured" });
  });

  it("a network failure is unavailable in words, not a throw", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect(await readReplayPageAction(P, R, 0, null)).toMatchObject({ kind: "unavailable", reason: null });
  });

  it("an off-contract body is a drift, not an empty page", async () => {
    fetchMock.mockResolvedValue({ propertyId: P });
    expect(await readReplayPageAction(P, R, 0, null)).toMatchObject({ kind: "drift" });
    fetchMock.mockResolvedValue(body({ opened: true, openingId: null }));
    expect(await readReplayPageAction(P, R, 0, null)).toMatchObject({ kind: "drift" });
  });
});
