-- 0117_monitor_results_partition_rls.sql — FORCE RLS on every `monitor_results` PARTITION, not just
-- on the partitioned parent.
--
-- ⚠ THIS FIXES ANOTHER TICKET'S TABLE, DELIBERATELY. `0116_module_monitoring.sql` (MON-10, commit
-- 1d4cfd8) is a concurrent session's work and is otherwise correct. It is amended here, in a NEW
-- migration rather than by editing theirs, because 0116 is already committed and may already be
-- applied — editing an applied migration is the one thing the numbering protocol forbids outright.
--
-- ── THE GAP ────────────────────────────────────────────────────────────────────────────────────
-- 0116 creates `monitor_results` as PARTITION BY RANGE and pre-creates four monthly partitions, then
-- runs its ENABLE/FORCE ROW LEVEL SECURITY loop over a hardcoded array of NINE table names — which
-- lists the parent `monitor_results` but none of its partitions.
--
-- In Postgres a parent's policies apply to rows reached THROUGH the parent. A query naming a
-- partition directly (`SELECT ... FROM monitor_results_202608`) is governed by that partition's OWN
-- policies, and it had none — so a direct read would have crossed tenants. Caught by the estate's own
-- `src/db/rls.test.ts`, which enumerates every tenant-scoped table rather than a maintained list:
-- exactly the kind of guard that earns its keep, and the reason this was a red test rather than an
-- incident.
--
-- ── WHY A LOOP OVER pg_inherits, NOT A LIST OF FOUR NAMES ──────────────────────────────────────
-- 0116's partition names are derived from the month the migration RUNS (`to_char(s, 'YYYYMM')`), so
-- they differ between environments — a hardcoded list would fix the box it was written on and miss
-- every other. Deriving from the catalog also covers partitions added later by the same DO block on a
-- re-run. It does NOT cover partitions created in the future by a scheduler; that belongs with
-- whoever owns the monitoring rollover, and is flagged in the ticket rather than silently assumed.
--
-- ── IDEMPOTENT, AND SAFE ON A DB WHERE 0116 NEVER RAN ──────────────────────────────────────────
-- ENABLE/FORCE RLS are no-ops when already set. The whole block is guarded on `monitor_results`
-- existing, so an environment that has not applied 0116 (or that disabled the monitoring module)
-- skips cleanly instead of failing the boot-time migration run.
--
-- Each partition gets the SAME policy shape as the parent — tenant isolation composed with the
-- monitoring module gate — copied from 0116 rather than reinvented, so the two cannot disagree about
-- what "visible" means.

DO $$
DECLARE
  part text;
  n integer := 0;
BEGIN
  IF to_regclass('public.monitor_results') IS NULL THEN
    RAISE NOTICE '0117: monitor_results absent (0116 not applied here) — nothing to harden';
    RETURN;
  END IF;

  FOR part IN
    SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'public.monitor_results'::regclass
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', part);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', part);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', part);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''monitoring''))
         WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''monitoring''))',
      part);
    n := n + 1;
  END LOOP;

  RAISE NOTICE '0117: hardened % monitor_results partition(s)', n;
END $$;
