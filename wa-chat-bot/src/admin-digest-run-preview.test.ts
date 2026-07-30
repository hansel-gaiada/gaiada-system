// Covers the two new digest surfaces added for the ERP console:
//   POST /admin/digests/run/:slot  — ASYNC trigger (202 immediately, 409 on overlap, a failure
//                                    inside the detached run is caught and recorded to history
//                                    rather than crashing the process).
//   GET  /admin/digests/preview    — read-only preview (never calls gateway.sendText).
// The existing synchronous POST /run-digests/:slot is untouched and already covered elsewhere
// (schedule.test.ts, admin-digests.test.ts) — not re-tested here.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { config } from "./config";
import { resetRegistryCache } from "./groups";
import { resetDigestHistoryCache, digestHistory } from "./digest-history";
import { resetDigestRunGuardForTest } from "./schedule";
import type { StoredMessage } from "./store";

const messagesByChat: Record<string, StoredMessage[]> = {};
vi.mock("./store", () => ({
  getGroupChatIds: vi.fn(async () => Object.keys(messagesByChat)),
  getMessages: vi.fn(async (chatId: string, sinceTs = 0) =>
    (messagesByChat[chatId] ?? []).filter((m) => m.ts >= sinceTs),
  ),
  // Mirrors the real store's contract: last `limit` messages for the chat, oldest -> newest.
  getMessagesPage: vi.fn(async (chatId: string, opts: { limit: number; beforeTs?: number }) => {
    const all = (messagesByChat[chatId] ?? []).filter((m) => opts.beforeTs === undefined || m.ts < opts.beforeTs);
    return all.slice(-opts.limit);
  }),
  saveMessage: vi.fn(async () => undefined),
  initStore: vi.fn(async () => undefined),
}));

const summarizeChat = vi.fn(async (_msgs: StoredMessage[]) => "DIGEST TEXT");
vi.mock("./summarize", () => ({
  summarizeChat: (msgs: StoredMessage[]) => summarizeChat(msgs),
  answerQuestion: vi.fn(async () => "ANSWER"),
}));

import { buildApp } from "./server";

const DIR = "data/test-admin-digest-run-preview";

function m(chatId: string, text: string, over: Partial<StoredMessage> = {}): StoredMessage {
  return {
    chatId,
    senderId: "s",
    senderName: "S",
    waMessageId: `w-${Math.random()}`,
    ts: Date.now() - 1000,
    text,
    fromBot: false,
    ...over,
  };
}

describe("POST /admin/digests/run/:slot (async trigger)", () => {
  let sent: Array<{ chatId: string; text: string }>;
  const gw = { sendText: async (chatId: string, text: string) => void sent.push({ chatId, text }) };

  beforeEach(() => {
    sent = [];
    summarizeChat.mockReset();
    summarizeChat.mockResolvedValue("DIGEST TEXT");
    resetDigestRunGuardForTest();
    for (const k of Object.keys(messagesByChat)) delete messagesByChat[k];
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    config.adminToken = "sekret";
    config.databaseUrl = ""; // hermetic: force file-mode schedule state regardless of a real .env
    config.groupsFile = `${DIR}/missing.yaml`; // trial mode -> getGroupChatIds() drives the slot
    config.scheduleStateFile = `${DIR}/state.json`;
    config.digestHistoryFile = `${DIR}/digest-history.json`;
    config.managementGroupId = "";
    resetRegistryCache();
    resetDigestHistoryCache();
    messagesByChat["site@g.us"] = [m("site@g.us", "poured the slab")];
  });

  it("401s without the admin token", async () => {
    const app = buildApp(gw as any);
    const res = await app.inject({ method: "POST", url: "/admin/digests/run/noon" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("503s when ADMIN_TOKEN is unset (fail-closed)", async () => {
    config.adminToken = "";
    const app = buildApp(gw as any);
    const res = await app.inject({
      method: "POST",
      url: "/admin/digests/run/noon",
      headers: { authorization: "Bearer whatever" },
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("400s on an invalid slot", async () => {
    const app = buildApp(gw as any);
    const res = await app.inject({
      method: "POST",
      url: "/admin/digests/run/midnight",
      headers: { authorization: "Bearer sekret" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("202s immediately without waiting for the run to finish, then the run completes in the background", async () => {
    // Block summarizeChat so the detached run is still in flight when the HTTP response returns.
    const releases: Array<() => void> = [];
    summarizeChat.mockImplementation(() => new Promise((resolve) => releases.push(() => resolve("DIGEST TEXT"))));

    const app = buildApp(gw as any);
    const start = Date.now();
    const res = await app.inject({
      method: "POST",
      url: "/admin/digests/run/noon",
      headers: { authorization: "Bearer sekret" },
    });
    expect(res.statusCode).toBe(202);
    expect(Date.now() - start).toBeLessThan(1000); // never awaited the run itself
    const body = res.json() as { started: boolean; slot: string; startedAt: number };
    expect(body).toMatchObject({ started: true, slot: "noon" });
    expect(typeof body.startedAt).toBe("number");

    // Still running — nothing recorded to history yet.
    expect(digestHistory()).toHaveLength(0);

    await vi.waitFor(() => expect(releases.length).toBe(1));
    releases[0]();
    await vi.waitFor(() => expect(digestHistory()).toHaveLength(1));
    expect(digestHistory()[0]).toMatchObject({ slot: "noon", trigger: "manual" });
    await app.close();
  });

  it("409s a second run of the same slot while one is in flight; a different slot still starts", async () => {
    const releases: Array<() => void> = [];
    summarizeChat.mockImplementation(() => new Promise((resolve) => releases.push(() => resolve("DIGEST TEXT"))));

    const app = buildApp(gw as any);
    const first = await app.inject({
      method: "POST",
      url: "/admin/digests/run/noon",
      headers: { authorization: "Bearer sekret" },
    });
    expect(first.statusCode).toBe(202);

    const second = await app.inject({
      method: "POST",
      url: "/admin/digests/run/noon",
      headers: { authorization: "Bearer sekret" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ slot: "noon" });

    // A different slot is a separate guard — unaffected by noon's in-flight run.
    const evening = await app.inject({
      method: "POST",
      url: "/admin/digests/run/evening",
      headers: { authorization: "Bearer sekret" },
    });
    expect(evening.statusCode).toBe(202);

    // Let both detached runs reach (and block on) summarizeChat, then release them both.
    await vi.waitFor(() => expect(releases.length).toBe(2));
    releases.forEach((r) => r());
    await vi.waitFor(() => expect(digestHistory()).toHaveLength(2));
    await app.close();
  });

  it("a failure that escapes the detached run entirely never becomes an unhandled rejection — it lands in history as an error", async () => {
    const { getMessages } = await import("./store");
    vi.mocked(getMessages).mockImplementationOnce(async () => {
      throw new Error("store exploded");
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);

    const app = buildApp(gw as any);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/admin/digests/run/noon",
        headers: { authorization: "Bearer sekret" },
      });
      expect(res.statusCode).toBe(202);

      await vi.waitFor(() => expect(digestHistory()).toHaveLength(1));
      const [entry] = digestHistory();
      expect(entry).toMatchObject({ slot: "noon", trigger: "manual", groupsCovered: 0 });
      expect(entry.error).toContain("store exploded");
    } finally {
      await app.close();
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toHaveLength(0);
  });
});

describe("GET /admin/digests/preview (no-send preview)", () => {
  // sendText throwing proves the preview path never reaches it — the actual assertion in
  // "never calls gateway.sendText" below is that this never fires.
  const gw = {
    sendText: async () => {
      throw new Error("preview must never call gateway.sendText");
    },
  };

  beforeEach(() => {
    summarizeChat.mockReset();
    summarizeChat.mockResolvedValue("PREVIEW DIGEST TEXT");
    for (const k of Object.keys(messagesByChat)) delete messagesByChat[k];
    config.adminToken = "sekret";
    // Isolate from the async-trigger describe above, which writes real history entries to the
    // same module-level cache/file.
    config.digestHistoryFile = `${DIR}/preview-digest-history.json`;
    resetDigestHistoryCache();
  });

  it("401s without the admin token", async () => {
    const app = buildApp(gw as any);
    const res = await app.inject({ method: "GET", url: "/admin/digests/preview?chatId=111@g.us" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("503s when ADMIN_TOKEN is unset (fail-closed)", async () => {
    config.adminToken = "";
    const app = buildApp(gw as any);
    const res = await app.inject({
      method: "GET",
      url: "/admin/digests/preview?chatId=111@g.us",
      headers: { authorization: "Bearer whatever" },
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("400s on a missing or invalid chatId", async () => {
    const app = buildApp(gw as any);
    const missing = await app.inject({
      method: "GET",
      url: "/admin/digests/preview",
      headers: { authorization: "Bearer sekret" },
    });
    expect(missing.statusCode).toBe(400);

    const bad = await app.inject({
      method: "GET",
      url: "/admin/digests/preview?chatId=not-a-chat-id",
      headers: { authorization: "Bearer sekret" },
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it("404s on a chat with no stored messages", async () => {
    const app = buildApp(gw as any);
    const res = await app.inject({
      method: "GET",
      url: "/admin/digests/preview?chatId=999@g.us",
      headers: { authorization: "Bearer sekret" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("returns {chatId, digest} generated from the stored messages, and never sends anything", async () => {
    messagesByChat["111@g.us"] = [m("111@g.us", "poured the slab"), m("111@g.us", "ordered rebar")];
    const app = buildApp(gw as any);
    const res = await app.inject({
      method: "GET",
      url: "/admin/digests/preview?chatId=111@g.us",
      headers: { authorization: "Bearer sekret" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ chatId: "111@g.us", digest: "PREVIEW DIGEST TEXT" });
    expect(summarizeChat).toHaveBeenCalledTimes(1);
    await app.close();
    // The gw stub above throws if sendText is ever invoked; reaching here without that error
    // propagating (it would have surfaced as a 500/thrown promise) is the no-send proof.
  });

  it("does not persist the digest body anywhere (history stays counts-only)", async () => {
    messagesByChat["111@g.us"] = [m("111@g.us", "poured the slab")];
    const app = buildApp(gw as any);
    await app.inject({
      method: "GET",
      url: "/admin/digests/preview?chatId=111@g.us",
      headers: { authorization: "Bearer sekret" },
    });
    expect(digestHistory()).toEqual([]); // preview never touches digest-history.ts
    await app.close();
  });

  it("excludes the bot's own messages from the transcript, same as the real digest run", async () => {
    messagesByChat["111@g.us"] = [
      m("111@g.us", "poured the slab"),
      m("111@g.us", "*Digest — noon*\n\nprevious digest", { fromBot: true }),
    ];
    const app = buildApp(gw as any);
    const res = await app.inject({
      method: "GET",
      url: "/admin/digests/preview?chatId=111@g.us",
      headers: { authorization: "Bearer sekret" },
    });
    expect(res.statusCode).toBe(200);
    const [msgs] = summarizeChat.mock.calls[0] as [StoredMessage[]];
    expect(msgs.every((mm) => !mm.fromBot)).toBe(true);
    expect(msgs).toHaveLength(1);
    await app.close();
  });

  it("respects the `limit` querystring (last N messages, oldest -> newest)", async () => {
    messagesByChat["111@g.us"] = Array.from({ length: 5 }, (_, i) => m("111@g.us", `msg${i}`, { ts: i }));
    const app = buildApp(gw as any);
    const res = await app.inject({
      method: "GET",
      url: "/admin/digests/preview?chatId=111@g.us&limit=2",
      headers: { authorization: "Bearer sekret" },
    });
    expect(res.statusCode).toBe(200);
    const [msgs] = summarizeChat.mock.calls[0] as [StoredMessage[]];
    expect(msgs.map((mm) => mm.text)).toEqual(["msg3", "msg4"]);
    await app.close();
  });
});
