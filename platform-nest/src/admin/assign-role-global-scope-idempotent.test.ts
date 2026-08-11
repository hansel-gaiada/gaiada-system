// IAM-01c-3 — regression gate for the fix that migration 0092 forced on
// admin-identity.controller.ts::assignRole (docs/superpowers/plans/2026-08-10-iam-phase1-tickets.md
// §1b "Landed from this wave").
//
// THE REGRESSION THIS GUARDS AGAINST: 0092 added a PARTIAL unique index
// `user_roles_global_scope_uniq ON user_roles (user_id, role_id, scope_type) WHERE scope_id IS NULL`
// to close the hole where the pre-existing `UNIQUE (user_id, role_id, scope_type, scope_id)` never
// fired for global grants (NULL scope_id, and SQL NULLs are never equal). `assignRole` used to
// INSERT with a TARGETED `ON CONFLICT (user_id, role_id, scope_type, scope_id) DO NOTHING`. A
// targeted arbiter only suppresses a violation raised via THAT EXACT index/constraint — it still
// does not fire on NULL scope_id, so after 0092 a re-grant of an already-held GLOBAL role would hit
// the NEW partial index (a different arbiter than the one named) and Postgres would raise an
// unhandled 23505, turning the endpoint's graceful "already granted, return the existing grantId"
// no-op path into an unhandled 500. It was changed to an UNTARGETED `ON CONFLICT DO NOTHING`, which
// arbitrates over every unique constraint on the table (including the new partial index), so the
// existing `scope_id IS NOT DISTINCT FROM $4` recovery lookup right below it can still find and
// return the survivor row.
//
// This file drives the HTTP endpoint exactly as a role-assignment UI would (not the DB layer
// directly, and not the constraint in isolation like user-roles-global-scope-uniq.test.ts already
// does) — so it is the layer this specific regression lived in. It is deliberately calibrated to
// FAIL if the controller's ON CONFLICT clause is ever re-tightened back to the targeted 4-column
// form: see the IAM-01c-3 report for the observed failure transcript from that exact revert.
//
// Also covers (per the ticket's point 3) the company-scope path with a real, non-NULL scope_id —
// the case the ORIGINAL targeted clause handled correctly and which must not regress either.
//
// Does NOT touch managed_by / the reconciler-adoption invariant (see managed-by-invariant.test.ts,
// load-bearing, not to be duplicated or contradicted here): every grant in this file is a fresh
// manual admin grant with no service_assignments in play, so managed_by is NULL throughout and out
// of scope for what this file asserts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { withGlobal } from "../db";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("IAM-01c-3 — assignRole re-grant idempotency after 0092's partial index", () => {
  let app: NestFastifyApplication;
  let tenantA: string;
  let admin: string;
  let target: string;
  let globalRole: string;
  let companyRole: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";

    tenantA = await createCompany("IAM01c3 Co", ["agency"]);
    admin = await createUser("iam01c3-admin@a.test");
    target = await createUser("iam01c3-target@a.test");
    await addMembership(tenantA, admin);
    await addMembership(tenantA, target);

    const adminRole = await createRole("company_admin");
    await grantRole(admin, adminRole, "company", tenantA);

    globalRole = await createRole("iam01c3_global_role"); // companyId null => global-grantable
    companyRole = await createRole("iam01c3_company_role");

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("re-granting an already-held GLOBAL role returns the SAME grantId twice and never 500s", async () => {
    const first = await app.inject({
      method: "POST",
      url: `/api/${tenantA}/users/${target}/roles`,
      headers: asUser(admin),
      payload: { roleId: globalRole, scopeType: "global" },
    });
    // Sanity: prove this call genuinely reaches the NULL-scope_id partial index, not some other
    // path — a targeted ON CONFLICT clause would have made the FIRST call succeed identically to
    // an untargeted one; it is the SECOND call that exposes the regression.
    expect(first.statusCode).toBe(201);
    const { grantId: firstGrantId } = first.json() as { grantId: string };
    expect(firstGrantId).toBeTruthy();

    const second = await app.inject({
      method: "POST",
      url: `/api/${tenantA}/users/${target}/roles`,
      headers: asUser(admin),
      payload: { roleId: globalRole, scopeType: "global" },
    });
    // The regression this test exists to catch: with a TARGETED `ON CONFLICT (user_id, role_id,
    // scope_type, scope_id)`, this second call raises an unhandled 23505 from the NEW partial
    // index (not the named 4-column arbiter) and the endpoint 500s instead of returning here.
    expect(second.statusCode).toBe(201);
    const { grantId: secondGrantId } = second.json() as { grantId: string };
    expect(secondGrantId).toBe(firstGrantId);

    // Prove the partial index actually did its job at the storage layer too — exactly one row,
    // not two, and it carries the survivor's id.
    const { rows } = await withGlobal((c) =>
      c.query<{ id: string; count: string }>(
        `SELECT id::text, (SELECT count(*) FROM user_roles WHERE user_id = $1 AND role_id = $2
           AND scope_type = 'global' AND scope_id IS NULL)::text AS count
         FROM user_roles WHERE user_id = $1 AND role_id = $2 AND scope_type = 'global' AND scope_id IS NULL`,
        [target, globalRole],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(firstGrantId);
    expect(rows[0].count).toBe("1");
  });

  it("re-granting an already-held COMPANY-scope role (real, non-NULL scopeId) is unaffected — the case the original targeted clause already handled", async () => {
    const other = await createUser("iam01c3-target2@a.test");
    await addMembership(tenantA, other);

    const first = await app.inject({
      method: "POST",
      url: `/api/${tenantA}/users/${other}/roles`,
      headers: asUser(admin),
      payload: { roleId: companyRole, scopeType: "company", scopeId: tenantA },
    });
    expect(first.statusCode).toBe(201);
    const { grantId: firstGrantId } = first.json() as { grantId: string };
    expect(firstGrantId).toBeTruthy();

    const second = await app.inject({
      method: "POST",
      url: `/api/${tenantA}/users/${other}/roles`,
      headers: asUser(admin),
      payload: { roleId: companyRole, scopeType: "company", scopeId: tenantA },
    });
    expect(second.statusCode).toBe(201);
    const { grantId: secondGrantId } = second.json() as { grantId: string };
    expect(secondGrantId).toBe(firstGrantId);

    const { rows } = await withGlobal((c) =>
      c.query<{ count: string }>(
        `SELECT count(*) FROM user_roles WHERE user_id = $1 AND role_id = $2 AND scope_type = 'company' AND scope_id = $3`,
        [other, companyRole, tenantA],
      ),
    );
    expect(Number(rows[0].count)).toBe(1);
  });
});
