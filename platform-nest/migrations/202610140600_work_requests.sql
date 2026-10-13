-- DW-5c (docs/FRONTEND-BFF-CONTRACT.md §32.1; plan docs/plans/2026-10-13-department-workspaces.md §7.2 and §7.3, ruling
-- DW-D14): REQUESTS BETWEEN DEPARTMENTS. A request is the ask; the work stays where each receiver already works.
--
--   1. work_requests        — one thin row per ask: who asked, from which department, to which department, by when, for
--                             which campaign part, the request form, and the ask's own lifecycle (open, delivered,
--                             declined, cancelled). Progress inside that lifecycle is read live from the work item and
--                             is NEVER copied here. The work item is a PM task (assets) or a Web Dev change request
--                             (engineering), exactly one of the two.
--   2. work_request_assets  — the finished library assets delivered against a request (an asset may serve several).
--   3. work_request_intakes — each receiving department's lazily-created "<Department> · Requests" project, where the
--                             PM tasks of its asset requests live.
--
-- ── WHY work_request_intakes.project_id IS A DEFERRED FOREIGN KEY ────────────────────────────────
-- Two first requests to one department race to create its intake project. The service must make exactly ONE project and
-- must not leave an orphan when it loses. The order that achieves it is: mint the project id, INSERT the intake row
-- (carrying that id) with ON CONFLICT DO NOTHING, and create the project row ONLY IF that insert won. That order needs
-- the intake row to exist before the project row it points at, which a plain FK refuses. DEFERRABLE INITIALLY DEFERRED
-- moves the check to COMMIT, by which time the winner has inserted the project in the same transaction. The loser's
-- ON CONFLICT waits for the winner's transaction (the unique-index speculative insert blocks on an uncommitted
-- conflicting row), inserts nothing, creates no project, and re-selects the winner's committed intake row.
-- The FK is the tenant-scoped composite (project_id, tenant_id) -> projects (id, tenant_id) (ux_projects_id_tenant, 0056),
-- so a cross-tenant project cannot be named even by a bug.
--
-- ── NOTES ON THE REST ─────────────────────────────────────────────────────────────────────────
--   * `to_unit_id`, `from_unit_id` and `work_request_intakes.unit_id` are org-blob node ids (free text, no FK): the
--     `projects.department_id` convention. The application validates `to_unit_id` against the tenant's org tree.
--   * pm_task_id has the tenant-scoped composite FK (pm_tasks already carries ux_pm_tasks_id_tenant, 0054).
--     change_request_id is a plain FK: webdev_change_requests carries no (id, tenant_id) unique and adding one is out of
--     scope; the row is only ever written with the id of a change request the same transaction just inserted.
--   * campaign_part_id is a plain FK for the same reason (agency_campaign_parts, 202610140500, has no composite unique);
--     the application validates the part against the tenant (RLS) before it is written.
--   * Both lifecycle CHECKs are integrity guards for the contract's state machine: a closed request carries closed_at,
--     an open one does not, and a declined one always carries its reason.
--
-- Pure DDL. The Cerbos kind's permission seed is the NEXT migration (202610140610).

-- ── 1 · work_requests ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS work_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  kind text NOT NULL CHECK (kind IN ('assets', 'engineering')),
  -- routing: the receiving department (required), the requester's department (derived by the server, NULL when the
  -- requester sits in none, for example an owner) and the requester
  to_unit_id text NOT NULL CHECK (char_length(to_unit_id) > 0),
  from_unit_id text,
  requested_by uuid NOT NULL REFERENCES users(id),
  -- the ask
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  brief text NOT NULL DEFAULT '' CHECK (char_length(brief) <= 10000),
  needed_by date,
  campaign_part_id uuid REFERENCES agency_campaign_parts(id),
  form jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(form) = 'object'),
  -- the ask's own lifecycle
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'delivered', 'declined', 'cancelled')),
  closed_by uuid REFERENCES users(id),
  closed_at timestamptz,
  decline_reason text CHECK (decline_reason IS NULL OR char_length(decline_reason) <= 2000),
  -- the work item: a PM task (assets) or a Web Dev change request (engineering), exactly one of the two
  pm_task_id uuid,
  change_request_id uuid REFERENCES webdev_change_requests(id),
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT work_requests_work_item_ck CHECK (
    (kind = 'assets' AND pm_task_id IS NOT NULL AND change_request_id IS NULL)
    OR (kind = 'engineering' AND change_request_id IS NOT NULL AND pm_task_id IS NULL)
  ),
  CONSTRAINT work_requests_closed_ck CHECK ((status = 'open') = (closed_at IS NULL)),
  CONSTRAINT work_requests_declined_reason_ck CHECK (status <> 'declined' OR decline_reason IS NOT NULL),
  CONSTRAINT fk_work_requests_task_tenant FOREIGN KEY (pm_task_id, tenant_id) REFERENCES pm_tasks (id, tenant_id),
  -- one request per work item; NULL is allowed on the other kind's column (SQL NULLs are distinct)
  CONSTRAINT ux_work_requests_pm_task UNIQUE (pm_task_id),
  CONSTRAINT ux_work_requests_change_request UNIQUE (change_request_id)
);

CREATE INDEX IF NOT EXISTS ix_work_requests_to_unit
  ON work_requests (tenant_id, to_unit_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_work_requests_from_unit
  ON work_requests (tenant_id, from_unit_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_work_requests_requested_by
  ON work_requests (tenant_id, requested_by) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_work_requests_campaign_part
  ON work_requests (campaign_part_id) WHERE campaign_part_id IS NOT NULL;

ALTER TABLE work_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON work_requests;
CREATE POLICY tenant_isolation ON work_requests FOR ALL
  USING (tenant_id = ANY(app_current_tenants()))
  WITH CHECK (tenant_id = ANY(app_current_tenants()));

-- ── 2 · work_request_assets ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS work_request_assets (
  request_id uuid NOT NULL REFERENCES work_requests(id),
  asset_id uuid NOT NULL REFERENCES creative_assets(id),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  added_by uuid REFERENCES users(id),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, asset_id)
);
CREATE INDEX IF NOT EXISTS ix_work_request_assets_asset ON work_request_assets (asset_id);

ALTER TABLE work_request_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_request_assets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON work_request_assets;
CREATE POLICY tenant_isolation ON work_request_assets FOR ALL
  USING (tenant_id = ANY(app_current_tenants()))
  WITH CHECK (tenant_id = ANY(app_current_tenants()));

-- ── 3 · work_request_intakes ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS work_request_intakes (
  tenant_id uuid NOT NULL REFERENCES companies(id),
  unit_id text NOT NULL CHECK (char_length(unit_id) > 0),
  project_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, unit_id),
  -- DEFERRED: see the header. The intake row is inserted before the project row it names.
  CONSTRAINT fk_work_request_intakes_project_tenant FOREIGN KEY (project_id, tenant_id)
    REFERENCES projects (id, tenant_id) DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE work_request_intakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_request_intakes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON work_request_intakes;
CREATE POLICY tenant_isolation ON work_request_intakes FOR ALL
  USING (tenant_id = ANY(app_current_tenants()))
  WITH CHECK (tenant_id = ANY(app_current_tenants()));

-- ── Assert, don't assume ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  n integer;
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['work_requests', 'work_request_assets', 'work_request_intakes'] LOOP
    SELECT count(*) INTO n FROM pg_class WHERE relname = t AND relrowsecurity AND relforcerowsecurity;
    IF n <> 1 THEN
      RAISE EXCEPTION '202610140600: % must exist with RLS ENABLED and FORCED', t;
    END IF;
    SELECT count(*) INTO n FROM pg_policies WHERE tablename = t AND policyname = 'tenant_isolation';
    IF n <> 1 THEN
      RAISE EXCEPTION '202610140600: % needs exactly one tenant_isolation policy, found %', t, n;
    END IF;
  END LOOP;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'work_requests'::regclass
     AND conname IN ('work_requests_work_item_ck', 'work_requests_closed_ck', 'work_requests_declined_reason_ck',
                     'ux_work_requests_pm_task', 'ux_work_requests_change_request', 'fk_work_requests_task_tenant');
  IF n <> 6 THEN
    RAISE EXCEPTION '202610140600: work_requests should carry its 3 CHECKs, 2 UNIQUEs and the task FK, found % of 6', n;
  END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conname = 'fk_work_request_intakes_project_tenant' AND condeferrable AND condeferred;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610140600: the intake project FK must be DEFERRABLE INITIALLY DEFERRED (the first-request race depends on it)';
  END IF;

  SELECT count(*) INTO n FROM pg_indexes
   WHERE indexname IN ('ix_work_requests_to_unit', 'ix_work_requests_from_unit', 'ix_work_requests_requested_by');
  IF n <> 3 THEN
    RAISE EXCEPTION '202610140600: the three work_requests lookup indexes are missing (found % of 3)', n;
  END IF;

  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_name = 'work_request_assets' AND column_name IN ('request_id', 'asset_id', 'tenant_id', 'added_by', 'added_at');
  IF n <> 5 THEN
    RAISE EXCEPTION '202610140600: work_request_assets should have 5 columns, found %', n;
  END IF;
END $$;
