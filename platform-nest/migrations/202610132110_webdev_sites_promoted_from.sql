-- 202610132110_webdev_sites_promoted_from.sql — M6-P6g: a provisioned site's PRODUCTION row is created from its STAGING row.
--
-- ── WHY ONE COLUMN, AND WHY NOT THE INDEX THE REGISTRY ALREADY HAS ─────────────────────────────────
-- 202608301055 made "one production per project" structural (`ux_webdev_sites_one_production_per_project`), but that index
-- is partial on `project_id IS NOT NULL`: a provisioned site with no project (a standalone or internal site) has nothing
-- to be the production OF, so two production rows for one provisioned site were reachable. The staging row M6-P4c registers
-- is the only handle that names "the site", so the production row records it: `promoted_from_site_id`, a composite FK to the
-- SAME tenant's staging row, and a partial unique index so a staging row has at most one live production row. That makes
-- "a second production row for the same site is refused" a fact of the schema for every site, project or not.
--
-- ── WHAT THIS ADDS (every step additive; no existing column, CHECK, index or policy is touched) ──────
--   1. `webdev_sites.promoted_from_site_id uuid`, NULL for every existing row and for every row not made this way.
--   2. A composite FK (promoted_from_site_id, tenant_id) -> webdev_sites (id, tenant_id): cross-tenant linkage is
--      structurally impossible, the same idiom as fk_wps_webdev_site_tenant (202610120425). MATCH SIMPLE, so a NULL
--      promoted_from_site_id is not checked.
--   3. A CHECK: a row that names a staging row IS a production row, and is not its own origin. The `IS NULL OR` arm is
--      explicit (a CHECK passes on NULL anyway; the intent is stated, not relied on). `environment` is NOT NULL, so the
--      equality below cannot be NULL-defeated.
--   4. A partial UNIQUE index (tenant_id, promoted_from_site_id) over live rows: one production row per staging row.
--
-- No DML, so neither the backfill-under-RLS silence nor the shared-CHECK trap has anything to bite. The existing RLS
-- policy (tenant_isolation, module `webdev`) already covers the new column; no policy changes.
ALTER TABLE webdev_sites
  ADD COLUMN IF NOT EXISTS promoted_from_site_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'webdev_sites'::regclass AND conname = 'fk_webdev_sites_promoted_from'
  ) THEN
    ALTER TABLE webdev_sites
      ADD CONSTRAINT fk_webdev_sites_promoted_from
      FOREIGN KEY (promoted_from_site_id, tenant_id) REFERENCES webdev_sites (id, tenant_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'webdev_sites'::regclass AND conname = 'webdev_sites_promoted_from_is_production'
  ) THEN
    ALTER TABLE webdev_sites
      ADD CONSTRAINT webdev_sites_promoted_from_is_production
      CHECK (promoted_from_site_id IS NULL OR (environment = 'production' AND promoted_from_site_id <> id));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_webdev_sites_one_production_per_staging
  ON webdev_sites (tenant_id, promoted_from_site_id)
  WHERE promoted_from_site_id IS NOT NULL AND deleted_at IS NULL;

COMMENT ON COLUMN webdev_sites.promoted_from_site_id IS
  'M6-P6g: set only on a production row that was created from a provisioned site''s staging row (POST sites/:id/production); '
  'the staging row''s id, same tenant (composite FK). NULL on every other row. ux_webdev_sites_one_production_per_staging '
  'allows one live production row per staging row, which holds for a project-less site too (the per-project index does not).';
