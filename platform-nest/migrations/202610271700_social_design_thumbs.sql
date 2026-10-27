-- SCP-2b (docs/FRONTEND-BFF-CONTRACT.md §63.1 file 10, §63.8 "Thumbnails"; plan §10) -- the stored thumbnail of a post's design.
--
-- A post's design is materialized as a `files` row at final_approve (SCP-D8) and remembered on `social_post_designs.file_id`.
-- The client's approval page and the staff feed list that picture for about 600 cards across two months, so a list must not
-- ship the full-size file. One column remembers the small copy:
--
--   thumb_file_id   uuid NULL, REFERENCES files(id). The WebP thumbnail (fits inside 640 x 640) of `file_id`, itself a `files`
--                   row targeting the same post. NULL means no thumbnail yet or none possible (a video, a failed resize): the
--                   reads fall back to `file_id`, so a NULL is never an error. The code resets it to NULL whenever `file_id`
--                   moves to a new version, so a thumbnail never outlives the picture it was made from.
--
-- No RLS change: `social_post_designs` keeps its third wall untouched, and `files` keeps its plain tenant wall.
-- No DML: no row is read or written, so the RLS zero-row trap (an unset tenant GUC reads zero rows of a FORCE-RLS table)
-- cannot bite. The closing DO block asserts the catalogue, never a row count.
--
-- `social_post_designs` is not in the sync-engine's write-back registry (sync-engine-go/internal/protocol/writeback.go lists
-- deliverable, campaign and time_entry only), so the column reaches no replica.
--
-- Applies on its own with plain `psql -f` (CI's sync-engine-go job applies every migration that way, with no ledger) and
-- again without error: every statement is guarded.

ALTER TABLE social_post_designs
  ADD COLUMN IF NOT EXISTS thumb_file_id uuid REFERENCES files(id);

-- Assert what this file made: the column, its type and nullability, its foreign key to files, and the wall left in place.
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'social_post_designs'
     AND column_name = 'thumb_file_id' AND data_type = 'uuid' AND is_nullable = 'YES' AND column_default IS NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610271700: social_post_designs needs thumb_file_id uuid NULL with no default';
  END IF;

  SELECT count(*) INTO n FROM pg_constraint pc
   WHERE pc.conrelid = to_regclass('social_post_designs') AND pc.contype = 'f'
     AND pc.confrelid = to_regclass('files')
     AND pc.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = to_regclass('social_post_designs') AND attname = 'thumb_file_id')];
  IF n <> 1 THEN
    RAISE EXCEPTION '202610271700: social_post_designs.thumb_file_id must reference files(id)';
  END IF;

  -- The wall is untouched: social_post_designs still has RLS enabled and forced.
  SELECT count(*) INTO n FROM pg_class
   WHERE oid = to_regclass('social_post_designs') AND relrowsecurity AND relforcerowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610271700: social_post_designs must keep RLS ENABLED and FORCED';
  END IF;
END $$;
