-- webdesk/migrations/0016_editorial_review.sql
-- WebDesk M5 (M5-W2a, the writers' room): the REVIEW STATE of content. Design:
-- docs/plans/2026-10-11-m5-writers-room-design.md, section 4 (the flow) and section 4.2 (this schema).
-- Four new tenant tables. Nothing existing changes: no ALTER of any earlier table, no DML.
--
--   editorial_policies  per (site, collection): is review required, is an SEO/AEO sign-off required.
--                       REVIEW IS OFF BY DEFAULT: both flags default false, and a collection with NO row
--                       is exactly "off" (the importer, deck sections and client sites keep working as
--                       before). The publish gate (W2c) reads this table; this file only stores it.
--   editorial_items     one row per content item that has been touched by the review flow: its review
--                       state and the exact VERSIONS that were submitted, SEO-signed and approved. A
--                       legacy item has NO row and reads as 'draft' with no author until first touch
--                       (fail closed: a writer cannot edit what has no author). No backfill DML here.
--   editorial_events    append-only history of review transitions (who, what, which version, note).
--   editorial_comments  review comments, anchored to a JSON pointer into a version; only the resolve
--                       fields can change afterwards.
--
-- REVIEW STATE IS PER IMMUTABLE VERSION. content_versions is append-only for the app role (0002), so
-- submitted_version, seo_signed_version and approved_version each name ONE version by a composite
-- foreign key (content_item_id, version) -> content_versions, the 0013 shape: "approved" can never
-- drift from the bytes that were approved, and a version that does not exist is unrepresentable.
-- The foreign keys are MATCH SIMPLE, so a NULL version (never submitted, never approved) is not
-- checked; content_item_id is always non-null.
--
-- WHAT THE DATABASE ENFORCES vs WHAT THE APP DOES. The state machine (which transition is legal from
-- which state, maker != checker, version = head) is W2b's code and Cerbos; it is not duplicated in
-- triggers here. The database enforces only the invariants that are true in EVERY state:
--   in_review     => a submitted version exists
--   approved      => an approved version exists
--   approved_version / approved_by / approved_at are all set or all NULL
--   seo_signed_version / seo_signed_by are both set or both NULL; a snapshot needs a signed version
--   seo_signoff_required => review_required (a sign-off with no review can never be asked for)
-- approved_version legitimately survives while state is back at 'draft' (design 4.1: "edit after
-- approval: back to draft; approved_version stays publishable"), so it is NOT tied to state = approved.
-- Event kinds are a FORMAT check, not a closed list: W2b owns the vocabulary, and widening a shared
-- CHECK in a later migration is the DROP+ADD hazard that has deleted values on live before.
--
-- /v1 NEVER SEES THESE TABLES (design 4.6, D11). The frozen delivery read SQL never joins editorial_*;
-- webdesk/migrations/tests/0016_editorial_review.test.mjs scans webdesk/api/src/delivery/** to prove it.
--
-- RLS and grants follow 0012/0013 exactly: FORCE ROW LEVEL SECURITY with the single-mode
-- tenant_isolation policy (every row belongs to exactly one tenant, no platform_ctx escape),
-- fail-closed on an unset webdesk.tenant_ctx. Grants are written out explicitly (REVOKE ALL, then GRANT)
-- so a database whose default privileges were never set up still ends in the intended state:
--   editorial_policies  SELECT, INSERT, UPDATE   (a policy is edited in place; no DELETE: turn it off)
--   editorial_items     SELECT, INSERT, UPDATE   (state moves; the row is never deleted)
--   editorial_events    SELECT, INSERT           (append-only: no UPDATE, no DELETE)
--   editorial_comments  SELECT, INSERT, and UPDATE on (resolved_at, resolved_by) ONLY
-- The read-only webdesk_backup role (WSK-68) needs nothing here: this file runs as webdesk_migrator
-- through migrate.mjs, so the default privileges it inherits (SELECT on new tables, BYPASSRLS role)
-- cover the new tables; check-rls-integrity.mjs asserts that role model.
--
-- Every *_sub / *_by is an opaque ERP principal id (D39), attribution only: never an email or a name.
-- Re-runnable: every statement is IF NOT EXISTS / DROP IF EXISTS / idempotent. Runs as webdesk_migrator
-- (no SET ROLE) in the runner's per-file transaction, like every earlier file.

-- ---------------------------------------------------------------------------
-- editorial_policies
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS editorial_policies (
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  site_id              uuid NOT NULL REFERENCES sites(id),
  collection_key       text NOT NULL,
  review_required      boolean NOT NULL DEFAULT false,
  seo_signoff_required boolean NOT NULL DEFAULT false,
  updated_by           text,                  -- opaque principal (EditorialPrincipal.sub), attribution only
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, collection_key),
  -- The collection must exist on that site (collections is UNIQUE (site_id, key), 0002).
  CONSTRAINT editorial_policies_collection_fk
    FOREIGN KEY (site_id, collection_key) REFERENCES collections (site_id, key),
  CONSTRAINT editorial_policies_signoff_needs_review_check
    CHECK (NOT seo_signoff_required OR review_required),
  CONSTRAINT editorial_policies_updated_by_check
    CHECK (updated_by IS NULL OR char_length(updated_by) BETWEEN 1 AND 200)
);
CREATE INDEX IF NOT EXISTS ix_editorial_policies_tenant ON editorial_policies (tenant_id);

-- ---------------------------------------------------------------------------
-- editorial_items
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS editorial_items (
  content_item_id    uuid PRIMARY KEY REFERENCES content_items(id),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  site_id            uuid NOT NULL REFERENCES sites(id),
  state              text NOT NULL DEFAULT 'draft',
  author_sub         text,                    -- the maker; NULL until first touch / assign (fail closed)
  submitted_version  integer,
  seo_signed_version integer,
  seo_signed_by      text,
  seo_snapshot       jsonb,                   -- W3's lint + AEO report for the signed version, server-computed
  approved_version   integer,
  approved_by        text,
  approved_at        timestamptz,
  due_at             timestamptz,
  planned_publish_at timestamptz,
  brief_ref          text,                    -- opaque reference to an ERP brief (W4); never content
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT editorial_items_state_check
    CHECK (state IN ('draft', 'in_review', 'changes_requested', 'approved')),
  CONSTRAINT editorial_items_in_review_needs_version_check
    CHECK (state <> 'in_review' OR submitted_version IS NOT NULL),
  CONSTRAINT editorial_items_approved_needs_version_check
    CHECK (state <> 'approved' OR approved_version IS NOT NULL),
  CONSTRAINT editorial_items_versions_check
    CHECK ((submitted_version IS NULL OR submitted_version >= 1)
       AND (seo_signed_version IS NULL OR seo_signed_version >= 1)
       AND (approved_version IS NULL OR approved_version >= 1)),
  CONSTRAINT editorial_items_approval_triple_check
    CHECK ((approved_version IS NULL) = (approved_by IS NULL)
       AND (approved_version IS NULL) = (approved_at IS NULL)),
  CONSTRAINT editorial_items_seo_pair_check
    CHECK ((seo_signed_version IS NULL) = (seo_signed_by IS NULL)),
  CONSTRAINT editorial_items_seo_snapshot_check
    CHECK (seo_snapshot IS NULL
       OR (seo_signed_version IS NOT NULL
           AND jsonb_typeof(seo_snapshot) = 'object'
           AND octet_length(seo_snapshot::text) <= 65536)),
  CONSTRAINT editorial_items_subs_check
    CHECK ((author_sub IS NULL     OR char_length(author_sub)     BETWEEN 1 AND 200)
       AND (seo_signed_by IS NULL  OR char_length(seo_signed_by)  BETWEEN 1 AND 200)
       AND (approved_by IS NULL    OR char_length(approved_by)    BETWEEN 1 AND 200)),
  CONSTRAINT editorial_items_brief_ref_check
    CHECK (brief_ref IS NULL OR char_length(brief_ref) BETWEEN 1 AND 200),
  -- Each *_version names ONE immutable version of THIS item (the 0013 shape).
  CONSTRAINT editorial_items_submitted_version_fk
    FOREIGN KEY (content_item_id, submitted_version)  REFERENCES content_versions (content_item_id, version),
  CONSTRAINT editorial_items_seo_signed_version_fk
    FOREIGN KEY (content_item_id, seo_signed_version) REFERENCES content_versions (content_item_id, version),
  CONSTRAINT editorial_items_approved_version_fk
    FOREIGN KEY (content_item_id, approved_version)   REFERENCES content_versions (content_item_id, version)
);
CREATE INDEX IF NOT EXISTS ix_editorial_items_tenant ON editorial_items (tenant_id);
-- The board: items of a site by state, and by due date (only those that have one).
CREATE INDEX IF NOT EXISTS ix_editorial_items_site_state ON editorial_items (site_id, state);
CREATE INDEX IF NOT EXISTS ix_editorial_items_site_due ON editorial_items (site_id, due_at) WHERE due_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- editorial_events (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS editorial_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  content_item_id uuid NOT NULL REFERENCES content_items(id),
  version         integer,                    -- the version the event concerns; NULL for e.g. an assignment
  kind            text NOT NULL,
  actor_sub       text NOT NULL,
  note            text,
  -- clock_timestamp(), not now(): several events can be written in one transaction and must still order.
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT editorial_events_kind_check
    CHECK (kind ~ '^[a-z][a-z0-9_.]{0,47}$'),
  CONSTRAINT editorial_events_actor_check
    CHECK (char_length(actor_sub) BETWEEN 1 AND 200),
  CONSTRAINT editorial_events_version_check
    CHECK (version IS NULL OR version >= 1),
  CONSTRAINT editorial_events_note_check
    CHECK (note IS NULL OR char_length(note) <= 2000),
  CONSTRAINT editorial_events_version_fk
    FOREIGN KEY (content_item_id, version) REFERENCES content_versions (content_item_id, version)
);
CREATE INDEX IF NOT EXISTS ix_editorial_events_tenant ON editorial_events (tenant_id);
-- An item's history, oldest first.
CREATE INDEX IF NOT EXISTS ix_editorial_events_item ON editorial_events (content_item_id, created_at);

-- ---------------------------------------------------------------------------
-- editorial_comments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS editorial_comments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  content_item_id uuid NOT NULL REFERENCES content_items(id),
  version         integer NOT NULL,           -- the version the comment was made on
  anchor          text,                       -- RFC 6901 JSON pointer into the version's fields; NULL = the whole item
  body            text NOT NULL,
  author_sub      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  resolved_by     text,
  CONSTRAINT editorial_comments_version_check
    CHECK (version >= 1),
  CONSTRAINT editorial_comments_anchor_check
    CHECK (anchor IS NULL OR (char_length(anchor) <= 512 AND (anchor = '' OR anchor LIKE '/%'))),
  CONSTRAINT editorial_comments_body_check
    CHECK (char_length(body) BETWEEN 1 AND 4000),
  CONSTRAINT editorial_comments_author_check
    CHECK (char_length(author_sub) BETWEEN 1 AND 200),
  CONSTRAINT editorial_comments_resolved_pair_check
    CHECK ((resolved_at IS NULL) = (resolved_by IS NULL)),
  CONSTRAINT editorial_comments_resolved_by_check
    CHECK (resolved_by IS NULL OR char_length(resolved_by) BETWEEN 1 AND 200),
  CONSTRAINT editorial_comments_version_fk
    FOREIGN KEY (content_item_id, version) REFERENCES content_versions (content_item_id, version)
);
CREATE INDEX IF NOT EXISTS ix_editorial_comments_tenant ON editorial_comments (tenant_id);
CREATE INDEX IF NOT EXISTS ix_editorial_comments_item ON editorial_comments (content_item_id, created_at);
-- "What is still open on this item": the reviewer's and the board's count.
CREATE INDEX IF NOT EXISTS ix_editorial_comments_open ON editorial_comments (content_item_id) WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- Grants (see the header) and FORCE RLS, tenant_isolation, fail-closed (see 0012/0013)
-- ---------------------------------------------------------------------------
REVOKE ALL ON editorial_policies FROM webdesk_app;
GRANT SELECT, INSERT, UPDATE ON editorial_policies TO webdesk_app;

REVOKE ALL ON editorial_items FROM webdesk_app;
GRANT SELECT, INSERT, UPDATE ON editorial_items TO webdesk_app;

REVOKE ALL ON editorial_events FROM webdesk_app;
GRANT SELECT, INSERT ON editorial_events TO webdesk_app;

REVOKE ALL ON editorial_comments FROM webdesk_app;
GRANT SELECT, INSERT ON editorial_comments TO webdesk_app;
GRANT UPDATE (resolved_at, resolved_by) ON editorial_comments TO webdesk_app;

ALTER TABLE editorial_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE editorial_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON editorial_policies;
CREATE POLICY tenant_isolation ON editorial_policies FOR ALL
  USING      (tenant_id = webdesk_tenant_ctx())
  WITH CHECK (tenant_id = webdesk_tenant_ctx());

ALTER TABLE editorial_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE editorial_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON editorial_items;
CREATE POLICY tenant_isolation ON editorial_items FOR ALL
  USING      (tenant_id = webdesk_tenant_ctx())
  WITH CHECK (tenant_id = webdesk_tenant_ctx());

ALTER TABLE editorial_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE editorial_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON editorial_events;
CREATE POLICY tenant_isolation ON editorial_events FOR ALL
  USING      (tenant_id = webdesk_tenant_ctx())
  WITH CHECK (tenant_id = webdesk_tenant_ctx());

ALTER TABLE editorial_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE editorial_comments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON editorial_comments;
CREATE POLICY tenant_isolation ON editorial_comments FOR ALL
  USING      (tenant_id = webdesk_tenant_ctx())
  WITH CHECK (tenant_id = webdesk_tenant_ctx());

COMMENT ON TABLE editorial_policies IS
  'M5-W2a: review policy per (site, collection). No row = review off. Read by the publish gate (W2c); never by /v1.';
COMMENT ON TABLE editorial_items IS
  'M5-W2a: review state of a content item and the exact immutable versions submitted / SEO-signed / approved. No row = legacy item = draft with no author. Never read by /v1.';
COMMENT ON TABLE editorial_events IS
  'M5-W2a: append-only review history (the app role has no UPDATE or DELETE). Never read by /v1.';
COMMENT ON TABLE editorial_comments IS
  'M5-W2a: review comments anchored to a JSON pointer in one version; only resolved_at / resolved_by are updatable. Never read by /v1.';
