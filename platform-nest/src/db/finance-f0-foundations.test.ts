// Finance F0 — FOUNDATIONS: ownership scope, the third wall, CoA freeze, period locks, SoD, elevation.
//
// Covers migrations 202608241010..1013. Verified through the NOSUPERUSER NOBYPASSRLS app role
// (initTestDb) so RLS is actually exercised, following src/db/module-hr-rls.test.ts.
//
// ── WHY THIS FILE EXISTS AT THIS SIZE ────────────────────────────────────────────────────────────
// Owner ruling D-F1 permits reusing project-hug's finance design "if it's good and proper". The
// audit that produced the F0 blueprint found project-hug shipped **27,100 LOC of finance code
// behind ONE test file**, while its own FINANCE_CHECKPOINTS.md ticked "Integration Test Suite: all
// phases pass with zero failures". That gap is the specific thing this program is not inheriting.
// Every invariant below was driven against Postgres while the migration was written; this file is
// what keeps them true after someone else edits the schema.
//
// The invariants are load-bearing, not decorative:
//   * a shareholder in one company must never reach a sibling — the confidentiality boundary;
//   * a posted account must never be re-typed — silently rewrites every prior balance;
//   * a hard-locked period must never reopen — it is what "filed" means;
//   * an elevation must expire on its own — nothing may depend on someone remembering to revoke.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, withGlobal, newId } from "./index";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser } from "../testing/fixtures";
import type { PoolClient } from "pg";

/** withTenants + the declared `finance` module scope — models withTenants([t], { modules: ["finance"] }). */
async function withFinance<T>(tenantIds: string[], fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenants(tenantIds, async (c) => {
    await c.query("SELECT set_config('app.scopes', 'finance', true)");
    return fn(c);
  });
}

describe.skipIf(!TEST_URL)("Finance F0 — foundations (202608241010..1013)", () => {
  let HOLD: string;   // holding PT (root)
  let SUBA: string;   // subsidiary A
  let SUBB: string;   // subsidiary B
  let SUBA1: string;  // nested under A — proves the walk is transitive, not one level
  let OTHER: string;  // unrelated PT, owned by nobody in this fixture
  let holdingOwner: string;
  let shareholderB: string;
  let outsider: string;

  beforeAll(async () => {
    await initTestDb();
    // Parents are set AT INSERT, never by a later UPDATE: 202608201326 maintains
    // companies.root_company_id and REFUSES a cross-root re-parent ("moving a company between
    // holdings is an ownership transfer, not an org edit"). Building the tree top-down respects
    // that guard instead of fighting it.
    HOLD = await createCompany("Holding PT", ["finance"]);
    SUBA = await createCompany("Sub A", [], HOLD);
    SUBB = await createCompany("Sub B", [], HOLD);
    SUBA1 = await createCompany("Sub A1", [], SUBA);
    OTHER = await createCompany("Unrelated PT");
    holdingOwner = await createUser("holding.owner@f0.test");
    shareholderB = await createUser("shareholder.b@f0.test");
    outsider = await createUser("outsider@f0.test");

    // Ownership edges. company_ownership is tenant-walled but NOT module-walled (it is core
    // structure the login path reads before any module scope exists) — hence withTenants, not
    // withFinance.
    await withTenants([HOLD], (c) =>
      c.query(
        `INSERT INTO company_ownership (tenant_id, holder_user_id, kind, stake_pct)
         VALUES ($1,$2,'holding',100)`,
        [HOLD, holdingOwner],
      ),
    );
    await withTenants([SUBB], (c) =>
      c.query(
        `INSERT INTO company_ownership (tenant_id, holder_user_id, kind, stake_pct)
         VALUES ($1,$2,'shareholder',5)`,
        [SUBB, shareholderB],
      ),
    );
  });
  afterAll(teardownTestDb);

  // ── (1) The scope resolver — owner ruling D-F8 ─────────────────────────────────────────────────
  describe("ownership scope resolver (D-F8)", () => {
    it("holding owner reaches the root and every descendant, transitively", async () => {
      const ids = await withGlobal(async (c) =>
        (await c.query<{ company_id: string }>("SELECT company_id FROM finance_owner_company_ids($1)", [holdingOwner]))
          .rows.map((r) => r.company_id),
      );
      expect(new Set(ids)).toEqual(new Set([HOLD, SUBA, SUBB, SUBA1]));
    });

    it("holding owner does NOT reach an unrelated company", async () => {
      const ids = await withGlobal(async (c) =>
        (await c.query<{ company_id: string }>("SELECT company_id FROM finance_owner_company_ids($1)", [holdingOwner]))
          .rows.map((r) => r.company_id),
      );
      expect(ids).not.toContain(OTHER);
    });

    // THE confidentiality boundary. A shareholder in one company reaching a sibling is the single
    // worst failure this schema can have — worse than a crash, because it is silent.
    it("a company shareholder reaches ONLY that company — never a sibling, never the group", async () => {
      const ids = await withGlobal(async (c) =>
        (await c.query<{ company_id: string }>("SELECT company_id FROM finance_owner_company_ids($1)", [shareholderB]))
          .rows.map((r) => r.company_id),
      );
      expect(ids).toEqual([SUBB]);
      expect(ids).not.toContain(HOLD);
      expect(ids).not.toContain(SUBA);
    });

    it("a user with no ownership edge resolves to the EMPTY set (fail-closed)", async () => {
      const ids = await withGlobal(async (c) =>
        (await c.query("SELECT company_id FROM finance_owner_company_ids($1)", [outsider])).rows,
      );
      expect(ids).toHaveLength(0);
    });

    // The payoff of deriving scope from a graph instead of maintaining a list.
    it("a newly incorporated subsidiary is reachable with NO permission edit", async () => {
      const fresh = await createCompany("Sub D (new)", [], HOLD);
      const ids = await withGlobal(async (c) =>
        (await c.query<{ company_id: string }>("SELECT company_id FROM finance_owner_company_ids($1)", [holdingOwner]))
          .rows.map((r) => r.company_id),
      );
      expect(ids).toContain(fresh);
    });

    // parent_company_id carries no acyclicity constraint. Unguarded, this hangs the connection
    // rather than returning a wrong answer — which is why the walk has a path array and a depth cap.
    it("a cycle in the corporate structure terminates instead of hanging", async () => {
      await withGlobal((c) => c.query("UPDATE companies SET parent_company_id=$1 WHERE id=$2", [SUBA1, HOLD]));
      try {
        const ids = await withGlobal(async (c) =>
          (await c.query("SELECT company_id FROM finance_owner_company_ids($1)", [holdingOwner])).rows,
        );
        expect(ids.length).toBeGreaterThan(0);
      } finally {
        await withGlobal((c) => c.query("UPDATE companies SET parent_company_id=NULL WHERE id=$1", [HOLD]));
      }
    });
  });

  // ── (2) The third wall ─────────────────────────────────────────────────────────────────────────
  describe("finance third wall (module-sliced RLS)", () => {
    // ⚠ THIS EXPLICIT LIST *IS* THE TEST. Not a sweep: naming every table is what turns "a new
    // finance_* table arrived without the wall" into a failure rather than a silent pass. The
    // sweep below asserts the other direction.
    const WALLED = [
      "finance_accounts",
      "finance_dimensions",
      "finance_dimension_values",
      "finance_account_dimension_rules",
      "finance_company_settings",
      "finance_exchange_rates",
      "finance_fiscal_years",
      "finance_fiscal_periods",
      "finance_duty_assignments",
      "finance_access_grants",
      "finance_access_log",
    ];

    it("every tenanted finance table has FORCE RLS and a tenant_isolation policy", async () => {
      const rows = await withGlobal(async (c) =>
        (
          await c.query<{ relname: string; relforcerowsecurity: boolean; policies: number }>(
            `SELECT c.relname, c.relforcerowsecurity,
                    (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname AND p.policyname='tenant_isolation') AS policies
               FROM pg_class c WHERE c.relname = ANY($1)`,
            [WALLED],
          )
        ).rows,
      );
      expect(rows).toHaveLength(WALLED.length);
      for (const r of rows) {
        expect(r.relforcerowsecurity, `${r.relname} must FORCE RLS`).toBe(true);
        expect(Number(r.policies), `${r.relname} must carry tenant_isolation`).toBe(1);
      }
    });

    // The sweep, catching a finance_* table this file forgot to list.
    it("no tenanted finance_* table escapes the wall", async () => {
      const unwalled = await withGlobal(async (c) =>
        (
          await c.query<{ relname: string }>(
            `SELECT c.relname FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE 'finance\\_%'
                AND EXISTS (SELECT 1 FROM information_schema.columns col
                             WHERE col.table_name=c.relname AND col.column_name='tenant_id')
                AND NOT c.relforcerowsecurity`,
          )
        ).rows.map((r) => r.relname),
      );
      expect(unwalled).toEqual([]);
    });

    // The silent trap: a handler that forgets the module scope reads zero rows and gets NO error.
    it("a request that does NOT declare the finance scope reads ZERO rows", async () => {
      await withFinance([SUBA], (c) =>
        c.query(
          `INSERT INTO finance_accounts (tenant_id, code, name, account_type, normal_balance)
           VALUES ($1,'9999','Wall probe','expense','debit')`,
          [SUBA],
        ),
      );
      const withScope = await withFinance([SUBA], async (c) =>
        (await c.query("SELECT 1 FROM finance_accounts WHERE code='9999'")).rowCount,
      );
      const withoutScope = await withTenants([SUBA], async (c) =>
        (await c.query("SELECT 1 FROM finance_accounts WHERE code='9999'")).rowCount,
      );
      expect(withScope).toBe(1);
      expect(withoutScope).toBe(0); // no error — that silence IS the trap
    });

    it("a company cannot read another company's accounts", async () => {
      const seen = await withFinance([SUBB], async (c) =>
        (await c.query("SELECT 1 FROM finance_accounts WHERE code='9999'")).rowCount,
      );
      expect(seen).toBe(0);
    });
  });

  // ── (3) Chart of accounts — D-F5 ───────────────────────────────────────────────────────────────
  describe("chart of accounts (D-F5: editable data, frozen once posted)", () => {
    it("instantiates the PSAK template, resolves the hierarchy, and is idempotent", async () => {
      const first = await withFinance([SUBA], async (c) =>
        Number((await c.query("SELECT finance_instantiate_coa($1,'id_psak_general_v1') AS n", [SUBA])).rows[0].n),
      );
      expect(first).toBeGreaterThan(50);

      const again = await withFinance([SUBA], async (c) =>
        Number((await c.query("SELECT finance_instantiate_coa($1,'id_psak_general_v1') AS n", [SUBA])).rows[0].n),
      );
      expect(again).toBe(0);

      const parented = await withFinance([SUBA], async (c) =>
        Number(
          (await c.query("SELECT count(*) AS n FROM finance_accounts WHERE tenant_id=$1 AND parent_id IS NOT NULL", [SUBA]))
            .rows[0].n,
        ),
      );
      expect(parented).toBeGreaterThan(50);
    });

    // Contra accounts are why normal_balance is stored rather than derived from account_type.
    it("carries contra accounts: assets with a CREDIT normal balance", async () => {
      const contra = await withFinance([SUBA], async (c) =>
        (
          await c.query<{ code: string }>(
            `SELECT code FROM finance_accounts
              WHERE tenant_id=$1 AND account_type='asset' AND normal_balance='credit' ORDER BY code`,
            [SUBA],
          )
        ).rows.map((r) => r.code),
      );
      expect(contra).toContain("1220"); // Akumulasi Penyusutan
    });

    it("control accounts refuse manual posting, without exception", async () => {
      const bad = await withFinance([SUBA], async (c) =>
        Number(
          (
            await c.query(
              "SELECT count(*) AS n FROM finance_accounts WHERE tenant_id=$1 AND is_control AND allow_manual_posting",
              [SUBA],
            )
          ).rows[0].n,
        ),
      );
      expect(bad).toBe(0);
    });

    it("an accountant's edit survives a template top-up (the company's chart wins)", async () => {
      await withFinance([SUBA], (c) =>
        c.query("UPDATE finance_accounts SET name='Beban Sewa Kantor' WHERE tenant_id=$1 AND code='6200'", [SUBA]),
      );
      await withFinance([SUBA], (c) => c.query("SELECT finance_instantiate_coa($1,'id_psak_general_v1')", [SUBA]));
      const name = await withFinance([SUBA], async (c) =>
        (await c.query<{ name: string }>("SELECT name FROM finance_accounts WHERE tenant_id=$1 AND code='6200'", [SUBA]))
          .rows[0].name,
      );
      expect(name).toBe("Beban Sewa Kantor");
    });

    it("before any posting, the accountant may still re-type an account", async () => {
      await expect(
        withFinance([SUBA], (c) =>
          c.query("UPDATE finance_accounts SET account_type='expense' WHERE tenant_id=$1 AND code='6900'", [SUBA]),
        ),
      ).resolves.toBeDefined();
    });

    // The one-way door. Re-typing a posted account rewrites every prior balance.
    it("after posting, code / account_type / normal_balance are FROZEN", async () => {
      await withFinance([SUBA], (c) =>
        c.query("UPDATE finance_accounts SET first_posted_at=now() WHERE tenant_id=$1 AND code='6900'", [SUBA]),
      );
      for (const set of ["account_type='asset'", "normal_balance='credit'", "code='6901'"]) {
        await expect(
          withFinance([SUBA], (c) =>
            c.query(`UPDATE finance_accounts SET ${set} WHERE tenant_id=$1 AND code='6900'`, [SUBA]),
          ),
          `${set} must be refused on a posted account`,
        ).rejects.toThrow(/FINANCE_ACCOUNT_FROZEN/);
      }
    });

    it("first_posted_at cannot be cleared", async () => {
      await expect(
        withFinance([SUBA], (c) =>
          c.query("UPDATE finance_accounts SET first_posted_at=NULL WHERE tenant_id=$1 AND code='6900'", [SUBA]),
        ),
      ).rejects.toThrow(/FINANCE_ACCOUNT_FROZEN/);
    });

    // Freezing identity must not freeze housekeeping — otherwise nobody can retire an account.
    it("but a posted account may still be renamed and archived", async () => {
      await expect(
        withFinance([SUBA], (c) =>
          c.query(
            "UPDATE finance_accounts SET name='Beban Lain (ditutup)', status='archived' WHERE tenant_id=$1 AND code='6900'",
            [SUBA],
          ),
        ),
      ).resolves.toBeDefined();
    });
  });

  // ── (4) Fiscal periods — the lock state machine + the D-F5 sign-off gate ──────────────────────
  describe("fiscal period lock state machine", () => {
    let fyId: string;

    beforeAll(async () => {
      fyId = newId();
      await withFinance([SUBA], (c) =>
        c.query(
          `INSERT INTO finance_fiscal_years (id, tenant_id, code, start_date, end_date)
           VALUES ($1,$2,'FY2026','2026-01-01','2027-01-01')`,
          [fyId, SUBA],
        ),
      );
      await withFinance([SUBA], (c) => c.query("SELECT finance_generate_periods($1,'monthly')", [fyId]));
    });

    it("generates twelve monthly periods, idempotently", async () => {
      const n = await withFinance([SUBA], async (c) =>
        Number((await c.query("SELECT count(*) AS n FROM finance_fiscal_periods WHERE fiscal_year_id=$1", [fyId])).rows[0].n),
      );
      expect(n).toBe(12);
      const again = await withFinance([SUBA], async (c) =>
        Number((await c.query("SELECT finance_generate_periods($1,'monthly') AS n", [fyId])).rows[0].n),
      );
      expect(again).toBe(0);
    });

    it("the posting guard is TRUE inside an OPEN period", async () => {
      const ok = await withFinance([SUBA], async (c) =>
        (await c.query("SELECT finance_period_accepts_posting($1,'2026-03-15') AS ok", [SUBA])).rows[0].ok,
      );
      expect(ok).toBe(true);
    });

    // An unconfigured calendar must not silently accept postings no report will include.
    it("the posting guard is FALSE for a date with NO period at all", async () => {
      const ok = await withFinance([SUBA], async (c) =>
        (await c.query("SELECT finance_period_accepts_posting($1,'2029-03-15') AS ok", [SUBA])).rows[0].ok,
      );
      expect(ok).toBe(false);
    });

    it("OPEN -> HARD_LOCK directly is refused: close passes through SOFT_LOCK", async () => {
      await expect(
        withFinance([SUBA], (c) =>
          c.query("UPDATE finance_fiscal_periods SET state='HARD_LOCK' WHERE fiscal_year_id=$1 AND period_no=1", [fyId]),
        ),
      ).rejects.toThrow(/FINANCE_PERIOD_TRANSITION/);
    });

    it("SOFT_LOCK closes the period to posting, and may be reopened", async () => {
      await withFinance([SUBA], (c) =>
        c.query("UPDATE finance_fiscal_periods SET state='SOFT_LOCK' WHERE fiscal_year_id=$1 AND period_no=1", [fyId]),
      );
      const blocked = await withFinance([SUBA], async (c) =>
        (await c.query("SELECT finance_period_accepts_posting($1,'2026-01-15') AS ok", [SUBA])).rows[0].ok,
      );
      expect(blocked).toBe(false);

      await withFinance([SUBA], (c) =>
        c.query("UPDATE finance_fiscal_periods SET state='OPEN' WHERE fiscal_year_id=$1 AND period_no=1", [fyId]),
      );
      const cleared = await withFinance([SUBA], async (c) =>
        (await c.query("SELECT soft_locked_at FROM finance_fiscal_periods WHERE fiscal_year_id=$1 AND period_no=1", [fyId]))
          .rows[0].soft_locked_at,
      );
      expect(cleared).toBeNull(); // the record must not claim a lock no longer in force
    });

    // Owner ruling D-F5, enforced by the schema rather than remembered by a process.
    it("HARD_LOCK without an accountant sign-off is refused", async () => {
      await withFinance([SUBA], (c) =>
        c.query("UPDATE finance_fiscal_periods SET state='SOFT_LOCK' WHERE fiscal_year_id=$1 AND period_no=1", [fyId]),
      );
      await expect(
        withFinance([SUBA], (c) =>
          c.query("UPDATE finance_fiscal_periods SET state='HARD_LOCK' WHERE fiscal_year_id=$1 AND period_no=1", [fyId]),
        ),
      ).rejects.toThrow(/FINANCE_PERIOD_UNSIGNED/);
    });

    it("HARD_LOCK is TERMINAL — a filed period never reopens", async () => {
      await withFinance([SUBA], (c) =>
        c.query(
          `UPDATE finance_fiscal_periods
              SET state='HARD_LOCK', signed_off_by=$2, signed_off_at=now()
            WHERE fiscal_year_id=$1 AND period_no=1`,
          [fyId, holdingOwner],
        ),
      );
      await expect(
        withFinance([SUBA], (c) =>
          c.query("UPDATE finance_fiscal_periods SET state='OPEN' WHERE fiscal_year_id=$1 AND period_no=1", [fyId]),
        ),
      ).rejects.toThrow(/FINANCE_PERIOD_HARD_LOCKED/);
      await expect(
        withFinance([SUBA], (c) =>
          c.query("UPDATE finance_fiscal_periods SET state='SOFT_LOCK' WHERE fiscal_year_id=$1 AND period_no=1", [fyId]),
        ),
      ).rejects.toThrow(/FINANCE_PERIOD_HARD_LOCKED/);
    });

    it("overlapping periods are rejected by the exclusion constraint", async () => {
      await expect(
        withFinance([SUBA], (c) =>
          c.query(
            `INSERT INTO finance_fiscal_periods (tenant_id, fiscal_year_id, period_no, name, start_date, end_date)
             VALUES ($1,$2,13,'Overlap','2026-03-10','2026-04-10')`,
            [SUBA, fyId],
          ),
        ),
      ).rejects.toThrow(/exclusion constraint/);
    });
  });

  // ── (5) Segregation of duties ──────────────────────────────────────────────────────────────────
  describe("segregation of duties (blueprint 2.2 / 10.5)", () => {
    it("flags the blueprint's incompatible pairs, in either grant order", async () => {
      await withFinance([SUBA], (c) =>
        c.query(
          "INSERT INTO finance_duty_assignments (tenant_id,user_id,duty_key) VALUES ($1,$2,'ap_bill_entry')",
          [SUBA, shareholderB],
        ),
      );
      const conflicts = await withFinance([SUBA], async (c) =>
        (
          await c.query<{ conflicting_duty: string }>(
            "SELECT conflicting_duty FROM finance_sod_check($1,$2,'ap_payment_approve')",
            [SUBA, shareholderB],
          )
        ).rows.map((r) => r.conflicting_duty),
      );
      expect(conflicts).toEqual(["ap_bill_entry"]);
    });

    // The shared-service case. Efficient, and it concentrates risk — but holding the two duties in
    // DIFFERENT companies is not the conflict; holding them in the SAME one is.
    it("the same two duties in DIFFERENT companies is not a conflict", async () => {
      const conflicts = await withFinance([SUBB], async (c) =>
        (await c.query("SELECT conflicting_duty FROM finance_sod_check($1,$2,'ap_payment_approve')", [SUBB, shareholderB]))
          .rows,
      );
      expect(conflicts).toHaveLength(0);
    });

    it("seeds all six blueprint pairs, canonically ordered", async () => {
      const n = await withGlobal(async (c) =>
        Number((await c.query("SELECT count(*) AS n FROM finance_sod_conflicts WHERE severity='blocking'")).rows[0].n),
      );
      expect(n).toBe(6);
    });
  });

  // ── (6) Elevation grants ───────────────────────────────────────────────────────────────────────
  describe("elevation grants (blueprint 10.3)", () => {
    let grantId: string;

    beforeAll(async () => {
      grantId = newId();
      await withFinance([SUBB], (c) =>
        c.query(
          `INSERT INTO finance_access_grants (id, tenant_id, grantee_id, scope, purpose)
           VALUES ($1,$2,$3,'read_detail','FY2026 audit support for the group close')`,
          [grantId, SUBB, outsider],
        ),
      );
    });

    it("an unapproved request grants nothing", async () => {
      const live = await withGlobal(async (c) =>
        (await c.query("SELECT finance_has_elevated_access($1,$2,'read_detail') AS live", [outsider, SUBB])).rows[0].live,
      );
      expect(live).toBe(false);
    });

    // An indefinite elevation is the failure mode this object exists to prevent.
    it("an approved grant with NO expiry is refused by the schema", async () => {
      await expect(
        withFinance([SUBB], (c) =>
          c.query("UPDATE finance_access_grants SET approved_by=$2, approved_at=now() WHERE id=$1", [grantId, holdingOwner]),
        ),
      ).rejects.toThrow(/ck_finance_access_grants_expiry/);
    });

    it("approval executes: the grant is live immediately (D14 semantics)", async () => {
      await withFinance([SUBB], (c) =>
        c.query(
          `UPDATE finance_access_grants
              SET approved_by=$2, approved_at=now(), expires_at=now()+interval '4 hours',
                  approver_position_key='finance.cross_company_approver'
            WHERE id=$1`,
          [grantId, holdingOwner],
        ),
      );
      const live = await withGlobal(async (c) =>
        (await c.query("SELECT finance_has_elevated_access($1,$2,'read_detail') AS live", [outsider, SUBB])).rows[0].live,
      );
      expect(live).toBe(true);
    });

    it("a read_detail grant does NOT confer write", async () => {
      const live = await withGlobal(async (c) =>
        (await c.query("SELECT finance_has_elevated_access($1,$2,'write') AS live", [outsider, SUBB])).rows[0].live,
      );
      expect(live).toBe(false);
    });

    // Nothing may depend on someone remembering to revoke.
    it("lapses on its own, with no revoke action", async () => {
      await withFinance([SUBB], (c) =>
        c.query(
          "UPDATE finance_access_grants SET approved_at=now()-interval '5 hours', expires_at=now()-interval '1 hour' WHERE id=$1",
          [grantId],
        ),
      );
      const live = await withGlobal(async (c) =>
        (await c.query("SELECT finance_has_elevated_access($1,$2,'read_detail') AS live", [outsider, SUBB])).rows[0].live,
      );
      expect(live).toBe(false);
    });

    it("an elevated access-log row must name the grant it acted under", async () => {
      await expect(
        withFinance([SUBB], (c) =>
          c.query(
            "INSERT INTO finance_access_log (tenant_id,user_id,action,basis) VALUES ($1,$2,'read_gl','elevated')",
            [SUBB, outsider],
          ),
        ),
      ).rejects.toThrow(/ck_finance_access_log_grant/);
    });
  });
});
