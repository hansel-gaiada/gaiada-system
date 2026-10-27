-- SCP-1h (docs/FRONTEND-BFF-CONTRACT.md §63.1 file 4, §63.6.6; plan §8 row 1h) -- where a picture in the Asset Library came
-- from, and the note an AI-made one must carry.
--
-- `creative_assets` is the Asset Library's table (0031, versions in 202610140730): the plain tenant wall (FORCE RLS on
-- tenant_id, no module wall). Nothing here changes who can read a row. The two columns only describe a version:
--
--   source    'own' | 'client' | 'stock' | 'ai' | 'unknown', NOT NULL, DEFAULT 'unknown'. The default is a constant, so
--             Postgres gives every existing row 'unknown' without rewriting it, and a NEW VERSION of an asset starts
--             'unknown' as well: the save names the source of the bytes it brings, and a version never inherits the
--             source of the one it replaces (new bytes, new origin).
--   ai_note   NULL, or 1 to 1,000 characters: how the picture was made (the tool, the prompt). An AI-made version MUST
--             carry one: `source <> 'ai' OR ai_note IS NOT NULL`. `source` is NOT NULL, so no NULL can slip past it.
--
-- The post's design check reads these (`asset_source_unknown` and `ai_note_missing` warn on a design left 'unknown';
-- the database refuses an AI design without its note, BFF §63.6.6).
--
-- No DML: no row is read or written, so the RLS zero-row trap (an unset tenant GUC reads zero rows of a FORCE-RLS table)
-- cannot bite. The closing DO block asserts the catalogue, never a row count.
--
-- `creative_assets` is not in the sync-engine's write-back registry (sync-engine-go/internal/protocol/writeback.go lists
-- deliverable, campaign and time_entry only), so the two columns reach no replica.
--
-- Applies on its own with plain `psql -f` (CI's sync-engine-go job applies every migration that way, with no ledger) and
-- again without error: every statement is guarded.

ALTER TABLE creative_assets
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS ai_note text;

-- One ALTER keeps the DROP and the ADD of each name together, so a re-run replaces and never stacks.
ALTER TABLE creative_assets
  DROP CONSTRAINT IF EXISTS creative_assets_source_ck,
  ADD CONSTRAINT creative_assets_source_ck CHECK (source IN ('own', 'client', 'stock', 'ai', 'unknown')),
  DROP CONSTRAINT IF EXISTS creative_assets_ai_note_ck,
  ADD CONSTRAINT creative_assets_ai_note_ck CHECK (ai_note IS NULL OR char_length(ai_note) BETWEEN 1 AND 1000),
  -- `source` is NOT NULL, so `source <> 'ai'` is never NULL and an AI row with no note is refused, not waved through.
  DROP CONSTRAINT IF EXISTS creative_assets_ai_needs_note_ck,
  ADD CONSTRAINT creative_assets_ai_needs_note_ck CHECK (source <> 'ai' OR ai_note IS NOT NULL);

-- Assert what this file made: the two columns and the three CHECKs. Catalogue reads only.
DO $$
DECLARE
  n int;
  missing text;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'creative_assets'
     AND ((column_name = 'source' AND data_type = 'text' AND is_nullable = 'NO' AND column_default LIKE '''unknown''%')
       OR (column_name = 'ai_note' AND data_type = 'text' AND is_nullable = 'YES' AND column_default IS NULL));
  IF n <> 2 THEN
    RAISE EXCEPTION '202610271400: creative_assets needs source text NOT NULL DEFAULT ''unknown'' and ai_note text NULL, found % of 2 right', n;
  END IF;

  SELECT string_agg(want.c, ', ') INTO missing
    FROM (VALUES ('creative_assets_source_ck'), ('creative_assets_ai_note_ck'), ('creative_assets_ai_needs_note_ck')) AS want(c)
   WHERE NOT EXISTS (SELECT 1 FROM pg_constraint pc
                      WHERE pc.conrelid = to_regclass('creative_assets') AND pc.conname = want.c AND pc.contype = 'c' AND pc.convalidated);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '202610271400: missing or unvalidated constraints on creative_assets: %', missing;
  END IF;

  -- The wall is untouched: creative_assets still has RLS enabled and forced.
  SELECT count(*) INTO n FROM pg_class
   WHERE oid = to_regclass('creative_assets') AND relrowsecurity AND relforcerowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610271400: creative_assets must keep RLS ENABLED and FORCED';
  END IF;
END $$;
