// PV5-12 — the invoice-issue agent tools (`invoices.issueReadiness`, `invoices.issue`, `invoices.voidIssued`,
// `billingProfile.read`): one GOLDEN CASE per tool, the D14 executors, the bot refusal and the masked read.
//
// Driven the way contracts-billing-tools.test.ts drives the PV3-06 tools: `callTool()` builds the request FROM THE TOOL
// DEF (the hub's `callPlatform`), with the OBO envelope, into the real Nest app; the hub itself is a stub of the
// transport only (the D14 section), so Cerbos, RLS and the routes are all real.
//
// TEETH (each proven in the PV5-12 hand-back by breaking the code in a throwaway edit):
//   (a) return the full number from billing-profile-agent.controller.ts -> "masks the account number" fails;
//   (b) drop `precondition` from the `invoices.issue` / `invoices.voidIssued` registrations -> the three
//       "precondition refuses" cases fail (the hub is called, and the route's own answer is a different error).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { newId, withTenants } from "../db";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, linkIdentity } from "../testing/fixtures";
import { allCoreTools } from "./core-tools";
import { getExecutable } from "./approval-executables";
import { executeApprovedAutomationWrite } from "./approval-execute";
import { ensureBillingSetup } from "../seed/billing-setup";
import { maskAccountNo } from "../modules/invoice/billing-profile-agent.controller";
import { invoiceModule } from "../modules/invoice";
import { financeModule } from "../modules/finance";
import { clientsModule } from "../modules/clients";
import { agencyModule } from "../modules/agency";

const svc = { authorization: "Bearer svc-token" };
const AGENT = "agent:invoicing";
const defs = new Map(allCoreTools().map((t) => [t.name, t]));
const FULL_ACCOUNT_NO = "1234567890123";

describe("PV5-12 · the invoice-issue tool defs (no database)", () => {
  const NAMES = ["invoices.issueReadiness", "invoices.issue", "invoices.voidIssued", "billingProfile.read"];

  it("all four are declared", () => {
    for (const n of NAMES) expect(defs.has(n), n).toBe(true);
  });

  it("🔴 impact: issue and voidIssued are HIGH writes; the two reads carry none and are GETs", () => {
    for (const n of ["invoices.issue", "invoices.voidIssued"]) {
      expect(defs.get(n)!.write, n).toBe(true);
      expect(defs.get(n)!.impact, n).toBe("high");
      expect(defs.get(n)!.method, n).toBe("POST");
    }
    for (const n of ["invoices.issueReadiness", "billingProfile.read"]) {
      expect(defs.get(n)!.write, n).toBeUndefined();
      expect(defs.get(n)!.impact, n).toBeUndefined();
      expect(defs.get(n)!.method, n).toBe("GET");
    }
    for (const n of NAMES) expect(defs.get(n)!.minAssurance, n).toBe("verified");
  });

  it("🔴 both HIGH writes are registry-listed: an approved row executes, it never sits at not_applicable", () => {
    for (const n of ["invoices.issue", "invoices.voidIssued"]) {
      const e = getExecutable(n);
      expect(!!e, `${n} must have a D14 executor`).toBe(true);
      expect(typeof e!.precondition, `${n} must re-check the state it was filed against`).toBe("function");
    }
    for (const n of ["invoices.issueReadiness", "billingProfile.read"]) expect(getExecutable(n), n).toBeUndefined();
  });

  it("the D14 lock keys are per invoice, namespaced per tool, and malformed args do not share one", () => {
    const issue = getExecutable("invoices.issue")!;
    const voidE = getExecutable("invoices.voidIssued")!;
    expect(issue.lockKey({ invoiceId: "i1" })).toBe(issue.lockKey({ invoiceId: "i1" }));
    expect(issue.lockKey({ invoiceId: "i1" })).not.toBe(issue.lockKey({ invoiceId: "i2" }));
    expect(issue.lockKey({ invoiceId: "i1" })).not.toBe(voidE.lockKey({ invoiceId: "i1" }));
    expect(new Set([issue.lockKey({}), issue.lockKey({ invoiceId: 7 }), issue.lockKey({ invoiceId: null })]).size).toBe(3);
  });

  it("the path templates and schemas agree: every :param is required; void REQUIRES a reason", () => {
    for (const n of NAMES) {
      const t = defs.get(n)!;
      const required = (t.inputSchema as { required: string[] }).required;
      for (const m of t.pathTemplate!.matchAll(/:(\w+)/g)) expect(required, `${n} :${m[1]}`).toContain(m[1]);
    }
    expect((defs.get("invoices.voidIssued")!.inputSchema as { required: string[] }).required).toContain("reason");
  });

  it("🔴 NO tool sets bank details, certifies a contract or creates a checkout", () => {
    const all = [
      ...allCoreTools(),
      ...invoiceModule.mcpTools, ...financeModule.mcpTools, ...clientsModule.mcpTools, ...agencyModule.mcpTools,
    ];
    const forbiddenName = /bank|certif|checkout|payment[-_ ]?link/i;
    const offenders = all.filter((t) => forbiddenName.test(t.name) || forbiddenName.test(t.pathTemplate ?? "")).map((t) => t.name);
    expect(offenders, "a tool matches a forbidden capability (bank details, certification, checkout)").toEqual([]);
    // The profile is READ-only for agents: no write tool may reach a billing-profile route.
    const profileWrites = all.filter((t) => t.write && /billing-profile/.test(t.pathTemplate ?? "")).map((t) => t.name);
    expect(profileWrites).toEqual([]);
    // And the one profile tool reaches the MASKED route, never the full one.
    expect(defs.get("billingProfile.read")!.pathTemplate).toBe("/api/:tenantId/billing-profile/masked");
    for (const t of all) expect(t.pathTemplate, t.name).not.toMatch(/\/billing-profile$/);
  });

  it("maskAccountNo keeps the last 4 and nothing else; a short number is masked whole; empty is null", () => {
    expect(maskAccountNo(FULL_ACCOUNT_NO)).toBe("••••0123");
    expect(maskAccountNo(` ${FULL_ACCOUNT_NO} `)).toBe("••••0123");
    expect(maskAccountNo("12345")).toBe("••••2345");
    expect(maskAccountNo("1234")).toBe("••••");
    expect(maskAccountNo("")).toBeNull();
    expect(maskAccountNo(null)).toBeNull();
    expect(maskAccountNo(undefined)).toBeNull();
  });
});

describe.skipIf(!TEST_URL)("PV5-12 · invoice-issue tools through the real endpoints", () => {
  let app: NestFastifyApplication;
  let tenant: string;
  let admin: string;  // company_admin: may issue and void
  let bot: string;    // company_admin, users.kind = 'bot': refused issue and void by Cerbos
  let member: string; // a member with no authority over invoices
  // PGL-05 (PV-D46 (1)): the approver of the D14 rows below. Before PV-D46 they were approved by `admin`, who also filed
  // most of them; the self-approval rule now refuses that at decide time and again at execution.
  let checker: string;
  let clientA: string;

  const as = (ext: string) => ({ provider: "platform", externalId: ext });
  const ADMIN = as("pv512-admin");
  const BOT = as("pv512-bot");
  const MEMBER = as("pv512-member");
  type Who = { provider: string; externalId: string };

  function toolRequest(name: string, args: Record<string, unknown>, who: Who) {
    const def = defs.get(name);
    if (!def) throw new Error(`no such tool: ${name}`);
    const used = new Set<string>();
    const url = def.pathTemplate!.replace(/:([A-Za-z0-9_]+)/g, (_m, n: string) => {
      used.add(n);
      const v = args[n];
      if (v == null || v === "") throw new Error(`missing path parameter: ${n}`);
      return encodeURIComponent(String(v));
    });
    const method = def.method ?? "GET";
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) if (!used.has(k)) rest[k] = v;
    return {
      method,
      url,
      headers: { ...svc, "x-obo-provider": who.provider, "x-obo-external-id": who.externalId, "x-obo-agent": AGENT },
      ...(method !== "GET" ? { payload: rest } : {}),
    };
  }
  const callTool = (name: string, args: Record<string, unknown>, who: Who) =>
    app.inject(toolRequest(name, args, who) as Parameters<typeof app.inject>[0]);
  const asUser = (id: string) => ({ ...svc, "x-user-id": id });

  const activities = async (entityId: string, verb: string) =>
    (await adminPool().query<{ actor_id: string; metadata: { via?: { externalId: string; agent?: string } } }>(
      `SELECT actor_id, metadata FROM activities WHERE target_entity_id = $1 AND verb = $2`, [entityId, verb],
    )).rows;
  const invoiceRow = async (id: string) =>
    (await adminPool().query<{ status: string; issued_at: string | null; invoice_no: string | null }>(
      `SELECT status, issued_at, invoice_no FROM invoices WHERE id = $1`, [id],
    )).rows[0];

  /** An APPROVED invoice (the stage issue starts from), lines that add up. */
  async function approvedInvoice(amount = 500, serviceLineKey: string | null = "services"): Promise<string> {
    const id = newId();
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO invoices (id, tenant_id, client_id, period_start, period_end, status, currency, lines, total, origin_site,
                               created_by, updated_by, approved_by, approved_at, service_line_key)
         VALUES ($1, $2, $3, current_date - 30, current_date, 'approved', 'IDR', $4, $5, 'test', $6, $6, $6, now(), $7)`,
        [id, tenant, clientA, JSON.stringify([{ description: "Design work", hours: 1, rate: amount, amount }]), amount, member, serviceLineKey],
      ),
    );
    return id;
  }
  async function issuedInvoice(): Promise<string> {
    const id = await approvedInvoice();
    const r = await callTool("invoices.issue", { tenantId: tenant, invoiceId: id }, ADMIN);
    expect(r.statusCode, r.body).toBe(200);
    return id;
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.approvalGrantSecret = "pv512-test-secret-not-real";
    config.services.hub = { url: "http://hub.test", token: "hub-token", assuranceToken: "" };
    tenant = await createCompany("PV512 Agency", ["invoice", "clients"]);

    admin = await createUser("admin@pv512.test");
    bot = await createUser("bot@pv512.test");
    member = await createUser("member@pv512.test");
    checker = await createUser("checker@pv512.test");
    const companyAdmin = await createRole("company_admin");
    for (const u of [admin, bot, member, checker]) await addMembership(tenant, u);
    await grantRole(admin, companyAdmin, "company", tenant);
    await grantRole(checker, companyAdmin, "company", tenant);
    await grantRole(bot, companyAdmin, "company", tenant);
    await grantRole(member, await createRole("member"), "company", tenant);
    const pool = adminPool();
    await pool.query(`UPDATE users SET kind = 'bot' WHERE id = $1`, [bot]);
    for (const u of [admin, bot, member]) await pool.query(`UPDATE users SET home_company_id = $1 WHERE id = $2`, [tenant, u]);
    await linkIdentity(admin, ADMIN.provider, ADMIN.externalId, true);
    await linkIdentity(bot, BOT.provider, BOT.externalId, true);
    await linkIdentity(member, MEMBER.provider, MEMBER.externalId, true);

    clientA = await createClient(tenant, "PV512 Client A");
    await ensureBillingSetup(tenant);
    // The seed's placeholder account is all zeros; use a recognisable FAKE one so the mask is observable.
    await pool.query(`UPDATE company_billing_profiles SET bank_account_no = $2 WHERE tenant_id = $1`, [tenant, FULL_ACCOUNT_NO]);
    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ── golden cases: one per tool ───────────────────────────────────────────────────────────────

  describe("golden cases", () => {
    it("invoices.issueReadiness: an approved invoice is ready; an unapproved one lists NOT_APPROVED; a member is refused (403)", async () => {
      const id = await approvedInvoice();
      const ok = await callTool("invoices.issueReadiness", { tenantId: tenant, invoiceId: id }, ADMIN);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({ invoiceId: id, status: "approved", issued: false, ready: true, blockers: [] });

      await adminPool().query(`UPDATE invoices SET status = 'void' WHERE id = $1`, [id]);
      const stuck = await callTool("invoices.issueReadiness", { tenantId: tenant, invoiceId: id }, ADMIN);
      expect(stuck.json().ready).toBe(false);
      expect((stuck.json().blockers as Array<{ code: string }>).map((b) => b.code)).toContain("NOT_APPROVED");

      const denied = await callTool("invoices.issueReadiness", { tenantId: tenant, invoiceId: id }, MEMBER);
      expect(denied.statusCode, denied.body).toBe(403);

      // PV5-04b: an invoice with no service line reports the stable blocker through the tool too.
      const noLine = await approvedInvoice(500, null);
      const missing = await callTool("invoices.issueReadiness", { tenantId: tenant, invoiceId: noLine }, ADMIN);
      expect(missing.statusCode, missing.body).toBe(200);
      expect(missing.json().ready).toBe(false);
      expect((missing.json().blockers as Array<{ code: string }>).map((b) => b.code)).toEqual(["NO_SERVICE_LINE"]);
    });

    it("invoices.issue: issues through the ledger, an `issued` activity names the human AND the agent, a repeat answers the issued invoice", async () => {
      const id = await approvedInvoice();
      const r = await callTool("invoices.issue", { tenantId: tenant, invoiceId: id }, ADMIN);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ id, status: "sent", alreadyIssued: false });
      expect(r.json().invoiceNo).toMatch(/\/\d{4}\//);
      expect((await invoiceRow(id)).issued_at).not.toBeNull();
      const rows = await activities(id, "issued");
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_id).toBe(admin);
      expect(rows[0].metadata.via).toMatchObject({ externalId: ADMIN.externalId, agent: AGENT });

      // Idempotent: the second call answers the SAME issued invoice, takes no new number, writes no second activity.
      const again = await callTool("invoices.issue", { tenantId: tenant, invoiceId: id }, ADMIN);
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json()).toMatchObject({ id, invoiceNo: r.json().invoiceNo, alreadyIssued: true });
      expect(await activities(id, "issued")).toHaveLength(1);
    });

    it("invoices.voidIssued: voids an issued invoice (credit note), a `voided` activity, a repeat is alreadyVoid; a short reason is a 400 after authorization", async () => {
      const id = await issuedInvoice();
      const short = await callTool("invoices.voidIssued", { tenantId: tenant, invoiceId: id, reason: "no" }, ADMIN);
      expect(short.statusCode, short.body).toBe(400);
      expect((await invoiceRow(id)).status).toBe("sent");

      const r = await callTool("invoices.voidIssued", { tenantId: tenant, invoiceId: id, reason: "issued to the wrong client" }, ADMIN);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ id, status: "void", alreadyVoid: false });
      expect(r.json().creditNoteId).toBeTruthy();
      expect((await invoiceRow(id)).status).toBe("void");
      const rows = await activities(id, "voided");
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_id).toBe(admin);
      expect(rows[0].metadata.via?.agent).toBe(AGENT);

      const again = await callTool("invoices.voidIssued", { tenantId: tenant, invoiceId: id, reason: "issued to the wrong client" }, ADMIN);
      expect(again.json()).toMatchObject({ status: "void", alreadyVoid: true });
      expect(await activities(id, "voided")).toHaveLength(1);
    });

    it("🔴 billingProfile.read: the bank account number is MASKED to its last 4, nowhere in the body is the full number", async () => {
      const r = await callTool("billingProfile.read", { tenantId: tenant }, ADMIN);
      expect(r.statusCode, r.body).toBe(200);
      const p = r.json();
      expect(p.invoicePrefix).toBe("INV");
      expect(p.bank.bankName).toBeTruthy();
      expect(p.bank.accountNoMasked).toBe("••••0123");
      expect(p.bank.accountNo).toBeUndefined();
      expect(r.body).not.toContain(FULL_ACCOUNT_NO);
      expect(r.body).not.toContain("1234567890");
      // PV5-F4: the gateway clearing account CODE is part of the agent's view (a code is not secret); null until set.
      expect(p).toHaveProperty("gatewayClearingAccountCode", null);
      await adminPool().query(`UPDATE company_billing_profiles SET gateway_clearing_account_code = '1125' WHERE tenant_id = $1`, [tenant]);
      const withCode = await callTool("billingProfile.read", { tenantId: tenant }, ADMIN);
      expect(withCode.statusCode, withCode.body).toBe(200);
      expect(withCode.json().gatewayClearingAccountCode).toBe("1125");
      expect(withCode.json().bank.accountNoMasked).toBe("••••0123"); // the bank number stays masked
      expect(withCode.body).not.toContain(FULL_ACCOUNT_NO);
      // The route is a refusal for a caller who may not read profiles, never an empty profile.
      const denied = await callTool("billingProfile.read", { tenantId: tenant }, MEMBER);
      expect(denied.statusCode, denied.body).toBe(403);
      expect(denied.body).not.toContain("0123");
    });
  });

  // ── a bot is refused directly ────────────────────────────────────────────────────────────────

  describe("a bot or automation principal calling a HIGH invoice tool directly", () => {
    it("🔴 invoices.issue as a bot (holding company_admin) is refused 403 and nothing is issued", async () => {
      const id = await approvedInvoice();
      const viaTool = await callTool("invoices.issue", { tenantId: tenant, invoiceId: id }, BOT);
      expect(viaTool.statusCode, viaTool.body).toBe(403);
      const direct = await app.inject({ method: "POST", url: `/api/${tenant}/invoices/${id}/issue`, headers: asUser(bot) });
      expect(direct.statusCode, direct.body).toBe(403);
      expect(await invoiceRow(id)).toMatchObject({ status: "approved", issued_at: null });
      expect(await activities(id, "issued")).toHaveLength(0);
    });

    it("🔴 invoices.voidIssued as a bot is refused 403, even with an EMPTY body (authorization before validation)", async () => {
      const id = await issuedInvoice();
      const viaTool = await callTool("invoices.voidIssued", { tenantId: tenant, invoiceId: id, reason: "bot trying to void" }, BOT);
      expect(viaTool.statusCode, viaTool.body).toBe(403);
      const empty = await app.inject({ method: "POST", url: `/api/${tenant}/invoices/${id}/void`, headers: asUser(bot), payload: {} });
      expect(empty.statusCode, empty.body).toBe(403);
      expect((await invoiceRow(id)).status).toBe("sent");
    });
  });

  // ── D14: approving actually executes, as the human the agent acted for ──────────────────────

  describe("D14: an approved call re-runs as the ORIGINAL filing principal", () => {
    const realFetch = globalThis.fetch;
    let hubCalls = 0;

    beforeEach(() => {
      hubCalls = 0;
      vi.stubGlobal("fetch", vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
        if (!String(url).startsWith("http://hub.test")) return realFetch(url as never, init as never);
        hubCalls++;
        const { params } = JSON.parse(init.body) as { params: { name: string; arguments: Record<string, unknown> } };
        const res = await callTool(params.name, params.arguments, {
          provider: init.headers["x-obo-provider"], externalId: init.headers["x-obo-external-id"],
        });
        const text = res.statusCode < 300 ? res.body : String(res.json().error ?? res.json().message ?? res.body);
        const rpc = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }], ...(res.statusCode < 300 ? {} : { isError: true }) } };
        return { ok: true, status: 200, text: async () => `event: message\ndata: ${JSON.stringify(rpc)}\n\n` } as never;
      }) as unknown as typeof fetch);
    });
    afterEach(() => vi.restoreAllMocks());

    async function fileApproved(tool: string, args: Record<string, unknown>, filedBy: string): Promise<string> {
      const id = newId();
      await withTenants([tenant], (c) =>
        c.query(
          `INSERT INTO automation_approvals
             (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, decided_by, decided_at,
              origin, origin_site, execution_status)
           VALUES ($1,$2,'wf:pv512-agent',$3,$4,'high','approved',$5,$6,now(),'agent','main','pending')`,
          [id, tenant, tool, JSON.stringify(args), filedBy, checker],
        ),
      );
      return id;
    }
    const rowOf = async (id: string) =>
      (await adminPool().query<{ execution_status: string; execution_error: string | null; executed_by: string | null }>(
        `SELECT execution_status, execution_error, executed_by FROM automation_approvals WHERE id = $1`, [id],
      )).rows[0];

    it("🔴 invoices.issue: approving it issues the invoice, as the human who filed it, exactly once", async () => {
      const id = await approvedInvoice();
      const a = await fileApproved("invoices.issue", { tenantId: tenant, invoiceId: id }, admin);
      expect(await executeApprovedAutomationWrite(tenant, a)).toEqual({ status: "executed" });
      expect(hubCalls).toBe(1);
      expect(await invoiceRow(id)).toMatchObject({ status: "sent" });
      expect((await invoiceRow(id)).invoice_no).toBeTruthy();
      expect((await rowOf(a)).executed_by).toBe(admin);
      const rows = await activities(id, "issued");
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_id).toBe(admin);
      // Once: a redelivery finds nothing to claim.
      expect(await executeApprovedAutomationWrite(tenant, a)).toMatchObject({ status: "skipped" });
      expect(hubCalls).toBe(1);
    });

    it("🔴 an approval filed for someone who may NOT issue is APPROVED but REFUSED at execution: the approver's authority never replaces the filer's", async () => {
      const id = await approvedInvoice();
      const a = await fileApproved("invoices.issue", { tenantId: tenant, invoiceId: id }, member);
      const out = await executeApprovedAutomationWrite(tenant, a);
      expect(out.status).toBe("failed");
      expect((await rowOf(a)).execution_error).toMatch(/not authorized/);
      expect(await invoiceRow(id)).toMatchObject({ status: "approved", issued_at: null });

      // And an approval filed as the BOT principal is refused the same way (PV5-02).
      const b = await fileApproved("invoices.issue", { tenantId: tenant, invoiceId: id }, bot);
      expect((await executeApprovedAutomationWrite(tenant, b)).status).toBe("failed");
      expect(await invoiceRow(id)).toMatchObject({ status: "approved", issued_at: null });
    });

    it("🔴 invoices.issue: the precondition refuses when the invoice changed after filing (issued meanwhile, no longer approved, no longer ready); the hub is NOT called", async () => {
      // 1. A human issued it while the approval sat in the inbox.
      const issuedMeanwhile = await approvedInvoice();
      const a1 = await fileApproved("invoices.issue", { tenantId: tenant, invoiceId: issuedMeanwhile }, admin);
      const h = await app.inject({ method: "POST", url: `/api/${tenant}/invoices/${issuedMeanwhile}/issue`, headers: asUser(admin) });
      expect(h.statusCode, h.body).toBe(200);
      expect(await executeApprovedAutomationWrite(tenant, a1)).toMatchObject({ status: "failed", error: "precondition_failed: invoice_already_issued" });

      // 2. It stopped being approved.
      const reopened = await approvedInvoice();
      const a2 = await fileApproved("invoices.issue", { tenantId: tenant, invoiceId: reopened }, admin);
      await adminPool().query(`UPDATE invoices SET status = 'void' WHERE id = $1`, [reopened]);
      expect(await executeApprovedAutomationWrite(tenant, a2)).toMatchObject({ status: "failed", error: "precondition_failed: invoice_not_approved" });

      // 3. Still approved, but it is no longer READY (its lines stopped adding up to the total).
      const broken = await approvedInvoice();
      const a3 = await fileApproved("invoices.issue", { tenantId: tenant, invoiceId: broken }, admin);
      await adminPool().query(`UPDATE invoices SET total = total + 1 WHERE id = $1`, [broken]);
      expect(await executeApprovedAutomationWrite(tenant, a3)).toMatchObject({
        status: "failed", error: "precondition_failed: invoice_not_ready: LINES_TOTAL_MISMATCH",
      });

      expect(hubCalls).toBe(0);
      expect((await invoiceRow(broken)).issued_at).toBeNull();
      expect((await invoiceRow(reopened)).issued_at).toBeNull();
      expect(await activities(issuedMeanwhile, "issued")).toHaveLength(1); // the human's, no second
    });

    it("🔴 invoices.voidIssued: approving it voids the issued invoice as the filer; a paid/void/never-issued one is refused by the precondition", async () => {
      const id = await issuedInvoice();
      const a = await fileApproved("invoices.voidIssued", { tenantId: tenant, invoiceId: id, reason: "duplicate invoice" }, admin);
      expect(await executeApprovedAutomationWrite(tenant, a)).toEqual({ status: "executed" });
      expect(hubCalls).toBe(1);
      expect((await invoiceRow(id)).status).toBe("void");
      const rows = await activities(id, "voided");
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_id).toBe(admin);

      // Already void (a retry, or a human first): refused before the hub is called.
      const calls = hubCalls;
      const again = await fileApproved("invoices.voidIssued", { tenantId: tenant, invoiceId: id, reason: "duplicate invoice" }, admin);
      expect(await executeApprovedAutomationWrite(tenant, again)).toMatchObject({ status: "failed", error: "precondition_failed: invoice_not_voidable" });

      // Paid in the meantime.
      const paid = await issuedInvoice();
      const p = await fileApproved("invoices.voidIssued", { tenantId: tenant, invoiceId: paid, reason: "duplicate invoice" }, admin);
      await adminPool().query(`UPDATE invoices SET status = 'paid' WHERE id = $1`, [paid]);
      expect(await executeApprovedAutomationWrite(tenant, p)).toMatchObject({ status: "failed", error: "precondition_failed: invoice_not_voidable" });

      // Never issued.
      const draftish = await approvedInvoice();
      const n = await fileApproved("invoices.voidIssued", { tenantId: tenant, invoiceId: draftish, reason: "duplicate invoice" }, admin);
      expect(await executeApprovedAutomationWrite(tenant, n)).toMatchObject({ status: "failed", error: "precondition_failed: invoice_not_issued" });

      // No usable reason.
      const noReason = await fileApproved("invoices.voidIssued", { tenantId: tenant, invoiceId: draftish }, admin);
      expect(await executeApprovedAutomationWrite(tenant, noReason)).toMatchObject({ status: "failed", error: "precondition_failed: void_reason_required" });
      expect(hubCalls).toBe(calls);
    });

    it("🔴 an approval filed for someone who may NOT void is refused at execution", async () => {
      const id = await issuedInvoice();
      const a = await fileApproved("invoices.voidIssued", { tenantId: tenant, invoiceId: id, reason: "member trying to void" }, member);
      expect((await executeApprovedAutomationWrite(tenant, a)).status).toBe("failed");
      expect((await rowOf(a)).execution_error).toMatch(/not authorized/);
      expect((await invoiceRow(id)).status).toBe("sent");
    });

    it("preconditions fail closed on missing args and on an invoice this tenant cannot see", async () => {
      const pre = (tool: string, args: Record<string, unknown>) =>
        withTenants([tenant], (c) => getExecutable(tool)!.precondition!(c, args));
      for (const tool of ["invoices.issue", "invoices.voidIssued"]) {
        expect(await pre(tool, { tenantId: tenant })).toEqual({ ok: false, reason: "missing_invoice_args" });
        expect(await pre(tool, { tenantId: tenant, invoiceId: newId(), reason: "long enough" })).toEqual({ ok: false, reason: "invoice_not_found" });
      }
    });
  });
});
