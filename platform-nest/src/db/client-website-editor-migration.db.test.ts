// WSK-49f — migration 202610110520 widens THREE live CHECKs (user_roles.scope_type, the user_roles
// per-scope shape CHECK, client_contacts.capability). A DROP+ADD that re-declares a list from memory has
// silently deleted values on LIVE before, so the migration is self-verifying against whatever database it
// runs on. This file proves the verification has teeth, with the migration's REAL file text:
//   (1) after the migration every PRIOR value is still accepted and the new one is added -- the exact
//       value lists are pinned, so a later edit that drops one fails here;
//   (2) a LIVE database that has drifted (a value this migration does not know) makes it ABORT, naming the
//       value, and changes nothing;
//   (3) re-running it on an already-migrated database is a no-op that keeps every value;
//   (4) the role/scope weld (trigger) and the shape CHECK actually refuse what they must.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withGlobal, newId } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createUser, createRole, createCompany, createClient } from "../testing/fixtures";

const MIGRATION_SQL = readFileSync(
  join(__dirname, "..", "..", "migrations", "202610110520_iam_client_website_editor_grant_path.sql"),
  "utf8",
);

/** The quoted literals of one CHECK definition, as the live catalogue renders it. */
async function literalsOf(table: string, like: string, notLike?: string): Promise<string[]> {
  const { rows } = await adminPool().query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = $1::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE $2
        AND ($3::text IS NULL OR pg_get_constraintdef(oid) NOT LIKE $3)`,
    [table, like, notLike ?? null],
  );
  expect(rows.length, `exactly one ${table} CHECK matching ${like}`).toBe(1);
  return [...new Set([...rows[0].def.matchAll(/'([^']*)'/g)].map((m) => m[1]))].sort();
}

/** Run the migration's REAL text in one transaction; roll back when asked. Returns the error, if any. */
async function runMigration(commit: boolean): Promise<Error | undefined> {
  const client = await adminPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(MIGRATION_SQL);
    await client.query(commit ? "COMMIT" : "ROLLBACK");
    return undefined;
  } catch (err) {
    await client.query("ROLLBACK");
    return err as Error;
  } finally {
    client.release();
  }
}

describe.skipIf(!TEST_URL)("202610110520 — the CHECK widenings keep every prior value and abort on drift", () => {
  beforeAll(initTestDb, 120_000);
  afterAll(teardownTestDb);

  it("user_roles.scope_type lists EVERY prior value plus client (exact set)", async () => {
    expect(await literalsOf("user_roles", "%scope_type%", "%scope_id%")).toEqual(
      ["client", "company", "global", "org_unit", "project"],
    );
  });

  it("the user_roles shape CHECK names every prior scope plus client, and keeps the uuid + org_unit branches", async () => {
    const lits = (await literalsOf("user_roles", "%scope_id%")).filter((x) => /^[a-z_]+$/.test(x));
    expect(lits).toEqual(["client", "company", "global", "org_unit", "project"]);
    const { rows } = await adminPool().query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'user_roles'::regclass AND conname = 'user_roles_scope_id_shape_check'`,
    );
    expect(rows[0].def).toContain("btrim(scope_id)");
    expect(rows[0].def).toContain("[0-9a-fA-F]{8}");
  });

  it("client_contacts.capability lists EVERY prior value plus admin (exact set)", async () => {
    expect(await literalsOf("client_contacts", "%capability%")).toEqual(["admin", "signer", "viewer"]);
  });

  it("behaviour, not just text: every prior scope type and capability is still ACCEPTED, a stranger is not", async () => {
    const admin = adminPool();
    const u = await createUser("w49f-values@a.test");
    const role = await createRole("w49f_values_role");
    const uuid = newId();
    for (const [scopeType, scopeId] of [["global", null], ["company", uuid], ["project", uuid], ["org_unit", "d-web"]] as const) {
      await withGlobal((c) =>
        c.query(`INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id) VALUES ($1,$2,$3,$4,$5)`, [newId(), u, role, scopeType, scopeId]),
      );
    }
    await expect(
      admin.query(`INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id) VALUES ($1,$2,$3,'team',$4)`, [newId(), u, role, uuid]),
    ).rejects.toThrow(/user_roles_scope_(type|id_shape)_check/);
    await expect(
      admin.query(`INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id) VALUES ($1,$2,$3,'record',$4)`, [newId(), u, role, uuid]),
    ).rejects.toThrow(/user_roles_scope_(type|id_shape)_check/);
    await admin.query(`DELETE FROM user_roles WHERE user_id = $1`, [u]);

    // capability: signer | viewer | admin accepted, anything else refused. A throwaway client + contact rows.
    const co = await createCompany("w49f co");
    const cl = await createClient(co, "w49f client");
    for (const cap of ["signer", "viewer", "admin"]) {
      const cu = await createUser(`w49f-${cap}@a.test`);
      await admin.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, capability, status, origin_site) VALUES ($1,$2,$3,$4,$5,'active','test')`,
        [newId(), co, cl, cu, cap],
      );
    }
    const cu = await createUser("w49f-owner@a.test");
    await expect(
      admin.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, capability, status, origin_site) VALUES ($1,$2,$3,$4,'owner','active','test')`,
        [newId(), co, cl, cu],
      ),
    ).rejects.toThrow(/capability_check/);
  });

  it("a LIVE scope_type CHECK that allows a value the migration does not know ABORTS it, naming the value, and changes nothing", async () => {
    const admin = adminPool();
    try {
      await admin.query(`ALTER TABLE user_roles DROP CONSTRAINT user_roles_scope_type_check`);
      await admin.query(
        `ALTER TABLE user_roles ADD CONSTRAINT user_roles_scope_type_check CHECK (scope_type IN ('global','company','org_unit','project','client','record'))`,
      );
      const err = await runMigration(false);
      expect(err, "the migration must abort when the live list has a value it would delete").toBeDefined();
      expect(String(err?.message)).toMatch(/record/);
      expect(String(err?.message)).toMatch(/Nothing was changed/);
      // still the drifted definition: nothing was dropped or re-declared behind the abort
      expect(await literalsOf("user_roles", "%scope_type%", "%scope_id%")).toEqual(
        ["client", "company", "global", "org_unit", "project", "record"],
      );
    } finally {
      await admin.query(`ALTER TABLE user_roles DROP CONSTRAINT user_roles_scope_type_check`);
      await admin.query(
        `ALTER TABLE user_roles ADD CONSTRAINT user_roles_scope_type_check CHECK (scope_type IN ('global','company','org_unit','project','client'))`,
      );
    }
  });

  it("a LIVE capability CHECK that allows a value the migration does not know ABORTS it, naming the value", async () => {
    const admin = adminPool();
    try {
      await admin.query(`ALTER TABLE client_contacts DROP CONSTRAINT client_contacts_capability_check`);
      await admin.query(
        `ALTER TABLE client_contacts ADD CONSTRAINT client_contacts_capability_check CHECK (capability IN ('signer','viewer','admin','auditor'))`,
      );
      const err = await runMigration(false);
      expect(err).toBeDefined();
      expect(String(err?.message)).toMatch(/auditor/);
      expect(await literalsOf("client_contacts", "%capability%")).toEqual(["admin", "auditor", "signer", "viewer"]);
    } finally {
      await admin.query(`ALTER TABLE client_contacts DROP CONSTRAINT client_contacts_capability_check`);
      await admin.query(
        `ALTER TABLE client_contacts ADD CONSTRAINT client_contacts_capability_check CHECK (capability IN ('signer','viewer','admin'))`,
      );
    }
  });

  it("a LIVE shape CHECK whose scope list is not the one it expects ABORTS rather than being guessed at", async () => {
    const admin = adminPool();
    const original = (
      await admin.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'user_roles'::regclass AND conname = 'user_roles_scope_id_shape_check'`,
      )
    ).rows[0].def;
    try {
      await admin.query(`ALTER TABLE user_roles DROP CONSTRAINT user_roles_scope_id_shape_check`);
      // drifted: an unknown scope literal ('workspace') the migration has never heard of
      await admin.query(
        `ALTER TABLE user_roles ADD CONSTRAINT user_roles_scope_id_shape_check CHECK (
           (scope_type = 'global' AND scope_id IS NULL) OR (scope_type IN ('company','project','workspace') AND scope_id IS NOT NULL))`,
      );
      // also make scope_type's own CHECK agree, so the abort under test is the SHAPE check's
      await admin.query(`ALTER TABLE user_roles DROP CONSTRAINT user_roles_scope_type_check`);
      await admin.query(
        `ALTER TABLE user_roles ADD CONSTRAINT user_roles_scope_type_check CHECK (scope_type IN ('global','company','org_unit','project','client'))`,
      );
      const err = await runMigration(false);
      expect(err).toBeDefined();
      expect(String(err?.message)).toMatch(/workspace/);
    } finally {
      await admin.query(`ALTER TABLE user_roles DROP CONSTRAINT user_roles_scope_id_shape_check`);
      await admin.query(`ALTER TABLE user_roles ADD CONSTRAINT user_roles_scope_id_shape_check CHECK ${original.replace(/^CHECK /, "")}`);
    }
  });

  it("re-running the migration on an already-migrated database is a no-op that keeps every value", async () => {
    const err = await runMigration(true);
    expect(err, err?.message).toBeUndefined();
    expect(await literalsOf("user_roles", "%scope_type%", "%scope_id%")).toEqual(["client", "company", "global", "org_unit", "project"]);
    expect(await literalsOf("client_contacts", "%capability%")).toEqual(["admin", "signer", "viewer"]);
    const roles = await adminPool().query(`SELECT 1 FROM roles WHERE company_id IS NULL AND name = 'client_website_editor'`);
    expect(roles.rowCount).toBe(1);
  });

  it("the role carries no permission bundle (no perm_* mirror may ever be implied)", async () => {
    const { rows } = await adminPool().query(
      `SELECT count(*)::int AS n FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.name = 'client_website_editor'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it("the weld: client_website_editor only at client scope, and client scope only for that role (DB trigger)", async () => {
    const admin = adminPool();
    const u = await createUser("w49f-weld@a.test");
    const editor = (await admin.query<{ id: string }>(`SELECT id FROM roles WHERE company_id IS NULL AND name='client_website_editor'`)).rows[0].id;
    const staffRole = await createRole("w49f_staff_role");
    const uuid = newId();
    // wrong scope for the role
    await expect(
      admin.query(`INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id) VALUES ($1,$2,$3,'company',$4)`, [newId(), u, editor, uuid]),
    ).rejects.toThrow(/client_website_editor may only be granted at scope_type=client/);
    await expect(
      admin.query(`INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id) VALUES ($1,$2,$3,'global',NULL)`, [newId(), u, editor]),
    ).rejects.toThrow(/client_website_editor may only be granted/);
    // wrong role for the scope
    await expect(
      admin.query(`INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id) VALUES ($1,$2,$3,'client',$4)`, [newId(), u, staffRole, uuid]),
    ).rejects.toThrow(/scope_type=client may only carry the client_website_editor role/);
    // an UPDATE cannot repoint an existing row across the weld either
    const rowId = newId();
    await admin.query(`INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id) VALUES ($1,$2,$3,'client',$4)`, [rowId, u, editor, uuid]);
    await expect(admin.query(`UPDATE user_roles SET role_id = $2 WHERE id = $1`, [rowId, staffRole])).rejects.toThrow(/may only carry/);
    // the shape CHECK: a client scope_id must be uuid-shaped
    await expect(
      admin.query(`INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id) VALUES ($1,$2,$3,'client','not-a-uuid')`, [newId(), u, editor]),
    ).rejects.toThrow(/scope_id_shape_check/);
    await expect(
      admin.query(`INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id) VALUES ($1,$2,$3,'client',NULL)`, [newId(), u, editor]),
    ).rejects.toThrow(/scope_id_shape_check/);
  });
});
