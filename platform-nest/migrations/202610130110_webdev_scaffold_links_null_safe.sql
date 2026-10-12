-- M6-P4g follow-up: wps_scaffold_links (202610122130, M6-P4b2) let a scaffold state sit on a site whose §08
-- completion was never started.
--
-- ── THE DEFECT ─────────────────────────────────────────────────────────────────────────────────────
-- The first clause read `(scaffold_state IS NULL OR completion_state = 'complete')`. With completion_state NULL,
-- `= 'complete'` is NULL, and a CHECK passes on NULL, so `scaffold_state = 'pending'` with completion_state NULL was
-- accepted. Found on the Linux gate by M6-P4g's schema test, which hit the same shape in wps_deploy_grant_links
-- (fixed in place in 202610130100 before it ever shipped). No live row has a scaffold state yet, so no data is wrong.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────────────────────────────
-- Re-declare THIS ONE named constraint, clause for clause as 202610122130 wrote it, with only the first clause changed
-- to `IS NOT DISTINCT FROM`. Nothing else shares the name, so the DROP + ADD re-declares nothing beyond it.
--
-- ── RLS / BACKFILL ─────────────────────────────────────────────────────────────────────────────────
-- No table, column or policy change. Zero DML. ADD CONSTRAINT validates existing rows; every live row has
-- scaffold_state NULL, so it passes.
ALTER TABLE webdev_provisioned_sites DROP CONSTRAINT IF EXISTS wps_scaffold_links;
ALTER TABLE webdev_provisioned_sites
  ADD CONSTRAINT wps_scaffold_links CHECK (
    (scaffold_state IS NULL OR completion_state IS NOT DISTINCT FROM 'complete')
    AND (scaffold_state IS NULL OR (
          scaffold_manifest_sha256 IS NOT NULL AND scaffold_snapshot_id IS NOT NULL
          AND scaffold_branch IS NOT NULL AND scaffold_base_sha IS NOT NULL))
    AND (scaffold_state IS NULL OR scaffold_state = 'pending'
         OR (scaffold_tree_sha IS NOT NULL AND scaffold_commit_sha IS NOT NULL))
    AND (scaffold_state IS DISTINCT FROM 'committed' OR scaffold_committed_at IS NOT NULL)
  );
