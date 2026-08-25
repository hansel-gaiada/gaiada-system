-- Finance F9-04 — INTERCOMPANY TAGGING. The input every elimination needs.
--
-- Owner ruling 2026-08-25 (B2): "yes. as sometime there are some dealings between intercompany."
-- That makes eliminations mandatory rather than optional, and eliminations cannot be computed
-- without knowing WHICH entity is on the other side of a balance.
--
-- ── WHY THE COUNTERPARTY LIVES ON THE ACCOUNT, NOT ON THE JOURNAL ──────────────────────────────
-- The obvious design is a `counterparty_company_id` on the journal entry. It is not available here,
-- and the reason is a good one: `trg_finance_journal_entries_immutable` forbids UPDATE and DELETE
-- on entries and lines, by anyone, ever. So a counterparty could only be set AT POSTING TIME, which
-- means a 13th parameter on `finance_post_journal()` — a 313-line function with seven callers
-- across the migration set. Every one of them would need to thread a value that is NULL in almost
-- every case.
--
-- Putting it on the ACCOUNT is what real ledgers do, and it is better here for three reasons:
--
--   1. **Nothing about the ledger changes.** No new parameter, no re-created function, no risk to
--      the immutability guarantee that the whole design rests on.
--   2. **The accountant sees it.** "1291 Piutang — Viceroy Bali" states the counterparty in the
--      chart of accounts and on every report, instead of hiding it in a column nobody prints.
--   3. **It cannot be forgotten.** A journal parameter defaults to NULL and an untagged
--      intercompany posting looks exactly like a normal one. An account, by contrast, must be
--      CHOSEN — and posting a related-party balance to the plain `1290` is then a visible mistake
--      rather than an invisible one.
--
-- The cost is that the chart grows by one account per counterparty per direction. With three
-- entities that is small, and it is the same shape a group auditor expects to see.
--
-- ── THIS MIGRATION DOES NOT ELIMINATE ANYTHING ─────────────────────────────────────────────────
-- It records the counterparty and checks that the two sides AGREE. Elimination itself (F9-05..07)
-- posts into a separate consolidation ledger and is deliberately a later change — an entity's own
-- books must stay standalone-auditable, so nothing here writes to them.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) The tag
-- ════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE finance_accounts
  ADD COLUMN counterparty_company_id uuid REFERENCES companies(id);

COMMENT ON COLUMN finance_accounts.counterparty_company_id IS
  'F9-04: for an intercompany account, the entity on the OTHER side. NULL for every ordinary '
  'account. Lives here rather than on the journal because the ledger is immutable — a counterparty '
  'could only be set at posting time — and because an account must be chosen, so a mis-posted '
  'related-party balance is a visible mistake rather than an invisible one.';

-- A company cannot be its own counterparty: that balance would eliminate against itself and net to
-- nothing, silently removing a real number from the consolidated statements.
ALTER TABLE finance_accounts
  ADD CONSTRAINT ck_finance_accounts_counterparty_not_self
    CHECK (counterparty_company_id IS NULL OR counterparty_company_id <> tenant_id);

CREATE INDEX ix_finance_accounts_counterparty
  ON finance_accounts (tenant_id, counterparty_company_id)
  WHERE counterparty_company_id IS NOT NULL AND deleted_at IS NULL;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) finance_ensure_intercompany_accounts() — create the pair for a counterparty
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Idempotent by code. Creates a receivable and a payable in THIS company, both tagged with the
-- counterparty. The mirror pair in the other company is a separate call — deliberately, because
-- the two companies are separate tenants and writing into another tenant from here would need a
-- second RLS scope, which is exactly the kind of cross-tenant write this schema exists to prevent.
CREATE OR REPLACE FUNCTION finance_ensure_intercompany_accounts(
  p_company      uuid,
  p_counterparty uuid
) RETURNS TABLE (account_code text, was_created boolean)
  -- OUT params are named account_code/was_created, NOT code/created: a plpgsql OUT parameter is a
  -- variable in scope for the whole body, so `code` would shadow `finance_accounts.code` inside the
  -- INSERT below and Postgres reports "column reference "code" is ambiguous".
  LANGUAGE plpgsql AS $$
DECLARE
  v_name    text;
  v_suffix  text;
  v_ar_code text;
  v_ap_code text;
  v_par_ar  uuid;
  v_par_ap  uuid;
  v_made    boolean;
BEGIN
  IF p_company = p_counterparty THEN
    RAISE EXCEPTION 'FINANCE_COUNTERPARTY_IS_SELF: a company cannot be its own counterparty';
  END IF;
  SELECT c.name INTO v_name FROM companies c WHERE c.id = p_counterparty AND c.deleted_at IS NULL;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'FINANCE_UNKNOWN_COUNTERPARTY: no company %', p_counterparty;
  END IF;

  -- ★ THE SUFFIX COMES FROM THE END OF THE UUID, NOT THE START.
  --
  -- Company ids are uuid v7, whose LEADING hex digits are a millisecond timestamp. Two companies
  -- created in the same millisecond — which a seed or a test does routinely — derive an identical
  -- prefix. Combined with ON CONFLICT DO NOTHING below, the second call then silently returned the
  -- account belonging to the FIRST counterparty, and postings for one entity landed against
  -- another. Caught by the F9 suite: 2,000,000 owed by Outside PT appeared as owed by Beta PT.
  --
  -- The v7 tail is random, so it does not collide by construction. Not the company NAME: a rename
  -- would change an account code, and codes appear in exported statements and in the accountant's
  -- own working papers.
  v_suffix  := upper(right(replace(p_counterparty::text, '-', ''), 6));
  v_ar_code := '1290-' || v_suffix;
  v_ap_code := '2290-' || v_suffix;

  SELECT id INTO v_par_ar FROM finance_accounts
   WHERE tenant_id = p_company AND code = '1200' AND deleted_at IS NULL;
  SELECT id INTO v_par_ap FROM finance_accounts
   WHERE tenant_id = p_company AND code = '2200' AND deleted_at IS NULL;

  -- Refuse rather than silently reuse. An existing code that belongs to a DIFFERENT counterparty is
  -- the collision described above, and returning it would tag one entity's balances with another's
  -- — invisible in the ledger and fatal to consolidation. Loud is the only safe behaviour.
  PERFORM 1 FROM finance_accounts
   WHERE tenant_id = p_company AND code IN (v_ar_code, v_ap_code) AND deleted_at IS NULL
     AND counterparty_company_id IS DISTINCT FROM p_counterparty;
  IF FOUND THEN
    RAISE EXCEPTION
      'FINANCE_INTERCOMPANY_CODE_COLLISION: account code %/% already exists for a different '
      'counterparty in this company', v_ar_code, v_ap_code;
  END IF;

  INSERT INTO finance_accounts
    (tenant_id, code, name, parent_id, account_type, normal_balance, is_postable, counterparty_company_id)
  VALUES (p_company, v_ar_code, 'Piutang Pihak Berelasi — ' || v_name, v_par_ar,
          'asset', 'debit', true, p_counterparty)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_made = ROW_COUNT;
  account_code := v_ar_code; was_created := v_made; RETURN NEXT;

  INSERT INTO finance_accounts
    (tenant_id, code, name, parent_id, account_type, normal_balance, is_postable, counterparty_company_id)
  VALUES (p_company, v_ap_code, 'Utang Pihak Berelasi — ' || v_name, v_par_ap,
          'liability', 'credit', true, p_counterparty)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_made = ROW_COUNT;
  account_code := v_ap_code; was_created := v_made; RETURN NEXT;
END $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (3) finance_intercompany_position() — what each side says it is owed
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_intercompany_position(p_company uuid, p_as_of date DEFAULT NULL)
  RETURNS TABLE (counterparty_company_id uuid, receivable numeric, payable numeric, net numeric)
  LANGUAGE sql STABLE AS $$
  SELECT a.counterparty_company_id,
         COALESCE(sum(m.balance) FILTER (WHERE a.account_type = 'asset'), 0),
         COALESCE(sum(m.balance) FILTER (WHERE a.account_type = 'liability'), 0),
         COALESCE(sum(m.balance) FILTER (WHERE a.account_type = 'asset'), 0)
           - COALESCE(sum(m.balance) FILTER (WHERE a.account_type = 'liability'), 0)
    FROM finance_accounts a
    JOIN finance_account_movement(p_company, NULL, p_as_of) m ON m.account_id = a.id
   WHERE a.tenant_id = p_company
     AND a.deleted_at IS NULL
     AND a.counterparty_company_id IS NOT NULL
   GROUP BY a.counterparty_company_id;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (4) finance_intercompany_mismatch() — the check that makes elimination possible
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- If A says it is owed 10m by B, B must say it owes 10m to A. When they disagree, elimination
-- cannot produce a balanced consolidation — the difference has to go somewhere, and every
-- automatic answer is wrong.
--
-- ⚠ This reads TWO tenants, so the caller must hold both in scope. Called with only one, RLS
-- returns the other side as absent and every pair reports a mismatch equal to the full balance.
-- That is loud rather than silent, which is the right failure, but it is worth knowing.
CREATE OR REPLACE FUNCTION finance_intercompany_mismatch(
  p_company      uuid,
  p_counterparty uuid,
  p_as_of        date DEFAULT NULL
) RETURNS TABLE (problem text, detail text)
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_a_recv numeric;
  v_b_pay  numeric;
  v_a_pay  numeric;
  v_b_recv numeric;
BEGIN
  SELECT COALESCE(p.receivable, 0), COALESCE(p.payable, 0) INTO v_a_recv, v_a_pay
    FROM finance_intercompany_position(p_company, p_as_of) p
   WHERE p.counterparty_company_id = p_counterparty;

  SELECT COALESCE(p.receivable, 0), COALESCE(p.payable, 0) INTO v_b_recv, v_b_pay
    FROM finance_intercompany_position(p_counterparty, p_as_of) p
   WHERE p.counterparty_company_id = p_company;

  v_a_recv := COALESCE(v_a_recv, 0); v_a_pay := COALESCE(v_a_pay, 0);
  v_b_recv := COALESCE(v_b_recv, 0); v_b_pay := COALESCE(v_b_pay, 0);

  IF v_a_recv <> v_b_pay THEN
    RETURN QUERY SELECT 'INTERCOMPANY_RECEIVABLE_MISMATCH'::text,
      'this company is owed ' || v_a_recv::text || ' but the counterparty records owing ' || v_b_pay::text;
  END IF;
  IF v_a_pay <> v_b_recv THEN
    RETURN QUERY SELECT 'INTERCOMPANY_PAYABLE_MISMATCH'::text,
      'this company owes ' || v_a_pay::text || ' but the counterparty records being owed ' || v_b_recv::text;
  END IF;
END $$;
COMMENT ON FUNCTION finance_intercompany_mismatch(uuid, uuid, date) IS
  'F9-04: the two sides of an intercompany balance must agree before elimination is possible. '
  'Reads BOTH tenants — the caller must hold both in scope, or RLS reports the other side as absent '
  'and every pair mismatches by its full balance.';
