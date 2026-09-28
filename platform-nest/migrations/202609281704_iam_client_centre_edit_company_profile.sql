-- 202609281704_iam_client_centre_edit_company_profile.sql — CLIENT-CENTRE CC-D4: the
-- `portal.edit_company_profile` catalog permission + its single (role, permission) bundle pair.
--
-- Design: docs/plans/2026-09-29-client-centre.md (decision log CC-D4). Companion policy:
-- cerbos/policies/resource_portal.yaml's `edit_company_profile` action (added to the `client`
-- role-arm rule) + derived_roles.yaml's `perm_portal_edit_company_profile` mirror. Same idiom as
-- 0106_iam_social_permissions.sql's `portal.approve_post` addition — a new ACTION on the EXISTING
-- `portal` kind, ONE new grantable catalog row, and exactly ONE role gains it: `client`. Nothing
-- else changes — `validateModulePermissions()` does not require this key (the `clients` module's
-- own contract lists only `core.client.*`; `portal.*` permissions are core, not module-owned), so
-- this migration is not boot-gating in the way 0106's social kinds were, but it must still land
-- before the policy ships, or a real `client` grant would resolve a `perms` entry Cerbos already
-- recognises with no catalog row backing it — cerbos-catalog-alignment.test.ts's own alignment
-- guarantee (permission-catalog.json <-> Cerbos policy, zero drift in either direction).
--
-- RLS: `permissions`/`roles`/`role_permissions` are GLOBAL reference tables with no RLS (0093's own
-- conclusion, reasoned identically here) — the NOBYPASSRLS backfill-silence trap does not apply.

-- ── 1 · the catalog permission ──────────────────────────────────────────────────────────────────
INSERT INTO permissions (id, key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description, v.cerbos_kind, v.cerbos_action, v.class, v.sensitive
FROM (VALUES
  ('portal.edit_company_profile', 'portal', 'portal', 'edit_company_profile',
   'Edit your company''s Client Centre profile (CC-D4: an active, client-wide contact with capability signer only).',
   'portal', 'edit_company_profile', 'grantable', true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive)
ON CONFLICT (key) DO UPDATE SET
  module_key = EXCLUDED.module_key,
  resource = EXCLUDED.resource,
  action = EXCLUDED.action,
  description = EXCLUDED.description,
  cerbos_kind = EXCLUDED.cerbos_kind,
  cerbos_action = EXCLUDED.cerbos_action,
  class = EXCLUDED.class,
  sensitive = EXCLUDED.sensitive;

-- ── 2 · the ONE bundle pair — `client` gains `portal.edit_company_profile` ──────────────────────
-- Nobody else: DR-12's staff-read removal on `resource_portal.yaml` is untouched (no
-- company_admin/manager/group_executive rule exists on this kind), and `owner`'s one-time bundle
-- mirror was built from `company_admin` (which holds zero `portal.*` keys), so `owner` does not
-- gain this either — matching every other `portal.*` key's reach exactly (role-permission-
-- bundles.json's own counts, confirmed: only `platform_admin`'s wildcard and `client` hold any
-- `portal.*` key today).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('client', 'portal.edit_company_profile')
) AS v(role_name, perm_key)
JOIN roles r ON r.company_id IS NULL AND r.name = v.role_name
JOIN permissions p ON p.key = v.perm_key
ON CONFLICT DO NOTHING;

-- ── Assert, don't assume ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  got integer;
BEGIN
  SELECT count(*) INTO got FROM permissions
   WHERE key = 'portal.edit_company_profile' AND class = 'grantable' AND module_key = 'portal';
  IF got <> 1 THEN
    RAISE EXCEPTION '202609281704: expected exactly 1 grantable portal.edit_company_profile catalog row, found %', got;
  END IF;

  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND r.name = 'client' AND p.key = 'portal.edit_company_profile';
  IF got <> 1 THEN
    RAISE EXCEPTION '202609281704: expected exactly 1 (client, portal.edit_company_profile) bundle row, found %', got;
  END IF;

  -- No other role picked this up — matches every other portal.* key's exclusivity to `client`
  -- (platform_admin's wildcard is a separate, exempt reach — IAM-04c — not a bundle row here).
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE p.key = 'portal.edit_company_profile' AND r.name <> 'client';
  IF got <> 0 THEN
    RAISE EXCEPTION '202609281704: portal.edit_company_profile leaked to % non-client role row(s)', got;
  END IF;
END $$;
