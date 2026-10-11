-- IAM — WSK-43b: the WebDesk media library permission family (docs/plans/2026-10-11-webdesk-m3-plan.md
-- "WSK-43 · The media library"; owner rulings WSK-D53/D54, docs/blueprints/webdesk-design-v2.md §14). One NEW
-- Cerbos kind: `webdesk_media_asset` (4 actions: read, upload, update, delete). Pure IAM seed: no DDL.
--
-- A new Cerbos kind costs six coupled artifacts; this is #5. The others, all in the same change:
--   1. cerbos/policies/resource_webdesk_media_asset.yaml
--   2. src/rbac/cerbos.ts            — NO change needed: the policy reads only attributes the allow-list
--                                      already carries (`tenantId`, `module`); `Resource.kind` is a plain string
--   3. src/rbac/permission-catalog.json  — the 4 keys + _meta counts (re-derived from the array)
--   4. src/rbac/permission-groups.json   — 1 group (`webdesk_media_library`) + _meta counts
--   6. scripts/generate-role-bundles.mjs + src/rbac/role-permission-parity.db.test.ts (both resolvers)
--      and src/rbac/role-permission-bundles.json regenerated from a clean worktree.
--
-- ── WHICH REACH IS SEEDED (a mechanical transcription of the policy's role-arm ALLOW rules) ──────
-- The policy mirrors resource_webdesk_content_item.yaml: an editor tier (read/upload/update <- content
-- read/create/update) and a publisher tier (delete <- content delete). No approval id, no maker-checker.
--
--   platform_admin, company_admin, owner — all 4 (owner MUST mirror company_admin exactly:
--                                          owner-role.db.test.ts; a new company_admin key does NOT
--                                          propagate to owner on its own)
--   webdev_manager — all 4 (the "publisher" tier, module_manager)
--   manager        — read/upload/update (3)  (the editor tier; `manager` cannot delete, as it cannot
--                                             delete a content item)
--   webdev_staff   — read/upload/update (3)  (module_staff)
--   member, client, group_executive — NOTHING (the policy names none of them)
--
-- `read` is bundled onto every role that holds any other action on the kind (a role that could act but
-- not list is a gap this repo has hit before); the final assertion pins that as an invariant.
--
-- `permissions.id` has no default, so it is supplied explicitly (202608310900's pattern).
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('webdev.webdesk_media_asset.read', 'webdev', 'webdesk_media_asset', 'read',
   'View a WebDesk site''s media library (list assets, read where an asset is used).',
   'webdesk_media_asset', 'read', 'grantable', false, true),
  ('webdev.webdesk_media_asset.upload', 'webdev', 'webdesk_media_asset', 'upload',
   'Start a WebDesk media upload: mints a single-use upload token; the browser then uploads straight to WebDesk, the bytes never pass through the ERP.',
   'webdesk_media_asset', 'upload', 'grantable', false, true),
  ('webdev.webdesk_media_asset.update', 'webdev', 'webdesk_media_asset', 'update',
   'Edit a WebDesk media asset''s title, alt text and tags (MEDIUM).',
   'webdesk_media_asset', 'update', 'grantable', false, true),
  ('webdev.webdesk_media_asset.delete', 'webdev', 'webdesk_media_asset', 'delete',
   'Soft-delete a WebDesk media asset (MEDIUM). Refused with 409 media-in-use while any content uses it (WSK-D54).',
   'webdesk_media_asset', 'delete', 'grantable', true, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (
  -- the full-reach tier: every key of the kind
  SELECT f.role_name, k.perm_key
    FROM (VALUES ('platform_admin'), ('company_admin'), ('owner'), ('webdev_manager')) AS f(role_name)
   CROSS JOIN (VALUES
     ('webdev.webdesk_media_asset.read'), ('webdev.webdesk_media_asset.upload'),
     ('webdev.webdesk_media_asset.update'), ('webdev.webdesk_media_asset.delete')
   ) AS k(perm_key)
  UNION ALL
  -- the editor tier
  SELECT e.role_name, k.perm_key
    FROM (VALUES ('manager'), ('webdev_staff')) AS e(role_name)
   CROSS JOIN (VALUES
     ('webdev.webdesk_media_asset.read'), ('webdev.webdesk_media_asset.upload'),
     ('webdev.webdesk_media_asset.update')
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
   WHERE cerbos_kind = 'webdesk_media_asset' AND class = 'grantable';
  IF got <> 4 THEN
    RAISE EXCEPTION '202610111030: expected 4 webdesk_media_asset permissions, found %', got;
  END IF;

  FOR expected IN
    SELECT * FROM (VALUES
      ('platform_admin', 4), ('company_admin', 4), ('owner', 4), ('webdev_manager', 4),
      ('manager', 3), ('webdev_staff', 3),
      ('member', 0), ('client', 0), ('group_executive', 0)
    ) AS x(role_name, expected_count)
  LOOP
    SELECT count(*) INTO got
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND r.name = expected.role_name
       AND p.cerbos_kind = 'webdesk_media_asset';
    IF got <> expected.expected_count THEN
      RAISE EXCEPTION '202610111030: role "%": expected % bundled webdesk_media_asset permission(s), found % (missing/typo''d role name or key, or a prior partial application)',
        expected.role_name, expected.expected_count, got;
    END IF;
  END LOOP;

  -- Every global role that holds any action on the kind also holds `read` (a role that can upload but not
  -- list is the gap this repo has hit before).
  SELECT count(*) INTO got FROM (
    SELECT rp.role_id
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND p.cerbos_kind = 'webdesk_media_asset'
     GROUP BY rp.role_id
    HAVING bool_or(p.action <> 'read')
       AND NOT bool_or(p.action = 'read')
  ) gap;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610111030: % role(s) hold a webdesk_media_asset action without `read`', got;
  END IF;

  -- owner ≡ company_admin, in BOTH directions (equal counts alone would not catch the wrong keys).
  SELECT count(*) INTO got FROM (
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
        AND p.cerbos_kind = 'webdesk_media_asset'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin'
        AND p.cerbos_kind = 'webdesk_media_asset')
    UNION ALL
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin'
        AND p.cerbos_kind = 'webdesk_media_asset'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
        AND p.cerbos_kind = 'webdesk_media_asset')
  ) diff;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610111030: owner''s webdesk_media_asset bundle diverges from company_admin''s by % key(s) — owner-role.db.test.ts will fail', got;
  END IF;

  SELECT count(*) INTO total_got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.cerbos_kind = 'webdesk_media_asset';
  IF total_got <> 22 THEN
    RAISE EXCEPTION '202610111030: total bundled webdesk_media_asset permissions: expected 22 (4x4 + 2x3), found %', total_got;
  END IF;

  RAISE NOTICE '202610111030: role_permissions seeded — % rows across 6 roles for webdev.webdesk_media_asset.*', total_got;
END $$;
