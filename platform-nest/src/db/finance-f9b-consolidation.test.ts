// Finance F9-01/02/03/05 — CONSOLIDATION. Migration 202608251530.
//
// The assertion this file exists for is the third one: after eliminating, the SUBSIDIARY'S OWN
// LEDGER IS UNCHANGED. An elimination is true of the group and false of the entity — Alpha really
// is owed 10m by Beta, and Alpha's statutory accounts must keep saying so. If an elimination ever
// reached an entity's books, its standalone statements and its tax return would both be wrong, and
// an auditor would find entries with no supporting transaction.
//
// Everything else here is in service of that.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, newId } from "./index";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany } from "../testing/fixtures";
import type { PoolClient } from "pg";

async function withFinance<T>(tenantIds: string[], fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenants(tenantIds, async (c) => {
    await c.query("SELECT set_config('app.scopes', 'finance', true)");
    return fn(c);
  });
}

describe.skipIf(!TEST_URL)("Finance F9 — consolidation ledger (202608251530)", () => {
  let H: string; // holding / reporting entity
  let A: string; // 100% subsidiary
  let B: string; // 60% subsidiary
  let ASSOC: string; // 30% associate — equity method, NOT consolidated
  let arCodeA: string;
  let apCodeB: string;

  beforeAll(async () => {
    await initTestDb();
    H = await createCompany("Holding PT");
    A = await createCompany("Alpha PT", [], H);
    B = await createCompany("Beta PT", [], H);
    ASSOC = await createCompany("Gamma PT", [], H);

    for (const co of [H, A, B, ASSOC]) {
      await withFinance([co], async (c) => {
        await c.query(
          `INSERT INTO finance_company_settings (tenant_id,functional_currency,presentation_currency,fiscal_year_start_month)
           VALUES ($1,'IDR','IDR',1) ON CONFLICT (tenant_id) DO NOTHING`,
          [co],
        );
        await c.query(`SELECT finance_instantiate_coa($1,'id_psak_general_v1')`, [co]);
        const fy = await c.query<{ id: string }>(
          `INSERT INTO finance_fiscal_years (tenant_id,code,start_date,end_date)
           VALUES ($1,'FY2026','2026-01-01','2027-01-01') RETURNING id`,
          [co],
        );
        await c.query(`SELECT finance_generate_periods($1,'monthly')`, [fy.rows[0].id]);
      });
    }

    // Ownership edges held by the HOLDING company (entity holder, so kind='holding' where it
    // controls). stake_pct drives the consolidation basis.
    //
    // ★ effective_from is set EXPLICITLY. It defaults to CURRENT_DATE, so an edge created today is
    // not yet effective at a June as-of date and finance_group_members() correctly excludes it —
    // the first version of this fixture relied on the default and the group came back empty, which
    // is the effective-dating working, not failing. Ownership changes, and last year's statements
    // were true under last year's cap table.
    await withFinance([A], (c) =>
      c.query(
        `INSERT INTO company_ownership (id,tenant_id,holder_company_id,kind,stake_pct,effective_from)
         VALUES ($1,$2,$3,'holding',100,'2026-01-01')`,
        [newId(), A, H],
      ),
    );
    await withFinance([B], (c) =>
      c.query(
        `INSERT INTO company_ownership (id,tenant_id,holder_company_id,kind,stake_pct,effective_from)
         VALUES ($1,$2,$3,'holding',60,'2026-01-01')`,
        [newId(), B, H],
      ),
    );
    await withFinance([ASSOC], (c) =>
      c.query(
        `INSERT INTO company_ownership (id,tenant_id,holder_company_id,kind,stake_pct,effective_from)
         VALUES ($1,$2,$3,'shareholder',30,'2026-01-01')`,
        [newId(), ASSOC, H],
      ),
    );
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  it("★ control is DERIVED from the stake, and reports the basis it used", async () => {
    // Scope must already hold the candidate tenants — see the migration header. Called with
    // withGlobal it returns the parent alone, silently, because an empty ownership read looks
    // exactly like "no subsidiaries".
    const rows = await withFinance([H, A, B, ASSOC], async (c) =>
      (
        await c.query<{ company_id: string; consolidation: string; nci_pct: string; basis: string }>(
          `SELECT * FROM finance_group_members($1,'2026-06-30')`,
          [H],
        )
      ).rows,
    );
    const by = Object.fromEntries(rows.map((r) => [r.company_id, r]));
    expect(by[H].consolidation).toBe("parent");
    expect(by[A].consolidation).toBe("full");
    expect(Number(by[A].nci_pct)).toBe(0);
    expect(by[B].consolidation).toBe("full");
    // ★ 60% held means 40% belongs to somebody else, and the group must carve it out.
    expect(Number(by[B].nci_pct)).toBe(40);
    // 30% is significant influence, NOT control — equity method, never line-by-line consolidation.
    expect(by[ASSOC].consolidation).toBe("equity");
    expect(Number(by[ASSOC].nci_pct)).toBe(0);
    expect(by[ASSOC].basis).toMatch(/PSAK 15/);
  });

  it("an intercompany balance between two group members eliminates, and the set BALANCES", async () => {
    // Set up matched sides: A owed 10m by B.
    const mk = async (co: string, cp: string) =>
      (
        await withFinance([co], async (c) =>
          (
            await c.query<{ account_code: string }>(`SELECT * FROM finance_ensure_intercompany_accounts($1,$2)`, [co, cp])
          ).rows,
        )
      ).map((r) => r.account_code);
    [arCodeA] = await mk(A, B);
    const bPair = await mk(B, A);
    apCodeB = bPair[1];

    await withFinance([A], (c) =>
      c.query(`SELECT finance_post_journal($1,'2026-06-30','ic-a','svc',$2::jsonb)`, [
        A,
        JSON.stringify([
          { account_code: arCodeA, side: "debit", amount: 10_000_000, memo: "due from Beta" },
          { account_code: "4100", side: "credit", amount: 10_000_000, memo: "rev" },
        ]),
      ]),
    );
    await withFinance([B], (c) =>
      c.query(`SELECT finance_post_journal($1,'2026-06-30','ic-b','svc',$2::jsonb)`, [
        B,
        JSON.stringify([
          { account_code: "6900", side: "debit", amount: 10_000_000, memo: "exp" },
          { account_code: apCodeB, side: "credit", amount: 10_000_000, memo: "due to Alpha" },
        ]),
      ]),
    );

    const runId = await withFinance([H], async (c) =>
      (
        await c.query<{ id: string }>(
          `INSERT INTO finance_consolidation_runs (tenant_id, as_of, label) VALUES ($1,'2026-06-30','H1') RETURNING id`,
          [H],
        )
      ).rows[0].id,
    );
    const n = await withFinance([H, A, B, ASSOC], async (c) =>
      Number((await c.query<{ n: string }>(`SELECT finance_eliminate_intercompany($1) n`, [runId])).rows[0].n),
    );
    expect(n).toBe(2);

    const bal = await withFinance([H], async (c) =>
      (
        await c.query<{ total_debit: string; total_credit: string; balanced: boolean }>(
          `SELECT * FROM finance_consolidation_balanced($1)`,
          [runId],
        )
      ).rows[0],
    );
    expect(Number(bal.total_debit)).toBe(10_000_000);
    expect(Number(bal.total_credit)).toBe(10_000_000);
    expect(bal.balanced).toBe(true);
  });

  it("★★ the subsidiary's OWN ledger is untouched — the elimination is true of the group, not the entity", async () => {
    // The single most important assertion in F9. Alpha really IS owed 10m by Beta; Alpha's
    // statutory accounts and tax return must keep saying so.
    const aReceivable = await withFinance([A], async (c) =>
      Number(
        (
          await c.query<{ b: string }>(
            `SELECT COALESCE(sum(m.balance),0) b FROM finance_account_movement($1,NULL,'2026-06-30') m
               JOIN finance_accounts acc ON acc.id=m.account_id WHERE acc.code=$2`,
            [A, arCodeA],
          )
        ).rows[0].b,
      ),
    );
    expect(aReceivable).toBe(10_000_000);

    // And no journal in A mentions consolidation.
    const consolJournals = await withFinance([A], async (c) =>
      Number(
        (
          await c.query<{ n: string }>(
            `SELECT count(*) n FROM finance_journal_entries WHERE tenant_id=$1 AND source_event_id LIKE 'consol%'`,
            [A],
          )
        ).rows[0].n,
      ),
    );
    expect(consolJournals).toBe(0);
  });

  it("★ a DISAGREEING pair refuses to eliminate rather than netting the difference", async () => {
    // B pays 3m; A has not recorded it. Netting would hide a real reconciling item (cash in
    // transit); forcing it to one side would invent a number.
    await withFinance([B], (c) =>
      c.query(`SELECT finance_post_journal($1,'2026-07-31','ic-b2','part pay',$2::jsonb)`, [
        B,
        JSON.stringify([
          { account_code: apCodeB, side: "debit", amount: 3_000_000, memo: "paid" },
          { account_code: "1120", side: "credit", amount: 3_000_000, memo: "bank" },
        ]),
      ]),
    );
    const runId = await withFinance([H], async (c) =>
      (
        await c.query<{ id: string }>(
          `INSERT INTO finance_consolidation_runs (tenant_id, as_of) VALUES ($1,'2026-07-31') RETURNING id`,
          [H],
        )
      ).rows[0].id,
    );
    await expect(
      withFinance([H, A, B, ASSOC], (c) => c.query(`SELECT finance_eliminate_intercompany($1)`, [runId])),
    ).rejects.toThrow(/FINANCE_INTERCOMPANY_MISMATCH/);
  });

  it("a balance with an entity OUTSIDE the group is not eliminated", async () => {
    // A real external related-party balance must survive consolidation — eliminating it would
    // remove a genuine asset from the group.
    const OUT = await createCompany("Outside PT", [], H); // in the same ROOT but not owned
    await withFinance([OUT], async (c) => {
      await c.query(
        `INSERT INTO finance_company_settings (tenant_id,functional_currency,presentation_currency,fiscal_year_start_month)
         VALUES ($1,'IDR','IDR',1) ON CONFLICT (tenant_id) DO NOTHING`,
        [OUT],
      );
      await c.query(`SELECT finance_instantiate_coa($1,'id_psak_general_v1')`, [OUT]);
    });
    const [outAr] = (
      await withFinance([A], async (c) =>
        (
          await c.query<{ account_code: string }>(`SELECT * FROM finance_ensure_intercompany_accounts($1,$2)`, [A, OUT])
        ).rows,
      )
    ).map((r) => r.account_code);
    await withFinance([A], (c) =>
      c.query(`SELECT finance_post_journal($1,'2026-08-31','ext','external related party',$2::jsonb)`, [
        A,
        JSON.stringify([
          { account_code: outAr, side: "debit", amount: 2_000_000, memo: "due from Outside" },
          { account_code: "4100", side: "credit", amount: 2_000_000, memo: "rev" },
        ]),
      ]),
    );

    const runId = await withFinance([H], async (c) =>
      (
        await c.query<{ id: string }>(
          `INSERT INTO finance_consolidation_runs (tenant_id, as_of) VALUES ($1,'2026-08-31') RETURNING id`,
          [H],
        )
      ).rows[0].id,
    );
    // Resolve the earlier mismatch first so this run can proceed.
    await withFinance([A], (c) =>
      c.query(`SELECT finance_post_journal($1,'2026-08-31','ic-a2','receipt',$2::jsonb)`, [
        A,
        JSON.stringify([
          { account_code: "1120", side: "debit", amount: 3_000_000, memo: "bank" },
          { account_code: arCodeA, side: "credit", amount: 3_000_000, memo: "from Beta" },
        ]),
      ]),
    );
    const n = await withFinance([H, A, B, ASSOC], async (c) =>
      Number((await c.query<{ n: string }>(`SELECT finance_eliminate_intercompany($1) n`, [runId])).rows[0].n),
    );
    // Only the Alpha<->Beta pair eliminated (2 entries). The Outside balance survived.
    expect(n).toBe(2);
    const entries = await withFinance([H], async (c) =>
      (
        await c.query<{ amount: string }>(`SELECT amount FROM finance_consolidation_entries WHERE run_id=$1`, [runId])
      ).rows,
    );
    expect(entries.every((e) => Number(e.amount) === 7_000_000)).toBe(true); // 10m less the 3m settled
  });
});
