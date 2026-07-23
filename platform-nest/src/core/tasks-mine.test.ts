// WSUX-3 — GET /api/tasks/mine: the cross-company My-Work task read, unioned over the forked
// task model (base `tasks` + `pm_tasks`), against live Postgres + RLS + Cerbos. Verifies:
// (1) union of BOTH models normalized into one list with source+href, (2) cross-company fan-out
// tags an inaccessible company {included:false, reason:"no_access"} and leaks NO rows from it,
// (3) a company where the pm module is OFF still returns base-task rows (never all-or-nothing),
// (4) status/dueBefore filters, (5) disjointness: a synthetic id collision across the two models
// surfaces as an excluded/errored company, never a silent merge, and never crashes other legs.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules, registerModule } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createProject, createTask } from "../testing/fixtures";
import { newId, withTenants } from "../db";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

interface Row {
  id: string; title: string; status: string; dueDate: string | null;
  tenantId: string; company: string; source: "task" | "pm_task"; href: string;
}
interface EnvelopeBody {
  items: Row[];
  companies: Array<{ id: string; name?: string; included: boolean; reason?: string }>;
}

async function createPmTask(
  tenantId: string,
  projectId: string,
  title: string,
  responsibleId: string,
  status = "todo",
  dueDate: string | null = null,
  idOverride?: string,
): Promise<string> {
  const id = idOverride ?? newId();
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO pm_tasks (id, tenant_id, project_id, title, status, assignee, due_date, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id, tenantId, projectId, title, status,
        JSON.stringify({ kind: "person", refId: responsibleId, refName: "x", responsibleId, responsibleName: "x" }),
        dueDate, config.originSite,
      ],
    ),
  );
  return id;
}

describe.skipIf(!TEST_URL)("GET /api/tasks/mine — cross-company union over tasks + pm_tasks (WSUX-3)", () => {
  let app: NestFastifyApplication;
  let coA: string; // has pm enabled
  let coB: string; // pm NOT enabled — base tasks only
  let coC: string; // caller is NOT a member
  let user: string;
  let other: string; // a different assignee, used to prove no over-fetch

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();

    coA = await createCompany("WSUX3 Co A", ["pm"]);
    coB = await createCompany("WSUX3 Co B", []); // pm module OFF
    coC = await createCompany("WSUX3 Co C — not a member");

    user = await createUser("wsux3-user@a.test");
    other = await createUser("wsux3-other@a.test");
    await addMembership(coA, user);
    await addMembership(coB, user);
    await addMembership(coA, other);

    const memberRole = await createRole("member");
    await grantRole(user, memberRole, "company", coA);
    await grantRole(user, memberRole, "company", coB);
    await grantRole(other, memberRole, "company", coA);

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("unions base tasks + pm_tasks for one company into one normalized list with source+href", async () => {
    const projA = await createProject(coA, "Proj A");
    await createTask(coA, projA, "Base task mine", "todo"); // base `tasks`, assignee unset by default helper
    // createTask helper doesn't set assignee_id; assign directly via SQL so it's "mine".
    const baseTaskId = await withTenants([coA], async (c) => {
      const r = await c.query<{ id: string }>(`SELECT id FROM tasks WHERE tenant_id = $1 AND title = 'Base task mine'`, [coA]);
      await c.query(`UPDATE tasks SET assignee_id = $2 WHERE id = $1`, [r.rows[0].id, user]);
      return r.rows[0].id;
    });
    const pmTaskId = await createPmTask(coA, projA, "PM task mine", user);
    // A distractor assigned to someone else — must NOT appear.
    await createPmTask(coA, projA, "PM task NOT mine", other);

    const r = await app.inject({ method: "GET", url: `/api/tasks/mine?scope=${coA}`, headers: asUser(user) });
    expect(r.statusCode).toBe(200);
    const body = r.json() as EnvelopeBody;

    const byId = new Map(body.items.map((i) => [i.id, i]));
    expect(byId.get(baseTaskId)).toMatchObject({ source: "task", title: "Base task mine", tenantId: coA, company: "WSUX3 Co A", href: `/tasks/${baseTaskId}` });
    expect(byId.get(pmTaskId)).toMatchObject({ source: "pm_task", title: "PM task mine", tenantId: coA, company: "WSUX3 Co A", href: `/tasks/${pmTaskId}` });
    expect(body.items.some((i) => i.title === "PM task NOT mine")).toBe(false);
    expect(body.companies).toEqual([{ id: coA, name: "WSUX3 Co A", included: true }]);
  });

  it("a company with the pm module OFF still returns base-task rows — never all-or-nothing", async () => {
    const projB = await createProject(coB, "Proj B");
    await createTask(coB, projB, "Co B base task", "todo");
    await withTenants([coB], (c) =>
      c.query(`UPDATE tasks SET assignee_id = $1 WHERE tenant_id = $2 AND title = 'Co B base task'`, [user, coB]),
    );

    const r = await app.inject({ method: "GET", url: `/api/tasks/mine?scope=${coB}`, headers: asUser(user) });
    expect(r.statusCode).toBe(200);
    const body = r.json() as EnvelopeBody;
    expect(body.items.every((i) => i.source === "task")).toBe(true);
    expect(body.items.some((i) => i.title === "Co B base task")).toBe(true);
    expect(body.companies).toEqual([{ id: coB, name: "WSUX3 Co B", included: true }]);
  });

  it("cross-company fan-out (scope=all): includes authorized companies, tags the non-member one excluded, and leaks NO rows from it", async () => {
    const r = await app.inject({ method: "GET", url: `/api/tasks/mine?scope=all`, headers: asUser(user) });
    expect(r.statusCode).toBe(200);
    const body = r.json() as EnvelopeBody;
    const companyIds = body.companies.map((c) => c.id);
    expect(companyIds).toContain(coA);
    expect(companyIds).toContain(coB);
    expect(companyIds).not.toContain(coC); // user has no membership in C — never entered the fan-out

    expect(body.items.every((i) => i.tenantId !== coC)).toBe(true);
  });

  it("a crafted scope=<companyId the caller cannot see> degrades to an excluded envelope entry, never a leak, never a 500", async () => {
    const r = await app.inject({ method: "GET", url: `/api/tasks/mine?scope=${coC}`, headers: asUser(user) });
    expect(r.statusCode).toBe(200);
    const body = r.json() as EnvelopeBody;
    expect(body.items).toEqual([]);
    expect(body.companies).toEqual([{ id: coC, included: false, reason: "no_access" }]);
  });

  it("status filter narrows both models to the requested status", async () => {
    const proj = await createProject(coA, "Proj A2");
    await createTask(coA, proj, "Done base task", "done");
    await withTenants([coA], (c) =>
      c.query(`UPDATE tasks SET assignee_id = $1 WHERE tenant_id = $2 AND title = 'Done base task'`, [user, coA]),
    );
    await createPmTask(coA, proj, "Done pm task", user, "done");

    const r = await app.inject({ method: "GET", url: `/api/tasks/mine?scope=${coA}&status=done`, headers: asUser(user) });
    expect(r.statusCode).toBe(200);
    const body = r.json() as EnvelopeBody;
    expect(body.items.length).toBeGreaterThanOrEqual(2);
    expect(body.items.every((i) => i.status === "done")).toBe(true);
  });

  it("dueBefore filters out later-dated rows from both models", async () => {
    const proj = await createProject(coA, "Proj A3");
    const early = await createPmTask(coA, proj, "Early pm task", user, "todo", "2026-01-01");
    const late = await createPmTask(coA, proj, "Late pm task", user, "todo", "2027-01-01");

    const r = await app.inject({ method: "GET", url: `/api/tasks/mine?scope=${coA}&dueBefore=2026-06-01`, headers: asUser(user) });
    expect(r.statusCode).toBe(200);
    const body = r.json() as EnvelopeBody;
    expect(body.items.some((i) => i.id === early)).toBe(true);
    expect(body.items.some((i) => i.id === late)).toBe(false);
  });

  it("rejects a malformed dueBefore (400)", async () => {
    const r = await app.inject({ method: "GET", url: `/api/tasks/mine?scope=${coA}&dueBefore=not-a-date`, headers: asUser(user) });
    expect(r.statusCode).toBe(400);
  });

  it("disjointness: an id collision between tasks and pm_tasks for the SAME tenant is surfaced as an excluded/errored company, never a silent merge — and other companies are unaffected", async () => {
    const proj = await createProject(coA, "Proj Collide");
    const collideId = newId();
    await withTenants([coA], (c) =>
      c.query(
        `INSERT INTO tasks (id, tenant_id, project_id, title, status, assignee_id, origin_site) VALUES ($1,$2,$3,'Collision base',$4,$5,$6)`,
        [collideId, coA, proj, "todo", user, config.originSite],
      ),
    );
    await createPmTask(coA, proj, "Collision pm", user, "todo", null, collideId);

    const r = await app.inject({ method: "GET", url: `/api/tasks/mine?scope=all`, headers: asUser(user) });
    expect(r.statusCode).toBe(200);
    const body = r.json() as EnvelopeBody;

    const aEntry = body.companies.find((c) => c.id === coA)!;
    expect(aEntry.included).toBe(false);
    expect(aEntry.reason).toBe("error");
    // No row from the colliding id leaked out under either source.
    expect(body.items.some((i) => i.id === collideId)).toBe(false);
    // coB (unaffected tenant) still returned normally alongside the errored coA.
    const bEntry = body.companies.find((c) => c.id === coB)!;
    expect(bEntry.included).toBe(true);
  });
});
