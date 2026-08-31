-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Tax return preparation — turning the ledger into a lodgeable SPT.
--
-- WHAT WAS MISSING. finance_tax_returns has existed since F7 as a table with nothing that writes to
-- it: the period summaries (finance_tax_ppn_summary, finance_tax_pph_summary) could compute the
-- numbers, and the table could hold a filed return, but there was no path between them. A period
-- could be closed without anyone ever being able to say what was owed.
--
-- THE DESIGN DECISION THAT MATTERS: A DRAFT STORES NO NUMBERS.
-- The table's own comment says filed_output/filed_input/filed_net are "the numbers AS FILED. NULL
-- while draft", and that is right, so this engine does not fight it. A draft return's figures are
-- recomputed from the ledger every time they are asked for, by finance_tax_return_figures(). They
-- are frozen into the row only at the moment of filing.
--
-- The alternative — stamping figures onto the draft at preparation time — would create a cache
-- with no drift detector, and every late journal in the period would silently make it wrong. This
-- estate has already shipped two functions that were confidently wrong for weeks; a stored draft
-- figure is the same shape of bug waiting to happen. Recomputing is cheap. Being quietly wrong
-- about what you owe the tax office is not.
--
-- WHAT IS DELIBERATELY NOT HERE. No e-filing, no ASP/PJAP transmission, no CoreTax API call. This
-- prepares a return and records that a human lodged it, with the receipt reference as evidence.
-- Actually transmitting it is a different capability with a different risk profile.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

-- ── (1) The period a return covers ───────────────────────────────────────────────────────────────
-- One place decides what "2026-03" means, so preparation, filing and amendment can never disagree
-- about the window they are summarising.
CREATE OR REPLACE FUNCTION finance_tax_return_period(p_year integer, p_month integer)
  RETURNS TABLE (period_start date, period_end date)
  LANGUAGE sql IMMUTABLE AS $$
  SELECT
    CASE WHEN p_month IS NULL THEN make_date(p_year, 1, 1)
         ELSE make_date(p_year, p_month, 1) END,
    CASE WHEN p_month IS NULL THEN make_date(p_year, 12, 31)
         ELSE (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date END
$$;

-- ── (2) finance_tax_return_figures() — the live computation ──────────────────────────────────────
-- The single source of the three numbers, used for the draft preview AND for the figures frozen at
-- filing. One implementation, so what you previewed is arithmetically what you filed.
CREATE OR REPLACE FUNCTION finance_tax_return_figures(
  p_company uuid, p_kind text, p_year integer, p_month integer DEFAULT NULL)
  RETURNS TABLE (output_amount numeric, input_amount numeric, net_amount numeric)
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_from date;
  v_to   date;
BEGIN
  IF p_kind NOT IN ('ppn','pph21','pph23','pph42','pph_badan') THEN
    RAISE EXCEPTION 'FINANCE_TAX_UNKNOWN_KIND: % is not a return kind', p_kind;
  END IF;

  SELECT period_start, period_end INTO v_from, v_to FROM finance_tax_return_period(p_year, p_month);

  IF p_kind = 'ppn' THEN
    -- PPN nets creditable input against output. Uncreditable input is a cost, not a credit, and is
    -- deliberately excluded here — including it would understate what is payable.
    RETURN QUERY
      SELECT coalesce(s.output_vat, 0),
             coalesce(s.input_vat_creditable, 0),
             coalesce(s.net_payable, 0)
        FROM finance_tax_ppn_summary(p_company, v_from, v_to) s;
    RETURN;
  END IF;

  -- Withholding returns: we are the withholding agent. Everything withheld in the period is
  -- remittable in full — there is no input side to offset, so net = output. Stating input as 0
  -- rather than NULL is deliberate: NULL would read as "unknown", and it is known to be nil.
  RETURN QUERY
    SELECT coalesce(sum(s.withheld_amount), 0),
           0::numeric,
           coalesce(sum(s.withheld_amount), 0)
      FROM finance_tax_pph_summary(p_company, v_from, v_to) s
      JOIN finance_tax_codes c
        ON c.tenant_id = p_company AND c.code = s.withholding_code
     WHERE c.kind = p_kind;
END $$;

-- ── (3) finance_tax_prepare_return() — create or refresh the draft shell ─────────────────────────
CREATE OR REPLACE FUNCTION finance_tax_prepare_return(
  p_company uuid, p_kind text, p_year integer, p_month integer DEFAULT NULL,
  p_actor uuid DEFAULT NULL)
  RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_from   date;
  v_to     date;
  v_id     uuid;
  v_status text;
BEGIN
  IF p_kind NOT IN ('ppn','pph21','pph23','pph42','pph_badan') THEN
    RAISE EXCEPTION 'FINANCE_TAX_UNKNOWN_KIND: % is not a return kind', p_kind;
  END IF;
  IF p_kind = 'pph_badan' AND p_month IS NOT NULL THEN
    RAISE EXCEPTION 'FINANCE_TAX_BADAN_IS_ANNUAL: SPT Tahunan Badan has no month — pass NULL';
  END IF;
  IF p_kind <> 'pph_badan' AND p_month IS NULL THEN
    RAISE EXCEPTION 'FINANCE_TAX_PERIODIC_NEEDS_MONTH: % is a monthly return — pass a month', p_kind;
  END IF;

  SELECT period_start, period_end INTO v_from, v_to FROM finance_tax_return_period(p_year, p_month);

  SELECT id, status INTO v_id, v_status FROM finance_tax_returns
   WHERE tenant_id = p_company AND kind = p_kind
     AND period_year = p_year AND period_month IS NOT DISTINCT FROM p_month;

  IF v_id IS NOT NULL THEN
    -- Already filed? Preparing again is not how you correct a lodged return — that is an amendment,
    -- and it must be an explicit act with its own reference.
    IF v_status <> 'draft' THEN
      RAISE EXCEPTION 'FINANCE_TAX_ALREADY_FILED: the % return for %-% is already %',
        p_kind, p_year, coalesce(p_month::text, 'annual'), v_status
        USING HINT = 'Use finance_tax_amend_return to correct a lodged return.';
    END IF;
    RETURN v_id;   -- idempotent: the draft holds no figures, so there is nothing to refresh
  END IF;

  INSERT INTO finance_tax_returns (tenant_id, kind, period_year, period_month,
                                   period_start, period_end, status)
  VALUES (p_company, p_kind, p_year, p_month, v_from, v_to, 'draft')
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

-- ── (4) finance_tax_file_return() — freeze the figures and record the lodgement ──────────────────
CREATE OR REPLACE FUNCTION finance_tax_file_return(
  p_return uuid, p_filing_reference text, p_actor uuid DEFAULT NULL)
  RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_ret finance_tax_returns%ROWTYPE;
  v_out numeric;
  v_in  numeric;
  v_net numeric;
BEGIN
  SELECT * INTO v_ret FROM finance_tax_returns WHERE id = p_return;
  IF v_ret.id IS NULL THEN
    RAISE EXCEPTION 'FINANCE_TAX_UNKNOWN_RETURN: no return %', p_return;
  END IF;
  IF v_ret.status <> 'draft' THEN
    RAISE EXCEPTION 'FINANCE_TAX_NOT_DRAFT: return is % — a lodged return is corrected by amendment',
      v_ret.status;
  END IF;
  IF p_filing_reference IS NULL OR btrim(p_filing_reference) = '' THEN
    RAISE EXCEPTION 'FINANCE_TAX_NO_FILING_REFERENCE: filing needs the receipt/NTPN as evidence'
      USING HINT = 'A return marked filed with no reference cannot be proven to have been lodged.';
  END IF;
  -- You cannot file a period that has not finished. Filing mid-period would freeze figures that
  -- the rest of the month is still going to change.
  IF v_ret.period_end >= CURRENT_DATE THEN
    RAISE EXCEPTION 'FINANCE_TAX_PERIOD_NOT_ENDED: period ends % — cannot file before it closes',
      v_ret.period_end;
  END IF;

  SELECT output_amount, input_amount, net_amount INTO v_out, v_in, v_net
    FROM finance_tax_return_figures(v_ret.tenant_id, v_ret.kind, v_ret.period_year, v_ret.period_month);

  UPDATE finance_tax_returns
     SET status = 'filed',
         filed_output = coalesce(v_out, 0),
         filed_input  = coalesce(v_in, 0),
         filed_net    = coalesce(v_net, 0),
         filed_at = now(), filed_by = p_actor,
         filing_reference = btrim(p_filing_reference),
         updated_at = now()
   WHERE id = p_return;

  RETURN p_return;
END $$;

-- ── (5) finance_tax_amend_return() — correct a lodged return ─────────────────────────────────────
-- Recomputes from the ledger as it now stands and restamps. The previous figures are not preserved
-- here; the audit trail for what changed lives in the ledger itself, which is immutable and
-- hash-chained. A separate revision history on this table would be a second, weaker record of the
-- same fact.
CREATE OR REPLACE FUNCTION finance_tax_amend_return(
  p_return uuid, p_filing_reference text, p_actor uuid DEFAULT NULL)
  RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_ret finance_tax_returns%ROWTYPE;
  v_out numeric;
  v_in  numeric;
  v_net numeric;
BEGIN
  SELECT * INTO v_ret FROM finance_tax_returns WHERE id = p_return;
  IF v_ret.id IS NULL THEN
    RAISE EXCEPTION 'FINANCE_TAX_UNKNOWN_RETURN: no return %', p_return;
  END IF;
  IF v_ret.status = 'draft' THEN
    RAISE EXCEPTION 'FINANCE_TAX_NOTHING_TO_AMEND: return is still a draft — file it first';
  END IF;
  IF p_filing_reference IS NULL OR btrim(p_filing_reference) = '' THEN
    RAISE EXCEPTION 'FINANCE_TAX_NO_FILING_REFERENCE: an amendment needs its own receipt/NTPN';
  END IF;

  SELECT output_amount, input_amount, net_amount INTO v_out, v_in, v_net
    FROM finance_tax_return_figures(v_ret.tenant_id, v_ret.kind, v_ret.period_year, v_ret.period_month);

  UPDATE finance_tax_returns
     SET status = 'amended',
         filed_output = coalesce(v_out, 0),
         filed_input  = coalesce(v_in, 0),
         filed_net    = coalesce(v_net, 0),
         filed_at = now(), filed_by = p_actor,
         filing_reference = btrim(p_filing_reference),
         updated_at = now()
   WHERE id = p_return;

  RETURN p_return;
END $$;

-- ── (6) finance_tax_return_drift() — has the ledger moved since we filed? ────────────────────────
-- The one check that makes filing safe to trust later. A late journal posted into a filed period
-- changes what was owed; nothing else in the system would ever say so. This does, per return, in
-- the same shape as the other finance reconcilers so it can join a close checklist.
CREATE OR REPLACE FUNCTION finance_tax_return_drift(p_company uuid)
  RETURNS TABLE (problem text, detail text)
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  r     finance_tax_returns%ROWTYPE;
  v_net numeric;
BEGIN
  FOR r IN
    SELECT * FROM finance_tax_returns
     WHERE tenant_id = p_company AND status IN ('filed','amended')
  LOOP
    SELECT net_amount INTO v_net
      FROM finance_tax_return_figures(r.tenant_id, r.kind, r.period_year, r.period_month);
    IF coalesce(v_net, 0) <> coalesce(r.filed_net, 0) THEN
      problem := 'TAX_RETURN_LEDGER_DRIFT';
      detail  := r.kind || ' ' || r.period_year::text || '-' ||
                 coalesce(lpad(r.period_month::text, 2, '0'), 'annual') ||
                 ': filed net ' || coalesce(r.filed_net, 0)::text ||
                 ' but the ledger now computes ' || coalesce(v_net, 0)::text ||
                 ' (difference ' || (coalesce(v_net, 0) - coalesce(r.filed_net, 0))::text ||
                 ') — a journal was posted into a filed period';
      RETURN NEXT;
    END IF;
  END LOOP;
END $$;
