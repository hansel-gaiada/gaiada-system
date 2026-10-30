// SCP-5f / W5-C1 — 202610301310_pm_task_cycle_steps.sql (BFF §63.27.1) against LIVE Postgres. Needs DATABASE_URL_TEST; skipped without
// it (the file-text checks at the top always run). initTestDb() hands us a fully migrated database; the CHECKs and the unique index are
// proved through the superuser pool (which bypasses RLS but never a CHECK or an index), the wall through the app role (`withGlobal` has no
// tenant GUC; `withTenants` sets one), and the file is re-applied the way CI's sync-engine-go job applies every migration: plain `psql -f`
// semantics, no ledger (here: one multi-statement simple query).
//
// Proves: the type admits 'social_cycle_step' and still admits the old two (and NULL), and nothing else; the step is set exactly for the
// step kind, with the NULL cases (a step task with no step; a step on a post task, a content-month task and an unlinked task) refused and
// a bad key shape refused; one LIVE task per step and cycle (a deleted one holds nothing; another step, another cycle and another company
// are fine), the content-month index untouched; the unset GUC reads ZERO step tasks though they exist; the file applies again and changes
// no row.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newId, withGlobal, withTenants } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createProject } from "../testing/fixtures";
import { pmModule } from "../modules/pm/index";

const MIGRATION = "202610301310_pm_task_cycle_steps.sql";
const PATH = join(__dirname, "..", "..", "migrations", MIGRATION);
const CHECK = "23514";
const UNIQUE = "23505";

describe("SCP-5f · the migration file (no database needed)", () => {
  const sql = readFileSync(PATH, "utf8");
  const code = sql.split("\n").map((l) => (l.includes("--") ? l.slice(0, l.indexOf("--")) : l)).join("\n");

  it("is registered in the PM module, after the links file it widens", () => {
    expect(pmModule.migrations).toContain(MIGRATION);
    expect(pmModule.migrations.indexOf(MIGRATION)).toBeGreaterThan(pmModule.migrations.indexOf("202610271410_pm_task_links.sql"));
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

  it("redeclares only the single-column type CHECK, DROP and ADD in one ALTER, and leaves the pair CHECK alone", () => {
    expect(code).toMatch(/DROP CONSTRAINT IF EXISTS pm_tasks_linked_type_ck,\s*ADD CONSTRAINT pm_tasks_linked_type_ck CHECK/);
    expect(code).not.toMatch(/DROP CONSTRAINT IF EXISTS pm_tasks_linked_pair_ck/);
  });
});

describe.skipIf(!TEST_URL)("SCP-5f · pm_tasks step tasks", () => {
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

  async function insert(over: { tenant?: string; type?: string | null; linkedId?: string | null; step?: string | null; deleted?: boolean } = {}): Promise<string> {
    const id = newId();
    const tenant = over.tenant ?? A;
    await pool().query(
      `INSERT INTO pm_tasks (id, tenant_id, project_id, title, origin_site, linked_type, linked_id, linked_step, deleted_at)
       VALUES ($1, $2, $3, 'Mock task', 'central', $4, $5, $6, CASE WHEN $7::boolean THEN now() ELSE NULL END)`,
      [id, tenant, tenant === A ? projectA : projectB, over.type ?? null, over.linkedId ?? null, over.step ?? null, over.deleted === true],
    );
    return id;
  }
  const refusedWith = async (p: Promise<unknown>, code: string, name: string) => {
    const err = await p.then(() => null, (e: { code?: string; constraint?: string }) => e);
    expect(err, `expected ${code} (${name})`).not.toBeNull();
    expect(err!.code).toBe(code);
    expect(err!.constraint).toBe(name);
  };

  it("a row written the way every route writes it (no link) reads no step", async () => {
    const id = newId();
    await pool().query(`INSERT INTO pm_tasks (id, tenant_id, project_id, title, origin_site) VALUES ($1, $2, $3, 'Mock task', 'central')`, [id, A, projectA]);
    const r = await pool().query(`SELECT linked_type, linked_id, linked_step FROM pm_tasks WHERE id = $1`, [id]);
    expect(r.rows[0]).toEqual({ linked_type: null, linked_id: null, linked_step: null });
  });

  it("the type admits social_cycle_step, still admits the old two and NULL, and nothing else", async () => {
    await insert({ type: "social_cycle_step", linkedId: newId(), step: "planning" });
    await insert({ type: "social_post", linkedId: newId() });
    await insert({ type: "social_cycle", linkedId: newId() });
    await insert({});
    await refusedWith(insert({ type: "social_cycle_steps", linkedId: newId() }), CHECK, "pm_tasks_linked_type_ck");
    await refusedWith(insert({ type: "SOCIAL_CYCLE_STEP", linkedId: newId() }), CHECK, "pm_tasks_linked_type_ck");
    await refusedWith(insert({ type: "deal", linkedId: newId() }), CHECK, "pm_tasks_linked_type_ck");
  });

  it("the NULL cases: a step task without a step, and a step on any other row, are refused", async () => {
    // a social_cycle_step task with no step
    await refusedWith(insert({ type: "social_cycle_step", linkedId: newId(), step: null }), CHECK, "pm_tasks_linked_step_ck");
    // a step on a post task, a content-month task, and an unlinked task (linked_type NULL: IS NOT DISTINCT FROM decides it, never NULL)
    await refusedWith(insert({ type: "social_post", linkedId: newId(), step: "planning" }), CHECK, "pm_tasks_linked_step_ck");
    await refusedWith(insert({ type: "social_cycle", linkedId: newId(), step: "planning" }), CHECK, "pm_tasks_linked_step_ck");
    await refusedWith(insert({ type: null, linkedId: null, step: "planning" }), CHECK, "pm_tasks_linked_step_ck");
    // the pair CHECK still holds for the new kind
    await refusedWith(insert({ type: "social_cycle_step", linkedId: null, step: "planning" }), CHECK, "pm_tasks_linked_pair_ck");
  });

  it("a step has the rules' key shape", async () => {
    for (const ok of ["report", "client_window", "a", `s${"x".repeat(39)}`]) await insert({ type: "social_cycle_step", linkedId: newId(), step: ok });
    for (const bad of ["", "Planning", "1st", "copy-lock", "copy lock", `s${"x".repeat(40)}`, "_lead"]) {
      await refusedWith(insert({ type: "social_cycle_step", linkedId: newId(), step: bad }), CHECK, "pm_tasks_linked_step_value_ck");
    }
  });

  it("an UPDATE is held to the same checks", async () => {
    const id = await insert({ type: "social_cycle_step", linkedId: newId(), step: "artwork" });
    await refusedWith(pool().query(`UPDATE pm_tasks SET linked_step = NULL WHERE id = $1`, [id]), CHECK, "pm_tasks_linked_step_ck");
    await refusedWith(pool().query(`UPDATE pm_tasks SET linked_type = 'social_cycle' WHERE id = $1`, [id]), CHECK, "pm_tasks_linked_step_ck");
    await pool().query(`UPDATE pm_tasks SET linked_step = 'deploy' WHERE id = $1`, [id]);
  });

  it("one live task per step and cycle; a deleted one holds nothing; another step, cycle or company is fine; the content-month index is its own", async () => {
    const cycle = newId();
    await insert({ type: "social_cycle_step", linkedId: cycle, step: "planning" });
    await refusedWith(insert({ type: "social_cycle_step", linkedId: cycle, step: "planning" }), UNIQUE, "ux_pm_tasks_social_cycle_step");
    await insert({ type: "social_cycle_step", linkedId: cycle, step: "artwork" });
    await insert({ type: "social_cycle_step", linkedId: newId(), step: "planning" });
    await insert({ tenant: B, type: "social_cycle_step", linkedId: cycle, step: "planning" });
    // The cycle's content-month task beside its steps (same linked_id, its own kind and index).
    await insert({ type: "social_cycle", linkedId: cycle });
    await refusedWith(insert({ type: "social_cycle", linkedId: cycle }), UNIQUE, "ux_pm_tasks_social_cycle");
    const gone = newId();
    await insert({ type: "social_cycle_step", linkedId: gone, step: "deploy", deleted: true });
    await insert({ type: "social_cycle_step", linkedId: gone, step: "deploy" });
    await insert({ type: "social_cycle_step", linkedId: gone, step: "deploy", deleted: true });
  });

  it("the indexes are as the file says", async () => {
    const r = await pool().query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'pm_tasks' AND indexname IN ('ux_pm_tasks_social_cycle', 'ux_pm_tasks_social_cycle_step') ORDER BY indexname`,
    );
    expect(r.rows.map((x) => x.indexname)).toEqual(["ux_pm_tasks_social_cycle", "ux_pm_tasks_social_cycle_step"]);
    const month = r.rows[0].indexdef as string;
    expect(month).toContain("(tenant_id, linked_id)");
    expect(month).not.toContain("social_cycle_step");
    const step = r.rows[1].indexdef as string;
    expect(step).toContain("CREATE UNIQUE INDEX");
    expect(step).toContain("(tenant_id, linked_id, linked_step)");
    expect(step).toContain("'social_cycle_step'::text");
    expect(step).toContain("deleted_at IS NULL");
  });

  it("the wall: the unset GUC reads ZERO step tasks (never an error) though they exist; another company sees none", async () => {
    const id = await insert({ type: "social_cycle_step", linkedId: newId(), step: "report" });
    const all = await pool().query(`SELECT count(*)::int AS n FROM pm_tasks WHERE linked_type = 'social_cycle_step'`);
    expect(all.rows[0].n).toBeGreaterThan(0);
    const unset = await withGlobal((c) => c.query(`SELECT count(*)::int AS n FROM pm_tasks WHERE linked_type = 'social_cycle_step'`));
    expect(unset.rows[0].n).toBe(0);
    const asB = await withTenants([B], (c) => c.query(`SELECT count(*)::int AS n FROM pm_tasks WHERE id = $1`, [id]));
    expect(asB.rows[0].n).toBe(0);
    const asA = await withTenants([A], (c) => c.query(`SELECT linked_step FROM pm_tasks WHERE id = $1`, [id]));
    expect(asA.rows).toEqual([{ linked_step: "report" }]);
  });

  it("applies again on its own with plain psql semantics, changes no row, and leaves one of each constraint and the wall", async () => {
    await insert({ type: "social_cycle_step", linkedId: newId(), step: "copy_lock" });
    const snap = async () => (await pool().query(
      `SELECT id, linked_type, linked_id, linked_step, title, status, progress, due_date, deleted_at, updated_at FROM pm_tasks ORDER BY id`,
    )).rows;
    const before = await snap();
    await pool().query(readFileSync(PATH, "utf8"));
    expect(await snap()).toEqual(before);
    const cons = await pool().query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'pm_tasks'::regclass AND conname LIKE 'pm\\_tasks\\_linked\\_%' ORDER BY conname`,
    );
    expect(cons.rows.map((x) => x.conname)).toEqual(["pm_tasks_linked_pair_ck", "pm_tasks_linked_step_ck", "pm_tasks_linked_step_value_ck", "pm_tasks_linked_type_ck"]);
    const wall = await pool().query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'pm_tasks'::regclass`);
    expect(wall.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });
});
