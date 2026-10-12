-- 202610131800_pv5_enforce_invoice_issued.sql — PV-5 / PV5-01b, INVOICE HALF: an invoice is `sent` or `paid` only if issued.
-- Plan: docs/plans/2026-10-12-pv5-contracts-billing-tickets.md (PV5-01 "As built", PV5-04; decision 2). Part (a): 202610130400.
--
-- WHERE THIS CAME FROM
--   PV5-01b was written as ONE migration (branch pv5/01b-enforcement, 202610130430_pv5_enforce_issue_and_fixed_content.sql)
--   enforcing two rules: the invoice rule below and the contract content-fixed rule. The lead split it: the INVOICE half
--   ships here with PV5-04 (the issue path that satisfies it); the CONTRACT half ships with PV5-06. Nothing of the contract
--   half is in this file. The guard function is therefore named for invoices alone (pv5_invoices_legacy_flag_guard), so
--   the contract half can create its own without a name collision or a shared function body to keep in step.
--
-- WHAT THIS ENFORCES
--   invoices_sent_paid_issued: status IN ('sent','paid') requires issued_at, i.e. the invoice went through PV5-04's issue
--   (POST /api/:t/invoices/:id/issue), which numbers it and posts the matching ledger AR invoice in one transaction.
--   The PATCH route no longer accepts sent or paid (PV5-04), and paid is derived from AR allocations.
--
-- ── THE LEGACY EXEMPTION: a flag column, NOT a date bound ─────────────────────────────────────────────
-- Rows that are sent/paid when this file runs were never issued and cannot be (nothing records a number, a tax
-- computation or an issuer for them). They are exempt. A CHECK like `created_at < '2026-10-13'` would be reachable by
-- new rows (a client may supply created_at; a backdated INSERT would claim the exemption), so the exemption is
-- `pre_pv5_legacy boolean NOT NULL DEFAULT false`, and:
--   * only THIS migration sets it true (the backfill below, which runs before the guard exists);
--   * a BEFORE INSERT OR UPDATE trigger refuses any row carrying true unless it is an UPDATE that leaves the column
--     unchanged, so no INSERT and no UPDATE can claim, grant, or remove it;
--   * it is exactly scoped: status sent/paid and issued_at NULL. A legacy DRAFT or APPROVED invoice is NOT flagged: it
--     can still be issued through the new flow and must then satisfy the check.
-- A legacy flagged row may still move sent -> paid (a confirmed claim on it, the pre-PV-5 behaviour, kept for these
-- rows only) and to void; PV5-04 accepts no NEW payment claim on it (it is not issued).
-- The guard is a trigger, which a superuser can disable; that is the same trust boundary as every other trigger and is
-- how the tests build a "legacy" row. No application role can.
--
-- ── BACKFILL AND THE ZERO-ROW TRAP ────────────────────────────────────────────────────────────────────
-- The migration owner is NOBYPASSRLS and invoices is FORCE RLS, so a bare UPDATE would silently match zero rows. The
-- backfill runs per company with app.current_tenant_ids set (0051/0108 idiom). ADD CONSTRAINT then VALIDATES every
-- existing row by a heap scan that does not go through RLS, so a row the backfill missed fails the migration loudly
-- rather than shipping. The number of rows exempted is printed as a NOTICE ("[PV5-01b] ..."); read it from the deploy
-- log (live data is seed; expected: the seed's sent/paid invoices).
--
-- ── ROLLOUT ───────────────────────────────────────────────────────────────────────────────────────────
-- Ships in the same release as PV5-04's code and seed/fixture changes (the code on main before PV5-04 PATCHes invoices
-- to sent/paid, which this refuses). The backfill UPDATE touches only legacy rows and fires no immutability trigger
-- (those rows have issued_at NULL). Brief ACCESS EXCLUSIVE lock on invoices (a small table).
-- Reverse: DROP CONSTRAINT invoices_sent_paid_issued; DROP TRIGGER trg_invoices_pv5_legacy_guard; DROP FUNCTION
-- pv5_invoices_legacy_flag_guard(); ALTER TABLE invoices DROP COLUMN pre_pv5_legacy.
-- No secrets; no company names or ids.

ALTER TABLE invoices ADD COLUMN pre_pv5_legacy boolean NOT NULL DEFAULT false;

-- ── backfill, per company (RLS) ──────────────────────────────────────────────────────────────────
DO $$
DECLARE
  co RECORD;
  n_inv integer;
  total_inv integer := 0;
BEGIN
  FOR co IN SELECT id FROM companies ORDER BY id LOOP
    PERFORM set_config('app.current_tenant_ids', co.id::text, true);

    UPDATE invoices
       SET pre_pv5_legacy = true
     WHERE status IN ('sent', 'paid') AND issued_at IS NULL;
    GET DIAGNOSTICS n_inv = ROW_COUNT;
    total_inv := total_inv + n_inv;
  END LOOP;
  PERFORM set_config('app.current_tenant_ids', '', true);
  RAISE NOTICE '[PV5-01b] legacy sent/paid invoices exempted: % row(s)', total_inv;
END $$;

-- ── the guard: nothing but this file may ever set the flag ───────────────────────────────────────
-- Written for `invoices` only. OLD is touched only on UPDATE, in a nested IF: plpgsql does not promise AND
-- short-circuiting, and OLD is unassigned in an INSERT trigger.
CREATE OR REPLACE FUNCTION pv5_invoices_legacy_flag_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.pre_pv5_legacy THEN
      RAISE EXCEPTION 'PV5_LEGACY_FLAG: pre_pv5_legacy cannot be set on a new invoices row'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW.pre_pv5_legacy IS DISTINCT FROM OLD.pre_pv5_legacy THEN
      RAISE EXCEPTION 'PV5_LEGACY_FLAG: pre_pv5_legacy cannot be changed on invoices row %', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_invoices_pv5_legacy_guard
  BEFORE INSERT OR UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION pv5_invoices_legacy_flag_guard();

-- ── the enforcing CHECK (validated against every existing row) ───────────────────────────────────
ALTER TABLE invoices
  ADD CONSTRAINT invoices_sent_paid_issued CHECK (
    status NOT IN ('sent', 'paid') OR issued_at IS NOT NULL OR pre_pv5_legacy
  );

-- ── self-assertion ───────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_sent_paid_issued' AND contype = 'c' AND convalidated) THEN
    RAISE EXCEPTION 'PV5-01b: CHECK invoices_sent_paid_issued is missing or not validated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_invoices_pv5_legacy_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'PV5-01b: trigger trg_invoices_pv5_legacy_guard is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'invoices' AND column_name = 'pre_pv5_legacy'
                AND (column_default IS DISTINCT FROM 'false' OR is_nullable <> 'NO')) THEN
    RAISE EXCEPTION 'PV5-01b: invoices.pre_pv5_legacy must be NOT NULL DEFAULT false';
  END IF;
END $$;

COMMENT ON COLUMN invoices.pre_pv5_legacy IS
  'PV5-01b: true only for sent/paid rows that existed when PV-5 landed with no issue record. Set by the migration alone; a trigger refuses any insert or update that sets or changes it.';
