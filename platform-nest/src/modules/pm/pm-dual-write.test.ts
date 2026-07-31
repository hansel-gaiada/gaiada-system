// TR-02 — PM dual-write + contributors API (tracker-reporting-foundation.md §3.1, §12, §15).
// Every assignee-writing path (createTask, patchTask reassignment, recurrence spawn,
// duplicateTask) must write pm_tasks.assignee (the blob) AND pm_task_assignees (the relational
// substrate, migration 0054) in ONE transaction, honouring the TR-01 hard constraints:
//   (1) person rows carry `user_id::text` (canonical), never the raw blob string.
//   (2) `origin_site` is passed explicitly, never the column DEFAULT.
//   (3) the one-owner/one-responsible partial uniques are never transiently violated.
//   (4) unit-owned tasks never get an invented person row.
// Plus: task GET carries `contributors[]`, PATCH add/removeContributor work, and the write-time
// drift-guard hook (assigneeDrift / logAssigneeDriftIfAny) fires on a manufactured mismatch.
//
// Against live Postgres + RLS + Cerbos, same harness as pm.test.ts / pm-task-assignees.test.ts.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { withTenants } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createProject } from "../../testing/fixtures";
import { assigneeDrift, logAssigneeDriftIfAny } from "./pm.controller";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

type Row = {
  role: string;
  assignee_kind: string;
  assignee_ref: string;
  user_id: string | null;
  origin_site: string;
};

describe.skipIf(!TEST_URL)("PM dual-write + contributors (TR-02)", () => {
  let app: NestFastifyApplication;
  let tenant: string;
  let manager: string;
  let alice: string; // member, used as a person owner/responsible/contributor
  let bob: string;
  let projectId: string;
  const hdr = () => asUser(manager);

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    tenant = await createCompany("Tracker Dual-Write Co", ["agency", "pm"]);
    manager = await createUser("mgr-tr02@a.test", "Manager Mo");
    alice = await createUser("alice-tr02@a.test", "Alice Assignee");
    bob = await createUser("bob-tr02@a.test", "Bob Contributor");
    await addMembership(tenant, manager);
    await addMembership(tenant, alice);
    await addMembership(tenant, bob);
    await grantRole(manager, await createRole("manager"), "company", tenant);
    await grantRole(alice, await createRole("member"), "company", tenant);
    await grantRole(bob, await createRole("member"), "company", tenant);
    projectId = await createProject(tenant, "Dual-Write Project", manager);
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
  const getTask = async (id: string, headers = hdr()) =>
    app.inject({ method: "GET", url: `/api/${tenant}/pm/tasks/${id}`, headers });

  const rowsFor = async (taskId: string): Promise<Row[]> => {
    const { rows } = await adminPool().query<Row>(
      `SELECT role, assignee_kind, assignee_ref, user_id, origin_site FROM pm_task_assignees
        WHERE tenant_id = $1 AND task_id = $2 ORDER BY role`,
      [tenant, taskId],
    );
    return rows;
  };

  // ───────────────────────── dual-write: createTask ─────────────────────────

  it("createTask with a person owner + a DIFFERENT responsible writes both rows, canonical + explicit origin_site", async () => {
    const r = await createTask({
      title: "Owner+responsible differ",
      assignee: { kind: "person", refId: alice, refName: "Alice", responsibleId: manager, responsibleName: "Manager Mo" },
    });
    expect(r.statusCode).toBe(201);
    const { id } = r.json() as { id: string };

    const rows = await rowsFor(id);
    expect(rows).toEqual([
      { role: "owner", assignee_kind: "person", assignee_ref: alice, user_id: alice, origin_site: config.originSite },
      { role: "responsible", assignee_kind: "person", assignee_ref: manager, user_id: manager, origin_site: config.originSite },
    ]);
    // origin_site was passed EXPLICITLY (config.originSite), not left to the column's
    // DEFAULT 'central' — config.originSite in this test process is not 'central'.
    expect(config.originSite).not.toBe("central");

    // the blob is byte-unchanged FE wire format
    const body = (await getTask(id)).json() as { assignee: { refId: string; responsibleId: string } };
    expect(body.assignee).toMatchObject({ refId: alice, responsibleId: manager });
  });

  it("createTask with owner = responsible (same person) writes ONE owner row only, no responsible row", async () => {
    const r = await createTask({
      title: "Self-owned and self-responsible",
      assignee: { kind: "person", refId: alice, refName: "Alice", responsibleId: alice, responsibleName: "Alice" },
    });
    const { id } = r.json() as { id: string };
    expect(await rowsFor(id)).toEqual([
      { role: "owner", assignee_kind: "person", assignee_ref: alice, user_id: alice, origin_site: config.originSite },
    ]);
  });

  it("createTask with a DEPARTMENT owner + a person responsible: unit owner row (no invented person) + separate responsible row", async () => {
    const r = await createTask({
      title: "Dept-owned",
      assignee: { kind: "department", refId: "dept-engineering", refName: "Engineering", responsibleId: bob, responsibleName: "Bob" },
    });
    const { id } = r.json() as { id: string };
    expect(await rowsFor(id)).toEqual([
      { role: "owner", assignee_kind: "department", assignee_ref: "dept-engineering", user_id: null, origin_site: config.originSite },
      { role: "responsible", assignee_kind: "person", assignee_ref: bob, user_id: bob, origin_site: config.originSite },
    ]);
  });

  it("a non-canonical (uppercase) person refId still satisfies the ref-matches-user CHECK: the row is canonicalized", async () => {
    const upper = alice.toUpperCase();
    const r = await createTask({
      title: "Uppercase ref",
      assignee: { kind: "person", refId: upper, refName: "Alice", responsibleId: upper, responsibleName: "Alice" },
    });
    expect(r.statusCode).toBe(201);
    const { id } = r.json() as { id: string };
    const rows = await rowsFor(id);
    // exactly one owner row (self-responsible), and its assignee_ref is the CANONICAL lowercase
    // form — never the raw (uppercase) blob string, per the TR-01 hard constraint.
    expect(rows).toEqual([
      { role: "owner", assignee_kind: "person", assignee_ref: alice, user_id: alice, origin_site: config.originSite },
    ]);
  });

  // ───────────────────────── atomicity: rollback leaves NEITHER half ─────────────────────────

  it("a person ref that does not resolve to a real user rolls back the WHOLE transaction: no task row, no assignee rows", async () => {
    const ghost = "00000000-0000-4000-8000-0000000000ff"; // well-formed uuid, not a users row
    const title = "This task must never exist";
    const r = await createTask({
      title,
      assignee: { kind: "person", refId: ghost, refName: "Ghost", responsibleId: ghost, responsibleName: "Ghost" },
    });
    // the write fails loudly (by design, §15) rather than silently accepting a dangling ref
    expect(r.statusCode).toBeGreaterThanOrEqual(400);

    // and the task itself was never created either — the pm_tasks INSERT rolled back along with
    // the failed pm_task_assignees INSERT, proving the "one transaction" property: a partial
    // write (blob without rows) is structurally impossible.
    const { rows } = await adminPool().query<{ n: string }>(
      `SELECT count(*) AS n FROM pm_tasks WHERE tenant_id = $1 AND title = $2`,
      [tenant, title],
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it("PATCHing a real task to an unresolvable responsible rolls back: the ORIGINAL blob and rows are untouched", async () => {
    const { id } = (await createTask({
      title: "Reassign target",
      assignee: { kind: "person", refId: alice, refName: "Alice", responsibleId: alice, responsibleName: "Alice" },
    }).then((r) => r.json())) as { id: string };
    const before = await rowsFor(id);
    const beforeBlob = (await getTask(id).then((r) => r.json())) as { assignee: unknown };

    const ghost = "00000000-0000-4000-8000-0000000000ff";
    const bad = await patchTask(id, {
      assignee: { kind: "person", refId: alice, refName: "Alice", responsibleId: ghost, responsibleName: "Ghost" },
    });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);

    expect(await rowsFor(id)).toEqual(before);
    const afterBlob = (await getTask(id).then((r) => r.json())) as { assignee: unknown };
    expect(afterBlob.assignee).toEqual(beforeBlob.assignee);
  });

  // ───────────────────────── dual-write: patchTask reassignment (partial-unique safety) ─────────────────────────

  it("PATCH reassigning the owner replaces the row in place — never a duplicate owner, never a transient violation", async () => {
    const { id } = (await createTask({
      title: "Reassign owner",
      assignee: { kind: "person", refId: alice, refName: "Alice", responsibleId: alice, responsibleName: "Alice" },
    }).then((r) => r.json())) as { id: string };
    expect(await rowsFor(id)).toEqual([
      { role: "owner", assignee_kind: "person", assignee_ref: alice, user_id: alice, origin_site: config.originSite },
    ]);

    const r = await patchTask(id, {
      assignee: { kind: "person", refId: bob, refName: "Bob", responsibleId: manager, responsibleName: "Manager Mo" },
    });
    expect(r.statusCode).toBe(200);
    expect(await rowsFor(id)).toEqual([
      { role: "owner", assignee_kind: "person", assignee_ref: bob, user_id: bob, origin_site: config.originSite },
      { role: "responsible", assignee_kind: "person", assignee_ref: manager, user_id: manager, origin_site: config.originSite },
    ]);
  });

  it("PATCH clearing the assignee (assignee: null) deletes both rows", async () => {
    const { id } = (await createTask({
      title: "Clear me",
      assignee: { kind: "person", refId: alice, refName: "Alice", responsibleId: bob, responsibleName: "Bob" },
    }).then((r) => r.json())) as { id: string };
    expect((await rowsFor(id)).length).toBe(2);

    const r = await patchTask(id, { assignee: null });
    expect(r.statusCode).toBe(200);
    expect(await rowsFor(id)).toEqual([]);
    const body = (await getTask(id).then((x) => x.json())) as { assignee: unknown };
    expect(body.assignee).toBeNull();
  });

  it("a PATCH that does NOT touch assignee leaves the rows exactly as they were", async () => {
    const { id } = (await createTask({
      title: "Untouched assignee",
      assignee: { kind: "person", refId: alice, refName: "Alice", responsibleId: bob, responsibleName: "Bob" },
    }).then((r) => r.json())) as { id: string };
    const before = await rowsFor(id);
    const r = await patchTask(id, { progress: 50 });
    expect(r.statusCode).toBe(200);
    expect(await rowsFor(id)).toEqual(before);
  });

  // ───────────────────────── duplicateTask carries owner/responsible, not contributors ─────────────────────────

  it("duplicateTask copies the source's owner/responsible rows but not contributors", async () => {
    const { id: sourceId } = (await createTask({
      title: "Source",
      assignee: { kind: "person", refId: alice, refName: "Alice", responsibleId: bob, responsibleName: "Bob" },
    }).then((r) => r.json())) as { id: string };
    await patchTask(sourceId, { addContributor: bob });

    const dup = await app.inject({ method: "POST", url: `/api/${tenant}/pm/tasks/${sourceId}/duplicate`, headers: hdr() });
    expect(dup.statusCode).toBe(201);
    const { id: copyId } = dup.json() as { id: string };

    expect(await rowsFor(copyId)).toEqual([
      { role: "owner", assignee_kind: "person", assignee_ref: alice, user_id: alice, origin_site: config.originSite },
      { role: "responsible", assignee_kind: "person", assignee_ref: bob, user_id: bob, origin_site: config.originSite },
    ]);
    const copyTask = (await getTask(copyId).then((r) => r.json())) as { contributors: unknown[] };
    expect(copyTask.contributors).toEqual([]);
  });

  // ───────────────────────── contributors API ─────────────────────────

  it("task GET carries an empty contributors[] by default", async () => {
    const { id } = (await createTask({ title: "No contributors yet" }).then((r) => r.json())) as { id: string };
    const task = (await getTask(id).then((r) => r.json())) as { contributors: unknown[] };
    expect(task.contributors).toEqual([]);
  });

  it("addContributor/removeContributor: add two, dedupe a repeat add, remove one, invalid inputs rejected", async () => {
    const { id } = (await createTask({ title: "Contributors task" }).then((r) => r.json())) as { id: string };

    let r = await patchTask(id, { addContributor: alice }, asUser(bob)); // a mere member can add
    expect(r.statusCode).toBe(200);
    r = await patchTask(id, { addContributor: bob });
    expect(r.statusCode).toBe(200);

    let task = (await getTask(id).then((x) => x.json())) as { contributors: { userId: string; name: string }[] };
    expect(task.contributors.map((c) => c.userId).sort()).toEqual([alice, bob].sort());
    expect(task.contributors.every((c) => typeof c.name === "string" && c.name.length > 0)).toBe(true);

    // re-adding the same contributor is a no-op, not a duplicate/error
    r = await patchTask(id, { addContributor: alice });
    expect(r.statusCode).toBe(200);
    task = (await getTask(id).then((x) => x.json())) as { contributors: { userId: string; name: string }[] };
    expect(task.contributors).toHaveLength(2);

    // malformed user id -> 400
    r = await patchTask(id, { addContributor: "not-a-uuid" });
    expect(r.statusCode).toBe(400);
    // well-formed uuid that is not a member of this tenant -> 400
    const stranger = await createUser("stranger-tr02@x.test", "Stranger");
    r = await patchTask(id, { addContributor: stranger });
    expect(r.statusCode).toBe(400);

    r = await patchTask(id, { removeContributor: alice });
    expect(r.statusCode).toBe(200);
    task = (await getTask(id).then((x) => x.json())) as { contributors: { userId: string; name: string }[] };
    expect(task.contributors.map((c) => c.userId)).toEqual([bob]);

    // removing something already absent is a no-op, not an error
    r = await patchTask(id, { removeContributor: alice });
    expect(r.statusCode).toBe(200);

    // contributors never touch the owner/responsible rows (bob is still a contributor here —
    // only alice was removed above)
    const all = await rowsFor(id);
    expect(all.filter((r) => r.role === "owner" || r.role === "responsible")).toEqual([]);
    expect(all.filter((r) => r.role === "contributor").map((r) => r.assignee_ref)).toEqual([bob]);
  });

  // ───────────────────────── drift guard ─────────────────────────

  it("assigneeDrift reports no drift right after a normal dual-write", async () => {
    const { id } = (await createTask({
      title: "Drift-free",
      assignee: { kind: "person", refId: alice, refName: "Alice", responsibleId: bob, responsibleName: "Bob" },
    }).then((r) => r.json())) as { id: string };

    const result = await withTenants([tenant], (c) => assigneeDrift(c, tenant, id));
    expect(result.drift).toBe(false);
  });

  it("assigneeDrift + logAssigneeDriftIfAny detect and log a manufactured owner-ref mismatch", async () => {
    const { id } = (await createTask({
      title: "Will be corrupted",
      assignee: { kind: "person", refId: alice, refName: "Alice", responsibleId: alice, responsibleName: "Alice" },
    }).then((r) => r.json())) as { id: string };

    // Corrupt the ROW side directly (bypassing syncTaskAssignees entirely) so the blob (still
    // pointing at `alice`) and the row (now pointing at `bob`) disagree — the exact failure mode
    // the guard exists to catch.
    await adminPool().query(
      `UPDATE pm_task_assignees SET assignee_ref = $1::text, user_id = $1::uuid
         WHERE tenant_id = $2 AND task_id = $3 AND role = 'owner'`,
      [bob, tenant, id],
    );

    const result = await withTenants([tenant], (c) => assigneeDrift(c, tenant, id));
    expect(result.drift).toBe(true);
    expect(result.blobOwnerRef).toBe(alice);
    expect(result.rowOwnerRef).toBe(bob);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const logged = await withTenants([tenant], (c) => logAssigneeDriftIfAny(c, tenant, id));
      expect(logged.drift).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain("PM-ASSIGNEE-DRIFT");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("logAssigneeDriftIfAny does not log when there is no drift", async () => {
    const { id } = (await createTask({
      title: "Never corrupted",
      assignee: { kind: "person", refId: bob, refName: "Bob", responsibleId: bob, responsibleName: "Bob" },
    }).then((r) => r.json())) as { id: string };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const logged = await withTenants([tenant], (c) => logAssigneeDriftIfAny(c, tenant, id));
      expect(logged.drift).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
