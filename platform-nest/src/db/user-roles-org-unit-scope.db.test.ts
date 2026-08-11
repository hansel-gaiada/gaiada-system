// HIER-1 — dedicated test for migration 0100_user_roles_org_unit_scope.sql
// (docs/superpowers/plans/2026-08-10-iam-hier-01-plan.md, DR-8/DR-10).
//
// WHAT 0100 CHANGED: `user_roles.scope_type` CHECK -> ('global','company','org_unit','project')
// (drops `team`/`record`, adds `org_unit`); `user_roles.scope_id` widened `uuid` -> `text`; a new
// per-scope SHAPE CHECK (`user_roles_scope_id_shape_check`) replaces the typing guarantee the
// `uuid` column used to give for free.
//
// THIS FILE PROVES, against a real Postgres (not read from the migration text and trusted):
//   1. the shape CHECK REJECTS a malformed scope_id for every scope type it constrains
//      (org_unit empty/whitespace-only text; company/project non-uuid-shaped text; a non-NULL
//      scope_id on a global grant);
//   2. the shape CHECK ACCEPTS the valid shape for every scope type (org_unit free-form text
//      node id like 'd-hr'; company/project a real uuid; global with scope_id NULL);
//   3. the scope_type CHECK itself rejects the now-retired 'team'/'record' values;
//   4. 0092's partial unique index (`user_roles_global_scope_uniq`) is not just PRESENT after the
//      `ALTER COLUMN ... TYPE text` (0100's own closing assertion already checks that, loudly, at
//      migration time) but still FUNCTIONALLY FIRES — a genuine duplicate global-scope insert is
//      still rejected post-migration.
//
// `user_roles` carries no RLS (0092's own header, re-confirmed live) — every query below uses
// `withGlobal`, matching every real call site.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withGlobal, newId } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createUser, createRole } from "../testing/fixtures";

const REAL_UUID = "0198018e-0000-7000-8000-000000000001"; // uuidv7-shaped, does not need to reference a real row — user_roles has no FK on scope_id

describe.skipIf(!TEST_URL)("0100 — user_roles scope_type/scope_id shape after the org_unit widening", () => {
  let user: string;
  let role: string;

  beforeAll(async () => {
    await initTestDb();
    user = await createUser("hier1-shape-user@a.test");
    role = await createRole("hier1_shape_role");
  });
  afterAll(teardownTestDb);

  const insert = (scopeType: string, scopeId: string | null) =>
    withGlobal((c) =>
      c.query(`INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id) VALUES ($1,$2,$3,$4,$5)`, [
        newId(),
        user,
        role,
        scopeType,
        scopeId,
      ]),
    );

  // ── scope_type CHECK: team/record are RETIRED (HIER-3, migration 0103) ─────────────────────
  //
  // ⚠ INVERTED 2026-08-11 (HIER-3). These two originally asserted 'team'/'record' were REJECTED
  // (0100's first-draft intent), then were REWRITTEN 2026-08-10 to assert the OPPOSITE
  // (`resolves.toBeDefined()`) when 0100 was amended to expand-only — three write paths
  // (`core/teams.controller.ts:119`, `testing/personas.ts`, `seed/personas.ts`) still minted
  // `scope_type='team'` grants at the time, so dropping the value in 0100 would have turned those
  // into CHECK violations. HIER-3 removes all three writers in the same change that drops the
  // values (migration 0103) — the drop is real now, so these two invert back to asserting
  // REJECTION, matching 0100's own header's explicit instruction to do so.
  //
  // Uses a uuid-shaped scope_id (not e.g. "some-team-id") so the SHAPE check cannot mask the
  // scope_type behaviour this test targets — a lesson from the prior rewrite's own note that an
  // earlier version of this test passed for the wrong reason.
  it("scope_type CHECK REJECTS 'team' — retired by HIER-3 (migration 0103)", async () => {
    await expect(insert("team", REAL_UUID)).rejects.toThrow(/violates check constraint|user_roles_scope_type_check/i);
  });

  it("scope_type CHECK REJECTS 'record' — retired by HIER-3 (migration 0103)", async () => {
    await expect(insert("record", REAL_UUID)).rejects.toThrow(/violates check constraint|user_roles_scope_type_check/i);
  });

  it("scope_type CHECK accepts the new 'org_unit' value (shape check permitting)", async () => {
    await expect(insert("org_unit", "d-legal")).resolves.toBeDefined();
  });

  // ── shape CHECK: org_unit — non-empty text required ────────────────────────────────────────
  it("shape CHECK rejects org_unit with a NULL scope_id", async () => {
    await expect(insert("org_unit", null)).rejects.toThrow(/violates check constraint|user_roles_scope_id_shape_check/i);
  });

  it("shape CHECK rejects org_unit with an empty-string scope_id", async () => {
    await expect(insert("org_unit", "")).rejects.toThrow(/violates check constraint|user_roles_scope_id_shape_check/i);
  });

  it("shape CHECK rejects org_unit with a whitespace-only scope_id", async () => {
    await expect(insert("org_unit", "   ")).rejects.toThrow(/violates check constraint|user_roles_scope_id_shape_check/i);
  });

  it("shape CHECK accepts org_unit with a real free-form org-node id ('d-hr', the 0029/0055 convention)", async () => {
    await expect(insert("org_unit", "d-hr")).resolves.toBeDefined();
  });

  it("shape CHECK accepts org_unit with a division-shaped node id ('dv-web')", async () => {
    await expect(insert("org_unit", "dv-web")).resolves.toBeDefined();
  });

  // ── shape CHECK: company/project — uuid-shaped text required ───────────────────────────────
  it("shape CHECK rejects company scope with a non-uuid-shaped scope_id", async () => {
    await expect(insert("company", "not-a-uuid")).rejects.toThrow(
      /violates check constraint|user_roles_scope_id_shape_check/i,
    );
  });

  it("shape CHECK rejects project scope with a non-uuid-shaped scope_id", async () => {
    await expect(insert("project", "d-hr")).rejects.toThrow(/violates check constraint|user_roles_scope_id_shape_check/i);
  });

  it("shape CHECK rejects company scope with a NULL scope_id (the pre-0100 silent-null gap this closes)", async () => {
    await expect(insert("company", null)).rejects.toThrow(/violates check constraint|user_roles_scope_id_shape_check/i);
  });

  it("shape CHECK accepts company scope with a real uuid-shaped scope_id", async () => {
    await expect(insert("company", REAL_UUID)).resolves.toBeDefined();
  });

  it("shape CHECK accepts project scope with a real uuid-shaped scope_id", async () => {
    await expect(insert("project", REAL_UUID)).resolves.toBeDefined();
  });

  // ── shape CHECK: global — scope_id must be NULL ─────────────────────────────────────────────
  it("shape CHECK rejects global scope with a non-NULL scope_id", async () => {
    await expect(insert("global", REAL_UUID)).rejects.toThrow(/violates check constraint|user_roles_scope_id_shape_check/i);
  });

  it("shape CHECK accepts global scope with a NULL scope_id", async () => {
    await expect(insert("global", null)).resolves.toBeDefined();
  });
});

describe.skipIf(!TEST_URL)("0100 — 0092's partial unique index survives the scope_id type change and still FIRES", () => {
  let user: string;
  let role: string;

  beforeAll(async () => {
    await initTestDb();
    user = await createUser("hier1-index-survival@a.test");
    role = await createRole("hier1_index_survival_role");
  });
  afterAll(teardownTestDb);

  it("the index object itself is present under its original name post-0100 (existence)", async () => {
    const { rows } = await withGlobal((c) =>
      c.query<{ exists: boolean }>(`SELECT to_regclass('public.user_roles_global_scope_uniq') IS NOT NULL AS exists`),
    );
    expect(rows[0].exists).toBe(true);
  });

  it("a genuine duplicate global-scope grant is still rejected (functional proof, not just presence)", async () => {
    await withGlobal((c) =>
      c.query(`INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id) VALUES ($1,$2,$3,'global',NULL)`, [
        newId(),
        user,
        role,
      ]),
    );
    await expect(
      withGlobal((c) =>
        c.query(`INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id) VALUES ($1,$2,$3,'global',NULL)`, [
          newId(),
          user,
          role,
        ]),
      ),
    ).rejects.toThrow(/duplicate key|unique constraint|violates/i);
  });

  it("scope_id is genuinely text now — a text org_unit value coexists with the pkey/unique constraints without a uuid cast error", async () => {
    const { rows } = await withGlobal((c) =>
      c.query<{ data_type: string }>(
        `SELECT data_type FROM information_schema.columns WHERE table_name='user_roles' AND column_name='scope_id'`,
      ),
    );
    expect(rows[0].data_type).toBe("text");
  });
});
