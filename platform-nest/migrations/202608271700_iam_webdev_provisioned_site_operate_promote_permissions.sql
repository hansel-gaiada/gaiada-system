-- IAM — WSK-31: the `webdev_provisioned_site` kind's two NEW actions, `operate` and `promote`.
--
-- NOT a new resource kind (that would cost the full six coupled artifacts, per this ticket's own
-- brief) — two new ACTIONS on the ALREADY-REGISTERED `webdev_provisioned_site` kind
-- (resource_webdev_provisioned_site.yaml already carries `read`/`provision`/`reconcile` and the full
-- catalog/groups/bundle chain for them). Adding a literal action to an existing kind's rules still
-- trips the IAM-07b static catalog-alignment gate (`cerbos-catalog-alignment.test.ts`, "(b) every
-- literal action ... is a catalogued (kind, action) pair"), which is what this migration and its
-- sibling catalog/groups edits close. In order, mirroring 202608271400's own numbered list:
--   1. `cerbos/policies/resource_webdev_provisioned_site.yaml`  — the policy (this ticket's own edit,
--      additive "operate"/"promote" rules — see that file's own WSK-31 note)
--   2. `src/rbac/permission-catalog.json`                       — the keys (this ticket's own edit)
--   3. `src/rbac/role-permission-bundles.json`                  — GENERATED (npm run gen:role-bundles)
--   4. this migration                                           — the same rows, in the database
--   6. `src/rbac/permission-groups.json`                        — advancedOnly (this ticket's own edit)
--
-- WHY THESE ACTIONS EXIST: the §07 WebDesk control-plane MCP tool set's Zone A authz
-- (`webdesk-control.controller.ts`) — `operate` for the three MEDIUM commands (schema.apply,
-- site.provision, deploy.staging), `promote` for the seven HIGH ones (site.promote/rollback/
-- setDomain, key.mint/rotate/revoke, site.archive). See docs/blueprints/webdesk-design.md §07/§09.
--
-- WHY NOT uiGrantable: the controller behind both actions is an honest 501 stub — WSK-23 (the ERP
-- module egress client into Zone B) has not landed, so there is nothing yet for a human to
-- meaningfully grant this toward. Mirrors `webdev.zoneb_event.record`'s own reasoning
-- (202608271400's migration) exactly.
--
-- DIRECT ROLES ONLY, matching 202608271400's own role list (company_admin, manager, owner,
-- platform_admin) byte-for-byte. The module tiers (`webdev_manager`/`webdev_staff`) are handled
-- DIFFERENTLY from 202608271400's precedent, and that difference is deliberate, not an oversight:
-- `webdev_provisioned_site` already has a LIVE `webdev_manager` bundle (0098) covering its
-- `provision`/`reconcile` actions, generated from the SAME Cerbos `module_manager` rule this ticket
-- extends with `operate`/`promote` (resource_webdev_provisioned_site.yaml's `module_manager` rule
-- now lists all four actions in two rule blocks). Regenerating via `npm run gen:role-bundles`
-- therefore naturally extends `webdev_manager`'s bundle to include `operate`/`promote` too — unlike
-- WSK-12's `webdev_zoneb_event` (a brand-new kind with NO pre-existing module-tier consumer, hence
-- NO_ROLE_SEEDED_KINDS), `webdev_provisioned_site`'s module tiers are already a real, consumed
-- bundle and excluding two of its four module_manager actions from that regeneration would itself be
-- the surprising, undocumented special case. `webdev_staff` gets nothing new — its own Cerbos rule
-- was never widened past `read`.
--
-- `permissions.id` has no default (uuid PRIMARY KEY, no gen_random_uuid()), so it is supplied
-- explicitly, matching 202608271400's own pattern.
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('webdev.provisioned_site.operate', 'webdev', 'provisioned_site', 'operate',
   'Run a WebDesk MEDIUM control-plane command (schema.apply, site.provision, deploy.staging) via the Zone A stub control endpoint.',
   'webdev_provisioned_site', 'operate', 'grantable', true, false),
  ('webdev.provisioned_site.promote', 'webdev', 'provisioned_site', 'promote',
   'Run a WebDesk HIGH control-plane command (site.promote/rollback/setDomain, key.mint/rotate/revoke, site.archive) via the Zone A stub control endpoint. Always WS4-gated regardless of caller.',
   'webdev_provisioned_site', 'promote', 'grantable', true, false)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('company_admin',  'webdev.provisioned_site.operate'),
  ('company_admin',  'webdev.provisioned_site.promote'),

  ('manager',        'webdev.provisioned_site.operate'),
  ('manager',        'webdev.provisioned_site.promote'),

  ('owner',          'webdev.provisioned_site.operate'),
  ('owner',          'webdev.provisioned_site.promote'),

  ('platform_admin', 'webdev.provisioned_site.operate'),
  ('platform_admin', 'webdev.provisioned_site.promote'),

  -- `webdev_manager` (0097/0098): its Cerbos `module_manager` reach on this kind is EXTENDED by
  -- this ticket's own resource_webdev_provisioned_site.yaml edit to include `operate`/`promote`
  -- (same rule that already grants `provision`/`reconcile`, byte-identical `inTenant && notLow`
  -- condition — see that file's own WSK-31 note). `role-permission-parity.db.test.ts` derives its
  -- expectation LIVE from Cerbos, so leaving these two rows out would make that suite fail exactly
  -- where the module_manager rule now says webdev_manager reaches them. `webdev_staff` gets NOTHING
  -- here — its own module_staff rule was never widened past `read`.
  ('webdev_manager', 'webdev.provisioned_site.operate'),
  ('webdev_manager', 'webdev.provisioned_site.promote')
) AS v(role_name, perm_key)
JOIN roles r ON r.company_id IS NULL AND r.name = v.role_name
JOIN permissions p ON p.key = v.perm_key
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
);

-- ── Assert, don't assume (mirrors 0098's own closing block) ────────────────────────────────────
DO $$
DECLARE
  got integer;
BEGIN
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND r.name = 'webdev_manager'
     AND p.key IN ('webdev.provisioned_site.operate', 'webdev.provisioned_site.promote');
  IF got <> 2 THEN
    RAISE EXCEPTION '202608271700: webdev_manager operate/promote bundle: expected 2 rows, found % (missing/typo''d role name or permission key in the JOIN, or a prior partial application)', got;
  END IF;
  RAISE NOTICE '202608271700: operate/promote seeded for company_admin/manager/owner/platform_admin/webdev_manager';
END $$;
