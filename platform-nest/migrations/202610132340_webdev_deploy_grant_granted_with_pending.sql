-- 202610132340_webdev_deploy_grant_granted_with_pending.sql — M6-P6h2 (docs/plans/2026-10-11-webdesk-m6-plan.md, the M6-P6h2 row;
-- docs/plans/2026-10-13-webdesk-m6-p4g-deploy-grant.md): the deploy grant also grants a site's PRODUCTION per-site secret.
--
-- ── WHY A MIGRATION AT ALL ─────────────────────────────────────────────────────────────────────────
-- How the two per-site names are RECORDED needs no DDL: the production name is derived with the same function and repository id
-- as the staging one, so it lives in the existing `deploy_grant_secret_names` once its PUT landed and in
-- `deploy_grant_pending_names` while the owner has not created the secret. `deploy_grant_site_secret_name` stays the staging
-- row's name (its shape CHECK, 202610132210, is unchanged and still right for both).
--
-- What DOES need DDL is one rule of `wps_deploy_grant_links` (202610130100): "granted ⇒ cardinality(deploy_grant_pending_names)
-- = 0". A site granted at staging is `granted`; when its production row is created and the owner has not created the production
-- secret yet, the grant records that name as pending. With the rule the UPDATE would be refused (23514), and the only other way
-- out is to demote the site to `pending`, which stops the STAGING rebuilds the site already has (a build target needs the grant
-- `granted`, M6-P6h). So the rule is lifted: `granted` keeps meaning "a full grant landed" (granted_at, at least one name), and
-- the names that were added after it are listed pending until a grant run completes them (which re-asserts `granted` and
-- clears the list). Nothing reads "pending names is empty" as a fact about `granted`; consumers ask about ONE name.
--
-- ── WHAT CHANGES: ONE CLAUSE OF ONE CHECK ───────────────────────────────────────────────────────────
-- The constraint is rebuilt from its LIVE definition (`pg_get_constraintdef`), not retyped (a DROP + ADD from memory silently
-- deletes whatever a later migration added; see 202610132320_webdev_site_builds_kind_promote.sql, whose pattern this follows).
-- Only the single `AND (cardinality(deploy_grant_pending_names) = 0)` term of the `granted` arm is removed from the text; every
-- other clause is carried over byte for byte. Every migration that names the constraint (`grep -l wps_deploy_grant_links
-- migrations/`): 202610130100 declares it, 202610130110 and 202610132210 only mention it (the latter asserts it still exists).
--
-- ── WHAT STAYS TRUE ─────────────────────────────────────────────────────────────────────────────────
-- * A grant state still needs a COMMITTED scaffold and every claim fact; `granted` still needs its time and at least one name;
--   `revoked` still needs its time and reason. The column's own CHECK on `deploy_grant_pending_names` (valid names only) is a
--   different constraint and is untouched.
-- * The constraint keeps its name. Relaxing a CHECK cannot fail on existing rows, and no row is touched: zero DML, so the RLS
--   zero-row trap has nothing to bite.
-- * Re-running is a no-op: a definition without the term is left alone.
--
-- ── ASSERT, DON'T ASSUME ────────────────────────────────────────────────────────────────────────────
-- Before: exactly ONE constraint of that name, and its definition holds the term exactly once (a rendering this migration does
-- not recognise is refused, never silently skipped). After: the constraint exists, the term is gone, and every other
-- clause the old definition held is still there. Any failure raises and the file rolls back (migrate.ts: one transaction per file).
DO $$
DECLARE
  n_found   integer;
  old_def   text;
  new_def   text;
  term      text := '\s+AND\s+\(cardinality\(deploy_grant_pending_names\)\s*=\s*0\)';
  n_terms   integer;
  must_keep text[] := ARRAY[
    'scaffold_state', 'committed', 'deploy_grant_secret_names', 'deploy_grant_snapshot_id', 'deploy_grant_repository_id',
    'deploy_grant_head_sha', 'deploy_grant_requested_by', 'deploy_grant_site_secret_name', 'deploy_grant_pending_names',
    'granted', 'deploy_grant_granted_at', 'revoked', 'deploy_grant_revoked_at', 'deploy_grant_revoke_reason'
  ];
  k         text;
BEGIN
  SELECT count(*) INTO n_found
    FROM pg_constraint
   WHERE conrelid = 'webdev_provisioned_sites'::regclass AND contype = 'c' AND conname = 'wps_deploy_grant_links';
  IF n_found <> 1 THEN
    RAISE EXCEPTION 'M6-P6h2: expected exactly ONE wps_deploy_grant_links on webdev_provisioned_sites, found % — refusing to guess', n_found;
  END IF;

  SELECT pg_get_constraintdef(oid) INTO old_def
    FROM pg_constraint
   WHERE conrelid = 'webdev_provisioned_sites'::regclass AND contype = 'c' AND conname = 'wps_deploy_grant_links';

  SELECT count(*) INTO n_terms FROM regexp_matches(old_def, term, 'g');

  IF n_terms = 0 THEN
    -- Already relaxed (a re-run). But "no match" must mean "the term is not there", not "the rendering changed": the constraint
    -- may not mention the cardinality of the pending names at all any more.
    IF old_def ~ 'cardinality\(deploy_grant_pending_names\)' THEN
      RAISE EXCEPTION 'M6-P6h2: wps_deploy_grant_links mentions cardinality(deploy_grant_pending_names) in a form this migration does not recognise (%) — refusing to proceed', old_def;
    END IF;
    RAISE NOTICE 'M6-P6h2: wps_deploy_grant_links already lets a granted row list pending names — nothing to do';
    RETURN;
  END IF;
  IF n_terms <> 1 THEN
    RAISE EXCEPTION 'M6-P6h2: expected the pending-names term exactly once in wps_deploy_grant_links, found % (%)', n_terms, old_def;
  END IF;

  new_def := regexp_replace(old_def, term, '', 'g');

  -- The old definition must be the one this change was written against: every clause the rebuilt one must keep is present.
  FOREACH k IN ARRAY must_keep LOOP
    IF position(k IN old_def) = 0 THEN
      RAISE EXCEPTION 'M6-P6h2: the live wps_deploy_grant_links (%) has drifted: it no longer mentions %', old_def, k;
    END IF;
  END LOOP;

  EXECUTE 'ALTER TABLE webdev_provisioned_sites DROP CONSTRAINT wps_deploy_grant_links';
  EXECUTE format('ALTER TABLE webdev_provisioned_sites ADD CONSTRAINT wps_deploy_grant_links %s', new_def);

  -- Assert on what the database now holds, not on what this block meant to write.
  SELECT count(*) INTO n_found
    FROM pg_constraint
   WHERE conrelid = 'webdev_provisioned_sites'::regclass AND contype = 'c' AND conname = 'wps_deploy_grant_links';
  IF n_found <> 1 THEN
    RAISE EXCEPTION 'M6-P6h2: wps_deploy_grant_links missing after the rebuild';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO new_def
    FROM pg_constraint
   WHERE conrelid = 'webdev_provisioned_sites'::regclass AND contype = 'c' AND conname = 'wps_deploy_grant_links';
  IF new_def ~ term THEN
    RAISE EXCEPTION 'M6-P6h2: the pending-names term is still in wps_deploy_grant_links after the rebuild (%)', new_def;
  END IF;
  FOREACH k IN ARRAY must_keep LOOP
    IF position(k IN new_def) = 0 THEN
      RAISE EXCEPTION 'M6-P6h2: % was in the old wps_deploy_grant_links and is missing from the new one (%)', k, new_def;
    END IF;
  END LOOP;

  RAISE NOTICE 'M6-P6h2: wps_deploy_grant_links rebuilt from the live definition without the granted => no pending names term';
END $$;

COMMENT ON COLUMN webdev_provisioned_sites.deploy_grant_pending_names IS
  'M6-P4g: org secret names the owner has not created yet (GitHub 404), so the grant could not add this repo to them; a grant run '
  'completes them once they exist. M6-P6h2: a site that is already `granted` may list names here (its production per-site secret '
  'after the production row is created, or a name added to the configuration): the state is not demoted, so the builds it already '
  'has keep working, and the next full grant run clears the list.';
