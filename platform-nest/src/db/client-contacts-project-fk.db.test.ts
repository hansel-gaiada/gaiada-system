// PV4-13 — migration 202610132210: client_contacts.project_id must name a project of the contact's OWN client.
// Real Postgres (skips silently without DATABASE_URL_TEST; runs on the Linux gate).
//
// Before this, project_id was a plain FK to projects(id): a contact row could point at a project of ANOTHER client of
// the same tenant, and the portal scope kernel would read it as a reach into that project. The guard is a composite FK
// (project_id, client_id, tenant_id) -> projects (id, client_id, tenant_id), added NOT VALID.
//   (1) a valid row succeeds, a client-wide row (NULL project) skips the check;
//   (2) a project of another client, an internal project (no client) and another tenant's project all fail with 23503,
//       on INSERT and on an UPDATE that moves the project;
//   (3) the constraint is NOT VALID on purpose (an existing violating row is left alone and can still be revoked),
//       and the migration's REAL text, run against a table that already holds a violation, does not fail, reports ONE
//       count and re-adds the constraint NOT VALID.
//
// Teeth: drop the constraint (or the composite) and (2) fails with a successful insert.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newId } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, createClient, createProject } from "../testing/fixtures";

const NAME = "fk_client_contacts_project_client_tenant";
const MIGRATION_SQL = readFileSync(
  join(__dirname, "..", "..", "migrations", "202610132210_pv4_client_contacts_project_client_fk.sql"),
  "utf8",
);

describe.skipIf(!TEST_URL)("PV4-13 client_contacts.project_id belongs to the contact's client", () => {
  let tenant: string;
  let otherTenant: string;
  let clientA: string;
  let clientB: string;
  let projectA: string;
  let projectB: string;
  let projectInternal: string;
  let projectOtherTenant: string;
  let user: string;

  const insert = (o: { tenantId?: string; clientId: string; projectId: string | null; userId?: string }) =>
    adminPool().query(
      `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, origin_site)
       VALUES ($1, $2, $3, $4, $5, 'viewer', 'active', 'test')`,
      [newId(), o.tenantId ?? tenant, o.clientId, o.userId ?? user, o.projectId],
    );
  const code = async (p: Promise<unknown>): Promise<string | undefined> => {
    try {
      await p;
      return undefined;
    } catch (e) {
      return (e as { code?: string }).code;
    }
  };

  beforeAll(async () => {
    await initTestDb();
    tenant = await createCompany("FK Co");
    otherTenant = await createCompany("Other FK Co");
    user = await createUser("fk-contact@fk.test");
    clientA = await createClient(tenant, "FK Client A");
    clientB = await createClient(tenant, "FK Client B");
    projectA = await createProject(tenant, "A project", undefined, clientA);
    projectB = await createProject(tenant, "B project", undefined, clientB);
    projectInternal = await createProject(tenant, "Internal project");
    const otherClient = await createClient(otherTenant, "Other tenant client");
    projectOtherTenant = await createProject(otherTenant, "Other tenant project", undefined, otherClient);
  }, 120_000);
  afterAll(teardownTestDb);

  it("a contact on a project of its OWN client is accepted; a client-wide contact (NULL project) skips the check", async () => {
    expect(await code(insert({ clientId: clientA, projectId: projectA }))).toBeUndefined();
    expect(await code(insert({ clientId: clientB, projectId: null }))).toBeUndefined();
  });

  it("a contact naming a project of ANOTHER client of the same tenant is refused: 23503", async () => {
    expect(await code(insert({ clientId: clientA, projectId: projectB }))).toBe("23503");
    expect(await code(insert({ clientId: clientB, projectId: projectA }))).toBe("23503");
  });

  it("an internal project (no client) and another tenant's project are refused: 23503", async () => {
    expect(await code(insert({ clientId: clientA, projectId: projectInternal }))).toBe("23503");
    expect(await code(insert({ clientId: clientA, projectId: projectOtherTenant }))).toBe("23503");
  });

  it("moving an existing contact onto another client's project is refused on UPDATE too", async () => {
    const id = newId();
    const otherUser = await createUser("fk-mover@fk.test");
    await adminPool().query(
      `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, origin_site)
       VALUES ($1, $2, $3, $4, $5, 'viewer', 'active', 'test')`,
      [id, tenant, clientA, otherUser, projectA],
    );
    expect(await code(adminPool().query(`UPDATE client_contacts SET project_id = $2 WHERE id = $1`, [id, projectB]))).toBe("23503");
    // ...and re-assigning the PROJECT to another client while a contact still points at it is refused as well.
    expect(await code(adminPool().query(`UPDATE projects SET client_id = $2 WHERE id = $1`, [projectA, clientB]))).toBe("23503");
  });

  it("the constraint exists, is composite over (project_id, client_id, tenant_id) and is NOT VALID on purpose", async () => {
    const { rows } = await adminPool().query<{ def: string; convalidated: boolean }>(
      `SELECT pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint
        WHERE conrelid = 'client_contacts'::regclass AND conname = $1`,
      [NAME],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].def).toContain("FOREIGN KEY (project_id, client_id, tenant_id)");
    expect(rows[0].def).toContain("REFERENCES projects(id, client_id, tenant_id)");
    // Not validated here: a later, deliberate step once the deploy-log count is 0 on live (migration header).
    expect(rows[0].convalidated).toBe(false);
  });

  it("the migration's real text, run over a table that ALREADY holds a violation, does not fail, counts it once and re-adds the FK NOT VALID", async () => {
    const pool = adminPool();
    const bad = newId();
    const okId = newId();
    const badUser = await createUser("fk-legacy@fk.test");
    await pool.query(`ALTER TABLE client_contacts DROP CONSTRAINT ${NAME}`);
    // A legacy cross-client row, and a legitimate one that must NOT be counted.
    await pool.query(
      `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, origin_site)
       VALUES ($1, $2, $3, $4, $5, 'viewer', 'active', 'test'), ($6, $2, $3, $4, NULL, 'viewer', 'active', 'test')`,
      [bad, tenant, clientA, badUser, projectB, okId],
    );
    const before = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM client_contacts cc WHERE cc.project_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM projects p WHERE p.id = cc.project_id AND p.client_id = cc.client_id AND p.tenant_id = cc.tenant_id)`,
    );
    const expected = Number(before.rows[0].n);
    expect(expected).toBeGreaterThanOrEqual(1);

    const client = await pool.connect();
    const notices: string[] = [];
    client.on("notice", (n) => notices.push(n.message ?? ""));
    try {
      await client.query("BEGIN");
      await client.query(MIGRATION_SQL);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const count = notices.filter((m) => m.startsWith("[PV4-13]"));
    expect(count).toHaveLength(1);
    expect(count[0]).toContain(`: ${expected} row(s)`);
    // Names no id and no row, only the number.
    expect(count[0]).not.toContain(bad);

    const { rows } = await pool.query<{ convalidated: boolean }>(
      `SELECT convalidated FROM pg_constraint WHERE conrelid = 'client_contacts'::regclass AND conname = $1`,
      [NAME],
    );
    expect(rows).toEqual([{ convalidated: false }]);
    // The legacy row is untouched and, the constraint being NOT VALID, can still be revoked: an UPDATE that leaves the
    // key columns alone is not checked.
    await pool.query(`UPDATE client_contacts SET status = 'revoked' WHERE id = $1`, [bad]);
    // New violations are refused again.
    expect(await code(insert({ clientId: clientA, projectId: projectB }))).toBe("23503");
  });
});
