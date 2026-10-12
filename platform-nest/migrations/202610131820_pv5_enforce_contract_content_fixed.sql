-- 202610131820_pv5_enforce_contract_content_fixed.sql — PV-5 / PV5-06 (the CONTRACT half of PV5-01b).
-- Plan: docs/plans/2026-10-12-pv5-contracts-billing-tickets.md (PV5-01 "As built", PV5-06; decisions 11 and 13).
-- Part (a) is 202610130400 (the columns, format checks and the freeze trigger). The INVOICE half of 01b
-- (invoices_sent_paid_issued, invoices.pre_pv5_legacy) belongs to PV5-04 and is NOT in this file.
--
-- WHAT THIS ENFORCES
--   A contract that has been sent must carry its content hash, the time it was fixed, and its signature tier.
--   The code that satisfies it ships in the same change (PV5-06: `POST /contracts/:id/send` computes and stores
--   all three in the one UPDATE), together with every fixture and seed that sent a contract with no hash.
--
-- ── THE LEGACY EXEMPTION: a flag column, NOT a date bound ─────────────────────────────────────────────
-- Contracts that exist when this file runs and were sent with no hash cannot be repaired (nothing recorded what
-- they said when they were signed), so they are exempt. A CHECK like `created_at < '2026-10-13'` would be reachable
-- by new rows (a client may supply created_at, so an INSERT could claim the exemption by backdating). So the
-- exemption is `pre_pv5_legacy boolean NOT NULL DEFAULT false`, and:
--   * only THIS migration sets it true (the backfill below, before the guard exists);
--   * a BEFORE INSERT OR UPDATE trigger refuses any row that carries true unless it is an UPDATE that leaves the
--     column unchanged, so no INSERT and no UPDATE can ever claim, grant or remove it;
--   * it is exactly scoped: contracts with status <> 'draft' that were actually sent. A legacy DRAFT contract is
--     NOT flagged: it is sent through the new flow and must then satisfy the CHECK.
-- The guard function is `pv5_legacy_flag_guard()`, the SAME name and body PV5-04's invoice half uses (it names only
-- the column both tables share), so whichever migration runs second simply CREATE OR REPLACEs an identical function.
-- The guard is a trigger, which a superuser can disable; that is the same trust boundary as every other trigger and
-- is how the tests build a "legacy" row. No application role can.
--
-- ── VOID BEFORE SEND stays possible ───────────────────────────────────────────────────────────────────
-- contracts PATCH allows `void` from a draft ("from anywhere"). The ticket text says "every non-draft row", which would
-- have blocked cancelling a draft, so a contract that was never sent (status void, sent_at NULL) is exempt from the
-- content requirement. DEVIATION from the ticket text, stated for review.
--
-- ── BACKFILL AND THE ZERO-ROW TRAP ────────────────────────────────────────────────────────────────────
-- The migration owner is NOBYPASSRLS and contracts is FORCE RLS, so a bare UPDATE would silently match zero rows. The
-- backfill runs per company with app.current_tenant_ids set (0051/0108 idiom). The ADD CONSTRAINT then VALIDATES every
-- existing row by a heap scan that does not go through RLS, so a row the backfill missed fails the migration loudly
-- rather than shipping.
-- The number of rows exempted is printed as a NOTICE ("[PV5-06] ..."); read it from the deploy log. (Live data is
-- seed; the count is expected to be the seed's sent/signed contracts.)
--
-- ── ROLLOUT ───────────────────────────────────────────────────────────────────────────────────────────
-- Ships WITH the PV5-06 code. The backfill UPDATE touches only legacy rows and fires no immutability trigger (those
-- rows have content_fixed_at NULL). Reverse: DROP the constraint, the trigger and the column (keep the function if the
-- invoice half is installed).
-- No secrets; no company names or ids.

ALTER TABLE contracts ADD COLUMN pre_pv5_legacy boolean NOT NULL DEFAULT false;

-- ── backfill, per company (RLS) ──────────────────────────────────────────────────────────────────
DO $$
DECLARE
  co RECORD;
  n_con integer;
  total_con integer := 0;
BEGIN
  FOR co IN SELECT id FROM companies LOOP
    PERFORM set_config('app.current_tenant_ids', co.id::text, true);

    -- Existing sent/signed (and any other sent-then-closed) rows: tier attested, hash left NULL, exempt.
    -- A void row that was never sent needs neither.
    UPDATE contracts
       SET pre_pv5_legacy = true, signature_tier = 'attested'
     WHERE status <> 'draft'
       AND content_fixed_at IS NULL
       AND NOT (status = 'void' AND sent_at IS NULL);
    GET DIAGNOSTICS n_con = ROW_COUNT;
    total_con := total_con + n_con;
  END LOOP;
  PERFORM set_config('app.current_tenant_ids', '', true);
  RAISE NOTICE '[PV5-06] legacy non-draft contracts marked attested and exempted: % row(s)', total_con;
END $$;

-- DDL below refuses to run while a deferrable constraint trigger is pending on a table this transaction wrote
-- ("cannot ALTER TABLE ... because it has pending trigger events"); contracts carries two DEFERRABLE FKs (PV4-01).
-- The backfill touches no FK column so none should be pending, but this makes the order safe regardless of data.
SET CONSTRAINTS ALL IMMEDIATE;

-- ── the guard: nothing but this file may ever set the flag ───────────────────────────────────────
-- Names only the column both tables share (contracts here, invoices in PV5-04), so one function is safe for both.
-- OLD is touched only on UPDATE, in a nested IF: plpgsql does not promise AND short-circuiting, and OLD is
-- unassigned in an INSERT trigger.
CREATE OR REPLACE FUNCTION pv5_legacy_flag_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.pre_pv5_legacy THEN
      RAISE EXCEPTION 'PV5_LEGACY_FLAG: pre_pv5_legacy cannot be set on a new % row', TG_TABLE_NAME
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW.pre_pv5_legacy IS DISTINCT FROM OLD.pre_pv5_legacy THEN
      RAISE EXCEPTION 'PV5_LEGACY_FLAG: pre_pv5_legacy cannot be changed on % row %', TG_TABLE_NAME, OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_contracts_pv5_legacy_guard
  BEFORE INSERT OR UPDATE ON contracts
  FOR EACH ROW EXECUTE FUNCTION pv5_legacy_flag_guard();

-- ── the enforcing CHECK (validated against every existing row) ───────────────────────────────────
ALTER TABLE contracts
  ADD CONSTRAINT contracts_content_fixed_when_sent CHECK (
    status = 'draft'
    OR (status = 'void' AND sent_at IS NULL)
    OR pre_pv5_legacy
    OR (content_sha256 IS NOT NULL AND content_fixed_at IS NOT NULL AND signature_tier IS NOT NULL)
  );

-- ── self-assertion ───────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contracts_content_fixed_when_sent' AND contype = 'c' AND convalidated) THEN
    RAISE EXCEPTION 'PV5-06: CHECK contracts_content_fixed_when_sent is missing or not validated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_contracts_pv5_legacy_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'PV5-06: trigger trg_contracts_pv5_legacy_guard is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'contracts' AND column_name = 'pre_pv5_legacy' AND column_default <> 'false') THEN
    RAISE EXCEPTION 'PV5-06: contracts.pre_pv5_legacy must default to false';
  END IF;
END $$;

COMMENT ON COLUMN contracts.pre_pv5_legacy IS
  'PV5-06: true only for non-draft rows that existed when PV-5 landed with no content hash (tier attested). Set by the migration alone; a trigger refuses any insert or update that sets or changes it.';
