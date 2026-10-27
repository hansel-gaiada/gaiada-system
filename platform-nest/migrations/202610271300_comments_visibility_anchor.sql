-- SCP-1l (docs/FRONTEND-BFF-CONTRACT.md §63.1 file 3, §63.8; plan §8 row 1l) -- the shared comment thread gains a
-- visibility (team-only or client-visible) and a pin on the image.
--
-- `comments` is the core thread (0001_core.sql): FORCE RLS on tenant_id, no module wall. Nothing here changes who can
-- read a row. The two columns only describe a row, and the CHECKs keep them to the one thread that may use them: a
-- `social_post` thread. So no other thread (a task, a deal, a creative asset) can ever carry a client-visible comment or a
-- pin, and so none can leak to a portal.
--
--   visibility  'team' (default) or 'client'. Every existing row reads 'team': the default is a constant, so Postgres
--               gives existing rows the value without rewriting them.
--   anchor      NULL, or a pin {x, y, fileId}: x and y numbers from 0 to 1 (a fraction of the image), fileId a string
--               (the file of the post the pin sits on; the route checks that it belongs to the post).
--
-- No DML: no row is read or written, so the RLS zero-row trap (an unset tenant GUC reads zero rows of a FORCE-RLS table)
-- cannot bite. The closing DO block asserts the catalogue, never a row count.
--
-- `comments` is not in the sync-engine's write-back registry (sync-engine-go/internal/protocol/writeback.go lists
-- deliverable, campaign and time_entry only) and no sync_app grant names it, so the two columns reach no replica.
--
-- Applies on its own with plain `psql -f` (CI's sync-engine-go job applies every migration that way, with no ledger) and
-- again without error: every statement is guarded.

ALTER TABLE comments
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'team',
  ADD COLUMN IF NOT EXISTS anchor jsonb;

-- One ALTER per constraint group keeps the DROP and the ADD of a name together, so a re-run replaces and never stacks.
ALTER TABLE comments
  DROP CONSTRAINT IF EXISTS comments_visibility_ck,
  ADD CONSTRAINT comments_visibility_ck CHECK (visibility IN ('team', 'client')),
  -- Only a social_post thread may carry a client-visible comment. Both columns are NOT NULL, so no NULL can pass this.
  DROP CONSTRAINT IF EXISTS comments_visibility_scope_ck,
  ADD CONSTRAINT comments_visibility_scope_ck CHECK (visibility = 'team' OR target_entity_type = 'social_post'),
  -- A pin {x, y, fileId}: x and y numbers from 0 to 1, fileId a string. CASE keeps the numeric casts off anything that is
  -- not a number, so a malformed pin is a CHECK violation rather than a cast error (the shape of spcr_anchor_ck, 1b).
  DROP CONSTRAINT IF EXISTS comments_anchor_shape_ck,
  ADD CONSTRAINT comments_anchor_shape_ck CHECK (
    anchor IS NULL OR CASE
      WHEN jsonb_typeof(anchor) = 'object'
       AND jsonb_typeof(anchor->'x') IS NOT DISTINCT FROM 'number'
       AND jsonb_typeof(anchor->'y') IS NOT DISTINCT FROM 'number'
       AND jsonb_typeof(anchor->'fileId') IS NOT DISTINCT FROM 'string'
      THEN (anchor->>'x')::numeric BETWEEN 0 AND 1 AND (anchor->>'y')::numeric BETWEEN 0 AND 1
      ELSE false
    END
  ),
  -- Only a social_post thread may carry a pin.
  DROP CONSTRAINT IF EXISTS comments_anchor_scope_ck,
  ADD CONSTRAINT comments_anchor_scope_ck CHECK (anchor IS NULL OR target_entity_type = 'social_post');

-- The thread read: one entity's live comments in time order (there was no index on the target until now).
CREATE INDEX IF NOT EXISTS ix_comments_target
  ON comments (tenant_id, target_entity_type, target_entity_id, created_at)
  WHERE deleted_at IS NULL;

-- Assert what this file made: the columns, the four CHECKs, the index. Catalogue reads only.
DO $$
DECLARE
  n int;
  missing text;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'comments'
     AND ((column_name = 'visibility' AND data_type = 'text' AND is_nullable = 'NO' AND column_default LIKE '''team''%')
       OR (column_name = 'anchor' AND data_type = 'jsonb' AND is_nullable = 'YES' AND column_default IS NULL));
  IF n <> 2 THEN
    RAISE EXCEPTION '202610271300: comments needs visibility text NOT NULL DEFAULT ''team'' and anchor jsonb NULL, found % of 2 right', n;
  END IF;

  SELECT string_agg(want.c, ', ') INTO missing
    FROM (VALUES ('comments_visibility_ck'), ('comments_visibility_scope_ck'),
                 ('comments_anchor_shape_ck'), ('comments_anchor_scope_ck')) AS want(c)
   WHERE NOT EXISTS (SELECT 1 FROM pg_constraint pc
                      WHERE pc.conrelid = to_regclass('comments') AND pc.conname = want.c AND pc.contype = 'c' AND pc.convalidated);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '202610271300: missing or unvalidated constraints on comments: %', missing;
  END IF;

  SELECT count(*) INTO n FROM pg_indexes
   WHERE schemaname = current_schema() AND tablename = 'comments' AND indexname = 'ix_comments_target'
     AND indexdef LIKE '%(tenant_id, target_entity_type, target_entity_id, created_at)%'
     AND indexdef LIKE '%WHERE (deleted_at IS NULL)%';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610271300: ix_comments_target must be on (tenant_id, target_entity_type, target_entity_id, created_at) WHERE deleted_at IS NULL';
  END IF;

  -- The wall is untouched: comments still has RLS enabled and forced, with its one tenant policy.
  SELECT count(*) INTO n FROM pg_class
   WHERE oid = to_regclass('comments') AND relrowsecurity AND relforcerowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610271300: comments must keep RLS ENABLED and FORCED';
  END IF;
END $$;
