-- IAM — DW-4e-3: the two department-appraisal actions on the existing `dept_kpi_target` kind (docs/FRONTEND-BFF-CONTRACT.md
-- §41.3): `appraisal_comment` (the head's commentary) and `appraisal_assess` (the GM's assessment). NO new Cerbos kind,
-- so the six-artifact cost is the kind's own, extended: policy rules and one derived-role mirror, catalog (+2 keys),
-- permission-groups (+2 members of `dept_kpi_targets`), role-permission-bundles.json, and this seed. Pure IAM seed: no
-- DDL (202610150000 owns the table).
--
-- ── WHICH REACH IS SEEDED (a mechanical transcription of the policy's role-arm ALLOW rules) ──────
--   platform_admin   — both keys (its Cerbos wildcard; 0094's methodology materialises an explicit row per grantable key)
--   company_admin, owner — both keys (owner MUST mirror company_admin exactly: owner-role.db.test.ts; a new
--                      company_admin key does NOT propagate to owner on its own)
--   org_unit_lead    — appraisal_comment only (its own rule, over the unit's subtree)
--   everything else (manager, member, viewer, the HR tier, client, module tiers, ...) — NOTHING. Reading the appraisal
--                      uses the kind's existing `read` (the handler narrows it), so no new read key.
--
-- ── THE MIRROR CALL (the same as 202610140810's propose vs approve) ─────────────────────────────
--   appraisal_assess  — reached only through company_admin: it has a permission-arm mirror, so the permission-native
--                      `owner` assesses through its bundle.
--   appraisal_comment — also reached through the org_unit_lead rule (one unit's subtree), which a flat `perms` mirror
--                      cannot express (iam-04-reg1-mirror-reach-invariant): NO mirror. The key is still seeded for
--                      owner (it must equal company_admin), but owner comments only if it also holds company_admin or
--                      leads the unit, exactly as it proposes.
--
-- ── SELF-SCOPED / SENSITIVE ─────────────────────────────────────────────────────────────────────
-- No self-scoped marker (no rule compares a resource attribute to the caller's id). Neither key is sensitive: a
-- department appraisal is department-grain (KPIs and an aggregate of the people's appraisals: no names, no scores).
--
-- `permissions.id` has no default, so it is supplied explicitly. `ui_grantable` is EXPLICIT (0110's default).
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('reports.dept_kpi_target.appraisal_comment', 'reports', 'dept_kpi_target', 'appraisal_comment',
   'Write the head''s commentary on a department''s appraisal for an open cycle (1 to 4000 characters). Also reached, by Cerbos rule, by a department head over their own unit''s subtree.',
   'dept_kpi_target', 'appraisal_comment', 'grantable', false, true),
  ('reports.dept_kpi_target.appraisal_assess', 'reports', 'dept_kpi_target', 'appraisal_assess',
   'Write the GM''s assessment and judged condition on a department''s appraisal for an open cycle. The approver tier (company_admin, which owner mirrors); shown beside the computed condition, never replacing it.',
   'dept_kpi_target', 'appraisal_assess', 'grantable', false, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

INSERT INTO role_permissions (role_id, permission_id, self_scoped)
SELECT r.id, p.id, bundle.self_scoped
FROM (
  -- the full-reach tier: both keys (company_admin's reach, mirrored exactly by owner)
  SELECT f.role_name, k.perm_key, false AS self_scoped
    FROM (VALUES ('platform_admin'), ('company_admin'), ('owner')) AS f(role_name)
   CROSS JOIN (VALUES
     ('reports.dept_kpi_target.appraisal_comment'), ('reports.dept_kpi_target.appraisal_assess')
   ) AS k(perm_key)
  UNION ALL
  -- a department head comments on their own unit's appraisal
  SELECT 'org_unit_lead', 'reports.dept_kpi_target.appraisal_comment', false
) AS bundle(role_name, perm_key, self_scoped)
JOIN roles r ON r.company_id IS NULL AND r.name = bundle.role_name
JOIN permissions p ON p.key = bundle.perm_key
ON CONFLICT (role_id, permission_id) DO UPDATE SET self_scoped = EXCLUDED.self_scoped;

-- ── Assert, don't assume (202608310900's discipline) ────────────────────────────────────────────
DO $$
DECLARE
  expected record;
  got integer;
BEGIN
  SELECT count(*) INTO got FROM permissions
   WHERE key IN ('reports.dept_kpi_target.appraisal_comment', 'reports.dept_kpi_target.appraisal_assess')
     AND cerbos_kind = 'dept_kpi_target' AND class = 'grantable' AND module_key = 'reports'
     AND sensitive = false AND ui_grantable = true;
  IF got <> 2 THEN
    RAISE EXCEPTION '202610150100: expected 2 grantable, non-sensitive, ui_grantable appraisal permissions, found %', got;
  END IF;

  -- the kind now has 6 permissions in all (4 from 202610140810 + these 2)
  SELECT count(*) INTO got FROM permissions WHERE cerbos_kind = 'dept_kpi_target';
  IF got <> 6 THEN
    RAISE EXCEPTION '202610150100: expected 6 dept_kpi_target permissions in all, found %', got;
  END IF;

  FOR expected IN
    SELECT * FROM (VALUES
      ('platform_admin', 2), ('company_admin', 2), ('owner', 2), ('org_unit_lead', 1),
      ('manager', 0), ('member', 0), ('viewer', 0), ('hr_staff', 0), ('hr_manager', 0),
      ('client', 0), ('group_executive', 0), ('reports_staff', 0), ('reports_manager', 0), ('webdev_manager', 0)
    ) AS x(role_name, expected_count)
  LOOP
    SELECT count(*) INTO got
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND r.name = expected.role_name
       AND p.key IN ('reports.dept_kpi_target.appraisal_comment', 'reports.dept_kpi_target.appraisal_assess');
    IF got <> expected.expected_count THEN
      RAISE EXCEPTION '202610150100: role "%": expected % bundled appraisal permission(s), found % (missing/typo''d role name or key, or a prior partial application)',
        expected.role_name, expected.expected_count, got;
    END IF;
  END LOOP;

  -- `appraisal_assess` is held ONLY by the admin tiers: `manager` is every head's company-wide role and org_unit_lead
  -- is the head's own grant, so neither may assess (the GM assesses; the head comments).
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL
     AND p.key = 'reports.dept_kpi_target.appraisal_assess'
     AND r.name NOT IN ('platform_admin', 'company_admin', 'owner');
  IF got <> 0 THEN
    RAISE EXCEPTION '202610150100: appraisal_assess leaked to % row(s) outside platform_admin/company_admin/owner', got;
  END IF;

  -- `appraisal_comment` is held only by the admin tiers and org_unit_lead.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL
     AND p.key = 'reports.dept_kpi_target.appraisal_comment'
     AND r.name NOT IN ('platform_admin', 'company_admin', 'owner', 'org_unit_lead');
  IF got <> 0 THEN
    RAISE EXCEPTION '202610150100: appraisal_comment leaked to % row(s) outside platform_admin/company_admin/owner/org_unit_lead', got;
  END IF;

  -- No self-scoped marker on this kind.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
   WHERE p.cerbos_kind = 'dept_kpi_target' AND rp.self_scoped;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610150100: % unexpected self_scoped dept_kpi_target row(s)', got;
  END IF;

  -- owner = company_admin over the WHOLE kind, in BOTH directions (equal counts alone would not catch wrong keys).
  SELECT count(*) INTO got FROM (
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
        AND p.cerbos_kind = 'dept_kpi_target'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin'
        AND p.cerbos_kind = 'dept_kpi_target')
    UNION ALL
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin'
        AND p.cerbos_kind = 'dept_kpi_target'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
        AND p.cerbos_kind = 'dept_kpi_target')
  ) diff;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610150100: owner''s dept_kpi_target bundle diverges from company_admin''s by % key(s) — owner-role.db.test.ts will fail', got;
  END IF;

  -- the kind's whole footprint on global roles: 18 (202610140810) + 7 (3x2 + 1) = 25
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.cerbos_kind = 'dept_kpi_target';
  IF got <> 25 THEN
    RAISE EXCEPTION '202610150100: total bundled dept_kpi_target permissions on global roles: expected 25 (18 + 3x2 + 1), found %', got;
  END IF;

  RAISE NOTICE '202610150100: role_permissions seeded — % dept_kpi_target rows in all across 9 global roles', got;
END $$;
