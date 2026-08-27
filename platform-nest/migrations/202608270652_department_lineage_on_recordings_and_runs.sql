-- WEB DEV LINEAGE (1/2): a briefing and its PRD run know their DEPARTMENT.
--
-- `meeting_recordings` and `pipeline_runs` carried `client_id` / `project_id` but nothing that says
-- which department the work belongs to. The Web Dev console inferred it through
-- `projects.department_id`, which fails for any briefing without a project — and a briefing
-- usually exists BEFORE its project (the call happens, then the project is opened). The department
-- is a fact known at creation (PRD Studio is a department tab), so it is stored, not inferred.
--
-- Shape follows `projects.department_id` (0029): an org-node id as free text, nullable. Runs derive
-- it from their source meeting in `createRun`, exactly as they already derive client/project (WD-30).
--
-- Backfill: rows are attributed through their project where one is set — the same inference the UI
-- used, now written down once. Rows with neither project nor department stay NULL (honestly unknown).
-- Per-tenant `set_config('app.current_tenant_ids', …, true)` because migrations run as
-- `platform_owner` WITHOUT BYPASSRLS (lint:migration-rls; see 0051 / 0074).

ALTER TABLE meeting_recordings ADD COLUMN IF NOT EXISTS department_id text;
CREATE INDEX IF NOT EXISTS meeting_recordings_department_idx
  ON meeting_recordings (tenant_id, department_id) WHERE department_id IS NOT NULL;

ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS department_id text;
CREATE INDEX IF NOT EXISTS pipeline_runs_department_idx
  ON pipeline_runs (tenant_id, department_id) WHERE department_id IS NOT NULL;

DO $$
DECLARE
  co RECORD;
  n_rec int;
  n_run int;
  t_rec int := 0;
  t_run int := 0;
BEGIN
  FOR co IN SELECT id FROM companies LOOP
    PERFORM set_config('app.current_tenant_ids', co.id::text, true);

    UPDATE meeting_recordings m
       SET department_id = p.department_id
      FROM projects p
     WHERE p.id = m.project_id
       AND m.department_id IS NULL
       AND p.department_id IS NOT NULL
       AND m.deleted_at IS NULL;
    GET DIAGNOSTICS n_rec = ROW_COUNT;

    UPDATE pipeline_runs r
       SET department_id = p.department_id
      FROM projects p
     WHERE p.id = r.project_id
       AND r.department_id IS NULL
       AND p.department_id IS NOT NULL
       AND r.deleted_at IS NULL;
    GET DIAGNOSTICS n_run = ROW_COUNT;

    t_rec := t_rec + n_rec;
    t_run := t_run + n_run;
    IF n_rec > 0 OR n_run > 0 THEN
      RAISE NOTICE '[department-lineage] tenant %: % recording(s), % run(s) attributed via project', co.id, n_rec, n_run;
    END IF;
  END LOOP;
  RAISE NOTICE '[department-lineage] total: % recordings, % runs', t_rec, t_run;
END $$;

COMMENT ON COLUMN meeting_recordings.department_id IS
  'Org-node id of the department this briefing belongs to (free text, same shape as projects.department_id). '
  'Set at POST /recordings/start by the department console that created it; NULL = unknown/pre-dates the column.';
COMMENT ON COLUMN pipeline_runs.department_id IS
  'Org-node id of the department this run belongs to. createRun derives it from the source meeting '
  '(then the project) when the caller omits it, as it does for client_id/project_id.';
