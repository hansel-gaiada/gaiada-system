// HIER-3 — migration 0103 must ABORT (hard `RAISE EXCEPTION`) if a `scope_type='team'` or
// `'record'` row exists in `user_roles` at migration time, rather than silently dropping the
// values out from under a live grant.
//
// ⚠ THIS FILE WAS INVERTED (2026-08-11, HIER-3), per 0100's own header's explicit instruction:
// "HIER-3 must restore these as hard `RAISE EXCEPTION` assertions, where they are correct again
// because the drop is real." The PRIOR version of this file (through HIER-1/HIER-2) proved the
// OPPOSITE — that **0100** was re-runnable with a `team`-scoped row present, because 0100 was
// deliberately amended to expand-only (RAISE NOTICE, not RAISE EXCEPTION) after its first draft
// could not land: three write paths (`core/teams.controller.ts:119`, `testing/personas.ts`,
// `seed/personas.ts`) still minted `scope_type='team'` grants at the time. **0100 is an already-
// APPLIED migration and stays exactly as it was written — rule 4, never edit an applied
// migration** — so it is NOT what gets its hard abort back. HIER-3 removes all three writers in
// the same change that narrows the CHECK (migration 0103), and the hard abort now lives THERE —
// this file's subject shifts from "0100's re-run behavior" to "0103's abort behavior" for exactly
// that reason.
//
// Uses `adminPool()` (the owner connection `initTestDb` already sets up) because manipulating
// constraints is DDL the least-privilege `platform_app_test` role cannot perform. `initTestDb()`
// already runs 0103 once (there are zero team/record rows at fresh-bootstrap time, so its own
// count-assert never fires during normal setup) — this test manufactures the "dirty" pre-existing
// state 0103 must guard against by temporarily widening the CHECK back, inserting a poison row,
// then re-running 0103's REAL file text and proving it aborts before reaching the DROP TABLE /
// DELETE steps that would otherwise silently discard the row's scope.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withGlobal, newId } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createUser, createRole } from "../testing/fixtures";

const MIGRATION_0103_SQL = readFileSync(
  join(__dirname, "..", "..", "migrations", "0103_hier3_retire_team_scope.sql"),
  "utf8",
);

// The post-0103 CHECKs (both scope_type AND the per-scope shape check) are narrower than the
// value this test needs to insert (a poison 'team'/'record' row) — so BOTH constraints must be
// temporarily widened back to make the poison INSERT possible at all, mirroring the exact "dirty
// pre-existing data" shape 0103's count-assert exists to catch (e.g. a database that had a
// leftover team-scoped row from before HIER-3 landed). A uuid-shaped scope_id is used so the
// widened SHAPE check's team/record branch (which requires uuid shape, same as company/project)
// is satisfied — this test targets the scope_type behaviour, not the shape behaviour.
const WIDENED_SCOPE_TYPES = "'global','company','team','org_unit','project','record'";
const POST_0103_SCOPE_TYPES = "'global','company','org_unit','project'";
const WIDENED_SHAPE_CHECK = `
  (scope_type = 'global' AND scope_id IS NULL)
  OR (
    scope_type IN ('company', 'project', 'team', 'record')
    AND scope_id IS NOT NULL
    AND scope_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  )
  OR (
    scope_type = 'org_unit'
    AND scope_id IS NOT NULL
    AND btrim(scope_id) <> ''
  )
`;
const POST_0103_SHAPE_CHECK = `
  (scope_type = 'global' AND scope_id IS NULL)
  OR (
    scope_type IN ('company', 'project')
    AND scope_id IS NOT NULL
    AND scope_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  )
  OR (
    scope_type = 'org_unit'
    AND scope_id IS NOT NULL
    AND btrim(scope_id) <> ''
  )
`;

describe.skipIf(!TEST_URL)("0103 — aborts loudly (does not silently drop) when a team/record-scoped row exists at migration time", () => {
  beforeAll(initTestDb);
  afterAll(teardownTestDb);

  it.each(["team", "record"] as const)(
    "a scope_type='%s' row ABORTS a re-run of 0103's real migration text",
    async (scopeType) => {
      const admin = adminPool();
      const user = await createUser(`hier3-abort-${scopeType}@a.test`);
      const role = await createRole(`hier3_abort_${scopeType}_role`);
      const poisonId = newId();

      // Sanity: 0103 already ran once during initTestDb() — the CHECK is already narrow.
      const before = await admin.query<{ count: string }>(
        `SELECT count(*) FROM pg_constraint WHERE conname='user_roles_scope_type_check' AND conrelid='user_roles'::regclass`,
      );
      expect(Number(before.rows[0].count)).toBe(1);

      try {
        // Manufacture the dirty pre-existing state: widen BOTH constraints back just enough to
        // insert the poison row (a real production DB in this shape would predate 0103 entirely).
        await admin.query(`ALTER TABLE user_roles DROP CONSTRAINT user_roles_scope_type_check`);
        await admin.query(`ALTER TABLE user_roles ADD CONSTRAINT user_roles_scope_type_check CHECK (scope_type IN (${WIDENED_SCOPE_TYPES}))`);
        await admin.query(`ALTER TABLE user_roles DROP CONSTRAINT user_roles_scope_id_shape_check`);
        await admin.query(`ALTER TABLE user_roles ADD CONSTRAINT user_roles_scope_id_shape_check CHECK (${WIDENED_SHAPE_CHECK})`);
        await withGlobal((c) =>
          c.query(`INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id) VALUES ($1,$2,$3,$4,$5)`, [
            poisonId,
            user,
            role,
            scopeType,
            newId(), // uuid-shaped, so the widened SHAPE check's team/record branch is satisfied
          ]),
        );

        // Re-execute 0103's REAL file text (not a paraphrase), exactly as the runner would on boot.
        const client = await admin.connect();
        let caught: unknown;
        try {
          await client.query("BEGIN");
          await client.query(MIGRATION_0103_SQL);
          await client.query("COMMIT");
        } catch (err) {
          caught = err;
          await client.query("ROLLBACK");
        } finally {
          client.release();
        }

        expect(
          caught,
          `0103 must ABORT when a scope_type='${scopeType}' row exists — a silent pass here would ` +
            `orphan a live grant's scope out from under it the moment the CHECK narrows.`,
        ).toBeDefined();
        expect(String((caught as Error)?.message ?? caught)).toMatch(new RegExp(scopeType));

        // Nothing was torn down by the aborted (rolled-back) transaction: the poison row survives,
        // and — because the whole migration ran inside one transaction that rolled back — the CHECK
        // is still the WIDENED one this test set up, not 0103's narrower post-migration shape.
        const stillThere = await withGlobal((c) =>
          c.query<{ count: string }>(`SELECT count(*) FROM user_roles WHERE id = $1 AND scope_type = $2`, [
            poisonId,
            scopeType,
          ]),
        );
        expect(Number(stillThere.rows[0].count)).toBe(1);
      } finally {
        await withGlobal((c) => c.query(`DELETE FROM user_roles WHERE id = $1`, [poisonId]));
        // Restore the REAL post-0103 (narrow) CHECKs, whatever happened above, so the next test in
        // this file (or this suite's own teardown) sees the correct live shape.
        await admin.query(`ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_scope_type_check`);
        await admin.query(`
          DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='user_roles_scope_type_check' AND conrelid='user_roles'::regclass) THEN
              ALTER TABLE user_roles ADD CONSTRAINT user_roles_scope_type_check CHECK (scope_type IN (${POST_0103_SCOPE_TYPES}));
            END IF;
          END $$;
        `);
        await admin.query(`ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_scope_id_shape_check`);
        await admin.query(`
          DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='user_roles_scope_id_shape_check' AND conrelid='user_roles'::regclass) THEN
              ALTER TABLE user_roles ADD CONSTRAINT user_roles_scope_id_shape_check CHECK (${POST_0103_SHAPE_CHECK});
            END IF;
          END $$;
        `);
      }
    },
  );
});
