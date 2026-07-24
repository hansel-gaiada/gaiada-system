-- P2-04 — Custom statuses: per-project configurable workflow statuses
-- (pm-console-ux-design-spec.md §7, §0). Replaces the fixed TaskStatus enum with a
-- project-scoped, ordered status registry carrying is_done / is_blocked engine flags.
--
-- D-3 ROLLING-DEPLOY STRATEGY (zero row rewrites, no backfill, old readers keep working):
--   * The seeded default status ids ARE the legacy literals todo / in_progress / blocked / done,
--     so every existing pm_tasks.status value stays valid unchanged.
--   * A project with NO rows in this table is READ as the 4 synthesized defaults (app-side,
--     pm.controller effectiveStatuses()); rows are MATERIALIZED only on the first status-editor
--     write for that project (ensureMaterialized()). So this migration inserts NOTHING.
--   * The old pm_tasks.status CHECK (a fixed enum) is DROPPED — status is now a project-scoped
--     status id, validated app-side against the project's effective set. The column stays text,
--     so a rolling deploy where old code still SELECTs status keeps working throughout.
--
-- Mirrors the pm_* table shape (origin_site, created/updated/deleted_at) and is FORCE-RLS'd off
-- the 0025 app_current_tenants() helper — same pattern as pm_project_tags (0036) and every pm_*
-- table after the 0025 re-point. id is TEXT (a project-scoped slug), and the PK is composite
-- (tenant_id, project_id, id) per the locked P2-04/P2-05 contract.

CREATE TABLE pm_project_statuses (
  id text NOT NULL,                       -- project-scoped status id (slug); defaults reuse the legacy literals
  tenant_id uuid NOT NULL REFERENCES companies(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  position integer NOT NULL DEFAULT 0,
  label text NOT NULL,
  color text NOT NULL,
  is_done boolean NOT NULL DEFAULT false,
  is_blocked boolean NOT NULL DEFAULT false,
  wip_limit integer,
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (tenant_id, project_id, id)
);
CREATE INDEX pm_project_statuses_project_idx ON pm_project_statuses (project_id) WHERE deleted_at IS NULL;

-- status is now a project-scoped id, not a fixed enum — drop the legacy CHECK. Located by its
-- definition (not a hard-coded name) so a differently-named constraint is still removed; the
-- priority/progress CHECKs are untouched. Column type stays text.
DO $$
DECLARE cname text;
BEGIN
  SELECT con.conname INTO cname
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'pm_tasks' AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) ILIKE '%status%'
    AND pg_get_constraintdef(con.oid) ILIKE '%todo%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE pm_tasks DROP CONSTRAINT %I', cname);
  END IF;
END $$;

-- FORCE RLS + tenant_isolation via the 0025 app_current_tenants() helper.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE pm_project_statuses ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE pm_project_statuses FORCE ROW LEVEL SECURITY';
  EXECUTE
    'CREATE POLICY tenant_isolation ON pm_project_statuses FOR ALL
       USING (tenant_id = ANY(app_current_tenants()))
       WITH CHECK (tenant_id = ANY(app_current_tenants()))';
END $$;
