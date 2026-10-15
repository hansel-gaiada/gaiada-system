-- IAM — DW-10a: the `dept_notice` permission family (docs/FRONTEND-BFF-CONTRACT.md §57, docs/PERMISSION-CONTRACT.md §47), a NEW core
-- Cerbos kind (no module): a notice on a department's board, or a company-wide notice. Pure IAM seed: no DDL (202610152100 owns the
-- table).
--
-- A new Cerbos kind costs six coupled artifacts; this is #5 (copied from 202610151110_iam_calendar_event_permissions.sql). The others,
-- all in the same change:
--   1. cerbos/policies/resource_dept_notice.yaml (+ 1 perm_dept_notice_read derived role in derived_roles.yaml: `read` ONLY, see the
--      policy header)
--   2. src/rbac/cerbos.ts            — `scope` added to Resource AND to the resourcePayload() allow-list (`unitAncestors` was already there)
--   3. src/rbac/permission-catalog.json  — the 4 keys + _meta counts (112 kinds / 483 pairs / 468 grantable)
--   4. src/rbac/permission-groups.json   — 1 group (`notices`) + _meta counts
--   6. scripts/generate-role-bundles.mjs (NO resolver change: the kind names only direct roles and hr_people_reader, which DIRECT already
--      maps) and src/rbac/role-permission-bundles.json regenerated.
--
-- ── WHICH REACH IS SEEDED (a mechanical transcription of the policy's role-arm ALLOW rules) ──────
--   platform_admin   — all 4 keys (its Cerbos wildcard; 0094's methodology materialises an explicit row per grantable key anyway, see
--                      202609281704)
--   company_admin, owner — read, post, edit, withdraw
--                      (owner MUST mirror company_admin exactly: owner-role.db.test.ts; a new company_admin key does NOT propagate to
--                      owner on its own. Cerbos' permission arm covers `read` only, so a permission-native owner posts, edits and
--                      withdraws only if it also holds company_admin or leads the unit: PERMISSION-CONTRACT §47.)
--   manager, member, viewer — read (the handler narrows it to the unit and the company-wide notices; Cerbos bounds the tier)
--   hr_staff, hr_manager — read (the hr_people_reader rule: the HR read tier reads every unit's notices)
--   org_unit_lead    — post, edit, withdraw (its own rule per action, over the unit's subtree, UNIT notices only)
--   everything else (client, module tiers, ...) — NOTHING
--
-- ── SELF-SCOPED MARKER ──────────────────────────────────────────────────────────────────────────
-- None. No rule on this kind compares a resource attribute to the caller's id: the head's rule is containment in the unit's ancestry.
--
-- ── SENSITIVE ─────────────────────────────────────────────────────────────────────────────────
-- None of the four is flagged. A notice is internal broadcast text: it moves no money and exposes no client, HR or finance data.
-- Flagging `post` would route every department-head grant of org_unit_lead through the sensitive-grant override path (PERMISSION-CONTRACT
-- §12.2). Owner/architect may tighten this additively.
--
-- `permissions.id` has no default, so it is supplied explicitly. `ui_grantable` is EXPLICIT (0110's default).
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('core.dept_notice.read', 'core', 'dept_notice', 'read',
   'See and list notices on department notice boards. The handler narrows a unit''s notices to the people placed in that unit or below it, the heads over it and the company-wide tiers; company-wide notices are read by every member. Agents read notices and never post them.',
   'dept_notice', 'read', 'grantable', false, true),
  ('core.dept_notice.post', 'core', 'dept_notice', 'post',
   'Post a notice to a department''s board. Also reached, by Cerbos rule, by a department head over their own unit''s subtree; a company-wide notice is for company admins only. Never granted to agents or automation.',
   'dept_notice', 'post', 'grantable', false, true),
  ('core.dept_notice.edit', 'core', 'dept_notice', 'edit',
   'Edit a notice''s title, body, pin or end date. Reached on the same terms as posting, on the notice''s stored unit: any person who may post to a unit may edit any of its notices. Never granted to agents or automation.',
   'dept_notice', 'edit', 'grantable', false, true),
  ('core.dept_notice.withdraw', 'core', 'dept_notice', 'withdraw',
   'Withdraw a notice from its board (there is no delete). Reached on the same terms as posting, on the notice''s stored unit. Never granted to agents or automation.',
   'dept_notice', 'withdraw', 'grantable', false, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

INSERT INTO role_permissions (role_id, permission_id, self_scoped)
SELECT r.id, p.id, bundle.self_scoped
FROM (
  -- the full-reach tier: every key (company_admin's reach, mirrored exactly by owner)
  SELECT f.role_name, k.perm_key, false AS self_scoped
    FROM (VALUES ('platform_admin'), ('company_admin'), ('owner')) AS f(role_name)
   CROSS JOIN (VALUES
     ('core.dept_notice.read'), ('core.dept_notice.post'), ('core.dept_notice.edit'), ('core.dept_notice.withdraw')
   ) AS k(perm_key)
  UNION ALL
  -- the read tier: the scope roles and the HR read tier (hr_people_reader)
  SELECT g.role_name, 'core.dept_notice.read', false
    FROM (VALUES ('manager'), ('member'), ('viewer'), ('hr_staff'), ('hr_manager')) AS g(role_name)
  UNION ALL
  -- a department head posts, edits and withdraws their own unit's notices
  SELECT 'org_unit_lead', k.perm_key, false
    FROM (VALUES ('core.dept_notice.post'), ('core.dept_notice.edit'), ('core.dept_notice.withdraw')) AS k(perm_key)
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
   WHERE cerbos_kind = 'dept_notice' AND class = 'grantable' AND module_key = 'core'
     AND sensitive = false AND ui_grantable = true;
  IF got <> 4 THEN
    RAISE EXCEPTION '202610152110: expected 4 grantable, non-sensitive, ui_grantable dept_notice permissions, found %', got;
  END IF;

  FOR expected IN
    SELECT * FROM (VALUES
      ('platform_admin', 4), ('company_admin', 4), ('owner', 4),
      ('manager', 1), ('member', 1), ('viewer', 1), ('hr_staff', 1), ('hr_manager', 1), ('org_unit_lead', 3),
      ('client', 0), ('group_executive', 0), ('reports_staff', 0), ('reports_manager', 0), ('webdev_staff', 0), ('webdev_manager', 0)
    ) AS x(role_name, expected_count)
  LOOP
    SELECT count(*) INTO got
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND r.name = expected.role_name
       AND p.cerbos_kind = 'dept_notice';
    IF got <> expected.expected_count THEN
      RAISE EXCEPTION '202610152110: role "%": expected % bundled dept_notice permission(s), found % (missing/typo''d role name or key, or a prior partial application)',
        expected.role_name, expected.expected_count, got;
    END IF;
  END LOOP;

  -- Nobody outside platform_admin / company_admin / owner / org_unit_lead posts, edits or withdraws: `manager` is every head's
  -- company-wide role, so it must never write a notice.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL
     AND p.key IN ('core.dept_notice.post', 'core.dept_notice.edit', 'core.dept_notice.withdraw')
     AND r.name NOT IN ('platform_admin', 'company_admin', 'owner', 'org_unit_lead');
  IF got <> 0 THEN
    RAISE EXCEPTION '202610152110: post/edit/withdraw leaked to % row(s) outside platform_admin/company_admin/owner/org_unit_lead', got;
  END IF;

  -- org_unit_lead holds the three writes and NOT read (its read comes from the scope roles it also carries).
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND r.name = 'org_unit_lead' AND p.key = 'core.dept_notice.read';
  IF got <> 0 THEN
    RAISE EXCEPTION '202610152110: org_unit_lead must not hold core.dept_notice.read directly (found % row)', got;
  END IF;

  -- No self-scoped marker on this kind.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
   WHERE p.cerbos_kind = 'dept_notice' AND rp.self_scoped;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610152110: % unexpected self_scoped dept_notice row(s)', got;
  END IF;

  -- owner ≡ company_admin, in BOTH directions (equal counts alone would not catch the wrong keys).
  SELECT count(*) INTO got FROM (
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
        AND p.cerbos_kind = 'dept_notice'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin'
        AND p.cerbos_kind = 'dept_notice')
    UNION ALL
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin'
        AND p.cerbos_kind = 'dept_notice'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
        AND p.cerbos_kind = 'dept_notice')
  ) diff;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610152110: owner''s dept_notice bundle diverges from company_admin''s by % key(s) — owner-role.db.test.ts will fail', got;
  END IF;

  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.cerbos_kind = 'dept_notice';
  IF got <> 20 THEN
    RAISE EXCEPTION '202610152110: total bundled dept_notice permissions on global roles: expected 20 (3x4 + 5 + 3), found %', got;
  END IF;

  RAISE NOTICE '202610152110: role_permissions seeded — % dept_notice rows across 9 global roles', got;
END $$;
