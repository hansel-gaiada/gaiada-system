// PV2-01 — one definition of "finished project", proven through BOTH readers that count it:
// `GET /portal/overview` (the client's view) and `GET /clients/:id/overview` (the staff mirror), plus
// the portal projects list ordering. A project staff mark `completed` must count as done and not
// active; `on_hold` stays active; `archived` is finished but not done.
//
// Needs DATABASE_URL_TEST + a live Cerbos (skips silently otherwise — check the skip count). Follows
// portal-dashboard.test.ts's app.inject() harness. Runs on the Linux server gate, not locally.
//
// Teeth: remove "completed" from FINISHED_PROJECT_STATUSES (and/or DONE_PROJECT_STATUSES) in
// project-status.ts and the first assertion block below fails.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject } from "../testing/fixtures";
import { newId, withTenants } from "../db";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

// The four statuses the staff form offered at PV2-01. PV2-09 added planned and cancelled; the counts
// below are for these four, and project-status-check.db.test.ts covers the closed set.
const FORM_STATUSES = ["active", "on_hold", "completed", "archived"] as const;

describe.skipIf(!TEST_URL)("PV2-01 · finished project statuses", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string;
  let signer: string;
  let client: string;
  const byStatus: Record<string, string> = {};

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Finished Status Co", ["clients"]);
    admin = await createUser("admin@pv201.test");
    signer = await createUser("signer@pv201.test");
    for (const u of [admin, signer]) await addMembership(co, u);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    await grantRole(signer, await createRole("client"), "company", co);

    client = await createClient(co, "Finished Client");
    await withTenants([co], async (c) => {
      for (const status of FORM_STATUSES) {
        const id = await createProject(co, `Project ${status}`, admin);
        byStatus[status] = id;
        await c.query(`UPDATE projects SET client_id = $2, status = $3 WHERE id = $1`, [id, client, status]);
      }
      await c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, activated_at, origin_site)
         VALUES ($1, $2, $3, $4, NULL, 'signer', 'active', now(), $5)`,
        [newId(), co, client, signer, config.originSite],
      );
    });
    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  it("portal/overview: completed is done and not active; on_hold is active; archived is finished but not done", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/overview`, headers: asUser(signer) });
    expect(r.statusCode).toBe(200);
    const p = r.json().progress;
    expect(p.projects).toBe(4);
    expect(p.activeProjects).toBe(2); // active + on_hold
    expect(p.completedProjects).toBe(1); // completed only
  });

  it("clients/:id/overview: the staff mirror counts the same way", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/clients/${client}/overview`, headers: asUser(admin) });
    expect(r.statusCode).toBe(200);
    const p = r.json().projects;
    expect(p.total).toBe(4);
    expect(p.active).toBe(2);
    expect(p.done).toBe(1);
  });

  it("portal/projects: finished projects (completed, archived) sort after unfinished ones", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/projects`, headers: asUser(signer) });
    expect(r.statusCode).toBe(200);
    const order = r.json().map((x: { status: string }) => x.status);
    const firstFinished = order.findIndex((s: string) => s === "completed" || s === "archived");
    expect(order.slice(0, firstFinished).sort()).toEqual(["active", "on_hold"]);
    expect(order.slice(firstFinished).sort()).toEqual(["archived", "completed"]);
  });

  it("each form status individually: flipping one project to every status moves the counts as defined", async () => {
    const expected: Record<string, { active: number; done: number }> = {
      active: { active: 1, done: 0 },
      on_hold: { active: 1, done: 0 },
      completed: { active: 0, done: 1 },
      archived: { active: 0, done: 0 },
    };
    const solo = await createClient(co, "Solo Client");
    const pid = await createProject(co, "Solo", admin);
    await withTenants([co], (c) => c.query(`UPDATE projects SET client_id = $2 WHERE id = $1`, [pid, solo]));
    for (const status of FORM_STATUSES) {
      await withTenants([co], (c) => c.query(`UPDATE projects SET status = $2 WHERE id = $1`, [pid, status]));
      const r = await app.inject({ method: "GET", url: `/api/${co}/clients/${solo}/overview`, headers: asUser(admin) });
      expect(r.statusCode).toBe(200);
      expect({ status, active: r.json().projects.active, done: r.json().projects.done })
        .toEqual({ status, ...expected[status] });
    }
  });
});
