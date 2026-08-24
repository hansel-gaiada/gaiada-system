-- Finance F7 — TAX AND STATUTORY. The legal ability to operate.
--
-- Design: docs/blueprints/finance-accounting-foundation.md §3.6. Builds on F4 (AR invoices carry
-- output VAT and an e-Faktur number) and F5 (AP bills carry input VAT and withholding).
--
-- F4 and F5 already RECORD the tax. F7 turns it into RETURNS, and adds the one rule in Indonesian
-- VAT with a direct money consequence:
--
--     an input VAT amount with no valid e-Faktur is NOT CREDITABLE
--
-- The company pays that VAT and cannot reclaim it. It is not a paperwork problem — it is a real
-- cost, and a system that quietly includes it in the claim overstates the refund and understates
-- expense. `finance_tax_ppn_summary()` therefore EXCLUDES it and reports it separately, so the
-- number lost is visible rather than absorbed.
--
-- ── WHAT THIS MIGRATION DOES NOT DO, AND MUST NOT ───────────────────────────────────────────────
-- It does not talk to Coretax. Blueprint §6 and owner ruling D-F2's explicit carve-out: e-Faktur
-- transmission goes through a licensed ASP/PJAP. "Ground up" applies to the ledger, not to becoming
-- a tax filing channel.
--
-- What F7 owns instead is the harder half: correct, complete tax DATA, and the RECONCILIATION
-- against what DJP thinks. Blueprint §3.6 names that as the operationally difficult part —
-- "monthly reconciliation between our ledger and Coretax's pre-populated data... a mismatch
-- unresolved by the due date means filing on a known inconsistency". `finance_coretax_extracts`
-- holds what DJP says; `finance_tax_coretax_reconcile()` compares it to what we say.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) finance_tax_codes — rates as DATA, per company, effective-dated.
--
-- ── WHY A SINGLE `rate` COLUMN CANNOT EXPRESS INDONESIAN PPN ────────────────────────────────────
-- Since 1 Jan 2025 the statutory rate is 12%, but for most domestic supplies it is applied to
-- ELEVEN TWELFTHS of the taxable base — which yields an effective 11%. That is not a discount and
-- not a different rate: it is a different BASE. Writing "11%" into a rate column loses the
-- distinction the tax office cares about, and writing "12%" without the multiplier overstates the
-- tax by ~9%.
--
-- So a code carries BOTH: `rate` (the statutory rate) and `base_multiplier` (the fraction of the
-- base it applies to). Tax = amount × base_multiplier × rate. For a 12% / (11/12) code that gives
-- the right number AND keeps the return able to say which rate was applied.
--
-- Effective dating is not optional either: an invoice raised in 2024 was 11% on the full base, and
-- re-rating history when the law changes is how a prior-period return stops reproducing.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE finance_tax_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  code          text NOT NULL,
  name          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN
                  ('ppn_output','ppn_input','pph21','pph23','pph42','pph_badan','exempt')),
  rate          numeric(9,6) NOT NULL CHECK (rate >= 0 AND rate <= 100),
  -- The fraction of the taxable base the rate applies to. 1 for everything except the
  -- 11/12 regime. numeric, not float — this multiplies money.
  base_multiplier numeric(12,10) NOT NULL DEFAULT 1 CHECK (base_multiplier > 0 AND base_multiplier <= 1),
  -- Where the tax lands in the ledger.
  account_id    uuid,
  effective_from date NOT NULL,
  effective_to   date,
  notes         text,
  origin_site   text NOT NULL DEFAULT 'central',
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_finance_tax_codes_account
    FOREIGN KEY (account_id, tenant_id) REFERENCES finance_accounts (id, tenant_id),
  CONSTRAINT ck_finance_tax_codes_dates CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT ux_finance_tax_codes_id_tenant UNIQUE (id, tenant_id),
  CONSTRAINT ux_finance_tax_codes_code_from UNIQUE (tenant_id, code, effective_from)
);
CREATE INDEX ix_finance_tax_codes_lookup ON finance_tax_codes (tenant_id, code, effective_from DESC);

COMMENT ON COLUMN finance_tax_codes.base_multiplier IS
  'The FRACTION OF THE BASE the rate applies to. Indonesian PPN since 2025-01-01 is a statutory 12% '
  'applied to 11/12 of the base (effective 11%). Storing "11%" loses what the tax office cares '
  'about; storing "12%" alone overstates the tax by ~9%. tax = amount * base_multiplier * rate.';

-- Compute tax the one correct way, so no caller re-derives it and drops the multiplier.
CREATE OR REPLACE FUNCTION finance_tax_compute(p_company uuid, p_code text, p_base numeric, p_on date)
  RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT round(p_base * t.base_multiplier * t.rate / 100, 4)
    FROM finance_tax_codes t
   WHERE t.tenant_id = p_company AND t.code = p_code
     AND p_on >= t.effective_from
     AND (t.effective_to IS NULL OR p_on <= t.effective_to)
   ORDER BY t.effective_from DESC
   LIMIT 1
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) finance_tax_returns — the filing record.
--
-- A return is a DOCUMENT with a lifecycle, not a query result. It matters that we can say "this is
-- the figure we filed on the 20th", separately from "this is what the data says today" — because
-- those diverge the moment a late invoice is booked, and an auditor asks about exactly that gap.
-- `filed_*` snapshots the numbers AS FILED.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE finance_tax_returns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  kind          text NOT NULL CHECK (kind IN ('ppn','pph21','pph23','pph42','pph_badan')),
  period_year   integer NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),
  -- NULL for an annual return (SPT Tahunan Badan).
  period_month  integer CHECK (period_month IS NULL OR period_month BETWEEN 1 AND 12),
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','filed','amended')),
  -- The numbers AS FILED. NULL while draft.
  filed_output  numeric(20,4),
  filed_input   numeric(20,4),
  filed_net     numeric(20,4),
  filed_at      timestamptz,
  filed_by      uuid REFERENCES users(id),
  -- The receipt/NTPN from the filing channel. Evidence the return was actually lodged.
  filing_reference text,
  notes         text,
  origin_site   text NOT NULL DEFAULT 'central',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_finance_tax_returns_period CHECK (period_end >= period_start),
  CONSTRAINT ck_finance_tax_returns_filed CHECK (
    (status = 'draft' AND filed_at IS NULL AND filed_by IS NULL)
    OR (status <> 'draft' AND filed_at IS NOT NULL)
  ),
  CONSTRAINT ux_finance_tax_returns_period UNIQUE (tenant_id, kind, period_year, period_month),
  CONSTRAINT ux_finance_tax_returns_id_tenant UNIQUE (id, tenant_id)
);
CREATE INDEX ix_finance_tax_returns_lookup ON finance_tax_returns (tenant_id, kind, period_year, period_month);

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (3) finance_tax_ppn_summary() — the SPT Masa PPN figure.
--
-- Output VAT (from AR invoices actually issued) less CREDITABLE input VAT (from AP bills that carry
-- an e-Faktur number). The uncreditable portion is reported SEPARATELY rather than silently
-- dropped: it is a real cost the business is absorbing, and the whole point of surfacing it is that
-- somebody chases the vendor for the faktur while there is still time.
--
-- Draft and void documents are excluded — a draft invoice has no output VAT because it does not
-- exist yet, and a voided one was reversed in the ledger.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_tax_ppn_summary(p_company uuid, p_from date, p_to date)
  RETURNS TABLE (
    output_vat            numeric,
    input_vat_creditable  numeric,
    input_vat_uncreditable numeric,
    net_payable           numeric
  ) LANGUAGE sql STABLE AS $$
  WITH out_vat AS (
    SELECT coalesce(sum(i.tax_total), 0) AS v
      FROM finance_ar_invoices i
     WHERE i.tenant_id = p_company
       AND i.status IN ('issued','paid')
       AND i.invoice_date BETWEEN p_from AND p_to
  ),
  in_vat AS (
    SELECT
      -- CREDITABLE only where an e-Faktur number is on file. Blueprint §3.6.
      coalesce(sum(b.tax_total) FILTER (
        WHERE b.efaktur_no IS NOT NULL AND length(btrim(b.efaktur_no)) > 0), 0) AS creditable,
      coalesce(sum(b.tax_total) FILTER (
        WHERE b.efaktur_no IS NULL OR length(btrim(b.efaktur_no)) = 0), 0) AS uncreditable
      FROM finance_ap_bills b
     WHERE b.tenant_id = p_company
       AND b.status IN ('approved','paid')
       AND b.bill_date BETWEEN p_from AND p_to
  )
  SELECT o.v, i.creditable, i.uncreditable, o.v - i.creditable
    FROM out_vat o, in_vat i
$$;
COMMENT ON FUNCTION finance_tax_ppn_summary(uuid,date,date) IS
  'SPT Masa PPN. Input VAT with no e-Faktur is NOT creditable and is excluded from the claim, then '
  'reported separately — it is a real cost being absorbed, and surfacing it is how somebody chases '
  'the vendor for the faktur while there is still time.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (4) finance_tax_pph_summary() — what e-Bupot needs.
--
-- Withholding is reported PER COUNTERPARTY, per code, per period, because a bukti potong is issued
-- to each vendor individually. A single total is useless for filing.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_tax_pph_summary(p_company uuid, p_from date, p_to date)
  RETURNS TABLE (
    withholding_code text,
    vendor_code      text,
    vendor_name      text,
    npwp             text,
    base_amount      numeric,
    withheld_amount  numeric,
    bill_count       bigint
  ) LANGUAGE sql STABLE AS $$
  SELECT b.withholding_code, v.code, v.name, v.npwp,
         sum(b.subtotal), sum(b.withholding_amount), count(*)
    FROM finance_ap_bills b
    JOIN finance_ap_vendors v ON v.id = b.vendor_id
   WHERE b.tenant_id = p_company
     AND b.status IN ('approved','paid')
     AND b.withholding_amount > 0
     AND b.bill_date BETWEEN p_from AND p_to
   GROUP BY b.withholding_code, v.code, v.name, v.npwp
   ORDER BY b.withholding_code, v.code
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (5) finance_tax_efaktur_exceptions() — the chase list.
--
-- Two different problems, deliberately reported as different kinds:
--
--   AR_MISSING_EFAKTUR   we billed VAT and have not issued a faktur. A COMPLIANCE failure — the
--                        customer cannot credit it either, and they will ask.
--   AP_INPUT_VAT_LOST    a vendor billed us VAT with no faktur. A MONEY loss — we pay it and
--                        cannot reclaim it.
--
-- Same symptom, opposite consequence, different person to chase. Merging them into "missing
-- e-Faktur" would send the wrong person.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_tax_efaktur_exceptions(p_company uuid, p_from date, p_to date)
  RETURNS TABLE (kind text, document_no text, counterparty text, doc_date date, tax_amount numeric, detail text)
  LANGUAGE sql STABLE AS $$
  SELECT 'AR_MISSING_EFAKTUR', i.invoice_no, c.name, i.invoice_date, i.tax_total,
         'output VAT billed with no e-Faktur issued — the customer cannot credit it either'
    FROM finance_ar_invoices i
    JOIN finance_ar_customers c ON c.id = i.customer_id
   WHERE i.tenant_id = p_company
     AND i.status IN ('issued','paid')
     AND i.tax_total > 0
     AND (i.efaktur_no IS NULL OR length(btrim(i.efaktur_no)) = 0)
     AND i.invoice_date BETWEEN p_from AND p_to
  UNION ALL
  SELECT 'AP_INPUT_VAT_LOST', b.bill_no, v.name, b.bill_date, b.tax_total,
         'input VAT NOT creditable without a vendor e-Faktur — this amount is a real cost'
    FROM finance_ap_bills b
    JOIN finance_ap_vendors v ON v.id = b.vendor_id
   WHERE b.tenant_id = p_company
     AND b.status IN ('approved','paid')
     AND b.tax_total > 0
     AND (b.efaktur_no IS NULL OR length(btrim(b.efaktur_no)) = 0)
     AND b.bill_date BETWEEN p_from AND p_to
   ORDER BY 1, 4, 2
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (6) Coretax extract + reconciliation — blueprint §3.6's hard part.
--
-- Coretax pre-fills PPN and PPh returns from e-invoices. The operationally demanding job is
-- monthly reconciliation between OUR ledger and THEIR pre-populated data; a mismatch unresolved by
-- the due date means filing on a known inconsistency.
--
-- We cannot call Coretax (that is the ASP's job), but we can hold what it says and compare. The
-- extract is imported and then read — the same posture as a bank statement, and for the same
-- reason: it is somebody else's record of events and editing it to agree proves nothing.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE finance_coretax_extracts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  direction     text NOT NULL CHECK (direction IN ('output','input')),
  period_year   integer NOT NULL,
  period_month  integer NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  efaktur_no    text NOT NULL,
  counterparty_npwp text,
  counterparty_name text,
  doc_date      date NOT NULL,
  base_amount   numeric(20,4) NOT NULL,
  tax_amount    numeric(20,4) NOT NULL,
  imported_at   timestamptz NOT NULL DEFAULT now(),
  imported_by   uuid REFERENCES users(id),
  CONSTRAINT ux_finance_coretax_extracts_no UNIQUE (tenant_id, direction, efaktur_no),
  CONSTRAINT ux_finance_coretax_extracts_id_tenant UNIQUE (id, tenant_id)
);
CREATE INDEX ix_finance_coretax_extracts_period
  ON finance_coretax_extracts (tenant_id, direction, period_year, period_month);

CREATE OR REPLACE FUNCTION finance_tax_coretax_reconcile(
  p_company uuid, p_year integer, p_month integer
) RETURNS TABLE (problem text, efaktur_no text, detail text)
LANGUAGE sql STABLE AS $$
  WITH bounds AS (
    SELECT make_date(p_year, p_month, 1) AS d_from,
           (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date AS d_to
  ),
  -- Ours, output side.
  ours AS (
    SELECT i.efaktur_no, i.tax_total AS tax, i.invoice_no AS doc
      FROM finance_ar_invoices i, bounds b
     WHERE i.tenant_id = p_company AND i.status IN ('issued','paid')
       AND i.invoice_date BETWEEN b.d_from AND b.d_to
       AND i.efaktur_no IS NOT NULL AND length(btrim(i.efaktur_no)) > 0
  ),
  theirs AS (
    SELECT e.efaktur_no, e.tax_amount AS tax
      FROM finance_coretax_extracts e
     WHERE e.tenant_id = p_company AND e.direction = 'output'
       AND e.period_year = p_year AND e.period_month = p_month
  )
  -- In our books, not in DJP's data: either never transmitted, or transmitted late.
  SELECT 'NOT_IN_CORETAX', o.efaktur_no,
         'invoice ' || o.doc || ' carries this faktur but DJP has no record for the period'
    FROM ours o WHERE NOT EXISTS (SELECT 1 FROM theirs t WHERE t.efaktur_no = o.efaktur_no)
  UNION ALL
  -- In DJP's data, not in ours: somebody issued a faktur outside the system.
  SELECT 'NOT_IN_LEDGER', t.efaktur_no,
         'DJP has this faktur for the period but no issued invoice in the ledger carries it'
    FROM theirs t WHERE NOT EXISTS (SELECT 1 FROM ours o WHERE o.efaktur_no = t.efaktur_no)
  UNION ALL
  -- Both have it and the numbers disagree — the case that quietly becomes an assessment.
  SELECT 'TAX_AMOUNT_MISMATCH', o.efaktur_no,
         'ledger ' || o.tax::text || ' vs DJP ' || t.tax::text ||
         ' (difference ' || (o.tax - t.tax)::text || ')'
    FROM ours o JOIN theirs t ON t.efaktur_no = o.efaktur_no
   WHERE o.tax <> t.tax
   ORDER BY 1, 2
$$;
COMMENT ON FUNCTION finance_tax_coretax_reconcile(uuid,integer,integer) IS
  'Blueprint 3.6''s hard part: our ledger vs DJP''s pre-populated data. One row per PROBLEM; EMPTY '
  'means they agree. A mismatch unresolved by the due date means filing on a known inconsistency.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (7) The finance third wall.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'finance_tax_codes','finance_tax_returns','finance_coretax_extracts'
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
