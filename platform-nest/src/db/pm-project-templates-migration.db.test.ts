// SCP-5h / W5-C3 — 202610301200_pm_project_templates.sql and 202610301201_social_settings_onboarding.sql (BFF §63.29.1, §63.29.2)
// against LIVE Postgres. Needs DATABASE_URL_TEST; skipped without it (the file-text checks at the top always run). initTestDb() hands
// us a fully migrated database; the CHECKs, FKs and the unique index are proved through the superuser pool (which bypasses RLS but
// never a CHECK, an FK or an index); the wall through the app role (`withGlobal` has no tenant GUC; `withTenants` sets one).
//
// Proves: pm_templates.kind admits 'project' and still refuses anything else (and NULL), with exactly one CHECK on kind; every NOT
// NULL column of pm_template_applications refuses NULL and every CHECK refuses its bad value; the composite FKs refuse another
// company's project and template; one LIVE application per project and template (a deleted one holds nothing); the unset-GUC read
// is ZERO rows and another company's context sees none; social_settings.onboarding_template_id is NULL on an existing row, takes
// a template and refuses an unknown id; both files apply again and change no existing row.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newId, withGlobal, withTenants } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createProject, createUser } from "../testing/fixtures";
import { pmModule } from "../modules/pm/index";
import { socialModule } from "../modules/social/index";

const PM_FILE = "202610301200_pm_project_templates.sql";
const SOCIAL_FILE = "202610301201_social_settings_onboarding.sql";
const pathOf = (f: string) => join(__dirname, "..", "..", "migrations", f);
const NOT_NULL = "23502";
const CHECK = "23514";
const FK = "23503";
const UNIQUE = "23505";

const codeOf = (sql: string) => sql.split("\n").map((l) => (l.includes("--") ? l.slice(0, l.indexOf("--")) : l)).join("\n");

describe("SCP-5h · the migration files (no database needed)", () => {
  it("are registered: the PM file in the PM module, the settings file in the Social module", () => {
    expect(pmModule.migrations).toContain(PM_FILE);
    expect(socialModule.migrations).toContain(SOCIAL_FILE);
  });

  it.each([PM_FILE, SOCIAL_FILE])("%s holds no data change, no grant and no ledger write, never counts rows, and is LF only", (f) => {
    const sql = readFileSync(pathOf(f), "utf8");
    const code = codeOf(sql);
    expect(code).not.toMatch(/^\s*INSERT\s+INTO\b/im);
    expect(code).not.toMatch(/^\s*UPDATE\s+\S+\s+SET\b/im);
    expect(code).not.toMatch(/^\s*DELETE\s+FROM\b/im);
    expect(code).not.toMatch(/\bTRUNCATE\b/i);
    expect(code).not.toMatch(/\bGRANT\b/i);
    expect(code).not.toMatch(/schema_migrations/i);
    expect(code).not.toMatch(/count\(\*\)[^;]*\bFROM\s+(pm_templates|pm_template_applications|social_settings)\b/i);
    expect(sql).not.toMatch(/\r/);
  });
});

describe.skipIf(!TEST_URL)("SCP-5h · pm_templates 'project', pm_template_applications, social_settings.onboarding_template_id", () => {
  let A: string;
  let B: string;
  let user: string;
  let projectA: string;
  let projectA2: string;
  let projectB: string;
  let templateA: string;
  let templateB: string;
  const pool = () => adminPool();
  const PAYLOAD = { title: "Mock", phases: [{ key: "p", title: "P" }], roles: [{ key: "r", label: "R" }], tasks: [{ key: "t", title: "T", phase: "p", role: "r", dueOffsetWorkingDays: 0 }] };

  const template = async (tenant: string, kind = "project"): Promise<string> => {
    const id = newId();
    await pool().query(`INSERT INTO pm_templates (id, tenant_id, kind, name, payload, origin_site) VALUES ($1, $2, $3, 'Mock template', $4, 'central')`,
      [id, tenant, kind, JSON.stringify(PAYLOAD)]);
    return id;
  };

  /** A valid row, with `over` replacing columns (a value of `undefined` leaves the default row's value). */
  const insertApp = async (over: Record<string, unknown> = {}): Promise<string> => {
    const row: Record<string, unknown> = {
      id: newId(), tenant_id: A, project_id: projectA, template_id: templateA, template_name: "Mock template", kickoff: "2026-12-24",
      people: JSON.stringify({ r: user }), tasks: JSON.stringify([{ key: "t", taskId: newId(), phase: "p" }]),
      milestones: JSON.stringify([{ phase: "p", milestoneId: newId() }]), template_payload: JSON.stringify(PAYLOAD), created_by: user,
      ...over,
    };
    const cols = Object.keys(row);
    await pool().query(
      `INSERT INTO pm_template_applications (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
      cols.map((c) => row[c]),
    );
    return row.id as string;
  };
  const refusedWith = async (p: Promise<unknown>, code: string, name?: string) => {
    const err = await p.then(() => null, (e: { code?: string; constraint?: string }) => e);
    expect(err, `expected ${code}${name ? ` (${name})` : ""}`).not.toBeNull();
    expect(err!.code).toBe(code);
    if (name) expect(err!.constraint).toBe(name);
  };

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("Mock Agency PTM", ["pm", "social"]);
    B = await createCompany("Mock Other PTM", ["pm"]);
    user = await createUser("ptm-user@a.test", "Mock User");
    projectA = await createProject(A, "Mock project");
    projectA2 = await createProject(A, "Mock project two");
    projectB = await createProject(B, "Mock other project");
    templateA = await template(A);
    templateB = await template(B);
  });
  afterAll(async () => { await teardownTestDb(); });

  it("pm_templates.kind admits project, task and doc and refuses anything else, NULL included; one CHECK on kind", async () => {
    for (const k of ["task", "doc", "project"]) await template(A, k);
    await refusedWith(template(A, "Project"), CHECK, "pm_templates_kind_ck");
    await refusedWith(template(A, "checklist"), CHECK, "pm_templates_kind_ck");
    await refusedWith(pool().query(`INSERT INTO pm_templates (id, tenant_id, kind, name, payload, origin_site) VALUES ($1, $2, NULL, 'x', '{}', 'central')`, [newId(), A]), NOT_NULL);
    const checks = await pool().query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'pm_templates'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ~ '\\mkind\\M'`);
    expect(checks.rows.map((r) => r.conname)).toEqual(["pm_templates_kind_ck"]);
  });

  it("a valid application is stored", async () => {
    const id = await insertApp();
    const r = await pool().query(`SELECT to_char(kickoff, 'YYYY-MM-DD') AS k, deleted_at, origin_site FROM pm_template_applications WHERE id = $1`, [id]);
    expect(r.rows[0]).toEqual({ k: "2026-12-24", deleted_at: null, origin_site: "central" });
    await pool().query(`UPDATE pm_template_applications SET deleted_at = now() WHERE id = $1`, [id]);
  });

  it.each(["tenant_id", "project_id", "template_id", "template_name", "kickoff", "people", "tasks", "milestones", "template_payload", "created_by"])(
    "%s refuses NULL", async (col) => {
      await refusedWith(insertApp({ [col]: null, project_id: col === "project_id" ? null : projectA2 }), NOT_NULL);
    },
  );

  it("each CHECK refuses its bad value", async () => {
    const p = { project_id: projectA2 };
    await refusedWith(insertApp({ ...p, template_name: "   " }), CHECK, "pm_template_applications_name_ck");
    await refusedWith(insertApp({ ...p, template_name: "" }), CHECK, "pm_template_applications_name_ck");
    await refusedWith(insertApp({ ...p, kickoff: "1999-12-31" }), CHECK, "pm_template_applications_kickoff_ck");
    await refusedWith(insertApp({ ...p, kickoff: "2101-01-01" }), CHECK, "pm_template_applications_kickoff_ck");
    await refusedWith(insertApp({ ...p, people: JSON.stringify([]) }), CHECK, "pm_template_applications_people_ck");
    await refusedWith(insertApp({ ...p, people: "null" }), CHECK, "pm_template_applications_people_ck"); // a JSON null, not SQL NULL
    await refusedWith(insertApp({ ...p, tasks: JSON.stringify([]) }), CHECK, "pm_template_applications_tasks_ck");
    await refusedWith(insertApp({ ...p, tasks: JSON.stringify({}) }), CHECK, "pm_template_applications_tasks_ck");
    await refusedWith(insertApp({ ...p, tasks: JSON.stringify(Array.from({ length: 81 }, () => ({}))) }), CHECK, "pm_template_applications_tasks_ck");
    await refusedWith(insertApp({ ...p, milestones: JSON.stringify({}) }), CHECK, "pm_template_applications_milestones_ck");
    await refusedWith(insertApp({ ...p, milestones: JSON.stringify(Array.from({ length: 13 }, () => ({}))) }), CHECK, "pm_template_applications_milestones_ck");
    await refusedWith(insertApp({ ...p, template_payload: JSON.stringify([]) }), CHECK, "pm_template_applications_payload_ck");
    // A payload missing a list: `->` reads SQL NULL and `jsonb_typeof(NULL) = 'array'` is NULL, which a CHECK PASSES. The file
    // COALESCEs each path to a failing value; this is the case that proves it.
    await refusedWith(insertApp({ ...p, template_payload: JSON.stringify({ phases: [], roles: [] }) }), CHECK, "pm_template_applications_payload_ck");
    await refusedWith(insertApp({ ...p, template_payload: JSON.stringify({ tasks: [], phases: [] }) }), CHECK, "pm_template_applications_payload_ck");
    await refusedWith(insertApp({ ...p, template_payload: JSON.stringify({ tasks: [], phases: null, roles: [] }) }), CHECK, "pm_template_applications_payload_ck");
    // The column's NOT NULL is the only guard against SQL NULL; a JSON null in a list column fails its CHECK, never raises.
    await refusedWith(insertApp({ ...p, tasks: "null" }), CHECK, "pm_template_applications_tasks_ck");
    await refusedWith(insertApp({ ...p, milestones: JSON.stringify("x") }), CHECK, "pm_template_applications_milestones_ck");
    // An empty milestone list is within the bound (0 to 12).
    const ok = await insertApp({ ...p, milestones: JSON.stringify([]) });
    await pool().query(`DELETE FROM pm_template_applications WHERE id = $1`, [ok]);
  });

  it("the composite FKs refuse another company's project and template, and an unknown one", async () => {
    await refusedWith(insertApp({ project_id: projectB }), FK, "fk_pm_template_applications_project_tenant");
    await refusedWith(insertApp({ project_id: projectA2, template_id: templateB }), FK, "fk_pm_template_applications_template_tenant");
    await refusedWith(insertApp({ project_id: projectA2, template_id: newId() }), FK, "fk_pm_template_applications_template_tenant");
    await refusedWith(insertApp({ project_id: projectA2, created_by: newId() }), FK);
  });

  it("one LIVE application per project and template; a deleted one holds nothing; another template or project is fine", async () => {
    const p = await createProject(A, "Mock unique project");
    const first = await insertApp({ project_id: p });
    await refusedWith(insertApp({ project_id: p }), UNIQUE, "ux_pm_template_applications_once");
    await insertApp({ project_id: p, template_id: await template(A) });
    await insertApp({ project_id: await createProject(A, "Mock unique two") });
    await pool().query(`UPDATE pm_template_applications SET deleted_at = now() WHERE id = $1`, [first]);
    await insertApp({ project_id: p });
    await refusedWith(insertApp({ project_id: p }), UNIQUE, "ux_pm_template_applications_once");
    await refusedWith(insertApp({ id: first, project_id: await createProject(A, "Mock pk") }), UNIQUE, "pm_template_applications_pkey");
  });

  it("the wall: the unset GUC reads ZERO rows (never an error) though rows exist; another company's context sees none and cannot write A's", async () => {
    const id = await insertApp({ project_id: await createProject(A, "Mock wall project") });
    expect(Number((await pool().query(`SELECT count(*)::int AS n FROM pm_template_applications`)).rows[0].n)).toBeGreaterThan(0);
    const unset = await withGlobal((c) => c.query(`SELECT count(*)::int AS n FROM pm_template_applications`));
    expect(unset.rows[0].n).toBe(0);
    const asB = await withTenants([B], (c) => c.query(`SELECT count(*)::int AS n FROM pm_template_applications WHERE id = $1`, [id]));
    expect(asB.rows[0].n).toBe(0);
    const asA = await withTenants([A], (c) => c.query(`SELECT count(*)::int AS n FROM pm_template_applications WHERE id = $1`, [id]));
    expect(asA.rows[0].n).toBe(1);
    await expect(withTenants([B], (c) => c.query(
      `INSERT INTO pm_template_applications (id, tenant_id, project_id, template_id, template_name, kickoff, people, tasks, milestones, template_payload, created_by)
       VALUES ($1, $2, $3, $4, 'x', '2026-12-24', '{}', '[{}]', '[]', $5, $6)`,
      [newId(), A, projectA, templateA, JSON.stringify(PAYLOAD), user]))).rejects.toThrow(/row-level security/);
  });

  it("social_settings.onboarding_template_id: NULL on an existing row, takes a template, refuses an unknown id, clears back to NULL", async () => {
    await pool().query(`INSERT INTO social_settings (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`, [A]);
    const r = await pool().query(`SELECT onboarding_template_id FROM social_settings WHERE tenant_id = $1`, [A]);
    expect(r.rows[0].onboarding_template_id).toBeNull();
    await pool().query(`UPDATE social_settings SET onboarding_template_id = $2 WHERE tenant_id = $1`, [A, templateA]);
    await refusedWith(pool().query(`UPDATE social_settings SET onboarding_template_id = $2 WHERE tenant_id = $1`, [A, newId()]), FK, "fk_social_settings_onboarding_template");
    await pool().query(`UPDATE social_settings SET onboarding_template_id = NULL WHERE tenant_id = $1`, [A]);
  });

  it("both files apply again on their own (plain psql semantics), change no existing row, and leave one of each constraint", async () => {
    await pool().query(`UPDATE social_settings SET onboarding_template_id = $2 WHERE tenant_id = $1`, [A, templateA]);
    const snap = async () => ({
      templates: (await pool().query(`SELECT id, kind, name, payload, updated_at FROM pm_templates ORDER BY id`)).rows,
      apps: (await pool().query(`SELECT * FROM pm_template_applications ORDER BY id`)).rows,
      settings: (await pool().query(`SELECT * FROM social_settings ORDER BY tenant_id`)).rows,
    });
    const before = await snap();
    await pool().query(readFileSync(pathOf(PM_FILE), "utf8"));
    await pool().query(readFileSync(pathOf(SOCIAL_FILE), "utf8"));
    expect(await snap()).toEqual(before);
    const cons = await pool().query(
      `SELECT conrelid::regclass::text AS t, conname FROM pg_constraint
        WHERE conname IN ('pm_templates_kind_ck', 'ux_pm_templates_id_tenant', 'fk_social_settings_onboarding_template')
           OR conname LIKE 'pm\\_template\\_applications\\_%' OR conname LIKE 'fk\\_pm\\_template\\_applications\\_%'
        ORDER BY conname`);
    expect(cons.rows.map((x) => x.conname)).toEqual([
      "fk_pm_template_applications_project_tenant", "fk_pm_template_applications_template_tenant", "fk_social_settings_onboarding_template",
      "pm_template_applications_created_by_fkey", "pm_template_applications_kickoff_ck", "pm_template_applications_milestones_ck",
      "pm_template_applications_name_ck", "pm_template_applications_payload_ck", "pm_template_applications_people_ck",
      "pm_template_applications_pkey", "pm_template_applications_tasks_ck", "pm_template_applications_tenant_id_fkey",
      "pm_templates_kind_ck", "ux_pm_templates_id_tenant",
    ]);
    const wall = await pool().query(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid IN ('pm_template_applications'::regclass, 'pm_templates'::regclass) ORDER BY relname`);
    expect(wall.rows).toEqual([
      { relname: "pm_template_applications", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "pm_templates", relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });
});
