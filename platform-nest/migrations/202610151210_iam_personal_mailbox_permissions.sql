-- IAM — DW-8j: the `personal_mailbox` permission family (docs/FRONTEND-BFF-CONTRACT.md §48, docs/PERMISSION-CONTRACT.md §40), a NEW
-- core Cerbos kind (no module): one person's OWN Gmail, linked to the ERP (connect, read, send). Pure IAM seed: no DDL (the provider CHECKs
-- that admit `google_gmail` are 202610151200's).
--
-- A new Cerbos kind costs six coupled artifacts; this is #5 (copied from 202610151110_iam_calendar_event_permissions.sql).
-- The others, all in the same change:
--   1. cerbos/policies/resource_personal_mailbox.yaml (NO derived role: every rule is self-scoped, so there is no permission arm)
--   2. src/rbac/cerbos.ts            — NO change: `ownerId` was already in Resource and in the resourcePayload() allow-list
--   3. src/rbac/permission-catalog.json  — the 3 keys + _meta counts (110 kinds / 474 pairs / 459 grantable)
--   4. src/rbac/permission-groups.json   — 1 group (`personal_mailbox`) + _meta counts
--   6. scripts/generate-role-bundles.mjs (NO resolver change: the kind names only direct roles, which DIRECT already
--      maps) and src/rbac/role-permission-bundles.json regenerated.
--
-- ── WHICH REACH IS SEEDED (a mechanical transcription of the policy's role-arm ALLOW rules) ──────
--   platform_admin   — all 3 keys (its Cerbos wildcard; 0094's methodology materialises an explicit row per grantable key anyway)
--   company_admin, owner — connect, read, send (owner MUST mirror company_admin exactly: owner-role.db.test.ts; a new
--                      company_admin key does NOT propagate to owner on its own)
--   manager, member  — connect, read, send
--   viewer           — NOTHING: a viewer is a read-only seat, and personal mail is a working tool
--   everything else (client, org_unit_lead, module tiers, ...) — NOTHING
--   NOBODY reaches another person's mailbox, whatever the bundle says: the policy's `roles: ["user"]` EFFECT_DENY on a non-owner beats every
--   ALLOW, the platform_admin wildcard included (PERMISSION-CONTRACT §40).
--
-- ── SELF-SCOPED MARKER ──────────────────────────────────────────────────────────────────────────
-- company_admin, manager and member hold all three keys as SELF-SCOPED pairs: the generator derives the marker from the rule shape, and the only
-- ALLOW rule is the self rule (`ownerId == principal.id`). 9 marked pairs. platform_admin (the wildcard) and owner (no rules of its own, a mirror
-- of company_admin's reach) are NOT marked: the generator does not mark either, and self-scoped-marker-parity.db.test.ts pins this DB to that
-- JSON. The policy's deny is what makes the reach personal for them.
--
-- ── SENSITIVE ─────────────────────────────────────────────────────────────────────────────────
-- None of the three is flagged: each reaches only the holder's own data, and flagging `connect` would route every grant of `member` through
-- the sensitive-grant override path (PERMISSION-CONTRACT §12.2). Owner/architect may tighten this additively.
--
-- `permissions.id` has no default, so it is supplied explicitly. `ui_grantable` is EXPLICIT (0110's default).
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('core.personal_mailbox.connect', 'core', 'personal_mailbox', 'connect',
   'Link or unlink your own Gmail to the ERP. Reached only by the mailbox''s own owner, by Cerbos rule: no role reaches another person''s mailbox, company_admin and platform_admin included. Never granted to a viewer, agents or automation.',
   'personal_mailbox', 'connect', 'grantable', false, true),
  ('core.personal_mailbox.read', 'core', 'personal_mailbox', 'read',
   'Read your own Gmail threads inside the ERP, on demand (nothing is stored). Reached only by the mailbox''s own owner, by Cerbos rule: no role reads another person''s mail. Never granted to a viewer, agents or automation.',
   'personal_mailbox', 'read', 'grantable', false, true),
  ('core.personal_mailbox.send', 'core', 'personal_mailbox', 'send',
   'Send or reply from your own Gmail inside the ERP, including emailing a client you can read. Reached only by the mailbox''s own owner, by Cerbos rule: nobody sends as someone else. Never granted to a viewer, agents or automation.',
   'personal_mailbox', 'send', 'grantable', false, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

INSERT INTO role_permissions (role_id, permission_id, self_scoped)
SELECT r.id, p.id, bundle.self_scoped
FROM (
  -- the wildcard tier and owner (mirroring company_admin): every key, NOT marked (the generator marks neither)
  SELECT f.role_name, k.perm_key, false AS self_scoped
    FROM (VALUES ('platform_admin'), ('owner')) AS f(role_name)
   CROSS JOIN (VALUES
     ('core.personal_mailbox.connect'), ('core.personal_mailbox.read'), ('core.personal_mailbox.send')
   ) AS k(perm_key)
  UNION ALL
  -- the three roles the self rule names: every key, as a SELF-SCOPED pair
  SELECT f.role_name, k.perm_key, true
    FROM (VALUES ('company_admin'), ('manager'), ('member')) AS f(role_name)
   CROSS JOIN (VALUES
     ('core.personal_mailbox.connect'), ('core.personal_mailbox.read'), ('core.personal_mailbox.send')
   ) AS k(perm_key)
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
   WHERE cerbos_kind = 'personal_mailbox' AND class = 'grantable' AND module_key = 'core'
     AND sensitive = false AND ui_grantable = true;
  IF got <> 3 THEN
    RAISE EXCEPTION '202610151210: expected 3 grantable, non-sensitive, ui_grantable personal_mailbox permissions, found %', got;
  END IF;

  FOR expected IN
    SELECT * FROM (VALUES
      ('platform_admin', 3), ('company_admin', 3), ('owner', 3), ('manager', 3), ('member', 3),
      ('viewer', 0),
      ('org_unit_lead', 0), ('client', 0), ('webdev_staff', 0), ('webdev_manager', 0), ('hr_manager', 0), ('hr_staff', 0)
    ) AS x(role_name, expected_count)
  LOOP
    SELECT count(*) INTO got
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND r.name = expected.role_name
       AND p.cerbos_kind = 'personal_mailbox';
    IF got <> expected.expected_count THEN
      RAISE EXCEPTION '202610151210: role "%": expected % bundled personal_mailbox permission(s), found % (missing/typo''d role name or key, or a prior partial application)',
        expected.role_name, expected.expected_count, got;
    END IF;
  END LOOP;

  -- The self-scoped marker: exactly company_admin, manager and member (3 each), and nothing else on this kind.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.cerbos_kind = 'personal_mailbox' AND rp.self_scoped
     AND r.name NOT IN ('company_admin', 'manager', 'member');
  IF got <> 0 THEN
    RAISE EXCEPTION '202610151210: % unexpected self_scoped personal_mailbox row(s)', got;
  END IF;
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.cerbos_kind = 'personal_mailbox' AND rp.self_scoped
     AND r.name IN ('company_admin', 'manager', 'member');
  IF got <> 9 THEN
    RAISE EXCEPTION '202610151210: company_admin, manager and member must hold all 3 personal_mailbox keys self_scoped (found % marked, expected 9)', got;
  END IF;

  -- owner ≡ company_admin, in BOTH directions (equal counts alone would not catch the wrong keys).
  SELECT count(*) INTO got FROM (
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
        AND p.cerbos_kind = 'personal_mailbox'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin'
        AND p.cerbos_kind = 'personal_mailbox')
    UNION ALL
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin'
        AND p.cerbos_kind = 'personal_mailbox'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
        AND p.cerbos_kind = 'personal_mailbox')
  ) diff;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610151210: owner''s personal_mailbox bundle diverges from company_admin''s by % key(s) — owner-role.db.test.ts will fail', got;
  END IF;

  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.cerbos_kind = 'personal_mailbox';
  IF got <> 15 THEN
    RAISE EXCEPTION '202610151210: total bundled personal_mailbox permissions on global roles: expected 15 (5 roles x 3), found %', got;
  END IF;

  RAISE NOTICE '202610151210: role_permissions seeded — % personal_mailbox rows across 5 global roles', got;
END $$;
