import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDemoResponse } from "./demoFixtures";
import { listAlertsResult, listBlocksResult, listConnectionsResult, listSignInsResult } from "./itSecurity";

// DW-7h: the demo layer answers the four GETs and three POSTs of IT > Network (BFF §52), in the shapes the readers check, and
// mirrors the server's refusals closely enough to drive every state of the forms in a browser. Without these explicit routes the
// dispatcher's catch-all would answer `[]` and the pages would read "cannot be read".
const T = "co-demo";
const post = (path: string, body: unknown) => getDemoResponse("POST", `/api/${T}/it/security/${path}`, "demo-hansel", JSON.stringify(body));
const get = (path: string) => getDemoResponse("GET", `/api/${T}/it/security/${path}`, "demo-hansel");

beforeEach(() => { process.env.DEMO_MODE = "1"; });
afterEach(() => { delete process.env.DEMO_MODE; });

describe("the demo reads pass the readers' shape checks", () => {
  it("connections: every window, newest first, with a blocked address, a signed-out session and one with no session id", async () => {
    for (const w of ["15m", "24h", "7d"] as const) {
      const r = await listConnectionsResult("demo-hansel", T, w);
      expect(r.kind, w).toBe("ok");
    }
    const r = await listConnectionsResult("demo-hansel", T, "7d");
    if (r.kind !== "ok") throw new Error("not ok");
    const rows = r.data.connections;
    expect(rows.some((c) => c.ipBlocked)).toBe(true);
    expect(rows.some((c) => c.revoked)).toBe(true);
    expect(rows.some((c) => c.sessionId === "")).toBe(true);
    expect(rows.map((c) => c.lastSeenAt)).toEqual([...rows.map((c) => c.lastSeenAt)].sort().reverse());
    const short = await listConnectionsResult("demo-hansel", T, "15m");
    if (short.kind === "ok") expect(short.data.connections.length).toBeLessThan(rows.length);
  });

  it("sign-ins: on, with failed sign-ins, a summary and unknown accounts", async () => {
    const r = await listSignInsResult("demo-hansel", T, "24h");
    if (r.kind !== "ok" || r.data.state !== "on") throw new Error("not on");
    expect(r.data.summary.failed).toBeGreaterThanOrEqual(5);
    expect(r.data.summary.failedByAccount.length).toBeGreaterThan(0);
    expect(r.data.unknownAccounts.failed).toBeGreaterThan(0);
  });

  it("alerts: a failed_signins_account and a new_device one, and a shorter window drops the older", async () => {
    const r = await listAlertsResult("demo-hansel", T, "24h");
    if (r.kind !== "ok") throw new Error("not ok");
    expect(r.data.signIns).toBe("on");
    expect(r.data.alerts.map((a) => a.kind)).toEqual(expect.arrayContaining(["failed_signins_account", "new_device"]));
    const short = await listAlertsResult("demo-hansel", T, "15m");
    if (short.kind === "ok") expect(short.data.alerts.length).toBeLessThan(r.data.alerts.length);
  });

  it("blocks: an active block first, then earlier ones, and sessions ended", async () => {
    const r = await listBlocksResult("demo-hansel", T);
    if (r.kind !== "ok") throw new Error("not ok");
    expect(r.data.ipBlocks[0].liftedAt).toBeNull();
    expect(r.data.ipBlocks.length).toBeGreaterThan(1);
    expect(r.data.revokedSessions.some((s) => s.sessionId === null)).toBe(true);
  });

  it("refuses a window the route does not take with a 400", () => {
    expect(get("connections?window=1y").status).toBe(400);
    expect(get("sign-ins?window=15m").status).toBe(400);
    expect(get("alerts?window=").status).toBe(400);
  });
});

describe("the demo writes mirror the server's refusals", () => {
  it("revoke: 200 and the connection reads as revoked; your own session is a 409 revokes_yourself; an unknown one is a 404", () => {
    expect(post("sessions/demo-sid-dewi-1/revoke", { userId: "u-dewi" })).toEqual({ status: 200, json: { revoked: true, keycloak: "ended" } });
    const own = post("sessions/demo-sid-hansel/revoke", { userId: "demo-hansel" });
    expect(own.status).toBe(409);
    expect(own.json).toMatchObject({ reason: "revokes_yourself" });
    expect(post("sessions/nope/revoke", { userId: "u-dewi" }).status).toBe(404);
  });

  it("block: an invalid, a private and your own address are refused; a shared one asks, then goes through with confirmShared; the same address twice is already_blocked", () => {
    expect(post("blocks", { ip: "not-an-ip", reason: "abc" }).status).toBe(400);
    expect(post("blocks", { ip: "10.1.2.3", reason: "abc" }).status).toBe(400);
    expect(post("blocks", { ip: "203.0.113.10", reason: "abc" }).json).toMatchObject({ reason: "blocks_yourself" });
    const shared = post("blocks", { ip: "198.51.100.50", reason: "abc" });
    expect(shared.status).toBe(409);
    expect(shared.json).toMatchObject({ reason: "shared_address", detail: { users: 3 } });
    const made = post("blocks", { ip: "198.51.100.50", reason: "abc", hours: 2, confirmShared: true });
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ ip: "198.51.100.50", liftedAt: null });
    expect(post("blocks", { ip: "198.51.100.50", reason: "abc" }).json).toMatchObject({ reason: "already_blocked" });
  });

  it("lift: the block is lifted, a second lift is a 409 not_active, an unknown id a 404; a lifted block reads as earlier", async () => {
    const made = post("blocks", { ip: "192.0.2.99", reason: "abc", hours: 1 });
    const id = (made.json as { id: string }).id;
    expect(post(`blocks/${id}/lift`, {}).status).toBe(200);
    expect(post(`blocks/${id}/lift`, {}).json).toMatchObject({ reason: "not_active" });
    expect(post("blocks/nope/lift", {}).status).toBe(404);
    const r = await listBlocksResult("demo-hansel", T);
    if (r.kind !== "ok") throw new Error("not ok");
    expect(r.data.ipBlocks.find((b) => b.id === id)?.liftedAt).not.toBeNull();
  });
});
