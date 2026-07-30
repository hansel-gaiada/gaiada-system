// GET /admin/media/status (1d): auth (401/503) + the queueEnabled/pending/oldestPendingTs
// shape, built from getPendingMedia() (mocked here, same convention as chat-admin.test.ts)
// and the real queueEnabled() (a pure config.redisUrl read — no need to mock).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { config } from "./config";
import type { StoredMessage } from "./store/types";

let pending: StoredMessage[] = [];
vi.mock("./store", () => ({
  initStore: vi.fn(async () => undefined),
  saveMessage: vi.fn(async () => undefined),
  getMessages: vi.fn(async () => []),
  getGroupChatIds: vi.fn(async () => []),
  getPendingMedia: vi.fn(async () => pending),
  updateMedia: vi.fn(async () => undefined),
  listChats: vi.fn(async () => []),
  getMessagesPage: vi.fn(async () => []),
  searchMessages: vi.fn(async () => []),
}));

import { buildApp } from "./server";

function pendingMsg(over: Partial<StoredMessage>): StoredMessage {
  return {
    chatId: "g@g.us",
    senderId: "s",
    senderName: "S",
    waMessageId: `w-${Math.random()}`,
    ts: Date.now(),
    text: "",
    fromBot: false,
    mediaStatus: "pending",
    ...over,
  };
}

const gw = { sendText: async () => {} };

describe("GET /admin/media/status", () => {
  beforeEach(() => {
    config.adminToken = "sekret";
    config.redisUrl = "";
    pending = [];
  });

  it("401s without the admin token", async () => {
    const app = buildApp(gw as any);
    const res = await app.inject({ method: "GET", url: "/admin/media/status" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("503s when ADMIN_TOKEN is unset (fail-closed)", async () => {
    config.adminToken = "";
    const app = buildApp(gw as any);
    const res = await app.inject({ method: "GET", url: "/admin/media/status", headers: { authorization: "Bearer whatever" } });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("queueEnabled reflects config.redisUrl; empty queue -> pending 0, oldestPendingTs null", async () => {
    config.redisUrl = "redis://localhost:6379";
    const app = buildApp(gw as any);
    const res = await app.inject({ method: "GET", url: "/admin/media/status", headers: { authorization: "Bearer sekret" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ queueEnabled: true, pending: 0, oldestPendingTs: null });
    await app.close();
  });

  it("queueEnabled is false when REDIS_URL is unset (the poller-only, no-queue mode)", async () => {
    config.redisUrl = "";
    const app = buildApp(gw as any);
    const res = await app.inject({ method: "GET", url: "/admin/media/status", headers: { authorization: "Bearer sekret" } });
    expect((res.json() as { queueEnabled: boolean }).queueEnabled).toBe(false);
    await app.close();
  });

  it("reports the pending count and the oldest pending message's ts — counts only, never a media ref or text", async () => {
    const now = Date.now();
    pending = [
      pendingMsg({ waMessageId: "a", ts: now - 1000, mediaRef: "http://waha/a", text: "should never appear" }),
      pendingMsg({ waMessageId: "b", ts: now - 5000, mediaRef: "http://waha/b" }), // oldest
      pendingMsg({ waMessageId: "c", ts: now - 2000 }),
    ];
    const app = buildApp(gw as any);
    const res = await app.inject({ method: "GET", url: "/admin/media/status", headers: { authorization: "Bearer sekret" } });
    const body = res.json() as Record<string, unknown>;
    expect(body).toEqual({ queueEnabled: false, pending: 3, oldestPendingTs: now - 5000 });
    // Never leaks mediaRef/text — the route only ever returns the three declared keys.
    expect(Object.keys(body).sort()).toEqual(["oldestPendingTs", "pending", "queueEnabled"]);
    await app.close();
  });
});
