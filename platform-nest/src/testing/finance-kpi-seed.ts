// Test seeding shared by the functional readers' database tests (DW-7j: f1, f2, f7, f8). Not a test file.
// A finance company is: the company row with the `finance` module, its settings row (IDR), the PSAK chart of accounts and fiscal
// year FY2026 (2026-01-01 .. 2027-01-01). Periods are either cut monthly (all OPEN, so journals and invoices can post) or left
// for the test to insert by hand, which is the only way to seed a period the state machine would refuse to reach.
import type { PoolClient } from "pg";
import { newId, withGlobal, withTenants } from "../db";
import { createCompany } from "./fixtures";

export const FINANCE = { modules: ["finance"] };

export const withFinance = <T>(tenant: string, fn: (c: PoolClient) => Promise<T>): Promise<T> => withTenants([tenant], fn, FINANCE);

export interface FinanceWorld {
  tenant: string;
  fiscalYear: string;
}

export async function seedFinanceCompany(name: string, opts: { periods: "monthly" | "none" }): Promise<FinanceWorld> {
  const tenant = await createCompany(name, ["finance"]);
  await withFinance(tenant, (c) =>
    c.query(`INSERT INTO finance_company_settings (tenant_id, functional_currency, presentation_currency) VALUES ($1,'IDR','IDR')`, [tenant]),
  );
  await withFinance(tenant, (c) => c.query("SELECT finance_instantiate_coa($1,'id_psak_general_v1')", [tenant]));
  const fiscalYear = newId();
  await withFinance(tenant, (c) =>
    c.query(`INSERT INTO finance_fiscal_years (id, tenant_id, code, start_date, end_date) VALUES ($1,$2,'FY2026','2026-01-01','2027-01-01')`, [
      fiscalYear, tenant,
    ]),
  );
  if (opts.periods === "monthly") await withFinance(tenant, (c) => c.query("SELECT finance_generate_periods($1,'monthly')", [fiscalYear]));
  return { tenant, fiscalYear };
}

/** One balanced journal: `lines` are [account code, side, amount]. */
export async function postJournal(tenant: string, date: string, tag: string, lines: Array<[string, "debit" | "credit", number]>): Promise<void> {
  const payload = lines.map(([account_code, side, amount]) => ({ account_code, side, amount }));
  await withFinance(tenant, (c) =>
    c.query("SELECT finance_post_journal($1,$2::date,$3,$4,$5::jsonb,NULL,'standard')", [tenant, date, tag, tag, JSON.stringify(payload)]),
  );
}

/** Turn the company's modules off (its rows stay): what a reader's gate must answer `null` for. */
export async function turnModulesOff(tenant: string): Promise<void> {
  await withGlobal((c) => c.query(`UPDATE companies SET enabled_modules = '{}' WHERE id = $1`, [tenant]));
}

/** One month of the GM's revenue plan (`finance_revenue_plans`, BFF §40.6.4). `month` is `YYYY-MM`; `amountMinor` is in the currency's minor unit. */
export async function seedRevenuePlan(
  tenant: string, month: string, amountMinor: number, setBy: string, currency = "IDR",
): Promise<void> {
  await withFinance(tenant, (c) =>
    c.query(`INSERT INTO finance_revenue_plans (tenant_id, month, amount_minor, currency, set_by) VALUES ($1, $2::date, $3, $4, $5)`, [
      tenant, `${month}-01`, String(amountMinor), currency, setBy,
    ]),
  );
}
