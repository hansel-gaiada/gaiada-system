-- 202610132215_pv5_legacy_flag_unissued_void_invoices.sql — PV5-F1: a `void` invoice that was never issued is not shown to the client.
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
--   Every `void` invoice with `issued_at IS NULL` that was created before PV-5's invoice rule was APPLIED, i.e. before the
--   `applied_at` that the runner's ledger (`schema_migrations`) recorded for 202610131850_pv5_enforce_invoice_issued.sql.
--   Voided invoices created after that instant are drafts the client was never sent, and issued ones are visible through
--   `issued_at`: neither is flagged.
--   WHY THE LEDGER AND NOT THE FILENAME: a filename stamp is not a real time in this repo (sessions pick future-ish minutes;
--   1850 is stamped 18:50Z but was applied on live hours earlier). A literal cutoff taken from the stamp would lie in the
--   future and flag every unissued void created since PV-5 went live as legacy, keeping the very bug this closes. So the
--   cutoff is read from the ledger, and if 1850's row is missing this file refuses to run (never a literal fallback).
--   On a fresh database (CI) 1850's applied_at is moments before this file, so nothing qualifies.
--   LEDGER-LESS BUILDS: the sync-engine-go CI job applies every migration with `psql -f`, with no `schema_migrations`
--   table at all. There 1850 ran moments earlier in the same batch, so `now()` is the right cutoff and the file says so
--   in a NOTICE. If the table EXISTS but has no row for 1850, that is a real fault (the runner records every file) and
--   the file refuses to run. The table is only touched through dynamic SQL after to_regclass() says it exists.
--   A row created before the cutoff and voided after it is flagged too (the column cannot tell when it was voided): the
--   conservative direction, it stays as visible as it was.
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
  cutoff timestamptz;
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

  IF to_regclass('public.schema_migrations') IS NULL THEN
    cutoff := now();
    RAISE NOTICE '[PV5-F1] no schema_migrations ledger here (psql -f build); using now() as the cutoff';
  ELSE
    EXECUTE 'SELECT applied_at FROM schema_migrations WHERE name = $1' INTO cutoff USING '202610131850_pv5_enforce_invoice_issued.sql';
    IF cutoff IS NULL THEN
      RAISE EXCEPTION 'PV5-F1: schema_migrations has no applied_at for 202610131850_pv5_enforce_invoice_issued.sql; it must run first';
    END IF;
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

  RAISE NOTICE '[PV5-F1] pre-PV-5 unissued void invoices flagged legacy (cutoff %): % row(s)', cutoff, total_inv;
  IF left_over <> 0 THEN
    RAISE EXCEPTION 'PV5-F1: % pre-PV-5 unissued void invoice(s) were not flagged (RLS zero-row trap?)', left_over;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_invoices_pv5_legacy_guard' AND NOT tgisinternal AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'PV5-F1: trg_invoices_pv5_legacy_guard is missing or not enabled';
  END IF;
END $$;
