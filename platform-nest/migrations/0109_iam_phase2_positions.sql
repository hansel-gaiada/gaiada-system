-- 0109_iam_phase2_positions.sql — P2-01 (IAM Phase 2 foundation ticket): the schema for
-- employees, positions, position role-set templates, position assignments, and the position
-- reconciler's refcounting claims table, plus the new provenance columns on `user_roles`.
--
-- Design: docs/superpowers/plans/2026-08-13-iam-phase2-design.md — §2 (the data model), §2.3 (the
-- position_roles guard trigger), §11 (deferred legal/PII work). This migration is SCHEMA ONLY: no
-- Cerbos policy, no controller, no reconciler code lands here (that is P2-02..05). Nothing in this
-- file reads or writes an existing row on any pre-existing table other than the additive ALTER on
-- `user_roles` (three new nullable columns + one CHECK) — zero backfill DML anywhere.
--
-- ── NUMBERING (migrations/README.md rule 5) ────────────────────────────────────────────────────
-- `ls migrations | sort | tail` immediately before writing this file showed the real head as
-- `0108_iam_gap_02_invoice_self_approval_deny_and_revisions.sql` with `0109` genuinely free — this
-- ticket's own brief warned the head "moved twice today", so it was re-checked at the moment of
-- writing, not trusted from docs/MAP.md's snapshot. `0058`/`0059`/`0070` remain the permanently
-- orphaned reservation gaps from earlier programs — not touched, not filled.
--
-- ── THE RLS WALLS (design §2 preamble) ─────────────────────────────────────────────────────────
-- `employees` sits behind the HR module's THIRD wall — `tenant_id = ANY(app_current_tenants()) AND
-- app_module_allowed('hr')` — the exact composed predicate 0028/0081 use for every hr_* table.
-- `positions` / `position_roles` / `position_assignments` / `position_grant_claims` are CORE
-- (design §2 preamble: "the reconciler, the dept-head surface, and admin flows read them
-- platform-wide") — the PLAIN `tenant_id = ANY(app_current_tenants())` wall, the same shape
-- `org_units` (0026) / `org_unit_memberships` (0055) / `org_unit_closure` (0101) use. Getting this
-- backwards either hides HR employee data from a served company's HR staff (wrong wall on
-- employees) or fails to isolate a position by tenant at all (missing wall on the core tables) —
-- both are wrong in different directions, so each table's wall is called out explicitly below
-- rather than looped generically the way 0093's hr_* block does (that DO-loop convenience would
-- have hidden the fact that `employees` needs a DIFFERENT predicate than its three siblings).
--
-- ── PD (personal-data) MARKER — LABEL ONLY (design §11, owner decision 2026-08-13) ────────────────
-- Per the owner's explicit build-speed decision ("no real employee and only me, the data are all
-- mock anyway"), legal/PII work (crypto-shred, PAN/national-ID scrubbing, DPIA/consent/retention)
-- is DEFERRED — NOT built, NOT stubbed, NOT ticketed here. Each column that would carry personal
-- data in a real deployment is marked with a `COMMENT ON COLUMN ... IS 'PD — ...'` below so the
-- retrofit is a grep, not an audit. This is a documentation label; it changes no runtime behavior.
--
-- ── COMPOSITE TENANT-SCOPED FKs (0075 §0 / 0090 precedent) ─────────────────────────────────────
-- `positions` and `position_assignments` each carry `UNIQUE (id, tenant_id)` so every child FK
-- into them is the two-column composite form (`FOREIGN KEY (child_fk, tenant_id) REFERENCES
-- parent (id, tenant_id)`), not a plain single-column FK — an FK check runs as the table owner,
-- OUTSIDE RLS, so the composite form is what actually stops a cross-tenant reference at the
-- constraint layer instead of relying on RLS alone. `employees` and `user_roles.managed_by_position`
-- are the two exceptions, both precedented: `employees` has no tenant-scoped child in this file, and
-- `user_roles` (global, no `tenant_id` column of its own — 0001) cannot form a composite FK any more
-- than `user_roles.managed_by → service_assignments(id)` (0026) could; both are plain single-column
-- FKs for the same structural reason.
--
-- ── THE §2.3 GUARD TRIGGER — WHAT IT ENFORCES NOW, AND WHAT IS DEFERRED TO P2-03 ────────────────
-- The design's trigger has three clauses: (a) a denied-role registry, (b) a ui_grantable bundle
-- check, (c) a scope-shape check. (a) and (c) are implemented below. (b) is DEFERRED: it reads
-- `permissions.ui_grantable`, a column P2-03 owns (§7) — this ticket is explicitly SCOPE: schema
-- only for employees/positions/*, and explicitly forbidden from touching the permission catalog
-- ("Do NOT touch ... the permission catalog — those are P2-02/03/04's tickets and would collide").
-- Adding `ui_grantable` here to satisfy (b) would be exactly that collision. `position_roles_guard()`
-- is a `CREATE OR REPLACE FUNCTION` on a named trigger — P2-03 extends it in place (no migration
-- renumbering, no new trigger) the moment the column exists. Recorded here, not silently dropped;
-- restated in the P2-01 report.
--
-- (c)'s scope-shape check hand-mirrors `src/rbac/scope-constrained-roles.json` (IAM-SEC-06) AS OF
-- 2026-08-13, because Postgres cannot import that generated JSON. This is a deliberate, FLAGGED
-- duplication seam, not an oversight — if `derived_roles.yaml`'s scope conditions ever change, this
-- CASE block must be hand-updated in a follow-up migration (`CREATE OR REPLACE FUNCTION`, same
-- pattern as the (b) extension). Only entries relevant to position_roles' two possible scope_kinds
-- (`company`→scope_type `company`, `own_unit`→scope_type `org_unit`) matter in practice; the design's
-- own example (`org_unit_lead` only valid at `own_unit`) is the one this phase actually exercises.
--
-- ── ZERO BACKFILL DML ───────────────────────────────────────────────────────────────────────────
-- Every table below is CREATE TABLE, brand new. The only touch of a pre-existing table is the
-- additive `ALTER TABLE user_roles ADD COLUMN ...` (three nullable columns, one CHECK over the two
-- new/existing marker columns) — no UPDATE, no DELETE, no INSERT ... SELECT anywhere in this file.
-- `npm run lint:migration-rls` has nothing to flag here by construction; existing `user_roles` rows
-- are altered in shape (three new NULL columns) but not in VALUE — verified by an exact row-count
-- and content assertion in the test suite (P2-01 report).

-- btree_gist: already installed by 0055; `CREATE EXTENSION IF NOT EXISTS` is idempotent and cheap
-- to restate (0063's precedent) — needed here for position_assignments' GiST EXCLUDE constraint.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ═══════════════════════════ (1) employees — the HR people file (D-4) ═══════════════════════════
CREATE TABLE employees (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES companies(id),   -- the EMPLOYING company; one row per person PER company
  user_id           uuid REFERENCES users(id),                -- 0..1: a `pending_start` candidate may have no principal yet
  display_name      text NOT NULL,
  legal_name        text,
  work_email        text,                                     -- mirror of users.email once linked; not a source of truth
  personal_email    text,
  phone             text,
  hire_date         date,
  employment_status text NOT NULL DEFAULT 'active'
                      CHECK (employment_status IN ('pending_start','active','on_leave','terminated')),
  terminated_at     timestamptz,
  -- Explicit reporting-line OVERRIDE only. The DEFAULT reporting line is the org chart (nearest
  -- ancestor unit's lead position holder) — deliberately NOT duplicated here (design §2.1).
  manager_user_id   uuid REFERENCES users(id),
  notes             text,
  origin_site       text NOT NULL DEFAULT 'central',
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);

-- Partial unique: a plain UNIQUE (tenant_id, user_id) never fires while user_id IS NULL (SQL NULLs
-- are distinct), which would let a company seed 2+ `pending_start` rows and ALSO 2+ linked rows for
-- the SAME user silently — the [null-defeats-unique-constraints] trap. Scoped to non-NULL only.
CREATE UNIQUE INDEX ux_employees_tenant_user ON employees (tenant_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX ix_employees_tenant_status ON employees (tenant_id, employment_status) WHERE deleted_at IS NULL;

COMMENT ON TABLE employees IS
  'IAM Phase 2 (P2-01) — HR-owned people file. One row per person PER employing company (holding-OS '
  'reality: two group companies = two employee rows). May exist with NO users row (pending_start). '
  'HR wall RLS: tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''hr''). PD columns are '
  'labeled per-column (design §11) — no encryption/scrubbing this wave, owner decision 2026-08-13.';
COMMENT ON COLUMN employees.display_name   IS 'PD — personal data marker (label only, no encryption/scrubbing this wave; design §11).';
COMMENT ON COLUMN employees.legal_name     IS 'PD — personal data marker (label only, no encryption/scrubbing this wave; design §11).';
COMMENT ON COLUMN employees.work_email     IS 'PD — personal data marker (label only, no encryption/scrubbing this wave; design §11).';
COMMENT ON COLUMN employees.personal_email IS 'PD — personal data marker (label only, no encryption/scrubbing this wave; design §11).';
COMMENT ON COLUMN employees.phone          IS 'PD — personal data marker (label only, no encryption/scrubbing this wave; design §11).';
COMMENT ON COLUMN employees.notes          IS 'PD — personal data marker (label only, no encryption/scrubbing this wave; design §11).';

ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON employees FOR ALL
  USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('hr'))
  WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('hr'));

-- ═══════════════════════════════ (2) positions — the seat (design §2.2) ═════════════════════════
CREATE TABLE positions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES companies(id),
  -- Org-blob node id ('d-web' convention, 0029 ruling: node ids are not a database table). Free
  -- text, NO FK — same posture as org_unit_memberships.unit_node_id (0055) / org_units.node_id (0026).
  unit_node_id text NOT NULL CHECK (length(unit_node_id) > 0),
  title        text NOT NULL,
  -- Display + backfill convenience ONLY — confers nothing by itself. Lead authority comes from the
  -- role SET (an org_unit_lead @ own_unit entry in position_roles) — exactly one grant mechanism
  -- (design §2.2). A position with is_lead=true and no org_unit_lead role row confers no lead power.
  is_lead      boolean NOT NULL DEFAULT false,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired','orphaned')),
  headcount    int CHECK (headcount IS NULL OR headcount >= 0),   -- soft target, display only
  origin_site  text NOT NULL DEFAULT 'central',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- Composite-FK anchor for position_roles/position_assignments below (0075 §0 / 0090 precedent).
  CONSTRAINT ux_positions_id_tenant UNIQUE (id, tenant_id)
);
CREATE INDEX ix_positions_tenant_unit ON positions (tenant_id, unit_node_id) WHERE status = 'active';

COMMENT ON TABLE positions IS
  'IAM Phase 2 (P2-01) — an org-chart seat: (tenant, org-unit node, title, is_lead, role-set '
  'template). Pure provisioning data; Cerbos/RLS never learn positions exist (design §1). Retire via '
  'status; rows are never deleted. CORE table (plain tenant_isolation, NOT module-gated) — the '
  'reconciler/dept-head surface/admin flows read platform-wide (design §2 preamble).';

ALTER TABLE positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE positions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON positions FOR ALL
  USING (tenant_id = ANY(app_current_tenants()))
  WITH CHECK (tenant_id = ANY(app_current_tenants()));

-- ═════════════════════════ (3) position_roles — the role-set template (design §2.3) ═════════════
CREATE TABLE position_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES companies(id),
  position_id uuid NOT NULL,
  role_id     uuid NOT NULL REFERENCES roles(id),
  -- Resolved at materialization time by the (not-yet-built) reconciler: 'company' -> (company,
  -- tenant_id); 'own_unit' -> (org_unit, position.unit_node_id). No 'global' option, STRUCTURALLY —
  -- this CHECK is the entire enforcement of "a position can never confer platform tier" (design §2.3).
  scope_kind  text NOT NULL DEFAULT 'company' CHECK (scope_kind IN ('company','own_unit')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_position_roles_position_tenant FOREIGN KEY (position_id, tenant_id)
    REFERENCES positions (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT ux_position_roles UNIQUE (position_id, role_id, scope_kind)
);

COMMENT ON TABLE position_roles IS
  'IAM Phase 2 (P2-01) — a position''s role-set template: which roles, at which scope_kind, a '
  'holder of this seat is entitled to (materialized by the not-yet-built position reconciler, P2-05, '
  'into ordinary user_roles grants). Guarded by trg_position_roles_guard (see position_roles_guard()) '
  '— denied-role registry + scope-shape check now; the ui_grantable bundle check is P2-03''s to add.';

ALTER TABLE position_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE position_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON position_roles FOR ALL
  USING (tenant_id = ANY(app_current_tenants()))
  WITH CHECK (tenant_id = ANY(app_current_tenants()));

-- ── The §2.3 structural allow-list backstop trigger ──────────────────────────────────────────────
-- Fires on INSERT and UPDATE (an UPDATE could re-point role_id or scope_kind onto a now-denied
-- pairing). See the file header for exactly what is enforced now vs. deferred to P2-03.
CREATE OR REPLACE FUNCTION position_roles_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  rname     text;
  reachable text[];
BEGIN
  SELECT name INTO rname FROM roles WHERE id = NEW.role_id;
  IF rname IS NULL THEN
    RAISE EXCEPTION 'position_roles: role_id % does not resolve to a roles row', NEW.role_id;
  END IF;

  -- (a) denied-role registry (design §2.3): these tiers can NEVER be attached to a position, at any
  -- scope_kind. 'owner' does not exist as a roles row yet (Phase 3) — matched by NAME, not
  -- existence, so it is caught automatically the moment it is seeded, with no trigger edit needed.
  IF rname = ANY (ARRAY['platform_admin','group_executive','client','owner']) THEN
    RAISE EXCEPTION
      'position_roles: role "%" is in the denied-role registry and can never be attached to a '
      'position (IAM Phase 2 design §2.3/§6.3.6 — the elevated fence)', rname;
  END IF;

  -- (c) scope-shape check — hand-mirrors src/rbac/scope-constrained-roles.json AS OF 2026-08-13
  -- (see file header: Postgres cannot import the generated JSON, so this is a flagged, hand-synced
  -- duplication seam). scope_kind='company' materializes at scope_type='company'; scope_kind=
  -- 'own_unit' materializes at scope_type='org_unit'. A role ABSENT from this map is UNCONSTRAINED
  -- (fail-open — same semantics as isGrantScopeReachable()); most roles fall here by design.
  reachable := CASE rname
    WHEN 'org_unit_lead' THEN ARRAY['org_unit']
    WHEN 'company_admin' THEN ARRAY['company','global']
    WHEN 'hr_manager'    THEN ARRAY['company','global']
    WHEN 'hr_staff'      THEN ARRAY['company','global']
    WHEN 'it'            THEN ARRAY['company','global']
    WHEN 'it_admin'      THEN ARRAY['company','global']
    WHEN 'it_manager'    THEN ARRAY['company','global']
    WHEN 'manager'       THEN ARRAY['company','global','project']
    WHEN 'member'        THEN ARRAY['company','global','project']
    WHEN 'viewer'        THEN ARRAY['company','global']
    ELSE NULL
  END;

  IF reachable IS NOT NULL THEN
    IF NEW.scope_kind = 'own_unit' AND NOT ('org_unit' = ANY (reachable)) THEN
      RAISE EXCEPTION
        'position_roles: role "%" cannot be attached at scope_kind=own_unit -- its own Cerbos '
        'condition never reaches org_unit scope (scope-constrained-roles.json)', rname;
    END IF;
    IF NEW.scope_kind = 'company' AND NOT ('company' = ANY (reachable)) THEN
      RAISE EXCEPTION
        'position_roles: role "%" cannot be attached at scope_kind=company -- its own Cerbos '
        'condition never reaches company scope (scope-constrained-roles.json)', rname;
    END IF;
  END IF;

  -- (b) ui_grantable bundle check: DEFERRED to P2-03 — see file header. `permissions.ui_grantable`
  -- does not exist yet; P2-03 must CREATE OR REPLACE this function to add it (same trigger, no
  -- migration-number churn).

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_position_roles_guard ON position_roles;
CREATE TRIGGER trg_position_roles_guard
  BEFORE INSERT OR UPDATE ON position_roles
  FOR EACH ROW EXECUTE FUNCTION position_roles_guard();

-- ═══════════════════ (4) position_assignments — who holds the seat (design §2.4) ════════════════
-- Mirrors org_unit_memberships' (0055) proven temporal + GiST shape.
CREATE TABLE position_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES companies(id),
  position_id uuid NOT NULL,
  -- `users`, NOT `employees` — so bot/agent principals (ordinary users rows by design,
  -- [principal-kinds]) can hold seats; human employees link via employees.user_id (design §2.4).
  user_id     uuid NOT NULL REFERENCES users(id),
  valid_from  date NOT NULL DEFAULT current_date,
  valid_to    date,                                   -- NULL = current
  assigned_by uuid REFERENCES users(id),
  reason      text,
  origin_site text NOT NULL DEFAULT 'central',
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_position_assignments_position_tenant FOREIGN KEY (position_id, tenant_id)
    REFERENCES positions (id, tenant_id),
  CONSTRAINT position_assignments_valid_range CHECK (valid_to IS NULL OR valid_to >= valid_from),
  -- Composite-FK anchor for position_grant_claims below.
  CONSTRAINT ux_position_assignments_id_tenant UNIQUE (id, tenant_id),
  -- No overlapping duplicate of the SAME seat by the SAME person, from ANY session — including a
  -- future bug in the (not-yet-built) reconciler. Plurality ACROSS DIFFERENT positions is allowed
  -- (design §2.4 / owner decision Q3: a person may hold multiple concurrent positions) — this
  -- constraint deliberately does NOT include an is_primary axis (no such column exists; "the
  -- primary position" is a FUTURE users.title-mirror display concept per design §1/§12 Q6, not a
  -- DB constraint this phase enforces — see the P2-01 report for the explicit call-out).
  CONSTRAINT position_assignments_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, position_id WITH =, user_id WITH =,
    daterange(valid_from, COALESCE(valid_to, '9999-12-31'::date), '[]') WITH &&
  )
);
-- As-of resolution ("this person's active seats as of date D") — mirrors 0055's ix_oum_asof.
CREATE INDEX ix_position_assignments_asof ON position_assignments (tenant_id, user_id, valid_from, valid_to);
-- "Who currently holds this seat" — the reconciler's desired-state read.
CREATE INDEX ix_position_assignments_position ON position_assignments (tenant_id, position_id) WHERE valid_to IS NULL;

COMMENT ON TABLE position_assignments IS
  'IAM Phase 2 (P2-01) — temporal (person, position) placement. valid_to IS NULL = currently active. '
  'EXCLUDE-enforced: no overlapping duplicate assignment of the SAME seat to the SAME person; plural '
  'CONCURRENT positions for one person across DIFFERENT seats are allowed by design (union semantics, '
  'owner decision Q3). user_id references users (not employees) so bot/agent principals can hold seats.';

ALTER TABLE position_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE position_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON position_assignments FOR ALL
  USING (tenant_id = ANY(app_current_tenants()))
  WITH CHECK (tenant_id = ANY(app_current_tenants()));

-- ═══════════════ (5) position_grant_claims — the refcount (design §2.6) ═════════════════════════
-- Byte-pattern copy of service_grant_claims (0026), with position_assignment_id in place of
-- assignment_id — same num_nonnulls=1 CHECK, same PARTIAL uniques (a plain UNIQUE would let NULLs
-- corrupt the refcount, [null-defeats-unique-constraints]). Kept as a SEPARATE table from
-- service_grant_claims on purpose (design §2.6): each reconciler owns its claims outright.
CREATE TABLE position_grant_claims (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES companies(id),
  position_assignment_id uuid NOT NULL,
  membership_id          uuid REFERENCES company_memberships(id),
  user_role_id           uuid REFERENCES user_roles(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_pgc_assignment_tenant FOREIGN KEY (position_assignment_id, tenant_id)
    REFERENCES position_assignments (id, tenant_id),
  CHECK (num_nonnulls(membership_id, user_role_id) = 1)
);
CREATE UNIQUE INDEX ux_pgc_membership ON position_grant_claims(position_assignment_id, membership_id)
  WHERE membership_id IS NOT NULL;
CREATE UNIQUE INDEX ux_pgc_user_role ON position_grant_claims(position_assignment_id, user_role_id)
  WHERE user_role_id IS NOT NULL;
CREATE INDEX ix_pgc_membership ON position_grant_claims(membership_id) WHERE membership_id IS NOT NULL;
CREATE INDEX ix_pgc_user_role ON position_grant_claims(user_role_id) WHERE user_role_id IS NOT NULL;
CREATE INDEX ix_pgc_assignment ON position_grant_claims(position_assignment_id);

COMMENT ON TABLE position_grant_claims IS
  'IAM Phase 2 (P2-01) — A2 refcounting junction for the position reconciler (P2-05, not yet '
  'built): each row = "position_assignment X is one reason user_role/membership artifact A exists". '
  'Byte-pattern copy of service_grant_claims (0026) — SEPARATE table on purpose so the position and '
  'service reconcilers each own their own claims outright (design §2.6).';

ALTER TABLE position_grant_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE position_grant_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON position_grant_claims FOR ALL
  USING (tenant_id = ANY(app_current_tenants()))
  WITH CHECK (tenant_id = ANY(app_current_tenants()));

-- ═══════════════ (6) user_roles — additive provenance columns (design §2.5) ═════════════════════
-- `managed_by` (0026) is a TYPED FK to service_assignments and cannot be reused for positions — a
-- separate marker column + a separate claims table (above), per the design's explicit ruling.
ALTER TABLE user_roles
  ADD COLUMN managed_by_position uuid REFERENCES position_assignments(id),
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN origin_approval_id uuid REFERENCES automation_approvals(id);

-- "Reconciler-owned" becomes managed_by IS NOT NULL OR managed_by_position IS NOT NULL; a single
-- grant row can never be claimed by BOTH reconcilers at once (design §2.5) — enforced structurally,
-- not by convention, so a future bug in either reconciler cannot double-own one row.
ALTER TABLE user_roles
  ADD CONSTRAINT user_roles_managed_by_position_exclusive
    CHECK (NOT (managed_by IS NOT NULL AND managed_by_position IS NOT NULL));

CREATE INDEX ix_user_roles_managed_by_position ON user_roles(managed_by_position) WHERE managed_by_position IS NOT NULL;
CREATE INDEX ix_user_roles_expires_at ON user_roles(expires_at) WHERE expires_at IS NOT NULL;

COMMENT ON COLUMN user_roles.managed_by_position IS
  'IAM Phase 2 (P2-01) — the position reconciler''s marker (design §2.5), mirrors managed_by''s role '
  'for service_assignments. Mutually exclusive with managed_by (user_roles_managed_by_position_exclusive).';
COMMENT ON COLUMN user_roles.expires_at IS
  'IAM Phase 2 (P2-01) — time-boxed override grant expiry (D-10). Swept by the (not-yet-built) '
  'expiry sweep (design §3.4); NULL = no expiry.';
COMMENT ON COLUMN user_roles.origin_approval_id IS
  'IAM Phase 2 (P2-01) — the automation_approvals row that authorized an override grant (design §6.5).';
