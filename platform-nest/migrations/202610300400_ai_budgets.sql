-- AIP-17b + AIP-19 (docs/plans/2026-10-27-ai-plan.md §6.3 items 6, 7 and 8; rulings AIP-D7, AIP-D8, AIP-D9, AIP-D19) -- the stored side of
-- AI budgets, per-person allowances and the alert ledger.
--
-- WHAT THIS ADDS
--   ai_budgets            the company's monthly alert figure (scope 'company', no mode: AIP-D8 allows no company-level stop) and a
--                         department's monthly budget (scope 'unit', `mode` 'report' by default, 'soft_stop' for AIP-18 later).
--                         A row with no figure does not exist: removing a figure DELETES the row.
--   ai_person_allowances  per-person overrides of the daily reply allowance (AIP-D9). No row = the default (AI_DAILY_REPLY_ALLOWANCE).
--   ai_usage_alerts       the dedupe ledger of the 10-minute job: one row per notice already sent. INSERT .. ON CONFLICT DO NOTHING is how
--                         "once" holds across concurrent runners (two replicas, a restart in the middle of a tick).
--
-- WHO WRITES: only `manage` on the Cerbos kind `ai_usage` (the owner and the superadmin) edits the two settings tables, through
-- platform-nest's routes; the job writes the ledger. Nothing here holds any text a person typed: ids, labels, whole numbers and money.
--
-- ── RLS: THE HOUSE CORE PATTERN (as 202610271800 copies it) ──────────────────────────────────────────────────────────────────
-- ENABLE + FORCE ROW LEVEL SECURITY and ONE `tenant_isolation` policy FOR ALL, as USING and WITH CHECK: tenant_id =
-- ANY(app_current_tenants()). No module predicate: the job and the routes run in the ai-usage library's scope, not a module's.
--
-- ── CHECKS: A CHECK PASSES ON NULL ───────────────────────────────────────────────────────────────────────────────────────────
-- Every rule that must hold for a NULL too is written so NULL fails: the `scope` / `unit_node_id` / `mode` triple is ONE CHECK per
-- scope branch (company: unit and mode NULL; unit: unit set, mode in the vocabulary), and the figure is NOT NULL.
-- `mode` keeps the column DEFAULT 'report' (AIP-D7: report first) so a unit row that omits it is a report-mode row; a COMPANY row must
-- therefore name `mode` NULL explicitly, and an insert that forgets is refused by ck_ai_budgets_scope_shape rather than stored wrongly.
--
-- No DML anywhere in this file, and the closing self-check reads the catalogue only (never a row of a FORCE-RLS table, so the unset-GUC
-- zero-row trap cannot bite). Applies on its own with plain `psql -f` and again without error: every statement is guarded.
--
-- ROLLOUT: purely additive; nothing reads the tables until the routes and the job ship in the same release.
-- To undo: DROP TABLE ai_usage_alerts; DROP TABLE ai_person_allowances; DROP TABLE ai_budgets;

DO $$
BEGIN
  IF to_regprocedure('app_current_tenants()') IS NULL THEN
    RAISE EXCEPTION '202610300400: app_current_tenants() is missing (0025)';
  END IF;
  IF to_regclass('users') IS NULL OR to_regclass('companies') IS NULL THEN
    RAISE EXCEPTION '202610300400: companies and users must exist';
  END IF;
END $$;

-- ══ (1) ai_budgets ═══════════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS ai_budgets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES companies(id),
  scope              text NOT NULL,
  unit_node_id       text,                                   -- NULL for the company row; the org node id for a unit row
  monthly_usd        numeric(12,4) NOT NULL,                 -- the figure; no figure = no row
  mode               text DEFAULT 'report',                  -- NULL for the company row (AIP-D8); 'report' | 'soft_stop' for a unit row
  stop_lifted_month  text,                                   -- 'YYYY-MM' when a stop was lifted for that month (AIP-18 writes it); unit rows only
  updated_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ai_budgets
  DROP CONSTRAINT IF EXISTS ck_ai_budgets_scope,
  ADD CONSTRAINT ck_ai_budgets_scope CHECK (scope IN ('company', 'unit'));
ALTER TABLE ai_budgets
  DROP CONSTRAINT IF EXISTS ck_ai_budgets_scope_shape,
  ADD CONSTRAINT ck_ai_budgets_scope_shape CHECK (
    (scope = 'company' AND unit_node_id IS NULL AND mode IS NULL)
    OR (scope = 'unit' AND unit_node_id IS NOT NULL AND length(unit_node_id) BETWEEN 1 AND 120 AND mode IN ('report', 'soft_stop'))
  );
ALTER TABLE ai_budgets
  DROP CONSTRAINT IF EXISTS ck_ai_budgets_monthly_usd,
  ADD CONSTRAINT ck_ai_budgets_monthly_usd CHECK (monthly_usd > 0);
ALTER TABLE ai_budgets
  DROP CONSTRAINT IF EXISTS ck_ai_budgets_stop_lifted_month,
  ADD CONSTRAINT ck_ai_budgets_stop_lifted_month CHECK (
    stop_lifted_month IS NULL OR (scope = 'unit' AND stop_lifted_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
  );

-- One company row per tenant, one row per (tenant, unit). Partial, because the two scopes share the table.
CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_budgets_company ON ai_budgets (tenant_id) WHERE scope = 'company';
CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_budgets_unit ON ai_budgets (tenant_id, unit_node_id) WHERE scope = 'unit';

COMMENT ON TABLE ai_budgets IS
  'AIP-17b: the company''s monthly AI alert figure (scope company, no mode) and a department''s monthly budget (scope unit; mode report or soft_stop). '
  'No figure = no row. Edited only by `manage` on ai_usage (the owner, the superadmin). Report mode only notifies (AIP-D7); a stop is AIP-18''s.';
COMMENT ON COLUMN ai_budgets.stop_lifted_month IS 'YYYY-MM: the month a soft stop was lifted for this department (AIP-18). Unit rows only.';

-- ══ (2) ai_person_allowances ═════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS ai_person_allowances (
  tenant_id      uuid NOT NULL REFERENCES companies(id),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  daily_replies  integer NOT NULL,
  updated_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

ALTER TABLE ai_person_allowances
  DROP CONSTRAINT IF EXISTS ck_ai_person_allowances_daily_replies,
  ADD CONSTRAINT ck_ai_person_allowances_daily_replies CHECK (daily_replies BETWEEN 1 AND 100000);

COMMENT ON TABLE ai_person_allowances IS
  'AIP-17b (AIP-D9): a person''s own daily reply allowance, overriding the default AI_DAILY_REPLY_ALLOWANCE. No row = the default.';

-- ══ (3) ai_usage_alerts: the dedupe ledger ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS ai_usage_alerts (
  tenant_id  uuid NOT NULL REFERENCES companies(id),
  kind       text NOT NULL,
  subject    text NOT NULL DEFAULT '',     -- '' (company) | the unit node id | the user id | the agent name
  period     text NOT NULL,                -- 'YYYY-MM' for a budget, 'YYYY-MM-DD' for a runaway
  threshold  integer NOT NULL,             -- 80 or 100 (percent of a budget); 500 (5x, in percent) for a runaway
  sent_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind, subject, period, threshold)
);

ALTER TABLE ai_usage_alerts
  DROP CONSTRAINT IF EXISTS ck_ai_usage_alerts_kind,
  ADD CONSTRAINT ck_ai_usage_alerts_kind CHECK (kind IN ('company_budget', 'unit_budget', 'runaway_person', 'runaway_agent'));
ALTER TABLE ai_usage_alerts
  DROP CONSTRAINT IF EXISTS ck_ai_usage_alerts_subject,
  ADD CONSTRAINT ck_ai_usage_alerts_subject CHECK (
    length(subject) <= 120 AND (CASE WHEN kind = 'company_budget' THEN subject = '' ELSE subject <> '' END)
  );
ALTER TABLE ai_usage_alerts
  DROP CONSTRAINT IF EXISTS ck_ai_usage_alerts_period_threshold,
  ADD CONSTRAINT ck_ai_usage_alerts_period_threshold CHECK (
    (kind IN ('company_budget', 'unit_budget') AND period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND threshold IN (80, 100))
    OR (kind IN ('runaway_person', 'runaway_agent') AND period ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' AND threshold = 500)
  );

COMMENT ON TABLE ai_usage_alerts IS
  'AIP-17b/AIP-19: the dedupe ledger of the AI usage job. One row per notice sent; INSERT .. ON CONFLICT DO NOTHING makes "once" hold across runners. '
  'The app role may only SELECT and INSERT.';

-- ══ (4) RLS: the house core pattern ══════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE ai_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_budgets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ai_budgets;
CREATE POLICY tenant_isolation ON ai_budgets FOR ALL
  USING (tenant_id = ANY(app_current_tenants()))
  WITH CHECK (tenant_id = ANY(app_current_tenants()));

ALTER TABLE ai_person_allowances ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_person_allowances FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ai_person_allowances;
CREATE POLICY tenant_isolation ON ai_person_allowances FOR ALL
  USING (tenant_id = ANY(app_current_tenants()))
  WITH CHECK (tenant_id = ANY(app_current_tenants()));

ALTER TABLE ai_usage_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage_alerts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ai_usage_alerts;
CREATE POLICY tenant_isolation ON ai_usage_alerts FOR ALL
  USING (tenant_id = ANY(app_current_tenants()))
  WITH CHECK (tenant_id = ANY(app_current_tenants()));

-- ══ (5) grants (stated for review) ═══════════════════════════════════════════════════════════════════════════════════════
-- Guarded, as 202610271800 is: platform_app does not exist in a fresh CI database. The two settings tables are edited, so they get all four
-- verbs; the ledger is INSERT-only by design (a notice once sent is never edited or removed by the app), which NARROWS the default grant.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') THEN
    REVOKE ALL ON ai_budgets FROM platform_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ai_budgets TO platform_app;
    REVOKE ALL ON ai_person_allowances FROM platform_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ai_person_allowances TO platform_app;
    REVOKE ALL ON ai_usage_alerts FROM platform_app;
    GRANT SELECT, INSERT ON ai_usage_alerts TO platform_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sync_app') THEN
    REVOKE ALL ON ai_budgets FROM sync_app;
    REVOKE ALL ON ai_person_allowances FROM sync_app;
    REVOKE ALL ON ai_usage_alerts FROM sync_app;
  END IF;
END $$;

-- ══ (6) self-check: catalogue reads only ═════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  n int;
  missing text;
  t text;
BEGIN
  SELECT string_agg(want.c, ', ') INTO missing
    FROM (VALUES ('ai_budgets', 'ck_ai_budgets_scope'), ('ai_budgets', 'ck_ai_budgets_scope_shape'), ('ai_budgets', 'ck_ai_budgets_monthly_usd'),
                 ('ai_budgets', 'ck_ai_budgets_stop_lifted_month'),
                 ('ai_person_allowances', 'ck_ai_person_allowances_daily_replies'),
                 ('ai_usage_alerts', 'ck_ai_usage_alerts_kind'), ('ai_usage_alerts', 'ck_ai_usage_alerts_subject'),
                 ('ai_usage_alerts', 'ck_ai_usage_alerts_period_threshold')) AS want(tbl, c)
   WHERE NOT EXISTS (SELECT 1 FROM pg_constraint pc
                      WHERE pc.conrelid = to_regclass(want.tbl) AND pc.conname = want.c AND pc.contype = 'c' AND pc.convalidated);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '202610300400: missing or unvalidated CHECKs: %', missing;
  END IF;

  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema() AND is_nullable = 'NO'
     AND ((table_name = 'ai_budgets' AND column_name IN ('tenant_id', 'scope', 'monthly_usd', 'updated_at'))
       OR (table_name = 'ai_person_allowances' AND column_name IN ('tenant_id', 'user_id', 'daily_replies'))
       OR (table_name = 'ai_usage_alerts' AND column_name IN ('tenant_id', 'kind', 'subject', 'period', 'threshold', 'sent_at')));
  IF n <> 13 THEN
    RAISE EXCEPTION '202610300400: the required columns must be NOT NULL, found % of 13', n;
  END IF;

  SELECT count(*) INTO n FROM pg_indexes
   WHERE schemaname = current_schema() AND tablename = 'ai_budgets'
     AND ((indexname = 'ux_ai_budgets_company' AND indexdef LIKE 'CREATE UNIQUE INDEX%' AND indexdef LIKE '%(tenant_id)%' AND indexdef LIKE '%scope = ''company''%')
       OR (indexname = 'ux_ai_budgets_unit' AND indexdef LIKE 'CREATE UNIQUE INDEX%' AND indexdef LIKE '%(tenant_id, unit_node_id)%' AND indexdef LIKE '%scope = ''unit''%'));
  IF n <> 2 THEN
    RAISE EXCEPTION '202610300400: the two partial unique indexes on ai_budgets must exist, found % of 2', n;
  END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE contype = 'p' AND conrelid IN (to_regclass('ai_person_allowances'), to_regclass('ai_usage_alerts'));
  IF n <> 2 THEN
    RAISE EXCEPTION '202610300400: ai_person_allowances and ai_usage_alerts must each have a primary key, found % of 2', n;
  END IF;

  FOREACH t IN ARRAY ARRAY['ai_budgets', 'ai_person_allowances', 'ai_usage_alerts'] LOOP
    SELECT count(*) INTO n FROM pg_class WHERE oid = to_regclass(t) AND relrowsecurity AND relforcerowsecurity;
    IF n <> 1 THEN
      RAISE EXCEPTION '202610300400: % must have RLS ENABLED and FORCED', t;
    END IF;
    SELECT count(*) INTO n FROM pg_policies
     WHERE schemaname = current_schema() AND tablename = t AND policyname = 'tenant_isolation' AND cmd = 'ALL'
       AND qual LIKE '%app_current_tenants()%' AND with_check LIKE '%app_current_tenants()%';
    IF n <> 1 THEN
      RAISE EXCEPTION '202610300400: % needs exactly the tenant_isolation policy over app_current_tenants()', t;
    END IF;
    SELECT count(*) INTO n FROM pg_policies WHERE schemaname = current_schema() AND tablename = t;
    IF n <> 1 THEN
      RAISE EXCEPTION '202610300400: % must carry no policy other than tenant_isolation, found %', t, n;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') THEN
    IF NOT (has_table_privilege('platform_app', 'ai_budgets', 'SELECT') AND has_table_privilege('platform_app', 'ai_budgets', 'INSERT')
        AND has_table_privilege('platform_app', 'ai_budgets', 'UPDATE') AND has_table_privilege('platform_app', 'ai_budgets', 'DELETE')
        AND has_table_privilege('platform_app', 'ai_person_allowances', 'SELECT') AND has_table_privilege('platform_app', 'ai_person_allowances', 'INSERT')
        AND has_table_privilege('platform_app', 'ai_person_allowances', 'UPDATE') AND has_table_privilege('platform_app', 'ai_person_allowances', 'DELETE')) THEN
      RAISE EXCEPTION '202610300400: platform_app must hold SELECT, INSERT, UPDATE and DELETE on ai_budgets and ai_person_allowances';
    END IF;
    IF has_table_privilege('platform_app', 'ai_usage_alerts', 'UPDATE') OR has_table_privilege('platform_app', 'ai_usage_alerts', 'DELETE')
       OR has_table_privilege('platform_app', 'ai_usage_alerts', 'TRUNCATE')
       OR NOT has_table_privilege('platform_app', 'ai_usage_alerts', 'SELECT') OR NOT has_table_privilege('platform_app', 'ai_usage_alerts', 'INSERT') THEN
      RAISE EXCEPTION '202610300400: platform_app must hold exactly SELECT and INSERT on ai_usage_alerts';
    END IF;
  END IF;
END $$;
