-- Finance F9-01/02/03 — CONTROL DETERMINATION, THE GROUP, AND A SEPARATE CONSOLIDATION LEDGER.
--
-- ── THE NON-NEGOTIABLE ─────────────────────────────────────────────────────────────────────────
-- ★ An elimination entry must NEVER appear in an entity's own books.
--
-- Consolidation removes intercompany balances so the group is not double-counted. Those removals
-- are true of the GROUP and false of the ENTITY: Alpha really is owed 10m by Beta, and Alpha's own
-- statutory accounts must keep saying so. If eliminations posted into Alpha's ledger, Alpha's
-- standalone statements would be wrong, its tax return would be wrong, and an auditor examining
-- Alpha alone would find entries with no supporting transaction.
--
-- So eliminations live in their own ledger, keyed by (group, period), and the consolidated
-- statements are entity ledgers PLUS that overlay. Nothing here writes to `finance_journal_entries`.
--
-- ── CONTROL IS DERIVED, NOT DECLARED ───────────────────────────────────────────────────────────
-- PSAK 65 / 15: >50% is control (full consolidation), 20-50% is significant influence (equity
-- method), below that is an investment. Derived from `company_ownership` rather than stored as a
-- flag, because a flag and a stake can disagree — and when they do, the flag is what the software
-- believes while the stake is what is true.
--
-- ⚠ This is a SIMPLIFICATION with a known edge: control can exist below 50% (a shareholder
-- agreement, board control) and can be absent above it. PSAK 65 is about power, not arithmetic. The
-- percentage is the right default and the wrong answer in unusual structures, so
-- `finance_group_members()` reports the basis it used and a human can override by recording the
-- ownership edge that reflects reality.
--
-- ── THE GROUP IS BOUNDED BY root_company_id ────────────────────────────────────────────────────
-- `withTenants` refuses a tenant set spanning two roots, and consolidation is inherently a
-- multi-tenant read. That bound is correct — two unrelated holdings must never consolidate — and it
-- means a consolidation group can never be assembled across roots even by mistake.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) finance_group_members() — who consolidates, and on what basis
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_group_members(p_parent uuid, p_as_of date DEFAULT NULL)
  RETURNS TABLE (
    company_id      uuid,
    company_name    text,
    stake_pct       numeric,
    consolidation   text,   -- full | equity | investment | parent
    nci_pct         numeric,
    basis           text
  )
  LANGUAGE sql STABLE
  -- ⚠ THE CALLER MUST ALREADY HOLD THE CANDIDATE TENANTS IN SCOPE.
  --
  -- SECURITY DEFINER does NOT lift RLS here. `company_ownership` is FORCE ROW LEVEL SECURITY, which
  -- applies to the table owner too, so a definer-rights function is still filtered. And an ownership
  -- edge lives in the tenant of the company that is OWNED — the row saying "H holds 60% of B" has
  -- tenant_id = B. So reading the group requires B in scope, which is what the caller is asking for:
  -- genuinely circular.
  --
  -- It is resolved by SEQUENCE, not by privilege. `companies` is a core table with no finance
  -- predicate, so the candidate set (the root's descendants) is readable first; the caller opens
  -- withTenants over those, and THEN asks this function for the basis. Called without that scope it
  -- returns the parent row alone — silently, because an empty ownership read is indistinguishable
  -- from "no subsidiaries". Every caller in this migration set follows that order.
  SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  SELECT p_parent, c.name, 100::numeric, 'parent'::text, 0::numeric, 'the reporting entity itself'
    FROM companies c WHERE c.id = p_parent AND c.deleted_at IS NULL
  UNION ALL
  SELECT o.tenant_id,
         c.name,
         o.stake_pct,
         CASE
           WHEN o.stake_pct IS NULL              THEN 'investment'
           WHEN o.stake_pct > 50                 THEN 'full'
           WHEN o.stake_pct >= 20                THEN 'equity'
           ELSE 'investment'
         END,
         -- Non-controlling interest is the slice the group does NOT own. Only meaningful for a
         -- fully consolidated subsidiary: an equity-method associate is not consolidated line by
         -- line, so there is no minority to carve out.
         CASE WHEN COALESCE(o.stake_pct, 0) > 50 THEN 100 - o.stake_pct ELSE 0 END,
         CASE
           WHEN o.stake_pct IS NULL THEN 'stake unknown — recorded as an investment rather than guessed'
           WHEN o.stake_pct > 50    THEN 'PSAK 65: stake above 50% presumed to confer control'
           WHEN o.stake_pct >= 20   THEN 'PSAK 15: stake 20-50% presumed significant influence'
           ELSE 'PSAK 71: stake below 20% presumed neither control nor significant influence'
         END
    FROM company_ownership o
    JOIN companies c ON c.id = o.tenant_id AND c.deleted_at IS NULL
   WHERE o.holder_company_id = p_parent
     AND o.deleted_at IS NULL
     AND (p_as_of IS NULL OR (o.effective_from <= p_as_of AND (o.effective_to IS NULL OR o.effective_to > p_as_of)))
     AND (p_as_of IS NOT NULL OR o.effective_to IS NULL);
$$;
GRANT EXECUTE ON FUNCTION finance_group_members(uuid, date) TO PUBLIC;
COMMENT ON FUNCTION finance_group_members(uuid, date) IS
  'F9-01: consolidation basis per subsidiary, DERIVED from company_ownership rather than stored as '
  'a flag — a flag and a stake can disagree, and then the flag is what the software believes while '
  'the stake is what is true. Reports `basis` because the percentage rule is a default, not a law: '
  'PSAK 65 control is about power, not arithmetic.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) The consolidation ledger — separate, and deliberately NOT the journal tables
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE finance_consolidation_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The PARENT/reporting entity. Named tenant_id so the standard isolation policy applies unchanged.
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  as_of         date NOT NULL,
  label         text,
  -- A run is a SNAPSHOT of a judgement made on a date. It is never edited: a changed elimination
  -- means a new run, so "what did we report in March" stays answerable after the numbers move.
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  origin_site   text NOT NULL DEFAULT 'central',
  CONSTRAINT ux_finance_consol_runs_id_tenant UNIQUE (id, tenant_id)
);
CREATE INDEX ix_finance_consol_runs_asof ON finance_consolidation_runs (tenant_id, as_of DESC);

CREATE TABLE finance_consolidation_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  run_id        uuid NOT NULL,
  -- Which entity's figures this adjustment applies to, and which account.
  subject_company_id uuid NOT NULL REFERENCES companies(id),
  account_code  text NOT NULL,
  side          text NOT NULL CHECK (side IN ('debit','credit')),
  amount        numeric(20,2) NOT NULL CHECK (amount > 0),
  kind          text NOT NULL CHECK (kind IN (
                  'ic_balance','ic_revenue_expense','unrealised_profit','investment_equity','nci','goodwill','other')),
  memo          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_finance_consol_entries_run
    FOREIGN KEY (run_id, tenant_id) REFERENCES finance_consolidation_runs (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX ix_finance_consol_entries_run ON finance_consolidation_entries (run_id);

COMMENT ON TABLE finance_consolidation_entries IS
  'F9-03: elimination and consolidation adjustments. DELIBERATELY NOT finance_journal_entries — an '
  'elimination is true of the GROUP and false of the ENTITY. Posting one into a subsidiary''s books '
  'would make its standalone statements and its tax return wrong, and leave an auditor looking at '
  'entries with no supporting transaction.';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_consolidation_runs','finance_consolidation_entries'] LOOP
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

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (3) finance_consolidation_balanced() — an elimination set must balance
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Eliminations are journal entries in every sense except where they live, so debits must equal
-- credits. An unbalanced set would make the consolidated balance sheet not balance, and the cause
-- would be indistinguishable from a real accounting error in one of the entities.
CREATE OR REPLACE FUNCTION finance_consolidation_balanced(p_run uuid)
  RETURNS TABLE (total_debit numeric, total_credit numeric, balanced boolean)
  LANGUAGE sql STABLE AS $$
  SELECT COALESCE(sum(amount) FILTER (WHERE side = 'debit'), 0),
         COALESCE(sum(amount) FILTER (WHERE side = 'credit'), 0),
         COALESCE(sum(amount) FILTER (WHERE side = 'debit'), 0)
           = COALESCE(sum(amount) FILTER (WHERE side = 'credit'), 0)
    FROM finance_consolidation_entries WHERE run_id = p_run;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (4) finance_eliminate_intercompany() — F9-05, the first real elimination
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Removes matched intercompany receivable/payable pairs across the group.
--
-- ⚠ It REFUSES when the two sides disagree. Every automatic treatment of a difference is wrong:
-- netting it hides a real reconciling item, and forcing it to one side invents a number. The
-- difference is a genuine operational problem (goods in transit, cash in transit, a missed entry)
-- and someone has to resolve it before the group can be reported.
CREATE OR REPLACE FUNCTION finance_eliminate_intercompany(
  p_run uuid
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_run    finance_consolidation_runs%ROWTYPE;
  v_n      integer := 0;
  m        record;
  r        record;
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
      SELECT p.counterparty_company_id AS cp, p.receivable, p.payable
        FROM finance_intercompany_position(m.company_id, v_run.as_of) p
    LOOP
      -- Only eliminate against a company that is itself in the group. A related-party balance with
      -- an entity OUTSIDE the group is a real external balance and must survive consolidation.
      CONTINUE WHEN NOT EXISTS (
        SELECT 1 FROM finance_group_members(v_run.tenant_id, v_run.as_of) g2
         WHERE g2.company_id = r.cp AND g2.consolidation IN ('full','parent'));

      IF (SELECT count(*) FROM finance_intercompany_mismatch(m.company_id, r.cp, v_run.as_of)) > 0 THEN
        RAISE EXCEPTION
          'FINANCE_INTERCOMPANY_MISMATCH: the two sides of the balance between % and % disagree; '
          'resolve it before consolidating (netting it would hide a real reconciling item)',
          m.company_id, r.cp;
      END IF;

      -- Remove the receivable in this company against the payable in the counterparty. One entry
      -- per side, each naming the company it adjusts, so the working paper reads like a journal.
      IF r.receivable <> 0 THEN
        INSERT INTO finance_consolidation_entries
          (tenant_id, run_id, subject_company_id, account_code, side, amount, kind, memo)
        VALUES (v_run.tenant_id, p_run, m.company_id, '1290', 'credit', abs(r.receivable), 'ic_balance',
                'Eliminate intercompany receivable');
        INSERT INTO finance_consolidation_entries
          (tenant_id, run_id, subject_company_id, account_code, side, amount, kind, memo)
        VALUES (v_run.tenant_id, p_run, r.cp, '2290', 'debit', abs(r.receivable), 'ic_balance',
                'Eliminate intercompany payable');
        v_n := v_n + 2;
      END IF;
    END LOOP;
  END LOOP;
  RETURN v_n;
END $$;
COMMENT ON FUNCTION finance_eliminate_intercompany(uuid) IS
  'F9-05: eliminates matched intercompany balances into the consolidation ledger. REFUSES when the '
  'two sides disagree — netting hides a real reconciling item and forcing invents a number, so a '
  'human resolves it before the group is reported. Balances with entities outside the group are '
  'left alone: they are real external balances.';
