-- Finance UI-01d / UI-02c / UI-02d — THE GUARDS THAT MAKE THESE SURFACES SAFE TO EDIT.
--
-- Ownership and accounting settings are about to become editable by a person rather than only by a
-- seed. Three things then become reachable that were not before, and each is enforced in the
-- database rather than in the form, because a form is one caller among several (a seed, an agent,
-- n8n) and the rule has to hold for all of them.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) UI-02d — turning PKP OFF with PPN already posted
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- ★ A company that has charged output VAT has a liability to the tax office. Flipping `is_pkp` to
-- false does not undo that: it orphans the tax already collected, hides the account from the F7
-- surface, and leaves a real statutory debt with nothing pointing at it.
--
-- The same reasoning as a locked period — the request is well-formed and the state says no.
CREATE OR REPLACE FUNCTION finance_settings_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_ppn numeric;
BEGIN
  IF OLD.is_pkp AND NOT NEW.is_pkp THEN
    SELECT COALESCE(sum(m.balance), 0) INTO v_ppn
      FROM finance_account_movement(NEW.tenant_id, NULL, NULL) m
      JOIN finance_accounts a ON a.id = m.account_id
     WHERE a.code IN ('2140', '1170');   -- PPN keluaran, PPN masukan
    IF v_ppn <> 0 THEN
      RAISE EXCEPTION
        'FINANCE_PKP_HAS_POSTED_VAT: this company has PPN posted (balance %). Turning PKP off would '
        'orphan tax already charged and owed to the tax office.', v_ppn
        USING HINT = 'Settle or reverse the VAT first, or keep PKP on and stop issuing taxable invoices.';
    END IF;
  END IF;

  -- The fiscal year start cannot move once a calendar has been cut. Every period boundary, every
  -- balance sheet's `fyStart` and every year-end close is derived from it; changing it silently
  -- re-dates history that has already been reported.
  IF NEW.fiscal_year_start_month IS DISTINCT FROM OLD.fiscal_year_start_month
     AND EXISTS (SELECT 1 FROM finance_fiscal_periods p WHERE p.tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION
      'FINANCE_FY_START_LOCKED: the fiscal calendar is already cut; the year start cannot move'
      USING HINT = 'A different year start needs a new fiscal year, not an edit to this one.';
  END IF;

  RETURN NEW;
END $$;
CREATE TRIGGER trg_finance_settings_guard
  BEFORE UPDATE ON finance_company_settings
  FOR EACH ROW EXECUTE FUNCTION finance_settings_guard();

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) UI-02c — the NPWP is a national-ID-shaped value
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Program rule: scrub PAN/national-ID-shaped values before persist. An NPWP is exactly that shape.
--
-- What this does NOT do is encrypt it here: the estate's crypto lives in the application layer with
-- a two-axis subject x entity key, and a plpgsql copy would be a second implementation of the most
-- security-sensitive code in the system. What it DOES do is normalise and validate, so a
-- mistyped or partial NPWP is rejected at the boundary rather than stored and later transmitted to
-- Coretax where it fails for reasons nobody can trace back here.
CREATE OR REPLACE FUNCTION finance_normalise_npwp() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_digits text;
BEGIN
  IF NEW.npwp IS NULL OR btrim(NEW.npwp) = '' THEN
    NEW.npwp := NULL;
    RETURN NEW;
  END IF;
  v_digits := regexp_replace(NEW.npwp, '[^0-9]', '', 'g');
  -- 15 digits historically, 16 under the NIK-as-NPWP transition. Both are current, so both pass.
  IF length(v_digits) NOT IN (15, 16) THEN
    RAISE EXCEPTION
      'FINANCE_NPWP_INVALID: an NPWP has 15 or 16 digits, got % — check the value before it reaches '
      'a tax filing', length(v_digits);
  END IF;
  NEW.npwp := v_digits;   -- stored bare; formatting is a presentation concern
  RETURN NEW;
END $$;
CREATE TRIGGER trg_finance_normalise_npwp
  BEFORE INSERT OR UPDATE ON finance_company_settings
  FOR EACH ROW EXECUTE FUNCTION finance_normalise_npwp();

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (3) UI-01d — a cap table that totals more than 100%
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- The column CHECK caps a SINGLE row at 100. Nothing sums them, so ten holders at 20% each is
-- accepted and the company reads as 200% owned — which then flows into NCI and the group's equity.
--
-- Reported rather than rejected, deliberately. A cap table is entered one row at a time and passes
-- through invalid intermediate states on the way to a correct one; refusing the fourth row of a
-- four-row entry would make the surface unusable. The UI shows this and the consolidation refuses
-- to rely on it — the same split as the close checklist: warn while editing, block at the gate.
CREATE OR REPLACE FUNCTION finance_ownership_problems(p_company uuid, p_as_of date DEFAULT NULL)
  RETURNS TABLE (problem text, detail text)
  LANGUAGE plpgsql STABLE AS $$
DECLARE v_total numeric;
BEGIN
  SELECT COALESCE(sum(o.stake_pct), 0) INTO v_total
    FROM company_ownership o
   WHERE o.tenant_id = p_company
     AND o.deleted_at IS NULL
     AND (p_as_of IS NULL
          OR (o.effective_from <= p_as_of AND (o.effective_to IS NULL OR o.effective_to > p_as_of)))
     AND (p_as_of IS NOT NULL OR o.effective_to IS NULL);

  IF v_total > 100 THEN
    RETURN QUERY SELECT 'STAKE_EXCEEDS_100'::text,
      'live stakes total ' || v_total::text || '% — a company cannot be more than wholly owned';
  ELSIF v_total > 0 AND v_total < 100 THEN
    -- NOT an error. A partially-recorded cap table is the normal state of a real one: minority
    -- holders are often unknown to the group. Said out loud so nobody reads the gap as 100%.
    RETURN QUERY SELECT 'STAKE_INCOMPLETE'::text,
      'live stakes total ' || v_total::text || '% — the remaining ' || (100 - v_total)::text ||
      '% is not recorded, which is not the same as nobody holding it';
  END IF;

  -- Two live edges for the same holder is a data error the partial unique indexes already prevent
  -- for the same holder id, but a person AND a company edge can both exist and double-count.
  RETURN QUERY
    SELECT 'DUPLICATE_HOLDER'::text,
           'more than one live edge resolves to the same holder for this company'
      FROM company_ownership o
     WHERE o.tenant_id = p_company AND o.deleted_at IS NULL AND o.effective_to IS NULL
     GROUP BY COALESCE(o.holder_user_id, o.holder_company_id)
    HAVING count(*) > 1;
END $$;
COMMENT ON FUNCTION finance_ownership_problems(uuid, date) IS
  'UI-01d: cap-table validation. REPORTS rather than rejects — a cap table passes through invalid '
  'intermediate states while being entered one row at a time, and refusing the fourth row of a '
  'four-row entry would make the surface unusable. Warn while editing, block at the gate.';
