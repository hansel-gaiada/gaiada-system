-- Finance F9-06..F9-12 — THE REST OF CONSOLIDATION, AND THE STATEMENTS IT EXISTS TO PRODUCE.
--
-- ── WHAT "CONSOLIDATED" IS ALLOWED TO MEAN ─────────────────────────────────────────────────────
-- ★ `finance_consolidated_trial_balance()` returns the group's figures ONLY when the eliminations
-- for that run have been computed. Until then it refuses.
--
-- That refusal is the point of this file. A naive sum across three companies is a perfectly
-- legitimate number to show — it is just not a consolidated one, and labelling it so is how a group
-- reports revenue twice because one company billed another. The blueprint's own rule (F9-12) is
-- that the console must not use the word until the eliminations exist, so the function enforces it
-- rather than trusting a caller to remember.
--
-- ── HOW INTERCOMPANY REVENUE IS IDENTIFIED ─────────────────────────────────────────────────────
-- By the JOURNAL, not by guesswork. When Alpha invoices Beta, Alpha's entry debits an intercompany
-- receivable (an account tagged with Beta) and credits revenue — in ONE journal. So the revenue
-- lines of any entry that also touches a counterparty-tagged account are intercompany revenue, by
-- construction. Same transaction, same entry, no heuristics.
--
-- The alternative — matching amounts and dates across two companies' books — produces false pairs
-- the moment two unrelated transactions share a figure, which in a group with round-number
-- management fees is often.
--
-- ── WHAT IS RECORDED BUT NOT COMPUTED, AND WHY THAT IS HONEST ──────────────────────────────────
-- F9-07 (unrealised profit), F9-10 (goodwill) and F9-11 (FX translation) get a RECORDING path and
-- validation, not automatic computation:
--
--   * unrealised profit needs an inventory or intragroup-asset-transfer record. There is no
--     inventory module, so the margin cannot be derived — only asserted by a human who knows it.
--   * goodwill needs an acquisition: consideration paid, and the fair value of net assets at that
--     date. Neither is in the schema, and inventing a "goodwill = investment - book equity" shortcut
--     would produce a figure that looks like goodwill and is not.
--   * FX translation needs a subsidiary whose functional currency differs from the group's. All
--     three entities are IDR, so the closing/average-rate machinery would be dead code written
--     against an imagined shape.
--
-- Each is expressible as a consolidation entry with its own `kind`, so the working paper is
-- complete and an accountant can put the number in. Deriving them from data that does not exist
-- would be fabrication with a function signature.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) F9-06 — intercompany revenue and expense
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_intercompany_pl(
  p_company uuid,
  p_from    date,
  p_to      date
) RETURNS TABLE (counterparty_company_id uuid, account_code text, account_type text, amount numeric)
  LANGUAGE sql STABLE AS $$
  -- Revenue/expense lines that share a JOURNAL with a counterparty-tagged line. One transaction,
  -- one entry — no amount-and-date matching, which pairs unrelated transactions in any group that
  -- uses round-number management fees.
  WITH ic_entries AS (
    SELECT DISTINCT l.entry_id, a.counterparty_company_id
      FROM finance_journal_lines l
      JOIN finance_accounts a ON a.id = l.account_id
     WHERE l.tenant_id = p_company AND a.counterparty_company_id IS NOT NULL
  )
  -- Lines carry `side` + `base_amount`, not debit/credit columns. base_amount, not amount, so a
  -- foreign-currency line aggregates in the company's own currency rather than adding figures
  -- denominated in different ones.
  SELECT ie.counterparty_company_id,
         a.code,
         a.account_type,
         sum(CASE WHEN l.side = a.normal_balance THEN l.base_amount ELSE -l.base_amount END)
    FROM ic_entries ie
    JOIN finance_journal_lines l ON l.entry_id = ie.entry_id
    JOIN finance_journal_entries e ON e.id = l.entry_id
    JOIN finance_accounts a ON a.id = l.account_id
   WHERE a.account_type IN ('revenue','expense')
     AND (p_from IS NULL OR e.entry_date >= p_from)
     AND (p_to   IS NULL OR e.entry_date <= p_to)
   GROUP BY ie.counterparty_company_id, a.code, a.account_type
  HAVING sum(CASE WHEN l.side = a.normal_balance THEN l.base_amount ELSE -l.base_amount END) <> 0;
$$;
COMMENT ON FUNCTION finance_intercompany_pl(uuid, date, date) IS
  'F9-06: intercompany revenue/expense, identified by SHARING A JOURNAL with a counterparty-tagged '
  'line — same transaction, same entry. Amount-and-date matching across two companies produces '
  'false pairs whenever two unrelated transactions share a figure.';

CREATE OR REPLACE FUNCTION finance_eliminate_intercompany_pl(p_run uuid)
  RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_run finance_consolidation_runs%ROWTYPE;
  v_n   integer := 0;
  m     record;
  r     record;
BEGIN
  SELECT * INTO v_run FROM finance_consolidation_runs WHERE id = p_run;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FINANCE_CONSOLIDATION_RUN_NOT_FOUND: no run %', p_run;
  END IF;

  FOR m IN
    SELECT g.company_id FROM finance_group_members(v_run.tenant_id, v_run.as_of) g
     WHERE g.consolidation IN ('full','parent')
  LOOP
    FOR r IN
      SELECT * FROM finance_intercompany_pl(m.company_id, NULL, v_run.as_of)
    LOOP
      -- Only against a member of the group; a sale to an entity OUTSIDE it is real group revenue.
      CONTINUE WHEN NOT EXISTS (
        SELECT 1 FROM finance_group_members(v_run.tenant_id, v_run.as_of) g2
         WHERE g2.company_id = r.counterparty_company_id AND g2.consolidation IN ('full','parent'));

      INSERT INTO finance_consolidation_entries
        (tenant_id, run_id, subject_company_id, account_code, side, amount, kind, memo)
      VALUES (v_run.tenant_id, p_run, m.company_id, r.account_code,
              -- Revenue is credit-normal, so removing it is a DEBIT; expense the reverse.
              CASE WHEN r.account_type = 'revenue' THEN 'debit' ELSE 'credit' END,
              abs(r.amount), 'ic_revenue_expense',
              'Eliminate intercompany ' || r.account_type);
      v_n := v_n + 1;
    END LOOP;
  END LOOP;
  RETURN v_n;
END $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) F9-08 / F9-09 — non-controlling interest and the equity method
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- NCI is the slice of a fully-consolidated subsidiary the group does NOT own. Consolidation brings
-- in 100% of the subsidiary's assets and liabilities because the group CONTROLS them; the portion
-- of net assets belonging to someone else must then be carved out of equity, or the group would be
-- claiming to own what it merely controls.
CREATE OR REPLACE FUNCTION finance_nci_position(p_parent uuid, p_as_of date)
  RETURNS TABLE (company_id uuid, nci_pct numeric, net_assets numeric, nci_amount numeric)
  LANGUAGE plpgsql STABLE AS $$
DECLARE g record;
DECLARE v_net numeric;
BEGIN
  FOR g IN
    SELECT * FROM finance_group_members(p_parent, p_as_of) m
     WHERE m.consolidation = 'full' AND m.nci_pct > 0
  LOOP
    -- ★ NET ASSETS IS ASSETS MINUS LIABILITIES, not the equity accounts.
    --
    -- Reading `account_type = 'equity'` returns contributed capital and prior retained earnings but
    -- EXCLUDES the current year's result, which has not been closed to equity yet. A subsidiary that
    -- made a 50m loss this year would report its full capital as net assets, and the minority's
    -- share would be overstated by their percentage of that loss. Assets less liabilities is the
    -- definition, and it needs no fiscal-year-start to compute.
    SELECT COALESCE(sum(mv.balance) FILTER (WHERE a.account_type = 'asset'), 0)
         - COALESCE(sum(mv.balance) FILTER (WHERE a.account_type = 'liability'), 0)
      INTO v_net
      FROM finance_account_movement(g.company_id, NULL, p_as_of) mv
      JOIN finance_accounts a ON a.id = mv.account_id;

    company_id := g.company_id;
    nci_pct    := g.nci_pct;
    net_assets := v_net;
    nci_amount := round(v_net * g.nci_pct / 100.0, 2);
    RETURN NEXT;
  END LOOP;
END $$;
COMMENT ON FUNCTION finance_nci_position(uuid, date) IS
  'F9-08 (PSAK 65): the slice of a consolidated subsidiary the group does not own. Consolidation '
  'brings in 100% of what the group CONTROLS; NCI carves out what it does not OWN.';

CREATE OR REPLACE FUNCTION finance_equity_method_position(p_parent uuid, p_as_of date)
  RETURNS TABLE (company_id uuid, stake_pct numeric, net_assets numeric, carrying_amount numeric)
  LANGUAGE plpgsql STABLE AS $$
DECLARE g record;
DECLARE v_net numeric;
BEGIN
  -- An ASSOCIATE is not consolidated line by line. The group carries ONE number — its share of the
  -- associate's net assets — and brings in none of its revenue, assets or liabilities. Adding an
  -- associate's lines would claim control the group does not have.
  FOR g IN
    SELECT * FROM finance_group_members(p_parent, p_as_of) m WHERE m.consolidation = 'equity'
  LOOP
    -- ★ NET ASSETS IS ASSETS MINUS LIABILITIES, not the equity accounts.
    --
    -- Reading `account_type = 'equity'` returns contributed capital and prior retained earnings but
    -- EXCLUDES the current year's result, which has not been closed to equity yet. A subsidiary that
    -- made a 50m loss this year would report its full capital as net assets, and the minority's
    -- share would be overstated by their percentage of that loss. Assets less liabilities is the
    -- definition, and it needs no fiscal-year-start to compute.
    SELECT COALESCE(sum(mv.balance) FILTER (WHERE a.account_type = 'asset'), 0)
         - COALESCE(sum(mv.balance) FILTER (WHERE a.account_type = 'liability'), 0)
      INTO v_net
      FROM finance_account_movement(g.company_id, NULL, p_as_of) mv
      JOIN finance_accounts a ON a.id = mv.account_id;

    company_id      := g.company_id;
    stake_pct       := g.stake_pct;
    net_assets      := v_net;
    carrying_amount := round(v_net * g.stake_pct / 100.0, 2);
    RETURN NEXT;
  END LOOP;
END $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (3) F9-12 — the consolidated trial balance
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_consolidated_trial_balance(p_run uuid)
  RETURNS TABLE (account_code text, account_name text, account_type text, debit numeric, credit numeric)
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_run finance_consolidation_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM finance_consolidation_runs WHERE id = p_run;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FINANCE_CONSOLIDATION_RUN_NOT_FOUND: no run %', p_run;
  END IF;

  -- ★ THE REFUSAL. A run with no elimination entries has not been consolidated — it has merely been
  -- summed. Returning the sum under this function's name is how a group reports revenue twice.
  IF NOT EXISTS (SELECT 1 FROM finance_consolidation_entries WHERE run_id = p_run) THEN
    RAISE EXCEPTION
      'FINANCE_CONSOLIDATION_NOT_ELIMINATED: run % has no elimination entries. Run '
      'finance_eliminate_intercompany() and finance_eliminate_intercompany_pl() first — a sum of '
      'the members is a legitimate figure but it is NOT consolidated, and this function will not '
      'return one under that name.', p_run
      USING HINT = 'If the group genuinely has no intercompany activity, record a zero-effect entry '
                   'saying so, that the working paper shows it was considered.';
  END IF;

  RETURN QUERY
  WITH members AS (
    SELECT g.company_id FROM finance_group_members(v_run.tenant_id, v_run.as_of) g
     WHERE g.consolidation IN ('full','parent')
  ),
  entity_lines AS (
    SELECT a.code, a.name, a.account_type, a.normal_balance,
           sum(mv.balance) AS bal
      FROM members m
      CROSS JOIN LATERAL finance_account_movement(m.company_id, NULL, v_run.as_of) mv
      JOIN finance_accounts a ON a.id = mv.account_id
     GROUP BY a.code, a.name, a.account_type, a.normal_balance
  ),
  elim AS (
    SELECT ce.account_code AS code,
           sum(CASE WHEN ce.side = 'debit' THEN ce.amount ELSE -ce.amount END) AS net_debit
      FROM finance_consolidation_entries ce
     WHERE ce.run_id = p_run
     GROUP BY ce.account_code
  )
  SELECT el.code, el.name, el.account_type,
         -- Balances come back in the account's OWN normal direction; the trial balance wants them
         -- in debit/credit columns, and eliminations are expressed as debits and credits.
         GREATEST(CASE WHEN el.normal_balance = 'debit' THEN el.bal ELSE -el.bal END
                    + COALESCE(e.net_debit, 0), 0),
         GREATEST(-(CASE WHEN el.normal_balance = 'debit' THEN el.bal ELSE -el.bal END
                    + COALESCE(e.net_debit, 0)), 0)
    FROM entity_lines el
    LEFT JOIN elim e ON e.code = el.code
   WHERE el.bal <> 0 OR e.net_debit IS NOT NULL
   ORDER BY el.code;
END $$;
COMMENT ON FUNCTION finance_consolidated_trial_balance(uuid) IS
  'F9-12: the group trial balance. REFUSES a run with no elimination entries — a sum of the members '
  'is legitimate but is not consolidated, and returning one under this name is how a group reports '
  'revenue twice.';

-- A naive sum, under a name that says what it is. Available deliberately: the figure is useful and
-- the honest way to offer it is to label it correctly, not to withhold it.
CREATE OR REPLACE FUNCTION finance_group_sum_trial_balance(p_parent uuid, p_as_of date)
  RETURNS TABLE (account_code text, account_name text, account_type text, balance numeric)
  LANGUAGE sql STABLE AS $$
  SELECT a.code, a.name, a.account_type, sum(mv.balance)
    FROM finance_group_members(p_parent, p_as_of) g
    CROSS JOIN LATERAL finance_account_movement(g.company_id, NULL, p_as_of) mv
    JOIN finance_accounts a ON a.id = mv.account_id
   WHERE g.consolidation IN ('full','parent')
   GROUP BY a.code, a.name, a.account_type
  HAVING sum(mv.balance) <> 0
   ORDER BY a.code;
$$;
COMMENT ON FUNCTION finance_group_sum_trial_balance(uuid, date) IS
  'A NAIVE SUM across group members, named so nobody mistakes it for a consolidation. Double-counts '
  'every intercompany transaction, by design — that is what a sum is.';
