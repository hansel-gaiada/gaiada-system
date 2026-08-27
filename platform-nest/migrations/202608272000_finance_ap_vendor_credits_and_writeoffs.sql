-- Finance F5b — AP VENDOR CREDITS AND WRITE-OFFS. The payables mirror of F4b (202608270900).
--
-- The payables page has said "Credit notes and write-offs are not built for payables — neither has
-- SQL behind it yet" since the AR side landed. This is that SQL.
--
-- ── IT IS NOT F4b WITH THE SIGNS FLIPPED, AND TREATING IT THAT WAY IS THE EXPENSIVE MISTAKE ─────
-- Three differences, each with its own money consequence:
--
--   1. INPUT VAT, NOT OUTPUT. A bill's `tax_total` is PPN Masukan in 1170 — an ASSET, VAT we
--      CLAIMED. Crediting a bill reverses the claim (CR 1170). On the AR side the same act debited
--      2140, a liability. And in Indonesia the reversal is validated by a NOTA RETUR that the BUYER
--      issues (PMK 65/PMK.03/2010 as amended) — the supplier's own credit note does not do it, which
--      is why `nota_retur_no` is a column here and has no AR counterpart.
--
--   2. WITHHOLDING IS ALREADY GONE. `finance_ap_approve_bill` credits AP with `amount_payable`
--      (= total - withholding_amount) and credits the PPh liability separately, because the company
--      never owed the vendor the withheld portion — it owes DJP. A credit therefore has to unwind
--      BOTH legs or the journal does not balance, and the arithmetic is not optional:
--
--          DR AP control          credit.amount_payable
--          DR withholding account credit.withholding_amount
--              CR expense/contra  credit.subtotal
--              CR 1170            credit.tax_total
--
--      ⚠ The LEDGER is corrected here. The FILING is not. If a bukti potong was already issued to
--      the vendor, crediting the bill means it over-states what was withheld, and fixing that is an
--      AMENDED e-Bupot — a statement to DJP. Owner ruling 2026-08-27 chose option (c): RECORD the
--      exposure and FLAG it, never auto-amend and never block. Auto-amending would have this system
--      silently restate a filing; blocking would make a routine purchase return impossible until a
--      tax officer acted. So the credit posts, `requires_bupot_amendment` is set, and
--      `finance_ap_bupot_amendment_exceptions()` lists what a human still owes DJP.
--
--   3. A WRITE-OFF ON THIS SIDE IS INCOME. Forgiving a receivable is an expense; a payable you will
--      never pay is `pembebasan utang` — released debt, taxable income under UU PPh. So:
--
--          AR write-off:  DR bad-debt expense (6950)     -> reduces profit
--          AP write-off:  CR other income   (7300)       -> INCREASES taxable profit
--
--      Booking it as a negative expense instead of income understates taxable profit. Exactly the
--      same class of error as reclaiming VAT on a bad debt, in the opposite direction.
--
-- ── THE TIE-OUT AGAIN ───────────────────────────────────────────────────────────────────────────
-- finance_ap_aging / _position / _reconcile are RE-DEFINED at the bottom, never edited in
-- 202608241021 — that file is applied on every estate. An unapplied vendor credit DEBITS the AP
-- control account exactly as an unallocated payment does, so the identity grows a third term:
--
--     control = open bills - payments on account - unapplied vendor credits

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) The bill learns the two new ways it can be settled.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE finance_ap_bills
  ADD COLUMN IF NOT EXISTS amount_credited    numeric(20,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amount_written_off numeric(20,4) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_finance_ap_bills_settled') THEN
    ALTER TABLE finance_ap_bills
      ADD CONSTRAINT ck_finance_ap_bills_settled
      CHECK (amount_credited >= 0 AND amount_written_off >= 0
             -- against amount_payable, NOT total: the withheld portion was never owed to the vendor.
             AND amount_paid + amount_credited + amount_written_off <= amount_payable);
  END IF;
END $$;

COMMENT ON COLUMN finance_ap_bills.amount_credited IS
  'Settled by VENDOR CREDIT (we never owed it; input VAT reversed). Measured against '
  'amount_payable, not total -- the withheld portion was owed to DJP, never to the vendor.';
COMMENT ON COLUMN finance_ap_bills.amount_written_off IS
  'Settled by WRITE-OFF (we owed it and will not pay). Credits OTHER INCOME, not an expense -- '
  'released debt is taxable income (pembebasan utang).';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) finance_ap_vendor_credits — the document.
--
-- Mirrors finance_ap_bills field for field, including the withholding block, because a credit that
-- cannot express withholding cannot reverse a bill that had it.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS finance_ap_vendor_credits (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES companies(id),
  vendor_id      uuid NOT NULL,
  credit_no      text NOT NULL,
  credit_date    date NOT NULL,
  currency_code  text NOT NULL REFERENCES finance_currencies(code),

  subtotal       numeric(20,4) NOT NULL CHECK (subtotal >= 0),
  tax_total      numeric(20,4) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  total          numeric(20,4) NOT NULL CHECK (total > 0),

  -- The withholding being unwound. Copied from the bill rather than re-derived: the rate in force
  -- when the bill was approved is the rate that must be reversed, even if the code's rate changed.
  withholding_code   text,
  withholding_rate   numeric(9,6) CHECK (withholding_rate IS NULL
                       OR (withholding_rate >= 0 AND withholding_rate <= 100)),
  withholding_amount numeric(20,4) NOT NULL DEFAULT 0 CHECK (withholding_amount >= 0),
  withholding_account_id uuid,

  amount_payable numeric(20,4) NOT NULL CHECK (amount_payable >= 0),
  amount_applied numeric(20,4) NOT NULL DEFAULT 0 CHECK (amount_applied >= 0),

  reason_code    text NOT NULL CHECK (reason_code IN
                   ('return','overbilling','discount','service_failure','price_correction','other')),
  reason         text NOT NULL,
  original_bill_id uuid,

  -- The BUYER-issued document that makes the input-VAT reversal valid in Indonesia. Recorded here,
  -- never transmitted from here (ruling D-F2, same carve-out as efaktur_no).
  nota_retur_no  text,

  -- ── THE (c) RULING, AS COLUMNS ────────────────────────────────────────────────────────────────
  -- Set when the credit unwinds withholding that may already sit on a bukti potong. The credit is
  -- NOT blocked; a human resolves the filing and records the reference here.
  requires_bupot_amendment boolean NOT NULL DEFAULT false,
  bupot_amendment_ref text,
  bupot_amended_at    timestamptz,
  bupot_amended_by    uuid REFERENCES users(id),

  status         text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','issued','applied','void')),
  journal_entry_id uuid,
  notes          text,
  origin_site    text NOT NULL DEFAULT 'central',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_finance_ap_vc_vendor
    FOREIGN KEY (vendor_id, tenant_id) REFERENCES finance_ap_vendors (id, tenant_id),
  CONSTRAINT fk_finance_ap_vc_bill
    FOREIGN KEY (original_bill_id, tenant_id) REFERENCES finance_ap_bills (id, tenant_id),
  CONSTRAINT fk_finance_ap_vc_journal
    FOREIGN KEY (journal_entry_id, tenant_id) REFERENCES finance_journal_entries (id, tenant_id),
  CONSTRAINT fk_finance_ap_vc_wht_account
    FOREIGN KEY (withholding_account_id, tenant_id) REFERENCES finance_accounts (id, tenant_id),
  CONSTRAINT ux_finance_ap_vc_no UNIQUE (tenant_id, credit_no),
  CONSTRAINT ux_finance_ap_vc_id_tenant UNIQUE (id, tenant_id),
  CONSTRAINT ck_finance_ap_vc_total CHECK (total = subtotal + tax_total),
  -- The same identity the bill carries. If this drifts, the journal cannot balance.
  CONSTRAINT ck_finance_ap_vc_payable CHECK (amount_payable = total - withholding_amount),
  CONSTRAINT ck_finance_ap_vc_applied CHECK (amount_applied <= amount_payable),
  CONSTRAINT ck_finance_ap_vc_journal CHECK ((status = 'draft') = (journal_entry_id IS NULL)),
  -- Withholding needs somewhere to go back to.
  CONSTRAINT ck_finance_ap_vc_wht CHECK (
    withholding_amount = 0 OR withholding_account_id IS NOT NULL),
  -- A resolved amendment must say what resolved it.
  CONSTRAINT ck_finance_ap_vc_bupot CHECK (
    (bupot_amended_at IS NULL) OR (bupot_amendment_ref IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_finance_ap_vc_vendor
  ON finance_ap_vendor_credits (tenant_id, vendor_id, credit_date DESC);
CREATE INDEX IF NOT EXISTS ix_finance_ap_vc_bupot_open
  ON finance_ap_vendor_credits (tenant_id) WHERE requires_bupot_amendment AND bupot_amended_at IS NULL;

CREATE TABLE IF NOT EXISTS finance_ap_vendor_credit_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES companies(id),
  credit_id      uuid NOT NULL,
  description    text NOT NULL,
  line_subtotal  numeric(20,4) NOT NULL CHECK (line_subtotal > 0),
  -- The account being reversed. Defaults to the ORIGINAL EXPENSE account rather than a contra:
  -- unlike revenue, where returns are a reported figure, an over-billed expense that never happened
  -- should simply not be in the expense line. A "purchase returns" contra exists in some charts and
  -- callers may point here at whatever their policy says.
  credit_account_id uuid NOT NULL,
  sort_order     integer NOT NULL DEFAULT 0,
  CONSTRAINT fk_finance_ap_vcl_credit
    FOREIGN KEY (credit_id, tenant_id) REFERENCES finance_ap_vendor_credits (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT fk_finance_ap_vcl_account
    FOREIGN KEY (credit_account_id, tenant_id) REFERENCES finance_accounts (id, tenant_id),
  CONSTRAINT ux_finance_ap_vcl_id_tenant UNIQUE (id, tenant_id)
);
CREATE INDEX IF NOT EXISTS ix_finance_ap_vcl_credit ON finance_ap_vendor_credit_lines (credit_id);

-- Separate from finance_ap_allocations for the same reason as AR: finance_ap_reconcile compares
-- `bill.amount_paid` against the sum of PAYMENT allocations, and mixing credits into that table
-- would report permanent cache drift on every bill that ever receives one.
CREATE TABLE IF NOT EXISTS finance_ap_credit_applications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES companies(id),
  credit_id   uuid NOT NULL,
  bill_id     uuid NOT NULL,
  amount      numeric(20,4) NOT NULL CHECK (amount > 0),
  applied_at  timestamptz NOT NULL DEFAULT now(),
  applied_by  uuid REFERENCES users(id),
  CONSTRAINT fk_finance_ap_ca_credit
    FOREIGN KEY (credit_id, tenant_id) REFERENCES finance_ap_vendor_credits (id, tenant_id),
  CONSTRAINT fk_finance_ap_ca_bill
    FOREIGN KEY (bill_id, tenant_id) REFERENCES finance_ap_bills (id, tenant_id),
  CONSTRAINT ux_finance_ap_ca_pair UNIQUE (credit_id, bill_id)
);

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (3) finance_ap_writeoffs — a debt we will not pay.
--
-- Always against ONE bill, same reasoning as AR: you cannot write off a debt without naming it.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS finance_ap_writeoffs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES companies(id),
  bill_id        uuid NOT NULL,
  vendor_id      uuid NOT NULL,
  write_off_date date NOT NULL,
  amount         numeric(20,4) NOT NULL CHECK (amount > 0),
  reason_code    text NOT NULL CHECK (reason_code IN
                   ('vendor_dissolved','statute_barred','disputed_abandoned','unclaimed','other')),
  reason         text NOT NULL,
  -- Where the income landed, snapshotted. A five-year-old write-off must still explain itself, and
  -- an auditor asks which income line absorbed it.
  income_account_code text NOT NULL,
  journal_entry_id uuid,
  approved_by    uuid REFERENCES users(id),
  origin_site    text NOT NULL DEFAULT 'central',
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_finance_ap_wo_bill
    FOREIGN KEY (bill_id, tenant_id) REFERENCES finance_ap_bills (id, tenant_id),
  CONSTRAINT fk_finance_ap_wo_vendor
    FOREIGN KEY (vendor_id, tenant_id) REFERENCES finance_ap_vendors (id, tenant_id),
  CONSTRAINT fk_finance_ap_wo_journal
    FOREIGN KEY (journal_entry_id, tenant_id) REFERENCES finance_journal_entries (id, tenant_id),
  CONSTRAINT ux_finance_ap_wo_id_tenant UNIQUE (id, tenant_id)
);
CREATE INDEX IF NOT EXISTS ix_finance_ap_wo_bill ON finance_ap_writeoffs (tenant_id, bill_id);

-- ── The finance third wall ──────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'finance_ap_vendor_credits','finance_ap_vendor_credit_lines',
    'finance_ap_credit_applications','finance_ap_writeoffs'
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
-- (4) finance_ap_issue_vendor_credit() — the exact inverse of finance_ap_approve_bill().
--
--   DR AP control            amount_payable
--   DR withholding account   withholding_amount
--       CR expense (per line) subtotal
--       CR 1170 PPN Masukan   tax_total
--
-- Every leg mirrors one the bill posted. Getting the AP leg wrong is the easy mistake: crediting the
-- GROSS total would debit AP by more than the bill ever credited it, because the withheld portion
-- was never a payable to the vendor at all.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_ap_issue_vendor_credit(p_credit uuid, p_actor uuid DEFAULT NULL)
  RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_cr    finance_ap_vendor_credits%ROWTYPE;
  v_ap    text;
  v_vat   text;
  v_wht   text;
  v_lines jsonb;
  v_entry uuid;
BEGIN
  SELECT * INTO v_cr FROM finance_ap_vendor_credits WHERE id = p_credit;
  IF v_cr.id IS NULL THEN
    RAISE EXCEPTION 'FINANCE_AP_UNKNOWN_CREDIT: no vendor credit %', p_credit;
  END IF;
  IF v_cr.status <> 'draft' THEN
    RAISE EXCEPTION 'FINANCE_AP_CREDIT_ALREADY_ISSUED: vendor credit % is %', v_cr.credit_no, v_cr.status;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM finance_ap_vendor_credit_lines WHERE credit_id = p_credit) THEN
    RAISE EXCEPTION 'FINANCE_AP_CREDIT_EMPTY: vendor credit % has no lines', v_cr.credit_no;
  END IF;

  SELECT code INTO v_ap FROM finance_accounts
   WHERE tenant_id = v_cr.tenant_id AND is_control AND control_subledger = 'ap'
     AND deleted_at IS NULL AND status = 'active'
   ORDER BY code LIMIT 1;
  IF v_ap IS NULL THEN
    RAISE EXCEPTION 'FINANCE_AP_NO_CONTROL_ACCOUNT: this company has no active AP control account'
      USING HINT = 'Mark the payables account is_control with control_subledger = ''ap''.';
  END IF;

  IF v_cr.tax_total > 0 THEN
    SELECT code INTO v_vat FROM finance_accounts
     WHERE tenant_id = v_cr.tenant_id AND code = '1170' AND deleted_at IS NULL AND status = 'active';
    IF v_vat IS NULL THEN
      RAISE EXCEPTION 'FINANCE_AP_NO_INPUT_VAT_ACCOUNT: credit carries tax but no input VAT account (1170) exists';
    END IF;
  END IF;

  IF v_cr.withholding_amount > 0 THEN
    SELECT code INTO v_wht FROM finance_accounts WHERE id = v_cr.withholding_account_id;
    IF v_wht IS NULL THEN
      RAISE EXCEPTION 'FINANCE_AP_NO_WHT_ACCOUNT: credit withholds but its withholding account is missing';
    END IF;
  END IF;

  SELECT jsonb_build_array(jsonb_build_object(
           'account_code', v_ap, 'side', 'debit', 'amount', v_cr.amount_payable,
           'memo', 'Vendor credit ' || v_cr.credit_no))
       || CASE WHEN v_cr.withholding_amount > 0
               THEN jsonb_build_array(jsonb_build_object(
                      'account_code', v_wht, 'side', 'debit', 'amount', v_cr.withholding_amount,
                      'memo', coalesce(v_cr.withholding_code,'WHT') || ' reversed on ' || v_cr.credit_no))
               ELSE '[]'::jsonb END
       || coalesce((
            SELECT jsonb_agg(jsonb_build_object(
                     'account_code', a.code, 'side', 'credit', 'amount', x.amt,
                     'memo', 'Vendor credit ' || v_cr.credit_no))
              FROM (SELECT credit_account_id, sum(line_subtotal) AS amt
                      FROM finance_ap_vendor_credit_lines WHERE credit_id = p_credit
                     GROUP BY credit_account_id) x
              JOIN finance_accounts a ON a.id = x.credit_account_id), '[]'::jsonb)
       || CASE WHEN v_cr.tax_total > 0
               THEN jsonb_build_array(jsonb_build_object(
                      'account_code', v_vat, 'side', 'credit', 'amount', v_cr.tax_total,
                      'memo', 'Input VAT reversed on ' || v_cr.credit_no))
               ELSE '[]'::jsonb END
    INTO v_lines;

  v_entry := finance_post_journal(
    v_cr.tenant_id, v_cr.credit_date,
    'ap-vendor-credit:' || p_credit::text,
    'AP vendor credit ' || v_cr.credit_no,
    v_lines, p_actor, 'standard', NULL, v_cr.currency_code, NULL, NULL, 'ap');

  UPDATE finance_ap_vendor_credits
     SET status = 'issued',
         journal_entry_id = v_entry,
         -- The (c) ruling: the ledger is now correct, the FILING may not be. Flag, never block.
         requires_bupot_amendment = (v_cr.withholding_amount > 0),
         updated_at = now()
   WHERE id = p_credit;

  RETURN v_entry;
END $$;

COMMENT ON FUNCTION finance_ap_issue_vendor_credit(uuid,uuid) IS
  'Posts a vendor credit: DR AP control + DR withholding, CR expense + CR input VAT (1170). The '
  'exact inverse of finance_ap_approve_bill, including the withholding leg -- the AP debit is '
  'amount_payable, never the gross total, because the withheld portion was never owed to the vendor. '
  'Sets requires_bupot_amendment when withholding is unwound; it does NOT amend the filing.';

-- ── Application: subledger only, posts nothing ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION finance_ap_apply_vendor_credit(
  p_credit uuid, p_bill uuid, p_amount numeric, p_actor uuid DEFAULT NULL)
  RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_cr       finance_ap_vendor_credits%ROWTYPE;
  v_bill     finance_ap_bills%ROWTYPE;
  v_cr_free  numeric;
  v_bill_open numeric;
  v_id       uuid;
BEGIN
  SELECT * INTO v_cr FROM finance_ap_vendor_credits WHERE id = p_credit;
  IF v_cr.id IS NULL THEN
    RAISE EXCEPTION 'FINANCE_AP_UNKNOWN_CREDIT: no vendor credit %', p_credit;
  END IF;
  IF v_cr.status NOT IN ('issued','applied') THEN
    RAISE EXCEPTION 'FINANCE_AP_CREDIT_NOT_ISSUED: vendor credit % is %', v_cr.credit_no, v_cr.status;
  END IF;

  SELECT * INTO v_bill FROM finance_ap_bills WHERE id = p_bill;
  IF v_bill.id IS NULL THEN
    RAISE EXCEPTION 'FINANCE_AP_UNKNOWN_BILL: no bill %', p_bill;
  END IF;
  IF v_bill.tenant_id <> v_cr.tenant_id THEN
    RAISE EXCEPTION 'FINANCE_AP_CROSS_COMPANY: credit and bill belong to different companies';
  END IF;
  IF v_bill.vendor_id <> v_cr.vendor_id THEN
    RAISE EXCEPTION 'FINANCE_AP_CREDIT_WRONG_VENDOR: credit % is for a different vendor than bill %',
      v_cr.credit_no, v_bill.bill_no;
  END IF;
  IF v_bill.status NOT IN ('approved','paid') THEN
    RAISE EXCEPTION 'FINANCE_AP_CREDIT_BILL_NOT_APPROVED: bill % is %', v_bill.bill_no, v_bill.status;
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'FINANCE_AP_CREDIT_BAD_AMOUNT: application amount must be greater than zero';
  END IF;

  v_cr_free   := v_cr.amount_payable - v_cr.amount_applied;
  v_bill_open := v_bill.amount_payable - v_bill.amount_paid - v_bill.amount_credited - v_bill.amount_written_off;

  IF p_amount > v_cr_free THEN
    RAISE EXCEPTION 'FINANCE_AP_CREDIT_OVERAPPLIED: vendor credit % has only % unapplied',
      v_cr.credit_no, v_cr_free;
  END IF;
  IF p_amount > v_bill_open THEN
    RAISE EXCEPTION 'FINANCE_AP_CREDIT_OVER_BILL: bill % has only % outstanding',
      v_bill.bill_no, v_bill_open;
  END IF;

  INSERT INTO finance_ap_credit_applications (tenant_id, credit_id, bill_id, amount, applied_by)
  VALUES (v_cr.tenant_id, p_credit, p_bill, p_amount, p_actor)
  ON CONFLICT (credit_id, bill_id) DO UPDATE
    SET amount = finance_ap_credit_applications.amount + EXCLUDED.amount, applied_at = now()
  RETURNING id INTO v_id;

  UPDATE finance_ap_bills
     SET amount_credited = amount_credited + p_amount, updated_at = now()
   WHERE id = p_bill;

  UPDATE finance_ap_vendor_credits
     SET amount_applied = amount_applied + p_amount,
         status = CASE WHEN amount_applied + p_amount >= amount_payable THEN 'applied' ELSE 'issued' END,
         updated_at = now()
   WHERE id = p_credit;

  RETURN v_id;
END $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (5) finance_ap_write_off() — a payable that will never be paid.
--
--   DR AP control    amount
--       CR 7300 Pendapatan Lain-lain   amount
--
-- ⚠ INCOME, NOT A NEGATIVE EXPENSE. Released debt (pembebasan utang) is taxable income under
-- UU PPh. Crediting the original expense account would understate taxable profit and hide the event
-- inside whatever cost centre the bill happened to hit.
--
-- ⚠ AND NO VAT LEG. The input VAT on the original bill was validly claimed when the supply
-- happened; not paying the supplier does not retrospectively invalidate it. Reversing 1170 here
-- would give back a credit the company is entitled to keep — the exact mirror of the AR side, where
-- a write-off must NOT reclaim output VAT.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_ap_write_off(
  p_bill        uuid,
  p_amount      numeric,
  p_date        date,
  p_reason_code text,
  p_reason      text,
  p_actor       uuid DEFAULT NULL,
  p_income_code text DEFAULT '7300')
  RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_bill   finance_ap_bills%ROWTYPE;
  v_open   numeric;
  v_ap     text;
  v_income text;
  v_entry  uuid;
  v_wo     uuid;
BEGIN
  SELECT * INTO v_bill FROM finance_ap_bills WHERE id = p_bill;
  IF v_bill.id IS NULL THEN
    RAISE EXCEPTION 'FINANCE_AP_UNKNOWN_BILL: no bill %', p_bill;
  END IF;
  IF v_bill.status NOT IN ('approved','paid') THEN
    RAISE EXCEPTION 'FINANCE_AP_WO_NOT_APPROVED: bill % is % -- only a posted bill can be written off',
      v_bill.bill_no, v_bill.status;
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'FINANCE_AP_WO_NO_REASON: a write-off with no recorded reason is indistinguishable from a mistake';
  END IF;

  v_open := v_bill.amount_payable - v_bill.amount_paid - v_bill.amount_credited - v_bill.amount_written_off;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'FINANCE_AP_WO_BAD_AMOUNT: write-off amount must be greater than zero';
  END IF;
  IF p_amount > v_open THEN
    RAISE EXCEPTION 'FINANCE_AP_WO_OVER_BILL: bill % has only % outstanding', v_bill.bill_no, v_open;
  END IF;

  SELECT code INTO v_ap FROM finance_accounts
   WHERE tenant_id = v_bill.tenant_id AND is_control AND control_subledger = 'ap'
     AND deleted_at IS NULL AND status = 'active'
   ORDER BY code LIMIT 1;
  IF v_ap IS NULL THEN
    RAISE EXCEPTION 'FINANCE_AP_NO_CONTROL_ACCOUNT: this company has no active AP control account';
  END IF;

  SELECT code INTO v_income FROM finance_accounts
   WHERE tenant_id = v_bill.tenant_id AND code = coalesce(p_income_code, '7300')
     AND deleted_at IS NULL AND status = 'active';
  IF v_income IS NULL THEN
    RAISE EXCEPTION 'FINANCE_AP_WO_NO_INCOME_ACCOUNT: this company has no active account % for the released debt',
      coalesce(p_income_code, '7300')
      USING HINT = 'Released debt is taxable INCOME, not a negative expense. Create 7300 Pendapatan Lain-lain, or pass another income account.';
  END IF;

  INSERT INTO finance_ap_writeoffs
    (tenant_id, bill_id, vendor_id, write_off_date, amount, reason_code, reason,
     income_account_code, approved_by)
  VALUES (v_bill.tenant_id, p_bill, v_bill.vendor_id, p_date, p_amount,
          coalesce(p_reason_code,'other'), p_reason, v_income, p_actor)
  RETURNING id INTO v_wo;

  v_entry := finance_post_journal(
    v_bill.tenant_id, p_date,
    'ap-writeoff:' || v_wo::text,
    'AP write-off on ' || v_bill.bill_no,
    jsonb_build_array(
      jsonb_build_object('account_code', v_ap, 'side', 'debit', 'amount', p_amount,
                         'memo', 'Write-off ' || v_bill.bill_no),
      jsonb_build_object('account_code', v_income, 'side', 'credit', 'amount', p_amount,
                         'memo', 'Released debt (income) ' || v_bill.bill_no)),
    p_actor, 'standard', NULL, v_bill.currency_code, NULL, NULL, 'ap');

  UPDATE finance_ap_writeoffs SET journal_entry_id = v_entry WHERE id = v_wo;
  UPDATE finance_ap_bills
     SET amount_written_off = amount_written_off + p_amount, updated_at = now()
   WHERE id = p_bill;

  RETURN v_wo;
END $$;

COMMENT ON FUNCTION finance_ap_write_off(uuid,numeric,date,text,text,uuid,text) IS
  'Writes off an unpayable liability. DR AP control, CR other income (7300 by default). INCOME, not '
  'a negative expense -- released debt is taxable under UU PPh. Posts NO VAT leg: the input VAT was '
  'validly claimed when the supply happened and not paying does not invalidate it.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (6) finance_ap_bupot_amendment_exceptions() — the other half of the (c) ruling.
--
-- The credit posts and the ledger is right. What is NOT right, until a human acts, is the bukti
-- potong already given to the vendor. This is the chase list — same shape as
-- finance_tax_efaktur_exceptions(): a list of things somebody still owes DJP, surfaced while there
-- is time to file the amendment rather than discovered in a Coretax reconciliation months later.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_ap_bupot_amendment_exceptions(p_company uuid)
  RETURNS TABLE (
    credit_no text, credit_date date, vendor_code text, vendor_name text, npwp text,
    withholding_code text, withholding_reversed numeric, original_bill_no text, detail text
  ) LANGUAGE sql STABLE AS $$
  SELECT c.credit_no, c.credit_date, v.code, v.name, v.npwp,
         c.withholding_code, c.withholding_amount, b.bill_no,
         'vendor credit ' || c.credit_no || ' reversed ' || c.withholding_amount::text || ' of ' ||
         coalesce(c.withholding_code,'withholding') ||
         coalesce(' originally withheld on bill ' || b.bill_no, '') ||
         ' -- the bukti potong issued to this vendor now overstates what was withheld and needs an amended e-Bupot'
    FROM finance_ap_vendor_credits c
    JOIN finance_ap_vendors v ON v.id = c.vendor_id
    LEFT JOIN finance_ap_bills b ON b.id = c.original_bill_id
   WHERE c.tenant_id = p_company
     AND c.status IN ('issued','applied')
     AND c.requires_bupot_amendment
     AND c.bupot_amended_at IS NULL
   ORDER BY c.credit_date DESC, c.credit_no
$$;
COMMENT ON FUNCTION finance_ap_bupot_amendment_exceptions(uuid) IS
  'Vendor credits that unwound withholding and whose bukti potong has not been amended. Owner ruling '
  '2026-08-27 option (c): record and flag, never auto-amend a filing to DJP and never block a routine '
  'purchase return on a tax action.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (7) THE TIE-OUT FUNCTIONS RE-DEFINED.
--
-- Copied from 202608241021 and changed minimally. NOT edited there — that migration is applied on
-- every estate, and an edit would reach fresh databases only.
--
-- The identity grows a third term, mirroring what F4b did to AR. An UNAPPLIED VENDOR CREDIT debits
-- the AP control account the moment it is issued, before anyone decides which bill it settles —
-- exactly as an unallocated PAYMENT does, which is the term the original author had to add after the
-- F4 suite caught it. Leaving it out would report a mismatch for as long as a credit sits unapplied,
-- which is a credit's normal state.
--
--     control = open bills - payments on account - unapplied vendor credits
--
-- Write-offs need no term: a write-off is always against one bill and immediately reduces that
-- bill's outstanding, so it is already inside the first term.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION finance_ap_aging(p_company uuid, p_as_of date DEFAULT NULL)
  RETURNS TABLE (
    vendor_code text, vendor_name text,
    current_amt numeric, d1_30 numeric, d31_60 numeric, d61_90 numeric, d90_plus numeric,
    total_outstanding numeric
  ) LANGUAGE sql STABLE AS $$
  WITH asof AS (SELECT coalesce(p_as_of, CURRENT_DATE) AS d),
  open_bill AS (
    SELECT b.vendor_id,
           (b.amount_payable - b.amount_paid - b.amount_credited - b.amount_written_off) AS outstanding,
           ((SELECT d FROM asof) - b.due_date) AS days_overdue
      FROM finance_ap_bills b
     WHERE b.tenant_id = p_company AND b.status IN ('approved','paid')
       AND b.amount_payable > b.amount_paid + b.amount_credited + b.amount_written_off
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
COMMENT ON FUNCTION finance_ap_aging(uuid,date) IS
  'Aging by days past due, net of payments, vendor credits AND write-offs. Measured against '
  'amount_payable, never total -- the withheld portion was owed to DJP, not to the vendor. An '
  'unapplied vendor credit is deliberately absent: it is a credit on the ACCOUNT, not a negative '
  'bill, exactly as a vendor prepayment is.';

-- position() gains a fourth number, so DROP first: Postgres cannot CREATE OR REPLACE a function
-- whose OUT parameters changed. finance_ap_reconcile() selects from it and is re-created below.
DROP FUNCTION IF EXISTS finance_ap_position(uuid, date) CASCADE;
CREATE FUNCTION finance_ap_position(p_company uuid, p_as_of date DEFAULT NULL)
  RETURNS TABLE (open_bills numeric, payments_on_account numeric,
                 unapplied_credits numeric, net_payable numeric)
  LANGUAGE sql STABLE AS $$
  WITH asof AS (SELECT coalesce(p_as_of, CURRENT_DATE) AS d),
  b AS (
    SELECT coalesce(sum(x.amount_payable - x.amount_paid - x.amount_credited - x.amount_written_off), 0) AS v
      FROM finance_ap_bills x
     WHERE x.tenant_id = p_company AND x.status IN ('approved','paid')
       AND x.bill_date <= (SELECT d FROM asof)
  ),
  oa AS (
    SELECT coalesce(sum(p.amount - p.amount_allocated), 0) AS v FROM finance_ap_payments p
     WHERE p.tenant_id = p_company AND p.journal_entry_id IS NOT NULL
       AND p.payment_date <= (SELECT d FROM asof)
  ),
  uc AS (
    SELECT coalesce(sum(c.amount_payable - c.amount_applied), 0) AS v
      FROM finance_ap_vendor_credits c
     WHERE c.tenant_id = p_company AND c.status IN ('issued','applied')
       AND c.credit_date <= (SELECT d FROM asof)
  )
  SELECT b.v, oa.v, uc.v, b.v - oa.v - uc.v FROM b, oa, uc
$$;
COMMENT ON FUNCTION finance_ap_position(uuid,date) IS
  'open bills - payments on account - unapplied vendor credits = net payable, which is what the AP '
  'control account holds. Neither of the last two is optional: a payment debits AP the moment money '
  'leaves and a vendor credit debits it the moment it is issued, both before anyone decides which '
  'bill they settle.';

CREATE OR REPLACE FUNCTION finance_ap_reconcile(p_company uuid, p_as_of date DEFAULT NULL)
  RETURNS TABLE (problem text, detail text) LANGUAGE sql STABLE AS $$
  WITH asof AS (SELECT coalesce(p_as_of, CURRENT_DATE) AS d),
  pos AS (SELECT * FROM finance_ap_position(p_company, (SELECT d FROM asof))),
  gl AS (
    SELECT coalesce(sum(m.balance), 0) AS balance
      FROM finance_account_movement(p_company, NULL, (SELECT d FROM asof)) m
      JOIN finance_accounts a ON a.id = m.account_id
     WHERE a.is_control AND a.control_subledger = 'ap'
  )
  SELECT 'AP_SUBLEDGER_GL_MISMATCH',
         'AP subledger net (open bills ' || pos.open_bills::text ||
         ' less payments on account ' || pos.payments_on_account::text ||
         ' less unapplied vendor credits ' || pos.unapplied_credits::text || ' = ' ||
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
  -- ── The same cache-drift argument, for the two new caches ────────────────────────────────────
  UNION ALL
  SELECT 'AP_BILL_CREDIT_CACHE_DRIFT',
         'bill ' || b.bill_no || ': amount_credited ' || b.amount_credited::text ||
         ' <> credit applications ' || coalesce(x.applied, 0)::text
    FROM finance_ap_bills b
    LEFT JOIN (SELECT bill_id, sum(amount) AS applied FROM finance_ap_credit_applications GROUP BY bill_id) x
           ON x.bill_id = b.id
   WHERE b.tenant_id = p_company AND b.amount_credited <> coalesce(x.applied, 0)
  UNION ALL
  SELECT 'AP_VENDOR_CREDIT_APPLIED_CACHE_DRIFT',
         'vendor credit ' || c.credit_no || ': amount_applied ' || c.amount_applied::text ||
         ' <> applications ' || coalesce(x.applied, 0)::text
    FROM finance_ap_vendor_credits c
    LEFT JOIN (SELECT credit_id, sum(amount) AS applied FROM finance_ap_credit_applications GROUP BY credit_id) x
           ON x.credit_id = c.id
   WHERE c.tenant_id = p_company AND c.amount_applied <> coalesce(x.applied, 0)
  UNION ALL
  SELECT 'AP_BILL_WRITEOFF_CACHE_DRIFT',
         'bill ' || b.bill_no || ': amount_written_off ' || b.amount_written_off::text ||
         ' <> write-offs ' || coalesce(x.wo, 0)::text
    FROM finance_ap_bills b
    LEFT JOIN (SELECT bill_id, sum(amount) AS wo FROM finance_ap_writeoffs GROUP BY bill_id) x
           ON x.bill_id = b.id
   WHERE b.tenant_id = p_company AND b.amount_written_off <> coalesce(x.wo, 0)
  -- ── The (c) ruling surfaced where a controller will actually see it ──────────────────────────
  -- Not a ledger error: the books are right. It is a FILING that is not, and the reconciliation is
  -- the one screen somebody reads every close.
  UNION ALL
  SELECT 'AP_BUPOT_AMENDMENT_PENDING',
         e.detail
    FROM finance_ap_bupot_amendment_exceptions(p_company) e
$$;
COMMENT ON FUNCTION finance_ap_reconcile(uuid,date) IS
  'F5 subledger test. One row per PROBLEM; EMPTY is the pass condition. CHECKS, never repairs. The '
  'identity is open bills - payments on account - UNAPPLIED VENDOR CREDITS = the AP control balance. '
  'Also surfaces bukti potong amendments a vendor credit has made necessary -- the books are right, '
  'the filing is not, and this is the screen somebody reads every close.';
