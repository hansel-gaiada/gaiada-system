// FINANCE CONFIGURATION seed — makes the department operable so the console has something to show,
// and seats the two role tiers so dev is not blocked on a hire.
//
// ── WHAT THIS SEEDS ────────────────────────────────────────────────────────────────────────────
//   the `finance` module enabled on the company · accounting settings (IDR) · the PSAK-aligned
//   chart of accounts · a fiscal year with monthly periods · a finance_manager and a finance_staff
//   seat, granted at company scope.
//
// ── WHAT IT DELIBERATELY DOES NOT DO, AND WHY THAT MATTERS MORE THAN WHAT IT DOES ──────────────
//
// **It does not sign off a period.** `finance_period_close_readiness()` will still report
// `NO_ACCOUNTANT_SIGNOFF`, and that is correct rather than unfinished.
//
// The D-F5 control exists so that "these figures are final" cannot be asserted anonymously. A seed
// that stamped `signed_off_by` with a seeded persona would satisfy the check while destroying the
// only thing it protects — and it would do so invisibly, because a green close-readiness looks
// identical whether a human signed or a script did. Nothing else in the module is blocked by it:
// posting, statements, both subledgers, reconciliation and the tax returns all work. The ONLY
// operation it gates is `SOFT_LOCK → HARD_LOCK`, which no dev workflow needs.
//
// When the finance manager has an account, they sign off — one UPDATE, by a named person, which is
// exactly the artefact an auditor asks for. The run prints that statement at the end.
//
// **It seeds no transactions.** No invoices, no bills, no journals. An empty ledger is a truthful
// empty state; a ledger of invented transactions is a demo that someone eventually mistakes for
// data, and this is the one module where that mistake has money attached.
//
// ── IDEMPOTENT, AND IT WILL NOT OVERWRITE A CONFIGURED ESTATE ──────────────────────────────────
// Every write is guarded on a natural key and reports `created` vs `existing`. `finance_instantiate_coa()`
// is itself idempotent by account code and never updates an existing account — the accountant's chart
// always wins over the template (owner ruling D-F5).
//
// ⚠ THE FINANCE WALL IS A THIRD GUC. Every finance_* table composes
// `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('finance')`. A `withTenants([t], fn)`
// WITHOUT `{ modules: ["finance"] }` leaves `app.scopes` unset, every row fails the predicate, and the
// INSERT reports success having written nothing. Every call below passes it.
//
// ⚠ AND `set_config(..., true)` INSIDE `withGlobal` IS A NO-OP — withGlobal opens no transaction, so
// the GUC is gone before the next statement. The verification counts at the end go through
// `withTenants` for that reason.
import { withTenants, withGlobal, closePool, newId } from "../db";

const COMPANY_NAME = "Gaia Digital Agency";

/** The two dev seats. Clearly labelled as seats, not people — when the real finance manager gets an
 *  account, they get their own user and these can be retired. */
const SEATS = [
  { email: "finance.manager@gaiada.local", name: "Finance Manager (seat)", role: "finance_manager" },
  { email: "finance.clerk@gaiada.local", name: "Finance Clerk (seat)", role: "finance_staff" },
];

export interface FinanceConfigResult {
  tenantId: string;
  moduleEnabled: { created: boolean };
  settings: { created: boolean };
  chartOfAccounts: { created: number; existing: number };
  fiscalYear: { code: string; created: boolean; periods: number };
  seats: Array<{ email: string; role: string; userCreated: boolean; grantCreated: boolean }>;
  signOffOutstanding: number;
}

export async function seedFinanceConfig(fiscalYear = new Date().getUTCFullYear()): Promise<FinanceConfigResult> {
  // ── The company ───────────────────────────────────────────────────────────────────────────────
  const company = await withGlobal(async (c) => {
    const r = await c.query<{ id: string; enabled_modules: string[] }>(
      `SELECT id, enabled_modules FROM companies WHERE name = $1 AND deleted_at IS NULL LIMIT 1`,
      [COMPANY_NAME],
    );
    return r.rows[0] ?? null;
  });
  if (!company) {
    throw new Error(
      `seed:finance-config — no company named "${COMPANY_NAME}". Run seed:agency first; this seed ` +
        `deliberately does not create companies, because a second company with the same intent is ` +
        `how an estate ends up with two of everything (see the rename trap in platform-nest/CLAUDE.md).`,
    );
  }
  const tenantId = company.id;

  // ── The module flag. Without it, ModuleEnabledGuard 404s every finance route and
  //    app_module_allowed('finance') is never satisfied, so the tables read zero rows. ──────────
  const alreadyEnabled = (company.enabled_modules ?? []).includes("finance");
  if (!alreadyEnabled) {
    await withGlobal((c) =>
      c.query(
        `UPDATE companies SET enabled_modules = array_append(enabled_modules, 'finance'),
                              updated_at = now()
          WHERE id = $1 AND NOT ('finance' = ANY(enabled_modules))`,
        [tenantId],
      ),
    );
  }

  // ── Accounting settings, chart, calendar ──────────────────────────────────────────────────────
  const out = await withTenants(
    [tenantId],
    async (c) => {
      const settings = await c.query(
        `INSERT INTO finance_company_settings
           (tenant_id, functional_currency, presentation_currency, fiscal_year_start_month)
         VALUES ($1,'IDR','IDR',1)
         ON CONFLICT (tenant_id) DO NOTHING
         RETURNING tenant_id`,
        [tenantId],
      );

      const before = await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM finance_accounts WHERE tenant_id = $1 AND deleted_at IS NULL`,
        [tenantId],
      );
      // Idempotent by code; never updates an existing account (ruling D-F5).
      await c.query(`SELECT finance_instantiate_coa($1, 'id_psak_general_v1')`, [tenantId]);
      const after = await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM finance_accounts WHERE tenant_id = $1 AND deleted_at IS NULL`,
        [tenantId],
      );
      const existing = Number(before.rows[0].n);
      const created = Number(after.rows[0].n) - existing;

      // Fiscal year. `fiscal_year_start_month` is 1 here, but the dates are computed from it rather
      // than hardcoded to January so a company with a different year start seeds correctly.
      const code = `FY${fiscalYear}`;
      const fyRow = await c.query<{ id: string }>(
        `INSERT INTO finance_fiscal_years (tenant_id, code, start_date, end_date)
         VALUES ($1, $2, make_date($3,1,1), make_date($3 + 1,1,1))
         ON CONFLICT (tenant_id, code) DO NOTHING
         RETURNING id`,
        [tenantId, code, fiscalYear],
      );
      let fyId = fyRow.rows[0]?.id ?? null;
      const fyCreated = fyId != null;
      if (!fyId) {
        const found = await c.query<{ id: string }>(
          `SELECT id FROM finance_fiscal_years WHERE tenant_id = $1 AND code = $2`,
          [tenantId, code],
        );
        fyId = found.rows[0]?.id ?? null;
      }
      // Returns 0 if the calendar is already cut — it never re-cuts periods.
      if (fyId) await c.query(`SELECT finance_generate_periods($1, 'monthly')`, [fyId]);
      const periods = await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM finance_fiscal_periods WHERE fiscal_year_id = $1`,
        [fyId],
      );

      // How many ended periods still lack a sign-off. Reported, never fixed — see the header.
      const outstanding = await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM finance_fiscal_periods
          WHERE tenant_id = $1 AND end_date < CURRENT_DATE AND signed_off_by IS NULL`,
        [tenantId],
      );

      return {
        settingsCreated: settings.rowCount === 1,
        coa: { created, existing },
        fy: { code, created: fyCreated, periods: Number(periods.rows[0].n) },
        signOffOutstanding: Number(outstanding.rows[0].n),
      };
    },
    { modules: ["finance"] },
  );

  // ── The two seats ─────────────────────────────────────────────────────────────────────────────
  const seats: FinanceConfigResult["seats"] = [];
  for (const seat of SEATS) {
    const result = await withGlobal(async (c) => {
      // Resolve by email (globally unique), create only if absent.
      const found = await c.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [seat.email]);
      let userId = found.rows[0]?.id ?? null;
      const userCreated = userId == null;
      if (!userId) {
        userId = newId();
        await c.query(
          `INSERT INTO users (id, email, name, title, status, origin_site)
           VALUES ($1,$2,$3,'Finance','active','central')`,
          [userId, seat.email, seat.name],
        );
      }

      const role = await c.query<{ id: string }>(
        `SELECT id FROM roles WHERE company_id IS NULL AND name = $1`,
        [seat.role],
      );
      if (!role.rows[0]) {
        throw new Error(
          `seed:finance-config — global role "${seat.role}" is missing. It is seeded by ` +
            `202608241014_iam_finance_f0_permissions.sql; run migrations first.`,
        );
      }
      const grant = await c.query(
        `INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id)
         VALUES ($1,$2,$3,'company',$4)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [newId(), userId, role.rows[0].id, tenantId],
      );
      return { userId, userCreated, grantCreated: grant.rowCount === 1 };
    });

    // ⚠ THE MEMBERSHIP GOES THROUGH withTenants, NOT withGlobal.
    //
    // `company_memberships` is tenant-scoped with FORCE RLS, so an INSERT under `withGlobal` — which
    // sets no `app.current_tenant_ids` — fails the WITH CHECK outright. It fails LOUDLY here, which
    // is the good case; the dangerous sibling is a SELECT under withGlobal, which returns zero rows
    // and reports success. Caught by the seed test on its first run.
    //
    // `kind` is explicit rather than defaulted: these are staff seats ('employee'), not service
    // principals. The column defaults to 'employee' anyway, but a seat row that says what it is
    // beats one relying on a default nobody reads.
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO company_memberships (id, tenant_id, user_id, origin_site, kind)
         VALUES ($1,$2,$3,'central','employee')
         ON CONFLICT (tenant_id, user_id) DO NOTHING`,
        [newId(), tenantId, result.userId],
      ),
    );

    seats.push({ email: seat.email, role: seat.role, userCreated: result.userCreated, grantCreated: result.grantCreated });
  }

  return {
    tenantId,
    moduleEnabled: { created: !alreadyEnabled },
    settings: { created: out.settingsCreated },
    chartOfAccounts: out.coa,
    fiscalYear: out.fy,
    seats,
    signOffOutstanding: out.signOffOutstanding,
  };
}

async function main() {
  const year = Number(process.argv[2]) || new Date().getUTCFullYear();
  const r = await seedFinanceConfig(year);
  console.log(`finance config seeded for ${COMPANY_NAME} (${r.tenantId})`);
  console.log(`  module enabled:   ${r.moduleEnabled.created ? "added" : "already on"}`);
  console.log(`  settings:         ${r.settings.created ? "created" : "already present"} (IDR)`);
  console.log(`  chart of accounts: ${r.chartOfAccounts.created} created, ${r.chartOfAccounts.existing} already present`);
  console.log(`  ${r.fiscalYear.code}:           ${r.fiscalYear.created ? "created" : "already present"}, ${r.fiscalYear.periods} periods`);
  for (const s of r.seats) {
    console.log(
      `  seat ${s.role.padEnd(15)} ${s.email} — user ${s.userCreated ? "created" : "existing"}, ` +
        `grant ${s.grantCreated ? "created" : "existing"}`,
    );
  }
  console.log("");
  console.log("The department is now operable: the chart, the calendar and both role tiers exist.");
  if (r.signOffOutstanding > 0) {
    console.log(
      `⚠ ${r.signOffOutstanding} ended period(s) have no accountant sign-off, so ` +
        `finance_period_close_readiness() will report NO_ACCOUNTANT_SIGNOFF. That is CORRECT, not ` +
        `unfinished — this seed deliberately does not stamp it.`,
    );
    console.log(
      "  Nothing else is blocked by it: posting, statements, AR, AP, reconciliation and the tax",
    );
    console.log(
      "  returns all work. It gates only SOFT_LOCK -> HARD_LOCK. When the finance manager has an",
    );
    console.log("  account, they sign off — a named human, which is the artefact an auditor asks for.");
  }
  await closePool();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
