// PV2-03 — the portal payload fields the Active/Past split and the People area read:
//   projects[].finished, projectDetail.lead, profile.clients[].accountManager, profile.contacts[].side.
//
// Needs DATABASE_URL_TEST + a live Cerbos (skips silently otherwise — check the skip count). Follows
// project-status.db.test.ts's app.inject() harness. Runs on the Linux server gate, not locally.
//
// Teeth (scoping): in portal-profile.controller.ts, change the accountManager subselect's
// `WHERE u.id = cl.owner_user_id AND` to `WHERE u.id = (SELECT owner_user_id FROM clients
// ORDER BY name LIMIT 1) AND` (a join that ignores the row's own client) and the
// "each contact sees only its own client's account manager" test fails.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject } from "../testing/fixtures";
import { newId, withTenants, withGlobal } from "../db";
import { FINISHED_PROJECT_STATUSES } from "./project-status";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("PV2-03 · portal payload fields", () => {
  let app: NestFastifyApplication;
  let co: string;
  let staff: string;
  let mgrA: string;
  let mgrB: string;
  let contactA: string;
  let contactB: string;
  let clientA: string;
  let clientB: string;
  const projByStatus: Record<string, string> = {};
  let projNoOwner: string;
  let projDeletedOwner: string;
  let projOwned: string;
  const statuses = [...FINISHED_PROJECT_STATUSES, "on_hold", "active"];

  const contactRow = (userId: string, client: string) =>
    withTenants([co], (c) =>
      c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, activated_at, origin_site)
         VALUES ($1, $2, $3, $4, NULL, 'signer', 'active', now(), $5)`,
        [newId(), co, client, userId, config.originSite],
      ),
    );

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Payload Co", ["clients"]);
    staff = await createUser("staff@pv203.test", "Stella Staff");
    mgrA = await createUser("mgra@pv203.test", "Alice Manager");
    mgrB = await createUser("mgrb@pv203.test", "Bob Manager");
    contactA = await createUser("contact-a@pv203.test", "Carol A");
    contactB = await createUser("contact-b@pv203.test", "Dan B");
    for (const u of [staff, mgrA, mgrB, contactA, contactB]) await addMembership(co, u);
    const clientRole = await createRole("client");
    await grantRole(contactA, clientRole, "company", co);
    await grantRole(contactB, clientRole, "company", co);
    await withGlobal((c) => c.query(`UPDATE users SET kind = 'client' WHERE id = ANY($1::uuid[])`, [[contactA, contactB]]));

    clientA = await createClient(co, "Client A");
    clientB = await createClient(co, "Client B");
    await withTenants([co], async (c) => {
      await c.query(`UPDATE clients SET owner_user_id = $2 WHERE id = $1`, [clientA, mgrA]);
      await c.query(`UPDATE clients SET owner_user_id = $2 WHERE id = $1`, [clientB, mgrB]);
    });

    // One project per status on client A, owned by `staff`.
    await withTenants([co], async (c) => {
      for (const status of statuses) {
        const id = await createProject(co, `Project ${status}`, staff);
        projByStatus[status] = id;
        await c.query(`UPDATE projects SET client_id = $2, status = $3 WHERE id = $1`, [id, clientA, status]);
      }
    });
    projOwned = projByStatus.active;
    projNoOwner = await createProject(co, "No owner");
    const ghost = await createUser("ghost@pv203.test", "Gone Owner");
    projDeletedOwner = await createProject(co, "Deleted owner", ghost);
    await withTenants([co], async (c) => {
      await c.query(`UPDATE projects SET client_id = $2 WHERE id = ANY($1::uuid[])`, [[projNoOwner, projDeletedOwner], clientA]);
    });
    await withGlobal((c) => c.query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [ghost]));

    await contactRow(contactA, clientA);
    await contactRow(contactB, clientB);
    // Staff hold a contact row on client A too (like a placeholder signer): must stay visible, as `provider`.
    await contactRow(staff, clientA);
    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  it("finished: true for every finished status, false for on_hold and active (list and detail)", async () => {
    const list = await app.inject({ method: "GET", url: `/api/${co}/portal/projects`, headers: asUser(contactA) });
    expect(list.statusCode).toBe(200);
    const rows = list.json() as Array<{ id: string; status: string; finished: boolean }>;
    for (const status of statuses) {
      const row = rows.find((r) => r.id === projByStatus[status]);
      expect(row, status).toBeDefined();
      expect({ status, finished: row!.finished }).toEqual({ status, finished: (FINISHED_PROJECT_STATUSES as readonly string[]).includes(status) });
      const d = await app.inject({ method: "GET", url: `/api/${co}/portal/projects/${projByStatus[status]}`, headers: asUser(contactA) });
      expect(d.statusCode).toBe(200);
      expect({ status, finished: d.json().finished }).toEqual({ status, finished: row!.finished });
    }
  });

  it("lead: filled for an owned project; null with no owner and when the owner is deleted", async () => {
    const get = async (id: string) =>
      (await app.inject({ method: "GET", url: `/api/${co}/portal/projects/${id}`, headers: asUser(contactA) })).json();
    expect((await get(projOwned)).lead).toEqual({ name: "Stella Staff", email: "staff@pv203.test" });
    expect((await get(projNoOwner)).lead).toBeNull();
    expect((await get(projDeletedOwner)).lead).toBeNull();
  });

  it("accountManager: each contact sees only its own client's account manager", async () => {
    const asA = await app.inject({ method: "GET", url: `/api/${co}/portal/profile`, headers: asUser(contactA) });
    const asB = await app.inject({ method: "GET", url: `/api/${co}/portal/profile`, headers: asUser(contactB) });
    expect(asA.statusCode).toBe(200);
    expect(asB.statusCode).toBe(200);
    const a = asA.json().clients as Array<{ id: string; accountManager: unknown }>;
    const b = asB.json().clients as Array<{ id: string; accountManager: unknown }>;
    expect(a.map((x) => x.id)).toEqual([clientA]);
    expect(b.map((x) => x.id)).toEqual([clientB]);
    expect(a[0].accountManager).toEqual({ name: "Alice Manager", email: "mgra@pv203.test" });
    expect(b[0].accountManager).toEqual({ name: "Bob Manager", email: "mgrb@pv203.test" });
    expect(JSON.stringify(asA.json())).not.toContain("mgrb@pv203.test");
    expect(JSON.stringify(asB.json())).not.toContain("mgra@pv203.test");
  });

  it("accountManager: null when the client has no owner", async () => {
    await withTenants([co], (c) => c.query(`UPDATE clients SET owner_user_id = NULL WHERE id = $1`, [clientB]));
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/profile`, headers: asUser(contactB) });
    expect(r.json().clients[0].accountManager).toBeNull();
    await withTenants([co], (c) => c.query(`UPDATE clients SET owner_user_id = $2 WHERE id = $1`, [clientB, mgrB]));
  });

  it("side: client for kind='client', provider for an employee contact who stays visible", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/profile`, headers: asUser(contactA) });
    const contacts = r.json().contacts as Array<{ id: string; side: string }>;
    expect(contacts.find((x) => x.id === contactA)?.side).toBe("client");
    expect(contacts.find((x) => x.id === staff)?.side).toBe("provider");
    expect(contacts.find((x) => x.id === contactB)).toBeUndefined(); // other client's contact: still scoped out
  });
});
