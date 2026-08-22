// Billing/invoices (§4) — generate from billable time, status transitions, RBAC.
// Against live Postgres + RLS + Cerbos.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { withTenants } from "../db";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createProject } from "../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("billing / invoices (§4)", () => {
  let app: NestFastifyApplication;
  let tenant: string;
  let admin: string;
  let admin2: string;
  let manager: string;
  let member: string;
  let platformAdmin: string; // global scope — IAM-GAP-02 self-approval hole probes
  let groupExec: string; // global scope — ditto
  let clientId: string;
  let projectId: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    tenant = await createCompany("Agency A", ["agency", "billing", "clients"]);
    admin = await createUser("admin@a.test");
    admin2 = await createUser("admin2@a.test");
    manager = await createUser("mgr@a.test");
    member = await createUser("mem@a.test");
    platformAdmin = await createUser("superadmin@a.test");
    groupExec = await createUser("exec@a.test");
    await addMembership(tenant, admin);
    await addMembership(tenant, admin2);
    await addMembership(tenant, manager);
    await addMembership(tenant, member);
    await grantRole(admin, await createRole("company_admin"), "company", tenant);
    await grantRole(admin2, await createRole("company_admin"), "company", tenant);
    await grantRole(manager, await createRole("manager"), "company", tenant);
    await grantRole(member, await createRole("member"), "company", tenant);
    // IAM-GAP-02: global scope, no company membership needed — platform_admin/group_executive's
    // wildcard rule has no `inTenant` condition, and `withTenants([tenantId], ...)` scopes every
    // DB query by the explicit `tenantId` parameter regardless of the caller's own memberships
    // (same pattern as src/admin/org14-preflight-adversarial.test.ts's `exec` fixture).
    await grantRole(platformAdmin, await createRole("platform_admin"), "global", null);
    // ⚠ IAM-15: this fixture WAS a global `group_executive`, which reached invoices with no
    // membership because the exec rule carried no `inTenant`. Substituting company_admin at global
    // scope does NOT reproduce that — company_admin IS inTenant-gated, so invoice creation 403'd and
    // the test failed in its setup rather than its assertion.
    //
    // So this is now a company-scoped company_admin WITH a membership. The maker/checker property
    // under test is unchanged and is the point: whoever creates an invoice cannot approve it, no
    // matter how senior. Only the seniority of the principal demonstrating it has come down a tier,
    // because the tier above it no longer exists.
    await grantRole(groupExec, await createRole("company_admin"), "company", tenant);
    await addMembership(tenant, groupExec);
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

  it("lists invoices, requires approval before sent, and transitions draft→approved→sent (IAM-GAP-01 maker/checker)", async () => {
    const list = (await app.inject({ method: "GET", url: `/api/${tenant}/invoices`, headers: asUser(admin) })).json() as Array<{ id: string; status: string; createdBy: string }>;
    expect(list.length).toBeGreaterThan(0);
    const id = list[0].id;
    expect(list[0].createdBy).toBe(admin);

    // IAM-GAP-01: 'sent' is now gated on 'approved' — the creator alone can no longer skip straight
    // from draft to sent (the maker/checker seam would otherwise be purely cosmetic).
    const skipAttempt = await app.inject({ method: "PATCH", url: `/api/${tenant}/invoices/${id}`, headers: asUser(admin), payload: { status: "sent" } });
    expect(skipAttempt.statusCode).toBe(400);

    // The creator cannot approve their own invoice.
    const selfApprove = await app.inject({ method: "POST", url: `/api/${tenant}/invoices/${id}/approve`, headers: asUser(admin) });
    expect(selfApprove.statusCode).toBe(403);

    // A DIFFERENT company_admin can.
    const approve = await app.inject({ method: "POST", url: `/api/${tenant}/invoices/${id}/approve`, headers: asUser(admin2) });
    expect(approve.statusCode).toBe(200);
    expect(approve.json()).toMatchObject({ status: "approved" });

    // Re-approving an already-approved invoice is rejected (not a re-entrant action).
    const reapprove = await app.inject({ method: "POST", url: `/api/${tenant}/invoices/${id}/approve`, headers: asUser(admin2) });
    expect(reapprove.statusCode).toBe(400);

    // Directly PATCHing status='approved' is not a valid input at all — the ONLY door in is /approve.
    const bypass = await app.inject({ method: "PATCH", url: `/api/${tenant}/invoices/${id}`, headers: asUser(admin), payload: { status: "approved" } });
    expect(bypass.statusCode).toBe(400);

    // Now that it is approved, the creator (or anyone else holding "update") can send it.
    const patch = await app.inject({ method: "PATCH", url: `/api/${tenant}/invoices/${id}`, headers: asUser(admin), payload: { status: "sent" } });
    expect(patch.statusCode).toBe(200);
    const after = (await app.inject({ method: "GET", url: `/api/${tenant}/invoices/${id}`, headers: asUser(admin) })).json() as { status: string; approvedBy: string };
    expect(after.status).toBe("sent");
    expect(after.approvedBy).toBe(admin2);
  });

  it("bad status rejected (400); a plain member cannot issue an invoice (403)", async () => {
    const list = (await app.inject({ method: "GET", url: `/api/${tenant}/invoices`, headers: asUser(admin) })).json() as Array<{ id: string }>;
    expect((await app.inject({ method: "PATCH", url: `/api/${tenant}/invoices/${list[0].id}`, headers: asUser(admin), payload: { status: "nope" } })).statusCode).toBe(400);
    const denied = await app.inject({ method: "POST", url: `/api/${tenant}/invoices`, headers: asUser(member), payload: { clientId, periodStart: "2026-07-01", periodEnd: "2026-07-31", rate: 50 } });
    expect(denied.statusCode).toBe(403);
  });

  // ══════════════════ IAM-GAP-01 — the maker/checker seam, adversarial end-to-end ══════════════════
  describe("invoice approve — maker/checker (IAM-GAP-01)", () => {
    let freshId: string;

    beforeAll(async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/invoices`, headers: asUser(admin),
        payload: { clientId, periodStart: "2026-07-01", periodEnd: "2026-07-31", rate: 10, currency: "USD" },
      });
      freshId = r.json().id as string;
    });

    it("creator (company_admin) cannot approve their own invoice — 403", async () => {
      const r = await app.inject({ method: "POST", url: `/api/${tenant}/invoices/${freshId}/approve`, headers: asUser(admin) });
      expect(r.statusCode).toBe(403);
    });

    it("a DIFFERENT company_admin CAN approve — 200", async () => {
      const r = await app.inject({ method: "POST", url: `/api/${tenant}/invoices/${freshId}/approve`, headers: asUser(admin2) });
      expect(r.statusCode).toBe(200);
    });

    it("a manager (department-manager tier, owner default) can approve a DIFFERENT fresh invoice, but cannot create one", async () => {
      const created = await app.inject({
        method: "POST", url: `/api/${tenant}/invoices`, headers: asUser(admin),
        payload: { clientId, periodStart: "2026-07-01", periodEnd: "2026-07-31", rate: 10 },
      });
      const id2 = created.json().id as string;
      const mgrApprove = await app.inject({ method: "POST", url: `/api/${tenant}/invoices/${id2}/approve`, headers: asUser(manager) });
      expect(mgrApprove.statusCode).toBe(200);

      const mgrCreate = await app.inject({
        method: "POST", url: `/api/${tenant}/invoices`, headers: asUser(manager),
        payload: { clientId, periodStart: "2026-07-01", periodEnd: "2026-07-31", rate: 10 },
      });
      expect(mgrCreate.statusCode).toBe(403);
    });

    it("a plain member can never approve — 403", async () => {
      const created = await app.inject({
        method: "POST", url: `/api/${tenant}/invoices`, headers: asUser(admin),
        payload: { clientId, periodStart: "2026-07-01", periodEnd: "2026-07-31", rate: 10 },
      });
      const id3 = created.json().id as string;
      const r = await app.inject({ method: "POST", url: `/api/${tenant}/invoices/${id3}/approve`, headers: asUser(member) });
      expect(r.statusCode).toBe(403);
    });

    it("a legacy invoice with NULL created_by (simulating a pre-migration row) is DENIED to every non-superadmin — fail closed on unknown creator", async () => {
      const legacyId = await withTenants([tenant], async (c) => {
        const id = (await c.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0].id;
        await c.query(
          `INSERT INTO invoices (id, tenant_id, client_id, status, currency, lines, total, origin_site, created_by)
           VALUES ($1,$2,$3,'draft','USD','[]',0,'test',NULL)`,
          [id, tenant, clientId],
        );
        return id;
      });
      const r = await app.inject({ method: "POST", url: `/api/${tenant}/invoices/${legacyId}/approve`, headers: asUser(admin2) });
      expect(r.statusCode).toBe(403);
    });

    it("cannot mark an unapproved invoice paid either (the gate covers both sent and paid)", async () => {
      const created = await app.inject({
        method: "POST", url: `/api/${tenant}/invoices`, headers: asUser(admin),
        payload: { clientId, periodStart: "2026-07-01", periodEnd: "2026-07-31", rate: 10 },
      });
      const id4 = created.json().id as string;
      const r = await app.inject({ method: "PATCH", url: `/api/${tenant}/invoices/${id4}`, headers: asUser(admin), payload: { status: "paid" } });
      expect(r.statusCode).toBe(400);
    });

    it("void is always reachable without approval (cancelling a mistake must not require a checker)", async () => {
      const created = await app.inject({
        method: "POST", url: `/api/${tenant}/invoices`, headers: asUser(admin),
        payload: { clientId, periodStart: "2026-07-01", periodEnd: "2026-07-31", rate: 10 },
      });
      const id5 = created.json().id as string;
      const r = await app.inject({ method: "PATCH", url: `/api/${tenant}/invoices/${id5}`, headers: asUser(admin), payload: { status: "void" } });
      expect(r.statusCode).toBe(200);
    });
  });

  // ══════════════════════ IAM-GAP-02 — the self-approval hole, closed for BOTH elevated tiers ══════════════════════
  // IAM-GAP-01's own report (§4.5/§12.2) flagged this loudly: platform_admin/group_executive's
  // PRE-EXISTING wildcard rule sat above the maker/checker ALLOW rule with no condition at all, so
  // either could approve an invoice it created itself — the exact hole the owner's two-person rule
  // ("1 superadmin + 1 owner") forbids. Closed with a structural EFFECT_DENY in
  // resource_invoice.yaml (`roles: ["user"]` — matches every principal, Cerbos deny-overrides an
  // ALLOW including a wildcard). Adversarially proven end-to-end here, not just via a live Cerbos
  // probe — the hole was reachable through this exact HTTP endpoint.
  describe("invoice approve — the self-approval hole, elevated roles (IAM-GAP-02)", () => {
    it("platform_admin CANNOT approve an invoice IT created — 403 (the hole being closed)", async () => {
      const created = await app.inject({
        method: "POST", url: `/api/${tenant}/invoices`, headers: asUser(platformAdmin),
        payload: { clientId, periodStart: "2026-07-01", periodEnd: "2026-07-31", rate: 10 },
      });
      expect(created.statusCode).toBe(201);
      const id = created.json().id as string;
      const selfApprove = await app.inject({ method: "POST", url: `/api/${tenant}/invoices/${id}/approve`, headers: asUser(platformAdmin) });
      expect(selfApprove.statusCode).toBe(403);
      // Non-regression: the SAME platform_admin can still approve someone ELSE's invoice — the
      // DENY must not have over-fired into a blanket platform_admin lockout.
      const other = await app.inject({
        method: "POST", url: `/api/${tenant}/invoices`, headers: asUser(admin),
        payload: { clientId, periodStart: "2026-07-01", periodEnd: "2026-07-31", rate: 10 },
      });
      const otherApprove = await app.inject({ method: "POST", url: `/api/${tenant}/invoices/${other.json().id}/approve`, headers: asUser(platformAdmin) });
      expect(otherApprove.statusCode).toBe(200);
    });

    it("a second company_admin CANNOT approve an invoice IT created — 403 (the hole being closed)", async () => {
      const created = await app.inject({
        method: "POST", url: `/api/${tenant}/invoices`, headers: asUser(groupExec),
        payload: { clientId, periodStart: "2026-07-01", periodEnd: "2026-07-31", rate: 10 },
      });
      expect(created.statusCode).toBe(201);
      const id = created.json().id as string;
      const selfApprove = await app.inject({ method: "POST", url: `/api/${tenant}/invoices/${id}/approve`, headers: asUser(groupExec) });
      expect(selfApprove.statusCode).toBe(403);
      const otherApprove = await app.inject({ method: "POST", url: `/api/${tenant}/invoices/${id}/approve`, headers: asUser(platformAdmin) });
      expect(otherApprove.statusCode).toBe(200);
    });
  });

  // ══════════════════════════════ IAM-GAP-02 — revision tracking, real endpoints ══════════════════════════════
  // "draft need to track the maker and the last person who make changes and the changes itself. so
  // we can have proper version control and able to identify and have forensic capabilities." Drives
  // create -> edit -> approve through the real HTTP surface and asserts a revision row per mutation
  // with the right actor, and that the PRE-EDIT state is reconstructible from `before_snapshot`
  // alone (not by replaying every prior revision).
  describe("invoice revision tracking (IAM-GAP-02)", () => {
    type Revision = {
      action: string; actorId: string | null;
      before: { status: string; total: string; updatedBy: string | null } | null;
      after: { status: string; total: string; updatedBy: string | null };
      changedFields: string[];
    };
    const getRevisions = (invoiceId: string) =>
      withTenants([tenant], (c) =>
        c.query<Revision>(
          `SELECT action, actor_id AS "actorId", before_snapshot AS before, after_snapshot AS after,
                  changed_fields AS "changedFields"
             FROM invoice_revisions WHERE invoice_id = $1 ORDER BY occurred_at ASC`,
          [invoiceId],
        ),
      ).then((r) => r.rows);

    it("create -> edit (void) -> approve-then-send each write exactly one revision row, actor-attributed, pre-edit state reconstructible", async () => {
      const created = await app.inject({
        method: "POST", url: `/api/${tenant}/invoices`, headers: asUser(admin),
        payload: { clientId, periodStart: "2026-07-01", periodEnd: "2026-07-31", rate: 10 },
      });
      const id = created.json().id as string;

      let revs = await getRevisions(id);
      expect(revs).toHaveLength(1);
      expect(revs[0]).toMatchObject({ action: "created", actorId: admin, before: null });
      expect(revs[0].after.status).toBe("draft");
      expect(revs[0].after.updatedBy).toBe(admin); // IAM-GAP-02: updated_by = creator right after create

      // A GET reflects `updatedBy` too — additive field on the existing response shape.
      const afterCreate = (await app.inject({ method: "GET", url: `/api/${tenant}/invoices/${id}`, headers: asUser(admin) })).json() as { updatedBy: string };
      expect(afterCreate.updatedBy).toBe(admin);

      // EDIT #1: a DIFFERENT actor voids it. `manager` holds only `read` on invoices
      // (resource_invoice.yaml: "Managers may view invoices but not issue/edit them" — `approve`
      // is the ONE manager exception, added by IAM-GAP-01/02), so a DIFFERENT company_admin
      // (admin2) is the one who legitimately holds `update` here.
      const voided = await app.inject({ method: "PATCH", url: `/api/${tenant}/invoices/${id}`, headers: asUser(admin2), payload: { status: "void" } });
      expect(voided.statusCode).toBe(200);

      revs = await getRevisions(id);
      expect(revs).toHaveLength(2);
      expect(revs[1]).toMatchObject({ action: "status_changed", actorId: admin2 });
      // The PRE-EDIT state is reconstructible from this ONE revision row's own before_snapshot —
      // no need to touch revs[0] at all.
      expect(revs[1].before?.status).toBe("draft");
      expect(revs[1].after.status).toBe("void");
      expect(revs[1].changedFields).toEqual(expect.arrayContaining(["status", "updatedAt", "updatedBy"]));

      const afterVoid = (await app.inject({ method: "GET", url: `/api/${tenant}/invoices/${id}`, headers: asUser(admin) })).json() as { updatedBy: string; status: string };
      expect(afterVoid.updatedBy).toBe(admin2); // "the last person who made changes"
      expect(afterVoid.status).toBe("void");
    });

    it("approve() records a revision with before.status='draft', after.status='approved', actor=the approver (not the creator)", async () => {
      const created = await app.inject({
        method: "POST", url: `/api/${tenant}/invoices`, headers: asUser(admin),
        payload: { clientId, periodStart: "2026-07-01", periodEnd: "2026-07-31", rate: 10 },
      });
      const id = created.json().id as string;
      const approve = await app.inject({ method: "POST", url: `/api/${tenant}/invoices/${id}/approve`, headers: asUser(admin2) });
      expect(approve.statusCode).toBe(200);

      const revs = await getRevisions(id);
      expect(revs).toHaveLength(2); // created, approved
      const approvedRev = revs[1];
      expect(approvedRev.action).toBe("approved");
      expect(approvedRev.actorId).toBe(admin2); // the CHECKER, not admin (the maker)
      expect(approvedRev.before?.status).toBe("draft");
      expect(approvedRev.after.status).toBe("approved");
      expect(approvedRev.after.updatedBy).toBe(admin2);
    });

    it("a self-approval attempt that Cerbos denies (403) records NO revision — a rejected mutation must not appear in the forensic trail", async () => {
      const created = await app.inject({
        method: "POST", url: `/api/${tenant}/invoices`, headers: asUser(admin),
        payload: { clientId, periodStart: "2026-07-01", periodEnd: "2026-07-31", rate: 10 },
      });
      const id = created.json().id as string;
      const revsBefore = await getRevisions(id);
      const denied = await app.inject({ method: "POST", url: `/api/${tenant}/invoices/${id}/approve`, headers: asUser(admin) });
      expect(denied.statusCode).toBe(403);
      const revsAfter = await getRevisions(id);
      expect(revsAfter).toHaveLength(revsBefore.length); // unchanged — the 403 short-circuits before any DB write
    });
  });
});
