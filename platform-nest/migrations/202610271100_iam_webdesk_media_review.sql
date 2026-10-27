-- 202610271100 — M5-W1q: the `review` permission on the WebDesk media library kind (IAM seed; no DDL).
-- Owner ruling WSK-D84 (docs/blueprints/webdesk-design-v2.md §14): a freelance writer (the `contributor` principal) may upload
-- media, but only INTO A QUARANTINE: the asset is not served until a staff editor accepts it. docs/PERMISSION-CONTRACT.md §27.6.
--
-- WHAT THIS ADDS
--   One catalog permission on the EXISTING Cerbos kind `webdesk_media_asset` (no new kind):
--       webdev.webdesk_media_asset.review   (accept or reject a quarantined upload; MEDIUM in WebDesk, `media.review`)
--   grantable, uiGrantable, NOT sensitive (a MEDIUM, recorded staff decision; the asset is already scanned and stored, and it
--   reaches a public page only through a gated publish, which refuses content that names an unaccepted asset).
--
-- WHICH REACH IS SEEDED (a mechanical transcription of the policy's role-arm ALLOW rules, exactly what `npm run gen:role-bundles`
-- derives; src/rbac/role-permission-bundles.json carries the same six pairs): the SAME role arms as read/upload/update on the kind.
--     platform_admin, company_admin, owner, webdev_manager   (publisher tier + the wildcard; owner MUST mirror company_admin)
--     manager, webdev_staff                                  (the editor tier)
--   member, client, viewer, group_executive: NOTHING. The scoped writers' room `webdesk_editor` reaches `review` through an
--   attribute rule on its grant's site scope row (no bundle and no perm_* mirror, like every writers' room role). The uploader, a
--   contributor, an automation and a bot principal are DENIED by structural rules in the policy whatever they hold.
--
-- RLS / DML NOTE: the only DML is on `permissions` and `role_permissions`, GLOBAL reference tables with no RLS, so the zero-rows
-- trap does not apply. `permissions.id` has no default, so it is supplied explicitly (202608310900's pattern).
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('webdev.webdesk_media_asset.review', 'webdev', 'webdesk_media_asset', 'review',
   'Accept or reject a freelance contributor''s quarantined upload to a WebDesk site''s media library (MEDIUM; WebDesk media.review). Until a staff editor accepts it, WebDesk serves the asset nowhere. Never the uploader, a contributor, an automation or a bot principal (WSK-D84).',
   'webdesk_media_asset', 'review', 'grantable', false, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('platform_admin'), ('company_admin'), ('owner'), ('webdev_manager'), ('manager'), ('webdev_staff')
) AS v(role_name)
JOIN roles r ON r.company_id IS NULL AND r.name = v.role_name
JOIN permissions p ON p.key = 'webdev.webdesk_media_asset.review'
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
);

-- ── Assert, don't assume (202608310900's discipline) ────────────────────────────────────────────
DO $$
DECLARE
  got integer;
BEGIN
  SELECT count(*) INTO got FROM permissions
   WHERE key = 'webdev.webdesk_media_asset.review' AND cerbos_kind = 'webdesk_media_asset' AND cerbos_action = 'review'
     AND class = 'grantable' AND ui_grantable AND NOT sensitive;
  IF got <> 1 THEN
    RAISE EXCEPTION '202610271100: expected exactly 1 webdev.webdesk_media_asset.review permission, found %', got;
  END IF;

  SELECT count(*) INTO got FROM permissions WHERE cerbos_kind = 'webdesk_media_asset' AND class = 'grantable';
  IF got <> 5 THEN
    RAISE EXCEPTION '202610271100: expected 5 webdesk_media_asset permissions, found %', got;
  END IF;

  -- exactly the six named roles hold it, and nobody else (no per-company role, no member/client/viewer/group_executive)
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE p.key = 'webdev.webdesk_media_asset.review';
  IF got <> 6 THEN
    RAISE EXCEPTION '202610271100: expected 6 role_permissions rows for the review key, found %', got;
  END IF;
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE p.key = 'webdev.webdesk_media_asset.review'
     AND NOT (r.company_id IS NULL
              AND r.name IN ('platform_admin', 'company_admin', 'owner', 'webdev_manager', 'manager', 'webdev_staff'));
  IF got <> 0 THEN
    RAISE EXCEPTION '202610271100: the review key is held by % role(s) outside the six staff tiers', got;
  END IF;

  -- the writers' room roles carry no bundle, ever
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
   WHERE r.name IN ('webdesk_writer', 'webdesk_translator', 'webdesk_seo_reviewer', 'webdesk_editor');
  IF got <> 0 THEN
    RAISE EXCEPTION '202610271100: the writers'' room roles must carry no permission bundle, found % row(s)', got;
  END IF;

  -- every global role that holds any action on the kind also holds `read`
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
    RAISE EXCEPTION '202610271100: % role(s) hold a webdesk_media_asset action without `read`', got;
  END IF;

  -- owner ≡ company_admin over the kind, in BOTH directions (equal counts alone would not catch the wrong keys)
  SELECT count(*) INTO got FROM (
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner' AND p.cerbos_kind = 'webdesk_media_asset'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin' AND p.cerbos_kind = 'webdesk_media_asset')
    UNION ALL
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin' AND p.cerbos_kind = 'webdesk_media_asset'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner' AND p.cerbos_kind = 'webdesk_media_asset')
  ) diff;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610271100: owner''s webdesk_media_asset bundle diverges from company_admin''s by % key(s) — owner-role.db.test.ts will fail', got;
  END IF;

  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.cerbos_kind = 'webdesk_media_asset';
  IF got <> 28 THEN
    RAISE EXCEPTION '202610271100: total bundled webdesk_media_asset permissions: expected 28 (22 before + 6), found %', got;
  END IF;

  RAISE NOTICE '202610271100: webdev.webdesk_media_asset.review seeded on 6 roles (% bundled media rows in all)', got;
END $$;
