// M6-P6h — migration 202610132320: `webdev_site_builds.kind` gains 'promote', rebuilt from the LIVE definition.
// Needs DATABASE_URL_TEST (the Linux gate); skips without it. Fixtures are inserted as superuser (`adminPool`): this suite is
// about the constraint, and a superuser is what lets a rolled-back transaction put the OLD constraint back to re-run the file.
//
// WHAT THIS SUITE IS TRYING TO FALSIFY:
//   1. the standing test: every earlier value (publish, rebuild) still passes, promote passes, junk and NULL fail;
//   2. exactly one kind CHECK exists afterwards, it keeps its live name, and its list is exactly the earlier two plus promote;
//   3. the migration rebuilds from the LIVE definition: run against the pre-widening CHECK with rows of each earlier kind, it
//      takes them all and touches none; a value a hypothetical later migration added survives; a re-run is a no-op;
//   4. a live CHECK that has drifted away from what the code needs (no 'rebuild') is REFUSED, not widened.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PoolClient } from "pg";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany } from "../../testing/fixtures";
import { newId } from "../../db";

const MIGRATION = path.resolve(__dirname, "../../../migrations/202610132320_webdev_site_builds_kind_promote.sql");
const EARLIER = ["publish", "rebuild"] as const;

const live = Boolean(TEST_URL);

describe.skipIf(!live)("M6-P6h — webdev_site_builds kind CHECK widening (promote)", () => {
  let A: string;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("P6h Kind Co", ["webdev"]);
  });
  afterAll(teardownTestDb);

  const insertBuild = (c: Pick<PoolClient, "query">, kind: string | null) =>
    c.query(
      `INSERT INTO webdev_site_builds (id, tenant_id, tenant_slug, site_id, approval_id, kind, state, failure_reason)
       VALUES ($1, $2, 'p6h-kind', $3, $4, $5, 'failed', 'rebuild_not_configured')`,
      [newId(), A, newId(), newId(), kind],
    );

  const kindChecks = async (c: Pick<PoolClient, "query">): Promise<Array<{ conname: string; def: string }>> =>
    (await c.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'webdev_site_builds'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ~* '\\mkind\\M'`,
    )).rows;

  /** Run `fn` on a connection inside a transaction that is ALWAYS rolled back: the schema under test is never left changed. */
  async function inRolledBackTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await adminPool().connect();
    try {
      await c.query("BEGIN");
      return await fn(c);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  }

  it("STANDING TEST: every earlier value still passes, promote passes, junk and NULL fail", async () => {
    for (const v of EARLIER) await expect(insertBuild(adminPool(), v), v).resolves.toBeTruthy();
    await expect(insertBuild(adminPool(), "promote")).resolves.toBeTruthy();
    for (const junk of ["PROMOTE", "promote ", "deploy", "production", ""]) {
      await expect(insertBuild(adminPool(), junk), JSON.stringify(junk)).rejects.toMatchObject({ code: "23514" });
    }
    await expect(insertBuild(adminPool(), null)).rejects.toMatchObject({ code: "23502" }); // the column stays NOT NULL
  });

  it("exactly one kind CHECK exists, and its list is the earlier two plus promote, nothing more", async () => {
    const rows = await kindChecks(adminPool());
    expect(rows).toHaveLength(1);
    const lits = [...rows[0].def.matchAll(/'([^']*)'/g)].map((m) => m[1]).sort();
    expect(lits).toEqual([...EARLIER, "promote"].sort());
  });

  it("the other CHECKs hold for a promote row as for a staging build: live needs verified_at, failed needs a reason", async () => {
    await inRolledBackTx(async (c) => {
      await c.query("SAVEPOINT s");
      await expect(
        c.query(
          `INSERT INTO webdev_site_builds (id, tenant_id, tenant_slug, site_id, approval_id, kind, state, dispatched_at)
           VALUES ($1, $2, 'p6h-kind', $3, $4, 'promote', 'live', now())`,
          [newId(), A, newId(), newId()],
        ),
      ).rejects.toMatchObject({ code: "23514" }); // wsb_live_is_verified
      await c.query("ROLLBACK TO SAVEPOINT s");
      await expect(
        c.query(
          `INSERT INTO webdev_site_builds (id, tenant_id, tenant_slug, site_id, approval_id, kind, state)
           VALUES ($1, $2, 'p6h-kind', $3, $4, 'promote', 'failed')`,
          [newId(), A, newId(), newId()],
        ),
      ).rejects.toMatchObject({ code: "23514" }); // wsb_failed_has_reason
      await c.query("ROLLBACK TO SAVEPOINT s");
      // One row per approval, whatever the kind.
      const approval = newId();
      await c.query(
        `INSERT INTO webdev_site_builds (id, tenant_id, tenant_slug, site_id, approval_id, kind, state, failure_reason)
         VALUES ($1, $2, 'p6h-kind', $3, $4, 'promote', 'failed', 'production_secret_not_granted')`,
        [newId(), A, newId(), approval],
      );
      await expect(
        c.query(
          `INSERT INTO webdev_site_builds (id, tenant_id, tenant_slug, site_id, approval_id, kind, state, failure_reason)
           VALUES ($1, $2, 'p6h-kind', $3, $4, 'publish', 'failed', 'rebuild_not_configured')`,
          [newId(), A, newId(), approval],
        ),
      ).rejects.toMatchObject({ code: "23505" }); // ux_wsb_tenant_approval
    });
  });

  it("rebuilds from the LIVE definition: a database still on the two-value CHECK, with rows of each kind, takes the migration", async () => {
    await inRolledBackTx(async (c) => {
      const [{ conname }] = await kindChecks(c);
      await c.query(`DELETE FROM webdev_site_builds WHERE kind = 'promote'`); // the old CHECK must validate
      await c.query(`ALTER TABLE webdev_site_builds DROP CONSTRAINT ${conname}`);
      await c.query(`ALTER TABLE webdev_site_builds ADD CONSTRAINT ${conname} CHECK (kind IN ('publish', 'rebuild'))`);
      await c.query("SAVEPOINT s");
      await expect(insertBuild(c, "promote")).rejects.toMatchObject({ code: "23514" }); // the old constraint really refuses it
      await c.query("ROLLBACK TO SAVEPOINT s");
      for (const v of EARLIER) await insertBuild(c, v);
      const before = await c.query(`SELECT count(*)::int AS n FROM webdev_site_builds WHERE tenant_slug = 'p6h-kind'`);

      await c.query(readFileSync(MIGRATION, "utf8"));
      const after = await kindChecks(c);
      expect(after).toHaveLength(1);
      expect(after[0].conname).toBe(conname); // keeps its live name
      for (const v of [...EARLIER, "promote"]) expect(after[0].def, v).toContain(`'${v}'`);
      await insertBuild(c, "promote");
      const kept = await c.query(`SELECT count(*)::int AS n FROM webdev_site_builds WHERE tenant_slug = 'p6h-kind'`);
      expect(kept.rows[0].n).toBe(before.rows[0].n + 1); // no existing row was touched

      // A re-run is a no-op: the definition is unchanged.
      await c.query(readFileSync(MIGRATION, "utf8"));
      expect((await kindChecks(c))[0].def).toBe(after[0].def);
    });
  });

  it("keeps a value a LATER migration might have added (read from the live definition, never typed from memory)", async () => {
    await inRolledBackTx(async (c) => {
      const [{ conname }] = await kindChecks(c);
      await c.query(`DELETE FROM webdev_site_builds WHERE kind = 'promote'`);
      await c.query(`ALTER TABLE webdev_site_builds DROP CONSTRAINT ${conname}`);
      await c.query(`ALTER TABLE webdev_site_builds ADD CONSTRAINT ${conname} CHECK (kind IN ('publish', 'rebuild', 'preview'))`);
      await c.query(readFileSync(MIGRATION, "utf8"));
      const [after] = await kindChecks(c);
      for (const v of ["publish", "rebuild", "preview", "promote"]) expect(after.def, v).toContain(`'${v}'`);
    });
  });

  it("REFUSES a live CHECK that has drifted from what the code needs (no 'rebuild'): it is not widened", async () => {
    await inRolledBackTx(async (c) => {
      const [{ conname }] = await kindChecks(c);
      await c.query(`DELETE FROM webdev_site_builds WHERE kind <> 'publish'`);
      await c.query(`ALTER TABLE webdev_site_builds DROP CONSTRAINT ${conname}`);
      await c.query(`ALTER TABLE webdev_site_builds ADD CONSTRAINT ${conname} CHECK (kind IN ('publish'))`);
      await expect(c.query(readFileSync(MIGRATION, "utf8"))).rejects.toThrow(/no longer admits rebuild/);
    });
  });
});
