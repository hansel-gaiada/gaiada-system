-- 202610151700_reports_client_grain.sql
-- PV7-01 (docs/FRONTEND-BFF-CONTRACT.md §53, docs/PERMISSION-CONTRACT.md §45; plan
-- docs/plans/2026-10-15-pv7-performance-views-tickets.md): the FIFTH report grain, `client`.
-- Two parts, in one file so the ticket owns exactly one migration prefix.
--
-- ══ (1) report_documents.grain accepts 'client' ═══════════════════════════════════════════════════════
-- 0067 declared `grain text NOT NULL CHECK (grain IN ('person','project','department','company'))` inline, so the
-- constraint carries Postgres's auto-generated name. Widen-only. The constraint is found by its COLUMN SET, never by
-- text (the 0083 lesson, and 202610140010's method): a text match on `grain` would not be safe against any other
-- CHECK that names the column. Only a CHECK over exactly {grain} is dropped. `DROP CONSTRAINT IF EXISTS` by the
-- canonical name then covers a re-run and a name collision, so running this twice is harmless.
-- `report_documents.scope_ref` is free `text`, so a client id needs nothing; `UNIQUE (tenant_id, period_id,
-- revision, grain, scope_ref)` already keeps a client's document distinct from a project's.
DO $$
DECLARE cname text;
BEGIN
  FOR cname IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_attribute att
        ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
     WHERE con.conrelid = 'report_documents'::regclass
       AND con.contype = 'c'
     GROUP BY con.conname
     -- `attname` is `name`, not `text`, so the cast is required — `name[] = text[]` has no operator.
    HAVING array_agg(att.attname::text ORDER BY att.attname::text) = ARRAY['grain']::text[]
  LOOP
    EXECUTE format('ALTER TABLE report_documents DROP CONSTRAINT %I', cname);
  END LOOP;
  -- Covers the re-run case and a name collision.
  ALTER TABLE report_documents DROP CONSTRAINT IF EXISTS report_documents_grain_check;

  ALTER TABLE report_documents
    ADD CONSTRAINT report_documents_grain_check
    CHECK (grain IN ('person','project','client','department','company'));
END $$;

-- ══ (2) IAM seed: `reports.document.read_client` on the EXISTING `report_document` kind ═════════════════
-- No new Cerbos kind, so the six-artifact cost is the kind's own, extended: the policy (`read_client` joins the
-- company_admin, hr_people_reader, manager and member rules), permission-catalog.json (+1 key), permission-groups.json
-- (a member of `team_project_reports`), role-permission-bundles.json, and this seed. Pure IAM seed, no further DDL.
--
-- ── WHICH REACH IS SEEDED (a mechanical transcription of the policy's role-arm ALLOW rules) ──────────
--   platform_admin       — its Cerbos wildcard (0094's methodology materialises an explicit row per grantable key)
--   company_admin, owner — owner MUST mirror company_admin exactly (owner-role.db.test.ts; a new company_admin key does
--                          NOT propagate to owner on its own)
--   manager, member      — the same derived roles that hold `read_project`
--   hr_staff, hr_manager — hr_people_reader, the same HR read tier that holds `read_project`
--   NOT reports_staff / reports_manager: they hold `read_project` only through the served-provider arm
--                          (module_staff / module_manager), and a served slice is department only.
--   everything else (viewer, org_unit_lead, client, the other module tiers, ...) — NOTHING.
--
-- ── NO MIRROR, NO SELF-SCOPE, NOT SENSITIVE ────────────────────────────────────────────────────────
-- No `perm_*` rule: the IAM-04-B5 note in resource_report_document.yaml (permission-arm-hazard-scan.test.ts, PART 3b)
-- fails the whole kind if one exists. No rule compares a resource attribute to the caller's id, so no self-scoped
-- marker. Not sensitive, like `read_project`: a client's figures are project-grain data summed, with no person named.
--
-- `permissions.id` has no default, so it is supplied explicitly. `ui_grantable` is EXPLICIT (0110's default).
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('reports.document.read_client', 'reports', 'document', 'read_client',
   'Read client-grain report documents (one client''s figures summed across its projects; staff only).',
   'report_document', 'read_client', 'grantable', false, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

INSERT INTO role_permissions (role_id, permission_id, self_scoped)
SELECT r.id, p.id, false
FROM (VALUES
  ('platform_admin'), ('company_admin'), ('owner'), ('manager'), ('member'), ('hr_staff'), ('hr_manager')
) AS bundle(role_name)
JOIN roles r ON r.company_id IS NULL AND r.name = bundle.role_name
JOIN permissions p ON p.key = 'reports.document.read_client'
ON CONFLICT (role_id, permission_id) DO UPDATE SET self_scoped = EXCLUDED.self_scoped;

-- ── Assert, don't assume (202608310900's discipline) ──────────────────────────────────────────────────
DO $$
DECLARE
  expected record;
  got integer;
BEGIN
  SELECT count(*) INTO got FROM permissions
   WHERE key = 'reports.document.read_client'
     AND cerbos_kind = 'report_document' AND cerbos_action = 'read_client'
     AND class = 'grantable' AND module_key = 'reports' AND sensitive = false AND ui_grantable = true;
  IF got <> 1 THEN
    RAISE EXCEPTION '202610151700: expected exactly 1 grantable, non-sensitive, ui_grantable reports.document.read_client, found %', got;
  END IF;

  -- the kind now has 5 permissions in all (read_person/read_project/read_department/read_company + this one)
  SELECT count(*) INTO got FROM permissions WHERE cerbos_kind = 'report_document';
  IF got <> 5 THEN
    RAISE EXCEPTION '202610151700: expected 5 report_document permissions in all, found %', got;
  END IF;

  FOR expected IN
    SELECT * FROM (VALUES
      ('platform_admin', 1), ('company_admin', 1), ('owner', 1), ('manager', 1), ('member', 1),
      ('hr_staff', 1), ('hr_manager', 1),
      ('viewer', 0), ('org_unit_lead', 0), ('client', 0), ('group_executive', 0),
      ('reports_staff', 0), ('reports_manager', 0), ('webdev_manager', 0)
    ) AS x(role_name, expected_count)
  LOOP
    SELECT count(*) INTO got
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND r.name = expected.role_name
       AND p.key = 'reports.document.read_client';
    IF got <> expected.expected_count THEN
      RAISE EXCEPTION '202610151700: role "%": expected % bundled read_client permission(s), found % (missing/typo''d role name or key, or a prior partial application)',
        expected.role_name, expected.expected_count, got;
    END IF;
  END LOOP;

  -- Held by exactly the seven roles above and no other global role (the served-provider tiers must NOT hold it).
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL
     AND p.key = 'reports.document.read_client'
     AND r.name NOT IN ('platform_admin', 'company_admin', 'owner', 'manager', 'member', 'hr_staff', 'hr_manager');
  IF got <> 0 THEN
    RAISE EXCEPTION '202610151700: read_client leaked to % row(s) outside the seven role-arm roles', got;
  END IF;

  -- No self-scoped marker on the key.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
   WHERE p.key = 'reports.document.read_client' AND rp.self_scoped;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610151700: % unexpected self_scoped read_client row(s)', got;
  END IF;

  -- owner = company_admin over the WHOLE kind, in BOTH directions (equal counts alone would not catch wrong keys).
  SELECT count(*) INTO got FROM (
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
        AND p.cerbos_kind = 'report_document'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin'
        AND p.cerbos_kind = 'report_document')
    UNION ALL
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin'
        AND p.cerbos_kind = 'report_document'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
        AND p.cerbos_kind = 'report_document')
  ) diff;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610151700: owner''s report_document bundle diverges from company_admin''s by % key(s) — owner-role.db.test.ts will fail', got;
  END IF;

  -- The CHECK now lists the five grains (and a stray older one is gone).
  SELECT count(*) INTO got
    FROM pg_constraint con
   WHERE con.conrelid = 'report_documents'::regclass AND con.contype = 'c'
     AND con.conname = 'report_documents_grain_check'
     AND pg_get_constraintdef(con.oid) LIKE '%client%';
  IF got <> 1 THEN
    RAISE EXCEPTION '202610151700: report_documents_grain_check does not list the client grain';
  END IF;

  RAISE NOTICE '202610151700: report_documents.grain widened to client; read_client seeded on 7 global roles';
END $$;
