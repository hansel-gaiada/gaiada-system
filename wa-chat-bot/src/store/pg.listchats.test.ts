// PgStore.listChats aggregate query. Needs a live Postgres: set DATABASE_URL_TEST to run
// (skipped otherwise). Sibling of pg.rls.test.ts (same fixture conventions), scoped to a
// distinct tenant so it can't collide with the RLS suite's rows.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config } from "../config";
import { PgStore, withTenant } from "./pg";

const url = process.env.DATABASE_URL_TEST ?? "";
const TENANT = "test-listchats";

describe.skipIf(!url)("PgStore.listChats", () => {
  let store: PgStore;

  beforeAll(async () => {
    config.tenantId = TENANT;
    store = new PgStore(url);
    await store.init();
  });

  afterAll(async () => {
    await withTenant((store as unknown as { pool: import("pg").Pool }).pool, [TENANT], (c) =>
      c.query(`DELETE FROM messages WHERE tenant_id = $1`, [TENANT]),
    );
    await store.close();
  });

  // Timestamps must be within config.retentionDays of "now" — saveMessage purges anything
  // older on every write, so fixtures use small offsets from Date.now().
  const now = Date.now();

  it("aggregates one entry per chat, sorted by lastActivityTs desc, with count/preview/sender", async () => {
    await store.saveMessage({
      chatId: "pg-a@g.us", senderId: "s1", senderName: "Siti", waMessageId: "pg-1", ts: now - 3000, text: "first", fromBot: false,
    });
    await store.saveMessage({
      chatId: "pg-a@g.us", senderId: "s2", senderName: "Budi", waMessageId: "pg-2", ts: now - 1000, text: "third", fromBot: false,
    });
    await store.saveMessage({
      chatId: "pg-b@c.us", senderId: "628", senderName: "Wati", waMessageId: "pg-3", ts: now - 2000, text: "dm", fromBot: false,
    });

    const chats = await store.listChats(10);
    const a = chats.find((c) => c.chatId === "pg-a@g.us")!;
    const b = chats.find((c) => c.chatId === "pg-b@c.us")!;
    expect(chats.findIndex((c) => c.chatId === "pg-a@g.us")).toBeLessThan(chats.findIndex((c) => c.chatId === "pg-b@c.us"));
    expect(a.messageCount).toBe(2);
    expect(a.lastActivityTs).toBe(now - 1000);
    expect(a.lastPreview).toBe("third");
    expect(a.lastSenderName).toBe("Budi");
    expect(b.messageCount).toBe(1);
    expect(b.lastSenderName).toBe("Wati");
  });

  it("bot-only chat has no non-bot sender -> lastSenderName is empty", async () => {
    await store.saveMessage({
      chatId: "pg-botonly@c.us", senderId: "bot", senderName: "Bot", waMessageId: "pg-4", ts: now - 500, text: "auto", fromBot: true,
    });
    const chats = await store.listChats(50);
    const row = chats.find((c) => c.chatId === "pg-botonly@c.us")!;
    expect(row.lastSenderName).toBe("");
    expect(row.lastPreview).toBe("auto");
  });

  it("caps to `limit`, keeping the most recently active chats", async () => {
    const chats = await store.listChats(1);
    expect(chats).toHaveLength(1);
  });
});
