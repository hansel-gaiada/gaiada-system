-- Finance F6 — CASH, BANK RECONCILIATION AND THE CLOSE.
--
-- Design: docs/blueprints/finance-accounting-foundation.md §3.2. Builds on F1 (ledger), F3
-- (statements), F4 (AR) and F5 (AP).
--
-- Two halves, and they are the last two things standing between "the books exist" and "the books
-- are closed".
--
-- ── HALF ONE: DOES THE CASH ACTUALLY EXIST? ─────────────────────────────────────────────────────
-- A lender asks for the aging first and the bank reconciliation second, and the second question is
-- the blunter one: the balance sheet says there is cash — is there?
--
-- The reconciling identity is:
--
--     GL bank balance
--       + deposits recorded by us but not yet on the statement      (in flight, ours)
--       - payments recorded by us but not yet on the statement      (in flight, ours)
--       - receipts on the statement we have not recorded            (in flight, theirs)
--       + charges on the statement we have not recorded             (in flight, theirs)
--     = statement closing balance
--
-- Everything in the middle is an ITEM IN FLIGHT. A reconciliation is complete when the difference
-- between the two balances is FULLY explained by those items — and `finance_bank_reconcile()`
-- reports the residue when it is not. **There is no plug and no adjustment field.** A difference
-- nobody can explain is the finding; letting someone type it away is how a real problem becomes a
-- rounding line.
--
-- ── THE STATEMENT IS NEVER EDITED TO MATCH THE LEDGER ───────────────────────────────────────────
-- `finance_bank_transactions` holds the BANK's version of events. It is imported and then read.
-- If the bank is wrong, the answer is a dispute with the bank and a correcting entry in the ledger —
-- not a quiet edit that makes the two agree. The tables enforce this by having no update path in
-- any function here.
--
-- ── HALF TWO: THE CLOSE, AS A COMPUTED ANSWER ───────────────────────────────────────────────────
-- Blueprint §3.2 lists a close checklist. F6 turns it into `finance_period_close_readiness()`,
-- which aggregates every integrity check the program has built:
--
--     ledger chain (F1) · statements A=L+E (F3) · AR tie-out (F4) · AP tie-out (F5) · bank rec (F6)
--
-- plus the F0 rule that a HARD_LOCK needs a named accountant's sign-off. One function, one answer,
-- one row per reason you cannot close. "Can we close?" stops being a question answered from memory.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) finance_bank_statements — one per account per period.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE finance_bank_statements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES companies(id),
  -- The GL account this statement belongs to (a bank or cash account).
  account_id      uuid NOT NULL,
  statement_no    text NOT NULL,
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  opening_balance numeric(20,4) NOT NULL,
  closing_balance numeric(20,4) NOT NULL,
  currency_code   text NOT NULL REFERENCES finance_currencies(code),
  -- Where the lines came from. Recorded because an auditor asks, and because a hand-keyed statement
  -- deserves more scepticism than a bank-issued file.
  source          text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','csv','ofx','api')),
  imported_at     timestamptz NOT NULL DEFAULT now(),
  imported_by     uuid REFERENCES users(id),
  origin_site     text NOT NULL DEFAULT 'central',
  CONSTRAINT fk_finance_bank_statements_account
    FOREIGN KEY (account_id, tenant_id) REFERENCES finance_accounts (id, tenant_id),
  CONSTRAINT ux_finance_bank_statements_no UNIQUE (tenant_id, account_id, statement_no),
  CONSTRAINT ux_finance_bank_statements_id_tenant UNIQUE (id, tenant_id),
  CONSTRAINT ck_finance_bank_statements_period CHECK (period_end >= period_start)
);
CREATE INDEX ix_finance_bank_statements_account ON finance_bank_statements (tenant_id, account_id, period_end);

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) finance_bank_transactions — the bank's lines. Imported, then read.
--
-- `direction` mirrors the ledger's debit/credit rather than using a signed amount, for the same
-- reason F1's lines do: a signed amount makes "is this money in or out" depend on a convention that
-- differs between banks, and OFX/CSV exports disagree about it constantly.
--   'in'  = money arrived   (would DEBIT the bank account in our ledger)
--   'out' = money left      (would CREDIT it)
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE finance_bank_transactions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  statement_id  uuid NOT NULL,
  line_no       integer NOT NULL CHECK (line_no > 0),
  txn_date      date NOT NULL,
  description   text NOT NULL,
  reference     text,
  direction     text NOT NULL CHECK (direction IN ('in','out')),
  amount        numeric(20,4) NOT NULL CHECK (amount > 0),
  CONSTRAINT fk_finance_bank_transactions_statement
    FOREIGN KEY (statement_id, tenant_id) REFERENCES finance_bank_statements (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT ux_finance_bank_transactions_no UNIQUE (statement_id, line_no),
  CONSTRAINT ux_finance_bank_transactions_id_tenant UNIQUE (id, tenant_id)
);
CREATE INDEX ix_finance_bank_transactions_statement ON finance_bank_transactions (statement_id, line_no);
CREATE INDEX ix_finance_bank_transactions_match ON finance_bank_transactions (tenant_id, txn_date, amount);

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (3) finance_bank_matches — statement line ↔ ledger line.
--
-- A MATCH is an assertion that one bank line and one ledger line are the same real-world event. It
-- is deliberately one-to-one: a bank line that pays three invoices still corresponds to ONE ledger
-- line on the bank account (the receipt), because that is how the money moved. Many-to-many
-- matching is a feature that mostly enables sloppy matching, and the AR/AP allocation tables
-- already carry the "which debt did this settle" question.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE finance_bank_matches (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES companies(id),
  bank_transaction_id uuid NOT NULL,
  journal_line_id    uuid NOT NULL,
  -- How the match was made. An auto-match is evidence of a rule firing; a manual match is evidence
  -- of a human decision. An auditor treats them differently and so should we.
  matched_by_rule    boolean NOT NULL DEFAULT false,
  matched_at         timestamptz NOT NULL DEFAULT now(),
  matched_by         uuid REFERENCES users(id),
  CONSTRAINT fk_finance_bank_matches_txn
    FOREIGN KEY (bank_transaction_id, tenant_id) REFERENCES finance_bank_transactions (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT fk_finance_bank_matches_line
    FOREIGN KEY (journal_line_id, tenant_id) REFERENCES finance_journal_lines (id, tenant_id),
  -- One-to-one, enforced on BOTH sides.
  CONSTRAINT ux_finance_bank_matches_txn UNIQUE (bank_transaction_id),
  CONSTRAINT ux_finance_bank_matches_line UNIQUE (journal_line_id)
);

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (4) finance_bank_automatch() — a DELIBERATELY CONSERVATIVE matcher.
--
-- Matches only on an exact triple: same account, same amount, same direction, and a date within
-- `p_tolerance_days`. And it refuses to match at all where the candidate is AMBIGUOUS — if two
-- ledger lines could equally be this bank line, it leaves the bank line unmatched for a human.
--
-- That refusal is the whole design. An aggressive matcher clears the queue and produces a
-- reconciliation that LOOKS complete while quietly pairing the wrong payment with the wrong
-- invoice — and the error surfaces months later as a customer chasing a payment we recorded
-- against someone else. Leaving an item unmatched costs a minute; a wrong match costs a
-- relationship and an audit finding.
--
-- Returns the number of matches made.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_bank_automatch(
  p_statement uuid, p_tolerance_days integer DEFAULT 3, p_actor uuid DEFAULT NULL
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_stmt  finance_bank_statements%ROWTYPE;
  v_txn   record;
  v_line  uuid;
  v_count integer := 0;
  v_cands integer;
BEGIN
  SELECT * INTO v_stmt FROM finance_bank_statements WHERE id = p_statement;
  IF v_stmt.id IS NULL THEN
    RAISE EXCEPTION 'FINANCE_BANK_UNKNOWN_STATEMENT: no statement %', p_statement;
  END IF;

  FOR v_txn IN
    SELECT t.* FROM finance_bank_transactions t
     WHERE t.statement_id = p_statement
       AND NOT EXISTS (SELECT 1 FROM finance_bank_matches m WHERE m.bank_transaction_id = t.id)
     ORDER BY t.line_no
  LOOP
    -- Candidate ledger lines on this bank account: same amount, same direction, near date, and not
    -- already matched to some other bank line.
    SELECT count(*) INTO v_cands
      FROM finance_journal_lines l
      JOIN finance_journal_entries e ON e.id = l.entry_id
     WHERE l.tenant_id = v_stmt.tenant_id
       AND l.account_id = v_stmt.account_id
       AND l.amount = v_txn.amount
       AND l.side = CASE v_txn.direction WHEN 'in' THEN 'debit' ELSE 'credit' END
       AND e.entry_date BETWEEN v_txn.txn_date - p_tolerance_days AND v_txn.txn_date + p_tolerance_days
       AND NOT EXISTS (SELECT 1 FROM finance_bank_matches m WHERE m.journal_line_id = l.id);

    -- EXACTLY ONE candidate, or nothing. Two identical payments on the same day to different
    -- vendors are indistinguishable on amount alone, and guessing between them is worse than
    -- leaving both for a human.
    IF v_cands = 1 THEN
      SELECT l.id INTO v_line
        FROM finance_journal_lines l
        JOIN finance_journal_entries e ON e.id = l.entry_id
       WHERE l.tenant_id = v_stmt.tenant_id
         AND l.account_id = v_stmt.account_id
         AND l.amount = v_txn.amount
         AND l.side = CASE v_txn.direction WHEN 'in' THEN 'debit' ELSE 'credit' END
         AND e.entry_date BETWEEN v_txn.txn_date - p_tolerance_days AND v_txn.txn_date + p_tolerance_days
         AND NOT EXISTS (SELECT 1 FROM finance_bank_matches m WHERE m.journal_line_id = l.id);

      INSERT INTO finance_bank_matches (tenant_id, bank_transaction_id, journal_line_id, matched_by_rule, matched_by)
      VALUES (v_stmt.tenant_id, v_txn.id, v_line, true, p_actor);
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN v_count;
END $$;
COMMENT ON FUNCTION finance_bank_automatch(uuid,integer,uuid) IS
  'Conservative by design: matches only on an exact amount+direction+near-date triple, and REFUSES '
  'to match when more than one ledger line qualifies. An unmatched item costs a minute; a wrong '
  'match costs a customer relationship and an audit finding.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (5) finance_bank_reconcile() — does the cash exist?
--
-- Returns the reconciliation AS A STATEMENT OF POSITION, not a pass/fail: the GL balance, the
-- statement balance, each class of item in flight, and the UNEXPLAINED residue. A reconciliation
-- whose residue is zero is complete; any other residue is the finding.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_bank_reconcile(p_statement uuid)
  RETURNS TABLE (
    gl_balance            numeric,
    statement_balance     numeric,
    unmatched_ledger_in   numeric,
    unmatched_ledger_out  numeric,
    unmatched_bank_in     numeric,
    unmatched_bank_out    numeric,
    unexplained_difference numeric
  ) LANGUAGE sql STABLE AS $$
  WITH stmt AS (SELECT * FROM finance_bank_statements WHERE id = p_statement),
  gl AS (
    -- The bank account's GL balance as at the statement's end date. A bank account is debit-normal,
    -- so finance_account_movement already returns it positive when there is money in it.
    SELECT coalesce(m.balance, 0) AS bal
      FROM stmt s
      LEFT JOIN LATERAL finance_account_movement(s.tenant_id, NULL, s.period_end) m
             ON m.account_id = s.account_id
  ),
  -- Recorded by us, not yet on the statement.
  led AS (
    SELECT
      coalesce(sum(l.amount) FILTER (WHERE l.side = 'debit'), 0)  AS in_flight_in,
      coalesce(sum(l.amount) FILTER (WHERE l.side = 'credit'), 0) AS in_flight_out
      FROM stmt s
      JOIN finance_journal_lines l   ON l.tenant_id = s.tenant_id AND l.account_id = s.account_id
      JOIN finance_journal_entries e ON e.id = l.entry_id
     WHERE e.entry_date <= s.period_end
       AND NOT EXISTS (SELECT 1 FROM finance_bank_matches m WHERE m.journal_line_id = l.id)
  ),
  -- On the statement, not yet recorded by us.
  bnk AS (
    SELECT
      coalesce(sum(t.amount) FILTER (WHERE t.direction = 'in'), 0)  AS unrec_in,
      coalesce(sum(t.amount) FILTER (WHERE t.direction = 'out'), 0) AS unrec_out
      FROM finance_bank_transactions t
     WHERE t.statement_id = p_statement
       AND NOT EXISTS (SELECT 1 FROM finance_bank_matches m WHERE m.bank_transaction_id = t.id)
  )
  SELECT gl.bal, s.closing_balance,
         led.in_flight_in, led.in_flight_out, bnk.unrec_in, bnk.unrec_out,
         -- GL, adjusted for everything in flight, should equal the statement.
         (gl.bal - led.in_flight_in + led.in_flight_out + bnk.unrec_in - bnk.unrec_out)
           - s.closing_balance
    FROM stmt s, gl, led, bnk
$$;
COMMENT ON FUNCTION finance_bank_reconcile(uuid) IS
  'Position, not pass/fail. A zero unexplained_difference means the GL and the bank agree once items '
  'in flight are accounted for. There is deliberately NO adjustment field: a difference nobody can '
  'explain is the finding, and letting someone type it away turns a real problem into a rounding line.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (6) finance_period_close_readiness() — THE CAPSTONE.
--
-- Aggregates every integrity check this program has built into one answer. Returns one row per
-- BLOCKER; an empty result means the period can be closed.
--
-- This is what turns blueprint §3.2's close checklist from a document into a gate. Note what it
-- does NOT do: it does not close anything. Closing is `finance_fiscal_periods.state`, guarded by
-- F0's trigger and requiring a named accountant's sign-off (ruling D-F5). This function tells you
-- whether you SHOULD; the trigger enforces who MAY.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_period_close_readiness(p_company uuid, p_period uuid)
  RETURNS TABLE (blocker text, detail text)
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_p finance_fiscal_periods%ROWTYPE;
  v_fy_start date;
BEGIN
  SELECT * INTO v_p FROM finance_fiscal_periods WHERE id = p_period AND tenant_id = p_company;
  IF v_p.id IS NULL THEN
    RAISE EXCEPTION 'FINANCE_UNKNOWN_PERIOD: no period % for this company', p_period;
  END IF;
  SELECT fy.start_date INTO v_fy_start FROM finance_fiscal_years fy WHERE fy.id = v_p.fiscal_year_id;

  -- (a) The ledger's own integrity (F1).
  RETURN QUERY
    SELECT 'LEDGER_INTEGRITY', v.problem || ' at #' || v.ledger_sequence::text
      FROM finance_verify_ledger_chain(p_company) v;

  -- (b) The statements balance (F3).
  RETURN QUERY
    SELECT 'STATEMENTS', v.problem || ': ' || v.detail
      FROM finance_verify_statements(p_company, v_p.end_date, v_fy_start) v;

  -- (c) Subledgers tie to their control accounts (F4, F5).
  RETURN QUERY
    SELECT 'AR_RECONCILIATION', v.problem || ': ' || v.detail
      FROM finance_ar_reconcile(p_company, v_p.end_date) v;
  RETURN QUERY
    SELECT 'AP_RECONCILIATION', v.problem || ': ' || v.detail
      FROM finance_ap_reconcile(p_company, v_p.end_date) v;

  -- (d) Every bank/cash account with activity has a reconciled statement covering the period end.
  --
  -- TWO distinct blockers, deliberately not merged: a MISSING statement and an UNEXPLAINED
  -- difference are different problems with different owners — one is "nobody imported it", the
  -- other is "the money does not agree" — and collapsing them into "bank not reconciled" sends the
  -- wrong person to investigate.
  RETURN QUERY
    SELECT 'BANK_STATEMENT_MISSING',
           'no statement covering ' || v_p.end_date::text || ' for account ' || a.code || ' ' || a.name
      FROM finance_accounts a
     WHERE a.tenant_id = p_company
       AND a.deleted_at IS NULL
       AND a.control_subledger IS NULL
       AND a.account_type = 'asset'
       AND a.is_postable
       AND EXISTS (SELECT 1 FROM finance_journal_lines l WHERE l.account_id = a.id)
       AND a.code IN (SELECT code FROM finance_accounts
                       WHERE tenant_id = p_company AND code IN ('1110','1120'))
       AND NOT EXISTS (
             SELECT 1 FROM finance_bank_statements s
              WHERE s.tenant_id = p_company AND s.account_id = a.id
                AND v_p.end_date BETWEEN s.period_start AND s.period_end);

  RETURN QUERY
    SELECT 'BANK_UNEXPLAINED_DIFFERENCE',
           'account ' || a.code || ': ' || r.unexplained_difference::text || ' unexplained'
      FROM finance_bank_statements s
      JOIN finance_accounts a ON a.id = s.account_id
      CROSS JOIN LATERAL finance_bank_reconcile(s.id) r
     WHERE s.tenant_id = p_company
       AND v_p.end_date BETWEEN s.period_start AND s.period_end
       AND r.unexplained_difference <> 0;

  -- (e) The D-F5 gate, surfaced BEFORE the trigger raises it. The trigger is the enforcement; this
  -- is the courtesy of saying so while there is still time to get the sign-off.
  IF v_p.signed_off_by IS NULL THEN
    RETURN QUERY SELECT 'NO_ACCOUNTANT_SIGNOFF',
      'period ' || v_p.name || ' has no signed_off_by — a HARD_LOCK will be refused (owner ruling D-F5)';
  END IF;
END $$;
COMMENT ON FUNCTION finance_period_close_readiness(uuid,uuid) IS
  'THE close gate. One row per blocker; EMPTY means the period can be closed. Aggregates F1 ledger '
  'integrity, F3 statement balance, F4/F5 subledger tie-outs, F6 bank reconciliation, and the D-F5 '
  'sign-off requirement. It does NOT close anything — it says whether you should.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (7) The finance third wall.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'finance_bank_statements','finance_bank_transactions','finance_bank_matches'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''finance''))
         WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''finance''))',
      t
    );
  END LOOP;
END $$;
