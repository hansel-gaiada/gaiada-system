-- IAM — PV4-02: the `conversation` permission family (the staff side of the client conversation, a NEW
-- Cerbos kind) and `portal.converse` (the client's door to it, a new action on the EXISTING `portal` kind).
-- Pure IAM seed: no DDL (PV4-01's 202610122330 owns the tables).
--
-- Owner rulings: PV-D22 (one client-wide thread + one per project), PV-D23 (nothing an agent writes reaches a
-- client until a staff member approves it), PV-D24 (viewers post: posting is not signing).
--
-- A new Cerbos kind costs six coupled artifacts; this is #5 (copied from 202610111808_iam_webdev_site_permissions.sql).
-- The others, all in the same change:
--   1. cerbos/policies/resource_conversation.yaml (+ 4 perm_conversation_* derived roles in derived_roles.yaml),
--      and resource_portal.yaml's `converse` action (+ perm_portal_converse)
--   2. src/rbac/cerbos.ts            — NO change: the policy reads only attributes the allow-list already carries
--                                      (`tenantId`, and `principal.attr.kind`, which principalPayload() sends)
--   3. src/rbac/permission-catalog.json  — the 5 keys + _meta counts
--   4. src/rbac/permission-groups.json   — 2 groups (`client_conversation`, `portal_conversation`) + _meta counts
--   6. scripts/generate-role-bundles.mjs (NO resolver change: the kind names only direct roles, which DIRECT
--      already maps) and src/rbac/role-permission-bundles.json regenerated from a clean worktree.
--
-- ── WHICH REACH IS SEEDED (a mechanical transcription of the policy's role-arm ALLOW rules) ──────
--   platform_admin   — all 4 conversation keys + portal.converse (its Cerbos wildcard; 0094's methodology
--                      materialises an explicit row per grantable key anyway, see 202609281704)
--   company_admin, owner, manager, member — read, post, draft, manage
--                      (owner MUST mirror company_admin exactly: owner-role.db.test.ts; a new company_admin key
--                      does NOT propagate to owner on its own. `owner` gets NO portal.* key, same as company_admin.)
--   viewer           — read
--   client           — portal.converse ONLY (never a conversation key: the client derived role appears in the
--                      conversation policy nowhere; its reach to the thread is the portal route's own scope)
--   everything else (group_executive, module tiers, ...) — NOTHING
--
-- ── NOTE ON THE AGENT DENY ─────────────────────────────────────────────────────────────────────
-- `post` and `manage` are DENIED by Cerbos to principal.attr.kind in [automation, bot] regardless of any bundle
-- below (an EFFECT_DENY on roles: ["user"]). The bundle rows say what a ROLE may be granted; they do not and
-- cannot widen an agent, and a bot holding company_admin keeps `draft` and `read`.
--
-- ── SENSITIVE ─────────────────────────────────────────────────────────────────────────────────
-- core.conversation.post and .manage are sensitive (words sent to a client under a person's name; edits to that
-- record). read and draft are not; portal.converse is not (same ground as portal.request_change).
--
-- `permissions.id` has no default, so it is supplied explicitly. `ui_grantable` is EXPLICIT (0110's default would
-- otherwise flip portal.converse to true; portal.* must be false — ui-grantable-catalog.test.ts).
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('core.conversation.read', 'core', 'conversation', 'read',
   'View a client''s conversation threads and messages (staff side).',
   'conversation', 'read', 'grantable', false, true),
  ('core.conversation.post', 'core', 'conversation', 'post',
   'Send a message to a client in a conversation, as yourself. Words a client reads and a named person answers for; never granted to agents or automation.',
   'conversation', 'post', 'grantable', true, true),
  ('core.conversation.draft', 'core', 'conversation', 'draft',
   'Write a draft reply to a client that only staff see, for a person to review and send (the agent-safe half of posting).',
   'conversation', 'draft', 'grantable', false, true),
  ('core.conversation.manage', 'core', 'conversation', 'manage',
   'Close or reopen a client conversation thread, edit its subject, and retract a staff message.',
   'conversation', 'manage', 'grantable', true, true),
  ('portal.converse', 'portal', 'portal', 'converse',
   'Open a thread, post, and edit or retract your own message in the client conversation (any active contact; viewers included — posting is not signing).',
   'portal', 'converse', 'grantable', false, false)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (
  -- the full-reach tier: every conversation key (company_admin's reach, mirrored exactly by owner)
  SELECT f.role_name, k.perm_key
    FROM (VALUES ('platform_admin'), ('company_admin'), ('owner'), ('manager'), ('member')) AS f(role_name)
   CROSS JOIN (VALUES
     ('core.conversation.read'), ('core.conversation.post'), ('core.conversation.draft'), ('core.conversation.manage')
   ) AS k(perm_key)
  UNION ALL
  -- the read tier: see the conversation, nothing that writes
  SELECT 'viewer', 'core.conversation.read'
  UNION ALL
  -- the portal door: the client role's own bundle, and platform_admin's explicit wildcard row
  SELECT e.role_name, 'portal.converse'
    FROM (VALUES ('client'), ('platform_admin')) AS e(role_name)
) AS v(role_name, perm_key)
JOIN roles r ON r.company_id IS NULL AND r.name = v.role_name
JOIN permissions p ON p.key = v.perm_key
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
);

-- ── Assert, don't assume (202608310900's discipline) ────────────────────────────────────────────
DO $$
DECLARE
  expected record;
  got integer;
  total_got integer;
BEGIN
  SELECT count(*) INTO got FROM permissions
   WHERE cerbos_kind = 'conversation' AND class = 'grantable' AND module_key = 'core';
  IF got <> 4 THEN
    RAISE EXCEPTION '202610130010: expected 4 conversation permissions, found %', got;
  END IF;

  SELECT count(*) INTO got FROM permissions
   WHERE key = 'portal.converse' AND class = 'grantable' AND module_key = 'portal'
     AND sensitive = false AND ui_grantable = false;
  IF got <> 1 THEN
    RAISE EXCEPTION '202610130010: expected exactly 1 grantable, non-sensitive, ui_grantable=false portal.converse row, found %', got;
  END IF;

  SELECT count(*) INTO got FROM permissions
   WHERE cerbos_kind = 'conversation' AND sensitive = true AND action IN ('post', 'manage');
  IF got <> 2 THEN
    RAISE EXCEPTION '202610130010: expected conversation post and manage to be sensitive, found % of 2', got;
  END IF;

  FOR expected IN
    SELECT * FROM (VALUES
      ('platform_admin', 4), ('company_admin', 4), ('owner', 4), ('manager', 4), ('member', 4),
      ('viewer', 1),
      ('client', 0), ('group_executive', 0), ('webdev_staff', 0), ('webdev_manager', 0), ('hr_manager', 0)
    ) AS x(role_name, expected_count)
  LOOP
    SELECT count(*) INTO got
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND r.name = expected.role_name
       AND p.cerbos_kind = 'conversation';
    IF got <> expected.expected_count THEN
      RAISE EXCEPTION '202610130010: role "%": expected % bundled conversation permission(s), found % (missing/typo''d role name or key, or a prior partial application)',
        expected.role_name, expected.expected_count, got;
    END IF;
  END LOOP;

  -- portal.converse is held by client and platform_admin and NOBODY else (owner included: company_admin holds
  -- no portal.* key, and owner mirrors company_admin).
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND r.name IN ('client', 'platform_admin') AND p.key = 'portal.converse';
  IF got <> 2 THEN
    RAISE EXCEPTION '202610130010: expected exactly 2 (client|platform_admin, portal.converse) bundle rows, found %', got;
  END IF;
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE p.key = 'portal.converse' AND NOT (r.company_id IS NULL AND r.name IN ('client', 'platform_admin'));
  IF got <> 0 THEN
    RAISE EXCEPTION '202610130010: portal.converse leaked to % other role row(s)', got;
  END IF;

  -- Every global role that holds any action on the kind also holds `read` (no write without read).
  SELECT count(*) INTO got FROM (
    SELECT rp.role_id
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND p.cerbos_kind = 'conversation'
     GROUP BY rp.role_id
    HAVING bool_or(p.action <> 'read')
       AND NOT bool_or(p.action = 'read')
  ) gap;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610130010: % role(s) hold a conversation action without `read`', got;
  END IF;

  -- owner ≡ company_admin, in BOTH directions (equal counts alone would not catch the wrong keys).
  SELECT count(*) INTO got FROM (
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
        AND p.cerbos_kind = 'conversation'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin'
        AND p.cerbos_kind = 'conversation')
    UNION ALL
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin'
        AND p.cerbos_kind = 'conversation'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
        AND p.cerbos_kind = 'conversation')
  ) diff;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610130010: owner''s conversation bundle diverges from company_admin''s by % key(s) — owner-role.db.test.ts will fail', got;
  END IF;

  SELECT count(*) INTO total_got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.cerbos_kind = 'conversation';
  IF total_got <> 21 THEN
    RAISE EXCEPTION '202610130010: total bundled conversation permissions on global roles: expected 21 (5x4 + 1x1), found %', total_got;
  END IF;

  RAISE NOTICE '202610130010: role_permissions seeded — % conversation rows across 6 global roles, plus portal.converse on client + platform_admin', total_got;
END $$;
