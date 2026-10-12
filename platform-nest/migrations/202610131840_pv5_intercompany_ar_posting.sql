-- 202610131840_pv5_intercompany_ar_posting.sql — PV-5 / PV5-05: intercompany posting for group clients.
-- Plan: docs/plans/2026-10-12-pv5-contracts-billing-tickets.md (finding 6, design decision 20, PV5-05).
-- Builds on: F4 (202608241019), F4b (202608270900), F9-04 (202608251430), PV5-01a (202610130400).
--
-- ── THE PROBLEM (finding 6) ────────────────────────────────────────────────────────────────────────
-- F9-04 tags an intercompany balance on the ACCOUNT: `1290-<suffix>` (receivable) and `2290-<suffix>`
-- (payable), each carrying `counterparty_company_id`. PV5-01a gave `finance_ar_customers` the same
-- column, so a group client (PV-D2) is an AR customer that names the group company on the other side.
-- But every AR function still resolved ONE account, the AR control (`is_control AND control_subledger =
-- 'ar' ORDER BY code LIMIT 1`). An invoice to a group client therefore landed on plain AR: invisible to
-- `finance_intercompany_position()`, never eliminated in consolidation, and exactly the "untagged
-- intercompany posting" F9-04's header calls a visible mistake.
--
-- ── WHAT CHANGES ───────────────────────────────────────────────────────────────────────────────────
-- A customer's postings go to that CUSTOMER's receivable:
--   * counterparty_company_id IS NULL     -> the AR control account, resolved exactly as before (by role,
--                                            ordered, never a hard-coded code);
--   * counterparty_company_id = C         -> this company's receivable tagged C, the `1290-*` account that
--                                            finance_ensure_intercompany_accounts(company, C) creates or
--                                            returns. Ensured on every posting, so the first invoice to a
--                                            new group client needs no set-up step.
-- One resolver, finance_ar_receivable_account(customer), so the four posting paths cannot disagree.
--
-- Functions RE-CREATED (CREATE OR REPLACE, signatures unchanged; bodies copied from their latest
-- definition and changed only where the receivable is resolved):
--   finance_ar_issue_invoice     (202608241019) DR the customer's receivable            (was: AR control)
--   finance_ar_record_receipt    (202608241019) CR the customer's receivable            (was: AR control)
--   finance_ar_issue_credit_note (202608270900) CR the customer's receivable            (was: AR control)
--   finance_ar_write_off         (202608270900) CR the invoice customer's receivable    (was: AR control)
--   finance_ar_reconcile         (202608270900) checks each receivable BUCKET separately (see below)
--   finance_ar_position          (202608270900) same four numbers, now summed from the buckets
-- Functions read and deliberately NOT changed:
--   finance_ar_allocate, finance_ar_apply_credit — post nothing; both already refuse to cross customers,
--     so an allocation or a credit application can never move value between buckets.
--   finance_ar_aging — groups by customer, never by account; its total still equals open_invoices.
--   F2 posting rules with subledger 'ar' — a rule names its accounts itself and has no customer; it is
--     untouched, and it was never a path for AR documents.
-- NEW: finance_ar_receivable_account(), finance_ar_position_by_receivable(), and a trigger that freezes a
-- customer's counterparty once the customer has posted anything (section 5).
--
-- ── THE RECONCILIATION IDENTITY, PER BUCKET ────────────────────────────────────────────────────────
-- The F4/F4b identity was one equation: open invoices - payments on account - unapplied credit notes =
-- AR control balance. It now holds once PER RECEIVABLE BUCKET:
--
--   ordinary bucket (customers with no counterparty):
--       AR control balance                     = open - on account - unapplied   over those customers
--   one bucket per counterparty C (customers tagged C):
--       AR-posted movement on C's receivable   = open - on account - unapplied   over those customers
--   and so, summed:
--       AR control + AR portion of the tagged receivables = finance_ar_position().net_receivable
--
-- "AR-posted movement" means the lines on a C-tagged ASSET account from journals that an AR document
-- posted (invoice, receipt, credit note, write-off) plus reversals of those journals. Not the whole
-- account, because `1290-*` is not a control account: F9-04 posts manual intercompany journals to it
-- (a recharge, a cost split), and those are not AR's to reconcile. Counting them would report a
-- permanent mismatch on every recharge, which trains people to ignore the reconciliation. The WHOLE
-- account still feeds finance_intercompany_position() and the eliminations, which are about what the
-- two companies owe each other, not about AR.
--
-- Per bucket, not only in total, and that is the point: an invoice to a group client posted to the
-- control account leaves the TOTAL equal and both buckets wrong by the same amount, in opposite
-- directions. Only the split check sees it (the PV5-05 teeth test).
--
-- Worked example. Company A; customer O is ordinary; customer G is a group client with counterparty V.
--   1. Invoice O-1, 100 + 11 VAT         DR 1130 111              CR 4100 100, CR 2140 11
--   2. Invoice G-1, 222                  DR 1290-<V> 222          CR 4100 222
--   3. Receipt from G, 250               DR 1120 250              CR 1290-<V> 250
--      allocated 222 to G-1, 28 stays on account
--   4. Credit note to O, 11, unapplied   DR 4300 11               CR 1130 11
--   5. A manual recharge to V, 50        DR 1290-<V> 50           CR 4100 50      (not an AR document)
--   ordinary bucket:  open 111 - on account 0  - unapplied 11 = 100  =  1130: 111 - 11 = 100           OK
--   bucket V:         open 0   - on account 28 - unapplied 0  = -28  =  AR lines on 1290-<V>: 222 - 250 OK
--   finance_ar_position().net_receivable = 72 = 100 + (-28).
--   1290-<V>'s full balance is 22 (= -28 + 50). That is what finance_intercompany_position() reports
--   and what the eliminations remove, and it is not an AR mismatch.
-- If step 2 had debited 1130 instead: ordinary 100 vs 322 and bucket V -28 vs -250, two rows, each
-- off by 222 in opposite directions, while the totals (72 = 72) agree.
--
-- ── THE OTHER SIDE IS NOT WRITTEN ──────────────────────────────────────────────────────────────────
-- Only the issuing company's books move. The group client's mirror (its `2290-*` payable to us) is NOT
-- written here. That company has no books yet (PV-9), and writing into another tenant from inside this
-- one's posting is the cross-tenant write F9-04 refuses on purpose. Until PV-9, finance_intercompany_
-- mismatch() reports INTERCOMPANY_RECEIVABLE_MISMATCH for the pair, which is true, and an elimination
-- run refuses to net it. The mirror is booked by that company, in its own books, when it has some.
--
-- ── RLS / GRANTS ───────────────────────────────────────────────────────────────────────────────────
-- No policy, grant or table changes. Every function stays SECURITY INVOKER and RLS-bound, as before.
-- These are domain helpers, not scope resolvers. Ensuring the `1290-*` pair INSERTs into finance_accounts
-- under the caller's own finance scope, as finance_ensure_intercompany_accounts always has.
--
-- ── ROLLOUT ────────────────────────────────────────────────────────────────────────────────────────
-- Functions and one trigger; NO DML, so nothing here can be blind to RLS. Deploy order is free:
-- PV5-04 calls finance_ar_issue_invoice / finance_ar_record_receipt with unchanged signatures.
-- One live-data precondition: a customer that ALREADY has a counterparty AND posted documents from
-- before this migration has those documents on the control account, and the split check reports them
-- (loudly, as it should). PV5-01a added the column one day earlier and live had no AR invoices at seed
-- time, so none is expected. To check on live, under a finance scope:
--     SELECT c.tenant_id, c.code FROM finance_ar_customers c
--      WHERE c.counterparty_company_id IS NOT NULL
--        AND EXISTS (SELECT 1 FROM finance_ar_invoices i WHERE i.customer_id = c.id AND i.status <> 'draft');
-- Reverse: re-apply the bodies from 202608241019 (issue, receipt) and 202608270900 (credit note,
-- write-off, reconcile, position), then DROP the trigger, its function, finance_ar_position_by_receivable
-- and finance_ar_receivable_account. Do that before any group-client posting exists, or the old
-- reconciliation reports those postings as a control-account mismatch.

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 1 · finance_ar_receivable_account(customer) — the one place a customer's receivable is resolved
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_ar_receivable_account(p_customer uuid)
  RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid;
  v_cp     uuid;
  v_codes  text[];
  v_code   text;
BEGIN
  SELECT c.tenant_id, c.counterparty_company_id INTO v_tenant, v_cp
    FROM finance_ar_customers c WHERE c.id = p_customer;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'FINANCE_AR_UNKNOWN_CUSTOMER: no customer %', p_customer;
  END IF;

  IF v_cp IS NULL THEN
    -- Unchanged from F4: by role, never by code (ruling D-F5), and ORDERED, because an unordered
    -- LIMIT 1 picks a different row on another machine.
    SELECT a.code INTO v_code FROM finance_accounts a
     WHERE a.tenant_id = v_tenant AND a.is_control AND a.control_subledger = 'ar'
       AND a.deleted_at IS NULL AND a.status = 'active'
     ORDER BY a.code LIMIT 1;
    IF v_code IS NULL THEN
      RAISE EXCEPTION 'FINANCE_AR_NO_CONTROL_ACCOUNT: this company has no active AR control account'
        USING HINT = 'Mark the receivables account is_control with control_subledger = ''ar''.';
    END IF;
    RETURN v_code;
  END IF;

  -- A group client. The ensure is idempotent: it creates the tagged pair on the first posting and
  -- returns the same codes after. It refuses loudly on a code collision with another counterparty,
  -- and on a counterparty that is not a live company.
  SELECT array_agg(e.account_code) INTO v_codes
    FROM finance_ensure_intercompany_accounts(v_tenant, v_cp) e;

  -- ⚠ A SEPARATE STATEMENT, on purpose. Joining finance_accounts in the SAME statement as the ensure
  -- reads with that statement's snapshot, which predates the ensure's INSERT, so on the first posting
  -- to a new counterparty the receivable would be invisible and the lookup would come back empty.
  -- Picked out of the ensured codes by the tag and the type, not by a code prefix: the ensure owns
  -- the code scheme, and this must not re-derive it.
  SELECT a.code INTO v_code FROM finance_accounts a
   WHERE a.tenant_id = v_tenant AND a.code = ANY (v_codes)
     AND a.counterparty_company_id = v_cp AND a.account_type = 'asset'
     AND a.deleted_at IS NULL
   ORDER BY a.code LIMIT 1;
  IF v_code IS NULL THEN
    RAISE EXCEPTION 'FINANCE_AR_NO_INTERCOMPANY_RECEIVABLE: no receivable tagged with counterparty % in this company', v_cp
      USING HINT = 'finance_ensure_intercompany_accounts(company, counterparty) creates it.';
  END IF;
  -- An ARCHIVED receivable is returned as is: finance_post_journal then refuses it with
  -- FINANCE_ACCOUNT_ARCHIVED, which names the real problem. Falling back to the control account
  -- here would be the silent untagged posting this migration exists to remove.
  RETURN v_code;
END $$;
COMMENT ON FUNCTION finance_ar_receivable_account(uuid) IS
  'PV5-05: the receivable an AR customer''s documents post to. No counterparty: the AR control account '
  '(by role, ordered). A group client (counterparty_company_id set): this company''s 1290-* receivable '
  'tagged with that counterparty, ensured through finance_ensure_intercompany_accounts. Never falls back '
  'from one to the other.';

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 2 · The four posting paths. Bodies copied from their latest definition; only the receivable changes.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════

-- 2a · finance_ar_issue_invoice (202608241019 §4). DR the customer's receivable, CR revenue, CR VAT.
CREATE OR REPLACE FUNCTION finance_ar_issue_invoice(p_invoice uuid, p_actor uuid DEFAULT NULL)
  RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_inv     finance_ar_invoices%ROWTYPE;
  v_ar      text;
  v_vat     text;
  v_lines   jsonb;
  v_entry   uuid;
BEGIN
  SELECT * INTO v_inv FROM finance_ar_invoices WHERE id = p_invoice;
  IF v_inv.id IS NULL THEN
    RAISE EXCEPTION 'FINANCE_AR_UNKNOWN_INVOICE: no invoice %', p_invoice;
  END IF;
  IF v_inv.status <> 'draft' THEN
    RAISE EXCEPTION 'FINANCE_AR_ALREADY_ISSUED: invoice % is %', v_inv.invoice_no, v_inv.status;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM finance_ar_invoice_lines WHERE invoice_id = p_invoice) THEN
    RAISE EXCEPTION 'FINANCE_AR_EMPTY_INVOICE: invoice % has no lines', v_inv.invoice_no;
  END IF;

  -- PV5-05: the CUSTOMER's receivable. The AR control account for an ordinary customer (resolved by
  -- role, exactly as before), the counterparty's 1290-* for a group client.
  v_ar := finance_ar_receivable_account(v_inv.customer_id);

  IF v_inv.tax_total > 0 THEN
    SELECT code INTO v_vat FROM finance_accounts
     WHERE tenant_id = v_inv.tenant_id AND code = '2140' AND deleted_at IS NULL AND status = 'active';
    IF v_vat IS NULL THEN
      RAISE EXCEPTION 'FINANCE_AR_NO_VAT_ACCOUNT: invoice carries tax but no output VAT account (2140) exists';
    END IF;
  END IF;

  SELECT jsonb_build_array(jsonb_build_object(
           'account_code', v_ar, 'side', 'debit', 'amount', v_inv.total,
           'memo', 'Invoice ' || v_inv.invoice_no))
       || coalesce((
            SELECT jsonb_agg(jsonb_build_object(
                     'account_code', a.code, 'side', 'credit', 'amount', x.amt,
                     'memo', 'Invoice ' || v_inv.invoice_no))
              FROM (SELECT revenue_account_id, sum(line_subtotal) AS amt
                      FROM finance_ar_invoice_lines WHERE invoice_id = p_invoice
                     GROUP BY revenue_account_id) x
              JOIN finance_accounts a ON a.id = x.revenue_account_id), '[]'::jsonb)
       || CASE WHEN v_inv.tax_total > 0
               THEN jsonb_build_array(jsonb_build_object(
                      'account_code', v_vat, 'side', 'credit', 'amount', v_inv.tax_total,
                      'memo', 'Output VAT on ' || v_inv.invoice_no))
               ELSE '[]'::jsonb END
    INTO v_lines;

  v_entry := finance_post_journal(
    v_inv.tenant_id, v_inv.invoice_date,
    'ar-invoice:' || p_invoice::text,
    'AR invoice ' || v_inv.invoice_no,
    v_lines, p_actor, 'standard', NULL, v_inv.currency_code, NULL, NULL, 'ar');

  UPDATE finance_ar_invoices
     SET status = 'issued', journal_entry_id = v_entry, updated_at = now()
   WHERE id = p_invoice;

  RETURN v_entry;
END $$;

-- 2b · finance_ar_record_receipt (202608241019 §5). DR bank, CR the customer's receivable.
-- A receipt from a group client credits the same 1290-* its invoices debited, so a payment on account
-- sits as a credit on that account, exactly as an ordinary prepayment sits on the control account.
CREATE OR REPLACE FUNCTION finance_ar_record_receipt(p_receipt uuid, p_actor uuid DEFAULT NULL)
  RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_rec  finance_ar_receipts%ROWTYPE;
  v_ar   text;
  v_bank text;
  v_entry uuid;
BEGIN
  SELECT * INTO v_rec FROM finance_ar_receipts WHERE id = p_receipt;
  IF v_rec.id IS NULL THEN
    RAISE EXCEPTION 'FINANCE_AR_UNKNOWN_RECEIPT: no receipt %', p_receipt;
  END IF;
  IF v_rec.journal_entry_id IS NOT NULL THEN
    RETURN v_rec.journal_entry_id;   -- already posted; idempotent
  END IF;

  v_ar := finance_ar_receivable_account(v_rec.customer_id);
  SELECT code INTO v_bank FROM finance_accounts WHERE id = v_rec.bank_account_id;

  v_entry := finance_post_journal(
    v_rec.tenant_id, v_rec.receipt_date,
    'ar-receipt:' || p_receipt::text,
    'AR receipt ' || v_rec.receipt_no,
    jsonb_build_array(
      jsonb_build_object('account_code', v_bank, 'side', 'debit',  'amount', v_rec.amount,
                         'memo', 'Receipt ' || v_rec.receipt_no),
      jsonb_build_object('account_code', v_ar,   'side', 'credit', 'amount', v_rec.amount,
                         'memo', 'Receipt ' || v_rec.receipt_no)),
    p_actor, 'standard', NULL, v_rec.currency_code, NULL, NULL, 'ar');

  UPDATE finance_ar_receipts SET journal_entry_id = v_entry WHERE id = p_receipt;
  RETURN v_entry;
END $$;

-- 2c · finance_ar_issue_credit_note (202608270900 §6). DR contra-revenue, DR VAT, CR the receivable.
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

  v_ar := finance_ar_receivable_account(v_cn.customer_id);

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
  'Posts a credit note: DR contra-revenue + DR output VAT, CR the customer''s receivable (the AR control '
  'account, or a group client''s tagged 1290-*: PV5-05). The VAT debit is the difference from a '
  'write-off. Application to specific invoices is a separate, subledger-only act.';

-- 2d · finance_ar_write_off (202608270900 §8). DR bad-debt expense or allowance, CR the receivable.
-- The receivable is the INVOICE's customer's: a write-off is always against one invoice.
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

  v_ar := finance_ar_receivable_account(v_inv.customer_id);

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
  'finance_company_settings.bad_debt_method, CR the invoice customer''s receivable (AR control, or a '
  'group client''s tagged 1290-*: PV5-05). Posts NO VAT line -- Indonesian PPN is not recoverable on '
  'a bad debt, and reversing it here would understate tax payable.';

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 3 · finance_ar_position_by_receivable() — the identity, one row per bucket
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- Row with counterparty_company_id NULL: the ordinary customers against the AR control account(s).
-- Always present, so a company with no AR activity still reports one row of zeros.
-- One row per counterparty that has either a document from a customer tagged with it, or an AR-posted
-- line on a receivable tagged with it. Both sides are grouped independently and then joined, so a
-- posting on the WRONG bucket's account shows up as a row on each side, never as a silent net.
CREATE OR REPLACE FUNCTION finance_ar_position_by_receivable(p_company uuid, p_as_of date DEFAULT NULL)
  RETURNS TABLE (counterparty_company_id uuid, receivable_accounts text,
                 open_invoices numeric, payments_on_account numeric, unapplied_credits numeric,
                 net_receivable numeric, gl_balance numeric)
  LANGUAGE sql STABLE AS $$
  WITH asof AS (SELECT coalesce(p_as_of, CURRENT_DATE) AS d),
  -- ── The subledger, by the CUSTOMER's tag ──
  inv AS (
    SELECT c.counterparty_company_id AS cp,
           sum(i.total - i.amount_paid - i.amount_credited - i.amount_written_off) AS v
      FROM finance_ar_invoices i
      JOIN finance_ar_customers c ON c.id = i.customer_id AND c.tenant_id = i.tenant_id
     WHERE i.tenant_id = p_company AND i.status IN ('issued','paid')
       AND i.invoice_date <= (SELECT d FROM asof)
     GROUP BY c.counterparty_company_id
  ),
  oa AS (
    SELECT c.counterparty_company_id AS cp, sum(r.amount - r.amount_allocated) AS v
      FROM finance_ar_receipts r
      JOIN finance_ar_customers c ON c.id = r.customer_id AND c.tenant_id = r.tenant_id
     WHERE r.tenant_id = p_company AND r.journal_entry_id IS NOT NULL
       AND r.receipt_date <= (SELECT d FROM asof)
     GROUP BY c.counterparty_company_id
  ),
  uc AS (
    SELECT c.counterparty_company_id AS cp, sum(n.total - n.amount_applied) AS v
      FROM finance_ar_credit_notes n
      JOIN finance_ar_customers c ON c.id = n.customer_id AND c.tenant_id = n.tenant_id
     WHERE n.tenant_id = p_company AND n.status IN ('issued','applied')
       AND n.credit_note_date <= (SELECT d FROM asof)
     GROUP BY c.counterparty_company_id
  ),
  -- ── The GL, by the ACCOUNT's tag ──
  -- Ordinary bucket: the whole AR control balance, exactly as F4 compared it. A control account is
  -- barred to manual journals, so everything on it is AR's.
  ctl AS (
    SELECT coalesce(sum(m.balance), 0) AS v, string_agg(m.code, ',' ORDER BY m.code) AS codes
      FROM finance_account_movement(p_company, NULL, (SELECT d FROM asof)) m
      JOIN finance_accounts a ON a.id = m.account_id
     WHERE a.is_control AND a.control_subledger = 'ar'
  ),
  -- Journals an AR document posted, and their reversals. Reversals stay in: a reversed AR journal
  -- nets to zero on the account, and the document's own status (void) takes it out of the subledger.
  -- Reversing without voiding then shows as a mismatch, exactly as it does on the control account.
  ar_entries AS (
    SELECT journal_entry_id AS id FROM finance_ar_invoices
     WHERE tenant_id = p_company AND journal_entry_id IS NOT NULL
    UNION SELECT journal_entry_id FROM finance_ar_receipts
     WHERE tenant_id = p_company AND journal_entry_id IS NOT NULL
    UNION SELECT journal_entry_id FROM finance_ar_credit_notes
     WHERE tenant_id = p_company AND journal_entry_id IS NOT NULL
    UNION SELECT journal_entry_id FROM finance_ar_writeoffs
     WHERE tenant_id = p_company AND journal_entry_id IS NOT NULL
  ),
  ar_journals AS (
    SELECT id FROM ar_entries
    UNION
    SELECT e.id FROM finance_journal_entries e
     WHERE e.tenant_id = p_company AND e.reversal_of_id IN (SELECT id FROM ar_entries)
  ),
  -- Counterparty buckets: only the AR-posted lines on tagged RECEIVABLES (asset accounts). Not the
  -- whole account (manual intercompany journals are not AR's; see the header), and not other tagged
  -- accounts (a group invoice may credit a tagged intercompany REVENUE account, which is not a
  -- receivable). Signed by normal_balance, as finance_account_movement signs a balance.
  tagged AS (
    SELECT a.counterparty_company_id AS cp,
           sum(CASE WHEN (l.side = 'debit') = (a.normal_balance = 'debit') THEN l.amount ELSE -l.amount END) AS v,
           string_agg(DISTINCT a.code, ',') AS codes
      FROM finance_journal_lines l
      JOIN finance_journal_entries e ON e.id = l.entry_id
      JOIN finance_accounts a ON a.id = l.account_id
     WHERE l.tenant_id = p_company
       AND l.entry_id IN (SELECT id FROM ar_journals)
       AND e.entry_date <= (SELECT d FROM asof)
       AND a.counterparty_company_id IS NOT NULL
       AND a.account_type = 'asset'
       -- never count one account in two buckets
       AND NOT (a.is_control AND a.control_subledger IS NOT DISTINCT FROM 'ar')
     GROUP BY a.counterparty_company_id
  ),
  buckets AS (
    SELECT NULL::uuid AS cp
    UNION SELECT cp FROM inv WHERE cp IS NOT NULL
    UNION SELECT cp FROM oa  WHERE cp IS NOT NULL
    UNION SELECT cp FROM uc  WHERE cp IS NOT NULL
    UNION SELECT cp FROM tagged
  )
  SELECT b.cp,
         CASE WHEN b.cp IS NULL THEN ctl.codes ELSE t.codes END,
         coalesce(inv.v, 0), coalesce(oa.v, 0), coalesce(uc.v, 0),
         coalesce(inv.v, 0) - coalesce(oa.v, 0) - coalesce(uc.v, 0),
         CASE WHEN b.cp IS NULL THEN ctl.v ELSE coalesce(t.v, 0) END
    FROM buckets b
    CROSS JOIN ctl
    LEFT JOIN inv    ON inv.cp IS NOT DISTINCT FROM b.cp
    LEFT JOIN oa     ON oa.cp  IS NOT DISTINCT FROM b.cp
    LEFT JOIN uc     ON uc.cp  IS NOT DISTINCT FROM b.cp
    LEFT JOIN tagged t ON t.cp = b.cp
   ORDER BY b.cp NULLS FIRST
$$;
COMMENT ON FUNCTION finance_ar_position_by_receivable(uuid,date) IS
  'PV5-05: the AR identity per receivable bucket. NULL counterparty = ordinary customers vs the AR '
  'control account; one row per counterparty = customers tagged with it vs the AR-posted lines on '
  'receivables tagged with it. net_receivable = open_invoices - payments_on_account - '
  'unapplied_credits must equal gl_balance on every row; finance_ar_reconcile reports each row that '
  'does not.';

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 4 · finance_ar_reconcile and finance_ar_position, re-created over the buckets
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- reconcile: the ordinary bucket keeps the F4 problem name and message, so a company with no group
-- client sees exactly what it saw before. Each counterparty bucket gets its own problem name. The cache
-- drift and allowance checks are copied verbatim from 202608270900.
CREATE OR REPLACE FUNCTION finance_ar_reconcile(p_company uuid, p_as_of date DEFAULT NULL)
  RETURNS TABLE (problem text, detail text)
  LANGUAGE sql STABLE AS $$
  WITH asof AS (SELECT coalesce(p_as_of, CURRENT_DATE) AS d),
  b AS (SELECT * FROM finance_ar_position_by_receivable(p_company, p_as_of))
  SELECT 'AR_SUBLEDGER_GL_MISMATCH',
         'AR subledger net (open invoices ' || b.open_invoices::text ||
         ' less payments on account ' || b.payments_on_account::text ||
         ' less unapplied credit notes ' || b.unapplied_credits::text || ' = ' ||
         b.net_receivable::text ||
         ') <> AR control account balance ' || b.gl_balance::text ||
         ' (difference ' || (b.net_receivable - b.gl_balance)::text || ')'
    FROM b
   WHERE b.counterparty_company_id IS NULL AND b.net_receivable <> b.gl_balance
  UNION ALL
  SELECT 'AR_INTERCOMPANY_SUBLEDGER_GL_MISMATCH',
         'counterparty ' || b.counterparty_company_id::text ||
         ' (receivable ' || coalesce(b.receivable_accounts, 'none posted') || '): AR subledger net (open invoices ' ||
         b.open_invoices::text ||
         ' less payments on account ' || b.payments_on_account::text ||
         ' less unapplied credit notes ' || b.unapplied_credits::text || ' = ' ||
         b.net_receivable::text ||
         ') <> AR postings on the tagged receivable ' || b.gl_balance::text ||
         ' (difference ' || (b.net_receivable - b.gl_balance)::text || ')'
    FROM b
   WHERE b.counterparty_company_id IS NOT NULL AND b.net_receivable <> b.gl_balance
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
  'repairs. PV5-05: the identity open invoices - payments on account - unapplied credit notes = GL '
  'holds per receivable bucket: ordinary customers vs the AR control account (AR_SUBLEDGER_GL_MISMATCH), '
  'and each counterparty''s customers vs the AR-posted lines on its tagged 1290-* receivable '
  '(AR_INTERCOMPANY_SUBLEDGER_GL_MISMATCH). See finance_ar_position_by_receivable.';

-- position: same OUT columns, so CREATE OR REPLACE is allowed (no DROP, no caller breaks). Summed from
-- the buckets, so position and reconcile cannot compute the identity two different ways. The totals
-- are the same numbers as before: every customer, ordinary or group.
CREATE OR REPLACE FUNCTION finance_ar_position(p_company uuid, p_as_of date DEFAULT NULL)
  RETURNS TABLE (open_invoices numeric, payments_on_account numeric,
                 unapplied_credits numeric, net_receivable numeric)
  LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(b.open_invoices), 0), coalesce(sum(b.payments_on_account), 0),
         coalesce(sum(b.unapplied_credits), 0), coalesce(sum(b.net_receivable), 0)
    FROM finance_ar_position_by_receivable(p_company, p_as_of) b
$$;
COMMENT ON FUNCTION finance_ar_position(uuid,date) IS
  'open invoices - payments on account - unapplied credit notes = net receivable, which is what the '
  'AR control account PLUS the AR-posted part of the tagged 1290-* receivables holds (PV5-05; per '
  'bucket in finance_ar_position_by_receivable). The aging report shows the FIRST number only; neither '
  'a prepayment nor an unapplied credit is a negative invoice.';

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 5 · A customer's counterparty is frozen once the customer has posted anything
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- The buckets classify the SUBLEDGER by the customer's tag and the GL by the account's tag. Retagging
-- a customer after it has posted moves its history into another bucket on one side only, and every
-- later reconciliation reports a mismatch that no posting caused. So the tag is set before the first
-- posting (PV5-04 sets it when it creates the customer) and is then fixed. A customer billed through
-- the wrong bucket is corrected the way a ledger corrects anything: credit note on the old customer,
-- a new customer with the right tag, re-issue.
-- Written for THIS table only (plpgsql resolves OLD/NEW against the triggering table).
CREATE OR REPLACE FUNCTION finance_ar_customers_counterparty_frozen()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.counterparty_company_id IS DISTINCT FROM OLD.counterparty_company_id
     AND (EXISTS (SELECT 1 FROM finance_ar_invoices i
                   WHERE i.customer_id = OLD.id AND i.journal_entry_id IS NOT NULL)
       OR EXISTS (SELECT 1 FROM finance_ar_receipts r
                   WHERE r.customer_id = OLD.id AND r.journal_entry_id IS NOT NULL)
       OR EXISTS (SELECT 1 FROM finance_ar_credit_notes n
                   WHERE n.customer_id = OLD.id AND n.journal_entry_id IS NOT NULL)
       OR EXISTS (SELECT 1 FROM finance_ar_writeoffs w WHERE w.customer_id = OLD.id)) THEN
    RAISE EXCEPTION
      'FINANCE_AR_COUNTERPARTY_FROZEN: customer % has posted documents; its counterparty cannot change', OLD.code
      USING HINT = 'Credit the old customer''s invoices and bill a new customer with the right counterparty.';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_finance_ar_customers_counterparty_frozen ON finance_ar_customers;
CREATE TRIGGER trg_finance_ar_customers_counterparty_frozen
  BEFORE UPDATE OF counterparty_company_id ON finance_ar_customers
  FOR EACH ROW EXECUTE FUNCTION finance_ar_customers_counterparty_frozen();
