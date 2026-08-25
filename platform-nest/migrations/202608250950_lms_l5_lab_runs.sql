-- LMS wave L5b — the platform's record of a lab dispatch.
--
-- Design: docs/blueprints/lms-foundation.md §5.2. The runner (`lab-runner/`) is a separate service
-- with NO ERP network path: it holds no learner identity, never reaches Postgres, and returns a
-- graded result over HTTP. This table is the platform side of that seam — what we asked for, what
-- came back, and who asked.
--
-- ── WHY A TABLE RATHER THAN A COLUMN ON `lms_attempts` ────────────────────────────────────────
-- Three reasons, each of which would otherwise be a hack on the attempt row:
--   1. RATE LIMITING. "How many labs has this person run in the last hour" has to be answerable
--      cheaply, and an LMS lab endpoint is an obvious way to get free compute on somebody else's
--      box. Counting rows here is that answer.
--   2. A DISPATCH IS NOT AN ATTEMPT. A run can fail before it ever produces a gradeable result —
--      the runner was unreachable, the queue was full, the image key was wrong. None of those are
--      "the learner failed"; recording them on the attempt would make a broken deploy look like a
--      cohort that could not code.
--   3. THE AUDIT. This is the one place in the estate that executes somebody's code on a shared
--      host. What was submitted, when, by whom, and what the runner said, is worth keeping.
--
-- ── THE MODULE THIRD WALL ─────────────────────────────────────────────────────────────────────
-- `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('lms')`. Omit `{ modules: ["lms"] }`
-- and this table reads and writes ZERO rows with no error.
-- ⚠ app_module_allowed returns NULL, not false, on an unset GUC (the 202608240140 correction).
--
-- Additive. No UPDATE or DELETE of existing rows anywhere in this file.

-- ── A MISSING CONSTRAINT L1 DID NOT NEED AND THIS WAVE DOES ───────────────────────────────────
-- Every other lms_* table carries `UNIQUE (id, tenant_id)` so a composite tenant-scoped FK can
-- reference it. `lms_attempts` was the one exception, because in L1 nothing pointed AT an attempt.
-- This wave does, and a plain `REFERENCES lms_attempts(id)` would be a tenant-blind FK in a schema
-- whose entire isolation story is that they are not.
--
-- Additive and safe on live data: the pair is already unique (id is the primary key), so the index
-- can only succeed.
ALTER TABLE lms_attempts
  ADD CONSTRAINT ux_lms_attempts_id_tenant UNIQUE (id, tenant_id);

CREATE TABLE IF NOT EXISTS lms_lab_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  subject_user_id uuid NOT NULL REFERENCES users(id),
  activity_id   uuid NOT NULL,
  -- The attempt this run graded. NULL while the run is in flight, and NULL forever for a run that
  -- never produced a gradeable result — see reason 2 in the header.
  attempt_id    uuid,
  -- The runner's own id for this run. Not a foreign key to anything: the runner is a compute
  -- surface, not a store, and it drops results after its TTL. Kept so a support question ("what
  -- happened to my submission at 14:03") can be matched against the runner's logs while they exist.
  runner_run_id text,
  -- queued    — accepted by the runner, not finished
  -- succeeded — ran and PASSED its grading spec
  -- failed    — ran and did not pass. A NORMAL outcome; this is what learning looks like.
  -- error     — never produced a gradeable result. NOT the learner's fault.
  status        text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','succeeded','failed','error')),
  score         numeric(5,2) CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  exit_code     int,
  timed_out     boolean NOT NULL DEFAULT false,
  -- Bounded application-side before insert. A runaway `yes` in a submission would otherwise put
  -- megabytes per attempt into the database that backs the whole ERP.
  stdout        text,
  stderr        text,
  -- The per-check verdicts, so a learner can be told WHICH assertion failed and what was seen.
  -- A grade with no explanation teaches nothing, which defeats the point of a lab.
  checks        jsonb NOT NULL DEFAULT '[]',
  artefacts     jsonb NOT NULL DEFAULT '[]',
  error         text,
  duration_ms   int,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  FOREIGN KEY (activity_id, tenant_id) REFERENCES lms_activities (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (attempt_id, tenant_id) REFERENCES lms_attempts (id, tenant_id) ON DELETE SET NULL,
  -- A finished run has an end time; an unfinished one does not. Without this a crashed dispatch
  -- leaves a row that reads as "still queued" forever and no sweep can tell it apart from a real one.
  CONSTRAINT ck_lms_lab_runs_finished CHECK ((status = 'queued') = (finished_at IS NULL)),
  CONSTRAINT ux_lms_lab_runs_id_tenant UNIQUE (id, tenant_id)
);

-- THE RATE-LIMIT INDEX. The question is always "this person, recently", so the index is ordered to
-- answer exactly that without a scan.
CREATE INDEX IF NOT EXISTS ix_lms_lab_runs_subject_recent
  ON lms_lab_runs (tenant_id, subject_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_lms_lab_runs_activity
  ON lms_lab_runs (tenant_id, activity_id, created_at DESC);

COMMENT ON TABLE lms_lab_runs IS
  'One dispatch to the lab runner. Separate from lms_attempts because a dispatch can fail without '
  'the learner having failed (runner unreachable, queue full, bad image key) — recording those on '
  'the attempt would make a broken deploy look like a cohort that could not code. Also the cheap '
  'answer to "how many labs has this person run in the last hour", which an LMS lab endpoint needs '
  'because it is an obvious way to get free compute on a shared host.';

COMMENT ON COLUMN lms_lab_runs.status IS
  'failed = ran and did not pass, which is a NORMAL outcome. error = never produced a gradeable '
  'result, which is ours to fix rather than the learner''s.';

-- FORCE RLS + the composed third-wall predicate, same DO-loop shape as L1/L2 so it cannot drift.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lms_lab_runs'] LOOP
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
