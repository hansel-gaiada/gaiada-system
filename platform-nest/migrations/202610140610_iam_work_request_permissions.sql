-- IAM — DW-5c: the `work_request` permission family (docs/FRONTEND-BFF-CONTRACT.md §32.2), a NEW core Cerbos kind
-- (no module): one request between departments (assets from Creatives, engineering work from Web Dev). Pure IAM seed:
-- no DDL (202610140600 owns the tables).
--
-- A new Cerbos kind costs six coupled artifacts; this is #5 (copied from 202610140510_iam_agency_campaign_part_permissions.sql).
-- The others, all in the same change:
--   1. cerbos/policies/resource_work_request.yaml (+ 2 perm_work_request_* derived roles in derived_roles.yaml: read and
--      create, NOT cancel/deliver/decline — see the policy header)
--   2. src/rbac/cerbos.ts            — `requestedBy` and `assigneeIds` added to Resource AND to the resourcePayload()
--                                      allow-list (`unitAncestors` was already there)
--   3. src/rbac/permission-catalog.json  — the 5 keys + _meta counts (106 kinds / 456 pairs / 441 grantable)
--   4. src/rbac/permission-groups.json   — 1 group (`work_requests`) + _meta counts
--   6. scripts/generate-role-bundles.mjs (NO resolver change: the kind names only direct roles, which DIRECT already
--      maps) and src/rbac/role-permission-bundles.json regenerated.
--
-- ── WHICH REACH IS SEEDED (a mechanical transcription of the policy's role-arm ALLOW rules) ──────
--   platform_admin   — all 5 keys (its Cerbos wildcard; 0094's methodology materialises an explicit row per
--                      grantable key anyway, see 202609281704)
--   company_admin, owner, manager — read, create, cancel, deliver, decline
--                      (owner MUST mirror company_admin exactly: owner-role.db.test.ts; a new company_admin key does
--                      NOT propagate to owner on its own)
--   member           — read, create; cancel as a SELF-SCOPED pair (the requester on their own request) and deliver as
--                      a SELF-SCOPED pair (the work's assignees)
--   viewer           — read
--   org_unit_lead    — deliver, decline (its own rule per action, over the receiving department's subtree)
--   everything else (client, module tiers, ...) — NOTHING
--
-- ── SELF-SCOPED MARKER ──────────────────────────────────────────────────────────────────────────
-- member·core.work_request.cancel and member·core.work_request.deliver are the ONLY marked pairs: every rule that
-- grants either to `member` is an attribute-equality rule (`requestedBy == principal.id`,
-- `principal.id in assigneeIds`). role-permission-bundles.json carries them under `selfScoped.member`, and
-- self-scoped-marker-parity.db.test.ts pins the DB to the JSON. org_unit_lead's pairs are NOT marked: a department
-- head acts on other people's requests (authority over others, which is what a grant ceiling cares about).
--
-- ── SENSITIVE ─────────────────────────────────────────────────────────────────────────────────
-- None of the five is flagged. A request moves no money and exposes no client or HR data; flagging `create` would
-- route every department-head grant of `member` through the sensitive-grant override path (PERMISSION-CONTRACT
-- §12.2). Owner/architect may tighten this additively.
--
-- `permissions.id` has no default, so it is supplied explicitly. `ui_grantable` is EXPLICIT (0110's default).
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('core.work_request.read', 'core', 'work_request', 'read',
   'View requests between departments: what was asked, by whom, of which department, and the live state of the work behind it. Same reach as reading PM tasks.',
   'work_request', 'read', 'grantable', false, true),
  ('core.work_request.create', 'core', 'work_request', 'create',
   'Ask another department for something (assets from Creatives, engineering work from Web Dev). Any workspace can ask; never granted to agents or automation.',
   'work_request', 'create', 'grantable', false, true),
  ('core.work_request.cancel', 'core', 'work_request', 'cancel',
   'Withdraw a request while it is still open. Also reached, by Cerbos rule, by the requester on their own request. Never granted to agents or automation.',
   'work_request', 'cancel', 'grantable', false, true),
  ('core.work_request.deliver', 'core', 'work_request', 'deliver',
   'Hand over finished assets on an asset request. Also reached, by Cerbos rule, by a department head over the receiving department and by the person doing the work. Never granted to agents or automation.',
   'work_request', 'deliver', 'grantable', false, true),
  ('core.work_request.decline', 'core', 'work_request', 'decline',
   'Refuse an asset request with a reason. Also reached, by Cerbos rule, by a department head over the receiving department. Engineering requests are declined by Web Dev triage. Never granted to agents or automation.',
   'work_request', 'decline', 'grantable', false, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

INSERT INTO role_permissions (role_id, permission_id, self_scoped)
SELECT r.id, p.id, bundle.self_scoped
FROM (
  -- the full-reach tier: every request key (company_admin's reach, mirrored exactly by owner)
  SELECT f.role_name, k.perm_key, false AS self_scoped
    FROM (VALUES ('platform_admin'), ('company_admin'), ('owner'), ('manager')) AS f(role_name)
   CROSS JOIN (VALUES
     ('core.work_request.read'), ('core.work_request.create'), ('core.work_request.cancel'),
     ('core.work_request.deliver'), ('core.work_request.decline')
   ) AS k(perm_key)
  UNION ALL
  -- members read and ask; viewers only read
  SELECT 'member', 'core.work_request.read', false
  UNION ALL
  SELECT 'member', 'core.work_request.create', false
  UNION ALL
  SELECT 'viewer', 'core.work_request.read', false
  UNION ALL
  -- the REQUESTER withdraws their own ask, and the work's ASSIGNEES deliver it: the self-scoped pairs
  SELECT 'member', 'core.work_request.cancel', true
  UNION ALL
  SELECT 'member', 'core.work_request.deliver', true
  UNION ALL
  -- a department head delivers and declines the requests addressed to their own unit's subtree
  SELECT 'org_unit_lead', 'core.work_request.deliver', false
  UNION ALL
  SELECT 'org_unit_lead', 'core.work_request.decline', false
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
   WHERE cerbos_kind = 'work_request' AND class = 'grantable' AND module_key = 'core'
     AND sensitive = false AND ui_grantable = true;
  IF got <> 5 THEN
    RAISE EXCEPTION '202610140610: expected 5 grantable, non-sensitive, ui_grantable work_request permissions, found %', got;
  END IF;

  FOR expected IN
    SELECT * FROM (VALUES
      ('platform_admin', 5), ('company_admin', 5), ('owner', 5), ('manager', 5),
      ('member', 4), ('viewer', 1), ('org_unit_lead', 2),
      ('client', 0), ('group_executive', 0), ('webdev_staff', 0), ('webdev_manager', 0), ('hr_manager', 0)
    ) AS x(role_name, expected_count)
  LOOP
    SELECT count(*) INTO got
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND r.name = expected.role_name
       AND p.cerbos_kind = 'work_request';
    IF got <> expected.expected_count THEN
      RAISE EXCEPTION '202610140610: role "%": expected % bundled work_request permission(s), found % (missing/typo''d role name or key, or a prior partial application)',
        expected.role_name, expected.expected_count, got;
    END IF;
  END LOOP;

  -- Nobody outside the full-reach tier and org_unit_lead holds `decline`: only a department head (over their own
  -- subtree) joins the full-reach tier.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL
     AND p.key = 'core.work_request.decline'
     AND r.name NOT IN ('platform_admin', 'company_admin', 'owner', 'manager', 'org_unit_lead');
  IF got <> 0 THEN
    RAISE EXCEPTION '202610140610: decline leaked to % row(s) outside platform_admin/company_admin/owner/manager/org_unit_lead', got;
  END IF;

  -- A viewer never asks, cancels, delivers or declines.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND r.name = 'viewer'
     AND p.cerbos_kind = 'work_request' AND p.action <> 'read';
  IF got <> 0 THEN
    RAISE EXCEPTION '202610140610: viewer holds % non-read work_request permission(s)', got;
  END IF;

  -- The self-scoped marker: exactly member·cancel and member·deliver, and nothing else on this kind.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.cerbos_kind = 'work_request' AND rp.self_scoped
     AND NOT (r.name = 'member' AND p.key IN ('core.work_request.cancel', 'core.work_request.deliver'));
  IF got <> 0 THEN
    RAISE EXCEPTION '202610140610: % unexpected self_scoped work_request row(s)', got;
  END IF;
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND r.name = 'member'
     AND p.key IN ('core.work_request.cancel', 'core.work_request.deliver') AND rp.self_scoped;
  IF got <> 2 THEN
    RAISE EXCEPTION '202610140610: member·cancel and member·deliver must both be marked self_scoped (found %)', got;
  END IF;

  -- Every global role that holds a write on the kind via the role arm also holds `read`, EXCEPT org_unit_lead,
  -- whose rules are the deliver and decline rules only (a head also holds member/company_admin in practice).
  SELECT count(*) INTO got FROM (
    SELECT rp.role_id
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND p.cerbos_kind = 'work_request' AND r.name <> 'org_unit_lead'
     GROUP BY rp.role_id
    HAVING bool_or(p.action <> 'read')
       AND NOT bool_or(p.action = 'read')
  ) gap;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610140610: % role(s) hold a work_request action without `read`', got;
  END IF;

  -- owner ≡ company_admin, in BOTH directions (equal counts alone would not catch the wrong keys).
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
    RAISE EXCEPTION '202610140610: owner''s work_request bundle diverges from company_admin''s by % key(s) — owner-role.db.test.ts will fail', got;
  END IF;

  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.cerbos_kind = 'work_request';
  IF got <> 27 THEN
    RAISE EXCEPTION '202610140610: total bundled work_request permissions on global roles: expected 27 (4x5 + 4 + 1 + 2), found %', got;
  END IF;

  RAISE NOTICE '202610140610: role_permissions seeded — % work_request rows across 7 global roles', got;
END $$;
