-- IAM — DW-5a: the `agency_campaign_part` permission family (docs/FRONTEND-BFF-CONTRACT.md §31.2), a NEW Cerbos
-- kind (module `agency`): one part of a shared campaign, belonging to one taking-part department. Pure IAM seed:
-- no DDL (202610140500 owns the tables).
--
-- A new Cerbos kind costs six coupled artifacts; this is #5 (copied from 202610130120_iam_conversation_permissions.sql).
-- The others, all in the same change:
--   1. cerbos/policies/resource_agency_campaign_part.yaml (+ 4 perm_agency_campaign_part_* derived roles in
--      derived_roles.yaml: read/create/delete/allocate, NOT update — see the policy header)
--   2. src/rbac/cerbos.ts            — NO change: `ownerId` and `unitAncestors` (the two attributes the owner and
--                                      org_unit_lead rules read) are already in Resource AND in the resourcePayload()
--                                      allow-list
--   3. src/rbac/permission-catalog.json  — the 5 keys + _meta counts (105 kinds / 451 pairs / 436 grantable)
--   4. src/rbac/permission-groups.json   — 1 group (`agency_campaign_parts`) + _meta counts
--   6. scripts/generate-role-bundles.mjs (NO resolver change: the kind names only direct roles, which DIRECT already
--      maps) and src/rbac/role-permission-bundles.json regenerated from a clean worktree.
--
-- ── WHICH REACH IS SEEDED (a mechanical transcription of the policy's role-arm ALLOW rules) ──────
--   platform_admin   — all 5 keys (its Cerbos wildcard; 0094's methodology materialises an explicit row per
--                      grantable key anyway, see 202609281704)
--   company_admin, owner, manager — read, create, update, delete, allocate
--                      (owner MUST mirror company_admin exactly: owner-role.db.test.ts; a new company_admin key does
--                      NOT propagate to owner on its own)
--   member           — read, and update as a SELF-SCOPED pair (the part's own owner: `variables.owns`)
--   viewer           — read
--   org_unit_lead    — update (its own rule, over the part's unit subtree)
--   everything else (client, module tiers, ...) — NOTHING
--
-- ── SELF-SCOPED MARKER ──────────────────────────────────────────────────────────────────────────
-- member·agency.campaign_part.update is the ONLY marked pair: every rule that grants it to `member` is the
-- `variables.owns` rule. role-permission-bundles.json carries it under `selfScoped.member`, and
-- self-scoped-marker-parity.db.test.ts pins the DB to the JSON. org_unit_lead·update is NOT marked: a department
-- head acts on other people's parts (it is authority over others, which is what a grant ceiling cares about).
--
-- ── SENSITIVE ─────────────────────────────────────────────────────────────────────────────────
-- None of the five is flagged. `allocate` moves money but only within the campaign's own budget, and flagging it
-- would route any role that carries it (manager) through the sensitive-grant override path (PERMISSION-CONTRACT
-- §12.2) for every department-head grant of that role. Owner/architect may tighten this additively.
--
-- `permissions.id` has no default, so it is supplied explicitly. `ui_grantable` is EXPLICIT (0110's default).
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('agency.campaign_part.allocate', 'agency', 'campaign_part', 'allocate',
   'Set or change a campaign part''s budget allocation, drawn from the campaign''s own budget. Kept apart from update so a part''s owner or a department head can never move money.',
   'agency_campaign_part', 'allocate', 'grantable', false, true),
  ('agency.campaign_part.create', 'agency', 'campaign_part', 'create',
   'Add a department to a shared campaign as a campaign part.',
   'agency_campaign_part', 'create', 'grantable', false, true),
  ('agency.campaign_part.delete', 'agency', 'campaign_part', 'delete',
   'Remove a department''s part from a shared campaign (a soft delete; cancelling is the normal path).',
   'agency_campaign_part', 'delete', 'grantable', false, true),
  ('agency.campaign_part.read', 'agency', 'campaign_part', 'read',
   'View a shared campaign''s parts: the departments taking part, their owners, status and allocations.',
   'agency_campaign_part', 'read', 'grantable', false, true),
  ('agency.campaign_part.update', 'agency', 'campaign_part', 'update',
   'Update a campaign part''s status, owner, brief, due date and links. Also reached, by Cerbos rule, by the part''s own owner and by a department head over the part''s unit.',
   'agency_campaign_part', 'update', 'grantable', false, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

INSERT INTO role_permissions (role_id, permission_id, self_scoped)
SELECT r.id, p.id, bundle.self_scoped
FROM (
  -- the full-reach tier: every part key (company_admin's reach, mirrored exactly by owner)
  SELECT f.role_name, k.perm_key, false AS self_scoped
    FROM (VALUES ('platform_admin'), ('company_admin'), ('owner'), ('manager')) AS f(role_name)
   CROSS JOIN (VALUES
     ('agency.campaign_part.read'), ('agency.campaign_part.create'), ('agency.campaign_part.update'),
     ('agency.campaign_part.delete'), ('agency.campaign_part.allocate')
   ) AS k(perm_key)
  UNION ALL
  -- the read tier: members and viewers see the parts
  SELECT e.role_name, 'agency.campaign_part.read', false
    FROM (VALUES ('member'), ('viewer')) AS e(role_name)
  UNION ALL
  -- the part's OWN owner updates their own part (never its money): the self-scoped pair
  SELECT 'member', 'agency.campaign_part.update', true
  UNION ALL
  -- a department head updates the parts of their own unit's subtree
  SELECT 'org_unit_lead', 'agency.campaign_part.update', false
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
   WHERE cerbos_kind = 'agency_campaign_part' AND class = 'grantable' AND module_key = 'agency'
     AND sensitive = false AND ui_grantable = true;
  IF got <> 5 THEN
    RAISE EXCEPTION '202610140510: expected 5 grantable, non-sensitive, ui_grantable agency_campaign_part permissions, found %', got;
  END IF;

  FOR expected IN
    SELECT * FROM (VALUES
      ('platform_admin', 5), ('company_admin', 5), ('owner', 5), ('manager', 5),
      ('member', 2), ('viewer', 1), ('org_unit_lead', 1),
      ('client', 0), ('group_executive', 0), ('webdev_staff', 0), ('webdev_manager', 0), ('hr_manager', 0)
    ) AS x(role_name, expected_count)
  LOOP
    SELECT count(*) INTO got
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND r.name = expected.role_name
       AND p.cerbos_kind = 'agency_campaign_part';
    IF got <> expected.expected_count THEN
      RAISE EXCEPTION '202610140510: role "%": expected % bundled agency_campaign_part permission(s), found % (missing/typo''d role name or key, or a prior partial application)',
        expected.role_name, expected.expected_count, got;
    END IF;
  END LOOP;

  -- Nobody but the full-reach tier holds the money key or create/delete: the part's owner and a department head
  -- must never reach `allocate`, `create` or `delete`.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL
     AND p.key IN ('agency.campaign_part.allocate', 'agency.campaign_part.create', 'agency.campaign_part.delete')
     AND r.name NOT IN ('platform_admin', 'company_admin', 'owner', 'manager');
  IF got <> 0 THEN
    RAISE EXCEPTION '202610140510: allocate/create/delete leaked to % row(s) outside platform_admin/company_admin/owner/manager', got;
  END IF;

  -- The self-scoped marker: exactly member·update, and nothing else on this kind.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.cerbos_kind = 'agency_campaign_part' AND rp.self_scoped
     AND NOT (r.name = 'member' AND p.key = 'agency.campaign_part.update');
  IF got <> 0 THEN
    RAISE EXCEPTION '202610140510: % unexpected self_scoped agency_campaign_part row(s)', got;
  END IF;
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND r.name = 'member' AND p.key = 'agency.campaign_part.update' AND rp.self_scoped;
  IF got <> 1 THEN
    RAISE EXCEPTION '202610140510: member·agency.campaign_part.update must be marked self_scoped';
  END IF;

  -- Every global role that holds a write on the kind via the role arm also holds `read`, EXCEPT org_unit_lead,
  -- whose only rule is the update rule (a head also holds member/company_admin in practice).
  SELECT count(*) INTO got FROM (
    SELECT rp.role_id
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND p.cerbos_kind = 'agency_campaign_part' AND r.name <> 'org_unit_lead'
     GROUP BY rp.role_id
    HAVING bool_or(p.action <> 'read')
       AND NOT bool_or(p.action = 'read')
  ) gap;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610140510: % role(s) hold an agency_campaign_part action without `read`', got;
  END IF;

  -- owner ≡ company_admin, in BOTH directions (equal counts alone would not catch the wrong keys).
  SELECT count(*) INTO got FROM (
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
        AND p.cerbos_kind = 'agency_campaign_part'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin'
        AND p.cerbos_kind = 'agency_campaign_part')
    UNION ALL
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin'
        AND p.cerbos_kind = 'agency_campaign_part'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
        AND p.cerbos_kind = 'agency_campaign_part')
  ) diff;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610140510: owner''s agency_campaign_part bundle diverges from company_admin''s by % key(s) — owner-role.db.test.ts will fail', got;
  END IF;

  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.cerbos_kind = 'agency_campaign_part';
  IF got <> 24 THEN
    RAISE EXCEPTION '202610140510: total bundled agency_campaign_part permissions on global roles: expected 24 (4x5 + 2 + 1 + 1), found %', got;
  END IF;

  RAISE NOTICE '202610140510: role_permissions seeded — % agency_campaign_part rows across 7 global roles', got;
END $$;
