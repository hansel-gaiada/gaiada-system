// FINANCE DEMO DATA — a month of books, so the workspace has something to show.
//
// The engine has been complete and the surfaces empty: an accountant opening /finance saw zeroes
// everywhere and could not tell a working system from a broken one. This posts a plausible month
// for one company so the ledger, the agings, the statements and the asset register all carry real
// figures that tie.
//
// ── MOST ENTRIES ARE TAGGED — BUT NOT ALL, AND THE DIFFERENCE MATTERS ──────────────────────────
// ★ This writes into REAL BOOKS. Not a sandbox — the same ledger that will carry the company's
// actual transactions, and the ledger is append-only, so nothing here can be deleted later.
//
// Every journal this file posts DIRECTLY carries `source_event_id` beginning `demo-seed:`.
//
// ⚠ THAT DOES NOT COVER EVERYTHING THIS SEED CREATES. Sections 6 and 8 do not post journals
// themselves — they call `finance_capitalise_asset()` and `finance_run_depreciation()`, and those
// SQL functions mint their OWN ids (`fa-acquire:<assetId>`, `fa-depreciation:<runId>`). The seed
// cannot tag them, and an earlier version of this comment claimed it could. Verified against the
// live estate on 2026-08-26: a 12-entry run produced 8 tagged and 4 untagged, the untagged four
// being three capitalisations and one depreciation charge — the largest single entry among them a
// 380,000,000 vehicle. Cleaning up on the `demo-seed:%` filter alone would silently leave those.
//
// The honest cleanup is therefore THREE queries, not one — and the `fa-` prefixes must be narrowed
// to the rows this seed created, because a genuine asset acquired later carries the same prefix:
//
//   -- 1. everything posted directly here
//   SELECT * FROM finance_journal_entries WHERE source_event_id LIKE 'demo-seed:%';
//   -- 2. the capitalisations, via the assets this seed created (codes below)
//   SELECT e.* FROM finance_journal_entries e JOIN finance_assets a
//     ON e.source_event_id = 'fa-acquire:' || a.id
//    WHERE a.code IN ('IT-001','IT-002','VEH-001');
//   -- 3. the depreciation charge(s) those assets produced
//   SELECT * FROM finance_journal_entries WHERE source_event_id LIKE 'fa-depreciation:%';
//
// And note the ledger is not the whole footprint: `finance_assets`, `finance_asset_classes` and
// `finance_instruments` rows also exist and are NOT journals, so reversing entries leaves the
// register populated. Those are ordinary rows and can be deleted.
//
// ── IDEMPOTENT BY THE LEDGER'S OWN RULE ────────────────────────────────────────────────────────
// `source_event_id` is unique per company, so a second run does not double-post — it fails on the
// first duplicate. That is the ledger's existing guarantee, not something this script adds.
import { withTenants, withGlobal, closePool, newId } from "../db";
import type { PoolClient } from "pg";

const COMPANY = "Gaia Digital Agency";
const YEAR = 2026;

interface Line {
  account_code: string;
  side: "debit" | "credit";
  amount: number;
  memo?: string;
}

async function fin<T>(t: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenants([t], fn, { modules: ["finance"] });
}

export async function seedFinanceDemo(companyName = COMPANY): Promise<{ posted: number; skipped: number }> {
  const co = await withGlobal(async (c) => {
    const r = await c.query<{ id: string }>(
      `SELECT id FROM companies WHERE name = $1 AND deleted_at IS NULL LIMIT 1`,
      [companyName],
    );
    return r.rows[0]?.id ?? null;
  });
  if (!co) throw new Error(`seed:finance-demo — no company named "${companyName}".`);

  const actor = await withGlobal(async (c) => {
    const r = await c.query<{ id: string }>(`SELECT id FROM users WHERE email = 'hansel@gaiada.com'`);
    return r.rows[0]?.id ?? null;
  });

  let posted = 0;
  let skipped = 0;

  const post = async (key: string, date: string, description: string, lines: Line[]) => {
    try {
      await fin(co, (c) =>
        c.query(`SELECT finance_post_journal($1,$2::date,$3,$4,$5::jsonb,$6)`, [
          co, date, `demo-seed:${key}`, description, JSON.stringify(lines), actor,
        ]),
      );
      posted++;
    } catch (e) {
      // A duplicate source_event_id means this entry is already here from a previous run. Anything
      // else is a real refusal and must not be swallowed — an unbalanced entry or a locked period
      // is a bug in this seed, not a re-run.
      const msg = (e as Error).message ?? "";
      if (/duplicate|unique|already/i.test(msg)) {
        skipped++;
      } else {
        throw new Error(`seed:finance-demo — posting "${key}" failed: ${msg}`);
      }
    }
  };

  // ── 1. Capital and a bank balance ─────────────────────────────────────────────────────────────
  await post("capital", `${YEAR}-01-02`, "Setoran modal pendiri", [
    { account_code: "1120", side: "debit", amount: 500_000_000, memo: "Bank BCA" },
    { account_code: "3100", side: "credit", amount: 500_000_000, memo: "Modal saham" },
  ]);

  // ── 2. Client revenue with statutory PPN ──────────────────────────────────────────────────────
  // Indonesian PPN is 12% applied to 11/12 of the base, not a flat 11% — the shape matters because
  // an accountant will check this figure against a real invoice.
  const feeBase = 150_000_000;
  const ppn = Math.round(feeBase * (11 / 12) * 0.12);
  await post("revenue-q1", `${YEAR}-03-25`, "Jasa digital marketing — retainer Q1", [
    { account_code: "1120", side: "debit", amount: feeBase + ppn, memo: "Diterima di bank" },
    { account_code: "4100", side: "credit", amount: feeBase, memo: "Pendapatan jasa" },
    { account_code: "2140", side: "credit", amount: ppn, memo: "PPN keluaran" },
  ]);

  // ── 3. Payroll — the biggest cost in an agency, and it carries withholding ────────────────────
  // Gross 90m: staff receive 84.5m, DJP is owed 4m PPh 21, BPJS 1.5m. Three creditors from one
  // expense, which is exactly why payroll cannot be booked as a single payment line.
  await post("payroll-03", `${YEAR}-03-31`, "Gaji dan tunjangan Maret", [
    { account_code: "6100", side: "debit", amount: 90_000_000, memo: "Beban gaji" },
    { account_code: "2160", side: "credit", amount: 84_500_000, memo: "Utang gaji" },
    { account_code: "2150", side: "credit", amount: 4_000_000, memo: "PPh 21 dipotong" },
    { account_code: "2170", side: "credit", amount: 1_500_000, memo: "BPJS" },
  ]);

  // ── 4. Ordinary operating costs ───────────────────────────────────────────────────────────────
  await post("rent-03", `${YEAR}-03-05`, "Sewa kantor Maret", [
    { account_code: "6200", side: "debit", amount: 15_000_000, memo: "Sewa kantor" },
    { account_code: "1120", side: "credit", amount: 15_000_000 },
  ]);
  await post("utilities-03", `${YEAR}-03-28`, "Listrik dan internet Maret", [
    { account_code: "6300", side: "debit", amount: 4_200_000 },
    { account_code: "1120", side: "credit", amount: 4_200_000 },
  ]);
  await post("subscriptions-03", `${YEAR}-03-15`, "Langganan perangkat lunak", [
    { account_code: "6850", side: "debit", amount: 6_800_000, memo: "Adobe, Figma, Google Workspace" },
    { account_code: "1120", side: "credit", amount: 6_800_000 },
  ]);

  // ── 5. A contractor bill with PPh 23 withheld ─────────────────────────────────────────────────
  // The vendor is owed 19.6m and DJP 0.4m from a 20m expense. Both are real liabilities with
  // different creditors, which is the thing a single "accounts payable" line would hide.
  await post("contractor-03", `${YEAR}-03-20`, "Jasa freelance desain", [
    { account_code: "6600", side: "debit", amount: 20_000_000, memo: "Jasa profesional" },
    { account_code: "2120", side: "credit", amount: 19_600_000, memo: "Utang vendor" },
    { account_code: "2151", side: "credit", amount: 400_000, memo: "PPh 23 dipotong" },
  ]);

  // ── 6. A fixed asset, capitalised ─────────────────────────────────────────────────────────────
  // Posted through the fixed_assets subledger, which is the only thing permitted to touch the 1210
  // control account — a manual journal there is barred, and that bar is what lets the register be
  // trusted to tie.
  const assetsExist = await fin(co, async (c) =>
    Number((await c.query<{ n: string }>(`SELECT count(*) n FROM finance_assets WHERE tenant_id=$1`, [co])).rows[0].n),
  );
  if (assetsExist === 0) {
    await fin(co, async (c) => {
      const cls = newId();
      await c.query(
        `INSERT INTO finance_asset_classes
           (id,tenant_id,code,name,book_method,book_life_months,tax_golongan,tax_method)
         VALUES ($1,$2,'IT','Peralatan IT','straight_line',36,'gol_1','garis_lurus')`,
        [cls, co],
      );
      const vehicles = newId();
      await c.query(
        `INSERT INTO finance_asset_classes
           (id,tenant_id,code,name,book_method,book_life_months,tax_golongan,tax_method)
         VALUES ($1,$2,'VEH','Kendaraan','straight_line',60,'gol_2','garis_lurus')`,
        [vehicles, co],
      );

      for (const [cid, code, name, cost, date] of [
        [cls, "IT-001", "MacBook Pro 16 — Creative", 42_000_000, `${YEAR}-02-10`],
        [cls, "IT-002", "iMac 27 — Editing", 36_000_000, `${YEAR}-02-10`],
        [vehicles, "VEH-001", "Toyota Innova — operasional", 380_000_000, `${YEAR}-01-20`],
      ] as const) {
        const id = newId();
        await c.query(
          `INSERT INTO finance_assets
             (id,tenant_id,class_id,code,name,acquisition_date,in_service_date,cost,status)
           VALUES ($1,$2,$3,$4,$5,$6::date,$6::date,$7,'active')`,
          [id, co, cid, code, name, date, cost],
        );
        await c.query(`SELECT finance_capitalise_asset($1,'1120',$2::date,$3)`, [id, date, actor]);
      }
    });
    posted += 3;
  }

  // ── 7. A bank loan ────────────────────────────────────────────────────────────────────────────
  const loansExist = await fin(co, async (c) =>
    Number(
      (await c.query<{ n: string }>(`SELECT count(*) n FROM finance_instruments WHERE tenant_id=$1`, [co])).rows[0].n,
    ),
  );
  if (loansExist === 0) {
    await fin(co, (c) =>
      c.query(
        `INSERT INTO finance_instruments
           (tenant_id,code,name,kind,counterparty_name,principal,nominal_rate,start_date,maturity_date,
            payment_months,repayment_method)
         VALUES ($1,'BCA-01','Kredit modal kerja BCA','loan_payable','Bank BCA',
                 240000000,11.5,'${YEAR}-02-01','${YEAR + 2}-02-01',1,'annuity')`,
        [co],
      ),
    );
    await post("loan-drawdown", `${YEAR}-02-01`, "Pencairan kredit modal kerja BCA", [
      { account_code: "1120", side: "debit", amount: 240_000_000, memo: "Dana masuk" },
      { account_code: "2210", side: "credit", amount: 240_000_000, memo: "Utang bank jangka panjang" },
    ]);
  }

  // ── 7b. Receivables and payables THROUGH THE SUBLEDGERS ───────────────────────────────────────
  // ★ Sections 2 and 5 above post CASH and direct GL entries — money already received, a vendor
  // liability booked straight to 2120. Neither creates a subledger document, so the receivables and
  // payables agings stayed EMPTY while the ledger looked healthy. That was verified on the live
  // estate: 12 entries posted, and `finance_ar_invoices`/`finance_ap_bills` both still zero.
  //
  // An empty aging beside a populated ledger is exactly the "everything is on screen and nothing is
  // findable" complaint this whole seed exists to answer, so the two subledgers get real documents:
  // an ISSUED invoice that is not yet paid, one that is partly paid, and an APPROVED bill carrying
  // Indonesian withholding. Each is created as a draft row and then put through its subledger
  // function, never posted by hand — `finance_ar_issue_invoice` and `finance_ap_approve_bill` are
  // what write the journal and move the control account, and a hand-written journal to 1210/2110 is
  // barred precisely so the aging can be trusted to tie.
  const arApExist = await fin(co, async (c) =>
    Number((await c.query<{ n: string }>(`SELECT count(*) n FROM finance_ar_invoices WHERE tenant_id=$1`, [co])).rows[0].n),
  );
  if (arApExist === 0) {
    await fin(co, async (c) => {
      const acct = async (code: string) =>
        (await c.query<{ id: string }>(
          `SELECT id FROM finance_accounts WHERE tenant_id=$1 AND code=$2`, [co, code],
        )).rows[0]?.id ?? null;
      const bank = await acct("1120");
      const revenue = await acct("4100");   // Pendapatan jasa
      const proServices = await acct("6600"); // Jasa profesional

      // Two customers on DIFFERENT payment terms, so the aging buckets are not all the same shape.
      const cust: string[] = [];
      for (const [code, name, terms] of [
        ["C-001", "PT Bali Beach Resort", 30],
        ["C-002", "CV Nusantara Kopi", 14],
      ] as const) {
        const r = await c.query<{ id: string }>(
          `INSERT INTO finance_ar_customers (tenant_id, code, name, payment_terms_days, is_pkp)
           VALUES ($1,$2,$3,$4,true) RETURNING id`,
          [co, code, name, terms],
        );
        cust.push(r.rows[0].id);
      }

      // Invoice dates are chosen so the two land in DIFFERENT aging buckets as of the seeded month
      // end — an aging where every row sits in "current" demonstrates nothing about the bucketing.
      const invoices: Array<[string, number, string, string, string, number]> = [
        // [no, customerIdx, invoiceDate, dueDate, memo, alreadyPaid]
        ["INV-2026-001", 0, `${YEAR}-02-10`, `${YEAR}-03-12`, "Retainer Februari", 0],
        ["INV-2026-002", 1, `${YEAR}-03-20`, `${YEAR}-04-03`, "Kampanye peluncuran produk", 0],
      ];
      const invoiceIds: string[] = [];
      for (const [no, ci, date, due, memo, paid] of invoices) {
        const sub = no.endsWith("001") ? 60_000_000 : 25_000_000;
        const tax = Math.round(sub * (11 / 12) * 0.12);
        const r = await c.query<{ id: string }>(
          `INSERT INTO finance_ar_invoices
             (tenant_id, customer_id, invoice_no, invoice_date, due_date, currency_code,
              subtotal, tax_total, total, amount_paid, status)
           VALUES ($1,$2,$3,$4::date,$5::date,'IDR',$6,$7,$8,$9,'draft') RETURNING id`,
          [co, cust[ci], no, date, due, sub, tax, sub + tax, paid],
        );
        // ⚠ A HEADER IS NOT AN INVOICE. `finance_ar_issue_invoice` refuses one with no lines
        // (FINANCE_AR_EMPTY_INVOICE) — caught by dry-running this against the live schema inside a
        // rolled-back transaction before it ever ran for real. The revenue account is per LINE, not
        // per invoice, because one invoice legitimately spans service and product revenue and
        // collapsing that is how a P&L stops being able to answer "what did we sell".
        await c.query(
          `INSERT INTO finance_ar_invoice_lines
             (tenant_id, invoice_id, line_no, description, quantity, unit_price, line_subtotal,
              revenue_account_id, tax_code, tax_rate, tax_amount)
           VALUES ($1,$2,1,$3,1,$4,$4,$5,'PPN',12,$6)`,
          [co, r.rows[0].id, memo, sub, revenue, tax],
        );
        // Issuing is what posts the journal and moves the AR control account.
        await c.query(`SELECT finance_ar_issue_invoice($1,$2)`, [r.rows[0].id, actor]);
        invoiceIds.push(r.rows[0].id);
      }

      // A receipt that is PARTLY allocated, deliberately.
      //
      // Banking the money and deciding which debt it settles are two separate acts here:
      // `finance_ar_record_receipt` posts the cash, and `finance_ar_allocate` — which posts NOTHING
      // — records which invoice it pays down. So 30,000,000 arrives, 20,000,000 is allocated
      // against INV-2026-001, and 10,000,000 remains ON ACCOUNT.
      //
      // That leftover is the whole reason the receivables page shows open invoices, payments on
      // account and the net as three separate figures rather than one. A fully-allocated book would
      // make those three look redundant, and the reader would never see the case that actually
      // bites: an unallocated receipt quietly lowering the net while the invoice it should have
      // settled still sits in the aging, so a customer gets chased for money already paid.
      if (bank) {
        const rec = await c.query<{ id: string }>(
          `INSERT INTO finance_ar_receipts
             (tenant_id, customer_id, receipt_no, receipt_date, currency_code, amount, bank_account_id, reference)
           VALUES ($1,$2,'RCPT-2026-001',$3::date,'IDR',$4,$5,'Transfer BCA') RETURNING id`,
          [co, cust[0], `${YEAR}-03-15`, 30_000_000, bank],
        );
        await c.query(`SELECT finance_ar_record_receipt($1,$2)`, [rec.rows[0].id, actor]);
        if (invoiceIds[0]) {
          await c.query(`SELECT finance_ar_allocate($1,$2,$3,$4)`,
            [rec.rows[0].id, invoiceIds[0], 20_000_000, actor]);
        }
      }

      // One vendor bill WITH withholding — the case a single "accounts payable" line hides. PPh 23
      // at 2% on a service bill: the vendor is owed the net, DJP the rest.
      const ven = await c.query<{ id: string }>(
        `INSERT INTO finance_ap_vendors (tenant_id, code, name, is_pkp, default_withholding_code, default_withholding_rate)
         VALUES ($1,'V-001','PT Kreatif Media Nusantara',true,'PPH23',0.02) RETURNING id`,
        [co],
      );
      const wht = (
        await c.query<{ id: string }>(`SELECT id FROM finance_accounts WHERE tenant_id=$1 AND code='2151'`, [co])
      ).rows[0]?.id ?? null;
      const sub = 35_000_000;
      const tax = Math.round(sub * (11 / 12) * 0.12);
      const whtAmt = Math.round(sub * 0.02);
      const bill = await c.query<{ id: string }>(
        `INSERT INTO finance_ap_bills
           (tenant_id, vendor_id, bill_no, bill_date, due_date, currency_code, subtotal, tax_total, total,
            withholding_code, withholding_rate, withholding_amount, withholding_account_id,
            amount_payable, amount_paid, status)
         VALUES ($1,$2,'BILL-8841',$3::date,$4::date,'IDR',$5,$6,$7,'PPH23',0.02,$8,$9,$10,0,'draft')
         RETURNING id`,
        [co, ven.rows[0].id, `${YEAR}-03-18`, `${YEAR}-04-17`, sub, tax, sub + tax, whtAmt, wht,
         sub + tax - whtAmt],
      );
      await c.query(
        `INSERT INTO finance_ap_bill_lines
           (tenant_id, bill_id, line_no, description, quantity, unit_price, line_subtotal,
            expense_account_id, tax_code, tax_rate, tax_amount)
         VALUES ($1,$2,1,'Produksi konten video',1,$3,$3,$4,'PPN',12,$5)`,
        [co, bill.rows[0].id, sub, proServices, tax],
      );
      await c.query(`SELECT finance_ap_approve_bill($1,$2)`, [bill.rows[0].id, actor]);
    });
    posted += 4;
  }

  // ── 8. Depreciation for March ─────────────────────────────────────────────────────────────────
  // Run LAST, because it charges whatever assets exist by then. Running it before section 6 would
  // post a zero charge and look like the engine was broken.
  const marchId = await fin(co, async (c) =>
    (
      await c.query<{ id: string }>(
        `SELECT id FROM finance_fiscal_periods
          WHERE tenant_id=$1 AND $2::date BETWEEN start_date AND end_date`,
        [co, `${YEAR}-03-31`],
      )
    ).rows[0]?.id ?? null,
  );
  if (marchId) {
    try {
      await fin(co, (c) => c.query(`SELECT finance_run_depreciation($1,$2,$3)`, [co, marchId, actor]));
      posted++;
    } catch (e) {
      if (!/ux_finance_dep_runs_period|duplicate/i.test((e as Error).message)) throw e;
      skipped++;
    }
  }

  return { posted, skipped };
}

async function main() {
  const argv = process.argv.slice(2);
  const name = argv.find((a) => a.startsWith("--company="))?.slice(10) ?? COMPANY;
  const r = await seedFinanceDemo(name);
  console.log(`finance demo data for ${name}: ${r.posted} posted, ${r.skipped} already present`);
  console.log("");
  console.log("To find what this seeded, THREE queries are needed — not one. Entries posted through");
  console.log("the fixed-asset subledger carry ITS ids, not this seed's, and are easy to miss:");
  console.log("  SELECT * FROM finance_journal_entries WHERE source_event_id LIKE 'demo-seed:%';");
  console.log("  SELECT e.* FROM finance_journal_entries e JOIN finance_assets a");
  console.log("    ON e.source_event_id = 'fa-acquire:' || a.id");
  console.log("   WHERE a.code IN ('IT-001','IT-002','VEH-001');");
  console.log("  SELECT * FROM finance_journal_entries WHERE source_event_id LIKE 'fa-depreciation:%';");
  console.log("");
  console.log("Also NOT journals, so unaffected by a reversal: finance_assets, finance_asset_classes");
  console.log("and finance_instruments rows. Those are ordinary rows and can be deleted outright.");
  console.log("");
  console.log("⚠ These are REAL entries in REAL books. The ledger is append-only — they can be");
  console.log("  reversed, never deleted. Reverse them before the company's actual transactions");
  console.log("  begin, or the two become tangled in the same periods.");
  await closePool();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
