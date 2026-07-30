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
  // Mirrors the real FileStore semantics (see store/file.test.ts) closely enough for these
  // route-level tests, which exercise chat-admin.ts's own logic (hasMore derivation, name
  // resolution), not the store implementation itself (covered directly in store/file.test.ts
  // and store/pg.search.test.ts).
  getMessagesPage: vi.fn(async (chatId: string, opts: { limit: number; beforeTs?: number }) =>
    (messagesByChat[chatId] ?? [])
      .filter((m) => opts.beforeTs === undefined || m.ts < opts.beforeTs)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, opts.limit)
      .sort((a, b) => a.ts - b.ts),
  ),
  searchMessages: vi.fn(async (query: string, limit = 20) => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return Object.values(messagesByChat)
      .flat()
      .filter((m) => m.text.toLowerCase().includes(q))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
  }),
}));

import { buildApp } from "./server";
import { config } from "./config";
import { resetSessionState, recordSessionEvent } from "./session-state";
import { resetRegistryCache } from "./groups";
import { listChats as mockedListChats } from "./store";
import { isValidChatId } from "./chat-admin";

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
  ["GET", "/admin/search"],
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

  it("GET /admin/chats: `q` filters by name or id, case-insensitive (1e)", async () => {
    writeFileSync(config.groupsFile, "groups:\n  - id: \"111@g.us\"\n    name: Site Alpha\n");
    resetRegistryCache();
    chatSummaries = [
      summary({ chatId: "111@g.us" }),
      summary({ chatId: "62812@c.us", lastSenderName: "Wati" }),
    ];
    const app = buildApp(gw as any);
    const res = await app.inject({ method: "GET", url: "/admin/chats?q=alpha", headers: { authorization: "Bearer sekret" } });
    const body = res.json() as { chats: Array<{ chatId: string }> };
    expect(body.chats.map((c) => c.chatId)).toEqual(["111@g.us"]);

    // Matching by (part of) the raw chatId also works.
    const byId = await app.inject({ method: "GET", url: "/admin/chats?q=62812", headers: { authorization: "Bearer sekret" } });
    expect((byId.json() as { chats: Array<{ chatId: string }> }).chats.map((c) => c.chatId)).toEqual(["62812@c.us"]);
    await app.close();
  });

  it("GET /admin/chats: `kind` filters to group|dm; an unrecognized value is ignored", async () => {
    chatSummaries = [summary({ chatId: "111@g.us" }), summary({ chatId: "62812@c.us" })];
    const app = buildApp(gw as any);

    const groups = await app.inject({ method: "GET", url: "/admin/chats?kind=group", headers: { authorization: "Bearer sekret" } });
    expect((groups.json() as { chats: Array<{ chatId: string }> }).chats.map((c) => c.chatId)).toEqual(["111@g.us"]);

    const dms = await app.inject({ method: "GET", url: "/admin/chats?kind=dm", headers: { authorization: "Bearer sekret" } });
    expect((dms.json() as { chats: Array<{ chatId: string }> }).chats.map((c) => c.chatId)).toEqual(["62812@c.us"]);

    const bogus = await app.inject({ method: "GET", url: "/admin/chats?kind=bogus", headers: { authorization: "Bearer sekret" } });
    expect((bogus.json() as { chats: unknown[] }).chats).toHaveLength(2); // ignored, not an error
    await app.close();
  });

  it("GET /admin/chats: q/kind filter BEFORE the limit — a match outside the newest N is still found", async () => {
    // Regression: the filters used to run on the store's already-limited page, so
    // `?kind=dm&limit=8` returned 1 of 12 DMs on the live stack and `?q=<older chat>` returned
    // nothing at all. A search that silently answers "no results" is worse than one that errors.
    writeFileSync(config.groupsFile, "groups:\n  - id: \"111@g.us\"\n    name: Site Alpha\n");
    resetRegistryCache();
    // 10 groups are newer than the only DM, which sits last in activity order.
    chatSummaries = [
      ...Array.from({ length: 10 }, (_, i) =>
        summary({ chatId: `${100 + i}@g.us`, lastActivityTs: 9000 - i }),
      ),
      summary({ chatId: "62899@c.us", lastSenderName: "Buried Wati", lastActivityTs: 1 }),
    ];
    const app = buildApp(gw as any);

    const dms = await app.inject({
      method: "GET",
      url: "/admin/chats?kind=dm&limit=3",
      headers: { authorization: "Bearer sekret" },
    });
    expect((dms.json() as { chats: Array<{ chatId: string }> }).chats.map((c) => c.chatId)).toEqual(["62899@c.us"]);

    const byName = await app.inject({
      method: "GET",
      url: "/admin/chats?q=buried&limit=3",
      headers: { authorization: "Bearer sekret" },
    });
    expect((byName.json() as { chats: Array<{ chatId: string }> }).chats.map((c) => c.chatId)).toEqual(["62899@c.us"]);

    // ...and `limit` still caps the FILTERED result set.
    const capped = await app.inject({
      method: "GET",
      url: "/admin/chats?kind=group&limit=4",
      headers: { authorization: "Bearer sekret" },
    });
    expect((capped.json() as { chats: unknown[] }).chats).toHaveLength(4);
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

  it("GET /admin/chats/:chatId/messages: hasMore is true when older messages exist beyond `limit`", async () => {
    messagesByChat["111@g.us"] = [
      msg({ ts: 1000, text: "first" }),
      msg({ ts: 2000, text: "second" }),
      msg({ ts: 3000, text: "third" }),
    ];
    const app = buildApp(gw as any);
    const res = await app.inject({
      method: "GET",
      url: "/admin/chats/111%40g.us/messages?limit=2",
      headers: { authorization: "Bearer sekret" },
    });
    const body = res.json() as { messages: Array<{ text: string }>; hasMore: boolean };
    expect(body.messages.map((m) => m.text)).toEqual(["second", "third"]);
    expect(body.hasMore).toBe(true);
    await app.close();
  });

  it("GET /admin/chats/:chatId/messages: hasMore is false at the start of a thread", async () => {
    messagesByChat["111@g.us"] = [msg({ ts: 1000, text: "only" })];
    const app = buildApp(gw as any);
    const res = await app.inject({
      method: "GET",
      url: "/admin/chats/111%40g.us/messages?limit=10",
      headers: { authorization: "Bearer sekret" },
    });
    expect((res.json() as { hasMore: boolean }).hasMore).toBe(false);
    await app.close();
  });

  it("GET /admin/chats/:chatId/messages: `beforeTs` pages backwards; exhausting a KNOWN chat's history is 200 (not 404)", async () => {
    messagesByChat["111@g.us"] = [
      msg({ ts: 1000, text: "first" }),
      msg({ ts: 2000, text: "second" }),
      msg({ ts: 3000, text: "third" }),
    ];
    const app = buildApp(gw as any);
    const older = await app.inject({
      method: "GET",
      url: "/admin/chats/111%40g.us/messages?limit=10&beforeTs=2000",
      headers: { authorization: "Bearer sekret" },
    });
    const olderBody = older.json() as { messages: Array<{ text: string }>; hasMore: boolean };
    expect(olderBody.messages.map((m) => m.text)).toEqual(["first"]); // strictly older than 2000
    expect(olderBody.hasMore).toBe(false);

    const exhausted = await app.inject({
      method: "GET",
      url: "/admin/chats/111%40g.us/messages?limit=10&beforeTs=1000",
      headers: { authorization: "Bearer sekret" },
    });
    expect(exhausted.statusCode).toBe(200); // reached the start of a real thread, not "unknown chat"
    const exhaustedBody = exhausted.json() as { messages: unknown[]; hasMore: boolean };
    expect(exhaustedBody.messages).toEqual([]);
    expect(exhaustedBody.hasMore).toBe(false);
    await app.close();
  });

  it("GET /admin/chats/:chatId/messages: a malformed `beforeTs` is ignored (fail-soft), not a 400", async () => {
    messagesByChat["111@g.us"] = [msg({ ts: 1000, text: "only" })];
    const app = buildApp(gw as any);
    const res = await app.inject({
      method: "GET",
      url: "/admin/chats/111%40g.us/messages?beforeTs=not-a-number",
      headers: { authorization: "Bearer sekret" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { messages: Array<{ text: string }> }).messages.map((m) => m.text)).toEqual(["only"]);
    await app.close();
  });

  it("GET /admin/chats/:chatId/messages: accepts @lid DM ids (NOWEB linked identity)", async () => {
    // Regression: the NOWEB (Baileys) engine addresses most 1:1 chats by LINKED IDENTITY
    // (<digits>@lid). The validator only allowed c.us/g.us/tg:, so on the live stack all 12 @lid
    // DMs listed correctly but returned {"error":"invalid chatId"} the moment they were clicked.
    messagesByChat["36314183401707@lid"] = [
      msg({ chatId: "36314183401707@lid", ts: 1000, text: "dm via lid" }),
    ];
    const app = buildApp(gw as any);
    const res = await app.inject({
      method: "GET",
      url: "/admin/chats/36314183401707%40lid/messages",
      headers: { authorization: "Bearer sekret" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { chatId: string; messages: Array<{ text: string }> };
    expect(body.chatId).toBe("36314183401707@lid");
    expect(body.messages.map((m) => m.text)).toEqual(["dm via lid"]);
    await app.close();
  });

  it("isValidChatId accepts every id shape the live store actually holds, and rejects anything else", () => {
    for (const ok of [
      "123@g.us", // modern group
      "123@c.us", // classic DM
      "36314183401707@lid", // NOWEB linked-identity DM
      "628123894471-1606911325@g.us", // LEGACY group id (<creator>-<created-at>)
      "tg:-1001",
      "tg:42",
    ]) {
      expect(isValidChatId(ok)).toBe(true);
    }
    for (const bad of ["", "nope", "123@unknown", "@lid", "abc@lid", "123@lid.us", "tg:x", "-123@g.us", "1-@g.us"]) {
      expect(isValidChatId(bad)).toBe(false);
    }
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

  it("GET /admin/search: matches across chats and resolves names via groupName()/senderName (1e)", async () => {
    writeFileSync(config.groupsFile, "groups:\n  - id: \"111@g.us\"\n    name: Site A\n");
    resetRegistryCache();
    messagesByChat["111@g.us"] = [msg({ chatId: "111@g.us", ts: 2000, text: "poured the SLAB", senderName: "Budi" })];
    messagesByChat["62812@c.us"] = [
      msg({ chatId: "62812@c.us", ts: 1000, text: "slab inspection", senderName: "Wati", senderId: "628" }),
    ];

    const app = buildApp(gw as any);
    const res = await app.inject({ method: "GET", url: "/admin/search?q=slab", headers: { authorization: "Bearer sekret" } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { results: Array<Record<string, unknown>> };
    expect(body.results).toHaveLength(2);

    const group = body.results.find((r) => r.chatId === "111@g.us")!;
    expect(group).toMatchObject({ chatName: "Site A", kind: "group", surface: "whatsapp", senderName: "Budi", text: "poured the SLAB" });

    const dm = body.results.find((r) => r.chatId === "62812@c.us")!;
    expect(dm).toMatchObject({ chatName: "Wati", kind: "dm", surface: "whatsapp" });
    await app.close();
  });

  it("GET /admin/search: an empty query returns {results: []}, not a 400", async () => {
    messagesByChat["111@g.us"] = [msg({ text: "hello" })];
    const app = buildApp(gw as any);
    const res = await app.inject({ method: "GET", url: "/admin/search", headers: { authorization: "Bearer sekret" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ results: [] });
    await app.close();
  });

  it("GET /admin/search: no matches returns {results: []}", async () => {
    messagesByChat["111@g.us"] = [msg({ text: "hello" })];
    const app = buildApp(gw as any);
    const res = await app.inject({ method: "GET", url: "/admin/search?q=nonexistent-xyz", headers: { authorization: "Bearer sekret" } });
    expect(res.json()).toEqual({ results: [] });
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
