-- IAM — DW-10e: two new actions on the EXISTING `work_request` kind, for REQUESTS ACROSS GROUP COMPANIES
-- (docs/PERMISSION-CONTRACT.md §49, docs/FRONTEND-BFF-CONTRACT.md §60; rulings DW-D35, DW-D39, DW-D40, DW-D41).
-- Pure IAM seed: no DDL (202610160500 owns the tables and the route/client triggers).
--
--   core.work_request.send_across — send a request to another group company's department, through one of the company's
--                                   routes. The same reach as `create`, as its own action.
--   core.work_request.read_across — read EVERY request the company sent to another group company's departments (DW-D40's
--                                   wide tier; the requester's own read is the handler's narrowing, never this action).
--
-- No new Cerbos kind, so this is the 5th of the six artifacts only (template: 202610140610_iam_work_request_permissions.sql).
-- The others, all in the same change:
--   1. cerbos/policies/resource_work_request.yaml (send_across: ALLOW company_admin/manager/member, in the bot/automation
--      DENY list, and a mirror rule; read_across: ALLOW company_admin/manager and a mirror rule, NOT denied to agents)
--      + 2 perm_work_request_* derived roles in derived_roles.yaml (perm_work_request_send_across, _read_across)
--   2. src/rbac/cerbos.ts            — NO change (no new resource attribute)
--   3. src/rbac/permission-catalog.json  — the 2 keys + _meta counts (111 kinds / 481 pairs / 466 grantable)
--   4. src/rbac/permission-groups.json   — both keys join the existing `work_requests` group + _meta counts
--   6. scripts/generate-role-bundles.mjs (NO resolver change) and src/rbac/role-permission-bundles.json regenerated.
--
-- ── WHICH REACH IS SEEDED (a mechanical transcription of the policy's role-arm ALLOW rules) ──────
--   send_across: platform_admin (its Cerbos wildcard; an explicit row per grantable key anyway, see 202609281704),
--                company_admin, owner (MUST mirror company_admin exactly: owner-role.db.test.ts; a new company_admin key
--                does NOT propagate to owner on its own), manager, member
--   read_across: platform_admin, company_admin, owner, manager
--   viewer, org_unit_lead (its grant carries no company, so a head rule could match a same-id department of another
--   company), client and every module role: NOTHING.
--
-- ── SELF-SCOPED MARKER ──────────────────────────────────────────────────────────────────────────
-- None of the nine rows is self-scoped. The sender acts for their company, not on their own record, and read_across has no
-- requester rule (one would make it self-scoped and forbid the permission mirror).
--
-- ── SENSITIVE ─────────────────────────────────────────────────────────────────────────────────
-- Neither key is flagged (like `create`, and a read is not sensitive authority: PERMISSION-CONTRACT §12.2). Both are
-- ui_grantable, EXPLICITLY (0110's default). `permissions.id` has no default, so it is supplied explicitly.
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('core.work_request.send_across', 'core', 'work_request', 'send_across',
   'Send a request to another group company''s department, through one of the company''s routes',
   'work_request', 'send_across', 'grantable', false, true),
  ('core.work_request.read_across', 'core', 'work_request', 'read_across',
   'Read every request the company sent to another group company''s departments',
   'work_request', 'read_across', 'grantable', false, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

INSERT INTO role_permissions (role_id, permission_id, self_scoped)
SELECT r.id, p.id, false
FROM (VALUES
  ('platform_admin', 'core.work_request.send_across'),
  ('company_admin',  'core.work_request.send_across'),
  ('owner',          'core.work_request.send_across'),
  ('manager',        'core.work_request.send_across'),
  ('member',         'core.work_request.send_across'),
  ('platform_admin', 'core.work_request.read_across'),
  ('company_admin',  'core.work_request.read_across'),
  ('owner',          'core.work_request.read_across'),
  ('manager',        'core.work_request.read_across')
) AS bundle(role_name, perm_key)
JOIN roles r ON r.company_id IS NULL AND r.name = bundle.role_name
JOIN permissions p ON p.key = bundle.perm_key
ON CONFLICT (role_id, permission_id) DO UPDATE SET self_scoped = EXCLUDED.self_scoped;

-- ── Assert, don't assume (202608310900's discipline) ────────────────────────────────────────────
DO $$
DECLARE
  got integer;
  k record;
BEGIN
  SELECT count(*) INTO got FROM permissions
   WHERE key IN ('core.work_request.send_across', 'core.work_request.read_across')
     AND cerbos_kind = 'work_request' AND class = 'grantable' AND module_key = 'core'
     AND sensitive = false AND ui_grantable = true;
  IF got <> 2 THEN
    RAISE EXCEPTION '202610160510: expected 2 grantable, non-sensitive, ui_grantable work_request across permissions, found %', got;
  END IF;

  -- Exactly the expected global roles hold each key: the count of holders, and none outside the list.
  FOR k IN
    SELECT * FROM (VALUES
      ('core.work_request.send_across', ARRAY['platform_admin', 'company_admin', 'owner', 'manager', 'member']),
      ('core.work_request.read_across', ARRAY['platform_admin', 'company_admin', 'owner', 'manager'])
    ) AS x(perm_key, role_names)
  LOOP
    SELECT count(*) INTO got
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND p.key = k.perm_key AND r.name = ANY (k.role_names);
    IF got <> array_length(k.role_names, 1) THEN
      RAISE EXCEPTION '202610160510: %: expected % of the named roles to hold it, found % (missing/typo''d role name, or a prior partial application)',
        k.perm_key, array_length(k.role_names, 1), got;
    END IF;

    SELECT count(*) INTO got
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND p.key = k.perm_key AND NOT (r.name = ANY (k.role_names));
    IF got <> 0 THEN
      RAISE EXCEPTION '202610160510: % leaked to % global role(s) outside %', k.perm_key, got, k.role_names;
    END IF;
  END LOOP;

  -- Named negatives: nobody below the manager tier reads across, and no viewer, department head, portal contact or
  -- module role sends across (the exact-set check above already implies it; these name the intent).
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.key = 'core.work_request.read_across'
     AND r.name IN ('member', 'viewer', 'org_unit_lead', 'client', 'group_executive', 'webdev_staff', 'webdev_manager', 'hr_manager');
  IF got <> 0 THEN
    RAISE EXCEPTION '202610160510: read_across reached % role(s) below company_admin/owner/manager', got;
  END IF;
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.key = 'core.work_request.send_across'
     AND r.name IN ('viewer', 'org_unit_lead', 'client', 'group_executive', 'webdev_staff', 'webdev_manager', 'hr_manager');
  IF got <> 0 THEN
    RAISE EXCEPTION '202610160510: send_across reached % viewer / org_unit_lead / client / module role(s)', got;
  END IF;

  -- None of the nine rows is self-scoped.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
   WHERE p.key IN ('core.work_request.send_across', 'core.work_request.read_across') AND rp.self_scoped;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610160510: % self_scoped row(s) on the across keys (the sender acts for the company, never on their own record)', got;
  END IF;

  -- owner ≡ company_admin over the WHOLE work_request kind, in BOTH directions (equal counts alone would not catch the
  -- wrong keys).
  SELECT count(*) INTO got FROM (
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
        AND p.cerbos_kind = 'work_request'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin'
        AND p.cerbos_kind = 'work_request')
    UNION ALL
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin'
        AND p.cerbos_kind = 'work_request'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
        AND p.cerbos_kind = 'work_request')
  ) diff;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610160510: owner''s work_request bundle diverges from company_admin''s by % key(s) — owner-role.db.test.ts will fail', got;
  END IF;

  RAISE NOTICE '202610160510: work_request across keys seeded (send_across: 5 roles, read_across: 4 roles)';
END $$;
