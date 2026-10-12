// PV5-05 — intercompany posting for group clients. Migration 202610131840_pv5_intercompany_ar_posting.sql.
// Plan: docs/plans/2026-10-12-pv5-contracts-billing-tickets.md (finding 6, design decision 20, PV5-05).
//
// An AR customer with `counterparty_company_id` (a group client) posts to that counterparty's tagged
// `1290-*` receivable, never to the AR control account. The reconciliation identity holds PER BUCKET:
// ordinary customers against the control account, each counterparty's customers against the AR-posted
// lines on its tagged receivable. The suite is stateful, like the F4 suite: `finance_ar_reconcile()` is
// asserted EMPTY after every state change.
//
// Needs DATABASE_URL_TEST (the Linux gate). Skips without it, and a skipped run proves nothing.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, newId } from "./index";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany } from "../testing/fixtures";
import type { PoolClient } from "pg";

/** The finance module wall: a finance_* table reads ZERO rows without the declared scope. */
async function withFinance<T>(tenantIds: string[], fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenants(tenantIds, async (c) => {
    await c.query("SELECT set_config('app.scopes', 'finance', true)");
    return fn(c);
  });
}

type Line = { code: string; cp: string | null; side: string; amount: number };
type Bucket = {
  counterparty_company_id: string | null;
  receivable_accounts: string | null;
  open_invoices: string;
  payments_on_account: string;
  unapplied_credits: string;
  net_receivable: string;
  gl_balance: string;
};

describe.skipIf(!TEST_URL)("PV5-05 — intercompany AR posting for group clients (202610131840)", () => {
  let H: string; // the group's holding company
  let A: string; // the issuer: has books, bills a group client
  let V: string; // the group client's own company (the counterparty)
  let ORD: string; // ordinary AR customer of A
  let GRP: string; // group-client AR customer of A, counterparty V
  let revenue: string;
  let bank: string;
  let contraRevenue: string;
  let tagged: string; // A's 1290-* receivable tagged V, learned from the first group posting
  let seq = 0;

  // ── helpers ─────────────────────────────────────────────────────────────────────────────────────
  const reconcile = () =>
    withFinance([A], async (c) =>
      (await c.query<{ problem: string; detail: string }>("SELECT * FROM finance_ar_reconcile($1)", [A])).rows,
    );
  const position = () =>
    withFinance([A], async (c) => {
      const r = (
        await c.query<{ open_invoices: string; payments_on_account: string; unapplied_credits: string; net_receivable: string }>(
          "SELECT * FROM finance_ar_position($1)", [A],
        )
      ).rows[0];
      return {
        open: Number(r.open_invoices), onAccount: Number(r.payments_on_account),
        unapplied: Number(r.unapplied_credits), net: Number(r.net_receivable),
      };
    });
  const buckets = () =>
    withFinance([A], async (c) =>
      (await c.query<Bucket>("SELECT * FROM finance_ar_position_by_receivable($1)", [A])).rows,
    );
  /** Whole-account balance straight from the GL, independent of the subledger. */
  const balanceOf = (where: string, params: unknown[] = []) =>
    withFinance([A], async (c) =>
      Number(
        (
          await c.query<{ b: string }>(
            `SELECT coalesce(sum(m.balance),0) AS b
               FROM finance_account_movement($1, NULL, NULL) m
               JOIN finance_accounts a ON a.id = m.account_id
              WHERE ${where}`,
            [A, ...params],
          )
        ).rows[0].b,
      ),
    );
  const controlBalance = () => balanceOf("a.is_control AND a.control_subledger = 'ar'");
  const taggedBalance = () => balanceOf("a.code = $2", [tagged]);
  const lines = (entry: string) =>
    withFinance([A], async (c) =>
      (
        await c.query<{ code: string; cp: string | null; side: string; amount: string }>(
          `SELECT a.code, a.counterparty_company_id AS cp, l.side, l.amount
             FROM finance_journal_lines l JOIN finance_accounts a ON a.id = l.account_id
            WHERE l.entry_id = $1 ORDER BY l.line_no`,
          [entry],
        )
      ).rows.map((r): Line => ({ code: r.code, cp: r.cp, side: r.side, amount: Number(r.amount) })),
    );
  const scalar = async <T>(sql: string, params: unknown[]) =>
    withFinance([A], async (c) => (await c.query<{ v: T }>(sql, params)).rows[0].v);

  async function draftInvoice(customer: string, date: string, due: string, subtotal: number, tax = 0) {
    const id = newId();
    const no = `PV505-INV-${++seq}`;
    await withFinance([A], async (c) => {
      await c.query(
        `INSERT INTO finance_ar_invoices
           (id, tenant_id, customer_id, invoice_no, invoice_date, due_date, currency_code, subtotal, tax_total, total)
         VALUES ($1,$2,$3,$4,$5::date,$6::date,'IDR',$7,$8,$9)`,
        [id, A, customer, no, date, due, subtotal, tax, subtotal + tax],
      );
      await c.query(
        `INSERT INTO finance_ar_invoice_lines
           (tenant_id, invoice_id, line_no, description, quantity, unit_price, line_subtotal,
            revenue_account_id, tax_code, tax_rate, tax_amount)
         VALUES ($1,$2,1,'Services',1,$3,$3,$4,$5,$6,$7)`,
        [A, id, subtotal, revenue, tax > 0 ? "PPN" : null, tax > 0 ? 11 : null, tax],
      );
    });
    return id;
  }
  const issue = (inv: string) =>
    withFinance([A], async (c) => (await c.query<{ e: string }>("SELECT finance_ar_issue_invoice($1) AS e", [inv])).rows[0].e);

  async function receipt(customer: string, date: string, amount: number) {
    const id = newId();
    const entry = await withFinance([A], async (c) => {
      await c.query(
        `INSERT INTO finance_ar_receipts
           (id, tenant_id, customer_id, receipt_no, receipt_date, currency_code, amount, bank_account_id)
         VALUES ($1,$2,$3,$4,$5::date,'IDR',$6,$7)`,
        [id, A, customer, `PV505-RCP-${++seq}`, date, amount, bank],
      );
      return (await c.query<{ e: string }>("SELECT finance_ar_record_receipt($1) AS e", [id])).rows[0].e;
    });
    return { id, entry };
  }

  async function creditNote(customer: string, invoice: string | null, date: string, subtotal: number, tax: number) {
    const id = newId();
    const entry = await withFinance([A], async (c) => {
      await c.query(
        `INSERT INTO finance_ar_credit_notes
           (id, tenant_id, customer_id, credit_note_no, credit_note_date, currency_code,
            subtotal, tax_total, total, reason_code, reason, original_invoice_id)
         VALUES ($1,$2,$3,$4,$5::date,'IDR',$6,$7,$8,'discount','Agreed discount',$9)`,
        [id, A, customer, `PV505-CN-${++seq}`, date, subtotal, tax, subtotal + tax, invoice],
      );
      await c.query(
        `INSERT INTO finance_ar_credit_note_lines (tenant_id, credit_note_id, description, line_subtotal, credit_account_id)
         VALUES ($1,$2,'Discount',$3,$4)`,
        [A, id, subtotal, contraRevenue],
      );
      return (await c.query<{ e: string }>("SELECT finance_ar_issue_credit_note($1) AS e", [id])).rows[0].e;
    });
    return { id, entry };
  }

  async function writeOff(invoice: string, amount: number, date: string) {
    return withFinance([A], async (c) => {
      const wo = (
        await c.query<{ id: string }>(
          "SELECT finance_ar_write_off($1,$2,$3::date,'uncollectible','Test write-off') AS id",
          [invoice, amount, date],
        )
      ).rows[0].id;
      return (await c.query<{ e: string }>("SELECT journal_entry_id AS e FROM finance_ar_writeoffs WHERE id=$1", [wo])).rows[0].e;
    });
  }

  beforeAll(async () => {
    await initTestDb();
    // A and V share a root: reading both sides of an intercompany balance is a two-tenant read, and
    // withTenants refuses a tenant set that spans two roots.
    H = await createCompany("PV505 Holding", ["finance"]);
    A = await createCompany("PV505 Issuer", ["finance"], H);
    V = await createCompany("PV505 Group Client", ["finance"], H);
    for (const co of [H, A, V]) {
      await withFinance([co], async (c) => {
        await c.query(
          `INSERT INTO finance_company_settings (tenant_id, functional_currency, presentation_currency, fiscal_year_start_month)
           VALUES ($1,'IDR','IDR',1) ON CONFLICT (tenant_id) DO NOTHING`,
          [co],
        );
        await c.query("SELECT finance_instantiate_coa($1,'id_psak_general_v1')", [co]);
        const fy = await c.query<{ id: string }>(
          `INSERT INTO finance_fiscal_years (tenant_id, code, start_date, end_date)
           VALUES ($1,'FY2026','2026-01-01','2027-01-01') RETURNING id`,
          [co],
        );
        await c.query("SELECT finance_generate_periods($1,'monthly')", [fy.rows[0].id]);
      });
    }
    // Ownership edges, so the elimination test has a group. effective_from is explicit (the default,
    // CURRENT_DATE, would not be effective at a 2026 as-of date).
    for (const co of [A, V]) {
      await withFinance([co], (c) =>
        c.query(
          `INSERT INTO company_ownership (id, tenant_id, holder_company_id, kind, stake_pct, effective_from)
           VALUES ($1,$2,$3,'holding',100,'2026-01-01')`,
          [newId(), co, H],
        ),
      );
    }

    const acct = (code: string) => scalar<string>("SELECT id AS v FROM finance_accounts WHERE tenant_id=$1 AND code=$2", [A, code]);
    revenue = await acct("4100");
    bank = await acct("1120");
    contraRevenue = await acct("4300");

    ORD = newId();
    GRP = newId();
    await withFinance([A], (c) =>
      c.query(
        `INSERT INTO finance_ar_customers (id, tenant_id, code, name, payment_terms_days, counterparty_company_id)
         VALUES ($1,$2,'PV505-ORD','Ordinary Client',30,NULL), ($3,$2,'PV505-GRP','Group Client',30,$4)`,
        [ORD, A, GRP, V],
      ),
    );
  }, 120_000);
  afterAll(teardownTestDb);

  // ── Issue ───────────────────────────────────────────────────────────────────────────────────────
  it("an ordinary customer's invoice still debits the AR control account", async () => {
    const inv = await draftInvoice(ORD, "2026-02-01", "2026-03-03", 100_000_000, 11_000_000);
    const entry = await issue(inv);
    expect(await lines(entry)).toEqual([
      { code: "1130", cp: null, side: "debit", amount: 111_000_000 },
      { code: "4100", cp: null, side: "credit", amount: 100_000_000 },
      { code: "2140", cp: null, side: "credit", amount: 11_000_000 },
    ]);
    expect(await controlBalance()).toBe(111_000_000);
    // Nothing tagged with the counterparty exists yet: the first group posting creates it.
    expect(
      Number(await scalar<string>("SELECT count(*) AS v FROM finance_accounts WHERE tenant_id=$1 AND counterparty_company_id=$2", [A, V])),
    ).toBe(0);
    expect(await reconcile()).toEqual([]);
  });

  it("★ a group client's invoice debits the counterparty's tagged 1290-* receivable, and the control account does not move", async () => {
    const inv = await draftInvoice(GRP, "2026-02-10", "2026-03-12", 222_000_000);
    const entry = await issue(inv);
    // Learned from the resolver, not from the posting, so later tests know the account even when the
    // posting is wrong (the PV5-05 teeth commit).
    tagged = await scalar<string>("SELECT finance_ar_receivable_account($1) AS v", [GRP]);
    expect(tagged).toMatch(/^1290-[0-9A-F]{6}$/);
    // The reconciliation first: this is what the PV5-05 teeth commit turns red.
    expect(await reconcile()).toEqual([]);

    const ls = await lines(entry);
    expect(ls).toEqual([
      { code: tagged, cp: V, side: "debit", amount: 222_000_000 },
      { code: "4100", cp: null, side: "credit", amount: 222_000_000 },
    ]);

    expect(await controlBalance()).toBe(111_000_000);
    expect(await taggedBalance()).toBe(222_000_000);
    // finance_ensure_intercompany_accounts made the pair: the receivable and its payable twin.
    expect(
      Number(await scalar<string>("SELECT count(*) AS v FROM finance_accounts WHERE tenant_id=$1 AND counterparty_company_id=$2", [A, V])),
    ).toBe(2);

    const b = await buckets();
    expect(b.map((r) => [r.counterparty_company_id, Number(r.net_receivable), Number(r.gl_balance)])).toEqual([
      [null, 111_000_000, 111_000_000],
      [V, 222_000_000, 222_000_000],
    ]);
    expect(b[0].receivable_accounts).toBe("1130");
    expect(b[1].receivable_accounts).toBe(tagged);
  });

  // ── Receipts ────────────────────────────────────────────────────────────────────────────────────
  it("a receipt from the group client credits the same tagged account and clears it", async () => {
    const inv = await scalar<string>("SELECT id AS v FROM finance_ar_invoices WHERE tenant_id=$1 AND customer_id=$2", [A, GRP]);
    const r = await receipt(GRP, "2026-03-01", 222_000_000);
    expect(await lines(r.entry)).toEqual([
      { code: "1120", cp: null, side: "debit", amount: 222_000_000 },
      { code: tagged, cp: V, side: "credit", amount: 222_000_000 },
    ]);
    expect(await reconcile()).toEqual([]); // unallocated: a payment on account in bucket V
    await withFinance([A], (c) => c.query("SELECT finance_ar_allocate($1,$2,222000000)", [r.id, inv]));
    expect(await scalar<string>("SELECT status AS v FROM finance_ar_invoices WHERE id=$1", [inv])).toBe("paid");
    expect(await taggedBalance()).toBe(0);
    expect(await controlBalance()).toBe(111_000_000);
    expect(await reconcile()).toEqual([]);
  });

  it("an overpayment leaves a CREDIT on the tagged account, counted as a payment on account in its bucket", async () => {
    await receipt(GRP, "2026-03-05", 30_000_000);
    expect(await taggedBalance()).toBe(-30_000_000);
    const v = (await buckets()).find((r) => r.counterparty_company_id === V)!;
    expect(Number(v.payments_on_account)).toBe(30_000_000);
    expect(Number(v.net_receivable)).toBe(-30_000_000);
    expect(Number(v.gl_balance)).toBe(-30_000_000);
    expect((await position()).onAccount).toBe(30_000_000);
    expect(await reconcile()).toEqual([]);

    // A later taxed invoice, settled from the money already on account.
    const inv = await draftInvoice(GRP, "2026-03-10", "2026-04-09", 50_000_000, 5_500_000);
    const entry = await issue(inv);
    expect(await lines(entry)).toEqual([
      { code: tagged, cp: V, side: "debit", amount: 55_500_000 },
      { code: "4100", cp: null, side: "credit", amount: 50_000_000 },
      { code: "2140", cp: null, side: "credit", amount: 5_500_000 },
    ]);
    const onAccount = await scalar<string>(
      "SELECT id AS v FROM finance_ar_receipts WHERE tenant_id=$1 AND customer_id=$2 AND amount_allocated = 0", [A, GRP],
    );
    await withFinance([A], (c) => c.query("SELECT finance_ar_allocate($1,$2,30000000)", [onAccount, inv]));
    expect(await taggedBalance()).toBe(25_500_000);
    expect(await reconcile()).toEqual([]);
  });

  // ── Credit note and write-off ───────────────────────────────────────────────────────────────────
  it("a credit note on an intercompany invoice debits contra-revenue and VAT and credits the tagged account", async () => {
    const inv = await scalar<string>("SELECT id AS v FROM finance_ar_invoices WHERE tenant_id=$1 AND customer_id=$2 AND total=55500000", [A, GRP]);
    const cn = await creditNote(GRP, inv, "2026-03-20", 10_000_000, 1_100_000);
    expect(await lines(cn.entry)).toEqual([
      { code: "4300", cp: null, side: "debit", amount: 10_000_000 }, // contra-revenue: debit-normal, so a DEBIT reduces revenue
      { code: "2140", cp: null, side: "debit", amount: 1_100_000 },  // output VAT reversed
      { code: tagged, cp: V, side: "credit", amount: 11_100_000 },
    ]);
    // Issued, not yet applied: an unapplied credit in bucket V.
    const v = (await buckets()).find((r) => r.counterparty_company_id === V)!;
    expect(Number(v.unapplied_credits)).toBe(11_100_000);
    expect(await reconcile()).toEqual([]);

    await withFinance([A], (c) => c.query("SELECT finance_ar_apply_credit($1,$2,11100000)", [cn.id, inv]));
    expect(await taggedBalance()).toBe(14_400_000);
    expect(await reconcile()).toEqual([]);
  });

  it("a write-off on an intercompany invoice credits the tagged account, with no VAT line", async () => {
    const inv = await scalar<string>("SELECT id AS v FROM finance_ar_invoices WHERE tenant_id=$1 AND customer_id=$2 AND total=55500000", [A, GRP]);
    const entry = await writeOff(inv, 14_400_000, "2026-04-01");
    expect(await lines(entry)).toEqual([
      { code: "6950", cp: null, side: "debit", amount: 14_400_000 },
      { code: tagged, cp: V, side: "credit", amount: 14_400_000 },
    ]);
    expect(await taggedBalance()).toBe(0);
    expect(await reconcile()).toEqual([]);
  });

  it("an ordinary customer's credit note and write-off still credit the AR control account", async () => {
    const inv = await scalar<string>("SELECT id AS v FROM finance_ar_invoices WHERE tenant_id=$1 AND customer_id=$2", [A, ORD]);
    const cn = await creditNote(ORD, inv, "2026-03-25", 10_000_000, 1_100_000);
    const cnLines = await lines(cn.entry);
    expect(cnLines[cnLines.length - 1]).toEqual({ code: "1130", cp: null, side: "credit", amount: 11_100_000 });
    expect(await reconcile()).toEqual([]); // unapplied credit in the ordinary bucket
    const wo = await writeOff(inv, 5_000_000, "2026-04-02");
    expect(await lines(wo)).toEqual([
      { code: "6950", cp: null, side: "debit", amount: 5_000_000 },
      { code: "1130", cp: null, side: "credit", amount: 5_000_000 },
    ]);
    expect(await controlBalance()).toBe(111_000_000 - 11_100_000 - 5_000_000);
    expect(await reconcile()).toEqual([]);
  });

  // ── Aging, position, buckets ────────────────────────────────────────────────────────────────────
  it("★ aging, position and the buckets agree: control + AR part of the tagged receivables = net receivable", async () => {
    await issue(await draftInvoice(GRP, "2026-05-01", "2026-05-31", 40_000_000));
    const aging = Number(
      await scalar<string>("SELECT coalesce(sum(total_outstanding),0) AS v FROM finance_ar_aging($1,'2026-12-31'::date)", [A]),
    );
    const pos = await position();
    const b = await buckets();
    expect(aging).toBe(pos.open);
    expect(pos.open).toBe(111_000_000 - 5_000_000 + 40_000_000);
    for (const r of b) expect(Number(r.net_receivable)).toBe(Number(r.gl_balance));
    expect(b.reduce((s, r) => s + Number(r.net_receivable), 0)).toBe(pos.net);
    expect(pos.net).toBe((await controlBalance()) + (await taggedBalance()));
    expect(await reconcile()).toEqual([]);
  });

  // ── Manual intercompany postings, and the eliminations ──────────────────────────────────────────
  it("a manual intercompany journal on the same 1290-* is not AR's: reconciliation stays clean, the intercompany position counts it", async () => {
    await withFinance([A], (c) =>
      c.query(`SELECT finance_post_journal($1,'2026-05-15','pv505-recharge','Recharge to the group client',$2::jsonb)`, [
        A,
        JSON.stringify([
          { account_code: tagged, side: "debit", amount: 5_000_000, memo: "recharge" },
          { account_code: "4100", side: "credit", amount: 5_000_000, memo: "recharge" },
        ]),
      ]),
    );
    expect(await taggedBalance()).toBe(45_000_000); // 40m AR + 5m recharge
    const v = (await buckets()).find((r) => r.counterparty_company_id === V)!;
    expect(Number(v.gl_balance)).toBe(40_000_000); // the AR part only
    expect(await reconcile()).toEqual([]);

    const ic = await withFinance([A], async (c) =>
      (await c.query<{ counterparty_company_id: string; receivable: string }>("SELECT * FROM finance_intercompany_position($1)", [A])).rows,
    );
    expect(ic).toHaveLength(1);
    expect(ic[0].counterparty_company_id).toBe(V);
    expect(Number(ic[0].receivable)).toBe(45_000_000);
  });

  it("★ finance_intercompany_position and the eliminations agree with the AR posting (the mirror is the group client's own entry)", async () => {
    // The mirror is NOT written by AR (the group client has no books yet, PV-9), so until it books
    // one the pair is reported as a mismatch. That is true, and it is the header's stated behaviour.
    const before = await withFinance([A, V], async (c) =>
      (await c.query<{ problem: string }>("SELECT * FROM finance_intercompany_mismatch($1,$2)", [A, V])).rows,
    );
    expect(before.map((r) => r.problem)).toEqual(["INTERCOMPANY_RECEIVABLE_MISMATCH"]);

    // The group client books its payable in its own books.
    await withFinance([V], async (c) => {
      const pair = (
        await c.query<{ account_code: string }>("SELECT * FROM finance_ensure_intercompany_accounts($1,$2)", [V, A])
      ).rows;
      await c.query(`SELECT finance_post_journal($1,'2026-05-15','pv505-mirror','Owed to the issuer',$2::jsonb)`, [
        V,
        JSON.stringify([
          { account_code: "6900", side: "debit", amount: 45_000_000, memo: "services" },
          { account_code: pair[1].account_code, side: "credit", amount: 45_000_000, memo: "due to issuer" },
        ]),
      ]);
    });
    const after = await withFinance([A, V], async (c) =>
      (await c.query("SELECT * FROM finance_intercompany_mismatch($1,$2)", [A, V])).rows,
    );
    expect(after).toEqual([]);

    const run = await withFinance([H], async (c) =>
      (
        await c.query<{ id: string }>(
          "INSERT INTO finance_consolidation_runs (tenant_id, as_of, label) VALUES ($1,'2026-06-30','PV505') RETURNING id", [H],
        )
      ).rows[0].id,
    );
    const n = await withFinance([H, A, V], async (c) =>
      Number((await c.query<{ n: string }>("SELECT finance_eliminate_intercompany($1) AS n", [run])).rows[0].n),
    );
    expect(n).toBe(2);
    const entries = await withFinance([H], async (c) =>
      (
        await c.query<{ subject_company_id: string; account_code: string; side: string; amount: string }>(
          "SELECT subject_company_id, account_code, side, amount FROM finance_consolidation_entries WHERE run_id=$1 ORDER BY side",
          [run],
        )
      ).rows,
    );
    const onA = entries.find((e) => e.subject_company_id === A)!;
    expect(onA).toMatchObject({ account_code: tagged, side: "credit" });
    expect(Number(onA.amount)).toBe(45_000_000);
    const bal = await withFinance([H], async (c) =>
      (await c.query<{ balanced: boolean }>("SELECT * FROM finance_consolidation_balanced($1)", [run])).rows[0],
    );
    expect(bal.balanced).toBe(true);
    expect(await reconcile()).toEqual([]); // eliminations never touch the entity's books
  });

  // ── Detection, permanently pinned ───────────────────────────────────────────────────────────────
  it("★ a group client's invoice booked on the CONTROL account is reported on both buckets, though the totals agree", async () => {
    const inv = await draftInvoice(GRP, "2026-06-01", "2026-07-01", 30_000_000);
    const entry = await withFinance([A], async (c) => {
      const e = (
        await c.query<{ e: string }>(
          `SELECT finance_post_journal($1,'2026-06-01','pv505-misposted','Mis-posted group invoice',$2::jsonb,
                                       NULL,'standard',NULL,NULL,NULL,NULL,'ar') AS e`,
          [
            A,
            JSON.stringify([
              { account_code: "1130", side: "debit", amount: 30_000_000, memo: "wrong receivable" },
              { account_code: "4100", side: "credit", amount: 30_000_000, memo: "revenue" },
            ]),
          ],
        )
      ).rows[0].e;
      await c.query("UPDATE finance_ar_invoices SET status='issued', journal_entry_id=$2 WHERE id=$1", [inv, e]);
      return e;
    });

    const problems = await reconcile();
    expect(problems.map((p) => p.problem).sort()).toEqual(["AR_INTERCOMPANY_SUBLEDGER_GL_MISMATCH", "AR_SUBLEDGER_GL_MISMATCH"]);
    expect(problems.find((p) => p.problem === "AR_SUBLEDGER_GL_MISMATCH")!.detail).toMatch(/difference -30000000\.0000\)$/);
    const ic = problems.find((p) => p.problem === "AR_INTERCOMPANY_SUBLEDGER_GL_MISMATCH")!.detail;
    expect(ic).toContain(V);
    expect(ic).toMatch(/difference 30000000\.0000\)$/);
    // The totals still agree, which is why the check is per bucket.
    const pos = await position();
    const gl = (await buckets()).reduce((s, r) => s + Number(r.gl_balance), 0);
    expect(gl).toBe(pos.net);

    // Correcting it: reverse the journal, void the document. Reversals stay in and net to zero.
    await withFinance([A], async (c) => {
      await c.query("SELECT finance_reverse_journal($1,$2,NULL,'2026-06-02'::date)", [entry, "Booked on the wrong receivable"]);
      await c.query("UPDATE finance_ar_invoices SET status='void' WHERE id=$1", [inv]);
    });
    expect(await reconcile()).toEqual([]);
  });

  it("a reversed group invoice that is not voided is reported on its bucket", async () => {
    const inv = await draftInvoice(GRP, "2026-06-05", "2026-07-05", 7_000_000);
    const entry = await issue(inv);
    await withFinance([A], (c) =>
      c.query("SELECT finance_reverse_journal($1,$2,NULL,'2026-06-06'::date)", [entry, "Raised in error"]),
    );
    expect((await reconcile()).map((p) => p.problem)).toEqual(["AR_INTERCOMPANY_SUBLEDGER_GL_MISMATCH"]);
    await withFinance([A], (c) => c.query("UPDATE finance_ar_invoices SET status='void' WHERE id=$1", [inv]));
    expect(await reconcile()).toEqual([]);
  });

  // ── The tag is fixed once a customer has posted ────────────────────────────────────────────────
  it("a customer's counterparty cannot change once it has posted documents, and can before", async () => {
    const setCp = (id: string, cp: string | null) =>
      withFinance([A], (c) => c.query("UPDATE finance_ar_customers SET counterparty_company_id=$2 WHERE id=$1", [id, cp]));
    await expect(setCp(GRP, null)).rejects.toThrow(/FINANCE_AR_COUNTERPARTY_FROZEN/);
    await expect(setCp(ORD, V)).rejects.toThrow(/FINANCE_AR_COUNTERPARTY_FROZEN/);
    // Other columns stay editable.
    await withFinance([A], (c) => c.query("UPDATE finance_ar_customers SET name='Group Client (renamed)' WHERE id=$1", [GRP]));

    const fresh = newId();
    await withFinance([A], (c) =>
      c.query("INSERT INTO finance_ar_customers (id, tenant_id, code, name) VALUES ($1,$2,'PV505-NEW','Not yet billed')", [fresh, A]),
    );
    await setCp(fresh, V);
    await setCp(fresh, null);
    expect(await reconcile()).toEqual([]);
  });

  // ── The module wall ─────────────────────────────────────────────────────────────────────────────
  it("issuing without the finance scope fails loudly instead of posting nothing", async () => {
    const inv = await draftInvoice(GRP, "2026-06-10", "2026-07-10", 1_000_000);
    await expect(
      withTenants([A], (c) => c.query("SELECT finance_ar_issue_invoice($1)", [inv])),
    ).rejects.toThrow(/FINANCE_AR_UNKNOWN_INVOICE/);
    expect(await scalar<string>("SELECT status AS v FROM finance_ar_invoices WHERE id=$1", [inv])).toBe("draft");
  });
});
