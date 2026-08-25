// Finance F1 — LEDGER CORE: balance, immutability, idempotency, period guard, reversal, tamper evidence.
//
// Covers migration 202608241015 (with F0's 202608241010..1013 underneath). Runs through the
// NOSUPERUSER NOBYPASSRLS app role, so RLS and the triggers are genuinely exercised.
//
// Every assertion here is a property an auditor or a bank credit team actually tests. They are not
// unit tests of helper functions — they are the guarantees the ledger sells:
//
//   * a journal can never be unbalanced          (the definition of double entry)
//   * a posted journal can never be edited        (the difference between a ledger and a CRUD app)
//   * one business event can never post twice     (what makes retries and integrations safe)
//   * nothing posts into a locked period          (what "closed" means)
//   * a correction is a reversal, both visible    (what an auditor traces)
//   * altering history is DETECTABLE              (what the hash chain is for)
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, withGlobal, newId } from "./index";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser } from "../testing/fixtures";
import type { PoolClient } from "pg";

async function withFinance<T>(tenantIds: string[], fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenants(tenantIds, async (c) => {
    await c.query("SELECT set_config('app.scopes', 'finance', true)");
    return fn(c);
  });
}

/** Post through the ONE sanctioned entry point. Lines are [account_code, side, amount] triples. */
async function post(
  company: string,
  date: string,
  source: string,
  description: string,
  lines: Array<[string, "debit" | "credit", number]>,
  actor?: string,
): Promise<string> {
  const payload = lines.map(([account_code, side, amount]) => ({ account_code, side, amount }));
  return withFinance([company], async (c) =>
    (
      await c.query<{ id: string }>(
        "SELECT finance_post_journal($1,$2::date,$3,$4,$5::jsonb,$6) AS id",
        [company, date, source, description, JSON.stringify(payload), actor ?? null],
      )
    ).rows[0].id,
  );
}

describe.skipIf(!TEST_URL)("Finance F1 — ledger core (202608241015)", () => {
  let CO: string;
  let accountant: string;
  let fyId: string;

  beforeAll(async () => {
    await initTestDb();
    CO = await createCompany("Ledger Co", ["finance"]);
    accountant = await createUser("accountant@f1.test");

    await withFinance([CO], (c) =>
      c.query(
        `INSERT INTO finance_company_settings (tenant_id, functional_currency, presentation_currency)
         VALUES ($1,'IDR','IDR')`,
        [CO],
      ),
    );
    await withFinance([CO], (c) => c.query("SELECT finance_instantiate_coa($1,'id_psak_general_v1')", [CO]));

    fyId = newId();
    await withFinance([CO], (c) =>
      c.query(
        `INSERT INTO finance_fiscal_years (id, tenant_id, code, start_date, end_date)
         VALUES ($1,$2,'FY2026','2026-01-01','2027-01-01')`,
        [fyId, CO],
      ),
    );
    await withFinance([CO], (c) => c.query("SELECT finance_generate_periods($1,'monthly')", [fyId]));
  });
  afterAll(teardownTestDb);

  // ── (1) Balance — the definition of double entry ───────────────────────────────────────────────
  describe("balance", () => {
    it("posts a balanced journal and starts the chain", async () => {
      const id = await post(CO, "2026-03-15", "evt-rent-03", "Office rent March", [
        ["6200", "debit", 10_000_000],
        ["1120", "credit", 10_000_000],
      ], accountant);
      expect(id).toBeTruthy();

      const row = await withFinance([CO], async (c) =>
        (
          await c.query<{ ledger_sequence: string; total_debit: string; prev_hash: string | null; entry_hash: string }>(
            "SELECT ledger_sequence, total_debit, prev_hash, entry_hash FROM finance_journal_entries WHERE id=$1",
            [id],
          )
        ).rows[0],
      );
      expect(Number(row.ledger_sequence)).toBe(1);
      expect(Number(row.total_debit)).toBe(10_000_000);
      expect(row.prev_hash).toBeNull(); // first entry in this company's chain
      expect(row.entry_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("REFUSES an unbalanced journal", async () => {
      await expect(
        post(CO, "2026-03-16", "evt-bad-balance", "Unbalanced", [
          ["6300", "debit", 100],
          ["1120", "credit", 90],
        ]),
      ).rejects.toThrow(/FINANCE_UNBALANCED/);
    });

    it("REFUSES a zero or negative line amount", async () => {
      await expect(
        post(CO, "2026-03-16", "evt-bad-amount", "Zero line", [
          ["6300", "debit", 0],
          ["1120", "credit", 0],
        ]),
      ).rejects.toThrow(/FINANCE_BAD_AMOUNT/);
    });

    it("REFUSES an empty journal", async () => {
      await expect(
        withFinance([CO], (c) =>
          c.query("SELECT finance_post_journal($1,'2026-03-16','evt-empty','Nothing','[]'::jsonb)", [CO]),
        ),
      ).rejects.toThrow(/FINANCE_EMPTY_JOURNAL/);
    });
  });

  // ── (2) Account guards ─────────────────────────────────────────────────────────────────────────
  describe("account guards", () => {
    // Posting to a parent makes its children's total a lie.
    it("REFUSES posting to a header account", async () => {
      await expect(
        post(CO, "2026-03-16", "evt-header", "To a header", [
          ["6000", "debit", 100],
          ["1120", "credit", 100],
        ]),
      ).rejects.toThrow(/FINANCE_ACCOUNT_NOT_POSTABLE/);
    });

    // A control account is reconciled to its subledger; a free-hand journal is how AR stops
    // agreeing with the aging.
    it("REFUSES a manual journal into a control account (AR)", async () => {
      await expect(
        post(CO, "2026-03-16", "evt-control", "Manual into AR", [
          ["1130", "debit", 100],
          ["4100", "credit", 100],
        ]),
      ).rejects.toThrow(/FINANCE_MANUAL_POSTING_BARRED/);
    });

    // Bank and cash are reconciled against a STATEMENT, not a subledger — recording a payment from
    // the bank is ordinary bookkeeping and must work. (The F0 seed originally barred it; driving
    // the first real posting caught that.)
    it("ALLOWS posting to bank and cash — they are not subledger-controlled", async () => {
      const control = await withFinance([CO], async (c) =>
        (
          await c.query<{ code: string }>(
            "SELECT code FROM finance_accounts WHERE tenant_id=$1 AND is_control ORDER BY code",
            [CO],
          )
        ).rows.map((r) => r.code),
      );
      // The pin is the point: a new control account BARS manual journals from it, which is a
      // change to what an accountant can do. It must be a deliberate edit here, not a surprise.
      //
      //   1130 Piutang Usaha / 2110 Utang Usaha   — AR, AP (F0)
      //   1150 Persediaan                          — inventory (F0, no subledger yet)
      //   1210 Aset Tetap / 1220 Akumulasi         — fixed assets (F8)
      //   1270 / 2220 / 2230                       — loans receivable, bonds, lease liability (F11)
      //
      // 2210 Utang Bank Jangka Panjang is deliberately NOT here. An ordinary bank loan is drawn by
      // a manual journal, and barring that would leave no way to record one.
      expect(control).toEqual(["1130", "1150", "1210", "1220", "1270", "2110", "2220", "2230"]);
      expect(control).not.toContain("1120"); // Bank
      expect(control).not.toContain("1110"); // Cash
    });

    it("REFUSES an unknown account code", async () => {
      await expect(
        post(CO, "2026-03-16", "evt-unknown", "Nonexistent", [
          ["9999", "debit", 100],
          ["1120", "credit", 100],
        ]),
      ).rejects.toThrow(/FINANCE_UNKNOWN_ACCOUNT/);
    });

    // Closes the F0-03 loop: posting arms the freeze trigger on every account it touches.
    it("stamps first_posted_at, which ARMS the F0 account freeze", async () => {
      const armed = await withFinance([CO], async (c) =>
        (
          await c.query<{ code: string }>(
            "SELECT code FROM finance_accounts WHERE tenant_id=$1 AND first_posted_at IS NOT NULL ORDER BY code",
            [CO],
          )
        ).rows.map((r) => r.code),
      );
      expect(armed).toContain("6200");
      expect(armed).toContain("1120");

      await expect(
        withFinance([CO], (c) =>
          c.query("UPDATE finance_accounts SET account_type='asset' WHERE tenant_id=$1 AND code='6200'", [CO]),
        ),
      ).rejects.toThrow(/FINANCE_ACCOUNT_FROZEN/);
    });
  });

  // ── (3) Idempotency — what makes retries and integrations safe ────────────────────────────────
  describe("idempotency", () => {
    it("the same source event returns the SAME entry and does not double-post", async () => {
      const before = await withFinance([CO], async (c) =>
        Number((await c.query("SELECT count(*) AS n FROM finance_journal_entries WHERE tenant_id=$1", [CO])).rows[0].n),
      );
      const first = await withFinance([CO], async (c) =>
        (await c.query<{ id: string }>("SELECT id FROM finance_journal_entries WHERE source_event_id='evt-rent-03'"))
          .rows[0].id,
      );
      const again = await post(CO, "2026-03-15", "evt-rent-03", "Office rent March", [
        ["6200", "debit", 10_000_000],
        ["1120", "credit", 10_000_000],
      ]);
      const after = await withFinance([CO], async (c) =>
        Number((await c.query("SELECT count(*) AS n FROM finance_journal_entries WHERE tenant_id=$1", [CO])).rows[0].n),
      );
      expect(again).toBe(first);
      expect(after).toBe(before);
    });
  });

  // ── (4) The period guard — what "closed" means ────────────────────────────────────────────────
  describe("period guard", () => {
    it("REFUSES a date that falls in NO period, rather than silently accepting it", async () => {
      await expect(
        post(CO, "2029-01-05", "evt-no-period", "Outside the calendar", [
          ["6300", "debit", 500],
          ["1120", "credit", 500],
        ]),
      ).rejects.toThrow(/FINANCE_NO_PERIOD/);
    });

    it("REFUSES posting into a soft-locked period", async () => {
      await withFinance([CO], (c) =>
        c.query("UPDATE finance_fiscal_periods SET state='SOFT_LOCK' WHERE tenant_id=$1 AND period_no=6", [CO]),
      );
      await expect(
        post(CO, "2026-06-10", "evt-locked", "Into a locked period", [
          ["6300", "debit", 500],
          ["1120", "credit", 500],
        ]),
      ).rejects.toThrow(/FINANCE_PERIOD_CLOSED/);
    });
  });

  // ── (5) Immutability — the difference between a ledger and a CRUD app ─────────────────────────
  describe("immutability", () => {
    it("REFUSES UPDATE and DELETE on an entry", async () => {
      for (const sql of [
        "UPDATE finance_journal_entries SET description='tampered' WHERE tenant_id=$1",
        "DELETE FROM finance_journal_entries WHERE tenant_id=$1",
      ]) {
        await expect(withFinance([CO], (c) => c.query(sql, [CO])), sql).rejects.toThrow(
          /FINANCE_LEDGER_IMMUTABLE/,
        );
      }
    });

    // Regression pin: this used to raise `record "old" has no field "entry_hash"` because the
    // trigger tested an entries-only column in a flat AND-chain. Still blocked, but with a
    // confusing internal error instead of this function's own message.
    it("REFUSES UPDATE on a LINE with the ledger's own error, not an internal one", async () => {
      await expect(
        withFinance([CO], (c) => c.query("UPDATE finance_journal_lines SET amount=999 WHERE tenant_id=$1", [CO])),
      ).rejects.toThrow(/FINANCE_LEDGER_IMMUTABLE/);
    });
  });

  // ── (6) Reversal — correction is a new entry, both visible ────────────────────────────────────
  describe("reversal", () => {
    let originalId: string;
    let reversalId: string;

    it("posts a mirrored entry and leaves the original untouched", async () => {
      originalId = await withFinance([CO], async (c) =>
        (await c.query<{ id: string }>("SELECT id FROM finance_journal_entries WHERE source_event_id='evt-rent-03'"))
          .rows[0].id,
      );
      reversalId = await withFinance([CO], async (c) =>
        (
          await c.query<{ id: string }>(
            "SELECT finance_reverse_journal($1,$2,$3,'2026-04-02'::date) AS id",
            [originalId, "Booked to the wrong period, re-booking to April", accountant],
          )
        ).rows[0].id,
      );

      const sides = await withFinance([CO], async (c) =>
        (
          await c.query<{ code: string; side: string }>(
            `SELECT a.code, l.side FROM finance_journal_lines l
               JOIN finance_accounts a ON a.id = l.account_id
              WHERE l.entry_id = $1 ORDER BY l.line_no`,
            [reversalId],
          )
        ).rows,
      );
      // The original was 6200 debit / 1120 credit.
      expect(sides).toEqual([
        { code: "6200", side: "credit" },
        { code: "1120", side: "debit" },
      ]);
    });

    it("derives status from the forward-only link — nothing on the original is updated", async () => {
      const [orig, rev] = await withFinance([CO], async (c) => [
        (await c.query<{ s: string }>("SELECT finance_journal_entry_status($1) AS s", [originalId])).rows[0].s,
        (await c.query<{ s: string }>("SELECT finance_journal_entry_status($1) AS s", [reversalId])).rows[0].s,
      ]);
      expect(orig).toBe("reversed");
      expect(rev).toBe("reversal");
    });

    it("REFUSES reversing the same entry twice", async () => {
      await expect(
        withFinance([CO], (c) =>
          c.query("SELECT finance_reverse_journal($1,$2)", [originalId, "Trying again with no new reason"]),
        ),
      ).rejects.toThrow(/FINANCE_ALREADY_REVERSED/);
    });

    it("REFUSES reversing a reversal", async () => {
      await expect(
        withFinance([CO], (c) =>
          c.query("SELECT finance_reverse_journal($1,$2)", [reversalId, "Reversing the reversal"]),
        ),
      ).rejects.toThrow(/FINANCE_REVERSAL_OF_REVERSAL/);
    });

    it("REQUIRES a substantive reason", async () => {
      const other = await post(CO, "2026-05-05", "evt-may", "May utilities", [
        ["6300", "debit", 750_000],
        ["1120", "credit", 750_000],
      ]);
      await expect(
        withFinance([CO], (c) => c.query("SELECT finance_reverse_journal($1,'oops')", [other])),
      ).rejects.toThrow(/FINANCE_REVERSAL_REASON_REQUIRED/);
    });
  });

  // ── (7) Tamper evidence — what the hash chain is for ──────────────────────────────────────────
  describe("chain verification", () => {
    it("reports ZERO problems on an untouched ledger", async () => {
      const problems = await withFinance([CO], async (c) =>
        (await c.query("SELECT * FROM finance_verify_ledger_chain($1)", [CO])).rows,
      );
      expect(problems).toEqual([]);
    });

    it("each entry's prev_hash links to the previous entry's hash", async () => {
      const broken = await withFinance([CO], async (c) =>
        (
          await c.query(
            `SELECT ledger_sequence FROM (
               SELECT ledger_sequence, prev_hash,
                      lag(entry_hash) OVER (ORDER BY ledger_sequence) AS expected
                 FROM finance_journal_entries WHERE tenant_id=$1
             ) x WHERE expected IS NOT NULL AND prev_hash IS DISTINCT FROM expected`,
            [CO],
          )
        ).rows,
      );
      expect(broken).toEqual([]);
    });

    // The point of the chain: a determined actor with enough privilege CAN alter history — what
    // they cannot do is alter it UNDETECTABLY.
    //
    // This is asserted by proving the hash is SENSITIVE to each thing it must cover, rather than by
    // actually tampering. The tampering route needs `ALTER TABLE ... DISABLE TRIGGER`, which the
    // app role deliberately cannot do — it is NOSUPERUSER and owns none of these tables, so the
    // attempt fails on privileges before it proves anything about the chain. That refusal is itself
    // the first line of defence and is pinned by the immutability tests above.
    //
    // Live tamper detection WAS driven end-to-end on a superuser scratch database while this
    // migration was written: editing a posted line behind a disabled trigger produced
    // HASH_MISMATCH + HEADER_LINE_MISMATCH, and restoring the value returned the ledger to clean.
    // What follows is the part that can be pinned from inside the app role's own privileges.
    it("the entry hash is SENSITIVE to every field it must cover", async () => {
      const probes = await withFinance([CO], async (c) =>
        (
          await c.query<{ field: string; differs: boolean }>(
            `SELECT 'total_debit' AS field,
                    finance_journal_hash(prev_hash, tenant_id, ledger_sequence, entry_date, source_event_id,
                      kind, currency_code, total_debit + 1, total_credit, finance_journal_lines_blob(id))
                      <> entry_hash AS differs
               FROM finance_journal_entries WHERE tenant_id=$1 AND ledger_sequence=1
             UNION ALL
             SELECT 'entry_date',
                    finance_journal_hash(prev_hash, tenant_id, ledger_sequence, entry_date + 1, source_event_id,
                      kind, currency_code, total_debit, total_credit, finance_journal_lines_blob(id))
                      <> entry_hash
               FROM finance_journal_entries WHERE tenant_id=$1 AND ledger_sequence=1
             UNION ALL
             SELECT 'source_event_id',
                    finance_journal_hash(prev_hash, tenant_id, ledger_sequence, entry_date, source_event_id || 'x',
                      kind, currency_code, total_debit, total_credit, finance_journal_lines_blob(id))
                      <> entry_hash
               FROM finance_journal_entries WHERE tenant_id=$1 AND ledger_sequence=1
             UNION ALL
             SELECT 'prev_hash',
                    finance_journal_hash(repeat('b',64), tenant_id, ledger_sequence, entry_date, source_event_id,
                      kind, currency_code, total_debit, total_credit, finance_journal_lines_blob(id))
                      <> entry_hash
               FROM finance_journal_entries WHERE tenant_id=$1 AND ledger_sequence=1
             UNION ALL
             SELECT 'lines',
                    finance_journal_hash(prev_hash, tenant_id, ledger_sequence, entry_date, source_event_id,
                      kind, currency_code, total_debit, total_credit, finance_journal_lines_blob(id) || '|tampered')
                      <> entry_hash
               FROM finance_journal_entries WHERE tenant_id=$1 AND ledger_sequence=1`,
            [CO],
          )
        ).rows,
      );
      expect(probes).toHaveLength(5);
      for (const p of probes) {
        expect(p.differs, `the hash must cover ${p.field}`).toBe(true);
      }
    });

    // The writer and the verifier must serialise identically. A verifier that computes the hash
    // even slightly differently reports tampering on an untouched ledger — worse than no verifier,
    // because it trains people to ignore the alarm.
    it("the verifier recomputes exactly what the writer stored", async () => {
      const mismatches = await withFinance([CO], async (c) =>
        (
          await c.query(
            `SELECT ledger_sequence FROM finance_journal_entries e
              WHERE e.tenant_id=$1
                AND e.entry_hash <> finance_journal_hash(e.prev_hash, e.tenant_id, e.ledger_sequence,
                      e.entry_date, e.source_event_id, e.kind, e.currency_code, e.total_debit,
                      e.total_credit, finance_journal_lines_blob(e.id))`,
            [CO],
          )
        ).rows,
      );
      expect(mismatches).toEqual([]);
    });
  });

  // ── (8) Isolation ─────────────────────────────────────────────────────────────────────────────
  describe("isolation", () => {
    it("another company cannot see these journals", async () => {
      const other = await createCompany("Unrelated Co", ["finance"]);
      const seen = await withFinance([other], async (c) =>
        (await c.query("SELECT 1 FROM finance_journal_entries")).rowCount,
      );
      expect(seen).toBe(0);
    });

    it("a request without the finance module scope reads ZERO journals", async () => {
      const seen = await withTenants([CO], async (c) =>
        (await c.query("SELECT 1 FROM finance_journal_entries")).rowCount,
      );
      expect(seen).toBe(0);
    });
  });
});
