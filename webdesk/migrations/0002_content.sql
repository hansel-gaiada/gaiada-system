-- webdesk/migrations/0002_content.sql
-- WSK-03 — content layer: collections · content_items · content_versions · media_assets.
-- Carries the v1.1 locale axis (webdesk-design.md §05, WSK-D18): content is locale-scoped, with
-- sibling localization links (never inlined content), publish_at/unpublish_at for scheduled
-- publishing, and a tsvector search column per locale.
--
-- Requires 0001_platform_core.sql (webdesk_tenant_ctx()/webdesk_platform_ctx()). Runs as
-- webdesk_migrator (this ledger's connecting role, per postgres/init-roles.sh — WSK-01) with no
-- SET ROLE: see 0001's header note on why every table here is owned by webdesk_migrator
-- directly, with webdesk_app's DML rights arriving via init-roles.sh's default-privilege rule.
-- Redirects/sitemap/robots are deliberately NOT new tables here: §05's amendment models them as
-- data inside the generic collections/content_items mechanism ("a fixed redirect collection"),
-- which is WSK-06 (vocabulary/engine) work, not new DDL — this file adds no bespoke table for
-- them, on purpose.

-- ---------------------------------------------------------------------------
-- Locale -> text-search-config mapping (used by the search_vector trigger below)
-- ---------------------------------------------------------------------------
-- FLAGGED GAP (not in the §05 sketch, resolved pragmatically here): stock PostgreSQL ships no
-- Bahasa Indonesia text-search configuration, and id-ID is the tenant DEFAULT locale per §05.
-- 'simple' (no stemming, no stopword removal) is the honest fallback for it and for any other
-- unmapped locale — a real Indonesian analyzer would need a third-party dictionary/config
-- installed on the box, or an app-layer search strategy that does not lean on Postgres tsvector
-- for id-ID content. This function is IMMUTABLE (pure string matching, no catalog lookups), and
-- deliberately does its own prefix matching rather than depending on pg_ts_config contents, so
-- it stays IMMUTABLE-safe.
CREATE OR REPLACE FUNCTION webdesk_locale_ts_config(p_locale text) RETURNS regconfig
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_locale ILIKE 'en%' THEN 'english'::regconfig
    WHEN p_locale ILIKE 'fr%' THEN 'french'::regconfig
    WHEN p_locale ILIKE 'de%' THEN 'german'::regconfig
    WHEN p_locale ILIKE 'es%' THEN 'spanish'::regconfig
    WHEN p_locale ILIKE 'pt%' THEN 'portuguese'::regconfig
    ELSE 'simple'::regconfig  -- id-ID and every other unmapped locale
  END
$$;
COMMENT ON FUNCTION webdesk_locale_ts_config(text) IS
  'Maps a content_items.locale to the closest built-in Postgres text-search config. ''simple''
   (no stemming) for id-ID and anything else unmapped — a known, flagged gap, not a real
   Indonesian analyzer.';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE collections (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  site_id    uuid NOT NULL REFERENCES sites(id),
  key        text NOT NULL,               -- e.g. 'case-study' — the vocabulary's collection name
  schema     jsonb NOT NULL DEFAULT '{}', -- Layer-2 composition-as-data (§05)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, key)
);
CREATE INDEX ix_collections_tenant ON collections (tenant_id);

CREATE TABLE content_items (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id),
  site_id                uuid NOT NULL REFERENCES sites(id),
  collection_id          uuid NOT NULL REFERENCES collections(id),
  locale                 text NOT NULL,             -- e.g. 'id-ID'; tenant declares its set (§05)
  slug                   text NOT NULL,
  -- Siblings across locales of the SAME logical item share this id; the envelope's
  -- `localizations` array is `SELECT locale, slug FROM content_items WHERE
  -- localization_group_id = ... AND locale <> :current` — sibling LINKS, never inlined content,
  -- per §05's explicit rule.
  localization_group_id  uuid NOT NULL DEFAULT gen_random_uuid(),
  blocks                 jsonb NOT NULL DEFAULT '[]',  -- Layer-1 block array
  seo                    jsonb NOT NULL DEFAULT '{}',
  publish_state          text NOT NULL DEFAULT 'draft'
                           CHECK (publish_state IN ('draft', 'scheduled', 'published', 'unpublished')),
  publish_at             timestamptz,   -- scheduled publishing (§05 amendment)
  unpublish_at           timestamptz,
  preview_token          text,          -- headless preview/draft, §05's resolved open item
  -- App-maintained plain-text extraction of `blocks` for search only (rich block jsonb is not
  -- parsed in SQL); search_vector below is derived FROM this plus slug/seo, not from blocks
  -- directly.
  search_text            text,
  search_vector          tsvector,      -- maintained by the trigger below, per-locale config
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (collection_id, locale, slug),
  CHECK (unpublish_at IS NULL OR publish_at IS NULL OR unpublish_at > publish_at)
);
CREATE INDEX ix_content_items_tenant ON content_items (tenant_id);
CREATE INDEX ix_content_items_collection ON content_items (collection_id);
CREATE INDEX ix_content_items_localization_group ON content_items (localization_group_id);
-- Scheduled-publish worker sweep (WSK-D18): only rows that still have work pending.
CREATE INDEX ix_content_items_publish_at ON content_items (publish_at) WHERE publish_at IS NOT NULL;
CREATE INDEX ix_content_items_unpublish_at ON content_items (unpublish_at) WHERE unpublish_at IS NOT NULL;
CREATE INDEX ix_content_items_search ON content_items USING gin (search_vector);

CREATE OR REPLACE FUNCTION webdesk_content_items_search_vector() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_vector := to_tsvector(
    webdesk_locale_ts_config(NEW.locale),
    coalesce(NEW.slug, '') || ' ' ||
    coalesce(NEW.seo ->> 'title', '') || ' ' ||
    coalesce(NEW.seo ->> 'description', '') || ' ' ||
    coalesce(NEW.search_text, '')
  );
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION webdesk_content_items_search_vector() IS
  'Keeps content_items.search_vector in the text-search config matching the row''s OWN locale
   (§05: "a tsvector search column per locale"). A trigger rather than a GENERATED column so it
   can call a STABLE-or-better mapping freely without the stricter IMMUTABLE-only rule that
   GENERATED ALWAYS AS (...) STORED would impose.';

CREATE TRIGGER trg_content_items_search_vector
  BEFORE INSERT OR UPDATE OF locale, slug, seo, search_text ON content_items
  FOR EACH ROW EXECUTE FUNCTION webdesk_content_items_search_vector();

CREATE TABLE content_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  content_item_id uuid NOT NULL REFERENCES content_items(id),
  version         integer NOT NULL,
  blocks          jsonb NOT NULL,
  seo             jsonb NOT NULL DEFAULT '{}',
  publish_state   text NOT NULL,
  created_by      text NOT NULL,        -- Zone A principal id, opaque — attribution only
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (content_item_id, version)
);
CREATE INDEX ix_content_versions_tenant ON content_versions (tenant_id);
CREATE INDEX ix_content_versions_item ON content_versions (content_item_id);
-- Version history is append-only, same reasoning as audit_entries.
REVOKE UPDATE, DELETE ON content_versions FROM webdesk_app;

CREATE TABLE media_assets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  site_id     uuid NOT NULL REFERENCES sites(id),
  bucket_key  text NOT NULL,   -- MinIO object key; per-tenant prefix is enforced app-side (WSK-07)
  mime        text NOT NULL,
  size_bytes  bigint NOT NULL CHECK (size_bytes >= 0),
  scan_status text NOT NULL DEFAULT 'pending'
                CHECK (scan_status IN ('pending', 'clean', 'infected', 'error')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, bucket_key)
);
CREATE INDEX ix_media_assets_tenant ON media_assets (tenant_id);

-- ---------------------------------------------------------------------------
-- FORCE RLS, fail-closed, same shape on every table (all single-tenant here — no dual-mode
-- platform_ctx escape needed, because every row's parent site already belongs to exactly one
-- tenant by the time content exists; unlike `tenants`/`audit_entries` there is no
-- platform-level/no-tenant-yet case for content).
-- ---------------------------------------------------------------------------

ALTER TABLE collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE collections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON collections;
CREATE POLICY tenant_isolation ON collections FOR ALL
  USING      (tenant_id = webdesk_tenant_ctx())
  WITH CHECK (tenant_id = webdesk_tenant_ctx());

ALTER TABLE content_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON content_items;
CREATE POLICY tenant_isolation ON content_items FOR ALL
  USING      (tenant_id = webdesk_tenant_ctx())
  WITH CHECK (tenant_id = webdesk_tenant_ctx());

ALTER TABLE content_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON content_versions;
CREATE POLICY tenant_isolation ON content_versions FOR ALL
  USING      (tenant_id = webdesk_tenant_ctx())
  WITH CHECK (tenant_id = webdesk_tenant_ctx());

ALTER TABLE media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_assets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON media_assets;
CREATE POLICY tenant_isolation ON media_assets FOR ALL
  USING      (tenant_id = webdesk_tenant_ctx())
  WITH CHECK (tenant_id = webdesk_tenant_ctx());

