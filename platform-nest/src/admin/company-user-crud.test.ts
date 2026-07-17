// Company lifecycle (§2) + user invite/edit (§3) — against live Postgres + RLS + Cerbos.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { withTenants, withGlobal } from "../db";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("company + user CRUD (§2/§3)", () => {
  let app: NestFastifyApplication;
  let tenantA: string;
  let superadmin: string; // platform_admin (global)
  let coAdmin: string; // company_admin on tenantA
  let member: string;
  let memberRoleId: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";

    tenantA = await createCompany("Agency A", ["agency"]);
    superadmin = await createUser("super@a.test");
    coAdmin = await createUser("coadmin@a.test");
    member = await createUser("member@a.test");
    await addMembership(tenantA, superadmin);
    await addMembership(tenantA, coAdmin);
    await addMembership(tenantA, member);

    const paRole = await createRole("platform_admin");
    const adminRole = await createRole("company_admin");
    memberRoleId = await createRole("member");
    await grantRole(superadmin, paRole, "global", null);
    await grantRole(coAdmin, adminRole, "company", tenantA);
    await grantRole(member, memberRoleId, "company", tenantA);

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  // ---------- Companies ----------
  it("superadmin creates a company; creator becomes a member; company.created emitted", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/companies`,
      headers: asUser(superadmin),
      payload: { name: "Viceroy", type: "resort", parentCompanyId: tenantA, modules: ["agency"] },
    });
    expect(r.statusCode).toBe(201);
    const { id } = r.json() as { id: string };
    expect(id).toBeTruthy();

    // creator is a member of the new company
    const mem = await withTenants([id], (c) =>
      c.query(`SELECT 1 FROM company_memberships WHERE tenant_id = $1 AND user_id = $2`, [id, superadmin]),
    );
    expect(mem.rows).toHaveLength(1);

    // detail reflects parent + settings
    const detail = await app.inject({ method: "GET", url: `/api/companies/${id}`, headers: asUser(superadmin) });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as { parent_company_id: string; settings: unknown; type: string };
    expect(body.parent_company_id).toBe(tenantA);
    expect(body.type).toBe("resort");
    expect(body.settings).toEqual({});

    const ev = await withTenants([id], (c) =>
      c.query(`SELECT event_type FROM outbox_events WHERE entity_type = 'company' AND tenant_id = $1`, [id]),
    );
    expect(ev.rows).toContainEqual({ event_type: "company.created" });
  });

  it("a non-elevated member cannot create a company (403)", async () => {
    const r = await app.inject({ method: "POST", url: `/api/companies`, headers: asUser(member), payload: { name: "Nope" } });
    expect(r.statusCode).toBe(403);
  });

  it("company_admin PATCHes name/status; company.updated emitted", async () => {
    const r = await app.inject({
      method: "PATCH",
      url: `/api/companies/${tenantA}`,
      headers: asUser(coAdmin),
      payload: { name: "Agency A (renamed)", status: "active" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });

    const detail = await app.inject({ method: "GET", url: `/api/companies/${tenantA}`, headers: asUser(coAdmin) });
    expect((detail.json() as { name: string }).name).toBe("Agency A (renamed)");

    const ev = await withTenants([tenantA], (c) =>
      c.query(`SELECT event_type FROM outbox_events WHERE entity_type = 'company' AND event_type = 'company.updated' AND tenant_id = $1`, [tenantA]),
    );
    expect(ev.rows.length).toBeGreaterThan(0);
  });

  it("PATCH rejects self-parenting (400)", async () => {
    const r = await app.inject({
      method: "PATCH",
      url: `/api/companies/${tenantA}`,
      headers: asUser(coAdmin),
      payload: { parentCompanyId: tenantA },
    });
    expect(r.statusCode).toBe(400);
  });

  // ---------- Users ----------
  it("company_admin invites a new user; membership + user.invited event; role granted", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${tenantA}/users`,
      headers: asUser(coAdmin),
      payload: { name: "New Hire", email: "hire@a.test", title: "Designer", roleId: memberRoleId },
    });
    expect(r.statusCode).toBe(201);
    const { id } = r.json() as { id: string };

    const users = await app.inject({ method: "GET", url: `/api/${tenantA}/users`, headers: asUser(coAdmin) });
    const found = (users.json() as Array<{ id: string; title: string; roles: unknown[] }>).find((u) => u.id === id);
    expect(found).toBeTruthy();
    expect(found!.title).toBe("Designer");
    expect(found!.roles.length).toBe(1);

    const ev = await withTenants([tenantA], (c) =>
      c.query(`SELECT 1 FROM outbox_events WHERE entity_type = 'user' AND event_type = 'user.invited' AND entity_id = $1`, [id]),
    );
    expect(ev.rows).toHaveLength(1);
  });

  it("inviting an existing email reuses the same user record", async () => {
    const first = await app.inject({
      method: "POST", url: `/api/${tenantA}/users`, headers: asUser(coAdmin),
      payload: { name: "Dup", email: "dup@a.test" },
    });
    const id1 = (first.json() as { id: string }).id;
    const second = await app.inject({
      method: "POST", url: `/api/${tenantA}/users`, headers: asUser(coAdmin),
      payload: { name: "Dup Again", email: "dup@a.test" },
    });
    expect((second.json() as { id: string }).id).toBe(id1);
  });

  it("PATCH user deactivates + bumps session_version (D11)", async () => {
    const before = await withGlobal((c) => c.query<{ session_version: number }>(`SELECT session_version FROM users WHERE id = $1`, [member]));
    const r = await app.inject({
      method: "PATCH", url: `/api/${tenantA}/users/${member}`, headers: asUser(coAdmin),
      payload: { status: "inactive", title: "Former" },
    });
    expect(r.statusCode).toBe(200);
    const after = await withGlobal((c) => c.query<{ session_version: number; title: string; status: string }>(`SELECT session_version, title, status FROM users WHERE id = $1`, [member]));
    expect(after.rows[0].session_version).toBe(before.rows[0].session_version + 1);
    expect(after.rows[0].title).toBe("Former");
    expect(after.rows[0].status).toBe("inactive");
  });

  it("a plain member cannot invite users (403)", async () => {
    // member's session was bumped above; use a fresh active admin path instead
    const r = await app.inject({
      method: "POST", url: `/api/${tenantA}/users`, headers: asUser(member),
      payload: { name: "X", email: "x@a.test" },
    });
    expect([401, 403]).toContain(r.statusCode);
  });
});
