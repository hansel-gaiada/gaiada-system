-- M5-W4 — content briefs for the writers' room: link the EXISTING `search_content_briefs` (0046) to a WebDesk site,
-- collection, locale and (later) draft item. docs/plans/2026-10-11-m5-writers-room-design.md §5 (W4 row), §2.1;
-- docs/plans/2026-10-11-webdesk-m5-plan.md (M5-W4); PERMISSION-CONTRACT §27.4.
--
-- DECISION: REUSE the table, add columns. The design (written before this was checked) assumed no brief record
-- existed; 0046 already made one for the SEO department's AI drafting (topic, outline, body, GEO notes, grounding,
-- status draft|approved). A second brief table would fork the entity, so the writers' room brief IS a row of this
-- table with a WebDesk link and the structured search facts a writer needs. Rows made by the SEO department (no link)
-- are untouched: every new column is nullable or defaulted, and the SEO routes list by property_id exactly as before.
--
-- WHAT THIS ADDS
--   1. `property_id` becomes NULLABLE. A brief an editor files from the writers' room need not belong to a search
--      property (an editorial scope grants no `search` access, and must not: the property is an optional provenance
--      link that the BFF only accepts from a caller who ALSO holds `search_property:read` on it). The SEO routes that
--      address a brief by id (`briefRow` in search.controller.ts) treat a property-less row as not found, because they
--      authorise against the parent property and a NULL parent has nobody to ask.
--   2. The WebDesk link (all-or-none, CHECK): `webdesk_tenant_slug`, `webdesk_site_id`, `collection_key`, `locale`.
--      Opaque Zone B identifiers, never trusted from a body: the BFF takes the site from the route (after the
--      cross-company wall), proves the collection against WebDesk and writes them. `webdesk_item_id` is set when the
--      brief is linked to a draft ("create draft from brief" or "assign"); `linked_at` stamps it.
--   3. `assignee_id`: the user the brief was assigned to (a mirror of WebDesk's `editorial_items.author_sub`, kept by
--      the BFF). It is a LIST FILTER AND A NOTIFICATION TARGET ONLY: whether a principal may READ a brief is decided by
--      Cerbos on the linked ITEM (design §2.1), with the item's author read from WebDesk, never from this column.
--   4. The structured search facts: `target_query`, `search_intent` (the four values search_keywords.intent uses),
--      `ai_questions` and `content_gaps` (jsonb arrays of short strings, at most 50 each), and `source_brief_id`
--      (the SEO brief a writers' room brief was copied from; informational).
--   5. One brief per item: a partial UNIQUE index on (tenant_id, webdesk_item_id). A board index on the site.
--
-- RLS: unchanged and still FORCEd (0046's `tenant_isolation`: tenant wall AND app_module_allowed('search')). Adding
-- columns needs no policy change. The consequence stays the same: a query with no tenant GUC, or with no `search`
-- module scope, reads ZERO rows with no error (the silent-zero trap), so the BFF reads this table only inside
-- `withTenants([tenant], fn, { modules: ["search"] })`, and the DB test proves the zero-row reads.
--
-- DML: none. Pure DDL plus self-assertions that read pg_catalog.

ALTER TABLE search_content_briefs ALTER COLUMN property_id DROP NOT NULL;

ALTER TABLE search_content_briefs
  ADD COLUMN webdesk_tenant_slug text,
  ADD COLUMN webdesk_site_id     uuid,
  ADD COLUMN collection_key      text,
  ADD COLUMN locale              text,
  ADD COLUMN webdesk_item_id     uuid,
  ADD COLUMN linked_at           timestamptz,
  ADD COLUMN assignee_id         uuid,
  ADD COLUMN target_query        text,
  ADD COLUMN search_intent       text,
  ADD COLUMN ai_questions        jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN content_gaps        jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN source_brief_id     uuid REFERENCES search_content_briefs(id);

ALTER TABLE search_content_briefs
  -- All-or-none: either a plain SEO brief (no link at all) or a fully-addressed writers' room brief.
  ADD CONSTRAINT chk_scb_webdesk_link CHECK (
    (webdesk_site_id IS NULL AND webdesk_tenant_slug IS NULL AND collection_key IS NULL AND locale IS NULL
       AND webdesk_item_id IS NULL AND linked_at IS NULL AND assignee_id IS NULL)
    OR
    (webdesk_site_id IS NOT NULL AND webdesk_tenant_slug IS NOT NULL AND collection_key IS NOT NULL AND locale IS NOT NULL)
  ),
  ADD CONSTRAINT chk_scb_item_needs_stamp CHECK ((webdesk_item_id IS NULL) = (linked_at IS NULL)),
  -- property_id is now nullable: a brief must still belong to SOMETHING, a search property or a WebDesk site
  -- (orchestrator review). Existing rows all have a property_id, so this validates on live.
  ADD CONSTRAINT chk_scb_has_owner CHECK (property_id IS NOT NULL OR webdesk_site_id IS NOT NULL),
  ADD CONSTRAINT chk_scb_webdesk_slug CHECK (webdesk_tenant_slug IS NULL OR webdesk_tenant_slug ~ '^[a-z0-9]([a-z0-9-]{0,198}[a-z0-9])?$'),
  ADD CONSTRAINT chk_scb_collection_key CHECK (collection_key IS NULL OR char_length(collection_key) BETWEEN 1 AND 200),
  ADD CONSTRAINT chk_scb_locale CHECK (locale IS NULL OR char_length(locale) BETWEEN 1 AND 35),
  ADD CONSTRAINT chk_scb_target_query CHECK (target_query IS NULL OR char_length(target_query) BETWEEN 1 AND 300),
  ADD CONSTRAINT chk_scb_search_intent CHECK (search_intent IS NULL OR search_intent IN ('informational','commercial','transactional','navigational')),
  ADD CONSTRAINT chk_scb_ai_questions CHECK (jsonb_typeof(ai_questions) = 'array' AND jsonb_array_length(ai_questions) <= 50),
  ADD CONSTRAINT chk_scb_content_gaps CHECK (jsonb_typeof(content_gaps) = 'array' AND jsonb_array_length(content_gaps) <= 50);

-- One brief per WebDesk item (a second brief cannot claim the same draft).
CREATE UNIQUE INDEX ux_search_content_briefs_item
  ON search_content_briefs (tenant_id, webdesk_item_id)
  WHERE webdesk_item_id IS NOT NULL AND deleted_at IS NULL;

-- The writers' board: briefs of one site, newest first.
CREATE INDEX ix_search_content_briefs_site
  ON search_content_briefs (tenant_id, webdesk_site_id, created_at DESC)
  WHERE webdesk_site_id IS NOT NULL AND deleted_at IS NULL;

-- Self-assertions: the RLS state this file relies on is still in place, and the new columns exist.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_class c
   WHERE c.relname = 'search_content_briefs' AND c.relrowsecurity AND c.relforcerowsecurity;
  IF n <> 1 THEN RAISE EXCEPTION 'M5-W4: search_content_briefs must keep ENABLE + FORCE ROW LEVEL SECURITY'; END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE tablename = 'search_content_briefs' AND policyname = 'tenant_isolation';
  IF n <> 1 THEN RAISE EXCEPTION 'M5-W4: search_content_briefs lost its tenant_isolation policy'; END IF;
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'search_content_briefs'
     AND column_name IN ('webdesk_tenant_slug','webdesk_site_id','collection_key','locale','webdesk_item_id','linked_at',
                         'assignee_id','target_query','search_intent','ai_questions','content_gaps','source_brief_id');
  IF n <> 12 THEN RAISE EXCEPTION 'M5-W4: expected 12 new columns on search_content_briefs, found %', n; END IF;
END $$;
