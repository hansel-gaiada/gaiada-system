-- SCP-3c (docs/FRONTEND-BFF-CONTRACT.md §63.1 file 6, §63.10 "Metrics"; plan §4.2, §8 row 3c) -- post metrics that are typed in by
-- hand (or, later, simulated), not only pulled by the nightly job, and the reach the engagement rate needs.
--
-- `social_post_metrics` is 0105's table of per-variant snapshots: APPEND-ONLY by convention (the nightly pull inserts a row
-- per run; no UPDATE or DELETE touches it, and no trigger enforces that today, so there is none here to work around). It
-- carries the third wall (`tenant_id = ANY(app_current_tenants()) AND app_module_allowed('social')`, FORCE RLS). Nothing in this
-- file changes who can read or write a row. Three columns describe a snapshot's origin and its reach:
--
--   source      'pull' | 'manual' | 'simulated', NOT NULL, DEFAULT 'pull'. The default is a constant, so Postgres gives every
--               existing row 'pull' without rewriting it: every row today came from the nightly pull.
--   reach       NULL, or an integer >= 0. The engagement rate is (likes + comments + saves + shares) / reach and the table had
--               no reach. NULL means "not reported" (never 0: an absent counter is "we do not know", metrics-job.ts); the
--               nightly pull does not report reach today, so its rows keep NULL here.
--   entered_by  NULL, or the user who typed the numbers in (REFERENCES users). Exactly the 'manual' rows carry one:
--               `(source = 'manual') = (entered_by IS NOT NULL)`. `source` is NOT NULL, so the left side is never NULL and a
--               manual row with no author, or a pulled or simulated row with one, is refused rather than waved through.
--
-- No DML: no row is read or written, so the RLS zero-row trap (an unset tenant GUC reads zero rows of a FORCE-RLS table)
-- cannot bite. The closing DO block asserts the catalogue, never a row count.
--
-- `social_post_metrics` is not in the sync-engine's write-back registry (sync-engine-go/internal/protocol/writeback.go lists
-- deliverable, campaign and time_entry only), so the new columns reach no replica.
--
-- Applies on its own with plain `psql -f` (CI's sync-engine-go job applies every migration that way, with no ledger) and
-- again without error: every statement is guarded.

ALTER TABLE social_post_metrics
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'pull',
  ADD COLUMN IF NOT EXISTS reach integer,
  ADD COLUMN IF NOT EXISTS entered_by uuid;

-- One ALTER keeps the DROP and the ADD of each name together, so a re-run replaces and never stacks.
ALTER TABLE social_post_metrics
  DROP CONSTRAINT IF EXISTS social_post_metrics_source_ck,
  ADD CONSTRAINT social_post_metrics_source_ck CHECK (source IN ('pull', 'manual', 'simulated')),
  DROP CONSTRAINT IF EXISTS social_post_metrics_reach_ck,
  ADD CONSTRAINT social_post_metrics_reach_ck CHECK (reach IS NULL OR reach >= 0),
  DROP CONSTRAINT IF EXISTS fk_social_post_metrics_entered_by,
  ADD CONSTRAINT fk_social_post_metrics_entered_by FOREIGN KEY (entered_by) REFERENCES users (id),
  -- `source` is NOT NULL, so `source = 'manual'` is never NULL: both directions are enforced.
  DROP CONSTRAINT IF EXISTS social_post_metrics_entered_by_ck,
  ADD CONSTRAINT social_post_metrics_entered_by_ck CHECK ((source = 'manual') = (entered_by IS NOT NULL));

-- Assert what this file made: the three columns, the four constraints, and the untouched wall. Catalogue reads only.
DO $$
DECLARE
  n int;
  missing text;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'social_post_metrics'
     AND ((column_name = 'source' AND data_type = 'text' AND is_nullable = 'NO' AND column_default LIKE '''pull''%')
       OR (column_name = 'reach' AND data_type = 'integer' AND is_nullable = 'YES' AND column_default IS NULL)
       OR (column_name = 'entered_by' AND data_type = 'uuid' AND is_nullable = 'YES' AND column_default IS NULL));
  IF n <> 3 THEN
    RAISE EXCEPTION '202610271500: social_post_metrics needs source text NOT NULL DEFAULT ''pull'', reach integer NULL and entered_by uuid NULL, found % of 3 right', n;
  END IF;

  SELECT string_agg(want.c, ', ') INTO missing
    FROM (VALUES ('social_post_metrics_source_ck', 'c'), ('social_post_metrics_reach_ck', 'c'),
                 ('social_post_metrics_entered_by_ck', 'c'), ('fk_social_post_metrics_entered_by', 'f')) AS want(c, t)
   WHERE NOT EXISTS (SELECT 1 FROM pg_constraint pc
                      WHERE pc.conrelid = to_regclass('social_post_metrics') AND pc.conname = want.c
                        AND pc.contype = want.t::"char" AND pc.convalidated);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '202610271500: missing or unvalidated constraints on social_post_metrics: %', missing;
  END IF;

  -- The wall is untouched: social_post_metrics still has RLS enabled and forced.
  SELECT count(*) INTO n FROM pg_class
   WHERE oid = to_regclass('social_post_metrics') AND relrowsecurity AND relforcerowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610271500: social_post_metrics must keep RLS ENABLED and FORCED';
  END IF;
END $$;
