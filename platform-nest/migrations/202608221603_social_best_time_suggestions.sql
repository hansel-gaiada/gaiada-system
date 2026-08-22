-- SMM-27 — best-time-to-post: a cached, classical-stats suggestion per connected account, computed
-- nightly by `src/modules/social/best-time-job.ts` from `social_post_variants.published_at` +
-- `social_post_metrics` (SMM-21's own tables — this ticket adds no new source data, only a derived
-- read-model over what SMM-21 already ingests).
--
-- ── WHY A CACHE TABLE, NOT AN ON-DEMAND COMPUTATION ────────────────────────────────────────────
-- The scan (every published variant for an account, joined to its latest metrics snapshot) is cheap
-- today because there is no data, but the shape mirrors `social_metrics_daily`'s own D-4 reasoning
-- in reverse: rather than re-scanning on every Composer/Calendar render, one nightly sweep
-- (`best-time-job.ts`, the SAME env-gated/dark-by-default/per-tenant-isolated idiom as
-- `metrics-job.ts`/`inbox-triage-job.ts`) writes ONE current row per account, and the read endpoint
-- is a single indexed lookup. UPSERTED, not append-only — SMM-21's `social_post_metrics` is the
-- historical record; this table is a CURRENT VERDICT, so a re-run replaces it (same `UNIQUE
-- (account_id)` + `ON CONFLICT` shape `social_metrics_daily` itself uses for its own per-day cache).
--
-- ── THE STATUS COLUMN — THREE DISTINCT FACTS, NEVER ONE BOOLEAN (this ticket's own hardest
--    constraint: every platform credential is empty, D-23, so this table starts, and will stay for a
--    long while, in a state that must never be confused with "we looked and it's a bad time") ─────
--   'insufficient_evidence' — the account's driver DOES report post-level engagement, but fewer
--       measured, published posts exist than `min_measured_posts_threshold` (or the single best hour
--       bucket did not reach `min_bucket_posts_threshold` on its own) — SMM-16's own
--       unclassified/unavailable/classified precedent, applied to a statistic instead of an AI call.
--       This is the state EVERY tenant is in today, because no account is connected (D-23).
--   'unsupported' — the resolved driver for this account's network does not advertise the
--       `post_metrics` capability at all (checked via `driver.capabilities`, the SAME
--       "unsupported vs empty" discipline `inbox-sync-job.ts`/`metrics-job.ts` already apply to
--       `inbox_read`/`post_metrics`) — no amount of waiting will ever produce a suggestion here,
--       which is a DIFFERENT, more permanent fact than "not enough data yet".
--   'suggested' — a real answer: `best_hour_utc` is the winning bucket, backed by
--       `best_hour_sample_size` measured posts in that bucket alone (out of
--       `total_measured_posts` measured posts examined).
-- The shape CHECK below makes exactly one of these hold structurally — a `suggested` row without its
-- three supporting numbers, or a non-`suggested` row that leaked one of them, cannot be written.
--
-- ── WHAT "MEASURED" MEANS, AND WHY A COUNT CAN NEVER BE A FABRICATED ZERO ──────────────────────
-- `best-time.ts` only counts a published variant once its LATEST `social_post_metrics` snapshot has
-- at least one non-null interaction field (likes/comments/shares/saves/clicks) — an entirely-null
-- snapshot means "not yet fetched", never "zero engagement" (`metrics-job.ts`'s own "no invented
-- numbers" header, restated here for the table that consumes its output). `total_measured_posts` and
-- `best_hour_sample_size` are therefore always genuine observation counts, never inflated by
-- not-yet-measured posts.
--
-- ── WHICH RLS WALL ───────────────────────────────────────────────────────────────────────────────
-- THIRD WALL, same as `social_metrics_daily`/`social_post_metrics` and every social_* table except
-- `social_post_client_reviews` (0105's own portal-writer exception, which does not apply here — this
-- table's only writer is `best-time-job.ts`, module code, never a portal controller).
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────────────
-- UTC-timestamp scheme (`date -u +%Y%m%d%H%M` at write time: 202608221603) — the sequential `NNNN_`
-- scheme is closed above 0118 (migrations/README.md, amended 2026-08-19).
--
-- ── NO DML, NO BACKFILL ──────────────────────────────────────────────────────────────────────────
-- Brand-new table, zero rows anywhere (no account is connected today, D-23) — the 0050 NOBYPASSRLS
-- backfill trap does not apply. Self-asserted below anyway, per the 0106/0112/.../0118 discipline.

BEGIN;

CREATE TABLE social_best_time_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  account_id uuid NOT NULL REFERENCES social_accounts(id),
  status text NOT NULL CHECK (status IN ('insufficient_evidence', 'unsupported', 'suggested')),
  -- Wall-clock hour bucket, ALWAYS UTC (0-23) — see best-time.ts's header for why: no per-account
  -- timezone column exists anywhere in this schema, and guessing one would be exactly the kind of
  -- fabricated-precision claim this ticket's own brief refuses to ship. The UI is responsible for
  -- labelling this "UTC" rather than implying a client-local hour that was never computed.
  best_hour_utc smallint CHECK (best_hour_utc IS NULL OR best_hour_utc BETWEEN 0 AND 23),
  best_hour_sample_size integer CHECK (best_hour_sample_size IS NULL OR best_hour_sample_size >= 0),
  total_measured_posts integer NOT NULL DEFAULT 0 CHECK (total_measured_posts >= 0),
  avg_engagement_score numeric CHECK (avg_engagement_score IS NULL OR avg_engagement_score >= 0),
  -- The thresholds ACTUALLY APPLIED at compute time, snapshotted onto the row (not just held in
  -- config) so the read endpoint can show its own rationale ("3 of 5 measured posts needed") even if
  -- the deployment's config value changes later — the ticket's own "state the threshold, not just a
  -- silent constant" instruction, carried through to the API response.
  min_measured_posts_threshold integer NOT NULL CHECK (min_measured_posts_threshold >= 1),
  min_bucket_posts_threshold integer NOT NULL CHECK (min_bucket_posts_threshold >= 1),
  lookback_days integer NOT NULL CHECK (lookback_days >= 1),
  -- Full per-hour breakdown ({"14": {"count": 3, "avgScore": 12.5}, ...}) for transparency/debugging
  -- — our OWN derived aggregate, never engine-reported, so `social_metrics_daily.raw`'s "verbatim
  -- engine payload" meaning does NOT apply here; documented so a future reader does not conflate them.
  raw jsonb NOT NULL DEFAULT '{}',
  computed_at timestamptz NOT NULL DEFAULT now(),
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One current verdict per account — a re-run UPSERTs (see header).
  UNIQUE (account_id),
  CONSTRAINT fk_social_best_time_account_tenant FOREIGN KEY (account_id, tenant_id)
    REFERENCES social_accounts (id, tenant_id),
  CONSTRAINT ux_social_best_time_id_tenant UNIQUE (id, tenant_id),
  -- THE SHAPE CONTRACT: exactly one of the three status branches holds, structurally.
  CONSTRAINT sbt_status_shape CHECK (
    (status = 'suggested'
      AND best_hour_utc IS NOT NULL AND best_hour_sample_size IS NOT NULL
      AND avg_engagement_score IS NOT NULL)
    OR (status IN ('insufficient_evidence', 'unsupported')
      AND best_hour_utc IS NULL AND best_hour_sample_size IS NULL AND avg_engagement_score IS NULL)
  )
);

CREATE INDEX ix_social_best_time_tenant ON social_best_time_suggestions (tenant_id);

COMMENT ON TABLE social_best_time_suggestions IS
  'SMM-27 — cached classical-stats best-hour-to-post verdict per connected account, recomputed '
  'nightly by best-time-job.ts from social_post_variants + social_post_metrics (SMM-21). THIRD RLS '
  'WALL. status is one of three DISTINCT facts (insufficient_evidence / unsupported / suggested) '
  'per sbt_status_shape — never a single boolean or a bare NULL that could be misread as ''no good '
  'time'' instead of ''nobody has looked / not enough data yet''. best_hour_utc is a UTC hour '
  'bucket; no per-account timezone exists in this schema to localize it.';

-- FORCE RLS, THIRD WALL — byte-identical predicate to 0105's DO-loop block / social_oauth_tokens'
-- own explicit statement, applied here the same way (no loop needed for a single table).
ALTER TABLE social_best_time_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_best_time_suggestions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON social_best_time_suggestions FOR ALL
  USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('social'))
  WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('social'));

-- ── SELF-ASSERTION (0106/.../202608201519 idiom) ────────────────────────────────────────────────
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM information_schema.tables WHERE table_name = 'social_best_time_suggestions';
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected social_best_time_suggestions to exist, found %', n;
  END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conname IN ('sbt_status_shape', 'fk_social_best_time_account_tenant',
                      'ux_social_best_time_id_tenant');
  IF n <> 3 THEN
    RAISE EXCEPTION 'expected 3 named constraints on social_best_time_suggestions, found %', n;
  END IF;

  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'sbt_status_shape')
       NOT LIKE '%insufficient_evidence%' THEN
    RAISE EXCEPTION 'sbt_status_shape does not mention the insufficient_evidence branch';
  END IF;

  SELECT count(*) INTO n FROM pg_indexes WHERE indexname = 'ix_social_best_time_tenant';
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected ix_social_best_time_tenant to exist, found %', n;
  END IF;

  -- FORCE RLS actually landed (a typo'd table/policy name would not error the way a SELECT would).
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE c.relname = 'social_best_time_suggestions' AND c.relrowsecurity AND c.relforcerowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected social_best_time_suggestions to have ENABLE+FORCE row level security, found %', n;
  END IF;

  SELECT count(*) INTO n FROM pg_policies
   WHERE tablename = 'social_best_time_suggestions' AND policyname = 'tenant_isolation';
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected a tenant_isolation policy on social_best_time_suggestions, found %', n;
  END IF;

  -- No DML above, so a fresh table must have zero rows — the floor every later assertion assumes.
  SELECT count(*) INTO n FROM social_best_time_suggestions;
  IF n <> 0 THEN
    RAISE EXCEPTION 'expected social_best_time_suggestions to be empty immediately after creation, found % rows', n;
  END IF;
END $$;
-- Behavioural coverage (the module-GUC regression, the three-status shape against real seeded
-- variants/metrics, the UTC hour-bucket arithmetic, and the insufficient-evidence/unsupported
-- thresholds) lives in `src/modules/social/best-time.test.ts` against the repo's own `initTestDb`
-- harness — deliberately not attempted here with synthetic FK values (0113's own reasoning: an FK
-- violation and a CHECK violation would be indistinguishable, turning this assertion into a false
-- pass).

COMMIT;
