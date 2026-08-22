// MAIL-06 (F1 fix, design §7.2/§7.3, plan row MAIL-06) — decider notifications on approval
// creation. Before this ticket, creating an automation_approvals OR agency_approvals row notified
// nobody: the approvals inbox was pull-only on the request side (F1). This suite proves, against
// live Postgres + Cerbos:
//   1. automation-approvals.controller.ts create() ⇒ the resolved decider set (company_admin +
//      group_executive) gets exactly one bell notification + one mail_log row each; a non-decider
//      member gets zero.
//   2. hr.controller.ts fileLeave() (the ONLY place an origin='hr' row is created — the
//      automation-approvals endpoint itself restricts origin to automation|agent) ⇒ the SAME set
//      PLUS the providing unit's hr_manager; a manager of a DIFFERENT module is NOT included
//      (negative probe — the module_manager mirror is scoped tightly to module=='hr').
//   3. agency.controller.ts's BOTH agency_approvals creation paths (subject-review + asset-submit)
//      ⇒ the mirrored agency_approval DECIDE-equivalent set (company_admin + agency_approver);
//      self-skip holds even when the actor IS a decider.
//   4. Deduped recipients: a user holding TWO role rows that both resolve to the same decider name
//      (a global `company_admin` grant AND a company-scoped `company_admin` grant for the SAME
//      tenant — a real, reproducible-today shape of the documented duplicate-role-row defect,
//      memory "NULL defeats UNIQUE constraints") gets exactly ONE notification, not two.
//   5. Non-deciders (plain members) get zero notifications throughout (multiple negative probes).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createProject } from "../testing/fixtures";
import { seedAutomationAccounts } from "../seed/automation";
import { buildApp } from "../main";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const asWorkflow = (wf: string) => ({ ...svc, "x-obo-provider": "n8n", "x-obo-external-id": wf });

async function notifCount(userId: string, type = "approval.requested"): Promise<number> {
  const r = await adminPool().query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type = $2`, [userId, type]);
  return r.rows[0].n as number;
}

async function mailLogRows(userId: string): Promise<Array<{ template_key: string; entity_type: string | null; entity_id: string | null }>> {
  const r = await adminPool().query(
    `SELECT template_key, entity_type, entity_id FROM mail_log WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return r.rows;
}

describe.skipIf(!TEST_URL)("mail — MAIL-06 decider notifications on approval creation (F1 fix)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string; // company_admin, scoped to co — a decider on ALL three origins below
  let exec: string; // IAM-15: was group_executive. company_admin @ GLOBAL is the decider tier that
                    // remains on automation/hr per derived_roles.yaml.
  let hrMgr: string; // hr_manager, scoped to co — the WSD-2 "providing unit's hr_manager"
  let financeMgr: string; // finance_manager, scoped to co — NEGATIVE PROBE: a different module's manager
  let agencyApprover: string; // agency_approver, scoped to co — the agency_approval mirror's module_approver
  let member: string; // plain member, scoped to co — a non-decider on every origin (negative probe)
  let leaveFiler: string; // plain member who self-files leave (distinct from `member` for clarity)
  let dupUser: string; // holds TWO role rows named 'company_admin' (global + company-scoped) — dedupe probe
  let projectId: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.mail.enabled = true;
    resetModules();
    resetCoreRollupProviders();

    co = await createCompany("Mail-06 Test Co", ["hr", "agency"]);
    await seedAutomationAccounts(co); // gives wf:new-client-seed a service principal (the automation-origin actor)

    admin = await createUser("mail06-admin@a.test");
    exec = await createUser("mail06-exec@a.test");
    hrMgr = await createUser("mail06-hrmgr@a.test");
    financeMgr = await createUser("mail06-financemgr@a.test");
    agencyApprover = await createUser("mail06-agencyapprover@a.test");
    member = await createUser("mail06-member@a.test");
    leaveFiler = await createUser("mail06-leavefiler@a.test");
    dupUser = await createUser("mail06-dupuser@a.test");

    for (const u of [admin, exec, hrMgr, financeMgr, agencyApprover, member, leaveFiler, dupUser]) {
      await addMembership(co, u);
    }

    await grantRole(admin, await createRole("company_admin"), "company", co);
    await grantRole(exec, await createRole("company_admin"), "global", null);
    await grantRole(hrMgr, await createRole("hr_manager"), "company", co);
    await grantRole(financeMgr, await createRole("finance_manager"), "company", co);
    await grantRole(agencyApprover, await createRole("agency_approver"), "company", co);
    // A real agency_approver also needs baseline member-shaped access to create the campaign asset
    // and submit it for review — 'agency_approver' alone only grants the DECIDE-side 'approve'
    // action (resource_agency_approval.yaml), not asset/approval 'create'.
    await grantRole(agencyApprover, await createRole("member"), "company", co);
    await grantRole(member, await createRole("member"), "company", co);
    await grantRole(leaveFiler, await createRole("member"), "company", co); // self-file needs the 'member' create rule

    // Dedupe probe fixture (design trap 1): TWO 'roles' rows named 'company_admin' — one GLOBAL
    // (company_id NULL) and one scoped to THIS company (company_id=co) — both granted to the same
    // user. This is legitimately reproducible today (the 0073 partial unique index only prevents
    // two GLOBAL rows of the same name; a global row and a company-scoped row of the same name are
    // two genuinely different `roles` rows) and exercises the exact SQL DISTINCT-by-user_id path
    // resolveAutomationApprovalDeciders()/resolveAgencyApprovalDeciders() rely on.
    const globalAdminRoleId = await createRole("company_admin"); // company_id NULL (already exists from `admin`'s grant above)
    const companyAdminRoleId = await createRole("company_admin", co);
    await grantRole(dupUser, globalAdminRoleId, "global", null);
    await grantRole(dupUser, companyAdminRoleId, "company", co);

    projectId = await createProject(co, "Mail-06 Agency Project");

    app = await buildApp();
  });

  afterAll(async () => {
    config.mail.enabled = false;
    await app.close();
    await teardownTestDb();
  });

  describe("1. automation-approvals create (origin=automation, the hub-gate suspension path)", () => {
    it("notifies both company_admin deciders (one bell + one mail_log row each); a non-decider member gets nothing", async () => {
      const before = {
        admin: await notifCount(admin), exec: await notifCount(exec), member: await notifCount(member),
      };
      const r = await app.inject({
        method: "POST",
        url: `/api/${co}/automation-approvals`,
        headers: asWorkflow("wf:new-client-seed"),
        payload: { workflowId: "wf:mail06", toolName: "money.transfer", toolArgs: { amount: 100 }, impact: "high", reason: "mail-06 automation probe" },
      });
      expect(r.statusCode).toBe(201);
      const approvalId = r.json().id as string;

      expect(await notifCount(admin)).toBe(before.admin + 1);
      expect(await notifCount(exec)).toBe(before.exec + 1);
      expect(await notifCount(member)).toBe(before.member); // negative probe: never a decider on this origin

      const adminRows = await mailLogRows(admin);
      expect(adminRows[0]).toMatchObject({ template_key: "approval.warning", entity_type: "automation_approval", entity_id: approvalId });
      const execRows = await mailLogRows(exec);
      expect(execRows[0]).toMatchObject({ template_key: "approval.warning", entity_type: "automation_approval", entity_id: approvalId });
    });
  });

  describe("2. hr-origin leave request (hr.controller.ts fileLeave — the ONLY origin='hr' insert site)", () => {
    it("notifies the company_admin deciders + the providing unit's hr_manager; a DIFFERENT module's manager gets nothing", async () => {
      const before = {
        admin: await notifCount(admin), exec: await notifCount(exec),
        hrMgr: await notifCount(hrMgr), financeMgr: await notifCount(financeMgr), leaveFiler: await notifCount(leaveFiler),
      };
      const r = await app.inject({
        method: "POST",
        url: `/api/${co}/modules/hr/leave`,
        headers: asUser(leaveFiler),
        payload: { subjectUserId: leaveFiler, leaveType: "vacation", startsOn: "2026-09-01", endsOn: "2026-09-02", minutes: 960 },
      });
      expect(r.statusCode).toBe(201);
      const approvalId = r.json().approvalId as string;

      expect(await notifCount(admin)).toBe(before.admin + 1);
      expect(await notifCount(exec)).toBe(before.exec + 1);
      expect(await notifCount(hrMgr)).toBe(before.hrMgr + 1);
      // NEGATIVE PROBE (AC): a manager of a DIFFERENT module must never light up on an hr-origin row —
      // proves the module_manager mirror is scoped tightly to module=='hr', not "any *_manager".
      expect(await notifCount(financeMgr)).toBe(before.financeMgr);
      // Self-skip: the filer is never notified about their own request via this path.
      expect(await notifCount(leaveFiler)).toBe(before.leaveFiler);

      const hrMgrRows = await mailLogRows(hrMgr);
      expect(hrMgrRows[0]).toMatchObject({ template_key: "approval.actionable", entity_type: "automation_approval", entity_id: approvalId });
    });
  });

  describe("3. agency_approvals create — BOTH paths", () => {
    it("subject-review path (POST .../approvals): notifies agency_approver; self-skip holds even though the actor (admin) IS a decider", async () => {
      const campaign = await app.inject({
        method: "POST", url: `/api/${co}/modules/agency/campaigns`, headers: asUser(admin),
        payload: { name: "Mail-06 Campaign", projectId },
      });
      expect(campaign.statusCode).toBe(201);
      const campaignId = campaign.json().id as string;

      const before = { admin: await notifCount(admin), agencyApprover: await notifCount(agencyApprover), member: await notifCount(member) };
      const r = await app.inject({
        method: "POST", url: `/api/${co}/modules/agency/approvals`, headers: asUser(admin),
        payload: { campaignId, subject: "mail-06 subject review" },
      });
      expect(r.statusCode).toBe(201);
      const approvalId = r.json().id as string;

      expect(await notifCount(agencyApprover)).toBe(before.agencyApprover + 1);
      expect(await notifCount(admin)).toBe(before.admin); // self-skip: admin created it AND is a decider
      expect(await notifCount(member)).toBe(before.member); // negative probe

      const rows = await mailLogRows(agencyApprover);
      expect(rows[0]).toMatchObject({ template_key: "approval.actionable", entity_type: "agency_approval", entity_id: approvalId });
    });

    it("asset-submit path (POST .../assets/:id/submit): notifies company_admin; self-skip holds for the submitting agency_approver", async () => {
      const campaign = await app.inject({
        method: "POST", url: `/api/${co}/modules/agency/campaigns`, headers: asUser(admin),
        payload: { name: "Mail-06 Asset Campaign", projectId },
      });
      const campaignId = campaign.json().id as string;
      const asset = await app.inject({
        method: "POST", url: `/api/${co}/modules/agency/campaigns/${campaignId}/assets`, headers: asUser(agencyApprover),
        payload: { name: "Hero banner v2", kind: "design" },
      });
      expect(asset.statusCode).toBe(201);
      const assetId = asset.json().id as string;

      const before = { admin: await notifCount(admin), agencyApprover: await notifCount(agencyApprover), member: await notifCount(member) };
      const r = await app.inject({
        method: "POST", url: `/api/${co}/modules/agency/assets/${assetId}/submit`, headers: asUser(agencyApprover),
      });
      expect(r.statusCode).toBe(201);
      const approvalId = r.json().approvalId as string;

      expect(await notifCount(admin)).toBe(before.admin + 1);
      expect(await notifCount(agencyApprover)).toBe(before.agencyApprover); // self-skip: submitter IS a decider too
      expect(await notifCount(member)).toBe(before.member);

      const rows = await mailLogRows(admin);
      expect(rows[0]).toMatchObject({ template_key: "approval.actionable", entity_type: "agency_approval", entity_id: approvalId });
    });
  });

  describe("4. deduped recipients (trap 1: duplicate role-name rows)", () => {
    it("a user with TWO role rows both named 'company_admin' (global + company-scoped) gets exactly ONE notification, not two", async () => {
      const before = await notifCount(dupUser);
      const beforeMailRows = (await mailLogRows(dupUser)).length;

      const r = await app.inject({
        method: "POST",
        url: `/api/${co}/automation-approvals`,
        headers: asWorkflow("wf:new-client-seed"),
        payload: { workflowId: "wf:mail06-dedupe", toolName: "money.transfer", toolArgs: {}, impact: "medium", reason: "dedupe probe" },
      });
      expect(r.statusCode).toBe(201);

      expect(await notifCount(dupUser)).toBe(before + 1); // NOT before + 2
      expect((await mailLogRows(dupUser)).length).toBe(beforeMailRows + 1);
    });
  });

  describe("5. bell substrate exists independent of mail (MAIL_ENABLED=0 still notifies in-app)", () => {
    it("with MAIL_ENABLED off, the decider still gets a bell notification (only mail_log stays untouched)", async () => {
      config.mail.enabled = false;
      try {
        const beforeNotif = await notifCount(admin);
        const beforeMail = (await mailLogRows(admin)).length;
        const r = await app.inject({
          method: "POST",
          url: `/api/${co}/automation-approvals`,
          headers: asWorkflow("wf:new-client-seed"),
          payload: { workflowId: "wf:mail06-off", toolName: "money.transfer", toolArgs: {}, impact: "medium", reason: "mail-off probe" },
        });
        expect(r.statusCode).toBe(201);
        expect(await notifCount(admin)).toBe(beforeNotif + 1); // the bell (F1's original ask) is unconditional
        expect((await mailLogRows(admin)).length).toBe(beforeMail); // mail itself stays off
      } finally {
        config.mail.enabled = true;
      }
    });
  });
});
