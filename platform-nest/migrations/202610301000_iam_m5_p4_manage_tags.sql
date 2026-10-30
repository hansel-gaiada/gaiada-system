-- IAM — M5-P4 (WSK-D92): one new SENSITIVE action on the EXISTING Cerbos kind resource_search_property. Pure IAM seed on the
-- global reference tables: no DDL, no tenant rows, no new kind.
--
--   search.property.manage_tags  resource_search_property  manage_tags  grantable, sensitive, ui_grantable
--
-- It sets a website's tracking tags through the ERP (today: the LinkedIn partner id, stored as a GitHub Actions repository
-- variable that the site's next rebuild reads). The value is public (it ends up in the site's HTML), but the write changes
-- what the site ships, so it is a manager-tier action. Plain search staff keep `read`, which lets them SEE the value.
--
-- Cerbos (cerbos/policies/resource_search_property.yaml): the role arm is module_manager (search_manager) and the served
-- company's company_admin, in tenant, the same tier and conditions as read_visitors / view_replay (202610131730). The perm arm
-- is one mirror (perm_resource_search_property_manage_tags), which is also how the permission-native `owner` reaches it.
--
-- WHICH BUNDLE HOLDS WHAT (a mechanical transcription of what scripts/generate-role-bundles.mjs derives from the policy):
--   platform_admin (wildcard), company_admin, search_manager (module_manager), owner (= company_admin's set)
--   NOT held by search_staff, manager, member, viewer, org_unit_lead, client, webdev_*, or any other module tier.
--
-- `owner` is not auto-derived in the database (202608221409's one-time snapshot), so it is mirrored explicitly, as 202610131730
-- does. `permissions.id` has no default, so it is supplied. Idempotent: ON CONFLICT (key) is a metadata sync and never churns
-- the id that role_permissions rows reference.
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, 'grantable', true, true
FROM (VALUES
  ('search.property.manage_tags', 'search', 'property', 'manage_tags',
   'Set a website''s tracking tags through the ERP (today: the LinkedIn partner id, stored as a repository variable the site''s next rebuild reads). Held by search managers and company admins; plain search staff can see the value but not change it.',
   'resource_search_property', 'manage_tags')
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action)
ON CONFLICT (key) DO UPDATE SET
  module_key    = EXCLUDED.module_key,
  resource      = EXCLUDED.resource,
  action        = EXCLUDED.action,
  description   = EXCLUDED.description,
  cerbos_kind   = EXCLUDED.cerbos_kind,
  cerbos_action = EXCLUDED.cerbos_action,
  class         = EXCLUDED.class,
  sensitive     = EXCLUDED.sensitive,
  ui_grantable  = EXCLUDED.ui_grantable;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('platform_admin', 'search.property.manage_tags'),
  ('company_admin',  'search.property.manage_tags'),
  ('search_manager', 'search.property.manage_tags'),
  ('owner',          'search.property.manage_tags')
) AS v(role_name, perm_key)
JOIN roles r ON r.company_id IS NULL AND r.name = v.role_name
JOIN permissions p ON p.key = v.perm_key
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
);

-- ── Assert, don't assume ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  got integer;
BEGIN
  SELECT count(*) INTO got FROM permissions
   WHERE key = 'search.property.manage_tags' AND class = 'grantable'
     AND cerbos_kind = 'resource_search_property' AND cerbos_action = 'manage_tags'
     AND sensitive = true AND ui_grantable = true;
  IF got <> 1 THEN
    RAISE EXCEPTION '202610301000: expected 1 search.property.manage_tags (grantable, sensitive, ui_grantable on resource_search_property.manage_tags), found %', got;
  END IF;

  -- The exact holder set, in BOTH directions: the four global roles that must hold it do, and no other role row (global or
  -- company-defined) holds it.
  SELECT count(*) INTO got FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
   WHERE p.key = 'search.property.manage_tags' AND r.company_id IS NULL
     AND r.name IN ('platform_admin', 'company_admin', 'search_manager', 'owner');
  IF got <> 4 THEN
    RAISE EXCEPTION '202610301000: search.property.manage_tags should be held by 4 global roles (platform_admin, company_admin, search_manager, owner), found %', got;
  END IF;

  SELECT count(*) INTO got FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
   WHERE p.key = 'search.property.manage_tags'
     AND NOT (r.company_id IS NULL AND r.name IN ('platform_admin', 'company_admin', 'search_manager', 'owner'));
  IF got <> 0 THEN
    RAISE EXCEPTION '202610301000: search.property.manage_tags is held by % role row(s) outside its expected set (search_staff must never hold it)', got;
  END IF;

  -- owner stays equal to company_admin on this key, in both directions (owner-role.db.test.ts's invariant).
  SELECT count(*) INTO got FROM (
    SELECT
      (SELECT count(*) FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
        WHERE r.company_id IS NULL AND r.name = 'owner' AND p.key = 'search.property.manage_tags') AS owner_n,
      (SELECT count(*) FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
        WHERE r.company_id IS NULL AND r.name = 'company_admin' AND p.key = 'search.property.manage_tags') AS admin_n
  ) c WHERE owner_n <> admin_n;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610301000: owner''s bundle diverges from company_admin''s on search.property.manage_tags — owner-role.db.test.ts will fail';
  END IF;
END $$;
