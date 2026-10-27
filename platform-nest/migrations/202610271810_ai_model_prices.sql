-- AIP-04 (docs/plans/2026-10-27-ai-plan.md §4.1, §4.2; ruling AIP-D11) -- the price table that fills the cost of an AI call when the provider reported none.
--
-- WHAT THIS ADDS
--   ai_model_prices   one row per (provider, model, effective_from): US dollars per MILLION prompt tokens and per MILLION completion tokens, in force
--                     from that date. The writer of ai_usage_events (src/modules/ai-usage/writer.ts) reads it when an event has token counts and no
--                     cost_usd: it takes the NEWEST row whose effective_from is on or before the day of the call, computes the cost, and labels it
--                     cost_source = 'table'. The provider's own figure always comes first and is labelled 'provider' (AIP-D11); this table only fills
--                     the gap. No row for (provider, model) on that day means the cost stays NULL: unknown is not zero.
--
-- NO ROWS ARE SEEDED. No price for the live model (openai / z-ai/glm-5.3-flash, the company OpenRouter key) exists anywhere in the repository, and
-- the OpenRouter answers the gateway has read carry a per-call `usage.cost`, not a rate card. A price is a fact someone looked up and dated; this
-- file never invents one. Until the owner or an admin enters a row (SQL for now; an admin editor is a later ticket), every call whose provider
-- reports no cost keeps cost_usd NULL, and every call whose provider does report one (OpenRouter does) already has it.
--
-- ── NOT TENANT DATA: GLOBAL REFERENCE DATA, NO RLS (the house pattern for platform-wide reference tables) ─────────────────────────────────
-- A model's price is the same for every company, so this table has NO tenant_id and NO row-level security, exactly like `permissions`
-- (0001_core.sql, 0093_iam_permission_catalog.sql: "Global reference data (no tenant_id, no RLS)"). Consequences, checked rather than assumed:
--   (a) `npm run lint:migration-rls` only tracks tables that have had FORCE ROW LEVEL SECURITY applied, so it cannot flag this file;
--   (b) the unset-GUC zero-row trap cannot apply: there is no policy to read an unset app.current_tenant_ids. The self-assertion below therefore
--       checks the CATALOGUE (columns, primary key, constraints, grants), never a row count of data it did not write;
--   (c) the runtime role may only READ it. It is shared by every company, so a write from a tenant-scoped request would be a cross-company write.
--       The platform_owner role (migrations, and the admin editor that a later ticket adds behind its own Cerbos kind) is the only writer.
--
-- IDEMPOTENT: CREATE TABLE IF NOT EXISTS, constraints dropped and re-added by fixed name, grants re-issued. No data change.

DO $$
BEGIN
  IF to_regclass('ai_usage_events') IS NULL THEN
    RAISE EXCEPTION '202610271810: ai_usage_events is missing (the ai_usage_events migration, AIP-01, must run first)';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ai_model_prices (
  provider                 text          NOT NULL,   -- the gateway's provider name as reported in `meta`: openai, ollama, claude, gemini, ...
  model                    text          NOT NULL,   -- the model id the provider served, exactly as the gateway reports it
  prompt_usd_per_mtok      numeric(14,6) NOT NULL,   -- US dollars per 1,000,000 prompt (input) tokens
  completion_usd_per_mtok  numeric(14,6) NOT NULL,   -- US dollars per 1,000,000 completion (output) tokens
  effective_from           date          NOT NULL,   -- the first UTC day this price applies; the newest row on or before a call's day wins
  note                     text,                     -- where the figure came from (a URL and the date it was read); never required, always welcome
  PRIMARY KEY (provider, model, effective_from)
);

ALTER TABLE ai_model_prices
  DROP CONSTRAINT IF EXISTS ck_ai_model_prices_prompt,
  ADD CONSTRAINT ck_ai_model_prices_prompt CHECK (prompt_usd_per_mtok >= 0);
ALTER TABLE ai_model_prices
  DROP CONSTRAINT IF EXISTS ck_ai_model_prices_completion,
  ADD CONSTRAINT ck_ai_model_prices_completion CHECK (completion_usd_per_mtok >= 0);
-- The same label shape the usage writer enforces on `provider` and `model` (writer.ts LABEL_PATTERN), so a row here can always be matched by an
-- event there: no space, 1 to 120 characters.
ALTER TABLE ai_model_prices
  DROP CONSTRAINT IF EXISTS ck_ai_model_prices_labels,
  ADD CONSTRAINT ck_ai_model_prices_labels CHECK (
    provider ~ '^[A-Za-z0-9._:/@+-]{1,120}$' AND model ~ '^[A-Za-z0-9._:/@+-]{1,120}$'
  );
ALTER TABLE ai_model_prices
  DROP CONSTRAINT IF EXISTS ck_ai_model_prices_note,
  ADD CONSTRAINT ck_ai_model_prices_note CHECK (note IS NULL OR length(note) <= 500);

COMMENT ON TABLE ai_model_prices IS
  'Global reference data (no tenant_id, no RLS) -- AIP-04 price table: USD per million prompt and completion tokens per provider and model, in force from effective_from. '
  'Fills ai_usage_events.cost_usd (cost_source = table) only when the provider reported no cost (AIP-D11). The newest row with effective_from <= the call''s UTC day wins; '
  'no row means the cost stays NULL. Read-only to the runtime role; entered by the owner or an admin. No rows are seeded.';
COMMENT ON COLUMN ai_model_prices.effective_from IS
  'The first UTC day this price applies. To change a price, INSERT a new row with a later effective_from; never edit an old one, because old usage rows were costed from it.';

-- Runtime role: read only. The default privileges of the owner would grant it DML on this new table, so REVOKE first.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') THEN
    REVOKE ALL ON ai_model_prices FROM platform_app;
    GRANT SELECT ON ai_model_prices TO platform_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sync_app') THEN
    REVOKE ALL ON ai_model_prices FROM sync_app;
  END IF;
END $$;

-- Self-assertion: the catalogue, never a row count (see the header, (b)).
DO $$
DECLARE
  cols text;
  pk text;
  n int;
BEGIN
  SELECT string_agg(column_name::text, ',' ORDER BY column_name::text COLLATE "C") INTO cols FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'ai_model_prices';
  IF cols IS DISTINCT FROM 'completion_usd_per_mtok,effective_from,model,note,prompt_usd_per_mtok,provider' THEN
    RAISE EXCEPTION '202610271810: ai_model_prices has the wrong column set: %', cols;
  END IF;

  SELECT string_agg(a.attname::text, ',' ORDER BY k.ord) INTO pk
    FROM pg_index i
    JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
   WHERE i.indrelid = 'ai_model_prices'::regclass AND i.indisprimary;
  IF pk IS DISTINCT FROM 'provider,model,effective_from' THEN
    RAISE EXCEPTION '202610271810: ai_model_prices has the wrong primary key: %', pk;
  END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'ai_model_prices'::regclass
     AND conname IN ('ck_ai_model_prices_prompt', 'ck_ai_model_prices_completion', 'ck_ai_model_prices_labels', 'ck_ai_model_prices_note');
  IF n <> 4 THEN
    RAISE EXCEPTION '202610271810: ai_model_prices is missing a CHECK (found % of 4)', n;
  END IF;

  SELECT count(*) INTO n FROM pg_class WHERE oid = 'ai_model_prices'::regclass AND (relrowsecurity OR relforcerowsecurity);
  IF n <> 0 THEN
    RAISE EXCEPTION '202610271810: ai_model_prices is global reference data and must not have row-level security';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') THEN
    IF has_table_privilege('platform_app', 'ai_model_prices', 'INSERT') OR has_table_privilege('platform_app', 'ai_model_prices', 'UPDATE')
       OR has_table_privilege('platform_app', 'ai_model_prices', 'DELETE') OR NOT has_table_privilege('platform_app', 'ai_model_prices', 'SELECT') THEN
      RAISE EXCEPTION '202610271810: platform_app must hold SELECT and nothing else on ai_model_prices';
    END IF;
  END IF;
END $$;
