-- WSK-48b (rulings WSK-D37 "Payload is removed", WSK-D38 "webdesk/payload/ becomes webdesk/delivery/"):
-- drop the tables Payload's own schema created, now that the Payload app is deleted.
--
-- WHAT THIS DROPS: exactly the nine tables of Payload's initial migration
-- (webdesk/payload/src/migrations/20260829_113056_wsk_initial.ts, deleted in the same change) and
-- nothing else. scripts/setup-schema.mjs (its dev schema push, also deleted) pushed the same set;
-- neither created a type, an enum, a function, a view or a standalone sequence. The only sequences
-- are the serial ones behind the integer ids (users_id_seq, pages_id_seq, ...): a serial sequence is
-- OWNED BY its column and goes with its table, so it needs no statement of its own.
--
--   users_sessions                 (FK -> users)
--   payload_locked_documents_rels  (FK -> payload_locked_documents, users, pages)
--   payload_preferences_rels       (FK -> payload_preferences, users)
--   payload_locked_documents
--   payload_preferences
--   pages                          (carried a tenant_id column, FORCE RLS + the tenant_isolation policy
--                                   from setup-schema.mjs / reapply-tenant-rls.mjs; the policy and the
--                                   indexes go with the table)
--   users                          (Payload's admin login table; NOT a WebDesk table)
--   payload_kv
--   payload_migrations             (Payload's own ledger)
-- The statements below are in dependency order: children before parents.
--
-- NO WEBDESK TABLE HAS A FOREIGN KEY TO ANY OF THESE. Payload's tables were created in the same
-- database as WebDesk's but never referenced by them: no WebDesk migration (0001-0010) says
-- REFERENCES users / pages / payload_*, and none of WebDesk's tables is named like any of the nine.
-- The drops are deliberately plain `DROP TABLE` with no CASCADE: if anything WebDesk owns ever DID
-- depend on one of them (a foreign key, a view), Postgres refuses the drop with "cannot drop table
-- ... because other objects depend on it" and this file fails loudly, rolling back, instead of
-- silently taking that object with it. 0011's test proves both halves (the clean drop, and the
-- refusal when a dependent exists).
--
-- WHY A SHAPE GUARD. `users` and `pages` are generic names. Before dropping either, the block below
-- checks it still has Payload's columns (users: salt, hash, login_attempts; pages: tenant_id, title,
-- body). A table with the same name but another shape is not Payload's, and this file must not drop
-- it: it fails loudly, naming the table, and the operator looks. WebDesk has never had such a table.
--
-- THE LIVE DATABASE: it was rebuilt on 2026-10-10 from WebDesk's own migrations only, so none of
-- the nine tables exist there. On it this file is a NO-OP (every statement is IF EXISTS); it is here
-- for any database that ever ran Payload (the shared dev databases, the spike restore targets).
--
-- OWNERSHIP. DROP TABLE needs ownership. Payload's tables were created by whichever role ran
-- Payload's migration or setup-schema.mjs (webdesk_owner there), while this file runs as
-- webdesk_migrator like every file in this ledger. If a database still holds Payload tables owned by
-- another role, the first DROP fails with "must be owner of table ..." and nothing is applied: run
-- the DROPs below once as that owner (or drop the tables by hand) and re-run the migrator. Not
-- worked around with SET ROLE or GRANT: this ledger never does, and a quiet privilege change is
-- worse than a loud stop.
--
-- Reversal: not automated, and nothing to reverse for a database that never held Payload data. A
-- database whose Payload tables held content cannot be restored from this ledger (the content that
-- mattered, WebDesk's own, lives in content_items and friends).

DO $$
BEGIN
  -- Nested IFs on purpose: the ::regclass cast inside the count must never be planned when the table is absent.
  IF to_regclass('public.users') IS NOT NULL THEN
    IF (SELECT count(*) FROM pg_attribute
         WHERE attrelid = 'public.users'::regclass AND attnum > 0 AND NOT attisdropped
           AND attname IN ('salt', 'hash', 'login_attempts')) < 3 THEN
      RAISE EXCEPTION '0011: public.users exists but does not have Payload''s columns (salt, hash, login_attempts); it is not Payload''s table, so it is NOT dropped. Look at it, then re-run.';
    END IF;
  END IF;
  IF to_regclass('public.pages') IS NOT NULL THEN
    IF (SELECT count(*) FROM pg_attribute
         WHERE attrelid = 'public.pages'::regclass AND attnum > 0 AND NOT attisdropped
           AND attname IN ('tenant_id', 'title', 'body')) < 3 THEN
      RAISE EXCEPTION '0011: public.pages exists but does not have Payload''s columns (tenant_id, title, body); it is not Payload''s table, so it is NOT dropped. Look at it, then re-run.';
    END IF;
  END IF;
END
$$;

DROP TABLE IF EXISTS public.users_sessions;
DROP TABLE IF EXISTS public.payload_locked_documents_rels;
DROP TABLE IF EXISTS public.payload_preferences_rels;
DROP TABLE IF EXISTS public.payload_locked_documents;
DROP TABLE IF EXISTS public.payload_preferences;
DROP TABLE IF EXISTS public.pages;
DROP TABLE IF EXISTS public.users;
DROP TABLE IF EXISTS public.payload_kv;
DROP TABLE IF EXISTS public.payload_migrations;
