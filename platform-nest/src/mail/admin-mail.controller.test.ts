// MAIL-04 — GET /api/admin/mail/log[/:id]. Non-elevated 403; elevated sees rows + filters.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { newId } from "../db";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

async function insertRow(opts: { stream?: "notify" | "auth"; status?: string; tenantId?: string | null; entityType?: string | null; entityId?: string | null } = {}): Promise<string> {
  const id = newId();
  await adminPool().query(
    `INSERT INTO mail_log (id, stream, tenant_id, to_email, template_key, subject, payload, status, entity_type, entity_id, origin_site)
     VALUES ($1, $2, $3, $4, 'approval.actionable', 'a subject', '{}'::jsonb, $5, $6, $7, 'test')`,
    [
      id,
      opts.stream ?? "notify",
      opts.tenantId ?? null,
      `row-${id}@dev.gaiada.invalid`,
      opts.status ?? "queued",
      opts.entityType ?? null,
      opts.entityId ?? null,
    ],
  );
  return id;
}

describe.skipIf(!TEST_URL)("admin mail log — GET /api/admin/mail/log[/:id]", () => {
  let app: NestFastifyApplication;
  let admin: string, member: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    const tenant = await createCompany("Mail Admin Test Co");
    admin = await createUser("mailadmin@a.test");
    member = await createUser("mailmember@a.test");
    await addMembership(tenant, admin);
    await addMembership(tenant, member);
    const adminRole = await createRole("platform_admin");
    const memberRole = await createRole("member");
    await grantRole(admin, adminRole, "global", null);
    await grantRole(member, memberRole, "company", tenant);
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });
  afterEach(async () => {
    await adminPool().query(`DELETE FROM mail_log`);
  });

  it("403s a non-elevated caller on the list AND the detail route", async () => {
    const id = await insertRow();
    const list = await app.inject({ method: "GET", url: "/api/admin/mail/log", headers: asUser(member) });
    const detail = await app.inject({ method: "GET", url: `/api/admin/mail/log/${id}`, headers: asUser(member) });
    expect(list.statusCode).toBe(403);
    expect(detail.statusCode).toBe(403);
  });

  it("returns rows to an elevated (platform_admin) caller", async () => {
    const id = await insertRow({ status: "sent" });
    const res = await app.inject({ method: "GET", url: "/api/admin/mail/log", headers: asUser(admin) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rows: Array<{ id: string; status: string }> };
    expect(body.rows.some((r) => r.id === id && r.status === "sent")).toBe(true);
  });

  it("filters by status and entity", async () => {
    await insertRow({ status: "queued" });
    const bounced = await insertRow({ status: "bounced", entityType: "pipeline_run", entityId: newId() });
    const res = await app.inject({
      method: "GET", url: "/api/admin/mail/log?status=bounced", headers: asUser(admin),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rows: Array<{ id: string; status: string }> };
    expect(body.rows.every((r) => r.status === "bounced")).toBe(true);
    expect(body.rows.some((r) => r.id === bounced)).toBe(true);
  });

  it("returns the full row on detail, and 404s for an unknown id", async () => {
    const id = await insertRow();
    const found = await app.inject({ method: "GET", url: `/api/admin/mail/log/${id}`, headers: asUser(admin) });
    expect(found.statusCode).toBe(200);
    expect(found.json().id).toBe(id);
    const missing = await app.inject({ method: "GET", url: `/api/admin/mail/log/${newId()}`, headers: asUser(admin) });
    expect(missing.statusCode).toBe(404);
  });
});
