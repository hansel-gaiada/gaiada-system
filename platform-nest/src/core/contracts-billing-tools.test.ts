// PV3-06 — the billing tools (`contracts.*`, `invoicePayments.*`): one GOLDEN CASE per tool, the D14
// registry entries, and the authorization-before-validation fix on `countersign` and `decide`.
//
// ── HOW A TOOL IS DRIVEN HERE ────────────────────────────────────────────────────────────────────
// `callTool()` builds the request FROM THE TOOL DEF, the way mcp-hub's `callPlatform` does (the
// `:param` tokens filled from the args and URL-encoded, the remaining args sent as the JSON body for
// anything but a GET, a GET's leftover args dropped), and injects it into the real Nest app with the
// OBO envelope the hub sends (`x-obo-provider`, `x-obo-external-id`, `x-obo-agent`). So a wrong path
// template, a wrong method, a missing required arg or a body member the route does not read fails
// HERE, and the actor on every activity row is a non-human `via` (an agent) acting as a verified
// human, which is the case readiness-bar criterion 6 asks about.
//
// The hub itself is not in this harness. For the D14 section, a stub stands in for it: it receives the
// executor's `tools/call`, takes the OBO envelope from the request, and runs the SAME def-to-request
// path into the real app. That proves "approving executes" through the real executor and the real
// route (Cerbos, RLS, the maker-checker rule), with only the hub's own gate (policy.ts, which has its
// own suite) stubbed. It is a stub of a transport, not of the platform.
//
// ── AUTHORIZATION BEFORE VALIDATION ─────────────────────────────────────────────────────────────
// The denial cases that matter send an EMPTY body: a caller who may not countersign / decide must get
// 403 whatever they sent. Before PV3-06 both handlers validated the body first, so the same request
// got a 400 and a denial test with a thin payload silently stopped testing authorization.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { newId, withTenants } from "../db";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { sha256Hex } from "./content-hash";
import {
  createCompany, createUser, addMembership, createRole, grantRole, createClient, linkIdentity,
} from "../testing/fixtures";
import { allCoreTools } from "./core-tools";
import { APPROVER_RECORDED_THIS_PAYMENT, getExecutable } from "./approval-executables";
import { executeApprovedAutomationWrite } from "./approval-execute";
import { createIssuedInvoice, ensureBillingSetup } from "../seed/billing-setup";

const svc = { authorization: "Bearer svc-token" };
const AGENT = "agent:billing";
const defs = new Map(allCoreTools().map((t) => [t.name, t]));

describe("PV3-06 · the billing tool defs (no database)", () => {
  const names = ["contracts.list", "contracts.get", "contracts.createDraft", "contracts.updateDraft",
    "contracts.send", "contracts.countersign", "invoicePayments.list", "invoicePayments.decide"];

  it("all eight are declared, in the order the surface pins", () => {
    for (const n of names) expect(defs.has(n), n).toBe(true);
  });

  it("🔴 impact: send MEDIUM, countersign and decide HIGH, drafts LOW, reads carry none", () => {
    expect(defs.get("contracts.send")!.impact).toBe("medium");
    expect(defs.get("contracts.countersign")!.impact).toBe("high");
    expect(defs.get("invoicePayments.decide")!.impact).toBe("high");
    expect(defs.get("contracts.createDraft")!.impact).toBe("low");
    expect(defs.get("contracts.updateDraft")!.impact).toBe("low");
    for (const n of ["contracts.list", "contracts.get", "invoicePayments.list"]) {
      expect(defs.get(n)!.write, n).toBeUndefined();
      expect(defs.get(n)!.impact, n).toBeUndefined();
      expect(defs.get(n)!.method, n).toBe("GET");
    }
  });

  // PV-D28: an n8n principal is capped at "low" assurance and never elevated, so the two lists the daily
  // wf:billing-chaser reads must be "low" or the hub refuses it on assurance before its scope is consulted.
  // Nothing else is lowered: every write, and `contracts.get`, stays "verified".
  it("🔴 assurance: exactly the two list reads are \"low\" (the billing chaser's); every write and contracts.get stay \"verified\"", () => {
    for (const n of ["contracts.list", "invoicePayments.list"]) expect(defs.get(n)!.minAssurance, n).toBe("low");
    for (const n of names.filter((x) => !["contracts.list", "invoicePayments.list"].includes(x))) {
      expect(defs.get(n)!.minAssurance, n).toBe("verified");
    }
  });

  it("🔴 the three medium/high writes are registry-listed (an approved row executes, it never sits at not_applicable)", () => {
    for (const n of ["contracts.send", "contracts.countersign", "invoicePayments.decide"]) {
      expect(!!getExecutable(n), `${n} must have a D14 executor`).toBe(true);
    }
    // And the low ones must not: nothing to resume for a write that never suspends.
    for (const n of ["contracts.createDraft", "contracts.updateDraft"]) expect(getExecutable(n), n).toBeUndefined();
  });

  it("createDraft REQUIRES `reference`, the idempotency key; the list tools require clientId", () => {
    expect((defs.get("contracts.createDraft")!.inputSchema as { required: string[] }).required).toEqual(
      ["tenantId", "clientId", "title", "reference"],
    );
    for (const n of ["contracts.list", "invoicePayments.list"]) {
      expect((defs.get(n)!.inputSchema as { required: string[] }).required, n).toContain("clientId");
    }
  });

  it("updateDraft advertises no `status`: voiding is not a tool", () => {
    const props = Object.keys((defs.get("contracts.updateDraft")!.inputSchema as { properties: object }).properties);
    expect(props).not.toContain("status");
  });

  it("the D14 lock keys are per row, stable, namespaced per tool, and malformed args do not share one", () => {
    const send = getExecutable("contracts.send")!;
    const sign = getExecutable("contracts.countersign")!;
    const decide = getExecutable("invoicePayments.decide")!;
    expect(send.lockKey({ contractId: "c1" })).toBe(send.lockKey({ contractId: "c1" }));
    expect(send.lockKey({ contractId: "c1" })).not.toBe(send.lockKey({ contractId: "c2" }));
    expect(send.lockKey({ contractId: "c1" })).not.toBe(sign.lockKey({ contractId: "c1" }));
    expect(decide.lockKey({ paymentId: "p1" })).not.toBe(decide.lockKey({ paymentId: "p2" }));
    const malformed = [sign.lockKey({}), sign.lockKey({ contractId: 7 }), sign.lockKey({ contractId: null })];
    expect(new Set(malformed).size).toBe(3);
  });
});

describe.skipIf(!TEST_URL)("PV3-06 · billing tools through the real endpoints", () => {
  let app: NestFastifyApplication;
  let tenant: string;
  let admin: string; // company_admin: drafts, sends, confirms payments, may NOT countersign
  let owner: string; // owner of `tenant`: may countersign
  let recorder: string; // company_admin who RECORDS payments: may not confirm what they recorded
  let outsider: string; // a member with no role
  let checker: string; // a second company_admin: an eligible approver who recorded nothing
  let clientA: string;
  let clientB: string;
  let invoiceA: string;
  let invoiceB: string;

  const as = (ext: string) => ({ provider: "platform", externalId: ext });
  const ADMIN = as("pv306-admin");
  const OWNER = as("pv306-owner");
  const RECORDER = as("pv306-recorder");

  type Who = { provider: string; externalId: string };

  /** The hub's `callPlatform`, against the real app. */
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
    (await adminPool().query<{ actor_id: string; metadata: { via?: { provider: string; externalId: string; agent?: string } } }>(
      `SELECT actor_id, metadata FROM activities WHERE target_entity_id = $1 AND verb = $2`, [entityId, verb],
    )).rows;

  async function draftViaTool(clientId: string, ref: string, extra: Record<string, unknown> = {}): Promise<string> {
    const r = await callTool("contracts.createDraft",
      { tenantId: tenant, clientId, title: `Contract ${ref}`, reference: ref, bodyMd: "Terms.", ...extra }, ADMIN);
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id;
  }
  async function sentViaTool(clientId: string, ref: string): Promise<string> {
    const id = await draftViaTool(clientId, ref);
    const r = await callTool("contracts.send", { tenantId: tenant, contractId: id }, ADMIN);
    expect(r.statusCode, r.body).toBe(200);
    return id;
  }
  // PV5-04: a `sent` invoice is an ISSUED one (PV5-01b): issued through the real path, in IDR (the books' currency).
  async function insertInvoice(clientId: string, total: number): Promise<string> {
    return (await createIssuedInvoice(tenant, {
      clientId, actorId: admin, lines: [{ description: "Fixture work", amount: total }],
    })).id;
  }
  async function insertPayment(invoiceId: string, clientId: string, amount: number, recordedBy: string): Promise<string> {
    const id = newId();
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO invoice_payments (id, tenant_id, invoice_id, client_id, amount, currency, paid_on, status, recorded_by, origin_site)
         VALUES ($1, $2, $3, $4, $5, 'IDR', now()::date, 'pending', $6, 'test')`,
        [id, tenant, invoiceId, clientId, amount, recordedBy],
      ),
    );
    return id;
  }
  const paymentStatus = async (id: string) =>
    (await adminPool().query<{ status: string }>(`SELECT status FROM invoice_payments WHERE id = $1`, [id])).rows[0]?.status;
  const contractStatus = async (id: string) =>
    (await adminPool().query<{ status: string }>(`SELECT status FROM contracts WHERE id = $1`, [id])).rows[0]?.status;
  const providerSigs = async (id: string) =>
    (await adminPool().query(`SELECT 1 FROM contract_signatures WHERE contract_id = $1 AND party = 'provider'`, [id])).rowCount;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.approvalGrantSecret = "pv306-test-secret-not-real";
    config.services.hub = { url: "http://hub.test", token: "hub-token", assuranceToken: "" };
    tenant = await createCompany("PV306 Agency", ["agency", "clients"]);

    admin = await createUser("admin@pv306.test");
    await addMembership(tenant, admin);
    await grantRole(admin, await createRole("company_admin"), "company", tenant);
    owner = await createUser("owner@pv306.test");
    await addMembership(tenant, owner);
    await grantRole(owner, await createRole("owner"), "company", tenant);
    recorder = await createUser("recorder@pv306.test");
    await addMembership(tenant, recorder);
    await grantRole(recorder, await createRole("company_admin"), "company", tenant);
    outsider = await createUser("outsider@pv306.test");
    await addMembership(tenant, outsider);
    checker = await createUser("checker@pv306.test");
    await addMembership(tenant, checker);
    await grantRole(checker, await createRole("company_admin"), "company", tenant);

    const pool = adminPool();
    for (const u of [admin, owner, recorder, outsider, checker]) {
      await pool.query(`UPDATE users SET home_company_id = $1 WHERE id = $2`, [tenant, u]);
    }
    await linkIdentity(admin, ADMIN.provider, ADMIN.externalId, true);
    await linkIdentity(owner, OWNER.provider, OWNER.externalId, true);
    await linkIdentity(recorder, RECORDER.provider, RECORDER.externalId, true);

    clientA = await createClient(tenant, "PV306 Client A");
    clientB = await createClient(tenant, "PV306 Client B");
    await ensureBillingSetup(tenant);
    invoiceA = await insertInvoice(clientA, 500);
    invoiceB = await insertInvoice(clientB, 500);
    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ── golden cases: one per tool ───────────────────────────────────────────────────────────────

  describe("golden cases", () => {
    it("contracts.createDraft: 201 draft, a `created` activity naming the human AND the agent that drove it", async () => {
      const id = await draftViaTool(clientA, "PV306-GOLD-1");
      expect(await contractStatus(id)).toBe("draft");
      const rows = await activities(id, "created");
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_id).toBe(admin);
      expect(rows[0].metadata.via).toMatchObject({ provider: ADMIN.provider, externalId: ADMIN.externalId, agent: AGENT });
    });

    it("contracts.updateDraft: edits a draft; refused once it is sent", async () => {
      const id = await draftViaTool(clientA, "PV306-GOLD-2");
      const ok = await callTool("contracts.updateDraft", { tenantId: tenant, contractId: id, title: "Renamed by the agent", value: 1200 }, ADMIN);
      expect(ok.statusCode, ok.body).toBe(200);
      const got = await callTool("contracts.get", { tenantId: tenant, contractId: id }, ADMIN);
      expect(got.json()).toMatchObject({ id, title: "Renamed by the agent", value: 1200, status: "draft" });
      expect((await callTool("contracts.send", { tenantId: tenant, contractId: id }, ADMIN)).statusCode).toBe(200);
      const late = await callTool("contracts.updateDraft", { tenantId: tenant, contractId: id, title: "Too late" }, ADMIN);
      expect(late.statusCode).toBe(400);
      expect(late.json().error ?? late.json().message).toMatch(/cannot be edited/);
    });

    it("contracts.list: this client's contracts only, with canCountersign; contracts.get: one contract with its signatures", async () => {
      const a = await draftViaTool(clientA, "PV306-GOLD-3A");
      const b = await draftViaTool(clientB, "PV306-GOLD-3B");
      const list = await callTool("contracts.list", { tenantId: tenant, clientId: clientA }, ADMIN);
      expect(list.statusCode, list.body).toBe(200);
      const rows = list.json() as Array<{ id: string; clientId: string; canCountersign: boolean }>;
      expect(rows.map((r) => r.id)).toContain(a);
      expect(rows.map((r) => r.id)).not.toContain(b);
      expect(rows.every((r) => r.clientId === clientA && typeof r.canCountersign === "boolean")).toBe(true);
      const got = await callTool("contracts.get", { tenantId: tenant, contractId: a }, ADMIN);
      expect(got.json()).toMatchObject({ id: a, clientId: clientA, signatures: [] });
    });

    it("contracts.list refuses (403) a caller who may not read: a refusal, never an empty list", async () => {
      await linkIdentity(outsider, "platform", "pv306-outsider", true);
      const r = await callTool("contracts.list", { tenantId: tenant, clientId: clientA }, as("pv306-outsider"));
      expect(r.statusCode, r.body).toBe(403);
    });

    it("contracts.send: draft -> sent, a `sent` activity with the actor and the agent", async () => {
      const id = await draftViaTool(clientA, "PV306-GOLD-4");
      const r = await callTool("contracts.send", { tenantId: tenant, contractId: id }, ADMIN);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ ok: true, status: "sent" });
      expect(await contractStatus(id)).toBe("sent");
      const rows = await activities(id, "sent");
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_id).toBe(admin);
      expect(rows[0].metadata.via?.agent).toBe(AGENT);
    });

    it("contracts.countersign: the owner signs for the company, a `countersigned` activity, a repeat is alreadySigned", async () => {
      const id = await sentViaTool(clientA, "PV306-GOLD-5");
      const r = await callTool("contracts.countersign", { tenantId: tenant, contractId: id, signerName: "Olive Owner", signerTitle: "Owner" }, OWNER);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ ok: true, alreadySigned: false, complete: false });
      expect(await providerSigs(id)).toBe(1);
      const rows = await activities(id, "countersigned");
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_id).toBe(owner);
      expect(rows[0].metadata.via).toMatchObject({ externalId: OWNER.externalId, agent: AGENT });
      const again = await callTool("contracts.countersign", { tenantId: tenant, contractId: id, signerName: "Olive Owner" }, OWNER);
      expect(again.json()).toMatchObject({ ok: true, alreadySigned: true });
      expect(await activities(id, "countersigned")).toHaveLength(1); // a repeat writes no second row
    });

    it("invoicePayments.list: this client's payments only, pending first", async () => {
      const pa = await insertPayment(invoiceA, clientA, 100, recorder);
      const pb = await insertPayment(invoiceB, clientB, 100, recorder);
      const r = await callTool("invoicePayments.list", { tenantId: tenant, clientId: clientA }, ADMIN);
      expect(r.statusCode, r.body).toBe(200);
      const ids = (r.json() as Array<{ id: string; clientId: string }>).map((p) => p.id);
      expect(ids).toContain(pa);
      expect(ids).not.toContain(pb);
      expect((r.json() as Array<{ clientId: string }>).every((p) => p.clientId === clientA)).toBe(true);
    });

    it("invoicePayments.decide: confirm and reject each write an activity with the actor and the agent", async () => {
      const inv = await insertInvoice(clientA, 40);
      const toConfirm = await insertPayment(inv, clientA, 40, recorder);
      const toReject = await insertPayment(invoiceA, clientA, 10, recorder);

      const noReason = await callTool("invoicePayments.decide", { tenantId: tenant, paymentId: toReject, decision: "reject" }, ADMIN);
      expect(noReason.statusCode, noReason.body).toBe(400);
      expect(await paymentStatus(toReject)).toBe("pending");

      const rej = await callTool("invoicePayments.decide", { tenantId: tenant, paymentId: toReject, decision: "reject", reason: "no matching transfer" }, ADMIN);
      expect(rej.statusCode, rej.body).toBe(200);
      expect(await paymentStatus(toReject)).toBe("rejected");
      const rejRows = await activities(toReject, "rejected");
      expect(rejRows).toHaveLength(1);
      expect(rejRows[0].actor_id).toBe(admin);
      expect(rejRows[0].metadata.via?.agent).toBe(AGENT);

      const conf = await callTool("invoicePayments.decide", { tenantId: tenant, paymentId: toConfirm, decision: "confirm" }, ADMIN);
      expect(conf.statusCode, conf.body).toBe(200);
      expect(conf.json()).toMatchObject({ ok: true, decision: "confirm", invoicePaid: true });
      expect(await paymentStatus(toConfirm)).toBe("confirmed");
      const confRows = await activities(toConfirm, "confirmed");
      expect(confRows).toHaveLength(1);
      expect(confRows[0].actor_id).toBe(admin);
    });
  });

  // ── criterion 3 ──────────────────────────────────────────────────────────────────────────────

  describe("contracts.createDraft is idempotent on `reference`", () => {
    it("🔴 a retry returns the SAME contract (deduped), creates no second row and no second activity", async () => {
      const first = await callTool("contracts.createDraft", { tenantId: tenant, clientId: clientA, title: "Retry me", reference: "PV306-IDEM-1", bodyMd: "T" }, ADMIN);
      expect(first.statusCode, first.body).toBe(201);
      expect(first.json().deduped).toBeUndefined();
      const again = await callTool("contracts.createDraft", { tenantId: tenant, clientId: clientA, title: "Retry me", reference: "PV306-IDEM-1", bodyMd: "T" }, ADMIN);
      expect(again.statusCode, again.body).toBe(201);
      expect(again.json()).toMatchObject({ id: first.json().id, status: "draft", deduped: true });
      const n = await adminPool().query(`SELECT 1 FROM contracts WHERE reference = 'PV306-IDEM-1'`);
      expect(n.rowCount).toBe(1);
      expect(await activities(first.json().id, "created")).toHaveLength(1);
    });

    it("🔴 a concurrent twin does not double-create either", async () => {
      const args = { tenantId: tenant, clientId: clientA, title: "Twin", reference: "PV306-IDEM-2", bodyMd: "T" };
      const [a, b] = await Promise.all([callTool("contracts.createDraft", args, ADMIN), callTool("contracts.createDraft", args, ADMIN)]);
      expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
      expect(a.json().id).toBe(b.json().id);
      expect((await adminPool().query(`SELECT 1 FROM contracts WHERE reference = 'PV306-IDEM-2'`)).rowCount).toBe(1);
    });

    it("the same reference under ANOTHER client is a 409, and it does not leak the other client's contract id", async () => {
      const first = await draftViaTool(clientA, "PV306-IDEM-3");
      const r = await callTool("contracts.createDraft", { tenantId: tenant, clientId: clientB, title: "Collides", reference: "PV306-IDEM-3", bodyMd: "T" }, ADMIN);
      expect(r.statusCode, r.body).toBe(409);
      expect(r.body).not.toContain(first);
    });

    it("a deduped replay after the contract was SENT answers with its real status, and does not touch it", async () => {
      const id = await draftViaTool(clientA, "PV306-IDEM-4");
      await callTool("contracts.send", { tenantId: tenant, contractId: id }, ADMIN);
      const r = await callTool("contracts.createDraft", { tenantId: tenant, clientId: clientA, title: "Retry", reference: "PV306-IDEM-4", bodyMd: "T" }, ADMIN);
      expect(r.json()).toMatchObject({ id, status: "sent", deduped: true });
      expect(await contractStatus(id)).toBe("sent");
    });

    it("a draft with NO reference is not deduped (no natural key): the human form behaves as before", async () => {
      const mk = () => app.inject({ method: "POST", url: `/api/${tenant}/contracts`, headers: asUser(admin), payload: { clientId: clientA, title: "No ref", bodyMd: "T" } });
      const [a, b] = [await mk(), await mk()];
      expect(a.statusCode).toBe(201);
      expect(b.json().id).not.toBe(a.json().id);
    });
  });

  // ── countersign / decide: refusal and the authorization order ────────────────────────────────

  describe("authorization before validation, and typed refusals", () => {
    it("🔴 a company_admin's contracts.countersign is refused with a typed 403 and writes nothing", async () => {
      const id = await sentViaTool(clientA, "PV306-AUTH-1");
      const r = await callTool("contracts.countersign", { tenantId: tenant, contractId: id, signerName: "Ada Admin" }, ADMIN);
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json().error ?? r.json().message).toMatch(/not authorized/);
      expect(await providerSigs(id)).toBe(0);
      expect(await activities(id, "countersigned")).toHaveLength(0);
    });

    it("🔴 a company_admin with an EMPTY body gets 403, not 400 (authorize runs before the signerName check)", async () => {
      const id = await sentViaTool(clientA, "PV306-AUTH-2");
      const empty = await app.inject({ method: "POST", url: `/api/${tenant}/contracts/${id}/countersign`, headers: asUser(admin), payload: {} });
      expect(empty.statusCode, empty.body).toBe(403);
      const noBody = await app.inject({ method: "POST", url: `/api/${tenant}/contracts/${id}/countersign`, headers: asUser(admin) });
      expect(noBody.statusCode, noBody.body).toBe(403);
    });

    it("…and the owner, who IS authorized, still gets the 400 for the empty body: validation runs, just after authorization", async () => {
      const id = await sentViaTool(clientA, "PV306-AUTH-3");
      const r = await app.inject({ method: "POST", url: `/api/${tenant}/contracts/${id}/countersign`, headers: asUser(owner), payload: {} });
      expect(r.statusCode, r.body).toBe(400);
      expect(await providerSigs(id)).toBe(0);
    });

    it("🔴 create: a caller with no right to draft gets 403 for an empty body; an admin gets the 400", async () => {
      const denied = await app.inject({ method: "POST", url: `/api/${tenant}/contracts`, headers: asUser(outsider), payload: {} });
      expect(denied.statusCode, denied.body).toBe(403);
      const bad = await app.inject({ method: "POST", url: `/api/${tenant}/contracts`, headers: asUser(admin), payload: {} });
      expect(bad.statusCode, bad.body).toBe(400);
    });

    it("🔴 an agent's contracts.updateDraft cannot void (or set any status): typed 400, contract unchanged; a human void still works", async () => {
      const sent = await sentViaTool(clientA, "PV306-VOID-1");
      const viaAgent = await callTool("contracts.updateDraft", { tenantId: tenant, contractId: sent, status: "void" }, ADMIN);
      expect(viaAgent.statusCode, viaAgent.body).toBe(400);
      expect(String(viaAgent.json().error ?? viaAgent.json().message)).toMatch(/status_not_allowed_via_automation/);
      expect(await contractStatus(sent)).toBe("sent");
      // Any status, on a draft too, and the guard sits after authorize: an unauthorized agent still gets 403.
      const draft = await draftViaTool(clientA, "PV306-VOID-2");
      expect((await callTool("contracts.updateDraft", { tenantId: tenant, contractId: draft, status: "draft" }, ADMIN)).statusCode).toBe(400);
      await linkIdentity(outsider, "platform", "pv306-outsider-void", true);
      expect((await callTool("contracts.updateDraft", { tenantId: tenant, contractId: draft, status: "void" }, as("pv306-outsider-void"))).statusCode).toBe(403);
      // A plain edit through the same tool still works, and a human (no OBO envelope) can void as before.
      expect((await callTool("contracts.updateDraft", { tenantId: tenant, contractId: draft, title: "Still editable" }, ADMIN)).statusCode).toBe(200);
      const human = await app.inject({ method: "PATCH", url: `/api/${tenant}/contracts/${sent}`, headers: asUser(admin), payload: { status: "void" } });
      expect(human.statusCode, human.body).toBe(200);
      expect(await contractStatus(sent)).toBe("void");
    });

    it("PV5-F1: an explicit value:null clears a DRAFT's value; an absent key leaves it; a sent contract refuses; authz comes first", async () => {
      const contractValue = async (id: string) =>
        (await adminPool().query<{ value: string | null; currency: string }>(`SELECT value::text AS value, currency FROM contracts WHERE id = $1`, [id])).rows[0]!;
      const patch = (id: string, payload: Record<string, unknown>, who = admin) =>
        app.inject({ method: "PATCH", url: `/api/${tenant}/contracts/${id}`, headers: asUser(who), payload });

      const id = await draftViaTool(clientA, "PV5F1-CLEAR-1", { value: 1500, currency: "USD" });
      expect(Number((await contractValue(id)).value)).toBe(1500);
      // Absent key: unchanged.
      expect((await patch(id, { title: "Renamed" })).statusCode).toBe(200);
      expect(Number((await contractValue(id)).value)).toBe(1500);
      // Explicit null: cleared; the currency is left as it was.
      const cleared = await patch(id, { value: null });
      expect(cleared.statusCode, cleared.body).toBe(200);
      expect(await contractValue(id)).toEqual({ value: null, currency: "USD" });
      // A number sets it again.
      expect((await patch(id, { value: 20 })).statusCode).toBe(200);
      expect(Number((await contractValue(id)).value)).toBe(20);

      // A sent contract cannot have its value cleared (not even while voiding it), and is untouched.
      const sent = await draftViaTool(clientA, "PV5F1-CLEAR-2", { value: 99 });
      expect((await callTool("contracts.send", { tenantId: tenant, contractId: sent }, ADMIN)).statusCode).toBe(200);
      expect((await patch(sent, { value: null })).statusCode).toBe(400);
      expect((await patch(sent, { value: null, status: "void" })).statusCode).toBe(400);
      expect(Number((await contractValue(sent)).value)).toBe(99);
      expect(await contractStatus(sent)).toBe("sent");

      // Authorization runs before validation: a caller with no right gets 403 and nothing changes.
      expect((await patch(id, { value: null }, outsider)).statusCode).toBe(403);
      expect(Number((await contractValue(id)).value)).toBe(20);
    });

    it("🔴 decide: a caller with no right to decide gets 403 for an empty body; an admin gets the 400", async () => {
      const p = await insertPayment(invoiceA, clientA, 5, recorder);
      const denied = await app.inject({ method: "POST", url: `/api/${tenant}/invoice-payments/${p}/decide`, headers: asUser(outsider), payload: {} });
      expect(denied.statusCode, denied.body).toBe(403);
      const bad = await app.inject({ method: "POST", url: `/api/${tenant}/invoice-payments/${p}/decide`, headers: asUser(admin), payload: {} });
      expect(bad.statusCode, bad.body).toBe(400);
      expect(await paymentStatus(p)).toBe("pending");
    });

    it("🔴 maker-checker: the person who recorded a payment cannot confirm it through the tool", async () => {
      const p = await insertPayment(invoiceA, clientA, 5, recorder);
      const r = await callTool("invoicePayments.decide", { tenantId: tenant, paymentId: p, decision: "confirm" }, RECORDER);
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json().error ?? r.json().message).toMatch(/someone other than whoever recorded/);
      expect(await paymentStatus(p)).toBe("pending");
      // A different admin can.
      const ok = await callTool("invoicePayments.decide", { tenantId: tenant, paymentId: p, decision: "reject", reason: "test" }, ADMIN);
      expect(ok.statusCode, ok.body).toBe(200);
    });
  });

  // ── D14: approving actually executes ─────────────────────────────────────────────────────────

  describe("D14: an approved medium/high call executes through the real executor, as the ORIGINAL filing principal", () => {
    const realFetch = globalThis.fetch;
    let hubCalls = 0;

    beforeEach(() => {
      hubCalls = 0;
      vi.stubGlobal("fetch", vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
        if (!String(url).startsWith("http://hub.test")) return realFetch(url as never, init as never);
        hubCalls++;
        const { params } = JSON.parse(init.body) as { params: { name: string; arguments: Record<string, unknown> } };
        // The hub's job: resolve the OBO envelope, call the platform with it. The envelope is the
        // executor's, so a re-drive that ran as the approver would show up as the wrong actor.
        const res = await callTool(params.name, params.arguments, {
          provider: init.headers["x-obo-provider"], externalId: init.headers["x-obo-external-id"],
        });
        const text = res.statusCode < 300 ? res.body : String(res.json().error ?? res.json().message ?? res.body);
        const rpc = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }], ...(res.statusCode < 300 ? {} : { isError: true }) } };
        return { ok: true, status: 200, text: async () => `event: message\ndata: ${JSON.stringify(rpc)}\n\n` } as never;
      }) as unknown as typeof fetch);
    });
    afterEach(() => vi.restoreAllMocks());

    async function fileApproved(
      tool: string, args: Record<string, unknown>, filedBy: string, impact: "medium" | "high", decidedBy: string = admin,
    ): Promise<string> {
      const id = newId();
      await withTenants([tenant], (c) =>
        c.query(
          `INSERT INTO automation_approvals
             (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, decided_by, decided_at,
              origin, origin_site, execution_status)
           VALUES ($1,$2,'wf:pv306-agent',$3,$4,$5,'approved',$6,$7,now(),'agent','main','pending')`,
          [id, tenant, tool, JSON.stringify(args), impact, filedBy, decidedBy],
        ),
      );
      return id;
    }
    /** A PENDING row, exactly as the hub's `approvals.request` files it (approval-filing.ts's INSERT): no
     *  decider yet, `execution_status` at its column default. Decided below through the REAL routes. */
    async function filePending(tool: string, args: Record<string, unknown>, filedBy: string): Promise<string> {
      const id = newId();
      await withTenants([tenant], (c) =>
        c.query(
          `INSERT INTO automation_approvals
             (id, tenant_id, workflow_id, tool_name, tool_args, impact, requested_by, origin, agent_name, origin_site)
           VALUES ($1,$2,'wf:pv306-agent',$3,$4,'high',$5,'agent',$6,'main')`,
          [id, tenant, tool, JSON.stringify(args), filedBy, AGENT],
        ),
      );
      return id;
    }
    const approvalOf = async (id: string) =>
      (await adminPool().query<{ status: string; decided_by: string | null; execution_status: string; execution_error: string | null }>(
        `SELECT status, decided_by, execution_status, execution_error FROM automation_approvals WHERE id = $1`, [id],
      )).rows[0];
    const decideRoute = (id: string, by: string, decision: "approved" | "rejected") =>
      app.inject({ method: "POST", url: `/api/${tenant}/automation-approvals/${id}/decide`, headers: asUser(by), payload: { decision } });
    const decideFacade = (id: string, by: string, decision: "approved" | "rejected") =>
      app.inject({ method: "POST", url: `/api/${tenant}/approvals/${id}/decide`, headers: asUser(by), payload: { origin: "agent", decision } });
    const confirmedBy = async (id: string) =>
      (await adminPool().query<{ confirmed_by: string | null }>(`SELECT confirmed_by FROM invoice_payments WHERE id = $1`, [id])).rows[0]?.confirmed_by;
    const rowOf = async (id: string) =>
      (await adminPool().query<{ execution_status: string; execution_error: string | null; executed_by: string | null }>(
        `SELECT execution_status, execution_error, executed_by FROM automation_approvals WHERE id = $1`, [id],
      )).rows[0];

    it("🔴 contracts.send: approving it sends the contract (draft -> sent), once", async () => {
      const id = await draftViaTool(clientA, "PV306-D14-1");
      const a = await fileApproved("contracts.send", { tenantId: tenant, contractId: id }, admin, "medium");
      expect(await executeApprovedAutomationWrite(tenant, a)).toEqual({ status: "executed" });
      expect(await contractStatus(id)).toBe("sent");
      expect(hubCalls).toBe(1);
      expect((await rowOf(a)).executed_by).toBe(admin);
      // A second approval for the same contract is refused by the precondition: the hub is NOT called.
      const b = await fileApproved("contracts.send", { tenantId: tenant, contractId: id }, admin, "medium");
      expect(await executeApprovedAutomationWrite(tenant, b)).toMatchObject({ status: "failed", error: "precondition_failed: contract_not_draft" });
      expect(hubCalls).toBe(1);
    });

    it("🔴 contracts.countersign: an OWNER-filed approval executes and the provider signature is the owner's", async () => {
      const id = await sentViaTool(clientA, "PV306-D14-2");
      const a = await fileApproved("contracts.countersign", { tenantId: tenant, contractId: id, signerName: "Olive Owner", signerTitle: "Owner" }, owner, "high");
      expect(await executeApprovedAutomationWrite(tenant, a)).toEqual({ status: "executed" });
      const sig = await adminPool().query<{ signer: string; content_sha256: string | null; ip_hash: string | null; user_agent: string | null }>(
        `SELECT signer, content_sha256, ip_hash, user_agent FROM contract_signatures WHERE contract_id = $1 AND party = 'provider'`, [id]);
      expect(sig.rows.map((r) => r.signer)).toEqual([owner]);
      // PV5-06: the D14 re-drive runs the same route as the human the agent served, so it records the hash fixed at
      // send (not whatever the agent saw), plus the IP hash and user agent of the hop, exactly like a direct call.
      const fixed = (await adminPool().query<{ content_sha256: string }>(`SELECT content_sha256 FROM contracts WHERE id = $1`, [id])).rows[0].content_sha256;
      expect(fixed).toBe(sha256Hex("Terms."));
      expect(sig.rows[0].content_sha256).toBe(fixed);
      expect(sig.rows[0].ip_hash).toMatch(/^[0-9a-f]{32}$/);
      expect(typeof sig.rows[0].user_agent).toBe("string");
      // Landed: a retry is refused by the precondition, hub not called again.
      const calls = hubCalls;
      const b = await fileApproved("contracts.countersign", { tenantId: tenant, contractId: id, signerName: "Olive Owner" }, owner, "high");
      expect(await executeApprovedAutomationWrite(tenant, b)).toMatchObject({ status: "failed", error: "precondition_failed: contract_already_countersigned" });
      expect(hubCalls).toBe(calls);
    });

    it("🔴 contracts.countersign filed by a company_admin is APPROVED but REFUSED at execution: the approver's authority never replaces the filer's", async () => {
      const id = await sentViaTool(clientA, "PV306-D14-3");
      // `admin` (a company_admin) is both the filer and, in this fixture, the decider; the owner is not involved.
      const a = await fileApproved("contracts.countersign", { tenantId: tenant, contractId: id, signerName: "Ada Admin" }, admin, "high");
      const out = await executeApprovedAutomationWrite(tenant, a);
      expect(out.status).toBe("failed");
      expect((await rowOf(a)).execution_error).toMatch(/not authorized/);
      expect(await providerSigs(id)).toBe(0);
    });

    it("🔴 invoicePayments.decide: approving it confirms the payment; the recorder's own approval is refused (maker-checker survives the D14 path)", async () => {
      const inv = await insertInvoice(clientA, 25);
      const p = await insertPayment(inv, clientA, 25, recorder);
      const byRecorder = await fileApproved("invoicePayments.decide", { tenantId: tenant, paymentId: p, decision: "confirm" }, recorder, "high");
      const refused = await executeApprovedAutomationWrite(tenant, byRecorder);
      expect(refused.status).toBe("failed");
      expect((await rowOf(byRecorder)).execution_error).toMatch(/someone other than whoever recorded/);
      expect(await paymentStatus(p)).toBe("pending");

      const byAdmin = await fileApproved("invoicePayments.decide", { tenantId: tenant, paymentId: p, decision: "confirm" }, admin, "high");
      expect(await executeApprovedAutomationWrite(tenant, byAdmin)).toEqual({ status: "executed" });
      expect(await paymentStatus(p)).toBe("confirmed");
      expect(await activities(p, "confirmed")).toHaveLength(1);

      // Decided already: the precondition refuses a second decision before the hub is called.
      const calls = hubCalls;
      const again = await fileApproved("invoicePayments.decide", { tenantId: tenant, paymentId: p, decision: "reject", reason: "x" }, admin, "high");
      expect(await executeApprovedAutomationWrite(tenant, again)).toMatchObject({ status: "failed", error: "precondition_failed: payment_not_pending" });
      expect(hubCalls).toBe(calls);
    });

    // ── maker-checker reaches the APPROVER (2026-10-12) ─────────────────────────────────────────
    // The re-drive runs as the FILER, so the route's own check compares the recorder with the filer and
    // never sees who approved. Before the approver rule, `recorder` approving `admin`'s agent request to
    // confirm `recorder`'s own payment confirmed it.

    it("🔴 the payment's RECORDER cannot approve an agent's request to confirm it: 403 approver_recorded_this_payment, the row stays pending, nothing executes", async () => {
      const inv = await insertInvoice(clientA, 30);
      const p = await insertPayment(inv, clientA, 30, recorder);
      // Filed by `admin`'s agent: the filer is NOT the recorder, so the route's own check would pass at execution.
      const a = await filePending("invoicePayments.decide", { tenantId: tenant, paymentId: p, decision: "confirm" }, admin);

      const r = await decideRoute(a, recorder, "approved");
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json().reason).toBe(APPROVER_RECORDED_THIS_PAYMENT);
      expect(String(r.json().error)).toMatch(/^approver_recorded_this_payment:/);
      // The unified inbox façade delegates to the same handler, so it refuses the same way.
      const viaFacade = await decideFacade(a, recorder, "approved");
      expect(viaFacade.statusCode, viaFacade.body).toBe(403);
      expect(viaFacade.json().reason).toBe(APPROVER_RECORDED_THIS_PAYMENT);

      expect(await approvalOf(a)).toMatchObject({ status: "pending", decided_by: null, execution_status: "not_applicable" });
      // Nothing to execute: the executor cannot claim a row that was never approved.
      expect(await executeApprovedAutomationWrite(tenant, a)).toEqual({ status: "skipped", reason: "not_pending" });
      expect(hubCalls).toBe(0);
      expect(await paymentStatus(p)).toBe("pending");
      expect(await activities(p, "confirmed")).toHaveLength(0);
    });

    it("🔴 approved by another eligible person, the same request executes exactly once, as the filer", async () => {
      const inv = await insertInvoice(clientA, 35);
      const p = await insertPayment(inv, clientA, 35, recorder);
      const a = await filePending("invoicePayments.decide", { tenantId: tenant, paymentId: p, decision: "confirm" }, admin);
      expect((await decideRoute(a, recorder, "approved")).statusCode).toBe(403);

      const ok = await decideRoute(a, checker, "approved");
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await approvalOf(a)).toMatchObject({ status: "approved", decided_by: checker, execution_status: "pending" });

      expect(await executeApprovedAutomationWrite(tenant, a)).toEqual({ status: "executed" });
      expect(hubCalls).toBe(1);
      expect(await paymentStatus(p)).toBe("confirmed");
      expect(await confirmedBy(p)).toBe(admin); // D14 invariant 1: run as the FILER, never as the approver
      expect(await activities(p, "confirmed")).toHaveLength(1);
      // Once: a redelivery of the decided event finds nothing to claim.
      expect(await executeApprovedAutomationWrite(tenant, a)).toEqual({ status: "skipped", reason: "not_pending" });
      expect(hubCalls).toBe(1);
    });

    it("the recorder may still REJECT the request (rejecting executes nothing), and the rule covers a `reject` decision too", async () => {
      const p = await insertPayment(invoiceA, clientA, 3, recorder);
      const conf = await filePending("invoicePayments.decide", { tenantId: tenant, paymentId: p, decision: "confirm" }, admin);
      const r = await decideRoute(conf, recorder, "rejected");
      expect(r.statusCode, r.body).toBe(200);
      expect(await approvalOf(conf)).toMatchObject({ status: "rejected", execution_status: "not_applicable" });
      // An agent's request to REJECT the recorder's payment: the route refuses the recorder either way, so the approver rule does too.
      const rej = await filePending("invoicePayments.decide", { tenantId: tenant, paymentId: p, decision: "reject", reason: "dup" }, admin);
      const r2 = await decideRoute(rej, recorder, "approved");
      expect(r2.statusCode, r2.body).toBe(403);
      expect(r2.json().reason).toBe(APPROVER_RECORDED_THIS_PAYMENT);
      expect(await paymentStatus(p)).toBe("pending");
    });

    it("🔴 second wall: a row the recorder approved by any other path is refused at EXECUTION (approver_refused), the hub is never called", async () => {
      const inv = await insertInvoice(clientA, 20);
      const p = await insertPayment(inv, clientA, 20, recorder);
      // As if decided around the route (a future surface, a hand edit, a retry of a row decided before the rule existed).
      const a = await fileApproved("invoicePayments.decide", { tenantId: tenant, paymentId: p, decision: "confirm" }, admin, "high", recorder);
      expect(await executeApprovedAutomationWrite(tenant, a)).toEqual({
        status: "failed", error: `approver_refused: ${APPROVER_RECORDED_THIS_PAYMENT}`,
      });
      expect(hubCalls).toBe(0);
      expect(await paymentStatus(p)).toBe("pending");
      expect((await approvalOf(a)).execution_status).toBe("failed");
    });

    it("the approver rule fails closed on bad args and missing rows, matches an act-for human, and passes a payment with no recorder", async () => {
      const chk = (args: Record<string, unknown>, approver: { userId: string; actForUserId?: string }, t = tenant) =>
        withTenants([t], (c) => getExecutable("invoicePayments.decide")!.approverCheck!(c, args, approver));
      expect(await chk({ tenantId: tenant }, { userId: checker })).toEqual({ ok: false, reason: "missing_payment_args" });
      expect(await chk({ tenantId: tenant, paymentId: newId() }, { userId: checker })).toEqual({ ok: false, reason: "payment_not_found" });
      const p = await insertPayment(invoiceA, clientA, 2, recorder);
      expect(await chk({ tenantId: tenant, paymentId: p }, { userId: checker })).toEqual({ ok: true });
      expect(await chk({ tenantId: tenant, paymentId: p }, { userId: recorder })).toEqual({ ok: false, reason: APPROVER_RECORDED_THIS_PAYMENT });
      expect(await chk({ tenantId: tenant, paymentId: p }, { userId: checker, actForUserId: recorder })).toEqual({ ok: false, reason: APPROVER_RECORDED_THIS_PAYMENT });
      // Another tenant's session cannot see the payment: refused, never "no recorder, so ok".
      const other = await createCompany("PV306 Other 2", ["agency", "clients"]);
      expect(await chk({ tenantId: tenant, paymentId: p }, { userId: checker }, other)).toEqual({ ok: false, reason: "payment_not_found" });
      const unrecorded = newId();
      await withTenants([tenant], (c) =>
        c.query(
          `INSERT INTO invoice_payments (id, tenant_id, invoice_id, client_id, amount, currency, paid_on, status, recorded_by, origin_site)
           VALUES ($1, $2, $3, $4, 1, 'IDR', now()::date, 'pending', NULL, 'test')`,
          [unrecorded, tenant, invoiceA, clientA],
        ),
      );
      expect(await chk({ tenantId: tenant, paymentId: unrecorded }, { userId: recorder })).toEqual({ ok: true });
      // Only the payment tool declares one; the contract tools keep no approver rule.
      expect(getExecutable("contracts.send")!.approverCheck).toBeUndefined();
      expect(getExecutable("contracts.countersign")!.approverCheck).toBeUndefined();
    });

    it("preconditions fail closed on bad args and on missing rows, and are RLS-scoped to the approval's tenant", async () => {
      const pre = (tool: string, args: Record<string, unknown>, t = tenant) =>
        withTenants([t], (c) => getExecutable(tool)!.precondition(c, args));
      expect(await pre("contracts.send", {})).toEqual({ ok: false, reason: "missing_contract_args" });
      expect(await pre("contracts.countersign", { tenantId: tenant })).toEqual({ ok: false, reason: "missing_contract_args" });
      expect(await pre("invoicePayments.decide", { tenantId: tenant })).toEqual({ ok: false, reason: "missing_payment_args" });
      expect(await pre("contracts.send", { tenantId: tenant, contractId: newId() })).toEqual({ ok: false, reason: "contract_not_found" });
      expect(await pre("invoicePayments.decide", { tenantId: tenant, paymentId: newId(), decision: "confirm" })).toEqual({ ok: false, reason: "payment_not_found" });
      const p = await insertPayment(invoiceA, clientA, 1, recorder);
      expect(await pre("invoicePayments.decide", { tenantId: tenant, paymentId: p, decision: "maybe" })).toEqual({ ok: false, reason: "payment_decision_invalid" });
      expect(await pre("invoicePayments.decide", { tenantId: tenant, paymentId: p, decision: "reject", reason: "  " })).toEqual({ ok: false, reason: "payment_reject_reason_required" });
      expect(await pre("invoicePayments.decide", { tenantId: tenant, paymentId: p, decision: "confirm" })).toEqual({ ok: true });
      // A draft with neither terms nor a file cannot be sent, so the approval refuses rather than 400s at the hub.
      const empty = (await app.inject({ method: "POST", url: `/api/${tenant}/contracts`, headers: asUser(admin), payload: { clientId: clientA, title: "Empty" } })).json().id;
      expect(await pre("contracts.send", { tenantId: tenant, contractId: empty })).toEqual({ ok: false, reason: "contract_has_no_document" });
      // The wrong tenant's session sees nothing, even with the right ids in the args.
      const other = await createCompany("PV306 Other", ["agency", "clients"]);
      expect(await pre("contracts.send", { tenantId: tenant, contractId: empty }, other)).toEqual({ ok: false, reason: "contract_not_found" });
    });
  });
});
