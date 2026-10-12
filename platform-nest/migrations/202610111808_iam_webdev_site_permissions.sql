-- IAM — M6-P3c: the `webdev_site` permission family (the `webdev_sites` portfolio registry's OWN Cerbos
-- kind). One NEW kind, 4 actions: read, create, update, request_probe_consent. Pure IAM seed: no DDL.
--
-- BEHAVIOUR-PRESERVING. Until this change the registry's routes borrowed `webdev_provisioned_site`'s
-- actions (webdev.controller.ts / console-reads.controller.ts). Each new action replaces exactly one
-- borrowed action and must reach exactly the principals the old one reached:
--     webdev_provisioned_site.read       -> webdev_site.read, webdev_site.request_probe_consent
--     webdev_provisioned_site.provision  -> webdev_site.create
--     webdev_provisioned_site.operate    -> webdev_site.update
-- Nothing on `webdev_provisioned_site` changes; it keeps serving the provisioning routes.
--
-- A new Cerbos kind costs six coupled artifacts; this is #5. The others, all in the same change:
--   1. cerbos/policies/resource_webdev_site.yaml  (+ 3 perm_webdev_site_* derived roles in
--                                                  derived_roles.yaml: read/create/request_probe_consent)
--   2. src/rbac/cerbos.ts            — NO change needed: the policy reads only attributes the allow-list
--                                      already carries (`tenantId`, `module`); `Resource.kind` is a plain string
--   3. src/rbac/permission-catalog.json  — the 4 keys + _meta counts
--   4. src/rbac/permission-groups.json   — 1 group (`webdev_site_registry`) + _meta counts
--   6. scripts/generate-role-bundles.mjs + src/rbac/role-permission-parity.db.test.ts (both resolvers)
--      and src/rbac/role-permission-bundles.json regenerated from a clean worktree.
--
-- ── WHICH REACH IS SEEDED (a mechanical transcription of the policy's role-arm ALLOW rules) ──────
--   platform_admin, company_admin, owner, manager, webdev_manager — all 4
--                                          (owner MUST mirror company_admin exactly: owner-role.db.test.ts;
--                                          a new company_admin key does NOT propagate to owner on its own)
--   webdev_staff   — read, request_probe_consent (module_staff; the old kind gave staff `read` only, and
--                    the probe-consent route was gated on `read`)
--   member, client, group_executive — NOTHING (the policy names none of them)
--
-- ── CUSTOM / COMPANY-SCOPED ROLES (the permission-mirror arm) ───────────────────────────────────
-- The old kind had B12 mirror arms on `read` and `provision` (not `operate`). A role holding
-- `webdev.provisioned_site.read` / `.provision` therefore reached the registry routes through the mirror.
-- To keep that reach, every role (global or company-scoped) holding an old key is given the new key(s)
-- it replaces. `webdev.provisioned_site.operate` has no mirror, so there is nothing to carry for `update`.
--
-- `permissions.id` has no default, so it is supplied explicitly (202608310900's pattern).
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('webdev.site.read', 'webdev', 'site', 'read',
   'View the webdev_sites portfolio registry: the estate portfolio (every site we know of, hosted or not) and one registry row.',
   'webdev_site', 'read', 'grantable', false, true),
  ('webdev.site.create', 'webdev', 'site', 'create',
   'Add a site to the webdev_sites portfolio registry (POST sites). Registry rows carry hosting topology; a manager-tier write.',
   'webdev_site', 'create', 'grantable', true, true),
  ('webdev.site.update', 'webdev', 'site', 'update',
   'Set or clear a registry site''s vault_ref credential pointer (PATCH sites/:id). Touches only the pointer, never a credential value.',
   'webdev_site', 'update', 'grantable', true, true),
  ('webdev.site.request_probe_consent', 'webdev', 'site', 'request_probe_consent',
   'File a probe-consent request for a client domain from the portfolio. Grants nothing: a holder of the search authority decides it.',
   'webdev_site', 'request_probe_consent', 'grantable', false, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (
  -- the full-reach tier: every key of the kind
  SELECT f.role_name, k.perm_key
    FROM (VALUES ('platform_admin'), ('company_admin'), ('owner'), ('manager'), ('webdev_manager')) AS f(role_name)
   CROSS JOIN (VALUES
     ('webdev.site.read'), ('webdev.site.create'), ('webdev.site.update'), ('webdev.site.request_probe_consent')
   ) AS k(perm_key)
  UNION ALL
  -- the staff tier: read and ask for consent, nothing that writes
  SELECT e.role_name, k.perm_key
    FROM (VALUES ('webdev_staff')) AS e(role_name)
   CROSS JOIN (VALUES
     ('webdev.site.read'), ('webdev.site.request_probe_consent')
   ) AS k(perm_key)
) AS v(role_name, perm_key)
JOIN roles r ON r.company_id IS NULL AND r.name = v.role_name
JOIN permissions p ON p.key = v.perm_key
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
);

-- Carry the mirror-arm reach: any role (custom / company-scoped included) holding an old key gets the
-- new key(s) that replace it. Idempotent.
INSERT INTO role_permissions (role_id, permission_id)
SELECT DISTINCT rp_old.role_id, p_new.id
FROM role_permissions rp_old
JOIN permissions p_old ON p_old.id = rp_old.permission_id
JOIN (VALUES
  ('webdev.provisioned_site.read',      'webdev.site.read'),
  ('webdev.provisioned_site.read',      'webdev.site.request_probe_consent'),
  ('webdev.provisioned_site.provision', 'webdev.site.create')
) AS m(old_key, new_key) ON m.old_key = p_old.key
JOIN permissions p_new ON p_new.key = m.new_key
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions x WHERE x.role_id = rp_old.role_id AND x.permission_id = p_new.id
);

-- ── Assert, don't assume (202608310900's discipline) ────────────────────────────────────────────
DO $$
DECLARE
  expected record;
  got integer;
  total_got integer;
BEGIN
  SELECT count(*) INTO got FROM permissions
   WHERE cerbos_kind = 'webdev_site' AND class = 'grantable';
  IF got <> 4 THEN
    RAISE EXCEPTION '202610111808: expected 4 webdev_site permissions, found %', got;
  END IF;

  FOR expected IN
    SELECT * FROM (VALUES
      ('platform_admin', 4), ('company_admin', 4), ('owner', 4), ('manager', 4), ('webdev_manager', 4),
      ('webdev_staff', 2),
      ('member', 0), ('client', 0), ('group_executive', 0)
    ) AS x(role_name, expected_count)
  LOOP
    SELECT count(*) INTO got
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND r.name = expected.role_name
       AND p.cerbos_kind = 'webdev_site';
    IF got <> expected.expected_count THEN
      RAISE EXCEPTION '202610111808: role "%": expected % bundled webdev_site permission(s), found % (missing/typo''d role name or key, or a prior partial application)',
        expected.role_name, expected.expected_count, got;
    END IF;
  END LOOP;

  -- Every global role that holds any action on the kind also holds `read`.
  SELECT count(*) INTO got FROM (
    SELECT rp.role_id
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND p.cerbos_kind = 'webdev_site'
     GROUP BY rp.role_id
    HAVING bool_or(p.action <> 'read')
       AND NOT bool_or(p.action = 'read')
  ) gap;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610111808: % role(s) hold a webdev_site action without `read`', got;
  END IF;

  -- owner ≡ company_admin, in BOTH directions (equal counts alone would not catch the wrong keys).
  SELECT count(*) INTO got FROM (
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
        AND p.cerbos_kind = 'webdev_site'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin'
        AND p.cerbos_kind = 'webdev_site')
    UNION ALL
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin'
        AND p.cerbos_kind = 'webdev_site'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
        AND p.cerbos_kind = 'webdev_site')
  ) diff;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610111808: owner''s webdev_site bundle diverges from company_admin''s by % key(s) — owner-role.db.test.ts will fail', got;
  END IF;

  -- Behaviour preservation: no role that held an old key is left without the key that replaces it.
  -- `update` is role-arm only (the old `operate` had no mirror), so only GLOBAL roles are expected to
  -- carry it; a company-scoped role holding `operate` is not a gap.
  SELECT count(*) INTO got FROM (
    SELECT rp.role_id, m.new_key
      FROM role_permissions rp
      JOIN permissions po ON po.id = rp.permission_id
      JOIN (VALUES
        ('webdev.provisioned_site.read',      'webdev.site.read'),
        ('webdev.provisioned_site.read',      'webdev.site.request_probe_consent'),
        ('webdev.provisioned_site.provision', 'webdev.site.create'),
        ('webdev.provisioned_site.operate',   'webdev.site.update')
      ) AS m(old_key, new_key) ON m.old_key = po.key
     WHERE NOT EXISTS (
       SELECT 1 FROM role_permissions x JOIN permissions pn ON pn.id = x.permission_id
        WHERE x.role_id = rp.role_id AND pn.key = m.new_key)
       AND (m.new_key <> 'webdev.site.update'
            OR EXISTS (SELECT 1 FROM roles rr WHERE rr.id = rp.role_id AND rr.company_id IS NULL))
  ) lost;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610111808: % (role, replacement key) pair(s) would lose reach the old webdev_provisioned_site key gave', got;
  END IF;

  SELECT count(*) INTO total_got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.cerbos_kind = 'webdev_site';
  IF total_got <> 22 THEN
    RAISE EXCEPTION '202610111808: total bundled webdev_site permissions on global roles: expected 22 (5x4 + 1x2), found %', total_got;
  END IF;

  RAISE NOTICE '202610111808: role_permissions seeded — % rows across 6 global roles for webdev.site.*', total_got;
END $$;
