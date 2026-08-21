-- SMM-38 phase 38e — Gap 3's durability fix for `youtube-quota.ts`'s per-process, in-memory YouTube
-- quota counter (design addendum §PD). 38d shipped the counter as a module-level `Map`, named
-- (not silently accepted) as non-durable and non-cross-instance, but left the fix as a follow-up
-- because nothing on a live path incremented it. 38e's own dispatch wiring
-- (`src/modules/social/publisher/provisioning.ts#resolveDispatchOrgHandle`) makes the `direct` driver
-- reachable from a real dispatch call for the first time — so an under-reporting, restart-resetting
-- counter stops being harmless the moment an operator sets the right capability-driver override.
--
-- ── GLOBAL TABLE, NO TENANT_ID, NO RLS — SAME REASONING AS social_platform_apps (0105, DESIGN D-4) ──
-- The dossier's own finding (`docs/blueprints/smm-app-review-dossier.md` §6.5, quoted verbatim in
-- youtube-quota.ts's own header): "the binding constraint is 100 video uploads/day across the ENTIRE
-- FLEET, not per client." The cap is a per-Google-Cloud-PROJECT fact — i.e. per DEPLOYMENT, identical
-- for every tenant's every YouTube channel this one OAuth app touches — never a per-tenant fact. A
-- tenant-walled table would UNDERSTATE the real, shared exposure (each tenant reading its own empty
-- counter while the shared project sits at its real cap), the same reasoning that already makes
-- `social_platform_apps` the one table in this module with no tenant_id and no RLS. This table holds
-- no client data and no secrets — three integer counters and a date — so it carries none of D-4's
-- containment concerns either.
--
-- ── WHY ONE ROW PER DAY, NOT ONE ROW EVER ─────────────────────────────────────────────────────────
-- `usage_day` is the PRIMARY KEY: `youtube-quota.ts`'s own `utcDayKey` convention (a UTC calendar
-- day) names which row an increment targets, and a fresh day simply has no row yet — read as
-- `{used:0}` for every bucket, the SAME "no calls observed" true fact the in-memory store's own
-- `dayCounters()` already returns for an unseen day, never a fabricated non-zero. Rows are never
-- deleted here: a small, forever-growing three-integer-a-day ledger is a feature for this table (an
-- operator can literally read "how close did we get to the wall, and when" months later), not a
-- retention concern SMM-36's purge machinery needs to know about — this is usage ACCOUNTING, not
-- inbox content with a privacy-driven ceiling.
--
-- ── THE ATOMIC INCREMENT, NOT A READ-THEN-WRITE ───────────────────────────────────────────────────
-- `youtube-quota.ts#createDbYouTubeQuotaStore`'s `record()` is a single
-- `INSERT ... ON CONFLICT (usage_day) DO UPDATE SET col = col + EXCLUDED.col` — the row-level lock
-- Postgres already takes for the UPDATE branch is what makes two Node instances recording
-- concurrently ADD UP correctly rather than each reading a stale count and overwriting the other's
-- increment. No advisory lock, no application-level retry loop needed.
--
-- ── NO DML, NO BACKFILL ────────────────────────────────────────────────────────────────────────────
-- Brand-new table, zero rows anywhere (nothing on a live path has ever called
-- `recordYouTubeQuotaUsage`/`createDbYouTubeQuotaStore` before this migration exists) — the 0050
-- NOBYPASSRLS backfill trap does not apply (this table carries no RLS at all, per D-4's own
-- precedent, so there is no GUC to omit).
--
-- ── NUMBERING ──────────────────────────────────────────────────────────────────────────────────────
-- UTC-timestamp scheme (`date -u +%Y%m%d%H%M`), per the 2026-08-19 protocol change the sequential
-- `NNNN_` scheme's closure above 0118 introduced — same scheme `202608201518_social_oauth_tokens.sql`
-- (38b) already uses.

CREATE TABLE social_youtube_quota_usage (
  usage_day date PRIMARY KEY,
  search_list_calls integer NOT NULL DEFAULT 0 CHECK (search_list_calls >= 0),
  videos_insert_calls integer NOT NULL DEFAULT 0 CHECK (videos_insert_calls >= 0),
  other_units integer NOT NULL DEFAULT 0 CHECK (other_units >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE social_youtube_quota_usage IS
  'SMM-38/38e (D-20, addendum §PD) — durable, cross-instance accounting for the direct driver''s '
  'YouTube quota buckets (search.list / videos.insert / all other Data API calls). GLOBAL: no '
  'tenant_id, no RLS — same reasoning as social_platform_apps (0105, D-4): the 100-upload/day cap is '
  'a per-Google-Cloud-project fact, shared across every tenant''s every YouTube channel, never a '
  'per-tenant one. One row per UTC calendar day; increments are atomic '
  '(INSERT ... ON CONFLICT DO UPDATE SET col = col + EXCLUDED.col), never a read-then-write. See '
  'src/modules/social/publisher/youtube-quota.ts#createDbYouTubeQuotaStore.';

-- ── SELF-ASSERTION (0106/0112/0113/0114/0118/202608201518 idiom) ───────────────────────────────────
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM information_schema.tables WHERE table_name = 'social_youtube_quota_usage';
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected social_youtube_quota_usage to exist, found %', n;
  END IF;

  -- Deliberately NO RLS on this table (D-4's own precedent) — assert that fact holds too, so a
  -- future "harden every table" pass does not silently add a wall that would zero out every tenant's
  -- read of a deployment-wide fact.
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE c.relname = 'social_youtube_quota_usage' AND (c.relrowsecurity OR c.relforcerowsecurity);
  IF n <> 0 THEN
    RAISE EXCEPTION 'expected social_youtube_quota_usage to carry NO row level security, found %', n;
  END IF;

  -- No DML above, so a fresh table must have zero rows — the floor every later assertion assumes.
  SELECT count(*) INTO n FROM social_youtube_quota_usage;
  IF n <> 0 THEN
    RAISE EXCEPTION 'expected social_youtube_quota_usage to be empty immediately after creation, found % rows', n;
  END IF;

  -- Prove the atomic-increment idiom this table exists for actually behaves as an increment, not an
  -- overwrite — two INSERT..ON CONFLICT statements against the SAME day must add up.
  INSERT INTO social_youtube_quota_usage (usage_day, videos_insert_calls) VALUES ('2026-01-01', 3)
    ON CONFLICT (usage_day) DO UPDATE SET videos_insert_calls = social_youtube_quota_usage.videos_insert_calls + EXCLUDED.videos_insert_calls;
  INSERT INTO social_youtube_quota_usage (usage_day, videos_insert_calls) VALUES ('2026-01-01', 4)
    ON CONFLICT (usage_day) DO UPDATE SET videos_insert_calls = social_youtube_quota_usage.videos_insert_calls + EXCLUDED.videos_insert_calls;
  SELECT videos_insert_calls INTO n FROM social_youtube_quota_usage WHERE usage_day = '2026-01-01';
  IF n <> 7 THEN
    RAISE EXCEPTION 'expected the atomic-increment idiom to sum to 7 (3+4), found %', n;
  END IF;
  -- Clean up the self-test row so this migration leaves the table genuinely empty, matching the
  -- "no DML" claim above for every row a real caller would ever see.
  DELETE FROM social_youtube_quota_usage WHERE usage_day = '2026-01-01';
END $$;
-- Behavioural coverage (the atomic-increment property under real concurrency, the three-bucket
-- independence, and the store-seam's own contract) lives in
-- src/modules/social/publisher/youtube-quota.test.ts against the repo's own initTestDb harness.
