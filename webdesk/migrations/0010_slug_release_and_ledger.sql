-- webdesk/migrations/0010_slug_release_and_ledger.sql
-- WSK-D51 (owner ruling, 2026-10-11): a soft-deleted content item RELEASES its slug.
-- Companion to 0009's soft delete (content_items.deleted_at) and to the WSK-41 write plane.
--
-- What this does:
--   1. content_items: replaces the inline table-wide UNIQUE (collection_id, locale, slug) from
--      0002 with a partial unique index over LIVE rows only (deleted_at IS NULL),
--      ux_content_items_slug_live. Before this file, delete-then-recreate with the same slug was
--      impossible: the soft-deleted row kept its slug forever and the create failed 409
--      slug-taken against a row nobody can see. After it, two soft-deleted rows may share a slug
--      with each other and with one live row; two LIVE rows still may not.
--   2. schema_migrations: REVOKE ALL FROM webdesk_app. The migration ledger is created by
--      migrate.mjs (as the migrator, before the first file runs), and init-roles.sh's default
--      privileges therefore handed the runtime role SELECT/INSERT/UPDATE/DELETE on it (and the
--      ledger was never covered by an explicit REVOKE). The runtime role has no business reading
--      or rewriting the ledger: a compromised or buggy app process could otherwise forge an
--      "applied" row (so a migration is silently skipped) or erase one (so it is re-applied).
--      Nothing in webdesk/api/src reads schema_migrations. This is a REDUCTION of the app
--      role's grants (security-relevant, and the only direction it moves in); no grant is widened.
--
-- WHY THE SLUG INDEX CAN NEVER FAIL TO BUILD. The old constraint was strictly stronger: it
-- forbade any two rows (live or soft-deleted) from sharing (collection_id, locale, slug). Every
-- database that reached 0010 therefore satisfies the weaker rule "no two LIVE rows share it", so
-- the build has nothing to reject. There is deliberately no SELECT-based duplicate precondition
-- (see 0009's header: FORCE RLS + an unset tenant GUC makes such a SELECT see zero rows and pass
-- silently, the estate's RLS zero-row trap). The build below is wrapped like 0009's anyway, so an
-- impossible failure would still be loud and name this file instead of surfacing as a bare 23505.
--
-- THE CONSTRAINT NAME IS RESOLVED FROM THE CATALOG, NOT ASSUMED. 0002 declared the UNIQUE inline,
-- so Postgres named it (content_items_collection_id_locale_slug_key by default). A database
-- restored from a dump, or one where the name was ever changed, may differ. The block below
-- finds the unique constraint on content_items whose key columns are exactly {collection_id,
-- locale, slug}, requires exactly ONE, and drops it by the name it found. Zero or several is a
-- loud failure: an operator has to look, nothing is guessed.
--
-- ROLLOUT ORDER. The pre-0010 API names the old constraint in its 409 mapping
-- (content-commands.service.ts) and uses ON CONFLICT (collection_id, locale, slug) in the legacy
-- redirect upsert (payload/collections/redirects.ts) and in the promotion import; a partial index
-- is only inferred by ON CONFLICT when the statement repeats its predicate. The matching code
-- change (maps ux_content_items_slug_live, adds the predicate, rewrites the promotion import) ships
-- in the same release as this file. If the migrator runs before the new code starts, then until it
-- does a duplicate-slug create is refused with an unmapped 23505 (a 500, nothing written) and the
-- redirect upsert and the promotion import fail with "no unique or exclusion constraint matching
-- the ON CONFLICT specification" (also a 500, nothing written). Loud, and nothing is corrupted.
--
-- Runs as webdesk_migrator (no SET ROLE), like every earlier file in this ledger, in the runner's
-- single per-file transaction. ALTER TABLE ... DROP CONSTRAINT holds ACCESS EXCLUSIVE on
-- content_items until commit, so no row can be written between the drop and the index build.
-- Reversal (not automated): CREATE the table-wide UNIQUE again; it fails if a live row shares a
-- slug with a soft-deleted one, which is exactly the state this file legalises.

-- ---------------------------------------------------------------------------
-- 0. Precondition: this role owns content_items (ALTER TABLE / CREATE INDEX need ownership).
-- ---------------------------------------------------------------------------
-- Same check, same reasoning as 0009 section 0. pg_class is a catalog and is not subject to RLS.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname, pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN ('content_items', 'schema_migrations')
       AND NOT pg_has_role(current_user, c.relowner, 'MEMBER')
  LOOP
    RAISE EXCEPTION '0010 precondition FAILED: table % is owned by %, not by the migrating role %',
      r.relname, r.owner, current_user
      USING HINT = 'Run migrations as webdesk_migrator (MIGRATE_DATABASE_URL). Fix ownership before retrying; do not run this file as a superuser.';
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 1. content_items: the slug is unique among LIVE rows only
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_names text[];
  v_detail text;
BEGIN
  -- Every plain UNIQUE constraint on content_items whose key is exactly the three columns
  -- (collection_id, locale, slug), in any column order. contype 'u' excludes the primary key and
  -- the partial indexes (which are not constraints at all).
  SELECT array_agg(c.conname::text ORDER BY c.conname)
    INTO v_names
    FROM pg_constraint c
   WHERE c.conrelid = 'public.content_items'::regclass
     AND c.contype = 'u'
     AND (
       SELECT array_agg(a.attname::text ORDER BY a.attname::text)
         FROM unnest(c.conkey) AS k(attnum)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
     ) = ARRAY['collection_id', 'locale', 'slug']::text[];

  IF v_names IS NULL OR array_length(v_names, 1) <> 1 THEN
    RAISE EXCEPTION USING
      -- The runner prints only the message, so the names are in the message (not just DETAIL).
      MESSAGE = format('0010 precondition FAILED: expected exactly one UNIQUE constraint on content_items (collection_id, locale, slug), found %s (%s)',
                       coalesce(array_length(v_names, 1), 0), coalesce(array_to_string(v_names, ', '), 'none')),
      HINT    = '0002_content.sql declares it inline (default name content_items_collection_id_locale_slug_key). If it was dropped or duplicated by hand, restore the intended state, then re-run the migrator. Nothing from 0010 was applied.';
  END IF;

  -- The build is the precondition (see the header): it reads the heap directly, not through RLS.
  BEGIN
    CREATE UNIQUE INDEX ux_content_items_slug_live
      ON content_items (collection_id, locale, slug)
      WHERE deleted_at IS NULL;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    RAISE EXCEPTION USING
      ERRCODE = 'unique_violation',
      MESSAGE = '0010 precondition FAILED: content_items has two live rows for the same (collection_id, locale, slug); ux_content_items_slug_live cannot be built',
      DETAIL  = v_detail,
      HINT    = 'This should be impossible while the old table-wide UNIQUE exists. Investigate how it was bypassed, resolve the duplicate under that tenant''s webdesk.tenant_ctx, then re-run the migrator. Nothing from 0010 was applied.';
  END;

  EXECUTE format('ALTER TABLE public.content_items DROP CONSTRAINT %I', v_names[1]);
  RAISE NOTICE '0010: dropped UNIQUE constraint % on content_items; slug is now unique among live rows (ux_content_items_slug_live)', v_names[1];
END
$$;

-- ---------------------------------------------------------------------------
-- 2. schema_migrations: the runtime role cannot touch the migration ledger
-- ---------------------------------------------------------------------------
-- Literal role name, as 0001/0002/0004/0006/0007/0008/0009 spell it. The ledger is created by
-- migrate.mjs before any file runs, so it exists here. REVOKE ALL removes the default-privilege
-- SELECT/INSERT/UPDATE/DELETE (and any TRUNCATE/REFERENCES/TRIGGER that might have been added by
-- hand). The migrator owns the table and keeps every right.
REVOKE ALL ON schema_migrations FROM webdesk_app;
