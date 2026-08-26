// FINANCE DEMO DATA — a month of books, so the workspace has something to show.
//
// The engine has been complete and the surfaces empty: an accountant opening /finance saw zeroes
// everywhere and could not tell a working system from a broken one. This posts a plausible month
// for one company so the ledger, the agings, the statements and the asset register all carry real
// figures that tie.
//
// ── EVERY ENTRY IS TAGGED, AND THAT IS THE POINT ───────────────────────────────────────────────
// ★ This writes into REAL BOOKS. Not a sandbox — the same ledger that will carry the company's
// actual transactions, and the ledger is append-only, so nothing here can be deleted later.
//
// So every journal this seeds carries `source_event_id` beginning `demo-seed:`. That makes the
// whole set findable in one query and reversible as a batch:
//
//   SELECT * FROM finance_journal_entries WHERE source_event_id LIKE 'demo-seed:%';
//
// Without that marker, demo figures and real ones would be indistinguishable within a week, and the
// only way to clean up would be to read every entry and judge it. A prefix costs nothing now and is
// the difference between "reversible" and "permanent".
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
  console.log("Every journal carries source_event_id 'demo-seed:*'. To find or reverse them later:");
  console.log("  SELECT id, source_event_id, description FROM finance_journal_entries");
  console.log("   WHERE source_event_id LIKE 'demo-seed:%';");
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
