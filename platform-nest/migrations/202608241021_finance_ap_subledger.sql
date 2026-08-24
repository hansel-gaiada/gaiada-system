-- Finance F5 — ACCOUNTS PAYABLE. The mirror of F4, plus withholding tax.
--
-- Design: docs/blueprints/finance-accounting-foundation.md §2.1 (P2P), §3.2, §3.6.
-- Builds on F1 (ledger), F3 (statements) and F4 (whose reconciliation identity is reused verbatim).
--
-- ── THE INVARIANT, REUSED RATHER THAN RE-DERIVED ────────────────────────────────────────────────
--     SUM(open bills) - SUM(payments on account)  ==  AP control account balance in the GL
--
-- Identical in shape to F4's, INCLUDING the second term, which F4's test suite had to teach us: a
-- payment debits AP the moment money leaves, before anyone allocates it to a bill, so a prepaid or
-- overpaid vendor leaves a debit sitting in the payables control account. The naive identity
-- reports a mismatch on every prepayment and trains people to ignore the reconciliation.
-- `finance_ap_position()` exposes all three numbers so no caller re-derives it.
--
-- ── WHAT AP HAS THAT AR DOES NOT: WITHHOLDING TAX ───────────────────────────────────────────────
-- Blueprint §3.6: PPh 23 is 2% on most domestic services, PPh 4(2) is final tax on rent. The
-- mechanism is that the PAYER withholds it and remits it to DJP. So on a 100m services bill:
--
--     the expense is                    100m
--     the vendor is owed                 98m
--     DJP is owed                         2m
--
-- Both liabilities are real, they have different creditors, and they fall due on different dates
-- (the vendor on payment terms, DJP by the 10th of the following month). Modelling this as "pay the
-- vendor 98m" without booking the 2m liability understates payables and hides a statutory debt —
-- and it is the single most common way an Indonesian AP ledger is wrong.
--
-- **The withholding is booked AT BILL APPROVAL, not at payment.** Two reasons: the liability to DJP
-- arises when the expense is recognised, and it keeps `finance_ap_bills.amount_payable` equal to
-- what the vendor is actually owed — which is what the aging must show. An aging that lists the
-- gross bill overstates what the company will pay out.
--
-- ── 3-WAY MATCHING IS NOT HERE, AND CANNOT BE ───────────────────────────────────────────────────
-- Matching a bill against a purchase order and a goods receipt requires a PO and a GRN. Neither
-- exists — there is no procurement module in this estate. A "match" against documents that do not
-- exist would be theatre. It is a dependency, recorded as one.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) finance_ap_vendors
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE finance_ap_vendors (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  code          text NOT NULL,
  name          text NOT NULL,
  -- NPWP is LOAD-BEARING for AP, not decorative: a vendor without one is withheld at a PENALTY
  -- rate (100% higher for PPh 23 under Indonesian rules), so its absence changes the arithmetic
  -- rather than merely leaving a field blank.
  npwp          text,
  is_pkp        boolean,
  -- Default withholding treatment for this vendor. Overridable per bill, because one vendor can
  -- invoice both services (PPh 23) and rent (PPh 4(2) final).
  default_withholding_code text,
  default_withholding_rate numeric(9,6) CHECK (default_withholding_rate IS NULL
                             OR (default_withholding_rate >= 0 AND default_withholding_rate <= 100)),
  payment_terms_days integer NOT NULL DEFAULT 30 CHECK (payment_terms_days >= 0),
  bank_account_name  text,
  bank_account_no    text,
  email         text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  origin_site   text NOT NULL DEFAULT 'central',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CONSTRAINT ux_finance_ap_vendors_id_tenant UNIQUE (id, tenant_id)
);
CREATE UNIQUE INDEX ux_finance_ap_vendors_code_live
  ON finance_ap_vendors (tenant_id, code) WHERE deleted_at IS NULL;

COMMENT ON COLUMN finance_ap_vendors.npwp IS
  'Load-bearing, not decorative: a vendor with no NPWP is withheld at a penalty rate under '
  'Indonesian PPh 23 rules, so its absence changes the arithmetic rather than leaving a blank field.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) finance_ap_bills + lines.
--
-- Three money columns that are deliberately distinct:
--   total            what the vendor billed, including input VAT
--   withholding_amount   what is withheld and owed to DJP instead of the vendor
--   amount_payable   total - withholding_amount = what the vendor is actually owed
--
-- `amount_payable` is what the AP control account carries and what the aging shows. Collapsing
-- these into one number is how a payables figure ends up overstating the cash that will leave.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE finance_ap_bills (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES companies(id),
  vendor_id      uuid NOT NULL,
  bill_no        text NOT NULL,              -- the VENDOR's invoice number
  bill_date      date NOT NULL,
  due_date       date NOT NULL,
  currency_code  text NOT NULL REFERENCES finance_currencies(code),

  subtotal       numeric(20,4) NOT NULL CHECK (subtotal >= 0),
  tax_total      numeric(20,4) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),   -- input VAT (PPN Masukan)
  total          numeric(20,4) NOT NULL CHECK (total > 0),

  withholding_code   text,
  withholding_rate   numeric(9,6) CHECK (withholding_rate IS NULL
                       OR (withholding_rate >= 0 AND withholding_rate <= 100)),
  withholding_amount numeric(20,4) NOT NULL DEFAULT 0 CHECK (withholding_amount >= 0),
  -- Which liability account the withheld tax lands in (Utang PPh 21 / 23 / 4(2)). Set only when
  -- there is withholding.
  withholding_account_id uuid,

  amount_payable numeric(20,4) NOT NULL CHECK (amount_payable >= 0),
  amount_paid    numeric(20,4) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),

  -- draft    -> not in the books; editable
  -- approved -> POSTED; the company owes the vendor and owes DJP the withholding
  -- paid     -> fully allocated
  -- void     -> approved then reversed; stays visible
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','paid','void')),
  journal_entry_id uuid,
  -- The vendor's e-Faktur number, needed to CREDIT the input VAT. Blueprint §3.6: no valid
  -- e-Faktur means the input VAT is not creditable — so this field's absence has a money
  -- consequence, which is why it lives on the bill rather than in a note.
  efaktur_no     text,
  notes          text,
  origin_site    text NOT NULL DEFAULT 'central',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_finance_ap_bills_vendor
    FOREIGN KEY (vendor_id, tenant_id) REFERENCES finance_ap_vendors (id, tenant_id),
  CONSTRAINT fk_finance_ap_bills_journal
    FOREIGN KEY (journal_entry_id, tenant_id) REFERENCES finance_journal_entries (id, tenant_id),
  CONSTRAINT fk_finance_ap_bills_wht_account
    FOREIGN KEY (withholding_account_id, tenant_id) REFERENCES finance_accounts (id, tenant_id),
  CONSTRAINT ux_finance_ap_bills_no UNIQUE (tenant_id, vendor_id, bill_no),
  CONSTRAINT ux_finance_ap_bills_id_tenant UNIQUE (id, tenant_id),
  CONSTRAINT ck_finance_ap_bills_total CHECK (total = subtotal + tax_total),
  CONSTRAINT ck_finance_ap_bills_payable CHECK (amount_payable = total - withholding_amount),
  CONSTRAINT ck_finance_ap_bills_due CHECK (due_date >= bill_date),
  CONSTRAINT ck_finance_ap_bills_paid CHECK (amount_paid <= amount_payable),
  -- Withholding is a triple or nothing: an amount with no account has nowhere to post, and an
  -- account with no amount is a mis-set field.
  CONSTRAINT ck_finance_ap_bills_wht CHECK (
    (withholding_amount = 0 AND withholding_account_id IS NULL)
    OR (withholding_amount > 0 AND withholding_account_id IS NOT NULL)
  ),
  CONSTRAINT ck_finance_ap_bills_journal CHECK ((status = 'draft') = (journal_entry_id IS NULL))
);
CREATE INDEX ix_finance_ap_bills_vendor ON finance_ap_bills (tenant_id, vendor_id);
CREATE INDEX ix_finance_ap_bills_open
  ON finance_ap_bills (tenant_id, due_date) WHERE status IN ('approved','paid');

CREATE TABLE finance_ap_bill_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  bill_id       uuid NOT NULL,
  line_no       integer NOT NULL CHECK (line_no > 0),
  description   text NOT NULL,
  quantity      numeric(20,4) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price    numeric(20,4) NOT NULL CHECK (unit_price >= 0),
  line_subtotal numeric(20,4) NOT NULL CHECK (line_subtotal >= 0),
  -- The expense or asset account this line debits. Per line, because one bill legitimately spans
  -- rent and utilities.
  expense_account_id uuid NOT NULL,
  tax_code      text,
  tax_rate      numeric(9,6) CHECK (tax_rate IS NULL OR (tax_rate >= 0 AND tax_rate <= 100)),
  tax_amount    numeric(20,4) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  CONSTRAINT fk_finance_ap_bill_lines_bill
    FOREIGN KEY (bill_id, tenant_id) REFERENCES finance_ap_bills (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT fk_finance_ap_bill_lines_expense
    FOREIGN KEY (expense_account_id, tenant_id) REFERENCES finance_accounts (id, tenant_id),
  CONSTRAINT ux_finance_ap_bill_lines_no UNIQUE (bill_id, line_no),
  CONSTRAINT ux_finance_ap_bill_lines_id_tenant UNIQUE (id, tenant_id)
);
CREATE INDEX ix_finance_ap_bill_lines_bill ON finance_ap_bill_lines (bill_id, line_no);

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (3) Payments and allocations. Mirrors F4's receipts exactly.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE finance_ap_payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES companies(id),
  vendor_id      uuid NOT NULL,
  payment_no     text NOT NULL,
  payment_date   date NOT NULL,
  currency_code  text NOT NULL REFERENCES finance_currencies(code),
  amount         numeric(20,4) NOT NULL CHECK (amount > 0),
  amount_allocated numeric(20,4) NOT NULL DEFAULT 0 CHECK (amount_allocated >= 0),
  bank_account_id uuid NOT NULL,
  journal_entry_id uuid,
  reference      text,
  origin_site    text NOT NULL DEFAULT 'central',
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_finance_ap_payments_vendor
    FOREIGN KEY (vendor_id, tenant_id) REFERENCES finance_ap_vendors (id, tenant_id),
  CONSTRAINT fk_finance_ap_payments_bank
    FOREIGN KEY (bank_account_id, tenant_id) REFERENCES finance_accounts (id, tenant_id),
  CONSTRAINT fk_finance_ap_payments_journal
    FOREIGN KEY (journal_entry_id, tenant_id) REFERENCES finance_journal_entries (id, tenant_id),
  CONSTRAINT ux_finance_ap_payments_no UNIQUE (tenant_id, payment_no),
  CONSTRAINT ux_finance_ap_payments_id_tenant UNIQUE (id, tenant_id),
  CONSTRAINT ck_finance_ap_payments_allocated CHECK (amount_allocated <= amount)
);
CREATE INDEX ix_finance_ap_payments_vendor ON finance_ap_payments (tenant_id, vendor_id);

CREATE TABLE finance_ap_allocations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES companies(id),
  payment_id  uuid NOT NULL,
  bill_id     uuid NOT NULL,
  amount      numeric(20,4) NOT NULL CHECK (amount > 0),
  allocated_at timestamptz NOT NULL DEFAULT now(),
  allocated_by uuid REFERENCES users(id),
  CONSTRAINT fk_finance_ap_allocations_payment
    FOREIGN KEY (payment_id, tenant_id) REFERENCES finance_ap_payments (id, tenant_id),
  CONSTRAINT fk_finance_ap_allocations_bill
    FOREIGN KEY (bill_id, tenant_id) REFERENCES finance_ap_bills (id, tenant_id),
  CONSTRAINT ux_finance_ap_allocations_pair UNIQUE (payment_id, bill_id)
);
CREATE INDEX ix_finance_ap_allocations_bill ON finance_ap_allocations (bill_id);

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (4) finance_ap_approve_bill() — the bill enters the books.
--
--   DR  expense / asset accounts     per line (net)
--   DR  PPN Masukan (input VAT)      tax total, if any
--   CR  AP control                   amount_payable  (what the VENDOR is owed)
--   CR  Utang PPh xx                 withholding     (what DJP is owed)
--
-- The two credits are the whole point. They are different creditors with different due dates, and
-- an AP ledger that books only the first understates the company's obligations.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_ap_approve_bill(p_bill uuid, p_actor uuid DEFAULT NULL)
  RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_bill  finance_ap_bills%ROWTYPE;
  v_ap    text;
  v_vat   text;
  v_wht   text;
  v_lines jsonb;
  v_entry uuid;
BEGIN
  SELECT * INTO v_bill FROM finance_ap_bills WHERE id = p_bill;
  IF v_bill.id IS NULL THEN
    RAISE EXCEPTION 'FINANCE_AP_UNKNOWN_BILL: no bill %', p_bill;
  END IF;
  IF v_bill.status <> 'draft' THEN
    RAISE EXCEPTION 'FINANCE_AP_ALREADY_APPROVED: bill % is %', v_bill.bill_no, v_bill.status;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM finance_ap_bill_lines WHERE bill_id = p_bill) THEN
    RAISE EXCEPTION 'FINANCE_AP_EMPTY_BILL: bill % has no lines', v_bill.bill_no;
  END IF;

  SELECT code INTO v_ap FROM finance_accounts
   WHERE tenant_id = v_bill.tenant_id AND is_control AND control_subledger = 'ap'
     AND deleted_at IS NULL AND status = 'active' ORDER BY code LIMIT 1;
  IF v_ap IS NULL THEN
    RAISE EXCEPTION 'FINANCE_AP_NO_CONTROL_ACCOUNT: this company has no active AP control account'
      USING HINT = 'Mark the payables account is_control with control_subledger = ''ap''.';
  END IF;

  IF v_bill.tax_total > 0 THEN
    SELECT code INTO v_vat FROM finance_accounts
     WHERE tenant_id = v_bill.tenant_id AND code = '1170' AND deleted_at IS NULL AND status = 'active';
    IF v_vat IS NULL THEN
      RAISE EXCEPTION 'FINANCE_AP_NO_INPUT_VAT_ACCOUNT: bill carries VAT but no input VAT account (1170) exists';
    END IF;
  END IF;
  IF v_bill.withholding_amount > 0 THEN
    SELECT code INTO v_wht FROM finance_accounts WHERE id = v_bill.withholding_account_id;
  END IF;

  SELECT coalesce((
           SELECT jsonb_agg(jsonb_build_object(
                    'account_code', a.code, 'side', 'debit', 'amount', x.amt,
                    'memo', 'Bill ' || v_bill.bill_no))
             FROM (SELECT expense_account_id, sum(line_subtotal) AS amt
                     FROM finance_ap_bill_lines WHERE bill_id = p_bill
                    GROUP BY expense_account_id) x
             JOIN finance_accounts a ON a.id = x.expense_account_id), '[]'::jsonb)
       || CASE WHEN v_bill.tax_total > 0
               THEN jsonb_build_array(jsonb_build_object('account_code', v_vat, 'side', 'debit',
                      'amount', v_bill.tax_total, 'memo', 'Input VAT on ' || v_bill.bill_no))
               ELSE '[]'::jsonb END
       || jsonb_build_array(jsonb_build_object('account_code', v_ap, 'side', 'credit',
              'amount', v_bill.amount_payable, 'memo', 'Bill ' || v_bill.bill_no))
       || CASE WHEN v_bill.withholding_amount > 0
               THEN jsonb_build_array(jsonb_build_object('account_code', v_wht, 'side', 'credit',
                      'amount', v_bill.withholding_amount,
                      'memo', coalesce(v_bill.withholding_code,'WHT') || ' withheld on ' || v_bill.bill_no))
               ELSE '[]'::jsonb END
    INTO v_lines;

  v_entry := finance_post_journal(
    v_bill.tenant_id, v_bill.bill_date,
    'ap-bill:' || p_bill::text,
    'AP bill ' || v_bill.bill_no,
    v_lines, p_actor, 'standard', NULL, v_bill.currency_code, NULL, NULL, 'ap');

  UPDATE finance_ap_bills
     SET status = 'approved', journal_entry_id = v_entry, updated_at = now()
   WHERE id = p_bill;
  RETURN v_entry;
END $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (5) Payment and allocation. DR AP control / CR bank, posted when the money leaves.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_ap_record_payment(p_payment uuid, p_actor uuid DEFAULT NULL)
  RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_pay  finance_ap_payments%ROWTYPE;
  v_ap   text;
  v_bank text;
  v_entry uuid;
BEGIN
  SELECT * INTO v_pay FROM finance_ap_payments WHERE id = p_payment;
  IF v_pay.id IS NULL THEN
    RAISE EXCEPTION 'FINANCE_AP_UNKNOWN_PAYMENT: no payment %', p_payment;
  END IF;
  IF v_pay.journal_entry_id IS NOT NULL THEN
    RETURN v_pay.journal_entry_id;
  END IF;

  SELECT code INTO v_ap FROM finance_accounts
   WHERE tenant_id = v_pay.tenant_id AND is_control AND control_subledger = 'ap'
     AND deleted_at IS NULL AND status = 'active' ORDER BY code LIMIT 1;
  SELECT code INTO v_bank FROM finance_accounts WHERE id = v_pay.bank_account_id;

  v_entry := finance_post_journal(
    v_pay.tenant_id, v_pay.payment_date,
    'ap-payment:' || p_payment::text,
    'AP payment ' || v_pay.payment_no,
    jsonb_build_array(
      jsonb_build_object('account_code', v_ap,   'side', 'debit',  'amount', v_pay.amount,
                         'memo', 'Payment ' || v_pay.payment_no),
      jsonb_build_object('account_code', v_bank, 'side', 'credit', 'amount', v_pay.amount,
                         'memo', 'Payment ' || v_pay.payment_no)),
    p_actor, 'standard', NULL, v_pay.currency_code, NULL, NULL, 'ap');

  UPDATE finance_ap_payments SET journal_entry_id = v_entry WHERE id = p_payment;
  RETURN v_entry;
END $$;

CREATE OR REPLACE FUNCTION finance_ap_allocate(
  p_payment uuid, p_bill uuid, p_amount numeric, p_actor uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_pay  finance_ap_payments%ROWTYPE;
  v_bill finance_ap_bills%ROWTYPE;
BEGIN
  SELECT * INTO v_pay  FROM finance_ap_payments WHERE id = p_payment;
  SELECT * INTO v_bill FROM finance_ap_bills    WHERE id = p_bill;
  IF v_pay.id IS NULL OR v_bill.id IS NULL THEN
    RAISE EXCEPTION 'FINANCE_AP_UNKNOWN_ALLOCATION_TARGET';
  END IF;
  IF v_pay.tenant_id <> v_bill.tenant_id THEN
    RAISE EXCEPTION 'FINANCE_AP_CROSS_COMPANY: payment and bill belong to different companies';
  END IF;
  IF v_pay.vendor_id <> v_bill.vendor_id THEN
    RAISE EXCEPTION 'FINANCE_AP_VENDOR_MISMATCH: a payment may only settle its own vendor''s bills';
  END IF;
  IF v_bill.status = 'draft' THEN
    RAISE EXCEPTION 'FINANCE_AP_NOT_APPROVED: bill % is still a draft', v_bill.bill_no;
  END IF;
  IF v_bill.status = 'void' THEN
    RAISE EXCEPTION 'FINANCE_AP_VOID_BILL: bill % has been voided', v_bill.bill_no;
  END IF;
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'FINANCE_AP_BAD_ALLOCATION: amount must be > 0';
  END IF;
  IF p_amount > v_pay.amount - v_pay.amount_allocated THEN
    RAISE EXCEPTION 'FINANCE_AP_OVER_ALLOCATED: payment % has only % unallocated',
      v_pay.payment_no, v_pay.amount - v_pay.amount_allocated;
  END IF;
  -- Against amount_payable, NOT total: the withheld tax is owed to DJP and was never the vendor's
  -- to be paid. Allocating against the gross bill would let a payment "overpay" by the withholding.
  IF p_amount > v_bill.amount_payable - v_bill.amount_paid THEN
    RAISE EXCEPTION 'FINANCE_AP_OVERPAYMENT: bill % has only % payable outstanding',
      v_bill.bill_no, v_bill.amount_payable - v_bill.amount_paid
      USING HINT = 'Withheld tax is owed to the tax office, not to the vendor.';
  END IF;

  INSERT INTO finance_ap_allocations (tenant_id, payment_id, bill_id, amount, allocated_by)
  VALUES (v_pay.tenant_id, p_payment, p_bill, p_amount, p_actor);

  UPDATE finance_ap_payments SET amount_allocated = amount_allocated + p_amount WHERE id = p_payment;
  UPDATE finance_ap_bills
     SET amount_paid = amount_paid + p_amount,
         status = CASE WHEN amount_paid + p_amount >= amount_payable THEN 'paid' ELSE status END,
         updated_at = now()
   WHERE id = p_bill;
END $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (6) Aging, position and reconciliation — the F4 shapes, mirrored.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_ap_aging(p_company uuid, p_as_of date DEFAULT NULL)
  RETURNS TABLE (
    vendor_code text, vendor_name text,
    current_amt numeric, d1_30 numeric, d31_60 numeric, d61_90 numeric, d90_plus numeric,
    total_outstanding numeric
  ) LANGUAGE sql STABLE AS $$
  WITH asof AS (SELECT coalesce(p_as_of, CURRENT_DATE) AS d),
  open_bill AS (
    SELECT b.vendor_id, (b.amount_payable - b.amount_paid) AS outstanding,
           ((SELECT d FROM asof) - b.due_date) AS days_overdue
      FROM finance_ap_bills b
     WHERE b.tenant_id = p_company AND b.status IN ('approved','paid')
       AND b.amount_payable > b.amount_paid
       AND b.bill_date <= (SELECT d FROM asof)
  )
  SELECT v.code, v.name,
         coalesce(sum(o.outstanding) FILTER (WHERE o.days_overdue <= 0), 0),
         coalesce(sum(o.outstanding) FILTER (WHERE o.days_overdue BETWEEN 1 AND 30), 0),
         coalesce(sum(o.outstanding) FILTER (WHERE o.days_overdue BETWEEN 31 AND 60), 0),
         coalesce(sum(o.outstanding) FILTER (WHERE o.days_overdue BETWEEN 61 AND 90), 0),
         coalesce(sum(o.outstanding) FILTER (WHERE o.days_overdue > 90), 0),
         coalesce(sum(o.outstanding), 0)
    FROM open_bill o
    JOIN finance_ap_vendors v ON v.id = o.vendor_id
   GROUP BY v.code, v.name
  HAVING sum(o.outstanding) <> 0
   ORDER BY v.code
$$;

CREATE OR REPLACE FUNCTION finance_ap_position(p_company uuid, p_as_of date DEFAULT NULL)
  RETURNS TABLE (open_bills numeric, payments_on_account numeric, net_payable numeric)
  LANGUAGE sql STABLE AS $$
  WITH asof AS (SELECT coalesce(p_as_of, CURRENT_DATE) AS d),
  b AS (
    SELECT coalesce(sum(x.amount_payable - x.amount_paid), 0) AS v FROM finance_ap_bills x
     WHERE x.tenant_id = p_company AND x.status IN ('approved','paid')
       AND x.bill_date <= (SELECT d FROM asof)
  ),
  oa AS (
    SELECT coalesce(sum(p.amount - p.amount_allocated), 0) AS v FROM finance_ap_payments p
     WHERE p.tenant_id = p_company AND p.journal_entry_id IS NOT NULL
       AND p.payment_date <= (SELECT d FROM asof)
  )
  SELECT b.v, oa.v, b.v - oa.v FROM b, oa
$$;
COMMENT ON FUNCTION finance_ap_position(uuid,date) IS
  'open bills - payments on account = net payable, which is what the AP control account holds. The '
  'second term is not optional: a payment debits AP the moment money leaves, before allocation, so '
  'a prepaid vendor leaves a debit in the control account (the identity F4''s tests had to teach us).';

CREATE OR REPLACE FUNCTION finance_ap_reconcile(p_company uuid, p_as_of date DEFAULT NULL)
  RETURNS TABLE (problem text, detail text) LANGUAGE sql STABLE AS $$
  WITH asof AS (SELECT coalesce(p_as_of, CURRENT_DATE) AS d),
  pos AS (SELECT * FROM finance_ap_position(p_company, (SELECT d FROM asof))),
  gl AS (
    -- AP control is a LIABILITY (credit-normal), so finance_account_movement already returns its
    -- balance positive in its own direction — directly comparable to the payable position.
    SELECT coalesce(sum(m.balance), 0) AS balance
      FROM finance_account_movement(p_company, NULL, (SELECT d FROM asof)) m
      JOIN finance_accounts a ON a.id = m.account_id
     WHERE a.is_control AND a.control_subledger = 'ap'
  )
  SELECT 'AP_SUBLEDGER_GL_MISMATCH',
         'AP subledger net (open bills ' || pos.open_bills::text ||
         ' less payments on account ' || pos.payments_on_account::text || ' = ' ||
         pos.net_payable::text || ') <> AP control account balance ' || gl.balance::text ||
         ' (difference ' || (pos.net_payable - gl.balance)::text || ')'
    FROM pos, gl WHERE pos.net_payable <> gl.balance
  UNION ALL
  SELECT 'AP_BILL_PAID_CACHE_DRIFT',
         'bill ' || b.bill_no || ': amount_paid ' || b.amount_paid::text ||
         ' <> allocations ' || coalesce(x.allocated, 0)::text
    FROM finance_ap_bills b
    LEFT JOIN (SELECT bill_id, sum(amount) AS allocated FROM finance_ap_allocations GROUP BY bill_id) x
           ON x.bill_id = b.id
   WHERE b.tenant_id = p_company AND b.amount_paid <> coalesce(x.allocated, 0)
  UNION ALL
  SELECT 'AP_PAYMENT_ALLOCATION_CACHE_DRIFT',
         'payment ' || p.payment_no || ': amount_allocated ' || p.amount_allocated::text ||
         ' <> allocations ' || coalesce(x.allocated, 0)::text
    FROM finance_ap_payments p
    LEFT JOIN (SELECT payment_id, sum(amount) AS allocated FROM finance_ap_allocations GROUP BY payment_id) x
           ON x.payment_id = p.id
   WHERE p.tenant_id = p_company AND p.amount_allocated <> coalesce(x.allocated, 0)
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (7) The finance third wall.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'finance_ap_vendors','finance_ap_bills','finance_ap_bill_lines',
    'finance_ap_payments','finance_ap_allocations'
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
