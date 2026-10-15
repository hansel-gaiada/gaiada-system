import { describe, it, expect, vi, beforeEach } from "vitest";
import { listAlertsResult, listBlocksResult, listConnectionsResult, listSignInsResult } from "./itSecurity";

// DW-7h (BFF §52.6): the four honest readers behind IT > Network. Pinned: each reads its own route with the window, a 403 is
// forbidden and anything else is unavailable, and a 200 in the wrong shape (the demo layer's `[]`, a drifted backend) is
// unavailable, never an empty list: "nobody is connected" and "no failed sign-ins" are claims only a real 200 may make.
const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
const urlOf = (f: ReturnType<typeof vi.fn>) => String((f.mock.calls[0] as unknown[])[0]);
const WRONG = "The security read returned an unexpected answer.";

beforeEach(() => {
  process.env.PLATFORM_URL = "http://p.test";
  process.env.PLATFORM_SERVICE_TOKEN = "t";
  delete process.env.DEMO_MODE;
});

const conn = (over: Record<string, unknown> = {}) => ({
  who: { userId: "u1", displayName: "Dewi", email: "dewi@x.test" }, sessionId: "s1", ip: "198.51.100.24", userAgent: "UA",
  device: { browser: "Safari", os: "iOS 17", kind: "mobile" }, firstSeenAt: "2026-10-15T08:00:00Z", lastSeenAt: "2026-10-15T09:00:00Z",
  requestCount: 4, revoked: false, ipBlocked: false, ...over,
});
const CONNECTIONS = { asOf: "2026-10-15T09:05:00Z", window: "24h", connections: [conn()] };

const event = (over: Record<string, unknown> = {}) => ({ at: "2026-10-15T08:00:00Z", type: "failed", userId: "u1", email: "dewi@x.test", ip: "192.0.2.7", error: "invalid_user_credentials", ...over });
const SIGN_INS = {
  asOf: "2026-10-15T09:05:00Z", window: "24h", state: "on", events: [event()],
  summary: { signIns: 3, failed: 1, failedByAccount: [{ userId: "u1", email: "dewi@x.test", count: 1 }], failedByIp: [{ ip: "192.0.2.7", count: 1 }] },
  unknownAccounts: { failed: 2 },
};
const ALERTS = {
  asOf: "2026-10-15T09:05:00Z", window: "24h", signIns: "on",
  alerts: [{ kind: "new_device", severity: "medium", at: "2026-10-15T08:30:00Z", subject: { userId: "u1", email: "dewi@x.test", ip: "198.51.100.24" }, detail: "d", count: 1 }],
};
const BLOCK = {
  id: "b1", ip: "192.0.2.45", reason: "guessing", active: true, createdAt: "2026-10-15T07:00:00Z", createdBy: { userId: "u9", displayName: "Hansel" },
  expiresAt: "2026-10-16T07:00:00Z", liftedAt: null, liftedBy: null, hitCount: 14, lastHitAt: "2026-10-15T08:40:00Z",
};
const REVOCATION = {
  id: "r1", who: { userId: "u2", displayName: "Gede", email: "gede@x.test" }, sessionId: null, reason: null, revokedAt: "2026-10-14T09:00:00Z",
  revokedBy: { userId: "u9", displayName: "Hansel" }, expiresAt: "2026-10-14T22:00:00Z",
};
const BLOCKS = { ipBlocks: [BLOCK], revokedSessions: [REVOCATION] };

describe("listConnectionsResult", () => {
  it("reads its own route with the window (24h by default) and returns the answer", async () => {
    const f = answer(200, CONNECTIONS);
    vi.stubGlobal("fetch", f);
    expect(await listConnectionsResult("u1", "co-a")).toEqual({ kind: "ok", data: CONNECTIONS });
    expect(urlOf(f)).toBe("http://p.test/api/co-a/it/security/connections?window=24h");
    const g = answer(200, { ...CONNECTIONS, window: "15m" });
    vi.stubGlobal("fetch", g);
    await listConnectionsResult("u1", "co-a", "15m");
    expect(urlOf(g)).toBe("http://p.test/api/co-a/it/security/connections?window=15m");
  });

  it("needs `who` as a nested object with all three fields", async () => {
    for (const who of [undefined, null, { userId: "u1", displayName: "Dewi" }, "u1"]) {
      vi.stubGlobal("fetch", answer(200, { ...CONNECTIONS, connections: [conn({ who })] }));
      expect(await listConnectionsResult("u1", "co-a"), JSON.stringify(who)).toEqual({ kind: "unavailable", reason: WRONG });
    }
  });

  it("keeps an unknown address (null) and a token with no session id", async () => {
    vi.stubGlobal("fetch", answer(200, { ...CONNECTIONS, connections: [conn({ ip: null, sessionId: "" })] }));
    const r = await listConnectionsResult("u1", "co-a");
    expect(r).toMatchObject({ kind: "ok", data: { connections: [{ ip: null, sessionId: "" }] } });
  });

  it("an empty list is ok (evidence of emptiness), but a 200 in the wrong shape is unavailable", async () => {
    vi.stubGlobal("fetch", answer(200, { ...CONNECTIONS, connections: [] }));
    expect(await listConnectionsResult("u1", "co-a")).toMatchObject({ kind: "ok", data: { connections: [] } });
    for (const body of [[], {}, { asOf: "x", window: "24h" }, { ...CONNECTIONS, connections: {} }, { ...CONNECTIONS, window: "1y" },
      { ...CONNECTIONS, connections: [conn({ device: null })] }, { ...CONNECTIONS, connections: [conn({ revoked: "no" })] },
      { ...CONNECTIONS, connections: [conn({ device: { browser: "x", os: "y", kind: "toaster" } })] }, { ...CONNECTIONS, connections: [null] }]) {
      vi.stubGlobal("fetch", answer(200, body));
      expect(await listConnectionsResult("u1", "co-a"), JSON.stringify(body)).toEqual({ kind: "unavailable", reason: WRONG });
    }
  });
});

describe("listSignInsResult", () => {
  it("reads the window and returns the events and summary when the state is on", async () => {
    const f = answer(200, SIGN_INS);
    vi.stubGlobal("fetch", f);
    expect(await listSignInsResult("u1", "co-a", "7d")).toEqual({ kind: "ok", data: SIGN_INS });
    expect(urlOf(f)).toBe("http://p.test/api/co-a/it/security/sign-ins?window=7d");
  });

  it("carries off and unavailable as states with no figures, and the reason when there is one", async () => {
    vi.stubGlobal("fetch", answer(200, { asOf: "a", window: "24h", state: "off" }));
    expect(await listSignInsResult("u1", "co-a")).toEqual({ kind: "ok", data: { asOf: "a", window: "24h", state: "off" } });
    vi.stubGlobal("fetch", answer(200, { asOf: "a", window: "24h", state: "unavailable", reason: "view-events missing", events: [], summary: {} }));
    expect(await listSignInsResult("u1", "co-a")).toEqual({ kind: "ok", data: { asOf: "a", window: "24h", state: "unavailable", reason: "view-events missing" } });
  });

  it("a state of on without its events, summary or unknown-accounts count is unavailable, never an empty list", async () => {
    const { events, ...noEvents } = SIGN_INS;
    void events;
    for (const body of [[], {}, noEvents, { ...SIGN_INS, summary: null }, { ...SIGN_INS, unknownAccounts: undefined }, { ...SIGN_INS, state: "maybe" },
      { ...SIGN_INS, window: "15m" }, { ...SIGN_INS, events: [event({ type: "teleport" })] },
      { ...SIGN_INS, summary: { ...SIGN_INS.summary, failedByIp: "none" } }]) {
      vi.stubGlobal("fetch", answer(200, body));
      expect(await listSignInsResult("u1", "co-a"), JSON.stringify(body)).toEqual({ kind: "unavailable", reason: WRONG });
    }
  });
});

describe("listAlertsResult", () => {
  it("reads the window and returns the alerts with the sign-in state", async () => {
    const f = answer(200, ALERTS);
    vi.stubGlobal("fetch", f);
    expect(await listAlertsResult("u1", "co-a", "24h")).toEqual({ kind: "ok", data: ALERTS });
    expect(urlOf(f)).toBe("http://p.test/api/co-a/it/security/alerts?window=24h");
  });

  it("keeps the reason that comes with an unavailable sign-in state", async () => {
    vi.stubGlobal("fetch", answer(200, { ...ALERTS, signIns: "unavailable", reason: "view-events is missing", alerts: [] }));
    expect(await listAlertsResult("u1", "co-a")).toMatchObject({ kind: "ok", data: { signIns: "unavailable", reason: "view-events is missing" } });
  });

  it("a wrong shape, a missing sign-in state or an unknown severity is unavailable", async () => {
    for (const body of [[], {}, { ...ALERTS, signIns: "sort of" }, { ...ALERTS, signIns: undefined }, { ...ALERTS, alerts: "none" },
      { ...ALERTS, alerts: [{ ...ALERTS.alerts[0], severity: "critical" }] }, { ...ALERTS, alerts: [{ ...ALERTS.alerts[0], subject: null }] }]) {
      vi.stubGlobal("fetch", answer(200, body));
      expect(await listAlertsResult("u1", "co-a"), JSON.stringify(body)).toEqual({ kind: "unavailable", reason: WRONG });
    }
  });
});

describe("listBlocksResult", () => {
  it("reads the blocks route (no window) and returns both lists", async () => {
    const f = answer(200, BLOCKS);
    vi.stubGlobal("fetch", f);
    expect(await listBlocksResult("u1", "co-a")).toEqual({ kind: "ok", data: BLOCKS });
    expect(urlOf(f)).toBe("http://p.test/api/co-a/it/security/blocks");
  });

  it("a lifted block carries who lifted it", async () => {
    const lifted = { ...BLOCK, active: false, liftedAt: "2026-10-15T08:00:00Z", liftedBy: { userId: "u9", displayName: "Hansel" } };
    vi.stubGlobal("fetch", answer(200, { ipBlocks: [lifted], revokedSessions: [] }));
    expect(await listBlocksResult("u1", "co-a")).toEqual({ kind: "ok", data: { ipBlocks: [lifted], revokedSessions: [] } });
  });

  it("both empty is ok; one list missing, or a block without its address, is unavailable", async () => {
    vi.stubGlobal("fetch", answer(200, { ipBlocks: [], revokedSessions: [] }));
    expect(await listBlocksResult("u1", "co-a")).toEqual({ kind: "ok", data: { ipBlocks: [], revokedSessions: [] } });
    for (const body of [[], {}, { ipBlocks: [] }, { revokedSessions: [] }, { ipBlocks: [{ ...BLOCK, ip: undefined }], revokedSessions: [] },
      { ipBlocks: [{ ...BLOCK, active: undefined }], revokedSessions: [] }, { ipBlocks: [{ ...BLOCK, createdBy: null }], revokedSessions: [] },
      { ipBlocks: [], revokedSessions: [{ sessionId: "s" }] }, { ipBlocks: [], revokedSessions: [{ ...REVOCATION, who: null }] }]) {
      vi.stubGlobal("fetch", answer(200, body));
      expect(await listBlocksResult("u1", "co-a"), JSON.stringify(body)).toEqual({ kind: "unavailable", reason: WRONG });
    }
  });
});

describe.each([
  ["listConnectionsResult", (u: string, t: string) => listConnectionsResult(u, t)],
  ["listSignInsResult", (u: string, t: string) => listSignInsResult(u, t)],
  ["listAlertsResult", (u: string, t: string) => listAlertsResult(u, t)],
  ["listBlocksResult", (u: string, t: string) => listBlocksResult(u, t)],
])("%s refusals", (_name, read) => {
  it("is forbidden on 403", async () => {
    vi.stubGlobal("fetch", answer(403, { error: "forbidden" }));
    expect(await read("u1", "co-a")).toEqual({ kind: "forbidden" });
  });

  it("is unavailable, in the server's words, on 400, 404 and 5xx", async () => {
    for (const status of [400, 404, 500, 503]) {
      vi.stubGlobal("fetch", answer(status, { error: `failed ${status}` }));
      expect(await read("u1", "co-a")).toEqual({ kind: "unavailable", reason: `failed ${status}` });
    }
  });

  it("is unavailable when the request itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket hang up"); }));
    expect(await read("u1", "co-a")).toEqual({ kind: "unavailable", reason: "socket hang up" });
  });
});
