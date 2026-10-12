-- 202610122130_webdev_scaffold_commit.sql
--
-- M6-P4b2 (docs/plans/2026-10-12-webdesk-m6-p4b2-scaffold-commit.md) — platform-nest commits the tree
-- `code.scaffold` v2 composed into the provisioned repo's default branch, with the ERP GitHub App, through the Git
-- Data API (blobs -> tree -> commit -> fast-forward ref). FIRST FILL ONLY: a write over anything but the
-- template's generated commit is refused. These columns record that one write so it is crash-resumable and an
-- identical re-submit is a no-op. The state machine is written out at the top of
-- `src/modules/webdev/scaffold-commit.ts`; this file is its schema half.
--
-- ── WHAT THIS ADDS (every step additive; no existing column, CHECK, index or policy is touched) ──────
--   scaffold_state            NULL (not begun) | 'pending' (claimed) | 'commit_created' (the commit object exists
--                             at GitHub, not yet on the branch) | 'committed' (the branch points at it). Monotone
--                             except that an UNLANDED claim (pending / commit_created while the branch is still the
--                             template commit) may be superseded by a different tree; never after 'committed'.
--   scaffold_manifest_sha256  sha256 (hex) of the canonical manifest (sorted path, sha256, bytes). THE identity of a
--                             tree: an identical re-submit compares equal and returns the recorded commit.
--   scaffold_snapshot_id      the contract snapshot the tree's CONTRACT.lock names (= the site's pinned one).
--   scaffold_branch           the default branch written to.
--   scaffold_base_sha         the template-generated commit the fill sits on (the commit's only parent).
--   scaffold_tree_sha         the git tree created.
--   scaffold_commit_sha       the git commit created; the branch is fast-forwarded to it.
--   scaffold_file_count / scaffold_total_bytes   what was written (bytes = sum of file sizes).
--   scaffold_goal_id          the ai-agents goal that composed it (another database: no FK).
--   scaffold_requested_by     the acting principal's user.
--   scaffold_error            the last typed reason a step could not finish. A token, never a response body.
--   scaffold_updated_at       when the state or the error last moved.
--   scaffold_committed_at     when the branch was moved.
--
-- ── THE INVARIANTS ARE IN THE SCHEMA, NOT ONLY IN THE SERVICE ─────────────────────────────────────────
-- wps_scaffold_links: a scaffold state only on a site whose completion is 'complete' (the pin exists), only with the
-- claim's facts, and 'commit_created'/'committed' only with the tree and commit sha ('committed' also with its time).
-- The sha columns are shape-checked (40 lowercase hex, SHA-1 object ids as GitHub returns them).
--
-- ── RLS ──────────────────────────────────────────────────────────────────────────────────────────────
-- No new table. webdev_provisioned_sites already has ENABLE + FORCE ROW LEVEL SECURITY and the third wall
-- (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('webdev')) from 0090; new columns inherit it.
--
-- ── ZERO BACKFILL DML ────────────────────────────────────────────────────────────────────────────────
-- Every existing row gets scaffold_state NULL, which satisfies every new CHECK.
--
-- ROLLOUT: no reader depends on the columns before this release; the service writes them on the first
-- scaffold commit. To undo: DROP the constraint and the fourteen columns.
ALTER TABLE webdev_provisioned_sites
  ADD COLUMN IF NOT EXISTS scaffold_state text
    CHECK (scaffold_state IN ('pending', 'commit_created', 'committed')),
  ADD COLUMN IF NOT EXISTS scaffold_manifest_sha256 text
    CHECK (scaffold_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN IF NOT EXISTS scaffold_snapshot_id uuid REFERENCES webdev_contract_snapshots (id),
  ADD COLUMN IF NOT EXISTS scaffold_branch text,
  ADD COLUMN IF NOT EXISTS scaffold_base_sha text CHECK (scaffold_base_sha ~ '^[0-9a-f]{40}$'),
  ADD COLUMN IF NOT EXISTS scaffold_tree_sha text CHECK (scaffold_tree_sha ~ '^[0-9a-f]{40}$'),
  ADD COLUMN IF NOT EXISTS scaffold_commit_sha text CHECK (scaffold_commit_sha ~ '^[0-9a-f]{40}$'),
  ADD COLUMN IF NOT EXISTS scaffold_file_count integer CHECK (scaffold_file_count >= 0),
  ADD COLUMN IF NOT EXISTS scaffold_total_bytes integer CHECK (scaffold_total_bytes >= 0),
  ADD COLUMN IF NOT EXISTS scaffold_goal_id uuid,
  ADD COLUMN IF NOT EXISTS scaffold_requested_by uuid REFERENCES users (id),
  ADD COLUMN IF NOT EXISTS scaffold_error text,
  ADD COLUMN IF NOT EXISTS scaffold_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS scaffold_committed_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'webdev_provisioned_sites'::regclass AND conname = 'wps_scaffold_links'
  ) THEN
    ALTER TABLE webdev_provisioned_sites
      ADD CONSTRAINT wps_scaffold_links CHECK (
        (scaffold_state IS NULL OR completion_state = 'complete')
        AND (scaffold_state IS NULL OR (
              scaffold_manifest_sha256 IS NOT NULL AND scaffold_snapshot_id IS NOT NULL
              AND scaffold_branch IS NOT NULL AND scaffold_base_sha IS NOT NULL))
        AND (scaffold_state IS NULL OR scaffold_state = 'pending'
             OR (scaffold_tree_sha IS NOT NULL AND scaffold_commit_sha IS NOT NULL))
        AND (scaffold_state IS DISTINCT FROM 'committed' OR scaffold_committed_at IS NOT NULL)
      );
  END IF;
END $$;

COMMENT ON COLUMN webdev_provisioned_sites.scaffold_state IS
  'M6-P4b2: NULL = no scaffold written | pending = a verified tree is claimed (manifest digest, base commit) | '
  'commit_created = the commit object exists at GitHub (scaffold_commit_sha), the branch not yet moved | '
  'committed = the default branch was fast-forwarded to it. First fill only; an identical re-submit is a no-op.';
