-- WSA-2 (Backbone Program): register the pm/it/billing/clients/knowledge/automation-console
-- modules and backfill companies.enabled_modules for every EXISTING company so their routes
-- (already coded behind ModuleEnabledGuard on each module's controller) don't 404 on deploy
-- just because the module registration/backfill had never shipped. Additive-only: never
-- removes a key a company already has (e.g. "agency"); safe to re-run (idempotent via the
-- array-union + DISTINCT below).
--
-- Data-only migration, no DDL. Runs as platform_owner like every other migration; no new
-- objects, so no RUNTIME_GRANTS_SQL changes are needed.
UPDATE companies
SET enabled_modules = (
  SELECT array_agg(DISTINCT m ORDER BY m)
  FROM unnest(
    enabled_modules || ARRAY['pm', 'it', 'billing', 'clients', 'knowledge', 'automation-console']::text[]
  ) AS m
)
WHERE deleted_at IS NULL;
