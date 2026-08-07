// MAIL-04 — GET /api/admin/mail/log[/:id]. Non-elevated 403; elevated sees rows + filters.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { PATH_METADATA } from "@nestjs/common/constants";
import { AdminMailController } from "./admin-mail.controller";
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

  // ── MAIL-33 follow-on: detail() had no id-shape check while its sibling thread() did ────────────
  it("detail() 400s a malformed id instead of 500ing through to Postgres", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/mail/log/not-a-uuid", headers: asUser(admin) });
    expect(res.statusCode).toBe(400);
  });

  // ── MAIL-38: rendered-body preview ──────────────────────────────────────────────────────────────
  it("preview renders the body from template_key + payload, and 403s a non-elevated caller", async () => {
    const id = await insertRow();

    const denied = await app.inject({ method: "GET", url: `/api/admin/mail/log/${id}/preview`, headers: asUser(member) });
    expect(denied.statusCode).toBe(403);

    const res = await app.inject({ method: "GET", url: `/api/admin/mail/log/${id}/preview`, headers: asUser(admin) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.templateKey).toBe("approval.actionable");
    expect(typeof body.html).toBe("string");
    expect(body.html.length).toBeGreaterThan(0);
    expect(typeof body.text).toBe("string");
    expect(body.renderedFromCurrentTemplate).toBe(true);
  });

  // The security AC, and it is a genuinely different claim from MAIL-18's. MAIL-18 proved hostile
  // inbound bytes inert AS STORED, read back from Postgres. This asserts they stay inert once
  // COMPOSED INTO HTML and served to an elevated-only page — the step MAIL-18 never exercised, and
  // the one that decides whether an admin opening a preview executes an attacker's markup.
  it("preview escapes a hostile payload instead of emitting live markup", async () => {
    const id = newId();
    await adminPool().query(
      `INSERT INTO mail_log (id, stream, tenant_id, to_email, template_key, subject, payload, status, origin_site)
       VALUES ($1, 'notify', NULL, $2, 'approval.actionable', 'xss probe', $3::jsonb, 'sent', 'test')`,
      [
        id,
        `xss-${id}@dev.gaiada.invalid`,
        JSON.stringify({
          href: "https://erp.example.invalid/approvals/1",
          subjectTitle: "<script>alert('xss')</script>",
          companyName: '"><img src=x onerror=alert(1)>',
        }),
      ],
    );

    const res = await app.inject({ method: "GET", url: `/api/admin/mail/log/${id}/preview`, headers: asUser(admin) });
    expect(res.statusCode).toBe(200);
    const html = res.json().html as string;

    // Must survive as VISIBLE TEXT, never as parsable markup. Asserting the escaped form is present
    // as well as the raw form absent, so this cannot pass by the payload silently vanishing.
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("onerror=");
    expect(html).toContain("&lt;script&gt;");
  });

  it("preview 404s (never 500s) when the row's template no longer has a renderer", async () => {
    const id = newId();
    await adminPool().query(
      `INSERT INTO mail_log (id, stream, tenant_id, to_email, template_key, subject, payload, status, origin_site)
       VALUES ($1, 'notify', NULL, $2, 'retired.template', 's', '{}'::jsonb, 'sent', 'test')`,
      [id, `retired-${id}@dev.gaiada.invalid`],
    );
    const res = await app.inject({ method: "GET", url: `/api/admin/mail/log/${id}/preview`, headers: asUser(admin) });
    expect(res.statusCode).toBe(404);
  });

  // Asserting that EVERY `:id` route agrees on a malformed id — rather than pinning `detail()`
  // alone — is what caught MAIL-33's asymmetry, the same shape as the tap/thread-authz agreement
  // test: two halves of one controller each internally consistent and never checked against each
  // other.
  //
  // MAIL-38 — now DERIVED from Nest's route metadata instead of hand-listed. The previous version
  // enumerated two literal paths and its own comment said "if a third `:id` route is ever added,
  // this list is the place to extend". MAIL-38 then added `log/:id/preview`, and this test went on
  // passing while never touching it — the guard failed at precisely the job it was written for,
  // because a manual list cannot notice what it omits. Reading the paths off the controller's own
  // metadata makes a future route covered the moment it is declared, rather than the moment
  // somebody remembers this file.
  it("every :id-taking route on this controller agrees on rejecting a malformed id with 400, never 500", async () => {
    const proto = AdminMailController.prototype as Record<string, unknown>;
    const paths = Object.getOwnPropertyNames(proto)
      .filter((k) => k !== "constructor")
      .map((k) => Reflect.getMetadata(PATH_METADATA, proto[k] as object) as unknown)
      .filter((p): p is string => typeof p === "string" && p.includes(":id"));

    // Without this the test is vacuous-by-construction: if the reflection ever returns nothing
    // (decorator metadata off, Nest changing the key), the loop below iterates zero times and the
    // test reports green having asserted precisely nothing. Pin the floor to today's three
    // (`detail`, `thread`, `preview`) so a silent drop to zero fails loudly.
    expect(paths.length).toBeGreaterThanOrEqual(3);

    for (const p of paths) {
      const url = `/api/admin/mail/${p.replace(":id", "not-a-uuid")}`;
      const res = await app.inject({ method: "GET", url, headers: asUser(admin) });
      expect(res.statusCode, `${url} must 400 on a malformed id`).toBe(400);
    }
  });
});
