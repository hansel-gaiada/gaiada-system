-- IAM — WSK-47: the WebDesk editorial permission family (docs/plans/2026-10-10-webdesk-write-plane-
-- design.md §7; owner ruling WSK-D46, docs/blueprints/webdesk-design-v2.md §14). Two NEW Cerbos kinds:
-- `webdesk_content_item` (8 actions) and `webdesk_collection` (2 actions). Pure IAM seed: no DDL.
--
-- A new Cerbos kind costs six coupled artifacts; this is #5. The others, all in the same change:
--   1. cerbos/policies/resource_webdesk_content_item.yaml, resource_webdesk_collection.yaml
--   2. src/rbac/cerbos.ts            — Resource + resourcePayload(): collectionKey, locale, itemCount
--   3. src/rbac/permission-catalog.json  — the 10 keys + _meta
--   4. src/rbac/permission-groups.json   — 2 groups + 2 advancedOnly (publish, schedule)
--   6. scripts/generate-role-bundles.mjs + src/rbac/role-permission-parity.db.test.ts (both resolvers)
--      and src/rbac/role-permission-bundles.json regenerated from a clean worktree.
--
-- ── WHICH REACH IS SEEDED (a mechanical transcription of the policies' role-arm ALLOW rules) ─────
-- 0094's bundling methodology treats resource-instance conditions as satisfied, so the approval-gated
-- `publish`/`schedule` (approvalId + maker ≠ checker, R4's single-item exception on publish) are
-- bundled onto every role whose ALLOW rule names them — the same convention as GH-03's D14-gated
-- github_repo actions (202608310900). The EFFECT_DENY rules name no derived role and seed nothing.
--
--   platform_admin, company_admin, owner — all 10 (owner MUST mirror company_admin exactly:
--                                          owner-role.db.test.ts; a new company_admin key does NOT
--                                          propagate to owner on its own)
--   manager        — content_item read/create/update/request_publish + collection read (5)
--   webdev_manager — all 10 (the "publisher" tier, design §7's module_manager column)
--   webdev_staff   — content_item read/create/update/request_publish + collection read (5)
--                    (the "editor" tier)
--   member, client, group_executive — NOTHING (neither policy names them)
--
-- `permissions.id` has no default, so it is supplied explicitly (202608310900's pattern).
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('webdev.webdesk_content_item.read', 'webdev', 'webdesk_content_item', 'read',
   'View WebDesk editorial items (drafts, versions, publish state) for a site.',
   'webdesk_content_item', 'read', 'grantable', false, true),
  ('webdev.webdesk_content_item.create', 'webdev', 'webdesk_content_item', 'create',
   'Create a WebDesk editorial item (a draft; nothing a production key can see changes).',
   'webdesk_content_item', 'create', 'grantable', false, true),
  ('webdev.webdesk_content_item.update', 'webdev', 'webdesk_content_item', 'update',
   'Edit a WebDesk editorial item''s draft (a new version; the live projection is unchanged until publish).',
   'webdesk_content_item', 'update', 'grantable', false, true),
  ('webdev.webdesk_content_item.request_publish', 'webdev', 'webdesk_content_item', 'request_publish',
   'Request publication of WebDesk items: files ONE WS4 approval (impact HIGH); publishes nothing by itself.',
   'webdesk_content_item', 'request_publish', 'grantable', false, true),
  ('webdev.webdesk_content_item.publish', 'webdev', 'webdesk_content_item', 'publish',
   'Publish WebDesk items at decide() of an approved WS4 row. approvalId required; maker != checker except a publisher''s own single-item publish (WSK-D46 R4).',
   'webdesk_content_item', 'publish', 'grantable', true, true),
  ('webdev.webdesk_content_item.schedule', 'webdev', 'webdesk_content_item', 'schedule',
   'Schedule a WebDesk publish at decide() of an approved WS4 row. approvalId required; strict maker != checker.',
   'webdesk_content_item', 'schedule', 'grantable', true, true),
  ('webdev.webdesk_content_item.unpublish', 'webdev', 'webdesk_content_item', 'unpublish',
   'Take a published WebDesk item down (MEDIUM, immediate: a takedown does not wait for a second person).',
   'webdesk_content_item', 'unpublish', 'grantable', true, true),
  ('webdev.webdesk_content_item.delete', 'webdev', 'webdesk_content_item', 'delete',
   'Soft-delete a WebDesk editorial item (MEDIUM, immediate).',
   'webdesk_content_item', 'delete', 'grantable', true, true),
  ('webdev.webdesk_collection.read', 'webdev', 'webdesk_collection', 'read',
   'View a WebDesk site''s collections and their compositions (field schemas).',
   'webdesk_collection', 'read', 'grantable', false, true),
  ('webdev.webdesk_collection.apply_schema', 'webdev', 'webdesk_collection', 'apply_schema',
   'Apply a composition (field schema) change to a WebDesk collection over the control channel (schema.apply, MEDIUM).',
   'webdesk_collection', 'apply_schema', 'grantable', true, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (
  -- the full-reach tier: every key of both kinds
  SELECT f.role_name, k.perm_key
    FROM (VALUES ('platform_admin'), ('company_admin'), ('owner'), ('webdev_manager')) AS f(role_name)
   CROSS JOIN (VALUES
     ('webdev.webdesk_content_item.read'), ('webdev.webdesk_content_item.create'),
     ('webdev.webdesk_content_item.update'), ('webdev.webdesk_content_item.request_publish'),
     ('webdev.webdesk_content_item.publish'), ('webdev.webdesk_content_item.schedule'),
     ('webdev.webdesk_content_item.unpublish'), ('webdev.webdesk_content_item.delete'),
     ('webdev.webdesk_collection.read'), ('webdev.webdesk_collection.apply_schema')
   ) AS k(perm_key)
  UNION ALL
  -- the editor tier
  SELECT e.role_name, k.perm_key
    FROM (VALUES ('manager'), ('webdev_staff')) AS e(role_name)
   CROSS JOIN (VALUES
     ('webdev.webdesk_content_item.read'), ('webdev.webdesk_content_item.create'),
     ('webdev.webdesk_content_item.update'), ('webdev.webdesk_content_item.request_publish'),
     ('webdev.webdesk_collection.read')
   ) AS k(perm_key)
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
   WHERE cerbos_kind IN ('webdesk_content_item', 'webdesk_collection') AND class = 'grantable';
  IF got <> 10 THEN
    RAISE EXCEPTION '202610101420: expected 10 webdesk permissions, found %', got;
  END IF;

  FOR expected IN
    SELECT * FROM (VALUES
      ('platform_admin', 10), ('company_admin', 10), ('owner', 10), ('webdev_manager', 10),
      ('manager', 5), ('webdev_staff', 5),
      ('member', 0), ('client', 0), ('group_executive', 0)
    ) AS x(role_name, expected_count)
  LOOP
    SELECT count(*) INTO got
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND r.name = expected.role_name
       AND p.cerbos_kind IN ('webdesk_content_item', 'webdesk_collection');
    IF got <> expected.expected_count THEN
      RAISE EXCEPTION '202610101420: role "%": expected % bundled webdesk permission(s), found % (missing/typo''d role name or key, or a prior partial application)',
        expected.role_name, expected.expected_count, got;
    END IF;
  END LOOP;

  -- owner ≡ company_admin, in BOTH directions (equal counts alone would not catch the wrong keys).
  SELECT count(*) INTO got FROM (
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
        AND p.cerbos_kind IN ('webdesk_content_item', 'webdesk_collection')
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin'
        AND p.cerbos_kind IN ('webdesk_content_item', 'webdesk_collection'))
    UNION ALL
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin'
        AND p.cerbos_kind IN ('webdesk_content_item', 'webdesk_collection')
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
        AND p.cerbos_kind IN ('webdesk_content_item', 'webdesk_collection'))
  ) diff;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610101420: owner''s webdesk bundle diverges from company_admin''s by % key(s) — owner-role.db.test.ts will fail', got;
  END IF;

  SELECT count(*) INTO total_got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.cerbos_kind IN ('webdesk_content_item', 'webdesk_collection');
  IF total_got <> 50 THEN
    RAISE EXCEPTION '202610101420: total bundled webdesk permissions: expected 50, found %', total_got;
  END IF;

  RAISE NOTICE '202610101420: role_permissions seeded — % rows across 6 roles for webdev.webdesk_*', total_got;
END $$;
