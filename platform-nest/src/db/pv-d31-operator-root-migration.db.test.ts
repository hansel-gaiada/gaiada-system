// PV-D31 (D21) — migration 202610132137_pv_d31_operator_root.sql: the operator-root marker.
//
// `initTestDb()` already applied the file once, against an EMPTY schema (zero roots, so it marked
// nothing — that is the "fresh database" path). Each case below manufactures an estate shape and
// re-runs the file's REAL text inside a transaction the case controls, exactly as the runner would.
//
// HOW THIS FILE BITES:
//   * drop the "exactly one root" guard (mark every root)       -> "two roots RAISE" fails;
//   * mark with an unordered LIMIT 1 instead of raising         -> "two roots RAISE" fails;
//   * delete the assertion DO block                             -> "the assertion bites" fails;
//   * drop the partial unique index or the root-only CHECK      -> the constraint cases fail.
//
// Uses `adminPool()` (the owner connection) because re-running DDL needs it; the app role cannot.
// Needs DATABASE_URL_TEST — skips silently otherwise.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PoolClient } from "pg";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany } from "../testing/fixtures";

const MIGRATION_SQL = readFileSync(
  join(__dirname, "..", "..", "migrations", "202610132137_pv_d31_operator_root.sql"),
  "utf8",
);
// The final assertion DO block on its own, so it can be shown to bite independently of the marking
// block (which would otherwise RAISE first on most bad shapes).
const ASSERT_MARKER = "-- Assert the result";
const ASSERTION_SQL = MIGRATION_SQL.slice(MIGRATION_SQL.indexOf(ASSERT_MARKER));

// Run `fn` in a transaction that is ALWAYS rolled back, so each case leaves the estate as it found it.
async function inRolledBackTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await adminPool().connect();
  try {
    await c.query("BEGIN");
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    c.release();
  }
}

async function errorOf(c: PoolClient, sql: string): Promise<string | null> {
  await c.query("SAVEPOINT probe");
  try {
    await c.query(sql);
    await c.query("RELEASE SAVEPOINT probe");
    return null;
  } catch (e) {
    await c.query("ROLLBACK TO SAVEPOINT probe");
    return String((e as Error).message);
  }
}

const markedIds = async (c: PoolClient) =>
  (await c.query<{ id: string }>(`SELECT id FROM companies WHERE is_operator_root ORDER BY id`)).rows.map((r) => r.id);

describe.skipIf(!TEST_URL)("PV-D31 · operator-root marker migration", () => {
  let rootA: string;
  let childA: string;
  let rootB: string;

  beforeAll(async () => {
    await initTestDb();
    rootA = await createCompany("PVD31 Holding A");
    childA = await createCompany("PVD31 Child A", [], rootA);
    rootB = await createCompany("PVD31 Customer B");
  }, 180_000);
  afterAll(teardownTestDb);

  it("the first application (empty schema at initTestDb) marked nothing, and the column defaults false", async () => {
    const { rows } = await adminPool().query<{ n: string }>(`SELECT count(*)::text n FROM companies WHERE is_operator_root`);
    expect(Number(rows[0].n)).toBe(0);
    const ledger = await adminPool().query(`SELECT 1 FROM schema_migrations WHERE name = '202610132137_pv_d31_operator_root.sql'`);
    expect(ledger.rowCount).toBe(1);
  });

  it("with exactly ONE live root, it marks that root and nothing else", async () => {
    await inRolledBackTx(async (c) => {
      // Take B out of the picture: a soft-deleted root does not count.
      await c.query(`UPDATE companies SET deleted_at = now() WHERE id = $1`, [rootB]);
      expect(await errorOf(c, MIGRATION_SQL)).toBeNull();
      expect(await markedIds(c)).toEqual([rootA]);
      expect((await c.query(`SELECT is_operator_root FROM companies WHERE id = $1`, [childA])).rows[0].is_operator_root).toBe(false);
    });
  });

  it("with TWO live roots, it RAISES and marks nothing (a human must decide)", async () => {
    await inRolledBackTx(async (c) => {
      const err = await errorOf(c, MIGRATION_SQL);
      expect(err).toMatch(/2 root companies exist/);
      expect(await markedIds(c)).toEqual([]);
    });
  });

  it("in a multi-root estate where a human PRE-MARKED the operator root, it keeps that choice", async () => {
    await inRolledBackTx(async (c) => {
      await c.query(`UPDATE companies SET is_operator_root = true WHERE id = $1`, [rootB]);
      expect(await errorOf(c, MIGRATION_SQL)).toBeNull();
      expect(await markedIds(c)).toEqual([rootB]);
    });
  });

  it("with ZERO live roots it is a no-op that passes", async () => {
    await inRolledBackTx(async (c) => {
      await c.query(`UPDATE companies SET deleted_at = now() WHERE deleted_at IS NULL`);
      expect(await errorOf(c, MIGRATION_SQL)).toBeNull();
      expect(await markedIds(c)).toEqual([]);
    });
  });

  it("the DO-block assertion bites on its own: roots exist but none is marked", async () => {
    await inRolledBackTx(async (c) => {
      expect(ASSERTION_SQL.length).toBeGreaterThan(0);
      expect(ASSERTION_SQL).toContain("PV-D31 assertion");
      const err = await errorOf(c, ASSERTION_SQL);
      expect(err).toMatch(/PV-D31 assertion: 2 root\(s\) exist but 0 operator root\(s\) are marked/);
      // And it passes once exactly one root is marked.
      await c.query(`UPDATE companies SET is_operator_root = true WHERE id = $1`, [rootA]);
      expect(await errorOf(c, ASSERTION_SQL)).toBeNull();
    });
  });

  it("the schema refuses a SECOND live operator root (partial unique index)", async () => {
    await inRolledBackTx(async (c) => {
      await c.query(`UPDATE companies SET is_operator_root = true WHERE id = $1`, [rootA]);
      const err = await errorOf(c, `UPDATE companies SET is_operator_root = true WHERE id = '${rootB}'`);
      expect(err).toMatch(/ux_companies_one_operator_root/);
    });
  });

  it("the schema refuses marking a NON-root company (CHECK companies_operator_root_is_root)", async () => {
    await inRolledBackTx(async (c) => {
      const err = await errorOf(c, `UPDATE companies SET is_operator_root = true WHERE id = '${childA}'`);
      expect(err).toMatch(/companies_operator_root_is_root/);
    });
  });
});
