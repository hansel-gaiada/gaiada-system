-- IAM-DR12 (owner decision, 2026-08-11) — delete the `role_permissions` rows for a Cerbos grant
-- that no longer exists.
--
-- ⚠ TAKES 0104, NOT 0103: HIER-3's retirement sweep is authoring 0103 concurrently in this shared
-- checkout. Numbers are pre-assigned by the coordinating session for exactly this reason — see
-- migrations/README.md's 2026-08-10 entry on why `ls | tail` cannot be right for the second author.
--
-- THE FINDING (IAM-VERIFY-01, observed by DRIVING the live API as personas — not by inspection):
-- `resource_portal.yaml` granted staff (`company_admin`/`manager`/`group_executive`) portal `read`,
-- framed in its comments as support access. But `core/portal-scope.ts`'s `callerClientIds()`
-- unconditionally throws `"not a portal client"` for any principal with no `client_contacts` row —
-- every staff member, by construction. The grant was dead: no staff member ever exercised it, and
-- none could.
--
-- It survived because the test that looked like it covered this drove a `member` persona, who had no
-- Cerbos grant on `portal` at all — so the `company_admin`/`manager` case the policy described was
-- never exercised. That test now drives the real personas and asserts refusal.
--
-- THE OWNER DECISION: delete the dead rule; staff have no portal access. Rationale of record —
-- it matches what the system has always actually done, and client-portal data is another company's
-- commercial information, so support access (if ever wanted) should be built deliberately with its
-- own capability and audit trail, not inherited by every manager from a rule nobody noticed was
-- inert. The Cerbos half landed with that ticket; `role-permission-bundles.json` was regenerated.
--
-- WHY THIS MIGRATION EXISTS: `role_permissions` is DB state seeded by 0094, not a generated file.
-- Removing the policy rule does not remove the rows, so the bundles and live Cerbos disagreed and
-- `role-permission-parity.db.test.ts` went red — the chain doing its job, not a defect. This closes
-- it at the only place that can: the table.
--
-- SAFE BY CONSTRUCTION: bundles are DATA with no runtime consumer today (role-name matching still
-- decides every live authorization; the permission arm is an additive mirror). So this migration
-- cannot change an authorization decision — it removes rows describing a grant Cerbos no longer has.

DO $$
DECLARE
  deleted int;
BEGIN
  DELETE FROM role_permissions rp
   USING roles r, permissions p
   WHERE rp.role_id = r.id
     AND rp.permission_id = p.id
     AND r.company_id IS NULL
     AND r.name IN ('company_admin', 'manager', 'group_executive')
     AND p.key = 'portal.read';

  GET DIAGNOSTICS deleted = ROW_COUNT;

  -- Asserted, not assumed. A backfill/cleanup that silently matches zero rows and reports success
  -- is a trap this repo has hit more than once (see migrations/README.md and the platform-nest
  -- CLAUDE.md "three walls" section). `role_permissions` carries no RLS, so the zero-row GUC trap
  -- does not apply here — but the count is still surfaced rather than trusted.
  --
  -- NOT an exception on a mismatch: this migration must stay re-runnable. On a database where it has
  -- already applied (or one seeded after the Cerbos rule was removed) the correct result is 0, and
  -- `migrate()` runs on EVERY platform boot — the same reasoning that downgraded 0100's guards after
  -- they turned a legitimate state into a boot failure.
  RAISE NOTICE '0104: deleted % orphaned portal.read bundle row(s) (expected 3 on a database seeded before IAM-DR12, 0 thereafter)', deleted;

  -- What MUST hold afterwards, either way: no staff role claims portal.read anymore.
  IF EXISTS (
    SELECT 1 FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL
       AND r.name IN ('company_admin', 'manager', 'group_executive')
       AND p.key = 'portal.read'
  ) THEN
    RAISE EXCEPTION '0104: a staff role still holds portal.read after the delete — investigate before proceeding';
  END IF;
END $$;
