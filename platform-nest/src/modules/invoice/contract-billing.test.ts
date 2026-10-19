// DW-10f-3a — invoices FROM THE SCHEDULE (FRONTEND-BFF-CONTRACT §61.5, §61.6, §61.10; PERMISSION-CONTRACT §51; rulings
// DW-D45, DW-D48). Drives the real routes (GET invoices/billable-instalments, POST invoices with both sources, approve,
// service line, issue, PATCH void ("Cancel draft"), POST …/void, issue-readiness, the portal reads, the two new tools)
// against real RLS, a live Cerbos and the migrations, with the claim guard (PD611) and the un-void guard (PD614) under
// them.
//
// ── THE TEETH ───────────────────────────────────────────────────────────────────────────────────
//  - drop `AND invoice_id IS NULL` / the rowCount check from the claim -> the race test sees two invoices for one
//    instalment, or the guard's PD611 surfaces as 500 -> fails.
//  - validate the hourly body before authorize                       -> "403 before 400" fails.
//  - fight the release trigger in PATCH void                        -> releasedInstalments / the re-draft fails.
//  - leave the instalment keys on the portal invoice lines          -> the portal line test fails.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { newId, withGlobal, withTenants } from "../../db";
import { buildApp } from "../../main";
import { resetModules } from "../registry";
import { resetCoreRollupProviders } from "../../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, linkIdentity } from "../../testing/fixtures";
import { insertSentContractWithSchedule, type FixtureInstalment } from "../../testing/contract-fixtures";
import { ensureBillingSetup } from "../../seed/billing-setup";
import { allCoreTools } from "../../core/core-tools";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const FUTURE = "2099-12-31";
const AGENT = "agent:billing";
const defs = new Map(allCoreTools().map((t) => [t.name, t]));

describe.skipIf(!TEST_URL)("DW-10f-3a · invoices from the schedule (HTTP)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let co2: string;
  let adminA: string;   // company_admin: drafts and issues
  let adminB: string;   // company_admin: approves (maker-checker)
  let manager: string;
  let member: string;
  let otherAdmin: string; // company_admin of the SECOND company only
  let bot: string;      // company_admin, users.kind = 'bot'
  let invoiceReader: string; // custom role: invoice.read only (no contract read)
  let signerA: string;  // client A's portal signer
  let clientA: string;
  let clientB: string;
  let seq = 0;
  const ADMIN_OBO = { provider: "platform", externalId: "dw10f3a-admin" };

  const req = (method: "GET" | "POST" | "PATCH", url: string, as: string, payload?: unknown) =>
    app.inject({ method, url, headers: asUser(as), ...(payload !== undefined ? { payload: payload as object } : {}) });
  const draftFrom = (body: Record<string, unknown>, as = adminA) =>
    req("POST", `/api/${co}/invoices`, as, { source: "instalments", ...body });
  const billable = (q: string, as = adminA) => req("GET", `/api/${co}/invoices/billable-instalments${q}`, as);
  const claimOf = async (instalmentId: string) =>
    (await adminPool().query<{ invoice_id: string | null; claimed_at: Date | null }>(
      `SELECT invoice_id, claimed_at FROM contract_instalments WHERE id = $1`, [instalmentId],
    )).rows[0];
  const invoiceCountFor = async (clientId: string) =>
    Number((await adminPool().query(`SELECT count(*)::int AS n FROM invoices WHERE client_id = $1`, [clientId])).rows[0].n);
  const blockerCodes = async (invoiceId: string) =>
    ((await req("GET", `/api/${co}/invoices/${invoiceId}/issue-readiness`, adminA)).json().blockers as Array<{ code: string }>).map((b) => b.code);

  /** A signed contract with a schedule, the way send + both signatures leave it. */
  async function signedContract(
    clientId: string, value: string, instalments: FixtureInstalment[], o: { currency?: string; cols?: Record<string, unknown> } = {},
  ): Promise<{ contractId: string; ids: string[] }> {
    const made = await withTenants([co], (c) => insertSentContractWithSchedule(c, {
      tenantId: co, clientId, value, currency: o.currency, instalments,
      cols: { title: `DW10f-3a agreement ${++seq}`, reference: `D3A-${seq}`, ...(o.cols ?? {}) },
    }));
    await adminPool().query(`UPDATE contracts SET status = 'signed', signed_at = now() WHERE id = $1`, [made.contractId]);
    return { contractId: made.contractId, ids: made.instalmentIds };
  }
  const FIFTY: FixtureInstalment[] = [
    { label: "Deposit (50%)", amount: "30000000", due: "on_signing" },
    { label: "Balance (50%)", amount: "30000000", due: FUTURE },
  ];

  /** The hub's callPlatform against the real app (the PV3-06 suites' shape). */
  function callTool(name: string, args: Record<string, unknown>) {
    const def = defs.get(name);
    if (!def) throw new Error(`no such tool: ${name}`);
    const used = new Set<string>();
    const url = def.pathTemplate!.replace(/:([A-Za-z0-9_]+)/g, (_m, n: string) => {
      used.add(n);
      return encodeURIComponent(String(args[n]));
    });
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) if (!used.has(k)) rest[k] = v;
    const method = def.method ?? "GET";
    return app.inject({
      method: method as "GET" | "POST",
      url,
      headers: { ...svc, "x-obo-provider": ADMIN_OBO.provider, "x-obo-external-id": ADMIN_OBO.externalId, "x-obo-agent": AGENT },
      ...(method !== "GET" ? { payload: rest } : {}),
    });
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.approvalGrantSecret = "dw10f3a-test-secret-not-real";
    config.services.hub = { url: "http://hub.test", token: "hub-token", assuranceToken: "" };
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("DW10f Billing Agency", ["invoice", "clients"]);
    co2 = await createCompany("DW10f Second Company", ["invoice", "clients"]);
    adminA = await createUser("admin-a@dw10f3a.test");
    adminB = await createUser("admin-b@dw10f3a.test");
    manager = await createUser("manager@dw10f3a.test");
    member = await createUser("member@dw10f3a.test");
    otherAdmin = await createUser("other-admin@dw10f3a.test");
    bot = await createUser("bot@dw10f3a.test");
    invoiceReader = await createUser("reader@dw10f3a.test");
    signerA = await createUser("signer-a@dw10f3a-client.test");
    const companyAdmin = await createRole("company_admin");
    for (const u of [adminA, adminB, manager, member, bot, invoiceReader, signerA]) await addMembership(co, u);
    await addMembership(co2, otherAdmin);
    for (const u of [adminA, adminB, bot]) await grantRole(u, companyAdmin, "company", co);
    await grantRole(otherAdmin, companyAdmin, "company", co2);
    await grantRole(manager, await createRole("manager"), "company", co);
    await grantRole(member, await createRole("member"), "company", co);
    const readerRole = newId();
    await withGlobal(async (c) => {
      await c.query(`INSERT INTO roles (id, company_id, name) VALUES ($1, $2, 'dw10f_invoice_reader')`, [readerRole, co]);
      const ins = await c.query(
        `INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key = 'invoice.read'`, [readerRole],
      );
      expect(ins.rowCount).toBe(1);
    });
    await grantRole(invoiceReader, readerRole, "company", co);
    const pool = adminPool();
    await pool.query(`UPDATE users SET kind = 'bot' WHERE id = $1`, [bot]);
    for (const u of [adminA, adminB, manager, member, bot, invoiceReader]) {
      await pool.query(`UPDATE users SET home_company_id = $1 WHERE id = $2`, [co, u]);
    }
    await pool.query(`UPDATE users SET home_company_id = $1 WHERE id = $2`, [co2, otherAdmin]);
    await linkIdentity(adminA, ADMIN_OBO.provider, ADMIN_OBO.externalId, true);

    clientA = await createClient(co, "DW10f-3a Client A");
    clientB = await createClient(co, "DW10f-3a Client B");
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, activated_at, origin_site)
         VALUES ($1, $2, $3, $4, NULL, 'signer', 'active', now(), $5)`,
        [newId(), co, clientA, signerA, config.originSite],
      ),
    );
    await grantRole(signerA, await createRole("client"), "company", co);
    await ensureBillingSetup(co, { prefix: "D3A" });
    app = await buildApp();
  }, 180_000);
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("the billable read", () => {
    it("on signing is due at once; a later date is upcoming, and due once dueBy reaches it", async () => {
      const { contractId, ids } = await signedContract(clientA, "60000000", FIFTY);
      const r = await billable(`?clientId=${clientA}`);
      expect(r.statusCode, r.body).toBe(200);
      const mine = r.json().items.filter((i: { contract: { id: string } }) => i.contract.id === contractId);
      expect(mine.map((i: { instalmentId: string; state: string; position: number; count: number }) => [i.instalmentId, i.state, i.position, i.count]))
        .toEqual([[ids[0], "due", 1, 2], [ids[1], "upcoming", 2, 2]]);
      expect(mine[0]).toMatchObject({
        client: { id: clientA }, contract: { id: contractId, kind: "agreement", projectId: null },
        label: "Deposit (50%)", amount: 30000000, currency: "IDR", due: { kind: "on_signing" }, invoice: null,
      });
      expect(mine[0].due.on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const ahead = await billable(`?clientId=${clientA}&dueBy=${FUTURE}`);
      expect(ahead.json().dueBy).toBe(FUTURE);
      expect(ahead.json().items.filter((i: { contract: { id: string } }) => i.contract.id === contractId).map((i: { state: string }) => i.state))
        .toEqual(["due", "due"]);
    });

    it("asks invoice read AND contract read (403 before any 400); bad query values are 400", async () => {
      expect((await billable("?dueBy=nope", member)).statusCode).toBe(403);
      expect((await billable("", invoiceReader)).statusCode).toBe(403); // reads invoices, not contracts
      expect((await billable("", otherAdmin)).statusCode).toBe(403);
      expect((await billable("", manager)).statusCode).toBe(200);
      expect((await billable("?dueBy=2027-02-30")).json().error).toBe("due_by_invalid");
      expect((await billable("?clientId=nope")).json().error).toBe("client_id_invalid");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("drafting, issuing and voiding", () => {
    it("draft from both instalments, replay, refuse a second draft, approve, issue (AR lines are quantity 1), portal, void", async () => {
      const { contractId, ids } = await signedContract(clientA, "60000000", FIFTY);
      const before = await invoiceCountFor(clientA);
      const r = await draftFrom({ clientId: clientA, instalmentIds: ids, dueBy: FUTURE });
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json()).toEqual({ id: expect.any(String), source: "instalments", lineCount: 2, total: 60000000, currency: "IDR" });
      const invId = r.json().id;
      const inv = (await adminPool().query(`SELECT status, total::text AS total, lines, period_start, created_by FROM invoices WHERE id = $1`, [invId])).rows[0];
      expect(inv).toMatchObject({ status: "draft", created_by: adminA });
      expect(Number(inv.total)).toBe(60000000);
      expect(inv.lines.map((l: Record<string, unknown>) => [l.kind, l.instalmentId, l.contractId, l.amount, l.hours, l.rate]))
        .toEqual([["instalment", ids[0], contractId, 30000000, undefined, undefined], ["instalment", ids[1], contractId, 30000000, undefined, undefined]]);
      expect(inv.lines[0].description).toMatch(/· Deposit \(50%\) \(1 of 2\)$/);
      for (const id of ids) expect((await claimOf(id)).invoice_id).toBe(invId);
      const created = (await adminPool().query(`SELECT metadata FROM activities WHERE target_entity_id = $1 AND verb = 'created'`, [invId])).rows;
      expect(created[0].metadata).toMatchObject({ source: "instalments", instalmentIds: ids });
      const ev = (await adminPool().query(`SELECT payload FROM outbox_events WHERE entity_id = $1 AND event_type = 'invoice.created'`, [invId])).rows;
      expect(ev[0].payload).toMatchObject({ source: "instalments", instalmentIds: ids });

      // A replay of the same body answers the same draft; a draft with either instalment is refused.
      const replay = await draftFrom({ clientId: clientA, instalmentIds: [ids[1], ids[0]], dueBy: FUTURE });
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toMatchObject({ id: invId, deduped: true });
      const second = await draftFrom({ clientId: clientA, instalmentIds: [ids[0]] });
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({ error: "instalment_unavailable", detail: { items: [{ instalmentId: ids[0], reason: "already_invoiced", invoiceId: invId }] } });
      expect(await invoiceCountFor(clientA)).toBe(before + 1);

      // The billable read shows them as `invoicing`; the portal never shows the draft (still "due", no invoice).
      const b = (await billable(`?clientId=${clientA}&dueBy=${FUTURE}`)).json().items.filter((i: { contract: { id: string } }) => i.contract.id === contractId);
      expect(b.map((i: { state: string; invoice: unknown }) => [i.state, i.invoice])).toEqual([
        ["invoicing", { id: invId, status: "draft" }], ["invoicing", { id: invId, status: "draft" }],
      ]);
      const p0 = (await req("GET", `/api/${co}/portal/contracts/${contractId}`, signerA)).json().schedule.instalments;
      // An instalment on an unissued draft reads "due" in the portal, whatever its date (§61.3: invoicing -> Due).
      expect(p0.map((i: { state: string; invoice: unknown }) => [i.state, i.invoice])).toEqual([["due", null], ["due", null]]);
      expect(await blockerCodes(invId)).not.toEqual(expect.arrayContaining(["INSTALMENT_LINES_INVALID"]));

      // B approves (maker-checker), A picks the service line (no project -> no default) and issues.
      expect((await req("POST", `/api/${co}/invoices/${invId}/approve`, adminB)).statusCode).toBe(200);
      expect((await req("PATCH", `/api/${co}/invoices/${invId}/service-line`, adminA, { serviceLineKey: "services" })).statusCode).toBe(200);
      const codes = await blockerCodes(invId);
      expect(codes.filter((c) => c.startsWith("INSTALMENT_"))).toEqual([]);
      const issued = await req("POST", `/api/${co}/invoices/${invId}/issue`, adminA);
      expect(issued.statusCode, issued.body).toBe(200);
      const ar = (await adminPool().query(
        `SELECT l.quantity::text AS q, l.unit_price::text AS p, l.line_subtotal::text AS s
           FROM finance_ar_invoice_lines l JOIN invoices i ON i.ar_invoice_id = l.invoice_id
          WHERE i.id = $1 ORDER BY l.line_no`, [invId],
      )).rows;
      expect(ar.map((x: { q: string; p: string; s: string }) => [Number(x.q), Number(x.p), Number(x.s)])).toEqual([[1, 30000000, 30000000], [1, 30000000, 30000000]]);

      // Issued: the staff and portal schedules say "invoiced" with the number; portal lines carry no internal ids.
      const invoiceNo = issued.json().invoiceNo;
      const p1 = (await req("GET", `/api/${co}/portal/contracts/${contractId}`, signerA)).json().schedule.instalments;
      expect(p1.map((i: { state: string; invoice: unknown }) => [i.state, i.invoice])).toEqual([
        ["invoiced", { id: invId, invoiceNo }], ["invoiced", { id: invId, invoiceNo }],
      ]);
      const pinv = await req("GET", `/api/${co}/portal/invoices/${invId}`, signerA);
      expect(pinv.statusCode, pinv.body).toBe(200);
      for (const l of pinv.json().lines) {
        expect(l.kind).toBe("instalment");
        expect(l).not.toHaveProperty("contractId");
        expect(l).not.toHaveProperty("instalmentId");
        expect(l).not.toHaveProperty("projectId");
      }

      // Void the issued invoice: the credit note, and both instalments released.
      const v = await req("POST", `/api/${co}/invoices/${invId}/void`, adminA, { reason: "issued in error" });
      expect(v.statusCode, v.body).toBe(200);
      expect(v.json()).toMatchObject({ status: "void", releasedInstalments: 2, creditNoteId: expect.any(String) });
      for (const id of ids) expect(await claimOf(id)).toEqual({ invoice_id: null, claimed_at: null });
      // An issued (now void) invoice cannot be edited back (409); the database's PD614 is pinned on a draft below.
      const back = await req("PATCH", `/api/${co}/invoices/${invId}`, adminA, { status: "draft" });
      expect(back.statusCode).toBe(409);
      await expect(adminPool().query(`UPDATE invoices SET status = 'sent' WHERE id = $1`, [invId])).rejects.toMatchObject({ code: "PD614" });
    });

    it("Cancel draft (PATCH void) releases the claims; drafting again works; un-voiding is refused (409, PD614)", async () => {
      const { ids } = await signedContract(clientA, "50000000", [{ label: "All", amount: "50000000", due: "on_signing" }]);
      const first = await draftFrom({ clientId: clientA, instalmentIds: ids });
      expect(first.statusCode, first.body).toBe(201);
      const cancel = await req("PATCH", `/api/${co}/invoices/${first.json().id}`, adminA, { status: "void" });
      expect(cancel.statusCode, cancel.body).toBe(200);
      expect(cancel.json()).toEqual({ ok: true, releasedInstalments: 1 });
      expect(await claimOf(ids[0])).toEqual({ invoice_id: null, claimed_at: null });
      const undo = await req("PATCH", `/api/${co}/invoices/${first.json().id}`, adminA, { status: "draft" });
      expect(undo.statusCode).toBe(409);
      expect(undo.json().reason).toBe("invoice_unvoid_refused");
      await expect(adminPool().query(`UPDATE invoices SET status = 'draft' WHERE id = $1`, [first.json().id])).rejects.toMatchObject({ code: "PD614" });
      const again = await draftFrom({ clientId: clientA, instalmentIds: ids });
      expect(again.statusCode, again.body).toBe(201);
      expect(again.json().id).not.toBe(first.json().id);
      expect((await claimOf(ids[0])).invoice_id).toBe(again.json().id);
    });

    it("the readiness blockers: lines that do not match the claim, a voided contract, a signed superseding version", async () => {
      const k1 = await signedContract(clientA, "10000000", [{ label: "All", amount: "10000000", due: "on_signing" }]);
      const d1 = (await draftFrom({ clientId: clientA, instalmentIds: k1.ids })).json().id;
      // A line edited behind the claim's back (the amount no longer the instalment's).
      await adminPool().query(
        `UPDATE invoices SET lines = jsonb_set(lines, '{0,amount}', '9'::jsonb), total = 9 WHERE id = $1`, [d1],
      );
      expect(await blockerCodes(d1)).toContain("INSTALMENT_LINES_INVALID");

      const k2 = await signedContract(clientA, "10000000", [{ label: "All", amount: "10000000", due: "on_signing" }]);
      const d2 = (await draftFrom({ clientId: clientA, instalmentIds: k2.ids })).json().id;
      expect((await req("PATCH", `/api/${co}/contracts/${k2.contractId}`, adminA, { status: "void" })).statusCode).toBe(200);
      expect(await blockerCodes(d2)).toContain("INSTALMENT_CONTRACT_NOT_SIGNED");

      const k3 = await signedContract(clientA, "10000000", [{ label: "All", amount: "10000000", due: "on_signing" }]);
      const d3 = (await draftFrom({ clientId: clientA, instalmentIds: k3.ids })).json().id;
      const unclaimed = await signedContract(clientA, "10000000", [{ label: "All", amount: "10000000", due: "on_signing" }]);
      for (const old of [k3.contractId, unclaimed.contractId]) {
        await signedContract(clientA, "10000000", [{ label: "All", amount: "10000000", due: "on_signing" }], { cols: { supersedes_id: old, version: 2 } });
      }
      expect(await blockerCodes(d3)).toContain("INSTALMENT_SUPERSEDED");
      // The superseded contract's unclaimed instalment is no longer billable: not_billed (superseded), and refused.
      const staff = (await req("GET", `/api/${co}/contracts/${unclaimed.contractId}`, adminA)).json().schedule.instalments[0];
      expect([staff.state, staff.notBilledReason]).toEqual(["not_billed", "superseded"]);
      const refused = await draftFrom({ clientId: clientA, instalmentIds: unclaimed.ids });
      expect(refused.json().detail.items).toEqual([{ instalmentId: unclaimed.ids[0], reason: "superseded" }]);
      // An hourly invoice carries none of these blockers.
      const hourly = await req("POST", `/api/${co}/invoices`, adminA, { clientId: clientA, periodStart: "2026-01-01", periodEnd: "2026-01-31", rate: 100 });
      expect(hourly.statusCode, hourly.body).toBe(201);
      expect((await blockerCodes(hourly.json().id)).filter((c) => c.startsWith("INSTALMENT_"))).toEqual([]);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("refusals", () => {
    it("403 before any 400: member, manager and another company's admin, with a malformed body", async () => {
      // (A bot through the dev x-user-id header is assembled at high assurance, so its "minted low" refusal cannot be
      // shown on this path; issue and void keep their bot DENY, pinned in invoice-issue-tools.test.ts.)
      for (const who of [member, manager, otherAdmin]) {
        const thin = await req("POST", `/api/${co}/invoices`, who, {});
        expect(thin.statusCode, `${who} hourly`).toBe(403);
        const bad = await req("POST", `/api/${co}/invoices`, who, { source: "instalments", instalmentIds: "x" });
        expect(bad.statusCode, `${who} instalments`).toBe(403);
      }
      // The hourly draft keeps working for a company admin, and its lines now carry kind 'hours'.
      const ok = await req("POST", `/api/${co}/invoices`, adminA, { clientId: clientA, periodStart: "2026-01-01", periodEnd: "2026-01-31", rate: 100 });
      expect(ok.statusCode, ok.body).toBe(201);
      expect(ok.json()).toEqual({ id: expect.any(String) });
      expect((await req("POST", `/api/${co}/invoices`, adminA, {})).statusCode).toBe(400);
    });

    it("DW-D48: one source per invoice; the body's 400s in order", async () => {
      const id = newId();
      const code = async (body: Record<string, unknown>) => {
        const r = await req("POST", `/api/${co}/invoices`, adminA, body);
        return `${r.statusCode} ${r.json().error}`;
      };
      expect(await code({ source: "both", clientId: clientA })).toBe("400 source_invalid");
      expect(await code({ source: "instalments", clientId: clientA, instalmentIds: [id], periodStart: "2026-01-01", periodEnd: "2026-01-31", rate: 1 }))
        .toBe("400 source_fields_mixed");
      expect(await code({ source: "hours", clientId: clientA, instalmentIds: [id], periodStart: "2026-01-01", periodEnd: "2026-01-31", rate: 1 }))
        .toBe("400 source_fields_mixed");
      expect(await code({ source: "instalments", clientId: clientA, instalmentIds: [] })).toBe("400 instalment_ids_invalid");
      expect(await code({ source: "instalments", clientId: clientA, instalmentIds: [id, id] })).toBe("400 instalment_ids_invalid");
      expect(await code({ source: "instalments", clientId: clientA, instalmentIds: [id], dueBy: "tomorrow" })).toBe("400 due_by_invalid");
      expect(await code({ source: "instalments", clientId: clientA, instalmentIds: [id], taxCode: "no spaces" })).toBe("400 tax_code_invalid");
      expect(await code({ source: "instalments", clientId: newId(), instalmentIds: [id] })).toBe("404 client_not_found");
    });

    it("409 instalment_unavailable names each reason; 400 currency_mixed; nothing is written", async () => {
      const before = await invoiceCountFor(clientA);
      const mine = await signedContract(clientA, "20000000", [
        { label: "Now", amount: "10000000", due: "on_signing" }, { label: "Later", amount: "10000000", due: FUTURE },
      ]);
      const theirs = await signedContract(clientB, "10000000", [{ label: "All", amount: "10000000", due: "on_signing" }]);
      const unsent = await withTenants([co], (c) => insertSentContractWithSchedule(c, {
        tenantId: co, clientId: clientA, value: "10000000", instalments: [{ label: "All", amount: "10000000", due: "on_signing" }],
      }));
      const ghost = newId();
      const r = await draftFrom({ clientId: clientA, instalmentIds: [ghost, theirs.ids[0], unsent.instalmentIds[0], mine.ids[1], mine.ids[0]] });
      expect(r.statusCode).toBe(409);
      expect(r.json().detail.items).toEqual([
        { instalmentId: ghost, reason: "not_found" },
        { instalmentId: theirs.ids[0], reason: "other_client" },
        { instalmentId: unsent.instalmentIds[0], reason: "not_signed" },
        { instalmentId: mine.ids[1], reason: "not_due" },
      ]);
      const usd = await signedContract(clientA, "100.50", [{ label: "All", amount: "100.50", due: "on_signing" }], { currency: "USD" });
      const mixed = await draftFrom({ clientId: clientA, instalmentIds: [mine.ids[0], usd.ids[0]] });
      expect([mixed.statusCode, mixed.json().error]).toEqual([400, "currency_mixed"]);
      expect(await invoiceCountFor(clientA)).toBe(before);
      expect((await claimOf(mine.ids[0])).invoice_id).toBeNull();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("the claim race", () => {
    it("two concurrent drafts of one instalment (different bodies): exactly one wins; the other 409s and writes nothing", async () => {
      const k = await signedContract(clientB, "20000000", [
        { label: "One", amount: "10000000", due: "on_signing" }, { label: "Two", amount: "10000000", due: "2020-01-01" },
      ]);
      const before = await invoiceCountFor(clientB);
      const [a, b] = await Promise.all([
        draftFrom({ clientId: clientB, instalmentIds: [k.ids[0]] }),
        draftFrom({ clientId: clientB, instalmentIds: [k.ids[0], k.ids[1]] }),
      ]);
      expect([a.statusCode, b.statusCode].sort(), `${a.body} | ${b.body}`).toEqual([201, 409]);
      const winner = a.statusCode === 201 ? a : b;
      expect((await claimOf(k.ids[0])).invoice_id).toBe(winner.json().id);
      expect(await invoiceCountFor(clientB)).toBe(before + 1);
      // The loser's other instalment was not claimed either (all or nothing).
      if (winner === a) expect((await claimOf(k.ids[1])).invoice_id).toBeNull();
    });

    it("two concurrent IDENTICAL drafts: one invoice; the replay answers it", async () => {
      const k = await signedContract(clientB, "10000000", [{ label: "All", amount: "10000000", due: "on_signing" }]);
      const before = await invoiceCountFor(clientB);
      const [a, b] = await Promise.all([
        draftFrom({ clientId: clientB, instalmentIds: k.ids }),
        draftFrom({ clientId: clientB, instalmentIds: k.ids }),
      ]);
      expect([a.statusCode, b.statusCode], `${a.body} | ${b.body}`).toEqual([201, 201]);
      expect(a.json().id).toBe(b.json().id);
      expect([a.json().deduped, b.json().deduped].filter(Boolean)).toEqual([true]);
      expect(await invoiceCountFor(clientB)).toBe(before + 1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("the tools (§61.10)", () => {
    it("invoices.billableInstalments and invoices.draftFromSchedule work through the envelope, as the person", async () => {
      const k = await signedContract(clientA, "10000000", [{ label: "All", amount: "10000000", due: "on_signing" }]);
      const list = await callTool("invoices.billableInstalments", { tenantId: co, clientId: clientA, dueBy: FUTURE });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json().items.some((i: { instalmentId: string }) => i.instalmentId === k.ids[0])).toBe(true);
      const d = await callTool("invoices.draftFromSchedule", { tenantId: co, source: "instalments", clientId: clientA, instalmentIds: k.ids });
      expect(d.statusCode, d.body).toBe(201);
      const act = (await adminPool().query(
        `SELECT actor_id, metadata FROM activities WHERE target_entity_id = $1 AND verb = 'created'`, [d.json().id],
      )).rows[0];
      expect(act.actor_id).toBe(adminA);
      expect(act.metadata.via).toMatchObject({ externalId: ADMIN_OBO.externalId });
      const again = await callTool("invoices.draftFromSchedule", { tenantId: co, source: "instalments", clientId: clientA, instalmentIds: k.ids });
      expect(again.json()).toMatchObject({ id: d.json().id, deduped: true });
    });
  });
});
