// M5-V3-h — migration 202610131900_agency_dsr_visitor_subjects.sql, proven against a REAL Postgres.
//
// TWO PARTS:
//  A. SHAPE, on the per-file database (fully migrated), written as `platform_app_test` (NOSUPERUSER NOBYPASSRLS)
//     through withTenants: a visitor-only and a consent-only request are accepted; a row naming nobody is refused;
//     an executed erase without `collector_forget` is refused, and no other row may carry one; the forget CHECK is
//     NOT VALID; the hash and status formats hold.
//  B. APPLY, on a scratch database built to the pre-migration head and seeded with ledger rows of the OLD shape
//     (including an executed erase that has no collector status, which the append-only ledger can never back-fill):
//     the real file applies, every existing row keeps every value, and the new CHECK did not reject the old row
//     (NOT VALID). NEGATIVE CONTROL: if `dsr_has_subject` was changed since 202610121835, the migration refuses
//     LOUDLY instead of re-declaring it. The file is DDL only (no DML), so applying it as superuser here shows
//     the same thing a NOBYPASSRLS owner would see: RLS cannot change what DDL does.
//
// Needs DATABASE_URL_TEST (a superuser URL to a disposable Postgres): the Linux gate. Skips without it.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, newId } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { dbPrefix, urlWithDb } from "../testing/db-names";
import { createCompany } from "../testing/fixtures";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");
const MIGRATION = "202610131900_agency_dsr_visitor_subjects.sql";
const MIGRATION_SQL = readFileSync(join(MIGRATIONS_DIR, MIGRATION), "utf8");
const H = (c: string) => c.repeat(64); // a well-formed hex hash
const OLD_COLS = "id, tenant_id, request_id, kind, phase, email_hash, phone_hash, approval_id, actor_id, lead_count, submission_count, token_count, out_of_scope_count, suppression_count, origin_site, created_at";

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// A. SHAPE
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!TEST_URL)("M5-V3-h — agency_dsr_requests visitor subjects (as the NOBYPASSRLS app role)", () => {
  let A: string;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("DSR Visitor Subjects A");
  }, 120_000);
  afterAll(teardownTestDb);

  async function row(cols: Record<string, unknown>): Promise<string> {
    const id = newId();
    const r: Record<string, unknown> = {
      id, tenant_id: A, request_id: newId(), kind: "erase", phase: "filed", approval_id: newId(), origin_site: "test", ...cols,
    };
    const names = Object.keys(r);
    await withTenants([A], (c) => c.query(
      `INSERT INTO agency_dsr_requests (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
      names.map((n) => r[n]),
    ));
    return id;
  }

  it("a visitor-only and a consent-only request are accepted (filed rows, no collector status)", async () => {
    await expect(row({ visitor_id_hash: H("a") })).resolves.toBeTruthy();
    await expect(row({ consent_id_hash: H("b"), kind: "find" })).resolves.toBeTruthy();
    await expect(row({ email_hash: H("c"), visitor_id_hash: H("d"), consent_id_hash: H("e") })).resolves.toBeTruthy();
  });

  it("a row naming nobody is refused (dsr_has_subject, now over four hashes)", async () => {
    await expect(row({})).rejects.toThrow(/dsr_has_subject/);
    await expect(row({ phase: "executed", collector_forget: "not_needed" })).rejects.toThrow(/dsr_has_subject/);
  });

  it("an executed erase MUST record collector_forget; no other row may carry one", async () => {
    await expect(row({ visitor_id_hash: H("1"), phase: "executed" })).rejects.toThrow(/dsr_collector_forget_on_erase/);
    await expect(row({ visitor_id_hash: H("1"), phase: "executed", collector_forget: null })).rejects.toThrow(/dsr_collector_forget_on_erase/);
    for (const s of ["not_needed", "delivered", "queued", "not_configured", "id_not_held"]) {
      await expect(row({ visitor_id_hash: H("2"), phase: "executed", collector_forget: s, profile_count: 1, collector_forget_calls: 2 })).resolves.toBeTruthy();
    }
    await expect(row({ visitor_id_hash: H("3"), phase: "filed", collector_forget: "queued" })).rejects.toThrow(/dsr_collector_forget_on_erase/);
    await expect(row({ visitor_id_hash: H("4"), kind: "find", phase: "executed", collector_forget: "delivered" })).rejects.toThrow(/dsr_collector_forget_on_erase/);
    await expect(row({ visitor_id_hash: H("5"), kind: "export", phase: "executed" })).resolves.toBeTruthy();
  });

  it("formats: a hash is 64 lower-case hex; the status is one of five words; counts are non-negative", async () => {
    await expect(row({ visitor_id_hash: "A".repeat(64) })).rejects.toThrow(/check constraint/);
    await expect(row({ consent_id_hash: "abc" })).rejects.toThrow(/check constraint/);
    await expect(row({ visitor_id_hash: H("6"), phase: "executed", collector_forget: "done" })).rejects.toThrow(/check constraint/);
    await expect(row({ visitor_id_hash: H("7"), phase: "executed", collector_forget: "queued", profile_count: -1 })).rejects.toThrow(/check constraint/);
  });

  it("the catalog: the forget CHECK is NOT VALID; the subject CHECK is the four-hash predicate; the ledger is still append-only", async () => {
    const { rows } = await adminPool().query<{ conname: string; convalidated: boolean; def: string }>(
      `SELECT conname, convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'agency_dsr_requests'::regclass AND conname IN ('dsr_has_subject', 'dsr_collector_forget_on_erase') ORDER BY conname`,
    );
    expect(rows.map((r) => [r.conname, r.convalidated])).toEqual([["dsr_collector_forget_on_erase", false], ["dsr_has_subject", true]]);
    expect(rows[1]!.def).toMatch(/visitor_id_hash IS NOT NULL/);
    expect(rows[1]!.def).toMatch(/consent_id_hash IS NOT NULL/);
    const id = await row({ visitor_id_hash: H("8") });
    await expect(withTenants([A], (c) => c.query(`UPDATE agency_dsr_requests SET profile_count = 1 WHERE id = $1`, [id]))).rejects.toThrow(/append-only/);
    const idx = await adminPool().query(`SELECT indexname FROM pg_indexes WHERE tablename = 'agency_dsr_requests' AND indexname IN ('ix_agency_dsr_visitor','ix_agency_dsr_consent') ORDER BY 1`);
    expect(idx.rows.map((r) => r.indexname)).toEqual(["ix_agency_dsr_consent", "ix_agency_dsr_visitor"]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// B. APPLY over rows of the old shape
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!TEST_URL)("M5-V3-h — the migration applied over existing ledger rows", () => {
  const SCRATCH = `${dbPrefix()}_v3h_apply`;
  const maintenance = () => new Pool({ connectionString: TEST_URL, max: 1 });
  const su = () => new Pool({ connectionString: urlWithDb(TEST_URL, SCRATCH), max: 2 });
  const before: Record<string, unknown>[] = [];
  let tenant = "";

  async function dropAll(): Promise<void> {
    const m = maintenance();
    try { await m.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`); } finally { await m.end(); }
  }

  beforeAll(async () => {
    await dropAll();
    const m = maintenance();
    try { await m.query(`CREATE DATABASE ${SCRATCH}`); } finally { await m.end(); }
    const pool = su();
    try {
      // 1. The pre-migration head, by the runner's own rules (readdir + lexicographic sort, one transaction per file).
      const prior = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort().filter((f) => f < MIGRATION);
      for (const file of prior) {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          await c.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
          await c.query("COMMIT");
        } catch (err) {
          await c.query("ROLLBACK").catch(() => {});
          throw new Error(`pre-head migration ${file} failed: ${(err as Error).message}`);
        } finally {
          c.release();
        }
      }
      const pre = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'agency_dsr_requests' AND column_name = 'visitor_id_hash'`);
      expect(pre.rowCount, "the pre-migration head must not have the new columns yet").toBe(0);

      // 2. Ledger rows of the OLD shape, including an executed erase with no collector status.
      tenant = newId();
      await pool.query(`INSERT INTO companies (id, name, origin_site) VALUES ($1, 'V3H Apply', 'test')`, [tenant]);
      const approval = newId();
      const request = newId();
      await pool.query(
        `INSERT INTO agency_dsr_requests (id, tenant_id, request_id, kind, phase, email_hash, phone_hash, approval_id, origin_site)
         VALUES ($1, $2, $3, 'erase', 'filed', $4, NULL, $5, 'test'),
                ($6, $2, $3, 'erase', 'executed', $4, NULL, $5, 'test')`,
        [newId(), tenant, request, H("e"), approval, newId()],
      );
      await pool.query(
        `INSERT INTO agency_dsr_requests (id, tenant_id, request_id, kind, phase, email_hash, phone_hash, approval_id,
                                          lead_count, submission_count, token_count, suppression_count, origin_site)
         VALUES ($1, $2, $3, 'erase', 'executed', NULL, $4, $5, 3, 1, 1, 2, 'test')`,
        [newId(), tenant, newId(), H("f"), newId()],
      );
      before.push(...(await pool.query(`SELECT row_to_json(x)::jsonb AS r FROM (SELECT ${OLD_COLS} FROM agency_dsr_requests ORDER BY id) x`)).rows.map((r) => r.r));
      expect(before).toHaveLength(3);
    } finally {
      await pool.end();
    }
  }, 600_000);

  afterAll(dropAll, 60_000);

  it("NEGATIVE CONTROL: a dsr_has_subject that changed since 202610121835 makes the migration refuse, and nothing is applied", async () => {
    const pool = su();
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`ALTER TABLE agency_dsr_requests DROP CONSTRAINT dsr_has_subject,
                       ADD CONSTRAINT dsr_has_subject CHECK (email_hash IS NOT NULL OR phone_hash IS NOT NULL OR approval_id IS NOT NULL)`);
      await expect(c.query(MIGRATION_SQL)).rejects.toThrow(/dsr_has_subject is not the two-hash predicate/);
      await c.query("ROLLBACK");
    } finally {
      c.release();
      await pool.end();
    }
    const check = su();
    try {
      const r = await check.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'agency_dsr_requests' AND column_name = 'visitor_id_hash'`);
      expect(r.rowCount).toBe(0);
    } finally {
      await check.end();
    }
  }, 120_000);

  it("the real migration applies over the old rows; every existing value is untouched; the old executed erase is kept (NOT VALID)", async () => {
    const pool = su();
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(MIGRATION_SQL);
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      c.release();
    }
    try {
      const after = (await pool.query(`SELECT row_to_json(x)::jsonb AS r FROM (SELECT ${OLD_COLS} FROM agency_dsr_requests ORDER BY id) x`)).rows.map((r) => r.r);
      expect(after).toEqual(before);
      const added = await pool.query(
        `SELECT visitor_id_hash, consent_id_hash, profile_count, profile_event_count, tombstone_count, collector_forget,
                collector_forget_calls, collector_deleted_events FROM agency_dsr_requests`,
      );
      for (const r of added.rows) {
        expect(r).toEqual({
          visitor_id_hash: null, consent_id_hash: null, profile_count: 0, profile_event_count: 0, tombstone_count: 0,
          collector_forget: null, collector_forget_calls: 0, collector_deleted_events: 0,
        });
      }
      // The old executed erase (collector_forget NULL) stays; the constraint is NOT VALID; a NEW such row is refused.
      const v = await pool.query(`SELECT convalidated FROM pg_constraint WHERE conname = 'dsr_collector_forget_on_erase'`);
      expect(v.rows[0].convalidated).toBe(false);
      await expect(pool.query(
        `INSERT INTO agency_dsr_requests (id, tenant_id, request_id, kind, phase, email_hash, approval_id, origin_site)
         VALUES ($1, $2, $3, 'erase', 'executed', $4, $5, 'test')`,
        [newId(), tenant, newId(), H("9"), newId()],
      )).rejects.toThrow(/dsr_collector_forget_on_erase/);
    } finally {
      await pool.end();
    }
  }, 120_000);
});
