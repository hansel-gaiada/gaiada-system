-- IAM — PV3-01: catalogue `core.contract.countersign` (docs/plans/2026-10-11-pv3-hub-symmetry-tickets.md, PV3-01;
-- plan trap 7). Pure IAM seed on the global reference tables: no DDL, no tenant rows.
--
-- WHY THIS KEY EXISTS AT ALL. resource_contract.yaml now names `countersign` as a literal action (the company-owner
-- rule: `roles: ["user"]`, an `owner` grant at company scope ON the contract's tenant). Every literal policy action
-- must be a catalogued (kind, action) pair (src/rbac/cerbos-catalog-alignment.test.ts (b)), so the pair is
-- catalogued. The key is NOT a way to reach countersign:
--   * no `perm_contract_countersign` derived role and no permission-arm rule names it, so holding the key grants
--     nothing through Cerbos (a custom role holding every `core.contract.*` key is still refused);
--   * `ui_grantable = false`, so no UI-built role can carry it (0110's guard and assertRoleUiGrantable());
--   * `sensitive = true`: it binds the company to a contract.
--
-- WHICH BUNDLE HOLDS IT (a mechanical transcription of what scripts/generate-role-bundles.mjs derives):
--   platform_admin — YES, only because its `*` rule is wildcard-expanded against the kind's catalog universe.
--   company_admin  — NO. Countersigning is deliberately excluded from company_admin (the recorded intent).
--   owner          — NO. Owner's bundle is derived as exactly company_admin's (owner-role.db.test.ts), and the
--                    owner rule reads the `owner` GRANT, not perms, so the bundle row would add nothing.
--   every other role — NO.
--
-- `permissions.id` has no default, so it is supplied explicitly (202608310900's pattern).
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), 'core.contract.countersign', 'core', 'contract', 'countersign',
       'Countersign a client contract on behalf of the company. Reached ONLY through the Cerbos owner rule (an owner grant on the contract''s company) or the platform_admin wildcard; holding this key grants nothing (no perm-arm rule).',
       'contract', 'countersign', 'grantable', true, false
 WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE key = 'core.contract.countersign');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.key = 'core.contract.countersign'
 WHERE r.company_id IS NULL AND r.name = 'platform_admin'
   AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id);

-- ── Assert, don't assume ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  got integer;
BEGIN
  SELECT count(*) INTO got FROM permissions
   WHERE key = 'core.contract.countersign' AND class = 'grantable' AND cerbos_kind = 'contract'
     AND cerbos_action = 'countersign' AND sensitive AND NOT ui_grantable;
  IF got <> 1 THEN
    RAISE EXCEPTION '202610112330: expected 1 core.contract.countersign (grantable, sensitive, not ui_grantable), found %', got;
  END IF;

  SELECT count(*) INTO got FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
   WHERE p.key = 'core.contract.countersign' AND r.company_id IS NULL AND r.name = 'platform_admin';
  IF got <> 1 THEN
    RAISE EXCEPTION '202610112330: expected platform_admin to hold core.contract.countersign once, found %', got;
  END IF;

  -- No other role, global or tenant-defined, holds it. A custom role that already carried it would be a role
  -- someone hand-wrote; refuse rather than leave it in place.
  SELECT count(*) INTO got FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
   WHERE p.key = 'core.contract.countersign' AND NOT (r.company_id IS NULL AND r.name = 'platform_admin');
  IF got <> 0 THEN
    RAISE EXCEPTION '202610112330: core.contract.countersign is held by % role row(s) other than platform_admin', got;
  END IF;
END $$;
