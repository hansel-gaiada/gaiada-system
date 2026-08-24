// IAM-VERIFY-01 — drive the REAL HTTP surface (buildApp() + app.inject(), real Postgres/RLS, real
// Cerbos) as each persona and OBSERVE the result. Everything else in this program is unit/
// integration-level against internal functions (can(), can.scopeOnly(), computeEffectivePermissions())
// or a single controller in isolation; nothing before this ticket has signed in as a persona over the
// front door and watched the platform allow and deny things end to end.
//
// This file is an OBSERVER. It asserts what was seen; it does not fix policies, controllers, or
// principal.ts. Every finding — expected boundary or real defect — is written up in
// docs/superpowers/plans/2026-08-11-iam-verify-01-report.md, not silently patched here.
//
// Cerbos staleness discipline (ticket brief, ⚠ section): the test-cerbos container was inspected
// and restarted before this file was authored (2026-08-11, see the report's header) because its
// prior StartedAt predated policy edits on disk. Every ALLOW/DENY below was produced by that fresh
// container. If a result here looks wrong on a re-run, re-check container freshness before trusting
// either direction — concurrent agents are editing derived_roles.yaml, three resource policies and
// role-permission-bundles.json while this file runs.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL } from "./setup";
import { newId, withTenants } from "../db";
import { seedPersonaTenant, isDeniedStatus, type PersonaKey } from "./personas";
import { createProject } from "./fixtures";

describe.skipIf(!TEST_URL)("IAM-VERIFY-01 · real HTTP drive as personas", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // 1. PM (pm_task) — role arm + permission arm, driven through the real endpoint.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  describe("PM — pm_task, both arms, through /pm/tasks", () => {
    // ── OWNER DECISION 2026-08-24 (PERMISSION-CONTRACT §16) ──────────────────────────────────
    // `member` moved from the DENY list to the ALLOW list here. It used to be denied because
    // `create` shared a Cerbos rule with `delete`/`manage`, which left 14 of 19 seeded staff
    // unable to file work against their own department's board. `viewer` stays denied — the
    // widening named `member`, not everyone — and that is what makes this case still a boundary
    // rather than a formality.
    it("ALLOW — company_admin, manager, member CAN create a task; DENY — viewer CANNOT", async () => {
      const p = await seedPersonaTenant(["company_admin", "manager", "member", "viewer"]);
      const projectId = await createProject(p.tenantId, "IAM-VERIFY PM project");
      for (const persona of ["company_admin", "manager", "member"] as const) {
        const res = await app.inject({
          method: "POST", url: `/api/${p.tenantId}/pm/tasks`, headers: p.as(persona),
          payload: { projectId, title: `task by ${persona}` },
        });
        expect(res.statusCode, `persona "${persona}" create pm_task`).toBe(201);
      }
      for (const persona of ["viewer"] as const) {
        const res = await app.inject({
          method: "POST", url: `/api/${p.tenantId}/pm/tasks`, headers: p.as(persona),
          payload: { projectId, title: `task by ${persona}` },
        });
        expect(isDeniedStatus(res.statusCode), `persona "${persona}" create pm_task should be denied, got ${res.statusCode}`).toBe(true);
      }
    });

    // The other half of §16, driven through the same real endpoint: opening `create` must not have
    // opened "assign work to a colleague". A member naming someone else as responsible is refused;
    // `manage` is what that needs, and `member` does not hold it.
    it("DENY — a member CANNOT create a task owned by someone else (that is `manage`)", async () => {
      const p = await seedPersonaTenant(["manager", "member"]);
      const projectId = await createProject(p.tenantId, "IAM-VERIFY PM ownership project");
      const otherUserId = p.users.manager!;
      const res = await app.inject({
        method: "POST", url: `/api/${p.tenantId}/pm/tasks`, headers: p.as("member"),
        payload: {
          projectId,
          title: "member assigns the lead",
          assignee: { kind: "person", refId: otherUserId, refName: "Lead", responsibleId: otherUserId, responsibleName: "Lead" },
        },
      });
      expect(isDeniedStatus(res.statusCode), `member create-with-other-assignee should be denied, got ${res.statusCode}`).toBe(true);
    });

    // HIER-3 (2026-08-11): the "DENY — team_lead cannot create OR even READ a pm_task" case that
    // used to sit here is REMOVED, not replaced — `team_lead` is retired entirely (role, derived
    // role, and every writer that could mint the grant); `resource_pm_task.yaml` no longer lists
    // it at all, so there is no dead-tier finding left to observe.

    it("ALLOW — member, viewer CAN read tasks (read/update tier is broader than create/delete/manage)", async () => {
      const p = await seedPersonaTenant(["member", "viewer"]);
      const projectId = await createProject(p.tenantId, "IAM-VERIFY PM read project");
      for (const persona of ["member", "viewer"] as const) {
        const res = await app.inject({ method: "GET", url: `/api/${p.tenantId}/pm/tasks`, headers: p.as(persona) });
        expect(res.statusCode, `persona "${persona}" read pm_task list`).toBe(200);
      }
    });

    it("DENY — a member cannot DELETE a task (manage-tier action, member holds only read/update)", async () => {
      const p = await seedPersonaTenant(["manager", "member"]);
      const projectId = await createProject(p.tenantId, "IAM-VERIFY PM delete project");
      const created = await app.inject({
        method: "POST", url: `/api/${p.tenantId}/pm/tasks`, headers: p.as("manager"),
        payload: { projectId, title: "to be deleted" },
      });
      const taskId = (created.json() as { id: string }).id;
      const del = await app.inject({ method: "DELETE", url: `/api/${p.tenantId}/pm/tasks/${taskId}`, headers: p.as("member") });
      expect(isDeniedStatus(del.statusCode), `member delete pm_task, got ${del.statusCode}`).toBe(true);
    });

    it("DENY — client_contact cannot reach the PM task surface at all", async () => {
      const p = await seedPersonaTenant(["client_contact"]);
      const res = await app.inject({ method: "GET", url: `/api/${p.tenantId}/pm/tasks`, headers: p.as("client_contact") });
      expect(isDeniedStatus(res.statusCode), `client_contact read pm_task list, got ${res.statusCode}`).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // 2. HR (hr_case) — self-service condition + role/permission arm agreement, through /modules/hr.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  describe("HR — hr_case, self-service + staff tiers, through /modules/hr/cases", () => {
    it("ALLOW — hr_staff, hr_manager, company_admin CAN create a case for someone else", async () => {
      const p = await seedPersonaTenant(["hr_staff", "hr_manager", "company_admin", "member"]);
      for (const persona of ["hr_staff", "hr_manager", "company_admin"] as const) {
        const res = await app.inject({
          method: "POST", url: `/api/${p.tenantId}/modules/hr/cases`, headers: p.as(persona),
          payload: { subjectUserId: p.users.member, kind: "review", title: `case by ${persona}` },
        });
        expect(res.statusCode, `persona "${persona}" create hr_case for another subject`).toBe(201);
      }
    });

    it("ALLOW — member CAN create a case about THEMSELVES (self-service); DENY for someone else", async () => {
      const p = await seedPersonaTenant(["member", "viewer"]);
      const self = await app.inject({
        method: "POST", url: `/api/${p.tenantId}/modules/hr/cases`, headers: p.as("member"),
        payload: { subjectUserId: p.users.member, kind: "other", title: "my own case" },
      });
      expect(self.statusCode, "member self-service create hr_case").toBe(201);

      const forOther = await app.inject({
        method: "POST", url: `/api/${p.tenantId}/modules/hr/cases`, headers: p.as("member"),
        payload: { subjectUserId: p.users.viewer, kind: "other", title: "case about someone else" },
      });
      expect(isDeniedStatus(forOther.statusCode), `member create hr_case for a DIFFERENT subject, got ${forOther.statusCode}`).toBe(true);
    });

    it("DENY — a plain member cannot DELETE a case (module_manager/company_admin-tier action)", async () => {
      const p = await seedPersonaTenant(["hr_manager", "member"]);
      const created = await app.inject({
        method: "POST", url: `/api/${p.tenantId}/modules/hr/cases`, headers: p.as("hr_manager"),
        payload: { subjectUserId: p.users.member, kind: "grievance", title: "to be deleted" },
      });
      const caseId = (created.json() as { id: string }).id;
      const del = await app.inject({ method: "DELETE", url: `/api/${p.tenantId}/modules/hr/cases/${caseId}`, headers: p.as("member") });
      expect(isDeniedStatus(del.statusCode), `member delete hr_case, got ${del.statusCode}`).toBe(true);
    });

    it("DENY — hr_staff cannot EXPORT records (high-assurance + manager/admin-tier action; hr_staff never reaches it)", async () => {
      const p = await seedPersonaTenant(["hr_staff", "hr_manager"]);
      // hr.record.export requires module_manager/company_admin AND assurance=='high'. The dev x-user-id
      // auth path always assembles principals at "high" (src/auth/guards.ts:70), so this isolates the
      // ROLE boundary specifically (hr_staff is not module_manager), not the assurance boundary — see
      // §6 below for the assurance boundary, which this fixture CANNOT reach.
      const staffExport = await app.inject({ method: "GET", url: `/api/${p.tenantId}/modules/hr/records/export`, headers: p.as("hr_staff") });
      expect(isDeniedStatus(staffExport.statusCode), `hr_staff export hr_record, got ${staffExport.statusCode}`).toBe(true);
      const managerExport = await app.inject({ method: "GET", url: `/api/${p.tenantId}/modules/hr/records/export`, headers: p.as("hr_manager") });
      expect(managerExport.statusCode, `hr_manager export hr_record, got ${managerExport.statusCode}`).toBe(200);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // 3. Reports — appraisal cycle_admin. TR-25's finding ② (hr_people_ops == hr_manager ONLY, not
  //    hr_staff) driven live: appraisal data is deliberately narrower than the HR module baseline.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  describe("Reports — appraisal cycle_admin, through /appraisals/cycles", () => {
    it("ALLOW — hr_manager CAN create an appraisal cycle; DENY — hr_staff and company_admin CANNOT (read-only or no reach)", async () => {
      const p = await seedPersonaTenant(["hr_manager", "hr_staff", "company_admin"]);
      const payload = { name: "IAM-VERIFY cycle", periodStart: "2026-01-01", periodEnd: "2026-03-31" };

      const managerRes = await app.inject({ method: "POST", url: `/api/${p.tenantId}/appraisals/cycles`, headers: p.as("hr_manager"), payload });
      expect(managerRes.statusCode, "hr_manager create appraisal cycle").toBe(200);

      const staffRes = await app.inject({ method: "POST", url: `/api/${p.tenantId}/appraisals/cycles`, headers: p.as("hr_staff"), payload });
      expect(isDeniedStatus(staffRes.statusCode), `hr_staff create appraisal cycle (TR-25 finding: must NOT inherit cycle_admin), got ${staffRes.statusCode}`).toBe(true);

      // DR-5 owner decision: company_admin gets READ on appraisal, explicitly NOT cycle_admin.
      const adminRes = await app.inject({ method: "POST", url: `/api/${p.tenantId}/appraisals/cycles`, headers: p.as("company_admin"), payload });
      expect(isDeniedStatus(adminRes.statusCode), `company_admin create appraisal cycle (DR-5 grants read only), got ${adminRes.statusCode}`).toBe(true);

      const adminRead = await app.inject({ method: "GET", url: `/api/${p.tenantId}/appraisals/cycles`, headers: p.as("company_admin") });
      // NOTE: appraisals.controller.ts's listCyclesRoute() also gates on "cycle_admin" (not "read"),
      // per the source above — so company_admin's DR-5 read grant does not cover LISTING cycles either.
      // Observed, reported as-is (see report §"listing cycles is cycle_admin-gated, not read-gated").
      expect(isDeniedStatus(adminRead.statusCode), `company_admin list appraisal cycles, got ${adminRead.statusCode}`).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // 4. IT — resource_device.yaml, role-arm ONLY (no permission arm on this kind) — a deliberate
  //    contrast to pm_task/hr_case's dual-arm kinds.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  describe("IT — device registry, role-arm only, adversarial personas", () => {
    it("DENY — hr_staff, search_staff, agency_approver (none hold it_staff/company_admin) cannot register a device", async () => {
      const p = await seedPersonaTenant(["hr_staff", "search_staff", "agency_approver"]);
      for (const persona of ["hr_staff", "search_staff", "agency_approver"] as const) {
        const res = await app.inject({
          method: "POST", url: `/api/${p.tenantId}/it/devices`, headers: p.as(persona),
          payload: { name: `${persona} device`, kind: "network" },
        });
        expect(isDeniedStatus(res.statusCode), `persona "${persona}" create device, got ${res.statusCode}`).toBe(true);
      }
    });

    it("DENY — client_contact cannot even READ the device registry (staff-only surface, not merely different)", async () => {
      const p = await seedPersonaTenant(["client_contact"]);
      const res = await app.inject({ method: "GET", url: `/api/${p.tenantId}/it/devices`, headers: p.as("client_contact") });
      expect(isDeniedStatus(res.statusCode), `client_contact read it devices, got ${res.statusCode}`).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // 5. Portal — client vs staff. TWO REAL DEFECTS surfaced here by driving the front door (both
  //    written up in the report, neither "fixed" here — this file only observes):
  //
  //    DEFECT A (fixture, src/testing/personas.ts): seedPersonaTenant()'s `client_contact` case
  //    inserts a `client_contacts` row but NEVER grants the Cerbos "client" ROLE — unlike every
  //    other client-seeding path in this codebase (src/seed/personas.ts, portal.test.ts,
  //    portal-dashboard.test.ts, portal-client-contacts.test.ts all call
  //    `grantRole(userId, await createRole("client"), "company", tenantId)`). Without that grant,
  //    `resource_portal.yaml`'s `client` derived role condition
  //    (`attr.grants.exists(g, g.role == "client" && ...)`) never activates, so the ONE persona
  //    whose entire documented purpose is portal access (README-PERSONAS.md) is unconditionally
  //    denied on every portal route. Confirmed below by granting the missing role by hand and
  //    watching the SAME seeded user flip from 403 to 200 — isolates the fixture as the cause,
  //    not a policy or portal-scope defect.
  //
  //    DEFECT B (app layer, src/core/portal-scope.ts `callerClientIds()`): resource_portal.yaml
  //    explicitly grants `read` to `company_admin`/`manager`/`group_executive` "for support"
  //    (its own comment: '"what does the client actually see?"'). But `callerClientIds()`
  //    unconditionally throws "not a portal client" for anyone with zero `client_contacts` rows —
  //    which is every staff member, by construction (clients are deliberately kept out of
  //    `company_memberships`, per principal.ts's own header). So a company_admin/manager clears
  //    Cerbos and is STILL always refused, every time, with no code path that ever lets the
  //    Cerbos-granted "support read" succeed. The existing test that looks like it covers this
  //    (`portal-client-contacts.test.ts`'s "a staff member is still not a portal client") only
  //    drives a `member` persona, who has NO Cerbos grant on `portal` to begin with — so it never
  //    actually exercises the company_admin/manager case Cerbos's own comment describes. This is
  //    an over-claim in the POLICY relative to what the CODE can deliver — the mirror image of the
  //    team_lead dead-bundle-entry finding (§1/§6), but on the role arm, inside the app layer.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  describe("Portal — client vs staff, through /portal/runs", () => {
    // ⚠ DEFECT A — FIXED 2026-08-11, and this test was INVERTED to match.
    //
    // As written by IAM-VERIFY-01 (an observer ticket, scoped to report and not repair) this
    // asserted the DEFECT: `403 / "not a portal client"`, because `testing/personas.ts` created the
    // `client_contacts` row but never granted the Cerbos `client` role that `resource_portal.yaml`
    // actually matches on. The fixture has since been fixed at the source, so the assertion now
    // pins the CORRECT behaviour instead of the broken one.
    //
    // Kept rather than deleted: this is the only test that drives the portal as a real client
    // persona end to end, and its absence is precisely why the defect survived every green suite.
    it("client_contact reaches the portal — the fixture grants the Cerbos \"client\" role (was DEFECT A)", async () => {
      const p = await seedPersonaTenant(["client_contact"]);
      const res = await app.inject({ method: "GET", url: `/api/${p.tenantId}/portal/runs`, headers: p.as("client_contact") });
      expect(res.statusCode, "client_contact read /portal/runs").toBe(200);
    });

    it("DEFECT A, isolated — the SAME seeded client_contact user succeeds once the missing \"client\" role grant is added by hand", async () => {
      const p = await seedPersonaTenant(["client_contact"]);
      const { createRole, grantRole } = await import("./fixtures");
      const clientRoleId = await createRole("client");
      await grantRole(p.users.client_contact!, clientRoleId, "company", p.tenantId);
      const res = await app.inject({ method: "GET", url: `/api/${p.tenantId}/portal/runs`, headers: p.as("client_contact") });
      expect(res.statusCode, "client_contact WITH the client role grant read /portal/runs").toBe(200);
    });

    // ⚠ DEFECT B — RESOLVED 2026-08-11 (owner decision DR-12), and this test was UPDATED to match.
    //
    // As written by this observer ticket it asserted the DIVERGENCE: Cerbos ALLOWED staff
    // (`company_admin`/`manager`/`group_executive`) portal `read` under a "for support" rule, while
    // `portal-scope.ts`'s `callerClientIds()` refused every one of them with `"not a portal client"`
    // — because that function throws for any principal with no `client_contacts` row, which is every
    // staff member by construction. The Cerbos rule was dead code that no code path could satisfy.
    //
    // The owner ruled: DELETE the dead rule — staff have no portal access. It matched what the
    // system had always actually done, and client-portal data is another company's commercial
    // information, so support access (if ever wanted) gets built deliberately with its own
    // capability and audit trail rather than inherited by every manager from an inert rule.
    // `resource_portal.yaml`'s staff rule is gone; migration `0104` removed the orphaned bundle rows.
    //
    // So staff are STILL refused — but now at the Cerbos layer (`cerbos denied read on portal`)
    // rather than by an app-layer throw behind a grant that pretended to allow it. The assertion
    // below deliberately checks the DENIAL, not the message text: `portal-client-contacts.test.ts`
    // owns the precise-reason assertions, and pinning an error string here would just make this
    // brittle to the next refactor.
    it("staff (company_admin, manager) are denied the portal — the dead support rule was removed (was DEFECT B)", async () => {
      const p = await seedPersonaTenant(["company_admin", "manager"]);
      for (const persona of ["company_admin", "manager"] as const) {
        const res = await app.inject({ method: "GET", url: `/api/${p.tenantId}/portal/runs`, headers: p.as(persona) });
        expect(isDeniedStatus(res.statusCode), `persona "${persona}" read /portal/runs, got ${res.statusCode}`).toBe(true);
      }
    });

    it("member and viewer are denied consistently at BOTH layers (no Cerbos grant on portal at all for these roles, so no divergence to observe here)", async () => {
      const p = await seedPersonaTenant(["member", "viewer", "hr_staff"]);
      for (const persona of ["member", "viewer", "hr_staff"] as const) {
        const res = await app.inject({ method: "GET", url: `/api/${p.tenantId}/portal/runs`, headers: p.as(persona) });
        expect(isDeniedStatus(res.statusCode), `persona "${persona}" read /portal/runs, got ${res.statusCode}`).toBe(true);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // 6. authz/permissions — the bulk endpoint vs the real per-endpoint behaviour it caveats about.
  //    Drives EVERY assertion above's persona a second way and diffs the two answers.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  describe("GET /:tenantId/authz/permissions — scopeLevelPermissions vs observed endpoint behaviour", () => {
    // HIER-3 (2026-08-11): the "EXPECTED DIVERGENCE — team_lead's scopeLevelPermissions claims
    // pm.task.create/read but the real endpoint denies both" case that used to sit here is
    // REMOVED, not replaced — `team_lead` is retired entirely, so there is no longer a
    // `role_permissions` bundle to claim anything in `scopeLevelPermissions` for that role.

    it("AGREEMENT — hr_manager's scopeLevelPermissions includes hr.case.create and the real endpoint agrees (ALLOW)", async () => {
      const p = await seedPersonaTenant(["hr_manager"]);
      const perms = await app.inject({ method: "GET", url: `/api/${p.tenantId}/authz/permissions`, headers: p.as("hr_manager") });
      const body = perms.json() as { scopeLevelPermissions: string[] };
      expect(body.scopeLevelPermissions).toContain("hr.case.create");

      const real = await app.inject({
        method: "POST", url: `/api/${p.tenantId}/modules/hr/cases`, headers: p.as("hr_manager"),
        payload: { subjectUserId: p.users.hr_manager, kind: "other", title: "agreement probe" },
      });
      expect(real.statusCode).toBe(201);
    });

    it("EXPECTED DIVERGENCE — a member's scopeLevelPermissions includes hr.case.read (their self-only grant, flattened) but the real endpoint denies reading a DIFFERENT subject's case", async () => {
      const p = await seedPersonaTenant(["member", "hr_manager"]);
      const perms = await app.inject({ method: "GET", url: `/api/${p.tenantId}/authz/permissions`, headers: p.as("member") });
      const body = perms.json() as { scopeLevelPermissions: string[] };
      expect(body.scopeLevelPermissions, "member's flattened bundle claims hr.case.read").toContain("hr.case.read");

      const otherCase = await app.inject({
        method: "POST", url: `/api/${p.tenantId}/modules/hr/cases`, headers: p.as("hr_manager"),
        payload: { subjectUserId: p.users.hr_manager, kind: "other", title: "not the member's case" },
      });
      const caseId = (otherCase.json() as { id: string }).id;
      const readOther = await app.inject({ method: "GET", url: `/api/${p.tenantId}/modules/hr/cases/${caseId}`, headers: p.as("member") });
      expect(isDeniedStatus(readOther.statusCode), `member read a DIFFERENT subject's hr_case, got ${readOther.statusCode} — scopeLevelPermissions said hr.case.read but the real, condition-aware endpoint denies`).toBe(true);
    });

    it("caveat + excludedRelationshipClass + wildcardBypassRoles are present in every real response, not just the unit-tested computation", async () => {
      const p = await seedPersonaTenant(["superadmin", "member"]);
      const admin = await app.inject({ method: "GET", url: `/api/${p.tenantId}/authz/permissions`, headers: p.as("superadmin") });
      const adminBody = admin.json() as { wildcardBypassRoles: string[]; excludedRelationshipClass: string[]; caveat: string };
      expect(adminBody.wildcardBypassRoles).toContain("platform_admin");
      expect(adminBody.excludedRelationshipClass.length).toBeGreaterThan(0);
      expect(adminBody.caveat).toMatch(/scopeLevelPermissions answers/);

      const member = await app.inject({ method: "GET", url: `/api/${p.tenantId}/authz/permissions`, headers: p.as("member") });
      const memberBody = member.json() as { wildcardBypassRoles: string[] };
      expect(memberBody.wildcardBypassRoles).toEqual([]);
    });

    it("403 (never 404) — a non-member of the tenant cannot read that tenant's effective permissions", async () => {
      const p1 = await seedPersonaTenant(["member"], "iam-verify tenant A");
      const p2 = await seedPersonaTenant(["member"], "iam-verify tenant B");
      const res = await app.inject({ method: "GET", url: `/api/${p1.tenantId}/authz/permissions`, headers: p2.as("member") });
      expect(res.statusCode, "cross-tenant read of authz/permissions").toBe(403);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // 7. Adversarial — try to break it. Cross-tenant, client-on-staff-surface, low-assurance path.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  describe("Adversarial — cross-tenant, client-on-staff-surface, assurance", () => {
    it("DENY — a company_admin of tenant A cannot read tenant B's PM tasks (cross-tenant, same role tier)", async () => {
      const pA = await seedPersonaTenant(["company_admin"], "iam-verify tenant A");
      const pB = await seedPersonaTenant(["company_admin"], "iam-verify tenant B");
      const res = await app.inject({ method: "GET", url: `/api/${pB.tenantId}/pm/tasks`, headers: pA.as("company_admin") });
      expect(isDeniedStatus(res.statusCode), `company_admin(A) reads tenant B's pm_task list, got ${res.statusCode}`).toBe(true);
    });

    it("DENY — a company_admin of tenant A cannot read tenant B's HR cases either (different module, same cross-tenant probe)", async () => {
      const pA = await seedPersonaTenant(["company_admin"], "iam-verify tenant A hr");
      const pB = await seedPersonaTenant(["company_admin"], "iam-verify tenant B hr");
      const res = await app.inject({ method: "GET", url: `/api/${pB.tenantId}/modules/hr/cases`, headers: pA.as("company_admin") });
      expect(isDeniedStatus(res.statusCode), `company_admin(A) reads tenant B's hr_case list, got ${res.statusCode}`).toBe(true);
    });

    it("DENY — client_contact reaching a staff-only endpoint (HR records) gets denied, not a 500 and not data", async () => {
      const p = await seedPersonaTenant(["client_contact"]);
      const res = await app.inject({ method: "GET", url: `/api/${p.tenantId}/modules/hr/records`, headers: p.as("client_contact") });
      expect(isDeniedStatus(res.statusCode), `client_contact read hr_record, got ${res.statusCode}`).toBe(true);
    });

    it("DENY — a member cannot escalate by hitting a manager-only appraisal-cycle route even after being handed the case-create self-service path", async () => {
      const p = await seedPersonaTenant(["member"]);
      const res = await app.inject({
        method: "POST", url: `/api/${p.tenantId}/appraisals/cycles`, headers: p.as("member"),
        payload: { name: "member escalation attempt", periodStart: "2026-01-01", periodEnd: "2026-03-31" },
      });
      expect(isDeniedStatus(res.statusCode), `member create appraisal cycle, got ${res.statusCode}`).toBe(true);
    });

    // UNTESTABLE, documented rather than inferred (report §"could not drive"): the dev x-user-id
    // auth path (src/auth/guards.ts, AuthGuard.canActivate) hardcodes `assemblePrincipal(userId,
    // "high")` for EVERY persona driven via p.as(...) — there is no fixture path to a NAMED,
    // IDENTIFIED persona at assurance "low". "low" only exists on `ANONYMOUS` (no userId at all) or
    // via an UNVERIFIED OBO envelope, which also collapses to ANONYMOUS. This test drives the one
    // reachable low-assurance shape (fully anonymous, no x-user-id, no bearer at all) against an
    // assurance-gated action (hr.record.export, which requires "high") to at least prove the
    // anonymous path is denied — NOT proof that a low-assurance NAMED principal is denied, which
    // this fixture cannot produce.
    it("DENY — fully anonymous (no credentials at all) cannot export HR records; NOT a substitute for a low-assurance NAMED persona (see report)", async () => {
      const p = await seedPersonaTenant(["hr_manager"]);
      const res = await app.inject({ method: "GET", url: `/api/${p.tenantId}/modules/hr/records/export` });
      expect(res.statusCode, "anonymous export hr_record").toBe(401);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // 8. A newly-wired (26-kind rollout) kind, driven end to end — agency_brief. Confirms the
  //    "zero authorization decisions changed" claim through the front door for a kind OTHER than
  //    pm_task/hr_case, which is what the ticket brief specifically asks for.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  describe("Agency (agency_brief, newly-wired permission arm) — through /modules/agency", () => {
    async function seedCampaign(tenantId: string): Promise<string> {
      const id = newId();
      const projectId = await createProject(tenantId, "IAM-VERIFY agency project");
      await withTenants([tenantId], (c) =>
        c.query(
          `INSERT INTO agency_campaigns (id, tenant_id, project_id, name, status, origin_site) VALUES ($1,$2,$3,'IAM-VERIFY campaign','active',$4)`,
          [id, tenantId, projectId, config.originSite],
        ),
      );
      return id;
    }

    it("ALLOW — company_admin, manager, member CAN create a brief; DENY — viewer (read-only tier) CANNOT", async () => {
      const p = await seedPersonaTenant(["company_admin", "manager", "member", "viewer"]);
      const campaignId = await seedCampaign(p.tenantId);
      for (const persona of ["company_admin", "manager", "member"] as const) {
        const res = await app.inject({
          method: "POST", url: `/api/${p.tenantId}/modules/agency/campaigns/${campaignId}/briefs`, headers: p.as(persona),
          payload: { title: `brief by ${persona}`, body: "x" },
        });
        expect(res.statusCode, `persona "${persona}" create agency_brief`).toBe(201);
      }
      const viewerRes = await app.inject({
        method: "POST", url: `/api/${p.tenantId}/modules/agency/campaigns/${campaignId}/briefs`, headers: p.as("viewer"),
        payload: { title: "brief by viewer", body: "x" },
      });
      expect(isDeniedStatus(viewerRes.statusCode), `viewer create agency_brief, got ${viewerRes.statusCode}`).toBe(true);
    });

    it("ALLOW — viewer CAN read briefs (read tier is broader than create)", async () => {
      const p = await seedPersonaTenant(["manager", "viewer"]);
      const campaignId = await seedCampaign(p.tenantId);
      await app.inject({
        method: "POST", url: `/api/${p.tenantId}/modules/agency/campaigns/${campaignId}/briefs`, headers: p.as("manager"),
        payload: { title: "seed brief", body: "x" },
      });
      const res = await app.inject({ method: "GET", url: `/api/${p.tenantId}/modules/agency/campaigns/${campaignId}/briefs`, headers: p.as("viewer") });
      expect(res.statusCode, "viewer read agency_brief list").toBe(200);
    });

    it("DENY — client_contact and hr_staff cannot touch agency briefs (no agency-role grant either way)", async () => {
      const p = await seedPersonaTenant(["client_contact", "hr_staff"]);
      const campaignId = await seedCampaign(p.tenantId);
      for (const persona of ["client_contact", "hr_staff"] as const) {
        const res = await app.inject({ method: "GET", url: `/api/${p.tenantId}/modules/agency/campaigns/${campaignId}/briefs`, headers: p.as(persona) });
        expect(isDeniedStatus(res.statusCode), `persona "${persona}" read agency_brief, got ${res.statusCode}`).toBe(true);
      }
    });
  });
});
