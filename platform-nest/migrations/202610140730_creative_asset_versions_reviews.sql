-- DW-6h (docs/FRONTEND-BFF-CONTRACT.md §35.2 and §35.3; plan docs/plans/2026-10-13-department-workspaces.md §4.2 and
-- §14.3): ASSET VERSIONS AND REVIEW ROUNDS on the Asset Library's `creative_assets` (migration 0031). Not the agency
-- module's campaign-bound `agency_creative_assets`, which keeps its own review.
--
--   1. creative_assets gains a version history: `version_group_id`, `version_no`, `supersedes_id`.
--   2. creative_asset_reviews: explicit review ROUNDS per version group.
--
-- ── THE GROUP KEY IS `COALESCE(version_group_id, id)` ─────────────────────────────────────────────
-- A group's first version carries `version_group_id = NULL`; every later version carries the first version's id. So every
-- row that exists today is already a group of one at version 1 (the column DEFAULT), and NOTHING is backfilled. That is
-- on purpose: an UPDATE backfill in a migration runs with no tenant GUC set, and under FORCE RLS it would match zero rows
-- and report success (the RLS zero-row trap). There is nothing to backfill, so the trap cannot arise.
--
-- ── WHY THE UNIQUE INDEX IS AN EXPRESSION INDEX, PARTIAL ON LIVE ROWS ─────────────────────────────
-- `(tenant_id, COALESCE(version_group_id, id), version_no) WHERE deleted_at IS NULL` is the SECOND wall against two
-- concurrent saves taking the same number. The first wall is the application: it locks the group's first row
-- (`SELECT … FOR UPDATE`) inside the saving transaction before it reads `max(version_no)`. The application numbers a new
-- version after EVERY row of the group, deleted ones included, so a number is never reused; the index only has to hold
-- among live rows.
--
-- ── REVIEW ROUNDS ─────────────────────────────────────────────────────────────────────────────────
-- One row per round. `group_id` is the group key, `asset_id` the exact version under review, and `content_sha256` the
-- SHA-256 of that version's graded bytes when the round opened (a version's file never changes after it is saved, so a
-- decision names exactly what was seen). The CHECKs are integrity guards for the lifecycle (§35.3):
--   * an open round carries no decision; a closed one always carries `decided_at`;
--   * approved, changes_requested and withdrawn always name who closed them (`superseded` is closed by a new version's
--     save, which names nobody);
--   * changes_requested always carries a non-blank comment.
-- `UNIQUE (tenant_id, group_id, round)` numbers rounds per group; the partial unique index on `status = 'open'` is the
-- wall behind "one open round per asset at a time" (the application maps its violation to 409 `review_open`).
--
-- Pure DDL. The Cerbos kind's permission seed is the NEXT migration (202610140740).

-- ── 1 · creative_assets: versions ───────────────────────────────────────────────────────────────
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS version_group_id uuid REFERENCES creative_assets(id);
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS version_no int NOT NULL DEFAULT 1;
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS supersedes_id uuid REFERENCES creative_assets(id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'creative_assets_version_no_ck') THEN
    ALTER TABLE creative_assets ADD CONSTRAINT creative_assets_version_no_ck CHECK (version_no >= 1);
  END IF;
  -- A first version has no group id and supersedes nothing; a later version names both. `IS NOT DISTINCT FROM` is not
  -- needed here: each side is a plain IS NULL test, which a NULL cannot slip past.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'creative_assets_version_shape_ck') THEN
    ALTER TABLE creative_assets ADD CONSTRAINT creative_assets_version_shape_ck CHECK (
      (version_group_id IS NULL AND supersedes_id IS NULL AND version_no = 1)
      OR (version_group_id IS NOT NULL AND supersedes_id IS NOT NULL AND version_no > 1)
    );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_creative_assets_version
  ON creative_assets (tenant_id, (COALESCE(version_group_id, id)), version_no) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_creative_assets_version_group
  ON creative_assets (tenant_id, (COALESCE(version_group_id, id)));

-- ── 2 · creative_asset_reviews: rounds ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS creative_asset_reviews (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  group_id uuid NOT NULL REFERENCES creative_assets(id),
  asset_id uuid NOT NULL REFERENCES creative_assets(id),
  round int NOT NULL CHECK (round >= 1),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'approved', 'changes_requested', 'withdrawn', 'superseded')),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  requested_by uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 2000),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_comment text CHECK (decision_comment IS NULL OR char_length(decision_comment) <= 4000),
  origin_site text NOT NULL,
  CONSTRAINT creative_asset_reviews_round_uq UNIQUE (tenant_id, group_id, round),
  CONSTRAINT creative_asset_reviews_closed_ck CHECK ((status = 'open') = (decided_at IS NULL)),
  CONSTRAINT creative_asset_reviews_open_undecided_ck CHECK (
    status <> 'open' OR (decided_by IS NULL AND decision_comment IS NULL)
  ),
  CONSTRAINT creative_asset_reviews_decider_ck CHECK (
    status NOT IN ('approved', 'changes_requested', 'withdrawn') OR decided_by IS NOT NULL
  ),
  CONSTRAINT creative_asset_reviews_changes_comment_ck CHECK (
    status <> 'changes_requested' OR (decision_comment IS NOT NULL AND btrim(decision_comment) <> '')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_creative_asset_reviews_one_open
  ON creative_asset_reviews (tenant_id, group_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS ix_creative_asset_reviews_asset
  ON creative_asset_reviews (asset_id);

ALTER TABLE creative_asset_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE creative_asset_reviews FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON creative_asset_reviews;
CREATE POLICY tenant_isolation ON creative_asset_reviews FOR ALL
  USING (tenant_id = ANY(app_current_tenants()))
  WITH CHECK (tenant_id = ANY(app_current_tenants()));

-- ── Assert, don't assume ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_name = 'creative_assets' AND column_name IN ('version_group_id', 'version_no', 'supersedes_id');
  IF n <> 3 THEN
    RAISE EXCEPTION '202610140730: creative_assets should carry the 3 version columns, found %', n;
  END IF;

  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_name = 'creative_assets' AND column_name = 'version_no' AND is_nullable = 'NO' AND column_default = '1';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610140730: creative_assets.version_no must be NOT NULL DEFAULT 1 (every existing row is version 1 of its own group)';
  END IF;

  SELECT count(*) INTO n FROM pg_indexes
   WHERE tablename = 'creative_assets' AND indexname = 'ux_creative_assets_version'
     AND indexdef LIKE 'CREATE UNIQUE INDEX%' AND indexdef LIKE '%COALESCE(version_group_id, id)%'
     AND indexdef LIKE '%WHERE (deleted_at IS NULL)%';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610140730: the unique (tenant, group key, version_no) index over live rows is missing or misshapen';
  END IF;

  SELECT count(*) INTO n FROM pg_indexes
   WHERE tablename = 'creative_assets' AND indexname = 'ix_creative_assets_version_group';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610140730: the (tenant, group key) lookup index is missing';
  END IF;

  SELECT count(*) INTO n FROM pg_class WHERE relname = 'creative_asset_reviews' AND relrowsecurity AND relforcerowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610140730: creative_asset_reviews must exist with RLS ENABLED and FORCED';
  END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE tablename = 'creative_asset_reviews' AND policyname = 'tenant_isolation';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610140730: creative_asset_reviews needs exactly one tenant_isolation policy, found %', n;
  END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'creative_asset_reviews'::regclass
     AND conname IN ('creative_asset_reviews_round_uq', 'creative_asset_reviews_closed_ck',
                     'creative_asset_reviews_open_undecided_ck', 'creative_asset_reviews_decider_ck',
                     'creative_asset_reviews_changes_comment_ck');
  IF n <> 5 THEN
    RAISE EXCEPTION '202610140730: creative_asset_reviews should carry its UNIQUE round and 4 lifecycle CHECKs, found % of 5', n;
  END IF;

  SELECT count(*) INTO n FROM pg_indexes
   WHERE tablename = 'creative_asset_reviews' AND indexname = 'ux_creative_asset_reviews_one_open'
     AND indexdef LIKE 'CREATE UNIQUE INDEX%' AND indexdef LIKE '%WHERE (status = ''open''::text)%';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610140730: the one-open-round partial unique index is missing or misshapen';
  END IF;
END $$;
