-- 202610301200_pm_project_templates.sql — SCP-5h / W5-C3: PM's `project` template kind and what one application of it made.
-- Contract: docs/FRONTEND-BFF-CONTRACT.md §63.29.1 ("<prefix+5>_pm_project_templates.sql"); PERMISSION-CONTRACT §57 (no new kind,
-- action or policy). Plan: docs/plans/2026-10-15-social-content-pipeline.md §4.5 (SCP-D4: no second task system) and §7 row W5-C3.
--
-- ── WHAT THIS CHANGES ─────────────────────────────────────────────────────────────────────────────────────────────────────
--   pm_templates.kind     admits 'project'. 0041 declared the CHECK inline, so Postgres named it (pm_templates_kind_check). It is
--                         found BY ITS DEFINITION (a CHECK on pm_templates that reads `kind`), dropped whatever its name, and
--                         replaced by the named pm_templates_kind_ck CHECK (kind IN ('task','doc','project')). `kind` is NOT NULL,
--                         so the CHECK has no NULL case to pass.
--   ux_pm_templates_id_tenant
--                         UNIQUE (id, tenant_id) on pm_templates, the target of the application's composite template FK (AD-1: a
--                         row can never point into another company). `id` is already the primary key, so no existing row can
--                         conflict.
--   pm_template_applications (new)
--                         what one application made: the kickoff, the people per role, the task and milestone ids, and a COPY of
--                         the template as applied (`template_payload`), so a later edit of the template changes no running
--                         application and "Move kickoff" re-dates from the copy (SCP-Q41, §63.30.3). One live application per
--                         project and template (ux_pm_template_applications_once).
--
-- ── WALL: THE PLAIN TENANT WALL ───────────────────────────────────────────────────────────────────────────────────────────
-- Core, like pm_templates (0041), pm_tasks and pm_milestones: FORCE RLS, `tenant_id = ANY(app_current_tenants())` on USING and
-- WITH CHECK, no module clause. PM is a core subsystem; Social reads its applications through PM's own connection scope.
--
-- ── FOREIGN KEYS ──────────────────────────────────────────────────────────────────────────────────────────────────────────
-- project → projects (id, tenant_id) through ux_projects_id_tenant (0056); template → pm_templates (id, tenant_id) through the
-- unique this file adds. The template FK holds a soft-deleted template too (pm_templates is soft-deleted only), and the
-- application keeps the template's name and payload as applied. created_by → users.
--
-- ── NO DML ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- No row is read or written: migrations run as platform_owner WITHOUT BYPASSRLS, so a data change on a FORCE-RLS table would
-- touch zero rows (the 0050 trap). The closing DO block asserts the catalogue, never a row count. Every existing pm_templates row
-- is 'task' or 'doc', which the new CHECK admits (validated on ADD).
--
-- ── RE-RUNNABLE ───────────────────────────────────────────────────────────────────────────────────────────────────────────
-- CREATE TABLE/INDEX IF NOT EXISTS, DROP CONSTRAINT IF EXISTS + ADD (the id/tenant unique: added only when missing, since the
-- FK depends on it), DROP POLICY IF EXISTS + CREATE. Applies on its own with plain
-- `psql -f` (CI's sync-engine-go job applies every migration that way, with no ledger) and again without error. Not in the
-- sync-engine's write-back registry.
--
-- ── ROLLOUT ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- Additive. pm_templates is small (a company's templates); the CHECK swap and the unique take a brief ACCESS EXCLUSIVE lock on it.
-- No deploy-order constraint: today's code never writes 'project', and no existing code reads the new table.

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) pm_templates.kind admits 'project'
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE r record;
BEGIN
  -- Every CHECK on pm_templates that reads `kind`, other than the one this file names, whatever Postgres called it.
  FOR r IN
    SELECT pc.conname FROM pg_constraint pc
     WHERE pc.conrelid = to_regclass('pm_templates') AND pc.contype = 'c' AND pc.conname <> 'pm_templates_kind_ck'
       AND pg_get_constraintdef(pc.oid) ~ '\mkind\M'
  LOOP
    EXECUTE format('ALTER TABLE pm_templates DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE pm_templates
  DROP CONSTRAINT IF EXISTS pm_templates_kind_ck,
  ADD CONSTRAINT pm_templates_kind_ck CHECK (kind IN ('task', 'doc', 'project'));

-- Added only when missing: on a re-run the application's FK depends on it, so a DROP + ADD would fail there.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = to_regclass('pm_templates') AND conname = 'ux_pm_templates_id_tenant') THEN
    ALTER TABLE pm_templates ADD CONSTRAINT ux_pm_templates_id_tenant UNIQUE (id, tenant_id);
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) pm_template_applications — what one application of a project template made
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS pm_template_applications (
  -- The caller's application id (the route's `id`): a replay answers the same row.
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  project_id uuid NOT NULL,
  template_id uuid NOT NULL,
  -- The template's name as applied.
  template_name text NOT NULL,
  kickoff date NOT NULL,
  -- {<roleKey>: userId} as applied; a role left unmapped is absent.
  people jsonb NOT NULL,
  -- [{key, taskId, phase}] and [{phase, milestoneId}].
  tasks jsonb NOT NULL,
  milestones jsonb NOT NULL,
  -- A copy of the template's payload as applied.
  template_payload jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  origin_site text NOT NULL DEFAULT 'central',
  CONSTRAINT fk_pm_template_applications_project_tenant FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id),
  CONSTRAINT fk_pm_template_applications_template_tenant FOREIGN KEY (template_id, tenant_id) REFERENCES pm_templates (id, tenant_id)
);

-- Every column above is NOT NULL except deleted_at. A CHECK still PASSES when its expression is NULL, and a jsonb path that is
-- missing reads SQL NULL (`template_payload -> 'tasks'` on a payload with no tasks), so each path test is COALESCEd to a value that
-- fails. A length is read only once the value is known to be an array (CASE, not AND: Postgres does not promise to evaluate an
-- AND left to right, and jsonb_array_length raises on a non-array instead of failing the CHECK).
ALTER TABLE pm_template_applications
  DROP CONSTRAINT IF EXISTS pm_template_applications_name_ck,
  ADD CONSTRAINT pm_template_applications_name_ck CHECK (btrim(template_name) <> ''),
  DROP CONSTRAINT IF EXISTS pm_template_applications_kickoff_ck,
  ADD CONSTRAINT pm_template_applications_kickoff_ck CHECK (kickoff BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
  DROP CONSTRAINT IF EXISTS pm_template_applications_people_ck,
  ADD CONSTRAINT pm_template_applications_people_ck CHECK (jsonb_typeof(people) = 'object'),
  DROP CONSTRAINT IF EXISTS pm_template_applications_tasks_ck,
  ADD CONSTRAINT pm_template_applications_tasks_ck CHECK (
    CASE WHEN jsonb_typeof(tasks) = 'array' THEN jsonb_array_length(tasks) BETWEEN 1 AND 80 ELSE false END
  ),
  DROP CONSTRAINT IF EXISTS pm_template_applications_milestones_ck,
  ADD CONSTRAINT pm_template_applications_milestones_ck CHECK (
    CASE WHEN jsonb_typeof(milestones) = 'array' THEN jsonb_array_length(milestones) <= 12 ELSE false END
  ),
  DROP CONSTRAINT IF EXISTS pm_template_applications_payload_ck,
  ADD CONSTRAINT pm_template_applications_payload_ck CHECK (
    jsonb_typeof(template_payload) = 'object'
    AND COALESCE(jsonb_typeof(template_payload -> 'tasks'), 'missing') = 'array'
    AND COALESCE(jsonb_typeof(template_payload -> 'phases'), 'missing') = 'array'
    AND COALESCE(jsonb_typeof(template_payload -> 'roles'), 'missing') = 'array'
  );

-- One live application per project and template. Partial, so an application that is deleted no longer holds the pair.
CREATE UNIQUE INDEX IF NOT EXISTS ux_pm_template_applications_once
  ON pm_template_applications (project_id, template_id) WHERE deleted_at IS NULL;
-- The applications read of one project leads with project_id, which the unique above already serves; the company-wide read
-- (Social's onboarding list) is by template.
CREATE INDEX IF NOT EXISTS ix_pm_template_applications_template
  ON pm_template_applications (tenant_id, template_id) WHERE deleted_at IS NULL;

DO $$
BEGIN
  EXECUTE 'ALTER TABLE pm_template_applications ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE pm_template_applications FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON pm_template_applications';
  EXECUTE
    'CREATE POLICY tenant_isolation ON pm_template_applications FOR ALL
       USING (tenant_id = ANY(app_current_tenants()))
       WITH CHECK (tenant_id = ANY(app_current_tenants()))';
END $$;

COMMENT ON TABLE pm_template_applications IS
  'SCP-5h (BFF §63.29.1): one application of a PM project template to a project. template_payload is the template AS APPLIED; '
  'the kickoff move re-dates from it. One live row per (project, template). PLAIN CORE TENANT WALL, as pm_templates.';

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Assert, don't assume. Catalogue reads only.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  n integer;
  missing text;
BEGIN
  -- pm_templates: exactly one CHECK reads `kind`, the named one, admitting the three kinds.
  SELECT count(*) INTO n FROM pg_constraint pc
   WHERE pc.conrelid = to_regclass('pm_templates') AND pc.contype = 'c' AND pg_get_constraintdef(pc.oid) ~ '\mkind\M';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610301200: pm_templates must carry exactly one CHECK on kind, found %', n;
  END IF;
  SELECT count(*) INTO n FROM pg_constraint pc
   WHERE pc.conrelid = to_regclass('pm_templates') AND pc.conname = 'pm_templates_kind_ck' AND pc.contype = 'c' AND pc.convalidated
     AND pg_get_constraintdef(pc.oid) LIKE '%''task''%' AND pg_get_constraintdef(pc.oid) LIKE '%''doc''%'
     AND pg_get_constraintdef(pc.oid) LIKE '%''project''%';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610301200: pm_templates_kind_ck must admit task, doc and project, and be validated';
  END IF;

  SELECT string_agg(want.c, ', ') INTO missing
    FROM (VALUES
      ('id','uuid','NO'), ('tenant_id','uuid','NO'), ('project_id','uuid','NO'), ('template_id','uuid','NO'),
      ('template_name','text','NO'), ('kickoff','date','NO'), ('people','jsonb','NO'), ('tasks','jsonb','NO'),
      ('milestones','jsonb','NO'), ('template_payload','jsonb','NO'), ('created_by','uuid','NO'),
      ('created_at','timestamp with time zone','NO'), ('updated_at','timestamp with time zone','NO'),
      ('deleted_at','timestamp with time zone','YES'), ('origin_site','text','NO')
    ) AS want(c, t, nullable)
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns ic
                      WHERE ic.table_schema = current_schema() AND ic.table_name = 'pm_template_applications'
                        AND ic.column_name = want.c AND ic.data_type = want.t AND ic.is_nullable = want.nullable);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '202610301200: pm_template_applications columns missing or misshapen: %', missing;
  END IF;

  SELECT string_agg(want.t || '.' || want.c, ', ') INTO missing
    FROM (VALUES
      ('pm_templates','ux_pm_templates_id_tenant','u'),
      ('pm_template_applications','fk_pm_template_applications_project_tenant','f'),
      ('pm_template_applications','fk_pm_template_applications_template_tenant','f'),
      ('pm_template_applications','pm_template_applications_name_ck','c'),
      ('pm_template_applications','pm_template_applications_kickoff_ck','c'),
      ('pm_template_applications','pm_template_applications_people_ck','c'),
      ('pm_template_applications','pm_template_applications_tasks_ck','c'),
      ('pm_template_applications','pm_template_applications_milestones_ck','c'),
      ('pm_template_applications','pm_template_applications_payload_ck','c')
    ) AS want(t, c, k)
   WHERE NOT EXISTS (SELECT 1 FROM pg_constraint pc
                      WHERE pc.conrelid = to_regclass(want.t) AND pc.conname = want.c AND pc.contype = want.k::"char" AND pc.convalidated);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '202610301200: missing or unvalidated constraints: %', missing;
  END IF;

  SELECT count(*) INTO n FROM pg_indexes
   WHERE schemaname = current_schema() AND tablename = 'pm_template_applications'
     AND ((indexname = 'ux_pm_template_applications_once' AND indexdef LIKE 'CREATE UNIQUE INDEX%'
           AND indexdef LIKE '%(project_id, template_id)%' AND indexdef LIKE '%deleted_at IS NULL%')
       OR (indexname = 'ix_pm_template_applications_template' AND indexdef NOT LIKE 'CREATE UNIQUE%'
           AND indexdef LIKE '%(tenant_id, template_id)%' AND indexdef LIKE '%deleted_at IS NULL%'));
  IF n <> 2 THEN
    RAISE EXCEPTION '202610301200: ux_pm_template_applications_once and ix_pm_template_applications_template must exist as written, found % of 2', n;
  END IF;

  -- The plain wall: RLS enabled and forced, one policy, the tenant predicate on both sides, no module clause.
  SELECT count(*) INTO n FROM pg_class
   WHERE oid = to_regclass('pm_template_applications') AND relrowsecurity AND relforcerowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610301200: pm_template_applications must have RLS ENABLED and FORCED';
  END IF;
  SELECT count(*) INTO n FROM pg_policies
   WHERE tablename = 'pm_template_applications' AND policyname = 'tenant_isolation'
     AND qual LIKE '%app_current_tenants()%' AND with_check LIKE '%app_current_tenants()%'
     AND qual NOT LIKE '%app_module_allowed%' AND with_check NOT LIKE '%app_module_allowed%';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610301200: pm_template_applications needs the plain tenant policy on USING and WITH CHECK';
  END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE tablename = 'pm_template_applications';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610301200: pm_template_applications must carry exactly one policy, found %', n;
  END IF;

  -- pm_templates keeps its wall.
  SELECT count(*) INTO n FROM pg_class WHERE oid = to_regclass('pm_templates') AND relrowsecurity AND relforcerowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610301200: pm_templates must keep RLS ENABLED and FORCED';
  END IF;
END $$;
