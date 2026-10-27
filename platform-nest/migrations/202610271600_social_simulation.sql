-- SCP-Sa (docs/FRONTEND-BFF-CONTRACT.md §63.1 file 8; plan §5, SCP-D1, SCP-D3) -- the marks the social simulator writes,
-- named here so the names are fixed before anything writes them.
--
-- The owner ruled (SCP-D1) that the whole content pipeline is proved on mock data with every step simulated, publishing
-- included. That reverses the social module's own "no simulator" rule (publisher/mock-driver.ts's header): a simulated
-- publish is a post that never appeared on a client's account while our calendar said it did. These three columns are
-- how a simulated row says so, structurally, for as long as it exists:
--
--   social_accounts.simulated        boolean NOT NULL DEFAULT false. TRUE only on a seeded mock account (SCP-Sb). Under
--                                    SOCIAL_SIMULATION_ENABLED this is the ONE fact that routes a variant to the
--                                    simulated publisher (publisher/simulated-driver.ts); nothing else ever does.
--   social_post_variants.simulated   boolean NOT NULL DEFAULT false. Set TRUE by the dispatch stamp when the simulator
--                                    served the publish (dispatch.ts), in the same UPDATE as the status.
--   social_metrics_daily.source      text NOT NULL DEFAULT 'pull', 'pull' | 'simulated'. 'simulated' is SCP-Sd's
--                                    generator; every row the nightly pull wrote is a real 'pull'.
--
-- The defaults are constants, so Postgres gives every EXISTING row false / 'pull' without rewriting it: everything
-- written before this file is real, and stays real. No existing row changes, and none is read.
--
-- The containment rules are not here: the database cannot see an environment flag. They are SCP-Sa's code (boot errors in
-- publisher/boot.ts, runtime refusals in publisher/simulation.ts and every account writer). This file only makes the mark
-- impossible to omit (NOT NULL) and impossible to misspell (the named CHECK).
--
-- No DML: no row is read or written, so the RLS zero-row trap (an unset tenant GUC reads zero rows of a FORCE-RLS table)
-- cannot bite. The closing DO block asserts the catalogue, never a row count.
--
-- None of the three tables is in the sync-engine's write-back registry (sync-engine-go/internal/protocol/writeback.go
-- lists deliverable, campaign and time_entry only), so the columns reach no replica.
--
-- Applies on its own with plain `psql -f` (CI's sync-engine-go job applies every migration that way, with no ledger) and
-- again without error: every statement is guarded.

ALTER TABLE social_accounts
  ADD COLUMN IF NOT EXISTS simulated boolean NOT NULL DEFAULT false;

ALTER TABLE social_post_variants
  ADD COLUMN IF NOT EXISTS simulated boolean NOT NULL DEFAULT false;

ALTER TABLE social_metrics_daily
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'pull';

-- One ALTER keeps the DROP and the ADD together, so a re-run replaces and never stacks. `source` is NOT NULL, so the CHECK
-- never meets a NULL it would wave through.
ALTER TABLE social_metrics_daily
  DROP CONSTRAINT IF EXISTS social_metrics_daily_source_ck,
  ADD CONSTRAINT social_metrics_daily_source_ck CHECK (source IN ('pull', 'simulated'));

-- Assert what this file made: the three columns, their defaults, the CHECK, and the walls left as they were. Catalogue
-- reads only.
DO $$
DECLARE
  n int;
  t text;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema()
     AND ((table_name = 'social_accounts' AND column_name = 'simulated' AND data_type = 'boolean'
            AND is_nullable = 'NO' AND column_default = 'false')
       OR (table_name = 'social_post_variants' AND column_name = 'simulated' AND data_type = 'boolean'
            AND is_nullable = 'NO' AND column_default = 'false')
       OR (table_name = 'social_metrics_daily' AND column_name = 'source' AND data_type = 'text'
            AND is_nullable = 'NO' AND column_default LIKE '''pull''%'));
  IF n <> 3 THEN
    RAISE EXCEPTION '202610271600: need social_accounts.simulated and social_post_variants.simulated (boolean NOT NULL DEFAULT false) and social_metrics_daily.source (text NOT NULL DEFAULT ''pull''), found % of 3 right', n;
  END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = to_regclass('social_metrics_daily') AND conname = 'social_metrics_daily_source_ck'
     AND contype = 'c' AND convalidated;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610271600: social_metrics_daily_source_ck is missing or unvalidated';
  END IF;

  -- The walls are untouched: all three tables keep RLS enabled and forced (0105's third wall).
  FOREACH t IN ARRAY ARRAY['social_accounts', 'social_post_variants', 'social_metrics_daily'] LOOP
    SELECT count(*) INTO n FROM pg_class
     WHERE oid = to_regclass(t) AND relrowsecurity AND relforcerowsecurity;
    IF n <> 1 THEN
      RAISE EXCEPTION '202610271600: % must keep RLS ENABLED and FORCED', t;
    END IF;
  END LOOP;
END $$;
