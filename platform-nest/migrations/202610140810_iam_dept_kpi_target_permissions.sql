-- IAM — DW-4e-1: the `dept_kpi_target` permission family (docs/FRONTEND-BFF-CONTRACT.md §40.2), a NEW Cerbos kind in
-- the `reports` module: a department KPI's target (the head proposes, the approver approves), and the read of a
-- department's KPIs, condition and standing. Pure IAM seed: no DDL (202610140800 owns the table).
--
-- A new Cerbos kind costs six coupled artifacts; this is #5 (copied from 202610140610_iam_work_request_permissions.sql).
-- The others, all in the same change:
--   1. cerbos/policies/resource_dept_kpi_target.yaml (+ 3 perm_dept_kpi_target_* derived roles in derived_roles.yaml:
--      read, approve and reject, NOT propose — see the policy header)
--   2. src/rbac/cerbos.ts            — no allow-list change: the only attribute the kind reads, `unitAncestors`, is
--                                      already in resourcePayload() (a comment records the new consumer)
--   3. src/rbac/permission-catalog.json  — the 4 keys + _meta counts (107 kinds / 460 pairs / 445 grantable)
--   4. src/rbac/permission-groups.json   — 1 group (`dept_kpi_targets`) + _meta counts
--   6. scripts/generate-role-bundles.mjs (NO resolver change: the kind names only direct roles and hr_people_reader,
--      which DIRECT already maps) and src/rbac/role-permission-bundles.json updated to the generator's output.
--
-- ── WHICH REACH IS SEEDED (a mechanical transcription of the policy's role-arm ALLOW rules) ──────
--   platform_admin   — all 4 keys (its Cerbos wildcard; 0094's methodology materialises an explicit row per
--                      grantable key anyway, see 202609281704)
--   company_admin, owner — read, propose, approve, reject
--                      (owner MUST mirror company_admin exactly: owner-role.db.test.ts; a new company_admin key does
--                      NOT propagate to owner on its own)
--   manager, member, viewer — read (the handler narrows it to the unit; Cerbos bounds the tier)
--   hr_staff, hr_manager — read (the hr_people_reader rule: the HR read tier sees the standing, §40.3)
--   org_unit_lead    — propose (its own rule, over the unit's subtree)
--   everything else (client, module tiers, ...) — NOTHING
--
-- ── SELF-SCOPED MARKER ──────────────────────────────────────────────────────────────────────────
-- None. No rule on this kind compares a resource attribute to the caller's id. The "never approve your own
-- proposal" check is an INEQUALITY on the row, made by the service, and confers nothing.
--
-- ── SENSITIVE ─────────────────────────────────────────────────────────────────────────────────
-- None of the four is flagged. A target moves no money and exposes no client or person data (a department's KPIs are
-- department-grain report figures). Owner/architect may tighten this additively.
--
-- `permissions.id` has no default, so it is supplied explicitly. `ui_grantable` is EXPLICIT (0110's default).
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('reports.dept_kpi_target.read', 'reports', 'dept_kpi_target', 'read',
   'See a department''s KPIs: their values, targets, condition and the targets'' history. The handler narrows it to the people placed in the unit, its heads and the company-wide tiers; all departments side by side (the standing) is for the company-wide tiers only.',
   'dept_kpi_target', 'read', 'grantable', false, true),
  ('reports.dept_kpi_target.propose', 'reports', 'dept_kpi_target', 'propose',
   'Propose a target for a department KPI (a level, in force from a month start once approved). Also reached, by Cerbos rule, by a department head over their own unit''s subtree.',
   'dept_kpi_target', 'propose', 'grantable', false, true),
  ('reports.dept_kpi_target.approve', 'reports', 'dept_kpi_target', 'approve',
   'Approve a proposed department KPI target, putting it in force from its month. Never on one''s own proposal (the service refuses it).',
   'dept_kpi_target', 'approve', 'grantable', false, true),
  ('reports.dept_kpi_target.reject', 'reports', 'dept_kpi_target', 'reject',
   'Reject a proposed department KPI target.',
   'dept_kpi_target', 'reject', 'grantable', false, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

INSERT INTO role_permissions (role_id, permission_id, self_scoped)
SELECT r.id, p.id, bundle.self_scoped
FROM (
  -- the full-reach tier: every key (company_admin's reach, mirrored exactly by owner)
  SELECT f.role_name, k.perm_key, false AS self_scoped
    FROM (VALUES ('platform_admin'), ('company_admin'), ('owner')) AS f(role_name)
   CROSS JOIN (VALUES
     ('reports.dept_kpi_target.read'), ('reports.dept_kpi_target.propose'),
     ('reports.dept_kpi_target.approve'), ('reports.dept_kpi_target.reject')
   ) AS k(perm_key)
  UNION ALL
  -- the read tier: the scope roles and the HR read tier (hr_people_reader)
  SELECT g.role_name, 'reports.dept_kpi_target.read', false
    FROM (VALUES ('manager'), ('member'), ('viewer'), ('hr_staff'), ('hr_manager')) AS g(role_name)
  UNION ALL
  -- a department head proposes their own unit's targets
  SELECT 'org_unit_lead', 'reports.dept_kpi_target.propose', false
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
   WHERE cerbos_kind = 'dept_kpi_target' AND class = 'grantable' AND module_key = 'reports'
     AND sensitive = false AND ui_grantable = true;
  IF got <> 4 THEN
    RAISE EXCEPTION '202610140810: expected 4 grantable, non-sensitive, ui_grantable dept_kpi_target permissions, found %', got;
  END IF;

  FOR expected IN
    SELECT * FROM (VALUES
      ('platform_admin', 4), ('company_admin', 4), ('owner', 4),
      ('manager', 1), ('member', 1), ('viewer', 1), ('hr_staff', 1), ('hr_manager', 1), ('org_unit_lead', 1),
      ('client', 0), ('group_executive', 0), ('reports_staff', 0), ('reports_manager', 0), ('webdev_manager', 0)
    ) AS x(role_name, expected_count)
  LOOP
    SELECT count(*) INTO got
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND r.name = expected.role_name
       AND p.cerbos_kind = 'dept_kpi_target';
    IF got <> expected.expected_count THEN
      RAISE EXCEPTION '202610140810: role "%": expected % bundled dept_kpi_target permission(s), found % (missing/typo''d role name or key, or a prior partial application)',
        expected.role_name, expected.expected_count, got;
    END IF;
  END LOOP;

  -- Nobody outside platform_admin / company_admin / owner holds `approve` or `reject`: `manager` is every head's
  -- company-wide role, so it must never decide a target.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL
     AND p.key IN ('reports.dept_kpi_target.approve', 'reports.dept_kpi_target.reject')
     AND r.name NOT IN ('platform_admin', 'company_admin', 'owner');
  IF got <> 0 THEN
    RAISE EXCEPTION '202610140810: approve/reject leaked to % row(s) outside platform_admin/company_admin/owner', got;
  END IF;

  -- `propose` is held only by the full-reach tier and org_unit_lead.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL
     AND p.key = 'reports.dept_kpi_target.propose'
     AND r.name NOT IN ('platform_admin', 'company_admin', 'owner', 'org_unit_lead');
  IF got <> 0 THEN
    RAISE EXCEPTION '202610140810: propose leaked to % row(s) outside platform_admin/company_admin/owner/org_unit_lead', got;
  END IF;

  -- No self-scoped marker on this kind.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
   WHERE p.cerbos_kind = 'dept_kpi_target' AND rp.self_scoped;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610140810: % unexpected self_scoped dept_kpi_target row(s)', got;
  END IF;

  -- owner ≡ company_admin, in BOTH directions (equal counts alone would not catch the wrong keys).
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
    RAISE EXCEPTION '202610140810: owner''s dept_kpi_target bundle diverges from company_admin''s by % key(s) — owner-role.db.test.ts will fail', got;
  END IF;

  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.cerbos_kind = 'dept_kpi_target';
  IF got <> 18 THEN
    RAISE EXCEPTION '202610140810: total bundled dept_kpi_target permissions on global roles: expected 18 (3x4 + 5 + 1), found %', got;
  END IF;

  RAISE NOTICE '202610140810: role_permissions seeded — % dept_kpi_target rows across 9 global roles', got;
END $$;
