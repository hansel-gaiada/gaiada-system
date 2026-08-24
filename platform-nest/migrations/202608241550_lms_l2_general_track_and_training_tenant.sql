-- LMS wave L2 — the mandatory general track, and the TRAINING TENANT it is practised in.
--
-- Design: docs/blueprints/lms-foundation.md §4 (the general track) and §9 (disposal by RESET, not
-- by delete). Owner decision 2026-08-24: "need to isolate the training. so it really use the live
-- version, but delete when finish." — resolved as a real company inside the live ERP, reset to a
-- known baseline between cohorts.
--
-- ── WHY RESET AND NOT DELETE, IN THE SCHEMA RATHER THAN ONLY IN A DOC ─────────────────────────
-- 186 tables carry `tenant_id` and the estate has no hard-delete path for a company. A cascade
-- across 186 FK-linked tables, written new and run against the production database, is the single
-- highest-risk operation this programme could contain — and the learning outcome is identical
-- either way. So the disposal surface is an EXPLICIT ALLOW-LIST of tables the exercises write
-- (`lms_training_reset_tables`), and the runner reads it rather than deriving "everything with
-- this tenant_id". Derivation is the 186-table cascade wearing a different hat: it looks bounded
-- today and silently grows teeth the next time a module adds a table.
--
-- The allow-list is DATA, not code, for one reason worth stating: adding a table to a reset is a
-- decision somebody should have to make and record, and a code constant makes it a diff nobody
-- reviews as a deletion.
--
-- ── AND WHY THE TENANT ID IS NEVER PASSED IN ──────────────────────────────────────────────────
-- `companies.is_training` is the ONLY way the runner learns what to clear, and a partial unique
-- index makes at most one company hold it. A reset that accepts an arbitrary tenant id is one
-- typo from clearing a real company; there is no safe amount of care that fixes an interface
-- shaped like that.
--
-- ── THE MODULE THIRD WALL ─────────────────────────────────────────────────────────────────────
-- The three new lms_* tables compose the byte-identical predicate 0028 established, `lms` in place
-- of `hr`:  `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('lms')`. Omit
-- `{ modules: ["lms"] }` at a call site and they read and write ZERO rows with no error.
-- ⚠ app_module_allowed returns **NULL**, not false, on an unset GUC (the 202608240140 correction).
--   Fail-closed inside a policy; outside one, test `IS NOT TRUE`, never `= false`.
--
-- `companies.is_training` and `lms_training_reset_tables` are deliberately NOT module-scoped:
-- `companies` is a core table, and the allow-list is global infrastructure that must stay readable
-- while deciding whether a reset may run at all — including from a context that holds no `lms`
-- scope. Neither carries tenant data.
--
-- Additive throughout. No DELETE and no destructive UPDATE anywhere in this file; the only UPDATE
-- is the idempotent allow-list upsert at the end.

-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- (1) companies.is_training — the flag the whole disposal mechanism resolves from.
-- ══════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE companies ADD COLUMN IF NOT EXISTS is_training boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN companies.is_training IS
  'TRUE for the single LMS training tenant: a real company inside the live ERP, staffed with fake '
  'people, used as the lab for ERP-usage training so exercises are verified against real rows. '
  'It is the ONLY input to the reset runner — the tenant id is never passed in. Rollups and '
  'cross-company reporting must EXCLUDE it, or its fake headcount lands in a real report.';

-- At most ONE training company, ever. "The" training tenant has to be unambiguous: with two, the
-- reset runner either picks one arbitrarily or clears both, and neither is a behaviour anybody
-- would choose deliberately. `((true))` is the idiom for a whole-table singleton under a WHERE.
CREATE UNIQUE INDEX IF NOT EXISTS ux_companies_one_training
  ON companies ((true)) WHERE is_training AND deleted_at IS NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- (2) lms_training_reset_tables — the ALLOW-LIST. The bound on what a reset may touch.
--
-- Global (no tenant_id): this describes the SHAPE of a reset, not any company's data. It is
-- readable without the `lms` module scope on purpose — a caller must be able to ask "what would
-- this clear" before it is authorized to clear anything.
-- ══════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS lms_training_reset_tables (
  table_name    text PRIMARY KEY,
  -- Which module's scope must be open for the delete to see any rows. NULL for a core table with
  -- no third-wall predicate. Getting this wrong is silent: the delete runs, matches zero rows, and
  -- reports success — the RLS zero-row trap, which is why the runner asserts a scope per table
  -- rather than opening one broad scope and hoping.
  module_scope  text,
  -- Why this table is in the blast radius. Required: an allow-list entry with no stated reason is
  -- how a table that should never have been cleared stays in the list through three reviews.
  rationale     text NOT NULL CHECK (length(rationale) > 0),
  -- Ordering for the delete, so a child is cleared before its parent and no FK aborts the run
  -- mid-way. Lower runs first.
  delete_order  int NOT NULL DEFAULT 100,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE lms_training_reset_tables IS
  'The EXPLICIT allow-list of tables the training-tenant reset may clear. Data rather than a code '
  'constant so adding a table is a decision somebody records with a rationale, not a diff nobody '
  'reviews as a deletion. The runner NEVER derives this set from information_schema.';

-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- (3) lms_cohorts / lms_cohort_members — who is in the training tenant right now.
--
-- A NEW table rather than a reuse of `hr_review_cycles` (settled 2026-08-24, blueprint §10): a
-- review cycle carries an outcome and an appraisal link a training cohort does not, and overloading
-- it makes both harder to read.
-- ══════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS lms_cohorts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES companies(id),
  cohort_key   text NOT NULL CHECK (length(cohort_key) > 0),
  title        text NOT NULL,
  -- The path this cohort is running. NULL for a general-purpose sandbox cohort.
  path_id      uuid,
  -- open      — accepting members, tenant not yet handed out
  -- running   — members hold real grants in the training tenant RIGHT NOW
  -- closed    — nobody should still be working; awaiting reset
  -- reset     — grants revoked, allow-listed tables cleared, baseline re-seeded
  status       text NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','running','closed','reset')),
  opened_at    timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  closed_at    timestamptz,
  reset_at     timestamptz,
  created_by   uuid REFERENCES users(id),
  origin_site  text NOT NULL DEFAULT 'central',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (path_id, tenant_id) REFERENCES lms_paths (id, tenant_id),
  -- A cohort is reset only after it is closed, and the timestamps must agree with the status —
  -- a `reset` row with no reset_at is a run that half-happened and nobody noticed.
  CONSTRAINT ck_lms_cohorts_reset CHECK ((status = 'reset') = (reset_at IS NOT NULL)),
  CONSTRAINT ck_lms_cohorts_closed CHECK (status NOT IN ('closed','reset') OR closed_at IS NOT NULL),
  CONSTRAINT ux_lms_cohorts_id_tenant UNIQUE (id, tenant_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_lms_cohorts_key ON lms_cohorts (tenant_id, cohort_key);
-- At most ONE cohort running at a time in a given tenant. Two cohorts sharing the training tenant
-- means one group's reset destroys the other group's work mid-exercise.
CREATE UNIQUE INDEX IF NOT EXISTS ux_lms_cohorts_one_running
  ON lms_cohorts (tenant_id) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS lms_cohort_members (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES companies(id),
  cohort_id    uuid NOT NULL,
  subject_user_id uuid NOT NULL REFERENCES users(id),
  -- The company the trainee actually works for. Recorded because the training tenant is NOT their
  -- home company, and after a reset there is otherwise no record of who was ever in it.
  home_company_id uuid REFERENCES companies(id),
  joined_at    timestamptz NOT NULL DEFAULT now(),
  -- Set when the trainee's grants in the training tenant are REVOKED. ORG-6: disposal that leaves
  -- live grants behind is worse than not disposing at all, so this is the field the reset asserts
  -- on rather than a boolean somebody could flip without doing the revocation.
  access_revoked_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (cohort_id, tenant_id) REFERENCES lms_cohorts (id, tenant_id) ON DELETE CASCADE,
  UNIQUE (tenant_id, cohort_id, subject_user_id)
);
CREATE INDEX IF NOT EXISTS ix_lms_cohort_members_subject
  ON lms_cohort_members (tenant_id, subject_user_id);
-- The open question a reset has to answer fast: is anybody still holding access?
CREATE INDEX IF NOT EXISTS ix_lms_cohort_members_live
  ON lms_cohort_members (tenant_id, cohort_id) WHERE access_revoked_at IS NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- (4) lms_training_resets — the APPEND-ONLY record of every reset that has run.
--
-- Same posture as every other ledger here: a reset that cannot be audited afterwards is a
-- destructive operation with no witness. `row_counts` records what was actually deleted per table,
-- which is also the only way to notice the RLS zero-row trap — a run that reports success having
-- matched nothing looks identical to a run against an already-clean tenant until you read this.
-- ══════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS lms_training_resets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES companies(id),
  cohort_id    uuid,
  -- 'dry_run' plans and counts without deleting; 'executed' deleted.
  mode         text NOT NULL CHECK (mode IN ('dry_run','executed')),
  requested_by uuid REFERENCES users(id),
  -- { "<table>": <rows>, ... } — per-table, never a single total. A total hides the table that
  -- matched zero rows when it should have matched hundreds.
  row_counts   jsonb NOT NULL DEFAULT '{}',
  grants_revoked int NOT NULL DEFAULT 0,
  reseeded     boolean NOT NULL DEFAULT false,
  error        text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  FOREIGN KEY (cohort_id, tenant_id) REFERENCES lms_cohorts (id, tenant_id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS ix_lms_training_resets_tenant
  ON lms_training_resets (tenant_id, started_at DESC);

-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- (5) Seed the allow-list.
--
-- These are the tables the ERP-usage exercises actually write. Every entry names WHY, and the
-- delete order clears children before parents so an FK cannot abort a run half-way.
--
-- NOT in this list, deliberately: `employees`, `users`, `company_memberships`, `org_unit_*`,
-- anything under `hr_records`, and every lms_* content table. The fake staff, the org chart and the
-- course material ARE the baseline — clearing them would mean rebuilding the tenant rather than
-- resetting it, and a trainee's LMS progress lives in their HOME company, not here.
-- ══════════════════════════════════════════════════════════════════════════════════════════════
INSERT INTO lms_training_reset_tables (table_name, module_scope, rationale, delete_order) VALUES
  -- HR exercises: "file a leave request", "approve one as a manager", "clock in".
  ('hr_case_events',      'hr',   'Append-only trail of the cases below. Cleared FIRST so the parent delete cannot abort on the FK.', 5),
  ('hr_leave_requests',   'hr',   'Trainees file leave in the exercises; real rows against a real approval chain.', 10),
  ('hr_record_reminders', 'hr',   'Reminders generated against records touched during training.', 15),
  ('hr_attendance',       'hr',   'The clock-in exercise writes attendance; leaving it makes the next cohort inherit somebody else''s week.', 18),
  ('hr_cases',            'hr',   'Cases opened during the HR exercises.', 20),
  -- Work exercises: "log time", "comment on a task", "create and move a task".
  ('time_entries',        NULL,   'The timesheet exercise writes real time entries. Core table, no module predicate.', 30),
  ('comments',            NULL,   'The comment thread is polymorphic and core (0001) — NOT a pm_* table. Cleared before its targets.', 35),
  ('pm_tasks',            NULL,   'Trainees create and move tasks in the PM exercise. 0018 gives pm_tasks a TENANT-ONLY policy, no module predicate — do not assume `pm` here or the delete opens a scope that changes nothing.', 40),
  ('tasks',               NULL,   'The core task table (0001), distinct from pm_tasks; the older surfaces still write it.', 45),
  -- Approvals. There is NO single `approvals` table — the estate has two, in different modules.
  ('agency_approvals',    NULL,   'Approval exercises route through the agency chain. Tenant-only policy (0002).', 50),
  ('automation_approvals', NULL,  'The automation/D14 approval queue; a trainee-triggered suspension left here would sit in a real reviewer''s list.', 52),
  -- The noise a cohort generates, which is the part people forget and which makes the NEXT cohort
  -- start inside somebody else's inbox and history.
  ('notifications',       NULL,   'Hundreds per cohort.', 55),
  ('activities',          NULL,   'The audit/activity feed fills with trainee actions and would otherwise read as real history.', 60)
ON CONFLICT (table_name) DO UPDATE
  SET module_scope = EXCLUDED.module_scope,
      rationale    = EXCLUDED.rationale,
      delete_order = EXCLUDED.delete_order,
      updated_at   = now();

-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- FORCE RLS + the composed third-wall policy, in the same DO-loop shape as L1 so the predicate
-- stays byte-identical across every lms_* table and cannot drift per-table.
--
-- `lms_training_reset_tables` is NOT in this loop: it holds no tenant data and must stay readable
-- while deciding whether a reset may run at all.
-- ══════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lms_cohorts','lms_cohort_members','lms_training_resets'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''lms''))
         WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''lms''))',
      t
    );
  END LOOP;
END $$;
