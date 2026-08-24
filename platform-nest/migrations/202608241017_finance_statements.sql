-- Finance F3 — STATEMENTS. The output a bank, an auditor and the owner actually read.
--
-- Design: docs/blueprints/finance-accounting-foundation.md §3.3. Builds on F1's ledger
-- (202608241015). Tracker: docs/plans/2026-08-24-finance-PROGRESS.md (F3-01..F3-05).
--
-- ⚠ THERE IS NO REFERENCE IMPLEMENTATION FOR THIS PHASE. project-hug's own
-- FINANCE_PHASE_ROADMAP.md §8 ("Financial Reporting Engine, Phase 12") is entirely unchecked —
-- including its "BS Equation: Total Assets must equal Liabilities + Equity" checkpoint. Its 27k LOC
-- stop exactly here. Everything below is walked from first principles and verified by test.
--
-- ── WHY THESE ARE FUNCTIONS OVER THE LEDGER, NOT MATERIALISED PROJECTIONS (yet) ─────────────────
-- The blueprint records project-hug's architectural rule — "financial reports must NEVER scan the
-- ledger directly" — and that rule is right AT SCALE. It is not right yet, and adopting it early
-- would be the more expensive mistake:
--
--   * A projection can DRIFT from the ledger. That is a whole failure class (project-hug needed a
--     LedgerIntegrityService, an invariant service, checkpointed workers and a rebuild path to
--     manage it). An aggregation over the ledger cannot drift: it IS the ledger.
--   * The volume does not warrant it. A holding group posts thousands of journals a year, not
--     millions. `ix_finance_journal_lines_account` makes a trial balance an index scan.
--   * The INTERFACE is what has to be stable, not the implementation. Every function below takes
--     (company, dates) and returns a result set. Swapping the body for a projection read later
--     changes nothing for any caller.
--
-- So: correct first, fast when measurement says so. When that day comes, the projections land
-- behind these signatures and these tests become the oracle proving the projection agrees with the
-- ledger — which is exactly the check a projection needs and the reason to build it in this order.
--
-- ── THE SIGN CONVENTION, ONCE ───────────────────────────────────────────────────────────────────
-- A line is (side, positive amount). An account's BALANCE is expressed in its own normal direction:
--
--   normal_balance = 'debit'   ->  sum(debits) - sum(credits)
--   normal_balance = 'credit'  ->  sum(credits) - sum(debits)
--
-- So a healthy asset and a healthy liability both read POSITIVE, which is how a statement is read.
-- A contra account (accumulated depreciation: asset, credit-normal) therefore also reads positive
-- in its own direction, and is SUBTRACTED by the statement that presents it — the presentation
-- layer decides that, not the balance function. Getting this wrong is why contra accounts render
-- backwards in half the reporting code that touches them.
--
-- ── REVERSALS ARE NOT EXCLUDED, AND MUST NOT BE ─────────────────────────────────────────────────
-- A reversed entry and its reversal BOTH appear in every statement. They net to zero by
-- construction, which is the correct answer and the auditable one: the books show that something
-- was posted and then reversed, not that it never happened. Any statement that filtered reversed
-- entries would disagree with the trial balance and hide a correction.
--
-- Functions only. No table, no trigger, nothing to migrate on rollback.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) finance_account_movement() — the shared engine. Everything else is a projection of this.
--
-- One place computes debits/credits per account for a window, so no two statements can disagree
-- about what a balance is. `p_from` NULL means "from the beginning of time" (balance-sheet shape,
-- cumulative); a date range gives P&L shape (period activity).
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_account_movement(
  p_company uuid,
  p_from    date DEFAULT NULL,
  p_to      date DEFAULT NULL
) RETURNS TABLE (
  account_id     uuid,
  code           text,
  name           text,
  account_type   text,
  normal_balance text,
  parent_id      uuid,
  debit          numeric,
  credit         numeric,
  balance        numeric
) LANGUAGE sql STABLE AS $$
  SELECT a.id, a.code, a.name, a.account_type, a.normal_balance, a.parent_id,
         coalesce(sum(l.amount) FILTER (WHERE l.side = 'debit'), 0)  AS debit,
         coalesce(sum(l.amount) FILTER (WHERE l.side = 'credit'), 0) AS credit,
         CASE a.normal_balance
           WHEN 'debit'  THEN coalesce(sum(l.amount) FILTER (WHERE l.side = 'debit'), 0)
                            - coalesce(sum(l.amount) FILTER (WHERE l.side = 'credit'), 0)
           ELSE               coalesce(sum(l.amount) FILTER (WHERE l.side = 'credit'), 0)
                            - coalesce(sum(l.amount) FILTER (WHERE l.side = 'debit'), 0)
         END AS balance
    FROM finance_accounts a
    LEFT JOIN finance_journal_lines l
           ON l.account_id = a.id
    LEFT JOIN finance_journal_entries e
           ON e.id = l.entry_id
          AND (p_from IS NULL OR e.entry_date >= p_from)
          AND (p_to   IS NULL OR e.entry_date <= p_to)
   WHERE a.tenant_id = p_company
     AND a.deleted_at IS NULL
     -- A line with no surviving entry cannot happen (FK + immutability), but the join above can
     -- produce one when the entry falls outside the window: drop those rather than counting them.
     AND (l.id IS NULL OR e.id IS NOT NULL)
   GROUP BY a.id, a.code, a.name, a.account_type, a.normal_balance, a.parent_id
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) finance_trial_balance() — F3-01. The base every other statement is derived from.
--
-- Returns POSTABLE accounts with any activity, plus their raw debit/credit totals. The property
-- that makes it a trial balance: SUM(debit) = SUM(credit), always, for any window — because every
-- journal is balanced and every journal is included.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_trial_balance(
  p_company uuid,
  p_as_of   date DEFAULT NULL,
  p_from    date DEFAULT NULL
) RETURNS TABLE (
  code text, name text, account_type text, debit numeric, credit numeric, balance numeric
) LANGUAGE sql STABLE AS $$
  SELECT m.code, m.name, m.account_type, m.debit, m.credit, m.balance
    FROM finance_account_movement(p_company, p_from, p_as_of) m
   WHERE m.debit <> 0 OR m.credit <> 0
   ORDER BY m.code
$$;
COMMENT ON FUNCTION finance_trial_balance(uuid,date,date) IS
  'F3-01. SUM(debit) = SUM(credit) holds for any window, because every journal is balanced and none '
  'is excluded — including reversed entries and their reversals, which net to zero.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (3) finance_general_ledger() — F3-02. Account detail with a RUNNING balance.
--
-- The running balance is what an auditor traces, and it must be continuous: every row's balance is
-- the previous row's plus this line's signed movement. Ordered by (entry_date, ledger_sequence) so
-- two entries on the same day have a deterministic, reproducible order — an unordered running total
-- is a different report every time it runs.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_general_ledger(
  p_company uuid,
  p_code    text,
  p_from    date DEFAULT NULL,
  p_to      date DEFAULT NULL
) RETURNS TABLE (
  ledger_sequence bigint,
  entry_date      date,
  description     text,
  memo            text,
  side            text,
  amount          numeric,
  running_balance numeric,
  entry_kind      text
) LANGUAGE sql STABLE AS $$
  WITH acct AS (
    SELECT id, normal_balance FROM finance_accounts
     WHERE tenant_id = p_company AND code = p_code AND deleted_at IS NULL
  ),
  -- Opening balance: everything before the window, so the running total starts from the truth
  -- rather than from zero. A GL that starts at zero mid-year is the classic wrong report.
  opening AS (
    SELECT coalesce(sum(CASE WHEN (l.side = 'debit') = (a.normal_balance = 'debit')
                             THEN l.amount ELSE -l.amount END), 0) AS bal
      FROM acct a
      JOIN finance_journal_lines l ON l.account_id = a.id
      JOIN finance_journal_entries e ON e.id = l.entry_id
     WHERE p_from IS NOT NULL AND e.entry_date < p_from
  ),
  moves AS (
    SELECT e.ledger_sequence, e.entry_date, e.description, l.memo, l.side, l.amount, e.kind,
           CASE WHEN (l.side = 'debit') = (a.normal_balance = 'debit') THEN l.amount ELSE -l.amount END AS signed
      FROM acct a
      JOIN finance_journal_lines l ON l.account_id = a.id
      JOIN finance_journal_entries e ON e.id = l.entry_id
     WHERE (p_from IS NULL OR e.entry_date >= p_from)
       AND (p_to   IS NULL OR e.entry_date <= p_to)
  )
  SELECT m.ledger_sequence, m.entry_date, m.description, m.memo, m.side, m.amount,
         (SELECT bal FROM opening) + sum(m.signed) OVER (ORDER BY m.entry_date, m.ledger_sequence
                                                          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW),
         m.kind
    FROM moves m
   ORDER BY m.entry_date, m.ledger_sequence
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (4) finance_profit_and_loss() — F3-03.
--
-- Revenue and expense accounts over a PERIOD (P&L is flow, not stock — a P&L "as of a date" is a
-- category error, so both bounds are required).
--
-- Contra accounts net correctly for free: a sales return is revenue/debit-normal, so its balance is
-- positive in its own direction and its `signed_amount` below is negative against revenue. The sign
-- comes from the account's own normal_balance, never from a hardcoded list of "contra" codes.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_profit_and_loss(
  p_company uuid,
  p_from    date,
  p_to      date
) RETURNS TABLE (
  section text, code text, name text, amount numeric
) LANGUAGE sql STABLE AS $$
  WITH m AS (
    SELECT * FROM finance_account_movement(p_company, p_from, p_to)
     WHERE account_type IN ('revenue','expense')
  ),
  lines AS (
    SELECT CASE WHEN account_type = 'revenue' THEN 'revenue' ELSE 'expense' END AS section,
           code, name,
           -- Express every figure in its SECTION's natural direction: revenue positive when it
           -- increases profit, expense positive when it decreases it. A revenue account with a
           -- debit normal balance (a return) therefore lands negative under revenue.
           CASE WHEN account_type = 'revenue'
                THEN CASE WHEN normal_balance = 'credit' THEN balance ELSE -balance END
                ELSE CASE WHEN normal_balance = 'debit'  THEN balance ELSE -balance END
           END AS amount
      FROM m
     WHERE debit <> 0 OR credit <> 0
  )
  SELECT section, code, name, amount FROM lines
  UNION ALL
  SELECT 'total', 'TOTAL_REVENUE', 'Total revenue',
         coalesce((SELECT sum(amount) FROM lines WHERE section = 'revenue'), 0)
  UNION ALL
  SELECT 'total', 'TOTAL_EXPENSE', 'Total expense',
         coalesce((SELECT sum(amount) FROM lines WHERE section = 'expense'), 0)
  UNION ALL
  SELECT 'total', 'NET_PROFIT', 'Net profit',
         coalesce((SELECT sum(amount) FROM lines WHERE section = 'revenue'), 0)
       - coalesce((SELECT sum(amount) FROM lines WHERE section = 'expense'), 0)
  ORDER BY 1, 2
$$;

-- Net profit alone — the balance sheet needs it, and recomputing it there would be a second
-- definition of profit waiting to disagree with the first.
CREATE OR REPLACE FUNCTION finance_net_profit(p_company uuid, p_from date, p_to date)
  RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT amount FROM finance_profit_and_loss(p_company, p_from, p_to)
                    WHERE code = 'NET_PROFIT'), 0)
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (5) finance_balance_sheet() — F3-04. A = L + E, and the reason it holds.
--
-- The equation only balances if CURRENT-PERIOD PROFIT is carried into equity. This is the single
-- most-missed thing in a hand-built balance sheet, and it is not a fudge: revenue and expense are
-- temporary accounts that close into retained earnings at year end. Before that close, their net is
-- still equity — it just has not been moved yet. Omit it and the sheet is out by exactly the
-- year-to-date profit, every time.
--
-- `p_fy_start` is therefore REQUIRED, not optional: "profit so far" is meaningless without knowing
-- when the year began. Defaulting it (to 1 January, say) would silently produce a wrong sheet for
-- any company whose fiscal year is not the calendar year — and finance_company_settings carries
-- `fiscal_year_start_month` precisely because some do not.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_balance_sheet(
  p_company  uuid,
  p_as_of    date,
  p_fy_start date
) RETURNS TABLE (
  section text, code text, name text, amount numeric
) LANGUAGE sql STABLE AS $$
  WITH m AS (
    SELECT * FROM finance_account_movement(p_company, NULL, p_as_of)
     WHERE account_type IN ('asset','liability','equity')
       AND (debit <> 0 OR credit <> 0)
  ),
  lines AS (
    SELECT account_type AS section, code, name,
           -- Presented in the section's natural direction. A contra asset (accumulated
           -- depreciation: asset, credit-normal) lands NEGATIVE under assets, which is exactly how
           -- it belongs on the face of the sheet.
           CASE WHEN account_type = 'asset'
                THEN CASE WHEN normal_balance = 'debit'  THEN balance ELSE -balance END
                ELSE CASE WHEN normal_balance = 'credit' THEN balance ELSE -balance END
           END AS amount
      FROM m
  ),
  profit AS (
    SELECT finance_net_profit(p_company, p_fy_start, p_as_of) AS amount
  )
  SELECT section, code, name, amount FROM lines
  UNION ALL
  -- Not a real account: the year-to-date result, shown in equity where it belongs until the
  -- year-end close moves it into retained earnings.
  SELECT 'equity', 'CURRENT_YEAR_PROFIT', 'Current year profit (not yet closed)', p.amount FROM profit p
  UNION ALL
  SELECT 'total', 'TOTAL_ASSETS', 'Total assets',
         coalesce((SELECT sum(amount) FROM lines WHERE section = 'asset'), 0)
  UNION ALL
  SELECT 'total', 'TOTAL_LIABILITIES', 'Total liabilities',
         coalesce((SELECT sum(amount) FROM lines WHERE section = 'liability'), 0)
  UNION ALL
  SELECT 'total', 'TOTAL_EQUITY', 'Total equity',
         coalesce((SELECT sum(amount) FROM lines WHERE section = 'equity'), 0)
       + (SELECT amount FROM profit)
  ORDER BY 1, 2
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (6) finance_verify_statements() — F3-05. The invariants, as a problem list.
--
-- Same shape as finance_verify_ledger_chain(): one row per PROBLEM, EMPTY means pass. A function
-- returning "true" invites a caller that never checks it.
--
-- This is the checkpoint project-hug's roadmap listed and never ticked ("BS Equation: Total Assets
-- must equal Liabilities + Equity").
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_verify_statements(
  p_company  uuid,
  p_as_of    date,
  p_fy_start date
) RETURNS TABLE (problem text, detail text)
LANGUAGE sql STABLE AS $$
  WITH tb AS (
    SELECT coalesce(sum(debit),0) AS d, coalesce(sum(credit),0) AS c
      FROM finance_trial_balance(p_company, p_as_of)
  ),
  bs AS (
    SELECT
      coalesce(max(amount) FILTER (WHERE code = 'TOTAL_ASSETS'), 0)      AS assets,
      coalesce(max(amount) FILTER (WHERE code = 'TOTAL_LIABILITIES'), 0) AS liabilities,
      coalesce(max(amount) FILTER (WHERE code = 'TOTAL_EQUITY'), 0)      AS equity
      FROM finance_balance_sheet(p_company, p_as_of, p_fy_start)
  )
  SELECT 'TRIAL_BALANCE_UNBALANCED',
         'debits ' || tb.d::text || ' <> credits ' || tb.c::text
    FROM tb WHERE tb.d <> tb.c
  UNION ALL
  SELECT 'BALANCE_SHEET_UNBALANCED',
         'assets ' || bs.assets::text || ' <> liabilities ' || bs.liabilities::text ||
         ' + equity ' || bs.equity::text || ' (difference ' ||
         (bs.assets - bs.liabilities - bs.equity)::text || ')'
    FROM bs WHERE bs.assets <> bs.liabilities + bs.equity
$$;
COMMENT ON FUNCTION finance_verify_statements(uuid,date,date) IS
  'F3-05. Returns one row per PROBLEM; EMPTY is the pass condition. Checks the trial balance sums '
  'and the A = L + E equation — the checkpoint project-hug listed and never reached.';
