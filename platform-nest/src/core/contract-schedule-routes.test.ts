// DW-10f-2a — the payment schedule on a contract (FRONTEND-BFF-CONTRACT §61.3, §61.4, §61.4a, §61.6; PERMISSION-CONTRACT
// §51; rulings DW-D45, DW-D49). Drives the REAL routes (PUT …/schedule, send, PATCH, countersign, the portal's contract
// read and sign, POST …/schedule/after-signing) against real RLS, a live Cerbos and the migrations, with the database's
// own walls (PD610 to PD618) underneath.
//
// ── AUTHORIZATION BEFORE VALIDATION ─────────────────────────────────────────────────────────────
// Every denial sends a body that would otherwise be refused with a 400, so a 403 can only come from the authorization
// check ("validation pre-empts authz"). A positive control shows each one-right custom role does pass its own half.
//
// ── THE TEETH ───────────────────────────────────────────────────────────────────────────────────
//  - remove the handler's schedule check in send   -> "Send answers 400 schedule_total_mismatch" sees PD612's mapping
//    (still 400) but loses `detail` -> fails on detail.
//  - drop `invoice` `create` from the addition       -> the editor-only custom role gets 201 -> fails.
//  - drop the PD613/PD618 mapping on the addition    -> the race answers 500 -> fails.
//  - COALESCE fields back into PATCH void           -> `{status:'void', value}` changes the value (or 500s) -> fails.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { newId, withGlobal, withTenants } from "../db";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import {
  createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject, linkIdentity,
} from "../testing/fixtures";
import { fixedContentCols, insertSentContractWithSchedule } from "../testing/contract-fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const TERMS = "## Terms\nThe client pays per this agreement.\n";
const PAST = "2020-01-31";
const FUTURE = "2099-12-31";

describe.skipIf(!TEST_URL)("DW-10f-2a · the payment schedule (HTTP)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string;      // company_admin: drafts, schedules, sends; contract update + invoice create
  let owner: string;      // owner: countersigns
  let manager: string;    // manager: reads contracts only
  let member: string;     // no authority over contracts
  let editorOnly: string; // custom role: core.contract.update only
  let invoicerOnly: string; // custom role: invoice.create only
  let signerA: string;    // client A's client-wide signer
  let signerB: string;    // client B's signer
  let scopedA: string;    // client A's contact scoped to ANOTHER project
  let clientA: string;
  let clientB: string;
  let projectA1: string;
  let seq = 0;
  const ADMIN_OBO = { provider: "platform", externalId: "dw10f2a-admin" };

  const req = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, as: string, payload?: unknown) =>
    app.inject({ method, url, headers: asUser(as), ...(payload !== undefined ? { payload: payload as object } : {}) });
  const put = (id: string, instalments: unknown, as = admin) =>
    req("PUT", `/api/${co}/contracts/${id}/schedule`, as, { instalments });
  const addAfter = (id: string, instalments: unknown, as = admin) =>
    req("POST", `/api/${co}/contracts/${id}/schedule/after-signing`, as, { instalments });
  const detail = (id: string, as = admin) => req("GET", `/api/${co}/contracts/${id}`, as);
  const row = async (id: string) =>
    (await adminPool().query(
      `SELECT status, value::text AS value, schedule_sha256, schedule_added_at, schedule_added_by,
              contract_schedule_sha256(id, currency, value) AS computed
         FROM contracts WHERE id = $1`, [id],
    )).rows[0] as { status: string; value: string | null; schedule_sha256: string | null; schedule_added_at: Date | null; schedule_added_by: string | null; computed: string | null };
  const instalmentCount = async (id: string) =>
    Number((await adminPool().query(`SELECT count(*)::int AS n FROM contract_instalments WHERE contract_id = $1`, [id])).rows[0].n);
  const activity = async (id: string, verb: string) =>
    (await adminPool().query<{ actor_id: string; metadata: Record<string, unknown> }>(
      `SELECT actor_id, metadata FROM activities WHERE target_entity_id = $1 AND verb = $2`, [id, verb],
    )).rows;

  async function draft(clientId: string, extra: Record<string, unknown> = {}): Promise<string> {
    const r = await req("POST", `/api/${co}/contracts`, admin, {
      clientId, title: `DW10f schedule ${++seq}`, bodyMd: TERMS, value: 60000000, currency: "IDR", ...extra,
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id;
  }
  const FIFTY = [
    { label: "Deposit (50%)", amount: 30000000, due: "on_signing" },
    { label: "Balance (50%)", amount: "30000000", due: FUTURE },
  ];
  async function sent(clientId: string, rows = FIFTY, extra: Record<string, unknown> = {}): Promise<string> {
    const id = await draft(clientId, extra);
    expect((await put(id, rows)).statusCode).toBe(200);
    const r = await req("POST", `/api/${co}/contracts/${id}/send`, admin);
    expect(r.statusCode, r.body).toBe(200);
    return id;
  }
  async function signBoth(id: string, signer = signerA): Promise<void> {
    const pd = await req("GET", `/api/${co}/portal/contracts/${id}`, signer);
    expect(pd.statusCode, pd.body).toBe(200);
    const s = await req("POST", `/api/${co}/portal/contracts/${id}/sign`, signer, {
      signerName: "Sam Signer", agree: true, contentSha256: pd.json().contentSha256,
    });
    expect(s.statusCode, s.body).toBe(200);
    const cs = await req("POST", `/api/${co}/contracts/${id}/countersign`, owner, { signerName: "Olive Owner" });
    expect(cs.statusCode, cs.body).toBe(200);
    expect((await row(id)).status).toBe("signed");
  }
  /** A contract sent and signed BEFORE 10f: inserted signed with a value and no schedule, both signatures with no
   *  schedule hash (the shape DW-D49 exists for). `status` lets the refusal cases put it in another closed state. */
  async function legacy(clientId: string, o: { value?: string | null; status?: string; cols?: Record<string, unknown> } = {}): Promise<string> {
    const id = newId();
    const cols: Record<string, unknown> = {
      id, tenant_id: co, client_id: clientId, title: `Legacy ${++seq}`, version: 1, status: o.status ?? "signed",
      value: o.value === undefined ? "60000000" : o.value, currency: "IDR", sent_at: new Date(), signed_at: new Date(),
      created_by: admin, origin_site: "test", ...fixedContentCols(TERMS), ...(o.cols ?? {}),
    };
    const names = Object.keys(cols);
    await adminPool().query(
      `INSERT INTO contracts (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
      names.map((n) => cols[n]),
    );
    if ((o.status ?? "signed") === "signed") {
      for (const [party, signer] of [["client", signerA], ["provider", owner]] as const) {
        await adminPool().query(
          `INSERT INTO contract_signatures (id, tenant_id, contract_id, party, signer, signer_name, content_sha256, origin_site)
           VALUES ($1, $2, $3, $4, $5, 'Someone', $6, 'test')`,
          [newId(), co, id, party, signer, fixedContentCols(TERMS).content_sha256],
        );
      }
    }
    return id;
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.approvalGrantSecret = "dw10f2a-test-secret-not-real";
    config.services.hub = { url: "http://hub.test", token: "hub-token", assuranceToken: "" };
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("DW10f Schedule Agency", ["invoice", "clients"]);
    admin = await createUser("admin@dw10f2a.test");
    owner = await createUser("owner@dw10f2a.test");
    manager = await createUser("manager@dw10f2a.test");
    member = await createUser("member@dw10f2a.test");
    editorOnly = await createUser("editor@dw10f2a.test");
    invoicerOnly = await createUser("invoicer@dw10f2a.test");
    signerA = await createUser("signer-a@dw10f2a-client.test");
    signerB = await createUser("signer-b@dw10f2a-client.test");
    scopedA = await createUser("scoped-a@dw10f2a-client.test");
    const staff = [admin, owner, manager, member, editorOnly, invoicerOnly];
    for (const u of [...staff, signerA, signerB, scopedA]) await addMembership(co, u);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    await grantRole(owner, await createRole("owner"), "company", co);
    await grantRole(manager, await createRole("manager"), "company", co);
    await grantRole(member, await createRole("member"), "company", co);
    // Two tenant-defined custom roles, one right each (PERMISSION-CONTRACT §51: the addition needs BOTH).
    for (const [u, name, key] of [[editorOnly, "dw10f_contract_editor", "core.contract.update"], [invoicerOnly, "dw10f_invoice_drafter", "invoice.create"]] as const) {
      const roleId = newId();
      await withGlobal(async (c) => {
        await c.query(`INSERT INTO roles (id, company_id, name) VALUES ($1, $2, $3)`, [roleId, co, name]);
        const ins = await c.query(
          `INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key = $2`, [roleId, key],
        );
        expect(ins.rowCount, key).toBe(1);
      });
      await grantRole(u, roleId, "company", co);
    }
    for (const u of staff) await adminPool().query(`UPDATE users SET home_company_id = $1 WHERE id = $2`, [co, u]);
    await linkIdentity(admin, ADMIN_OBO.provider, ADMIN_OBO.externalId, true);

    clientA = await createClient(co, "DW10f Client A");
    clientB = await createClient(co, "DW10f Client B");
    projectA1 = await createProject(co, "DW10f A project one", admin, clientA);
    const projectA2 = await createProject(co, "DW10f A project two", admin, clientA);
    const clientRole = await createRole("client");
    for (const [cl, u, proj] of [[clientA, signerA, null], [clientB, signerB, null], [clientA, scopedA, projectA2]] as const) {
      await withTenants([co], (c) =>
        c.query(
          `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, activated_at, origin_site)
           VALUES ($1, $2, $3, $4, $5, 'signer', 'active', now(), $6)`,
          [newId(), co, cl, u, proj, config.originSite],
        ),
      );
      await grantRole(u, clientRole, "company", co);
    }
    app = await buildApp();
  }, 180_000);
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("PUT …/schedule and the reads (§61.4)", () => {
    it("a 50/50 schedule on a draft reads back with matchesValue true; the list carries scheduleSummary", async () => {
      const id = await draft(clientA);
      const r = await put(id, FIFTY);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({
        currency: "IDR", value: 60000000, total: 60000000, matchesValue: true, scheduleSha256: null, addedAfterSigning: null,
      });
      const inst = r.json().instalments;
      expect(inst.map((i: { position: number; label: string; amount: number; due: unknown; state: string; invoice: unknown }) =>
        [i.position, i.label, i.amount, i.due, i.state, i.invoice])).toEqual([
        [1, "Deposit (50%)", 30000000, { kind: "on_signing", on: null }, "scheduled", null],
        [2, "Balance (50%)", 30000000, { kind: "date", on: FUTURE }, "scheduled", null],
      ]);
      const d = await detail(id);
      expect(d.json().schedule.instalments).toHaveLength(2);
      expect(d.json()).toMatchObject({ scheduleSummary: { count: 2, total: 60000000, matchesValue: true }, scheduleAddable: false });
      const list = await req("GET", `/api/${co}/contracts?clientId=${clientA}`, admin);
      const mine = list.json().find((x: { id: string }) => x.id === id);
      expect(mine.scheduleSummary).toEqual({ count: 2, total: 60000000, matchesValue: true });
      expect(mine).not.toHaveProperty("_schedCount");
      expect((await activity(id, "schedule_updated"))[0]).toMatchObject({ actor_id: admin, metadata: { count: 2, total: "60000000" } });
      // A PUT replaces the whole schedule; [] clears it (an object with no rows; the detail reads null).
      const cleared = await put(id, []);
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json()).toMatchObject({ instalments: [], matchesValue: false, total: 0 });
      expect((await detail(id)).json()).toMatchObject({ schedule: null, scheduleSummary: null });
    });

    it("a schedule that does not add up saves with matchesValue false; Send answers 400 schedule_total_mismatch and writes nothing", async () => {
      const id = await draft(clientA);
      const r = await put(id, [{ label: "Deposit", amount: 10000000, due: "on_signing" }]);
      expect(r.statusCode).toBe(200);
      expect(r.json().matchesValue).toBe(false);
      const s = await req("POST", `/api/${co}/contracts/${id}/send`, admin);
      expect(s.statusCode).toBe(400);
      expect(s.json()).toMatchObject({ error: "schedule_total_mismatch", reason: "schedule_total_mismatch", detail: { value: 60000000, total: 10000000 } });
      expect((await row(id)).status).toBe("draft");
      // A valued contract with NO schedule is the same refusal.
      const bare = await draft(clientA);
      const s2 = await req("POST", `/api/${co}/contracts/${bare}/send`, admin);
      expect(s2.statusCode).toBe(400);
      expect(s2.json().detail).toEqual({ value: 60000000, total: 0 });
      // Underneath, the database refuses a direct move to sent (PD612), and one that stores a wrong hash.
      await expect(adminPool().query(
        `UPDATE contracts SET status = 'sent', sent_at = now(), content_sha256 = $2, content_fixed_at = now(), signature_tier = 'attested',
                schedule_sha256 = contract_schedule_sha256(id, currency, value) WHERE id = $1`,
        [id, fixedContentCols(TERMS).content_sha256],
      )).rejects.toMatchObject({ code: "PD612" });
      expect((await put(id, FIFTY)).statusCode).toBe(200);
      await expect(adminPool().query(
        `UPDATE contracts SET status = 'sent', sent_at = now(), content_sha256 = $2, content_fixed_at = now(), signature_tier = 'attested',
                schedule_sha256 = repeat('a', 64) WHERE id = $1`,
        [id, fixedContentCols(TERMS).content_sha256],
      )).rejects.toMatchObject({ code: "PD612" });
    });

    it("authorizes FIRST: a manager, a member and the invoice-only role get 403 even with an invalid body", async () => {
      const id = await draft(clientA);
      for (const who of [manager, member, invoicerOnly]) {
        expect((await put(id, "not a list", who)).statusCode).toBe(403);
        expect((await put(id, FIFTY, who)).statusCode).toBe(403);
      }
      expect(await instalmentCount(id)).toBe(0);
      // The editor-only custom role holds contract update, so it may write a draft's schedule.
      expect((await put(id, FIFTY, editorOnly)).statusCode).toBe(200);
    });

    it("refusals in order: 404, 409 schedule_frozen (before any 400), then each 400 of the table", async () => {
      expect((await put(newId(), FIFTY)).json()).toMatchObject({ error: "contract_not_found" });
      expect((await put(newId(), FIFTY)).statusCode).toBe(404);
      const sentId = await sent(clientA);
      const frozen = await put(sentId, "not a list");
      expect(frozen.statusCode).toBe(409);
      expect(frozen.json().error).toBe("schedule_frozen");

      const id = await draft(clientA);
      const code = async (rows: unknown, target = id) => {
        const r = await put(target, rows);
        return `${r.statusCode} ${r.json().error}`;
      };
      expect(await code("x")).toBe("400 schedule_invalid");
      expect(await code(Array.from({ length: 61 }, () => ({ label: "x", amount: 1, due: FUTURE })))).toBe("400 schedule_invalid");
      expect(await code([{ label: " ", amount: 1, due: FUTURE }])).toBe("400 schedule_invalid");
      expect(await code([{ label: "A", amount: -1, due: FUTURE }])).toBe("400 schedule_invalid");
      expect(await code([{ label: "A", amount: 1, due: "soon" }])).toBe("400 schedule_invalid");
      expect(await code([{ label: "A", amount: 1, due: FUTURE }, { label: "B", amount: 1, due: "on_signing" }])).toBe("400 schedule_order_invalid");
      expect(await code([{ label: "A", amount: 1, due: "on_signing" }, { label: "B", amount: 1, due: "on_signing" }])).toBe("400 schedule_order_invalid");
      expect(await code([{ label: "A", amount: 1, due: FUTURE }, { label: "B", amount: 1, due: PAST }])).toBe("400 schedule_order_invalid");
      const zzz = await draft(clientA, { currency: "ZZZ" });
      expect(await code([{ label: "A", amount: 1, due: FUTURE }], zzz)).toBe("400 currency_unknown");
      expect(await code([{ label: "A", amount: "100.5", due: FUTURE }])).toBe("400 schedule_precision");
      const unvalued = await draft(clientA, { value: undefined });
      expect(await code([{ label: "A", amount: 1, due: FUTURE }], unvalued)).toBe("400 schedule_needs_value");
      const zero = await draft(clientA, { value: 0 });
      expect(await code([{ label: "A", amount: 1, due: FUTURE }], zero)).toBe("400 schedule_needs_value");
      expect(await instalmentCount(id)).toBe(0);
    });

    it("Send fixes the schedule: scheduleSha256 is contract_schedule_sha256(), on the answer, the row and the activity", async () => {
      const id = await draft(clientA);
      expect((await put(id, FIFTY)).statusCode).toBe(200);
      const s = await req("POST", `/api/${co}/contracts/${id}/send`, admin);
      expect(s.statusCode, s.body).toBe(200);
      const k = await row(id);
      expect(k.schedule_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(k.schedule_sha256).toBe(k.computed);
      expect(s.json().scheduleSha256).toBe(k.schedule_sha256);
      expect((await activity(id, "sent"))[0].metadata.scheduleSha256).toBe(k.schedule_sha256);
      expect((await detail(id)).json().schedule.scheduleSha256).toBe(k.schedule_sha256);
      // An unvalued contract carries no schedule and sends with no hash.
      const nda = await draft(clientA, { value: undefined });
      const s2 = await req("POST", `/api/${co}/contracts/${nda}/send`, admin);
      expect(s2.statusCode, s2.body).toBe(200);
      expect(s2.json().scheduleSha256).toBeNull();
    });

    it("after send: the schedule and the money are frozen (PUT 409, PD610, PD613); PATCH accepts {status:'void'} and nothing else", async () => {
      const id = await sent(clientA);
      const inst = (await adminPool().query<{ id: string }>(`SELECT id FROM contract_instalments WHERE contract_id = $1 ORDER BY position`, [id])).rows;
      await expect(adminPool().query(
        `INSERT INTO contract_instalments (id, tenant_id, contract_id, position, label, amount, due_kind) VALUES ($1, $2, $3, 3, 'Extra', 1, 'on_signing')`,
        [newId(), co, id],
      )).rejects.toMatchObject({ code: "PD610" });
      await expect(adminPool().query(`UPDATE contract_instalments SET amount = 1 WHERE id = $1`, [inst[0].id])).rejects.toMatchObject({ code: "PD610" });
      await expect(adminPool().query(`DELETE FROM contract_instalments WHERE id = $1`, [inst[1].id])).rejects.toMatchObject({ code: "PD610" });
      await expect(adminPool().query(`UPDATE contracts SET value = 1 WHERE id = $1`, [id])).rejects.toMatchObject({ code: "PD613" });

      const patch = (body: Record<string, unknown>) => req("PATCH", `/api/${co}/contracts/${id}`, admin, body);
      const t = await patch({ status: "void", title: "x" });
      expect(t.statusCode).toBe(400);
      expect(t.json().reason).toBe("only_void_after_send");
      // The bug this fixes: voiding used to COALESCE the value into the same UPDATE.
      const v = await patch({ status: "void", value: 1 });
      expect(v.statusCode).toBe(400);
      expect(v.json().reason).toBe("only_void_after_send");
      expect((await patch({ title: "x" })).json().reason).toBe("only_void_after_send");
      // PV5-F1 keeps its message, first.
      expect((await patch({ value: null, status: "void" })).json().error).toBe("a value can only be cleared on a draft contract");
      expect((await row(id)).status).toBe("sent");
      expect(Number((await row(id)).value)).toBe(60000000);
      const ok = await patch({ status: "void" });
      expect(ok.statusCode, ok.body).toBe(200);
      const after = await row(id);
      expect(after.status).toBe("void");
      expect(Number(after.value)).toBe(60000000);
      // A void contract's instalments are never billed.
      expect((await detail(id)).json().schedule.instalments.map((i: { state: string; notBilledReason: string }) => [i.state, i.notBilledReason]))
        .toEqual([["not_billed", "void"], ["not_billed", "void"]]);
    });

    it("on a draft, a change of value leaves the schedule; Send checks it", async () => {
      const id = await draft(clientA);
      expect((await put(id, FIFTY)).statusCode).toBe(200);
      expect((await req("PATCH", `/api/${co}/contracts/${id}`, admin, { value: 70000000 })).statusCode).toBe(200);
      expect(await instalmentCount(id)).toBe(2);
      expect((await detail(id)).json().schedule.matchesValue).toBe(false);
      expect((await req("POST", `/api/${co}/contracts/${id}/send`, admin)).json().error).toBe("schedule_total_mismatch");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("signatures and the portal (§61.2, §61.6)", () => {
    it("both signatures copy the contract's schedule_sha256; the portal shows the schedule with the portal's states", async () => {
      const id = await sent(clientA);
      const before = await req("GET", `/api/${co}/portal/contracts/${id}`, signerA);
      expect(before.statusCode).toBe(200);
      const sched = before.json().schedule;
      expect(sched).toMatchObject({ currency: "IDR", total: 60000000, addedAfterSigning: null });
      expect(sched.scheduleSha256).toBe((await row(id)).schedule_sha256);
      expect(sched.instalments.map((i: { state: string }) => i.state)).toEqual(["scheduled", "scheduled"]);
      // Never an instalment id or a claim time.
      for (const i of sched.instalments) {
        expect(Object.keys(i).sort()).toEqual(["amount", "due", "invoice", "label", "position", "state"]);
      }
      await signBoth(id);
      const sigs = (await adminPool().query<{ party: string; schedule_sha256: string | null }>(
        `SELECT party, schedule_sha256 FROM contract_signatures WHERE contract_id = $1 ORDER BY party`, [id],
      )).rows;
      const sha = (await row(id)).schedule_sha256;
      expect(sigs).toEqual([{ party: "client", schedule_sha256: sha }, { party: "provider", schedule_sha256: sha }]);
      expect((await detail(id)).json().signatures.map((s: { scheduleSha256: string }) => s.scheduleSha256)).toEqual([sha, sha]);
      // Signed: the on-signing instalment is due (dated the signing day); the dated one is upcoming (portal: "Due <date>").
      const after = (await req("GET", `/api/${co}/portal/contracts/${id}`, signerA)).json().schedule.instalments;
      expect(after.map((i: { state: string }) => i.state)).toEqual(["due", "upcoming"]);
      expect(after[0].due.on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const staff = (await detail(id)).json();
      expect(staff.schedule.instalments.map((i: { state: string }) => i.state)).toEqual(["due", "upcoming"]);
      expect(staff.scheduleAddable).toBe(false);
    });

    it("a contact of another client, or scoped to another project, gets 404 for the contract and its schedule", async () => {
      const id = await sent(clientA, FIFTY, { projectId: projectA1 });
      expect((await req("GET", `/api/${co}/portal/contracts/${id}`, signerB)).statusCode).toBe(404);
      expect((await req("GET", `/api/${co}/portal/contracts/${id}`, scopedA)).statusCode).toBe(404);
      expect((await req("GET", `/api/${co}/portal/contracts/${id}`, signerA)).json().schedule.instalments).toHaveLength(2);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("the addition after signing (§61.4a, DW-D49)", () => {
    const ROWS = [
      { label: "Deposit", amount: 30000000, due: "on_signing" },
      { label: "Balance", amount: 30000000, due: PAST },
    ];

    it("adds once: who and when recorded, the hash fixed, the activity and the event; signatures keep a NULL hash", async () => {
      const id = await legacy(clientA);
      const d0 = (await detail(id)).json();
      expect(d0).toMatchObject({ schedule: null, scheduleAddable: true, scheduleSummary: null });

      const r = await addAfter(id, ROWS);
      expect(r.statusCode, r.body).toBe(201);
      const k = await row(id);
      expect(k.schedule_added_by).toBe(admin);
      expect(k.schedule_added_at).not.toBeNull();
      expect(k.schedule_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(k.schedule_sha256).toBe(k.computed);
      expect(r.json()).toMatchObject({
        total: 60000000, matchesValue: true, scheduleSha256: k.schedule_sha256,
        addedAfterSigning: { by: { id: admin } },
      });
      // Signed: the on-signing row and the row dated in the past are due at once.
      expect(r.json().instalments.map((i: { state: string }) => i.state)).toEqual(["due", "due"]);
      expect((await activity(id, "schedule_added_after_signing"))[0]).toMatchObject({
        actor_id: admin, metadata: { count: 2, total: "60000000", scheduleSha256: k.schedule_sha256 },
      });
      const ev = await adminPool().query(
        `SELECT payload FROM outbox_events WHERE entity_id = $1 AND event_type = 'contract.schedule_added'`, [id],
      );
      expect(ev.rows).toHaveLength(1);
      expect(ev.rows[0].payload).toMatchObject({ clientId: clientA });
      const sigs = (await adminPool().query(`SELECT schedule_sha256 FROM contract_signatures WHERE contract_id = $1`, [id])).rows;
      expect(sigs).toHaveLength(2);
      expect(sigs.every((s: { schedule_sha256: string | null }) => s.schedule_sha256 === null)).toBe(true);
      expect((await detail(id)).json().scheduleAddable).toBe(false);

      // The portal says it was added after signing, with the date only, never who.
      const p = (await req("GET", `/api/${co}/portal/contracts/${id}`, signerA)).json().schedule;
      expect(p.addedAfterSigning).toEqual({ on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
      expect(JSON.stringify(p)).not.toContain(admin);

      // Once: a second addition is refused, and so is a PUT, and the database freezes the who and when (PD613).
      const again = await addAfter(id, ROWS);
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toBe("schedule_exists");
      expect((await put(id, ROWS)).json().error).toBe("schedule_frozen");
      await expect(adminPool().query(`UPDATE contracts SET schedule_added_at = now() - interval '1 day' WHERE id = $1`, [id]))
        .rejects.toMatchObject({ code: "PD613" });
      expect(await instalmentCount(id)).toBe(2);
    });

    it("authorization first: a manager, the editor-only role and the invoicer-only role get 403, even with an invalid body", async () => {
      const id = await legacy(clientA);
      for (const who of [manager, member, editorOnly, invoicerOnly]) {
        expect((await addAfter(id, "x", who)).statusCode, who).toBe(403);
        expect((await addAfter(id, ROWS, who)).statusCode, who).toBe(403);
      }
      expect(await instalmentCount(id)).toBe(0);
      // Positive controls: each one-right role passes its own half elsewhere.
      const draftId = await draft(clientA);
      expect((await put(draftId, FIFTY, editorOnly)).statusCode).toBe(200);
      const inv = await req("POST", `/api/${co}/invoices`, invoicerOnly, { source: "instalments", clientId: newId(), instalmentIds: [newId()] });
      expect(inv.statusCode, inv.body).toBe(404); // past `invoice` `create`: the client does not exist
    });

    it("refusals in order: envelope, 404, not signed, closed, superseded, exists, no value, the body, the total", async () => {
      const code = async (id: string, rows: unknown = ROWS) => {
        const r = await addAfter(id, rows);
        return `${r.statusCode} ${r.json().error}`;
      };
      // Through the hub's identity envelope (an agent or n8n acting for the admin): a person's act only.
      const target = await legacy(clientA);
      const obo = await app.inject({
        method: "POST", url: `/api/${co}/contracts/${target}/schedule/after-signing`,
        headers: { ...svc, "x-obo-provider": ADMIN_OBO.provider, "x-obo-external-id": ADMIN_OBO.externalId, "x-obo-agent": "agent:billing" },
        payload: { instalments: ROWS },
      });
      expect(obo.statusCode, obo.body).toBe(400);
      expect(obo.json().error).toBe("not_allowed_via_automation");

      expect(await code(newId())).toBe("404 contract_not_found");
      expect(await code(await draft(clientA))).toBe("409 contract_not_signed");
      expect(await code(await sent(clientA))).toBe("409 contract_not_signed");
      expect(await code(await legacy(clientA, { status: "void" }))).toBe("409 contract_closed");
      expect(await code(await legacy(clientA, { status: "expired" }))).toBe("409 contract_closed");
      expect(await code(await legacy(clientA, { status: "declined", cols: { decline_reason: "no" } }))).toBe("409 contract_closed");
      const old = await legacy(clientA);
      await legacy(clientA, { cols: { supersedes_id: old, version: 2 } });
      expect(await code(old)).toBe("409 contract_superseded");
      const fixedAtSend = await sent(clientA);
      await signBoth(fixedAtSend);
      expect(await code(fixedAtSend)).toBe("409 schedule_exists");
      expect(await code(await legacy(clientA, { value: null }))).toBe("400 schedule_needs_value");
      expect(await code(await legacy(clientA, { value: "0" }))).toBe("400 schedule_needs_value");
      const t = await legacy(clientA);
      expect(await code(t, [])).toBe("400 schedule_invalid");
      expect(await code(t, [{ label: "A", amount: 1, due: PAST }, { label: "B", amount: 1, due: "on_signing" }])).toBe("400 schedule_order_invalid");
      expect(await code(t, [{ label: "A", amount: "60000000.5", due: "on_signing" }])).toBe("400 schedule_precision");
      const mismatch = await addAfter(t, [{ label: "A", amount: 1000, due: "on_signing" }]);
      expect(mismatch.statusCode).toBe(400);
      expect(mismatch.json()).toMatchObject({ error: "schedule_total_mismatch", detail: { value: 60000000, total: 1000 } });
      // Nothing was written by any refusal.
      expect(await instalmentCount(t)).toBe(0);
      expect((await row(t)).schedule_added_at).toBeNull();
      expect((await row(target)).schedule_added_at).toBeNull();
    });

    it("two concurrent additions to one contract: exactly one commits, the other answers 409 and writes nothing", async () => {
      const id = await legacy(clientA);
      const other = [{ label: "All of it", amount: 60000000, due: "on_signing" }];
      const [a, b] = await Promise.all([addAfter(id, ROWS), addAfter(id, other)]);
      const statuses = [a.statusCode, b.statusCode].sort();
      expect(statuses, `${a.body} | ${b.body}`).toEqual([201, 409]);
      const loser = a.statusCode === 409 ? a : b;
      expect(["schedule_exists", "schedule_changed"]).toContain(loser.json().error);
      const winnerRows = (a.statusCode === 201 ? ROWS : other).length;
      expect(await instalmentCount(id)).toBe(winnerRows);
      const k = await row(id);
      expect(k.schedule_sha256).toBe(k.computed);
    });
  });
});
