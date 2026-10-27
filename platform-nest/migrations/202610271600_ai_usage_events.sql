-- AIP-01 (docs/plans/2026-10-27-ai-plan.md §1.4, §4.1, §4.2; rulings AIP-D6, AIP-D7, AIP-D11) -- the business record of every AI call.
--
-- WHAT THIS ADDS
--   ai_usage_events      one row per gateway call that reached (or was refused before reaching) a provider. Ids, counts, labels
--                        and money ONLY. NEVER prompt, answer, tool or message text: there is no column that could hold it, and
--                        every free label is length-capped so a caller cannot smuggle a sentence through `task` or `model`.
--   ai_usage_daily       the daily roll-up view (security_invoker, so the caller's RLS applies to the read).
--   ai_usage_events_append_only()   the trigger function that makes the table append-only.
--   ai_usage_erase_user(uuid)       the erasure hook: SECURITY DEFINER, nulls user_id, keeps every count.
--
-- NO READ ROUTE and NO CERBOS KIND HERE. Reads arrive with AIP-15 (a new Cerbos kind `ai_usage`). By AIP-D6 per-person figures are for
-- the department head and the owner only, never the person themselves, so nothing in this file makes a row readable by "its own user".
--
-- ── RLS: THE HOUSE CORE PATTERN, COPIED (0025 / 0026 org_units / 202610181101) ───────────────────────────────────────────────
-- ENABLE + FORCE ROW LEVEL SECURITY and ONE `tenant_isolation` policy FOR ALL, as USING and WITH CHECK:
--     tenant_id = ANY(app_current_tenants())
-- `app_current_tenants()` reads the `app.current_tenant_ids` GUC that withTenants() sets with set_config(.., true). There is NO module
-- predicate (`app_module_allowed`): usage is written from the assistant, the agent runner, knowledge, search and the bots, each in a
-- different module scope, and a module wall would make a writer that forgot to declare one fail. The table is core, like pm_tasks.
-- Who may READ is Cerbos's job from AIP-15; RLS only guarantees that one company never sees another's rows.
--
-- ── APPEND-ONLY: THREE LAYERS, AND THE EXEMPTION IS NARROW ───────────────────────────────────────────────────────────────────
--   1. Grants. platform_app gets SELECT and INSERT only (the owner's default privileges would otherwise hand it UPDATE and DELETE).
--      Guarded by IF EXISTS, as migrate.ts's RUNTIME_GRANTS_SQL is, because platform_app does not exist in a fresh CI database. This
--      NARROWS a default grant; nothing is widened.
--   2. A BEFORE UPDATE OR DELETE trigger, which fires for ANY role whatever its grants (the test harness blanket-grants DML to its own
--      role after migrating, so a REVOKE alone cannot be proved there; see 0068's note). DELETE is always refused. UPDATE is refused
--      unless the ONLY change is user_id and/or org_unit_id going from a value to NULL.
--   3. That one exemption is the erasure hook AND the foreign keys' own ON DELETE SET NULL. A trigger that refused every UPDATE would
--      make deleting a user (or a department) abort on this table, which is the failure the platform-nest guide records for an
--      append-only ledger meeting a user-FK rewrite. The exemption cannot change money, tokens, time, tenant, labels or outcome, and it
--      cannot ever SET an identity: only clear one. The app role has no UPDATE grant at all, so only the owner's function reaches it.
--   What this does NOT cover, stated plainly: TRUNCATE fires no row trigger (platform_app is never granted TRUNCATE), and an
--   owner/superuser can ALTER TABLE .. DISABLE TRIGGER. That is the same residual 0068 accepts.
--
-- ── ERASURE: why a function, and why it sets the tenant GUC itself ───────────────────────────────────────────────────────────
-- A person's rows can sit in several companies (a head works across a group), and the function takes only the user id. The table is
-- FORCE RLS, which applies to the OWNER too (platform_owner is NOBYPASSRLS), so a definer-rights UPDATE with no tenant context would
-- match ZERO rows and report success (the zero-row trap; 202608251530 records the same fact). The function therefore sets
-- app.current_tenant_ids to every company id for the duration of its own UPDATE and RESTORES the caller's value afterwards, so the
-- widening cannot leak into the rest of the caller's transaction. `companies` carries no RLS, so the list is readable. It reads
-- nothing from ai_usage_events and returns only the number of rows it cleared. search_path is pinned (the classic definer hole).
-- EXECUTE is revoked from PUBLIC and granted to platform_app (guarded). Counts are kept on purpose: a company's totals must stay right.
-- org_unit_id is NOT cleared: a department is not personal data, and the department's totals must stay right too.
-- The wire-up: there is no staff-user erasure job in platform-nest today (eraseTenant lives in ai-agents and the assistant's hard delete
-- is a design note). The TypeScript wrapper eraseAiUsageForUser() in src/modules/ai-usage/ is what that job calls when it exists. A
-- hard DELETE of a users row already clears user_id through the FK.
--
-- ── NO FOREIGN KEY ON thread_id / run_id, ON PURPOSE ─────────────────────────────────────────────────────────────────────────
-- Threads are hard-deleted on erasure (0079) and runs live in ai-agents. The usage record must OUTLIVE both, so a cascade or a block
-- would each be wrong. They are bare uuid links. org_unit_id is a plain FK (org_units has no (id, tenant_id) key, and a shared-service
-- department's unit belongs to the provider company while the event belongs to the company served).
--
-- ── CHECKS ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- Every closed vocabulary is a CHECK. A CHECK passes on NULL, so every vocabulary column that must be present is NOT NULL, and the
-- nullable ones (cost_source, tokens, cost) are written so that NULL is the meant case. cost_source is REQUIRED when cost_usd is set.
-- `incurred` means charged but nothing delivered, the search ledger's idea (0053): the money counts, the output does not exist.
-- AIP-D11: cost_source 'provider' (the provider's own figure) first, 'table' (our price table) fills the gap.
--
-- No DML anywhere in this file: no row is read or written, so the zero-row trap cannot bite. The closing DO block asserts the catalogue.
-- Applies on its own with plain `psql -f` (CI's sync-engine-go job applies every migration that way, with no ledger) and again without
-- error: every statement is guarded.
--
-- ROLLOUT: purely additive, nothing reads or writes the table until AIP-03 wires a caller. Deploy order is irrelevant.
-- To undo (only before any caller writes): DROP VIEW ai_usage_daily; DROP TABLE ai_usage_events;
-- DROP FUNCTION ai_usage_erase_user(uuid); DROP FUNCTION ai_usage_events_append_only().

DO $$
BEGIN
  IF to_regprocedure('app_current_tenants()') IS NULL THEN
    RAISE EXCEPTION '202610271600: app_current_tenants() is missing (0025)';
  END IF;
  IF to_regclass('org_units') IS NULL OR to_regclass('users') IS NULL OR to_regclass('companies') IS NULL THEN
    RAISE EXCEPTION '202610271600: companies, users and org_units must exist';
  END IF;
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION '202610271600: needs PostgreSQL 15+ (security_invoker views); server_version_num = %', current_setting('server_version_num');
  END IF;
END $$;

-- ══ (1) the table ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS ai_usage_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES companies(id),            -- the company, as on every tenant table
  occurred_at           timestamptz NOT NULL DEFAULT now(),
  user_id               uuid REFERENCES users(id) ON DELETE SET NULL,      -- NULL = unknown, a bot, or erased
  org_unit_id           uuid REFERENCES org_units(id) ON DELETE SET NULL,  -- the department, when known
  surface               text NOT NULL,
  capability            text NOT NULL,
  task                  text,                                              -- the routing class (AIP-06), a label
  tier                  text,                                              -- the routing tier (AIP-06), a label
  provider              text,
  model                 text,
  prompt_tokens         integer,
  completion_tokens     integer,
  tokens_source         text NOT NULL,
  cost_usd              numeric(14,8),
  cost_source           text,
  outcome               text NOT NULL,
  thread_id             uuid,                                              -- no FK: see the header
  run_id                uuid,                                              -- no FK: see the header
  gateway_provider_hint text
);

-- One ALTER per constraint keeps the DROP and the ADD of a name together, so a re-run replaces and never stacks.
ALTER TABLE ai_usage_events
  DROP CONSTRAINT IF EXISTS ck_ai_usage_events_surface,
  ADD CONSTRAINT ck_ai_usage_events_surface
    CHECK (surface IN ('assistant', 'compaction', 'title', 'agent', 'knowledge', 'search', 'bot', 'other'));
ALTER TABLE ai_usage_events
  DROP CONSTRAINT IF EXISTS ck_ai_usage_events_capability,
  ADD CONSTRAINT ck_ai_usage_events_capability CHECK (capability IN ('llm', 'chat', 'embed', 'media'));
ALTER TABLE ai_usage_events
  DROP CONSTRAINT IF EXISTS ck_ai_usage_events_tokens_source,
  ADD CONSTRAINT ck_ai_usage_events_tokens_source CHECK (tokens_source IN ('provider', 'estimate', 'none'));
ALTER TABLE ai_usage_events
  DROP CONSTRAINT IF EXISTS ck_ai_usage_events_outcome,
  ADD CONSTRAINT ck_ai_usage_events_outcome
    CHECK (outcome IN ('ok', 'blocked_dlp', 'blocked_budget', 'failed_over', 'error', 'incurred'));
-- NULL is the meant case for these three: a call with no reported tokens or no known cost is stored as unknown, never as zero.
ALTER TABLE ai_usage_events
  DROP CONSTRAINT IF EXISTS ck_ai_usage_events_prompt_tokens,
  ADD CONSTRAINT ck_ai_usage_events_prompt_tokens CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0);
ALTER TABLE ai_usage_events
  DROP CONSTRAINT IF EXISTS ck_ai_usage_events_completion_tokens,
  ADD CONSTRAINT ck_ai_usage_events_completion_tokens CHECK (completion_tokens IS NULL OR completion_tokens >= 0);
ALTER TABLE ai_usage_events
  DROP CONSTRAINT IF EXISTS ck_ai_usage_events_cost,
  ADD CONSTRAINT ck_ai_usage_events_cost CHECK (cost_usd IS NULL OR cost_usd >= 0);
-- cost_source: absent, or a known value; and REQUIRED once a cost is set. (`cost_source IN (..)` alone would pass a NULL.)
ALTER TABLE ai_usage_events
  DROP CONSTRAINT IF EXISTS ck_ai_usage_events_cost_source,
  ADD CONSTRAINT ck_ai_usage_events_cost_source CHECK (cost_source IS NULL OR cost_source IN ('provider', 'table'));
ALTER TABLE ai_usage_events
  DROP CONSTRAINT IF EXISTS ck_ai_usage_events_cost_source_required,
  ADD CONSTRAINT ck_ai_usage_events_cost_source_required CHECK (cost_usd IS NULL OR cost_source IS NOT NULL);
-- The five free labels are labels, not prose: a hard length cap is the database's own refusal to hold a sentence.
ALTER TABLE ai_usage_events
  DROP CONSTRAINT IF EXISTS ck_ai_usage_events_labels,
  ADD CONSTRAINT ck_ai_usage_events_labels CHECK (
    (task IS NULL OR length(task) <= 120)
    AND (tier IS NULL OR length(tier) <= 120)
    AND (provider IS NULL OR length(provider) <= 120)
    AND (model IS NULL OR length(model) <= 120)
    AND (gateway_provider_hint IS NULL OR length(gateway_provider_hint) <= 120)
  );

-- (company, department, day) and (company, user, day), as plan §4.2 asks.
CREATE INDEX IF NOT EXISTS ix_ai_usage_events_unit_day ON ai_usage_events (tenant_id, org_unit_id, occurred_at);
CREATE INDEX IF NOT EXISTS ix_ai_usage_events_user_day ON ai_usage_events (tenant_id, user_id, occurred_at);

COMMENT ON TABLE ai_usage_events IS
  'AIP-01: one row per AI gateway call. Ids, counts, labels and money only; NEVER prompt, answer, tool or message text. Append-only '
  '(trigger ai_usage_events_append_only); the only permitted change is user_id/org_unit_id going to NULL (erasure, FK SET NULL). '
  'Read by department head and owner only (AIP-D6), through the Cerbos kind ai_usage (AIP-15).';
COMMENT ON COLUMN ai_usage_events.outcome IS
  'ok | blocked_dlp | blocked_budget | failed_over | error | incurred. incurred = charged but nothing delivered (the search ledger''s idea, 0053): the money counts, no output exists.';
COMMENT ON COLUMN ai_usage_events.tokens_source IS
  'provider = the provider reported the counts; estimate = a 4-characters-per-token estimate; none = no counts at all.';
COMMENT ON COLUMN ai_usage_events.cost_source IS
  'AIP-D11: provider = the provider''s own figure; table = our price table filled the gap. Required whenever cost_usd is set.';

-- ══ (2) RLS: the house core pattern ══════════════════════════════════════════════════════════════════════════════
ALTER TABLE ai_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ai_usage_events;
CREATE POLICY tenant_isolation ON ai_usage_events FOR ALL
  USING (tenant_id = ANY(app_current_tenants()))
  WITH CHECK (tenant_id = ANY(app_current_tenants()));

-- ══ (3) append-only trigger ══════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION ai_usage_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ai_usage_events is append-only: a row is never deleted (row %)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- UPDATE: the one change that is allowed is an identity going from a value to NULL (erasure, or a FK's ON DELETE SET NULL).
  -- Everything else must be byte-identical, and an identity may never be set or changed to another value.
  IF (to_jsonb(NEW) - 'user_id' - 'org_unit_id') IS DISTINCT FROM (to_jsonb(OLD) - 'user_id' - 'org_unit_id')
     OR (NEW.user_id IS NOT NULL AND NEW.user_id IS DISTINCT FROM OLD.user_id)
     OR (NEW.org_unit_id IS NOT NULL AND NEW.org_unit_id IS DISTINCT FROM OLD.org_unit_id) THEN
    RAISE EXCEPTION 'ai_usage_events is append-only: only user_id and org_unit_id may be cleared (row %)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_ai_usage_events_append_only ON ai_usage_events;
CREATE TRIGGER trg_ai_usage_events_append_only
  BEFORE UPDATE OR DELETE ON ai_usage_events
  FOR EACH ROW EXECUTE FUNCTION ai_usage_events_append_only();

-- ══ (4) erasure hook ═════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION ai_usage_erase_user(p_user uuid) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  prev text := current_setting('app.current_tenant_ids', true);
  cleared bigint;
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'ai_usage_erase_user: a user id is required';
  END IF;
  -- FORCE RLS applies to the owner: without a tenant context the UPDATE below would match zero rows and report success.
  PERFORM set_config('app.current_tenant_ids', COALESCE((SELECT string_agg(id::text, ',') FROM companies), ''), true);
  UPDATE ai_usage_events SET user_id = NULL WHERE user_id = p_user;
  GET DIAGNOSTICS cleared = ROW_COUNT;
  -- Put the caller's tenant context back, so the widening never outlives this call.
  PERFORM set_config('app.current_tenant_ids', COALESCE(prev, ''), true);
  RETURN cleared;
END $$;

COMMENT ON FUNCTION ai_usage_erase_user(uuid) IS
  'AIP-01 erasure hook: sets user_id to NULL on every ai_usage_events row of that person, in every company, and keeps every count and amount. '
  'SECURITY DEFINER with a pinned search_path; widens app.current_tenant_ids only for its own UPDATE and restores it. Returns the rows cleared.';

-- ══ (5) the daily roll-up view ═══════════════════════════════════════════════════════════════════════════════════
-- security_invoker: the READER's RLS applies, so a company never sums another's rows. Sums stay NULL when no row in the group reported
-- the figure (unknown is not zero). `day` is the UTC calendar day.
CREATE OR REPLACE VIEW ai_usage_daily WITH (security_invoker = true) AS
SELECT
  tenant_id,
  (occurred_at AT TIME ZONE 'UTC')::date                  AS day,
  org_unit_id,
  user_id,
  surface,
  provider,
  model,
  count(*)::bigint                                        AS calls,
  sum(prompt_tokens)::bigint                              AS prompt_tokens,
  sum(completion_tokens)::bigint                          AS completion_tokens,
  sum(cost_usd)                                           AS cost_usd,
  (count(*) FILTER (WHERE tokens_source = 'estimate'))::bigint AS estimated_calls
FROM ai_usage_events
GROUP BY tenant_id, (occurred_at AT TIME ZONE 'UTC')::date, org_unit_id, user_id, surface, provider, model;

COMMENT ON VIEW ai_usage_daily IS
  'AIP-01: daily roll-up of ai_usage_events per company, UTC day, department, person, surface, provider and model. security_invoker, so RLS applies to the reader. '
  'estimated_calls counts the rows whose token figures are estimates.';

-- ══ (6) grants (security-relevant, stated for review: platform_app is NARROWED, nothing is widened) ═══════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') THEN
    REVOKE ALL ON ai_usage_events FROM platform_app;
    GRANT SELECT, INSERT ON ai_usage_events TO platform_app;
    REVOKE ALL ON ai_usage_daily FROM platform_app;
    GRANT SELECT ON ai_usage_daily TO platform_app;
    REVOKE ALL ON FUNCTION ai_usage_erase_user(uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION ai_usage_erase_user(uuid) TO platform_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sync_app') THEN
    REVOKE ALL ON ai_usage_events FROM sync_app;
    REVOKE ALL ON ai_usage_daily FROM sync_app;
    REVOKE ALL ON FUNCTION ai_usage_erase_user(uuid) FROM sync_app;
  END IF;
END $$;

-- ══ (7) self-check: catalogue reads only, never a row count ══════════════════════════════════════════════════════
DO $$
DECLARE
  n int;
  missing text;
  cols text;
BEGIN
  -- Exactly these columns: a column that could hold text is a defect, so the list is closed.
  SELECT string_agg(column_name::text, ',' ORDER BY column_name::text COLLATE "C") INTO cols FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'ai_usage_events';
  IF cols IS DISTINCT FROM 'capability,completion_tokens,cost_source,cost_usd,gateway_provider_hint,id,model,occurred_at,org_unit_id,outcome,prompt_tokens,provider,run_id,surface,task,tenant_id,thread_id,tier,tokens_source,user_id' THEN
    RAISE EXCEPTION '202610271600: ai_usage_events has the wrong column set: %', cols;
  END IF;

  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'ai_usage_events' AND is_nullable = 'NO'
     AND column_name IN ('id', 'tenant_id', 'occurred_at', 'surface', 'capability', 'tokens_source', 'outcome');
  IF n <> 7 THEN
    RAISE EXCEPTION '202610271600: id, tenant_id, occurred_at, surface, capability, tokens_source and outcome must be NOT NULL, found % of 7', n;
  END IF;

  SELECT string_agg(want.c, ', ') INTO missing
    FROM (VALUES ('ck_ai_usage_events_surface'), ('ck_ai_usage_events_capability'), ('ck_ai_usage_events_tokens_source'),
                 ('ck_ai_usage_events_outcome'), ('ck_ai_usage_events_prompt_tokens'), ('ck_ai_usage_events_completion_tokens'),
                 ('ck_ai_usage_events_cost'), ('ck_ai_usage_events_cost_source'), ('ck_ai_usage_events_cost_source_required'),
                 ('ck_ai_usage_events_labels')) AS want(c)
   WHERE NOT EXISTS (SELECT 1 FROM pg_constraint pc
                      WHERE pc.conrelid = to_regclass('ai_usage_events') AND pc.conname = want.c AND pc.contype = 'c' AND pc.convalidated);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '202610271600: missing or unvalidated CHECKs on ai_usage_events: %', missing;
  END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = to_regclass('ai_usage_events') AND contype = 'f' AND confdeltype = 'n'
     AND conname IN ('ai_usage_events_user_id_fkey', 'ai_usage_events_org_unit_id_fkey');
  IF n <> 2 THEN
    RAISE EXCEPTION '202610271600: user_id and org_unit_id must be foreign keys ON DELETE SET NULL, found % of 2', n;
  END IF;

  SELECT count(*) INTO n FROM pg_indexes
   WHERE schemaname = current_schema() AND tablename = 'ai_usage_events'
     AND ((indexname = 'ix_ai_usage_events_unit_day' AND indexdef LIKE '%(tenant_id, org_unit_id, occurred_at)%')
       OR (indexname = 'ix_ai_usage_events_user_day' AND indexdef LIKE '%(tenant_id, user_id, occurred_at)%'));
  IF n <> 2 THEN
    RAISE EXCEPTION '202610271600: the two (tenant, department|user, time) indexes must exist, found % of 2', n;
  END IF;

  SELECT count(*) INTO n FROM pg_class WHERE oid = to_regclass('ai_usage_events') AND relrowsecurity AND relforcerowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610271600: ai_usage_events must have RLS ENABLED and FORCED';
  END IF;

  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = current_schema() AND tablename = 'ai_usage_events' AND policyname = 'tenant_isolation' AND cmd = 'ALL'
     AND qual LIKE '%app_current_tenants()%' AND with_check LIKE '%app_current_tenants()%';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610271600: ai_usage_events needs exactly the tenant_isolation policy over app_current_tenants()';
  END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'ai_usage_events';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610271600: ai_usage_events must carry no policy other than tenant_isolation, found %', n;
  END IF;

  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgrelid = to_regclass('ai_usage_events') AND tgname = 'trg_ai_usage_events_append_only' AND NOT tgisinternal
     AND tgenabled = 'O' AND (tgtype & 1) = 1 AND (tgtype & 2) = 2 AND (tgtype & 8) = 8 AND (tgtype & 16) = 16 AND (tgtype & 32) = 0;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610271600: trg_ai_usage_events_append_only must be an enabled BEFORE UPDATE OR DELETE row trigger';
  END IF;

  SELECT count(*) INTO n FROM pg_proc
   WHERE oid = to_regprocedure('ai_usage_erase_user(uuid)') AND prosecdef
     AND proconfig IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(proconfig) AS cfg WHERE cfg LIKE 'search_path=%');
  IF n <> 1 THEN
    RAISE EXCEPTION '202610271600: ai_usage_erase_user(uuid) must be SECURITY DEFINER with a pinned search_path';
  END IF;

  SELECT count(*) INTO n FROM pg_class
   WHERE oid = to_regclass('ai_usage_daily') AND relkind = 'v' AND reloptions IS NOT NULL
     AND 'security_invoker=true' = ANY (reloptions);
  IF n <> 1 THEN
    RAISE EXCEPTION '202610271600: ai_usage_daily must be a view with security_invoker = true';
  END IF;

  -- The runtime role may INSERT and SELECT, and nothing else, when it exists (it does not in a fresh CI database).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') THEN
    IF has_table_privilege('platform_app', 'ai_usage_events', 'UPDATE')
       OR has_table_privilege('platform_app', 'ai_usage_events', 'DELETE')
       OR has_table_privilege('platform_app', 'ai_usage_events', 'TRUNCATE')
       OR NOT has_table_privilege('platform_app', 'ai_usage_events', 'SELECT')
       OR NOT has_table_privilege('platform_app', 'ai_usage_events', 'INSERT') THEN
      RAISE EXCEPTION '202610271600: platform_app must hold exactly SELECT and INSERT on ai_usage_events';
    END IF;
  END IF;
END $$;
