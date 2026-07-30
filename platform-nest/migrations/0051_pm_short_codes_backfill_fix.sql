-- WD-28 follow-up — corrects a real defect found during THIS ticket's own live verification of
-- 0050_pm_short_codes.sql: that migration's two backfill DO blocks ran successfully (no error,
-- recorded in schema_migrations) but silently touched ZERO rows on the live dev DB.
--
-- ROOT CAUSE: migrations execute as `platform_owner` (src/db/migrate.ts `migratePool()` uses
-- MIGRATE_DATABASE_URL). Per the DB-topology role split (`db-topology-roles`, 2026-07-15),
-- `platform_owner` deliberately does NOT have BYPASSRLS (`rolbypassrls = false`, verified live:
-- `SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = 'platform_owner'` → f). `projects`
-- and `pm_tasks` carry FORCE ROW LEVEL SECURITY (0001/0018), whose `tenant_isolation` policy
-- gates every row on `tenant_id = ANY(app_current_tenants())` — and `app_current_tenants()`
-- reads the `app.current_tenant_ids` GUC, unset during a migration run. Unset → NULL → the
-- policy's `= ANY(NULL)` is NULL (falsy) for every row, so the owner-run backfill's SELECTs
-- (and the UPDATEs' implicit visibility) matched nothing — no error, no rows, ledger recorded
-- success regardless, because DDL (ALTER TABLE/CREATE INDEX, unaffected by row security) is what
-- actually made the transaction succeed. Never renumber/edit 0050 itself (migrations README rule
-- 4 — it is already applied on this dev DB); this is the corrective follow-up in the same spirit
-- as WD-29's own "data-repair migration" idiom.
--
-- FIX: same backfill logic as 0050, but wrapped per-tenant — for each company, PERFORM
-- set_config('app.current_tenant_ids', <that company's id>, true) (SET LOCAL semantics, scoped to
-- this migration's own transaction, exactly the mechanism src/db/index.ts `withTenants` uses for
-- every ordinary request) immediately before touching `projects`/`pm_tasks`, so `tenant_isolation`
-- actually admits that tenant's rows for the duration of its own iteration. Idempotent by the same
-- construction as 0050 (`short_code IS NULL`/`seq IS NULL` guards) — safe to run on a DB where
-- 0050's backfill partially or fully landed already (nothing left to do → true no-op) and on a
-- fresh DB where 0050's backfill never ran at all (does the full job here instead).

-- 1) Short codes, one tenant's authorized-tenant-set at a time.
DO $$
DECLARE
  co RECORD;
  proj RECORD;
  base text;
  candidate text;
  n int;
BEGIN
  FOR co IN SELECT id FROM companies LOOP
    PERFORM set_config('app.current_tenant_ids', co.id::text, true);
    FOR proj IN
      SELECT id, tenant_id, name FROM projects
      WHERE short_code IS NULL AND deleted_at IS NULL
      ORDER BY created_at, id
    LOOP
      base := upper(regexp_replace(proj.name, '[^a-zA-Z0-9]', '', 'g'));
      base := substring(base FROM 1 FOR 4);
      IF length(base) < 3 THEN
        base := rpad(base, 3, 'X');
      END IF;
      IF base = '' THEN
        base := 'PRJ';
      END IF;
      candidate := base;
      n := 1;
      WHILE EXISTS (
        SELECT 1 FROM projects
        WHERE tenant_id = proj.tenant_id AND short_code = candidate AND deleted_at IS NULL
      ) LOOP
        n := n + 1;
        candidate := base || n::text;
      END LOOP;
      UPDATE projects SET short_code = candidate WHERE id = proj.id;
    END LOOP;
  END LOOP;
END $$;

-- 2) Task seq, same per-tenant GUC wrapping.
DO $$
DECLARE
  co RECORD;
  proj RECORD;
  tsk RECORD;
  next_seq int;
BEGIN
  FOR co IN SELECT id FROM companies LOOP
    PERFORM set_config('app.current_tenant_ids', co.id::text, true);
    FOR proj IN SELECT id, task_seq FROM projects WHERE deleted_at IS NULL LOOP
      next_seq := proj.task_seq;
      FOR tsk IN
        SELECT id FROM pm_tasks
        WHERE project_id = proj.id AND seq IS NULL
        ORDER BY created_at, id
      LOOP
        next_seq := next_seq + 1;
        UPDATE pm_tasks SET seq = next_seq WHERE id = tsk.id;
      END LOOP;
      IF next_seq <> proj.task_seq THEN
        UPDATE projects SET task_seq = next_seq WHERE id = proj.id;
      END IF;
    END LOOP;
  END LOOP;
END $$;
