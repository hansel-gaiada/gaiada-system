// Tasks 4.8 + 4.10: the agency module end-to-end — enable gating, campaign + approval
// flow with the module-elevated role, and module rollups feeding the management view.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { resetModules, registerModule } from "../registry";
import { buildApp } from "../../main";
import { agencyModule } from "./index";
import {
  recomputeRollups, syncMetricDefinitions, registerCoreRollupProvider, resetCoreRollupProviders, coreTaskRollups,
} from "../../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import {
  createCompany, createUser, addMembership, createRole, grantRole, createProject,
} from "../../testing/fixtures";

describe.skipIf(!TEST_URL)("agency module (phase e2e)", () => {
  let app: NestFastifyApplication;
  let agencyCo: string;
  let otherCo: string;
  let manager: string;
  let member: string;
  let approver: string;
  let exec: string;
  const svc = { authorization: "Bearer svc-token" };
  const asUser = (id: string) => ({ ...svc, "x-user-id": id });
  let campaignId: string;
  let approvalId: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    registerModule(agencyModule);
    registerCoreRollupProvider(coreTaskRollups);
    await syncMetricDefinitions();

    // ⚠ BOTH COMPANIES MUST SHARE A ROOT (MON-00). They were two independent roots, which was
    // invisible while the exec fixture was a `group_executive` anchored to one of them. IAM-15 made
    // it a `platform_admin`, whose rollup reach is operator-wide — so `/api/rollups` assembled a
    // tenant set spanning two roots and `withTenants` refused it with CrossRootTenantSetError.
    //
    // A shared holding is the correct fixture, not a workaround: this suite's subject is the
    // "cross-COMPANY management view", and under MON-00 cross-company means within one root. Two
    // unrelated roots would be a cross-CUSTOMER view, which is the thing the boundary forbids.
    const holdingCo = await createCompany("Creative Holding");
    agencyCo = await createCompany("Creative House", ["agency"], holdingCo);
    otherCo = await createCompany("Print Shop", [], holdingCo);
    manager = await createUser("mgr@creative.test");
    member = await createUser("mem@creative.test");
    approver = await createUser("approver@creative.test");
    exec = await createUser("exec2@gaiada.test");
    for (const u of [manager, member, approver]) await addMembership(agencyCo, u);

    const managerRole = await createRole("manager");
    const memberRole = await createRole("member");
    const approverRole = await createRole("agency_approver");
    const execRole = await createRole("platform_admin");
    await grantRole(manager, managerRole, "company", agencyCo);
    await grantRole(member, memberRole, "company", agencyCo);
    await grantRole(approver, memberRole, "company", agencyCo);
    await grantRole(approver, approverRole, "company", agencyCo);
    await grantRole(exec, execRole, "global", null);
    // MON-00c: `group_executive`'s cross-company rules are now gated on `variables.inRoot`, and
    // `assemblePrincipal` resolves a root from `users.home_company_id` OR active memberships. This
    // exec deliberately has NO membership (that is the point of a global grant), so before this it
    // resolved `rootCompanies: []` and every cross-company rollup read below was denied.
    //
    // Anchored via `home_company_id` rather than by adding a membership, on purpose: a membership
    // would put the exec INSIDE the agency company and change the very headcount/utilization
    // numbers these rollup assertions check, turning an authorization fix into a silent data-fixture
    // change. `home_company_id` is also the anchor MON-00c's own fixtures use (see principal.ts's
    // note that every existing root-anchored fixture sets it directly).
    await adminPool().query(`UPDATE users SET home_company_id = $1 WHERE id = $2`, [agencyCo, exec]);

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("module routes 404 for a tenant without the module", async () => {
    const r = await app.inject({
      method: "GET", url: `/api/${otherCo}/modules/agency/campaigns`, headers: asUser(manager),
    });
    expect(r.statusCode).toBe(404);
  });

  it("manager creates a campaign on a core project", async () => {
    const projectId = await createProject(agencyCo, "Rebrand");
    const r = await app.inject({
      method: "POST", url: `/api/${agencyCo}/modules/agency/campaigns`,
      headers: asUser(manager), payload: { name: "Q3 Rebrand", projectId },
    });
    expect(r.statusCode).toBe(201);
    campaignId = r.json().id;
  });

  it("member requests an approval; member cannot decide it (module-elevated action)", async () => {
    const create = await app.inject({
      method: "POST", url: `/api/${agencyCo}/modules/agency/approvals`,
      headers: asUser(member), payload: { campaignId, subject: "Hero visual v2" },
    });
    expect(create.statusCode).toBe(201);
    approvalId = create.json().id;

    const denied = await app.inject({
      method: "POST", url: `/api/${agencyCo}/modules/agency/approvals/${approvalId}/decide`,
      headers: asUser(member), payload: { decision: "approved" },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("agency_approver decides; the pending queue drains", async () => {
    const ok = await app.inject({
      method: "POST", url: `/api/${agencyCo}/modules/agency/approvals/${approvalId}/decide`,
      headers: asUser(approver), payload: { decision: "approved" },
    });
    expect(ok.statusCode).toBe(200);
    const pending = await app.inject({
      method: "GET", url: `/api/${agencyCo}/modules/agency/approvals/pending`, headers: asUser(member),
    });
    expect(pending.json()).toEqual([]);
  });

  it("decided-approval history lists the decision with campaignId + decider", async () => {
    const decided = await app.inject({
      method: "GET", url: `/api/${agencyCo}/modules/agency/approvals/decided`, headers: asUser(member),
    });
    expect(decided.statusCode).toBe(200);
    const rows = decided.json() as Array<{ id: string; campaignId: string; decision: string; decided_by: string | null }>;
    const row = rows.find((r) => r.id === approvalId)!;
    expect(row.decision).toBe("approved");
    expect(row.campaignId).toBe(campaignId);
    expect(row.decided_by).toBeTruthy();
  });

  it("module rollups feed the cross-company management view", async () => {
    const period = "2026-07-05";
    await recomputeRollups(agencyCo, period);
    const view = await app.inject({ method: "GET", url: `/api/rollups?period=${period}`, headers: asUser(exec) });
    const rows = view.json() as Array<{ metric_key: string; numerator: string }>;
    const active = rows.find((r) => r.metric_key === "agency.campaigns.active");
    expect(Number(active?.numerator)).toBe(1);
    const pendingMetric = rows.find((r) => r.metric_key === "agency.approvals.pending");
    expect(Number(pendingMetric?.numerator)).toBe(0); // drained above
  });

  it("MCP tool defs are contributed via the contract (consumed by the hub in 4.9)", () => {
    expect(agencyModule.mcpTools.map((t) => t.name)).toEqual(["agency.listCampaigns", "agency.pendingApprovals"]);
  });

  // 5c.1: briefs + creative-asset review lifecycle (first-deploy agency flow).
  it("brief → asset → submit-for-review → approve moves the asset's review state", async () => {
    const brief = await app.inject({
      method: "POST", url: `/api/${agencyCo}/modules/agency/campaigns/${campaignId}/briefs`,
      headers: asUser(member), payload: { title: "Launch brief", body: "Q3 rebrand hero" },
    });
    expect(brief.statusCode).toBe(201);

    const asset = await app.inject({
      method: "POST", url: `/api/${agencyCo}/modules/agency/campaigns/${campaignId}/assets`,
      headers: asUser(member), payload: { name: "Hero banner", kind: "design" },
    });
    expect(asset.statusCode).toBe(201);
    const assetId = asset.json().id;

    // Member submits for review → asset goes in_review + a linked approval is raised.
    const submit = await app.inject({
      method: "POST", url: `/api/${agencyCo}/modules/agency/assets/${assetId}/submit`, headers: asUser(member),
    });
    expect(submit.statusCode).toBe(201);
    const inReview = await app.inject({
      method: "GET", url: `/api/${agencyCo}/modules/agency/campaigns/${campaignId}/assets`, headers: asUser(member),
    });
    expect((inReview.json() as Array<{ id: string; review_status: string }>).find((a) => a.id === assetId)?.review_status).toBe("in_review");

    // Approver decides → the linked asset flips to approved.
    const approve = await app.inject({
      method: "POST", url: `/api/${agencyCo}/modules/agency/approvals/${submit.json().approvalId}/decide`,
      headers: asUser(approver), payload: { decision: "approved" },
    });
    expect(approve.statusCode).toBe(200);
    const after = await app.inject({
      method: "GET", url: `/api/${agencyCo}/modules/agency/campaigns/${campaignId}/assets`, headers: asUser(member),
    });
    expect((after.json() as Array<{ id: string; review_status: string }>).find((a) => a.id === assetId)?.review_status).toBe("approved");
  });

  it("assets-in-review rollup reflects the queue", async () => {
    const period = "2026-07-06";
    // raise one more asset into review
    const a = await app.inject({
      method: "POST", url: `/api/${agencyCo}/modules/agency/campaigns/${campaignId}/assets`,
      headers: asUser(member), payload: { name: "Second banner" },
    });
    await app.inject({ method: "POST", url: `/api/${agencyCo}/modules/agency/assets/${a.json().id}/submit`, headers: asUser(member) });
    await recomputeRollups(agencyCo, period);
    const view = await app.inject({ method: "GET", url: `/api/rollups?period=${period}`, headers: asUser(exec) });
    const rows = view.json() as Array<{ metric_key: string; numerator: string }>;
    expect(Number(rows.find((r) => r.metric_key === "agency.assets.in_review")?.numerator)).toBe(1);
  });

  // 5c.5: management-view rollups — utilization (D12 num/den) + deliverables due this week.
  it("management rollups compute utilization and deliverables-due", async () => {
    const period = "2026-07-09";
    const projectId = await createProject(agencyCo, "Client Work");
    const del = await app.inject({
      method: "POST", url: `/api/${agencyCo}/deliverables`,
      headers: asUser(manager), payload: { projectId, name: "Brand guidelines", dueDate: "2026-07-11" },
    });
    expect(del.statusCode).toBe(201);
    const time = await app.inject({
      method: "POST", url: `/api/${agencyCo}/time-entries`,
      headers: asUser(member), payload: { projectId, minutes: 120, billable: true, entryDate: period },
    });
    expect(time.statusCode).toBe(201);

    await recomputeRollups(agencyCo, period);
    const view = await app.inject({ method: "GET", url: `/api/rollups?period=${period}`, headers: asUser(exec) });
    const rows = view.json() as Array<{ metric_key: string; numerator: string; denominator: string | null }>;
    const util = rows.find((r) => r.metric_key === "agency.utilization");
    expect(Number(util?.numerator)).toBe(120);
    // 3 active members (manager, member, approver) × 8h × 60 = 1440 capacity minutes.
    expect(Number(util?.denominator)).toBe(1440);
    expect(Number(rows.find((r) => r.metric_key === "agency.deliverables.due_week")?.numerator)).toBeGreaterThanOrEqual(1);
  });

  // APPR-01 — the single-row read backing `platform-ui`'s `/approvals/[id]`, plus the href-parity
  // pin (the whole point of this ticket: the emailed link must land ON the item, not the list).
  describe("APPR-01: single-approval detail read + emitted href parity", () => {
    it("a member (broad agency_approval `read` grant) reads one row by id; the response carries campaign context", async () => {
      const create = await app.inject({
        method: "POST", url: `/api/${agencyCo}/modules/agency/approvals`,
        headers: asUser(member), payload: { campaignId, subject: "Detail-read probe" },
      });
      expect(create.statusCode).toBe(201);
      const id = create.json().id as string;

      const ok = await app.inject({ method: "GET", url: `/api/${agencyCo}/modules/agency/approvals/${id}`, headers: asUser(member) });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ id, subject: "Detail-read probe", campaignId, status: "pending" });
    });

    it("a caller with no membership in the tenant at all is denied — same refusal `pending`/`decided` give", async () => {
      const create = await app.inject({
        method: "POST", url: `/api/${agencyCo}/modules/agency/approvals`,
        headers: asUser(member), payload: { campaignId, subject: "Denial probe" },
      });
      const id = create.json().id as string;
      const stranger = await createUser("stranger@no-membership.test"); // no addMembership(agencyCo, ...) at all

      const deniedDetail = await app.inject({ method: "GET", url: `/api/${agencyCo}/modules/agency/approvals/${id}`, headers: asUser(stranger) });
      const deniedList = await app.inject({ method: "GET", url: `/api/${agencyCo}/modules/agency/approvals/pending`, headers: asUser(stranger) });
      expect(deniedDetail.statusCode).toBe(deniedList.statusCode); // no weaker than the list
      expect(deniedDetail.statusCode).toBe(403);
    });

    it("an unknown id 404s, and a REAL id read through a different agency-enabled tenant's path 404s too (RLS — never a leak)", async () => {
      const create = await app.inject({
        method: "POST", url: `/api/${agencyCo}/modules/agency/approvals`,
        headers: asUser(member), payload: { campaignId, subject: "Cross-tenant probe" },
      });
      const id = create.json().id as string;

      const unknown = await app.inject({ method: "GET", url: `/api/${agencyCo}/modules/agency/approvals/00000000-0000-0000-0000-000000000000`, headers: asUser(member) });
      expect(unknown.statusCode).toBe(404);

      const otherAgencyCo = await createCompany("Second Creative House", ["agency"]);
      const otherMember = await createUser("mem2@creative.test");
      await addMembership(otherAgencyCo, otherMember);
      await grantRole(otherMember, await createRole("member"), "company", otherAgencyCo);
      const crossTenant = await app.inject({ method: "GET", url: `/api/${otherAgencyCo}/modules/agency/approvals/${id}`, headers: asUser(otherMember) });
      expect(crossTenant.statusCode).toBe(404); // RLS makes the row invisible under the wrong tenant, even though this caller CAN read agency_approvals in general
    });

    it("the emitted notification's payload.href is the id-bearing detail route, not the bare list", async () => {
      const create = await app.inject({
        method: "POST", url: `/api/${agencyCo}/modules/agency/approvals`,
        headers: asUser(member), payload: { campaignId, subject: "Href parity probe" },
      });
      const id = create.json().id as string;
      const row = await adminPool().query<{ payload: { href: string } }>(
        `SELECT payload FROM notifications WHERE type = 'approval.requested' AND (payload->>'entityId') = $1`, [id],
      );
      expect(row.rows[0].payload.href).toBe(`/approvals/${id}`);
    });

    it("the SECOND agency_approvals insert site (asset submit-for-review) also emits the id-bearing href", async () => {
      const asset = await app.inject({
        method: "POST", url: `/api/${agencyCo}/modules/agency/campaigns/${campaignId}/assets`,
        headers: asUser(member), payload: { name: "Href-parity asset" },
      });
      const submit = await app.inject({
        method: "POST", url: `/api/${agencyCo}/modules/agency/assets/${asset.json().id}/submit`, headers: asUser(member),
      });
      const approvalId2 = submit.json().approvalId as string;
      const row = await adminPool().query<{ payload: { href: string } }>(
        `SELECT payload FROM notifications WHERE type = 'approval.requested' AND (payload->>'entityId') = $1`, [approvalId2],
      );
      expect(row.rows[0].payload.href).toBe(`/approvals/${approvalId2}`);
    });
  });
});
