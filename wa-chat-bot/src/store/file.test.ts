import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { FileStore } from "./file";
import type { StoredMessage } from "./types";

const DIR = "data/test-filestore";

function m(over: Partial<StoredMessage>): StoredMessage {
  return {
    chatId: "g@g.us",
    senderId: "s1",
    senderName: "Siti",
    waMessageId: "w1",
    ts: Date.now(),
    text: "hello",
    fromBot: false,
    ...over,
  };
}

describe("FileStore media queue", () => {
  let store: FileStore;

  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    store = new FileStore(`${DIR}/messages.json`);
  });
  afterAll(() => rmSync(DIR, { recursive: true, force: true }));

  it("persists media fields and lists pending media", async () => {
    await store.saveMessage(m({ waMessageId: "text-1" }));
    await store.saveMessage(
      m({ waMessageId: "voice-1", mediaMime: "audio/ogg", mediaRef: "http://waha/m/1", mediaStatus: "pending" }),
    );
    const pending = await store.getPendingMedia();
    expect(pending.map((p) => p.waMessageId)).toEqual(["voice-1"]);
    expect(pending[0].mediaMime).toBe("audio/ogg");
  });

  it("updateMedia completes a row and removes it from the queue", async () => {
    await store.saveMessage(m({ waMessageId: "img-1", mediaMime: "image/jpeg", mediaStatus: "pending" }));
    await store.updateMedia("img-1", { status: "done", text: "a crane lifting beams" });
    expect(await store.getPendingMedia()).toEqual([]);
    const [row] = await store.getMessages("g@g.us");
    expect(row.mediaStatus).toBe("done");
    expect(row.mediaText).toBe("a crane lifting beams");
  });

  it("failed media keeps its placeholder and leaves the queue", async () => {
    await store.saveMessage(m({ waMessageId: "vid-1", mediaMime: "video/mp4", mediaStatus: "pending" }));
    await store.updateMedia("vid-1", { status: "failed", text: "[media unavailable]" });
    expect(await store.getPendingMedia()).toEqual([]);
    const [row] = await store.getMessages("g@g.us");
    expect(row.mediaStatus).toBe("failed");
  });
});

describe("FileStore.listChats", () => {
  let store: FileStore;

  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    store = new FileStore(`${DIR}/messages.json`);
  });
  afterAll(() => rmSync(DIR, { recursive: true, force: true }));

  // Timestamps must be within config.retentionDays of "now" — saveMessage purges anything
  // older on every write (crypto-shred retention), so fixtures use small offsets from
  // Date.now() rather than tiny epoch values (which would be purged immediately).
  const now = Date.now();

  it("aggregates one entry per chat, sorted by lastActivityTs desc, with count/preview/sender", async () => {
    await store.saveMessage(m({ chatId: "a@g.us", waMessageId: "1", ts: now - 3000, text: "first" }));
    await store.saveMessage(m({ chatId: "a@g.us", waMessageId: "2", ts: now - 1000, text: "third", senderName: "Budi" }));
    await store.saveMessage(m({ chatId: "b@c.us", waMessageId: "3", ts: now - 2000, text: "dm", senderId: "628", senderName: "Wati" }));

    const chats = await store.listChats();
    expect(chats.map((c) => c.chatId)).toEqual(["a@g.us", "b@c.us"]);

    const a = chats[0];
    expect(a.messageCount).toBe(2);
    expect(a.lastActivityTs).toBe(now - 1000);
    expect(a.lastPreview).toBe("third");
    expect(a.lastSenderName).toBe("Budi");

    const b = chats[1];
    expect(b.messageCount).toBe(1);
    expect(b.lastSenderName).toBe("Wati");
  });

  it("bot-only chat has no non-bot sender -> lastSenderName is empty", async () => {
    await store.saveMessage(m({ chatId: "c@c.us", waMessageId: "1", ts: now - 1000, text: "auto-reply", fromBot: true }));
    const [chat] = await store.listChats();
    expect(chat.lastSenderName).toBe("");
    expect(chat.lastPreview).toBe("auto-reply");
  });

  it("caps to `limit`, keeping the most recently active chats", async () => {
    await store.saveMessage(m({ chatId: "old@g.us", waMessageId: "1", ts: now - 3000 }));
    await store.saveMessage(m({ chatId: "mid@g.us", waMessageId: "2", ts: now - 2000 }));
    await store.saveMessage(m({ chatId: "new@g.us", waMessageId: "3", ts: now - 1000 }));

    const chats = await store.listChats(2);
    expect(chats.map((c) => c.chatId)).toEqual(["new@g.us", "mid@g.us"]);
  });
});

describe("FileStore.searchMessages (1e)", () => {
  let store: FileStore;
  const now = Date.now();

  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    store = new FileStore(`${DIR}/messages.json`);
  });
  afterAll(() => rmSync(DIR, { recursive: true, force: true }));

  it("case-insensitive substring match across all chats, newest-first", async () => {
    await store.saveMessage(m({ chatId: "a@g.us", waMessageId: "1", ts: now - 3000, text: "poured the SLAB today" }));
    await store.saveMessage(m({ chatId: "b@c.us", waMessageId: "2", ts: now - 1000, text: "slab inspection passed" }));
    await store.saveMessage(m({ chatId: "a@g.us", waMessageId: "3", ts: now - 2000, text: "unrelated chatter" }));

    const hits = await store.searchMessages("slab", 10);
    expect(hits.map((h) => h.waMessageId)).toEqual(["2", "1"]); // newest first
  });

  it("empty or whitespace-only query returns []", async () => {
    await store.saveMessage(m({ waMessageId: "1", text: "hello" }));
    expect(await store.searchMessages("", 10)).toEqual([]);
    expect(await store.searchMessages("   ", 10)).toEqual([]);
  });

  it("respects `limit`", async () => {
    for (let i = 0; i < 5; i++) {
      await store.saveMessage(m({ waMessageId: `w${i}`, ts: now - i * 1000, text: "match me" }));
    }
    expect(await store.searchMessages("match", 2)).toHaveLength(2);
  });

  it("no match returns []", async () => {
    await store.saveMessage(m({ waMessageId: "1", text: "hello" }));
    expect(await store.searchMessages("nonexistent-term", 10)).toEqual([]);
  });
});

describe("FileStore.getMessagesPage (1e: backwards paging)", () => {
  let store: FileStore;
  const now = Date.now();

  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    store = new FileStore(`${DIR}/messages.json`);
  });
  afterAll(() => rmSync(DIR, { recursive: true, force: true }));

  it("without beforeTs, returns the newest `limit` messages, oldest -> newest", async () => {
    await store.saveMessage(m({ waMessageId: "1", ts: now - 3000, text: "first" }));
    await store.saveMessage(m({ waMessageId: "2", ts: now - 2000, text: "second" }));
    await store.saveMessage(m({ waMessageId: "3", ts: now - 1000, text: "third" }));

    const page = await store.getMessagesPage("g@g.us", { limit: 2 });
    expect(page.map((p) => p.text)).toEqual(["second", "third"]);
  });

  it("with beforeTs, returns the newest `limit` messages strictly older than it", async () => {
    await store.saveMessage(m({ waMessageId: "1", ts: now - 3000, text: "first" }));
    await store.saveMessage(m({ waMessageId: "2", ts: now - 2000, text: "second" }));
    await store.saveMessage(m({ waMessageId: "3", ts: now - 1000, text: "third" }));

    const page = await store.getMessagesPage("g@g.us", { limit: 10, beforeTs: now - 1000 });
    expect(page.map((p) => p.text)).toEqual(["first", "second"]); // "third" excluded (not strictly older)
  });

  it("a beforeTs at or before the oldest message returns []", async () => {
    await store.saveMessage(m({ waMessageId: "1", ts: now - 1000, text: "only" }));
    expect(await store.getMessagesPage("g@g.us", { limit: 10, beforeTs: now - 1000 })).toEqual([]);
  });

  it("an unknown chatId returns []", async () => {
    await store.saveMessage(m({ chatId: "known@g.us", waMessageId: "1" }));
    expect(await store.getMessagesPage("unknown@g.us", { limit: 10 })).toEqual([]);
  });
});
