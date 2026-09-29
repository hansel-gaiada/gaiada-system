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
-- `ui_grantable` is EXPLICIT (not left to its `DEFAULT true`, 0110) — matching every migration
-- since P2-03's idiom (e.g. 202609051010's agency_lead/agency_discovery_submission rows). Omitting
-- it here shipped false: the DB defaulted the new row to true while permission-catalog.json said
-- false, and iam-phase2-ui-grantable-guard.test.ts caught the drift immediately (full parity, not a
-- spot sample) — a real regression this migration's first cut had, fixed before landing.
INSERT INTO permissions (id, key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description, v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('portal.edit_company_profile', 'portal', 'portal', 'edit_company_profile',
   'Edit your company''s Client Centre profile (CC-D4: an active, client-wide contact with capability signer only).',
   'portal', 'edit_company_profile', 'grantable', true, false)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
ON CONFLICT (key) DO UPDATE SET
  module_key = EXCLUDED.module_key,
  resource = EXCLUDED.resource,
  action = EXCLUDED.action,
  description = EXCLUDED.description,
  cerbos_kind = EXCLUDED.cerbos_kind,
  cerbos_action = EXCLUDED.cerbos_action,
  class = EXCLUDED.class,
  sensitive = EXCLUDED.sensitive,
  ui_grantable = EXCLUDED.ui_grantable;

-- ── 2 · the bundle pairs — `client` gains it (the real authorization reach), and `platform_admin`
--       gets its own EXPLICIT row too ─────────────────────────────────────────────────────────────
-- `platform_admin` reaches every action via its Cerbos WILDCARD rule (`actions:["*"]`), never via a
-- `role_permissions` row read at request time — but 0094's own seeding methodology (confirmed by
-- 0106's "platform_admin +36" line, the exact same shape this migration follows) materializes an
-- EXPLICIT row per grantable permission for `platform_admin` anyway, because
-- `assemblePrincipal()`'s `perms` resolution (src/rbac/principal.ts, IAM-03a) reads `role_permissions`
-- literally — it does not re-derive the wildcard from Cerbos policy. Omitting this row does not
-- change any AUTHORIZATION decision (Cerbos's wildcard rule still grants the action regardless of
-- what `perms` contains), but it desyncs `role-permission-bundles.json` (a static, wildcard-expanded
-- artifact) from the live table three ways at once — role-permission-bundles.db.test.ts,
-- role-permission-parity.db.test.ts and principal-permissions.db.test.ts each caught this
-- independently when this migration's first cut omitted it. `owner`'s one-time bundle mirror was
-- built from `company_admin` (which holds zero `portal.*` keys), so `owner` does not gain this —
-- matching every other `portal.*` key's reach exactly.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('client', 'portal.edit_company_profile'),
  ('platform_admin', 'portal.edit_company_profile')
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
   WHERE key = 'portal.edit_company_profile' AND class = 'grantable' AND module_key = 'portal'
     AND ui_grantable = false;
  IF got <> 1 THEN
    RAISE EXCEPTION '202609281704: expected exactly 1 grantable, ui_grantable=false portal.edit_company_profile catalog row, found %', got;
  END IF;

  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND r.name IN ('client', 'platform_admin') AND p.key = 'portal.edit_company_profile';
  IF got <> 2 THEN
    RAISE EXCEPTION '202609281704: expected exactly 2 (client|platform_admin, portal.edit_company_profile) bundle rows, found %', got;
  END IF;

  -- No OTHER role picked this up — matches every other portal.* key's exclusivity to
  -- client + platform_admin.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE p.key = 'portal.edit_company_profile' AND r.name NOT IN ('client', 'platform_admin');
  IF got <> 0 THEN
    RAISE EXCEPTION '202609281704: portal.edit_company_profile leaked to % other role row(s)', got;
  END IF;
END $$;
