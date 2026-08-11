-- IAM-02g — bundle `webdev_staff`/`webdev_manager` (0097) into `role_permissions`, the FOURTH
-- variant of the "role provisioned at one layer, not the next" defect class found today:
--   1. named in Cerbos + rbac.ts, no `roles` row                    -> 0091
--   2. baseline roles created only by `seed:agency`, no migration   -> 0095
--   3. `agency_approver`, same shape                                -> 0096
--   4. `roles` row exists (0097), no `role_permissions` bundle      -> THIS FILE
--
-- Harmless today (`role_permissions` has zero runtime consumers — Cerbos still matches role
-- NAMES, IAM-03a/04 haven't landed), but the moment permission-based resolution goes live, a
-- webdev module grant would resolve to an EMPTY permission set and silently authorize nothing —
-- the exact silent-nothing shape `service-reconciler.ts`'s moduleRoleId() null-return already
-- produces for an unseeded ROLE row (0091/0097's own finding), now one layer up.
--
-- ── METHOD (identical to 0094's, applied to the two roles 0094 explicitly could not bundle) ────
-- Source of truth is the ACTUAL Cerbos policies, not `rbac.ts`. Both webdev kinds carry
-- module_staff/module_manager rules with the SAME derivation 0094's header already documents for
-- hr_*/search_*/reports_*:
--
--   resource_webdev_change_request.yaml   module_manager: ["read","triage"]   (inTenant && notLow)
--                                          module_staff:   ["read"]           (inTenant && notLow)
--   resource_webdev_provisioned_site.yaml module_manager: ["read","provision","reconcile"]
--                                          module_staff:   ["read"]           (inTenant && notLow)
--
-- That is the 7 (kind,action) pairs 0094's own header already counted (2 for webdev_staff, 5 for
-- webdev_manager) and the IAM-02a/02b report's §4(b) pinned in advance.
--
-- PLUS the two GENERIC (module-agnostic) pairs 0094 bundled onto every OTHER module_staff/
-- module_manager-composed role, because the underlying Cerbos rule has no module hardcode and
-- therefore fires for ANY module string, webdev included — verified by direct read, not assumed:
--   resource_member.yaml             module_staff ONLY:            ["read"]  (inTenant && notLow)
--     (module_manager is NOT listed on this rule — hr_manager/search_manager/reports_manager do
--     not get core.member.read either; confirmed against 0094's own bundle rows.)
--   resource_service_assignment.yaml module_staff AND module_manager (one rule, both derived
--     roles): ["read"]  (inTenant && notLow)
--
-- So: webdev_staff = {webdev.change_request.read, webdev.provisioned_site.read, core.member.read,
--                      core.service_assignment.read}                                   = 4 pairs
--     webdev_manager = {webdev.change_request.read, webdev.change_request.triage,
--                        webdev.provisioned_site.read, webdev.provisioned_site.provision,
--                        webdev.provisioned_site.reconcile, core.service_assignment.read}
--                                                                                       = 6 pairs
-- Total: 10 new (role, permission) pairs. Grand total across all 20 built-in roles: 925 + 10 = 935.
--
-- class='relationship' permissions are never reachable by construction here (none of the six keys
-- above are relationship-class) and 0093's `role_permissions_reject_relationship` trigger remains
-- the backstop even if this file ever tried.
--
-- ── ROLE ROWS ─────────────────────────────────────────────────────────────────────────────────────
-- Not re-seeded here. `webdev_staff`/`webdev_manager` are guaranteed to already exist:
-- `0097_webdev_module_roles.sql` numerically precedes this file and seeds both, idempotently, with
-- its own closing assertion — an ordering this repo's migration runner guarantees (ascending
-- filename order), unlike 0094's self-dependency on IAM-02e's THEN-not-yet-landed baseline roles.
--
-- ── NO RLS CONCERN ───────────────────────────────────────────────────────────────────────────────
-- `roles`/`permissions`/`role_permissions` are global reference data with no RLS policy (confirmed
-- by every prior migration in this family — 0094/0095/0096/0097's own headers). The "runs
-- NOBYPASSRLS with an unset tenant GUC -> silently matches zero rows" trap does not apply
-- structurally here (no tenant-scoped WHERE clause for RLS to zero out); asserted below anyway,
-- per the same discipline every migration in this family applies.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('webdev_staff',   'webdev.change_request.read'),
  ('webdev_staff',   'webdev.provisioned_site.read'),
  ('webdev_staff',   'core.member.read'),
  ('webdev_staff',   'core.service_assignment.read'),
  ('webdev_manager', 'webdev.change_request.read'),
  ('webdev_manager', 'webdev.change_request.triage'),
  ('webdev_manager', 'webdev.provisioned_site.read'),
  ('webdev_manager', 'webdev.provisioned_site.provision'),
  ('webdev_manager', 'webdev.provisioned_site.reconcile'),
  ('webdev_manager', 'core.service_assignment.read')
) AS bundle(role_name, perm_key)
JOIN roles r ON r.company_id IS NULL AND r.name = bundle.role_name
JOIN permissions p ON p.key = bundle.perm_key
ON CONFLICT DO NOTHING;

-- ── Assert, don't assume ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  expected record;
  got integer;
  total_expected integer := 10;
  total_got integer;
  leaked integer;
BEGIN
  FOR expected IN
    SELECT * FROM (VALUES
      ('webdev_staff', 4),
      ('webdev_manager', 6)
    ) AS x(role_name, expected_count)
  LOOP
    SELECT count(*) INTO got
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
     WHERE r.company_id IS NULL AND r.name = expected.role_name;
    IF got <> expected.expected_count THEN
      RAISE EXCEPTION '0098: role "%": expected % bundled permissions, found % (missing/typo''d role name or permission key in the JOIN, or a prior partial application)',
        expected.role_name, expected.expected_count, got;
    END IF;
  END LOOP;

  SELECT count(*) INTO total_got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
   WHERE r.company_id IS NULL AND r.name IN ('webdev_staff', 'webdev_manager');
  IF total_got <> total_expected THEN
    RAISE EXCEPTION '0098: total bundled permissions across webdev_staff/webdev_manager: expected %, found %',
      total_expected, total_got;
  END IF;

  -- Defense-in-depth re-assertion of Ruling 3, redundant with 0093's DB trigger.
  SELECT count(*) INTO leaked
    FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
    JOIN roles r ON r.id = rp.role_id
   WHERE r.company_id IS NULL AND r.name IN ('webdev_staff', 'webdev_manager')
     AND p.class = 'relationship';
  IF leaked <> 0 THEN
    RAISE EXCEPTION '0098: % relationship-class permission(s) leaked into webdev_staff/webdev_manager bundles — Ruling 3 violated', leaked;
  END IF;

  RAISE NOTICE '0098: role_permissions seeded — % rows across webdev_staff/webdev_manager, 0 relationship-class leaks', total_got;
END $$;
