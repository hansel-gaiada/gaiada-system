// ORG-7b — closes the membership-side A14 gap + builds the read surface UX-2 needs:
//   1. inviteUser's A14 hook (mirrors assignRole's, on company_memberships instead of user_roles).
//   2. GET /api/me `serviceScopes`.
//   3. GET assignments / GET service-units (Envelope-shaped, RLS-safe fan-out).
//   4. `?includeService=1` member badging.
//   5. `?dryRun=1` staff preview on the propose endpoint.
// All behind SERVICE_ASSIGNMENTS_ENABLED (default off) — a dedicated describe block proves the
// off-state is unchanged/inert for each surface.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { withGlobal, withTenants, newId } from "../db";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { registerModule, resetModules } from "../modules/registry";
import { reconcileAssignment } from "./service-reconciler";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("ORG-7b — membership A14 fix + read surface", () => {
  let app: NestFastifyApplication;
  let A: string; // provider
  let B: string; // target, same holding as A
  let providerAdmin: string;
  let targetAdmin: string;
  let globalExec: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.serviceAssignmentsEnabled = true;

    for (const key of ["org7b_hr", "org7b_hr2", "org7b_hr3", "org7b_hr4", "org7b_hr5"]) {
      registerModule({
        key, migrations: [], permissions: [], customFieldTargets: [], mcpTools: [], rollupProviders: [], uiManifest: [],
      });
      await createRole(`${key}_staff`);
      await createRole(`${key}_manager`);
    }

    A = await createCompany("ORG7b Provider");
    B = await createCompany("ORG7b Target", [], A);

    providerAdmin = await createUser("org7b-provider-admin@a.test");
    targetAdmin = await createUser("org7b-target-admin@b.test");
    globalExec = await createUser("org7b-exec@holding.test");
    await addMembership(A, providerAdmin);
    await addMembership(B, targetAdmin);

    const companyAdminRole = await createRole("company_admin");
    const execRole = await createRole("platform_admin");
    await grantRole(providerAdmin, companyAdminRole, "company", A);
    await grantRole(targetAdmin, companyAdminRole, "company", B);
    await grantRole(globalExec, execRole, "global", null);
    // MON-00c: platform_admin's rules are gated on `variables.inRoot`, and a root resolves from
    // `users.home_company_id` or an active membership. This exec holds a GLOBAL grant and therefore
    // has no membership, so it resolved `rootCompanies: []` and every call below 403'd. Anchored to
    // A, this fixture's ROOT company, via home_company_id rather than a membership — a
    // membership would place the exec inside the very companies these assertions count.
    await adminPool().query(`UPDATE users SET home_company_id = $1 WHERE id = $2`, [A, globalExec]);

    app = await buildApp();

    await app.inject({
      method: "PUT",
      url: `/api/${A}/org-structure`,
      headers: asUser(providerAdmin),
      payload: {
        root: {
          id: "root", name: "Provider Co", kind: "company",
          children: [{ id: "d-hr", name: "HR", kind: "department", children: [] }],
        },
      },
    });
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
    resetModules();
  });

  // ---- 1. membership-side A14 fix ----
  describe("inviteUser A14 membership hook", () => {
    it("re-inviting a person who has a reconciler-managed service membership adopts it as manual — a later revoke leaves it intact", async () => {
      const staffer = await createUser("org7b-a14-staffer@x.test");
      await addMembership(A, staffer);
      await app.inject({
        method: "PUT",
        url: `/api/${A}/org-structure`,
        headers: asUser(providerAdmin),
        payload: {
          root: {
            id: "root", name: "P", kind: "company",
            children: [{ id: "d-hr", name: "HR", kind: "department", children: [
              { id: "p1", name: "S", kind: "person", assigneeId: staffer },
            ] }],
          },
        },
      });
      const created = await app.inject({
        method: "POST",
        url: `/api/${A}/org-structure/units/d-hr/assignments`,
        headers: asUser(globalExec), // active immediately
        payload: { targets: [B], module: "org7b_hr" },
      });
      const assignmentId = (created.json() as { assignments: Array<{ id: string }> }).assignments[0].id;

      // Materialize via manual reconcile (proven path from ORG-7's suite).
      await reconcileAssignment(assignmentId, A);
      const membershipBefore = await withTenants([B], (c) =>
        c.query<{ kind: string; managed_by: string | null }>(
          `SELECT kind, managed_by FROM company_memberships WHERE tenant_id = $1 AND user_id = $2`,
          [B, staffer],
        ),
      );
      expect(membershipBefore.rows[0].kind).toBe("service");
      expect(membershipBefore.rows[0].managed_by).not.toBeNull();

      // Target company_admin explicitly invites/onboards this SAME person via the real endpoint —
      // this is the A14 collision: the invite hits (re-activates) a reconciler-managed row.
      const invite = await app.inject({
        method: "POST",
        url: `/api/${B}/users`,
        headers: asUser(targetAdmin),
        payload: { name: "Staffer S", email: "org7b-a14-staffer@x.test" },
      });
      expect(invite.statusCode).toBe(201);

      // Adopted: kind flips to 'employee', managed_by cleared.
      const membershipAfter = await withTenants([B], (c) =>
        c.query<{ kind: string; managed_by: string | null; id: string }>(
          `SELECT id, kind, managed_by FROM company_memberships WHERE tenant_id = $1 AND user_id = $2`,
          [B, staffer],
        ),
      );
      expect(membershipAfter.rows[0].kind).toBe("employee");
      expect(membershipAfter.rows[0].managed_by).toBeNull();
      const membershipId = membershipAfter.rows[0].id;

      // Revoke the OWNING assignment and reconcile: the now-manual membership must SURVIVE.
      await app.inject({
        method: "DELETE",
        url: `/api/${A}/org-structure/assignments/${assignmentId}`,
        headers: asUser(providerAdmin),
      });
      await reconcileAssignment(assignmentId, A);
      const membershipSurvived = await withTenants([B], (c) =>
        c.query<{ status: string; deleted_at: string | null }>(
          `SELECT status, deleted_at FROM company_memberships WHERE id = $1`,
          [membershipId],
        ),
      );
      expect(membershipSurvived.rows[0].status).toBe("active");
      expect(membershipSurvived.rows[0].deleted_at).toBeNull();
    });

    it("a fresh invite (no prior service membership) is completely unaffected", async () => {
      const r = await app.inject({
        method: "POST",
        url: `/api/${B}/users`,
        headers: asUser(targetAdmin),
        payload: { name: "Plain Hire", email: "org7b-plain-hire@x.test" },
      });
      expect(r.statusCode).toBe(201);
      const userId = (r.json() as { id: string }).id;
      const row = await withTenants([B], (c) =>
        c.query<{ kind: string; managed_by: string | null }>(
          `SELECT kind, managed_by FROM company_memberships WHERE tenant_id = $1 AND user_id = $2`,
          [B, userId],
        ),
      );
      expect(row.rows[0].kind).toBe("employee");
      expect(row.rows[0].managed_by).toBeNull();
    });

    it("the A14 membership hook is INERT when the flag is off", async () => {
      const staffer = await createUser("org7b-a14-flagoff@x.test");
      await addMembership(A, staffer);
      await app.inject({
        method: "PUT",
        url: `/api/${A}/org-structure`,
        headers: asUser(providerAdmin),
        payload: {
          root: {
            id: "root", name: "P", kind: "company",
            children: [{ id: "d-hr", name: "HR", kind: "department", children: [
              { id: "p1", name: "S", kind: "person", assigneeId: staffer },
            ] }],
          },
        },
      });
      const created = await app.inject({
        method: "POST",
        url: `/api/${A}/org-structure/units/d-hr/assignments`,
        headers: asUser(globalExec),
        payload: { targets: [B], module: "org7b_hr2" },
      });
      const assignmentId = (created.json() as { assignments: Array<{ id: string }> }).assignments[0].id;
      await reconcileAssignment(assignmentId, A);
      const before = await withTenants([B], (c) =>
        c.query<{ id: string; managed_by: string | null }>(
          `SELECT id, managed_by FROM company_memberships WHERE tenant_id = $1 AND user_id = $2`,
          [B, staffer],
        ),
      );
      expect(before.rows[0].managed_by).not.toBeNull();

      config.serviceAssignmentsEnabled = false;
      try {
        const invite = await app.inject({
          method: "POST",
          url: `/api/${B}/users`,
          headers: asUser(targetAdmin),
          payload: { name: "Staffer", email: "org7b-a14-flagoff@x.test" },
        });
        expect(invite.statusCode).toBe(201);
        const after = await withTenants([B], (c) =>
          c.query<{ managed_by: string | null; kind: string }>(
            `SELECT managed_by, kind FROM company_memberships WHERE id = $1`,
            [before.rows[0].id],
          ),
        );
        // Unchanged: still reconciler-managed — the hook did nothing while the flag is off.
        expect(after.rows[0].managed_by).toBe(before.rows[0].managed_by);
        expect(after.rows[0].kind).toBe("service");
      } finally {
        config.serviceAssignmentsEnabled = true;
      }
    });
  });

  // ---- 2. /api/me serviceScopes ----
  describe("GET /api/me serviceScopes", () => {
    it("lists exactly the companies this user has active service access into, and nothing cross-scoped", async () => {
      const staffer = await createUser("org7b-scopes-staffer@x.test");
      await addMembership(A, staffer);
      const C = await createCompany("ORG7b Scopes Other Target", [], A);
      await app.inject({
        method: "PUT",
        url: `/api/${A}/org-structure`,
        headers: asUser(providerAdmin),
        payload: {
          root: {
            id: "root", name: "P", kind: "company",
            children: [{ id: "d-hr", name: "HR", kind: "department", children: [
              { id: "p1", name: "SC", kind: "person", assigneeId: staffer },
            ] }],
          },
        },
      });
      const created = await app.inject({
        method: "POST",
        url: `/api/${A}/org-structure/units/d-hr/assignments`,
        headers: asUser(globalExec),
        payload: { targets: [B], module: "org7b_hr3" },
      });
      const assignmentId = (created.json() as { assignments: Array<{ id: string }> }).assignments[0].id;
      await reconcileAssignment(assignmentId, A);

      const me = await app.inject({ method: "GET", url: "/api/me", headers: asUser(staffer) });
      expect(me.statusCode).toBe(200);
      const body = me.json() as { serviceScopes: Array<{ companyId: string; module: string; role: string }> };
      const companyIds = body.serviceScopes.map((s) => s.companyId);
      expect(companyIds).toContain(B);
      expect(companyIds).not.toContain(C); // never served C — must not leak into scopes
      expect(companyIds).not.toContain(A); // provider itself is not a "served" company for this user
      const bScope = body.serviceScopes.find((s) => s.companyId === B)!;
      expect(bScope.module).toBe("org7b_hr3");
      expect(bScope.role).toBe("staff");
    });

    it("a stale managed_by grant with no live membership does NOT widen serviceScopes past principal.companies (architect gate hardening)", async () => {
      const staffer = await createUser("org7b-scopes-stale@x.test");
      await addMembership(A, staffer);
      const X = await createCompany("ORG7b Scopes Stale Target", [], A);
      await app.inject({
        method: "PUT",
        url: `/api/${A}/org-structure`,
        headers: asUser(providerAdmin),
        payload: {
          root: {
            id: "root", name: "P", kind: "company",
            children: [{ id: "d-hr", name: "HR", kind: "department", children: [
              { id: "p1", name: "SC", kind: "person", assigneeId: staffer },
            ] }],
          },
        },
      });
      const created = await app.inject({
        method: "POST",
        url: `/api/${A}/org-structure/units/d-hr/assignments`,
        headers: asUser(globalExec),
        payload: { targets: [X], module: "org7b_hr4" },
      });
      const assignmentId = (created.json() as { assignments: Array<{ id: string }> }).assignments[0].id;
      await reconcileAssignment(assignmentId, A);

      // Sanity: freshly reconciled, X shows up like any other served company.
      const before = await app.inject({ method: "GET", url: "/api/me", headers: asUser(staffer) });
      const beforeIds = (before.json() as { serviceScopes: Array<{ companyId: string }> }).serviceScopes.map(
        (s) => s.companyId,
      );
      expect(beforeIds).toContain(X);

      // Simulate drift: something OTHER than the reconciler's own suspend/clear sequence tears
      // down the materialized company_memberships row at X, while user_roles.managed_by (the
      // candidate-sizing marker) and the backing service_grant_claims/service_assignments row
      // are left untouched. This is the exact "stale grant, no live membership" scenario the
      // architect flagged: the un-intersected candidate set would still contain X, and the
      // inner authoritative query (service_grant_claims + service_assignments.status='active')
      // doesn't reference company_memberships at all, so pre-fix this would still surface X.
      await adminPool().query(
        `UPDATE company_memberships SET status = 'inactive', deleted_at = now(), updated_at = now()
         WHERE tenant_id = $1 AND user_id = $2`,
        [X, staffer],
      );

      const after = await app.inject({ method: "GET", url: "/api/me", headers: asUser(staffer) });
      expect(after.statusCode).toBe(200);
      const afterBody = after.json() as { serviceScopes: Array<{ companyId: string }>; companies: Array<{ id: string }> };
      expect(afterBody.companies.map((c) => c.id)).not.toContain(X); // principal.companies is live too
      expect(afterBody.serviceScopes.map((s) => s.companyId)).not.toContain(X); // the fix under test
    });

    it("a user with no service grants gets an empty serviceScopes", async () => {
      const plain = await createUser("org7b-scopes-none@x.test");
      await addMembership(A, plain);
      const me = await app.inject({ method: "GET", url: "/api/me", headers: asUser(plain) });
      expect((me.json() as { serviceScopes: unknown[] }).serviceScopes).toEqual([]);
    });

    it("serviceScopes is empty when the flag is off", async () => {
      const staffer = await createUser("org7b-scopes-flagoff@x.test");
      await addMembership(A, staffer);
      await addMembership(B, staffer); // manual membership so /me itself still resolves cleanly
      config.serviceAssignmentsEnabled = false;
      try {
        const me = await app.inject({ method: "GET", url: "/api/me", headers: asUser(staffer) });
        expect((me.json() as { serviceScopes: unknown[] }).serviceScopes).toEqual([]);
      } finally {
        config.serviceAssignmentsEnabled = true;
      }
    });
  });

  // ---- 3. GET assignments / GET service-units (Envelope) ----
  describe("GET assignments + GET service-units (Envelope<T>)", () => {
    it("GET assignments?direction=provided returns an Envelope with this company included:true and the created row", async () => {
      const created = await app.inject({
        method: "POST",
        url: `/api/${A}/org-structure/units/d-hr/assignments`,
        headers: asUser(globalExec),
        payload: { targets: [B], module: "org7b_hr4" },
      });
      const id = (created.json() as { assignments: Array<{ id: string }> }).assignments[0].id;

      const list = await app.inject({
        method: "GET",
        url: `/api/${A}/org-structure/assignments?direction=provided`,
        headers: asUser(providerAdmin),
      });
      expect(list.statusCode).toBe(200);
      const body = list.json() as { items: Array<{ id: string }>; companies: Array<{ id: string; included: boolean }> };
      expect(body.items.some((r) => r.id === id)).toBe(true);
      expect(body.companies).toEqual([{ id: A, name: expect.any(String), included: true }]);
    });

    it("GET assignments?direction=served, from the target side, sees the same row from its own perspective", async () => {
      const list = await app.inject({
        method: "GET",
        url: `/api/${B}/org-structure/assignments?direction=served`,
        headers: asUser(targetAdmin),
      });
      expect(list.statusCode).toBe(200);
      const body = list.json() as { items: Array<{ targetTenantId: string }> };
      expect(body.items.every((r) => r.targetTenantId === B)).toBe(true);
      expect(body.items.length).toBeGreaterThan(0);
    });

    it("a companyIds fan-out to a company the caller cannot see reports included:false, no_access — and leaks NO rows from it", async () => {
      const D = await createCompany("ORG7b Unrelated Co"); // no holding relation, no membership for providerAdmin
      const list = await app.inject({
        method: "GET",
        url: `/api/${A}/org-structure/assignments?direction=provided&companyIds=${D}`,
        headers: asUser(providerAdmin),
      });
      expect(list.statusCode).toBe(200);
      const body = list.json() as { items: unknown[]; companies: Array<{ id: string; included: boolean; reason?: string }> };
      const dEntry = body.companies.find((c) => c.id === D)!;
      expect(dEntry.included).toBe(false);
      expect(dEntry.reason).toBe("no_access");
      // No row belonging to D leaked into items (there are none for D anyway, but assert the shape holds).
      expect(body.items.every((r) => (r as { providerTenantId?: string }).providerTenantId !== D)).toBe(true);
    });

    it("GET service-units lists only units that actually have a live-ish assignment", async () => {
      const list = await app.inject({
        method: "GET",
        url: `/api/${A}/org-structure/service-units`,
        headers: asUser(providerAdmin),
      });
      expect(list.statusCode).toBe(200);
      const body = list.json() as { items: Array<{ nodeId: string; servedCompanyCount: number; modules: string[] }>; companies: unknown[] };
      const hrUnit = body.items.find((u) => u.nodeId === "d-hr");
      expect(hrUnit).toBeDefined();
      expect(hrUnit!.servedCompanyCount).toBeGreaterThan(0);
      // Module key from whichever prior test in this file left a live assignment standing on
      // d-hr — this assertion only cares that SOME real module key shows up, not which one.
      expect(hrUnit!.modules.length).toBeGreaterThan(0);
    });

    it("both new GET reads 409 when the flag is off", async () => {
      config.serviceAssignmentsEnabled = false;
      try {
        const a = await app.inject({ method: "GET", url: `/api/${A}/org-structure/assignments`, headers: asUser(providerAdmin) });
        expect(a.statusCode).toBe(409);
        const b = await app.inject({ method: "GET", url: `/api/${A}/org-structure/service-units`, headers: asUser(providerAdmin) });
        expect(b.statusCode).toBe(409);
      } finally {
        config.serviceAssignmentsEnabled = true;
      }
    });

    it("company_admin with no visibility into the URL tenant is denied (403), not handed an envelope", async () => {
      const outsider = await createUser("org7b-outsider@x.test");
      const r = await app.inject({
        method: "GET",
        url: `/api/${A}/org-structure/assignments`,
        headers: asUser(outsider),
      });
      expect(r.statusCode).toBe(403);
    });
  });

  // ---- 4. includeService=1 member badging ----
  describe("?includeService=1 member badging", () => {
    it("default GET members hides service-kind rows; includeService=1 shows both kinds and marks them", async () => {
      const staffer = await createUser("org7b-badge-staffer@x.test");
      await addMembership(A, staffer);
      await app.inject({
        method: "PUT",
        url: `/api/${A}/org-structure`,
        headers: asUser(providerAdmin),
        payload: {
          root: {
            id: "root", name: "P", kind: "company",
            children: [{ id: "d-hr", name: "HR", kind: "department", children: [
              { id: "p1", name: "Badge", kind: "person", assigneeId: staffer },
            ] }],
          },
        },
      });
      const created = await app.inject({
        method: "POST",
        url: `/api/${A}/org-structure/units/d-hr/assignments`,
        headers: asUser(globalExec),
        payload: { targets: [B], module: "org7b_hr5" },
      });
      const assignmentId = (created.json() as { assignments: Array<{ id: string }> }).assignments[0].id;
      await reconcileAssignment(assignmentId, A);

      const defaultList = await app.inject({ method: "GET", url: `/api/${B}/members`, headers: asUser(targetAdmin) });
      const defaultRows = defaultList.json() as Array<{ user_id: string }>;
      expect(defaultRows.some((r) => r.user_id === staffer)).toBe(false); // hidden by default

      const withService = await app.inject({
        method: "GET",
        url: `/api/${B}/members?includeService=1`,
        headers: asUser(targetAdmin),
      });
      const rows = withService.json() as Array<{ user_id: string; isService?: boolean }>;
      const row = rows.find((r) => r.user_id === staffer);
      expect(row).toBeDefined();
      expect(row!.isService).toBe(true);

      // targetAdmin themself is a real employee — must be present and NOT marked service, in both reads.
      expect(defaultRows.some((r) => r.user_id === targetAdmin)).toBe(true);
      const adminRow = rows.find((r) => r.user_id === targetAdmin);
      expect(adminRow!.isService).toBe(false);
    });

    it("members read is completely unaffected (no kind filter, no isService field) when the flag is off", async () => {
      config.serviceAssignmentsEnabled = false;
      try {
        const r = await app.inject({ method: "GET", url: `/api/${B}/members?includeService=1`, headers: asUser(targetAdmin) });
        expect(r.statusCode).toBe(200);
        const rows = r.json() as Array<{ isService?: boolean }>;
        expect(rows.every((row) => row.isService === undefined)).toBe(true);
      } finally {
        config.serviceAssignmentsEnabled = true;
      }
    });
  });

  // ---- 5. ?dryRun=1 staff preview ----
  describe("?dryRun=1 propose preview", () => {
    it("previews who WOULD be materialized without writing a service_assignments row", async () => {
      const staffer1 = await createUser("org7b-dryrun-1@x.test");
      const staffer2 = await createUser("org7b-dryrun-2@x.test");
      await addMembership(A, staffer1);
      await addMembership(A, staffer2);
      await app.inject({
        method: "PUT",
        url: `/api/${A}/org-structure`,
        headers: asUser(providerAdmin),
        payload: {
          root: {
            id: "root", name: "P", kind: "company",
            children: [{ id: "d-hr", name: "HR", kind: "department", children: [
              { id: "p1", name: "One", kind: "person", assigneeId: staffer1 },
              { id: "p2", name: "Two", kind: "person", assigneeId: staffer2 },
            ] }],
          },
        },
      });

      const before = await withTenants([A], (c) =>
        c.query<{ n: string }>(`SELECT count(*) AS n FROM service_assignments WHERE provider_tenant_id = $1`, [A]),
      );

      const dry = await app.inject({
        method: "POST",
        url: `/api/${A}/org-structure/units/d-hr/assignments?dryRun=1`,
        headers: asUser(providerAdmin),
        payload: { targets: [B], module: "org7b_hr", leadUserId: staffer1 },
      });
      expect(dry.statusCode).toBe(201);
      const body = dry.json() as {
        dryRun: boolean;
        items: Array<{ userId: string; role: string }>;
        companies: Array<{ id: string; included: boolean }>;
      };
      expect(body.dryRun).toBe(true);
      expect(body.companies).toEqual([{ id: B, name: expect.any(String), included: true }]);
      const ids = body.items.map((i) => i.userId);
      expect(ids).toContain(staffer1);
      expect(ids).toContain(staffer2);
      expect(body.items.find((i) => i.userId === staffer1)!.role).toBe("manager"); // lead
      expect(body.items.find((i) => i.userId === staffer2)!.role).toBe("staff");

      // No write happened.
      const after = await withTenants([A], (c) =>
        c.query<{ n: string }>(`SELECT count(*) AS n FROM service_assignments WHERE provider_tenant_id = $1`, [A]),
      );
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });

    it("dry-run flags a cross-holding target as included:false without throwing the request", async () => {
      const unrelated = await createCompany("ORG7b Dry-run Unrelated"); // own holding root, not A's
      const dry = await app.inject({
        method: "POST",
        url: `/api/${A}/org-structure/units/d-hr/assignments?dryRun=1`,
        headers: asUser(providerAdmin),
        payload: { targets: [unrelated], module: "org7b_hr" },
      });
      expect(dry.statusCode).toBe(201);
      const body = dry.json() as { companies: Array<{ id: string; included: boolean; reason?: string }> };
      expect(body.companies).toEqual([{ id: unrelated, included: false, reason: "no_access" }]);
    });

    it("dry-run 409s when the flag is off", async () => {
      config.serviceAssignmentsEnabled = false;
      try {
        const dry = await app.inject({
          method: "POST",
          url: `/api/${A}/org-structure/units/d-hr/assignments?dryRun=1`,
          headers: asUser(providerAdmin),
          payload: { targets: [B], module: "org7b_hr" },
        });
        expect(dry.statusCode).toBe(409);
      } finally {
        config.serviceAssignmentsEnabled = true;
      }
    });
  });
});
