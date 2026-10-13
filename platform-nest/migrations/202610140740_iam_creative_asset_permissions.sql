-- IAM — DW-6h: the `creative_asset` permission family (docs/FRONTEND-BFF-CONTRACT.md §35.4), a NEW core Cerbos kind (no
-- module): the REVIEW ROUNDS of an Asset Library asset. The asset routes themselves (list, save, read, stream, delete)
-- keep authorising as the generic `file` kind; this kind gates the review actions only. Pure IAM seed: no DDL
-- (202610140730 owns the tables).
--
-- A new Cerbos kind costs six coupled artifacts; this is #5 (copied from 202610140610_iam_work_request_permissions.sql).
-- The others, all in the same change:
--   1. cerbos/policies/resource_creative_asset.yaml (+ 2 perm_creative_asset_* derived roles in derived_roles.yaml: read
--      and request_review, NOT decide_review/withdraw_review — see the policy header)
--   2. src/rbac/cerbos.ts            — `requesterIds` and `reviewRequestedBy` added to Resource AND to the
--                                      resourcePayload() allow-list (`unitAncestors` was already there)
--   3. src/rbac/permission-catalog.json  — the 4 keys + _meta counts (107 kinds / 460 pairs / 445 grantable)
--   4. src/rbac/permission-groups.json   — 1 group (`creative_asset_reviews`) + _meta counts
--   6. scripts/generate-role-bundles.mjs and src/rbac/role-permission-parity.db.test.ts (NO resolver change in either:
--      the kind names only direct roles, which both DIRECT maps already resolve, and perm_* roles are skipped by both)
--      and src/rbac/role-permission-bundles.json regenerated.
--
-- ── WHICH REACH IS SEEDED (a mechanical transcription of the policy's role-arm ALLOW rules) ──────
--   platform_admin   — all 4 keys (its Cerbos wildcard; 0094's methodology materialises an explicit row per
--                      grantable key anyway, see 202609281704)
--   company_admin, owner, manager — read, request_review, decide_review, withdraw_review
--                      (owner MUST mirror company_admin exactly: owner-role.db.test.ts; a new company_admin key does
--                      NOT propagate to owner on its own)
--   member           — read, request_review; decide_review as a SELF-SCOPED pair (the requester of a linked work
--                      request) and withdraw_review as a SELF-SCOPED pair (the round's opener)
--   viewer           — read
--   org_unit_lead    — decide_review (its own rule, over the asset's department subtree)
--   everything else (client, module tiers, ...) — NOTHING
--
-- The maker/checker EFFECT_DENY (nobody decides a round they opened) and the automation/bot DENY name no role
-- (`roles: ["user"]`), so they move no bundle row: a bundle records what a role's ALLOW rules name.
--
-- ── SELF-SCOPED MARKER ──────────────────────────────────────────────────────────────────────────
-- member·core.creative_asset.decide_review and member·core.creative_asset.withdraw_review are the ONLY marked pairs:
-- every rule that grants either to `member` is an attribute rule against the caller's own id
-- (`principal.id in requesterIds`, `reviewRequestedBy == principal.id`). role-permission-bundles.json carries them under
-- `selfScoped.member`, and self-scoped-marker-parity.db.test.ts pins the DB to the JSON. org_unit_lead's pair is NOT
-- marked: a department head acts on other people's assets (authority over others).
--
-- ── SENSITIVE ─────────────────────────────────────────────────────────────────────────────────
-- None of the four is flagged. A review round moves no money and exposes no client or HR data.
--
-- `permissions.id` has no default, so it is supplied explicitly. `ui_grantable` is EXPLICIT (0110's default).
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('core.creative_asset.read', 'core', 'creative_asset', 'read',
   'View an Asset Library asset''s review rounds: who asked for a review of which version, and each round''s decision and comment.',
   'creative_asset', 'read', 'grantable', false, true),
  ('core.creative_asset.request_review', 'core', 'creative_asset', 'request_review',
   'Open a review round on the latest version of an Asset Library asset. Any member can ask; viewers cannot.',
   'creative_asset', 'request_review', 'grantable', false, true),
  ('core.creative_asset.decide_review', 'core', 'creative_asset', 'decide_review',
   'Approve an asset version under review, or request changes with a comment. Also reached, by Cerbos rule, by a department head over the asset''s department and by the requester of a request the asset was delivered against. Nobody decides a round they opened, and agents and automation never decide.',
   'creative_asset', 'decide_review', 'grantable', false, true),
  ('core.creative_asset.withdraw_review', 'core', 'creative_asset', 'withdraw_review',
   'Close an open review round without a decision. Also reached, by Cerbos rule, by the person who opened the round.',
   'creative_asset', 'withdraw_review', 'grantable', false, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

INSERT INTO role_permissions (role_id, permission_id, self_scoped)
SELECT r.id, p.id, bundle.self_scoped
FROM (
  -- the full-reach tier: every review key (company_admin's reach, mirrored exactly by owner)
  SELECT f.role_name, k.perm_key, false AS self_scoped
    FROM (VALUES ('platform_admin'), ('company_admin'), ('owner'), ('manager')) AS f(role_name)
   CROSS JOIN (VALUES
     ('core.creative_asset.read'), ('core.creative_asset.request_review'),
     ('core.creative_asset.decide_review'), ('core.creative_asset.withdraw_review')
   ) AS k(perm_key)
  UNION ALL
  -- members read and ask for reviews; viewers only read
  SELECT 'member', 'core.creative_asset.read', false
  UNION ALL
  SELECT 'member', 'core.creative_asset.request_review', false
  UNION ALL
  SELECT 'viewer', 'core.creative_asset.read', false
  UNION ALL
  -- a REQUESTER of a linked work request decides, and the OPENER withdraws: the self-scoped pairs
  SELECT 'member', 'core.creative_asset.decide_review', true
  UNION ALL
  SELECT 'member', 'core.creative_asset.withdraw_review', true
  UNION ALL
  -- a department head decides the rounds on their own unit's assets
  SELECT 'org_unit_lead', 'core.creative_asset.decide_review', false
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
   WHERE cerbos_kind = 'creative_asset' AND class = 'grantable' AND module_key = 'core'
     AND sensitive = false AND ui_grantable = true;
  IF got <> 4 THEN
    RAISE EXCEPTION '202610140740: expected 4 grantable, non-sensitive, ui_grantable creative_asset permissions, found %', got;
  END IF;

  FOR expected IN
    SELECT * FROM (VALUES
      ('platform_admin', 4), ('company_admin', 4), ('owner', 4), ('manager', 4),
      ('member', 4), ('viewer', 1), ('org_unit_lead', 1),
      ('client', 0), ('group_executive', 0), ('webdev_staff', 0), ('webdev_manager', 0), ('social_manager', 0),
      ('hr_manager', 0)
    ) AS x(role_name, expected_count)
  LOOP
    SELECT count(*) INTO got
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND r.name = expected.role_name
       AND p.cerbos_kind = 'creative_asset';
    IF got <> expected.expected_count THEN
      RAISE EXCEPTION '202610140740: role "%": expected % bundled creative_asset permission(s), found % (missing/typo''d role name or key, or a prior partial application)',
        expected.role_name, expected.expected_count, got;
    END IF;
  END LOOP;

  -- Nobody outside the full-reach tier, member (self-scoped) and org_unit_lead holds `decide_review`.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL
     AND p.key = 'core.creative_asset.decide_review'
     AND r.name NOT IN ('platform_admin', 'company_admin', 'owner', 'manager', 'member', 'org_unit_lead');
  IF got <> 0 THEN
    RAISE EXCEPTION '202610140740: decide_review leaked to % row(s) outside the full-reach tier, member and org_unit_lead', got;
  END IF;

  -- A viewer never asks for, decides or withdraws a review.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND r.name = 'viewer'
     AND p.cerbos_kind = 'creative_asset' AND p.action <> 'read';
  IF got <> 0 THEN
    RAISE EXCEPTION '202610140740: viewer holds % non-read creative_asset permission(s)', got;
  END IF;

  -- The self-scoped marker: exactly member·decide_review and member·withdraw_review, and nothing else on this kind.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.cerbos_kind = 'creative_asset' AND rp.self_scoped
     AND NOT (r.name = 'member' AND p.key IN ('core.creative_asset.decide_review', 'core.creative_asset.withdraw_review'));
  IF got <> 0 THEN
    RAISE EXCEPTION '202610140740: % unexpected self_scoped creative_asset row(s)', got;
  END IF;
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND r.name = 'member'
     AND p.key IN ('core.creative_asset.decide_review', 'core.creative_asset.withdraw_review') AND rp.self_scoped;
  IF got <> 2 THEN
    RAISE EXCEPTION '202610140740: member·decide_review and member·withdraw_review must both be marked self_scoped (found %)', got;
  END IF;

  -- Every global role that holds a write on the kind via the role arm also holds `read`, EXCEPT org_unit_lead, whose
  -- only rule is the decide_review rule (a head also holds member/company_admin in practice).
  SELECT count(*) INTO got FROM (
    SELECT rp.role_id
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND p.cerbos_kind = 'creative_asset' AND r.name <> 'org_unit_lead'
     GROUP BY rp.role_id
    HAVING bool_or(p.action <> 'read')
       AND NOT bool_or(p.action = 'read')
  ) gap;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610140740: % role(s) hold a creative_asset action without `read`', got;
  END IF;

  -- owner ≡ company_admin, in BOTH directions (equal counts alone would not catch the wrong keys).
  SELECT count(*) INTO got FROM (
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
        AND p.cerbos_kind = 'creative_asset'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin'
        AND p.cerbos_kind = 'creative_asset')
    UNION ALL
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin'
        AND p.cerbos_kind = 'creative_asset'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
        AND p.cerbos_kind = 'creative_asset')
  ) diff;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610140740: owner''s creative_asset bundle diverges from company_admin''s by % key(s) — owner-role.db.test.ts will fail', got;
  END IF;

  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.cerbos_kind = 'creative_asset';
  IF got <> 22 THEN
    RAISE EXCEPTION '202610140740: total bundled creative_asset permissions on global roles: expected 22 (4x4 + 4 + 1 + 1), found %', got;
  END IF;

  RAISE NOTICE '202610140740: role_permissions seeded — % creative_asset rows across 7 global roles', got;
END $$;
