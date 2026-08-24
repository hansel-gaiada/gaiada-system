-- LMS wave L1 — the learning catalogue: courses, modules, activities, paths, enrolment, progress,
-- completion and certification.
--
-- Design: docs/blueprints/lms-foundation.md. Owner decisions 2026-08-24 (§8): the LMS is its OWN
-- module (`lms`), NOT filed under `hr` — it serves all eight departments, and filing a company-wide
-- capability under one department would make Creatives' or SEO's training silently depend on `hr`
-- being served to them. Certification crosses a ONE-WAY seam: the LMS writes an `hr_record` on path
-- completion and reads nothing back.
--
-- ── THE MODULE THIRD WALL, for a NEW module key ────────────────────────────────────────────────
-- Every table below composes the byte-identical predicate 0028 established, with `lms` in place of
-- `hr`:  `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('lms')`.
--
-- `app_module_allowed(mod)` (0028) is generic — it reads the `app.scopes` GUC — so a NEW module key
-- needs no new function. What it DOES need is `withTenants(..., { modules: ["lms"] })` at every call
-- site, and `lms` in the company's `enabled_modules` (or an active service_assignment). Omit either
-- and these tables read and write ZERO rows with no error.
--
-- ⚠ AND THE CORRECTION 202608240140 RECORDED: app_module_allowed returns **NULL**, not false, on an
--   unset GUC. Fail-closed inside RLS (a policy admits only TRUE), but `NOT NULL` is NULL outside
--   one. Test with `IS NOT TRUE`, never `= false`.
--
-- ── THE ONE DISCIPLINE THIS WHOLE SCHEMA RESTS ON: CONTENT IS VERSIONED, PROGRESS IS FROZEN ─────
-- A published course that changes under a learner mid-path is the defining failure of a homegrown
-- LMS: somebody completes "Module 3", the author edits it, and the completion now attests to
-- something that was never taken. Worse, a compliance certificate then points at content that no
-- longer exists.
--
-- So, exactly the discipline 0081 froze the loan schedule with and HR-FULL froze payslips with:
--   * a course is (course_key, version) — editing a PUBLISHED course creates a NEW version
--   * an enrolment pins the version the learner is working through
--   * a completion records the version it was earned against, forever
-- A later version never invalidates an earned completion, and never silently rewrites what somebody
-- was assessed on.
--
-- PII posture: progress, scores and completions ARE personal data (a failed attempt more sensitive
-- than a passed one). Label-only per the 0109 owner decision; the Gate-1 posture is unchanged.
--
-- Additive throughout. No UPDATE, no DELETE, no INSERT..SELECT anywhere in this file.

-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- (1) lms_courses — the unit of authored content, VERSIONED.
--
-- `course_key` is the stable identity across versions ('erp-basics'); `version` increments. The
-- catalogue shows the latest PUBLISHED version; a learner may be mid-way through an older one.
-- ══════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE lms_courses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  course_key    text NOT NULL CHECK (length(course_key) > 0),
  version       int  NOT NULL DEFAULT 1 CHECK (version >= 1),
  title         text NOT NULL,
  summary       text,
  -- 'general' is the MANDATORY track every employee passes (ERP usage, Claude usage, fundamentals).
  -- 'department' scopes to an org-chart unit. The split is a column rather than a magic
  -- department name so "is this mandatory for everyone" is answerable without knowing the org.
  track         text NOT NULL DEFAULT 'department' CHECK (track IN ('general','department')),
  -- Org-blob node id ('d-web'). Free text, NO FK — the 0026/0055/0109 posture: org nodes are not a
  -- database table. NULL for a general-track course.
  unit_node_id  text,
  -- A subdivision within a department: 'fe','be','uiux','devops','cyber','qa' for Web Dev. Free
  -- text because every department names its own, and a CHECK here would need a migration per
  -- department. NULL where a department has no subdivisions.
  discipline    text,
  -- What makes this "all levels": the same discipline carries a management-tier path that is
  -- scenario-based rather than hands-on.
  level         text NOT NULL DEFAULT 'foundation'
                  CHECK (level IN ('foundation','practitioner','advanced','lead')),
  -- draft -> in_review -> published -> retired. Only `published` is assignable; `retired` keeps
  -- existing enrolments working (see the version discipline in the header) but accepts no new ones.
  status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','in_review','published','retired')),
  estimated_minutes int CHECK (estimated_minutes IS NULL OR estimated_minutes > 0),
  -- Set when this version is published; the catalogue orders by it.
  published_at  timestamptz,
  published_by  uuid REFERENCES users(id),
  -- Set when the LMS registers the published course as a knowledge source (blueprint §8.2 — the
  -- ONE-WAY publish INTO knowledge, so the assistant can cite training somebody was assigned).
  knowledge_source_id uuid,
  authored_by   uuid REFERENCES users(id),
  origin_site   text NOT NULL DEFAULT 'central',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  -- A department course must name its unit; a general course must NOT. Enforced here because the
  -- alternative is a general-track course that quietly belongs to one department and is therefore
  -- invisible to everybody else.
  CONSTRAINT ck_lms_courses_track_unit CHECK (
    (track = 'general' AND unit_node_id IS NULL) OR
    (track = 'department' AND unit_node_id IS NOT NULL)
  ),
  CONSTRAINT ck_lms_courses_published CHECK (
    (status = 'published') = (published_at IS NOT NULL)
  ),
  CONSTRAINT ux_lms_courses_id_tenant UNIQUE (id, tenant_id)
);
-- One row per (key, version). This is the versioning invariant, in the database.
CREATE UNIQUE INDEX ux_lms_courses_key_version ON lms_courses (tenant_id, course_key, version)
  WHERE deleted_at IS NULL;
-- At most ONE draft per course_key: editing a published course opens a draft, and a second
-- concurrent draft of the same course is two people silently overwriting each other.
CREATE UNIQUE INDEX ux_lms_courses_one_draft ON lms_courses (tenant_id, course_key)
  WHERE status IN ('draft','in_review') AND deleted_at IS NULL;
CREATE INDEX ix_lms_courses_catalogue ON lms_courses (tenant_id, track, unit_node_id, discipline, level)
  WHERE status = 'published' AND deleted_at IS NULL;

COMMENT ON TABLE lms_courses IS
  'Authored course content, VERSIONED. (course_key, version) is the identity; editing a published '
  'course creates a NEW version so an in-flight learner is never assessed on content that changed '
  'under them. Owned by the LMS; published INTO the knowledge store one-way (knowledge_source_id).';

-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- (2) lms_modules — ordered sections within one course VERSION.
-- ══════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE lms_modules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES companies(id),
  course_id   uuid NOT NULL,
  sort_order  int  NOT NULL DEFAULT 0,
  title       text NOT NULL,
  summary     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (course_id, tenant_id) REFERENCES lms_courses (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT ux_lms_modules_id_tenant UNIQUE (id, tenant_id)
);
CREATE INDEX ix_lms_modules_course ON lms_modules (tenant_id, course_id, sort_order);

-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- (3) lms_activities — THE POLYMORPHIC UNIT, and the reason the LMS does not wait on the sandbox.
--
-- `read · watch · quiz · scenario · lab`. A lab is one kind behind an HTTP contract to the runner
-- (blueprint §5.2); everything else executes nothing. That is what lets the mandatory general track
-- ship to all 23 employees while the lab runner is still being built — and what keeps MANAGEMENT
-- training expressible, which an activity model assuming code could not do.
-- ══════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE lms_activities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES companies(id),
  module_id   uuid NOT NULL,
  sort_order  int  NOT NULL DEFAULT 0,
  kind        text NOT NULL CHECK (kind IN ('read','watch','quiz','scenario','lab')),
  title       text NOT NULL,
  -- The body. Shape differs per kind — prose for `read`, a URL for `watch`, questions for `quiz`,
  -- a challenge spec for `lab` — and a typed union across five kinds would be five mostly-NULL
  -- column sets. Validated app-side per kind.
  spec        jsonb NOT NULL DEFAULT '{}',
  -- Whether the learner must pass this to complete the course. A `read` is usually not required to
  -- be "passed"; a quiz or lab usually is.
  is_required boolean NOT NULL DEFAULT true,
  -- Percentage needed to pass, for the graded kinds. NULL where passing is binary (opened/watched)
  -- or where a human reviews (blueprint §8.3 — UI/UX and management scenarios are REVIEWED, and an
  -- auto-gradeable proxy for "is this good design" mostly is not one).
  pass_threshold numeric(5,2) CHECK (pass_threshold IS NULL OR (pass_threshold >= 0 AND pass_threshold <= 100)),
  -- 'auto'   — machine-graded (quiz assertions, lab runner output)
  -- 'review' — a human (HOD or peer) grades it
  -- 'none'   — completion is participation, not a score
  grading     text NOT NULL DEFAULT 'auto' CHECK (grading IN ('auto','review','none')),
  max_attempts int CHECK (max_attempts IS NULL OR max_attempts > 0),
  estimated_minutes int CHECK (estimated_minutes IS NULL OR estimated_minutes > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (module_id, tenant_id) REFERENCES lms_modules (id, tenant_id) ON DELETE CASCADE,
  -- A lab MUST be machine-graded and MUST carry a threshold; a review activity must NOT claim to be
  -- auto-graded. Cheap to state here, and it stops a lab shipping that nothing can actually pass.
  CONSTRAINT ck_lms_activities_lab_graded CHECK (kind <> 'lab' OR grading = 'auto'),
  CONSTRAINT ck_lms_activities_threshold CHECK (grading <> 'auto' OR kind IN ('read','watch') OR pass_threshold IS NOT NULL),
  CONSTRAINT ux_lms_activities_id_tenant UNIQUE (id, tenant_id)
);
CREATE INDEX ix_lms_activities_module ON lms_activities (tenant_id, module_id, sort_order);

COMMENT ON COLUMN lms_activities.grading IS
  'auto = machine-graded | review = a human grades it | none = participation. Mixed BY DISCIPLINE '
  'per the owner decision: objective disciplines auto-grade, UI/UX and management scenarios are '
  'reviewed, because auto-grading them teaches people to satisfy the grader.';

-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- (4) lms_paths / lms_path_courses — the ORDERED sequence. "Steps so difficulties are in order."
--
-- Ordering lives on the PATH, not on the course, because the same course legitimately sits at
-- different points in two different paths (a security primer is step 1 for a junior and step 4 for
-- a designer).
-- ══════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE lms_paths (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES companies(id),
  path_key     text NOT NULL CHECK (length(path_key) > 0),
  title        text NOT NULL,
  summary      text,
  track        text NOT NULL DEFAULT 'department' CHECK (track IN ('general','department')),
  unit_node_id text,
  discipline   text,
  level        text NOT NULL DEFAULT 'foundation'
                 CHECK (level IN ('foundation','practitioner','advanced','lead')),
  status       text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','in_review','published','retired')),
  -- THE AUTO-ASSIGNMENT SWITCH. A mandatory path is enrolled onto every active employee in scope by
  -- the assignment runner — this is how "a general track every employee must pass" happens without
  -- anybody remembering to assign it.
  is_mandatory boolean NOT NULL DEFAULT false,
  -- Who a mandatory path applies to. 'all' is the general track; the others narrow it.
  applies_to   text NOT NULL DEFAULT 'all' CHECK (applies_to IN ('all','unit','discipline','level')),
  -- Days from enrolment to the due date. NULL = no due date.
  due_days     int CHECK (due_days IS NULL OR due_days > 0),
  -- Months a certification earned from this path stays valid — written onto the hr_record's
  -- `expires_on` so it flows into the EXISTING compliance sweep rather than a parallel one.
  certification_valid_months int CHECK (certification_valid_months IS NULL OR certification_valid_months > 0),
  certification_label text,
  published_at timestamptz,
  authored_by  uuid REFERENCES users(id),
  origin_site  text NOT NULL DEFAULT 'central',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  CONSTRAINT ck_lms_paths_track_unit CHECK (
    (track = 'general' AND unit_node_id IS NULL) OR
    (track = 'department' AND unit_node_id IS NOT NULL)
  ),
  -- Only a general-track path may be mandatory for EVERYONE; a department path narrows.
  CONSTRAINT ck_lms_paths_mandatory_scope CHECK (
    NOT is_mandatory OR applies_to <> 'all' OR track = 'general'
  ),
  CONSTRAINT ux_lms_paths_id_tenant UNIQUE (id, tenant_id)
);
CREATE UNIQUE INDEX ux_lms_paths_key ON lms_paths (tenant_id, path_key) WHERE deleted_at IS NULL;
CREATE INDEX ix_lms_paths_mandatory ON lms_paths (tenant_id, is_mandatory, applies_to)
  WHERE status = 'published' AND deleted_at IS NULL;

CREATE TABLE lms_path_courses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES companies(id),
  path_id     uuid NOT NULL,
  -- The COURSE KEY, not a course id — a path references the course by stable identity so a new
  -- published version flows to new enrolments without editing every path that names it.
  course_key  text NOT NULL,
  position    int  NOT NULL CHECK (position >= 1),
  -- Must the learner finish the previous step first? FALSE lets a path offer parallel electives.
  -- TRUE is the "difficulties in order" default.
  requires_previous boolean NOT NULL DEFAULT true,
  is_optional boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (path_id, tenant_id) REFERENCES lms_paths (id, tenant_id) ON DELETE CASCADE,
  UNIQUE (tenant_id, path_id, position),
  UNIQUE (tenant_id, path_id, course_key)
);
CREATE INDEX ix_lms_path_courses_path ON lms_path_courses (tenant_id, path_id, position);

-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- (5) lms_enrollments — a person against a path, PINNED to the versions they started.
-- ══════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE lms_enrollments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  subject_user_id uuid NOT NULL REFERENCES users(id),
  path_id       uuid NOT NULL,
  -- How this enrolment came about. `auto` is the mandatory-path runner; the others are deliberate
  -- acts. Recorded because "why am I assigned this" is the first question a learner asks.
  source        text NOT NULL DEFAULT 'manual'
                  CHECK (source IN ('manual','auto','hod','review_cycle','self')),
  assigned_by   uuid REFERENCES users(id),
  status        text NOT NULL DEFAULT 'assigned'
                  CHECK (status IN ('assigned','in_progress','completed','waived','expired')),
  due_on        date,
  started_at    timestamptz,
  completed_at  timestamptz,
  waived_reason text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (path_id, tenant_id) REFERENCES lms_paths (id, tenant_id),
  CONSTRAINT ck_lms_enrollments_completed CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CONSTRAINT ux_lms_enrollments_id_tenant UNIQUE (id, tenant_id)
);
-- One LIVE enrolment per (person, path). A re-enrolment after expiry is legitimate — recertification
-- is the normal case — so the constraint covers only open rows.
CREATE UNIQUE INDEX ux_lms_enrollments_live ON lms_enrollments (tenant_id, subject_user_id, path_id)
  WHERE status IN ('assigned','in_progress');
CREATE INDEX ix_lms_enrollments_subject ON lms_enrollments (tenant_id, subject_user_id, status);
CREATE INDEX ix_lms_enrollments_due ON lms_enrollments (tenant_id, due_on)
  WHERE status IN ('assigned','in_progress') AND due_on IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- (6) lms_progress — per-activity state, PINNED to the course version being worked through.
--
-- `course_id` (not course_key) is deliberate here: progress is against a SPECIFIC VERSION. When a
-- new version publishes, an in-flight learner keeps theirs and their completions stay meaningful.
-- ══════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE lms_progress (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  subject_user_id uuid NOT NULL REFERENCES users(id),
  enrollment_id uuid,
  course_id     uuid NOT NULL,
  activity_id   uuid NOT NULL,
  status        text NOT NULL DEFAULT 'not_started'
                  CHECK (status IN ('not_started','in_progress','submitted','passed','failed','waived')),
  -- Best score across attempts. NULL for ungraded activities — and NULL is NOT zero: "not graded"
  -- and "scored nothing" are different answers and a progress bar must not conflate them.
  best_score    numeric(5,2) CHECK (best_score IS NULL OR (best_score >= 0 AND best_score <= 100)),
  attempt_count int NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  first_started_at timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (course_id, tenant_id)   REFERENCES lms_courses (id, tenant_id),
  FOREIGN KEY (activity_id, tenant_id) REFERENCES lms_activities (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (enrollment_id, tenant_id) REFERENCES lms_enrollments (id, tenant_id) ON DELETE SET NULL,
  UNIQUE (tenant_id, subject_user_id, activity_id)
);
CREATE INDEX ix_lms_progress_subject ON lms_progress (tenant_id, subject_user_id, course_id);
CREATE INDEX ix_lms_progress_enrollment ON lms_progress (tenant_id, enrollment_id) WHERE enrollment_id IS NOT NULL;

COMMENT ON COLUMN lms_progress.best_score IS
  'PD — assessment result. NULL means UNGRADED, never zero: a progress view that renders NULL as 0 '
  'tells a learner they failed something that was never scored.';

-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- (7) lms_attempts — the append-only attempt ledger.
--
-- Same reasoning as 0081's repayment ledger and HR-FULL's accrual ledger: `lms_progress` keeps the
-- running best for cheap reads, and this keeps WHY it is that number. Without it, "you scored 60"
-- is unanswerable the moment anybody disputes it — and for a compliance certification, somebody
-- eventually will.
-- ══════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE lms_attempts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  subject_user_id uuid NOT NULL REFERENCES users(id),
  activity_id   uuid NOT NULL,
  attempt_no    int  NOT NULL CHECK (attempt_no >= 1),
  score         numeric(5,2) CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  passed        boolean,
  -- What the learner submitted (quiz answers, a diff, a file set). PD.
  submission    jsonb NOT NULL DEFAULT '{}',
  -- The grader's workings — a quiz's per-question result, or the lab runner's stdout/exit/artefacts.
  -- Stored so a disputed score can be traced to the thing that produced it.
  result        jsonb NOT NULL DEFAULT '{}',
  -- The lab runner's own id for this run (blueprint §5.2). NULL for every non-lab kind.
  lab_run_id    text,
  -- For `grading='review'`: who graded it. NULL while awaiting review.
  reviewed_by   uuid REFERENCES users(id),
  reviewed_at   timestamptz,
  review_note   text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  submitted_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (activity_id, tenant_id) REFERENCES lms_activities (id, tenant_id) ON DELETE CASCADE,
  UNIQUE (tenant_id, subject_user_id, activity_id, attempt_no)
);
CREATE INDEX ix_lms_attempts_activity ON lms_attempts (tenant_id, activity_id, subject_user_id, attempt_no);
-- The review queue: submitted, human-graded, not yet graded.
CREATE INDEX ix_lms_attempts_pending_review ON lms_attempts (tenant_id, submitted_at)
  WHERE submitted_at IS NOT NULL AND reviewed_at IS NULL;

COMMENT ON COLUMN lms_attempts.submission IS 'PD — the learner''s own work. Label only, 0109 posture.';

-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- (8) lms_completions — the FROZEN result, and the one-way seam into HR.
--
-- A completion records the course/path VERSION it was earned against and never changes. On path
-- completion the LMS writes an `hr_record` (record_type='document', with expires_on from the path's
-- certification_valid_months) and stores its id here — so certification expiry flows through the
-- EXISTING HR compliance sweep rather than a parallel model that would disagree with it.
-- ══════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE lms_completions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  subject_user_id uuid NOT NULL REFERENCES users(id),
  -- Exactly one of the two: a course completion or a path completion.
  course_id     uuid,
  path_id       uuid,
  enrollment_id uuid,
  -- Frozen provenance. `course_key`+`version` survive even if the course row is later retired,
  -- which is the point: a certificate must remain readable after its content is withdrawn.
  course_key    text,
  course_version int,
  path_key      text,
  final_score   numeric(5,2) CHECK (final_score IS NULL OR (final_score >= 0 AND final_score <= 100)),
  completed_at  timestamptz NOT NULL DEFAULT now(),
  -- THE ONE-WAY SEAM. Set when a path completion writes its certification into hr_records.
  hr_record_id  uuid,
  certificate_expires_on date,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (course_id, tenant_id)     REFERENCES lms_courses (id, tenant_id),
  FOREIGN KEY (path_id, tenant_id)       REFERENCES lms_paths (id, tenant_id),
  FOREIGN KEY (enrollment_id, tenant_id) REFERENCES lms_enrollments (id, tenant_id) ON DELETE SET NULL,
  CONSTRAINT ck_lms_completions_one_target CHECK (
    (course_id IS NOT NULL)::int + (path_id IS NOT NULL)::int = 1
  ),
  -- Only a PATH completion may carry a certification; a single course does not certify.
  CONSTRAINT ck_lms_completions_cert CHECK (hr_record_id IS NULL OR path_id IS NOT NULL)
);
-- One completion per (person, course version) and per (person, path). Re-earning after expiry is a
-- NEW row with a later completed_at — the history of who was certified when is the audit trail.
CREATE INDEX ix_lms_completions_subject ON lms_completions (tenant_id, subject_user_id, completed_at DESC);
CREATE INDEX ix_lms_completions_path ON lms_completions (tenant_id, path_id, completed_at DESC)
  WHERE path_id IS NOT NULL;

COMMENT ON TABLE lms_completions IS
  'FROZEN completion record. Carries the course_key/version it was earned against so a later version '
  'never invalidates it, and a certificate stays readable after its content is retired. Path '
  'completions write an hr_record (one-way) so expiry flows through HR''s existing compliance sweep.';

-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- FORCE RLS + the composed third-wall policy, in the 0028/0081/HR-FULL DO-loop shape so the
-- predicate is byte-identical across every lms_* table and cannot drift per-table.
-- ══════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'lms_courses','lms_modules','lms_activities','lms_paths','lms_path_courses',
    'lms_enrollments','lms_progress','lms_attempts','lms_completions'
  ] LOOP
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
