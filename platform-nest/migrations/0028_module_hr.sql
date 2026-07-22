-- WS-D / WSD-3 — HR module ('hr') schema + THE THIRD RLS WALL (module-sliced RLS).
--
-- Implements docs/superpowers/specs/2026-07-20-hr-module-design.md §3 (the six HR tables) and §2.4
-- (the module-sliced RLS wall). Six tenant-scoped tables, each `tenant_id` = the SERVED company,
-- FORCE RLS, and ONE `tenant_isolation` policy per table composed from the 0025 helper
-- app_current_tenants() AND the new app_module_allowed('hr') — the third, in-DB wall.
--
-- ── THE THIRD WALL (§2.4), and a DELIBERATE, FLAGGED semantics choice ──────────────────────────────
-- Walls 1 & 2 (Cerbos derived roles + the ORG-3 withTenants choke-point) gate WHO and WHICH TENANT.
-- The third wall answers a different question: "did this request DECLARE that it is operating inside
-- the hr module scope?" It is a fail-closed, in-process defense — any code path that reaches an hr_*
-- table WITHOUT declaring the hr module scope reads/writes ZERO rows, even with a correct tenant set
-- and even if Cerbos/choke-point were bypassed in-process (design §5 beat 7).
--
-- The scope is carried in a SECOND GUC, `app.scopes` (CSV of the module keys authorized for THIS
-- request), set alongside `app.current_tenant_ids` by withTenants(tenants, {modules:['hr']}). That
-- app-side setter is WSD-4 wiring (ORG-3's withTenants overload); this migration defines the DB-side
-- predicate that consumes it. Until WSD-4 wires it, a plain withTenants([t]) call sets no hr scope →
-- hr tables read zero rows (fail-closed by design). The RLS suite here sets `app.scopes` directly to
-- prove the wall in isolation.
--
-- >>> DEVIATION FROM THE WSD-3 TICKET PROSE (flagged for orchestrator ratification): the ticket text
--     described app_module_allowed as reading `companies.enabled_modules` for the row's own tenant.
--     That is NOT what the authoritative design specifies (§2.4 = the app.scopes GUC), and it would
--     BREAK the shared-service model: a SERVED company (design §5 — B/C receive 'hr' ONLY via an
--     active service_assignment, NEVER in their enabled_modules array) would then have its HR data
--     hidden from the very staff serving it. Enablement (enabled_modules OR active assignment) is
--     wall 1, computed app-side by isModuleEnabled()/ModuleEnabledGuard (design §4, WSD-4). The
--     module-sliced RLS wall is a SEPARATE, scope-declaration wall. This migration implements the
--     design (GUC), matching the design's own WSD-3 "done when" ("right-tenant + module-scope → rows;
--     right-tenant WITHOUT module scope → zero"). See the completion report for the full rationale.
--
-- Conventions: origin_site default 'central'; soft-delete deleted_at where applicable; timestamps.
-- Runtime DML grants come from the owner's ALTER DEFAULT PRIVILEGES + the external RUNTIME_GRANTS_SQL
-- pass (README) — no in-migration GRANTs, and NO sync_app grants (hr tables do not sync in v1).
-- Additive; the automation_approvals origin widening is the only non-CREATE change (widen-only, safe
-- on live data — see rollout note in the report).

-- ══ app_module_allowed(mod): the third-wall predicate (§2.4). Mirrors the app_current_tenants()
--    shape from 0025 — LANGUAGE sql STABLE PARALLEL SAFE so it inlines into the policy and is
--    evaluated once per scan, not per row. Empty/unset GUC → NULL → `= ANY(NULL)` → false
--    (fail-closed). EXECUTE to PUBLIC so every runtime role can evaluate it inside its own RLS check.
CREATE OR REPLACE FUNCTION app_module_allowed(mod text) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$
    SELECT mod = ANY(string_to_array(NULLIF(current_setting('app.scopes', true), ''), ','))
  $$;
COMMENT ON FUNCTION app_module_allowed(text) IS
  'The third RLS wall (HR design §2.4): true iff `mod` is in the request-declared module-scope set '
  '(the app.scopes GUC, CSV, set by withTenants(...,{modules})). Empty/unset -> false (fail-closed). '
  'Composed into every hr_* tenant_isolation policy alongside app_current_tenants().';
GRANT EXECUTE ON FUNCTION app_module_allowed(text) TO PUBLIC;

-- ══ (1) hr_cases — generic container: onboarding|offboarding|review|grievance|other.
CREATE TABLE hr_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),          -- the SERVED company (data never re-homes)
  subject_user_id uuid REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('onboarding','offboarding','review','grievance','other')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','cancelled')),
  title text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',      -- checklist {items:[{label,done,doneBy,doneAt}]} / review {period,goals,outcome}
  custom jsonb NOT NULL DEFAULT '{}',       -- D17 custom fields
  created_by uuid NOT NULL REFERENCES users(id),
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX ix_hr_cases_subject ON hr_cases(tenant_id, subject_user_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_hr_cases_kind ON hr_cases(tenant_id, kind, status) WHERE deleted_at IS NULL;

-- ══ (2) hr_records — contract|document|note references per subject.
CREATE TABLE hr_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  subject_user_id uuid NOT NULL REFERENCES users(id),
  record_type text NOT NULL CHECK (record_type IN ('contract','document','note')),
  data jsonb NOT NULL DEFAULT '{}',
  file_id uuid REFERENCES files(id),        -- same-tenant file (RLS makes cross-tenant refs unreadable)
  created_by uuid NOT NULL REFERENCES users(id),
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX ix_hr_records_subject ON hr_records(tenant_id, subject_user_id, record_type) WHERE deleted_at IS NULL;

-- ══ (3) hr_leave_requests — vacation|sick|unpaid|other; day/half-day as minutes; approval via inbox.
CREATE TABLE hr_leave_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  subject_user_id uuid NOT NULL REFERENCES users(id),
  leave_type text NOT NULL CHECK (leave_type IN ('vacation','sick','unpaid','other')),
  starts_on date NOT NULL,
  ends_on date NOT NULL CHECK (ends_on >= starts_on),
  minutes int NOT NULL CHECK (minutes > 0),            -- canonical unit (day = 480 by convention)
  note text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','denied','cancelled')),
  approval_id uuid,                                    -- automation_approvals row (origin='hr')
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX ix_hr_leave_subject ON hr_leave_requests(tenant_id, subject_user_id, starts_on);

-- ══ (4) hr_leave_balances — per subject/year/type; used_minutes moves on APPROVAL (see design §3).
CREATE TABLE hr_leave_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  subject_user_id uuid NOT NULL REFERENCES users(id),
  year int NOT NULL,
  leave_type text NOT NULL CHECK (leave_type IN ('vacation','sick','unpaid','other')),
  allocated_minutes int NOT NULL DEFAULT 0,
  used_minutes int NOT NULL DEFAULT 0 CHECK (used_minutes >= 0),
  UNIQUE (tenant_id, subject_user_id, year, leave_type)
);

-- ══ (5) hr_attendance — lightweight per-day log; one row per subject/day.
CREATE TABLE hr_attendance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  subject_user_id uuid NOT NULL REFERENCES users(id),
  day date NOT NULL,
  status text NOT NULL CHECK (status IN ('present','remote','absent','leave')),
  note text,
  recorded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, subject_user_id, day)
);

-- ══ (6) hr_checklist_templates — tenant-scoped onboarding/offboarding templates → instantiated as
--        hr_cases with the checklist in details (design §1).
CREATE TABLE hr_checklist_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  kind text NOT NULL CHECK (kind IN ('onboarding','offboarding')),
  name text NOT NULL,
  items jsonb NOT NULL DEFAULT '[]',        -- [{label}]
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- ══ FORCE RLS + the ONE composed tenant_isolation policy per hr_* table (§2.4). Written once in a
--    DO loop so the third-wall predicate can never drift per-table — every hr_* table gets the
--    byte-identical `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('hr')`, on BOTH
--    USING (reads) and WITH CHECK (writes: you cannot INSERT an hr row without declaring hr scope).
--    Each table has a tenant_id column, so the rls.test.ts FORCE-RLS sweep covers all six for free.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'hr_cases','hr_records','hr_leave_requests','hr_leave_balances','hr_attendance','hr_checklist_templates'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''hr''))
         WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''hr''))',
      t
    );
  END LOOP;
END $$;

-- ══ Unified approvals surface learns the 'hr' origin (design §3). Widen-only: drop whatever CHECK
--    currently constrains origin (0016 added it as the auto-named automation_approvals_origin_check),
--    re-add including 'hr'. Robust to the constraint name + idempotent on re-run.
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
   WHERE conrelid = 'automation_approvals'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%origin%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE automation_approvals DROP CONSTRAINT %I', cname);
  END IF;
END $$;
ALTER TABLE automation_approvals
  ADD CONSTRAINT automation_approvals_origin_check CHECK (origin IN ('automation','agent','hr'));
