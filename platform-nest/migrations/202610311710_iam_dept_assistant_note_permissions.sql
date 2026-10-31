-- IAM — AIP-23b: the `dept_assistant_note` permission family (docs/PERMISSION-CONTRACT.md §59, docs/FRONTEND-BFF-CONTRACT.md §67), a NEW core
-- Cerbos kind (no module): department notes, a department's shared assistant memory (plan docs/plans/2026-10-31-aip-23-department-notes.md §4.8;
-- owner rulings AIP-D20 to AIP-D24). Pure IAM seed: no DDL (202610311700 owns the table).
--
-- A new Cerbos kind costs six coupled artifacts; this is #5 (copied from 202610291510_iam_dept_assistant_preamble_permissions.sql, with the
-- owner-only key of 202610300310_iam_ai_usage_permissions.sql). The others, all in the same change:
--   1. cerbos/policies/resource_dept_assistant_note.yaml (+ the derived roles dept_note_gm_seat and perm_dept_assistant_note_manage in
--      derived_roles.yaml)
--   2. src/rbac/cerbos.ts            — Resource gains `homeAncestors` and `proposedBy`, AND both join the resourcePayload() allow-list
--   3. src/rbac/permission-catalog.json  — the 7 keys + _meta counts (116 kinds / 516 pairs / 501 grantable)
--   4. src/rbac/permission-groups.json   — 1 group (`assistant_dept_notes`) + _meta counts
--   6. scripts/generate-role-bundles.mjs (OWNER_EXTENSION + `core.dept_assistant_note.manage`; DIRECT maps dept_note_gm_seat to no real role,
--      byte-aligned with role-permission-parity.db.test.ts) and src/rbac/role-permission-bundles.json regenerated.
--
-- ── THE KEYS (`core.<kind>.<action>`) ─────────────────────────────────────────────────────────────
--   core.dept_assistant_note.read     — see the department's notes   (company_admin, manager, member, viewer by home placement; org_unit_lead and
--                                                                       the GM seat on their own rules)
--   core.dept_assistant_note.propose  — suggest a note               (company_admin, manager, member by home placement)
--   core.dept_assistant_note.withdraw — take back your OWN note      (company_admin, manager, member, viewer: the author rule, SELF-SCOPED)
--   core.dept_assistant_note.decide   — approve or reject            (org_unit_lead and the GM seat, own rules)
--   core.dept_assistant_note.delete   — remove a note                (org_unit_lead and the GM seat, own rules)
--   core.dept_assistant_note.pin      — pin or unpin                 (org_unit_lead and the GM seat, own rules)
--   core.dept_assistant_note.manage   — the COMPANY TIER, any department (the OWNER ONLY: OWNER_EXTENSION, ui_grantable FALSE; the mirror)
--
-- ── WHICH REACH IS SEEDED (a mechanical transcription of the policy's role-arm ALLOW rules) ──────
--   platform_admin   — all 7 keys (its Cerbos wildcard; 0094's methodology materialises an explicit row per grantable key anyway)
--   company_admin, manager, member — read, propose, withdraw (withdraw SELF-SCOPED). AIP-D21 names the approvers (head, GM, owner, superadmin):
--                      company_admin is NOT one, so it holds only the member-level keys.
--   viewer           — read, withdraw (withdraw SELF-SCOPED). A viewer reads its department's notes and never suggests.
--   org_unit_lead    — read, decide, delete, pin (its own rule per action, over the unit's subtree)
--   owner            — company_admin's three PLUS `manage` (OWNER_EXTENSION: owner == company_admin + OWNER_EXTENSION, owner-role.db.test.ts).
--                      Owner rows are never self-scoped (the generator marks real roles only; the 202610151210 precedent).
--   the GM seat      — no row: a seat is a relationship (fed as `gmIds`), not a grant, so no bundle carries a key through it.
--   everything else (hr_*, client, module tiers, ...) — NOTHING.
--
-- ── SELF-SCOPED MARKER ──────────────────────────────────────────────────────────────────────────
-- `withdraw` is reached ONLY through the author rule (`proposedBy == principal.id`), so the generator marks it self-scoped for the four roles the
-- rule names: 4 marked pairs. platform_admin (the wildcard) and owner are not marked.
--
-- ── SENSITIVE ─────────────────────────────────────────────────────────────────────────────────
-- None of the seven is flagged, as AIP-13b's preamble keys are not. A note is a short work fact a person chose to share; it moves no money and
-- exposes no client, HR or finance data (a note about a record is filtered by that record's own read check). Flagging `decide` would route every
-- department-head grant of org_unit_lead through the sensitive-grant override path (PERMISSION-CONTRACT §12.2). Owner/architect may tighten
-- this additively.
--
-- `permissions.id` has no default, so it is supplied explicitly. `ui_grantable` is EXPLICIT (0110's default).
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('core.dept_assistant_note.read', 'core', 'dept_assistant_note', 'read',
   'See a department''s approved notes (its shared assistant memory), and, for an approver, the waiting ones. Reached, by Cerbos rule, by staff whose home placement is the department or inside it, by the department''s head over their own unit''s subtree, and by the GM in every department. Never reached by agents, automation, contributors or client accounts.',
   'dept_assistant_note', 'read', 'grantable', false, true),
  ('core.dept_assistant_note.propose', 'core', 'dept_assistant_note', 'propose',
   'Suggest a note to your own department (1 to 500 characters, optionally linked to one record you can open). Reached, by Cerbos rule, by staff whose home placement is the department or inside it (not a viewer). A head''s own suggestion is approved when saved. Never reached by agents or automation.',
   'dept_assistant_note', 'propose', 'grantable', false, true),
  ('core.dept_assistant_note.withdraw', 'core', 'dept_assistant_note', 'withdraw',
   'Take back your OWN department note, waiting or approved; the text is deleted. Reached, by Cerbos rule, only by the person who suggested it (self-scoped). Never reached by agents or automation.',
   'dept_assistant_note', 'withdraw', 'grantable', false, true),
  ('core.dept_assistant_note.decide', 'core', 'dept_assistant_note', 'decide',
   'Approve or reject a suggested department note (a rejected note is deleted; at most 50 approved per department). Reached, by Cerbos rule, by the department''s head over their own unit''s subtree and by the GM in every department. Never reached by agents or automation.',
   'dept_assistant_note', 'decide', 'grantable', false, true),
  ('core.dept_assistant_note.delete', 'core', 'dept_assistant_note', 'delete',
   'Remove a department note, waiting or approved. Reached, by Cerbos rule, by the department''s head over their own unit''s subtree and by the GM in every department. Never reached by agents or automation.',
   'dept_assistant_note', 'delete', 'grantable', false, true),
  ('core.dept_assistant_note.pin', 'core', 'dept_assistant_note', 'pin',
   'Pin or unpin an approved department note (pinned notes come first). Reached, by Cerbos rule, by the department''s head over their own unit''s subtree and by the GM in every department. Never reached by agents or automation.',
   'dept_assistant_note', 'pin', 'grantable', false, true),
  ('core.dept_assistant_note.manage', 'core', 'dept_assistant_note', 'manage',
   'Read, decide, delete and pin notes in ANY department of the company: the company tier of department notes (owner ruling AIP-D21). The owner only, through the permission arm (OWNER_EXTENSION); not UI-grantable, so no role edit, position or request can hand it out. The superadmin reaches it through the platform wildcard. Never granted to agents or automation.',
   'dept_assistant_note', 'manage', 'grantable', false, false)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

INSERT INTO role_permissions (role_id, permission_id, self_scoped)
SELECT r.id, p.id, bundle.self_scoped
FROM (VALUES
  -- the wildcard tier: every key, not marked
  ('platform_admin', 'core.dept_assistant_note.read', false),
  ('platform_admin', 'core.dept_assistant_note.propose', false),
  ('platform_admin', 'core.dept_assistant_note.withdraw', false),
  ('platform_admin', 'core.dept_assistant_note.decide', false),
  ('platform_admin', 'core.dept_assistant_note.delete', false),
  ('platform_admin', 'core.dept_assistant_note.pin', false),
  ('platform_admin', 'core.dept_assistant_note.manage', false),
  -- the home-placement tier: read and propose; withdraw through the author rule (self-scoped)
  ('company_admin', 'core.dept_assistant_note.read', false),
  ('company_admin', 'core.dept_assistant_note.propose', false),
  ('company_admin', 'core.dept_assistant_note.withdraw', true),
  ('manager', 'core.dept_assistant_note.read', false),
  ('manager', 'core.dept_assistant_note.propose', false),
  ('manager', 'core.dept_assistant_note.withdraw', true),
  ('member', 'core.dept_assistant_note.read', false),
  ('member', 'core.dept_assistant_note.propose', false),
  ('member', 'core.dept_assistant_note.withdraw', true),
  -- a viewer reads and takes back its own, never suggests
  ('viewer', 'core.dept_assistant_note.read', false),
  ('viewer', 'core.dept_assistant_note.withdraw', true),
  -- a department head: its own rule per action, over the unit's subtree (not `manage`: that is the owner's)
  ('org_unit_lead', 'core.dept_assistant_note.read', false),
  ('org_unit_lead', 'core.dept_assistant_note.decide', false),
  ('org_unit_lead', 'core.dept_assistant_note.delete', false),
  ('org_unit_lead', 'core.dept_assistant_note.pin', false),
  -- the owner: company_admin's three, never marked, PLUS the OWNER_EXTENSION key
  ('owner', 'core.dept_assistant_note.read', false),
  ('owner', 'core.dept_assistant_note.propose', false),
  ('owner', 'core.dept_assistant_note.withdraw', false),
  ('owner', 'core.dept_assistant_note.manage', false)
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
   WHERE cerbos_kind = 'dept_assistant_note' AND class = 'grantable' AND module_key = 'core' AND sensitive = false;
  IF got <> 7 THEN
    RAISE EXCEPTION '202610311710: expected 7 grantable, non-sensitive core dept_assistant_note permissions, found %', got;
  END IF;

  -- ui_grantable: the six member/head keys true, `manage` (the owner only) false
  SELECT count(*) INTO got FROM permissions WHERE cerbos_kind = 'dept_assistant_note' AND ui_grantable = false;
  IF got <> 1 OR NOT EXISTS (SELECT 1 FROM permissions WHERE key = 'core.dept_assistant_note.manage' AND ui_grantable = false) THEN
    RAISE EXCEPTION '202610311710: exactly core.dept_assistant_note.manage must be ui_grantable = false (found % false row(s))', got;
  END IF;

  FOR expected IN
    SELECT * FROM (VALUES
      ('platform_admin', 7), ('company_admin', 3), ('owner', 4), ('manager', 3), ('member', 3), ('viewer', 2), ('org_unit_lead', 4),
      ('hr_staff', 0), ('hr_manager', 0), ('client', 0), ('reports_staff', 0), ('reports_manager', 0), ('webdev_staff', 0), ('webdev_manager', 0),
      ('social_staff', 0), ('social_manager', 0)
    ) AS x(role_name, expected_count)
  LOOP
    SELECT count(*) INTO got
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND r.name = expected.role_name
       AND p.cerbos_kind = 'dept_assistant_note';
    IF got <> expected.expected_count THEN
      RAISE EXCEPTION '202610311710: role "%": expected % bundled dept_assistant_note permission(s), found % (missing/typo''d role name or key, or a prior partial application)',
        expected.role_name, expected.expected_count, got;
    END IF;
  END LOOP;

  -- Nobody outside the seven named roles holds any key of the kind.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL
     AND p.cerbos_kind = 'dept_assistant_note'
     AND r.name NOT IN ('platform_admin', 'company_admin', 'owner', 'manager', 'member', 'viewer', 'org_unit_lead');
  IF got <> 0 THEN
    RAISE EXCEPTION '202610311710: dept_assistant_note leaked to % row(s) outside the seven named roles', got;
  END IF;

  -- `manage` is the OWNER's only (and the wildcard's): company_admin and a department head must never hold it (its permission arm is a flat
  -- mirror and would reach every department).
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.key = 'core.dept_assistant_note.manage'
     AND r.name NOT IN ('platform_admin', 'owner');
  IF got <> 0 THEN
    RAISE EXCEPTION '202610311710: core.dept_assistant_note.manage leaked to % row(s) outside platform_admin/owner', got;
  END IF;

  -- The approver keys (decide, delete, pin) are the head's and the wildcard's only: company_admin is NOT an approver (AIP-D21).
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL
     AND p.key IN ('core.dept_assistant_note.decide', 'core.dept_assistant_note.delete', 'core.dept_assistant_note.pin')
     AND r.name NOT IN ('platform_admin', 'org_unit_lead');
  IF got <> 0 THEN
    RAISE EXCEPTION '202610311710: an approver key (decide/delete/pin) leaked to % row(s) outside platform_admin/org_unit_lead', got;
  END IF;

  -- Self-scoped: exactly withdraw on company_admin, manager, member and viewer.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.cerbos_kind = 'dept_assistant_note' AND rp.self_scoped;
  IF got <> 4 OR EXISTS (
    SELECT 1 FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND p.cerbos_kind = 'dept_assistant_note' AND rp.self_scoped
       AND (p.key <> 'core.dept_assistant_note.withdraw' OR r.name NOT IN ('company_admin', 'manager', 'member', 'viewer'))
  ) THEN
    RAISE EXCEPTION '202610311710: expected exactly withdraw self_scoped on company_admin/manager/member/viewer (found % marked row(s))', got;
  END IF;

  -- owner == company_admin + OWNER_EXTENSION on this kind, in BOTH directions: company_admin's keys minus owner's is empty, and owner's minus
  -- company_admin's is exactly `manage` (equal counts alone would not catch the wrong keys).
  SELECT count(*) INTO got FROM (
    SELECT p.key FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND r.name = 'company_admin' AND p.cerbos_kind = 'dept_assistant_note'
    EXCEPT
    SELECT p.key FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND r.name = 'owner' AND p.cerbos_kind = 'dept_assistant_note'
  ) missing;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610311710: owner lacks % of company_admin''s dept_assistant_note key(s) — owner-role.db.test.ts will fail', got;
  END IF;
  IF (SELECT array_agg(k ORDER BY k) FROM (
        SELECT p.key AS k FROM role_permissions rp
          JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
         WHERE r.company_id IS NULL AND r.name = 'owner' AND p.cerbos_kind = 'dept_assistant_note'
        EXCEPT
        SELECT p.key FROM role_permissions rp
          JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
         WHERE r.company_id IS NULL AND r.name = 'company_admin' AND p.cerbos_kind = 'dept_assistant_note'
      ) extra) IS DISTINCT FROM ARRAY['core.dept_assistant_note.manage'] THEN
    RAISE EXCEPTION '202610311710: owner''s dept_assistant_note keys beyond company_admin''s must be exactly core.dept_assistant_note.manage (OWNER_EXTENSION)';
  END IF;

  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.cerbos_kind = 'dept_assistant_note';
  IF got <> 26 THEN
    RAISE EXCEPTION '202610311710: total bundled dept_assistant_note permissions on global roles: expected 26 (7 + 3 + 3 + 3 + 2 + 4 + 4), found %', got;
  END IF;

  RAISE NOTICE '202610311710: role_permissions seeded — % dept_assistant_note rows across 7 global roles (4 self-scoped)', got;
END $$;
