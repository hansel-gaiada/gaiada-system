// PGL-05 + PGL-06 (owner ruling PV-D46 (1) and (2)) — the approval tightening, driven through the REAL decide route, the
// unified `/approvals/:id/decide` façade, the executor's second wall, and the read hints. PERMISSION-CONTRACT §52.
//
// Cases (each rule has a case that would fail without it):
//   PGL-05 — nobody approves their own agent's HIGH-impact request
//     - the filer's own approval is refused (403 self_approval), the row stays pending, through both decide doors;
//     - the human the agent acts for is refused: an agent-path filing (the human's own OBO envelope + x-obo-agent);
//     - a decider ACTING FOR the filer (x-act-for) is refused;
//     - platform_admin is refused (nobody is exempt);
//     - a filer cannot dodge it by storing a lower impact;
//     - a different approver succeeds;
//     - the filer may REJECT, and a rejected row executes nothing;
//     - a medium-impact self-approval is unchanged;
//     - the second wall: a row whose STORED decided_by is its filer is refused at execution, hub never called;
//     - a filing that acts for someone else is refused (its human would not be recorded);
//     - the hints: the detail row and the unified inbox say `self_approval` to the filer and nothing to another approver.
//   PGL-06 — approving an agent's countersign needs the countersign right
//     - an approver without it (company_admin) gets 403 countersign_right_required, the row stays pending;
//     - an approver with it (a second owner) succeeds;
//     - the filer WITH the right still gets self_approval (the two rules stack);
//     - the second wall: a stored approver without the right is refused at execution, nothing is signed;
//     - the hint says countersign_right_required to the company_admin.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { newId, withTenants } from "../db";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, linkIdentity } from "../testing/fixtures";
import { sha256Hex } from "./content-hash";
import { COUNTERSIGN_RIGHT_REQUIRED } from "./approval-executables";
import { executeApprovedAutomationWrite } from "./approval-execute";
import { ACT_FOR_FILING_UNSUPPORTED, SELF_APPROVAL } from "./approval-self-approval";

const svc = { authorization: "Bearer svc-token" };
const AGENT = "agent:pgl05";

describe.skipIf(!TEST_URL)("PGL-05/06 · approval tightening (PV-D46) through the real routes", () => {
  let app: NestFastifyApplication;
  let tenant: string;
  let filer: string; // company_admin: files through their agent, and could otherwise decide
  let checker: string; // a second company_admin: an eligible approver, no countersign right
  let owner: string; // owner: holds countersign
  let coOwner: string; // a second owner: an eligible countersign approver
  let platformAdmin: string; // global platform_admin
  let clientA: string;

  const FILER = { provider: "platform", externalId: "pgl05-filer" };
  const CHECKER = { provider: "platform", externalId: "pgl05-checker" };
  const OWNER = { provider: "platform", externalId: "pgl05-owner" };

  const asUser = (id: string) => ({ ...svc, "x-user-id": id });
  /** The agent runner's envelope: the HUMAN's identity, with the agent named alongside (never instead). */
  const asAgentFor = (who: { provider: string; externalId: string }) => ({
    ...svc, "x-obo-provider": who.provider, "x-obo-external-id": who.externalId, "x-obo-agent": AGENT,
  });

  const realFetch = globalThis.fetch;
  let hubCalls = 0;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.approvalGrantSecret = "pgl05-test-secret-not-real";
    config.services.hub = { url: "http://hub.pgl05.test", token: "hub-token", assuranceToken: "" };
    tenant = await createCompany("PGL05 Agency", ["agency", "clients"]);
    const companyAdmin = await createRole("company_admin");
    const ownerRole = await createRole("owner");
    filer = await createUser("filer@pgl05.test");
    checker = await createUser("checker@pgl05.test");
    owner = await createUser("owner@pgl05.test");
    coOwner = await createUser("co-owner@pgl05.test");
    platformAdmin = await createUser("pa@pgl05.test");
    for (const u of [filer, checker, owner, coOwner, platformAdmin]) await addMembership(tenant, u);
    await grantRole(filer, companyAdmin, "company", tenant);
    await grantRole(checker, companyAdmin, "company", tenant);
    await grantRole(owner, ownerRole, "company", tenant);
    await grantRole(coOwner, ownerRole, "company", tenant);
    await grantRole(platformAdmin, await createRole("platform_admin"), "global", null);
    const pool = adminPool();
    for (const u of [filer, checker, owner, coOwner, platformAdmin]) {
      await pool.query(`UPDATE users SET home_company_id = $1 WHERE id = $2`, [tenant, u]);
    }
    await linkIdentity(filer, FILER.provider, FILER.externalId, true);
    await linkIdentity(checker, CHECKER.provider, CHECKER.externalId, true);
    await linkIdentity(owner, OWNER.provider, OWNER.externalId, true);
    clientA = await createClient(tenant, "PGL05 Client A");
    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  beforeEach(() => {
    hubCalls = 0;
    // The executor must never reach the hub in this file: every execution here is refused before the call.
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: unknown) => {
      if (String(url).startsWith("http://hub.pgl05.test")) {
        hubCalls++;
        return { ok: false, status: 500, text: async () => "hub must not be called" } as never;
      }
      return realFetch(url as never, init as never);
    }) as unknown as typeof fetch);
  });
  afterEach(() => vi.restoreAllMocks());

  // ── helpers ─────────────────────────────────────────────────────────────────────────────────────

  /** File through the agent path, exactly as the hub's `approvals.request` lands: the human's envelope + the agent. */
  async function fileAsAgentOf(
    who: { provider: string; externalId: string },
    toolName: string,
    toolArgs: Record<string, unknown>,
    impact: "medium" | "high" | "unclassified" = "high",
  ): Promise<string> {
    const r = await app.inject({
      method: "POST",
      url: `/api/${tenant}/automation-approvals`,
      headers: asAgentFor(who),
      payload: { workflowId: AGENT, toolName, toolArgs, impact, reason: "PGL-05 test: suspended", origin: "agent", agentName: AGENT },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id;
  }
  /** A pending row filed directly (the shape approval-filing.ts INSERTs), for a filer who has no identity link. */
  async function filePending(toolName: string, toolArgs: Record<string, unknown>, requestedBy: string, impact = "high", origin = "agent"): Promise<string> {
    const id = newId();
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO automation_approvals (id, tenant_id, workflow_id, tool_name, tool_args, impact, requested_by, origin, agent_name, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'main')`,
        [id, tenant, origin === "automation" ? "wf:pgl05" : AGENT, toolName, JSON.stringify(toolArgs), impact, requestedBy, origin, AGENT],
      ),
    );
    return id;
  }
  /** A row already `approved` + `pending` execution, as if decided around the route (the second wall's case). */
  async function fileApproved(toolName: string, toolArgs: Record<string, unknown>, requestedBy: string, decidedBy: string, impact = "high"): Promise<string> {
    const id = newId();
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO automation_approvals
           (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, decided_by, decided_at, origin, origin_site, execution_status)
         VALUES ($1,$2,$3,$4,$5,$6,'approved',$7,$8,now(),'agent','main','pending')`,
        [id, tenant, AGENT, toolName, JSON.stringify(toolArgs), impact, requestedBy, decidedBy],
      ),
    );
    return id;
  }
  const decideRoute = (id: string, headers: Record<string, string>, decision: "approved" | "rejected") =>
    app.inject({ method: "POST", url: `/api/${tenant}/automation-approvals/${id}/decide`, headers, payload: { decision } });
  const decideFacade = (id: string, headers: Record<string, string>, decision: "approved" | "rejected") =>
    app.inject({ method: "POST", url: `/api/${tenant}/approvals/${id}/decide`, headers, payload: { origin: "agent", decision } });
  const rowOf = async (id: string) =>
    (await adminPool().query<{ status: string; decided_by: string | null; execution_status: string; execution_error: string | null }>(
      `SELECT status, decided_by, execution_status, execution_error FROM automation_approvals WHERE id = $1`, [id],
    )).rows[0];
  const detailAs = async (id: string, by: string) => {
    const r = await app.inject({ method: "GET", url: `/api/${tenant}/automation-approvals/${id}`, headers: asUser(by) });
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as { approveRefusal: string | null; status: string };
  };
  /** A sent, unsigned contract, inserted in the state `contracts.countersign`'s precondition accepts. */
  async function sentContract(title: string): Promise<string> {
    const id = newId();
    await adminPool().query(
      `INSERT INTO contracts (id, tenant_id, client_id, title, status, sent_at, body_md, content_sha256, content_fixed_at, signature_tier, origin_site)
       VALUES ($1, $2, $3, $4, 'sent', now(), 'Terms.', $5, now(), 'attested', 'test')`,
      [id, tenant, clientA, title, sha256Hex("Terms.")],
    );
    return id;
  }
  const providerSigs = async (id: string) =>
    (await adminPool().query(`SELECT 1 FROM contract_signatures WHERE contract_id = $1 AND party = 'provider'`, [id])).rowCount;

  const issueArgs = () => ({ tenantId: tenant, invoiceId: newId() });

  // ── PGL-05 ──────────────────────────────────────────────────────────────────────────────────────

  describe("PGL-05: nobody approves their own agent's high-impact request", () => {
    it("🔴 the filer's own approval is refused 403 self_approval through BOTH decide doors; the row stays pending", async () => {
      const id = await fileAsAgentOf(FILER, "invoices.issue", issueArgs());
      const direct = await decideRoute(id, asUser(filer), "approved");
      expect(direct.statusCode, direct.body).toBe(403);
      expect(direct.json().reason).toBe(SELF_APPROVAL);
      expect(String(direct.json().error)).toMatch(/^self_approval:/);
      const facade = await decideFacade(id, asUser(filer), "approved");
      expect(facade.statusCode, facade.body).toBe(403);
      expect(facade.json().reason).toBe(SELF_APPROVAL);
      expect(await rowOf(id)).toMatchObject({ status: "pending", decided_by: null, execution_status: "not_applicable" });
    });

    it("🔴 the human the agent acts for is refused: an agent-path filing records that human as the filer", async () => {
      const id = await fileAsAgentOf(FILER, "invoicePayments.decide", { tenantId: tenant, paymentId: newId(), decision: "confirm" });
      expect((await adminPool().query(`SELECT requested_by FROM automation_approvals WHERE id = $1`, [id])).rows[0].requested_by).toBe(filer);
      // The same human deciding through their own agent's envelope is the same human.
      const viaAgent = await decideRoute(id, asAgentFor(FILER), "approved");
      expect(viaAgent.statusCode, viaAgent.body).toBe(403);
      expect(viaAgent.json().reason).toBe(SELF_APPROVAL);
      expect((await rowOf(id)).status).toBe("pending");
    });

    it("🔴 a decider ACTING FOR the filer (x-act-for) is refused, though the decider alone could approve", async () => {
      const id = await fileAsAgentOf(FILER, "invoices.voidIssued", { tenantId: tenant, invoiceId: newId(), reason: "duplicate" });
      const r = await decideRoute(id, { ...asAgentFor(CHECKER), "x-act-for": filer }, "approved");
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json().reason).toBe(SELF_APPROVAL);
      expect((await rowOf(id)).status).toBe("pending");
    });

    it("🔴 platform_admin is not exempt: their own high-impact request is refused", async () => {
      const id = await filePending("invoices.issue", issueArgs(), platformAdmin);
      const r = await decideRoute(id, asUser(platformAdmin), "approved");
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json().reason).toBe(SELF_APPROVAL);
      expect((await rowOf(id)).status).toBe("pending");
      // …while platform_admin approving SOMEONE ELSE's request is fine.
      const other = await filePending("invoices.issue", issueArgs(), filer);
      const ok = await decideRoute(other, asUser(platformAdmin), "approved");
      expect(ok.statusCode, ok.body).toBe(200);
    });

    it("🔴 storing a lower impact does not dodge it: a server-side HIGH tool filed as medium is still high", async () => {
      const id = await fileAsAgentOf(FILER, "contracts.countersign", { tenantId: tenant, contractId: newId(), signerName: "F" }, "medium");
      const r = await decideRoute(id, asUser(filer), "approved");
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json().reason).toBe(SELF_APPROVAL);
    });

    it("the automation origin is covered too", async () => {
      const id = await filePending("invoices.issue", issueArgs(), filer, "high", "automation");
      const r = await decideRoute(id, asUser(filer), "approved");
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json().reason).toBe(SELF_APPROVAL);
    });

    it("a different approver succeeds: approved, decided_by the approver, queued for execution", async () => {
      const id = await fileAsAgentOf(FILER, "invoices.issue", issueArgs());
      expect((await decideRoute(id, asUser(filer), "approved")).statusCode).toBe(403);
      const r = await decideFacade(id, asUser(checker), "approved");
      expect(r.statusCode, r.body).toBe(200);
      expect(await rowOf(id)).toMatchObject({ status: "approved", decided_by: checker, execution_status: "pending" });
    });

    it("the filer may REJECT their own request, and a rejected row executes nothing", async () => {
      const id = await fileAsAgentOf(FILER, "invoices.issue", issueArgs());
      const r = await decideRoute(id, asUser(filer), "rejected");
      expect(r.statusCode, r.body).toBe(200);
      expect(await rowOf(id)).toMatchObject({ status: "rejected", decided_by: filer, execution_status: "not_applicable" });
      expect(await executeApprovedAutomationWrite(tenant, id)).toEqual({ status: "skipped", reason: "not_pending" });
      expect(hubCalls).toBe(0);
    });

    it("a medium-impact self-approval is unchanged (the rule is the high tier only)", async () => {
      const id = await fileAsAgentOf(FILER, "contracts.send", { tenantId: tenant, contractId: newId() }, "medium");
      const r = await decideRoute(id, asUser(filer), "approved");
      expect(r.statusCode, r.body).toBe(200);
      expect((await rowOf(id)).status).toBe("approved");
    });

    it("🔴 second wall: a row whose STORED decider is its filer is refused at execution; the hub is never called", async () => {
      // As if decided around the gate (a hand edit, a future surface, a row decided before the rule).
      const a = await fileApproved("invoices.issue", issueArgs(), filer, filer);
      expect(await executeApprovedAutomationWrite(tenant, a)).toEqual({ status: "failed", error: `approver_refused: ${SELF_APPROVAL}` });
      expect(await rowOf(a)).toMatchObject({ execution_status: "failed", execution_error: `approver_refused: ${SELF_APPROVAL}` });
      // Under-labelled in storage: still refused, because the tier comes from the server side.
      const b = await fileApproved("invoices.issue", issueArgs(), filer, filer, "medium");
      expect(await executeApprovedAutomationWrite(tenant, b)).toEqual({ status: "failed", error: `approver_refused: ${SELF_APPROVAL}` });
      expect(hubCalls).toBe(0);
    });

    it("🔴 a filing that acts for SOMEONE ELSE is refused 400 act_for_filing_unsupported, and nothing is filed", async () => {
      const before = (await adminPool().query(`SELECT count(*)::int AS n FROM automation_approvals WHERE tenant_id = $1`, [tenant])).rows[0].n;
      const r = await app.inject({
        method: "POST",
        url: `/api/${tenant}/automation-approvals`,
        headers: { ...asAgentFor(CHECKER), "x-act-for": filer },
        payload: { workflowId: AGENT, toolName: "invoices.issue", toolArgs: issueArgs(), impact: "high", origin: "agent", agentName: AGENT },
      });
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json().reason).toBe(ACT_FOR_FILING_UNSUPPORTED);
      const after = (await adminPool().query(`SELECT count(*)::int AS n FROM automation_approvals WHERE tenant_id = $1`, [tenant])).rows[0].n;
      expect(after).toBe(before);
    });

    it("the hints: the detail row and the unified inbox tell the filer why Approve is refused, and say nothing to another approver", async () => {
      const id = await fileAsAgentOf(FILER, "invoices.issue", issueArgs());
      expect((await detailAs(id, filer)).approveRefusal).toBe(SELF_APPROVAL);
      expect((await detailAs(id, checker)).approveRefusal).toBeNull();
      const inbox = async (by: string) => {
        const r = await app.inject({ method: "GET", url: `/api/approvals?scope=${tenant}&origin=agent`, headers: asUser(by) });
        expect(r.statusCode, r.body).toBe(200);
        return (r.json().items as Array<{ id: string; approveRefusal?: string | null }>).find((i) => i.id === id);
      };
      expect((await inbox(filer))?.approveRefusal).toBe(SELF_APPROVAL);
      expect((await inbox(checker))?.approveRefusal).toBeNull();
      // A decided row carries no hint.
      await decideRoute(id, asUser(checker), "approved");
      expect((await detailAs(id, filer)).approveRefusal).toBeNull();
    });
  });

  // ── PGL-06 ──────────────────────────────────────────────────────────────────────────────────────

  describe("PGL-06: approving an agent's countersign needs the countersign right", () => {
    it("🔴 an approver WITHOUT the right (company_admin) gets 403 countersign_right_required; the row stays pending", async () => {
      const k = await sentContract("PGL06 no right");
      const id = await fileAsAgentOf(OWNER, "contracts.countersign", { tenantId: tenant, contractId: k, signerName: "Olive Owner" });
      const r = await decideRoute(id, asUser(checker), "approved");
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json().reason).toBe(COUNTERSIGN_RIGHT_REQUIRED);
      expect(String(r.json().error)).toMatch(/^countersign_right_required:/);
      const f = await decideFacade(id, asUser(checker), "approved");
      expect(f.statusCode, f.body).toBe(403);
      expect(f.json().reason).toBe(COUNTERSIGN_RIGHT_REQUIRED);
      expect(await rowOf(id)).toMatchObject({ status: "pending", decided_by: null });
      // The company_admin may still reject: rejecting signs nothing.
      const rej = await decideRoute(id, asUser(checker), "rejected");
      expect(rej.statusCode, rej.body).toBe(200);
      expect(await providerSigs(k)).toBe(0);
    });

    it("an approver WITH the right (a second owner) succeeds", async () => {
      const k = await sentContract("PGL06 with right");
      const id = await fileAsAgentOf(OWNER, "contracts.countersign", { tenantId: tenant, contractId: k, signerName: "Olive Owner" });
      expect((await detailAs(id, checker)).approveRefusal).toBe(COUNTERSIGN_RIGHT_REQUIRED);
      expect((await detailAs(id, coOwner)).approveRefusal).toBeNull();
      const r = await decideRoute(id, asUser(coOwner), "approved");
      expect(r.statusCode, r.body).toBe(200);
      expect(await rowOf(id)).toMatchObject({ status: "approved", decided_by: coOwner, execution_status: "pending" });
    });

    it("🔴 the filer WITH the right still gets self_approval: the two rules stack", async () => {
      const k = await sentContract("PGL06 filer owner");
      const id = await fileAsAgentOf(OWNER, "contracts.countersign", { tenantId: tenant, contractId: k, signerName: "Olive Owner" });
      expect((await detailAs(id, owner)).approveRefusal).toBe(SELF_APPROVAL);
      const r = await decideRoute(id, asUser(owner), "approved");
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json().reason).toBe(SELF_APPROVAL);
      expect((await rowOf(id)).status).toBe("pending");
    });

    it("🔴 second wall: a stored approver without the right is refused at execution; nothing is signed, hub not called", async () => {
      const k = await sentContract("PGL06 second wall");
      const a = await fileApproved("contracts.countersign", { tenantId: tenant, contractId: k, signerName: "Olive Owner" }, owner, checker);
      expect(await executeApprovedAutomationWrite(tenant, a)).toEqual({
        status: "failed", error: `approver_refused: ${COUNTERSIGN_RIGHT_REQUIRED}`,
      });
      expect(hubCalls).toBe(0);
      expect(await providerSigs(k)).toBe(0);
    });
  });
});
