// Billing/invoices (§4) — generate from billable time, status transitions, RBAC.
// Against live Postgres + RLS + Cerbos.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { withTenants } from "../db";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createProject } from "../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("billing / invoices (§4)", () => {
  let app: NestFastifyApplication;
  let tenant: string;
  let admin: string;
  let member: string;
  let clientId: string;
  let projectId: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    tenant = await createCompany("Agency A", ["agency"]);
    admin = await createUser("admin@a.test");
    member = await createUser("mem@a.test");
    await addMembership(tenant, admin);
    await addMembership(tenant, member);
    await grantRole(admin, await createRole("company_admin"), "company", tenant);
    await grantRole(member, await createRole("member"), "company", tenant);
    app = await buildApp();

    // A client + project + billable time in the period to invoice against.
    clientId = (await app.inject({ method: "POST", url: `/api/${tenant}/clients`, headers: asUser(admin), payload: { name: "Acme" } })).json().id;
    projectId = await createProject(tenant, "Acme Site", admin);
    await withTenants([tenant], (c) =>
      c.query(`UPDATE projects SET client_id = $1 WHERE id = $2`, [clientId, projectId]),
    );
    // 120 billable + 30 non-billable minutes in-period; 60 billable out-of-period.
    const t = (min: number, billable: boolean, date: string) =>
      app.inject({ method: "POST", url: `/api/${tenant}/time-entries`, headers: asUser(member), payload: { projectId, minutes: min, billable, entryDate: date } });
    await t(120, true, "2026-07-10");
    await t(30, false, "2026-07-11");
    await t(60, true, "2026-06-01");
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("generates an invoice from billable in-period time (2h × rate), one line per project", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${tenant}/invoices`, headers: asUser(admin),
      payload: { clientId, periodStart: "2026-07-01", periodEnd: "2026-07-31", rate: 100, currency: "USD" },
    });
    expect(r.statusCode).toBe(201);
    const { id } = r.json() as { id: string };

    const inv = (await app.inject({ method: "GET", url: `/api/${tenant}/invoices/${id}`, headers: asUser(admin) })).json() as {
      lines: Array<{ description: string; hours: number; rate: number; amount: number }>; total: number; status: string; clientName: string; currency: string;
    };
    expect(inv.status).toBe("draft");
    expect(inv.clientName).toBe("Acme");
    expect(inv.lines).toHaveLength(1);
    expect(inv.lines[0]).toMatchObject({ description: "Acme Site", hours: 2, rate: 100, amount: 200 });
    expect(inv.total).toBe(200); // out-of-period + non-billable excluded
  });

  it("lists invoices and transitions status draft→sent", async () => {
    const list = (await app.inject({ method: "GET", url: `/api/${tenant}/invoices`, headers: asUser(admin) })).json() as Array<{ id: string; status: string }>;
    expect(list.length).toBeGreaterThan(0);
    const id = list[0].id;
    const patch = await app.inject({ method: "PATCH", url: `/api/${tenant}/invoices/${id}`, headers: asUser(admin), payload: { status: "sent" } });
    expect(patch.statusCode).toBe(200);
    const after = (await app.inject({ method: "GET", url: `/api/${tenant}/invoices/${id}`, headers: asUser(admin) })).json() as { status: string };
    expect(after.status).toBe("sent");
  });

  it("bad status rejected (400); a plain member cannot issue an invoice (403)", async () => {
    const list = (await app.inject({ method: "GET", url: `/api/${tenant}/invoices`, headers: asUser(admin) })).json() as Array<{ id: string }>;
    expect((await app.inject({ method: "PATCH", url: `/api/${tenant}/invoices/${list[0].id}`, headers: asUser(admin), payload: { status: "nope" } })).statusCode).toBe(400);
    const denied = await app.inject({ method: "POST", url: `/api/${tenant}/invoices`, headers: asUser(member), payload: { clientId, periodStart: "2026-07-01", periodEnd: "2026-07-31", rate: 50 } });
    expect(denied.statusCode).toBe(403);
  });
});
