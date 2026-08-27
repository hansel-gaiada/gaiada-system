-- IAM — WSK-12: the `webdev_zoneb_event` permission family.
--
-- Fourth of the coupled artifacts a new Cerbos kind requires. In order:
--   1. `cerbos/policies/resource_webdev_zoneb_event.yaml`     — the policy
--   2. `src/rbac/permission-catalog.json`                     — the keys
--   3. `src/rbac/role-permission-bundles.json`                — GENERATED from (1) + (2)
--   4. this migration                                         — the same rows, in the database
--   5. `scripts/generate-role-bundles.mjs`                    — the resolver (it refuses to guess)
--   6. `src/rbac/permission-groups.json`                      — the authoring layer
--
-- (5) is the one that bites: the generator threw `unhandled module_manager kind
-- "webdev_zoneb_event"` rather than silently mapping it to no role, which would have produced a
-- bundle that looked complete and granted nobody anything.
--
-- SCOPE NOTE. Only the four DIRECT roles are armed here. The module tiers (`module_manager` /
-- `module_staff`) are deliberately NOT role-seeded — `webdev_zoneb_event` is listed in the
-- generator's NO_ROLE_SEEDED_KINDS with the reason: the Sites tab (WSK-24) that would read this
-- log is unbuilt, so there is no human consumer yet. Revisit at WSK-24.
--
-- WHY `record` IS SAFE TO GRANT A HUMAN. A recorded fact can at most raise a notification and a
-- log row. It can never cause a deploy, promote, key operation or schema change — those originate
-- only in Zone A behind WS4 (design section 03). Mirrors resource_webdev_provisioned_site.yaml.

-- `permissions.id` has no default (uuid PRIMARY KEY, no gen_random_uuid()), so it is supplied
-- explicitly, matching 202608252030_iam_finance_ownership_permissions.sql's own pattern.
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('webdev.zoneb_event.read', 'webdev', 'zoneb_event', 'read',
   'Read the Zone B (WebDesk) signed-fact log - what the website platform reported.',
   'webdev_zoneb_event', 'read', 'grantable', false, true),
  ('webdev.zoneb_event.record', 'webdev', 'zoneb_event', 'record',
   'Record a Zone B signed fact (idempotent). A recorded fact can at most raise a notification and a log row.',
   'webdev_zoneb_event', 'record', 'grantable', true, false)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('company_admin',  'webdev.zoneb_event.read'),
  ('company_admin',  'webdev.zoneb_event.record'),

  ('manager',        'webdev.zoneb_event.read'),
  ('manager',        'webdev.zoneb_event.record'),

  ('owner',          'webdev.zoneb_event.read'),
  ('owner',          'webdev.zoneb_event.record'),

  ('platform_admin', 'webdev.zoneb_event.read'),
  ('platform_admin', 'webdev.zoneb_event.record')
) AS v(role_name, perm_key)
JOIN roles r ON r.company_id IS NULL AND r.name = v.role_name
JOIN permissions p ON p.key = v.perm_key
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
);
