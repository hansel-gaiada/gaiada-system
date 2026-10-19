// DW-10f-1 (BFF §61.2, §61.4a, §61.12, §61.14) — migration 202610181100_contract_instalments.sql against a REAL Postgres.
//
// What it proves, each refusal by its SQLSTATE (a code nobody else raises, so a pass cannot be a coincidence):
//   * the schedule and the send: contract_schedule_sha256()'s canonical form (pinned against a hash computed here from the
//     exact jsonb text), the CHECKs, and contracts_schedule_on_send (PD612: no schedule, a total that does not add up, rows
//     on an unvalued contract, a missing or wrong hash);
//   * the freeze: contract_instalments_guard (PD610: insert, amount, delete after send) and contracts_terms_frozen (PD613);
//   * the claim: every PD611 path (another client, another currency, issued, void, lines that lack the instalment or carry
//     another amount, an unsigned or superseded contract, a move, a release while live, a cross-company claim), two
//     concurrent claims of one instalment (exactly one wins), release on PATCH-void, on the issued-invoice void, on soft and
//     hard delete, and the un-void refusal (PD614);
//   * DW-D49: the addition's two steps, every PD618 path (including an addition left open, refused at COMMIT), PD613 on
//     any later change, PD610 on any other insert, and two concurrent additions (exactly one commits);
//   * RLS: the zero-row trap (no tenant set reads nothing) and another company's rows stay invisible;
//   * the migration applies a second time, every assertion holding, with no row changed.
// Everything runs as the NOSUPERUSER NOBYPASSRLS app role inside withTenants, except `adminPool()` (superuser), used only to
// read what is really stored and to re-apply the migration. Needs DATABASE_URL_TEST (the Linux gate); skips without it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, newId } from "./index";
import { config } from "../config";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createClient, createUser } from "../testing/fixtures";
import { FIXTURE_TERMS, fixedContentCols, scheduleContract, insertSentContractWithSchedule } from "../testing/contract-fixtures";
import { ensureBillingSetup, SEED_SERVICE_LINES } from "../seed/billing-setup";
import { issueInvoice, voidIssuedInvoice } from "../modules/invoice/issue";

const MIGRATION = path.resolve(__dirname, "../../migrations/202610181100_contract_instalments.sql");
const HASH = "a".repeat(64);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const codeOf = (e: unknown) => (e as { code?: string } | undefined)?.code;

describe.skipIf(!TEST_URL)("DW-10f-1 · contract_instalments, the schedule hash, the claim and DW-D49 (202610181100)", () => {
  let A: string; // the agency
  let B: string; // a second company
  let CA: string; // a client of A
  let CA2: string; // another client of A
  let CB: string; // a client of B
  let actor: string;

  const q = (tenant: string, sql: string, params: unknown[] = []) => withTenants([tenant], (c) => c.query(sql, params));
  const insert = async (c: PoolClient, table: string, row: Record<string, unknown>) => {
    const names = Object.keys(row);
    await c.query(
      `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
      names.map((n) => row[n]),
    );
  };

  /** A draft contract of `client` in `tenant`. */
  async function draft(value: string | null, o: { tenant?: string; client?: string; currency?: string; cols?: Record<string, unknown> } = {}) {
    const id = newId();
    const tenant = o.tenant ?? A;
    await withTenants([tenant], (c) =>
      insert(c, "contracts", {
        id, tenant_id: tenant, client_id: o.client ?? CA, title: "DW-10f-1 agreement", status: "draft", body_md: FIXTURE_TERMS,
        value, currency: o.currency ?? "IDR", origin_site: config.originSite, ...(o.cols ?? {}),
      }),
    );
    return id;
  }
  const schedule = (k: string, rows: Array<{ label?: string; amount: string; due: string }>, tenant = A) =>
    withTenants([tenant], (c) => scheduleContract(c, tenant, k, rows.map((r, i) => ({ label: r.label ?? `Instalment ${i + 1}`, ...r }))));
  /** The send's UPDATE, as contracts.controller.ts writes it; `hash` replaces the hash expression for the refusal cases. */
  const send = (k: string, hash = "contract_schedule_sha256(id, currency, value)") =>
    q(A, `UPDATE contracts SET status = 'sent', sent_at = now(), content_sha256 = $2, content_fixed_at = now(),
                 signature_tier = 'attested', schedule_sha256 = ${hash}, updated_at = now() WHERE id = $1`,
      [k, createHash("sha256").update(FIXTURE_TERMS, "utf8").digest("hex")]);
  const sign = (k: string) => q(A, `UPDATE contracts SET status = 'signed', signed_at = now() WHERE id = $1`, [k]);
  const instalments = async (k: string) =>
    (await adminPool().query<{ id: string; amount: string; position: number; invoice_id: string | null; claimed_at: Date | null }>(
      `SELECT id, amount::text AS amount, position, invoice_id, claimed_at FROM contract_instalments WHERE contract_id = $1 ORDER BY position`, [k],
    )).rows;
  /** A signed 50/50 agreement of CA (value 120,000,000 IDR), sent through the real send UPDATE. */
  async function signedFiftyFifty(client = CA) {
    const k = await draft("120000000", { client });
    await schedule(k, [{ label: "Deposit (50%)", amount: "60000000", due: "on_signing" }, { label: "Balance (50%)", amount: "60000000", due: "2026-12-31" }]);
    await send(k);
    await sign(k);
    return { k, rows: await instalments(k) };
  }
  type Line = Record<string, unknown>;
  const line = (k: string, i: { id: string; amount: string }, amount: number | string = Number(i.amount)): Line =>
    ({ kind: "instalment", description: "Fixture instalment", contractId: k, instalmentId: i.id, projectId: null, amount });
  async function invoice(lines: Line[], o: { tenant?: string; client?: string; status?: string; currency?: string } = {}) {
    const id = newId();
    const tenant = o.tenant ?? A;
    const total = lines.reduce((s, l) => s + Number(l.amount ?? 0), 0);
    await withTenants([tenant], (c) =>
      insert(c, "invoices", {
        id, tenant_id: tenant, client_id: o.client ?? CA, status: o.status ?? "draft", currency: o.currency ?? "IDR",
        period_start: "2026-01-01", period_end: "2026-12-31",
        lines: JSON.stringify(lines), total, origin_site: config.originSite, created_by: actor, updated_by: actor,
      }),
    );
    return id;
  }
  const claim = (inst: string, inv: string, tenant = A) =>
    q(tenant, `UPDATE contract_instalments SET invoice_id = $2, claimed_at = now() WHERE id = $1`, [inst, inv]);
  const claimOf = async (inst: string) =>
    (await adminPool().query<{ invoice_id: string | null; claimed_at: Date | null }>(
      `SELECT invoice_id, claimed_at FROM contract_instalments WHERE id = $1`, [inst])).rows[0];

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("DW-10f-1 Agency");
    B = await createCompany("DW-10f-1 Other company");
    CA = await createClient(A, "DW-10f-1 Client A");
    CA2 = await createClient(A, "DW-10f-1 Client A2");
    CB = await createClient(B, "DW-10f-1 Client B");
    actor = await createUser("finance.actor@dw10f1.test");
  }, 120_000);
  afterAll(teardownTestDb);

  // ── the schedule, its hash and the send ─────────────────────────────────────────────────────────────────────────────
  describe("the schedule and the send (PD612)", () => {
    it("contract_schedule_sha256() is the SHA-256 of the canonical jsonb text, scale-trimmed, in position order", async () => {
      const k = await draft("120000000");
      await schedule(k, [{ label: "Deposit (50%)", amount: "60000000", due: "on_signing" }, { label: "Balance (50%)", amount: "60000000.0000", due: "2026-12-31" }]);
      const canonical =
        '{"v": 1, "value": 120000000, "currency": "IDR", "instalments": [' +
        '{"due": "on_signing", "label": "Deposit (50%)", "amount": 60000000, "position": 1}, ' +
        '{"due": "2026-12-31", "label": "Balance (50%)", "amount": 60000000, "position": 2}]}';
      const want = createHash("sha256").update(canonical, "utf8").digest("hex");
      const got = await q(A, `SELECT contract_schedule_sha256($1, 'IDR', 120000000.0000::numeric) AS h`, [k]);
      expect(got.rows[0].h).toBe(want);
      // No instalments: NULL (an NDA, a no-fee agreement).
      const none = await draft(null);
      expect((await q(A, `SELECT contract_schedule_sha256($1, 'IDR', NULL) AS h`, [none])).rows[0].h).toBeNull();
    });

    it("the CHECKs: one on-signing row, a positive amount, positions 1 to 60, a label, a date exactly for a dated row", async () => {
      const k = await draft("100");
      await schedule(k, [{ amount: "50", due: "on_signing" }]);
      const row = (o: Record<string, unknown>) =>
        withTenants([A], (c) => insert(c, "contract_instalments", {
          id: newId(), tenant_id: A, contract_id: k, position: 2, label: "x", amount: "1", due_kind: "date", due_on: "2027-01-01", ...o,
        }));
      await expect(row({ due_kind: "on_signing", due_on: null })).rejects.toThrow(/ux_contract_instalments_on_signing/);
      await expect(row({ amount: "0" })).rejects.toThrow(/contract_instalments_amount_ck/);
      await expect(row({ position: 61 })).rejects.toThrow(/contract_instalments_position_ck/);
      await expect(row({ position: 0 })).rejects.toThrow(/contract_instalments_position_ck/);
      await expect(row({ label: "   " })).rejects.toThrow(/contract_instalments_label_ck/);
      await expect(row({ label: "x".repeat(121) })).rejects.toThrow(/contract_instalments_label_ck/);
      await expect(row({ due_on: null })).rejects.toThrow(/contract_instalments_due_ck/);
      await expect(row({ due_kind: "on_signing", due_on: "2027-01-01", position: 3 })).rejects.toThrow(/contract_instalments_due_ck|ux_contract_instalments_on_signing/);
      await expect(row({ position: 1 })).rejects.toThrow(/ux_contract_instalments_position/);
      await expect(row({ invoice_id: newId(), claimed_at: new Date() })).rejects.toMatchObject({ code: "PD611" });
      // A draft carries no schedule hash.
      await expect(q(A, `UPDATE contracts SET schedule_sha256 = $2 WHERE id = $1`, [k, HASH])).rejects.toThrow(/contracts_schedule_draft_unset/);
    });

    it("refuses a valued send whose schedule is missing or does not add up, rows on an unvalued one, and a missing or wrong hash", async () => {
      const short = await draft("100");
      await schedule(short, [{ amount: "60", due: "on_signing" }]);
      await expect(send(short)).rejects.toMatchObject({ code: "PD612" });
      const none = await draft("100");
      await expect(send(none)).rejects.toMatchObject({ code: "PD612" });
      const unvalued = await draft(null);
      await schedule(unvalued, [{ amount: "5", due: "on_signing" }]);
      await expect(send(unvalued)).rejects.toMatchObject({ code: "PD612" });
      const ok = await draft("100");
      await schedule(ok, [{ amount: "40", due: "on_signing" }, { amount: "60", due: "2027-03-01" }]);
      await expect(send(ok, "NULL")).rejects.toMatchObject({ code: "PD612" });
      await expect(send(ok, `'${"b".repeat(64)}'`)).rejects.toMatchObject({ code: "PD612" });
      // Nothing was written by any refusal.
      expect((await adminPool().query(`SELECT status, schedule_sha256 FROM contracts WHERE id = ANY($1)`, [[short, none, unvalued, ok]])).rows)
        .toEqual(Array(4).fill({ status: "draft", schedule_sha256: null }));

      await send(ok);
      const stored = await adminPool().query(
        `SELECT schedule_sha256, contract_schedule_sha256(id, currency, value) AS h, status FROM contracts WHERE id = $1`, [ok]);
      expect(stored.rows[0].status).toBe("sent");
      expect(stored.rows[0].schedule_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(stored.rows[0].schedule_sha256).toBe(stored.rows[0].h);
    });

    it("an unvalued or zero-valued contract with no schedule sends with no hash", async () => {
      for (const value of [null, "0"]) {
        const k = await draft(value);
        await send(k);
        expect((await adminPool().query(`SELECT status, schedule_sha256 FROM contracts WHERE id = $1`, [k])).rows[0])
          .toEqual({ status: "sent", schedule_sha256: null });
      }
    });

    it("insertSentContractWithSchedule (the fixture) goes through the same trigger and stores the same hash", async () => {
      const out = await withTenants([A], (c) => insertSentContractWithSchedule(c, {
        tenantId: A, clientId: CA, value: "300", instalments: [{ label: "Month 1", amount: "100", due: "2027-01-31" },
          { label: "Month 2", amount: "100", due: "2027-02-28" }, { label: "Month 3", amount: "100", due: "2027-03-31" }],
      }));
      expect(out.instalmentIds).toHaveLength(3);
      const r = await adminPool().query(`SELECT status, schedule_sha256 = contract_schedule_sha256(id, currency, value) AS same FROM contracts WHERE id = $1`, [out.contractId]);
      expect(r.rows[0]).toEqual({ status: "sent", same: true });
      await expect(withTenants([A], (c) => insertSentContractWithSchedule(c, {
        tenantId: A, clientId: CA, value: "300", instalments: [{ label: "Short", amount: "100", due: "on_signing" }],
      }))).rejects.toMatchObject({ code: "PD612" });
    });
  });

  // ── the freeze ──────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("after send the schedule and the terms are frozen (PD610, PD613)", () => {
    let k: string;
    beforeAll(async () => {
      k = await draft("100");
      await schedule(k, [{ amount: "100", due: "on_signing" }]);
      await send(k);
    });

    it("a direct INSERT, an UPDATE of amount and a DELETE raise PD610; touching updated_at does not", async () => {
      await expect(schedule(k, [{ amount: "1", due: "2027-01-01" }])).rejects.toMatchObject({ code: "PD610" });
      await expect(q(A, `UPDATE contract_instalments SET amount = 1 WHERE contract_id = $1`, [k])).rejects.toMatchObject({ code: "PD610" });
      await expect(q(A, `UPDATE contract_instalments SET label = 'Renamed' WHERE contract_id = $1`, [k])).rejects.toMatchObject({ code: "PD610" });
      await expect(q(A, `DELETE FROM contract_instalments WHERE contract_id = $1`, [k])).rejects.toMatchObject({ code: "PD610" });
      await expect(q(A, `UPDATE contract_instalments SET updated_at = now() WHERE contract_id = $1`, [k])).resolves.toBeDefined();
      expect(await instalments(k)).toHaveLength(1);
    });

    it("value, currency, term, client, project, links and the hash raise PD613; title and status (void) do not", async () => {
      for (const set of ["value = 1", "currency = 'USD'", "ends_on = '2030-01-01'", "starts_on = '2020-01-01'", "client_id = '" + CA2 + "'",
                         "version = 2", `schedule_sha256 = '${HASH}'`, "status = 'void', value = 5"]) {
        await expect(q(A, `UPDATE contracts SET ${set} WHERE id = $1`, [k]), set).rejects.toMatchObject({ code: "PD613" });
      }
      await expect(q(A, `UPDATE contracts SET title = 'Renamed after send' WHERE id = $1`, [k])).resolves.toBeDefined();
      // PV-5's content freeze is untouched.
      await expect(q(A, `UPDATE contracts SET body_md = 'changed' WHERE id = $1`, [k])).rejects.toThrow(/PV5_CONTRACT_CONTENT_FIXED/);
      const v = await draft("100");
      await schedule(v, [{ amount: "100", due: "on_signing" }]);
      await send(v);
      await expect(q(A, `UPDATE contracts SET status = 'void' WHERE id = $1`, [v])).resolves.toBeDefined();
      expect((await adminPool().query(`SELECT value::text AS value, status FROM contracts WHERE id = $1`, [v])).rows[0]).toEqual({ value: "100", status: "void" });
    });

    it("an amendment with its own value and schedule is sent and signed on its own; the amended agreement's rows do not move", async () => {
      const { k: agreement, rows: before } = await signedFiftyFifty();
      const am = await draft("25000000", { cols: { kind: "amendment", amends_id: agreement } });
      await schedule(am, [{ label: "Change fee", amount: "25000000", due: "on_signing" }]);
      await send(am);
      await sign(am);
      expect((await instalments(am)).map((r) => r.amount)).toEqual(["25000000.0000"]);
      expect(await instalments(agreement)).toEqual(before);
    });
  });

  // ── the claim ───────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("the claim (PD611), its release and the un-void refusal (PD614)", () => {
    it("refuses a claim that does not hold", async () => {
      const { k, rows: [i1] } = await signedFiftyFifty();
      await expect(claim(i1.id, await invoice([line(k, i1)], { client: CA2 }))).rejects.toMatchObject({ code: "PD611" }); // another client
      await expect(claim(i1.id, await invoice([line(k, i1)], { currency: "USD" }))).rejects.toMatchObject({ code: "PD611" }); // another currency
      await expect(claim(i1.id, await invoice([line(k, i1)], { status: "void" }))).rejects.toMatchObject({ code: "PD611" }); // void
      await expect(claim(i1.id, await invoice([{ description: "Hours", hours: 1, rate: 1, amount: 1 }]))).rejects.toMatchObject({ code: "PD611" }); // lacks it
      await expect(claim(i1.id, await invoice([line(k, i1, 5)]))).rejects.toMatchObject({ code: "PD611" }); // another amount
      await expect(claim(i1.id, await invoice([line(k, i1), line(k, i1)]))).rejects.toMatchObject({ code: "PD611" }); // named twice
      await expect(claim(i1.id, newId())).rejects.toMatchObject({ code: "PD611" }); // no such invoice
      // An unsigned (sent) contract.
      const sentK = await draft("10");
      await schedule(sentK, [{ amount: "10", due: "on_signing" }]);
      await send(sentK);
      const [s1] = await instalments(sentK);
      await expect(claim(s1.id, await invoice([line(sentK, s1)]))).rejects.toMatchObject({ code: "PD611" });
      expect((await claimOf(i1.id)).invoice_id).toBeNull();
    });

    it("refuses a claim onto an ISSUED invoice", async () => {
      await ensureBillingSetup(A);
      const { k, rows: [i1] } = await signedFiftyFifty();
      const inv = await invoice([line(k, i1)], { status: "approved" });
      await q(A, `UPDATE invoices SET approved_by = $2, approved_at = now(), service_line_key = $3 WHERE id = $1`, [inv, actor, SEED_SERVICE_LINES[0][0]]);
      // DW-10f-3a: issue readiness now refuses an instalment line its invoice does not claim (INSTALMENT_LINES_INVALID),
      // so the invoice is issued WITH its claim, and the claim is then cleared behind the guard (superuser, trigger off)
      // to leave an issued invoice and an unclaimed instalment for the guard to judge. The guard is skipped for THIS session's
      // transaction only (`session_replication_role = replica`, superuser), never with ALTER TABLE ... DISABLE TRIGGER, which
      // would switch it off for every suite running in parallel against the same database.
      await claim(i1.id, inv);
      await issueInvoice(A, inv, actor);
      const sc = await adminPool().connect();
      try {
        await sc.query("BEGIN");
        await sc.query("SET LOCAL session_replication_role = replica");
        await sc.query(`UPDATE contract_instalments SET invoice_id = NULL, claimed_at = NULL WHERE id = $1`, [i1.id]);
        await sc.query("COMMIT");
      } catch (e) {
        await sc.query("ROLLBACK");
        throw e;
      } finally {
        sc.release();
      }
      await expect(claim(i1.id, inv)).rejects.toMatchObject({ code: "PD611" });
    });

    it("refuses a cross-company claim, even with both companies in the tenant set", async () => {
      const { k, rows: [i1] } = await signedFiftyFifty();
      const invB = await invoice([line(k, i1)], { tenant: B, client: CB });
      await expect(claim(i1.id, invB)).rejects.toMatchObject({ code: "PD611" });
      await expect(withTenants([A, B], (c) => c.query(`UPDATE contract_instalments SET invoice_id = $2, claimed_at = now() WHERE id = $1`, [i1.id, invB]),
        { crossRoot: { reason: "DW-10f-1 test: a cross-company claim with both companies visible is still refused" } }))
        .rejects.toMatchObject({ code: "PD611" });
      // B's session cannot even see A's instalment: the UPDATE matches nothing.
      expect((await claim(i1.id, invB, B)).rowCount).toBe(0);
      expect((await claimOf(i1.id)).invoice_id).toBeNull();
    });

    it("claims on a draft and an approved invoice; refuses a move and a release while live; void releases; un-void is PD614", async () => {
      const { k, rows: [i1, i2] } = await signedFiftyFifty();
      const inv = await invoice([line(k, i1), line(k, i2)]);
      await claim(i1.id, inv);
      await claim(i2.id, inv);
      expect((await claimOf(i1.id)).claimed_at).not.toBeNull();
      const other = await invoice([line(k, i1)]);
      await expect(claim(i1.id, other)).rejects.toMatchObject({ code: "PD611" }); // a move
      await expect(q(A, `UPDATE contract_instalments SET invoice_id = NULL, claimed_at = NULL WHERE id = $1`, [i1.id])).rejects.toMatchObject({ code: "PD611" });
      await expect(q(A, `UPDATE contract_instalments SET claimed_at = now() - interval '1 day' WHERE id = $1`, [i1.id])).rejects.toMatchObject({ code: "PD611" });
      await q(A, `UPDATE invoices SET status = 'approved' WHERE id = $1`, [inv]);
      expect((await claimOf(i1.id)).invoice_id).toBe(inv);

      await q(A, `UPDATE invoices SET status = 'void' WHERE id = $1`, [inv]); // PATCH {status: 'void'}'s write
      expect(await claimOf(i1.id)).toEqual({ invoice_id: null, claimed_at: null });
      expect(await claimOf(i2.id)).toEqual({ invoice_id: null, claimed_at: null });
      await expect(q(A, `UPDATE invoices SET status = 'draft' WHERE id = $1`, [inv])).rejects.toMatchObject({ code: "PD614" });
      // An hourly invoice keeps today's behaviour.
      const hourly = await invoice([{ description: "Hours", hours: 1, rate: 1, amount: 1 }], { status: "void" });
      await expect(q(A, `UPDATE invoices SET status = 'draft' WHERE id = $1`, [hourly])).resolves.toBeDefined();
      // Drafting again works once released.
      await claim(i1.id, other);
      expect((await claimOf(i1.id)).invoice_id).toBe(other);
    });

    it("soft delete releases (and un-delete is PD614); a hard-deleted draft releases through the FK, clearing claimed_at", async () => {
      const { k, rows: [i1] } = await signedFiftyFifty();
      const soft = await invoice([line(k, i1)]);
      await claim(i1.id, soft);
      await q(A, `UPDATE invoices SET deleted_at = now() WHERE id = $1`, [soft]);
      expect(await claimOf(i1.id)).toEqual({ invoice_id: null, claimed_at: null });
      await expect(q(A, `UPDATE invoices SET deleted_at = NULL WHERE id = $1`, [soft])).rejects.toMatchObject({ code: "PD614" });
      const hard = await invoice([line(k, i1)]);
      await claim(i1.id, hard);
      await q(A, `DELETE FROM invoices WHERE id = $1`, [hard]);
      expect(await claimOf(i1.id)).toEqual({ invoice_id: null, claimed_at: null });
    });

    it("voiding an ISSUED invoice (POST …/void, the credit note) releases its instalments", async () => {
      await ensureBillingSetup(A);
      const { k, rows: [i1, i2] } = await signedFiftyFifty();
      const inv = await invoice([line(k, i1), line(k, i2)]);
      await claim(i1.id, inv);
      await claim(i2.id, inv);
      await q(A, `UPDATE invoices SET status = 'approved', approved_by = $2, approved_at = now(), service_line_key = $3 WHERE id = $1`,
        [inv, actor, SEED_SERVICE_LINES[0][0]]);
      await issueInvoice(A, inv, actor);
      expect((await adminPool().query(`SELECT status, issued_at IS NOT NULL AS issued FROM invoices WHERE id = $1`, [inv])).rows[0])
        .toEqual({ status: "sent", issued: true });
      expect((await claimOf(i1.id)).invoice_id).toBe(inv); // issuing keeps the claim
      await voidIssuedInvoice(A, inv, actor, "DW-10f-1 fixture void");
      expect(await claimOf(i1.id)).toEqual({ invoice_id: null, claimed_at: null });
      expect(await claimOf(i2.id)).toEqual({ invoice_id: null, claimed_at: null });
    });

    it("a signed superseding version stops the old instalments being claimed", async () => {
      const { k, rows: [i1] } = await signedFiftyFifty();
      await withTenants([A], (c) => insert(c, "contracts", {
        id: newId(), tenant_id: A, client_id: CA, title: "v2", status: "signed", version: 2, supersedes_id: k,
        sent_at: new Date(), signed_at: new Date(), origin_site: config.originSite, ...fixedContentCols(),
      }));
      await expect(claim(i1.id, await invoice([line(k, i1)]))).rejects.toMatchObject({ code: "PD611" });
    });

    it("two concurrent claims of one instalment: exactly one wins (the handler's form, and the plain form)", async () => {
      for (const guarded of [true, false]) {
        const { k, rows: [i1] } = await signedFiftyFifty();
        const x = await invoice([line(k, i1)]);
        const y = await invoice([line(k, i1)]);
        const sql = `UPDATE contract_instalments SET invoice_id = $2, claimed_at = now() WHERE id = $1${guarded ? " AND invoice_id IS NULL" : ""}`;
        const results = await Promise.allSettled([
          withTenants([A], async (c) => {
            const r = await c.query(sql, [i1.id, x]);
            await c.query("SELECT pg_sleep(0.4)"); // hold the row lock while the other claim arrives
            return r.rowCount;
          }),
          (async () => {
            await sleep(120);
            return withTenants([A], async (c) => (await c.query(sql, [i1.id, y])).rowCount);
          })(),
        ]);
        const final = (await claimOf(i1.id)).invoice_id;
        expect([x, y]).toContain(final);
        if (guarded) {
          const counts = results.map((r) => (r.status === "fulfilled" ? r.value : "rejected"));
          expect(counts.slice().sort()).toEqual([0, 1]);
          expect(final).toBe(counts[0] === 1 ? x : y);
        } else {
          const fulfilled = results.filter((r) => r.status === "fulfilled");
          const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
          expect(fulfilled).toHaveLength(1);
          expect(rejected).toHaveLength(1);
          expect(codeOf(rejected[0].reason)).toBe("PD611"); // the loser re-reads a claimed row: a move
        }
      }
    });
  });

  // ── DW-D49 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("DW-D49: a schedule added once to a signed contract (PD618, PD613, PD610)", () => {
    /** A contract as one sent before 10f: inserted already sent or signed, with its content fixed and no schedule. */
    async function legacy(status: "sent" | "signed" | "void" | "declined" | "expired", value: string | null = "50000000") {
      const id = newId();
      await withTenants([A], (c) => insert(c, "contracts", {
        id, tenant_id: A, client_id: CA, title: "Signed before 10f", status, value, currency: "IDR", sent_at: new Date(),
        signed_at: status === "signed" ? new Date() : null, origin_site: config.originSite, ...fixedContentCols(),
      }));
      return id;
    }
    const open = (c: PoolClient, k: string, by = actor) =>
      c.query(`UPDATE contracts SET schedule_added_at = now(), schedule_added_by = $2 WHERE id = $1`, [k, by]);
    const add = (c: PoolClient, k: string, rows: Array<{ amount: string; due: string }>) =>
      scheduleContract(c, A, k, rows.map((r, i) => ({ label: `Added ${i + 1}`, ...r })));
    const close = (c: PoolClient, k: string, hash = "contract_schedule_sha256(id, currency, value)") =>
      c.query(`UPDATE contracts SET schedule_sha256 = ${hash} WHERE id = $1`, [k]);

    it("the addition: open, insert, close in one transaction; who, when and the hash are stored; signatures keep a NULL hash", async () => {
      const k = await legacy("signed");
      await withTenants([A], (c) => insert(c, "contract_signatures", {
        id: newId(), tenant_id: A, contract_id: k, party: "client", signer_name: "Client Signer", origin_site: config.originSite,
        content_sha256: fixedContentCols().content_sha256,
      }));
      await withTenants([A], async (c) => {
        await open(c, k);
        await add(c, k, [{ amount: "25000000", due: "on_signing" }, { amount: "25000000", due: "2020-01-31" }]);
        await close(c, k);
      });
      const r = (await adminPool().query(
        `SELECT schedule_added_by, schedule_added_at IS NOT NULL AS at, schedule_sha256 = contract_schedule_sha256(id, currency, value) AS same
           FROM contracts WHERE id = $1`, [k])).rows[0];
      expect(r).toEqual({ schedule_added_by: actor, at: true, same: true });
      expect((await adminPool().query(`SELECT schedule_sha256 FROM contract_signatures WHERE contract_id = $1`, [k])).rows)
        .toEqual([{ schedule_sha256: null }]);

      // Afterwards: frozen exactly like a schedule fixed at send.
      await expect(withTenants([A], (c) => open(c, k))).rejects.toMatchObject({ code: "PD613" }); // a second addition
      await expect(q(A, `UPDATE contracts SET schedule_added_by = NULL, schedule_added_at = NULL WHERE id = $1`, [k])).rejects.toMatchObject({ code: "PD613" });
      await expect(q(A, `UPDATE contracts SET schedule_added_by = $2 WHERE id = $1`, [k, await createUser("other.finance@dw10f1.test")])).rejects.toMatchObject({ code: "PD613" });
      await expect(q(A, `UPDATE contracts SET schedule_sha256 = $2 WHERE id = $1`, [k, HASH])).rejects.toMatchObject({ code: "PD613" });
      await expect(withTenants([A], (c) => add(c, k, [{ amount: "1", due: "2030-01-01" }]))).rejects.toMatchObject({ code: "PD610" });
      await expect(q(A, `UPDATE contract_instalments SET amount = 1 WHERE contract_id = $1`, [k])).rejects.toMatchObject({ code: "PD610" });
      // Its instalments are billable like any other.
      const [i1] = await instalments(k);
      const inv = await invoice([line(k, i1)]);
      await claim(i1.id, inv);
      expect((await claimOf(i1.id)).invoice_id).toBe(inv);
    });

    it("a direct INSERT on a signed contract with no addition open raises PD610", async () => {
      const k = await legacy("signed");
      await expect(withTenants([A], (c) => add(c, k, [{ amount: "50000000", due: "on_signing" }]))).rejects.toMatchObject({ code: "PD610" });
    });

    it("opening on a contract that is not signed, has no value, is superseded or already has a schedule raises PD618", async () => {
      for (const status of ["sent", "void", "declined", "expired"] as const) {
        const k = await legacy(status);
        await expect(withTenants([A], (c) => open(c, k)), status).rejects.toMatchObject({ code: "PD618" });
      }
      await expect(withTenants([A], async (c) => open(c, await legacy("signed", null)))).rejects.toMatchObject({ code: "PD618" });
      await expect(withTenants([A], async (c) => open(c, await legacy("signed", "0")))).rejects.toMatchObject({ code: "PD618" });
      const { k: fixedAtSend } = await signedFiftyFifty();
      await expect(withTenants([A], (c) => open(c, fixedAtSend))).rejects.toMatchObject({ code: "PD618" });
      const superseded = await legacy("signed");
      await withTenants([A], (c) => insert(c, "contracts", {
        id: newId(), tenant_id: A, client_id: CA, title: "v2", status: "signed", version: 2, supersedes_id: superseded,
        sent_at: new Date(), signed_at: new Date(), origin_site: config.originSite, ...fixedContentCols(),
      }));
      await expect(withTenants([A], (c) => open(c, superseded))).rejects.toMatchObject({ code: "PD618" });
      const d = await draft("100");
      await expect(withTenants([A], (c) => open(c, d))).rejects.toThrow(/contracts_schedule_added_not_draft/);
    });

    it("closing with a wrong hash or rows that do not add up, opening and closing at once, or a step that moves the value raise PD618", async () => {
      const k = await legacy("signed");
      await expect(withTenants([A], async (c) => {
        await open(c, k); await add(c, k, [{ amount: "50000000", due: "on_signing" }]); await close(c, k, `'${HASH}'`);
      })).rejects.toMatchObject({ code: "PD618" });
      await expect(withTenants([A], async (c) => {
        await open(c, k); await add(c, k, [{ amount: "40000000", due: "on_signing" }]); await close(c, k);
      })).rejects.toMatchObject({ code: "PD618" });
      await expect(q(A, `UPDATE contracts SET schedule_added_at = now(), schedule_added_by = $2, schedule_sha256 = $3 WHERE id = $1`, [k, actor, HASH]))
        .rejects.toMatchObject({ code: "PD618" });
      await expect(q(A, `UPDATE contracts SET schedule_added_at = now(), schedule_added_by = $2, value = 1 WHERE id = $1`, [k, actor]))
        .rejects.toMatchObject({ code: "PD618" });
      await expect(q(A, `UPDATE contracts SET schedule_sha256 = $2 WHERE id = $1`, [k, HASH])).rejects.toMatchObject({ code: "PD618" }); // nothing open
      // Nothing was written by any refusal.
      expect(await instalments(k)).toHaveLength(0);
      expect((await adminPool().query(`SELECT schedule_added_at, schedule_sha256 FROM contracts WHERE id = $1`, [k])).rows[0])
        .toEqual({ schedule_added_at: null, schedule_sha256: null });
    });

    it("an addition opened and never closed fails at COMMIT with PD618 (the deferred trigger), with or without rows", async () => {
      const k = await legacy("signed");
      await expect(withTenants([A], async (c) => {
        await open(c, k); await add(c, k, [{ amount: "50000000", due: "on_signing" }]);
      })).rejects.toMatchObject({ code: "PD618" });
      await expect(withTenants([A], (c) => open(c, k))).rejects.toMatchObject({ code: "PD618" });
      expect(await instalments(k)).toHaveLength(0);
      expect((await adminPool().query(`SELECT schedule_added_at FROM contracts WHERE id = $1`, [k])).rows[0].schedule_added_at).toBeNull();
    });

    it("two concurrent additions to one contract: exactly one commits, the other writes nothing", async () => {
      const k = await legacy("signed");
      const attempt = (amounts: string[], delay: number, hold: number) => (async () => {
        await sleep(delay);
        return withTenants([A], async (c) => {
          await open(c, k);
          await c.query(`SELECT pg_sleep(${hold})`);
          await add(c, k, amounts.map((amount, i) => ({ amount, due: i === 0 ? "on_signing" : `2027-0${i}-01` })));
          await close(c, k);
          return amounts.length;
        });
      })();
      const results = await Promise.allSettled([attempt(["50000000"], 0, 0.4), attempt(["25000000", "25000000"], 120, 0)]);
      const fulfilled = results.filter((r): r is PromiseFulfilledResult<number> => r.status === "fulfilled");
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      // The racing opening re-reads a contract whose addition is already recorded: a change of schedule_added_at.
      expect(["PD613", "PD618"]).toContain(codeOf(rejected[0].reason));
      expect(await instalments(k)).toHaveLength(fulfilled[0].value);
    });
  });

  // ── RLS ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("RLS (§61.12)", () => {
    it("the zero-row trap: with no tenant set the app role reads no instalment and hashes nothing", async () => {
      const { k } = await signedFiftyFifty();
      expect((await adminPool().query(`SELECT count(*)::int AS n FROM contract_instalments`)).rows[0].n).toBeGreaterThan(0);
      const unscoped = await withTenants([], (c) =>
        c.query(`SELECT (SELECT count(*)::int FROM contract_instalments) AS n, contract_schedule_sha256($1, 'IDR', 120000000::numeric) AS h`, [k]));
      expect(unscoped.rows[0]).toEqual({ n: 0, h: null });
    });

    it("another company reads none of A's instalments and cannot write one onto A's contract", async () => {
      const { k } = await signedFiftyFifty();
      expect((await q(B, `SELECT count(*)::int AS n FROM contract_instalments WHERE contract_id = $1`, [k])).rows[0].n).toBe(0);
      const kB = await draft("10", { tenant: B, client: CB });
      await expect(withTenants([B], (c) => insert(c, "contract_instalments", {
        id: newId(), tenant_id: A, contract_id: kB, position: 1, label: "x", amount: "10", due_kind: "on_signing",
      }))).rejects.toThrow(/row-level security|schedule_frozen/);
      await expect(withTenants([B], (c) => insert(c, "contract_instalments", {
        id: newId(), tenant_id: B, contract_id: k, position: 9, label: "x", amount: "10", due_kind: "date", due_on: "2027-01-01",
      }))).rejects.toMatchObject({ code: "PD610" });
    });
  });

  // ── the migration ───────────────────────────────────────────────────────────────────────────────────────────────────
  describe("the migration", () => {
    it("applies a second time: every assertion holds and no row changes", async () => {
      const snapshot = async () => (await adminPool().query(
        `SELECT (SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]') FROM contract_instalments i) AS inst,
                (SELECT coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'status', c.status, 'h', c.schedule_sha256,
                         'at', c.schedule_added_at, 'by', c.schedule_added_by) ORDER BY c.id), '[]') FROM contracts c) AS k`,
      )).rows[0];
      const before = await snapshot();
      expect((before.inst as unknown[]).length).toBeGreaterThan(0);
      const c = await adminPool().connect();
      try {
        await c.query("BEGIN");
        await c.query(readFileSync(MIGRATION, "utf8"));
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }
      expect(await snapshot()).toEqual(before);
    });
  });
});
