-- webdesk/migrations/0018_ws4_assertion_version.sql
-- WebDesk M4 F1 (docs/plans/2026-10-11-webdesk-m4-plan.md, "F1 · WS4 approval assertion made asymmetric"):
-- one additive, nullable column on `audit_entries`.
--
--   ws4_assertion_version smallint — which WS4 assertion Layer 4 verified for the row's ws4_approval_id:
--                                    1 = v1 (HMAC-SHA256, the shared key being retired),
--                                    2 = v2 (Ed25519 JWS, WebDesk holds only the public key).
--                                    NULL = not recorded: every row from before 0018, every row with no
--                                    approval, and a row whose approval this api instance did not verify
--                                    (the dev-mode policy decision point). Never a guess.
--
-- Why it exists: phase 2 of F1 proves "one HIGH command executes and its audit row says v2", and phase 3
-- (removing the HMAC key) is only safe once the rows show no v1 is still arriving. The application writes
-- it (src/audit/audit.service.ts, from src/control/auth/ws4-verified-version.ts); nothing here infers it.
--
-- The CHECK allows exactly NULL, 1 or 2, and a version only beside an approval id: a version on a row
-- that claims no approval would be a meaningless record. Every existing row is NULL, so validating the
-- constraint at ADD time reads the table once and cannot fail.
--
-- The WS4 single-use index (0009 ux_audit_entries_ws4_once, on ws4_approval_id over non-replay rows) is
-- untouched: the version is NOT part of the dedup key, so one approval cannot be used once as v1 and
-- once as v2.
--
-- RLS and grants: nothing to do. audit_entries keeps its FORCE ROW LEVEL SECURITY dual-mode policy (0001,
-- 0009), and a new column of an existing table inherits the table-level grants, including the
-- UPDATE/DELETE claw-back that keeps audit append-only (0001) and the webdesk_backup SELECT (WSK-68).
--
-- No DML, so this file is clear of the RLS zero-row trap (lint-migration-rls.mjs). Re-runnable: IF NOT
-- EXISTS on the column, a catalog guard on the constraint.

ALTER TABLE audit_entries ADD COLUMN IF NOT EXISTS ws4_assertion_version smallint;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ck_audit_entries_ws4_assertion_version'
       AND conrelid = 'public.audit_entries'::regclass
  ) THEN
    ALTER TABLE audit_entries ADD CONSTRAINT ck_audit_entries_ws4_assertion_version
      CHECK (ws4_assertion_version IS NULL OR (ws4_assertion_version IN (1, 2) AND ws4_approval_id IS NOT NULL));
  END IF;
END
$$;

COMMENT ON COLUMN audit_entries.ws4_assertion_version IS
  'M4 F1: the WS4 assertion version Layer 4 verified for ws4_approval_id (1 = HMAC v1, 2 = Ed25519 JWS v2). NULL = not recorded (pre-0018 rows, rows without an approval, or an approval not verified by this instance). Not part of the single-use key.';
