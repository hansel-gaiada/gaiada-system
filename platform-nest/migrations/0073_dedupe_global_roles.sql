-- 0073 — collapse duplicate GLOBAL roles and make the uniqueness real.
--
-- THE BUG. `roles` has carried `UNIQUE (company_id, name)` since 0001, which reads as though a role
-- name can exist once globally and once per company. It does not: in SQL, NULLs are DISTINCT for
-- uniqueness purposes, so `(NULL, 'manager')` never collides with `(NULL, 'manager')`. Every global
-- role is exempt from the very constraint that appears to protect it, and each insert pass adds
-- another row. Found live on gda-aicenter 2026-08-03: 10 × `manager`, 3 × `company_admin`,
-- 2 × `member`, all with company_id IS NULL. The visible symptom was the assign-role picker in
-- Settings → Users & Roles offering ten identical "manager" options with nothing to choose between.
--
-- (Per-company rows are genuinely protected — company_id is NOT NULL there, so the original
-- constraint works for them. This migration deliberately leaves those alone.)
--
-- WHY THE ORDER BELOW MATTERS. `user_roles.role_id` and `role_permissions.role_id` are
-- ON DELETE CASCADE. Deleting duplicate role rows first would therefore delete real grants — every
-- person holding one of the nine losing `manager` rows silently loses that role, and the migration
-- would report success. So: repoint every reference to the surviving row, THEN delete.
--
-- Canonical winner = the oldest row, chosen by id so the pick is deterministic and re-runnable
-- rather than dependent on physical row order.

BEGIN;

CREATE TEMP TABLE role_dedupe_map ON COMMIT DROP AS
WITH ranked AS (
  SELECT id, name,
         first_value(id) OVER (PARTITION BY name ORDER BY id) AS keep_id
  FROM roles
  WHERE company_id IS NULL
)
SELECT id AS dup_id, keep_id, name
FROM ranked
WHERE id <> keep_id;

-- user_roles: repoint, but respect UNIQUE (user_id, role_id, scope_type, scope_id) — a user holding
-- BOTH a duplicate and the canonical row at the same scope would collide on update, so drop the
-- redundant duplicate grant instead of failing the migration.
DELETE FROM user_roles ur
USING role_dedupe_map m
WHERE ur.role_id = m.dup_id
  AND EXISTS (
    SELECT 1 FROM user_roles keep
    WHERE keep.user_id = ur.user_id
      AND keep.role_id = m.keep_id
      AND keep.scope_type = ur.scope_type
      AND keep.scope_id IS NOT DISTINCT FROM ur.scope_id
  );

UPDATE user_roles ur
SET role_id = m.keep_id
FROM role_dedupe_map m
WHERE ur.role_id = m.dup_id;

-- role_permissions: same shape. PRIMARY KEY (role_id, permission_id), so a duplicate holding a
-- permission the canonical row already has would collide on update — drop those first.
DELETE FROM role_permissions rp
USING role_dedupe_map m
WHERE rp.role_id = m.dup_id
  AND EXISTS (
    SELECT 1 FROM role_permissions keep
    WHERE keep.role_id = m.keep_id
      AND keep.permission_id = rp.permission_id
  );

UPDATE role_permissions rp
SET role_id = m.keep_id
FROM role_dedupe_map m
WHERE rp.role_id = m.dup_id;

-- company_memberships.primary_role_id is a plain nullable FK (no cascade, no uniqueness) — but the
-- table carries FORCE ROW LEVEL SECURITY, and migrations run as platform_owner, which is
-- deliberately NOBYPASSRLS (db-topology-roles). With `app.current_tenant_ids` unset the
-- tenant_isolation policy admits NO rows, so a bare UPDATE here would touch ZERO of them and still
-- report success — the exact failure 0050 shipped and 0051 had to repair. Wrap it per tenant, the
-- same mechanism withTenants() uses for every ordinary request.
DO $$
DECLARE
  co RECORD;
BEGIN
  FOR co IN SELECT id FROM companies LOOP
    PERFORM set_config('app.current_tenant_ids', co.id::text, true);
    UPDATE company_memberships cm
    SET primary_role_id = m.keep_id
    FROM role_dedupe_map m
    WHERE cm.primary_role_id = m.dup_id;
  END LOOP;
  -- Leave no tenant set behind for the statements that follow.
  PERFORM set_config('app.current_tenant_ids', '', true);
END $$;

-- Only now is it safe to remove the losers.
DELETE FROM roles r USING role_dedupe_map m WHERE r.id = m.dup_id;

-- Make it impossible to recur. A partial unique index is what the 0001 constraint was reaching for:
-- it applies exactly to the global rows, where NULL-distinctness had disabled enforcement.
-- (`UNIQUE NULLS NOT DISTINCT` would also work on PG15+, but this states the intent explicitly and
-- does not depend on the server version.)
CREATE UNIQUE INDEX IF NOT EXISTS roles_global_name_uniq ON roles (name) WHERE company_id IS NULL;

-- Fail loudly if anything above was wrong, rather than committing a half-deduped table. Both
-- assertions are cheap and this is the only place they can be checked against real data.
DO $$
DECLARE
  dupes int;
  orphans int;
BEGIN
  SELECT count(*) INTO dupes FROM (
    SELECT name FROM roles WHERE company_id IS NULL GROUP BY name HAVING count(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION '0073: % global role name(s) still duplicated after dedupe', dupes;
  END IF;

  SELECT count(*) INTO orphans FROM user_roles ur
  WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.id = ur.role_id);
  IF orphans > 0 THEN
    RAISE EXCEPTION '0073: % user_roles row(s) point at a deleted role', orphans;
  END IF;
END $$;

COMMIT;
