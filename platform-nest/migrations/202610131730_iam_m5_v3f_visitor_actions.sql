-- IAM — M5-V3-f: two new SENSITIVE actions on the EXISTING Cerbos kind resource_search_property
-- (docs/plans/2026-10-12-m5-phase5-design.md §4.8, §6.3, O5). Pure IAM seed on the global reference tables:
-- no DDL, no tenant rows, no new kind.
--
--   search.property.read_visitors  resource_search_property  read_visitors  grantable, sensitive, ui_grantable
--   search.property.view_replay    resource_search_property  view_replay    grantable, sensitive, ui_grantable
--
-- Both are personal data of identified website visitors (consented visitor profiles, V3; our own sampled session
-- replay, V6). They are two keys on purpose: a recording is more intrusive than a profile, so each can be granted
-- without the other, and neither is implied by `search.property.read`.
--
-- Cerbos (cerbos/policies/resource_search_property.yaml): the role arm is module_manager (search_manager) and the
-- served company's company_admin, in tenant; plain module_staff keeps aggregate `read` only. The perm arm is one
-- mirror per key (perm_resource_search_property_read_visitors / _view_replay), so a holder of the key reaches exactly
-- that action. That mirror is also how the permission-native `owner` reaches them.
--
-- WHICH BUNDLE HOLDS WHAT (a mechanical transcription of what scripts/generate-role-bundles.mjs derives from the policy):
--   both keys   platform_admin (wildcard), company_admin, search_manager (module_manager), owner (= company_admin's set)
--   NOT held by search_staff, manager, member, viewer, org_unit_lead, client, webdev_*, or any other module tier.
--
-- `owner` is not auto-derived in the database (202608221409's one-time snapshot), so every migration landing new
-- company_admin keys mirrors them onto owner explicitly, as below (202608221728's note). `permissions.id` has no
-- default, so it is supplied. Idempotent: ON CONFLICT (key) is a metadata sync and never churns the id that
-- role_permissions rows reference.
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, 'grantable', true, true
FROM (VALUES
  ('search.property.read_visitors', 'search', 'property', 'read_visitors',
   'View consented website-visitor profiles for a property: the visitor list, timelines, interests, score parts and the visitor-ingest status. Personal data. Held by search managers and company admins; plain search staff keep aggregate read only.',
   'resource_search_property', 'read_visitors'),
  ('search.property.view_replay', 'search', 'property', 'view_replay',
   'Watch a recorded website-visitor session (our own sampled replay). A separate right from read_visitors: a recording is more intrusive than a profile, and every viewing is audited. Personal data. Held by search managers and company admins.',
   'resource_search_property', 'view_replay')
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
  ('platform_admin', 'search.property.read_visitors'),
  ('company_admin',  'search.property.read_visitors'),
  ('search_manager', 'search.property.read_visitors'),
  ('owner',          'search.property.read_visitors'),
  ('platform_admin', 'search.property.view_replay'),
  ('company_admin',  'search.property.view_replay'),
  ('search_manager', 'search.property.view_replay'),
  ('owner',          'search.property.view_replay')
) AS v(role_name, perm_key)
JOIN roles r ON r.company_id IS NULL AND r.name = v.role_name
JOIN permissions p ON p.key = v.perm_key
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
);

-- ── Assert, don't assume ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  expected record;
  got integer;
BEGIN
  FOR expected IN
    SELECT * FROM (VALUES
      ('search.property.read_visitors', 'read_visitors'),
      ('search.property.view_replay',   'view_replay')
    ) AS x(perm_key, action)
  LOOP
    SELECT count(*) INTO got FROM permissions
     WHERE key = expected.perm_key AND class = 'grantable'
       AND cerbos_kind = 'resource_search_property' AND cerbos_action = expected.action
       AND sensitive = true AND ui_grantable = true;
    IF got <> 1 THEN
      RAISE EXCEPTION '202610131730: expected 1 % (grantable, sensitive, ui_grantable on resource_search_property.%), found %',
        expected.perm_key, expected.action, got;
    END IF;

    -- The exact holder set, in BOTH directions: the four global roles that must hold it do, and no other role row
    -- (global or company-defined) holds it. A hand-written custom role that already carried a key is refused
    -- rather than left in place.
    SELECT count(*) INTO got FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
     WHERE p.key = expected.perm_key AND r.company_id IS NULL
       AND r.name IN ('platform_admin', 'company_admin', 'search_manager', 'owner');
    IF got <> 4 THEN
      RAISE EXCEPTION '202610131730: % should be held by 4 global roles (platform_admin, company_admin, search_manager, owner), found %',
        expected.perm_key, got;
    END IF;

    SELECT count(*) INTO got FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
     WHERE p.key = expected.perm_key
       AND NOT (r.company_id IS NULL AND r.name IN ('platform_admin', 'company_admin', 'search_manager', 'owner'));
    IF got <> 0 THEN
      RAISE EXCEPTION '202610131730: % is held by % role row(s) outside its expected set (search_staff must never hold it)', expected.perm_key, got;
    END IF;
  END LOOP;

  -- owner stays equal to company_admin across the two keys, in both directions (owner-role.db.test.ts's invariant).
  SELECT count(*) INTO got FROM (
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
        AND p.key IN ('search.property.read_visitors', 'search.property.view_replay')
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin'
        AND p.key IN ('search.property.read_visitors', 'search.property.view_replay'))
    UNION ALL
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin'
        AND p.key IN ('search.property.read_visitors', 'search.property.view_replay')
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
        AND p.key IN ('search.property.read_visitors', 'search.property.view_replay'))
  ) diff;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610131730: owner''s bundle diverges from company_admin''s by % of the 2 new key(s) — owner-role.db.test.ts will fail', got;
  END IF;
END $$;
