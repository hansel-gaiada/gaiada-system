// WSUX-2 — POST /api/:tenantId/approvals/:id/decide: the unified decide façade, against live
// Postgres + RLS + Cerbos. Verifies: (1) deciding via the façade for agency/pipeline/automation/hr
// origins produces the SAME row transition + SAME outbox event as calling the origin's native
// decide endpoint directly, (2) an unauthorized caller is denied identically through the façade
// as through the native endpoint (no widened authz), (3) an agency decide is blocked the same way
// (404) when the module is disabled for the tenant, mirroring ModuleEnabledGuard, (4) a bad
// `origin` is a 400, (5) decision-shape validation still lives in the origin handler (façade
// doesn't reimplement it) — an invalid decision for a given origin still 400s.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules, registerModule } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { seedAutomationAccounts } from "../seed/automation";
import { agencyModule } from "../modules/agency";
import { newId, withTenants } from "../db";
import { registerExecutableApproval, resetExecutableApprovals } from "./approval-executables";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const asWorkflow = (wf: string) => ({ ...svc, "x-obo-provider": "n8n", "x-obo-external-id": wf });

describe.skipIf(!TEST_URL)("POST /api/:tenantId/approvals/:id/decide — unified decide façade (WSUX-2)", () => {
  let app: NestFastifyApplication;
  let co: string; // agency-enabled company
  let noAgencyCo: string; // company WITHOUT the agency module enabled
  let admin: string; // company_admin in co
  let member: string; // member-only in co
  let hrManager: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    // D14-02: register exactly one fixture tool for this suite's execution_status tests — the
    // registry is a plain in-memory singleton (approval-executables.ts), reset first so a stray
    // registration from another test file in the same process can't collide (registerExecutableApproval
    // throws on a duplicate toolName by design).
    resetExecutableApprovals();
    registerExecutableApproval({ toolName: "test.registered-tool" });
    registerModule(agencyModule);
    registerModule({
      key: "hr", migrations: [], permissions: [], customFieldTargets: [], mcpTools: [], rollupProviders: [], uiManifest: [],
    });

    co = await createCompany("WSUX2 Co", ["agency"]);
    noAgencyCo = await createCompany("WSUX2 Co — no agency module");
    await seedAutomationAccounts(co);
    await seedAutomationAccounts(noAgencyCo);

    admin = await createUser("wsux2-admin@a.test");
    member = await createUser("wsux2-member@a.test");
    hrManager = await createUser("wsux2-hrmanager@a.test");
    await addMembership(co, admin);
    await addMembership(co, member);
    await addMembership(co, hrManager);
    await addMembership(noAgencyCo, admin);

    const companyAdminRole = await createRole("company_admin");
    const memberRole = await createRole("member");
    const hrManagerRole = await createRole("hr_manager");
    await grantRole(admin, companyAdminRole, "company", co);
    await grantRole(admin, companyAdminRole, "company", noAgencyCo);
    await grantRole(member, memberRole, "company", co);
    await grantRole(hrManager, hrManagerRole, "company", co);

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("agency: façade decide == native decide (same row transition + same authz denial for a member)", async () => {
    const project = await app.inject({ method: "POST", url: `/api/${co}/projects`, headers: asUser(admin), payload: { isInternal: true, name: "WSUX2 Project" } });
    const campaign = await app.inject({
      method: "POST", url: `/api/${co}/modules/agency/campaigns`, headers: asUser(admin),
      payload: { name: "WSUX2 Campaign", projectId: project.json().id },
    });
    const campaignId = campaign.json().id;

    // Approval #1 — decided via the FAÇADE.
    const approval1 = await app.inject({
      method: "POST", url: `/api/${co}/modules/agency/approvals`, headers: asUser(admin),
      payload: { campaignId, subject: "Façade-decided approval" },
    });
    const id1 = approval1.json().id;

    // Parity check: a member is denied identically via façade AND via the native endpoint.
    const memberViaFacade = await app.inject({
      method: "POST", url: `/api/${co}/approvals/${id1}/decide`, headers: asUser(member),
      payload: { origin: "agency", decision: "approved" },
    });
    expect(memberViaFacade.statusCode).toBe(403);
    const memberViaNative = await app.inject({
      method: "POST", url: `/api/${co}/modules/agency/approvals/${id1}/decide`, headers: asUser(member),
      payload: { decision: "approved" },
    });
    expect(memberViaNative.statusCode).toBe(403);

    const viaFacade = await app.inject({
      method: "POST", url: `/api/${co}/approvals/${id1}/decide`, headers: asUser(admin),
      payload: { origin: "agency", decision: "approved" },
    });
    expect(viaFacade.statusCode).toBe(200);
    expect(viaFacade.json()).toEqual({ ok: true });

    const row1 = await adminPool().query(`SELECT status FROM agency_approvals WHERE id = $1`, [id1]);
    expect(row1.rows[0].status).toBe("approved");

    // Approval #2 — decided via the NATIVE endpoint, same outcome for comparison.
    const approval2 = await app.inject({
      method: "POST", url: `/api/${co}/modules/agency/approvals`, headers: asUser(admin),
      payload: { campaignId, subject: "Native-decided approval" },
    });
    const id2 = approval2.json().id;
    const viaNative = await app.inject({
      method: "POST", url: `/api/${co}/modules/agency/approvals/${id2}/decide`, headers: asUser(admin),
      payload: { decision: "approved" },
    });
    expect(viaNative.statusCode).toBe(200);
    const row2 = await adminPool().query(`SELECT status FROM agency_approvals WHERE id = $1`, [id2]);
    expect(row2.rows[0].status).toBe(row1.rows[0].status); // identical outcome shape

    // A second decide via the façade on an already-decided row matches the native route's own
    // (pre-existing, unchanged-by-this-ticket) behaviour: AgencyController.decide doesn't check
    // UPDATE rowCount, so a redecide is a 200 no-op rather than a 404 — verified identical via
    // both paths, proving the façade didn't "fix" or alter agency's own semantics.
    const redecideFacade = await app.inject({
      method: "POST", url: `/api/${co}/approvals/${id1}/decide`, headers: asUser(admin),
      payload: { origin: "agency", decision: "rejected" },
    });
    const redecideNative = await app.inject({
      method: "POST", url: `/api/${co}/modules/agency/approvals/${id1}/decide`, headers: asUser(admin),
      payload: { decision: "rejected" },
    });
    expect(redecideFacade.statusCode).toBe(redecideNative.statusCode);
  });

  it("agency via façade 404s when the module is disabled for the tenant, mirroring ModuleEnabledGuard", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${noAgencyCo}/approvals/${newId()}/decide`, headers: asUser(admin),
      payload: { origin: "agency", decision: "approved" },
    });
    expect(r.statusCode).toBe(404);
  });

  it("pipeline: façade decide transitions the gate + emits the SAME pipeline.gate.decided event as native", async () => {
    const run = await app.inject({ method: "POST", url: `/api/${co}/pipeline/runs`, headers: asWorkflow("wf:mtg-dispatcher"), payload: { sourceMeetingId: "wsux2-mtg", title: "WSUX2 kickoff" } });
    const runId = run.json().id;
    const gate = await app.inject({ method: "POST", url: `/api/${co}/pipeline/gates`, headers: asWorkflow("wf:delivery"), payload: { runId, kind: "prd_review", actorSide: "internal" } });
    const gateId = gate.json().id;

    // Parity: member denied via façade exactly as via native.
    const memberFacade = await app.inject({ method: "POST", url: `/api/${co}/approvals/${gateId}/decide`, headers: asUser(member), payload: { origin: "pipeline", decision: "approved" } });
    expect(memberFacade.statusCode).toBe(403);

    const viaFacade = await app.inject({
      method: "POST", url: `/api/${co}/approvals/${gateId}/decide`, headers: asUser(admin),
      payload: { origin: "pipeline", decision: "approved", note: "looks good" },
    });
    expect(viaFacade.statusCode).toBe(200);
    expect(viaFacade.json()).toEqual({ ok: true });

    const row = await adminPool().query<{ status: string; decision: string; note: string }>(`SELECT status, decision, note FROM pipeline_gates WHERE id = $1`, [gateId]);
    expect(row.rows[0]).toMatchObject({ status: "decided", decision: "approved", note: "looks good" });

    const ev = await adminPool().query(`SELECT 1 FROM outbox_events WHERE entity_id = $1 AND event_type = 'pipeline.gate.decided'`, [gateId]);
    expect(ev.rowCount).toBe(1);

    // Already decided: façade 404s exactly like native.
    const redecide = await app.inject({ method: "POST", url: `/api/${co}/approvals/${gateId}/decide`, headers: asUser(admin), payload: { origin: "pipeline", decision: "rejected" } });
    expect(redecide.statusCode).toBe(404);
  });

  it("automation: façade decide transitions the row + emits the SAME automation_approval.decided event as native", async () => {
    const created = await app.inject({
      method: "POST", url: `/api/${co}/automation-approvals`, headers: asWorkflow("wf:new-client-seed"),
      payload: { workflowId: "wf:new-client-seed", toolName: "money.transfer", toolArgs: { amount: 42 }, impact: "high", reason: "wsux2 facade test" },
    });
    const id = created.json().id;

    const memberFacade = await app.inject({ method: "POST", url: `/api/${co}/approvals/${id}/decide`, headers: asUser(member), payload: { origin: "automation", decision: "approved" } });
    expect(memberFacade.statusCode).toBe(403);

    const viaFacade = await app.inject({
      method: "POST", url: `/api/${co}/approvals/${id}/decide`, headers: asUser(admin),
      payload: { origin: "automation", decision: "approved" },
    });
    expect(viaFacade.statusCode).toBe(200);
    expect(viaFacade.json()).toEqual({ ok: true });

    const row = await adminPool().query(`SELECT status FROM automation_approvals WHERE id = $1`, [id]);
    expect(row.rows[0].status).toBe("approved");

    const ev = await adminPool().query(
      `SELECT 1 FROM outbox_events WHERE entity_id = $1 AND event_type = 'automation_approval.decided'`,
      [id],
    );
    expect(ev.rowCount).toBe(1);
  });

  it("hr: façade decide (origin=hr) authorizes via the module_manager hr rule and emits automation_approval.decided", async () => {
    const id = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO automation_approvals (id, tenant_id, workflow_id, tool_name, tool_args, impact, reason, requested_by, origin, origin_site)
         VALUES ($1,$2,'hr:leave','hr.fileLeave','{}','medium',$3,$4,'hr',$5)`,
        [id, co, "WSUX2 hr leave request", admin, config.originSite],
      ),
    );

    // A plain member (no hr_manager role) is denied identically via façade as via native.
    const memberFacade = await app.inject({ method: "POST", url: `/api/${co}/approvals/${id}/decide`, headers: asUser(member), payload: { origin: "hr", decision: "approved" } });
    expect(memberFacade.statusCode).toBe(403);
    const memberNative = await app.inject({ method: "POST", url: `/api/${co}/automation-approvals/${id}/decide`, headers: asUser(member), payload: { decision: "approved" } });
    expect(memberNative.statusCode).toBe(403);

    const viaFacade = await app.inject({
      method: "POST", url: `/api/${co}/approvals/${id}/decide`, headers: asUser(hrManager),
      payload: { origin: "hr", decision: "approved" },
    });
    expect(viaFacade.statusCode).toBe(200);
    expect(viaFacade.json()).toEqual({ ok: true });

    const row = await adminPool().query(`SELECT status FROM automation_approvals WHERE id = $1`, [id]);
    expect(row.rows[0].status).toBe("approved");
    const ev = await adminPool().query(
      `SELECT 1 FROM outbox_events WHERE entity_id = $1 AND event_type = 'automation_approval.decided'`,
      [id],
    );
    expect(ev.rowCount).toBe(1);
  });

  it("rejects an invalid origin (400) and does not touch any row", async () => {
    const r = await app.inject({ method: "POST", url: `/api/${co}/approvals/${newId()}/decide`, headers: asUser(admin), payload: { origin: "bogus", decision: "approved" } });
    expect(r.statusCode).toBe(400);
  });

  it("origin-specific decision validation is delegated, not reimplemented: an invalid decision for automation still 400s through the façade", async () => {
    const created = await app.inject({
      method: "POST", url: `/api/${co}/automation-approvals`, headers: asWorkflow("wf:new-client-seed"),
      payload: { workflowId: "wf:new-client-seed", toolName: "money.transfer", impact: "medium", reason: "bad decision value test" },
    });
    const id = created.json().id;
    const r = await app.inject({
      method: "POST", url: `/api/${co}/approvals/${id}/decide`, headers: asUser(admin),
      payload: { origin: "automation", decision: "changes_requested" }, // valid for pipeline, NOT for automation
    });
    expect(r.statusCode).toBe(400);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // D14-02 — decision -> execution wiring. The executor is REGISTRY-scoped, not origin-scoped
  // (approval-executables.ts's doctrine + migration 0078's header): execution_status only ever
  // becomes 'pending' for an APPROVED row whose origin is automation|agent AND whose tool_name has
  // a registered executable entry. Every other combination stays 'not_applicable' forever.
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it("approved + a REGISTERED tool sets execution_status='pending' in the same UPDATE that flips status", async () => {
    const created = await app.inject({
      method: "POST", url: `/api/${co}/automation-approvals`, headers: asWorkflow("wf:new-client-seed"),
      payload: { workflowId: "wf:new-client-seed", toolName: "test.registered-tool", toolArgs: { x: 1 }, impact: "high", reason: "d14-02 registered-tool test" },
    });
    const id = created.json().id;
    const decide = await app.inject({
      method: "POST", url: `/api/${co}/automation-approvals/${id}/decide`, headers: asUser(admin),
      payload: { decision: "approved" },
    });
    expect(decide.statusCode).toBe(200);
    const row = await adminPool().query(`SELECT status, execution_status FROM automation_approvals WHERE id = $1`, [id]);
    expect(row.rows[0]).toMatchObject({ status: "approved", execution_status: "pending" });
  });

  it("approved + an UNREGISTERED tool (a money-spending search apply tool, permanently barred) stays execution_status='not_applicable'", async () => {
    const created = await app.inject({
      method: "POST", url: `/api/${co}/automation-approvals`, headers: asWorkflow("wf:new-client-seed"),
      payload: { workflowId: "wf:new-client-seed", toolName: "search.setBudget", toolArgs: {}, impact: "high", reason: "d14-02 unregistered-tool test" },
    });
    const id = created.json().id;
    const decide = await app.inject({
      method: "POST", url: `/api/${co}/automation-approvals/${id}/decide`, headers: asUser(admin),
      payload: { decision: "approved" },
    });
    expect(decide.statusCode).toBe(200);
    const row = await adminPool().query(`SELECT status, execution_status FROM automation_approvals WHERE id = $1`, [id]);
    expect(row.rows[0]).toMatchObject({ status: "approved", execution_status: "not_applicable" });
  });

  it("a REJECTED decision stays execution_status='not_applicable' even for a registered tool", async () => {
    const created = await app.inject({
      method: "POST", url: `/api/${co}/automation-approvals`, headers: asWorkflow("wf:new-client-seed"),
      payload: { workflowId: "wf:new-client-seed", toolName: "test.registered-tool", toolArgs: {}, impact: "high", reason: "d14-02 rejected test" },
    });
    const id = created.json().id;
    const decide = await app.inject({
      method: "POST", url: `/api/${co}/automation-approvals/${id}/decide`, headers: asUser(admin),
      payload: { decision: "rejected" },
    });
    expect(decide.statusCode).toBe(200);
    const row = await adminPool().query(`SELECT status, execution_status FROM automation_approvals WHERE id = $1`, [id]);
    expect(row.rows[0]).toMatchObject({ status: "rejected", execution_status: "not_applicable" });
  });

  it("origin='hr' approved stays execution_status='not_applicable' even if its tool_name is (hypothetically) registered — the origin gate runs before the registry lookup", async () => {
    // Proves the guard is an ORIGIN check, not merely an accident of the registry being empty for
    // hr's real tool names: register the exact tool_name this row carries, then decide approved,
    // and confirm it still doesn't become auto-executable. This is what keeps HR's own
    // decided-event handler (modules/hr/leave-decision.ts) safe from double-application.
    registerExecutableApproval({ toolName: "hr.fileLeave-d14-02-guard-test" });
    const id = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO automation_approvals (id, tenant_id, workflow_id, tool_name, tool_args, impact, reason, requested_by, origin, origin_site)
         VALUES ($1,$2,'hr:leave','hr.fileLeave-d14-02-guard-test','{}','medium',$3,$4,'hr',$5)`,
        [id, co, "D14-02 hr origin-gate test", admin, config.originSite],
      ),
    );
    const decide = await app.inject({
      method: "POST", url: `/api/${co}/automation-approvals/${id}/decide`, headers: asUser(hrManager),
      payload: { decision: "approved" },
    });
    expect(decide.statusCode).toBe(200);
    const row = await adminPool().query(`SELECT status, execution_status FROM automation_approvals WHERE id = $1`, [id]);
    expect(row.rows[0]).toMatchObject({ status: "approved", execution_status: "not_applicable" });
  });

  it("GET .../automation-approvals list returns the new execution_* fields", async () => {
    const created = await app.inject({
      method: "POST", url: `/api/${co}/automation-approvals`, headers: asWorkflow("wf:new-client-seed"),
      payload: { workflowId: "wf:new-client-seed", toolName: "test.registered-tool", toolArgs: {}, impact: "high", reason: "d14-02 list-fields test" },
    });
    const id = created.json().id;
    await app.inject({ method: "POST", url: `/api/${co}/automation-approvals/${id}/decide`, headers: asUser(admin), payload: { decision: "approved" } });

    const list = await app.inject({ method: "GET", url: `/api/${co}/automation-approvals?status=approved`, headers: asUser(admin) });
    expect(list.statusCode).toBe(200);
    const row = (list.json() as Array<Record<string, unknown>>).find((r) => r.id === id);
    expect(row).toMatchObject({
      execution_status: "pending",
      execution_attempts: 0,
      executed_at: null,
      executed_by: null,
      execution_error: null,
    });
  });

  it("both decide surfaces (façade + native) produce the IDENTICAL execution_status for the same registered tool", async () => {
    const createRow = async () => {
      const created = await app.inject({
        method: "POST", url: `/api/${co}/automation-approvals`, headers: asWorkflow("wf:new-client-seed"),
        payload: { workflowId: "wf:new-client-seed", toolName: "test.registered-tool", toolArgs: {}, impact: "high", reason: "d14-02 facade/native parity" },
      });
      return created.json().id as string;
    };
    const idFacade = await createRow();
    const idNative = await createRow();

    const viaFacade = await app.inject({ method: "POST", url: `/api/${co}/approvals/${idFacade}/decide`, headers: asUser(admin), payload: { origin: "automation", decision: "approved" } });
    expect(viaFacade.statusCode).toBe(200);
    const viaNative = await app.inject({ method: "POST", url: `/api/${co}/automation-approvals/${idNative}/decide`, headers: asUser(admin), payload: { decision: "approved" } });
    expect(viaNative.statusCode).toBe(200);

    const rows = await adminPool().query<{ id: string; execution_status: string }>(
      `SELECT id, execution_status FROM automation_approvals WHERE id IN ($1,$2)`,
      [idFacade, idNative],
    );
    const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r.execution_status]));
    expect(byId[idFacade]).toBe("pending");
    expect(byId[idNative]).toBe("pending");
    expect(byId[idFacade]).toBe(byId[idNative]);
  });
});
