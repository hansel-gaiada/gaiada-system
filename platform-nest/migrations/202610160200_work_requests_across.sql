-- DW-10e-1 (docs/FRONTEND-BFF-CONTRACT.md §60.3; plan docs/plans/2026-10-13-department-workspaces.md §12.2 "10e design";
-- rulings DW-D35, DW-D39, DW-D40, DW-D41): REQUESTS ACROSS GROUP COMPANIES, the data layer.
--
-- A request from a group company H to a department of the agency P lives in P (`tenant_id = P`) like any same-company request,
-- and records H in `requester_tenant_id` and H's client record at P in `client_id` (the work is billable client work, DW-D41).
-- It travels through a ROUTE: a `service_assignments` row whose `module_key` is a routing key (`asset_requests`,
-- `engineering_requests`; core/request-routes.ts). This migration is the database half of the two walls:
--
--   1. work_requests gains five columns: requester_tenant_id, requester_unit_id, requester_unit_name, service_assignment_id,
--      client_id; five CHECKs; three indexes.
--   2. work_requests_route_guard (BEFORE INSERT, SQLSTATE PD060 route / PD062 client) refuses any cross-company row that has no
--      active, matching route or is not billed to the requesting company's client record. It is the wall that holds when a
--      handler is wrong.
--   3. work_requests_freeze_requester (BEFORE UPDATE, SQLSTATE PD061) freezes the identity of the request.
--   4. work_request_client_intakes: each (department, client)'s requests project at the receiving company, the client twin of
--      work_request_intakes (202610140600), with the same DEFERRED project FK for the same first-request race.
--
-- ── NOTHING HERE WIDENS ACCESS ─────────────────────────────────────────────────────────────────────────────────────────────
-- No new policy on work_requests: the row belongs to the receiving company and stays under `tenant_isolation` alone (decision 5:
-- a second policy for the requester would make every existing statement on the table, none of which carries a tenant
-- predicate, start returning the other company's rows). No grant changes. The new table takes the 202610140600 shape: RLS
-- enabled and FORCED, one `tenant_isolation` policy.
--
-- ── ORDER (BFF §60.3) ──────────────────────────────────────────────────────────────────────────────────────────────────────
-- columns (nullable) -> backfill -> SET NOT NULL -> client FK -> CHECKs -> indexes -> triggers -> new table -> assertions.
-- The triggers come AFTER the backfill so the backfill's own UPDATE is not a frozen-column write.
--
-- ── THE BACKFILL, AND THE TRAP IT AVOIDS ───────────────────────────────────────────────────────────────────────────────────
-- work_requests is FORCE RLS and the migration role has no BYPASSRLS, so an unscoped `UPDATE work_requests` matches ZERO rows and
-- reports success (platform-nest/CLAUDE.md, "An unset tenant GUC makes RLS return ZERO rows"). The backfill therefore walks the
-- companies one at a time with `app.current_tenant_ids` set for each (the 202608261030 pattern). The `SET NOT NULL` that follows
-- scans the whole table regardless of RLS, so it is the REAL proof that no row was missed: it aborts the migration on one.
-- The assertion block at the end counts no rows at all (a count with no tenant set reads zero and lies); it checks the catalog.
--
-- ── IDEMPOTENT AND SAFE ON LIVE DATA ───────────────────────────────────────────────────────────────────────────────────────
-- Columns ADD COLUMN IF NOT EXISTS; constraints and triggers are dropped IF EXISTS and created again; the table is
-- CREATE TABLE IF NOT EXISTS. Every existing row becomes a same-company row (requester_tenant_id = tenant_id, the four other
-- columns NULL), which satisfies every CHECK. Code that predates the column keeps inserting same-company rows (the guard fills a
-- NULL requester_tenant_id with tenant_id), so migration-first and code-first deploys both work, and a rollback of the code
-- between the migration and the next release is harmless. Reverse (no live data to lose before 10e-2 ships): drop both triggers
-- and their functions, drop the table work_request_client_intakes, drop the five CHECKs, the client FK, the service-assignment
-- FK, the requester FK and the five columns.
--
-- ── NOTES ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
--   * The route guard is SECURITY INVOKER and reads under the inserting session's tenant set, which is the receiving company P.
--     There `sa_select` (accepts either side of the edge), org_units, clients, projects, pm_tasks and webdev_change_requests all
--     show the rows it needs: every one is on the plain tenant wall (none composes app_module_allowed). `companies` has no RLS.
--     No bypass role is involved. A caller that opened its transaction with another tenant set reads nothing and is refused,
--     which is the safe direction.
--   * The routing-key CASE in the guard is pinned to core/request-routes.ts REQUEST_ROUTE_KEYS by a static test.
--   * org node ids are unique only per company (`d-webdev` repeats): the guard compares `org_units.node_id` to `to_unit_id`
--     only inside the provider's own org_units row of THIS route, never across tenants.
--   * Not in this file: the IAM seed for `send_across` / `read_across` (PERMISSION-CONTRACT §49, ticket 10e-2).

-- ── 1 · work_requests: the five columns ────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE work_requests ADD COLUMN IF NOT EXISTS requester_tenant_id uuid;
ALTER TABLE work_requests ADD COLUMN IF NOT EXISTS requester_unit_id text;
ALTER TABLE work_requests ADD COLUMN IF NOT EXISTS requester_unit_name text;
ALTER TABLE work_requests ADD COLUMN IF NOT EXISTS service_assignment_id uuid;
ALTER TABLE work_requests ADD COLUMN IF NOT EXISTS client_id uuid;

-- ── 2 · backfill: requester = the company the row lives in, one company at a time, GUC set for each ────────────────────────
DO $$
DECLARE
  co record;
BEGIN
  FOR co IN SELECT id FROM companies ORDER BY id LOOP
    PERFORM set_config('app.current_tenant_ids', co.id::text, true);
    UPDATE work_requests SET requester_tenant_id = tenant_id
     WHERE tenant_id = co.id AND requester_tenant_id IS NULL;
  END LOOP;
  -- Leave the transaction's GUC as the runner found it: no tenant set.
  PERFORM set_config('app.current_tenant_ids', '', true);
END $$;

-- The real proof of the backfill: this scans every row regardless of RLS and aborts the migration on a NULL.
ALTER TABLE work_requests ALTER COLUMN requester_tenant_id SET NOT NULL;

-- ── 3 · foreign keys ───────────────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE work_requests DROP CONSTRAINT IF EXISTS fk_work_requests_requester_tenant;
ALTER TABLE work_requests ADD CONSTRAINT fk_work_requests_requester_tenant
  FOREIGN KEY (requester_tenant_id) REFERENCES companies (id);

ALTER TABLE work_requests DROP CONSTRAINT IF EXISTS fk_work_requests_service_assignment;
ALTER TABLE work_requests ADD CONSTRAINT fk_work_requests_service_assignment
  FOREIGN KEY (service_assignment_id) REFERENCES service_assignments (id);

-- The composite makes a client of ANOTHER company unnameable even by a bug (ux_clients_id_tenant, 0075). MATCH SIMPLE: a NULL
-- client_id (every same-company row) skips the check, which is what the CHECK below then pins.
ALTER TABLE work_requests DROP CONSTRAINT IF EXISTS fk_work_requests_client_tenant;
ALTER TABLE work_requests ADD CONSTRAINT fk_work_requests_client_tenant
  FOREIGN KEY (client_id, tenant_id) REFERENCES clients (id, tenant_id);

-- ── 4 · CHECKs (every operand is NOT NULL or an IS NULL test, so none of them can pass on a NULL) ─────────────────────────
ALTER TABLE work_requests DROP CONSTRAINT IF EXISTS work_requests_requester_route_ck;
ALTER TABLE work_requests ADD CONSTRAINT work_requests_requester_route_ck
  CHECK ((requester_tenant_id = tenant_id) = (service_assignment_id IS NULL));

ALTER TABLE work_requests DROP CONSTRAINT IF EXISTS work_requests_requester_client_ck;
ALTER TABLE work_requests ADD CONSTRAINT work_requests_requester_client_ck
  CHECK ((requester_tenant_id = tenant_id) = (client_id IS NULL));

ALTER TABLE work_requests DROP CONSTRAINT IF EXISTS work_requests_requester_unit_ck;
ALTER TABLE work_requests ADD CONSTRAINT work_requests_requester_unit_ck
  CHECK (requester_tenant_id <> tenant_id OR (requester_unit_id IS NULL AND requester_unit_name IS NULL));

-- A cross row never carries from_unit_id: the receiver's Sent box and summary filter on it and would match the requester's
-- node ids, which are unique only per company.
ALTER TABLE work_requests DROP CONSTRAINT IF EXISTS work_requests_across_from_ck;
ALTER TABLE work_requests ADD CONSTRAINT work_requests_across_from_ck
  CHECK (requester_tenant_id = tenant_id OR from_unit_id IS NULL);

-- A cross request links no campaign part (BFF §60.8).
ALTER TABLE work_requests DROP CONSTRAINT IF EXISTS work_requests_across_part_ck;
ALTER TABLE work_requests ADD CONSTRAINT work_requests_across_part_ck
  CHECK (requester_tenant_id = tenant_id OR campaign_part_id IS NULL);

-- The requester's department name is at most 200 characters (a NULL passes: its presence is the unit CHECK's business).
ALTER TABLE work_requests DROP CONSTRAINT IF EXISTS work_requests_requester_unit_name_len_ck;
ALTER TABLE work_requests ADD CONSTRAINT work_requests_requester_unit_name_len_ck
  CHECK (requester_unit_name IS NULL OR char_length(requester_unit_name) <= 200);

-- ── 5 · indexes ────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- The sender's reads (BFF §60.5) enter the receiving company's scope with an explicit requester predicate.
CREATE INDEX IF NOT EXISTS ix_work_requests_requester
  ON work_requests (requester_tenant_id, tenant_id, status)
  WHERE deleted_at IS NULL AND requester_tenant_id <> tenant_id;
CREATE INDEX IF NOT EXISTS ix_work_requests_requester_unit
  ON work_requests (requester_tenant_id, requester_unit_id, status)
  WHERE deleted_at IS NULL AND requester_unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_work_requests_service_assignment
  ON work_requests (service_assignment_id) WHERE service_assignment_id IS NOT NULL;

-- ── 6 · the route guard: BEFORE INSERT ─────────────────────────────────────────────────────────────────────────────────────
-- SECURITY INVOKER (the default). See NOTES above for why the rows it needs are visible, and why that is the safe direction
-- when they are not. The handler (10e-2) checks all of this first, to give a precise answer; this trigger is the wall that
-- holds when a handler is wrong: a cross request can never be written as unbilled internal work, or through another company's
-- route.
CREATE OR REPLACE FUNCTION work_requests_route_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_route boolean;
  v_client boolean;
  v_work boolean;
BEGIN
  -- Code that predates the column keeps inserting same-company rows.
  IF NEW.requester_tenant_id IS NULL THEN
    NEW.requester_tenant_id := NEW.tenant_id;
  END IF;
  IF NEW.requester_tenant_id = NEW.tenant_id THEN
    RETURN NEW;
  END IF;

  -- (PD060) the route: active, active unit, provider = this row's company, target = the requester, the routing key of the
  -- row's kind, the row's department, and one root for both companies.
  SELECT EXISTS (
    SELECT 1
      FROM service_assignments sa
      JOIN org_units ou ON ou.id = sa.unit_id AND ou.tenant_id = sa.provider_tenant_id
      JOIN companies cp ON cp.id = sa.provider_tenant_id
      JOIN companies ct ON ct.id = sa.target_tenant_id
     WHERE sa.id = NEW.service_assignment_id
       AND sa.status = 'active'
       AND sa.unit_status = 'active'
       AND sa.unit_kind = 'department'
       AND sa.provider_tenant_id = NEW.tenant_id
       AND sa.target_tenant_id = NEW.requester_tenant_id
       AND sa.module_key = CASE NEW.kind
             WHEN 'assets' THEN 'asset_requests'
             WHEN 'engineering' THEN 'engineering_requests'
           END
       AND ou.node_id = NEW.to_unit_id
       AND cp.root_company_id IS NOT NULL
       AND cp.root_company_id = ct.root_company_id
  ) INTO v_route;
  IF NOT v_route THEN
    RAISE EXCEPTION 'work_requests: a cross-company request needs an active route of its kind to this department (kind %, to_unit_id %)',
      NEW.kind, NEW.to_unit_id
      USING ERRCODE = 'PD060';
  END IF;

  -- (PD062) the client: a live, non-internal client of the receiving company, linked to the requester ...
  SELECT EXISTS (
    SELECT 1 FROM clients cl
     WHERE cl.id = NEW.client_id
       AND cl.tenant_id = NEW.tenant_id
       AND cl.deleted_at IS NULL
       AND NOT cl.is_internal
       AND cl.group_company_id = NEW.requester_tenant_id
  ) INTO v_client;
  IF NOT v_client THEN
    RAISE EXCEPTION 'work_requests: a cross-company request is billed to the requesting company''s client record at the receiving company'
      USING ERRCODE = 'PD062';
  END IF;

  -- ... and the work itself is on that client's books. The handler writes the work item before this row in the same
  -- transaction (BFF §32.5's order), so it is visible here.
  IF NEW.kind = 'assets' THEN
    SELECT EXISTS (
      SELECT 1 FROM pm_tasks t
        JOIN projects p ON p.id = t.project_id AND p.tenant_id = t.tenant_id
       WHERE t.id = NEW.pm_task_id AND t.tenant_id = NEW.tenant_id AND p.client_id = NEW.client_id
    ) INTO v_work;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM webdev_change_requests cr
       WHERE cr.id = NEW.change_request_id AND cr.tenant_id = NEW.tenant_id AND cr.client_id = NEW.client_id
         AND (cr.project_id IS NULL OR EXISTS (
               SELECT 1 FROM projects p
                WHERE p.id = cr.project_id AND p.tenant_id = cr.tenant_id AND p.client_id = NEW.client_id))
    ) INTO v_work;
  END IF;
  IF NOT v_work THEN
    RAISE EXCEPTION 'work_requests: the work item of a cross-company request must sit on the requesting company''s client record'
      USING ERRCODE = 'PD062';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_work_requests_route_guard ON work_requests;
CREATE TRIGGER trg_work_requests_route_guard
  BEFORE INSERT ON work_requests
  FOR EACH ROW EXECUTE FUNCTION work_requests_route_guard();

-- ── 7 · the freeze: BEFORE UPDATE ──────────────────────────────────────────────────────────────────────────────────────────
-- tenant_id and the five requester columns never change. On a cross row kind, to_unit_id and requested_by never change either.
-- Nothing in BFF §32 updates any of them (status, closure, decline reason and updated_at are the only writes).
CREATE OR REPLACE FUNCTION work_requests_freeze_requester() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.requester_tenant_id IS DISTINCT FROM OLD.requester_tenant_id
     OR NEW.requester_unit_id IS DISTINCT FROM OLD.requester_unit_id
     OR NEW.requester_unit_name IS DISTINCT FROM OLD.requester_unit_name
     OR NEW.service_assignment_id IS DISTINCT FROM OLD.service_assignment_id
     OR NEW.client_id IS DISTINCT FROM OLD.client_id THEN
    RAISE EXCEPTION 'work_requests: tenant_id, requester_tenant_id, requester_unit_id, requester_unit_name, service_assignment_id and client_id are immutable'
      USING ERRCODE = 'PD061';
  END IF;
  IF OLD.requester_tenant_id <> OLD.tenant_id
     AND (NEW.kind IS DISTINCT FROM OLD.kind
          OR NEW.to_unit_id IS DISTINCT FROM OLD.to_unit_id
          OR NEW.requested_by IS DISTINCT FROM OLD.requested_by) THEN
    RAISE EXCEPTION 'work_requests: kind, to_unit_id and requested_by of a cross-company request are immutable'
      USING ERRCODE = 'PD061';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_work_requests_freeze_requester ON work_requests;
CREATE TRIGGER trg_work_requests_freeze_requester
  BEFORE UPDATE ON work_requests
  FOR EACH ROW EXECUTE FUNCTION work_requests_freeze_requester();

-- ── 8 · work_request_client_intakes ────────────────────────────────────────────────────────────────────────────────────────
-- Each (department, client)'s "<Department> · Requests · <Client>" project at the receiving company. DEFERRED project FK: the
-- same first-request race as work_request_intakes (see 202610140600): mint the project id, INSERT the intake row ON CONFLICT DO
-- NOTHING, create the project only if that insert won; the FK is checked at COMMIT, when the winner has inserted the project.
-- Both FKs are the tenant-scoped composites, so another company's client or project cannot be named even by a bug.
CREATE TABLE IF NOT EXISTS work_request_client_intakes (
  tenant_id uuid NOT NULL REFERENCES companies(id),
  unit_id text NOT NULL CHECK (char_length(unit_id) > 0),
  client_id uuid NOT NULL,
  project_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, unit_id, client_id),
  CONSTRAINT fk_work_request_client_intakes_client_tenant FOREIGN KEY (client_id, tenant_id)
    REFERENCES clients (id, tenant_id),
  CONSTRAINT fk_work_request_client_intakes_project_tenant FOREIGN KEY (project_id, tenant_id)
    REFERENCES projects (id, tenant_id) DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE work_request_client_intakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_request_client_intakes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON work_request_client_intakes;
CREATE POLICY tenant_isolation ON work_request_client_intakes FOR ALL
  USING (tenant_id = ANY(app_current_tenants()))
  WITH CHECK (tenant_id = ANY(app_current_tenants()));

-- ── Assert, don't assume ───────────────────────────────────────────────────────────────────────────────────────────────────
-- Counts no rows (a count with no tenant set reads zero and lies): the catalog only.
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_name = 'work_requests'
     AND column_name IN ('requester_tenant_id', 'requester_unit_id', 'requester_unit_name', 'service_assignment_id', 'client_id');
  IF n <> 5 THEN
    RAISE EXCEPTION '202610160200: work_requests should carry its 5 new columns, found % of 5', n;
  END IF;

  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_name = 'work_requests' AND column_name = 'requester_tenant_id' AND is_nullable = 'NO';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610160200: work_requests.requester_tenant_id must be NOT NULL';
  END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'work_requests'::regclass AND conname = 'fk_work_requests_client_tenant' AND contype = 'f';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610160200: the composite client FK fk_work_requests_client_tenant is missing';
  END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'work_requests'::regclass AND contype = 'c'
     AND conname IN ('work_requests_requester_route_ck', 'work_requests_requester_client_ck', 'work_requests_requester_unit_ck',
                     'work_requests_across_from_ck', 'work_requests_across_part_ck');
  IF n <> 5 THEN
    RAISE EXCEPTION '202610160200: work_requests should carry its 5 requester CHECKs, found % of 5', n;
  END IF;

  SELECT count(*) INTO n FROM pg_indexes
   WHERE tablename = 'work_requests'
     AND indexname IN ('ix_work_requests_requester', 'ix_work_requests_requester_unit', 'ix_work_requests_service_assignment');
  IF n <> 3 THEN
    RAISE EXCEPTION '202610160200: the three requester indexes are missing (found % of 3)', n;
  END IF;

  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgrelid = 'work_requests'::regclass AND NOT tgisinternal
     AND tgname IN ('trg_work_requests_route_guard', 'trg_work_requests_freeze_requester');
  IF n <> 2 THEN
    RAISE EXCEPTION '202610160200: the route guard and the freeze triggers should both exist, found % of 2', n;
  END IF;

  SELECT count(*) INTO n FROM pg_class
   WHERE relname = 'work_request_client_intakes' AND relrowsecurity AND relforcerowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610160200: work_request_client_intakes must exist with RLS ENABLED and FORCED';
  END IF;

  SELECT count(*) INTO n FROM pg_policies
   WHERE tablename = 'work_request_client_intakes' AND policyname = 'tenant_isolation';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610160200: work_request_client_intakes needs exactly one tenant_isolation policy, found %', n;
  END IF;

  SELECT count(*) INTO n FROM pg_policies WHERE tablename = 'work_request_client_intakes';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610160200: work_request_client_intakes must carry exactly one policy, found %', n;
  END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conname = 'fk_work_request_client_intakes_project_tenant' AND condeferrable AND condeferred;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610160200: the client intake project FK must be DEFERRABLE INITIALLY DEFERRED (the first-request race depends on it)';
  END IF;
END $$;
