-- AIP-15a (docs/plans/2026-10-27-ai-plan.md §6.3 items 0 and 1) -- every usage row records the person's HOME department as an org node id.
--
-- WHY (measured live, 2026-10-30, read-only, counts only): 0 of 41,993 ai_usage_events rows had a department. The writer filled
-- org_unit_id only when the person's primary placement was an `org_units` row, and only 2 departments have one (6 of 33 primary
-- placements map to one). Departments mostly exist only as nodes of company_org_structure. A department view built on org_unit_id would
-- be empty, so the row now also carries the node itself.
--
-- WHAT THIS ADDS
--   ai_usage_events.unit_node_id   text NULL: the org node id of the person's primary placement on the day of the call
--                                  (org_unit_memberships.unit_node_id), whether or not that node has an org_units row. The same shape as
--                                  projects.department_id and knowledge's department_id. Capped at 120 characters like the other labels.
--   ck_ai_usage_events_unit_node_id   NULL, or 1 to 120 characters (a CHECK passes on NULL, and NULL is the meant "no department").
--   ix_ai_usage_events_unit_node_day  (tenant_id, unit_node_id, occurred_at): the department view and, later, a department's month to date.
--   ai_usage_daily                    recreated with unit_node_id APPENDED as its last column (CREATE OR REPLACE VIEW can only append) and
--                                     added to its GROUP BY. Every earlier column keeps its name, type and position; security_invoker
--                                     stays on, so the READER's RLS still applies.
--
-- THE BILL GOES TO THE HOME DEPARTMENT, not to the page the turn came from (§6.3 item 1): a head of SEO who asks from the Web Dev
-- workspace spends SEO's budget. Both writers fill it (platform-nest's recordGatewayCall and the AIP-03b ingest route); org_unit_id is
-- filled exactly as before.
--
-- APPEND-ONLY IS UNCHANGED, AND COVERS THE NEW COLUMN BY ITSELF. ai_usage_events_append_only() (202610271800) compares the WHOLE row
-- (to_jsonb(NEW) minus user_id and org_unit_id against the same of OLD), so a column added later is immutable from the moment it exists:
-- an UPDATE of unit_node_id is refused, and clearing user_id still passes. Erasure (ai_usage_erase_user) keeps unit_node_id, because a
-- department is not personal data and the department's totals must stay right. The trigger function is NOT touched here.
--
-- NO DML, NO BACKFILL. Old rows keep unit_node_id NULL and are shown as "No department recorded" (only ~15 rows of two people on mock data
-- would gain one, and the table is append-only by design). A row with no person (most knowledge embeds) has no department either. Nothing
-- in this file reads or writes a row, so the zero-row trap (FORCE RLS with an unset tenant GUC) cannot bite; the closing DO block reads the
-- catalogue only.
--
-- KNOWN CONSEQUENCE, stated for review: 202610271800's own self-check pins the column set to exactly 20 names. It ran once, before this
-- file, so nothing breaks on a normal migrate (the ledger) or on CI's in-order `psql -f` loop. Re-running 202610271800 by hand AFTER this
-- file would stop at that check; that is the one statement in the estate this change makes non-repeatable, and it is not edited here.
--
-- Applies on its own with plain `psql -f` (no ledger) and again without error: every statement is guarded (ADD COLUMN IF NOT EXISTS, DROP
-- CONSTRAINT IF EXISTS before ADD, CREATE INDEX IF NOT EXISTS, CREATE OR REPLACE VIEW with the same column list).
--
-- ROLLOUT: purely additive. Old platform code ignores the column; new code writes it. Deploy order is irrelevant.
-- To undo: CREATE OR REPLACE cannot drop a view column, so DROP VIEW ai_usage_daily and recreate it from 202610271800 (re-grant SELECT to
-- platform_app), then DROP INDEX ix_ai_usage_events_unit_node_day; ALTER TABLE ai_usage_events DROP COLUMN unit_node_id.

DO $$
BEGIN
  IF to_regclass('ai_usage_events') IS NULL OR to_regclass('ai_usage_daily') IS NULL THEN
    RAISE EXCEPTION '202610300300: ai_usage_events and ai_usage_daily must exist (202610271800)';
  END IF;
  IF to_regprocedure('ai_usage_events_append_only()') IS NULL THEN
    RAISE EXCEPTION '202610300300: ai_usage_events_append_only() is missing (202610271800)';
  END IF;
END $$;

-- ══ (1) the column, its CHECK, its index ═════════════════════════════════════════════════════════════════════════════════
ALTER TABLE ai_usage_events ADD COLUMN IF NOT EXISTS unit_node_id text;

-- One ALTER keeps the DROP and the ADD of the name together, so a re-run replaces and never stacks.
ALTER TABLE ai_usage_events
  DROP CONSTRAINT IF EXISTS ck_ai_usage_events_unit_node_id,
  ADD CONSTRAINT ck_ai_usage_events_unit_node_id CHECK (unit_node_id IS NULL OR length(unit_node_id) BETWEEN 1 AND 120);

CREATE INDEX IF NOT EXISTS ix_ai_usage_events_unit_node_day ON ai_usage_events (tenant_id, unit_node_id, occurred_at);

COMMENT ON COLUMN ai_usage_events.unit_node_id IS
  'AIP-15a: the org node id of the person''s primary placement on the day of the call (org_unit_memberships.unit_node_id), with or without '
  'an org_units row: the HOME department the call is billed to, never the page it came from. NULL = no person, no placement, or a row '
  'written before 202610300300 ("No department recorded"). Immutable through ai_usage_events_append_only(); erasure keeps it.';

-- ══ (2) the daily roll-up view: unit_node_id appended LAST ══════════════════════════════════════════════════════════════
-- The first twelve columns are 202610271800's, in its order, with its expressions. CREATE OR REPLACE VIEW keeps the view's grants.
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
  (count(*) FILTER (WHERE tokens_source = 'estimate'))::bigint AS estimated_calls,
  unit_node_id
FROM ai_usage_events
GROUP BY tenant_id, (occurred_at AT TIME ZONE 'UTC')::date, org_unit_id, user_id, surface, provider, model, unit_node_id;

COMMENT ON VIEW ai_usage_daily IS
  'AIP-01: daily roll-up of ai_usage_events per company, UTC day, department, person, surface, provider and model. security_invoker, so RLS applies to the reader. '
  'estimated_calls counts the rows whose token figures are estimates. AIP-15a: unit_node_id (the home org node) is the last column and part of the grouping.';

-- ══ (3) self-check: catalogue reads only, never a row count ════════════════════════════════════════════════════════════
DO $$
DECLARE
  n int;
  cols text;
BEGIN
  -- The table's column set is closed (202610271800's twenty plus this one), and the new column is nullable text.
  SELECT string_agg(column_name::text, ',' ORDER BY column_name::text COLLATE "C") INTO cols FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'ai_usage_events';
  IF cols IS DISTINCT FROM 'capability,completion_tokens,cost_source,cost_usd,gateway_provider_hint,id,model,occurred_at,org_unit_id,outcome,prompt_tokens,provider,run_id,surface,task,tenant_id,thread_id,tier,tokens_source,unit_node_id,user_id' THEN
    RAISE EXCEPTION '202610300300: ai_usage_events has the wrong column set: %', cols;
  END IF;
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'ai_usage_events' AND column_name = 'unit_node_id'
     AND data_type = 'text' AND is_nullable = 'YES' AND column_default IS NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610300300: ai_usage_events.unit_node_id must be a nullable text column with no default';
  END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = to_regclass('ai_usage_events') AND conname = 'ck_ai_usage_events_unit_node_id' AND contype = 'c' AND convalidated
     AND pg_get_constraintdef(oid) LIKE '%unit_node_id IS NULL%' AND pg_get_constraintdef(oid) LIKE '%120%';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610300300: ck_ai_usage_events_unit_node_id (NULL, or 1 to 120 characters) is missing or unvalidated';
  END IF;

  SELECT count(*) INTO n FROM pg_indexes
   WHERE schemaname = current_schema() AND tablename = 'ai_usage_events'
     AND indexname = 'ix_ai_usage_events_unit_node_day' AND indexdef LIKE '%(tenant_id, unit_node_id, occurred_at)%';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610300300: ix_ai_usage_events_unit_node_day (tenant_id, unit_node_id, occurred_at) is missing';
  END IF;

  -- Append-only still holds: the trigger is the one 202610271800 made, enabled, BEFORE UPDATE OR DELETE, per row.
  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgrelid = to_regclass('ai_usage_events') AND tgname = 'trg_ai_usage_events_append_only' AND NOT tgisinternal
     AND tgenabled = 'O' AND (tgtype & 1) = 1 AND (tgtype & 2) = 2 AND (tgtype & 8) = 8 AND (tgtype & 16) = 16 AND (tgtype & 32) = 0;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610300300: trg_ai_usage_events_append_only must still be an enabled BEFORE UPDATE OR DELETE row trigger';
  END IF;

  -- The view keeps security_invoker, and unit_node_id is its LAST column (the thirteenth).
  SELECT count(*) INTO n FROM pg_class
   WHERE oid = to_regclass('ai_usage_daily') AND relkind = 'v' AND reloptions IS NOT NULL
     AND 'security_invoker=true' = ANY (reloptions);
  IF n <> 1 THEN
    RAISE EXCEPTION '202610300300: ai_usage_daily must be a view with security_invoker = true';
  END IF;
  SELECT string_agg(column_name::text, ',' ORDER BY ordinal_position) INTO cols FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'ai_usage_daily';
  IF cols IS DISTINCT FROM 'tenant_id,day,org_unit_id,user_id,surface,provider,model,calls,prompt_tokens,completion_tokens,cost_usd,estimated_calls,unit_node_id' THEN
    RAISE EXCEPTION '202610300300: ai_usage_daily has the wrong columns or order: %', cols;
  END IF;

  -- The runtime role still reads the view and may INSERT and SELECT the table only, when it exists (it does not in a fresh CI database).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') THEN
    IF NOT has_table_privilege('platform_app', 'ai_usage_daily', 'SELECT')
       OR has_table_privilege('platform_app', 'ai_usage_events', 'UPDATE')
       OR has_table_privilege('platform_app', 'ai_usage_events', 'DELETE') THEN
      RAISE EXCEPTION '202610300300: platform_app must keep SELECT on ai_usage_daily and hold no UPDATE or DELETE on ai_usage_events';
    END IF;
  END IF;
END $$;
