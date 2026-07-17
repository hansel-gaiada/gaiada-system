-- Project-management subsystem (BFF §5, platform-ui lib/pm.ts): a Repsona-style rich task
-- model layered over the base projects. Dedicated pm_* tables (base projects/tasks untouched;
-- they unify later during the cross-session wiring pass). Poly-assignee + subtasks + tracker
-- suggestions stored as JSONB; task dependencies as a uuid[]. All tenant-scoped, FORCE RLS.

-- Per-project PM metadata: the poly-assignee owner (kind/refId/responsible). name/status/dueDate
-- stay on the base projects row (single source) — this only holds what the base table lacks.
CREATE TABLE pm_project_meta (
  tenant_id uuid NOT NULL REFERENCES companies(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  owner jsonb,
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id)
);

CREATE TABLE pm_milestones (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  name text NOT NULL,
  due_date date,
  status text NOT NULL DEFAULT 'open',
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE pm_tasks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','blocked','done')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  assignee jsonb,                       -- Assignee {kind,refId,refName,responsibleId,responsibleName} | null
  subtasks jsonb NOT NULL DEFAULT '[]', -- Subtask[] {id,title,done}
  milestone_id uuid REFERENCES pm_milestones(id),
  start_date date,
  due_date date,
  estimate_minutes integer,
  depends_on uuid[] NOT NULL DEFAULT '{}',
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX pm_tasks_project_idx ON pm_tasks (project_id) WHERE deleted_at IS NULL;

CREATE TABLE pm_docs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  author_id uuid REFERENCES users(id),
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- AI-Tracker suggestions (progress/status), applied by a human via confirm.
CREATE TABLE pm_suggestions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  task_id uuid NOT NULL REFERENCES pm_tasks(id),
  kind text NOT NULL CHECK (kind IN ('progress','status')),
  proposed text NOT NULL,
  rationale text NOT NULL DEFAULT '',
  docs jsonb NOT NULL DEFAULT '[]',     -- TrackerDoc[] {title,ref}
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','dismissed')),
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pm_suggestions_task_idx ON pm_suggestions (task_id);

-- Reuse time_entries for PM task time logs. Its task_id FKs the BASE tasks table, so add a
-- dedicated pm_task_id link; project_id (NOT NULL on time_entries) is satisfied by the PM
-- task's base project. loggedMinutes = SUM(minutes) over pm_task_id; billable rolls up as usual.
ALTER TABLE time_entries ADD COLUMN pm_task_id uuid REFERENCES pm_tasks(id);
CREATE INDEX time_entries_pm_task_idx ON time_entries (pm_task_id) WHERE pm_task_id IS NOT NULL;

-- FORCE RLS + authorized-tenant-set isolation (mirrors 0001/0011/0017).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pm_project_meta','pm_milestones','pm_tasks','pm_docs','pm_suggestions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
       USING (tenant_id = ANY(string_to_array(current_setting(''app.current_tenant_ids'', true), '','')::uuid[]))
       WITH CHECK (tenant_id = ANY(string_to_array(current_setting(''app.current_tenant_ids'', true), '','')::uuid[]))',
      t
    );
  END LOOP;
END $$;
