-- M5-P5a — IndexNow ping on publish + the Bing Webmaster connector, in the `search` module.
--
-- Additive: four new columns on search_properties, two new tables. No existing object is rewritten and there
-- is no DML, so the RLS zero-row trap does not apply. The `integration_connections.provider` CHECK is widened
-- by the NEXT migration (202610130210), kept apart because it rebuilds a shared constraint.
--
-- THE INDEXNOW KEY IS A PLAIN COLUMN, ON PURPOSE. The protocol requires the key to be served in clear at
-- https://<host>/<key>.txt and to travel in every submission; it only proves that the submitter controls the
-- host, and anyone can read it. It is not a secret, so it does not go through the sealed vault (the Bing API
-- key, which IS a credential, does: integration_connections via secret-box). Rotating it replaces the column
-- and clears the verification and the enabled flag in the same statement.
--
-- search_properties.indexnow_enabled can only be true when a key exists AND the key file was fetched back from
-- the site (indexnow_key_verified_at): the CHECK makes "enabled but never verified" unrepresentable. The
-- application proves the key file before it flips the flag; the constraint is the backstop.
--
-- search_indexnow_submissions is both the idempotency ledger and the retry queue. One row per
-- (property, engine, url, version): a redelivered event inserts nothing (ON CONFLICT DO NOTHING) so it sends
-- nothing. `version` is `<transition>:v<N>:<event ref>`, built by the caller. status:
--   pending   inserted, not yet attempted (or deferred by the daily cap: next_attempt_at is in the future)
--   sent      the engine answered 200/202
--   failed    a retryable failure (network, 429, 5xx); next_attempt_at carries the backoff
--   gave_up   retries exhausted
--   rejected  the engine refused for a reason a retry cannot fix (400/403/422)
-- error_code is a typed token ("http_429", "network", ...); never a response body. URLs are page addresses of
-- the client's own site (no personal data).
--
-- search_bing_performance mirrors search_gsc_performance (0061): one row per property x date x kind x key,
-- idempotent on a server-computed row_hash, `simulated` stamped on every row. Bing returns query rows and
-- page rows from separate calls, so `kind` says which one `key` is.
--
-- Both tables carry 0034's composed policy (tenant_id = ANY(app_current_tenants()) AND
-- app_module_allowed('search')) with FORCE ROW LEVEL SECURITY; reach them through
-- withTenants([t], fn, { modules: ['search'] }). To undo: DROP TABLE both; ALTER TABLE search_properties DROP
-- COLUMN the four.

ALTER TABLE search_properties
  ADD COLUMN indexnow_key text,
  ADD COLUMN indexnow_key_verified_at timestamptz,
  ADD COLUMN indexnow_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN bing_connection_id uuid REFERENCES integration_connections(id);

ALTER TABLE search_properties
  ADD CONSTRAINT search_properties_indexnow_key_format
    CHECK (indexnow_key IS NULL OR indexnow_key ~ '^[A-Za-z0-9-]{8,128}$'),
  ADD CONSTRAINT search_properties_indexnow_enabled_needs_proof
    CHECK (NOT indexnow_enabled OR (indexnow_key IS NOT NULL AND indexnow_key_verified_at IS NOT NULL));

CREATE TABLE search_indexnow_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  property_id uuid NOT NULL REFERENCES search_properties(id),
  engine text NOT NULL CHECK (engine IN ('indexnow', 'bing')),
  url text NOT NULL CHECK (char_length(url) BETWEEN 8 AND 2048),
  url_hash text NOT NULL CHECK (url_hash ~ '^[0-9a-f]{64}$'),
  version text NOT NULL CHECK (char_length(version) BETWEEN 1 AND 128),
  transition text NOT NULL CHECK (transition IN ('publish', 'unpublish', 'manual')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'gave_up', 'rejected')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  http_status integer,
  error_code text CHECK (error_code IS NULL OR char_length(error_code) <= 64),
  simulated boolean NOT NULL DEFAULT false,
  requested_by uuid REFERENCES users(id),
  sent_at timestamptz,
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, property_id, engine, url_hash, version)
);
CREATE INDEX ix_search_indexnow_property ON search_indexnow_submissions (tenant_id, property_id, created_at DESC);
CREATE INDEX ix_search_indexnow_due ON search_indexnow_submissions (next_attempt_at) WHERE status IN ('pending', 'failed');

CREATE TABLE search_bing_performance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  property_id uuid NOT NULL REFERENCES search_properties(id),
  connection_id uuid REFERENCES integration_connections(id),
  date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('query', 'page')),
  key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 2048),
  clicks integer NOT NULL DEFAULT 0,
  impressions integer NOT NULL DEFAULT 0,
  avg_click_position numeric(9, 2),
  avg_impression_position numeric(9, 2),
  -- sha256 hex of `property_id|date|kind|key`, computed in bing-service.ts; the idempotency key.
  row_hash text NOT NULL,
  simulated boolean NOT NULL DEFAULT false,
  origin_site text NOT NULL DEFAULT 'central',
  fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, property_id, row_hash)
);
CREATE INDEX ix_search_bing_performance_property_date ON search_bing_performance (tenant_id, property_id, date DESC);
CREATE INDEX ix_search_bing_performance_kind_key ON search_bing_performance (tenant_id, property_id, kind, key);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['search_indexnow_submissions', 'search_bing_performance'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''search''))
         WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''search''))',
      t
    );
  END LOOP;
END $$;

COMMENT ON COLUMN search_properties.indexnow_key IS
  'M5-P5a — the IndexNow key. PUBLIC by protocol design (served at https://<host>/<key>.txt), so a plain column, not the vault.';
COMMENT ON TABLE search_indexnow_submissions IS
  'M5-P5a — idempotency ledger + retry queue for IndexNow and Bing URL submissions. UNIQUE (tenant, property, engine, url_hash, version).';
COMMENT ON TABLE search_bing_performance IS
  'M5-P5a — Bing Webmaster query and page stats. Idempotent on row_hash; simulated stamped on every row. Not search_data_cache (client-private).';
