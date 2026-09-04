-- 202609040401_integration_connections_hosting_providers.sql — VLT-1: widen
-- `integration_connections.provider` to admit hosting-credential kinds.
-- Plan: docs/plans/2026-09-04-client-hosting-credential-vault.md §3 (VLT-1).
--
-- ── NUMBERING (migrations/README.md — the timestamp scheme) ────────────────────────────────────
-- `date -u +%Y%m%d%H%M` at authoring time. `ls migrations | sort | tail` showed head =
-- 202609040149_search_properties_domain_key.sql; re-verified immediately before writing.
--
-- ── WHAT THIS DOES ──────────────────────────────────────────────────────────────────────────────
-- Adds four values to `integration_connections.provider`'s CHECK: 'cpanel', 'ftp', 'ssh',
-- 'wp_admin'. A hosting-credential row looks like: `owner_kind = 'client'`,
-- `owner_id -> clients.id` (polymorphic, no FK — 0033's own convention), `provider` one of these
-- four new values, and the credential itself sealed in `access_token_enc` via
-- `src/core/secret-box.ts`'s existing `enc:v1:<iv>:<tag>:<data>` envelope — exactly the same vault
-- column OAuth tokens already use, no new column, no new crypto. `token_key_version` records
-- which key sealed it, same as for OAuth (0033).
--
-- ── owner_kind: NO CHANGE, and none is needed ──────────────────────────────────────────────────
-- `owner_kind` already admits 'client' — widened by 0035, silently dropped and then restored on
-- LIVE by the 202608311000/202608311400 incident described below, and unaffected by either
-- attempt at 'github_app' since. This migration does NOT touch `owner_kind`'s CHECK at all: no
-- DROP, no ADD, not even a no-op ALTER. Anyone tempted to "make sure" by re-touching it should
-- not — every prior touch of that constraint has been the source of a production incident, and
-- the fewer times it is rewritten, the fewer chances to repeat one.
--
-- ── THE ONE RULE THAT MATTERS MORE THAN THE SQL ────────────────────────────────────────────────
-- `202608311000_integration_connections_github_app_owner_kind.sql` (read in full before writing
-- this file) documents a LIVE PRODUCTION INCIDENT: a DROP + ADD on this same table's `owner_kind`
-- CHECK, written from a hardcoded 3-value list typed against 0033's original definition, silently
-- deleted the 'client' value that 0035 had added two migrations earlier. It shipped to LIVE
-- (alpha.308, via a re-run of a transiently-failed build job) before the repair
-- (202608311400) caught up. The lesson, in that file's own words: "a DROP + ADD on a shared CHECK
-- re-declares the WHOLE allow-list from whatever the author happened to know."
--
-- `provider`'s CHECK has EXACTLY the same shape of risk. It has already been widened twice
-- (0033: github|google_drive|claude -> 0035: +google_search_console|google_analytics|google_ads
-- |semrush). A naive DROP+ADD written from this ticket's own understanding of "what provider
-- currently allows" would silently drop all four 0035 values for every future write, exactly as
-- 202608311000's first draft dropped 'client' from owner_kind.
--
-- ── HOW THIS IS MADE SAFE: rebuild from the LIVE definition, never from a list ────────────────
-- Below, a DO block reads the constraint's CURRENT text via `pg_get_constraintdef(oid)`, extracts
-- the value list out of that literal string (a `CHECK (provider = ANY (ARRAY['a'::text, 'b'::text,
-- ...]))` — or an `IN (...)` — form; either is parsed the same way, by pulling every single-quoted
-- literal out of the definition text rather than assuming its exact shape), unions in the four new
-- values, and re-adds the constraint from THAT computed set (rendered back out as an explicit,
-- individually-quoted `IN (...)` list, the same textual shape every prior CHECK on this column
-- already uses). This provably cannot drop a value
-- another migration added, because the base set is read from the database's own catalog at
-- migration time, not retyped from this file's understanding of history — the same category of
-- fix 202608311400's header recommends ("git log -S on the constraint name is the cheap way to be
-- sure") pushed one step further: instead of a human enumerating history by grep, the migration
-- enumerates it by querying `pg_constraint` directly, so there is no "whatever the author happened
-- to know" for the machine to get wrong. `pg_get_constraintdef` is a catalog function, not a read
-- of `integration_connections`' own rows — it is unaffected by that table's FORCE RLS (see the
-- note on RLS posture at the end of this header), so it always sees the true, current definition.
--
-- ── PURELY ADDITIVE ─────────────────────────────────────────────────────────────────────────────
-- Every existing row's `provider` is already one of the seven current values, all of which remain
-- legal after this migration (they are read out of the live constraint, not dropped and retyped),
-- so the widened CHECK is vacuously satisfied for all history. No UPDATE, no INSERT, no backfill —
-- DDL only. Outside `lint:migration-rls`'s DML scan for the same reason 202608311000/202608311400
-- were: no DML statement exists in this file for it to find.
--
-- ── RLS / FORCE RLS POSTURE (checked, not assumed) ─────────────────────────────────────────────
-- `integration_connections` carries `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`
-- (0033) — the identical posture `202609040149_search_properties_domain_key.sql`'s header
-- measured for `search_properties` on the live box: FORCE RLS applies the table's policies to the
-- table OWNER too, and the migration runner connects as `platform_owner`, which is
-- `usesuper = false, bypassrls = false`. A DO-block SELECT against `integration_connections`' own
-- ROWS (its DATA) during a migration would therefore see ZERO rows, exactly as that file found for
-- search_properties — any guard built on counting or reading business rows in this table would be
-- a silent no-op.
--
-- That trap does NOT apply to the self-check below, and here is why: `pg_constraint` and
-- `pg_get_constraintdef()` read PostgreSQL's SYSTEM CATALOG, not `integration_connections`' own
-- rows. System catalogs carry no RLS policies at all (RLS is a per-table opt-in feature applied
-- only to ordinary relations, never to `pg_catalog`), so `platform_owner`'s lack of BYPASSRLS is
-- irrelevant to a catalog lookup — it sees the constraint's true definition regardless. The
-- self-check at the bottom of this file is exactly this shape (a `pg_get_constraintdef` read), so
-- it is a real, firing guard — not a guard that looks protective but cannot fire, which is the
-- specific failure `202609040149`'s header warns against and explicitly removed a guard for. This
-- migration keeps its guard because it is the other case.
--
-- ── ROLLOUT ─────────────────────────────────────────────────────────────────────────────────────
-- Additive, no backfill, no deploy-order dependency on application code — nothing writes a
-- hosting-credential row until a sibling ticket's service code does, and that code cannot exist
-- before this CHECK admits the values it needs. Plain `migrate` apply, no operator step.

DO $$
DECLARE
  cname      text;
  live_def   text;
  lit        text;
  values_in  text[] := ARRAY[]::text[];
  new_vals   text[] := ARRAY['cpanel', 'ftp', 'ssh', 'wp_admin'];
  final_set  text[];
  value_list text;
BEGIN
  -- Find the provider CHECK by CURRENT definition text, not by a name we might get wrong across
  -- migrations (0035 already relies on this same disambiguation: 'provider' + 'github' together,
  -- since 'github' only ever appears in the provider list, never in status/owner_kind's).
  SELECT conname, pg_get_constraintdef(oid)
    INTO cname, live_def
    FROM pg_constraint
   WHERE conrelid = 'integration_connections'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%provider%'
     AND pg_get_constraintdef(oid) ILIKE '%github%';

  IF cname IS NULL THEN
    RAISE EXCEPTION 'VLT-1: could not locate the provider CHECK on integration_connections — refusing to guess';
  END IF;

  -- Pull every single-quoted literal out of the live definition text. Robust to either rendering
  -- Postgres may choose (`IN ('a','b',...)` or `= ANY (ARRAY['a'::text,'b'::text,...])`) because
  -- both forms quote each value the same way; this only ever reads what pg_get_constraintdef
  -- actually returned, never a value typed by hand.
  FOR lit IN SELECT (regexp_matches(live_def, '''([^'']*)''', 'g'))[1] LOOP
    values_in := array_append(values_in, lit);
  END LOOP;

  IF array_length(values_in, 1) IS NULL THEN
    RAISE EXCEPTION 'VLT-1: parsed zero literals out of the live provider CHECK definition (%); refusing to proceed', live_def;
  END IF;

  -- Union: every value the live constraint already admits, PLUS the four new ones. Deduplicated,
  -- so a value already present twice in the source text (should never happen) doesn't double up.
  SELECT array_agg(DISTINCT v) INTO final_set
    FROM unnest(values_in || new_vals) AS v;

  -- Build the CHECK's value list as an explicit, individually-quoted IN (...) list — the same
  -- textual shape 0033/0035/202608311000/202608311400 all wrote by hand for this table's other
  -- CHECKs — rather than relying on an array-literal cast, so the resulting DDL is unambiguous
  -- and matches this table's existing constraint style exactly.
  SELECT string_agg(quote_literal(v), ', ') INTO value_list
    FROM unnest(final_set) AS v;

  EXECUTE format('ALTER TABLE integration_connections DROP CONSTRAINT %I', cname);
  EXECUTE format(
    'ALTER TABLE integration_connections ADD CONSTRAINT %I CHECK (provider IN (%s))',
    cname, value_list
  );

  RAISE NOTICE 'VLT-1: provider CHECK rebuilt from live definition (% pre-existing value(s)) + % new = % total',
    array_length(values_in, 1), array_length(new_vals, 1), array_length(final_set, 1);
END $$;

-- Prove it, rather than trust the ALTER: every value that existed before this migration ran, plus
-- the four new ones, must all still be present afterward. Mirrors 202608311400's self-check
-- pattern (lines 51-70 of that file) — fail loudly if any value is missing rather than leave a
-- silent partial widen sitting on top of an already-fixed bug class.
DO $$
DECLARE
  def text;
  k   text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'integration_connections'
     AND pg_get_constraintdef(c.oid) ILIKE '%provider%'
     AND pg_get_constraintdef(c.oid) ILIKE '%github%';

  IF def IS NULL THEN
    RAISE EXCEPTION 'VLT-1 self-check failed: provider CHECK is absent after rebuild';
  END IF;

  -- Every value ANY prior migration is known to have added, by reading 0033/0035's own text
  -- (never retyped independently of them), plus the four this migration adds.
  FOREACH k IN ARRAY ARRAY[
    'github', 'google_drive', 'claude',                                   -- 0033
    'google_search_console', 'google_analytics', 'google_ads', 'semrush', -- 0035
    'cpanel', 'ftp', 'ssh', 'wp_admin'                                    -- this migration (VLT-1)
  ] LOOP
    IF position(quote_literal(k) IN def) = 0 THEN
      RAISE EXCEPTION 'VLT-1 self-check failed: provider CHECK is missing %; got %', k, def;
    END IF;
  END LOOP;

  RAISE NOTICE 'VLT-1 self-check passed: all 11 provider values present — %', def;
END $$;

-- ── owner_kind self-check (unchanged, confirming this migration left it alone) ────────────────
-- Not a widen — a read-only confirmation that the four values 202608311400 repaired on LIVE are
-- still exactly what they were before this file ran, since this file touches nothing about
-- owner_kind. Cheap insurance against a future edit to this file (or a bad merge) quietly adding
-- an owner_kind ALTER that was never supposed to be here.
DO $$
DECLARE
  def text;
  k   text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'integration_connections'
     AND c.conname = 'integration_connections_owner_kind_check';

  IF def IS NULL THEN
    RAISE EXCEPTION 'VLT-1: integration_connections_owner_kind_check is unexpectedly absent — this migration must not have caused this, investigate before shipping';
  END IF;

  FOREACH k IN ARRAY ARRAY['user', 'company', 'client', 'github_app'] LOOP
    IF position(quote_literal(k) IN def) = 0 THEN
      RAISE EXCEPTION 'VLT-1: owner_kind CHECK is missing % — this migration does not touch owner_kind and should never see this; got %', k, def;
    END IF;
  END LOOP;

  RAISE NOTICE 'VLT-1: owner_kind confirmed unchanged (untouched by this migration) — %', def;
END $$;
