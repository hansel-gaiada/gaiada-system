// P4-B1..B5 (PM Repsona Parity Phase 4, workstream B) — the assignment-history LEDGER
// (`pm_task_assignment_events`, migration 0087) beside `pm_tasks.assignee`. Against live Postgres +
// real RLS + Cerbos, same harness style as pm-dual-write.test.ts / pm-task-assignees.test.ts.
//
// The plan's whole risk statement for this ticket: "a write path that forgets to append loses
// history silently — this is the whole ticket." So this suite is weighted toward proving EVERY
// assignee-writing path appends (one test per path, enumerated), rather than toward the table shape
// alone — the shape is easy to get right and easy to verify; the write-path enumeration is the part
// that silently rots as new call sites are added.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { withTenants, getPool } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createProject } from "../../testing/fixtures";

const MIGRATION = path.resolve(__dirname, "../../../migrations/0087_pm_task_assignment_events.sql");

/** The migration's backfill DO block, extracted verbatim — never a re-implementation that could
 *  drift from what shipped. 0087 has exactly two DO blocks: [0] RLS enable/force/policy,
 *  [1] the backfill (same shape as 0054). */
function backfillSql(): string {
  const sql = readFileSync(MIGRATION, "utf8");
  const blocks = sql.match(/DO \$\$[\s\S]*?END \$\$;/g);
  expect(blocks?.length, "0087 should have exactly 2 DO blocks (RLS, then backfill)").toBe(2);
  const backfill = blocks![1];
  expect(backfill, "backfill must wrap per-tenant GUC (the 0051 lesson)").toMatch(
    /set_config\s*\(\s*'app\.current_tenant_ids'/,
  );
  return backfill;
}

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

type EventRow = {
  id: string; refId: string | null; refKind: string | null; refName: string | null;
  responsibleId: string | null; responsibleName: string | null;
  statusId: string; note: string | null; changedBy: string | null; changedByName: string | null;
  createdAt: string;
};

describe.skipIf(!TEST_URL)("pm_task_assignment_events — assignment/ball history (P4-B1..B5, migration 0087)", () => {
  let app: NestFastifyApplication;
  let tenant: string;
  let manager: string;
  let alice: string; // person assignee/responsible
  let bob: string;   // person alternate assignee/responsible
  let projectId: string;
  const hdr = () => asUser(manager);

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    tenant = await createCompany("Ball History Co", ["agency", "pm"]);
    manager = await createUser("mgr-p4b@a.test", "Manager Mo");
    alice = await createUser("alice-p4b@a.test", "Alice Ball");
    bob = await createUser("bob-p4b@a.test", "Bob Ball");
    await addMembership(tenant, manager);
    await addMembership(tenant, alice);
    await addMembership(tenant, bob);
    await grantRole(manager, await createRole("manager"), "company", tenant);
    await grantRole(alice, await createRole("member"), "company", tenant);
    await grantRole(bob, await createRole("member"), "company", tenant);
    projectId = await createProject(tenant, "Ball History Project", manager);
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  const createTask = async (body: Record<string, unknown>, headers = hdr()) =>
    app.inject({ method: "POST", url: `/api/${tenant}/pm/tasks`, headers, payload: { projectId, ...body } });
  const patchTask = async (id: string, body: Record<string, unknown>, headers = hdr()) =>
    app.inject({ method: "PATCH", url: `/api/${tenant}/pm/tasks/${id}`, headers, payload: body });
  const getHistory = async (id: string, headers = hdr()) =>
    app.inject({ method: "GET", url: `/api/${tenant}/pm/tasks/${id}/assignment-history`, headers });
  const historyRows = async (id: string): Promise<EventRow[]> => {
    const r = await getHistory(id);
    expect(r.statusCode).toBe(200);
    return r.json() as EventRow[];
  };
  // FUNCTIONS, not plain object literals: `alice`/`bob` are only assigned inside beforeAll, which
  // runs AFTER this describe() body's own synchronous evaluation — a plain const here would freeze
  // in `undefined` for refId/responsibleId (confirmed the hard way: every write-path test failed
  // with an empty ledger because validAssignee() silently rejected the resulting {refId: undefined}
  // shape, so pm_tasks.assignee itself was null and there was nothing to log — not a bug in the
  // ledger code being tested).
  const aliceAssignee = () => ({ kind: "person", refId: alice, refName: "Alice Ball", responsibleId: alice, responsibleName: "Alice Ball" });
  const bobAssignee = () => ({ kind: "person", refId: bob, refName: "Bob Ball", responsibleId: bob, responsibleName: "Bob Ball" });

  // ───────────────────────── SHAPE ─────────────────────────

  it("the table, its composite FK, and its two append-only triggers exist", async () => {
    const cols = await adminPool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'pm_task_assignment_events'`,
    );
    const names = cols.rows.map((r) => r.column_name);
    for (const col of ["id", "tenant_id", "task_id", "ref_id", "ref_kind", "responsible_id", "status_id", "note", "changed_by", "created_at"]) {
      expect(names, `missing column ${col}`).toContain(col);
    }
    const fk = await adminPool().query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'fk_pm_task_assignment_events_task_tenant'`,
    );
    expect(fk.rows).toHaveLength(1);
    const triggers = await adminPool().query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'pm_task_assignment_events'::regclass AND NOT tgisinternal`,
    );
    expect(triggers.rows.map((r) => r.tgname).sort()).toEqual([
      "trg_pm_task_assignment_events_no_delete",
      "trg_pm_task_assignment_events_no_update",
    ]);
  });

  it("APPEND-ONLY: an UPDATE or DELETE through the ordinary app role is rejected, unconditionally", async () => {
    const id = (await createTask({ title: "Append-only probe", assignee: aliceAssignee() }).then((r) => r.json())).id as string;
    const before = await historyRows(id);
    expect(before.length).toBeGreaterThan(0);

    // withTenants (not a bare getPool() call): the RLS USING clause must actually SEE the row for
    // the BEFORE UPDATE/DELETE trigger to fire on it at all — an unscoped UPDATE would silently
    // match zero rows (RLS, not the trigger) and this test would prove nothing.
    await expect(
      withTenants([tenant], (c) => c.query(`UPDATE pm_task_assignment_events SET note = 'tampered' WHERE id = $1`, [before[0].id])),
    ).rejects.toThrow(/append-only/);
    await expect(
      withTenants([tenant], (c) => c.query(`DELETE FROM pm_task_assignment_events WHERE id = $1`, [before[0].id])),
    ).rejects.toThrow(/append-only/);

    // nothing was actually touched
    const after = await historyRows(id);
    expect(after).toEqual(before);
  });

  // ───────────────────────── EVERY ASSIGNEE WRITE PATH APPENDS (one test each) ─────────────────────────

  it("PATH 1/4 — createTask with an initial assignee appends the task's FIRST history row", async () => {
    const r = await createTask({ title: "Create with assignee", assignee: aliceAssignee() });
    const { id } = r.json() as { id: string };
    const rows = await historyRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].refId).toBe(alice);
    expect(rows[0].refKind).toBe("person");
    expect(rows[0].responsibleId).toBe(alice);
    expect(rows[0].statusId).toBe("todo"); // readyStatus() default for a fresh task
    expect(rows[0].changedBy).toBe(manager);
  });

  it("createTask with NO assignee appends NOTHING (nothing to log)", async () => {
    const r = await createTask({ title: "Create with no assignee" });
    const { id } = r.json() as { id: string };
    expect(await historyRows(id)).toHaveLength(0);
  });

  it("PATH 2/4 — patchTask reassignment appends a new row on top of createTask's row (never replaces it)", async () => {
    const id = (await createTask({ title: "Reassign me", assignee: aliceAssignee() }).then((r) => r.json())).id as string;
    expect(await historyRows(id)).toHaveLength(1);

    const patched = await patchTask(id, { assignee: bobAssignee(), assignmentNote: "handing off to Bob" });
    expect(patched.statusCode).toBe(200);

    const rows = await historyRows(id);
    expect(rows).toHaveLength(2); // REASSIGNMENT NEVER DELETES A PRIOR ROW
    // newest first
    expect(rows[0].refId).toBe(bob);
    expect(rows[0].note).toBe("handing off to Bob");
    expect(rows[1].refId).toBe(alice); // the original create-time row, untouched
  });

  it("PATH 3/4 — a recurrence spawn appends the CHILD task's own first history row", async () => {
    const id = (await createTask({
      title: "Recurring", assignee: aliceAssignee(), dueDate: "2026-09-01",
      recurrence: { freq: "weekly" },
    }).then((r) => r.json())).id as string;

    // complete it -> not-done -> done edge fires the spawn (P2-06)
    const done = await patchTask(id, { status: "done" });
    expect(done.statusCode).toBe(200);
    const { spawned } = done.json() as { spawned: { id: string } | null };
    expect(spawned).toBeTruthy();

    const childRows = await historyRows(spawned!.id);
    expect(childRows).toHaveLength(1);
    expect(childRows[0].refId).toBe(alice); // child inherits the parent's final assignee
    expect(childRows[0].statusId).toBe("todo"); // readyStatus(), not the parent's done status
    // the parent's OWN history is untouched by the spawn — still just its create-time row
    expect(await historyRows(id)).toHaveLength(1);
  });

  it("PATH 4/4 — duplicateTask appends the copy's own first history row, never touching the source's", async () => {
    const id = (await createTask({ title: "Dup source", assignee: aliceAssignee() }).then((r) => r.json())).id as string;
    const dup = await app.inject({ method: "POST", url: `/api/${tenant}/pm/tasks/${id}/duplicate`, headers: hdr() });
    expect(dup.statusCode).toBe(201);
    const { id: copyId } = dup.json() as { id: string };

    const copyRows = await historyRows(copyId);
    expect(copyRows).toHaveLength(1);
    expect(copyRows[0].refId).toBe(alice);
    expect(copyRows[0].statusId).toBe("backlog"); // intakeStatus() — a duplicate is uncommitted work
    expect(await historyRows(id)).toHaveLength(1); // source's own history untouched
  });

  // ───────────────────────── INVARIANTS ─────────────────────────

  it("a reassignment never deletes a prior row, across THREE consecutive reassignments", async () => {
    const id = (await createTask({ title: "Triple reassign", assignee: aliceAssignee() }).then((r) => r.json())).id as string;
    await patchTask(id, { assignee: bobAssignee() });
    await patchTask(id, { assignee: aliceAssignee() });

    const rows = await historyRows(id);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.refId)).toEqual([alice, bob, alice]); // newest first
  });

  it("a correction APPENDS rather than mutates — two same-day reassignments both leave their own row", async () => {
    // Both PATCHes land on the same calendar day, which is exactly the case applyRoleTransition
    // treats as an in-place AMEND of the pm_task_assignees row (§P4-B3 comment on syncTaskAssignees).
    // The point of this test is that the LEDGER never mirrors that in-place amend — it is never
    // updated, only appended to.
    const id = (await createTask({ title: "Same-day correction", assignee: aliceAssignee() }).then((r) => r.json())).id as string;
    await patchTask(id, { assignee: bobAssignee(), assignmentNote: "oops, meant Bob" });
    await patchTask(id, { assignee: aliceAssignee(), assignmentNote: "actually, back to Alice" });

    const rows = await historyRows(id);
    expect(rows).toHaveLength(3);
    expect(rows[0].note).toBe("actually, back to Alice");
    expect(rows[1].note).toBe("oops, meant Bob");
    expect(rows[2].note).toBeNull(); // the original create-time row never had a note

    // AND the underlying pm_task_assignees substrate really did amend in place (one open owner row,
    // not three) — proves this test is exercising the same-day amend branch it claims to.
    const { rows: substrate } = await adminPool().query<{ n: string }>(
      `SELECT count(*) AS n FROM pm_task_assignees WHERE tenant_id = $1 AND task_id = $2 AND role = 'owner'`,
      [tenant, id],
    );
    expect(Number(substrate[0].n)).toBe(1);
  });

  it("a no-op PATCH (assignee key present but identical value) appends NOTHING — the ledger is not a heartbeat", async () => {
    const id = (await createTask({ title: "No-op patch", assignee: aliceAssignee() }).then((r) => r.json())).id as string;
    expect(await historyRows(id)).toHaveLength(1);
    await patchTask(id, { assignee: aliceAssignee() }); // same value, re-sent
    expect(await historyRows(id)).toHaveLength(1); // still just the one
  });

  it("clearing the ball (assignee -> null) appends a row with a null refId — a real, loggable event", async () => {
    const id = (await createTask({ title: "Clear assignee", assignee: aliceAssignee() }).then((r) => r.json())).id as string;
    await patchTask(id, { assignee: null });
    const rows = await historyRows(id);
    expect(rows).toHaveLength(2);
    expect(rows[0].refId).toBeNull();
    expect(rows[0].refKind).toBeNull();
    expect(rows[0].responsibleId).toBeNull();
  });

  // ───────────────────────── RLS: cross-tenant reads of the chain are blocked ─────────────────────────

  it("RLS/authz: a rival cannot read this task's history via the real tenant's URL, and a forged cross-tenant task id 404s", async () => {
    const id = (await createTask({ title: "Isolation probe", assignee: aliceAssignee() }).then((r) => r.json())).id as string;

    const rivalTenant = await createCompany("Rival Co (ball history)", ["agency", "pm"]);
    const rivalAdmin = await createUser("rival-ballhist@x.test", "Rival Ball Admin");
    await addMembership(rivalTenant, rivalAdmin);
    await grantRole(rivalAdmin, await createRole("manager"), "company", rivalTenant);

    // same tenant path, rival's own credentials -> Cerbos denies before RLS is even reached
    const cross = await app.inject({ method: "GET", url: `/api/${tenant}/pm/tasks/${id}/assignment-history`, headers: asUser(rivalAdmin) });
    expect(cross.statusCode).toBe(403);

    // rival's OWN tenant path with the real task id -> RLS scopes the lookup to nothing -> 404, never a leak
    const forged = await app.inject({ method: "GET", url: `/api/${rivalTenant}/pm/tasks/${id}/assignment-history`, headers: asUser(rivalAdmin) });
    expect(forged.statusCode).toBe(404);
  });

  it("RLS at the table level: an authorized-tenant-set without this tenant sees zero rows, and no ambient context sees zero rows", async () => {
    const id = (await createTask({ title: "Direct RLS probe", assignee: aliceAssignee() }).then((r) => r.json())).id as string;

    const otherTenant = await createCompany("Other Co (ball history direct)", ["agency", "pm"]);

    const scoped = await withTenants([tenant], (c) =>
      c.query<{ n: number }>(`SELECT count(*)::int AS n FROM pm_task_assignment_events WHERE task_id = $1`, [id]),
    );
    expect(scoped.rows[0].n).toBeGreaterThan(0);

    const wrongTenant = await withTenants([otherTenant], (c) =>
      c.query<{ n: number }>(`SELECT count(*)::int AS n FROM pm_task_assignment_events WHERE task_id = $1`, [id]),
    );
    expect(wrongTenant.rows[0].n).toBe(0);

    const noContext = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pm_task_assignment_events WHERE task_id = $1`, [id],
    );
    expect(noContext.rows[0].n).toBe(0);
  });

  // ───────────────────────── BACKFILL (P4-B2) ─────────────────────────

  it("the backfill seeds one row per pre-existing assigned task, dated from the task's own creation", async () => {
    const taskId = "00000000-0000-7000-9500-0000000000d1";
    await adminPool().query(
      `INSERT INTO pm_tasks (id, tenant_id, project_id, title, status, assignee, origin_site, created_at)
       VALUES ($1, $2, $3, 'Pre-existing assigned task', 'in_progress', $4, 'test', '2021-06-01T00:00:00Z')`,
      [taskId, tenant, projectId, JSON.stringify({ kind: "person", refId: alice, refName: "Alice", responsibleId: bob, responsibleName: "Bob" })],
    );

    await adminPool().query(backfillSql());

    const { rows } = await adminPool().query<{ ref_id: string; ref_kind: string; responsible_id: string; status_id: string; created_at: string; changed_by: string | null }>(
      `SELECT ref_id, ref_kind, responsible_id, status_id, created_at::text AS created_at, changed_by
         FROM pm_task_assignment_events WHERE tenant_id = $1 AND task_id = $2`,
      [tenant, taskId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ref_id).toBe(alice);
    expect(rows[0].ref_kind).toBe("person");
    expect(rows[0].responsible_id).toBe(bob);
    expect(rows[0].status_id).toBe("in_progress");
    expect(rows[0].changed_by).toBeNull();
    expect(rows[0].created_at.slice(0, 10)).toBe("2021-06-01");
  });

  it("running the backfill a SECOND time is a true no-op (idempotent)", async () => {
    const before = (await adminPool().query(`SELECT id FROM pm_task_assignment_events ORDER BY id`)).rows;
    await adminPool().query(backfillSql());
    const after = (await adminPool().query(`SELECT id FROM pm_task_assignment_events ORDER BY id`)).rows;
    expect(after).toEqual(before);
  });

  // ─────────── THE ONE THAT MATTERS: the backfill under a NOBYPASSRLS role with no context ───────────

  it("the backfill writes under a NOBYPASSRLS role with NO ambient tenant context (the 0050 bug class)", async () => {
    const taskId = "00000000-0000-7000-9500-0000000000d2";
    await adminPool().query(
      `INSERT INTO pm_tasks (id, tenant_id, project_id, title, status, assignee, origin_site, created_at)
       VALUES ($1, $2, $3, 'NOBYPASSRLS backfill probe', 'todo', $4, 'test', '2022-02-02T00:00:00Z')`,
      [taskId, tenant, projectId, JSON.stringify({ kind: "person", refId: bob, refName: "Bob", responsibleId: bob, responsibleName: "Bob" })],
    );

    // getPool() — platform_app_test, NOSUPERUSER NOBYPASSRLS, NO tenant GUC set. If the migration's
    // per-tenant set_config wrapper were ever removed, this insert silently seeds zero rows.
    await getPool().query(backfillSql());

    const { rows } = await adminPool().query<{ n: string }>(
      `SELECT count(*) AS n FROM pm_task_assignment_events WHERE tenant_id = $1 AND task_id = $2`,
      [tenant, taskId],
    );
    expect(Number(rows[0].n), "backfill silently no-opped under NOBYPASSRLS — the 0050 bug class").toBe(1);
  });
});
