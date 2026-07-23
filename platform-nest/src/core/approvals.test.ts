// WSUX-1 — GET /api/approvals: unified cross-origin + cross-company approvals read, against
// live Postgres + RLS + Cerbos. Verifies: (1) union of >=2 origins normalized into one urgency-
// sorted list, (2) cross-company fan-out tags an inaccessible company {included:false,
// reason:"no_access"} and leaks NO rows from it, (3) a caller only sees approvals they are
// natively authorized to see (no widened visibility vs. the origin's own endpoint), (4) status
// pending|decided and sort urgency|age both work, (5) decidable reflects the per-origin decide
// capability, not just read.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules, registerModule } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { seedAutomationAccounts } from "../seed/automation";
import { agencyModule } from "../modules/agency";
import { newId, withTenants } from "../db";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const asWorkflow = (wf: string) => ({ ...svc, "x-obo-provider": "n8n", "x-obo-external-id": wf });

interface UnifiedRow {
  id: string; origin: string; tenantId: string; company: string; subject: string;
  subjectHref?: string; createdAt: string; ageMs: number; urgencyScore: number;
  decidable: boolean; status: string;
}
interface EnvelopeBody {
  items: UnifiedRow[];
  companies: Array<{ id: string; name?: string; included: boolean; reason?: string }>;
}

describe.skipIf(!TEST_URL)("GET /api/approvals — unified cross-origin + cross-company (WSUX-1)", () => {
  let app: NestFastifyApplication;
  let coA: string; // 3-company manager's companies
  let coB: string;
  let coC: string; // a company the manager is NOT a member of
  let manager: string; // company_admin in A and B, no membership in C
  let member: string; // member-only in A: can read agency, cannot read pipeline/automation
  let campaignId: string;
  let gateId: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    registerModule(agencyModule);

    coA = await createCompany("WSUX1 Co A", ["agency"]);
    coB = await createCompany("WSUX1 Co B", ["agency"]);
    coC = await createCompany("WSUX1 Co C — not a member");
    await seedAutomationAccounts(coA);
    await seedAutomationAccounts(coB);

    manager = await createUser("wsux1-manager@a.test");
    member = await createUser("wsux1-member@a.test");
    await addMembership(coA, manager);
    await addMembership(coB, manager);
    await addMembership(coA, member);

    const companyAdminRole = await createRole("company_admin");
    const memberRole = await createRole("member");
    await grantRole(manager, companyAdminRole, "company", coA);
    await grantRole(manager, companyAdminRole, "company", coB);
    await grantRole(member, memberRole, "company", coA);

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("setup: seed an agency approval (pending) and a pipeline gate (pending) in coA", async () => {
    const proj = await app.inject({
      method: "POST", url: `/api/${coA}/projects`, headers: asUser(manager), payload: { name: "WSUX1 Project" },
    });
    expect(proj.statusCode).toBe(201);
    const projectId = proj.json().id;

    const campaign = await app.inject({
      method: "POST", url: `/api/${coA}/modules/agency/campaigns`, headers: asUser(manager),
      payload: { name: "Summer Launch", projectId },
    });
    expect(campaign.statusCode).toBe(201);
    campaignId = campaign.json().id;

    const approval = await app.inject({
      method: "POST", url: `/api/${coA}/modules/agency/approvals`, headers: asUser(manager),
      payload: { campaignId, subject: "Hero asset — Summer" },
    });
    expect(approval.statusCode).toBe(201);

    const run = await app.inject({
      method: "POST", url: `/api/${coA}/pipeline/runs`, headers: asWorkflow("wf:mtg-dispatcher"),
      payload: { sourceMeetingId: "wsux1-mtg", title: "WSUX1 kickoff" },
    });
    expect(run.statusCode).toBe(201);
    const runId = run.json().id;

    const gate = await app.inject({
      method: "POST", url: `/api/${coA}/pipeline/gates`, headers: asWorkflow("wf:delivery"),
      payload: { runId, kind: "prd_review", actorSide: "internal" },
    });
    expect(gate.statusCode).toBe(201);
    gateId = gate.json().id;

    // A third origin, automation, so the union spans 3 sources in coA.
    const auto = await app.inject({
      method: "POST", url: `/api/${coA}/automation-approvals`, headers: asWorkflow("wf:new-client-seed"),
      payload: { workflowId: "wf:new-client-seed", toolName: "money.transfer", toolArgs: { amount: 5 }, impact: "high", reason: "high-impact write" },
    });
    expect(auto.statusCode).toBe(201);
  });

  it("unions >=2 origins into one normalized, urgency-sorted list for a single company", async () => {
    const r = await app.inject({ method: "GET", url: `/api/approvals?scope=${coA}`, headers: asUser(manager) });
    expect(r.statusCode).toBe(200);
    const body = r.json() as EnvelopeBody;
    const origins = new Set(body.items.map((i) => i.origin));
    expect(origins.has("agency")).toBe(true);
    expect(origins.has("pipeline")).toBe(true);
    expect(origins.has("automation")).toBe(true);

    // Normalized shape on every row.
    for (const item of body.items) {
      expect(typeof item.id).toBe("string");
      expect(item.tenantId).toBe(coA);
      expect(item.company).toBe("WSUX1 Co A");
      expect(typeof item.subject).toBe("string");
      expect(typeof item.ageMs).toBe("number");
      expect(typeof item.urgencyScore).toBe("number");
      expect(typeof item.decidable).toBe("boolean");
      expect(item.status).toBe("pending");
    }

    // Urgency-sorted descending by default.
    for (let i = 1; i < body.items.length; i++) {
      expect(body.items[i - 1].urgencyScore).toBeGreaterThanOrEqual(body.items[i].urgencyScore);
    }

    // company_admin can decide every origin here.
    expect(body.items.every((i) => i.decidable)).toBe(true);
    expect(body.companies).toEqual([{ id: coA, name: "WSUX1 Co A", included: true }]);
  });

  it("cross-company fan-out (scope=all): includes both authorized companies, tags the unauthorized one excluded, and leaks NO rows from it", async () => {
    const r = await app.inject({ method: "GET", url: `/api/approvals?scope=all`, headers: asUser(manager) });
    expect(r.statusCode).toBe(200);
    const body = r.json() as EnvelopeBody;
    const companyIds = body.companies.map((c) => c.id);
    expect(companyIds).toContain(coA);
    expect(companyIds).toContain(coB);
    expect(companyIds).not.toContain(coC); // manager has no membership in C — never entered the fan-out at all

    const aEntry = body.companies.find((c) => c.id === coA)!;
    expect(aEntry.included).toBe(true);
    expect(aEntry.name).toBe("WSUX1 Co A");
    const bEntry = body.companies.find((c) => c.id === coB)!;
    expect(bEntry.included).toBe(true); // no items, but readable (company_admin) -> included, not excluded

    // No item claims tenantId=coC anywhere in the union.
    expect(body.items.every((i) => i.tenantId !== coC)).toBe(true);
  });

  it("a crafted scope=<companyId the caller cannot see> degrades to an excluded envelope entry, never a leak, never a 500", async () => {
    const r = await app.inject({ method: "GET", url: `/api/approvals?scope=${coC}`, headers: asUser(manager) });
    expect(r.statusCode).toBe(200);
    const body = r.json() as EnvelopeBody;
    expect(body.items).toEqual([]);
    expect(body.companies).toEqual([{ id: coC, included: false, reason: "no_access" }]);
  });

  it("a member-only principal sees agency (readable) but NOT pipeline/automation (elevated-only) in the same company — no widened visibility vs. the native endpoints", async () => {
    const r = await app.inject({ method: "GET", url: `/api/approvals?scope=${coA}`, headers: asUser(member) });
    expect(r.statusCode).toBe(200);
    const body = r.json() as EnvelopeBody;
    const origins = new Set(body.items.map((i) => i.origin));
    expect(origins.has("agency")).toBe(true);
    expect(origins.has("pipeline")).toBe(false);
    expect(origins.has("automation")).toBe(false);
    // Company is still included:true — SOME origin (agency) was readable.
    expect(body.companies).toEqual([{ id: coA, name: "WSUX1 Co A", included: true }]);
    // member cannot decide agency approvals either (decide requires company_admin/module_approver).
    const agencyItem = body.items.find((i) => i.origin === "agency")!;
    expect(agencyItem.decidable).toBe(false);

    // Parity check: the native pipeline endpoint denies this same principal outright (403) —
    // proving the unified read isn't granting access the native source wouldn't.
    const native = await app.inject({ method: "GET", url: `/api/${coA}/pipeline/gates`, headers: asUser(member) });
    expect(native.statusCode).toBe(403);
  });

  it("origin filter narrows the union to exactly the requested source(s)", async () => {
    const r = await app.inject({ method: "GET", url: `/api/approvals?scope=${coA}&origin=pipeline`, headers: asUser(manager) });
    expect(r.statusCode).toBe(200);
    const body = r.json() as EnvelopeBody;
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((i) => i.origin === "pipeline")).toBe(true);
  });

  it("rejects an invalid origin (400)", async () => {
    const r = await app.inject({ method: "GET", url: `/api/approvals?scope=${coA}&origin=bogus`, headers: asUser(manager) });
    expect(r.statusCode).toBe(400);
  });

  it("sort=age orders by ageMs descending", async () => {
    const r = await app.inject({ method: "GET", url: `/api/approvals?scope=${coA}&sort=age`, headers: asUser(manager) });
    expect(r.statusCode).toBe(200);
    const body = r.json() as EnvelopeBody;
    for (let i = 1; i < body.items.length; i++) {
      expect(body.items[i - 1].ageMs).toBeGreaterThanOrEqual(body.items[i].ageMs);
    }
  });

  it("status=decided returns decided-history rows only, once items are decided", async () => {
    await app.inject({ method: "POST", url: `/api/${coA}/pipeline/gates/${gateId}/decide`, headers: asUser(manager), payload: { decision: "approved" } });

    const pending = await app.inject({ method: "GET", url: `/api/approvals?scope=${coA}&origin=pipeline&status=pending`, headers: asUser(manager) });
    expect((pending.json() as EnvelopeBody).items).toEqual([]);

    const decided = await app.inject({ method: "GET", url: `/api/approvals?scope=${coA}&origin=pipeline&status=decided`, headers: asUser(manager) });
    const decidedBody = decided.json() as EnvelopeBody;
    expect(decidedBody.items.length).toBeGreaterThan(0);
    expect(decidedBody.items[0].status).toBe("approved");
  });

  it("rejects an invalid status/sort (400)", async () => {
    expect((await app.inject({ method: "GET", url: `/api/approvals?scope=${coA}&status=bogus`, headers: asUser(manager) })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/api/approvals?scope=${coA}&sort=bogus`, headers: asUser(manager) })).statusCode).toBe(400);
  });

  it("hr-origin: a served company's hr_manager (module_manager) sees ONLY hr-origin rows, never automation/agent rows, in the same tenant", async () => {
    registerModule({
      key: "hr", migrations: [], permissions: [], customFieldTargets: [], mcpTools: [], rollupProviders: [], uiManifest: [],
    });
    const hrManagerRole = await createRole("hr_manager");
    const hrManager = await createUser("wsux1-hrmanager@a.test");
    await addMembership(coA, hrManager);
    await grantRole(hrManager, hrManagerRole, "company", coA);

    // origin='hr' rows are written internally by hr.controller.ts's fileLeave (SQL insert, not
    // the generic create() endpoint — that endpoint's own ORIGINS set deliberately excludes "hr",
    // see automation-approvals.controller.ts). Mirror that exact insert shape directly here so
    // this test doesn't need the full hr module (enable-gate + leave balances) wired up.
    await withTenants([coA], (c) =>
      c.query(
        `INSERT INTO automation_approvals (id, tenant_id, workflow_id, tool_name, tool_args, impact, reason, requested_by, origin, origin_site)
         VALUES ($1,$2,'hr:leave','hr.fileLeave','{}','medium',$3,$4,'hr',$5)`,
        [newId(), coA, "Andi requested vacation leave", manager, config.originSite],
      ),
    );

    const r = await app.inject({ method: "GET", url: `/api/approvals?scope=${coA}&origin=hr,automation,agent`, headers: asUser(hrManager) });
    expect(r.statusCode).toBe(200);
    const body = r.json() as EnvelopeBody;
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((i) => i.origin === "hr")).toBe(true);
    expect(body.companies).toEqual([{ id: coA, name: "WSUX1 Co A", included: true }]);
  });
});
