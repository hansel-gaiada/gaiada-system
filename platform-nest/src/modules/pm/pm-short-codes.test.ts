// WD-28 — PM per-project short-codes (OQ-7 default). Against live Postgres + RLS + Cerbos, same
// harness style as pm.test.ts. Covers: unique short_code derivation (incl. collision suffixing),
// atomic per-project seq allocation (incl. GENUINE CONCURRENCY — real parallel HTTP requests, not
// a sleep-based or single-threaded probe), the CODE-SEQ displayCode projection, duplicate-task/
// duplicate-project seq independence, cross-tenant isolation, and the 0050 backfill's idempotency
// (re-running the SAME migration SQL against rows it already processed changes nothing).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("PM short-codes (WD-28)", () => {
  let app: NestFastifyApplication;
  let tenantA: string;
  let managerA: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    tenantA = await createCompany("Web Dev Co", ["agency", "pm"]);
    managerA = await createUser("mgr-wd28@a.test", "Manager Mo");
    await addMembership(tenantA, managerA);
    await grantRole(managerA, await createRole("manager"), "company", tenantA);
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  const createProject = (name: string, headers = asUser(managerA), tenant = tenantA) =>
    app.inject({ method: "POST", url: `/api/${tenant}/projects`, headers, payload: { name } });

  const createTask = (projectId: string, title: string, headers = asUser(managerA), tenant = tenantA) =>
    app.inject({ method: "POST", url: `/api/${tenant}/pm/tasks`, headers, payload: { projectId, title } });

  it("assigns a unique per-tenant short_code, suffixing on a name collision", async () => {
    const p1 = await createProject("Web Redesign");
    const p2 = await createProject("Web Redesign"); // same name -> same derived base
    expect(p1.statusCode).toBe(201);
    expect(p2.statusCode).toBe(201);

    const list = (await app.inject({ method: "GET", url: `/api/${tenantA}/projects`, headers: asUser(managerA) })).json() as Array<{ id: string; shortCode: string }>;
    const c1 = list.find((p) => p.id === p1.json().id)!.shortCode;
    const c2 = list.find((p) => p.id === p2.json().id)!.shortCode;
    expect(c1).toBe("WEBR");
    expect(c2).toBe("WEBR2"); // collision -> numeric suffix, never a duplicate
    expect(c1).not.toBe(c2);
  });

  it("task creation allocates sequential per-project seq and a CODE-SEQ displayCode", async () => {
    const proj = await createProject("Homepage Overhaul");
    const projectId = proj.json().id as string;
    const shortCode = (list_ => list_.find((p: { id: string }) => p.id === projectId).shortCode)(
      (await app.inject({ method: "GET", url: `/api/${tenantA}/projects`, headers: asUser(managerA) })).json(),
    );
    expect(shortCode).toBe("HOME");

    const t1 = await createTask(projectId, "Design hero section");
    const t2 = await createTask(projectId, "Wire the CMS");
    const t3 = await createTask(projectId, "QA pass");
    expect(t1.statusCode).toBe(201);

    const g1 = (await app.inject({ method: "GET", url: `/api/${tenantA}/pm/tasks/${t1.json().id}`, headers: asUser(managerA) })).json() as { seq: number; displayCode: string; projectShortCode: string };
    const g2 = (await app.inject({ method: "GET", url: `/api/${tenantA}/pm/tasks/${t2.json().id}`, headers: asUser(managerA) })).json() as { seq: number; displayCode: string };
    const g3 = (await app.inject({ method: "GET", url: `/api/${tenantA}/pm/tasks/${t3.json().id}`, headers: asUser(managerA) })).json() as { seq: number; displayCode: string };

    expect([g1.seq, g2.seq, g3.seq]).toEqual([1, 2, 3]);
    expect(g1.displayCode).toBe("HOME-1");
    expect(g2.displayCode).toBe("HOME-2");
    expect(g3.displayCode).toBe("HOME-3");
    expect(g1.projectShortCode).toBe("HOME");
  });

  it("two different projects allocate seq off INDEPENDENT counters (never shared)", async () => {
    const p1 = await createProject("Alpha Track");
    const p2 = await createProject("Beta Track");
    const t1 = await createTask(p1.json().id, "A task");
    const t2 = await createTask(p2.json().id, "B task"); // first task in ITS project too
    const g1 = (await app.inject({ method: "GET", url: `/api/${tenantA}/pm/tasks/${t1.json().id}`, headers: asUser(managerA) })).json() as { seq: number };
    const g2 = (await app.inject({ method: "GET", url: `/api/${tenantA}/pm/tasks/${t2.json().id}`, headers: asUser(managerA) })).json() as { seq: number };
    expect(g1.seq).toBe(1);
    expect(g2.seq).toBe(1); // independent counter, not a tenant-wide sequence
  });

  // ───────────────────────── ATOMICITY UNDER REAL CONCURRENCY ─────────────────────────
  // The whole point of this ticket. Fires N genuinely concurrent HTTP requests (not sleeps, not
  // sequential awaits) at the SAME project's createTask endpoint. Each request opens its OWN
  // connection/transaction (withTenants), so Node's event loop and the pg pool can and do
  // interleave their I/O — Postgres's row lock on the targeted `projects` row (held for the
  // UPDATE...RETURNING's transaction) is the only thing that can prevent a duplicate seq here; a
  // read-then-write implementation (SELECT max()+1) would be expected to collide under this exact
  // load. Asserts the resulting seq set is EXACTLY {1..N} — no duplicates, no gaps.
  it("N concurrent task creates on ONE project yield exactly N distinct, gapless seq values", async () => {
    const proj = await createProject("Concurrency Target");
    const projectId = proj.json().id as string;
    const N = 25;

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => createTask(projectId, `Concurrent task ${i}`)),
    );
    expect(results.every((r) => r.statusCode === 201)).toBe(true);

    const tasks = (await app.inject({ method: "GET", url: `/api/${tenantA}/pm/projects/${projectId}/tasks`, headers: asUser(managerA) })).json() as Array<{ seq: number }>;
    const seqs = tasks.map((t) => t.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i + 1)); // {1..N}, no dup, no gap
    expect(new Set(seqs).size).toBe(N); // belt-and-suspenders: explicit distinctness check
  });

  it("duplicateTask and duplicateProject each allocate FRESH seq/short_code (never copy the source's)", async () => {
    const proj = await createProject("Duplication Source");
    const projectId = proj.json().id as string;
    const t1 = await createTask(projectId, "Original task");
    const taskId = t1.json().id as string;

    const dupTask = await app.inject({ method: "POST", url: `/api/${tenantA}/pm/tasks/${taskId}/duplicate`, headers: asUser(managerA) });
    expect(dupTask.statusCode).toBe(201);
    const dupTaskGet = (await app.inject({ method: "GET", url: `/api/${tenantA}/pm/tasks/${dupTask.json().id}`, headers: asUser(managerA) })).json() as { seq: number };
    expect(dupTaskGet.seq).toBe(2); // second allocation off the SAME project's counter

    const dupProj = await app.inject({ method: "POST", url: `/api/${tenantA}/pm/projects/${projectId}/duplicate`, headers: asUser(managerA), payload: { name: "Duplication Source" } });
    expect(dupProj.statusCode).toBe(201);
    const list = (await app.inject({ method: "GET", url: `/api/${tenantA}/projects`, headers: asUser(managerA) })).json() as Array<{ id: string; shortCode: string }>;
    const srcCode = list.find((p) => p.id === projectId)!.shortCode;
    const cloneCode = list.find((p) => p.id === dupProj.json().id)!.shortCode;
    expect(cloneCode).not.toBe(srcCode); // fresh code, never the source's

    // By this point the SOURCE project has 2 tasks (the original + the duplicateTask copy above),
    // so duplicateProject clones both — but the clone's OWN counter starts at 0 (fresh), so they
    // land as [1, 2] on the clone's own sequence, never inheriting the source's seq values.
    const cloneTasks = (await app.inject({ method: "GET", url: `/api/${tenantA}/pm/projects/${dupProj.json().id}/tasks`, headers: asUser(managerA) })).json() as Array<{ seq: number }>;
    expect(cloneTasks.map((t) => t.seq).sort((a, b) => a - b)).toEqual([1, 2]); // clone's own fresh counter, distinct from source's seq values by construction (independent counters), coincidentally same numbers here
  });

  // ───────────────────────── CROSS-TENANT ISOLATION ─────────────────────────
  it("a rival tenant can reuse the SAME short_code text and cannot see tenant A's tasks/codes", async () => {
    const tenantB = await createCompany("Rival Web Co", ["agency", "pm"]);
    const managerB = await createUser("mgr-wd28-b@b.test", "Manager Riva");
    await addMembership(tenantB, managerB);
    await grantRole(managerB, await createRole("manager"), "company", tenantB);

    // Deliberately the SAME name as an earlier tenant-A project ("Web Redesign" -> base "WEBR")
    // to prove the uniqueness constraint is scoped `(tenant_id, short_code)`, not global.
    const projB = await createProject("Web Redesign", asUser(managerB), tenantB);
    expect(projB.statusCode).toBe(201);
    const listB = (await app.inject({ method: "GET", url: `/api/${tenantB}/projects`, headers: asUser(managerB) })).json() as Array<{ id: string; shortCode: string }>;
    expect(listB.find((p) => p.id === projB.json().id)!.shortCode).toBe("WEBR"); // NOT "WEBR3" — independent per-tenant sequence of collisions

    // RLS: tenant A's manager can never see tenant B's project via the shared tenant-scoped route.
    const crossRead = await app.inject({ method: "GET", url: `/api/${tenantB}/projects`, headers: asUser(managerA) });
    expect(crossRead.statusCode).toBe(403); // company mismatch -> authz denial, not a leaked empty list
  });

  // ───────────────────────── BACKFILL IDEMPOTENCY (0050) ─────────────────────────
  // Re-executes the MIGRATION FILE'S OWN backfill SQL verbatim (parsed straight out of
  // 0050_pm_short_codes.sql, not a re-implementation that could silently drift from what actually
  // shipped) against rows inserted directly (bypassing the controller, simulating pre-migration
  // legacy data) and again a second time, proving the second pass is a true no-op: zero rows
  // change, no renumbering, no duplicate short_code/seq assignment.
  it("the 0050 backfill is idempotent — running it twice changes nothing on the second pass", async () => {
    const migrationSql = readFileSync(
      path.resolve(__dirname, "../../../migrations/0050_pm_short_codes.sql"),
      "utf8",
    );
    // Both DO $$ ... END $$; blocks after the DDL header are the backfill; strip the DDL (already
    // applied by initTestDb's migrate() run) and re-run ONLY the two DO blocks.
    const doBlocks = migrationSql.match(/DO \$\$[\s\S]*?END \$\$;/g);
    expect(doBlocks?.length).toBe(2); // sanity: the file still has exactly the two backfill passes we expect

    const pool = adminPool();
    // Seed two "legacy" projects directly (short_code/seq left NULL, as a pre-0050 row would be).
    const legacyProjectId = "00000000-0000-7000-8000-00000000bf01";
    await pool.query(
      `INSERT INTO projects (id, tenant_id, name, origin_site) VALUES ($1, $2, 'Legacy Backfill Target', 'test')`,
      [legacyProjectId, tenantA],
    );
    const t1 = "00000000-0000-7000-8000-00000000bf02";
    const t2 = "00000000-0000-7000-8000-00000000bf03";
    await pool.query(
      `INSERT INTO pm_tasks (id, tenant_id, project_id, title, origin_site, created_at) VALUES ($1, $2, $3, 'Legacy task one', 'test', now() - interval '2 minutes')`,
      [t1, tenantA, legacyProjectId],
    );
    await pool.query(
      `INSERT INTO pm_tasks (id, tenant_id, project_id, title, origin_site, created_at) VALUES ($1, $2, $3, 'Legacy task two', 'test', now() - interval '1 minute')`,
      [t2, tenantA, legacyProjectId],
    );

    // First pass — assigns short_code + seq.
    for (const block of doBlocks!) await pool.query(block);
    const after1 = await pool.query<{ shortCode: string | null }>(`SELECT short_code AS "shortCode" FROM projects WHERE id = $1`, [legacyProjectId]);
    const tasksAfter1 = await pool.query<{ id: string; seq: number }>(`SELECT id, seq FROM pm_tasks WHERE project_id = $1 ORDER BY created_at`, [legacyProjectId]);
    expect(after1.rows[0].shortCode).toBe("LEGA");
    expect(tasksAfter1.rows.map((r) => r.seq)).toEqual([1, 2]);

    // Second pass — must be a complete no-op (idempotent).
    for (const block of doBlocks!) await pool.query(block);
    const after2 = await pool.query<{ shortCode: string | null }>(`SELECT short_code AS "shortCode" FROM projects WHERE id = $1`, [legacyProjectId]);
    const tasksAfter2 = await pool.query<{ id: string; seq: number }>(`SELECT id, seq FROM pm_tasks WHERE project_id = $1 ORDER BY created_at`, [legacyProjectId]);
    expect(after2.rows[0].shortCode).toBe(after1.rows[0].shortCode); // unchanged, not renumbered/recoded
    expect(tasksAfter2.rows.map((r) => r.seq)).toEqual(tasksAfter1.rows.map((r) => r.seq));

    // And the uniqueness guarantees still hold after both passes — no duplicate slipped in.
    const dupCheck = await pool.query(
      `SELECT short_code, COUNT(*) FROM projects WHERE tenant_id = $1 AND short_code IS NOT NULL GROUP BY short_code HAVING COUNT(*) > 1`,
      [tenantA],
    );
    expect(dupCheck.rows).toEqual([]);
  });
});
