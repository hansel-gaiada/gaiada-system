// ORG-7 — wiring the (QA-locked, already-built) reconciler into the app. Three things this
// suite proves that ORG-3's service-assignments.test.ts and ORG-6's service-reconciler*.test.ts
// deliberately did NOT (each was scoped narrower at the time):
//   1. The manual /reconcile endpoint: authz (admin/global only, company_admin denied) + effect
//      (a target actually gets materialized grants from a single controller call).
//   2. The A14 admin-collision hook wired into the REAL role-assign endpoint (not just the bare
//      adoptManagedGrantAsManual() unit call service-reconciler.test.ts already covers): granting
//      a role that collides with a reconciler-managed grant adopts it as manual, and a later
//      revoke of the OWNING assignment does not delete the now-manual row.
//   3. GATE-1 is actually EFFECTIVE now that the reconciler + event consumer exist: driving the
//      ORG-3 controller's suspend/resume/relink through the REAL outbox → relay → reconcile-
//      consumer path (not a direct reconcileAssignment() call) strips/rematerializes grants,
//      and a re-consent relink empties them until the target re-accepts.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Redis from "ioredis";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { withGlobal, withTenants, newId } from "../db";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { registerModule, resetModules } from "../modules/registry";
import { relayBatch } from "../events/relay";
import { consumeReconcileOnce } from "../events/reconcile-consumer";
import { setRedis, closeRedis } from "../events/redis";

const REDIS_TEST_URL = process.env.REDIS_URL_TEST ?? "";
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const sampleOrg = (deptIds: string[]) => ({
  root: {
    id: "root",
    name: "Provider Co",
    kind: "company",
    children: deptIds.map((id) => ({ id, name: id, kind: "department", children: [] })),
  },
});

async function grantsFor(userId: string, target: string): Promise<{ role: string; managed: boolean }[]> {
  const { rows } = await withGlobal((c) =>
    c.query<{ role: string; managed_by: string | null }>(
      `SELECT r.name AS role, ur.managed_by FROM user_roles ur JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1 AND ur.scope_type = 'company' AND ur.scope_id = $2`,
      [userId, target],
    ),
  );
  return rows.map((r) => ({ role: r.role, managed: r.managed_by !== null }));
}

// Drains the real outbox -> Redis -> reconcile-consumer path deterministically (no polling
// interval): relay whatever's pending, then let the reconciler's own consumer group process it.
// Drains fully, not just once: this suite accumulates a lot of unrelated outbox traffic
// (companies/memberships/org PUTs across many tests sharing one process), so a single
// relayBatch/consumeReconcileOnce pass can leave a real backlog un-relayed or un-consumed.
// Loops until a full pass moves nothing, so callers can rely on "everything pending is applied"
// rather than racing an arbitrary fixed number of passes.
async function drainReconcile(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const relayed = await relayBatch(500);
    const a = await consumeReconcileOnce("service_assignment");
    const b = await consumeReconcileOnce("org_structure");
    if (relayed === 0 && a === 0 && b === 0) return;
  }
}

describe.skipIf(!TEST_URL || !REDIS_TEST_URL)("ORG-7 — reconciler wired into the app", () => {
  let app: NestFastifyApplication;
  let redis: Redis;
  let A: string; // provider
  let B: string; // target, same holding as A
  let providerAdmin: string;
  let targetAdmin: string;
  let globalExec: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.serviceAssignmentsEnabled = true;
    redis = new Redis(REDIS_TEST_URL);
    setRedis(redis);

    const moduleKeys = [
      "org7_hr", "org7_reconcile_test1", "org7_reconcile_test2", "org7_reconcile_test3", "org7_reconcile_test4",
      "org7_a14_test", "org7_gate1_test", "org7_relink_test",
    ];
    for (const key of moduleKeys) {
      registerModule({
        key, migrations: [], permissions: [], customFieldTargets: [], mcpTools: [], rollupProviders: [], uiManifest: [],
      });
      // The reconciler grants "<module>_staff"/"<module>_manager" (moduleRoleId in
      // service-reconciler.ts) — only 'hr' comes pre-seeded (migration 0026); every other test
      // module key here needs its own global role rows or reconcileAssignment reports the target
      // user as SKIPPED (unseeded module role) instead of granting.
      await createRole(`${key}_staff`);
      await createRole(`${key}_manager`);
    }

    A = await createCompany("ORG7 Provider");
    B = await createCompany("ORG7 Target", [], A);

    providerAdmin = await createUser("org7-provider-admin@a.test");
    targetAdmin = await createUser("org7-target-admin@b.test");
    globalExec = await createUser("org7-exec@holding.test");
    await addMembership(A, providerAdmin);
    await addMembership(B, targetAdmin);

    const companyAdminRole = await createRole("company_admin");
    const execRole = await createRole("platform_admin");
    await grantRole(providerAdmin, companyAdminRole, "company", A);
    await grantRole(targetAdmin, companyAdminRole, "company", B);
    await grantRole(globalExec, execRole, "global", null);
    // MON-00c: platform_admin's rules are gated on `variables.inRoot`, and a root is resolved from
    // `users.home_company_id` or an active membership. This exec has a GLOBAL grant and therefore no
    // membership, so it resolved `rootCompanies: []` and every call below 403'd. Anchored to A, the
    // ROOT of this fixture's tree (B was created as A's child), which is the root the exec oversees.
    // Anchored via home_company_id rather than a membership so the exec does not become a member of
    // the very companies whose service assignments these tests count.
    await adminPool().query(`UPDATE users SET home_company_id = $1 WHERE id = $2`, [A, globalExec]);

    app = await buildApp();

    await app.inject({
      method: "PUT",
      url: `/api/${A}/org-structure`,
      headers: asUser(providerAdmin),
      payload: sampleOrg(["d-hr", "d-hr2"]),
    });
  });
  afterAll(async () => {
    await app.close();
    await closeRedis();
    await teardownTestDb();
    resetModules();
  });
  beforeEach(async () => {
    // Fresh consumer-group cursor per test so an earlier test's un-relayed backlog can't leak in.
    for (const s of ["service_assignment", "org_structure"]) {
      try {
        await redis.xgroup("DESTROY", `events:${s}`, "reconciler");
      } catch {
        // may not exist yet
      }
    }
  });

  // ---- 1. manual /reconcile endpoint: authz + effect ----
  describe("manual /reconcile endpoint", () => {
    it("materializes grants for a target with a single admin call (no event wait)", async () => {
      const staffer = await createUser("org7-staffer1@x.test");
      await addMembership(A, staffer);
      await app.inject({
        method: "PUT",
        url: `/api/${A}/org-structure`,
        headers: asUser(providerAdmin),
        payload: {
          root: {
            id: "root", name: "P", kind: "company",
            children: [{ id: "d-hr", name: "HR", kind: "department", children: [
              { id: "p1", name: "S1", kind: "person", assigneeId: staffer },
            ] }],
          },
        },
      });
      const created = await app.inject({
        method: "POST",
        url: `/api/${A}/org-structure/units/d-hr/assignments`,
        headers: asUser(globalExec), // active immediately, no accept needed
        payload: { targets: [B], module: "org7_reconcile_test1" },
      });
      const id = (created.json() as { assignments: Array<{ id: string }> }).assignments[0].id;

      // Before manual reconcile: nothing materialized yet (propose/accept path doesn't call the
      // reconciler synchronously — only the outbox event does, asynchronously).
      expect(await grantsFor(staffer, B)).toEqual([]);

      const reconcile = await app.inject({
        method: "POST",
        url: `/api/${A}/org-structure/assignments/${id}/reconcile`,
        headers: asUser(globalExec),
      });
      expect(reconcile.statusCode).toBe(200);
      const body = reconcile.json() as { granted: number; revoked: number; orphaned: boolean };
      expect(body.granted).toBe(1);
      expect(body.orphaned).toBe(false);
      expect(await grantsFor(staffer, B)).toEqual([{ role: "org7_reconcile_test1_staff", managed: true }]);
    });

    it("company_admin is DENIED the manual reconcile action (admin/global-only, unlike propose/accept/...)", async () => {
      const created = await app.inject({
        method: "POST",
        url: `/api/${A}/org-structure/units/d-hr/assignments`,
        headers: asUser(globalExec),
        payload: { targets: [B], module: "org7_reconcile_test2" },
      });
      const id = (created.json() as { assignments: Array<{ id: string }> }).assignments[0].id;

      // Provider's own company_admin (who CAN propose/suspend/etc.) is denied reconcile.
      const asProviderAdmin = await app.inject({
        method: "POST",
        url: `/api/${A}/org-structure/assignments/${id}/reconcile`,
        headers: asUser(providerAdmin),
      });
      expect(asProviderAdmin.statusCode).toBe(403);

      const asTargetAdmin = await app.inject({
        method: "POST",
        url: `/api/${B}/org-structure/assignments/${id}/reconcile`,
        headers: asUser(targetAdmin),
      });
      expect(asTargetAdmin.statusCode).toBe(403);
    });

    it("404s a nonexistent/invisible assignment id", async () => {
      const r = await app.inject({
        method: "POST",
        url: `/api/${A}/org-structure/assignments/${newId()}/reconcile`,
        headers: asUser(globalExec),
      });
      expect(r.statusCode).toBe(404);
    });

    it("409s when the release-train flag is off", async () => {
      const created = await app.inject({
        method: "POST",
        url: `/api/${A}/org-structure/units/d-hr/assignments`,
        headers: asUser(globalExec),
        payload: { targets: [B], module: "org7_reconcile_test3" },
      });
      const id = (created.json() as { assignments: Array<{ id: string }> }).assignments[0].id;
      config.serviceAssignmentsEnabled = false;
      try {
        const r = await app.inject({
          method: "POST",
          url: `/api/${A}/org-structure/assignments/${id}/reconcile`,
          headers: asUser(globalExec),
        });
        expect(r.statusCode).toBe(409);
      } finally {
        config.serviceAssignmentsEnabled = true;
      }
    });

    it("provider-level /reconcile fans out over every live-ish assignment of the provider", async () => {
      // A dedicated target (not B) so this test's assertion can't be polluted by the OTHER live
      // assignments A already provides to B from the earlier tests above (reconcileProvider
      // legitimately re-diffs ALL of them, not just this test's).
      const C = await createCompany("ORG7 Provider Fanout Target", [], A);
      const staffer = await createUser("org7-staffer2@x.test");
      await addMembership(A, staffer);
      await app.inject({
        method: "PUT",
        url: `/api/${A}/org-structure`,
        headers: asUser(providerAdmin),
        payload: {
          root: {
            id: "root", name: "P", kind: "company",
            children: [{ id: "d-hr", name: "HR", kind: "department", children: [
              { id: "p1", name: "S2", kind: "person", assigneeId: staffer },
            ] }],
          },
        },
      });
      await app.inject({
        method: "POST",
        url: `/api/${A}/org-structure/units/d-hr/assignments`,
        headers: asUser(globalExec),
        payload: { targets: [C], module: "org7_reconcile_test4" },
      });
      const r = await app.inject({
        method: "POST",
        url: `/api/${A}/org-structure/reconcile`,
        headers: asUser(globalExec),
      });
      expect(r.statusCode).toBe(200);
      const body = r.json() as { results: unknown[] };
      expect(body.results.length).toBeGreaterThan(0);
      expect(await grantsFor(staffer, C)).toEqual([{ role: "org7_reconcile_test4_staff", managed: true }]);
    });

    // Revoke everything this describe block left live (A -> B, various modules) so the A14/
    // GATE-1 describes below get a clean provider-A/target-B live-assignment set — otherwise
    // org_structure.updated's legitimate "re-diff EVERY live assignment of this provider"
    // fan-out would let these modules' grants/membership-claims bleed into later tests that
    // share the same d-hr unit and B target.
    afterAll(async () => {
      await withTenants([A], (c) =>
        c.query(
          `UPDATE service_assignments SET status = 'revoked', revoked_at = now()
           WHERE provider_tenant_id = $1 AND target_tenant_id = $2 AND status <> 'revoked'`,
          [A, B],
        ),
      );
      await drainReconcile();
    });
  });

  // ---- 2. A14 hook wired into the REAL role-assign endpoint ----
  describe("A14 admin-collision hook (role-assign path)", () => {
    it("an admin role-grant colliding with a reconciler-managed grant adopts it as manual, immunizing it from the owning assignment's later revoke", async () => {
      const staffer = await createUser("org7-a14-staffer@x.test");
      await addMembership(A, staffer);
      await addMembership(B, staffer); // must be a B member for the admin-identity endpoint's memberIds() check
      await app.inject({
        method: "PUT",
        url: `/api/${A}/org-structure`,
        headers: asUser(providerAdmin),
        payload: {
          root: {
            id: "root", name: "P", kind: "company",
            children: [{ id: "d-hr", name: "HR", kind: "department", children: [
              { id: "p1", name: "S3", kind: "person", assigneeId: staffer },
            ] }],
          },
        },
      });
      const created = await app.inject({
        method: "POST",
        url: `/api/${A}/org-structure/units/d-hr/assignments`,
        headers: asUser(globalExec),
        payload: { targets: [B], module: "org7_a14_test" },
      });
      const assignmentId = (created.json() as { assignments: Array<{ id: string }> }).assignments[0].id;

      // Materialize via the manual endpoint (proven above) so staffer has a reconciler-managed grant.
      await app.inject({
        method: "POST",
        url: `/api/${A}/org-structure/assignments/${assignmentId}/reconcile`,
        headers: asUser(globalExec),
      });
      expect(await grantsFor(staffer, B)).toEqual([{ role: "org7_a14_test_staff", managed: true }]);

      const roleRow = await withGlobal((c) =>
        c.query<{ id: string }>(`SELECT id FROM roles WHERE company_id IS NULL AND name = 'org7_a14_test_staff'`),
      );
      const roleId = roleRow.rows[0].id;

      // Admin explicitly (re-)grants the SAME role at the SAME scope via the real endpoint —
      // this is the collision the A14 hook must catch.
      const assignRole = await app.inject({
        method: "POST",
        url: `/api/${B}/users/${staffer}/roles`,
        headers: asUser(targetAdmin),
        payload: { roleId, scopeType: "company", scopeId: B },
      });
      expect(assignRole.statusCode).toBe(201);

      // Adopted: managed_by cleared (now a manual grant, still exactly one row — no duplicate).
      expect(await grantsFor(staffer, B)).toEqual([{ role: "org7_a14_test_staff", managed: false }]);

      // Now revoke the OWNING assignment and reconcile: the now-manual row must SURVIVE.
      await app.inject({
        method: "DELETE",
        url: `/api/${A}/org-structure/assignments/${assignmentId}`,
        headers: asUser(providerAdmin),
      });
      const reconcileAfterRevoke = await app.inject({
        method: "POST",
        url: `/api/${A}/org-structure/assignments/${assignmentId}/reconcile`,
        headers: asUser(globalExec),
      });
      expect(reconcileAfterRevoke.statusCode).toBe(200);
      expect((reconcileAfterRevoke.json() as { revoked: number }).revoked).toBe(0); // nothing to revoke — no live claim
      expect(await grantsFor(staffer, B)).toEqual([{ role: "org7_a14_test_staff", managed: false }]); // survived
    });

    it("a NON-colliding role grant (different scope) is untouched by the A14 hook", async () => {
      const staffer = await createUser("org7-a14-noclash@x.test");
      await addMembership(B, staffer);
      const roleId = await createRole("some_other_role");
      const r = await app.inject({
        method: "POST",
        url: `/api/${B}/users/${staffer}/roles`,
        headers: asUser(targetAdmin),
        payload: { roleId, scopeType: "company", scopeId: B },
      });
      expect(r.statusCode).toBe(201);
      const grant = await withGlobal((c) =>
        c.query<{ managed_by: string | null }>(
          `SELECT managed_by FROM user_roles WHERE user_id = $1 AND role_id = $2`,
          [staffer, roleId],
        ),
      );
      expect(grant.rows[0].managed_by).toBeNull(); // ordinary manual grant, never touched adoption logic
    });
  });

  // ---- 3. GATE-1 semantics are EFFECTIVE via the real outbox -> consumer path ----
  describe("GATE-1 lifecycle semantics now that the reconciler + consumer are wired", () => {
    it("suspend strips materialized grants via the event path; resume RE-materializes (resume-not-recreate)", async () => {
      const staffer = await createUser("org7-gate1-staffer@x.test");
      await addMembership(A, staffer);
      await app.inject({
        method: "PUT",
        url: `/api/${A}/org-structure`,
        headers: asUser(providerAdmin),
        payload: {
          root: {
            id: "root", name: "P", kind: "company",
            children: [{ id: "d-hr", name: "HR", kind: "department", children: [
              { id: "p1", name: "G1", kind: "person", assigneeId: staffer },
            ] }],
          },
        },
      });
      const created = await app.inject({
        method: "POST",
        url: `/api/${A}/org-structure/units/d-hr/assignments`,
        headers: asUser(globalExec),
        payload: { targets: [B], module: "org7_gate1_test" },
      });
      const id = (created.json() as { assignments: Array<{ id: string }> }).assignments[0].id;

      // NOTE on the containment (not exact-equality) assertions below: the org PUT calls in this
      // file's earlier tests left OTHER live assignments from provider A to target B standing
      // (deliberately — they're proving other things). org_structure.updated legitimately
      // re-diffs EVERY live-ish assignment of a provider (reconcileProvider), so a PUT here can
      // (correctly!) also re-grant this same staffer under an EARLIER test's module if that
      // staffer happens to already be in the current blob under a shared unit. That's real,
      // correct system behavior (not this test's concern) — so we assert on THIS module's role
      // specifically, not the full grant set.
      const hasGate1Role = async () =>
        (await grantsFor(staffer, B)).some((g) => g.role === "org7_gate1_test_staff" && g.managed);

      // The CREATE event drives first materialization (no manual reconcile call this time —
      // proves the event path alone is sufficient).
      await drainReconcile();
      expect(await hasGate1Role()).toBe(true);

      const membershipBefore = await withTenants([B], (c) =>
        c.query<{ id: string }>(`SELECT id FROM company_memberships WHERE tenant_id = $1 AND user_id = $2`, [B, staffer]),
      );
      const membershipId = membershipBefore.rows[0].id;

      const suspend = await app.inject({
        method: "PATCH",
        url: `/api/${A}/org-structure/assignments/${id}/suspend`,
        headers: asUser(providerAdmin),
      });
      expect(suspend.statusCode).toBe(200);
      await drainReconcile();
      expect(await hasGate1Role()).toBe(false); // grants off while suspended

      const membershipDuringSuspend = await withTenants([B], (c) =>
        c.query<{ status: string; deleted_at: string | null }>(
          `SELECT status, deleted_at FROM company_memberships WHERE id = $1`,
          [membershipId],
        ),
      );
      expect(membershipDuringSuspend.rows[0].status).toBe("inactive");

      const resume = await app.inject({
        method: "PATCH",
        url: `/api/${B}/org-structure/assignments/${id}/resume`,
        headers: asUser(targetAdmin),
      });
      expect(resume.statusCode).toBe(200);
      await drainReconcile();
      expect(await hasGate1Role()).toBe(true);

      // RESUME-NOT-RECREATE: same membership row id resurrected, not a fresh one.
      const membershipAfterResume = await withTenants([B], (c) =>
        c.query<{ id: string; status: string }>(
          `SELECT id, status FROM company_memberships WHERE tenant_id = $1 AND user_id = $2`,
          [B, staffer],
        ),
      );
      expect(membershipAfterResume.rows[0].id).toBe(membershipId);
      expect(membershipAfterResume.rows[0].status).toBe("active");
    });

    it("a non-global relink's re-consent flip empties grants via the event path until re-accepted", async () => {
      const staffer = await createUser("org7-gate1-relink-staffer@x.test");
      await addMembership(A, staffer);
      await app.inject({
        method: "PUT",
        url: `/api/${A}/org-structure`,
        headers: asUser(providerAdmin),
        payload: {
          root: {
            id: "root", name: "P", kind: "company",
            children: [
              { id: "d-hr", name: "HR", kind: "department", children: [
                { id: "p1", name: "G2", kind: "person", assigneeId: staffer },
              ] },
              { id: "d-hr2", name: "HR2", kind: "department", children: [
                { id: "p1", name: "G2", kind: "person", assigneeId: staffer },
              ] },
            ],
          },
        },
      });
      const created = await app.inject({
        method: "POST",
        url: `/api/${A}/org-structure/units/d-hr/assignments`,
        headers: asUser(globalExec), // active immediately
        payload: { targets: [B], module: "org7_relink_test" },
      });
      const id = (created.json() as { assignments: Array<{ id: string }> }).assignments[0].id;
      // Same containment rationale as the suspend/resume test above — check this module's role
      // specifically; other still-live assignments from earlier tests may share this unit/target.
      const hasRelinkRole = async () =>
        (await grantsFor(staffer, B)).some((g) => g.role === "org7_relink_test_staff" && g.managed);
      await drainReconcile();
      expect(await hasRelinkRole()).toBe(true);

      // Non-global provider admin relinks -> forces re-consent (status flips to 'proposed').
      const relink = await app.inject({
        method: "PATCH",
        url: `/api/${A}/org-structure/assignments/${id}`,
        headers: asUser(providerAdmin),
        payload: { nodeId: "d-hr2" },
      });
      expect(relink.statusCode).toBe(200);
      expect((relink.json() as { reconsentRequired: boolean }).reconsentRequired).toBe(true);

      await drainReconcile();
      // Consent revoked pending re-accept: this module's grant must be gone (desired-empty while
      // 'proposed') even though it's the only assignment on d-hr2 (no fan-out ambiguity here).
      expect(await hasRelinkRole()).toBe(false);

      // Re-accept -> active again -> re-materializes over the NEW unit (which still has staffer).
      const accept = await app.inject({
        method: "POST",
        url: `/api/${B}/org-structure/assignments/${id}/accept`,
        headers: asUser(targetAdmin),
      });
      expect(accept.statusCode).toBe(200);
      await drainReconcile();
      expect(await hasRelinkRole()).toBe(true);
    });
  });
});
