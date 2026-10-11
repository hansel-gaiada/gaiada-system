// PV2-09 — `projects.status` is a closed set, enforced twice: the CHECK from migration
// 202610110151_projects_status_check.sql, and a 400 from both project PATCH routes before the CHECK can
// turn a bad value into a 500.
//
// Needs DATABASE_URL_TEST + a live Cerbos (skips silently otherwise — check the skip count). Runs on the
// Linux server gate, not locally. The test harness migrates as the postgres superuser, so the CHECK
// test below proves the constraint exists, not anything about RLS (the migration has no UPDATE).
//
// Teeth: delete the `isProjectStatus` guard from either PATCH route and its 400 case fails (the CHECK
// answers 500); delete the migration and the CHECK case fails.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject } from "../testing/fixtures";
import { withTenants } from "../db";
import { PROJECT_STATUSES } from "./project-status";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("PV2-09 · projects.status is a closed set", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string;
  let clientUser: string;
  let client: string;

  const statusOf = (id: string) =>
    withTenants([co], async (c) => (await c.query<{ status: string }>(`SELECT status FROM projects WHERE id = $1`, [id])).rows[0]?.status);
  const newProject = async (name: string) => {
    const id = await createProject(co, name, admin);
    await withTenants([co], (c) => c.query(`UPDATE projects SET client_id = $2 WHERE id = $1`, [id, client]));
    return id;
  };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Status Check Co", ["agency", "pm", "clients"]);
    admin = await createUser("admin@pv209.test");
    clientUser = await createUser("client@pv209.test");
    for (const u of [admin, clientUser]) await addMembership(co, u);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    await grantRole(clientUser, await createRole("client"), "company", co);
    client = await createClient(co, "Status Client");
    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  it("the CHECK accepts every status in the set and refuses anything else", async () => {
    const id = await newProject("Check target");
    for (const s of PROJECT_STATUSES) {
      await withTenants([co], (c) => c.query(`UPDATE projects SET status = $2 WHERE id = $1`, [id, s]));
      expect(await statusOf(id)).toBe(s);
    }
    for (const bad of ["done", "complete", "finished", ""]) {
      await expect(
        withTenants([co], (c) => c.query(`UPDATE projects SET status = $2 WHERE id = $1`, [id, bad])),
      ).rejects.toThrow(/projects_status_check/);
    }
  });

  it("PATCH /projects/:id refuses an unknown status with a 400 naming the set, and stores a valid one", async () => {
    const id = await newProject("Core patch target");
    const bad = await app.inject({ method: "PATCH", url: `/api/${co}/projects/${id}`, headers: asUser(admin), payload: { status: "done" } });
    expect(bad.statusCode).toBe(400);
    expect(JSON.stringify(bad.json())).toMatch(/status/);
    expect(JSON.stringify(bad.json())).toMatch(/planned, active, on_hold, completed, cancelled, archived/);
    expect(await statusOf(id)).toBe("active");

    const ok = await app.inject({ method: "PATCH", url: `/api/${co}/projects/${id}`, headers: asUser(admin), payload: { status: "cancelled" } });
    expect(ok.statusCode).toBe(200);
    expect(await statusOf(id)).toBe("cancelled");
  });

  it("PATCH /projects/:id without a status still works (the guard only reads a status that was sent)", async () => {
    const id = await newProject("Name only");
    const r = await app.inject({ method: "PATCH", url: `/api/${co}/projects/${id}`, headers: asUser(admin), payload: { name: "Renamed" } });
    expect(r.statusCode).toBe(200);
    expect(await statusOf(id)).toBe("active");
  });

  it("PATCH /pm/projects/:id refuses an unknown status with the same 400, and stores a valid one", async () => {
    const id = await newProject("PM patch target");
    const bad = await app.inject({ method: "PATCH", url: `/api/${co}/pm/projects/${id}`, headers: asUser(admin), payload: { status: "finished" } });
    expect(bad.statusCode).toBe(400);
    expect(JSON.stringify(bad.json())).toMatch(/planned, active, on_hold, completed, cancelled, archived/);
    expect(await statusOf(id)).toBe("active");

    const ok = await app.inject({ method: "PATCH", url: `/api/${co}/pm/projects/${id}`, headers: asUser(admin), payload: { status: "on_hold" } });
    expect(ok.statusCode).toBe(200);
    expect(await statusOf(id)).toBe("on_hold");
  });

  it("authorization still comes first: a caller who may not update gets 403, not the status 400", async () => {
    const id = await newProject("Denied target");
    const core = await app.inject({ method: "PATCH", url: `/api/${co}/projects/${id}`, headers: asUser(clientUser), payload: { status: "done" } });
    expect(core.statusCode).toBe(403);
    const pm = await app.inject({ method: "PATCH", url: `/api/${co}/pm/projects/${id}`, headers: asUser(clientUser), payload: { status: "done" } });
    expect(pm.statusCode).toBe(403);
    expect(await statusOf(id)).toBe("active");
  });
});
