// 5c.2: core client-work entities (clients, deliverables, time_entries) — the shared
// platform tables the agency (and every vertical) bills against. Verifies CRUD, tenant/
// role gating, time-entry ownership, and the core billable-minutes / open-deliverables
// rollups feeding the management view.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import {
  recomputeRollups, syncMetricDefinitions, registerCoreRollupProvider,
  resetCoreRollupProviders, coreTaskRollups,
} from "../rollups/engine";
import { resetModules } from "../modules/registry";
import { clientWorkRollups } from "./client-work";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createProject } from "../testing/fixtures";
import { withTenants } from "../db";

describe.skipIf(!TEST_URL)("core client-work", () => {
  let app: NestFastifyApplication;
  let co: string;
  let manager: string;
  let member: string;
  let member2: string;
  let viewer: string;
  let exec: string;
  let projectId: string;
  let clientId: string;
  let deliverableId: string;
  let entryId: string;
  const svc = { authorization: "Bearer svc-token" };
  const asUser = (id: string) => ({ ...svc, "x-user-id": id });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    registerCoreRollupProvider(coreTaskRollups);
    registerCoreRollupProvider(clientWorkRollups);
    await syncMetricDefinitions();

    co = await createCompany("Creative House", ["clients"]);
    manager = await createUser("mgr@cw.test");
    member = await createUser("mem@cw.test");
    member2 = await createUser("mem2@cw.test");
    viewer = await createUser("view@cw.test");
    exec = await createUser("exec@cw.test");
    for (const u of [manager, member, member2, viewer]) await addMembership(co, u);

    await grantRole(manager, await createRole("manager"), "company", co);
    await grantRole(member, await createRole("member"), "company", co);
    await grantRole(member2, await createRole("member"), "company", co);
    await grantRole(viewer, await createRole("viewer"), "company", co);
    // ⚠ IAM-15: this was a global `group_executive`. It must become `platform_admin`, NOT
    // company_admin: this fixture reads `/api/rollups`, and `core.rollup.read` is one of the keys
    // IAM-14 deliberately withholds from company_admin (and from `owner`) as a cross-company OPERATOR
    // surface. Substituting company_admin 403s on the rollup read.
    await grantRole(exec, await createRole("platform_admin"), "global", null);
    // MON-00c: a GLOBAL grant carries no membership, so no root resolves from
    // `users.home_company_id` or memberships, `rootCompanies` came back empty, `variables.inRoot` was
    // false, and the exec's own rules denied. Anchored via home_company_id rather than a membership so
    // the exec does not join the companies whose numbers these assertions check.
    await adminPool().query(`UPDATE users SET home_company_id = $1 WHERE id = $2`, [co, exec]);

    projectId = await createProject(co, "Acme Rebrand");
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("member creates a client; it lists back", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${co}/clients`,
      headers: asUser(member), payload: { name: "Acme Retail", contact: { email: "ops@acme.test" } },
    });
    expect(r.statusCode).toBe(201);
    clientId = r.json().id;
    const list = await app.inject({ method: "GET", url: `/api/${co}/clients`, headers: asUser(member) });
    expect((list.json() as Array<{ id: string }>).some((c) => c.id === clientId)).toBe(true);
  });

  it("creating a client emits a client.created outbox event (drives the n8n bridge)", async () => {
    const ev = await withTenants([co], (c) =>
      c.query<{ entity_id: string }>(
        `SELECT entity_id FROM outbox_events WHERE event_type = 'client.created' AND entity_id = $1`,
        [clientId],
      ),
    );
    expect(ev.rows).toHaveLength(1);
  });

  it("a viewer cannot create a client (read-only role)", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${co}/clients`, headers: asUser(viewer), payload: { name: "Nope" },
    });
    expect(r.statusCode).toBe(403);
  });

  it("member creates a deliverable on the project; lists by project", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${co}/deliverables`,
      headers: asUser(member), payload: { projectId, clientId, name: "Landing page", dueDate: "2026-07-20" },
    });
    expect(r.statusCode).toBe(201);
    deliverableId = r.json().id;
    const list = await app.inject({
      method: "GET", url: `/api/${co}/deliverables?projectId=${projectId}`, headers: asUser(member),
    });
    expect((list.json() as Array<{ id: string; client_id: string }>).find((d) => d.id === deliverableId)?.client_id).toBe(clientId);
  });

  it("a deliverable on an unknown project 404s", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${co}/deliverables`,
      headers: asUser(member), payload: { projectId: "00000000-0000-0000-0000-000000000000", name: "ghost" },
    });
    expect(r.statusCode).toBe(404);
  });

  it("member logs billable time; minutes must be positive", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${co}/time-entries`,
      headers: asUser(member), payload: { projectId, minutes: 90, billable: true, entryDate: "2026-07-08", notes: "wireframes" },
    });
    expect(r.statusCode).toBe(201);
    entryId = r.json().id;
    const bad = await app.inject({
      method: "POST", url: `/api/${co}/time-entries`, headers: asUser(member), payload: { projectId, minutes: 0 },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("a different member cannot edit someone else's time entry; owner and manager can", async () => {
    const denied = await app.inject({
      method: "PATCH", url: `/api/${co}/time-entries/${entryId}`, headers: asUser(member2), payload: { minutes: 30 },
    });
    expect(denied.statusCode).toBe(403);
    const owner = await app.inject({
      method: "PATCH", url: `/api/${co}/time-entries/${entryId}`, headers: asUser(member), payload: { minutes: 120 },
    });
    expect(owner.statusCode).toBe(200);
    const mgr = await app.inject({
      method: "PATCH", url: `/api/${co}/time-entries/${entryId}`, headers: asUser(manager), payload: { notes: "reviewed" },
    });
    expect(mgr.statusCode).toBe(200);
  });

  it("core client-work rollups surface billable minutes and open deliverables", async () => {
    const period = "2026-07-08";
    await recomputeRollups(co, period);
    const view = await app.inject({ method: "GET", url: `/api/rollups?period=${period}`, headers: asUser(exec) });
    const rows = view.json() as Array<{ metric_key: string; numerator: string }>;
    expect(Number(rows.find((r) => r.metric_key === "core.time.billable_minutes")?.numerator)).toBe(120);
    expect(Number(rows.find((r) => r.metric_key === "core.deliverables.open")?.numerator)).toBeGreaterThanOrEqual(1);
  });

  it("member creates a project with departmentId; it lists and details with department_id", async () => {
    const createResp = await app.inject({
      method: "POST", url: `/api/${co}/projects`,
      headers: asUser(member), payload: { name: "Mobile Redesign", departmentId: "web-dev-dept-123" },
    });
    expect(createResp.statusCode).toBe(201);
    const newProjectId = createResp.json().id;

    const listResp = await app.inject({
      method: "GET", url: `/api/${co}/projects`,
      headers: asUser(member),
    });
    expect(listResp.statusCode).toBe(200);
    const projects = listResp.json() as Array<{ id: string; department_id: string | null }>;
    const created = projects.find((p) => p.id === newProjectId);
    expect(created).toBeDefined();
    expect(created?.department_id).toBe("web-dev-dept-123");

    const detailResp = await app.inject({
      method: "GET", url: `/api/${co}/projects/${newProjectId}`,
      headers: asUser(member),
    });
    expect(detailResp.statusCode).toBe(200);
    const detail = detailResp.json() as { id: string; department_id: string | null };
    expect(detail.department_id).toBe("web-dev-dept-123");
  });

  it("member can PATCH a project to update departmentId", async () => {
    const createResp = await app.inject({
      method: "POST", url: `/api/${co}/projects`,
      headers: asUser(member), payload: { name: "SEO Overhaul" },
    });
    expect(createResp.statusCode).toBe(201);
    const newProjectId = createResp.json().id;

    const patchResp = await app.inject({
      method: "PATCH", url: `/api/${co}/projects/${newProjectId}`,
      headers: asUser(member), payload: { departmentId: "seo-dept-456" },
    });
    expect(patchResp.statusCode).toBe(200);

    const detailResp = await app.inject({
      method: "GET", url: `/api/${co}/projects/${newProjectId}`,
      headers: asUser(member),
    });
    expect(detailResp.statusCode).toBe(200);
    const detail = detailResp.json() as { id: string; department_id: string | null };
    expect(detail.department_id).toBe("seo-dept-456");
  });

  it("project departmentId can be null when not provided", async () => {
    const createResp = await app.inject({
      method: "POST", url: `/api/${co}/projects`,
      headers: asUser(member), payload: { name: "Generic Project" },
    });
    expect(createResp.statusCode).toBe(201);
    const newProjectId = createResp.json().id;

    const detailResp = await app.inject({
      method: "GET", url: `/api/${co}/projects/${newProjectId}`,
      headers: asUser(member),
    });
    expect(detailResp.statusCode).toBe(200);
    const detail = detailResp.json() as { id: string; department_id: string | null };
    expect(detail.department_id).toBeNull();
  });
});
