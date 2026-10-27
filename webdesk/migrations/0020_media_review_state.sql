-- webdesk/migrations/0020_media_review_state.sql
-- M5-W1q (owner ruling WSK-D84, writers' room design docs/plans/2026-10-11-m5-writers-room-design.md section 3.1 item 6 and Q2):
-- the CONTRIBUTOR UPLOAD QUARANTINE. A freelance writer may upload media, but the asset is not served anywhere
-- until a staff editor accepts it, on top of the malware scan every upload already passes (WSK-D80).
--
-- 1. media_assets.review_state: the review state of a library asset.
--
--        accepted     served (the public media route, the transform route): every row that exists today, every
--                     staff upload, every API-key upload, and a contributor's upload once a staff editor accepts it;
--        quarantined  a contributor's upload that no staff editor has judged yet: NEVER served by any route;
--        rejected     a staff editor refused it: never served. The review command also soft-deletes the row
--                     (deleted_at / purge_after, migration 0014), so the existing `media-purge` job frees the stored
--                     object once the bucket's GOVERNANCE retention lapses. The state stays 'rejected' for the record.
--
--    NOT NULL DEFAULT 'accepted': every existing row reads 'accepted' and every code path that never names the
--    column (the API-key route, the tombstone row) keeps behaving as before. The only writer of 'quarantined' is the
--    token upload route, which copies it from the upload token (below); nothing a caller sends can set it.
--    reviewed_by / reviewed_at record who judged it and when (reviewed_by is the editorial principal's opaque sub,
--    like created_by); both are NULL until a decision is made, and the CHECK ties them together.
--
-- 2. media_upload_tokens.quarantine: set at MINT time from the signed editorial principal (a contributor's assertion
--    carries `xc: true`), never from the upload request. The upload route reads it back and creates the asset
--    quarantined, so the marker is fixed by the credential the ERP issued and cannot be dodged by the uploader.
--    DEFAULT false: tokens minted before this migration were minted by staff or clients (a contributor could not
--    mint one: media.uploadToken was outside CONTRIBUTOR_COMMANDS until this ticket).
--
-- RLS and grants: nothing to do. Both tables keep their FORCE ROW LEVEL SECURITY policy and new columns inherit the
-- table-level grants. No DML here, so this file is clear of the RLS zero-row trap (lint-migration-rls.mjs).
-- Re-runnable: IF NOT EXISTS on the columns; the constraints are dropped and re-added.

ALTER TABLE media_assets
  ADD COLUMN IF NOT EXISTS review_state text        NOT NULL DEFAULT 'accepted',
  ADD COLUMN IF NOT EXISTS reviewed_by  text,
  ADD COLUMN IF NOT EXISTS reviewed_at  timestamptz;

ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_review_state_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_review_state_check
  CHECK (review_state IN ('accepted', 'quarantined', 'rejected'));

-- A quarantined row has no reviewer yet; reviewed_by and reviewed_at come together. (A row accepted by default, a
-- staff upload, has neither: only a decision on a quarantined asset writes them.)
ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_review_decision_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_review_decision_check
  CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL) AND (review_state <> 'quarantined' OR reviewed_by IS NULL));

-- The review queue: the few rows waiting for a decision, newest first.
CREATE INDEX IF NOT EXISTS ix_media_assets_quarantined ON media_assets (site_id, created_at DESC)
  WHERE review_state = 'quarantined' AND deleted_at IS NULL;

ALTER TABLE media_upload_tokens
  ADD COLUMN IF NOT EXISTS quarantine boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN media_assets.review_state IS
  'M5-W1q (WSK-D84): accepted | quarantined | rejected. Only accepted is ever served (public media route, transform route). A contributor''s upload is born quarantined; media.review moves it to accepted or rejected (rejected also soft-deletes it, so media-purge frees the bytes).';
COMMENT ON COLUMN media_upload_tokens.quarantine IS
  'M5-W1q (WSK-D84): true when the token was minted for a contributor principal (xc). The asset the token uploads is created quarantined. Set at mint, never from the upload request.';
