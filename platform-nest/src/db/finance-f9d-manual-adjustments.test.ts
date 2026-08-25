// Finance F9-07 / F9-10 / F9-11 — the recording path for what cannot be computed.
//
// These three adjustments are real and required, and none is derivable from anything this system
// holds: unrealised profit needs an inventory count, goodwill needs fair value at acquisition, FX
// translation needs a non-IDR subsidiary. The alternative to recording them is a compute function
// that produces a plausible figure from data that cannot support it — a wrong number with a
// function signature, believed precisely because the system produced it.
//
// So the tests here are about what CAN be enforced without the source data: that an adjustment is
// well-formed, that it balances ON ITS OWN, and that the run says what it has not addressed.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, newId } from "./index";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser } from "../testing/fixtures";
import type { PoolClient } from "pg";

async function fin<T>(t: string[], fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenants(t, async (c) => {
    await c.query("SELECT set_config('app.scopes','finance',true)");
    return fn(c);
  });
}

describe.skipIf(!TEST_URL)("Finance F9 — manual consolidation adjustments (202608252130)", () => {
  let H: string, A: string, B: string, ALL: string[], actor: string;

  beforeAll(async () => {
    await initTestDb();
    H = await createCompany("Holding PT");
    A = await createCompany("Alpha PT", [], H);
    B = await createCompany("Beta PT", [], H);
    ALL = [H, A, B];
    actor = await createUser("consol@f9d.test");
    for (const co of ALL) {
      await fin([co], async (c) => {
        await c.query(
          `INSERT INTO finance_company_settings (tenant_id,functional_currency,presentation_currency,fiscal_year_start_month)
           VALUES ($1,'IDR','IDR',1) ON CONFLICT (tenant_id) DO NOTHING`,
          [co],
        );
        await c.query(`SELECT finance_instantiate_coa($1,'id_psak_general_v1')`, [co]);
      });
    }
    // Alpha wholly owned; Beta 60% so an NCI note is reachable.
    for (const [co, pct] of [[A, 100], [B, 60]] as const) {
      await fin([co], (c) =>
        c.query(
          `INSERT INTO company_ownership (id,tenant_id,holder_company_id,kind,stake_pct,effective_from)
           VALUES ($1,$2,$3,'holding',$4,'2026-01-01')`,
          [newId(), co, H, pct],
        ),
      );
    }
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  const newRun = () =>
    fin([H], async (c) =>
      (
        await c.query<{ id: string }>(
          `INSERT INTO finance_consolidation_runs (tenant_id,as_of,label) VALUES ($1,'2026-06-30','H1') RETURNING id`,
          [H],
        )
      ).rows[0].id,
    );
  const record = (run: string, kind: string, subject: string, lines: unknown[], memo?: string) =>
    fin(ALL, (c) =>
      c.query(`SELECT finance_record_consolidation_adjustment($1,$2,$3,$4::jsonb,$5)`, [
        run, kind, subject, JSON.stringify(lines), memo ?? null,
      ]),
    );

  it("★ an unrealised-profit adjustment records, and it must BALANCE ON ITS OWN", async () => {
    const run = await newRun();
    // Alpha sold stock to Beta at a 5m margin; Beta still holds it, so the group has not earned it.
    const n = await fin(ALL, async (c) =>
      Number(
        (
          await c.query<{ n: string }>(
            `SELECT finance_record_consolidation_adjustment($1,'unrealised_profit',$2,$3::jsonb,$4) n`,
            [
              run, A,
              JSON.stringify([
                { account_code: "4100", side: "debit", amount: 5_000_000, memo: "reverse intragroup margin" },
                { account_code: "1150", side: "credit", amount: 5_000_000, memo: "write stock down to group cost" },
              ]),
              "Stock still on hand at Beta",
            ],
          )
        ).rows[0].n,
      ),
    );
    expect(n).toBe(2);
  });

  it("★★ an UNBALANCED adjustment is refused — two wrong entries must not cancel into a right total", async () => {
    // Checking only the run total would let this through as long as something else was wrong the
    // other way. An auditor reads the ENTRIES, not just the total.
    const run = await newRun();
    await expect(
      record(run, "goodwill", A, [
        { account_code: "1230", side: "debit", amount: 9_000_000 },
        { account_code: "3300", side: "credit", amount: 4_000_000 },
      ]),
    ).rejects.toThrow(/FINANCE_ADJUSTMENT_UNBALANCED/);
  });

  it("★ a COMPUTED kind cannot be hand-entered beside the generated one", async () => {
    // The failure this prevents: someone types an intercompany elimination that the generator also
    // produces, and the same balance is removed twice.
    const run = await newRun();
    await expect(
      record(run, "ic_balance", A, [
        { account_code: "1290", side: "credit", amount: 1_000_000 },
        { account_code: "2290", side: "debit", amount: 1_000_000 },
      ]),
    ).rejects.toThrow(/FINANCE_ADJUSTMENT_KIND_NOT_MANUAL/);
  });

  it("an account that does not exist in the subject company is refused", async () => {
    const run = await newRun();
    await expect(
      record(run, "goodwill", A, [
        { account_code: "9999", side: "debit", amount: 1_000 },
        { account_code: "3300", side: "credit", amount: 1_000 },
      ]),
    ).rejects.toThrow(/FINANCE_UNKNOWN_ACCOUNT/);
  });

  it("a negative amount is refused — the SIDE carries the direction", async () => {
    const run = await newRun();
    await expect(
      record(run, "goodwill", A, [
        { account_code: "1230", side: "debit", amount: -5_000 },
        { account_code: "3300", side: "credit", amount: -5_000 },
      ]),
    ).rejects.toThrow(/FINANCE_BAD_AMOUNT/);
  });

  it("★ completeness: an unrecorded NCI is REPORTED — the group would be claiming what it only controls", async () => {
    const run = await newRun();
    const notes = await fin(ALL, async (c) =>
      (
        await c.query<{ note: string; detail: string }>(`SELECT * FROM finance_consolidation_completeness($1)`, [run])
      ).rows,
    );
    // Beta is 60% held, so 40% belongs to somebody else and must be carved out.
    expect(notes.some((n) => n.note === "NCI_NOT_RECORDED")).toBe(true);
    // And the two that cannot be derived are named as not-considered rather than assumed absent.
    expect(notes.some((n) => n.note === "UNREALISED_PROFIT_NOT_CONSIDERED")).toBe(true);
    expect(notes.some((n) => n.note === "GOODWILL_NOT_CONSIDERED")).toBe(true);
  });

  it("★ recording the adjustment clears its note — 'considered' becomes distinguishable from 'ignored'", async () => {
    const run = await newRun();
    await record(run, "nci", B, [
      { account_code: "3300", side: "debit", amount: 20_000_000, memo: "carve out the minority" },
      { account_code: "3200", side: "credit", amount: 20_000_000, memo: "non-controlling interest" },
    ]);
    const notes = await fin(ALL, async (c) =>
      (await c.query<{ note: string }>(`SELECT * FROM finance_consolidation_completeness($1)`, [run])).rows,
    );
    expect(notes.some((n) => n.note === "NCI_NOT_RECORDED")).toBe(false);
    // The other two remain outstanding, correctly.
    expect(notes.some((n) => n.note === "GOODWILL_NOT_CONSIDERED")).toBe(true);
  });

  it("a recorded adjustment leaves the run BALANCED", async () => {
    const run = await newRun();
    await record(run, "goodwill", A, [
      { account_code: "1230", side: "debit", amount: 12_000_000, memo: "goodwill on acquisition" },
      { account_code: "3300", side: "credit", amount: 12_000_000, memo: "goodwill on acquisition" },
    ]);
    const bal = await fin([H], async (c) =>
      (
        await c.query<{ balanced: boolean; total_debit: string }>(
          `SELECT * FROM finance_consolidation_balanced($1)`,
          [run],
        )
      ).rows[0],
    );
    expect(bal.balanced).toBe(true);
    expect(Number(bal.total_debit)).toBe(12_000_000);
  });
});
