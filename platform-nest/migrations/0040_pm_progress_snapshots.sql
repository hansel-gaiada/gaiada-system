-- P2-07 — Burndown snapshots (pm-console-ux-design-spec.md §4, §0 D-2).
-- D-2 decision: a nightly snapshot table + LAZY upsert-on-read is the correctness backstop —
-- every /pm/projects/:id/burndown GET upserts TODAY's row for that project (pm.controller.ts
-- upsertTodaySnapshot()), so the series is always current even if the nightly job
-- (burndown-job.ts) hasn't reached the project yet. open_count/done_count derive from the
-- project's EFFECTIVE status set's is_done FLAG (P2-04, effectiveStatuses()), never a literal
-- status id — a renamed/custom done status still counts correctly.
--
-- One row per (tenant, project, day); ON CONFLICT (tenant_id, project_id, snapshot_date) keeps
-- same-day re-reads to exactly one row. Mirrors the pm_* table shape (origin_site, created/
-- updated_at) and is FORCE-RLS'd off the 0025 app_current_tenants() helper — same pattern as
-- pm_project_tags (0036) and pm_project_statuses (0038).
CREATE TABLE pm_progress_snapshots (
  tenant_id uuid NOT NULL REFERENCES companies(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  snapshot_date date NOT NULL,
  open_count integer NOT NULL DEFAULT 0,
  done_count integer NOT NULL DEFAULT 0,
  avg_progress integer NOT NULL DEFAULT 0,
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, snapshot_date)
);
CREATE INDEX pm_progress_snapshots_project_date_idx ON pm_progress_snapshots (project_id, snapshot_date);

-- FORCE RLS + tenant_isolation via the 0025 app_current_tenants() helper.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE pm_progress_snapshots ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE pm_progress_snapshots FORCE ROW LEVEL SECURITY';
  EXECUTE
    'CREATE POLICY tenant_isolation ON pm_progress_snapshots FOR ALL
       USING (tenant_id = ANY(app_current_tenants()))
       WITH CHECK (tenant_id = ANY(app_current_tenants()))';
END $$;
