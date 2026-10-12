-- 202610130100_webdev_deploy_grant.sql
--
-- M6-P4g (docs/plans/2026-10-13-webdesk-m6-p4g-deploy-grant.md) — the deploy gate is the org secret grant. Once a
-- provisioned site is a registered, locked repo (a live `webdev_sites` row, the scaffold committed, a CONTRACT.lock on
-- the default branch naming the pinned snapshot), platform-nest adds the repo to each configured org Actions secret's
-- "selected repositories" (`PUT /orgs/{org}/actions/secrets/{name}/repositories/{repo_id}`). The ERP never holds a
-- secret VALUE (WSK-D29); these columns record only WHICH secrets the repo may read, why, and when. The state machine
-- is written out at the top of `src/modules/webdev/deploy-grant.ts`; this file is its schema half.
--
-- ── WHAT THIS ADDS (every step additive; no existing column, CHECK, index or policy is touched) ──────
--   deploy_grant_state          NULL (never granted) | 'pending' (claimed: a PUT may have landed) | 'granted' (every
--                               configured secret granted) | 'revoked'. The claim is committed BEFORE any write to
--                               GitHub, so a crash never leaves a grant this row does not know about.
--   deploy_grant_secret_names   the org secret NAMES the repo is known to hold access to. Grows until a revoke (a name
--                               dropped from the configuration is not forgotten, so a revoke still removes it).
--   deploy_grant_snapshot_id    the contract snapshot the default branch's CONTRACT.lock named at grant time.
--   deploy_grant_repository_id  GitHub's numeric repository id (what the secret endpoints take; stable across renames).
--   deploy_grant_head_sha       the default-branch commit the lock was read at.
--   deploy_grant_error          the last typed reason a grant or revoke could not finish (e.g.
--                               `github_permission_missing: organization_secrets`, `deploy_grant_secret_not_selected: X`).
--                               A token, never a response body.
--   deploy_grant_requested_by   the principal whose grant claimed the row.
--   deploy_grant_updated_at     when the state, the names or the error last moved.
--   deploy_grant_granted_at     when every configured secret was last confirmed granted.
--   deploy_grant_revoked_at / deploy_grant_revoked_by / deploy_grant_revoke_reason   the last revoke (reason required).
--   deploy_grant_site_secret_name  the site's OWN per-site deploy secret, derived by `siteDeploySecretName()`
--                               (`WEBDESK_DEPLOY_<SLUG>_<ENV>_<H8>`, H8 = 8 hex of sha256(site id): the readable part alone
--                               can collide across companies). P6's deploy principal for this site and environment; an
--                               org owner creates it by hand, visible to this repo only. Recorded at claim.
--   deploy_grant_pending_names  secret names that do not exist yet (404). NOT an error: the grant stays 'pending' and the
--                               next run completes it once the owner has created them.
--
-- ── THE INVARIANTS ARE IN THE SCHEMA, NOT ONLY IN THE SERVICE ─────────────────────────────────────────
-- wps_deploy_grant_links: a grant state only on a site whose scaffold is 'committed' (which itself implies a complete
-- §08 completion, wps_scaffold_links), only with the claim's facts; 'granted' only with its time and at least one name;
-- 'revoked' only with its time and reason; a grant state always with the per-site secret's name; 'granted' with no
-- pending name. Names are checked as GitHub secret names; the head sha as 40 hex.
--
-- ── RLS ──────────────────────────────────────────────────────────────────────────────────────────────
-- No new table. webdev_provisioned_sites already has ENABLE + FORCE ROW LEVEL SECURITY and the third wall
-- (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('webdev')) from 0090; new columns inherit it.
--
-- ── ZERO BACKFILL DML ────────────────────────────────────────────────────────────────────────────────
-- Every existing row gets deploy_grant_state NULL, which satisfies every new CHECK.
--
-- ROLLOUT: no reader depends on the columns before this release; the service writes them on the first grant. Until the
-- ERP GitHub App holds `organization_secrets: write` (O-3) every grant records `github_permission_missing:
-- organization_secrets` and stays NULL/pending. To undo: DROP the constraint and the fourteen columns.
ALTER TABLE webdev_provisioned_sites
  ADD COLUMN IF NOT EXISTS deploy_grant_state text
    CHECK (deploy_grant_state IN ('pending', 'granted', 'revoked')),
  ADD COLUMN IF NOT EXISTS deploy_grant_secret_names text[]
    CHECK (
      deploy_grant_secret_names IS NULL
      OR cardinality(deploy_grant_secret_names) = 0
      OR (array_position(deploy_grant_secret_names, NULL) IS NULL
          AND array_to_string(deploy_grant_secret_names, ',') ~ '^[A-Za-z_][A-Za-z0-9_]*(,[A-Za-z_][A-Za-z0-9_]*)*$')
    ),
  ADD COLUMN IF NOT EXISTS deploy_grant_snapshot_id uuid REFERENCES webdev_contract_snapshots (id),
  ADD COLUMN IF NOT EXISTS deploy_grant_repository_id bigint CHECK (deploy_grant_repository_id > 0),
  ADD COLUMN IF NOT EXISTS deploy_grant_head_sha text CHECK (deploy_grant_head_sha ~ '^[0-9a-f]{40}$'),
  ADD COLUMN IF NOT EXISTS deploy_grant_error text,
  ADD COLUMN IF NOT EXISTS deploy_grant_requested_by uuid REFERENCES users (id),
  ADD COLUMN IF NOT EXISTS deploy_grant_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS deploy_grant_granted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deploy_grant_revoked_at timestamptz,
  ADD COLUMN IF NOT EXISTS deploy_grant_revoked_by uuid REFERENCES users (id),
  ADD COLUMN IF NOT EXISTS deploy_grant_revoke_reason text
    CHECK (char_length(btrim(deploy_grant_revoke_reason)) BETWEEN 8 AND 500),
  ADD COLUMN IF NOT EXISTS deploy_grant_site_secret_name text
    CHECK (deploy_grant_site_secret_name ~ '^WEBDESK_DEPLOY_[A-Z0-9_]+_[0-9A-F]{8}$'),
  ADD COLUMN IF NOT EXISTS deploy_grant_pending_names text[]
    CHECK (
      deploy_grant_pending_names IS NULL
      OR cardinality(deploy_grant_pending_names) = 0
      OR (array_position(deploy_grant_pending_names, NULL) IS NULL
          AND array_to_string(deploy_grant_pending_names, ',') ~ '^[A-Za-z_][A-Za-z0-9_]*(,[A-Za-z_][A-Za-z0-9_]*)*$')
    );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'webdev_provisioned_sites'::regclass AND conname = 'wps_deploy_grant_links'
  ) THEN
    ALTER TABLE webdev_provisioned_sites
      ADD CONSTRAINT wps_deploy_grant_links CHECK (
        -- IS NOT DISTINCT FROM, not `=`: with scaffold_state NULL, `= 'committed'` is NULL and a CHECK passes on NULL, so a
        -- grant state could sit on a site that was never scaffolded (caught by deploy-grant.db.test.ts on the Linux gate).
        (deploy_grant_state IS NULL OR scaffold_state IS NOT DISTINCT FROM 'committed')
        AND (deploy_grant_state IS NULL OR (
              deploy_grant_secret_names IS NOT NULL AND deploy_grant_snapshot_id IS NOT NULL
              AND deploy_grant_repository_id IS NOT NULL AND deploy_grant_head_sha IS NOT NULL
              AND deploy_grant_requested_by IS NOT NULL AND deploy_grant_site_secret_name IS NOT NULL
              AND deploy_grant_pending_names IS NOT NULL))
        AND (deploy_grant_state IS DISTINCT FROM 'granted'
             OR (deploy_grant_granted_at IS NOT NULL AND cardinality(deploy_grant_secret_names) > 0
                 AND cardinality(deploy_grant_pending_names) = 0))
        AND (deploy_grant_state IS DISTINCT FROM 'revoked'
             OR (deploy_grant_revoked_at IS NOT NULL AND deploy_grant_revoke_reason IS NOT NULL))
      );
  END IF;
END $$;

COMMENT ON COLUMN webdev_provisioned_sites.deploy_grant_state IS
  'M6-P4g: NULL = never granted | pending = a grant is claimed (a PUT may have landed; secrets so far in '
  'deploy_grant_secret_names) | granted = every configured org deploy secret lists this repo | revoked = removed '
  '(deploy_grant_revoke_reason). The ERP changes which repos may READ an org secret; it never holds a value (WSK-D29).';
