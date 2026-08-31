-- IAM — WSK-19: the `webdev_contract_snapshot` permission family.
--
-- A NEW Cerbos kind costs six coupled artifacts (the estate's own standing lesson, paid again by
-- WSK-12 for `webdev_zoneb_event` and caught by IAM-07b's CI gate). In order:
--   1. `cerbos/policies/resource_webdev_contract_snapshot.yaml`  — the policy
--   2. `src/rbac/permission-catalog.json`                        — the keys + _meta.counts
--   3. `src/rbac/permission-groups.json`                         — the authoring layer + counts
--   4. this migration                                            — the same rows, in the database
--   5. `scripts/generate-role-bundles.mjs` +
--      `src/rbac/role-permission-parity.db.test.ts`              — BOTH resolvers (they refuse to
--                                                                   guess; a kind unknown to either
--                                                                   throws by design)
--   6. `src/rbac/role-permission-bundles.json`                   — regenerated via
--                                                                   `npm run gen:role-bundles`,
--                                                                   never hand-edited
-- Every pinned sanity count that (2)/(3) move also gets its OWN note, in:
--   `cerbos-catalog-alignment.test.ts`, `permission-groups-catalog-parity.test.ts`,
--   `ui-grantable-catalog.test.ts`, `iam-215-boundary-pin.test.ts`.
--
-- SCOPE. Unlike `webdev_zoneb_event` (WSK-12, deliberately unseeded at the module tier — no human
-- consumer existed yet), this kind's `refresh` action IS a real console button per
-- webdesk-design.md §08's button matrix ("Refresh contract snapshot | Cerbos webdev:contract:
-- refresh; 🔴 when automation-initiated") and its `read` action backs the same section's "Contract
-- card". The webdev department's own module tier (`webdev_staff`/`webdev_manager`) already exists
-- (0097/0098, seeded for the sibling `webdev_provisioned_site`/`webdev_change_request` kinds), so
-- this migration seeds it too rather than deferring — the Sites tab (WSK-24) not existing yet did
-- not stop 0098 from seeding `webdev_provisioned_site.provision`, and the same reasoning applies
-- here: the ROLE reach should be correct the day the console lands, not discovered as a second gap.
--
-- WHY `refresh` IS SAFE TO GRANT company_admin/manager/webdev_manager DIRECTLY. Refresh recomputes
-- and verifies a content hash and writes an IMMUTABLE audit-pin row (202608271500's own header) —
-- it can never execute anything Zone B produced (D-6) and it cannot silently corrupt an existing
-- pin (the determinism-breach tripwire refuses that, loudly, rather than accepting a differing
-- hash). The action a human triggers here is closer to "verify and record" than "deploy".
--
-- `permissions.id` has no default (uuid PRIMARY KEY, no gen_random_uuid()), so it is supplied
-- explicitly, matching 202608271400's own pattern (itself matching
-- 202608252030_iam_finance_ownership_permissions.sql).
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('webdev.contract_snapshot.read', 'webdev', 'contract_snapshot', 'read',
   'View pinned WebDesk contract snapshots (the Contract card - contract@X.Y vs latest published, per site).',
   'webdev_contract_snapshot', 'read', 'grantable', false, true),
  ('webdev.contract_snapshot.refresh', 'webdev', 'contract_snapshot', 'refresh',
   'Fetch, hash-verify and record a new WebDesk contract snapshot for a site (the one-rail mirror; design section 06).',
   'webdev_contract_snapshot', 'refresh', 'grantable', true, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('company_admin',  'webdev.contract_snapshot.read'),
  ('company_admin',  'webdev.contract_snapshot.refresh'),

  ('manager',        'webdev.contract_snapshot.read'),
  ('manager',        'webdev.contract_snapshot.refresh'),

  ('owner',          'webdev.contract_snapshot.read'),
  ('owner',          'webdev.contract_snapshot.refresh'),

  ('platform_admin', 'webdev.contract_snapshot.read'),
  ('platform_admin', 'webdev.contract_snapshot.refresh'),

  -- The webdev department's own module tier — mirrors 0098's manager/staff split exactly (manager
  -- can act, staff can only read); see resource_webdev_contract_snapshot.yaml's own header.
  ('webdev_staff',   'webdev.contract_snapshot.read'),
  ('webdev_manager', 'webdev.contract_snapshot.read'),
  ('webdev_manager', 'webdev.contract_snapshot.refresh')
) AS v(role_name, perm_key)
JOIN roles r ON r.company_id IS NULL AND r.name = v.role_name
JOIN permissions p ON p.key = v.perm_key
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
);

-- ── Assert, don't assume — same discipline 0098's own closing block applies ─────────────────────
DO $$
DECLARE
  expected record;
  got integer;
  total_got integer;
BEGIN
  FOR expected IN
    SELECT * FROM (VALUES
      ('company_admin', 2), ('manager', 2), ('owner', 2), ('platform_admin', 2),
      ('webdev_staff', 1), ('webdev_manager', 2)
    ) AS x(role_name, expected_count)
  LOOP
    SELECT count(*) INTO got
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND r.name = expected.role_name
       AND p.key IN ('webdev.contract_snapshot.read', 'webdev.contract_snapshot.refresh');
    IF got <> expected.expected_count THEN
      RAISE EXCEPTION '202608271510: role "%": expected % bundled contract_snapshot permission(s), found % (missing/typo''d role name or permission key in the JOIN, or a prior partial application)',
        expected.role_name, expected.expected_count, got;
    END IF;
  END LOOP;

  SELECT count(*) INTO total_got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL
     AND p.key IN ('webdev.contract_snapshot.read', 'webdev.contract_snapshot.refresh');
  IF total_got <> 11 THEN
    RAISE EXCEPTION '202608271510: total bundled contract_snapshot permissions: expected 11, found %', total_got;
  END IF;

  RAISE NOTICE '202608271510: role_permissions seeded — % rows across 6 roles for webdev.contract_snapshot.*', total_got;
END $$;
