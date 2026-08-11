-- IAM (phase 1) — seed `agency_approver`, the SEVENTH role with the "seed-script-only, no
-- migration behind it" defect that 0091 and 0095 closed for the other twelve.
--
-- HOW IT SURFACED (worth recording, because the mechanism is the point): 0091 shipped
-- `src/rbac/role-catalog-drift.db.test.ts`, a guard asserting that every role named in
-- `platform-ui/src/lib/rbac.ts`'s `Role` union has a global `roles` row in a MIGRATIONS-ONLY
-- database. At that moment `agency_approver` was absent from `rbac.ts` entirely — it was the
-- drift register's finding #1, a live-held role (1 real holder on gda-aicenter, company-scoped
-- grant) that the UI mirror knew nothing about, so it conferred ZERO capabilities in the
-- interface. Owner decision DR-2b then added it to `rbac.ts`, and the guard immediately went red:
--
--   AssertionError: platform-ui/src/lib/rbac.ts's Role union names these roles, but no global
--   'roles' row exists for them in a migrations-only database — the exact team_lead/viewer/it/
--   it_manager/search_staff/search_manager defect class: agency_approver
--
-- That is the guard doing precisely its job: fixing the mirror exposed the seeding gap underneath,
-- which had been invisible while the role was missing from the mirror. Two half-defects were
-- hiding each other. This migration closes the second half.
--
-- WHY IT IS NOT IN 0095: 0095 scoped itself, deliberately and explicitly, to the six roles
-- IAM-02d had named and cross-checked. `agency_approver` was found afterwards, by 0095's own
-- author, while verifying that work. Per migrations/README.md rule 4 an existing migration is
-- never edited to absorb a late finding — corrections ship as a new, higher-numbered file.
--
-- IDIOM: identical to 0091/0095 — global role (`company_id IS NULL`), `gen_random_uuid()` id,
-- `NOT EXISTS` guard scoped to `company_id IS NULL`, so this is idempotent, re-runnable, and a
-- no-op on any database where `seed:agency` already created the row (which is every live one).
--
-- SAFE AGAINST THE NULL-UNIQUE TRAP: `roles` carries `roles_global_name_uniq ON roles (name)
-- WHERE company_id IS NULL`, added by 0073_dedupe_global_roles.sql, because plain
-- `UNIQUE (company_id, name)` never constrains global rows (SQL NULLs are never equal — the same
-- hole 0092 had to close for `user_roles`). The partial index means a duplicate global
-- `agency_approver` cannot be created even if this file were somehow applied twice outside the
-- ledger; the `NOT EXISTS` guard makes it a clean no-op rather than an error.
--
-- NO RLS CONCERN: `roles` has no `tenant_id` and carries no RLS policy, so the zero-row backfill
-- trap (a statement running without the tenant GUC silently matching nothing and reporting
-- success) does not apply here. The assertion block below proves the row exists regardless.

INSERT INTO roles (id, company_id, name, description)
SELECT gen_random_uuid(), NULL, 'agency_approver',
       'Agency approval authority — holds `approve` on agency_approval via the module_approver '
       'derived role (module hardcoded "agency" at every agency.controller.ts call site). '
       'Deliberately narrow: it holds nothing else, not even a baseline read on that same kind. '
       'Company-scoped in practice; see DR-2b (IAM phase 1) for the rbac.ts mirror entry.'
WHERE NOT EXISTS (
  SELECT 1 FROM roles WHERE company_id IS NULL AND name = 'agency_approver'
);

DO $$
DECLARE
  missing int;
  dupes   int;
BEGIN
  SELECT count(*) INTO missing FROM (
    SELECT 'agency_approver' AS name
    EXCEPT
    SELECT name FROM roles WHERE company_id IS NULL
  ) x;
  IF missing > 0 THEN
    RAISE EXCEPTION '0096: agency_approver still missing after seed';
  END IF;

  SELECT count(*) INTO dupes FROM roles
   WHERE company_id IS NULL AND name = 'agency_approver';
  IF dupes <> 1 THEN
    RAISE EXCEPTION '0096: expected exactly 1 global agency_approver row, found %', dupes;
  END IF;
END $$;
