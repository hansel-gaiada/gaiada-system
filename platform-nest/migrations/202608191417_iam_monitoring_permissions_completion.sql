-- IAM · complete the `monitoring` permission catalog — the 5 actions 0117 never seeded.
--
-- ── WHY THIS EXISTS (a real, live gap, not tidying) ───────────────────────────────────────────────
-- 0117 seeded 9 grantable permissions. The Cerbos policies (resource_monitor{,_incident,_maintenance,
-- _channel}.yaml, resource_status_page.yaml) name 14 literal actions. Five had a policy rule and NO
-- catalog row:
--     monitor_incident::read · monitor_maintenance::read · monitor_maintenance::delete
--     status_page::read      · status_page::update
--
-- Two of those five are asked for by code that is ALREADY IN PRODUCTION —
-- monitoring.controller.ts authorizes `monitor_incident::read` (the incidents list) and
-- `monitor_maintenance::read` (the detail route's window lookup). So this is not a future-feature
-- placeholder: the running platform authorizes against pairs the catalog does not describe.
--
-- It was caught by `cerbos-catalog-alignment.test.ts` (CI, static) and by
-- `permission-catalog.db.test.ts` (which needs DATABASE_URL_TEST and therefore SKIPS in CI — the DB
-- half of the drift was invisible to the pipeline and only appeared on a local run with a test DB).
--
-- ── AND A SECOND, LARGER GAP THE SAME PASS FOUND ─────────────────────────────────────────────────
-- 0117 seeded bundles for company_admin/platform_admin/monitoring_manager/monitoring_staff and gave
-- `manager` and `group_executive` NOTHING, though every monitoring policy names them. Cerbos was
-- allowing a plain manager all 14 actions with the DB mirror recording zero. 19 rows below fix it.
--
-- ── THE INVARIANT THIS RESTORES ───────────────────────────────────────────────────────────────────
-- `permissions` row count must equal permission-catalog.json's entry count, because 0093 seeds the
-- catalog and every later module migration adds its own rows to BOTH sides. 0117 moved only one side:
--     before this migration   DB 293 / catalog 284   (and sensitive 105 / 102)
--     after  this migration   DB 298 / catalog 298   (and sensitive 106 / 106)
--
-- ── NOTE ON 0117's SELF-CHECK ─────────────────────────────────────────────────────────────────────
-- 0117 asserted `n_perms <> 9` / `n_bundle <> 32`. Those numbers are correct at 0117's point in the
-- sequence and it never re-runs here (the ledger is by name). They are relaxed to floors in that file
-- so a deliberate manual re-run cannot raise on account of THIS migration's additions — the same
-- reasoning permission-catalog.db.test.ts records for its own derived counts: an exact-count tripwire
-- that fires on correct growth is a false alarm, not a guard.

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 1. The 5 missing catalog permissions. Same shape and ON CONFLICT policy as 0117, so a re-run is a
--    metadata sync and never churns an `id` that role_permissions references.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
INSERT INTO permissions (id, key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description, v.cerbos_kind, v.cerbos_action, v.class, v.sensitive
FROM (VALUES
  -- Reading incidents is separate from reading monitors: the incident record is the outage history,
  -- and a report-only or status-page-only principal may legitimately hold one without the other.
  ('monitoring.incident.read', 'monitoring', 'incident', 'read',
   'View monitoring incidents, open and closed.', 'monitor_incident', 'read', 'grantable', false),

  ('monitoring.maintenance.read', 'monitoring', 'maintenance', 'read',
   'View scheduled maintenance windows.', 'monitor_maintenance', 'read', 'grantable', false),

  -- NOT sensitive, unlike maintenance.create. Creating a window suppresses alerting and SLA math and
  -- can therefore hide a real outage; cancelling one ENDS suppression early. The asymmetry is the
  -- point — the sensitive direction is the one that conceals.
  ('monitoring.maintenance.delete', 'monitoring', 'maintenance', 'delete',
   'Cancel a maintenance window. Ends suppression early; it cannot hide an outage.', 'monitor_maintenance', 'delete', 'grantable', false),

  ('monitoring.status_page.read', 'monitoring', 'status_page', 'read',
   'View status-page configuration inside the ERP.', 'status_page', 'read', 'grantable', false),

  -- SENSITIVE, for the same reason as publish. On an ALREADY-published page, adding a monitor to the
  -- selection changes what is readable with NO session and without a second publish action, so this
  -- is an exposure path in its own right rather than a mere edit.
  ('monitoring.status_page.update', 'monitoring', 'status_page', 'update',
   'Edit a status page, including which monitors it exposes. On a published page this changes what is readable WITHOUT authentication.', 'status_page', 'update', 'grantable', true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive)
ON CONFLICT (key) DO UPDATE SET
  module_key    = EXCLUDED.module_key,
  resource      = EXCLUDED.resource,
  action        = EXCLUDED.action,
  description   = EXCLUDED.description,
  cerbos_kind   = EXCLUDED.cerbos_kind,
  cerbos_action = EXCLUDED.cerbos_action,
  class         = EXCLUDED.class,
  sensitive     = EXCLUDED.sensitive;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 2. Bundles. MIRRORS THE CERBOS ROLE ARM EXACTLY — re-read from the policy files, not assumed:
--      module_staff   : maintenance READ only, status_page READ only  (no delete, no update)
--      module_manager : all five
--      company_admin  : all five   (its rule set equals module_manager's on all 5 kinds)
--      platform_admin : all five   (actions: ["*"])
--      manager        : all 14     (shares company_admin's derivedRoles list in every policy)
--      group_executive: the 5 READS only (its rule grants `read` and is not inTenant-gated)
--    A bundle wider than the policy would be a lie the UI reads as reach; narrower would deny a
--    principal the policy allows once the permission arm lands.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('company_admin',     'monitoring.incident.read'),
  ('company_admin',     'monitoring.maintenance.read'),
  ('company_admin',     'monitoring.maintenance.delete'),
  ('company_admin',     'monitoring.status_page.read'),
  ('company_admin',     'monitoring.status_page.update'),

  ('platform_admin',    'monitoring.incident.read'),
  ('platform_admin',    'monitoring.maintenance.read'),
  ('platform_admin',    'monitoring.maintenance.delete'),
  ('platform_admin',    'monitoring.status_page.read'),
  ('platform_admin',    'monitoring.status_page.update'),

  ('monitoring_manager','monitoring.incident.read'),
  ('monitoring_manager','monitoring.maintenance.read'),
  ('monitoring_manager','monitoring.maintenance.delete'),
  ('monitoring_manager','monitoring.status_page.read'),
  ('monitoring_manager','monitoring.status_page.update'),

  ('monitoring_staff',  'monitoring.incident.read'),
  ('monitoring_staff',  'monitoring.maintenance.read'),
  ('monitoring_staff',  'monitoring.status_page.read'),

  -- ── `manager` and `group_executive`: 0117 GAVE THESE TWO ROLES NOTHING AT ALL ──────────────────
  -- Found by role-permission-parity.db.test.ts, which derives each role's reach from the live Cerbos
  -- policy and compares it to the seeded bundle. Every monitoring policy file carries
  -- `derivedRoles: ["company_admin", "manager"]` and a read rule for `group_executive`, but 0117's
  -- bundles named only company_admin/platform_admin/monitoring_manager/monitoring_staff. So Cerbos
  -- allowed a plain `manager` all 14 actions while the DB bundle recorded zero — the mirror
  -- understating the authority by an entire role. That gap matters twice over: the UI reads bundles
  -- to decide what to show, and the permission arm (still to land) will read them to decide access.
  ('manager',           'monitoring.monitor.read'),
  ('manager',           'monitoring.monitor.create'),
  ('manager',           'monitoring.monitor.update'),
  ('manager',           'monitoring.monitor.delete'),
  ('manager',           'monitoring.incident.read'),
  ('manager',           'monitoring.incident.acknowledge'),
  ('manager',           'monitoring.maintenance.read'),
  ('manager',           'monitoring.maintenance.create'),
  ('manager',           'monitoring.maintenance.delete'),
  ('manager',           'monitoring.channel.read'),
  ('manager',           'monitoring.channel.manage'),
  ('manager',           'monitoring.status_page.read'),
  ('manager',           'monitoring.status_page.update'),
  ('manager',           'monitoring.status_page.publish'),

  -- group_executive is READ-ONLY across all five kinds, and its rule is NOT gated on inTenant (it is
  -- the cross-company holding view) — so this list must stay reads and nothing else.
  ('group_executive',   'monitoring.monitor.read'),
  ('group_executive',   'monitoring.incident.read'),
  ('group_executive',   'monitoring.maintenance.read'),
  ('group_executive',   'monitoring.channel.read'),
  ('group_executive',   'monitoring.status_page.read')
) AS bundle(role_name, perm_key)
JOIN roles r ON r.company_id IS NULL AND r.name = bundle.role_name
JOIN permissions p ON p.key = bundle.perm_key
ON CONFLICT DO NOTHING;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 2b. The shared-service seam, mirroring `social` exactly (checked against the live estate:
--     social_staff holds core.member.read + core.service_assignment.read, social_manager holds
--     core.service_assignment.read).
--
--     WHY IT IS NEEDED: monitoring is a servable module, so a monitoring_staff principal in a SERVED
--     company legitimately resolves `service_assignment` / `member` resources whose attr.module is
--     "monitoring" — the module_staff derived role activates on exactly that string. Cerbos already
--     allows it; without these rows the DB bundle understates that reach, and because BOTH sides of
--     role-permission-parity would agree on the understatement it would never be flagged. These are
--     CORE permissions, so they are deliberately outside the `module_key = 'monitoring'` self-check
--     counts above and are asserted separately below.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('monitoring_staff',  'core.member.read'),
  ('monitoring_staff',  'core.service_assignment.read'),
  ('monitoring_manager','core.service_assignment.read')
) AS bundle(role_name, perm_key)
JOIN roles r ON r.company_id IS NULL AND r.name = bundle.role_name
JOIN permissions p ON p.key = bundle.perm_key
ON CONFLICT DO NOTHING;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 3. Self-check. Floors, not equalities, so a later legitimate addition cannot make this raise.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  n_perms  integer;
  n_bundle integer;
  n_orphan integer;
  n_core   integer;
BEGIN
  SELECT count(*) INTO n_perms FROM permissions WHERE module_key = 'monitoring' AND class = 'grantable';
  IF n_perms < 14 THEN
    RAISE EXCEPTION 'monitoring: expected at least 14 grantable catalog permissions, found %', n_perms;
  END IF;

  SELECT count(*) INTO n_bundle
  FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
  WHERE p.module_key = 'monitoring';
  IF n_bundle < 69 THEN
    RAISE EXCEPTION 'monitoring: expected at least 69 role->permission pairs (32 from 0117 + 37 here), found %', n_bundle;
  END IF;

  -- The check that actually matters: every (cerbos_kind, cerbos_action) the policies can decide on
  -- must now have a row. Asserted as "the 5 this migration adds resolved", so a JOIN that silently
  -- matched nothing (no such role name, for instance) fails loudly here instead of shipping a role
  -- that looks configured and grants nothing.
  SELECT count(*) INTO n_orphan
  FROM (VALUES ('monitor_incident','read'), ('monitor_maintenance','read'), ('monitor_maintenance','delete'),
               ('status_page','read'), ('status_page','update')) AS want(k, a)
  WHERE NOT EXISTS (
    SELECT 1 FROM permissions p WHERE p.cerbos_kind = want.k AND p.cerbos_action = want.a
  );
  IF n_orphan <> 0 THEN
    RAISE EXCEPTION 'monitoring: % policy action(s) still have no catalog row', n_orphan;
  END IF;

  -- The shared-service rows. A JOIN that matched no role would leave a monitoring_staff principal in
  -- a SERVED company unable to see the assignment that grants it the module at all.
  SELECT count(*) INTO n_core
  FROM role_permissions rp
  JOIN roles r ON r.id = rp.role_id AND r.company_id IS NULL
  JOIN permissions p ON p.id = rp.permission_id
  WHERE r.name IN ('monitoring_staff','monitoring_manager')
    AND p.key IN ('core.member.read','core.service_assignment.read');
  IF n_core <> 3 THEN
    RAISE EXCEPTION 'monitoring: expected 3 shared-service core grants, found %', n_core;
  END IF;

  RAISE NOTICE 'monitoring IAM completion OK: % grantable permissions, % bundle pairs, % core grants', n_perms, n_bundle, n_core;
END $$;
