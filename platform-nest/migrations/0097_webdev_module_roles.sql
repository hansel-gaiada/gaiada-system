-- IAM-02f — seed `webdev_staff`/`webdev_manager`, the THIRD live instance of the
-- module_staff/module_manager silent-skip defect in one day (after `reports_*` via 0069 and
-- `search_*` via 0091).
--
-- THE BUG. `derived_roles.yaml`'s `module_staff`/`module_manager` pair (lines ~108-135) string-
-- composes the required role name from `resource.attr.module` at request time:
--   g.role == (resource.attr.module + "_staff")   /   (resource.attr.module + "_manager")
-- `cerbos/policies/resource_webdev_change_request.yaml` and
-- `cerbos/policies/resource_webdev_provisioned_site.yaml` both grant `module_manager`/`module_staff`
-- (their headers confirm every handler passes `resource.attr = {..., module: "webdev", ...}` — MI-03
-- / PRV-03), so the concrete role names Cerbos needs are `webdev_staff` and `webdev_manager`. Neither
-- had a `roles` row. `src/admin/service-reconciler.ts`'s `moduleRoleId(c, 'webdev', kind)` does
-- `SELECT id FROM roles WHERE company_id IS NULL AND name = 'webdev_<kind>'` and returns NULL on a
-- miss; its one caller does `if (!rid) { skipped.push(userId); continue; }` — no grant, no operator-
-- visible error. Byte-for-byte the same shape 0069 closed for `reports_*` and 0091 closed for
-- `search_*`. Not yet a live incident on gda-aicenter (no active webdev service_assignments exist
-- yet, same as the other two instances when they were found) — this migration closes it before the
-- first webdev-department service assignment goes active.
--
-- WHAT THIS MIGRATION DOES NOT DO: it does not grant either role to any user, does not touch any
-- Cerbos policy, and does not touch `platform-ui/src/lib/rbac.ts`. Seeding a `roles` row only makes
-- a name grantable — `service-reconciler.ts` still only materializes `webdev_staff`/`webdev_manager`
-- onto a SERVED company via an active `service_assignments` row (of which there are currently none
-- for `module_key='webdev'`). Zero authorization decisions change for any existing user.
--
-- IDIOM: identical to 0026 block (E) / 0069 / 0091 / 0095 / 0096 — a global role has
-- `company_id IS NULL`, and SQL NULLs are distinct for `UNIQUE (company_id, name)` (0001's original
-- constraint), so `ON CONFLICT (company_id, name)` cannot de-duplicate a NULL-company_id row. The
-- `NOT EXISTS` guard scoped explicitly to `company_id IS NULL` is what makes this idempotent and
-- safely re-runnable. `0073_dedupe_global_roles.sql`'s `roles_global_name_uniq ON roles (name)
-- WHERE company_id IS NULL` (confirmed by reading that file directly, per this ticket's own
-- instruction not to assume it) already backstops this at the constraint level — no new index is
-- needed here, same conclusion 0095's header reached for its own six roles.
--
-- `roles` is GLOBAL reference data (company_id IS NULL here by construction) — there is no RLS on
-- this table, so the "migration runs NOBYPASSRLS with an unset tenant GUC -> silently matches zero
-- rows and reports success" trap (migration-backfill-rls-trap.md) does not apply structurally (no
-- tenant-scoped WHERE clause here for RLS to zero out). Asserted below anyway, per the same
-- discipline 0095/0096 applied.
INSERT INTO roles (id, company_id, name, description)
SELECT gen_random_uuid(), NULL, r.name, r.description
FROM (VALUES
  ('webdev_staff',
   'Web Dev module_staff (WSD-2/ORG-6) — served-company grant: read the change-request triage queue and the provisioned-site mirror; cannot triage/provision/reconcile. Reconciler-materialized onto a SERVED company via an active service_assignments row.'),
  ('webdev_manager',
   'Web Dev module_manager (WSD-2/ORG-6) — served-company grant: full working set including triage (decline/convert) on webdev_change_request and provision/reconcile on webdev_provisioned_site. Reconciler-materialized to the serving unit''s lead.')
) AS r(name, description)
WHERE NOT EXISTS (
  SELECT 1 FROM roles WHERE company_id IS NULL AND name = r.name
);

-- Assert the expected end state rather than assuming the INSERT did what it looks like it did.
DO $$
DECLARE
  missing text[];
  dupes text[];
BEGIN
  SELECT array_agg(x.name) INTO missing FROM (
    SELECT unnest(ARRAY['webdev_staff','webdev_manager']) AS name
    EXCEPT
    SELECT name FROM roles WHERE company_id IS NULL
  ) x;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0097: webdev module role(s) still missing after seed: %', missing;
  END IF;

  SELECT array_agg(x.name) INTO dupes FROM (
    SELECT name FROM roles
    WHERE company_id IS NULL AND name IN ('webdev_staff','webdev_manager')
    GROUP BY name HAVING count(*) > 1
  ) x;
  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION '0097: webdev module role(s) duplicated as global rows: %', dupes;
  END IF;
END $$;
