// PV5-06 (the CONTRACT half of PV5-01b) — migration 202610131820_pv5_enforce_contract_content_fixed.sql, against a
// REAL Postgres.
//
// The enforcing CHECK (a sent contract carries its hash, stamp and tier) and the LEGACY exemption: a flag only the
// migration may set. Everything runs as the NOSUPERUSER NOBYPASSRLS app role except `adminPool()` (superuser), which
// is used to (1) simulate rows that pre-date the migration by disabling the guard trigger, which no application role
// can do, and (2) re-run the migration's own backfill block.
// Needs DATABASE_URL_TEST: the Linux gate. Skips without it.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PoolClient } from "pg";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, newId } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createClient } from "../testing/fixtures";

const MIGRATION = path.resolve(__dirname, "../../migrations/202610131820_pv5_enforce_contract_content_fixed.sql");

describe.skipIf(!TEST_URL)("PV5-06 — contracts_content_fixed_when_sent and the legacy exemption", () => {
  let A: string;
  let client: string;
  let seq = 0;
  const HASH = "c".repeat(64);

  const insert = async (c: PoolClient, table: string, row: Record<string, unknown>) => {
    const names = Object.keys(row);
    await c.query(
      `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
      names.map((n) => row[n]),
    );
  };
  const contract = (cols: Record<string, unknown> = {}) => {
    const id = newId();
    return withTenants([A], (c) =>
      insert(c, "contracts", { id, tenant_id: A, client_id: client, title: `C ${++seq}`, origin_site: "test", ...cols }),
    ).then(() => id);
  };
  const update = (id: string, set: string, params: unknown[] = []) =>
    withTenants([A], (c) => c.query(`UPDATE contracts SET ${set} WHERE id = $1`, [id, ...params]));

  /** Run `fn` as superuser with the legacy guard trigger off, so a row can be born flagged (a pre-PV-5 row). */
  async function asLegacy<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await adminPool().connect();
    try {
      await c.query("ALTER TABLE contracts DISABLE TRIGGER trg_contracts_pv5_legacy_guard");
      try {
        return await fn(c);
      } finally {
        await c.query("ALTER TABLE contracts ENABLE TRIGGER trg_contracts_pv5_legacy_guard");
      }
    } finally {
      c.release();
    }
  }

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("PV5-06 Tenant A");
    client = await createClient(A, "PV5-06 Client A");
  }, 120_000);
  afterAll(teardownTestDb);

  describe("the migration's own backfill block", () => {
    it("flags exactly the sent non-draft contracts, sets tier attested, and the CHECK then validates", async () => {
      const sql = readFileSync(MIGRATION, "utf8");
      const from = sql.indexOf("DO $$", sql.indexOf("-- ── backfill, per company"));
      const to = sql.indexOf("-- ── the guard");
      expect(from).toBeGreaterThan(0);
      expect(to).toBeGreaterThan(from);
      const backfill = sql.slice(from, to);

      const c = await adminPool().connect();
      const notices: string[] = [];
      c.on("notice", (n) => notices.push(n.message ?? ""));
      const ids: Record<string, string> = {};
      try {
        await c.query("BEGIN");
        await c.query("ALTER TABLE contracts DROP CONSTRAINT contracts_content_fixed_when_sent");
        const con = async (key: string, status: string, sentAt: Date | null) => {
          ids[key] = newId();
          await insert(c, "contracts", { id: ids[key], tenant_id: A, client_id: client, title: key, status, sent_at: sentAt, origin_site: "test" });
        };
        await con("kDraft", "draft", null); await con("kSent", "sent", new Date()); await con("kSigned", "signed", new Date());
        await con("kVoidNeverSent", "void", null); await con("kVoidSent", "void", new Date());
        // contracts has DEFERRABLE FKs: flush their pending checks, or the ALTER below refuses to run.
        await c.query("SET CONSTRAINTS ALL IMMEDIATE");
        // The backfill's UPDATE must run while the guard is off, exactly as in the migration (guard created after).
        await c.query("ALTER TABLE contracts DISABLE TRIGGER trg_contracts_pv5_legacy_guard");

        await c.query(backfill);

        const cons = await c.query<{ id: string; legacy: boolean; tier: string | null }>(
          "SELECT id, pre_pv5_legacy AS legacy, signature_tier AS tier FROM contracts WHERE id = ANY($1::uuid[])",
          [[ids.kDraft, ids.kSent, ids.kSigned, ids.kVoidNeverSent, ids.kVoidSent]],
        );
        const k = Object.fromEntries(cons.rows.map((r) => [r.id, [r.legacy, r.tier]]));
        expect([k[ids.kDraft], k[ids.kSent], k[ids.kSigned], k[ids.kVoidNeverSent], k[ids.kVoidSent]]).toEqual([
          [false, null], [true, "attested"], [true, "attested"], [false, null], [true, "attested"],
        ]);
        // The notice totals every company in the test database; ours contribute exactly 3 (sent, signed, void-after-send).
        const notice = notices.find((m) => m.includes("legacy non-draft contracts marked attested and exempted"));
        expect(notice).toBeDefined();
        expect(Number(/exempted: (\d+) row/.exec(notice ?? "")?.[1])).toBeGreaterThanOrEqual(3);

        // The decisive step: the CHECK validates against every row the backfill left behind.
        await c.query(
          `ALTER TABLE contracts ADD CONSTRAINT contracts_content_fixed_when_sent CHECK (
             status = 'draft' OR (status = 'void' AND sent_at IS NULL) OR pre_pv5_legacy
             OR (content_sha256 IS NOT NULL AND content_fixed_at IS NOT NULL AND signature_tier IS NOT NULL))`,
        );
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
        c.release();
      }
      // The rollback left the real constraint and trigger in place.
      const left = await adminPool().query(
        "SELECT conname FROM pg_constraint WHERE conname = 'contracts_content_fixed_when_sent' AND convalidated",
      );
      expect(left.rowCount).toBe(1);
      const trg = await adminPool().query("SELECT tgname FROM pg_trigger WHERE tgname = 'trg_contracts_pv5_legacy_guard' AND tgenabled = 'O'");
      expect(trg.rowCount).toBe(1);
    });
  });

  describe("a sent contract carries its hash, stamp and tier", () => {
    it("send without them fails; with them succeeds; never-sent void and draft are unaffected", async () => {
      await expect(contract({ status: "sent", sent_at: new Date() })).rejects.toThrow(/contracts_content_fixed_when_sent/);
      await expect(contract({ status: "signed", sent_at: new Date(), signed_at: new Date() })).rejects.toThrow(/contracts_content_fixed_when_sent/);
      // A hash with no stamp or tier trips the stamp CHECK (01a) or this one; either way it is refused.
      await expect(contract({ status: "sent", sent_at: new Date(), content_sha256: HASH, content_fixed_at: new Date() })).rejects.toThrow(/contracts_content_fixed_when_sent/);
      await expect(contract({ status: "sent", sent_at: new Date(), content_sha256: HASH, content_fixed_at: new Date(), signature_tier: "attested" })).resolves.toBeTruthy();
      await expect(contract({ status: "draft" })).resolves.toBeTruthy();
      await expect(contract({ status: "void" })).resolves.toBeTruthy(); // cancelled before it was ever sent
      // The pre-PV5-06 controller's send UPDATE (status + sent_at only) is exactly what this refuses.
      const d = await contract({ status: "draft" });
      await expect(update(d, "status = 'sent', sent_at = now()")).rejects.toThrow(/contracts_content_fixed_when_sent/);
      await expect(update(d, "status = 'sent', sent_at = now(), content_sha256 = $2, content_fixed_at = now(), signature_tier = 'certified'", [HASH])).resolves.toBeDefined();
      // A sent contract can still be voided (hash already there).
      await expect(update(d, "status = 'void'")).resolves.toBeDefined();
    });
  });

  describe("the legacy exemption cannot be reached by new rows", () => {
    it("no INSERT may carry pre_pv5_legacy = true, however the row is shaped", async () => {
      await expect(contract({ status: "sent", sent_at: new Date(), pre_pv5_legacy: true })).rejects.toThrow(/PV5_LEGACY_FLAG/);
      await expect(contract({ status: "draft", pre_pv5_legacy: true })).rejects.toThrow(/PV5_LEGACY_FLAG/);
    });

    it("no UPDATE may set it, on a row that would then escape the CHECK", async () => {
      const d = await contract({ status: "draft" });
      await expect(update(d, "status = 'sent', sent_at = now(), pre_pv5_legacy = true")).rejects.toThrow(/PV5_LEGACY_FLAG/);
      await expect(update(d, "pre_pv5_legacy = true")).rejects.toThrow(/PV5_LEGACY_FLAG/);
    });

    it("backdating created_at does not buy an exemption (the exemption is not a date bound)", async () => {
      await expect(contract({ status: "sent", sent_at: new Date(), created_at: "2020-01-01" })).rejects.toThrow(/contracts_content_fixed_when_sent/);
    });
  });

  describe("legacy rows keep working, and stay exempt only themselves", () => {
    it("a legacy sent contract (attested, no hash) can be countersigned; its flag cannot be cleared", async () => {
      const id = newId();
      await asLegacy((c) =>
        insert(c, "contracts", { id, tenant_id: A, client_id: client, title: "legacy", status: "sent", sent_at: new Date(), signature_tier: "attested", origin_site: "test", pre_pv5_legacy: true }),
      );
      await expect(update(id, "status = 'signed', signed_at = now()")).resolves.toBeDefined();
      await expect(update(id, "pre_pv5_legacy = false")).rejects.toThrow(/PV5_LEGACY_FLAG/);
      // A legacy DRAFT contract is not exempt: sending it needs the hash.
      const d = await contract({ status: "draft" });
      await expect(update(d, "status = 'sent', sent_at = now()")).rejects.toThrow(/contracts_content_fixed_when_sent/);
    });
  });
});
