-- DW-6f (docs/FRONTEND-BFF-CONTRACT.md §34.3; plan docs/plans/2026-10-13-department-workspaces.md §4.2): PULL REQUESTS AND
-- THEIR CI STATUS, linked to PM tasks.
--
-- One table. It is filled by the existing GitHub webhook handlers (core/github-webhook-handlers.ts) in the same delivery,
-- and read by GET /api/:t/pm/tasks/:taskId/pull-requests. Nothing is backfilled: a pull request appears as its events
-- arrive.
--
--   * tenant_id is always the ORG tenant (GITHUB_REPO_SYNC_TENANT_ID, the receiver's stamp; docs/blueprints/
--     github-tenant-scope-ruling.md §0). A pull request links only to a task in that same company (§34.2).
--   * pm_task_id is a plain FK with ON DELETE SET NULL, NOT the tenant-scoped composite (pm_task_id, tenant_id) the other
--     pm_* tables use: a composite SET NULL would also null the NOT NULL tenant_id and fail. The application resolves the
--     task inside the org tenant under RLS before it writes the id, so a cross-tenant task cannot be named.
--   * ci is one entry per workflow name, { runId, status, conclusion, url, at }, merged by the handler with `||`
--     (never jsonb_set, which creates no ancestors). The summary (passing/failing/running/none) is computed on read.
--   * gh_updated_at is GitHub's own updated_at, the ordering guard: an out-of-order delivery never rolls a row back.
--
-- Grants: runtime DML comes from the owner's ALTER DEFAULT PRIVILEGES + the RUNTIME_GRANTS_SQL pass (migrations/README.md),
-- as for every other tenant table; nothing is granted by hand here.
--
-- Pure DDL, additive, idempotent.

CREATE TABLE IF NOT EXISTS github_pull_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  repo_full_name text NOT NULL,
  number integer NOT NULL,
  title text NOT NULL,
  state text NOT NULL CHECK (state IN ('open', 'closed')),
  merged boolean NOT NULL DEFAULT false,
  draft boolean NOT NULL DEFAULT false,
  head_ref text NOT NULL,
  head_sha text,
  html_url text NOT NULL,
  author_login text,
  gh_updated_at timestamptz,
  pm_task_id uuid REFERENCES pm_tasks(id) ON DELETE SET NULL,
  task_key text,
  ci jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(ci) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_github_pull_requests_repo_number UNIQUE (tenant_id, repo_full_name, number)
);

CREATE INDEX IF NOT EXISTS ix_github_pull_requests_task
  ON github_pull_requests (tenant_id, pm_task_id) WHERE pm_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_github_pull_requests_head_sha
  ON github_pull_requests (tenant_id, repo_full_name, head_sha);

ALTER TABLE github_pull_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_pull_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON github_pull_requests;
CREATE POLICY tenant_isolation ON github_pull_requests FOR ALL
  USING (tenant_id = ANY(app_current_tenants()))
  WITH CHECK (tenant_id = ANY(app_current_tenants()));

-- ── Assert, don't assume ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM pg_class WHERE relname = 'github_pull_requests' AND relrowsecurity AND relforcerowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610140720: github_pull_requests must exist with RLS ENABLED and FORCED';
  END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE tablename = 'github_pull_requests' AND policyname = 'tenant_isolation';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610140720: github_pull_requests needs exactly one tenant_isolation policy, found %', n;
  END IF;
  SELECT count(*) INTO n FROM pg_indexes
   WHERE indexname IN ('ix_github_pull_requests_task', 'ix_github_pull_requests_head_sha');
  IF n <> 2 THEN
    RAISE EXCEPTION '202610140720: the two github_pull_requests lookup indexes are missing (found % of 2)', n;
  END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'github_pull_requests'::regclass AND conname = 'ux_github_pull_requests_repo_number';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610140720: the (tenant_id, repo_full_name, number) unique constraint is missing';
  END IF;
END $$;
