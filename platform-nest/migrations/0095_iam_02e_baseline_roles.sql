-- IAM-02e — seed the six BASELINE roles that IAM-02d found have NO migration behind them at all:
-- manager, member, company_admin, platform_admin, group_executive, it_admin.
--
-- THE GAP (found 2026-08-10 while building 0091's role-catalog-drift test, recorded in that
-- test's own SEED_SCRIPT_ONLY_ROLES set and in docs/superpowers/plans/2026-08-10-iam-phase1-
-- tickets.md §6): these six role names are real, live-granted, Cerbos-enforced tiers (verified
-- live on gda-aicenter 2026-08-10 — `member`(18 holders)/`manager`(11)/`company_admin`(9)/
-- `platform_admin`(1)/`group_executive`(1, a seed/test account)/`it_admin`(1)) — but the ONLY
-- thing that has ever created their `roles` rows is the manual `npm run seed:agency` script
-- (`src/seed/agency.ts`'s `createRole()` calls). No migration seeds them. 0091 seeded the six
-- roles that were literal-in-Cerbos-only and explicitly carved these six OUT as "a separate,
-- pre-existing gap ... not this ticket's defect" — this migration closes exactly that gap. A
-- freshly-migrated environment (new deployment, disaster recovery, a new site in the multi-site
-- topology) that has NOT had `seed:agency` run against it has NO baseline roles at all: nobody
-- can be granted `manager`/`member`/`company_admin`/`platform_admin`/`group_executive`/`it_admin`
-- without someone remembering to run demo-data first.
--
-- WHY THESE SIX AND ONLY THESE SIX: cross-checked against every migration that seeds `roles`
-- rows in this directory (0026 hr_staff/hr_manager, 0069 reports_staff/reports_manager, 0072
-- client, 0091 team_lead/viewer/it_manager/it/search_staff/search_manager) before writing this
-- file — none of them inserts any of these six names. Confirmed via a direct grep of
-- `INSERT INTO roles` across `platform-nest/migrations/*.sql`.
--
-- IDIOM: identical to 0091 — global role (`company_id IS NULL`), `gen_random_uuid()` id,
-- `NOT EXISTS` guard scoped to `company_id IS NULL` (idempotent/re-runnable; a no-op on a live
-- database where `seed:agency` already created all six by hand — this only changes the FRESH,
-- unseeded-migration case).
--
-- ⚠ UNLIKE 0091's own reasoning about `user_roles` (which needed 0092 to add a partial unique
-- index), THIS migration does NOT need to add one: 0073 already created
-- `roles_global_name_uniq ON roles (name) WHERE company_id IS NULL` — confirmed by reading 0073
-- directly. `roles` already carries the same protection `user_roles` was missing until 0092.
-- `src/testing/fixtures.ts`'s `createRole()` already relies on this index
-- (`ON CONFLICT (name) WHERE company_id IS NULL DO NOTHING`) for exactly these six names when
-- `seed:agency` runs, so re-running the seed script after this migration remains a safe no-op.
-- The `NOT EXISTS` guard below is therefore redundant with that index in the same way 0091's is
-- — kept for idiom consistency with 0026/0069/0091, not because the index is missing.
--
-- `roles` is GLOBAL reference data (company_id IS NULL here by construction) — there is no RLS
-- on this table, so the "migration runs NOBYPASSRLS with an unset tenant GUC -> silently matches
-- zero rows and reports success" trap (migration-backfill-rls-trap.md) does not apply structurally
-- (no tenant-scoped WHERE clause here for RLS to zero out). Asserted below anyway, since this
-- repo has been burned by exactly that failure shape twice and "no RLS" should be proven, not
-- assumed.
--
-- WHAT THIS MIGRATION DOES NOT DO: it does not grant any of these six roles to any user, does not
-- touch any Cerbos policy, does not touch `platform-ui/src/lib/rbac.ts`, and does not touch
-- `src/seed/agency.ts`. Seeding a `roles` row only makes a name grantable — an admin (or the seed
-- script) still has to assign it. Zero authorization decisions change for any existing user; a
-- live database that already has these six rows (every real deployment so far, because
-- `seed:agency` has been run there) is unaffected.
INSERT INTO roles (id, company_id, name, description)
SELECT gen_random_uuid(), NULL, r.name, r.description
FROM (VALUES
  ('member',
   'Baseline company-scoped contributor — the default grant for staff doing billable/assigned work in one company.'),
  ('manager',
   'Company-scoped operational lead — team/pipeline management within one company; excluded from cross-cutting approval decisions Cerbos reserves for company_admin/group_executive/module_manager/module_approver (see DR-1, IAM phase 1).'),
  ('company_admin',
   'Company-scoped administrator — full control within one company (settings, billing, role assignment, approvals); does not span companies.'),
  ('platform_admin',
   'Global superadmin — the platform-wide Cerbos wildcard (''*'') bypass rule present on ~59 of 61 resource kinds; IAM-04c is the pending ruling on how that bypass is modeled going forward.'),
  ('group_executive',
   'Global cross-company executive — rollup/exec visibility across a holding''s member companies; its over-broad ''ALL'' capability mirror in rbac.ts is a separately tracked drift finding (D-7, IAM phase 1), not addressed by this migration.'),
  ('it_admin',
   'Company-scoped IT operator tier — Cerbos''s it_staff derived role treats this identically to it_manager/it (resource_device.yaml is the only policy that reads any of the three); distinguished only by the admin-systems console and the UI mirror.')
) AS r(name, description)
WHERE NOT EXISTS (
  SELECT 1 FROM roles WHERE company_id IS NULL AND name = r.name
);

-- Assert the expected end state rather than assuming the INSERT did what it looks like it did —
-- prove all six baseline roles exist, exactly once each, as global rows, after this file runs.
DO $$
DECLARE
  missing text[];
  dupes text[];
BEGIN
  SELECT array_agg(x.name) INTO missing FROM (
    SELECT unnest(ARRAY['member','manager','company_admin','platform_admin','group_executive','it_admin']) AS name
    EXCEPT
    SELECT name FROM roles WHERE company_id IS NULL
  ) x;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0095: baseline role(s) still missing after seed: %', missing;
  END IF;

  SELECT array_agg(x.name) INTO dupes FROM (
    SELECT name FROM roles
    WHERE company_id IS NULL
      AND name IN ('member','manager','company_admin','platform_admin','group_executive','it_admin')
    GROUP BY name HAVING count(*) > 1
  ) x;
  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION '0095: baseline role(s) duplicated as global rows: %', dupes;
  END IF;
END $$;
