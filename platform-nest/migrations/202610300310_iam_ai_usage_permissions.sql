-- IAM — AIP-15: the `ai_usage` permission family (docs/PERMISSION-CONTRACT.md §58, docs/FRONTEND-BFF-CONTRACT.md §66; owner rulings AIP-D6,
-- AIP-D18, and the AIP-D16 owner-only pattern), a NEW core Cerbos kind (no module): who sees and manages the company's AI usage record.
-- Pure IAM seed: no DDL (202610300300 owns the column; 202610271800 the table).
--
-- A new Cerbos kind costs six coupled artifacts; this is #5 (copied from 202610291510_iam_dept_assistant_preamble_permissions.sql). The
-- others, all in the same change:
--   1. cerbos/policies/resource_ai_usage.yaml (+ derived_roles.yaml: the seat `ai_usage_gm_seat` and four perm_ai_usage_* mirrors for
--      read_own, read_company, read_people and manage; NO read_unit / lift_stop mirror, see the policy header)
--   2. src/rbac/cerbos.ts            — `gmIds` added to Resource AND to the resourcePayload() allow-list (unitAncestors was already there)
--   3. src/rbac/permission-catalog.json  — the 6 keys + _meta counts (115 kinds / 508 pairs / 493 grantable)
--   4. src/rbac/permission-groups.json   — 1 group (`ai_usage`) + _meta counts
--   6. scripts/generate-role-bundles.mjs (DIRECT: ai_usage_gm_seat -> no real role; OWNER_EXTENSION: + read_people, manage) and
--      src/rbac/role-permission-bundles.json regenerated; role-permission-parity.db.test.ts's DIRECT kept byte-aligned.
--
-- ── THE KEYS (`core.<kind>.<action>`, AIP-13b's naming) ───────────────────────────────────────────
--   core.ai_usage.read_own      — the caller's own figures            (company_admin, manager, member, viewer by rule; owner by mirror)
--   core.ai_usage.read_unit     — one unit's totals AND people        (org_unit_lead on its own rule over the unit's subtree; no mirror)
--   core.ai_usage.read_company  — company totals, no people           (company_admin by rule; the GM seat (no key); owner by mirror)
--   core.ai_usage.read_people   — per-person lines in EVERY unit      (OWNER ONLY: OWNER_EXTENSION, uiGrantable false; mirror only)
--   core.ai_usage.manage        — budgets, allowances, lift any stop  (OWNER ONLY: OWNER_EXTENSION, uiGrantable false; mirror only)
--   core.ai_usage.lift_stop     — lift one unit's soft stop           (org_unit_lead on its own rule; no mirror)
--
-- ── WHICH REACH IS SEEDED (a mechanical transcription of the policy's role-arm ALLOW rules, plus OWNER_EXTENSION) ──
--   platform_admin   — all 6 keys (its Cerbos wildcard; 0094's methodology materialises an explicit row per grantable key anyway)
--   company_admin    — read_own, read_company (NOT read_people, NOT manage: AIP-D18 gives company admins totals only)
--   owner            — company_admin's two + OWNER_EXTENSION's two = read_own, read_company, read_people, manage
--                      (owner == company_admin's envelope + OWNER_EXTENSION EXACTLY: owner-role.db.test.ts; asserted below over EVERY key)
--   manager, member, viewer — read_own
--   org_unit_lead    — read_unit, lift_stop (its own rule per action, over the unit's subtree)
--   the GM           — NOTHING seeded: a seat (`gmIds`), not a grant (DIRECT maps ai_usage_gm_seat to no real role)
--   everything else (hr_*, client, module tiers, ...) — NOTHING
--
-- ── SELF-SCOPED MARKER ──────────────────────────────────────────────────────────────────────────
-- None. No rule on this kind compares a resource attribute to the caller's id: `read_own`'s "only my rows" is the ROUTE's
-- `user_id = caller` (a member's key opens nothing but their own line), and the head's rules are containment in the unit's ancestry.
--
-- ── SENSITIVE ─────────────────────────────────────────────────────────────────────────────────
-- None of the six is flagged. The record holds counts and money, never text. read_people and manage cannot be granted by anyone
-- (uiGrantable false), so the sensitive-grant override path (PERMISSION-CONTRACT §12.2) has nothing to route; flagging read_unit or
-- lift_stop would route every department-head grant of org_unit_lead through it. Owner/architect may tighten this additively.
--
-- RLS / DML NOTE: the only DML is on `permissions` and `role_permissions`, GLOBAL reference tables with no RLS, so the zero-row trap does
-- not apply. Both INSERTs are idempotent (NOT EXISTS / ON CONFLICT), so the file re-runs.
-- `permissions.id` has no default, so it is supplied explicitly. `ui_grantable` is EXPLICIT (0110's default).
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('core.ai_usage.read_own', 'core', 'ai_usage', 'read_own',
   'See your OWN AI usage in the company: your calls, tokens and cost this month, by surface and by day. Counts and money only, never any text. Every staff member holds it (company_admin, manager, member, viewer by Cerbos rule; the owner through the permission arm); the route reads only rows whose person is the caller, so it never shows a peer (owner ruling AIP-D18).',
   'ai_usage', 'read_own', 'grantable', false, true),
  ('core.ai_usage.read_unit', 'core', 'ai_usage', 'read_unit',
   'See one department''s AI usage, its totals AND its per-person lines (counts and money only, never any text). Reached, by Cerbos rule, by the department head over their own unit''s subtree only (org_unit_lead; owner ruling AIP-D6). No permission-arm mirror: a flat mirror would let a head read every unit.',
   'ai_usage', 'read_unit', 'grantable', false, true),
  ('core.ai_usage.read_company', 'core', 'ai_usage', 'read_company',
   'See the company''s AI usage totals by department, model, surface and day, with NO per-person lines (counts and money only). company_admin by Cerbos rule, the GM through the live seat of the company''s GM unit, the owner through the permission arm (owner ruling AIP-D18). Never needed by agents.',
   'ai_usage', 'read_company', 'grantable', false, true),
  ('core.ai_usage.read_people', 'core', 'ai_usage', 'read_people',
   'See the per-person AI usage lines in EVERY department of the company (counts and money only, never any text). The owner only (owner rulings AIP-D6 and AIP-D18): held through OWNER_EXTENSION and the permission arm, never by company_admin, and not UI-grantable, so no role edit or position hands it out. The superadmin reaches it through the wildcard.',
   'ai_usage', 'read_people', 'grantable', false, false),
  ('core.ai_usage.manage', 'core', 'ai_usage', 'manage',
   'Manage the company''s AI spending: department budgets and their mode, the company alert figure, per-person reply allowances, and lifting any soft stop (routes arrive with AIP-17b and AIP-18). The owner only (AIP-D7, AIP-D9): held through OWNER_EXTENSION and the permission arm, not UI-grantable. Never held by agents or automation (a Cerbos DENY).',
   'ai_usage', 'manage', 'grantable', false, false),
  ('core.ai_usage.lift_stop', 'core', 'ai_usage', 'lift_stop',
   'Lift one department''s AI soft stop for the rest of the month (AIP-18, AIP-D8). Reached, by Cerbos rule, by the department head over their own unit''s subtree only (org_unit_lead). The owner lifts any stop through manage. Never held by agents or automation (a Cerbos DENY).',
   'ai_usage', 'lift_stop', 'grantable', false, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

INSERT INTO role_permissions (role_id, permission_id, self_scoped)
SELECT r.id, p.id, false
FROM (VALUES
  -- the superadmin: every key (its wildcard)
  ('platform_admin', 'core.ai_usage.read_own'), ('platform_admin', 'core.ai_usage.read_unit'), ('platform_admin', 'core.ai_usage.read_company'),
  ('platform_admin', 'core.ai_usage.read_people'), ('platform_admin', 'core.ai_usage.manage'), ('platform_admin', 'core.ai_usage.lift_stop'),
  -- company admins: their own line and the company totals, never people, never manage (AIP-D18)
  ('company_admin', 'core.ai_usage.read_own'), ('company_admin', 'core.ai_usage.read_company'),
  -- the owner: company_admin's envelope + OWNER_EXTENSION's two owner-only keys
  ('owner', 'core.ai_usage.read_own'), ('owner', 'core.ai_usage.read_company'),
  ('owner', 'core.ai_usage.read_people'), ('owner', 'core.ai_usage.manage'),
  -- every other staff member: their own line
  ('manager', 'core.ai_usage.read_own'), ('member', 'core.ai_usage.read_own'), ('viewer', 'core.ai_usage.read_own'),
  -- a department head: their own unit's subtree (totals and people) and its soft stop
  ('org_unit_lead', 'core.ai_usage.read_unit'), ('org_unit_lead', 'core.ai_usage.lift_stop')
) AS bundle(role_name, perm_key)
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
   WHERE cerbos_kind = 'ai_usage' AND class = 'grantable' AND module_key = 'core' AND NOT sensitive;
  IF got <> 6 THEN
    RAISE EXCEPTION '202610300310: expected 6 grantable, non-sensitive ai_usage permissions, found %', got;
  END IF;
  SELECT count(*) INTO got FROM permissions
   WHERE cerbos_kind = 'ai_usage' AND NOT ui_grantable AND key IN ('core.ai_usage.read_people', 'core.ai_usage.manage');
  IF got <> 2 THEN
    RAISE EXCEPTION '202610300310: core.ai_usage.read_people and core.ai_usage.manage must be ui_grantable = false, found % of 2', got;
  END IF;
  SELECT count(*) INTO got FROM permissions WHERE cerbos_kind = 'ai_usage' AND ui_grantable;
  IF got <> 4 THEN
    RAISE EXCEPTION '202610300310: expected the other 4 ai_usage permissions ui_grantable = true, found %', got;
  END IF;

  FOR expected IN
    SELECT * FROM (VALUES
      ('platform_admin', 6), ('company_admin', 2), ('owner', 4), ('org_unit_lead', 2),
      ('manager', 1), ('member', 1), ('viewer', 1), ('hr_staff', 0), ('hr_manager', 0),
      ('client', 0), ('reports_staff', 0), ('reports_manager', 0), ('webdev_staff', 0), ('webdev_manager', 0)
    ) AS x(role_name, expected_count)
  LOOP
    SELECT count(*) INTO got
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND r.name = expected.role_name
       AND p.cerbos_kind = 'ai_usage';
    IF got <> expected.expected_count THEN
      RAISE EXCEPTION '202610300310: role "%": expected % bundled ai_usage permission(s), found % (missing/typo''d role name or key, or a prior partial application)',
        expected.role_name, expected.expected_count, got;
    END IF;
  END LOOP;

  -- read_people and manage: platform_admin and owner ONLY, on any role at all (a custom role included).
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE p.key IN ('core.ai_usage.read_people', 'core.ai_usage.manage')
     AND NOT (r.company_id IS NULL AND r.name IN ('platform_admin', 'owner'));
  IF got <> 0 THEN
    RAISE EXCEPTION '202610300310: core.ai_usage.read_people / manage leaked to % row(s) outside platform_admin and owner', got;
  END IF;

  -- read_unit and lift_stop: platform_admin and org_unit_lead only (a flat mirror does not exist for them; a holder elsewhere would be a
  -- bundle the policy does not grant).
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.key IN ('core.ai_usage.read_unit', 'core.ai_usage.lift_stop')
     AND r.name NOT IN ('platform_admin', 'org_unit_lead');
  IF got <> 0 THEN
    RAISE EXCEPTION '202610300310: core.ai_usage.read_unit / lift_stop leaked to % row(s) outside platform_admin and org_unit_lead', got;
  END IF;

  -- No self-scoped marker on this kind.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
   WHERE p.cerbos_kind = 'ai_usage' AND rp.self_scoped;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610300310: % unexpected self_scoped ai_usage row(s)', got;
  END IF;

  -- owner == company_admin + OWNER_EXTENSION, EXACTLY, over EVERY key (owner-role.db.test.ts's rule). The list is byte-aligned with
  -- scripts/generate-role-bundles.mjs OWNER_EXTENSION. Both directions: owner minus company_admin must be exactly the extension, and
  -- company_admin minus owner must be empty.
  SELECT count(*) INTO got FROM (
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin')
    EXCEPT
    SELECT k FROM (VALUES
      ('assistant.brain.choose_provider'), ('core.ai_usage.manage'), ('core.ai_usage.read_people'),
      ('social.engagement.budget'), ('social.engagement.plan'), ('social.post.approve'),
      ('social.report.approve'), ('social.report.deliver')
    ) AS ext(k)
  ) extra;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610300310: owner holds % key(s) that are neither company_admin''s nor in OWNER_EXTENSION — owner-role.db.test.ts will fail', got;
  END IF;
  SELECT count(*) INTO got FROM (
    SELECT k FROM (VALUES
      ('assistant.brain.choose_provider'), ('core.ai_usage.manage'), ('core.ai_usage.read_people'),
      ('social.engagement.budget'), ('social.engagement.plan'), ('social.post.approve'),
      ('social.report.approve'), ('social.report.deliver')
    ) AS ext(k)
    EXCEPT
    SELECT p.key FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND r.name = 'owner'
  ) missing;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610300310: owner lacks % OWNER_EXTENSION key(s) — owner-role.db.test.ts will fail', got;
  END IF;
  SELECT count(*) INTO got FROM (
    SELECT p.key FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND r.name = 'company_admin'
    EXCEPT
    SELECT p.key FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND r.name = 'owner'
  ) short;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610300310: owner lacks % of company_admin''s key(s) — owner-role.db.test.ts will fail', got;
  END IF;
  -- And no OWNER_EXTENSION key is company_admin's (else the extension would hide a widened company_admin).
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND r.name = 'company_admin'
     AND p.key IN ('core.ai_usage.manage', 'core.ai_usage.read_people');
  IF got <> 0 THEN
    RAISE EXCEPTION '202610300310: company_admin must not hold core.ai_usage.read_people or manage, found %', got;
  END IF;

  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.cerbos_kind = 'ai_usage';
  IF got <> 17 THEN
    RAISE EXCEPTION '202610300310: total bundled ai_usage permissions on global roles: expected 17 (6 + 2 + 4 + 2 + 3), found %', got;
  END IF;

  RAISE NOTICE '202610300310: role_permissions seeded — % ai_usage rows across 7 global roles', got;
END $$;
