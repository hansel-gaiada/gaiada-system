// Chat viewer + session-events routes (design doc addendum): auth (401/503), chatId
// validation, thread ordering, and the /admin/chats mapping (kind/surface/name/preview).
// Same conventions as schedule.test.ts/phase1.e2e.test.ts: ./store is mocked with a plain
// in-memory fixture so this suite never depends on which real Store impl (File/Pg) the
// running process's DATABASE_URL would select — store/file.test.ts covers FileStore.listChats
// directly, and pg.rls.test.ts's sibling covers PgStore.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import type { ChatSummary, StoredMessage } from "./store/types";

let chatSummaries: ChatSummary[] = [];
const messagesByChat: Record<string, StoredMessage[]> = {};

vi.mock("./store", () => ({
  initStore: vi.fn(async () => undefined),
  saveMessage: vi.fn(async () => undefined),
  getGroupChatIds: vi.fn(async () => Object.keys(messagesByChat).filter((c) => c.endsWith("@g.us"))),
  getPendingMedia: vi.fn(async () => []),
  updateMedia: vi.fn(async () => undefined),
  getMessages: vi.fn(async (chatId: string, sinceTs = 0) =>
    (messagesByChat[chatId] ?? []).filter((m) => m.ts >= sinceTs).sort((a, b) => a.ts - b.ts),
  ),
  listChats: vi.fn(async (limit = 100) => chatSummaries.slice(0, limit)),
}));

import { buildApp } from "./server";
import { config } from "./config";
import { resetSessionState, recordSessionEvent } from "./session-state";
import { resetRegistryCache } from "./groups";
import { listChats as mockedListChats } from "./store";

const gw = { sendText: async () => {} };
const DIR = "data/test-chat-admin";

function summary(over: Partial<ChatSummary>): ChatSummary {
  return { chatId: "111@g.us", messageCount: 1, lastActivityTs: 1000, lastPreview: "hi", lastSenderName: "", ...over };
}

function msg(over: Partial<StoredMessage>): StoredMessage {
  return {
    chatId: "111@g.us",
    senderId: "s1",
    senderName: "Siti",
    waMessageId: `w-${Math.random()}`,
    ts: Date.now(),
    text: "hello",
    fromBot: false,
    ...over,
  };
}

const ROUTES: Array<["GET", string]> = [
  ["GET", "/admin/chats"],
  ["GET", "/admin/chats/111%40g.us/messages"],
  ["GET", "/admin/session/events"],
];

describe("chat admin routes", () => {
  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    config.adminToken = "sekret";
    config.groupsFile = `${DIR}/groups.yaml`;
    config.groupsSeedFile = "";
    resetRegistryCache();
    resetSessionState();
    chatSummaries = [];
    for (const k of Object.keys(messagesByChat)) delete messagesByChat[k];
  });

  afterEach(() => {
    rmSync(DIR, { recursive: true, force: true });
  });

  it("401s every route without the admin token", async () => {
    const app = buildApp(gw as any);
    for (const [method, url] of ROUTES) {
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(401);
    }
    await app.close();
  });

  it("503s every route when ADMIN_TOKEN is unset (fail-closed)", async () => {
    config.adminToken = "";
    const app = buildApp(gw as any);
    for (const [method, url] of ROUTES) {
      const res = await app.inject({ method, url, headers: { authorization: "Bearer whatever" } });
      expect(res.statusCode).toBe(503);
    }
    await app.close();
  });

  it("GET /admin/chats: group name comes from the registry, kind/surface derived from chatId, preview truncated", async () => {
    writeFileSync(
      config.groupsFile,
      "groups:\n  - id: \"111@g.us\"\n    name: Site A\n    category: construction\n    optIn: false\n",
    );
    resetRegistryCache();
    chatSummaries = [
      summary({ chatId: "111@g.us", messageCount: 5, lastActivityTs: 2000, lastPreview: "x".repeat(120) }),
      summary({ chatId: "62812@c.us", messageCount: 1, lastActivityTs: 1500, lastPreview: "dm hi", lastSenderName: "Wati" }),
      summary({ chatId: "tg:-1001", messageCount: 1, lastActivityTs: 1000, lastPreview: "bot only", lastSenderName: "" }),
    ];

    const app = buildApp(gw as any);
    const res = await app.inject({ method: "GET", url: "/admin/chats", headers: { authorization: "Bearer sekret" } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { chats: Array<Record<string, unknown>> };
    expect(body.chats).toHaveLength(3);

    const group = body.chats.find((c) => c.chatId === "111@g.us")!;
    expect(group).toMatchObject({ kind: "group", surface: "whatsapp", name: "Site A", messageCount: 5, lastActivityTs: 2000 });
    expect((group.lastPreview as string)).toBe(`${"x".repeat(80)}…`);

    const dm = body.chats.find((c) => c.chatId === "62812@c.us")!;
    expect(dm).toMatchObject({ kind: "dm", surface: "whatsapp", name: "Wati", lastPreview: "dm hi" });

    const tg = body.chats.find((c) => c.chatId === "tg:-1001")!;
    // No non-bot sender recorded -> name falls back to the chatId itself.
    expect(tg).toMatchObject({ kind: "dm", surface: "telegram", name: "tg:-1001" });
    await app.close();
  });

  it("GET /admin/chats: passes the limit querystring through to the store", async () => {
    chatSummaries = [summary({})];
    const app = buildApp(gw as any);
    await app.inject({ method: "GET", url: "/admin/chats?limit=7", headers: { authorization: "Bearer sekret" } });
    expect(mockedListChats).toHaveBeenCalledWith(7);
    await app.close();
  });

  it("GET /admin/chats/:chatId/messages: 400 on an invalid chatId", async () => {
    const app = buildApp(gw as any);
    const res = await app.inject({ method: "GET", url: "/admin/chats/not-a-chat-id/messages", headers: { authorization: "Bearer sekret" } });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/invalid chatId/i);
    await app.close();
  });

  it("GET /admin/chats/:chatId/messages: 404 when the chat has no stored messages", async () => {
    const app = buildApp(gw as any);
    const res = await app.inject({ method: "GET", url: "/admin/chats/999%40g.us/messages", headers: { authorization: "Bearer sekret" } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("GET /admin/chats/:chatId/messages: returns the thread oldest -> newest, capped to `limit`", async () => {
    messagesByChat["111@g.us"] = [
      msg({ ts: 3000, text: "third" }),
      msg({ ts: 1000, text: "first" }),
      msg({ ts: 2000, text: "second" }),
    ];

    const app = buildApp(gw as any);
    const res = await app.inject({
      method: "GET",
      url: "/admin/chats/111%40g.us/messages?limit=2",
      headers: { authorization: "Bearer sekret" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { chatId: string; messages: Array<{ ts: number; text: string }> };
    expect(body.chatId).toBe("111@g.us");
    // last 2 of the 3, still oldest -> newest.
    expect(body.messages.map((m) => m.text)).toEqual(["second", "third"]);
    expect(body.messages[0].ts).toBeLessThan(body.messages[1].ts);
    await app.close();
  });

  it("GET /admin/chats/:chatId/messages: accepts tg: chat ids", async () => {
    messagesByChat["tg:-1001"] = [msg({ chatId: "tg:-1001", ts: 1000, text: "hi" })];
    const app = buildApp(gw as any);
    const res = await app.inject({
      method: "GET",
      url: "/admin/chats/tg%3A-1001/messages",
      headers: { authorization: "Bearer sekret" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { chatId: string }).chatId).toBe("tg:-1001");
    await app.close();
  });

  it("GET /admin/session/events: exposes the transitions ring buffer (oldest first, per design)", async () => {
    recordSessionEvent("STARTING", 1);
    recordSessionEvent("SCAN_QR_CODE", 2);
    recordSessionEvent("WORKING", 3);

    const app = buildApp(gw as any);
    const res = await app.inject({ method: "GET", url: "/admin/session/events", headers: { authorization: "Bearer sekret" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      events: [
        { status: "STARTING", ts: 1 },
        { status: "SCAN_QR_CODE", ts: 2 },
        { status: "WORKING", ts: 3 },
      ],
    });
    await app.close();
  });
});
