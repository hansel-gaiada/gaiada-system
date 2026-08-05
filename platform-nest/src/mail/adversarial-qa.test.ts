// MAIL-04 QA gate — adversarial probes beyond the implementer's own suite (per the ticket's
// "highest-risk property" instruction: mail_log/mail_suppressions/mail_messages are GLOBAL, no
// RLS, so app-layer authz on the admin log endpoints is the ONLY backstop). Covers:
//   1. A company-SCOPED platform_admin/group_executive (not global scope) must NOT count as
//      elevated — isElevated() checks scopeType === 'global' but this proves it end-to-end through
//      the real HTTP surface, not just by reading the predicate's source.
//   2. A client-kind member (no admin role at all) gets 403, same as staff.
//   3. Filter params cannot be used for SQL injection (parameterized queries) — a malicious
//      `status`/`entityId`/`tenantId` value must error safely (invalid uuid) or return zero rows,
//      never execute injected SQL or leak unrelated rows.
//   4. A NULL-tenant row (auth mail) is readable by a real elevated admin (the ONLY read path
//      design §6.1 grants it) and not by a non-elevated caller.
//   5. Pagination bounds (limit) cannot be pushed past the hard cap (500).
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { newId } from "../db";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

async function insertRow(opts: {
  stream?: "notify" | "auth";
  status?: string;
  tenantId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
} = {}): Promise<string> {
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

describe.skipIf(!TEST_URL)("MAIL-04 QA gate — adversarial admin-log authz probes", () => {
  let app: NestFastifyApplication;
  let tenantScopedAdmin: string, clientOnly: string, realAdmin: string, tenantA: string, tenantB: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    tenantA = await createCompany("QA Mail Tenant A");
    tenantB = await createCompany("QA Mail Tenant B");
    tenantScopedAdmin = await createUser("tenant-scoped-admin@a.test");
    clientOnly = await createUser("client-only@a.test");
    realAdmin = await createUser("real-admin@a.test");
    await addMembership(tenantA, tenantScopedAdmin);
    await addMembership(tenantA, clientOnly, "service"); // stand-in for a non-elevated principal
    await addMembership(tenantA, realAdmin);

    const adminRole = await createRole("platform_admin");
    const execRole = await createRole("group_executive");
    const memberRole = await createRole("member");

    // The attack: grant platform_admin, but SCOPED TO A COMPANY, not global. If the endpoint
    // mistakenly checked role name alone (ignoring scope), this caller would pass.
    await grantRole(tenantScopedAdmin, adminRole, "company", tenantA);
    // Also try the group_executive company-scoped variant.
    await grantRole(tenantScopedAdmin, execRole, "company", tenantB);
    await grantRole(clientOnly, memberRole, "company", tenantA);
    await grantRole(realAdmin, adminRole, "global", null);

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });
  afterEach(async () => {
    await adminPool().query(`DELETE FROM mail_log`);
  });

  it("company-scoped platform_admin AND company-scoped group_executive are BOTH denied — scope, not role name, gates elevation", async () => {
    const id = await insertRow({ tenantId: tenantA });
    const list = await app.inject({ method: "GET", url: "/api/admin/mail/log", headers: asUser(tenantScopedAdmin) });
    const detail = await app.inject({
      method: "GET",
      url: `/api/admin/mail/log/${id}`,
      headers: asUser(tenantScopedAdmin),
    });
    expect(list.statusCode).toBe(403);
    expect(detail.statusCode).toBe(403);
  });

  it("a client/non-admin member is denied on both routes", async () => {
    const id = await insertRow({ tenantId: tenantA });
    const list = await app.inject({ method: "GET", url: "/api/admin/mail/log", headers: asUser(clientOnly) });
    const detail = await app.inject({ method: "GET", url: `/api/admin/mail/log/${id}`, headers: asUser(clientOnly) });
    expect(list.statusCode).toBe(403);
    expect(detail.statusCode).toBe(403);
  });

  it("a real GLOBAL elevated admin CAN read a row belonging to a tenant they have no membership in, AND a NULL-tenant (auth mail) row — this is the design's only read path, not a bypass", async () => {
    const crossTenantRow = await insertRow({ tenantId: tenantB, stream: "notify" });
    const nullTenantRow = await insertRow({ tenantId: null, stream: "auth" });
    const detailCross = await app.inject({
      method: "GET",
      url: `/api/admin/mail/log/${crossTenantRow}`,
      headers: asUser(realAdmin),
    });
    const detailNull = await app.inject({
      method: "GET",
      url: `/api/admin/mail/log/${nullTenantRow}`,
      headers: asUser(realAdmin),
    });
    expect(detailCross.statusCode).toBe(200);
    expect(detailNull.statusCode).toBe(200);
    expect(detailNull.json().tenant_id).toBeNull();
  });

  it("SQL-injection-shaped TEXT filter values (status/stream/since) are inert: parameterized queries never execute injected SQL and never leak rows", async () => {
    await insertRow({ tenantId: tenantA, status: "sent" });
    await insertRow({ tenantId: tenantB, status: "bounced" });
    const attempts = [
      "/api/admin/mail/log?status=sent' OR '1'='1",
      "/api/admin/mail/log?stream=notify' UNION SELECT * FROM users --",
      "/api/admin/mail/log?status=x'; DROP TABLE mail_log; --",
    ];
    for (const url of attempts) {
      // eslint-disable-next-line no-await-in-loop
      const res = await app.inject({ method: "GET", url, headers: asUser(realAdmin) });
      // Never a 500 (injected SQL treated as a literal string value, not executed) and never a
      // full-table dump (a literal string like "sent' OR '1'='1" matches no real status/tenant/etc).
      expect(res.statusCode).not.toBe(500);
      if (res.statusCode === 200) {
        const body = res.json() as { rows: unknown[] };
        expect(body.rows.length).toBe(0);
      }
    }
    // Table must still exist and be queryable after the DROP TABLE attempt.
    const stillThere = await adminPool().query(`SELECT count(*) FROM mail_log`);
    expect(Number(stillThere.rows[0].count)).toBeGreaterThanOrEqual(2);
  });

  // DEFECT FIXED (senior-be, MAIL-05 pass): tenantId/entityId (`uuid`) and `since` (`timestamptz`)
  // are typed columns. A malformed value for any of the three was always safely PARAMETERIZED (no
  // injection, no data leak — still true and still asserted below), but the raw Postgres "invalid
  // input syntax for type X" error was previously uncaught and surfaced as a bare 500 instead of a
  // 400. `admin-mail.controller.ts` now shape-checks each filter (uuid regex / `Date.parse`,
  // matching `pm.controller.ts`'s `UUID_RE` / `search.controller.ts`'s `assertUuid` convention)
  // BEFORE the query runs, so a malformed filter is a clean 400 and never reaches the DB layer.
  it("a malformed tenantId/entityId/since 400s cleanly (fixed — was a bare 500) and leaks nothing: response body is the generic sanitized error, not a DB error string or stack trace", async () => {
    for (const url of [
      "/api/admin/mail/log?tenantId=' OR 1=1 --",
      "/api/admin/mail/log?entityId=not-a-uuid",
      "/api/admin/mail/log?since=2020-01-01' OR '1'='1",
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await app.inject({ method: "GET", url, headers: asUser(realAdmin) });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error?: string; code?: string };
      expect(JSON.stringify(body)).not.toMatch(/invalid input syntax|postgres|pg\.lib|OR 1=1/i);
    }
  });

  it("limit is hard-capped at 500 regardless of what the caller requests", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/mail/log?limit=999999",
      headers: asUser(realAdmin),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().limit).toBe(500);
  });

  it("a negative/garbage offset does not throw and normalizes to 0", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/mail/log?offset=-100",
      headers: asUser(realAdmin),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().offset).toBe(0);
  });
});
