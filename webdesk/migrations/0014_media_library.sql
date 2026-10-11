-- webdesk/migrations/0014_media_library.sql
-- WSK-43a (WebDesk M3, the media library, WebDesk half), owner rulings WSK-D53 and WSK-D54.
--
-- 1. media_assets becomes a LIBRARY row. 0002 gave it only what storage needs (bucket_key, mime,
--    size_bytes, scan_status); an editor browsing a library also needs a title, a per-locale alt text
--    (`alt` is a map locale -> text, `{}` = none), tags, the filename the file was uploaded under, the
--    pixel size when it is cheaply known, and a lifecycle:
--
--        live          deleted_at IS NULL
--        soft-deleted  deleted_at set, purge_after = deleted_at + the bucket's GOVERNANCE retention,
--                      purged_at NULL. The asset has left the library and is not served, but its stored
--                      object still exists (object lock keeps every version until retention ends), so its
--                      bytes still count against the tenant's quota.
--        purged        purged_at set: the scheduler's `media-purge` job deleted every stored version of the
--                      object once retention had passed. The row stays as the record; its bytes no longer
--                      count.
--
--    The CHECKs make an impossible lifecycle unrepresentable: purge_after exists exactly when deleted_at
--    does, never before it, and nothing is purged that was not deleted first. The two indexes serve the
--    library's tag filter (GIN) and the purge sweep (a partial index over the few rows awaiting it).
--    created_by is who uploaded it: the editorial principal's sub (opaque, attribution only), copied from the
--    upload token that authorised the upload; NULL for rows that predate this column.
--    updated_at is NOT NULL DEFAULT now(): rows that exist today get the migration's own instant (no DML
--    runs here: a backfill under FORCE RLS would match zero rows, lint-migration-rls.mjs).
--
-- 2. media_upload_tokens: the credential of the public upload route
--    (POST /v1/t/:tenantSlug/media/upload/:token). The ERP never carries file bytes: the control command
--    media.uploadToken mints a short-lived, SINGLE-USE token bound to a tenant, a site, a bucket, a byte
--    cap and an allowed mime set, and the browser uploads straight to WebDesk with it.
--
--    THE TOKEN IS A BEARER CAPABILITY, exactly as a preview token is (0013): 32 random bytes, base64url,
--    shown once; only sha256 (lowercase hex) is stored, the CHECK refuses anything else, and there is no
--    pepper (256 bits of entropy). Single use is enforced HERE: the upload claims the row with an UPDATE
--    ... WHERE used_at IS NULL AND expires_at > now(), in its own short transaction committed BEFORE the
--    body is read (no pooled connection is held while bytes stream), so two concurrent uploads with one token
--    cannot both succeed and a token whose upload fails after that stays spent (fail closed). A row is never deleted (the app role has
--    no DELETE): the table is also the record of who was allowed to upload what, and when.
--
-- RLS and grants follow 0002/0009/0012/0013 exactly: FORCE ROW LEVEL SECURITY with the single-mode
-- tenant_isolation policy, fail-closed on an unset webdesk.tenant_ctx. The public route resolves the
-- tenant from the URL slug first, so a token minted for tenant A is invisible under tenant B's slug.
--
-- Re-runnable: every statement is IF NOT EXISTS / DROP IF EXISTS. Runs as webdesk_migrator (no SET ROLE)
-- in the runner's per-file transaction.

-- ---------------------------------------------------------------------------------------------
-- 1. media_assets
-- ---------------------------------------------------------------------------------------------
ALTER TABLE media_assets
  ADD COLUMN IF NOT EXISTS title             text,
  ADD COLUMN IF NOT EXISTS alt               jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS tags              text[]      NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS original_filename text,
  ADD COLUMN IF NOT EXISTS created_by        text,
  ADD COLUMN IF NOT EXISTS width             integer,
  ADD COLUMN IF NOT EXISTS height            integer,
  ADD COLUMN IF NOT EXISTS updated_at        timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS deleted_at        timestamptz,
  ADD COLUMN IF NOT EXISTS purge_after       timestamptz,
  ADD COLUMN IF NOT EXISTS purged_at         timestamptz;

ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_alt_object_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_alt_object_check CHECK (jsonb_typeof(alt) = 'object');

ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_title_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_title_check CHECK (title IS NULL OR char_length(title) <= 200);

ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_tags_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_tags_check CHECK (cardinality(tags) <= 20);

ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_original_filename_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_original_filename_check CHECK (original_filename IS NULL OR char_length(original_filename) <= 255);

ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_dimensions_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_dimensions_check
  CHECK ((width IS NULL OR width > 0) AND (height IS NULL OR height > 0));

-- The lifecycle (see the header): purge_after iff deleted_at, never before it; purged only after deleted.
ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_purge_after_iff_deleted_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_purge_after_iff_deleted_check
  CHECK ((deleted_at IS NULL) = (purge_after IS NULL));

ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_purge_after_order_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_purge_after_order_check
  CHECK (purge_after IS NULL OR purge_after >= deleted_at);

ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_purged_requires_deleted_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_purged_requires_deleted_check
  CHECK (purged_at IS NULL OR deleted_at IS NOT NULL);

CREATE INDEX IF NOT EXISTS ix_media_assets_tags ON media_assets USING gin (tags);

-- The purge sweep reads only what is waiting: soft-deleted and not yet purged.
CREATE INDEX IF NOT EXISTS ix_media_assets_purge_due ON media_assets (purge_after)
  WHERE deleted_at IS NOT NULL AND purged_at IS NULL;

-- ---------------------------------------------------------------------------------------------
-- 2. media_upload_tokens
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS media_upload_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  site_id       uuid NOT NULL REFERENCES sites(id),
  token_hash    text NOT NULL,          -- sha256(token) as 64 lowercase hex chars; the plaintext is never stored
  bucket        text NOT NULL,          -- the PUBLIC bucket the asset is stored in
  max_bytes     bigint NOT NULL,        -- the cap this token's upload is held to, enforced while streaming
  allowed_mimes text[] NOT NULL,        -- the content types this token may upload
  expires_at    timestamptz NOT NULL,
  created_by    text NOT NULL,          -- opaque principal (EditorialPrincipal.sub); also the asset's attribution
  created_at    timestamptz NOT NULL DEFAULT now(),
  used_at       timestamptz,            -- set once, atomically with the asset row; never cleared
  CONSTRAINT media_upload_tokens_token_hash_check
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT media_upload_tokens_bucket_check
    CHECK (bucket IN ('media', 'video')),
  CONSTRAINT media_upload_tokens_max_bytes_check
    CHECK (max_bytes > 0),
  CONSTRAINT media_upload_tokens_allowed_mimes_check
    CHECK (cardinality(allowed_mimes) >= 1),
  CONSTRAINT media_upload_tokens_expiry_check
    CHECK (expires_at > created_at)
);

-- The lookup the public route does: exactly one row per hash, across the table.
CREATE UNIQUE INDEX IF NOT EXISTS ux_media_upload_tokens_hash ON media_upload_tokens (token_hash);

-- "What is still usable": rows that are neither spent nor (soon) expired.
CREATE INDEX IF NOT EXISTS ix_media_upload_tokens_expires ON media_upload_tokens (expires_at) WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_media_upload_tokens_tenant ON media_upload_tokens (tenant_id);
CREATE INDEX IF NOT EXISTS ix_media_upload_tokens_site ON media_upload_tokens (site_id);

-- Grants. The default-privilege rule in init-roles.sh would hand the app role SELECT/INSERT/UPDATE/
-- DELETE on a new table; say it explicitly and take DELETE back (the table is history). UPDATE is for
-- the single used_at transition.
REVOKE ALL ON media_upload_tokens FROM webdesk_app;
GRANT SELECT, INSERT, UPDATE ON media_upload_tokens TO webdesk_app;

ALTER TABLE media_upload_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_upload_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON media_upload_tokens;
CREATE POLICY tenant_isolation ON media_upload_tokens FOR ALL
  USING      (tenant_id = webdesk_tenant_ctx())
  WITH CHECK (tenant_id = webdesk_tenant_ctx());
