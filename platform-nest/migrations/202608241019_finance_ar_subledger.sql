-- Finance F4 — ACCOUNTS RECEIVABLE. The first subledger.
--
-- Design: docs/blueprints/finance-accounting-foundation.md §2.1 (O2C), §3.2, §4.
-- Builds on F1's ledger (202608241015) and F3's statements (202608241017).
--
-- ── THE INVARIANT THIS PHASE EXISTS TO HOLD ─────────────────────────────────────────────────────
-- Not "an invoice saves". The test is:
--
--     SUM(open invoices) - SUM(payments on account)  ==  AR control account balance in the GL
--
-- Blueprint §3.2: "Subledger-to-GL reconciliation is the test. If it can drift, the system is not
-- banking ready." An aging schedule is the first document a lender asks for, and an aging that does
-- not tie to the balance sheet is worse than none — it is a number that looks authoritative and is
-- not.
--
-- ⚠ Note the SECOND term. The naive identity — open invoices == control account — is wrong, and the
-- F4 test suite caught it on its first run. A receipt credits AR the moment the money lands, before
-- anyone allocates it, so a customer who prepays or overpays leaves a CREDIT sitting in the control
-- account. Comparing only the invoice side reports a mismatch on every prepayment, which teaches
-- people to ignore the reconciliation — the precise failure it exists to prevent. See §7.
--
-- The design keeps that invariant true BY CONSTRUCTION rather than by a nightly repair job:
--   * every AR document posts its journal in the SAME transaction that writes it,
--   * the amount posted is the amount recorded — one computation, not two,
--   * `finance_ar_reconcile()` is a CHECK, not a fixer. Nothing here silently repairs a difference,
--     because a repaired difference is a difference nobody investigated.
--
-- ── WHY AR CUSTOMERS ARE NOT THE `clients` TABLE ────────────────────────────────────────────────
-- They are LINKED, never merged. A client is a commercial relationship owned by the agency side; an
-- AR customer is a legal billing entity with an NPWP, payment terms and a balance. One client can
-- bill through two entities, a customer can exist with no client (a one-off sale), and the two have
-- different lifecycles — deleting a client must not orphan a receivable. `client_id` is a nullable
-- reference for joining reports, not a foreign identity.
--
-- ── TAX IS RECORDED HERE, TRANSMITTED IN F7 ─────────────────────────────────────────────────────
-- Every invoice line carries its tax treatment as DATA (code, base, rate, amount), and the invoice
-- carries the e-Faktur number once obtained. This migration does NOT talk to Coretax and must not:
-- blueprint §6 rules that e-Faktur transmission is integrated through a licensed ASP/PJAP, never
-- built. What F4 owes F7 is correct, complete tax data — which is the hard part anyway.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) finance_ar_customers
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE finance_ar_customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  code          text NOT NULL,
  name          text NOT NULL,
  -- Nullable link, not an identity. See the header.
  client_id     uuid,
  npwp          text,
  -- Indonesian VAT status of the CUSTOMER, which decides whether output VAT applies to them.
  -- NULL = unknown, deliberately distinct from false (blueprint §3.6, and the same posture
  -- finance_company_settings.is_pkp takes).
  is_pkp        boolean,
  payment_terms_days integer NOT NULL DEFAULT 30 CHECK (payment_terms_days >= 0),
  -- Recorded now, ENFORCED later: credit limits are a policy layer and are explicitly out of this
  -- chunk's scope. A column that stores a limit nobody checks is honest as data and dishonest as a
  -- control, so nothing in this migration reads it.
  credit_limit  numeric(20,4) CHECK (credit_limit IS NULL OR credit_limit >= 0),
  email         text,
  address       text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  origin_site   text NOT NULL DEFAULT 'central',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CONSTRAINT ux_finance_ar_customers_id_tenant UNIQUE (id, tenant_id)
);
CREATE UNIQUE INDEX ux_finance_ar_customers_code_live
  ON finance_ar_customers (tenant_id, code) WHERE deleted_at IS NULL;

COMMENT ON COLUMN finance_ar_customers.credit_limit IS
  'Stored, NOT enforced in F4. Credit-limit checking is a policy layer deferred to its own ticket; '
  'nothing in this migration reads this column. A limit that is silently unchecked is worse than an '
  'absent one.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) finance_ar_invoices + lines.
--
-- `amount_paid` is a DERIVED CACHE maintained by the allocation path, never edited by hand — and
-- `finance_ar_reconcile()` re-derives it from the allocations to prove the cache has not drifted.
-- The alternative (computing outstanding from a join every time) is correct but makes the aging
-- report quadratic and the invariant harder to state; caching plus a check that the cache is right
-- is the trade taken, and the check is what makes it safe.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE finance_ar_invoices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES companies(id),
  customer_id    uuid NOT NULL,
  invoice_no     text NOT NULL,
  invoice_date   date NOT NULL,
  due_date       date NOT NULL,
  currency_code  text NOT NULL REFERENCES finance_currencies(code),

  subtotal       numeric(20,4) NOT NULL CHECK (subtotal >= 0),
  tax_total      numeric(20,4) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  total          numeric(20,4) NOT NULL CHECK (total > 0),
  amount_paid    numeric(20,4) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),

  -- draft   -> not in the books at all; editable
  -- issued  -> POSTED to the ledger; immutable, awaiting payment
  -- paid    -> fully allocated (derived, maintained by the allocation path)
  -- void    -> issued then reversed; stays visible, never deleted
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','paid','void')),

  -- The journal this invoice posted. NULL while draft.
  journal_entry_id uuid,
  -- F7 fills this in once the invoice is transmitted through an ASP/PJAP. F4 only records it.
  efaktur_no     text,
  notes          text,
  origin_site    text NOT NULL DEFAULT 'central',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_finance_ar_invoices_customer
    FOREIGN KEY (customer_id, tenant_id) REFERENCES finance_ar_customers (id, tenant_id),
  CONSTRAINT fk_finance_ar_invoices_journal
    FOREIGN KEY (journal_entry_id, tenant_id) REFERENCES finance_journal_entries (id, tenant_id),
  CONSTRAINT ux_finance_ar_invoices_no UNIQUE (tenant_id, invoice_no),
  CONSTRAINT ux_finance_ar_invoices_id_tenant UNIQUE (id, tenant_id),
  CONSTRAINT ck_finance_ar_invoices_total CHECK (total = subtotal + tax_total),
  CONSTRAINT ck_finance_ar_invoices_due CHECK (due_date >= invoice_date),
  -- Cannot be paid beyond the invoice. Over-payment is a real event, but it is a CREDIT BALANCE on
  -- the customer, not a negative receivable — modelling it as over-allocation would make the aging
  -- lie. (Credit balances are deferred with credit memos.)
  CONSTRAINT ck_finance_ar_invoices_paid CHECK (amount_paid <= total),
  -- An issued invoice must name its journal; a draft must not have one.
  CONSTRAINT ck_finance_ar_invoices_journal CHECK (
    (status = 'draft') = (journal_entry_id IS NULL)
  )
);
CREATE INDEX ix_finance_ar_invoices_customer ON finance_ar_invoices (tenant_id, customer_id);
CREATE INDEX ix_finance_ar_invoices_open
  ON finance_ar_invoices (tenant_id, due_date) WHERE status IN ('issued','paid');

CREATE TABLE finance_ar_invoice_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  invoice_id    uuid NOT NULL,
  line_no       integer NOT NULL CHECK (line_no > 0),
  description   text NOT NULL,
  quantity      numeric(20,4) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price    numeric(20,4) NOT NULL CHECK (unit_price >= 0),
  line_subtotal numeric(20,4) NOT NULL CHECK (line_subtotal >= 0),

  -- Which revenue account this line credits. Explicit per line: one invoice legitimately spans
  -- service revenue and product revenue, and collapsing that to an invoice-level account is how a
  -- P&L stops being able to answer "what did we sell".
  revenue_account_id uuid NOT NULL,

  -- Tax AS DATA (blueprint §3.6). `tax_rate` is stored per line rather than looked up at report
  -- time because the rate that applied is a fact about the transaction — Indonesian VAT moved from
  -- 11% to a 12%-with-11/12-base regime in 2025, and a historical invoice must keep its own rate.
  tax_code      text,
  tax_rate      numeric(9,6) CHECK (tax_rate IS NULL OR (tax_rate >= 0 AND tax_rate <= 100)),
  tax_amount    numeric(20,4) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),

  CONSTRAINT fk_finance_ar_invoice_lines_invoice
    FOREIGN KEY (invoice_id, tenant_id) REFERENCES finance_ar_invoices (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT fk_finance_ar_invoice_lines_revenue
    FOREIGN KEY (revenue_account_id, tenant_id) REFERENCES finance_accounts (id, tenant_id),
  CONSTRAINT ux_finance_ar_invoice_lines_no UNIQUE (invoice_id, line_no),
  CONSTRAINT ux_finance_ar_invoice_lines_id_tenant UNIQUE (id, tenant_id)
);
CREATE INDEX ix_finance_ar_invoice_lines_invoice ON finance_ar_invoice_lines (invoice_id, line_no);

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (3) Receipts and their allocation to invoices.
--
-- A receipt is money ARRIVING; an allocation says which invoice it settles. They are separate
-- because the real world separates them: one transfer pays three invoices, a customer pays on
-- account before any invoice exists, and a payment can be partially applied. Collapsing them into
-- "invoice.paid_amount" loses the audit trail of WHICH money settled WHICH debt.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE finance_ar_receipts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES companies(id),
  customer_id    uuid NOT NULL,
  receipt_no     text NOT NULL,
  receipt_date   date NOT NULL,
  currency_code  text NOT NULL REFERENCES finance_currencies(code),
  amount         numeric(20,4) NOT NULL CHECK (amount > 0),
  amount_allocated numeric(20,4) NOT NULL DEFAULT 0 CHECK (amount_allocated >= 0),
  -- Which cash/bank account received it.
  bank_account_id uuid NOT NULL,
  journal_entry_id uuid,
  reference      text,
  origin_site    text NOT NULL DEFAULT 'central',
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_finance_ar_receipts_customer
    FOREIGN KEY (customer_id, tenant_id) REFERENCES finance_ar_customers (id, tenant_id),
  CONSTRAINT fk_finance_ar_receipts_bank
    FOREIGN KEY (bank_account_id, tenant_id) REFERENCES finance_accounts (id, tenant_id),
  CONSTRAINT fk_finance_ar_receipts_journal
    FOREIGN KEY (journal_entry_id, tenant_id) REFERENCES finance_journal_entries (id, tenant_id),
  CONSTRAINT ux_finance_ar_receipts_no UNIQUE (tenant_id, receipt_no),
  CONSTRAINT ux_finance_ar_receipts_id_tenant UNIQUE (id, tenant_id),
  CONSTRAINT ck_finance_ar_receipts_allocated CHECK (amount_allocated <= amount)
);
CREATE INDEX ix_finance_ar_receipts_customer ON finance_ar_receipts (tenant_id, customer_id);

CREATE TABLE finance_ar_allocations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES companies(id),
  receipt_id  uuid NOT NULL,
  invoice_id  uuid NOT NULL,
  amount      numeric(20,4) NOT NULL CHECK (amount > 0),
  allocated_at timestamptz NOT NULL DEFAULT now(),
  allocated_by uuid REFERENCES users(id),
  CONSTRAINT fk_finance_ar_allocations_receipt
    FOREIGN KEY (receipt_id, tenant_id) REFERENCES finance_ar_receipts (id, tenant_id),
  CONSTRAINT fk_finance_ar_allocations_invoice
    FOREIGN KEY (invoice_id, tenant_id) REFERENCES finance_ar_invoices (id, tenant_id),
  -- One allocation row per (receipt, invoice) pair: a second application of the same receipt to the
  -- same invoice is an amendment of the first, not a new fact.
  CONSTRAINT ux_finance_ar_allocations_pair UNIQUE (receipt_id, invoice_id)
);
CREATE INDEX ix_finance_ar_allocations_invoice ON finance_ar_allocations (invoice_id);

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (4) finance_ar_issue_invoice() — draft becomes a receivable, and hits the ledger.
--
--   DR  AR control account          total (subtotal + tax)
--   CR  revenue account(s)          per line
--   CR  PPN Keluaran (output VAT)   tax total, if any
--
-- Posted through `finance_post_journal(..., p_subledger := 'ar')`, which is what permits touching
-- the AR control account at all — and permits ONLY that one (F4-00). The journal is written in the
-- same transaction as the status change, so the subledger and the GL cannot disagree even if the
-- process dies mid-way.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
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

  -- Resolve the control accounts BY ROLE, not by hardcoded code. The chart is editable data
  -- (ruling D-F5) — an accountant may renumber 1130, and a hardcoded '1130' would silently post to
  -- the wrong account or fail. `is_control` + `control_subledger` is the durable handle.
  SELECT code INTO v_ar FROM finance_accounts
   WHERE tenant_id = v_inv.tenant_id AND is_control AND control_subledger = 'ar'
     AND deleted_at IS NULL AND status = 'active'
   ORDER BY code LIMIT 1;
  IF v_ar IS NULL THEN
    RAISE EXCEPTION 'FINANCE_AR_NO_CONTROL_ACCOUNT: this company has no active AR control account'
      USING HINT = 'Mark the receivables account is_control with control_subledger = ''ar''.';
  END IF;

  IF v_inv.tax_total > 0 THEN
    SELECT code INTO v_vat FROM finance_accounts
     WHERE tenant_id = v_inv.tenant_id AND code = '2140' AND deleted_at IS NULL AND status = 'active';
    IF v_vat IS NULL THEN
      RAISE EXCEPTION 'FINANCE_AR_NO_VAT_ACCOUNT: invoice carries tax but no output VAT account (2140) exists';
    END IF;
  END IF;

  -- One debit to AR, one credit per revenue account, one credit for VAT. Revenue lines are grouped
  -- by account so an invoice with ten lines against one account produces one journal line, not ten.
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
    'ar-invoice:' || p_invoice::text,           -- idempotent by construction
    'AR invoice ' || v_inv.invoice_no,
    v_lines, p_actor, 'standard', NULL, v_inv.currency_code, NULL, NULL, 'ar');

  UPDATE finance_ar_invoices
     SET status = 'issued', journal_entry_id = v_entry, updated_at = now()
   WHERE id = p_invoice;

  RETURN v_entry;
END $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (5) finance_ar_record_receipt() and finance_ar_allocate().
--
--   Receipt:     DR bank/cash        amount
--                CR AR control       amount
--
-- The receipt posts against the CONTROL ACCOUNT immediately, not on allocation. That is deliberate
-- and it is what keeps the GL right: the money is in the bank the moment it arrives, and the
-- customer owes that much less, whether or not anyone has decided which invoice it settles yet.
-- Allocation is a SUBLEDGER-ONLY act — it moves no money and posts no journal.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
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

  SELECT code INTO v_ar FROM finance_accounts
   WHERE tenant_id = v_rec.tenant_id AND is_control AND control_subledger = 'ar'
     AND deleted_at IS NULL AND status = 'active' ORDER BY code LIMIT 1;
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

-- Allocation posts NOTHING. It records which debt the already-banked money settles.
CREATE OR REPLACE FUNCTION finance_ar_allocate(
  p_receipt uuid, p_invoice uuid, p_amount numeric, p_actor uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_rec finance_ar_receipts%ROWTYPE;
  v_inv finance_ar_invoices%ROWTYPE;
BEGIN
  SELECT * INTO v_rec FROM finance_ar_receipts WHERE id = p_receipt;
  SELECT * INTO v_inv FROM finance_ar_invoices WHERE id = p_invoice;
  IF v_rec.id IS NULL OR v_inv.id IS NULL THEN
    RAISE EXCEPTION 'FINANCE_AR_UNKNOWN_ALLOCATION_TARGET';
  END IF;
  IF v_rec.tenant_id <> v_inv.tenant_id THEN
    RAISE EXCEPTION 'FINANCE_AR_CROSS_COMPANY: receipt and invoice belong to different companies';
  END IF;
  IF v_rec.customer_id <> v_inv.customer_id THEN
    RAISE EXCEPTION 'FINANCE_AR_CUSTOMER_MISMATCH: a receipt may only settle its own customer''s invoices';
  END IF;
  IF v_inv.status = 'draft' THEN
    RAISE EXCEPTION 'FINANCE_AR_NOT_ISSUED: invoice % is still a draft', v_inv.invoice_no;
  END IF;
  IF v_inv.status = 'void' THEN
    RAISE EXCEPTION 'FINANCE_AR_VOID_INVOICE: invoice % has been voided', v_inv.invoice_no;
  END IF;
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'FINANCE_AR_BAD_ALLOCATION: amount must be > 0';
  END IF;
  IF p_amount > v_rec.amount - v_rec.amount_allocated THEN
    RAISE EXCEPTION 'FINANCE_AR_OVER_ALLOCATED: receipt % has only % unallocated',
      v_rec.receipt_no, v_rec.amount - v_rec.amount_allocated;
  END IF;
  IF p_amount > v_inv.total - v_inv.amount_paid THEN
    RAISE EXCEPTION 'FINANCE_AR_OVERPAYMENT: invoice % has only % outstanding',
      v_inv.invoice_no, v_inv.total - v_inv.amount_paid
      USING HINT = 'An overpayment is a customer credit balance, not a negative receivable.';
  END IF;

  INSERT INTO finance_ar_allocations (tenant_id, receipt_id, invoice_id, amount, allocated_by)
  VALUES (v_rec.tenant_id, p_receipt, p_invoice, p_amount, p_actor);

  UPDATE finance_ar_receipts SET amount_allocated = amount_allocated + p_amount WHERE id = p_receipt;
  UPDATE finance_ar_invoices
     SET amount_paid = amount_paid + p_amount,
         status = CASE WHEN amount_paid + p_amount >= total THEN 'paid' ELSE status END,
         updated_at = now()
   WHERE id = p_invoice;
END $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (6) finance_ar_aging() — F4-05. The schedule a lender asks for.
--
-- Buckets by DAYS OVERDUE against `p_as_of`, not by invoice age: an invoice on 60-day terms issued
-- 45 days ago is CURRENT, not "30 days". Ageing by issue date is the classic error and it makes a
-- healthy book look distressed.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_ar_aging(p_company uuid, p_as_of date DEFAULT NULL)
  RETURNS TABLE (
    customer_code text, customer_name text,
    current_amt numeric, d1_30 numeric, d31_60 numeric, d61_90 numeric, d90_plus numeric,
    total_outstanding numeric
  ) LANGUAGE sql STABLE AS $$
  WITH asof AS (SELECT coalesce(p_as_of, CURRENT_DATE) AS d),
  open_inv AS (
    SELECT i.customer_id, (i.total - i.amount_paid) AS outstanding,
           ((SELECT d FROM asof) - i.due_date) AS days_overdue
      FROM finance_ar_invoices i
     WHERE i.tenant_id = p_company
       AND i.status IN ('issued','paid')
       AND i.total > i.amount_paid
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

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (7) finance_ar_reconcile() — F4-06. THE TEST.
--
-- One row per PROBLEM; EMPTY means the subledger agrees with the general ledger. Same shape as
-- finance_verify_ledger_chain() and finance_verify_statements(), for the same reason.
--
-- It CHECKS and never REPAIRS. A function that silently fixed a difference would destroy the only
-- evidence that something upstream is wrong — and "the reconciliation ran clean" would stop meaning
-- anything. Three independent things are compared:
--
--   1. subledger NET position        vs  the AR control account balance in the GL
--   2. each invoice's cached amount_paid  vs  the sum of its allocations (cache drift)
--   3. each receipt's cached amount_allocated  vs  the sum of its allocations
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_ar_reconcile(p_company uuid, p_as_of date DEFAULT NULL)
  RETURNS TABLE (problem text, detail text)
  LANGUAGE sql STABLE AS $$
  WITH asof AS (SELECT coalesce(p_as_of, CURRENT_DATE) AS d),
  sub AS (
    SELECT coalesce(sum(i.total - i.amount_paid), 0) AS outstanding
      FROM finance_ar_invoices i
     WHERE i.tenant_id = p_company AND i.status IN ('issued','paid')
       AND i.invoice_date <= (SELECT d FROM asof)
  ),
  -- ⚠ UNALLOCATED RECEIPTS ARE PART OF THE POSITION, and leaving them out was a real error caught
  -- by the F4 test suite on its first run.
  --
  -- A receipt credits the AR control account the moment the money lands (see §5) — before anyone
  -- decides which invoice it settles. So a customer who pays 500m against a 111m invoice leaves the
  -- control account 389m in CREDIT: a payment on account, which is a genuine liability-shaped
  -- position sitting inside a receivable control account.
  --
  -- The identity is therefore NOT "open invoices = control account". It is:
  --
  --     control balance  =  SUM(invoice outstanding)  -  SUM(receipt unallocated)
  --
  -- Comparing only the invoice side reports a mismatch every time a customer prepays or overpays —
  -- which trains people to ignore the reconciliation, the exact failure this function exists to
  -- prevent.
  on_account AS (
    SELECT coalesce(sum(r.amount - r.amount_allocated), 0) AS unallocated
      FROM finance_ar_receipts r
     WHERE r.tenant_id = p_company AND r.journal_entry_id IS NOT NULL
       AND r.receipt_date <= (SELECT d FROM asof)
  ),
  gl AS (
    SELECT coalesce(sum(m.balance), 0) AS balance
      FROM finance_account_movement(p_company, NULL, (SELECT d FROM asof)) m
      JOIN finance_accounts a ON a.id = m.account_id
     WHERE a.is_control AND a.control_subledger = 'ar'
  )
  SELECT 'AR_SUBLEDGER_GL_MISMATCH',
         'AR subledger net (open invoices ' || sub.outstanding::text ||
         ' less payments on account ' || oa.unallocated::text || ' = ' ||
         (sub.outstanding - oa.unallocated)::text ||
         ') <> AR control account balance ' || gl.balance::text ||
         ' (difference ' || (sub.outstanding - oa.unallocated - gl.balance)::text || ')'
    FROM sub, on_account oa, gl WHERE sub.outstanding - oa.unallocated <> gl.balance
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
$$;
COMMENT ON FUNCTION finance_ar_reconcile(uuid,date) IS
  'F4-06, THE subledger test (blueprint 3.2). Returns one row per PROBLEM; EMPTY is the pass '
  'condition. CHECKS, never repairs — a silently repaired difference destroys the evidence that '
  'something upstream is wrong.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (8) The finance third wall.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'finance_ar_customers','finance_ar_invoices','finance_ar_invoice_lines',
    'finance_ar_receipts','finance_ar_allocations'
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

-- ── finance_ar_position() — the three numbers the reconciliation compares ────────────────────────
-- Exposed so a report, a test or a close checklist can state the position without re-deriving the
-- identity and getting it subtly different.
CREATE OR REPLACE FUNCTION finance_ar_position(p_company uuid, p_as_of date DEFAULT NULL)
  RETURNS TABLE (open_invoices numeric, payments_on_account numeric, net_receivable numeric)
  LANGUAGE sql STABLE AS $$
  WITH asof AS (SELECT coalesce(p_as_of, CURRENT_DATE) AS d),
  inv AS (
    SELECT coalesce(sum(i.total - i.amount_paid), 0) AS v FROM finance_ar_invoices i
     WHERE i.tenant_id = p_company AND i.status IN ('issued','paid')
       AND i.invoice_date <= (SELECT d FROM asof)
  ),
  oa AS (
    SELECT coalesce(sum(r.amount - r.amount_allocated), 0) AS v FROM finance_ar_receipts r
     WHERE r.tenant_id = p_company AND r.journal_entry_id IS NOT NULL
       AND r.receipt_date <= (SELECT d FROM asof)
  )
  SELECT inv.v, oa.v, inv.v - oa.v FROM inv, oa
$$;
COMMENT ON FUNCTION finance_ar_position(uuid,date) IS
  'open invoices - payments on account = net receivable, which is what the AR control account '
  'holds. The aging report shows the FIRST number only; a customer prepayment is not a negative '
  'invoice and must not be netted into a bucket.';
