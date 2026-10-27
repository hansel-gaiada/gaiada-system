// SCP-1n — 202610271410_pm_task_links.sql (BFF §63.1 item 5) against LIVE Postgres. Needs DATABASE_URL_TEST; skipped without it (the
// file-text checks at the top always run). initTestDb() hands us a fully migrated database; the CHECKs and the unique index are
// proved through the superuser pool, which bypasses RLS but never a CHECK or an index, and the file is re-applied the way CI's
// sync-engine-go job applies every migration: plain `psql -f` semantics, no ledger (here: one multi-statement simple query).
//
// Proves: a row written the way today's routes write it (no link) reads NULL and NULL; the type is social_post or social_cycle and
// nothing else; the pair is all-or-nothing (a type with no id, and an id with no type, are refused); one LIVE content-month task per
// cycle (a second is refused, a deleted one holds nothing, another company's same id is fine); a post may carry many tasks; the file
// applies again without error and changes nothing; the indexes and the wall are as the file says.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newId } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createProject } from "../testing/fixtures";
import { pmModule } from "../modules/pm/index";

const MIGRATION = "202610271410_pm_task_links.sql";
const PATH = join(__dirname, "..", "..", "migrations", MIGRATION);

describe("SCP-1n · the migration file (no database needed)", () => {
  const sql = readFileSync(PATH, "utf8");
  const code = sql.split("\n").map((l) => (l.includes("--") ? l.slice(0, l.indexOf("--")) : l)).join("\n");

  it("is registered in the PM module", () => {
    expect(pmModule.migrations).toContain(MIGRATION);
  });

  it("holds no data changes, no grant, no foreign key and no ledger write, and is LF only", () => {
    expect(code).not.toMatch(/^\s*INSERT\s+INTO\b/im);
    expect(code).not.toMatch(/^\s*UPDATE\s+\S+\s+SET\b/im);
    expect(code).not.toMatch(/^\s*DELETE\s+FROM\b/im);
    expect(code).not.toMatch(/\bTRUNCATE\b/i);
    expect(code).not.toMatch(/\bGRANT\b/i);
    expect(code).not.toMatch(/\bREFERENCES\b/i);
    expect(code).not.toMatch(/schema_migrations/i);
    expect(sql).not.toMatch(/\r/);
  });

  it("never counts rows of the FORCE-RLS table (the unset-GUC zero-row trap): it asserts the catalogue", () => {
    expect(code).not.toMatch(/count\(\*\)[^;]*\bFROM\s+pm_tasks\b/i);
  });
});

describe.skipIf(!TEST_URL)("SCP-1n · pm_tasks links", () => {
  let A: string;
  let B: string;
  let projectA: string;
  let projectB: string;
  const pool = () => adminPool();

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("Mock Agency", ["pm"]);
    B = await createCompany("Mock Other Co", ["pm"]);
    projectA = await createProject(A, "Mock content project");
    projectB = await createProject(B, "Mock other project");
  });
  afterAll(async () => { await teardownTestDb(); });

  async function insert(over: { tenant?: string; project?: string; type?: string | null; linkedId?: string | null; omit?: boolean; deleted?: boolean } = {}) {
    const id = newId();
    const tenant = over.tenant ?? A;
    const project = over.project ?? (tenant === A ? projectA : projectB);
    if (over.omit) {
      // What every insert path writes today: no link columns at all.
      await pool().query(`INSERT INTO pm_tasks (id, tenant_id, project_id, title, origin_site) VALUES ($1, $2, $3, 'Mock task', 'central')`, [id, tenant, project]);
    } else {
      await pool().query(
        `INSERT INTO pm_tasks (id, tenant_id, project_id, title, origin_site, linked_type, linked_id, deleted_at)
         VALUES ($1, $2, $3, 'Mock task', 'central', $4, $5, CASE WHEN $6::boolean THEN now() ELSE NULL END)`,
        [id, tenant, project, over.type === undefined ? null : over.type, over.linkedId === undefined ? null : over.linkedId, over.deleted === true],
      );
    }
    return id;
  }
  const refuses = (p: Promise<unknown>, name: string) => expect(p).rejects.toThrow(new RegExp(`violates check constraint "${name}"`));

  it("a row written the way today's routes write it reads no link", async () => {
    const id = await insert({ omit: true });
    const r = await pool().query(`SELECT linked_type, linked_id FROM pm_tasks WHERE id = $1`, [id]);
    expect(r.rows[0]).toEqual({ linked_type: null, linked_id: null });
  });

  it("the type is social_post or social_cycle, nothing else", async () => {
    await insert({ type: "social_post", linkedId: newId() });
    await insert({ type: "social_cycle", linkedId: newId() });
    await refuses(insert({ type: "deal", linkedId: newId() }), "pm_tasks_linked_type_ck");
    await refuses(insert({ type: "", linkedId: newId() }), "pm_tasks_linked_type_ck");
    await refuses(insert({ type: "SOCIAL_POST", linkedId: newId() }), "pm_tasks_linked_type_ck");
  });

  it("the pair is all or nothing: a type with no id and an id with no type are both refused", async () => {
    await refuses(insert({ type: "social_post", linkedId: null }), "pm_tasks_linked_pair_ck");
    await refuses(insert({ type: "social_cycle", linkedId: null }), "pm_tasks_linked_pair_ck");
    await refuses(insert({ type: null, linkedId: newId() }), "pm_tasks_linked_pair_ck");
    await insert({ type: null, linkedId: null });
  });

  it("an UPDATE is held to the same checks", async () => {
    const id = await insert({});
    await expect(pool().query(`UPDATE pm_tasks SET linked_type = 'social_post' WHERE id = $1`, [id])).rejects.toThrow(/pm_tasks_linked_pair_ck/);
    await expect(pool().query(`UPDATE pm_tasks SET linked_id = $2 WHERE id = $1`, [id, newId()])).rejects.toThrow(/pm_tasks_linked_pair_ck/);
    await pool().query(`UPDATE pm_tasks SET linked_type = 'social_post', linked_id = $2 WHERE id = $1`, [id, newId()]);
    await pool().query(`UPDATE pm_tasks SET linked_type = NULL, linked_id = NULL WHERE id = $1`, [id]);
  });

  it("one live content-month task per cycle; a deleted one holds nothing; another company's same id is fine", async () => {
    const cycle = newId();
    await insert({ type: "social_cycle", linkedId: cycle });
    await expect(insert({ type: "social_cycle", linkedId: cycle })).rejects.toThrow(/ux_pm_tasks_social_cycle/);
    // A deleted task is out of the index, and a deleted row never blocks a live one.
    const gone = newId();
    await insert({ type: "social_cycle", linkedId: gone, deleted: true });
    await insert({ type: "social_cycle", linkedId: gone });
    await insert({ type: "social_cycle", linkedId: gone, deleted: true });
    // Another company may carry the same id (the key leads with tenant_id).
    await insert({ tenant: B, type: "social_cycle", linkedId: cycle });
  });

  it("a post may carry many tasks (the uniqueness is for the cycle kind only)", async () => {
    const post = newId();
    await insert({ type: "social_post", linkedId: post });
    await insert({ type: "social_post", linkedId: post });
    await insert({ type: "social_post", linkedId: post });
    const r = await pool().query(`SELECT count(*)::int AS n FROM pm_tasks WHERE tenant_id = $1 AND linked_type = 'social_post' AND linked_id = $2`, [A, post]);
    expect(r.rows[0].n).toBe(3);
  });

  it("the indexes are as the file says", async () => {
    const r = await pool().query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'pm_tasks' AND indexname IN ('ux_pm_tasks_social_cycle', 'ix_pm_tasks_linked') ORDER BY indexname`,
    );
    expect(r.rows.map((x) => x.indexname)).toEqual(["ix_pm_tasks_linked", "ux_pm_tasks_social_cycle"]);
    const lookup = r.rows[0].indexdef as string;
    expect(lookup).toContain("(tenant_id, linked_type, linked_id)");
    expect(lookup).toContain("linked_type IS NOT NULL");
    expect(lookup).toContain("deleted_at IS NULL");
    expect(lookup).not.toContain("UNIQUE");
    const uniq = r.rows[1].indexdef as string;
    expect(uniq).toContain("CREATE UNIQUE INDEX");
    expect(uniq).toContain("(tenant_id, linked_id)");
    expect(uniq).toContain("social_cycle");
    expect(uniq).toContain("deleted_at IS NULL");
  });

  it("applies again on its own with plain psql semantics, changes no row, and leaves one of each constraint and the wall", async () => {
    const id = await insert({ type: "social_post", linkedId: newId() });
    const before = await pool().query(`SELECT linked_type, linked_id, title FROM pm_tasks WHERE id = $1`, [id]);
    await pool().query(readFileSync(PATH, "utf8"));
    const after = await pool().query(`SELECT linked_type, linked_id, title FROM pm_tasks WHERE id = $1`, [id]);
    expect(after.rows).toEqual(before.rows);
    const cons = await pool().query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'pm_tasks'::regclass AND conname LIKE 'pm\\_tasks\\_linked\\_%' ORDER BY conname`,
    );
    expect(cons.rows.map((x) => x.conname)).toEqual(["pm_tasks_linked_pair_ck", "pm_tasks_linked_type_ck"]);
    const wall = await pool().query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'pm_tasks'::regclass`);
    expect(wall.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });
});
