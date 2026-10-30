// AIP-15a — migration 202610300300_ai_usage_unit_node.sql against LIVE Postgres. Needs DATABASE_URL_TEST; it SKIPS without one, and a skip
// is not a pass. initTestDb() hands us a fully migrated database and repoints the app at a NOSUPERUSER NOBYPASSRLS role, so RLS is really
// exercised through withTenants. Seeding and "what is really stored" go through the superuser pool, which bypasses RLS but never a CHECK
// or a trigger.
//
// Proves: the column (nullable text, no default), its CHECK (NULL, or 1 to 120 characters), its index; IMMUTABILITY through the existing
// append-only trigger (an UPDATE that sets, changes or clears unit_node_id is refused; clearing user_id still passes and keeps
// unit_node_id; erasure keeps it); the daily view is still security_invoker, unit_node_id is its LAST column, the earlier columns are
// unchanged, and it groups by the node; RLS still holds for the view and the new column; and the file re-applies cleanly.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newId, withTenants } from "../../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { createCompany, createUser } from "../../testing/fixtures";
import { eraseAiUsageForUser, recordAiUsage } from "./writer";

const MIGRATION = "202610300300_ai_usage_unit_node.sql";

describe.skipIf(!TEST_URL)("AIP-15a · ai_usage_events.unit_node_id (202610300300)", () => {
  let A: string;
  let B: string;
  let u1: string;
  const admin = () => adminPool();

  /** One row through the superuser pool (bypasses RLS, not CHECKs or triggers). */
  async function put(over: Record<string, unknown> & { tenant_id: string }): Promise<string> {
    const row: Record<string, unknown> = { surface: "assistant", capability: "chat", tokens_source: "provider", outcome: "ok", ...over };
    const cols = Object.keys(row);
    const id = newId();
    await admin().query(
      `INSERT INTO ai_usage_events (id, ${cols.join(", ")}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")})`,
      [id, ...cols.map((c) => row[c])],
    );
    return id;
  }

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("AIP15a Company A");
    B = await createCompany("AIP15a Company B");
    u1 = await createUser("aip15a-u1@mock.test", "AIP15a One");
  });
  afterAll(async () => { await teardownTestDb(); });

  describe("the column, its CHECK and its index", () => {
    it("is a nullable text column with no default", async () => {
      const r = await admin().query(
        `SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'ai_usage_events' AND column_name = 'unit_node_id'`,
      );
      expect(r.rows).toEqual([{ data_type: "text", is_nullable: "YES", column_default: null }]);
    });

    it("stores NULL, a 1-character and a 120-character node id; refuses an empty string and 121 characters", async () => {
      for (const v of [null, "d", "d-webdev", "x".repeat(120)]) {
        const id = await put({ tenant_id: A, unit_node_id: v });
        expect((await admin().query(`SELECT unit_node_id FROM ai_usage_events WHERE id = $1`, [id])).rows[0].unit_node_id).toBe(v);
      }
      await expect(put({ tenant_id: A, unit_node_id: "" })).rejects.toThrow(/ck_ai_usage_events_unit_node_id/);
      await expect(put({ tenant_id: A, unit_node_id: "x".repeat(121) })).rejects.toThrow(/ck_ai_usage_events_unit_node_id/);
    });

    it("has the (tenant_id, unit_node_id, occurred_at) index", async () => {
      const r = await admin().query(`SELECT indexdef FROM pg_indexes WHERE tablename = 'ai_usage_events' AND indexname = 'ix_ai_usage_events_unit_node_day'`);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].indexdef).toContain("(tenant_id, unit_node_id, occurred_at)");
    });
  });

  describe("immutable through the append-only trigger (nothing in 202610300300 touches it)", () => {
    it("refuses an UPDATE that SETS unit_node_id on a row that had none", async () => {
      const id = await put({ tenant_id: A, user_id: u1 });
      await expect(admin().query(`UPDATE ai_usage_events SET unit_node_id = 'd-web' WHERE id = $1`, [id])).rejects.toThrow(/append-only/);
      expect((await admin().query(`SELECT unit_node_id FROM ai_usage_events WHERE id = $1`, [id])).rows[0].unit_node_id).toBeNull();
    });

    it("refuses an UPDATE that CHANGES or CLEARS unit_node_id", async () => {
      const id = await put({ tenant_id: A, user_id: u1, unit_node_id: "d-web" });
      await expect(admin().query(`UPDATE ai_usage_events SET unit_node_id = 'd-seo' WHERE id = $1`, [id])).rejects.toThrow(/append-only/);
      await expect(admin().query(`UPDATE ai_usage_events SET unit_node_id = NULL WHERE id = $1`, [id])).rejects.toThrow(/append-only/);
      expect((await admin().query(`SELECT unit_node_id FROM ai_usage_events WHERE id = $1`, [id])).rows[0].unit_node_id).toBe("d-web");
    });

    it("clearing user_id still passes, and keeps unit_node_id (a department is not personal data)", async () => {
      const id = await put({ tenant_id: A, user_id: u1, unit_node_id: "d-web" });
      await admin().query(`UPDATE ai_usage_events SET user_id = NULL WHERE id = $1`, [id]);
      expect((await admin().query(`SELECT user_id, unit_node_id FROM ai_usage_events WHERE id = $1`, [id])).rows[0]).toEqual({ user_id: null, unit_node_id: "d-web" });
    });

    it("erasure (ai_usage_erase_user) clears the person and keeps the node", async () => {
      const gone = await createUser(`aip15a-erase-${newId().slice(-8)}@mock.test`, "Erase Me");
      const id = await put({ tenant_id: A, user_id: gone, unit_node_id: "d-hr" });
      expect(await eraseAiUsageForUser(gone)).toBeGreaterThanOrEqual(1);
      expect((await admin().query(`SELECT user_id, unit_node_id FROM ai_usage_events WHERE id = $1`, [id])).rows[0]).toEqual({ user_id: null, unit_node_id: "d-hr" });
    });

    it("a DELETE is still refused", async () => {
      const id = await put({ tenant_id: A, unit_node_id: "d-web" });
      await expect(admin().query(`DELETE FROM ai_usage_events WHERE id = $1`, [id])).rejects.toThrow(/append-only/);
    });
  });

  describe("ai_usage_daily", () => {
    it("is still security_invoker, keeps its first twelve columns in order, and unit_node_id is the LAST", async () => {
      const opt = await admin().query(`SELECT reloptions FROM pg_class WHERE oid = 'ai_usage_daily'::regclass`);
      expect(opt.rows[0].reloptions).toContain("security_invoker=true");
      const cols = await admin().query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_usage_daily' ORDER BY ordinal_position`);
      expect(cols.rows.map((r) => r.column_name)).toEqual([
        "tenant_id", "day", "org_unit_id", "user_id", "surface", "provider", "model", "calls", "prompt_tokens", "completion_tokens", "cost_usd",
        "estimated_calls", "unit_node_id",
      ]);
    });

    it("groups by the node: two nodes of one person on one day are two lines; unknown cost stays NULL", async () => {
      const m = "aip15a-view-model";
      await put({ tenant_id: A, user_id: u1, model: m, occurred_at: "2026-04-01T10:00:00Z", unit_node_id: "d-web", prompt_tokens: 10, completion_tokens: 5, cost_usd: "0.01", cost_source: "provider" });
      await put({ tenant_id: A, user_id: u1, model: m, occurred_at: "2026-04-01T11:00:00Z", unit_node_id: "d-web", prompt_tokens: 1, completion_tokens: 1 });
      await put({ tenant_id: A, user_id: u1, model: m, occurred_at: "2026-04-01T12:00:00Z", unit_node_id: "d-seo", prompt_tokens: 2, completion_tokens: 2 });
      const r = await withTenants([A], (c) =>
        c.query(`SELECT unit_node_id, calls::int AS calls, prompt_tokens::int AS p, cost_usd::text AS cost FROM ai_usage_daily WHERE model = $1 ORDER BY unit_node_id`, [m]),
      );
      expect(r.rows).toEqual([
        { unit_node_id: "d-seo", calls: 1, p: 2, cost: null },
        { unit_node_id: "d-web", calls: 2, p: 11, cost: "0.01000000" },
      ]);
    });

    it("RLS still applies to the reader: company B reads none of A's lines, and no tenant context reads none", async () => {
      const m = "aip15a-rls-model";
      await put({ tenant_id: A, user_id: u1, model: m, unit_node_id: "d-web" });
      expect((await withTenants([A], (c) => c.query(`SELECT 1 FROM ai_usage_daily WHERE model = $1`, [m]))).rows).toHaveLength(1);
      expect((await withTenants([B], (c) => c.query(`SELECT 1 FROM ai_usage_daily WHERE model = $1`, [m]))).rows).toHaveLength(0);
      expect((await withTenants([B], (c) => c.query(`SELECT 1 FROM ai_usage_events WHERE model = $1 AND unit_node_id = 'd-web'`, [m]))).rows).toHaveLength(0);
    });
  });

  it("the writer stores unitNodeId end to end", async () => {
    const r = await recordAiUsage({ tenantId: A, userId: u1, unitNodeId: "d-ops", surface: "assistant", capability: "chat", tokensSource: "none", outcome: "ok", model: "aip15a-writer" });
    expect(r.ok).toBe(true);
    const row = (await admin().query(`SELECT unit_node_id, org_unit_id FROM ai_usage_events WHERE model = 'aip15a-writer'`)).rows;
    expect(row).toEqual([{ unit_node_id: "d-ops", org_unit_id: null }]);
  });

  it("re-applies cleanly with the self-check passing (every statement is guarded)", async () => {
    const file = readFileSync(join(__dirname, "..", "..", "..", "migrations", MIGRATION), "utf8");
    await admin().query(file);
    await admin().query(file);
    const cols = await admin().query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'ai_usage_events' AND column_name = 'unit_node_id'`);
    expect(cols.rows[0].n).toBe(1);
    const ck = await admin().query(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'ck_ai_usage_events_unit_node_id'`);
    expect(ck.rows[0].n).toBe(1);
  });
});
