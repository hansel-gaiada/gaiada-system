-- 202608311400_repair_integration_connections_owner_kind_client.sql
-- REPAIR: restore 'client' to integration_connections.owner_kind's CHECK on LIVE.
--
-- ── WHAT HAPPENED, in the order it happened ───────────────────────────────────────────────────────
-- 1. 0033 created the CHECK as ('user','company').
-- 2. 0035 widened it to ('user','company','client') — per-client search-provider OAuth links,
--    owner_id -> clients.id. Same constraint NAME, so it is a drop-and-re-add.
-- 3. 202608311000 (GH-01) needed to add 'github_app'. It dropped and re-added the constraint from a
--    hardcoded list written against 0033's definition: ('user','company','github_app').
--    **That silently removed 'client'.**
-- 4. `src/db/module-search-rls.test.ts` caught it locally and 202608311000 was corrected in the
--    working tree to the full four-value list.
-- 5. BUT alpha.308 had ALREADY been tagged with the uncorrected file, and a re-run of its one failed
--    build job (a transient cosign download error) let its deploy proceed — applying the 3-value
--    version to LIVE and recording 202608311000 in `schema_migrations`.
-- 6. alpha.310 then shipped the corrected file, which will NEVER RUN: a recorded migration is not
--    re-applied. The repository and the database disagree, and the repository looks right.
--
-- ── WHY A NEW MIGRATION AND NOT AN EDIT ──────────────────────────────────────────────────────────
-- An applied migration cannot be fixed by editing it — that is exactly what
-- lint-migration-immutable.mjs exists to prevent, and the reason is this failure mode: the edit
-- makes the file describe a state the database was never put into. 202608311000 is left as-is (its
-- header now documents the four-value intent, which is what SHOULD have run); this file is what
-- actually reconciles LIVE. Anyone reading 202608311000 alone would conclude 'client' is present.
--
-- ── THE ACTUAL IMPACT THIS REPAIRS ───────────────────────────────────────────────────────────────
-- `src/modules/search/google/oauth-state.ts:92` writes `ownerKind: "client"` when sealing per-client
-- Google Search Console / Analytics / Ads credentials. Between step 5 and this migration, every such
-- write fails on LIVE with a check-constraint violation — a feature that was working before GH-01
-- touched a table it merely needed one new value in.
--
-- Idempotent and safe to re-run in effect: DROP IF EXISTS + ADD. No DML, no backfill — every
-- existing row's owner_kind is already one of the four values (the DB has been REFUSING 'client'
-- writes, not storing invalid ones), so the widened CHECK is vacuously satisfied for all history.
-- DDL only, therefore outside lint-migration-rls.mjs's DML scan.
--
-- ⚠ THE RULE, so this does not recur: a DROP + ADD on a shared CHECK re-declares the ENTIRE
-- allow-list from whatever the author happened to know. Before touching one, grep every prior
-- migration that names the constraint and carry every value forward. `git log -S` on the constraint
-- name is the cheap way to be sure.

ALTER TABLE integration_connections DROP CONSTRAINT IF EXISTS integration_connections_owner_kind_check;
ALTER TABLE integration_connections
  ADD CONSTRAINT integration_connections_owner_kind_check
  -- 'user','company' (0033) · 'client' (0035) · 'github_app' (202608311000). All four, deliberately.
  CHECK (owner_kind IN ('user', 'company', 'client', 'github_app'));

-- Prove it, rather than trust the ALTER: fail the migration loudly if any of the four is missing.
-- A silent partial repair here would leave the same class of bug with a fix commit sitting on top of
-- it, which is worse than the original.
DO $$
DECLARE
  def text;
  k   text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'integration_connections'
    AND c.conname = 'integration_connections_owner_kind_check';

  IF def IS NULL THEN
    RAISE EXCEPTION 'repair failed: integration_connections_owner_kind_check is absent';
  END IF;

  FOREACH k IN ARRAY ARRAY['user', 'company', 'client', 'github_app'] LOOP
    IF position(quote_literal(k) IN def) = 0 THEN
      RAISE EXCEPTION 'repair failed: owner_kind CHECK is missing %; got %', k, def;
    END IF;
  END LOOP;
END $$;
