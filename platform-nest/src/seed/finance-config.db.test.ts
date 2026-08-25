// seed:finance-config — against live Postgres + RLS.
//
// A seed test earns its place by proving the two things a seed can get silently wrong: that it
// writes anything at all (the finance module wall makes a mis-scoped INSERT report success having
// written nothing), and that running it twice does not duplicate or overwrite.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, withGlobal } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany } from "../testing/fixtures";
import { seedFinanceConfig } from "./finance-config";

describe.skipIf(!TEST_URL)("seed:finance-config", () => {
  beforeAll(async () => {
    await initTestDb();
    // The seed resolves the company BY NAME and refuses to create one — so the fixture must use
    // the exact name (the rename trap in platform-nest/CLAUDE.md).
    await createCompany("Gaia Digital Agency");
  });
  afterAll(teardownTestDb);

  it("refuses to run when the company is absent, rather than creating a second one", async () => {
    await withGlobal((c) => c.query("UPDATE companies SET name = 'Renamed' WHERE name = 'Gaia Digital Agency'"));
    await expect(seedFinanceConfig(2026)).rejects.toThrow(/no company named/);
    await withGlobal((c) => c.query("UPDATE companies SET name = 'Gaia Digital Agency' WHERE name = 'Renamed'"));
  });

  it("enables the module, instantiates the chart, cuts the calendar and seats both tiers", async () => {
    const r = await seedFinanceConfig(2026);
    expect(r.moduleEnabled.created).toBe(true);
    expect(r.settings.created).toBe(true);
    expect(r.chartOfAccounts.created).toBeGreaterThan(50);
    expect(r.fiscalYear.periods).toBe(12);
    expect(r.seats.map((s) => s.role).sort()).toEqual(["finance_manager", "finance_staff"]);
    expect(r.seats.every((s) => s.userCreated && s.grantCreated)).toBe(true);

    // The wall: read back THROUGH the module scope. If the seed had written with a mis-scoped
    // transaction this count would be 0 and the seed would still have reported success.
    const accounts = await withTenants(
      [r.tenantId],
      async (c) =>
        Number((await c.query("SELECT count(*) AS n FROM finance_accounts WHERE tenant_id=$1", [r.tenantId])).rows[0].n),
      { modules: ["finance"] },
    );
    expect(accounts).toBeGreaterThan(50);
  });

  it("is idempotent — a second run creates nothing and overwrites nothing", async () => {
    // An accountant's edit must survive a re-run (ruling D-F5).
    const before = await seedFinanceConfig(2026);
    await withTenants(
      [before.tenantId],
      (c) => c.query("UPDATE finance_accounts SET name='Bank (edited)' WHERE tenant_id=$1 AND code='1120'", [before.tenantId]),
      { modules: ["finance"] },
    );

    const again = await seedFinanceConfig(2026);
    expect(again.moduleEnabled.created).toBe(false);
    expect(again.settings.created).toBe(false);
    expect(again.chartOfAccounts.created).toBe(0);
    expect(again.fiscalYear.created).toBe(false);
    expect(again.seats.every((s) => !s.userCreated && !s.grantCreated)).toBe(true);

    const name = await withTenants(
      [again.tenantId],
      async (c) =>
        (await c.query<{ name: string }>("SELECT name FROM finance_accounts WHERE tenant_id=$1 AND code='1120'", [again.tenantId])).rows[0].name,
      { modules: ["finance"] },
    );
    expect(name).toBe("Bank (edited)");
  });

  // The control this seed deliberately does not satisfy.
  it("does NOT stamp an accountant sign-off", async () => {
    const r = await seedFinanceConfig(2026);
    const signed = await withTenants(
      [r.tenantId],
      async (c) =>
        Number((await c.query("SELECT count(*) AS n FROM finance_fiscal_periods WHERE tenant_id=$1 AND signed_off_by IS NOT NULL", [r.tenantId])).rows[0].n),
      { modules: ["finance"] },
    );
    expect(signed).toBe(0);
  });
  it("★ the chart records WHICH template it came from — provenance, not configuration", async () => {
    // finance_company_settings.coa_template_key existed since F0 and nothing wrote it, so the
    // settings page rendered "Chart of accounts: —" for a company whose chart had plainly just been
    // instantiated. The fix put the write inside finance_instantiate_coa(), and the FIRST draft of
    // that migration placed it after the function's `RETURN` — unreachable, compiling fine, with
    // every existing test still green. This assertion is what makes "it ran" and "it worked"
    // distinguishable.
    const r = await seedFinanceConfig(2026);
    const key = await withTenants(
      [r.tenantId],
      async (c) =>
        (
          await c.query<{ coa_template_key: string | null }>(
            `SELECT coa_template_key FROM finance_company_settings WHERE tenant_id = $1`,
            [r.tenantId],
          )
        ).rows[0].coa_template_key,
      { modules: ["finance"] },
    );
    expect(key).toBe("id_psak_general_v1");
  });

});
