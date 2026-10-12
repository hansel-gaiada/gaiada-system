-- M5-P5b — the AI-crawler log: daily aggregates of AI-crawler requests seen in a site's web-server access log
-- (parser: modules/search/ai-crawler-log.ts). Two new tables, nothing existing is touched.
--
-- PRIVACY (legal/website-visitor-addendum.md). The raw log line, the visitor/crawler IP and the User-Agent string
-- are NEVER stored. A row is only (property, UTC day, bot id from the allow-list, URL path with no query string,
-- HTTP status, verification flag) plus a count. Requests that are not from a known AI crawler never reach the
-- database at all; the column set below has nowhere to put an IP or a User-Agent.
--
-- IDEMPOTENCY. search_ai_crawler_daily is upserted (hits are ADDED on conflict), so replaying the same chunk would
-- double-count. search_ai_crawler_chunks records the SHA-256 of every ingested chunk per property; the same chunk
-- again is a no-op, in the same transaction as the upsert. (A chunk hash is not reversible to the lines.)
--
-- Scope: like every search_* tenant table, the third wall is `tenant_id = ANY(app_current_tenants()) AND
-- app_module_allowed('search')` with FORCE ROW LEVEL SECURITY (byte-identical to 202610122200). Written through
-- withTenants([t], {modules:['search']}). No backfill, no data DML.
-- To undo: DROP TABLE search_ai_crawler_chunks, search_ai_crawler_daily.

CREATE TABLE search_ai_crawler_daily (
  tenant_id uuid NOT NULL REFERENCES companies(id),
  property_id uuid NOT NULL REFERENCES search_properties(id),
  day date NOT NULL,                              -- UTC
  bot text NOT NULL CHECK (char_length(bot) BETWEEN 1 AND 64),
  path text NOT NULL CHECK (char_length(path) BETWEEN 1 AND 512 AND left(path, 1) = '/' AND position('?' in path) = 0),
  status smallint NOT NULL CHECK (status BETWEEN 100 AND 599),
  verification text NOT NULL CHECK (verification IN ('claimed','verified','unverified')),
  hits integer NOT NULL CHECK (hits > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  origin_site text NOT NULL DEFAULT 'central',
  PRIMARY KEY (tenant_id, property_id, day, bot, path, status, verification)
);
CREATE INDEX ix_search_ai_crawler_daily_day ON search_ai_crawler_daily (tenant_id, property_id, day);

CREATE TABLE search_ai_crawler_chunks (
  tenant_id uuid NOT NULL REFERENCES companies(id),
  property_id uuid NOT NULL REFERENCES search_properties(id),
  chunk_hash text NOT NULL CHECK (chunk_hash ~ '^[0-9a-f]{64}$'),
  rows_kept integer NOT NULL CHECK (rows_kept >= 0),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_by uuid REFERENCES users(id),
  origin_site text NOT NULL DEFAULT 'central',
  PRIMARY KEY (tenant_id, property_id, chunk_hash)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['search_ai_crawler_daily', 'search_ai_crawler_chunks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''search''))
         WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''search''))', t);
  END LOOP;
END $$;
