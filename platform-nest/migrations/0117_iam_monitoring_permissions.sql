-- MON-10b — register the `monitoring` module in the IAM layer: catalog permissions, the two module
-- roles Cerbos will actually look for, and the role->permission bundles.
-- Schema: 0116_module_monitoring.sql. Design: docs/blueprints/monitoring-program.md §3, §13.
--
-- ── WHY THIS LANDS BEFORE THE MODULE SHELL, NOT AFTER ─────────────────────────────────────────────
-- `validateModulePermissions()` (modules/registry.ts) REFUSES BOOT if any ModuleContract.permissions
-- key does not resolve to a `class='grantable'` catalog row. So the failure mode of shipping the
-- contract first is not a red test — the platform does not start with the module compiled in. Same
-- reasoning as 0106 for social.
--
-- ── ROLE NAMES ARE NOT A CHOICE ───────────────────────────────────────────────────────────────────
-- `cerbos/policies/derived_roles.yaml`'s module_staff/module_manager pair string-composes the role it
-- looks for at request time from `resource.attr.module`:
--     g.role == (resource.attr.module + "_staff") / (resource.attr.module + "_manager")
-- The module key is `monitoring`, so the ONLY names Cerbos will ever match are `monitoring_staff` and
-- `monitoring_manager`. Any other name produces an authz surface that denies everything while looking
-- fully configured.
--
-- ── SCOPE NOTE: CERBOS POLICY FILES ARE A SEPARATE CHANGE ─────────────────────────────────────────
-- This migration makes the module REGISTRABLE (boot succeeds, permissions are grantable). Until
-- `cerbos/policies/resource_monitor*.yaml` exist, Cerbos has no policy for these resources and
-- therefore DENIES — fail-closed, which is the correct direction to be incomplete in. Do not read a
-- 403 after this migration as a bug in it. And remember Cerbos does NOT hot-reload: restart it and
-- prove the new decision with a probe, because a *healthy* container on this estate has served
-- two-day-stale policy.

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 1. Catalog permissions (IAM-01c). `ON CONFLICT (key) DO UPDATE` so re-running is a metadata sync
--    and never churns the `id` that role_permissions rows reference.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
INSERT INTO permissions (id, key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description, v.cerbos_kind, v.cerbos_action, v.class, v.sensitive
FROM (VALUES
  -- The broad read. Everything on the operations board is visible to it, which is exactly why
  -- monitor_channels.config holds secret REFERENCES only and monitor_results.detail is excluded from
  -- the public status-page field allowlist: a widely-held grant must not imply credential access.
  ('monitoring.monitor.read', 'monitoring', 'monitor', 'read',
   'View monitors, their check results, incidents and uptime.', 'monitor', 'read', 'grantable', false),

  -- Authoring a monitor IS the standing authorization for the platform to probe that target on a
  -- schedule (design §4.3). It is NOT authorization to act ON the target: anything that changes a
  -- client system belongs behind a D14 approval, never behind one of these rows.
  ('monitoring.monitor.create', 'monitoring', 'monitor', 'create',
   'Create monitors. This authorizes scheduled probing of the target, and nothing more.', 'monitor', 'create', 'grantable', false),
  ('monitoring.monitor.update', 'monitoring', 'monitor', 'update',
   'Edit monitors, their assertions, interval and severity.', 'monitor', 'update', 'grantable', false),
  ('monitoring.monitor.delete', 'monitoring', 'monitor', 'delete',
   'Delete monitors and their history.', 'monitor', 'delete', 'grantable', false),

  -- Separate from monitor.update on purpose: acknowledging an incident is an accountability record
  -- ("a named person has seen this"), not an edit. Folding it into update would let anyone who can
  -- retune a check also silence the record of an outage.
  ('monitoring.incident.acknowledge', 'monitoring', 'incident', 'acknowledge',
   'Acknowledge an open monitoring incident.', 'monitor_incident', 'acknowledge', 'grantable', false),

  -- K7. A maintenance window suppresses BOTH notification and SLA math, so it can hide a real outage
  -- and flatter an uptime figure. That makes it a genuine grant rather than a convenience toggle.
  ('monitoring.maintenance.create', 'monitoring', 'maintenance', 'create',
   'Schedule maintenance windows, suppressing alerts and SLA impact for their duration.', 'monitor_maintenance', 'create', 'grantable', true),

  -- Channels carry secret references and deliver outward, so managing them is its own grant.
  ('monitoring.channel.read', 'monitoring', 'channel', 'read',
   'View notification channels and routing rules.', 'monitor_channel', 'read', 'grantable', false),
  ('monitoring.channel.manage', 'monitoring', 'channel', 'manage',
   'Create, edit and test notification channels and routes. Test sends a real notification.', 'monitor_channel', 'manage', 'grantable', true),

  -- SENSITIVE: this is the one action that moves tenant data onto the ERP's ONLY unauthenticated read
  -- surface. Everything else here stays behind a session.
  ('monitoring.status_page.publish', 'monitoring', 'status_page', 'publish',
   'Publish a client status page. Makes selected monitor state readable WITHOUT authentication.', 'status_page', 'publish', 'grantable', true)
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
-- 2. The two module roles. `NOT EXISTS` rather than ON CONFLICT: the unique index is on
--    (company_id, name) and a NULL company_id cannot be de-duplicated by ON CONFLICT (0106's note).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
INSERT INTO roles (id, company_id, name, description)
SELECT gen_random_uuid(), NULL, r.name, r.description
FROM (VALUES
  ('monitoring_staff',
   'Monitoring module_staff — runs the monitoring desk: reads the board, incidents and uptime, creates and tunes monitors, acknowledges incidents, and reads notification channels. Cannot manage channels (they hold secret references and send outward), cannot delete monitors or their history, cannot schedule maintenance (it suppresses alerting and flatters SLA figures), and cannot publish a client status page.'),
  ('monitoring_manager',
   'Monitoring module_manager — the full working set, including the decisions staff cannot make: delete monitors, manage and test notification channels, schedule maintenance windows, and publish a client status page. Publishing is the only action here that exposes tenant data without authentication, so it is deliberately manager-tier and audited.')
) AS r(name, description)
WHERE NOT EXISTS (
  SELECT 1 FROM roles WHERE company_id IS NULL AND roles.name = r.name
);

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 3. Role -> permission bundles.
--    company_admin and platform_admin get the full set (they already administer every other module);
--    monitoring_staff gets the read/author/acknowledge working set; monitoring_manager gets all of it.
--    Note what staff deliberately does NOT get: channel.manage, maintenance.create, monitor.delete
--    and status_page.publish — the four that either reach outside the ERP, hide an outage, or destroy
--    history.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('company_admin',     'monitoring.monitor.read'),
  ('company_admin',     'monitoring.monitor.create'),
  ('company_admin',     'monitoring.monitor.update'),
  ('company_admin',     'monitoring.monitor.delete'),
  ('company_admin',     'monitoring.incident.acknowledge'),
  ('company_admin',     'monitoring.maintenance.create'),
  ('company_admin',     'monitoring.channel.read'),
  ('company_admin',     'monitoring.channel.manage'),
  ('company_admin',     'monitoring.status_page.publish'),

  ('platform_admin',    'monitoring.monitor.read'),
  ('platform_admin',    'monitoring.monitor.create'),
  ('platform_admin',    'monitoring.monitor.update'),
  ('platform_admin',    'monitoring.monitor.delete'),
  ('platform_admin',    'monitoring.incident.acknowledge'),
  ('platform_admin',    'monitoring.maintenance.create'),
  ('platform_admin',    'monitoring.channel.read'),
  ('platform_admin',    'monitoring.channel.manage'),
  ('platform_admin',    'monitoring.status_page.publish'),

  ('monitoring_manager','monitoring.monitor.read'),
  ('monitoring_manager','monitoring.monitor.create'),
  ('monitoring_manager','monitoring.monitor.update'),
  ('monitoring_manager','monitoring.monitor.delete'),
  ('monitoring_manager','monitoring.incident.acknowledge'),
  ('monitoring_manager','monitoring.maintenance.create'),
  ('monitoring_manager','monitoring.channel.read'),
  ('monitoring_manager','monitoring.channel.manage'),
  ('monitoring_manager','monitoring.status_page.publish'),

  ('monitoring_staff',  'monitoring.monitor.read'),
  ('monitoring_staff',  'monitoring.monitor.create'),
  ('monitoring_staff',  'monitoring.monitor.update'),
  ('monitoring_staff',  'monitoring.incident.acknowledge'),
  ('monitoring_staff',  'monitoring.channel.read')
) AS bundle(role_name, perm_key)
JOIN roles r ON r.company_id IS NULL AND r.name = bundle.role_name
JOIN permissions p ON p.key = bundle.perm_key
ON CONFLICT DO NOTHING;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 4. Self-check. A silently-partial IAM seed is the worst outcome here: the module boots, some
--    permissions resolve, and the gaps only surface as scattered 403s that read like policy bugs.
--    Fail the migration loudly instead.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  n_perms integer;
  n_roles integer;
  n_bundle integer;
BEGIN
  SELECT count(*) INTO n_perms FROM permissions WHERE module_key = 'monitoring' AND class = 'grantable';
  -- FLOOR, not equality. A later migration legitimately completing this catalog (the 5 actions the
  -- Cerbos policies name that this file missed) must not make a manual re-run of this file raise.
  IF n_perms < 9 THEN
    RAISE EXCEPTION 'monitoring: expected at least 9 grantable catalog permissions, found %', n_perms;
  END IF;

  SELECT count(*) INTO n_roles FROM roles WHERE company_id IS NULL AND name IN ('monitoring_staff','monitoring_manager');
  IF n_roles <> 2 THEN
    RAISE EXCEPTION 'monitoring: expected both module roles, found %', n_roles;
  END IF;

  SELECT count(*) INTO n_bundle
  FROM role_permissions rp
  JOIN permissions p ON p.id = rp.permission_id
  WHERE p.module_key = 'monitoring';
  IF n_bundle < 32 THEN
    RAISE EXCEPTION 'monitoring: expected at least 32 role->permission pairs, found %', n_bundle;
  END IF;

  RAISE NOTICE 'monitoring IAM seed OK: % permissions, % roles, % bundle pairs', n_perms, n_roles, n_bundle;
END $$;
