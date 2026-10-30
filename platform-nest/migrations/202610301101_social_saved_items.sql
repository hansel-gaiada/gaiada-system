-- 202610301101_social_saved_items.sql — SCP-5e: Saved, each client's content bank (what has no other home).
-- Contract: docs/FRONTEND-BFF-CONTRACT.md §63.26.1 ("<prefix+2>_social_saved_items.sql"); plan
-- docs/plans/2026-10-15-social-content-pipeline.md SCP-Q28 (per client), SCP-Q29 (who curates), SCP-Q30 (videos are Drive
-- links), SCP-Q41 (the categories are the company's, `saved.categories`, §63.30).
--
-- ── WHAT THIS ADDS ──────────────────────────────────────────────────────────────────────────────────────
--   creative_assets      `ux_creative_assets_id_tenant UNIQUE (id, tenant_id)` when missing (the 0075 pattern; it cannot fail,
--                        `id` is the key), so the bank's asset FK carries the tenant. Its plain wall and rows are untouched.
--   social_saved_items   one kept item of one client: an Asset Library group (`asset`), a Drive or web link (`link`) or a text
--                        (`text`: a caption, a template). Design photos, approved posts and hashtag sets are READ from where
--                        they live and never stored here.
--
-- ── ONE SHAPE PER `holds` ───────────────────────────────────────────────────────────────────────────────
-- `holds` is NOT NULL, so `holds <> 'x'` is never NULL and each shape CHECK binds exactly the rows of its kind. Inside a shape
-- every side is an explicit `IS NULL` / `IS NOT NULL` (a CHECK passes on NULL, so a bare `url ~ ...` would admit a NULL url):
--   asset: asset_group_id set; url, body, media, source, ai_note all NULL (an asset carries its own source, §63.6.6);
--   link:  url and source set; asset_group_id and body NULL; media 'photo', 'video' or NULL;
--   text:  body set; url, asset_group_id, media, source, ai_note all NULL.
-- `category` is a key of the company's `saved.categories`: the database checks its shape only, the route checks it against the
-- rules (a category later removed keeps its items, shown under "Other").
--
-- ── WALL: THE THIRD WALL ────────────────────────────────────────────────────────────────────────────────
-- `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('social')` on USING and WITH CHECK, FORCE RLS, in 0105's
-- DO-loop form. The bank is the team's only and never reaches the portal (§63.26).
--
-- ── FOREIGN KEYS ────────────────────────────────────────────────────────────────────────────────────────
-- Composite (id, tenant_id): engagement → social_engagements, asset_group_id → creative_assets (ux_creative_assets_id_tenant,
-- above), last_used_post_id → social_posts. A referential check is not filtered by row security, so the third-walled bank may
-- reference the plain-walled creative_assets. Plain FKs to users for every person.
--
-- ── NO DML ──────────────────────────────────────────────────────────────────────────────────────────────
-- A new empty table and a unique key on creative_assets. No row is read or written, so the RLS zero-row trap cannot bite. The
-- closing DO block asserts the catalogue, never a row count.
--
-- ── RE-RUNNABLE ─────────────────────────────────────────────────────────────────────────────────────────
-- CREATE TABLE/INDEX IF NOT EXISTS, DROP CONSTRAINT IF EXISTS + ADD, DROP POLICY IF EXISTS + CREATE, the key added only when
-- missing. Applies on its own with plain `psql -f` and again without error.
--
-- ── ROLLOUT ─────────────────────────────────────────────────────────────────────────────────────────────
-- Additive. Runs on boot; the unique key on creative_assets builds one btree index under a brief lock. No deploy-order
-- constraint: no existing code reads the new table.

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
-- (0) creative_assets gets the (id, tenant_id) key a composite FK needs (0075's "when missing" pattern).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = to_regclass('creative_assets') AND conname = 'ux_creative_assets_id_tenant'
  ) THEN
    ALTER TABLE creative_assets ADD CONSTRAINT ux_creative_assets_id_tenant UNIQUE (id, tenant_id);
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) social_saved_items — one item of one client's bank.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS social_saved_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  engagement_id uuid NOT NULL,
  -- What the item is (a structural shape): 'asset', 'link' or 'text'.
  holds text NOT NULL,
  -- The company category it sits in: a key of `saved.categories` (§63.30), checked against the rules by the route.
  category text NOT NULL,
  title text NOT NULL,
  -- A caption's or a template's text.
  body text,
  url text,
  -- What a link points at: 'photo' or 'video'.
  media text,
  -- The Asset Library version group, COALESCE(version_group_id, id) of the asset.
  asset_group_id uuid,
  pillar text,
  -- A link's source and AI note; an asset carries its own (§63.6.6).
  source text,
  ai_note text,
  use_count integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  last_used_post_id uuid,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES users(id),
  origin_site text NOT NULL DEFAULT 'central',
  CONSTRAINT ux_social_saved_items_id_tenant UNIQUE (id, tenant_id),
  CONSTRAINT fk_social_saved_items_engagement_tenant FOREIGN KEY (engagement_id, tenant_id)
    REFERENCES social_engagements (id, tenant_id),
  CONSTRAINT fk_social_saved_items_asset_tenant FOREIGN KEY (asset_group_id, tenant_id)
    REFERENCES creative_assets (id, tenant_id),
  CONSTRAINT fk_social_saved_items_last_post_tenant FOREIGN KEY (last_used_post_id, tenant_id)
    REFERENCES social_posts (id, tenant_id)
);

ALTER TABLE social_saved_items
  DROP CONSTRAINT IF EXISTS social_saved_items_holds_ck,
  ADD CONSTRAINT social_saved_items_holds_ck CHECK (holds IN ('asset','link','text')),
  DROP CONSTRAINT IF EXISTS social_saved_items_category_ck,
  ADD CONSTRAINT social_saved_items_category_ck CHECK (category ~ '^[a-z][a-z0-9_]{0,39}$'),
  DROP CONSTRAINT IF EXISTS social_saved_items_values_ck,
  ADD CONSTRAINT social_saved_items_values_ck CHECK (
    char_length(title) BETWEEN 1 AND 120
    AND (body IS NULL OR char_length(body) BETWEEN 1 AND 5000)
    AND (url IS NULL OR (url ~* '^https?://' AND char_length(url) <= 500))
    AND (media IS NULL OR media IN ('photo','video'))
    AND (pillar IS NULL OR char_length(pillar) <= 60)
    AND (source IS NULL OR source IN ('own','client','stock','ai','unknown'))
    AND (ai_note IS NULL OR char_length(ai_note) <= 1000)
  ),
  -- The three shapes, one per kind.
  DROP CONSTRAINT IF EXISTS social_saved_items_asset_shape_ck,
  ADD CONSTRAINT social_saved_items_asset_shape_ck CHECK (
    holds <> 'asset'
    OR (asset_group_id IS NOT NULL AND url IS NULL AND body IS NULL AND media IS NULL AND source IS NULL AND ai_note IS NULL)
  ),
  DROP CONSTRAINT IF EXISTS social_saved_items_link_shape_ck,
  ADD CONSTRAINT social_saved_items_link_shape_ck CHECK (
    holds <> 'link'
    OR (url IS NOT NULL AND source IS NOT NULL AND asset_group_id IS NULL AND body IS NULL)
  ),
  DROP CONSTRAINT IF EXISTS social_saved_items_text_shape_ck,
  ADD CONSTRAINT social_saved_items_text_shape_ck CHECK (
    holds <> 'text'
    OR (body IS NOT NULL AND url IS NULL AND asset_group_id IS NULL AND media IS NULL AND source IS NULL AND ai_note IS NULL)
  ),
  -- An AI-made link says so.
  DROP CONSTRAINT IF EXISTS social_saved_items_ai_note_ck,
  ADD CONSTRAINT social_saved_items_ai_note_ck CHECK (source IS DISTINCT FROM 'ai' OR ai_note IS NOT NULL),
  DROP CONSTRAINT IF EXISTS social_saved_items_use_count_ck,
  ADD CONSTRAINT social_saved_items_use_count_ck CHECK (use_count >= 0),
  DROP CONSTRAINT IF EXISTS social_saved_items_last_used_ck,
  ADD CONSTRAINT social_saved_items_last_used_ck CHECK ((last_used_at IS NULL) = (last_used_post_id IS NULL)),
  DROP CONSTRAINT IF EXISTS social_saved_items_deleted_ck,
  ADD CONSTRAINT social_saved_items_deleted_ck CHECK ((deleted_at IS NULL) = (deleted_by IS NULL));

-- One live `asset` item per client and group (the asset shape CHECK makes the group NOT NULL there). A concurrent second save
-- meets this index (23505, answered 200 `created: false` by the route).
CREATE UNIQUE INDEX IF NOT EXISTS ux_social_saved_items_asset
  ON social_saved_items (engagement_id, asset_group_id) WHERE holds = 'asset' AND deleted_at IS NULL;
-- A collection: a client's live items of one category, newest first.
CREATE INDEX IF NOT EXISTS ix_social_saved_items_category
  ON social_saved_items (tenant_id, engagement_id, category, created_at DESC) WHERE deleted_at IS NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
-- FORCE RLS + the third wall, in 0105's DO-loop form (byte-identical predicate).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['social_saved_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''social''))
         WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''social''))',
      t
    );
  END LOOP;
END $$;

COMMENT ON TABLE social_saved_items IS
  'SCP-5e (BFF 63.26): a client''s content bank, the items with no other home (an asset kept for later, a link, a caption or '
  'template). Design photos, approved posts and hashtag sets are read from where they live. Team only, never the portal. '
  'Third wall. category is a key of the company''s saved.categories (63.30), checked by the route.';

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
-- Assert, don't assume: columns, CHECK expressions, keys, indexes and the walls. Catalogue reads only.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  n integer;
  missing text;
BEGIN
  SELECT string_agg(want.c, ', ') INTO missing
    FROM (VALUES
      ('id','uuid','NO'), ('tenant_id','uuid','NO'), ('engagement_id','uuid','NO'), ('holds','text','NO'),
      ('category','text','NO'), ('title','text','NO'), ('body','text','YES'), ('url','text','YES'), ('media','text','YES'),
      ('asset_group_id','uuid','YES'), ('pillar','text','YES'), ('source','text','YES'), ('ai_note','text','YES'),
      ('use_count','integer','NO'), ('last_used_at','timestamp with time zone','YES'), ('last_used_post_id','uuid','YES'),
      ('created_by','uuid','NO'), ('created_at','timestamp with time zone','NO'), ('updated_by','uuid','YES'),
      ('updated_at','timestamp with time zone','NO'), ('deleted_at','timestamp with time zone','YES'),
      ('deleted_by','uuid','YES'), ('origin_site','text','NO')
    ) AS want(c, ty, nul)
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns ic
                      WHERE ic.table_schema = current_schema() AND ic.table_name = 'social_saved_items'
                        AND ic.column_name = want.c AND ic.data_type = want.ty AND ic.is_nullable = want.nul);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '202610301101: social_saved_items columns missing or misshapen: %', missing;
  END IF;
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'social_saved_items' AND column_name = 'use_count'
     AND column_default = '0';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610301101: social_saved_items.use_count must default to 0';
  END IF;

  SELECT string_agg(want.c, ', ') INTO missing
    FROM (VALUES
      ('social_saved_items_holds_ck', 'CHECK ((holds = ANY (ARRAY[''asset''::text, ''link''::text, ''text''::text])))'),
      ('social_saved_items_category_ck', 'CHECK ((category ~ ''^[a-z][a-z0-9_]{0,39}$''::text))'),
      ('social_saved_items_values_ck', 'CHECK ((((char_length(title) >= 1) AND (char_length(title) <= 120)) AND ((body IS NULL) OR ((char_length(body) >= 1) AND (char_length(body) <= 5000))) AND ((url IS NULL) OR ((url ~* ''^https?://''::text) AND (char_length(url) <= 500))) AND ((media IS NULL) OR (media = ANY (ARRAY[''photo''::text, ''video''::text]))) AND ((pillar IS NULL) OR (char_length(pillar) <= 60)) AND ((source IS NULL) OR (source = ANY (ARRAY[''own''::text, ''client''::text, ''stock''::text, ''ai''::text, ''unknown''::text]))) AND ((ai_note IS NULL) OR (char_length(ai_note) <= 1000))))'),
      ('social_saved_items_asset_shape_ck', 'CHECK (((holds <> ''asset''::text) OR ((asset_group_id IS NOT NULL) AND (url IS NULL) AND (body IS NULL) AND (media IS NULL) AND (source IS NULL) AND (ai_note IS NULL))))'),
      ('social_saved_items_link_shape_ck', 'CHECK (((holds <> ''link''::text) OR ((url IS NOT NULL) AND (source IS NOT NULL) AND (asset_group_id IS NULL) AND (body IS NULL))))'),
      ('social_saved_items_text_shape_ck', 'CHECK (((holds <> ''text''::text) OR ((body IS NOT NULL) AND (url IS NULL) AND (asset_group_id IS NULL) AND (media IS NULL) AND (source IS NULL) AND (ai_note IS NULL))))'),
      ('social_saved_items_ai_note_ck', 'CHECK (((source IS DISTINCT FROM ''ai''::text) OR (ai_note IS NOT NULL)))'),
      ('social_saved_items_use_count_ck', 'CHECK ((use_count >= 0))'),
      ('social_saved_items_last_used_ck', 'CHECK (((last_used_at IS NULL) = (last_used_post_id IS NULL)))'),
      ('social_saved_items_deleted_ck', 'CHECK (((deleted_at IS NULL) = (deleted_by IS NULL)))')
    ) AS want(c, def)
   WHERE NOT EXISTS (SELECT 1 FROM pg_constraint pc
                      WHERE pc.conrelid = to_regclass('social_saved_items') AND pc.conname = want.c AND pc.contype = 'c'
                        AND pg_get_constraintdef(pc.oid) = want.def);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '202610301101: social_saved_items CHECKs missing or with another expression: %', missing;
  END IF;

  SELECT string_agg(want.t || '.' || want.c, ', ') INTO missing
    FROM (VALUES
      ('creative_assets','ux_creative_assets_id_tenant','UNIQUE (id, tenant_id)'),
      ('social_saved_items','ux_social_saved_items_id_tenant','UNIQUE (id, tenant_id)'),
      ('social_saved_items','fk_social_saved_items_engagement_tenant','FOREIGN KEY (engagement_id, tenant_id) REFERENCES %social_engagements(id, tenant_id)'),
      ('social_saved_items','fk_social_saved_items_asset_tenant','FOREIGN KEY (asset_group_id, tenant_id) REFERENCES %creative_assets(id, tenant_id)'),
      ('social_saved_items','fk_social_saved_items_last_post_tenant','FOREIGN KEY (last_used_post_id, tenant_id) REFERENCES %social_posts(id, tenant_id)')
    ) AS want(t, c, def)
   WHERE NOT EXISTS (SELECT 1 FROM pg_constraint pc
                      WHERE pc.conrelid = to_regclass(want.t) AND pc.conname = want.c AND pg_get_constraintdef(pc.oid) LIKE want.def);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '202610301101: keys or FKs missing or misshapen: %', missing;
  END IF;

  SELECT string_agg(want.i, ', ') INTO missing
    FROM (VALUES
      ('ux_social_saved_items_asset','CREATE UNIQUE INDEX ux_social_saved_items_asset ON %social_saved_items USING btree (engagement_id, asset_group_id) WHERE ((holds = ''asset''::text) AND (deleted_at IS NULL))'),
      ('ix_social_saved_items_category','CREATE INDEX ix_social_saved_items_category ON %social_saved_items USING btree (tenant_id, engagement_id, category, created_at DESC) WHERE (deleted_at IS NULL)')
    ) AS want(i, def)
   WHERE NOT EXISTS (SELECT 1 FROM pg_indexes pi
                      WHERE pi.schemaname = current_schema() AND pi.tablename = 'social_saved_items' AND pi.indexname = want.i
                        AND pi.indexdef LIKE want.def);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '202610301101: indexes missing or misshapen: %', missing;
  END IF;

  -- The third wall on the bank; creative_assets keeps its own (plain) wall, forced.
  SELECT count(*) INTO n FROM pg_class
   WHERE oid IN (to_regclass('social_saved_items'), to_regclass('creative_assets')) AND relrowsecurity AND relforcerowsecurity;
  IF n <> 2 THEN
    RAISE EXCEPTION '202610301101: social_saved_items and creative_assets must have RLS ENABLED and FORCED, found % of 2', n;
  END IF;
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = current_schema() AND tablename = 'social_saved_items' AND policyname = 'tenant_isolation' AND cmd = 'ALL'
     AND qual LIKE '%app_current_tenants()%' AND qual LIKE '%app_module_allowed(''social''::text)%'
     AND with_check LIKE '%app_current_tenants()%' AND with_check LIKE '%app_module_allowed(''social''::text)%';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610301101: social_saved_items needs the third-wall tenant_isolation policy on USING and WITH CHECK';
  END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'social_saved_items';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610301101: social_saved_items must carry exactly one policy, found %', n;
  END IF;
END $$;
