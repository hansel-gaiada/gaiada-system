-- M5-V5-c — A/B-test registrations and their decision snapshots (docs/plans/2026-10-12-m5-phase5-design.md §5.4, §5.5, §10 O9).
--
-- The ERP side of an experiment. WebDesk holds the arms (the `experiment` block of an item, vocabulary 1.5.0); the site
-- counts exposures and conversions in Umami; THIS file holds what must be fixed BEFORE anyone looks at a number (the
-- pre-registration) and the one decision that follows. DDL ONLY: no INSERT/UPDATE/DELETE, no backfill, so the RLS
-- zero-row trap (an unset app.current_tenant_ids reads ZERO rows, silently) cannot bite.
--
--   search_experiments          one row per registered test: the item it runs on (one experiment is one item in one
--                               locale), the pre-registration (hypothesis, goal, arms/weights, baseline rate, relative MDE,
--                               alpha, power, the computed n per arm and the projected days) and the lifecycle
--                               (draft -> running -> stopped -> decided, or aborted). `started_at` is set when the item's
--                               LIVE version is seen to carry the block (the publish is the start).
--   search_experiment_results   append-only: the decision snapshot (counts, analysis, decision, who decided).
--
-- WHAT THE DATABASE ENFORCES (the service checks first and answers with typed refusals; these are the backstop):
--   * the pre-registration is IMMUTABLE once the test leaves `draft` (a trigger refuses the UPDATE, constraint
--     search_experiments_prereg_locked; the service answers 409 `pre-registration-locked`);
--   * the status machine: draft -> running | aborted; running -> stopped | aborted; stopped -> decided | aborted;
--     decided and aborted are final;
--   * at most 10 RUNNING tests per property (constraint search_experiments_running_cap; Umami returns at most 100
--     `ev` values per read, 10 tests x 4 arms x 2 unit kinds = 80), serialised per property by an advisory lock;
--   * a key is unique per property, and one item carries at most one live registration (draft or running);
--   * search_experiment_results rows can be neither UPDATEd nor DELETEd.
--
-- RLS. Both tables are ENABLE + FORCE ROW LEVEL SECURITY with the composed wall used since 0034:
-- `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('search')`, as USING and WITH CHECK. Nothing here is
-- SECURITY DEFINER. No grant is added: runtime DML grants come from the owner's ALTER DEFAULT PRIVILEGES +
-- RUNTIME_GRANTS_SQL pass (migrations/README.md).
--
-- TRAPS HANDLED. (1) NULL defeats UNIQUE: every unique key is over NOT NULL columns. (2) NULL passes a CHECK: the
-- lifecycle CHECKs are written so a NULL timestamp fails where the status needs one. (3) No DROP + ADD on a shared CHECK:
-- every constraint is new and named by its own table.
--
-- IDEMPOTENT: IF NOT EXISTS everywhere, policies and triggers guarded by catalog lookups.
-- To undo: DROP TABLE search_experiment_results, search_experiments; DROP FUNCTION search_experiments_guard(),
-- search_experiment_results_append_only().
-- ROLLOUT: purely additive; nothing reads these tables until the V5-c routes ship.

-- (1) registrations ----------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS search_experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  property_id uuid NOT NULL REFERENCES search_properties(id),
  key text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9-]{2,47}$'),             -- the block's key (design 5.1)
  -- where the test runs: one item in one locale on one WebDesk site
  webdesk_tenant_slug text NOT NULL CHECK (char_length(webdesk_tenant_slug) BETWEEN 1 AND 200),
  webdesk_site_id uuid NOT NULL,
  collection_key text NOT NULL CHECK (char_length(collection_key) BETWEEN 1 AND 200),
  item_id uuid NOT NULL,
  locale text NOT NULL CHECK (char_length(locale) BETWEEN 1 AND 35),
  -- the Umami section_id whose section_view is the exposure trigger; the duration projection reads it
  section_id text NOT NULL CHECK (section_id ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  target jsonb NOT NULL CHECK (target = '"fields"'::jsonb OR (jsonb_typeof(target) = 'object' AND pg_column_size(target) <= 256)),
  enrolment text NOT NULL DEFAULT 'consented' CHECK (enrolment IN ('consented', 'all')),
  goal jsonb NOT NULL CHECK (jsonb_typeof(goal) = 'object' AND pg_column_size(goal) <= 1024),
  arms jsonb NOT NULL CHECK (jsonb_typeof(arms) = 'array' AND jsonb_array_length(arms) BETWEEN 2 AND 4 AND pg_column_size(arms) <= 1024),
                                                  -- [{key:'a', weight:50}, ...]; overrides live in WebDesk, never here
  hypothesis text NOT NULL CHECK (char_length(hypothesis) BETWEEN 1 AND 500),
  baseline_rate double precision NOT NULL CHECK (baseline_rate > 0 AND baseline_rate < 1),
  baseline_source text NOT NULL CHECK (baseline_source IN ('supplied', 'umami_28d')),
  relative_mde double precision NOT NULL CHECK (relative_mde > 0 AND relative_mde <= 5),
  alpha double precision NOT NULL DEFAULT 0.05 CHECK (alpha > 0 AND alpha < 1),
  power double precision NOT NULL DEFAULT 0.8 CHECK (power > 0 AND power < 1),
  n_per_arm integer NOT NULL CHECK (n_per_arm >= 1),
  daily_units double precision NOT NULL CHECK (daily_units > 0),   -- eligible exposures a day the projection used (28-day rate)
  projected_days integer NOT NULL CHECK (projected_days BETWEEN 14 AND 56),   -- a longer projection is refused at creation
  -- lifecycle (the only columns that may change after the test starts)
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'stopped', 'aborted', 'decided')),
  started_at timestamptz,
  stopped_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT search_experiments_key UNIQUE (property_id, key),
  CONSTRAINT search_experiments_scope UNIQUE (id, tenant_id, property_id),
  CONSTRAINT search_experiments_lifecycle CHECK (
    (status = 'draft'   AND started_at IS NULL AND stopped_at IS NULL)
    OR (status = 'running' AND started_at IS NOT NULL AND stopped_at IS NULL)
    OR (status IN ('stopped', 'decided') AND started_at IS NOT NULL AND stopped_at IS NOT NULL AND stopped_at >= started_at)
    OR (status = 'aborted' AND stopped_at IS NOT NULL AND (started_at IS NULL OR stopped_at >= started_at))
  )
);
-- one live registration per item: the block allows at most one experiment per item
CREATE UNIQUE INDEX IF NOT EXISTS ux_search_experiments_item_live
  ON search_experiments (property_id, webdesk_site_id, item_id) WHERE status IN ('draft', 'running');
CREATE INDEX IF NOT EXISTS ix_search_experiments_property ON search_experiments (tenant_id, property_id, status, created_at DESC);

-- (2) decision snapshots (append-only) ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS search_experiment_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  property_id uuid NOT NULL,
  experiment_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('decided', 'aborted')),
  -- 'decided': the engine's decision at the horizon ({action:'ship',arm} | {action:'keep_control',reason}).
  -- 'aborted': NULL. An abort records that the test ended and nothing else: no outcome is ever computed for it.
  decision jsonb CHECK (decision IS NULL OR (jsonb_typeof(decision) = 'object' AND pg_column_size(decision) <= 1024)),
  counts jsonb CHECK (counts IS NULL OR (jsonb_typeof(counts) = 'array' AND pg_column_size(counts) <= 4096)),     -- [{key, units, conversions}]
  analysis jsonb CHECK (analysis IS NULL OR (jsonb_typeof(analysis) = 'object' AND pg_column_size(analysis) <= 8192)),
  srm jsonb CHECK (srm IS NULL OR (jsonb_typeof(srm) = 'object' AND pg_column_size(srm) <= 1024)),
  window_from timestamptz,
  window_to timestamptz,
  note text CHECK (char_length(note) <= 500),
  decided_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT search_experiment_results_one UNIQUE (experiment_id),
  CONSTRAINT search_experiment_results_experiment_fk FOREIGN KEY (experiment_id, tenant_id, property_id)
    REFERENCES search_experiments (id, tenant_id, property_id),
  CONSTRAINT search_experiment_results_shape CHECK (
    (outcome = 'decided' AND decision IS NOT NULL AND counts IS NOT NULL AND window_from IS NOT NULL AND window_to IS NOT NULL)
    OR (outcome = 'aborted' AND decision IS NULL AND counts IS NULL AND analysis IS NULL AND srm IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS ix_search_experiment_results_property ON search_experiment_results (tenant_id, property_id, created_at DESC);

-- (3) the guard on search_experiments ----------------------------------------------------------------------
-- BEFORE INSERT OR UPDATE. SECURITY INVOKER (default): the cap count reads the table under the caller's own RLS
-- scope, which is the same tenant. The messages carry no value; the constraint name is what the service maps.
CREATE OR REPLACE FUNCTION search_experiments_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE running_others integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.property_id IS DISTINCT FROM OLD.property_id THEN
      RAISE EXCEPTION 'search_experiments: id, tenant and property never change'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'search_experiments_identity';
    END IF;
    -- the pre-registration is frozen once the test has left draft (and on the draft -> anything transition itself)
    IF (OLD.status <> 'draft' OR NEW.status <> 'draft') AND (
         NEW.key IS DISTINCT FROM OLD.key
      OR NEW.webdesk_tenant_slug IS DISTINCT FROM OLD.webdesk_tenant_slug
      OR NEW.webdesk_site_id IS DISTINCT FROM OLD.webdesk_site_id
      OR NEW.collection_key IS DISTINCT FROM OLD.collection_key
      OR NEW.item_id IS DISTINCT FROM OLD.item_id
      OR NEW.locale IS DISTINCT FROM OLD.locale
      OR NEW.section_id IS DISTINCT FROM OLD.section_id
      OR NEW.target IS DISTINCT FROM OLD.target
      OR NEW.enrolment IS DISTINCT FROM OLD.enrolment
      OR NEW.goal IS DISTINCT FROM OLD.goal
      OR NEW.arms IS DISTINCT FROM OLD.arms
      OR NEW.hypothesis IS DISTINCT FROM OLD.hypothesis
      OR NEW.baseline_rate IS DISTINCT FROM OLD.baseline_rate
      OR NEW.baseline_source IS DISTINCT FROM OLD.baseline_source
      OR NEW.relative_mde IS DISTINCT FROM OLD.relative_mde
      OR NEW.alpha IS DISTINCT FROM OLD.alpha
      OR NEW.power IS DISTINCT FROM OLD.power
      OR NEW.n_per_arm IS DISTINCT FROM OLD.n_per_arm
      OR NEW.daily_units IS DISTINCT FROM OLD.daily_units
      OR NEW.projected_days IS DISTINCT FROM OLD.projected_days
      OR NEW.created_by IS DISTINCT FROM OLD.created_by
    ) THEN
      RAISE EXCEPTION 'search_experiments: the pre-registration is locked once the test has started'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'search_experiments_prereg_locked';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
         (OLD.status = 'draft'   AND NEW.status IN ('running', 'aborted'))
      OR (OLD.status = 'running' AND NEW.status IN ('stopped', 'aborted'))
      OR (OLD.status = 'stopped' AND NEW.status IN ('decided', 'aborted'))
    ) THEN
      RAISE EXCEPTION 'search_experiments: the status cannot go from % to %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'search_experiments_status_machine';
    END IF;
    -- a start time, once set, never moves
    IF OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at THEN
      RAISE EXCEPTION 'search_experiments: started_at never changes'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'search_experiments_prereg_locked';
    END IF;
  END IF;

  IF NEW.status = 'running' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'running') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('search_experiments:' || NEW.property_id::text, 0));
    SELECT count(*) INTO running_others FROM search_experiments
     WHERE property_id = NEW.property_id AND status = 'running' AND id <> NEW.id;
    IF running_others >= 10 THEN
      RAISE EXCEPTION 'search_experiments: a property runs at most 10 experiments at once'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'search_experiments_running_cap';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.search_experiments'::regclass AND tgname = 'search_experiments_guard') THEN
    EXECUTE 'CREATE TRIGGER search_experiments_guard
               BEFORE INSERT OR UPDATE ON search_experiments
               FOR EACH ROW EXECUTE FUNCTION search_experiments_guard()';
  END IF;
END $$;

-- (4) results are append-only -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION search_experiment_results_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  RAISE EXCEPTION 'search_experiment_results is append-only'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'search_experiment_results_append_only';
END
$fn$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.search_experiment_results'::regclass AND tgname = 'search_experiment_results_append_only') THEN
    EXECUTE 'CREATE TRIGGER search_experiment_results_append_only
               BEFORE UPDATE OR DELETE ON search_experiment_results
               FOR EACH ROW EXECUTE FUNCTION search_experiment_results_append_only()';
  END IF;
END $$;

-- (5) RLS: ENABLE + FORCE + the composed search wall --------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['search_experiments', 'search_experiment_results'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = t AND policyname = 'tenant_isolation') THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I FOR ALL
           USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''search''))
           WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''search''))', t);
    END IF;
  END LOOP;
END $$;

COMMENT ON TABLE search_experiments IS
  'M5-V5-c: an A/B test on one WebDesk item (design 2026-10-12 §5.4/§5.5). The pre-registration columns are frozen once the test leaves '
  'draft (trigger). started_at = the publish that made the experiment block live. At most 10 running per property.';
COMMENT ON TABLE search_experiment_results IS
  'M5-V5-c: append-only decision snapshot of an experiment (counts, analysis at the horizon, decision, who decided). An aborted test has no outcome.';

-- Self-assertions (pg_catalog has no RLS, so these fire under the non-superuser migrator too).
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = current_schema() AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity
     AND c.relname IN ('search_experiments', 'search_experiment_results');
  IF n <> 2 THEN RAISE EXCEPTION 'M5-V5-c: both experiment tables must ENABLE + FORCE row level security, found %', n; END IF;

  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = current_schema() AND policyname = 'tenant_isolation'
     AND tablename IN ('search_experiments', 'search_experiment_results')
     AND qual ILIKE '%app_current_tenants%' AND qual ILIKE '%app_module_allowed%'
     AND with_check ILIKE '%app_current_tenants%' AND with_check ILIKE '%app_module_allowed%';
  IF n <> 2 THEN RAISE EXCEPTION 'M5-V5-c: expected the composed tenant_isolation policy (USING + WITH CHECK) on both tables, found %', n; END IF;

  SELECT count(*) INTO n FROM pg_trigger
   WHERE NOT tgisinternal AND tgname IN ('search_experiments_guard', 'search_experiment_results_append_only');
  IF n <> 2 THEN RAISE EXCEPTION 'M5-V5-c: both guard triggers must exist, found %', n; END IF;

  SELECT count(*) INTO n FROM pg_indexes
   WHERE schemaname = current_schema()
     AND indexname IN ('ux_search_experiments_item_live', 'ix_search_experiments_property', 'ix_search_experiment_results_property');
  IF n <> 3 THEN RAISE EXCEPTION 'M5-V5-c: expected 3 indexes, found %', n; END IF;
END $$;
