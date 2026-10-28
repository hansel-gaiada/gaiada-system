-- 202610280500_social_boosts.sql — SCP-4a: boosts and the monthly boost budget.
-- Contract: docs/FRONTEND-BFF-CONTRACT.md §63.1 file 7 ("<prefix+6>_social_boosts.sql") and §63.11. Plan:
-- docs/plans/2026-10-15-social-content-pipeline.md §4.2, rulings SCP-Q11, SCP-Q14, SCP-Q15, SCP-Q18, SCP-Q19. Fixture:
-- src/modules/social/scp-stage-machine.json (`boosts`, `boostBudgets`).
--
-- ── WHAT THIS ADDS ──────────────────────────────────────────────────────────────────────────────────────
--   social_boost_budgets   one row per proposal or recording of a cycle's monthly boost budget. A cycle's agreed
--                          budget is its ONE `agreed` row (partial unique); at most one `pending` proposal at a time.
--   social_boosts          one paid boost of one live post: the agreement, the budget, the start and stop, the
--                          results. At most one OPEN boost (requested, approved, running) per post (partial unique).
--
-- NO ADS ARE BOUGHT BY THE ERP (§63.11). These rows RECORD what the team runs in Meta's own tools, or what the
-- simulator runs. Nothing here, and nothing in the code that writes it, spends money or calls a network.
--
-- ── WALLS: THE PLAIN TENANT WALL, DELIBERATELY ─────────────────────────────────────────────────────────
-- Both tables take the PLAIN tenant wall, `tenant_id = ANY(app_current_tenants())`, on USING and WITH CHECK,
-- FORCE RLS, and NOT the third wall (`AND app_module_allowed('social')`) the rest of the module carries. The client
-- portal WRITES both (it agrees budgets and approves boosts), exactly the reason `social_post_client_reviews` takes
-- the plain wall (0105 D-16, 0088 D-2a): a third wall would read ZERO ROWS, silently, on a portal path that forgot the
-- module scope. That is also why the money facts live here and not as columns on the third-walled `social_cycles`:
-- the cycle lock (src/modules/social/pipeline/boosts-data.ts) keys on the cycle id carried by these rows, so the
-- portal never needs to read `social_cycles` to take it. Do not add app_module_allowed() to either table.
--
-- ── FOREIGN KEYS ────────────────────────────────────────────────────────────────────────────────────────
-- Composite (id, tenant_id) FKs, so a row can never point into another company: client → clients
-- (0105's fk_spcr_client_tenant shape), cycle → social_cycles (ux_social_cycles_id_tenant, 202610271000), post →
-- social_posts (ux_social_posts_id_tenant, 0105), boost → its covering budget (ux_social_boost_budgets_id_tenant,
-- below). Plain FKs to users for every person column. A referential check is not filtered by row security, so the
-- plain-walled child may reference the third-walled `social_cycles` and `social_posts` rows from the portal path.
--
-- ── updated_at, GRANTS ──────────────────────────────────────────────────────────────────────────────────
-- `updated_at` is written by the application on every UPDATE, as on every sibling social table (no trigger). No
-- in-migration GRANT: runtime DML grants come from the owner's ALTER DEFAULT PRIVILEGES and migrate.ts's
-- RUNTIME_GRANTS_SQL pass, exactly as for 0105's tables (social_post_client_reviews included).
--
-- ── NO DML ──────────────────────────────────────────────────────────────────────────────────────────────
-- Two new tables, no row read or written: migrations run as platform_owner WITHOUT BYPASSRLS, so a data backfill on a
-- FORCE-RLS table would read zero rows (the 0050 trap). The closing DO block asserts the catalogue, never a row count.
--
-- ── RE-RUNNABLE ─────────────────────────────────────────────────────────────────────────────────────────
-- CREATE TABLE/INDEX IF NOT EXISTS, DROP CONSTRAINT IF EXISTS + ADD, DROP POLICY IF EXISTS + CREATE. Applies on its own
-- with plain `psql -f` (CI's sync-engine-go job applies every migration that way, with no ledger) and again without
-- error. Neither table is in the sync-engine's write-back registry, so nothing here reaches a replica.
--
-- ── ROLLOUT ─────────────────────────────────────────────────────────────────────────────────────────────
-- Additive: two new empty tables. Runs on boot; no lock on any existing table beyond the FK's brief SHARE ROW
-- EXCLUSIVE on its parent. No deploy-order constraint: no existing code reads either table.

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) social_boost_budgets — the monthly boost budget of one cycle: proposals and recordings.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS social_boost_budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  -- SERVER-DERIVED from the cycle's engagement, never a body (0075's rule 1: a client cannot name their own client).
  client_id uuid NOT NULL,
  cycle_id uuid NOT NULL,
  amount_minor bigint NOT NULL,
  currency char(3) NOT NULL DEFAULT 'IDR',
  status text NOT NULL DEFAULT 'pending',
  -- Who proposed it, or (a recording) who recorded it.
  requested_by uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  request_note text,
  decided_via text,
  -- The portal contact who agreed or declined (portal contacts ARE users rows, 0072).
  decided_by uuid REFERENCES users(id),
  -- The social approver who recorded the client's answer given outside the portal, and how it came.
  recorded_by uuid REFERENCES users(id),
  channel text,
  decision_note text,
  decided_at timestamptz,
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_social_boost_budgets_id_tenant UNIQUE (id, tenant_id),
  CONSTRAINT fk_social_boost_budgets_client_tenant FOREIGN KEY (client_id, tenant_id) REFERENCES clients (id, tenant_id),
  CONSTRAINT fk_social_boost_budgets_cycle_tenant FOREIGN KEY (cycle_id, tenant_id) REFERENCES social_cycles (id, tenant_id)
);

ALTER TABLE social_boost_budgets
  DROP CONSTRAINT IF EXISTS social_boost_budgets_amount_ck,
  ADD CONSTRAINT social_boost_budgets_amount_ck CHECK (amount_minor BETWEEN 0 AND 1000000000000),
  DROP CONSTRAINT IF EXISTS social_boost_budgets_currency_ck,
  ADD CONSTRAINT social_boost_budgets_currency_ck CHECK (currency ~ '^[A-Z]{3}$'),
  DROP CONSTRAINT IF EXISTS social_boost_budgets_status_ck,
  ADD CONSTRAINT social_boost_budgets_status_ck CHECK (status IN ('pending','agreed','declined','withdrawn','superseded')),
  DROP CONSTRAINT IF EXISTS social_boost_budgets_decided_via_ck,
  ADD CONSTRAINT social_boost_budgets_decided_via_ck CHECK (decided_via IS NULL OR decided_via IN ('portal','recorded')),
  DROP CONSTRAINT IF EXISTS social_boost_budgets_channel_ck,
  ADD CONSTRAINT social_boost_budgets_channel_ck CHECK (channel IS NULL OR channel IN ('whatsapp','email','meeting')),
  DROP CONSTRAINT IF EXISTS social_boost_budgets_notes_ck,
  ADD CONSTRAINT social_boost_budgets_notes_ck CHECK (
    (request_note IS NULL OR char_length(request_note) <= 1000)
    AND (decision_note IS NULL OR char_length(decision_note) <= 2000)
  ),
  -- A pending proposal has no decision of any kind yet.
  DROP CONSTRAINT IF EXISTS social_boost_budgets_pending_ck,
  ADD CONSTRAINT social_boost_budgets_pending_ck CHECK (
    status <> 'pending'
    OR (decided_via IS NULL AND decided_at IS NULL AND decided_by IS NULL AND recorded_by IS NULL AND channel IS NULL)
  ),
  -- An agreement or a refusal says how and when it was given.
  DROP CONSTRAINT IF EXISTS social_boost_budgets_decided_ck,
  ADD CONSTRAINT social_boost_budgets_decided_ck CHECK (
    status NOT IN ('agreed','declined') OR (decided_via IS NOT NULL AND decided_at IS NOT NULL)
  ),
  -- In the portal: the contact decided; nobody recorded anything.
  DROP CONSTRAINT IF EXISTS social_boost_budgets_portal_ck,
  ADD CONSTRAINT social_boost_budgets_portal_ck CHECK (
    decided_via IS DISTINCT FROM 'portal' OR (decided_by IS NOT NULL AND recorded_by IS NULL AND channel IS NULL)
  ),
  -- Recorded: the approver, the channel and the note.
  DROP CONSTRAINT IF EXISTS social_boost_budgets_recorded_ck,
  ADD CONSTRAINT social_boost_budgets_recorded_ck CHECK (
    decided_via IS DISTINCT FROM 'recorded' OR (recorded_by IS NOT NULL AND channel IS NOT NULL AND decision_note IS NOT NULL)
  );

-- One pending proposal per cycle, and the cycle's agreed budget is its ONE agreed row.
CREATE UNIQUE INDEX IF NOT EXISTS ux_social_boost_budgets_pending
  ON social_boost_budgets (cycle_id) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS ux_social_boost_budgets_agreed
  ON social_boost_budgets (cycle_id) WHERE status = 'agreed';
-- The portal's approvals list (a client's pending proposals) and the history.
CREATE INDEX IF NOT EXISTS ix_social_boost_budgets_client_status
  ON social_boost_budgets (tenant_id, client_id, status);

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) social_boosts — one paid boost of one live post.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS social_boosts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  post_id uuid NOT NULL,
  -- SERVER-DERIVED from the post's engagement.
  client_id uuid NOT NULL,
  -- The budget cycle: the client's cycle for the month `starts_on` falls in; NULL when there is none (then nothing is
  -- agreed and the client must approve).
  cycle_id uuid,
  status text NOT NULL DEFAULT 'requested',
  goal text NOT NULL,
  audience text NOT NULL,
  audience_note text,
  daily_budget_minor bigint NOT NULL,
  days smallint NOT NULL,
  total_budget_minor bigint GENERATED ALWAYS AS (daily_budget_minor * days) STORED,
  currency char(3) NOT NULL,
  starts_on date NOT NULL,
  reach_estimate_low integer,
  reach_estimate_high integer,
  requested_by uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  approved_via text,
  -- The requester for `budget`, the contact for `portal`, the recorder for `recorded`.
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  -- The agreement that covered a `budget` approval.
  budget_id uuid,
  -- For `recorded`: how the client's answer came, and the recorder's note. (A recorded DECLINE keeps its channel here
  -- too: it is the channel of the client's recorded answer; see boosts.ts.)
  approval_channel text,
  approval_note text,
  started_at timestamptz,
  started_by uuid REFERENCES users(id),
  ended_at timestamptz,
  ended_by uuid REFERENCES users(id),
  -- Results, each >= 0. The spend is recorded when the boost stops or completes.
  spend_minor bigint,
  paid_reach integer,
  clicks integer,
  results_entered_by uuid REFERENCES users(id),
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES users(id),
  cancel_reason text,
  declined_at timestamptz,
  declined_via text,
  declined_by uuid REFERENCES users(id),
  decline_note text,
  -- The post's own mark (a post is wholly simulated or wholly real, SCP-D9): copied from social_posts.simulated.
  simulated boolean NOT NULL DEFAULT false,
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_social_boosts_post_tenant FOREIGN KEY (post_id, tenant_id) REFERENCES social_posts (id, tenant_id),
  CONSTRAINT fk_social_boosts_client_tenant FOREIGN KEY (client_id, tenant_id) REFERENCES clients (id, tenant_id),
  CONSTRAINT fk_social_boosts_cycle_tenant FOREIGN KEY (cycle_id, tenant_id) REFERENCES social_cycles (id, tenant_id),
  CONSTRAINT fk_social_boosts_budget_tenant FOREIGN KEY (budget_id, tenant_id) REFERENCES social_boost_budgets (id, tenant_id)
);

ALTER TABLE social_boosts
  DROP CONSTRAINT IF EXISTS social_boosts_status_ck,
  ADD CONSTRAINT social_boosts_status_ck CHECK (
    status IN ('requested','approved','running','stopped','completed','cancelled','declined')
  ),
  DROP CONSTRAINT IF EXISTS social_boosts_goal_ck,
  ADD CONSTRAINT social_boosts_goal_ck CHECK (goal IN ('profile_visits','website','messages')),
  DROP CONSTRAINT IF EXISTS social_boosts_audience_ck,
  ADD CONSTRAINT social_boosts_audience_ck CHECK (audience IN ('automatic','local','custom')),
  DROP CONSTRAINT IF EXISTS social_boosts_audience_note_ck,
  ADD CONSTRAINT social_boosts_audience_note_ck CHECK (
    (audience_note IS NULL OR char_length(audience_note) <= 500) AND (audience <> 'custom' OR audience_note IS NOT NULL)
  ),
  DROP CONSTRAINT IF EXISTS social_boosts_daily_budget_ck,
  ADD CONSTRAINT social_boosts_daily_budget_ck CHECK (daily_budget_minor BETWEEN 1 AND 1000000000000),
  DROP CONSTRAINT IF EXISTS social_boosts_days_ck,
  ADD CONSTRAINT social_boosts_days_ck CHECK (days BETWEEN 1 AND 90),
  DROP CONSTRAINT IF EXISTS social_boosts_currency_ck,
  ADD CONSTRAINT social_boosts_currency_ck CHECK (currency ~ '^[A-Z]{3}$'),
  DROP CONSTRAINT IF EXISTS social_boosts_reach_estimate_ck,
  ADD CONSTRAINT social_boosts_reach_estimate_ck CHECK (
    (reach_estimate_low IS NULL OR reach_estimate_low >= 0)
    AND (reach_estimate_high IS NULL OR reach_estimate_high >= 0)
    AND (reach_estimate_low IS NULL OR reach_estimate_high IS NULL OR reach_estimate_low <= reach_estimate_high)
  ),
  DROP CONSTRAINT IF EXISTS social_boosts_values_ck,
  ADD CONSTRAINT social_boosts_values_ck CHECK (
    (approved_via IS NULL OR approved_via IN ('budget','portal','recorded'))
    AND (declined_via IS NULL OR declined_via IN ('portal','recorded'))
    AND (approval_channel IS NULL OR approval_channel IN ('whatsapp','email','meeting'))
  ),
  DROP CONSTRAINT IF EXISTS social_boosts_results_ck,
  ADD CONSTRAINT social_boosts_results_ck CHECK (
    (spend_minor IS NULL OR spend_minor BETWEEN 0 AND 1000000000000)
    AND (paid_reach IS NULL OR paid_reach >= 0)
    AND (clicks IS NULL OR clicks >= 0)
  ),
  DROP CONSTRAINT IF EXISTS social_boosts_notes_ck,
  ADD CONSTRAINT social_boosts_notes_ck CHECK (
    (approval_note IS NULL OR char_length(approval_note) <= 2000)
    AND (decline_note IS NULL OR char_length(decline_note) <= 2000)
    AND (cancel_reason IS NULL OR char_length(cancel_reason) <= 500)
  ),
  -- The contract's CHECKs (§63.1 file 7), one each.
  DROP CONSTRAINT IF EXISTS social_boosts_approved_ck,
  ADD CONSTRAINT social_boosts_approved_ck CHECK (
    status NOT IN ('approved','running','stopped','completed')
    OR (approved_via IS NOT NULL AND approved_at IS NOT NULL AND approved_by IS NOT NULL)
  ),
  DROP CONSTRAINT IF EXISTS social_boosts_budget_approval_ck,
  ADD CONSTRAINT social_boosts_budget_approval_ck CHECK (approved_via IS DISTINCT FROM 'budget' OR budget_id IS NOT NULL),
  DROP CONSTRAINT IF EXISTS social_boosts_recorded_approval_ck,
  ADD CONSTRAINT social_boosts_recorded_approval_ck CHECK (
    approved_via IS DISTINCT FROM 'recorded' OR (approval_channel IS NOT NULL AND approval_note IS NOT NULL)
  ),
  DROP CONSTRAINT IF EXISTS social_boosts_started_ck,
  ADD CONSTRAINT social_boosts_started_ck CHECK (status NOT IN ('running','stopped','completed') OR started_at IS NOT NULL),
  DROP CONSTRAINT IF EXISTS social_boosts_ended_ck,
  ADD CONSTRAINT social_boosts_ended_ck CHECK (
    status NOT IN ('stopped','completed') OR (ended_at IS NOT NULL AND spend_minor IS NOT NULL)
  ),
  DROP CONSTRAINT IF EXISTS social_boosts_completed_ck,
  ADD CONSTRAINT social_boosts_completed_ck CHECK (status <> 'completed' OR paid_reach IS NOT NULL),
  -- `status` is NOT NULL, so both sides of each equality are never NULL: enforced in both directions.
  DROP CONSTRAINT IF EXISTS social_boosts_cancelled_ck,
  ADD CONSTRAINT social_boosts_cancelled_ck CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  DROP CONSTRAINT IF EXISTS social_boosts_declined_ck,
  ADD CONSTRAINT social_boosts_declined_ck CHECK ((status = 'declined') = (declined_at IS NOT NULL));

-- One open boost per post. A concurrent second request that slips past the route's check meets this index (23505,
-- answered 409 open_boost_exists by the route).
CREATE UNIQUE INDEX IF NOT EXISTS ux_social_boosts_open_post
  ON social_boosts (post_id) WHERE status IN ('requested','approved','running');
-- `committed` of a cycle (a sum over its boosts by status) and the Boosting list's cycle filter.
CREATE INDEX IF NOT EXISTS ix_social_boosts_cycle_status ON social_boosts (tenant_id, cycle_id, status);
-- The portal's approvals: a client's boosts waiting for them.
CREATE INDEX IF NOT EXISTS ix_social_boosts_client_requested
  ON social_boosts (tenant_id, client_id, status) WHERE status = 'requested';

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
-- FORCE RLS + the PLAIN tenant wall on both tables (see the header: the portal writes them).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['social_boost_budgets','social_boosts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = ANY(app_current_tenants()))
         WITH CHECK (tenant_id = ANY(app_current_tenants()))',
      t
    );
  END LOOP;
END $$;

COMMENT ON TABLE social_boost_budgets IS
  'PLAIN CORE TENANT WALL, deliberately, as social_post_client_reviews (0105 D-16): the client portal writes this table '
  'and a third wall would read zero rows on a portal path. A cycle''s agreed boost budget is its one agreed row. '
  'Do not add app_module_allowed(''social'').';
COMMENT ON TABLE social_boosts IS
  'PLAIN CORE TENANT WALL, deliberately, as social_post_client_reviews (0105 D-16): the client portal approves and '
  'declines boosts. Records what the team runs in Meta''s own tools or the simulator runs; the ERP buys no ads. '
  'Do not add app_module_allowed(''social'').';

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
-- Assert, don't assume: columns, the generated total, constraints, indexes and the walls. Catalogue reads only.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  n integer;
  missing text;
BEGIN
  SELECT string_agg(want.t || '.' || want.c, ', ') INTO missing
    FROM (VALUES
      ('social_boost_budgets','client_id'), ('social_boost_budgets','cycle_id'), ('social_boost_budgets','amount_minor'),
      ('social_boost_budgets','currency'), ('social_boost_budgets','status'), ('social_boost_budgets','requested_by'),
      ('social_boost_budgets','requested_at'), ('social_boost_budgets','request_note'), ('social_boost_budgets','decided_via'),
      ('social_boost_budgets','decided_by'), ('social_boost_budgets','recorded_by'), ('social_boost_budgets','channel'),
      ('social_boost_budgets','decision_note'), ('social_boost_budgets','decided_at'), ('social_boost_budgets','origin_site'),
      ('social_boost_budgets','created_at'), ('social_boost_budgets','updated_at'),
      ('social_boosts','post_id'), ('social_boosts','client_id'), ('social_boosts','cycle_id'), ('social_boosts','status'),
      ('social_boosts','goal'), ('social_boosts','audience'), ('social_boosts','audience_note'),
      ('social_boosts','daily_budget_minor'), ('social_boosts','days'), ('social_boosts','total_budget_minor'),
      ('social_boosts','currency'), ('social_boosts','starts_on'), ('social_boosts','reach_estimate_low'),
      ('social_boosts','reach_estimate_high'), ('social_boosts','requested_by'), ('social_boosts','requested_at'),
      ('social_boosts','approved_via'), ('social_boosts','approved_by'), ('social_boosts','approved_at'),
      ('social_boosts','budget_id'), ('social_boosts','approval_channel'), ('social_boosts','approval_note'),
      ('social_boosts','started_at'), ('social_boosts','started_by'), ('social_boosts','ended_at'), ('social_boosts','ended_by'),
      ('social_boosts','spend_minor'), ('social_boosts','paid_reach'), ('social_boosts','clicks'),
      ('social_boosts','results_entered_by'), ('social_boosts','cancelled_at'), ('social_boosts','cancelled_by'),
      ('social_boosts','cancel_reason'), ('social_boosts','declined_at'), ('social_boosts','declined_via'),
      ('social_boosts','declined_by'), ('social_boosts','decline_note'), ('social_boosts','simulated'),
      ('social_boosts','origin_site'), ('social_boosts','created_at'), ('social_boosts','updated_at')
    ) AS want(t, c)
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns ic
                      WHERE ic.table_schema = current_schema() AND ic.table_name = want.t AND ic.column_name = want.c);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '202610280500: missing columns: %', missing;
  END IF;

  -- The total is generated (daily x days), never written.
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'social_boosts' AND column_name = 'total_budget_minor'
     AND is_generated = 'ALWAYS' AND data_type = 'bigint';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610280500: social_boosts.total_budget_minor must be a GENERATED ALWAYS bigint';
  END IF;

  SELECT string_agg(want.c, ', ') INTO missing
    FROM (VALUES
      ('social_boost_budgets','ux_social_boost_budgets_id_tenant'), ('social_boost_budgets','fk_social_boost_budgets_client_tenant'),
      ('social_boost_budgets','fk_social_boost_budgets_cycle_tenant'), ('social_boost_budgets','social_boost_budgets_amount_ck'),
      ('social_boost_budgets','social_boost_budgets_currency_ck'), ('social_boost_budgets','social_boost_budgets_status_ck'),
      ('social_boost_budgets','social_boost_budgets_decided_via_ck'), ('social_boost_budgets','social_boost_budgets_channel_ck'),
      ('social_boost_budgets','social_boost_budgets_notes_ck'), ('social_boost_budgets','social_boost_budgets_pending_ck'),
      ('social_boost_budgets','social_boost_budgets_decided_ck'), ('social_boost_budgets','social_boost_budgets_portal_ck'),
      ('social_boost_budgets','social_boost_budgets_recorded_ck'),
      ('social_boosts','fk_social_boosts_post_tenant'), ('social_boosts','fk_social_boosts_client_tenant'),
      ('social_boosts','fk_social_boosts_cycle_tenant'), ('social_boosts','fk_social_boosts_budget_tenant'),
      ('social_boosts','social_boosts_status_ck'), ('social_boosts','social_boosts_goal_ck'), ('social_boosts','social_boosts_audience_ck'),
      ('social_boosts','social_boosts_audience_note_ck'), ('social_boosts','social_boosts_daily_budget_ck'),
      ('social_boosts','social_boosts_days_ck'), ('social_boosts','social_boosts_currency_ck'),
      ('social_boosts','social_boosts_reach_estimate_ck'), ('social_boosts','social_boosts_values_ck'),
      ('social_boosts','social_boosts_results_ck'), ('social_boosts','social_boosts_notes_ck'),
      ('social_boosts','social_boosts_approved_ck'), ('social_boosts','social_boosts_budget_approval_ck'),
      ('social_boosts','social_boosts_recorded_approval_ck'), ('social_boosts','social_boosts_started_ck'),
      ('social_boosts','social_boosts_ended_ck'), ('social_boosts','social_boosts_completed_ck'),
      ('social_boosts','social_boosts_cancelled_ck'), ('social_boosts','social_boosts_declined_ck')
    ) AS want(t, c)
   WHERE NOT EXISTS (SELECT 1 FROM pg_constraint pc WHERE pc.conrelid = to_regclass(want.t) AND pc.conname = want.c);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '202610280500: missing constraints: %', missing;
  END IF;

  SELECT string_agg(want.i, ', ') INTO missing
    FROM (VALUES
      ('social_boost_budgets','ux_social_boost_budgets_pending', 'CREATE UNIQUE INDEX', '''pending''::text'),
      ('social_boost_budgets','ux_social_boost_budgets_agreed', 'CREATE UNIQUE INDEX', '''agreed''::text'),
      ('social_boost_budgets','ix_social_boost_budgets_client_status', 'CREATE INDEX', ''),
      ('social_boosts','ux_social_boosts_open_post', 'CREATE UNIQUE INDEX', '''running''::text'),
      ('social_boosts','ix_social_boosts_cycle_status', 'CREATE INDEX', ''),
      ('social_boosts','ix_social_boosts_client_requested', 'CREATE INDEX', '''requested''::text')
    ) AS want(t, i, kind, pred)
   WHERE NOT EXISTS (SELECT 1 FROM pg_indexes pi
                      WHERE pi.schemaname = current_schema() AND pi.tablename = want.t AND pi.indexname = want.i
                        AND pi.indexdef LIKE want.kind || ' %' AND pi.indexdef LIKE '%' || want.pred || '%');
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '202610280500: missing or misshapen indexes: %', missing;
  END IF;

  -- The PLAIN wall: RLS enabled and forced, exactly one policy each, the tenant predicate and NO module clause.
  SELECT count(*) INTO n FROM pg_class
   WHERE relname IN ('social_boost_budgets','social_boosts') AND relkind = 'r' AND relrowsecurity AND relforcerowsecurity;
  IF n <> 2 THEN
    RAISE EXCEPTION '202610280500: both tables must have RLS ENABLED and FORCED, found % of 2', n;
  END IF;
  SELECT count(*) INTO n FROM pg_policies
   WHERE tablename IN ('social_boost_budgets','social_boosts') AND policyname = 'tenant_isolation'
     AND qual LIKE '%app_current_tenants()%' AND with_check LIKE '%app_current_tenants()%'
     AND qual NOT LIKE '%app_module_allowed%' AND with_check NOT LIKE '%app_module_allowed%';
  IF n <> 2 THEN
    RAISE EXCEPTION '202610280500: both tables need the plain tenant policy on USING and WITH CHECK (no module clause), found % of 2', n;
  END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE tablename IN ('social_boost_budgets','social_boosts');
  IF n <> 2 THEN
    RAISE EXCEPTION '202610280500: both tables must carry exactly one policy each, found %', n;
  END IF;
END $$;
