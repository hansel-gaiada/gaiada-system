-- IAM-DR5 — grant `company_admin` the `reports.appraisal.read` permission, matching the Cerbos
-- rule added to `cerbos/policies/resource_appraisal.yaml` in the same ticket.
--
-- ── THIS IS AN AUTHORIZATION WIDENING, NOT A DRIFT-NEUTRAL BUNDLE FIX ────────────────────────────
-- Every prior migration in the 0091/0094/0095/0096/0097/0098 family closed a bundle↔Cerbos gap
-- where BOTH sides already agreed and only the artifact was stale. This one is different: Cerbos
-- previously granted `company_admin` NOTHING on `appraisal` (drift register finding #6,
-- IAM-05b-3's confirmed over-claim, 9 live holders) and the OWNER decided (DR-5, 2026-08-10) to
-- close that gap by GRANTING in Cerbos rather than stripping the UI capability. This migration
-- makes the `role_permissions` audit mirror agree with that new Cerbos rule — it does not
-- introduce a NEW disagreement, it resolves the one that already existed in the dangerous
-- direction (UI claimed it, enforcement denied it silently — company_admin.dead button).
--
-- Deliberately narrow, matching the Cerbos rule exactly: `read` ONLY. `company_admin` gains
-- NO other `reports.appraisal.*` permission here (`write`/`submit`/`finalize`/`cycle_admin`/
-- `confirm_evidence`/`ack` are untouched — none of them are granted to `company_admin` in Cerbos,
-- and none are added to this bundle). Verify with:
--   SELECT p.key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
--     JOIN permissions p ON p.id = rp.permission_id
--   WHERE r.company_id IS NULL AND r.name = 'company_admin' AND p.key LIKE 'reports.appraisal.%';
-- should return exactly one row: reports.appraisal.read.
--
-- ── METHOD (identical idiom to 0094/0098) ────────────────────────────────────────────────────────
-- Insert by JOINing on `permissions.key` (0093's catalog) and `roles.name` (0094 already seeds
-- `company_admin` as a global role — numerically precedes this file, so the row is guaranteed to
-- exist). `ON CONFLICT DO NOTHING` on the existing PK makes this idempotent/re-runnable.
--
-- ── NO RLS CONCERN ────────────────────────────────────────────────────────────────────────────────
-- `roles`/`permissions`/`role_permissions` are global reference data with no RLS policy (confirmed
-- by every prior migration in this family). The "runs NOBYPASSRLS with an unset tenant GUC ->
-- silently matches zero rows" trap does not apply structurally here; asserted below anyway, per
-- the same discipline every migration in this family applies.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('company_admin', 'reports.appraisal.read')
) AS bundle(role_name, perm_key)
JOIN roles r ON r.company_id IS NULL AND r.name = bundle.role_name
JOIN permissions p ON p.key = bundle.perm_key
ON CONFLICT DO NOTHING;

-- ── Assert, don't assume ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  got integer;
  appraisal_pairs integer;
BEGIN
  -- company_admin's total bundle grows by exactly 1: 199 -> 200.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
   WHERE r.company_id IS NULL AND r.name = 'company_admin';
  IF got <> 200 THEN
    RAISE EXCEPTION '0099: role "company_admin": expected 200 bundled permissions (199 + this DR-5 grant), found %',
      got;
  END IF;

  -- Exactly one reports.appraisal.* permission for company_admin, and it must be .read — the
  -- narrowness guarantee this ticket exists to enforce (no write/submit/finalize/cycle_admin/
  -- confirm_evidence/ack ever sneaks in here or via a future careless re-run of this file).
  SELECT count(*) INTO appraisal_pairs
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND r.name = 'company_admin' AND p.key LIKE 'reports.appraisal.%';
  IF appraisal_pairs <> 1 THEN
    RAISE EXCEPTION '0099: role "company_admin": expected exactly 1 reports.appraisal.* permission (read only), found %',
      appraisal_pairs;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE r.company_id IS NULL AND r.name = 'company_admin' AND p.key = 'reports.appraisal.read'
  ) THEN
    RAISE EXCEPTION '0099: role "company_admin" is missing reports.appraisal.read after seeding — typo''d role name or permission key in the JOIN';
  END IF;

  -- Defense-in-depth re-assertion of Ruling 3, redundant with 0093's DB trigger.
  IF EXISTS (
    SELECT 1 FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
    JOIN roles r ON r.id = rp.role_id
    WHERE r.company_id IS NULL AND r.name = 'company_admin' AND p.key = 'reports.appraisal.read' AND p.class = 'relationship'
  ) THEN
    RAISE EXCEPTION '0099: reports.appraisal.read leaked in as relationship-class — Ruling 3 violated';
  END IF;

  RAISE NOTICE '0099: role_permissions — company_admin granted reports.appraisal.read (DR-5); bundle now 200 permissions, 1 of them reports.appraisal.*';
END $$;
