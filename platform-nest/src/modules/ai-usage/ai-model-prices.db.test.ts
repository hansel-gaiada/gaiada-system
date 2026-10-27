// AIP-04 — migration 202610271810_ai_model_prices.sql, the price lookup and `assistant_threads.total_cost_usd`, against LIVE Postgres. Needs
// DATABASE_URL_TEST; skipped without it. initTestDb() hands us a fully migrated database and repoints the app at a NOSUPERUSER NOBYPASSRLS role
// (platform_app_test); seeding and "what is really stored" go through the superuser pool.
//
// ⚠ The harness blanket-GRANTs on every table to platform_app_test AFTER migrating, and platform_app does not exist in a fresh database, so the
// "runtime role may only READ prices" rule is proved on the migration's TEXT (ai-model-prices-migration.test.ts) and by its own self-assertion,
// which runs when the migration applies on a real cluster.
//
// Proves: the catalogue (columns, primary key, no RLS, every CHECK); the newest row on or before the day wins, a day before the first row or an
// unknown model is NULL; the writer costs an event from the table (cost_source 'table'), keeps a provider cost untouched, and leaves NULL when no
// price is in force; and `total_cost_usd` follows the thread's usage rows (provider and table costs summed, unknown costs ignored, other threads
// and companies untouched, updated_at untouched), including through a real relayGeneration.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { withTenants, newId } from "../../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { createCompany, createUser } from "../../testing/fixtures";
import { lookupModelPrice } from "./prices";
import { recordAiUsage } from "./writer";
import { refreshThreadCost } from "../assistant/thread-cost";
import { relayGeneration, reserveGeneration } from "../assistant/stream";

describe.skipIf(!TEST_URL)("AIP-04 · ai_model_prices and total_cost_usd", () => {
  let A: string;
  let B: string;
  let u1: string;
  const admin = () => adminPool();

  async function price(provider: string, model: string, from: string, prompt: number, completion: number): Promise<void> {
    await admin().query(
      `INSERT INTO ai_model_prices (provider, model, prompt_usd_per_mtok, completion_usd_per_mtok, effective_from, note) VALUES ($1, $2, $3, $4, $5::date, 'test')`,
      [provider, model, prompt, completion, from],
    );
  }
  async function thread(tenant: string, owner: string): Promise<string> {
    const id = newId();
    await admin().query(
      `INSERT INTO assistant_threads (id, tenant_id, owner_user_id, origin_site) VALUES ($1, $2, $3, 'test')`, [id, tenant, owner],
    );
    return id;
  }
  const threadRow = async (id: string) =>
    (await admin().query<{ cost: string; updated_at: Date }>(`SELECT total_cost_usd::text AS cost, updated_at FROM assistant_threads WHERE id = $1`, [id])).rows[0];
  const usageRow = async (id: string) =>
    (await admin().query(`SELECT cost_usd::text AS cost_usd, cost_source, tokens_source FROM ai_usage_events WHERE id = $1`, [id])).rows[0];

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("AIP04 Company A");
    B = await createCompany("AIP04 Company B");
    u1 = await createUser("aip04-u1@mock.test", "AIP04 One");
  });
  afterAll(async () => { await teardownTestDb(); });

  describe("the table", () => {
    it("has exactly the agreed columns and the primary key (provider, model, effective_from)", async () => {
      const cols = await admin().query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_model_prices' ORDER BY column_name COLLATE "C"`,
      );
      expect(cols.rows.map((r) => r.column_name)).toEqual(["completion_usd_per_mtok", "effective_from", "model", "note", "prompt_usd_per_mtok", "provider"]);
      const pk = await admin().query<{ cols: string }>(
        `SELECT string_agg(a.attname::text, ',' ORDER BY k.ord) AS cols
           FROM pg_index i JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
          WHERE i.indrelid = 'ai_model_prices'::regclass AND i.indisprimary`,
      );
      expect(pk.rows[0].cols).toBe("provider,model,effective_from");
    });

    it("is global reference data: no tenant_id, no row-level security", async () => {
      const c = await admin().query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'ai_model_prices'::regclass`);
      expect(c.rows[0]).toEqual({ relrowsecurity: false, relforcerowsecurity: false });
      const t = await admin().query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_model_prices' AND column_name = 'tenant_id'`);
      expect(t.rows).toHaveLength(0);
    });

    it("refuses a negative price, a label with a space, an over-long note, and a duplicate (provider, model, day)", async () => {
      await expect(price("openai", "neg", "2026-01-01", -1, 1)).rejects.toThrow(/ck_ai_model_prices_prompt/);
      await expect(price("openai", "neg2", "2026-01-01", 1, -1)).rejects.toThrow(/ck_ai_model_prices_completion/);
      await expect(price("open ai", "m", "2026-01-01", 1, 1)).rejects.toThrow(/ck_ai_model_prices_labels/);
      await expect(price("openai", "some model", "2026-01-01", 1, 1)).rejects.toThrow(/ck_ai_model_prices_labels/);
      await expect(
        admin().query(`INSERT INTO ai_model_prices VALUES ('openai', 'longnote', 1, 1, '2026-01-01', $1)`, ["x".repeat(501)]),
      ).rejects.toThrow(/ck_ai_model_prices_note/);
      await price("openai", "dup", "2026-01-01", 1, 1);
      await expect(price("openai", "dup", "2026-01-01", 2, 2)).rejects.toThrow(/duplicate key|ai_model_prices_pkey/);
    });

    it("the app role can read it through withGlobal (no tenant context needed)", async () => {
      await price("openai", "readable", "2026-01-01", 0.1, 0.2);
      const p = await lookupModelPrice("openai", "readable", "2026-10-27");
      expect(p).toEqual({ provider: "openai", model: "readable", promptUsdPerMtok: 0.1, completionUsdPerMtok: 0.2, effectiveFrom: "2026-01-01" });
    });
  });

  describe("the lookup", () => {
    it("the newest row on or before the day wins; before the first row, or another model, is null", async () => {
      await price("openai", "m-look", "2026-01-01", 1, 1);
      await price("openai", "m-look", "2026-06-01", 2, 2);
      await price("openai", "m-look", "2026-11-01", 3, 3);
      expect((await lookupModelPrice("openai", "m-look", "2026-10-27"))?.promptUsdPerMtok).toBe(2);
      expect((await lookupModelPrice("openai", "m-look", "2026-06-01"))?.promptUsdPerMtok).toBe(2);
      expect((await lookupModelPrice("openai", "m-look", "2026-05-31"))?.promptUsdPerMtok).toBe(1);
      expect((await lookupModelPrice("openai", "m-look", "2027-01-01"))?.promptUsdPerMtok).toBe(3);
      expect(await lookupModelPrice("openai", "m-look", "2025-12-31")).toBeNull();
      expect(await lookupModelPrice("openai", "never-priced", "2026-10-27")).toBeNull();
      expect(await lookupModelPrice("ollama", "m-look", "2026-10-27")).toBeNull();
    });
  });

  describe("the writer costs events from the table", () => {
    it("tokens and no cost, a price in force: cost_usd from the table, cost_source 'table'; the stored cost is exact", async () => {
      await price("openai", "m-write", "2026-01-01", 0.5, 2);
      const r = await recordAiUsage({
        tenantId: A, userId: u1, surface: "assistant", capability: "llm", provider: "openai", model: "m-write",
        promptTokens: 1000, completionTokens: 500, tokensSource: "provider", outcome: "ok", occurredAt: "2026-10-27T10:00:00Z",
      });
      expect(r.ok).toBe(true);
      expect(await usageRow((r as { id: string }).id)).toEqual({ cost_usd: "0.00150000", cost_source: "table", tokens_source: "provider" });
    });

    it("the provider's cost beats the table, and keeps its label", async () => {
      const r = await recordAiUsage({
        tenantId: A, surface: "assistant", capability: "llm", provider: "openai", model: "m-write", promptTokens: 1000, completionTokens: 500,
        tokensSource: "provider", costUsd: 0.000123, costSource: "provider", outcome: "ok",
      });
      expect(await usageRow((r as { id: string }).id)).toMatchObject({ cost_usd: "0.00012300", cost_source: "provider" });
    });

    it("no price in force (an earlier day, or an unpriced model) leaves the cost NULL, never 0", async () => {
      const early = await recordAiUsage({
        tenantId: A, surface: "assistant", capability: "llm", provider: "openai", model: "m-write", promptTokens: 1000, completionTokens: 500,
        tokensSource: "provider", outcome: "ok", occurredAt: "2025-06-01T00:00:00Z",
      });
      expect(await usageRow((early as { id: string }).id)).toMatchObject({ cost_usd: null, cost_source: null });
      const unpriced = await recordAiUsage({
        tenantId: A, surface: "assistant", capability: "llm", provider: "openai", model: "unpriced-model", promptTokens: 1, completionTokens: 1, tokensSource: "provider", outcome: "ok",
      });
      expect(await usageRow((unpriced as { id: string }).id)).toMatchObject({ cost_usd: null, cost_source: null });
    });

    it("an event with no token counts is not costed even when a price exists", async () => {
      const r = await recordAiUsage({ tenantId: A, surface: "assistant", capability: "embed", provider: "openai", model: "m-write", tokensSource: "none", outcome: "ok" });
      expect(await usageRow((r as { id: string }).id)).toMatchObject({ cost_usd: null });
    });
  });

  describe("assistant_threads.total_cost_usd follows the usage rows", () => {
    const ev = (over: Record<string, unknown>) => ({
      tenantId: A, userId: u1, surface: "assistant" as const, capability: "llm" as const, provider: "openai", model: "m-write",
      promptTokens: 1000, completionTokens: 500, tokensSource: "provider" as const, outcome: "ok" as const, ...over,
    });

    it("sums provider and table costs of THIS thread's rows, ignores unknown costs, and leaves other threads, other companies and updated_at alone", async () => {
      const t1 = await thread(A, u1);
      const t2 = await thread(A, u1);
      const before = await threadRow(t1);
      await recordAiUsage(ev({ threadId: t1, costUsd: 0.25, costSource: "provider" }));
      await recordAiUsage(ev({ threadId: t1 })); // table: 0.0015
      await recordAiUsage(ev({ threadId: t1, model: "unpriced-model" })); // unknown: contributes nothing
      await recordAiUsage(ev({ threadId: t1, surface: "compaction", costUsd: 0.1, costSource: "provider" }));
      await recordAiUsage(ev({ threadId: t2, costUsd: 9, costSource: "provider" }));
      await recordAiUsage(ev({ tenantId: B, threadId: t1, costUsd: 5, costSource: "provider" })); // B's row, same thread id: never counted for A
      await refreshThreadCost(A, t1);
      const after = await threadRow(t1);
      expect(after.cost).toBe("0.351500");
      expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
      expect((await threadRow(t2)).cost).toBe("0.000000"); // not refreshed
      await refreshThreadCost(A, t2);
      expect((await threadRow(t2)).cost).toBe("9.000000");
    });

    it("a thread with no costed row is left at the default 0 (unknown is not written as a total)", async () => {
      const t = await thread(A, u1);
      await recordAiUsage(ev({ threadId: t, model: "unpriced-model" }));
      await refreshThreadCost(A, t);
      expect((await threadRow(t)).cost).toBe("0.000000");
    });

    it("is idempotent: refreshing twice gives the same total", async () => {
      const t = await thread(A, u1);
      await recordAiUsage(ev({ threadId: t, costUsd: 0.5, costSource: "provider" }));
      await refreshThreadCost(A, t);
      await refreshThreadCost(A, t);
      expect((await threadRow(t)).cost).toBe("0.500000");
    });

    it("never throws for an unknown thread", async () => {
      await expect(refreshThreadCost(A, newId())).resolves.toBeUndefined();
    });

    it("a real reply through relayGeneration fills the thread's total from the provider's own cost", async () => {
      const t = await thread(A, u1);
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(
            `event: meta\ndata: ${JSON.stringify({ provider: "openai", model: "unpriced-model" })}\n\n` +
            `data: ${JSON.stringify("Hello")}\n\n` +
            `event: usage\ndata: ${JSON.stringify({ promptTokens: 120, completionTokens: 30, costUsd: 0.0004, source: "provider" })}\n\n` +
            `event: done\ndata: {}\n\n`,
          ));
          c.close();
        },
      });
      const entry = reserveGeneration(t, newId())!;
      const result = await relayGeneration(entry, {
        tenantId: A, prompt: "hi", gatewayUrl: "http://fake-gateway.test", gatewayToken: "x",
        attribution: { tenantId: A, userId: u1, surface: "assistant", threadId: t, task: "assistant.reply" },
        emit: { token: () => {}, meta: () => {}, usage: () => {}, session: () => {}, done: () => {}, error: () => {} },
        fetchImpl: vi.fn(async () => ({ ok: true, body } as unknown as Response)) as unknown as typeof fetch,
      });
      expect(result).toMatchObject({ outcome: "done", costUsd: 0.0004 });
      await vi.waitFor(async () => expect((await threadRow(t)).cost).toBe("0.000400"), { timeout: 5000 });
      const rows = await withTenants([A], (c) => c.query(`SELECT surface, thread_id, user_id, tokens_source, cost_source, outcome FROM ai_usage_events WHERE thread_id = $1`, [t]));
      expect(rows.rows).toEqual([{ surface: "assistant", thread_id: t, user_id: u1, tokens_source: "provider", cost_source: "provider", outcome: "ok" }]);
    });
  });
});
