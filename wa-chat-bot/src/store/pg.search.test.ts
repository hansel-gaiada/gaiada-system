// PgStore.searchMessages + PgStore.getMessagesPage (1e). Needs a live Postgres: set
// DATABASE_URL_TEST to run (skipped otherwise). Sibling of pg.listchats.test.ts (same
// fixture conventions), scoped to its own tenant so it can't collide with other PG suites.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config } from "../config";
import { PgStore, withTenant } from "./pg";

const url = process.env.DATABASE_URL_TEST ?? "";
const TENANT = "test-search";

describe.skipIf(!url)("PgStore.searchMessages / getMessagesPage", () => {
  let store: PgStore;
  const now = Date.now();

  beforeAll(async () => {
    config.tenantId = TENANT;
    store = new PgStore(url);
    await store.init();
    await store.saveMessage({
      chatId: "pg-search@g.us", senderId: "s1", senderName: "Siti", waMessageId: "ps-1",
      ts: now - 4000, text: "poured the slab today", fromBot: false,
    });
    await store.saveMessage({
      chatId: "pg-search@g.us", senderId: "s2", senderName: "Budi", waMessageId: "ps-2",
      ts: now - 3000, text: "slab inspection passed", fromBot: false,
    });
    await store.saveMessage({
      chatId: "pg-search@g.us", senderId: "s1", senderName: "Siti", waMessageId: "ps-3",
      ts: now - 2000, text: "100% done, no issues", fromBot: false,
    });
    await store.saveMessage({
      chatId: "pg-search-other@g.us", senderId: "s3", senderName: "Wati", waMessageId: "ps-4",
      ts: now - 1000, text: "unrelated chatter", fromBot: false,
    });
  });

  afterAll(async () => {
    await withTenant((store as unknown as { pool: import("pg").Pool }).pool, [TENANT], (c) =>
      c.query(`DELETE FROM messages WHERE tenant_id = $1`, [TENANT]),
    );
    await store.close();
  });

  describe("searchMessages", () => {
    it("case-insensitive substring match across all chats, newest-first, runs under RLS", async () => {
      const hits = await store.searchMessages("slab", 10);
      expect(hits.map((h) => h.waMessageId)).toEqual(["ps-2", "ps-1"]);
    });

    it("empty/whitespace query returns [] without querying", async () => {
      expect(await store.searchMessages("", 10)).toEqual([]);
      expect(await store.searchMessages("   ", 10)).toEqual([]);
    });

    it("respects limit", async () => {
      const hits = await store.searchMessages("s", 1);
      expect(hits).toHaveLength(1);
    });

    it("a literal % in the query is treated literally, not as an ILIKE wildcard", async () => {
      const hits = await store.searchMessages("100%", 10);
      expect(hits.map((h) => h.waMessageId)).toEqual(["ps-3"]);
    });

    it("no match returns []", async () => {
      expect(await store.searchMessages("no-such-term-xyz", 10)).toEqual([]);
    });
  });

  describe("getMessagesPage", () => {
    it("without beforeTs, returns the newest `limit` messages, oldest -> newest", async () => {
      const page = await store.getMessagesPage("pg-search@g.us", { limit: 2 });
      expect(page.map((p) => p.waMessageId)).toEqual(["ps-2", "ps-3"]);
    });

    it("with beforeTs, returns the newest `limit` messages strictly older than it, oldest -> newest", async () => {
      const page = await store.getMessagesPage("pg-search@g.us", { limit: 10, beforeTs: now - 2000 });
      expect(page.map((p) => p.waMessageId)).toEqual(["ps-1", "ps-2"]);
    });

    it("a beforeTs at or before the oldest message returns []", async () => {
      const page = await store.getMessagesPage("pg-search@g.us", { limit: 10, beforeTs: now - 4000 });
      expect(page).toEqual([]);
    });

    it("an unknown chatId returns []", async () => {
      expect(await store.getMessagesPage("no-such-chat@g.us", { limit: 10 })).toEqual([]);
    });
  });
});
