-- IAM — DW-10c: the `org_structure · read_calendar` action (docs/FRONTEND-BFF-CONTRACT.md §59, docs/PERMISSION-CONTRACT.md §48): a NEW
-- action on an EXISTING core Cerbos kind. It gates the department calendar, which shows colleagues' approved leave and its type to the
-- department's people (owner ruling DW-D33). Pure IAM seed: no DDL (202610160300 owns the column).
--
-- A new action on an existing kind costs these artifacts (copied from 202610131730_iam_m5_v3f_visitor_actions.sql and
-- 202610160110_iam_dept_notice_permissions.sql); the others are in the same change:
--   1. cerbos/policies/resource_org_structure.yaml (+ derived_roles.yaml: perm_org_structure_read_calendar)
--   2. src/rbac/permission-catalog.json   — the key + _meta counts (484 pairs / 469 grantable, kinds unchanged at 112)
--   3. src/rbac/permission-groups.json    — the key in the `company_overview` group (the org chart's group) + _meta counts
--   4. src/rbac/role-permission-bundles.json regenerated (scripts/generate-role-bundles.mjs)
--
-- ── WHICH REACH IS SEEDED (a mechanical transcription of the policy's role-arm ALLOW rules) ──────
--   platform_admin   — its Cerbos wildcard (0094's methodology materialises an explicit row per grantable key anyway)
--   company_admin, owner — owner MUST mirror company_admin exactly: owner-role.db.test.ts; a new company_admin key does NOT propagate to
--                      owner on its own
--   manager, member, viewer — the scope-role rule (the handler narrows the department; Cerbos bounds the tier)
--   hr_staff, hr_manager — the hr_people_reader rule (its own rule: the HR read tier reads every department's calendar)
--   everything else (client, org_unit_lead, the other module tiers, ...) — NOTHING. A department head reads through `manager`, which
--                      every head's lead position also carries company-wide; org_unit_lead needs no key of its own.
--
-- SELF-SCOPED MARKER: none (no rule compares a resource attribute to the caller's id). SENSITIVE: no (the catalogue entry is not
-- flagged: the leave type is shown, never the note, the minutes or the approver, and only to the department's own people).
--
-- `permissions.id` has no default, so it is supplied explicitly. `ui_grantable` is EXPLICIT (0110's default).
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('core.org_structure.read_calendar', 'core', 'org_structure', 'read_calendar',
   'Read a department''s calendar: its holidays, the approved leave of the people placed in it (name, dates and leave type only, never the note), its open milestone deadlines and its department-visible events. The handler narrows a department to the people placed in it or below it, the heads over it and the company-wide tiers.',
   'org_structure', 'read_calendar', 'grantable', false, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

INSERT INTO role_permissions (role_id, permission_id, self_scoped)
SELECT r.id, p.id, false
FROM (VALUES
  ('platform_admin'), ('company_admin'), ('owner'), ('manager'), ('member'), ('viewer'), ('hr_staff'), ('hr_manager')
) AS g(role_name)
JOIN roles r ON r.company_id IS NULL AND r.name = g.role_name
JOIN permissions p ON p.key = 'core.org_structure.read_calendar'
ON CONFLICT (role_id, permission_id) DO UPDATE SET self_scoped = EXCLUDED.self_scoped;

-- ── Assert, don't assume (202608310900's discipline) ────────────────────────────────────────────
DO $$
DECLARE
  expected record;
  got integer;
BEGIN
  SELECT count(*) INTO got FROM permissions
   WHERE key = 'core.org_structure.read_calendar' AND cerbos_kind = 'org_structure' AND cerbos_action = 'read_calendar'
     AND class = 'grantable' AND module_key = 'core' AND sensitive = false AND ui_grantable = true;
  IF got <> 1 THEN
    RAISE EXCEPTION '202610160310: expected 1 grantable, non-sensitive, ui_grantable core.org_structure.read_calendar permission, found %', got;
  END IF;

  FOR expected IN
    SELECT * FROM (VALUES
      ('platform_admin', 1), ('company_admin', 1), ('owner', 1), ('manager', 1), ('member', 1), ('viewer', 1),
      ('hr_staff', 1), ('hr_manager', 1),
      ('client', 0), ('org_unit_lead', 0), ('group_executive', 0), ('reports_staff', 0), ('reports_manager', 0),
      ('webdev_staff', 0), ('webdev_manager', 0)
    ) AS x(role_name, expected_count)
  LOOP
    SELECT count(*) INTO got
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND r.name = expected.role_name
       AND p.key = 'core.org_structure.read_calendar';
    IF got <> expected.expected_count THEN
      RAISE EXCEPTION '202610160310: role "%": expected % read_calendar row(s), found % (missing/typo''d role name, or a prior partial application)',
        expected.role_name, expected.expected_count, got;
    END IF;
  END LOOP;

  -- No self-scoped marker on this key.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
   WHERE p.key = 'core.org_structure.read_calendar' AND rp.self_scoped;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610160310: % unexpected self_scoped read_calendar row(s)', got;
  END IF;

  -- owner = company_admin, in BOTH directions (equal counts alone would not catch the wrong keys): the org_structure bundle.
  SELECT count(*) INTO got FROM (
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner' AND p.cerbos_kind = 'org_structure'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin' AND p.cerbos_kind = 'org_structure')
    UNION ALL
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin' AND p.cerbos_kind = 'org_structure'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner' AND p.cerbos_kind = 'org_structure')
  ) diff;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610160310: owner''s org_structure bundle diverges from company_admin''s by % key(s) — owner-role.db.test.ts will fail', got;
  END IF;

  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.key = 'core.org_structure.read_calendar';
  IF got <> 8 THEN
    RAISE EXCEPTION '202610160310: total read_calendar rows on global roles: expected 8, found %', got;
  END IF;

  RAISE NOTICE '202610160310: role_permissions seeded — % core.org_structure.read_calendar rows across 8 global roles', got;
END $$;
