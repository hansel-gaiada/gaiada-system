-- 202610132210_webdev_deploy_secret_name_repo_id.sql
--
-- M6-P6f (docs/plans/2026-10-11-webdesk-m6-plan.md, the template deploy jobs). The per-site deploy secret's NAME changes
-- from `WEBDESK_DEPLOY_<SLUG>_<ENV>_<H8>` (H8 = 8 hex of sha256(the provisioned site's id)) to
-- `WEBDESK_DEPLOY_<SLUG>_<ENV>_<REPOID>`, REPOID = the GitHub repository's numeric id. Reason: a site repo's own workflow
-- has to derive the name of its own secret, and it never sees a provisioned site's id; every workflow knows
-- `github.repository_id`, and a repository id is unique across GitHub, so it also keeps the anti-collision job H8 had.
-- The code half is `siteDeploySecretName()` in src/modules/webdev/deploy-grant.ts (and the shell twin
-- webdesk/templates/_deploy/secret-name.sh; both are tested against one fixture).
--
-- WHAT THIS CHANGES: only the shape CHECK on `webdev_provisioned_sites.deploy_grant_site_secret_name`, which was
--   `~ '^WEBDESK_DEPLOY_[A-Z0-9_]+_[0-9A-F]{8}$'` (migration 202610130100) and is now
--   `~ '^WEBDESK_DEPLOY_[A-Z0-9_]+_[0-9]{1,16}$'`. A 16-digit cap is GitHub's id range inside the safe-integer limit the
--   derivation enforces (9007199254740991).
--
-- NO DATA MIGRATION: the name is recorded per grant, at claim. No claim can have been committed live: the grant reads the
-- org secret's metadata BEFORE it claims, and that read has been refused `github_permission_missing: organization_secrets`
-- since release 366 (O-3 not granted), so every row holds NULL here. Nothing is backfilled and no row is touched.
--
-- THE CHECK TRAP: the old CHECK is dropped and the new one added in one transaction, and only that one column's regex
-- check is touched. `wps_deploy_grant_links` also mentions this column, but only as `IS NOT NULL`, so it is left alone
-- (the file asserts that it still exists afterwards). The new CHECK is added NOT VALID (enforced on every new or changed
-- row at once) and then VALIDATEd; if a legacy-format row ever did exist, the validation fails with a NOTICE, the
-- constraint stays NOT VALID rather than blocking the deploy, and the next grant (which re-derives and re-records the
-- name at claim) repairs the row.
--
-- ASSERT, DON'T ASSUME: exactly one regex CHECK on the column is found before the change; afterwards exactly one named
-- `webdev_provisioned_sites_deploy_secret_name_repo_id` exists and `wps_deploy_grant_links` is still there. A re-run is a
-- no-op. To undo: DROP the new constraint and re-add the old regex (only valid while no row holds a REPOID name).
DO $$
DECLARE
  n_old  integer;
  oldname text;
  newname constant text := 'webdev_provisioned_sites_deploy_secret_name_repo_id';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'webdev_provisioned_sites'::regclass AND conname = newname) THEN
    RAISE NOTICE 'M6-P6f: % already exists — nothing to do', newname;
    RETURN;
  END IF;

  SELECT count(*) INTO n_old
    FROM pg_constraint
   WHERE conrelid = 'webdev_provisioned_sites'::regclass
     AND contype = 'c'
     AND conname <> 'wps_deploy_grant_links'
     AND pg_get_constraintdef(oid) LIKE '%deploy_grant_site_secret_name%';
  IF n_old <> 1 THEN
    RAISE EXCEPTION 'M6-P6f: expected exactly ONE shape CHECK on deploy_grant_site_secret_name, found % — refusing to guess', n_old;
  END IF;

  SELECT conname INTO oldname
    FROM pg_constraint
   WHERE conrelid = 'webdev_provisioned_sites'::regclass
     AND contype = 'c'
     AND conname <> 'wps_deploy_grant_links'
     AND pg_get_constraintdef(oid) LIKE '%deploy_grant_site_secret_name%';

  EXECUTE format('ALTER TABLE webdev_provisioned_sites DROP CONSTRAINT %I', oldname);
  EXECUTE format(
    'ALTER TABLE webdev_provisioned_sites ADD CONSTRAINT %I CHECK (deploy_grant_site_secret_name ~ %L) NOT VALID',
    newname, '^WEBDESK_DEPLOY_[A-Z0-9_]+_[0-9]{1,16}$'
  );
  BEGIN
    EXECUTE format('ALTER TABLE webdev_provisioned_sites VALIDATE CONSTRAINT %I', newname);
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'M6-P6f: % stays NOT VALID: a row holds a legacy-format name; the next grant re-records it', newname;
  END;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'webdev_provisioned_sites'::regclass AND conname = 'wps_deploy_grant_links') THEN
    RAISE EXCEPTION 'M6-P6f: wps_deploy_grant_links went missing';
  END IF;
END $$;

COMMENT ON COLUMN webdev_provisioned_sites.deploy_grant_site_secret_name IS
  'M6-P4g/M6-P6f: the site''s OWN per-site deploy secret, WEBDESK_DEPLOY_<SLUG>_<ENV>_<REPOID> (REPOID = the GitHub '
  'repository id = github.repository_id in the site''s workflow). Derived by siteDeploySecretName() from the resolved '
  'repo, recorded at claim together with deploy_grant_repository_id. An org owner creates it by hand, visible to this repo only.';
