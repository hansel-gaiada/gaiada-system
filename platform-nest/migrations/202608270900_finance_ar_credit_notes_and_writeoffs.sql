-- Finance F4b — AR CREDIT NOTES AND WRITE-OFFS. The two ways a receivable legitimately shrinks
-- without cash arriving.
--
-- 202608241019 built the AR subledger and deferred these explicitly: finance_ar_invoices carries the
-- comment "(Credit balances are deferred with credit memos.)" and the F4 Cerbos policy already
-- reserves a `write_off` action, the permission catalog already reserves `finance.ar.write_off`, and
-- the SoD matrix already seeds `ar_receipt_posting + ar_writeoff_approve` as a BLOCKING conflict.
-- Everything except the accounting existed. This migration supplies the accounting.
--
-- ── THE DISTINCTION THIS MIGRATION EXISTS TO PRESERVE ──────────────────────────────────────────
-- A credit note and a write-off both make a receivable go away, and conflating them is the single
-- most expensive mistake available here, because they differ on VAT and VAT is cash:
--
--   CREDIT NOTE (nota retur / adjustment) — the customer never owed it. We over-billed, goods came
--     back, a discount was agreed. Revenue is reduced, and the OUTPUT VAT IS REVERSED: we reclaim
--     PPN we previously declared. Posts against contra-revenue (4300 Retur Penjualan / 4200
--     Potongan Penjualan) plus a debit to 2140 PPN Keluaran.
--
--   WRITE-OFF (piutang tak tertagih) — the customer DID owe it and is not going to pay. The sale was
--     real, the VAT was genuinely due, and it was already remitted. The output VAT is NOT reversed.
--     Indonesian PPN gives no relief for a bad debt merely because it was written off; treating a
--     write-off like a credit note reclaims VAT the company is not entitled to, which understates
--     tax payable and surfaces in a Coretax reconciliation as a difference DJP will ask about.
--
-- So they are separate documents, separate tables, separate postings and separate rights. They are
-- NOT two `reason` values on one adjustment table, which is how this usually gets built and is
-- exactly how the VAT ends up wrong.
--
-- ── WHY THE TIE-OUT FUNCTIONS ARE RE-DEFINED AT THE BOTTOM, NOT EDITED IN PLACE ────────────────
-- finance_ar_aging / finance_ar_reconcile / finance_ar_position live in 202608241019, which is
-- already applied on every estate. Editing an applied migration reaches fresh databases ONLY and
-- never reaches production — the exact failure that left two finance functions silently wrong on
-- live for weeks (see 202608261900 / 202608261930 and `npm run lint:migration-immutable`). They are
-- therefore CREATE OR REPLACEd here, with the original bodies copied and changed minimally.
--
-- That is not decoration. If the aging and the reconciliation do not learn about credits and
-- write-offs, then the moment the first credit note posts, the AR control account moves and the
-- subledger does not — and finance_ar_reconcile reports a permanent mismatch that is the
-- reconciliation's own fault rather than the data's.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) HOW THIS COMPANY WRITES OFF BAD DEBT — a setting, not a guess.
--
-- Two lawful treatments, and the chart already hints at the second: 1131 "Cadangan Kerugian
-- Piutang" is an allowance account that exists in the template but nothing has ever posted to it.
--
--   direct     — DR bad-debt expense, CR AR. What a company with no provisioning policy does.
--   allowance  — DR the allowance (1131), CR AR. The PSAK 71 / IFRS 9 expected-credit-loss shape,
--                where the expense was recognised earlier, when the provision was raised.
--
-- Default is `direct`, because that is what every company on this estate is actually doing today —
-- no provision has ever been booked, so defaulting to `allowance` would post a debit into a
-- contra-asset with no credit balance, produce a negative allowance, and look like a bug in the
-- write-off rather than a missing accounting policy.
--
-- ⚠ Deliberately NOT auto-detected from the allowance balance. A rule like "use the allowance if
-- there is one, else expense" makes two write-offs in the same afternoon post to different accounts
-- depending on their order, which is indefensible to an auditor. The policy is a decision somebody
-- makes once and records.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE finance_company_settings
  ADD COLUMN IF NOT EXISTS bad_debt_method text NOT NULL DEFAULT 'direct';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_finance_settings_bad_debt_method') THEN
    ALTER TABLE finance_company_settings
      ADD CONSTRAINT ck_finance_settings_bad_debt_method
      CHECK (bad_debt_method IN ('direct','allowance'));
  END IF;
END $$;

COMMENT ON COLUMN finance_company_settings.bad_debt_method IS
  'direct = DR bad-debt expense (6950) on write-off. allowance = DR the allowance (1131), for a '
  'company that provisions under PSAK 71. An accounting POLICY recorded once, never inferred from '
  'the current allowance balance -- which would make identical write-offs post differently by order.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) 6950 Beban Kerugian Piutang — the expense account the template never had.
--
-- The chart shipped 1131 (the allowance, a contra-ASSET) but no bad-debt EXPENSE, so the `direct`
-- method had nowhere to post. Added to the template for future companies AND backfilled into every
-- existing chart, because a feature that only works on companies created after today is not built.
--
-- ⚠ THE BACKFILL MUST SET BOTH GUCs. finance_accounts composes its RLS policy as
-- `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('finance')`. Migrations run as
-- platform_app (NOBYPASSRLS) on a live estate — a bare INSERT here writes ZERO rows and reports
-- success. `companies` is enumerable, finance_accounts is not, which is why the loop is driven from
-- companies rather than from the accounts themselves.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
INSERT INTO finance_coa_template_lines
  (template_id, code, name, parent_code, account_type, normal_balance,
   is_postable, is_control, control_subledger, sort_order)
SELECT t.id, '6950', 'Beban Kerugian Piutang', '6000', 'expense', 'debit', true, false, NULL,
       COALESCE((SELECT max(sort_order) FROM finance_coa_template_lines WHERE template_id = t.id), 0) + 1
  FROM finance_coa_templates t
 WHERE NOT EXISTS (
   SELECT 1 FROM finance_coa_template_lines l WHERE l.template_id = t.id AND l.code = '6950');

DO $$
DECLARE co record; v_parent uuid; v_n integer := 0;
BEGIN
  FOR co IN SELECT id FROM companies LOOP
    PERFORM set_config('app.current_tenant_ids', co.id::text, true);
    PERFORM set_config('app.scopes', 'finance', true);

    -- Only companies that actually have a chart. A company with no finance_accounts rows has never
    -- been instantiated, and must not acquire a single orphan account here.
    IF NOT EXISTS (SELECT 1 FROM finance_accounts WHERE tenant_id = co.id) THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM finance_accounts WHERE tenant_id = co.id AND code = '6950') THEN CONTINUE; END IF;

    SELECT id INTO v_parent FROM finance_accounts
     WHERE tenant_id = co.id AND code = '6000' AND deleted_at IS NULL;

    INSERT INTO finance_accounts
      (tenant_id, code, name, parent_id, account_type, normal_balance,
       is_postable, allow_manual_posting, is_control, control_subledger, status)
    VALUES
      (co.id, '6950', 'Beban Kerugian Piutang', v_parent, 'expense', 'debit',
       true, true, false, NULL, 'active');
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE 'finance F4b: added 6950 Beban Kerugian Piutang to % existing chart(s)', v_n;
END $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (3) The invoice learns two new ways to be settled.
--
-- Outstanding was `total - amount_paid`. It becomes
--
--     total - amount_paid - amount_credited - amount_written_off
--
-- and these are THREE separate columns rather than one because they are three different economic
-- events that a collections person, a tax return and an auditor each need to tell apart. Folding a
-- credit into amount_paid would also break finance_ar_reconcile's cache-drift check, which compares
-- amount_paid against the sum of RECEIPT allocations — the credit would look like drift forever.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE finance_ar_invoices
  ADD COLUMN IF NOT EXISTS amount_credited     numeric(20,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amount_written_off  numeric(20,4) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_finance_ar_invoices_settled') THEN
    ALTER TABLE finance_ar_invoices
      ADD CONSTRAINT ck_finance_ar_invoices_settled
      CHECK (amount_credited >= 0 AND amount_written_off >= 0
             AND amount_paid + amount_credited + amount_written_off <= total);
  END IF;
END $$;

COMMENT ON COLUMN finance_ar_invoices.amount_credited IS
  'Settled by CREDIT NOTE (the customer never owed it; output VAT reversed). Separate from '
  'amount_paid so the receipt cache-drift check keeps working, and separate from amount_written_off '
  'because the two have opposite VAT treatment.';
COMMENT ON COLUMN finance_ar_invoices.amount_written_off IS
  'Settled by WRITE-OFF (the customer owed it and will not pay; output VAT NOT reversed).';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (4) finance_ar_credit_notes — a document with a lifecycle, mirroring the invoice.
--
-- A credit note may be raised WITHOUT naming an invoice (a general credit on the account), which is
-- why original_invoice_id is nullable and application is a separate act. That is the same shape as
-- a receipt: the money — or here, the credit — exists before anyone decides what it settles.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS finance_ar_credit_notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES companies(id),
  customer_id     uuid NOT NULL,
  credit_note_no  text NOT NULL,
  credit_note_date date NOT NULL,
  currency_code   text NOT NULL REFERENCES finance_currencies(code),

  subtotal        numeric(20,4) NOT NULL CHECK (subtotal >= 0),
  tax_total       numeric(20,4) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  total           numeric(20,4) NOT NULL CHECK (total > 0),
  amount_applied  numeric(20,4) NOT NULL DEFAULT 0 CHECK (amount_applied >= 0),

  -- WHY the credit exists. Required, and free text is not enough on its own — the reason CODE is
  -- what a revenue-leakage report groups by, and "misc" as the only option makes that report
  -- useless. A credit note with no stated cause is indistinguishable from a concealed write-off,
  -- which is the control this column exists to provide.
  reason_code     text NOT NULL CHECK (reason_code IN
                    ('return','overbilling','discount','service_failure','price_correction','other')),
  reason          text NOT NULL,

  -- The invoice this credit relates to, when it relates to exactly one. Application is still an
  -- explicit act -- this only records intent and drives the default.
  original_invoice_id uuid,

  status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','issued','applied','void')),
  journal_entry_id uuid,
  -- Nota retur reference once transmitted through an ASP/PJAP. Recorded here, never transmitted
  -- from here -- same carve-out as finance_ar_invoices.efaktur_no (ruling D-F2).
  efaktur_retur_no text,
  notes           text,
  origin_site     text NOT NULL DEFAULT 'central',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_finance_ar_cn_customer
    FOREIGN KEY (customer_id, tenant_id) REFERENCES finance_ar_customers (id, tenant_id),
  CONSTRAINT fk_finance_ar_cn_invoice
    FOREIGN KEY (original_invoice_id, tenant_id) REFERENCES finance_ar_invoices (id, tenant_id),
  CONSTRAINT fk_finance_ar_cn_journal
    FOREIGN KEY (journal_entry_id, tenant_id) REFERENCES finance_journal_entries (id, tenant_id),
  CONSTRAINT ux_finance_ar_cn_no UNIQUE (tenant_id, credit_note_no),
  CONSTRAINT ux_finance_ar_cn_id_tenant UNIQUE (id, tenant_id),
  CONSTRAINT ck_finance_ar_cn_total CHECK (total = subtotal + tax_total),
  CONSTRAINT ck_finance_ar_cn_applied CHECK (amount_applied <= total),
  CONSTRAINT ck_finance_ar_cn_journal CHECK ((status = 'draft') = (journal_entry_id IS NULL))
);
CREATE INDEX IF NOT EXISTS ix_finance_ar_cn_customer
  ON finance_ar_credit_notes (tenant_id, customer_id, credit_note_date DESC);

CREATE TABLE IF NOT EXISTS finance_ar_credit_note_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES companies(id),
  credit_note_id uuid NOT NULL,
  description    text NOT NULL,
  line_subtotal  numeric(20,4) NOT NULL CHECK (line_subtotal > 0),
  -- WHERE the reduction lands. Defaults to contra-revenue (4300 Retur Penjualan / 4200 Potongan
  -- Penjualan) rather than debiting the original revenue account, so gross revenue and returns stay
  -- separately visible -- netting them hides a deteriorating return rate completely.
  credit_account_id uuid NOT NULL,
  sort_order     integer NOT NULL DEFAULT 0,
  CONSTRAINT fk_finance_ar_cnl_note
    FOREIGN KEY (credit_note_id, tenant_id) REFERENCES finance_ar_credit_notes (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT fk_finance_ar_cnl_account
    FOREIGN KEY (credit_account_id, tenant_id) REFERENCES finance_accounts (id, tenant_id),
  CONSTRAINT ux_finance_ar_cnl_id_tenant UNIQUE (id, tenant_id)
);
CREATE INDEX IF NOT EXISTS ix_finance_ar_cnl_note ON finance_ar_credit_note_lines (credit_note_id);

-- ⚠ A SEPARATE APPLICATION TABLE, NOT finance_ar_allocations.
--
-- finance_ar_reconcile checks `invoice.amount_paid = sum(finance_ar_allocations.amount)` per
-- invoice. Putting credit applications into that same table would break that check on every invoice
-- that ever receives a credit -- silently, and in the direction that looks like cache corruption.
-- The tables are the same shape on purpose; they are not the same fact.
CREATE TABLE IF NOT EXISTS finance_ar_credit_applications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES companies(id),
  credit_note_id uuid NOT NULL,
  invoice_id     uuid NOT NULL,
  amount         numeric(20,4) NOT NULL CHECK (amount > 0),
  applied_at     timestamptz NOT NULL DEFAULT now(),
  applied_by     uuid REFERENCES users(id),
  CONSTRAINT fk_finance_ar_ca_note
    FOREIGN KEY (credit_note_id, tenant_id) REFERENCES finance_ar_credit_notes (id, tenant_id),
  CONSTRAINT fk_finance_ar_ca_invoice
    FOREIGN KEY (invoice_id, tenant_id) REFERENCES finance_ar_invoices (id, tenant_id),
  CONSTRAINT ux_finance_ar_ca_pair UNIQUE (credit_note_id, invoice_id)
);

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (5) finance_ar_writeoffs — forgiving a debt.
--
-- Always against ONE invoice. Unlike a credit note there is no such thing as a general write-off:
-- you cannot write off a debt without naming which debt, and a "write-off on account" would be
-- indistinguishable from cash going missing.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS finance_ar_writeoffs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES companies(id),
  invoice_id     uuid NOT NULL,
  customer_id    uuid NOT NULL,
  write_off_date date NOT NULL,
  amount         numeric(20,4) NOT NULL CHECK (amount > 0),
  reason_code    text NOT NULL CHECK (reason_code IN
                   ('uncollectible','customer_insolvent','disputed_abandoned','below_recovery_cost','statute_barred','other')),
  reason         text NOT NULL,
  -- The method APPLIED, snapshotted. The company setting can change later, and a five-year-old
  -- write-off must still explain which account it hit and why.
  method         text NOT NULL CHECK (method IN ('direct','allowance')),
  journal_entry_id uuid,
  approved_by    uuid REFERENCES users(id),
  origin_site    text NOT NULL DEFAULT 'central',
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_finance_ar_wo_invoice
    FOREIGN KEY (invoice_id, tenant_id) REFERENCES finance_ar_invoices (id, tenant_id),
  CONSTRAINT fk_finance_ar_wo_customer
    FOREIGN KEY (customer_id, tenant_id) REFERENCES finance_ar_customers (id, tenant_id),
  CONSTRAINT fk_finance_ar_wo_journal
    FOREIGN KEY (journal_entry_id, tenant_id) REFERENCES finance_journal_entries (id, tenant_id),
  CONSTRAINT ux_finance_ar_wo_id_tenant UNIQUE (id, tenant_id)
);
CREATE INDEX IF NOT EXISTS ix_finance_ar_wo_invoice ON finance_ar_writeoffs (tenant_id, invoice_id);

-- ── The finance third wall, for the four new tables ─────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'finance_ar_credit_notes','finance_ar_credit_note_lines',
    'finance_ar_credit_applications','finance_ar_writeoffs'
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

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (6) finance_ar_issue_credit_note() — post the credit to the ledger.
--
--   DR  contra-revenue (per line)   line_subtotal     -- 4300 Retur / 4200 Potongan
--   DR  output VAT (2140)           tax_total         -- reversing PPN previously declared
--       CR  AR control              total
--
-- Deliberately mirrors finance_ar_issue_invoice: same control-account resolution BY ROLE (the chart
-- is editable data, ruling D-F5 — a hardcoded '1130' posts to the wrong account after a renumber),
-- same idempotent source key, same refusal to post an empty document.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_ar_issue_credit_note(p_note uuid, p_actor uuid DEFAULT NULL)
  RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_cn    finance_ar_credit_notes%ROWTYPE;
  v_ar    text;
  v_vat   text;
  v_lines jsonb;
  v_entry uuid;
BEGIN
  SELECT * INTO v_cn FROM finance_ar_credit_notes WHERE id = p_note;
  IF v_cn.id IS NULL THEN
    RAISE EXCEPTION 'FINANCE_AR_UNKNOWN_CREDIT_NOTE: no credit note %', p_note;
  END IF;
  IF v_cn.status <> 'draft' THEN
    RAISE EXCEPTION 'FINANCE_AR_CN_ALREADY_ISSUED: credit note % is %', v_cn.credit_note_no, v_cn.status;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM finance_ar_credit_note_lines WHERE credit_note_id = p_note) THEN
    RAISE EXCEPTION 'FINANCE_AR_CN_EMPTY: credit note % has no lines', v_cn.credit_note_no;
  END IF;

  SELECT code INTO v_ar FROM finance_accounts
   WHERE tenant_id = v_cn.tenant_id AND is_control AND control_subledger = 'ar'
     AND deleted_at IS NULL AND status = 'active'
   ORDER BY code LIMIT 1;
  IF v_ar IS NULL THEN
    RAISE EXCEPTION 'FINANCE_AR_NO_CONTROL_ACCOUNT: this company has no active AR control account'
      USING HINT = 'Mark the receivables account is_control with control_subledger = ''ar''.';
  END IF;

  IF v_cn.tax_total > 0 THEN
    SELECT code INTO v_vat FROM finance_accounts
     WHERE tenant_id = v_cn.tenant_id AND code = '2140' AND deleted_at IS NULL AND status = 'active';
    IF v_vat IS NULL THEN
      RAISE EXCEPTION 'FINANCE_AR_NO_VAT_ACCOUNT: credit note carries tax but no output VAT account (2140) exists';
    END IF;
  END IF;

  SELECT coalesce((
           SELECT jsonb_agg(jsonb_build_object(
                    'account_code', a.code, 'side', 'debit', 'amount', x.amt,
                    'memo', 'Credit note ' || v_cn.credit_note_no))
             FROM (SELECT credit_account_id, sum(line_subtotal) AS amt
                     FROM finance_ar_credit_note_lines WHERE credit_note_id = p_note
                    GROUP BY credit_account_id) x
             JOIN finance_accounts a ON a.id = x.credit_account_id), '[]'::jsonb)
       || CASE WHEN v_cn.tax_total > 0
               THEN jsonb_build_array(jsonb_build_object(
                      'account_code', v_vat, 'side', 'debit', 'amount', v_cn.tax_total,
                      'memo', 'Output VAT reversed on ' || v_cn.credit_note_no))
               ELSE '[]'::jsonb END
       || jsonb_build_array(jsonb_build_object(
            'account_code', v_ar, 'side', 'credit', 'amount', v_cn.total,
            'memo', 'Credit note ' || v_cn.credit_note_no))
    INTO v_lines;

  v_entry := finance_post_journal(
    v_cn.tenant_id, v_cn.credit_note_date,
    'ar-credit-note:' || p_note::text,
    'AR credit note ' || v_cn.credit_note_no,
    v_lines, p_actor, 'standard', NULL, v_cn.currency_code, NULL, NULL, 'ar');

  UPDATE finance_ar_credit_notes
     SET status = 'issued', journal_entry_id = v_entry, updated_at = now()
   WHERE id = p_note;

  RETURN v_entry;
END $$;

COMMENT ON FUNCTION finance_ar_issue_credit_note(uuid,uuid) IS
  'Posts a credit note: DR contra-revenue + DR output VAT, CR AR control. The VAT debit is the '
  'difference from a write-off -- a credit note reverses PPN previously declared, a write-off does '
  'not. Application to specific invoices is a separate, subledger-only act.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (7) finance_ar_apply_credit() — subledger only, posts NOTHING.
--
-- Exactly the reasoning in finance_ar_allocate: the credit hit the control account when the note
-- was issued. Deciding which invoice it settles moves no money and must not touch the ledger a
-- second time.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_ar_apply_credit(
  p_note uuid, p_invoice uuid, p_amount numeric, p_actor uuid DEFAULT NULL)
  RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_cn        finance_ar_credit_notes%ROWTYPE;
  v_inv       finance_ar_invoices%ROWTYPE;
  v_cn_free   numeric;
  v_inv_open  numeric;
  v_id        uuid;
BEGIN
  SELECT * INTO v_cn FROM finance_ar_credit_notes WHERE id = p_note;
  IF v_cn.id IS NULL THEN
    RAISE EXCEPTION 'FINANCE_AR_UNKNOWN_CREDIT_NOTE: no credit note %', p_note;
  END IF;
  IF v_cn.status NOT IN ('issued','applied') THEN
    RAISE EXCEPTION 'FINANCE_AR_CN_NOT_ISSUED: credit note % is %, and only an issued note can be applied',
      v_cn.credit_note_no, v_cn.status;
  END IF;

  SELECT * INTO v_inv FROM finance_ar_invoices WHERE id = p_invoice;
  IF v_inv.id IS NULL THEN
    RAISE EXCEPTION 'FINANCE_AR_UNKNOWN_INVOICE: no invoice %', p_invoice;
  END IF;
  IF v_inv.tenant_id <> v_cn.tenant_id THEN
    RAISE EXCEPTION 'FINANCE_AR_CROSS_COMPANY: credit note and invoice belong to different companies';
  END IF;
  IF v_inv.customer_id <> v_cn.customer_id THEN
    RAISE EXCEPTION 'FINANCE_AR_CN_WRONG_CUSTOMER: credit note % is for a different customer than invoice %',
      v_cn.credit_note_no, v_inv.invoice_no;
  END IF;
  IF v_inv.status NOT IN ('issued','paid') THEN
    RAISE EXCEPTION 'FINANCE_AR_CN_INVOICE_NOT_ISSUED: invoice % is %', v_inv.invoice_no, v_inv.status;
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'FINANCE_AR_CN_BAD_AMOUNT: application amount must be greater than zero';
  END IF;

  v_cn_free  := v_cn.total - v_cn.amount_applied;
  v_inv_open := v_inv.total - v_inv.amount_paid - v_inv.amount_credited - v_inv.amount_written_off;

  IF p_amount > v_cn_free THEN
    RAISE EXCEPTION 'FINANCE_AR_CN_OVERAPPLIED: credit note % has only % unapplied',
      v_cn.credit_note_no, v_cn_free;
  END IF;
  IF p_amount > v_inv_open THEN
    RAISE EXCEPTION 'FINANCE_AR_CN_OVER_INVOICE: invoice % has only % outstanding',
      v_inv.invoice_no, v_inv_open;
  END IF;

  INSERT INTO finance_ar_credit_applications
    (tenant_id, credit_note_id, invoice_id, amount, applied_by)
  VALUES (v_cn.tenant_id, p_note, p_invoice, p_amount, p_actor)
  ON CONFLICT (credit_note_id, invoice_id) DO UPDATE
    SET amount = finance_ar_credit_applications.amount + EXCLUDED.amount,
        applied_at = now()
  RETURNING id INTO v_id;

  UPDATE finance_ar_invoices
     SET amount_credited = amount_credited + p_amount, updated_at = now()
   WHERE id = p_invoice;

  UPDATE finance_ar_credit_notes
     SET amount_applied = amount_applied + p_amount,
         status = CASE WHEN amount_applied + p_amount >= total THEN 'applied' ELSE 'issued' END,
         updated_at = now()
   WHERE id = p_note;

  RETURN v_id;
END $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (8) finance_ar_write_off() — the debt is real and is not coming.
--
--   direct:     DR 6950 Beban Kerugian Piutang    amount
--   allowance:  DR 1131 Cadangan Kerugian Piutang amount
--                   CR AR control                 amount
--
-- ⚠ NO VAT LINE. This is the whole reason write-offs are not credit notes. The supply happened, the
-- PPN was properly due and has been remitted; writing the debt off does not entitle the company to
-- reclaim it. Adding a 2140 debit here would understate PPN payable and produce a Coretax
-- difference that is very hard to explain after the fact.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_ar_write_off(
  p_invoice     uuid,
  p_amount      numeric,
  p_date        date,
  p_reason_code text,
  p_reason      text,
  p_actor       uuid DEFAULT NULL)
  RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_inv    finance_ar_invoices%ROWTYPE;
  v_open   numeric;
  v_method text;
  v_ar     text;
  v_debit  text;
  v_code   text;
  v_entry  uuid;
  v_wo     uuid;
BEGIN
  SELECT * INTO v_inv FROM finance_ar_invoices WHERE id = p_invoice;
  IF v_inv.id IS NULL THEN
    RAISE EXCEPTION 'FINANCE_AR_UNKNOWN_INVOICE: no invoice %', p_invoice;
  END IF;
  IF v_inv.status NOT IN ('issued','paid') THEN
    RAISE EXCEPTION 'FINANCE_AR_WO_NOT_ISSUED: invoice % is % -- only a posted invoice can be written off',
      v_inv.invoice_no, v_inv.status;
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'FINANCE_AR_WO_NO_REASON: a write-off with no recorded reason is indistinguishable from a mistake';
  END IF;

  v_open := v_inv.total - v_inv.amount_paid - v_inv.amount_credited - v_inv.amount_written_off;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'FINANCE_AR_WO_BAD_AMOUNT: write-off amount must be greater than zero';
  END IF;
  IF p_amount > v_open THEN
    RAISE EXCEPTION 'FINANCE_AR_WO_OVER_INVOICE: invoice % has only % outstanding', v_inv.invoice_no, v_open;
  END IF;

  SELECT coalesce(bad_debt_method, 'direct') INTO v_method
    FROM finance_company_settings WHERE tenant_id = v_inv.tenant_id;
  v_method := coalesce(v_method, 'direct');

  SELECT code INTO v_ar FROM finance_accounts
   WHERE tenant_id = v_inv.tenant_id AND is_control AND control_subledger = 'ar'
     AND deleted_at IS NULL AND status = 'active'
   ORDER BY code LIMIT 1;
  IF v_ar IS NULL THEN
    RAISE EXCEPTION 'FINANCE_AR_NO_CONTROL_ACCOUNT: this company has no active AR control account';
  END IF;

  v_code := CASE WHEN v_method = 'allowance' THEN '1131' ELSE '6950' END;
  SELECT code INTO v_debit FROM finance_accounts
   WHERE tenant_id = v_inv.tenant_id AND code = v_code AND deleted_at IS NULL AND status = 'active';
  IF v_debit IS NULL THEN
    RAISE EXCEPTION 'FINANCE_AR_WO_NO_ACCOUNT: bad-debt method % needs account % and this company has no active one',
      v_method, v_code
      USING HINT = 'Create it in the chart, or change finance_company_settings.bad_debt_method.';
  END IF;

  INSERT INTO finance_ar_writeoffs
    (tenant_id, invoice_id, customer_id, write_off_date, amount,
     reason_code, reason, method, approved_by)
  VALUES (v_inv.tenant_id, p_invoice, v_inv.customer_id, p_date, p_amount,
          coalesce(p_reason_code,'uncollectible'), p_reason, v_method, p_actor)
  RETURNING id INTO v_wo;

  v_entry := finance_post_journal(
    v_inv.tenant_id, p_date,
    'ar-writeoff:' || v_wo::text,
    'AR write-off on ' || v_inv.invoice_no,
    jsonb_build_array(
      jsonb_build_object('account_code', v_debit, 'side', 'debit', 'amount', p_amount,
                         'memo', 'Write-off ' || v_inv.invoice_no),
      jsonb_build_object('account_code', v_ar, 'side', 'credit', 'amount', p_amount,
                         'memo', 'Write-off ' || v_inv.invoice_no)),
    p_actor, 'standard', NULL, v_inv.currency_code, NULL, NULL, 'ar');

  UPDATE finance_ar_writeoffs SET journal_entry_id = v_entry WHERE id = v_wo;
  UPDATE finance_ar_invoices
     SET amount_written_off = amount_written_off + p_amount, updated_at = now()
   WHERE id = p_invoice;

  RETURN v_wo;
END $$;

COMMENT ON FUNCTION finance_ar_write_off(uuid,numeric,date,text,text,uuid) IS
  'Writes off an uncollectible receivable. DR bad-debt expense (6950) or the allowance (1131) per '
  'finance_company_settings.bad_debt_method, CR AR control. Posts NO VAT line -- Indonesian PPN is '
  'not recoverable on a bad debt, and reversing it here would understate tax payable.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (9) THE TIE-OUT FUNCTIONS RE-DEFINED.
--
-- Copied from 202608241019 and changed minimally. NOT edited there — that migration is applied on
-- every estate, and an edit would reach fresh databases only. See this file's header.
--
-- ── THE IDENTITY GROWS A THIRD TERM ────────────────────────────────────────────────────────────
-- The original comment in finance_ar_reconcile explains why unallocated RECEIPTS belong in the
-- position: a receipt credits the control account the moment money lands, before anyone decides
-- which invoice it settles. An UNAPPLIED CREDIT NOTE is the same shape for the same reason — it
-- credits the control account when issued, and application is a later, ledger-free act. So:
--
--     control balance = SUM(invoice outstanding)
--                     - SUM(receipt unallocated)
--                     - SUM(credit note unapplied)
--
-- Leaving the third term out would report a mismatch on every credit note that is issued and not
-- yet fully applied — which is the normal state of a credit note for as long as it takes somebody
-- to decide what it settles.
--
-- Write-offs need no term of their own: a write-off is always against one invoice and immediately
-- reduces that invoice's outstanding, so it is already inside the first term.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION finance_ar_aging(p_company uuid, p_as_of date DEFAULT NULL)
  RETURNS TABLE (
    customer_code text, customer_name text,
    current_amt numeric, d1_30 numeric, d31_60 numeric, d61_90 numeric, d90_plus numeric,
    total_outstanding numeric
  ) LANGUAGE sql STABLE AS $$
  WITH asof AS (SELECT coalesce(p_as_of, CURRENT_DATE) AS d),
  open_inv AS (
    SELECT i.customer_id,
           (i.total - i.amount_paid - i.amount_credited - i.amount_written_off) AS outstanding,
           ((SELECT d FROM asof) - i.due_date) AS days_overdue
      FROM finance_ar_invoices i
     WHERE i.tenant_id = p_company
       AND i.status IN ('issued','paid')
       AND i.total > i.amount_paid + i.amount_credited + i.amount_written_off
       AND i.invoice_date <= (SELECT d FROM asof)
  )
  SELECT c.code, c.name,
         coalesce(sum(o.outstanding) FILTER (WHERE o.days_overdue <= 0), 0),
         coalesce(sum(o.outstanding) FILTER (WHERE o.days_overdue BETWEEN 1 AND 30), 0),
         coalesce(sum(o.outstanding) FILTER (WHERE o.days_overdue BETWEEN 31 AND 60), 0),
         coalesce(sum(o.outstanding) FILTER (WHERE o.days_overdue BETWEEN 61 AND 90), 0),
         coalesce(sum(o.outstanding) FILTER (WHERE o.days_overdue > 90), 0),
         coalesce(sum(o.outstanding), 0)
    FROM open_inv o
    JOIN finance_ar_customers c ON c.id = o.customer_id
   GROUP BY c.code, c.name
  HAVING sum(o.outstanding) <> 0
   ORDER BY c.code
$$;
COMMENT ON FUNCTION finance_ar_aging(uuid,date) IS
  'Aging by days past due, net of receipts, credit notes AND write-offs. An unapplied credit note '
  'is deliberately absent -- it is a credit on the ACCOUNT, not a negative bucket, exactly as a '
  'customer prepayment is.';

CREATE OR REPLACE FUNCTION finance_ar_reconcile(p_company uuid, p_as_of date DEFAULT NULL)
  RETURNS TABLE (problem text, detail text)
  LANGUAGE sql STABLE AS $$
  WITH asof AS (SELECT coalesce(p_as_of, CURRENT_DATE) AS d),
  sub AS (
    SELECT coalesce(sum(i.total - i.amount_paid - i.amount_credited - i.amount_written_off), 0) AS outstanding
      FROM finance_ar_invoices i
     WHERE i.tenant_id = p_company AND i.status IN ('issued','paid')
       AND i.invoice_date <= (SELECT d FROM asof)
  ),
  on_account AS (
    SELECT coalesce(sum(r.amount - r.amount_allocated), 0) AS unallocated
      FROM finance_ar_receipts r
     WHERE r.tenant_id = p_company AND r.journal_entry_id IS NOT NULL
       AND r.receipt_date <= (SELECT d FROM asof)
  ),
  unapplied_credit AS (
    SELECT coalesce(sum(n.total - n.amount_applied), 0) AS unapplied
      FROM finance_ar_credit_notes n
     WHERE n.tenant_id = p_company AND n.status IN ('issued','applied')
       AND n.credit_note_date <= (SELECT d FROM asof)
  ),
  gl AS (
    SELECT coalesce(sum(m.balance), 0) AS balance
      FROM finance_account_movement(p_company, NULL, (SELECT d FROM asof)) m
      JOIN finance_accounts a ON a.id = m.account_id
     WHERE a.is_control AND a.control_subledger = 'ar'
  )
  SELECT 'AR_SUBLEDGER_GL_MISMATCH',
         'AR subledger net (open invoices ' || sub.outstanding::text ||
         ' less payments on account ' || oa.unallocated::text ||
         ' less unapplied credit notes ' || uc.unapplied::text || ' = ' ||
         (sub.outstanding - oa.unallocated - uc.unapplied)::text ||
         ') <> AR control account balance ' || gl.balance::text ||
         ' (difference ' || (sub.outstanding - oa.unallocated - uc.unapplied - gl.balance)::text || ')'
    FROM sub, on_account oa, unapplied_credit uc, gl
   WHERE sub.outstanding - oa.unallocated - uc.unapplied <> gl.balance
  UNION ALL
  SELECT 'AR_INVOICE_PAID_CACHE_DRIFT',
         'invoice ' || i.invoice_no || ': amount_paid ' || i.amount_paid::text ||
         ' <> allocations ' || coalesce(x.allocated, 0)::text
    FROM finance_ar_invoices i
    LEFT JOIN (SELECT invoice_id, sum(amount) AS allocated FROM finance_ar_allocations GROUP BY invoice_id) x
           ON x.invoice_id = i.id
   WHERE i.tenant_id = p_company AND i.amount_paid <> coalesce(x.allocated, 0)
  UNION ALL
  SELECT 'AR_RECEIPT_ALLOCATION_CACHE_DRIFT',
         'receipt ' || r.receipt_no || ': amount_allocated ' || r.amount_allocated::text ||
         ' <> allocations ' || coalesce(x.allocated, 0)::text
    FROM finance_ar_receipts r
    LEFT JOIN (SELECT receipt_id, sum(amount) AS allocated FROM finance_ar_allocations GROUP BY receipt_id) x
           ON x.receipt_id = r.id
   WHERE r.tenant_id = p_company AND r.amount_allocated <> coalesce(x.allocated, 0)
  -- ── The same cache-drift argument, for the two new caches ────────────────────────────────────
  UNION ALL
  SELECT 'AR_INVOICE_CREDIT_CACHE_DRIFT',
         'invoice ' || i.invoice_no || ': amount_credited ' || i.amount_credited::text ||
         ' <> credit applications ' || coalesce(x.applied, 0)::text
    FROM finance_ar_invoices i
    LEFT JOIN (SELECT invoice_id, sum(amount) AS applied FROM finance_ar_credit_applications GROUP BY invoice_id) x
           ON x.invoice_id = i.id
   WHERE i.tenant_id = p_company AND i.amount_credited <> coalesce(x.applied, 0)
  UNION ALL
  SELECT 'AR_CREDIT_NOTE_APPLIED_CACHE_DRIFT',
         'credit note ' || n.credit_note_no || ': amount_applied ' || n.amount_applied::text ||
         ' <> applications ' || coalesce(x.applied, 0)::text
    FROM finance_ar_credit_notes n
    LEFT JOIN (SELECT credit_note_id, sum(amount) AS applied FROM finance_ar_credit_applications GROUP BY credit_note_id) x
           ON x.credit_note_id = n.id
   WHERE n.tenant_id = p_company AND n.amount_applied <> coalesce(x.applied, 0)
  UNION ALL
  SELECT 'AR_INVOICE_WRITEOFF_CACHE_DRIFT',
         'invoice ' || i.invoice_no || ': amount_written_off ' || i.amount_written_off::text ||
         ' <> write-offs ' || coalesce(x.wo, 0)::text
    FROM finance_ar_invoices i
    LEFT JOIN (SELECT invoice_id, sum(amount) AS wo FROM finance_ar_writeoffs GROUP BY invoice_id) x
           ON x.invoice_id = i.id
   WHERE i.tenant_id = p_company AND i.amount_written_off <> coalesce(x.wo, 0)
  -- ── An allowance in DEBIT means the provision was never raised ───────────────────────────────
  -- Only meaningful under the allowance method: write-offs consume a provision, so a debit balance
  -- says more was written off than was ever provided for. Not a ledger error -- a control failure,
  -- and the reconciliation is where somebody will actually see it.
  UNION ALL
  SELECT 'AR_ALLOWANCE_IN_DEBIT',
         'allowance for doubtful debts (1131) has a DEBIT balance of ' || (-m.balance)::text ||
         ' -- more has been written off than provisioned'
    FROM finance_company_settings s
    JOIN finance_accounts a
      ON a.tenant_id = s.tenant_id AND a.code = '1131' AND a.deleted_at IS NULL
    JOIN finance_account_movement(p_company, NULL, (SELECT d FROM asof)) m
      ON m.account_id = a.id
   WHERE s.tenant_id = p_company AND s.bad_debt_method = 'allowance' AND m.balance < 0
$$;
COMMENT ON FUNCTION finance_ar_reconcile(uuid,date) IS
  'F4-06, THE subledger test. One row per PROBLEM; EMPTY is the pass condition. CHECKS, never '
  'repairs. The identity is open invoices - payments on account - UNAPPLIED CREDIT NOTES = the AR '
  'control balance; an unapplied credit note credits the control account exactly as an unallocated '
  'receipt does.';

-- position() gains a fourth number, so DROP first: Postgres cannot CREATE OR REPLACE a function
-- whose OUT parameters changed.
DROP FUNCTION IF EXISTS finance_ar_position(uuid, date);
CREATE FUNCTION finance_ar_position(p_company uuid, p_as_of date DEFAULT NULL)
  RETURNS TABLE (open_invoices numeric, payments_on_account numeric,
                 unapplied_credits numeric, net_receivable numeric)
  LANGUAGE sql STABLE AS $$
  WITH asof AS (SELECT coalesce(p_as_of, CURRENT_DATE) AS d),
  inv AS (
    SELECT coalesce(sum(i.total - i.amount_paid - i.amount_credited - i.amount_written_off), 0) AS v
      FROM finance_ar_invoices i
     WHERE i.tenant_id = p_company AND i.status IN ('issued','paid')
       AND i.invoice_date <= (SELECT d FROM asof)
  ),
  oa AS (
    SELECT coalesce(sum(r.amount - r.amount_allocated), 0) AS v FROM finance_ar_receipts r
     WHERE r.tenant_id = p_company AND r.journal_entry_id IS NOT NULL
       AND r.receipt_date <= (SELECT d FROM asof)
  ),
  uc AS (
    SELECT coalesce(sum(n.total - n.amount_applied), 0) AS v FROM finance_ar_credit_notes n
     WHERE n.tenant_id = p_company AND n.status IN ('issued','applied')
       AND n.credit_note_date <= (SELECT d FROM asof)
  )
  SELECT inv.v, oa.v, uc.v, inv.v - oa.v - uc.v FROM inv, oa, uc
$$;
COMMENT ON FUNCTION finance_ar_position(uuid,date) IS
  'open invoices - payments on account - unapplied credit notes = net receivable, which is what the '
  'AR control account holds. The aging report shows the FIRST number only; neither a prepayment nor '
  'an unapplied credit is a negative invoice, and netting either into a bucket makes the aging lie.';
