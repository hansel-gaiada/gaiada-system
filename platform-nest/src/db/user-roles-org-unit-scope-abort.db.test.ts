// HIER-1 — migration 0100 must be RE-RUNNABLE against a database that still contains
// `scope_type='team'` rows, without aborting.
//
// ⚠ THIS FILE WAS INVERTED (2026-08-10). As written it proved the OPPOSITE: that 0100's count-assert
// guards RAISE when a team row exists. That was correct for 0100's first draft, which dropped
// `team`/`record` from the scope_type CHECK immediately. **That draft could not land.** Three write
// paths still insert `scope_type='team'` — `core/teams.controller.ts:119` (promote-to-lead),
// `testing/personas.ts` and `seed/personas.ts` — and all three belong to HIER-3, not HIER-1. 0100 is
// now EXPAND-ONLY: it adds `org_unit` and widens `scope_id`, while `team`/`record` stay in the CHECK
// until HIER-3 removes them together with their writers (textbook expand/contract).
//
// WHY THE INVERTED PROPERTY IS WORTH A TEST AT ALL — it guards a trap this migration hit TWICE:
// `migrate()` runs on EVERY platform boot (`main.ts` → `migrate()`). While `teams.controller.ts` can
// still legitimately mint a team-scoped grant, ANY hard abort in 0100 keyed on the presence of such a
// row is a **boot failure** from a migration already in the ledger with nothing left to do. Both of
// 0100's guards were downgraded to `RAISE NOTICE` for exactly that reason (the second one was missed
// on the first pass and found by this very test failing). This file now pins that: plant the row the
// old guards tripped on, re-run the real migration text, and prove it completes.
//
// **HIER-3 must invert this file back**, in the same change that drops `team`/`record` from the CHECK
// and deletes their writers — at which point a hard abort is correct again and this test should once
// more prove that it fires.
//
// Uses `adminPool()` (the owner connection `initTestDb` already sets up) because manipulating
// constraints is DDL the least-privilege `platform_app_test` role cannot perform.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withGlobal, newId } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createUser, createRole } from "../testing/fixtures";

const MIGRATION_0100_SQL = readFileSync(
  join(__dirname, "..", "..", "migrations", "0100_user_roles_org_unit_scope.sql"),
  "utf8",
);

/** 0100's expand-only scope_type CHECK, restated here so the cleanup below restores the REAL
 *  post-0100 state. (The pre-amendment version of this file restored the narrower contract-phase
 *  CHECK, which would have left this file's database contradicting the migration it tests.) */
const EXPAND_ONLY_SCOPE_TYPES = "'global','company','team','org_unit','project','record'";

describe.skipIf(!TEST_URL)("0100 — re-runnable with team-scoped rows present (expand-only)", () => {
  beforeAll(initTestDb);
  afterAll(teardownTestDb);

  it("a scope_type='team' row does NOT abort a re-run of 0100 — migrate() runs on every boot", async () => {
    const admin = adminPool();
    const user = await createUser("hier1-rerun-team@a.test");
    const role = await createRole("hier1_rerun_team_role");

    const before = (
      await admin.query<{ data_type: string }>(
        `SELECT data_type FROM information_schema.columns WHERE table_name='user_roles' AND column_name='scope_id'`,
      )
    ).rows[0].data_type;
    expect(before).toBe("text"); // sanity: 0100 really did already run once, normally

    const poisonId = newId();
    try {
      // A live team-scoped grant — exactly what `teams.controller.ts` still mints today, and what
      // the pre-amendment guards aborted on. scope_id is uuid-shaped so the SHAPE check (which does
      // still constrain `team`) cannot be what accepts or rejects this row.
      await withGlobal((c) =>
        c.query(`INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id) VALUES ($1,$2,$3,'team',$4)`, [
          poisonId,
          user,
          role,
          newId(),
        ]),
      );

      // Re-execute 0100's REAL file text (not a paraphrase), exactly as the runner would on boot.
      const client = await admin.connect();
      let caught: unknown;
      try {
        await client.query("BEGIN");
        await client.query(MIGRATION_0100_SQL);
        await client.query("COMMIT");
      } catch (err) {
        caught = err;
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }

      expect(
        caught,
        `0100 must be re-runnable with a team-scoped row present — a throw here is a BOOT FAILURE ` +
          `for every developer who has promoted a team lead. If HIER-3 has landed and deliberately ` +
          `restored the hard abort, invert this file back (see its header).`,
      ).toBeUndefined();

      // And the row is untouched: this migration has no business deleting grants.
      const stillThere = await withGlobal((c) =>
        c.query<{ count: string }>(`SELECT count(*) FROM user_roles WHERE id = $1 AND scope_type = 'team'`, [poisonId]),
      );
      expect(Number(stillThere.rows[0].count)).toBe(1);

      // Both constraints are present and correct afterwards (the migration is idempotent).
      const constraints = await admin.query<{ count: string }>(
        `SELECT count(*) FROM pg_constraint
          WHERE conname IN ('user_roles_scope_type_check','user_roles_scope_id_shape_check')
            AND conrelid='user_roles'::regclass`,
      );
      expect(Number(constraints.rows[0].count)).toBe(2);
    } finally {
      await withGlobal((c) => c.query(`DELETE FROM user_roles WHERE id = $1`, [poisonId]));
      // Restore the REAL post-0100 (expand-only) CHECK, whatever happened above.
      await admin.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='user_roles_scope_type_check' AND conrelid='user_roles'::regclass) THEN
            ALTER TABLE user_roles ADD CONSTRAINT user_roles_scope_type_check CHECK (scope_type IN (${EXPAND_ONLY_SCOPE_TYPES}));
          END IF;
        END $$;
      `);
    }
  });
});
