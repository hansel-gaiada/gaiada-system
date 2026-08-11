// IAM-01c-2 dedicated test for 0092_user_roles_global_scope_unique.sql (Finding F,
// docs/superpowers/plans/2026-08-10-iam-phase1-tickets.md §6).
//
// THE BUG THIS GUARDS AGAINST: `user_roles` carried `UNIQUE (user_id, role_id, scope_type,
// scope_id)` since 0001, but for GLOBAL grants `scope_id IS NULL` and SQL never treats two NULLs as
// equal for uniqueness — so the constraint silently never fired for global grants. Confirmed live
// 2026-08-10: both real elevated accounts (`exec@gaiada.test` / group_executive,
// `hansel@gaiada.com` / platform_admin) carried 2 rows each. 0092 dedupes the existing rows and adds
// `user_roles_global_scope_uniq ON user_roles (user_id, role_id, scope_type) WHERE scope_id IS
// NULL`. This file proves the new index actually enforces uniqueness (a raw duplicate insert is
// rejected) AND that the real production call site — `grantRole()`, used by `seed:agency` on every
// re-run — is now genuinely idempotent for a global-scope grant instead of silently duplicating it,
// which is the exact mechanism that produced the live duplicates in the first place.
//
// `user_roles` carries no RLS at all (0001's own "Global tables ... app-layer guarded" — verified
// live via pg_class.relrowsecurity/relforcerowsecurity = false/false), so every query below uses
// `withGlobal`, matching how the real call sites (admin-identity.controller.ts, service-reconciler.ts,
// testing/fixtures.ts) reach this table.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withGlobal, newId } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createUser, createRole, grantRole } from "../testing/fixtures";

describe.skipIf(!TEST_URL)("0092 user_roles_global_scope_uniq — global-grant duplicates rejected", () => {
  let user: string;
  let roleA: string;
  let roleB: string;

  beforeAll(async () => {
    await initTestDb();
    user = await createUser("iam01c2-user@a.test");
    roleA = await createRole("iam01c2_role_a"); // global (companyId defaults to null)
    roleB = await createRole("iam01c2_role_b");
  });
  afterAll(teardownTestDb);

  it("a second bare INSERT of the identical global grant is rejected by the new partial unique index", async () => {
    await withGlobal((c) =>
      c.query(`INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id) VALUES ($1,$2,$3,'global',NULL)`, [
        newId(),
        user,
        roleA,
      ]),
    );

    await expect(
      withGlobal((c) =>
        c.query(`INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id) VALUES ($1,$2,$3,'global',NULL)`, [
          newId(),
          user,
          roleA,
        ]),
      ),
    ).rejects.toThrow(/duplicate key|unique constraint|violates/i);

    const { rows } = await withGlobal((c) =>
      c.query<{ count: string }>(
        `SELECT count(*) FROM user_roles WHERE user_id=$1 AND role_id=$2 AND scope_type='global' AND scope_id IS NULL`,
        [user, roleA],
      ),
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it("grantRole() — the real seed:agency call site — is now idempotent for a global grant across two calls", async () => {
    // This is the exact shape src/seed/agency.ts uses: grantRole(users.exec, roleExec, 'global',
    // null). Before 0092, calling it twice (e.g. two seed re-runs) produced two rows because
    // grantRole's untargeted `ON CONFLICT DO NOTHING` had no matching constraint to catch on. After
    // 0092, the new partial index gives it one — `ON CONFLICT DO NOTHING` (no target) is a
    // catch-all over every unique constraint on the table, so it now actually no-ops.
    await grantRole(user, roleB, "global", null);
    await grantRole(user, roleB, "global", null); // second call must not throw and must not duplicate

    const { rows } = await withGlobal((c) =>
      c.query<{ count: string }>(
        `SELECT count(*) FROM user_roles WHERE user_id=$1 AND role_id=$2 AND scope_type='global' AND scope_id IS NULL`,
        [user, roleB],
      ),
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it("control: a DIFFERENT global role for the same user is unaffected (not over-broadened)", async () => {
    const otherUser = await createUser("iam01c2-user2@a.test");
    await withGlobal((c) =>
      c.query(`INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id) VALUES ($1,$2,$3,'global',NULL)`, [
        newId(),
        otherUser,
        roleA,
      ]),
    );
    await withGlobal((c) =>
      c.query(`INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id) VALUES ($1,$2,$3,'global',NULL)`, [
        newId(),
        otherUser,
        roleB,
      ]),
    );
    const { rows } = await withGlobal((c) =>
      c.query<{ count: string }>(`SELECT count(*) FROM user_roles WHERE user_id=$1 AND scope_type='global'`, [otherUser]),
    );
    expect(Number(rows[0].count)).toBe(2);
  });

  it("control: a company-scoped grant of the same user/role is unaffected by the global partial index", async () => {
    const companyScopeId = newId(); // no real companies table row needed — user_roles has no FK to companies for scope_id
    await withGlobal((c) =>
      c.query(`INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id) VALUES ($1,$2,$3,'company',$4)`, [
        newId(),
        user,
        roleA,
        companyScopeId,
      ]),
    );
    // The pre-existing global-scope roleA grant for `user` from test 1 still coexists with this
    // company-scoped one — proving the partial index (WHERE scope_id IS NULL) never reaches rows
    // that have a real scope_id.
    const { rows } = await withGlobal((c) =>
      c.query<{ count: string }>(`SELECT count(*) FROM user_roles WHERE user_id=$1 AND role_id=$2`, [user, roleA]),
    );
    expect(Number(rows[0].count)).toBe(2); // 1 global + 1 company-scoped
  });
});
