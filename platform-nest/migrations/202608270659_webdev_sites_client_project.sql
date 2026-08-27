-- WEB DEV LINEAGE (2/2): a provisioned site (repo + staging) knows its CLIENT and PROJECT.
--
-- `webdev_provisioned_sites` linked to the world only through `pipeline_run_id`. That is fine for a
-- site provisioned from a PRD run (the run carries client/project) and useless for a STANDALONE site
-- (off-pipeline, `pipeline_run_id IS NULL` — an explicitly supported case since 0090): the UI could
-- only label it "not linked to a project". Both are now stored on the row: copied from the run when
-- there is one, supplied by the caller for a standalone site.
--
-- Nullable FKs, matching the table's own `pipeline_run_id` (plain uuid, not composite — 0090's note
-- about matching the table you extend rather than its neighbours). Partial indexes for the two lists
-- the UI reads (a client's sites, a project's sites).
--
-- Backfill: rows with a run take the run's client/project. This table is MODULE-OWNED (third RLS
-- wall: `app_module_allowed('webdev')`), so the per-tenant loop sets BOTH GUCs — `app.current_tenant_ids`
-- and `app.scopes` — or the UPDATE matches zero rows and reports success (lint:migration-rls; 0051).

ALTER TABLE webdev_provisioned_sites ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES clients(id);
ALTER TABLE webdev_provisioned_sites ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id);
CREATE INDEX IF NOT EXISTS ix_wps_client ON webdev_provisioned_sites (tenant_id, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_wps_project ON webdev_provisioned_sites (tenant_id, project_id) WHERE project_id IS NOT NULL;

DO $$
DECLARE
  co RECORD;
  n int;
  total int := 0;
BEGIN
  FOR co IN SELECT id FROM companies LOOP
    PERFORM set_config('app.current_tenant_ids', co.id::text, true);
    PERFORM set_config('app.scopes', 'webdev', true);
    UPDATE webdev_provisioned_sites s
       SET client_id  = COALESCE(s.client_id,  r.client_id),
           project_id = COALESCE(s.project_id, r.project_id),
           updated_at = now()
      FROM pipeline_runs r
     WHERE r.id = s.pipeline_run_id
       AND r.deleted_at IS NULL
       AND (
         (s.client_id  IS NULL AND r.client_id  IS NOT NULL) OR
         (s.project_id IS NULL AND r.project_id IS NOT NULL)
       );
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
    IF n > 0 THEN
      RAISE NOTICE '[wps-lineage] tenant %: % site(s) attached to their run''s client/project', co.id, n;
    END IF;
  END LOOP;
  RAISE NOTICE '[wps-lineage] total sites attached: %', total;
END $$;

COMMENT ON COLUMN webdev_provisioned_sites.client_id IS
  'The client this site/repo is for. Copied from the run at provision time when there is one; supplied '
  'by the caller for a standalone (off-pipeline) site. NULL = unknown / pre-dates the column.';
COMMENT ON COLUMN webdev_provisioned_sites.project_id IS
  'The project this site/repo belongs to. Same provenance as client_id.';
