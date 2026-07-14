// Phase A admin console API: users & roles, identity links, module enablement, filtered
// audit, and custom-field PATCH/DELETE — against live Postgres + RLS + Cerbos.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { withGlobal } from "../db";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, linkIdentity } from "../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

async function sessionVersion(userId: string): Promise<number> {
  const { rows } = await withGlobal((c) =>
    c.query<{ session_version: number }>(`SELECT session_version FROM users WHERE id = $1`, [userId]),
  );
  return rows[0].session_version;
}

describe.skipIf(!TEST_URL)("admin API (Phase A)", () => {
  let app: NestFastifyApplication;
  let tenantA: string;
  let admin: string;
  let member: string;
  let employee: string;
  let viewerRole: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";

    tenantA = await createCompany("Agency A", ["agency"]);
    admin = await createUser("admin@a.test");
    member = await createUser("member@a.test");
    employee = await createUser("employee@a.test", "employee", "Designer");
    await addMembership(tenantA, admin);
    await addMembership(tenantA, member);
    await addMembership(tenantA, employee);

    const adminRole = await createRole("company_admin");
    const memberRole = await createRole("member");
    viewerRole = await createRole("viewer");
    await grantRole(admin, adminRole, "company", tenantA);
    await grantRole(member, memberRole, "company", tenantA);

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("GET users: admin sees members with role grants; non-admin member is denied (403)", async () => {
    const ok = await app.inject({ method: "GET", url: `/api/${tenantA}/users`, headers: asUser(admin) });
    expect(ok.statusCode).toBe(200);
    const users = ok.json() as Array<{ email: string; roles: unknown[] }>;
    expect(users.map((u) => u.email).sort()).toEqual(["admin@a.test", "employee@a.test", "member@a.test"]);
    const adminRow = users.find((u) => u.email === "admin@a.test")!;
    expect(adminRow.roles).toContainEqual(
      expect.objectContaining({ role: "company_admin", scopeType: "company", scopeId: tenantA }),
    );

    const denied = await app.inject({ method: "GET", url: `/api/${tenantA}/users`, headers: asUser(member) });
    expect(denied.statusCode).toBe(403);
  });

  it("GET roles: admin gets the catalog; a plain member does not (404, no leak)", async () => {
    const ok = await app.inject({ method: "GET", url: `/api/roles`, headers: asUser(admin) });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as Array<{ name: string }>).map((r) => r.name)).toContain("viewer");
    const denied = await app.inject({ method: "GET", url: `/api/roles`, headers: asUser(member) });
    expect(denied.statusCode).toBe(404);
  });

  it("assign + revoke a role grant; both bump the target's session_version (D11)", async () => {
    const before = await sessionVersion(employee);
    const assigned = await app.inject({
      method: "POST",
      url: `/api/${tenantA}/users/${employee}/roles`,
      headers: asUser(admin),
      payload: { roleId: viewerRole, scopeType: "company" },
    });
    expect(assigned.statusCode).toBe(201);
    const { grantId } = assigned.json() as { grantId: string };
    expect(grantId).toBeTruthy();
    expect(await sessionVersion(employee)).toBe(before + 1);

    const listed = await app.inject({ method: "GET", url: `/api/${tenantA}/users`, headers: asUser(admin) });
    const emp = (listed.json() as Array<{ email: string; roles: Array<{ grantId: string }> }>).find(
      (u) => u.email === "employee@a.test",
    )!;
    expect(emp.roles.some((r) => r.grantId === grantId)).toBe(true);

    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/${tenantA}/users/${employee}/roles/${grantId}`,
      headers: asUser(admin),
    });
    expect(revoked.statusCode).toBe(200);
    expect(await sessionVersion(employee)).toBe(before + 2);
  });

  it("assigning to a non-member is a 404", async () => {
    const stranger = await createUser("stranger@x.test");
    const r = await app.inject({
      method: "POST",
      url: `/api/${tenantA}/users/${stranger}/roles`,
      headers: asUser(admin),
      payload: { roleId: viewerRole, scopeType: "company" },
    });
    expect(r.statusCode).toBe(404);
  });

  it("identity links: list, verify, unlink (admin only)", async () => {
    await linkIdentity(employee, "telegram", "tg:9001", false);
    const linkId = (
      await withGlobal((c) =>
        c.query<{ id: string }>(`SELECT id FROM identity_links WHERE external_id = 'tg:9001'`),
      )
    ).rows[0].id;

    const list = await app.inject({ method: "GET", url: `/api/${tenantA}/identity-links`, headers: asUser(admin) });
    expect(list.statusCode).toBe(200);
    expect((list.json() as Array<{ id: string; verified_at: string | null }>).find((l) => l.id === linkId)?.verified_at).toBeNull();

    const denied = await app.inject({ method: "GET", url: `/api/${tenantA}/identity-links`, headers: asUser(member) });
    expect(denied.statusCode).toBe(403);

    const verified = await app.inject({
      method: "POST",
      url: `/api/${tenantA}/identity-links/${linkId}/verify`,
      headers: asUser(admin),
    });
    expect(verified.statusCode).toBe(200);
    const after = await withGlobal((c) =>
      c.query<{ verified_at: string | null }>(`SELECT verified_at FROM identity_links WHERE id = $1`, [linkId]),
    );
    expect(after.rows[0].verified_at).not.toBeNull();

    const unlinked = await app.inject({
      method: "DELETE",
      url: `/api/${tenantA}/identity-links/${linkId}`,
      headers: asUser(admin),
    });
    expect(unlinked.statusCode).toBe(200);
    const gone = await withGlobal((c) => c.query(`SELECT 1 FROM identity_links WHERE id = $1`, [linkId]));
    expect(gone.rowCount).toBe(0);
  });

  it("module toggle updates companies.enabled_modules", async () => {
    const enable = await app.inject({
      method: "PATCH",
      url: `/api/${tenantA}/company/modules`,
      headers: asUser(admin),
      payload: { module: "resort", enabled: true },
    });
    expect(enable.statusCode).toBe(200);
    let mods = (
      await withGlobal((c) => c.query<{ enabled_modules: string[] }>(`SELECT enabled_modules FROM companies WHERE id = $1`, [tenantA]))
    ).rows[0].enabled_modules;
    expect(mods).toContain("resort");
    expect(mods.filter((m) => m === "agency").length).toBe(1); // existing preserved, no dupes

    const disable = await app.inject({
      method: "PATCH",
      url: `/api/${tenantA}/company/modules`,
      headers: asUser(admin),
      payload: { module: "resort", enabled: false },
    });
    expect(disable.statusCode).toBe(200);
    mods = (
      await withGlobal((c) => c.query<{ enabled_modules: string[] }>(`SELECT enabled_modules FROM companies WHERE id = $1`, [tenantA]))
    ).rows[0].enabled_modules;
    expect(mods).not.toContain("resort");
  });

  it("filtered audit read returns admin-write activity and honors the verb filter", async () => {
    // The role assign/revoke above wrote role.assigned / role.revoked activities.
    const all = await app.inject({ method: "GET", url: `/api/${tenantA}/audit`, headers: asUser(admin) });
    expect(all.statusCode).toBe(200);
    const verbs = (all.json() as Array<{ verb: string }>).map((a) => a.verb);
    expect(verbs).toContain("role.assigned");

    const filtered = await app.inject({
      method: "GET",
      url: `/api/${tenantA}/audit?verb=role.assigned`,
      headers: asUser(admin),
    });
    const rows = filtered.json() as Array<{ verb: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.verb === "role.assigned")).toBe(true);
  });

  it("custom-field PATCH then DELETE (soft) round-trips", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/${tenantA}/custom-fields`,
      headers: asUser(admin),
      payload: { entityType: "project", key: "priority_note", label: "Priority Note", dataType: "text" },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: string };

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/${tenantA}/custom-fields/${id}`,
      headers: asUser(admin),
      payload: { label: "Priority Notes", required: true },
    });
    expect(patched.statusCode).toBe(200);

    const list = await app.inject({
      method: "GET",
      url: `/api/${tenantA}/custom-fields?entityType=project`,
      headers: asUser(admin),
    });
    const def = (list.json() as Array<{ key: string; label: string; required: boolean }>).find((f) => f.key === "priority_note")!;
    expect(def.label).toBe("Priority Notes");
    expect(def.required).toBe(true);

    const removed = await app.inject({ method: "DELETE", url: `/api/${tenantA}/custom-fields/${id}`, headers: asUser(admin) });
    expect(removed.statusCode).toBe(200);
    const after = await app.inject({
      method: "GET",
      url: `/api/${tenantA}/custom-fields?entityType=project`,
      headers: asUser(admin),
    });
    expect((after.json() as Array<{ key: string }>).some((f) => f.key === "priority_note")).toBe(false);
  });
});
