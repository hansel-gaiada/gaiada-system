-- 202610132208_pv5_legacy_flag_unissued_void_invoices.sql — PV5-F1: a `void` invoice that was never issued is not shown to the client.
-- Plan: docs/plans/2026-10-12-pv5-contracts-billing-tickets.md (PV5-01b, PV5-04). Builds on 202610131850.
--
-- WHY
--   `invoiceClientVisible` (core/portal-visibility.ts) used to admit every non-deleted invoice that is not draft or
--   approved, so a DRAFT that staff voided before it was ever issued appeared in the client's portal. The client never
--   received such an invoice. The predicate now admits a `void` invoice only if it was issued (`issued_at IS NOT NULL`)
--   OR it predates PV-5 (`pre_pv5_legacy`). Rows from before PV-5 carry no issue record, so without the flag this change
--   would hide old voided invoices the client could see until now. This file flags exactly those, keeping their
--   visibility unchanged.
--
-- WHAT IT FLAGS
--   Every `void` invoice with `issued_at IS NULL` that was created before PV-5 shipped its issue path (the instant
--   202610131850 is stamped, 2026-10-13 18:50 UTC). Voided invoices created after that instant, and issued ones, are
--   not flagged: the first are drafts the client was never sent, the second are visible through `issued_at`.
--   A row created before the cutoff and voided after it is flagged too (it existed in the pre-PV-5 world; the column
--   cannot tell when it was voided). That is the deliberate, conservative direction: it stays as visible as it was.
--
-- THE GUARD
--   `trg_invoices_pv5_legacy_guard` refuses any change to the flag, by design, so the backfill disables it for the
--   statement and re-enables it in the same transaction. Only the migration owner can; no application role.
--
-- THE ZERO-ROW TRAP
--   The migration owner is NOBYPASSRLS and invoices is FORCE RLS: a bare UPDATE would silently match zero rows. The
--   backfill runs per company with app.current_tenant_ids set (0051/0108/1850 idiom). The count is printed as a NOTICE
--   ("[PV5-F1] ...") and asserted below: no pre-cutoff unissued void may be left unflagged.
--
-- Reverse (data only): UPDATE invoices SET pre_pv5_legacy = false WHERE status = 'void' AND issued_at IS NULL, with the
-- guard disabled, then revert the predicate. No secrets; no company names or ids.

DO $$
DECLARE
  cutoff constant timestamptz := timestamptz '2026-10-13 18:50:00+00';
  co RECORD;
  n_inv integer;
  total_inv integer := 0;
  left_over integer := 0;
  n integer;
BEGIN
  IF to_regclass('public.invoices') IS NULL OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'pre_pv5_legacy') THEN
    RAISE EXCEPTION 'PV5-F1: invoices.pre_pv5_legacy is missing; 202610131850 must run before this file';
  END IF;

  ALTER TABLE invoices DISABLE TRIGGER trg_invoices_pv5_legacy_guard;

  FOR co IN SELECT id FROM companies ORDER BY id LOOP
    PERFORM set_config('app.current_tenant_ids', co.id::text, true);

    UPDATE invoices
       SET pre_pv5_legacy = true
     WHERE status = 'void' AND issued_at IS NULL AND NOT pre_pv5_legacy AND created_at < cutoff;
    GET DIAGNOSTICS n_inv = ROW_COUNT;
    total_inv := total_inv + n_inv;

    SELECT count(*) INTO n FROM invoices
     WHERE status = 'void' AND issued_at IS NULL AND NOT pre_pv5_legacy AND created_at < cutoff;
    left_over := left_over + n;
  END LOOP;
  PERFORM set_config('app.current_tenant_ids', '', true);

  ALTER TABLE invoices ENABLE TRIGGER trg_invoices_pv5_legacy_guard;

  RAISE NOTICE '[PV5-F1] pre-PV-5 unissued void invoices flagged legacy: % row(s)', total_inv;
  IF left_over <> 0 THEN
    RAISE EXCEPTION 'PV5-F1: % pre-PV-5 unissued void invoice(s) were not flagged (RLS zero-row trap?)', left_over;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_invoices_pv5_legacy_guard' AND NOT tgisinternal AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'PV5-F1: trg_invoices_pv5_legacy_guard is missing or not enabled';
  END IF;
END $$;
