import { describe, it, expect, vi, beforeEach } from "vitest";
import { me as meFixture, member } from "./workspaceFixtures";

// DW-7h (BFF §52.7): the three writes behind IT > Network. Cerbos decides who may; what is pinned here is the wire (route, body,
// revalidation), the words for a 403, the server's own refusal passed through with its `reason`, `field` and `detail.users` (so
// the form can ask "N people use this address, block anyway?"), and that a blank form never reaches the server.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn() };
});

import { revalidatePath } from "next/cache";
import { getMe, platformFetch, PlatformError } from "./platform";
import { blockAddress, liftBlock, revokeSession } from "./itSecurityActions";

const fetchMock = vi.mocked(platformFetch);
const body = () => JSON.parse(String(fetchMock.mock.calls[0][2]?.body));
const itAdmin = meFixture([member(), { role: "it_admin", scopeType: "company", scopeId: "co-a" }]);
const plain = meFixture([member()]);
const BLOCK = { id: "b1", ip: "192.0.2.45", reason: "guessing", createdAt: "x", expiresAt: "y", liftedAt: null, hitCount: 0, lastHitAt: null };

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(revalidatePath).mockClear();
  vi.mocked(getMe).mockResolvedValue(itAdmin);
});

describe("revokeSession", () => {
  it("POSTs the person (and the reason, trimmed) to the session's route and re-reads the Network pages", async () => {
    fetchMock.mockResolvedValue({ revoked: true, keycloak: "ended" });
    const r = await revokeSession("u-2", "sid 1/x", "  lost phone ");
    expect(r).toEqual({ ok: true, result: { revoked: true, keycloak: "ended" } });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-a/it/security/sessions/sid%201%2Fx/revoke");
    expect(fetchMock.mock.calls[0][2]?.method).toBe("POST");
    expect(body()).toEqual({ userId: "u-2", reason: "lost phone" });
    expect(revalidatePath).toHaveBeenCalledWith("/it/network", "layout");
  });

  it("sends no reason when none is given, and keeps `keycloak: failed` as an ok answer (the ERP is cut either way)", async () => {
    fetchMock.mockResolvedValue({ revoked: true, keycloak: "failed" });
    expect(await revokeSession("u-2", "s")).toEqual({ ok: true, result: { revoked: true, keycloak: "failed" } });
    expect(body()).toEqual({ userId: "u-2" });
  });

  it("passes revokes_yourself (409) and a 404 through in the server's words, with the reason", async () => {
    fetchMock.mockRejectedValueOnce(new PlatformError(409, "That is your own session.", undefined, undefined, "revokes_yourself"));
    expect(await revokeSession("u-1", "s")).toEqual({ ok: false, error: "That is your own session.", reason: "revokes_yourself" });
    fetchMock.mockRejectedValueOnce(new PlatformError(404, "That session was never seen in this company."));
    expect(await revokeSession("u-2", "s")).toEqual({ ok: false, error: "That session was never seen in this company." });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a missing person or a connection with no session id before any request", async () => {
    expect((await revokeSession("", "s")).ok).toBe(false);
    const noSid = await revokeSession("u-2", "");
    expect(noSid).toMatchObject({ ok: false });
    expect(noSid.ok === false && noSid.error).toMatch(/no session id/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("blockAddress", () => {
  it("POSTs the address, the trimmed reason and the hours (24 when left out), and returns the block", async () => {
    fetchMock.mockResolvedValue(BLOCK);
    const r = await blockAddress({ ip: " 192.0.2.45 ", reason: " guessing passwords " });
    expect(r).toEqual({ ok: true, result: BLOCK });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-a/it/security/blocks");
    expect(fetchMock.mock.calls[0][2]?.method).toBe("POST");
    expect(body()).toEqual({ ip: "192.0.2.45", reason: "guessing passwords", hours: 24 });
    expect(revalidatePath).toHaveBeenCalledWith("/it/network", "layout");
  });

  it("sends confirmShared only when it is true", async () => {
    fetchMock.mockResolvedValue(BLOCK);
    await blockAddress({ ip: "192.0.2.45", reason: "abc", hours: 168, confirmShared: true });
    expect(body()).toEqual({ ip: "192.0.2.45", reason: "abc", hours: 168, confirmShared: true });
    fetchMock.mockClear();
    await blockAddress({ ip: "192.0.2.45", reason: "abc", hours: 1, confirmShared: false });
    expect(body()).toEqual({ ip: "192.0.2.45", reason: "abc", hours: 1 });
  });

  it("★ the shared_address 409 comes back with its reason and the number of people, so the form can ask", async () => {
    fetchMock.mockRejectedValue(new PlatformError(
      409, "5 people connected from this address in the last 24 hours.", undefined, undefined, "shared_address",
      { error: "5 people connected from this address in the last 24 hours.", reason: "shared_address", detail: { users: 5 } },
    ));
    const r = await blockAddress({ ip: "198.51.100.50", reason: "scanner" });
    expect(r).toEqual({ ok: false, error: "5 people connected from this address in the last 24 hours.", reason: "shared_address", users: 5 });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("ignores a detail.users that is not a number", async () => {
    fetchMock.mockRejectedValue(new PlatformError(409, "shared", undefined, undefined, "shared_address", { detail: { users: "many" } }));
    expect(await blockAddress({ ip: "198.51.100.50", reason: "scanner" })).toEqual({ ok: false, error: "shared", reason: "shared_address" });
  });

  it("passes blocks_yourself, already_blocked and a 400 (with its field) through untouched", async () => {
    fetchMock.mockRejectedValueOnce(new PlatformError(409, "That is your own address.", undefined, undefined, "blocks_yourself"));
    expect(await blockAddress({ ip: "203.0.113.10", reason: "abc" })).toEqual({ ok: false, error: "That is your own address.", reason: "blocks_yourself" });
    fetchMock.mockRejectedValueOnce(new PlatformError(409, "Already blocked.", undefined, undefined, "already_blocked"));
    expect((await blockAddress({ ip: "192.0.2.45", reason: "abc" })).ok).toBe(false);
    fetchMock.mockRejectedValueOnce(new PlatformError(400, "That is a private address.", "ip"));
    expect(await blockAddress({ ip: "10.0.0.4", reason: "abc" })).toEqual({ ok: false, error: "That is a private address.", field: "ip" });
  });

  it("refuses a blank address, a reason under 3 or over 500 characters and odd hours before any request", async () => {
    expect(await blockAddress({ ip: " ", reason: "abc" })).toMatchObject({ ok: false, field: "ip" });
    expect(await blockAddress({ ip: "192.0.2.45", reason: "ab" })).toMatchObject({ ok: false, field: "reason" });
    expect(await blockAddress({ ip: "192.0.2.45", reason: "x".repeat(501) })).toMatchObject({ ok: false, field: "reason" });
    for (const hours of [0, 721, 1.5, Number.NaN]) {
      expect(await blockAddress({ ip: "192.0.2.45", reason: "abc", hours }), String(hours)).toMatchObject({ ok: false, field: "hours" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("liftBlock", () => {
  it("POSTs to the block's lift route with no body and returns the block", async () => {
    fetchMock.mockResolvedValue({ ...BLOCK, liftedAt: "z" });
    const r = await liftBlock("b 1");
    expect(r).toMatchObject({ ok: true, result: { id: "b1", liftedAt: "z" } });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-a/it/security/blocks/b%201/lift");
    expect(fetchMock.mock.calls[0][2]?.method).toBe("POST");
    expect(fetchMock.mock.calls[0][2]?.body).toBeUndefined();
  });

  it("passes not_active (409) and 404 through", async () => {
    fetchMock.mockRejectedValueOnce(new PlatformError(409, "That block is no longer active.", undefined, undefined, "not_active"));
    expect(await liftBlock("b1")).toEqual({ ok: false, error: "That block is no longer active.", reason: "not_active" });
    fetchMock.mockRejectedValueOnce(new PlatformError(404, "No such block."));
    expect(await liftBlock("b9")).toEqual({ ok: false, error: "No such block." });
  });
});

describe("refusals common to all three", () => {
  it("says a 403 in words, keeps the machine reason and does not revalidate", async () => {
    fetchMock.mockRejectedValue(new PlatformError(403, "forbidden", undefined, undefined, "denied"));
    expect(await liftBlock("b1")).toEqual({ ok: false, error: "You don't have permission to lift blocks.", reason: "denied" });
    expect(await blockAddress({ ip: "192.0.2.45", reason: "abc" })).toMatchObject({ error: "You don't have permission to block addresses." });
    expect(await revokeSession("u-2", "s")).toMatchObject({ error: "You don't have permission to sign people out." });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("stops a person without it.manage before any request (defence in depth; the server still decides)", async () => {
    vi.mocked(getMe).mockResolvedValue(plain);
    expect(await liftBlock("b1")).toEqual({ ok: false, error: "You don't have permission to lift blocks." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says so, in words, when the request itself fails", async () => {
    fetchMock.mockRejectedValue(new Error("socket hang up"));
    const r = await liftBlock("b1");
    expect(r).toMatchObject({ ok: false });
    expect(r.ok === false && r.error).toMatch(/did not go through/);
  });
});
