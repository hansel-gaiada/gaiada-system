-- 0110_iam_phase2_role_grant_kinds_ui_grantable.sql — IAM Phase 2, P2-02 (the four new Cerbos kinds:
-- role_grant/position/employee/it_account) + P2-03 (the ui_grantable allow-list, design
-- docs/superpowers/plans/2026-08-13-iam-phase2-design.md §6.2/§7). Combined deliberately — both
-- tickets touch permission-catalog.json/the permissions table and would collide run separately.
--
-- Companion Cerbos policies: cerbos/policies/resource_role_grant.yaml, resource_position.yaml,
-- resource_employee.yaml, resource_it_account.yaml (+ derived_roles.yaml's new `it_managers`).
-- Companion catalog: src/rbac/permission-catalog.json (+18 grantable, ALL uiGrantable:true; +
-- uiGrantable REQUIRED on all 282 entries). Companion bundle: src/rbac/role-permission-bundles.json
-- (regenerated via `npm run gen:role-bundles`, +62 pairs — see this migration's PART 3 for the exact
-- list, derived from the artifact's own before/after diff, never hand-picked).
--
-- ⚠ ROLE-ARM ONLY. No perm_role_grant_*/perm_position_*/perm_employee_*/perm_it_account_* mirror is
-- wired by this migration or any policy file it accompanies — see each resource_*.yaml's own header
-- for why (role_grant/position: permanently-unwired, subtree-attribute-dependent; employee/
-- it_account: deferred pending their handlers, per this ticket's brief).
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────────────
-- `ls migrations | sort | tail` immediately before writing this file showed the real head as
-- `0109_iam_phase2_positions.sql` (P2-01, already landed) with `0110` genuinely free — re-checked at
-- the moment of writing per the numbering protocol's own rule 5, not trusted from a stale doc.
-- `0058`/`0059`/`0070` remain the permanently-orphaned dead reservations — not touched.
--
-- ── WHY THIS EXTENDS 0109's TRIGGER FUNCTION IN PLACE, NOT A NEW ONE ───────────────────────────────
-- 0109's own header/report explicitly deferred clause (b) of the design §2.3 guard trigger ("a
-- position may not confer a bundle containing a non-ui_grantable key") because `permissions.
-- ui_grantable` did not exist yet, and instructed P2-03 to `CREATE OR REPLACE FUNCTION
-- position_roles_guard()` — same trigger, same name, no migration renumbering — the moment the
-- column exists. PART 4 below does exactly that: 0109 shipped to the server already (per this
-- ticket's own brief), so 0109 itself is NOT edited.

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 · permissions.ui_grantable — the allow-list column (design §7)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- DEFAULT true is safe for the backfill: every pre-existing row that is NOT portal.*/relationship
-- was assessed true in the catalog's own initial marking pass (design §7's "everything else
-- grantable = true"). The two exceptions (portal.* and class='relationship') are corrected by name
-- immediately below, matching src/rbac/permission-catalog.json's own uiGrantable values exactly —
-- this migration's PART 5 asserts byte-for-byte agreement between the two so neither can drift.
ALTER TABLE permissions
  ADD COLUMN IF NOT EXISTS ui_grantable boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN permissions.ui_grantable IS
  'IAM Phase 2 (P2-03, design §7) — may this permission ever appear in a role bundle attached to a '
  'POSITION (or, in Phase 4, composed by the role-authoring UI)? A perm_* mirror or role_permissions '
  'row honours a key whichever role carries it; that is only safe while role composition is '
  'migration-only. Positions create a UI write path onto roles, so the boundary must live on the KEY '
  'itself, not on a scope check (a staff role carrying portal.* would put staff inside the client '
  'portal at a perfectly VALID scope). Flipping false->true is a PERMISSION-CONTRACT change requiring '
  'an owner decision line in the catalog entry, same as a rename (design §7(c)).';

-- portal.* is false STRUCTURALLY (the client/staff trust boundary — design §7's pinned invariant,
-- "client is listed even though its one key could be argued, because the boundary is a trust
-- boundary, not a permission sum"). Matched by module_key, not a hand-typed key list, so a future
-- portal.* addition inherits the pin without a migration edit.
UPDATE permissions SET ui_grantable = false WHERE module_key = 'portal' AND ui_grantable = true;

-- The 15 relationship-class permissions are false structurally too (Ruling 3's bypass-exempt set —
-- owned by the resource, never by any role, so "may a position confer this" is vacuously false).
UPDATE permissions SET ui_grantable = false WHERE class = 'relationship' AND ui_grantable = true;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 · The 18 new P2-02 catalog permissions (role_grant/position/employee/it_account)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
INSERT INTO permissions (id, key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description, v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('core.role_grant.create', 'core', 'role_grant', 'create',
   'Grant a role to a user - subtree-bounded for a dept-head position holder (org_unit_lead), full-tenant for company_admin.',
   'role_grant', 'create', 'grantable', true, true),
  ('core.role_grant.revoke', 'core', 'role_grant', 'revoke',
   'Revoke a role previously granted to a user.',
   'role_grant', 'revoke', 'grantable', true, true),
  ('core.role_grant.read', 'core', 'role_grant', 'read',
   'View who holds which role grants.',
   'role_grant', 'read', 'grantable', true, true),
  ('core.position.create', 'core', 'position', 'create',
   'Create an org-chart position (seat).',
   'position', 'create', 'grantable', false, true),
  ('core.position.update', 'core', 'position', 'update',
   'Edit a position''s title, unit, is_lead flag, or headcount.',
   'position', 'update', 'grantable', false, true),
  ('core.position.retire', 'core', 'position', 'retire',
   'Retire a position (soft-delete; rows are never deleted).',
   'position', 'retire', 'grantable', false, true),
  ('core.position.assign', 'core', 'position', 'assign',
   'Assign a person to a position (open a position assignment) - this is what actually confers the position''s role-set to them.',
   'position', 'assign', 'grantable', true, true),
  ('core.position.unassign', 'core', 'position', 'unassign',
   'Remove a person from a position (close a position assignment).',
   'position', 'unassign', 'grantable', true, true),
  ('core.position.read', 'core', 'position', 'read',
   'View positions and their role-set templates.',
   'position', 'read', 'grantable', false, true),
  ('hr.employee.create', 'hr', 'employee', 'create',
   'Create an employee record (HR people file).',
   'employee', 'create', 'grantable', true, true),
  ('hr.employee.read', 'hr', 'employee', 'read',
   'View employee records.',
   'employee', 'read', 'grantable', true, true),
  ('hr.employee.update', 'hr', 'employee', 'update',
   'Edit an employee record.',
   'employee', 'update', 'grantable', true, true),
  ('hr.employee.delete', 'hr', 'employee', 'delete',
   'Delete/deactivate an employee record.',
   'employee', 'delete', 'grantable', true, true),
  ('it.account.read', 'it', 'account', 'read',
   'View the IT accounts worklist (login/account status by person).',
   'it_account', 'read', 'grantable', true, true),
  ('it.account.provision', 'it', 'account', 'provision',
   'Provision a Keycloak login for a person.',
   'it_account', 'provision', 'grantable', true, true),
  ('it.account.disable', 'it', 'account', 'disable',
   'Disable a person''s Keycloak login.',
   'it_account', 'disable', 'grantable', true, true),
  ('it.account.enable', 'it', 'account', 'enable',
   'Re-enable a person''s Keycloak login.',
   'it_account', 'enable', 'grantable', true, true),
  ('it.account.reset_password', 'it', 'account', 'reset_password',
   'Reset a person''s Keycloak password (shown once).',
   'it_account', 'reset_password', 'grantable', true, true)
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

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 · The 62 role_permissions bundle pairs — machine-derived (PROVENANCE: the exact set
-- difference between src/rbac/role-permission-bundles.json before/after `npm run gen:role-bundles`
-- re-derived it from the four new Cerbos policies above; see 0107's own header for why this is
-- trustworthy — generate-role-bundles.mjs is the third independent expression of the same algorithm
-- role-permission-parity.db.test.ts checks live).
--   platform_admin  +18 (wildcard covers all 4 new kinds' full action universes)
--   company_admin   +18 (full-tenant reach on every new action, per design §6.2's own tier text)
--   org_unit_lead    +6 (role_grant.create/revoke/read + position.assign/unassign/read — the
--                        dept-head subtree rule; NOT position.create/update/retire, which are HR-only)
--   hr_manager       +8 (hr_people_ops: position.create/update/retire + employee.create/update/
--                        delete; hr_people_reader: position.read + employee.read)
--   hr_staff         +2 (hr_people_reader ONLY: position.read + employee.read — hr_staff is NOT
--                        hr_people_ops, so it does not reach any write action)
--   it_admin         +5 (it_managers: the full it.account.* action set)
--   it_manager       +5 (it_managers: the full it.account.* action set)
-- Zero pairs removed. No existing user's reach narrows. group_executive is UNCHANGED (design names
-- no group_executive reach over any of these 4 kinds).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('company_admin', 'core.position.assign'),
  ('company_admin', 'core.position.create'),
  ('company_admin', 'core.position.read'),
  ('company_admin', 'core.position.retire'),
  ('company_admin', 'core.position.unassign'),
  ('company_admin', 'core.position.update'),
  ('company_admin', 'core.role_grant.create'),
  ('company_admin', 'core.role_grant.read'),
  ('company_admin', 'core.role_grant.revoke'),
  ('company_admin', 'hr.employee.create'),
  ('company_admin', 'hr.employee.delete'),
  ('company_admin', 'hr.employee.read'),
  ('company_admin', 'hr.employee.update'),
  ('company_admin', 'it.account.disable'),
  ('company_admin', 'it.account.enable'),
  ('company_admin', 'it.account.provision'),
  ('company_admin', 'it.account.read'),
  ('company_admin', 'it.account.reset_password'),
  ('hr_manager', 'core.position.create'),
  ('hr_manager', 'core.position.read'),
  ('hr_manager', 'core.position.retire'),
  ('hr_manager', 'core.position.update'),
  ('hr_manager', 'hr.employee.create'),
  ('hr_manager', 'hr.employee.delete'),
  ('hr_manager', 'hr.employee.read'),
  ('hr_manager', 'hr.employee.update'),
  ('hr_staff', 'core.position.read'),
  ('hr_staff', 'hr.employee.read'),
  ('it_admin', 'it.account.disable'),
  ('it_admin', 'it.account.enable'),
  ('it_admin', 'it.account.provision'),
  ('it_admin', 'it.account.read'),
  ('it_admin', 'it.account.reset_password'),
  ('it_manager', 'it.account.disable'),
  ('it_manager', 'it.account.enable'),
  ('it_manager', 'it.account.provision'),
  ('it_manager', 'it.account.read'),
  ('it_manager', 'it.account.reset_password'),
  ('org_unit_lead', 'core.position.assign'),
  ('org_unit_lead', 'core.position.read'),
  ('org_unit_lead', 'core.position.unassign'),
  ('org_unit_lead', 'core.role_grant.create'),
  ('org_unit_lead', 'core.role_grant.read'),
  ('org_unit_lead', 'core.role_grant.revoke'),
  ('platform_admin', 'core.position.assign'),
  ('platform_admin', 'core.position.create'),
  ('platform_admin', 'core.position.read'),
  ('platform_admin', 'core.position.retire'),
  ('platform_admin', 'core.position.unassign'),
  ('platform_admin', 'core.position.update'),
  ('platform_admin', 'core.role_grant.create'),
  ('platform_admin', 'core.role_grant.read'),
  ('platform_admin', 'core.role_grant.revoke'),
  ('platform_admin', 'hr.employee.create'),
  ('platform_admin', 'hr.employee.delete'),
  ('platform_admin', 'hr.employee.read'),
  ('platform_admin', 'hr.employee.update'),
  ('platform_admin', 'it.account.disable'),
  ('platform_admin', 'it.account.enable'),
  ('platform_admin', 'it.account.provision'),
  ('platform_admin', 'it.account.read'),
  ('platform_admin', 'it.account.reset_password')
) AS bundle(role_name, perm_key)
JOIN roles r ON r.company_id IS NULL AND r.name = bundle.role_name
JOIN permissions p ON p.key = bundle.perm_key
ON CONFLICT DO NOTHING;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- PART 4 · position_roles_guard() — extend IN PLACE (CREATE OR REPLACE, same trigger, same name)
--          with 0109's DEFERRED clause (b): a position may not confer a bundle containing a
--          non-ui_grantable permission (design §2.3/§7).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- Clauses (a) and (c) are BYTE-IDENTICAL to 0109's version — only (b) is added, in the exact slot
-- 0109's own body left commented as "DEFERRED to P2-03". A position's bundle = the UNION of every
-- (role, permission) pair role-permission-bundles.json/role_permissions records for role_id
-- (module_staff/module_manager-composed reach is already resolved into concrete role rows by the
-- time a role reaches `roles.id`, so a plain join is sufficient — no CEL/Cerbos re-evaluation here).
CREATE OR REPLACE FUNCTION position_roles_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  rname          text;
  reachable      text[];
  bad_perm_count integer;
BEGIN
  SELECT name INTO rname FROM roles WHERE id = NEW.role_id;
  IF rname IS NULL THEN
    RAISE EXCEPTION 'position_roles: role_id % does not resolve to a roles row', NEW.role_id;
  END IF;

  -- (a) denied-role registry (design §2.3): these tiers can NEVER be attached to a position, at any
  -- scope_kind. 'owner' does not exist as a roles row yet (Phase 3) — matched by NAME, not
  -- existence, so it is caught automatically the moment it is seeded, with no trigger edit needed.
  IF rname = ANY (ARRAY['platform_admin','group_executive','client','owner']) THEN
    RAISE EXCEPTION
      'position_roles: role "%" is in the denied-role registry and can never be attached to a '
      'position (IAM Phase 2 design §2.3/§6.3.6 — the elevated fence)', rname;
  END IF;

  -- (c) scope-shape check — hand-mirrors src/rbac/scope-constrained-roles.json AS OF 2026-08-13
  -- (see 0109's header: Postgres cannot import the generated JSON, so this is a flagged, hand-synced
  -- duplication seam). scope_kind='company' materializes at scope_type='company'; scope_kind=
  -- 'own_unit' materializes at scope_type='org_unit'. A role ABSENT from this map is UNCONSTRAINED
  -- (fail-open — same semantics as isGrantScopeReachable()); most roles fall here by design.
  reachable := CASE rname
    WHEN 'org_unit_lead' THEN ARRAY['org_unit']
    WHEN 'company_admin' THEN ARRAY['company','global']
    WHEN 'hr_manager'    THEN ARRAY['company','global']
    WHEN 'hr_staff'      THEN ARRAY['company','global']
    WHEN 'it'            THEN ARRAY['company','global']
    WHEN 'it_admin'      THEN ARRAY['company','global']
    WHEN 'it_manager'    THEN ARRAY['company','global']
    WHEN 'manager'       THEN ARRAY['company','global','project']
    WHEN 'member'        THEN ARRAY['company','global','project']
    WHEN 'viewer'        THEN ARRAY['company','global']
    ELSE NULL
  END;

  IF reachable IS NOT NULL THEN
    IF NEW.scope_kind = 'own_unit' AND NOT ('org_unit' = ANY (reachable)) THEN
      RAISE EXCEPTION
        'position_roles: role "%" cannot be attached at scope_kind=own_unit -- its own Cerbos '
        'condition never reaches org_unit scope (scope-constrained-roles.json)', rname;
    END IF;
    IF NEW.scope_kind = 'company' AND NOT ('company' = ANY (reachable)) THEN
      RAISE EXCEPTION
        'position_roles: role "%" cannot be attached at scope_kind=company -- its own Cerbos '
        'condition never reaches company scope (scope-constrained-roles.json)', rname;
    END IF;
  END IF;

  -- (b) ui_grantable bundle check (design §2.3(b)/§7, P2-03) — a position may not confer a bundle
  -- containing ANY permission flagged ui_grantable=false. This is the layer that survives a
  -- forgotten guard (the design's own words): even if GrantWriteService/the position-authoring
  -- write path (P2-04/P2-12) ever fails to call assertRoleUiGrantable() before writing a
  -- position_roles row, this trigger still refuses the insert/update at the DB layer.
  SELECT count(*) INTO bad_perm_count
    FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
   WHERE rp.role_id = NEW.role_id AND p.ui_grantable = false;

  IF bad_perm_count > 0 THEN
    RAISE EXCEPTION
      'position_roles: role "%" carries % non-ui_grantable permission(s) in its bundle and can '
      'never be attached to a position (IAM Phase 2 design §2.3(b)/§7 — the UI-grantable '
      'allow-list; a position confers its role-set through a UI-adjacent write path, and a '
      'non-ui_grantable key — e.g. any portal.* key, or a relationship-class key — must never '
      'reach a role a position can hold)', rname, bad_perm_count;
  END IF;

  RETURN NEW;
END $$;

-- Trigger itself is UNCHANGED (same name, same timing/events) — CREATE OR REPLACE FUNCTION above is
-- sufficient; the trigger definition does not need to be dropped/recreated.

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- PART 5 · Assert, don't assume
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  missing text[];
  got integer;
  expected record;
BEGIN
  -- (a) ui_grantable column landed, NOT NULL
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'permissions' AND column_name = 'ui_grantable' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION '0110: permissions.ui_grantable is missing or nullable';
  END IF;

  -- (b) the DB's ui_grantable=false set matches the catalog's own false set EXACTLY: every
  -- portal.*/relationship-class permission (and ONLY those, among pre-0110 rows) is false.
  SELECT count(*) INTO got FROM permissions WHERE ui_grantable = false AND module_key <> 'portal' AND class <> 'relationship';
  IF got <> 0 THEN
    RAISE EXCEPTION '0110: % permission(s) are ui_grantable=false OUTSIDE portal.*/relationship-class — the DB and catalog have diverged', got;
  END IF;
  SELECT count(*) INTO got FROM permissions WHERE module_key = 'portal' AND ui_grantable = true;
  IF got <> 0 THEN
    RAISE EXCEPTION '0110: % portal.* permission(s) are still ui_grantable=true after the backfill', got;
  END IF;
  SELECT count(*) INTO got FROM permissions WHERE class = 'relationship' AND ui_grantable = true;
  IF got <> 0 THEN
    RAISE EXCEPTION '0110: % relationship-class permission(s) are still ui_grantable=true after the backfill', got;
  END IF;

  -- (c) the 18 new catalog rows landed, all class='grantable', all ui_grantable=true
  SELECT array_agg(k) INTO missing FROM (
    SELECT unnest(ARRAY[
      'core.role_grant.create', 'core.role_grant.revoke', 'core.role_grant.read',
      'core.position.create', 'core.position.update', 'core.position.retire',
      'core.position.assign', 'core.position.unassign', 'core.position.read',
      'hr.employee.create', 'hr.employee.read', 'hr.employee.update', 'hr.employee.delete',
      'it.account.read', 'it.account.provision', 'it.account.disable', 'it.account.enable', 'it.account.reset_password'
    ]) AS k
    EXCEPT SELECT key FROM permissions
  ) AS x;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0110: new catalog rows missing after insert: %', missing;
  END IF;

  SELECT count(*) INTO got FROM permissions
   WHERE key LIKE 'core.role_grant.%' OR key LIKE 'core.position.%' OR key LIKE 'hr.employee.%' OR key LIKE 'it.account.%';
  IF got <> 18 THEN
    RAISE EXCEPTION '0110: expected exactly 18 new permission rows, found %', got;
  END IF;

  SELECT count(*) INTO got FROM permissions
   WHERE (key LIKE 'core.role_grant.%' OR key LIKE 'core.position.%' OR key LIKE 'hr.employee.%' OR key LIKE 'it.account.%')
     AND (class <> 'grantable' OR ui_grantable <> true);
  IF got <> 0 THEN
    RAISE EXCEPTION '0110: % of the 18 new rows are not class=grantable/ui_grantable=true', got;
  END IF;

  -- (d) the bundle pairs are exactly the 62 the generator derived
  FOR expected IN
    SELECT * FROM (VALUES
      ('company_admin', 'core.position.assign'), ('company_admin', 'core.position.create'),
      ('company_admin', 'core.position.read'), ('company_admin', 'core.position.retire'),
      ('company_admin', 'core.position.unassign'), ('company_admin', 'core.position.update'),
      ('company_admin', 'core.role_grant.create'), ('company_admin', 'core.role_grant.read'),
      ('company_admin', 'core.role_grant.revoke'), ('company_admin', 'hr.employee.create'),
      ('company_admin', 'hr.employee.delete'), ('company_admin', 'hr.employee.read'),
      ('company_admin', 'hr.employee.update'), ('company_admin', 'it.account.disable'),
      ('company_admin', 'it.account.enable'), ('company_admin', 'it.account.provision'),
      ('company_admin', 'it.account.read'), ('company_admin', 'it.account.reset_password'),
      ('hr_manager', 'core.position.create'), ('hr_manager', 'core.position.read'),
      ('hr_manager', 'core.position.retire'), ('hr_manager', 'core.position.update'),
      ('hr_manager', 'hr.employee.create'), ('hr_manager', 'hr.employee.delete'),
      ('hr_manager', 'hr.employee.read'), ('hr_manager', 'hr.employee.update'),
      ('hr_staff', 'core.position.read'), ('hr_staff', 'hr.employee.read'),
      ('it_admin', 'it.account.disable'), ('it_admin', 'it.account.enable'),
      ('it_admin', 'it.account.provision'), ('it_admin', 'it.account.read'),
      ('it_admin', 'it.account.reset_password'), ('it_manager', 'it.account.disable'),
      ('it_manager', 'it.account.enable'), ('it_manager', 'it.account.provision'),
      ('it_manager', 'it.account.read'), ('it_manager', 'it.account.reset_password'),
      ('org_unit_lead', 'core.position.assign'), ('org_unit_lead', 'core.position.read'),
      ('org_unit_lead', 'core.position.unassign'), ('org_unit_lead', 'core.role_grant.create'),
      ('org_unit_lead', 'core.role_grant.read'), ('org_unit_lead', 'core.role_grant.revoke'),
      ('platform_admin', 'core.position.assign'), ('platform_admin', 'core.position.create'),
      ('platform_admin', 'core.position.read'), ('platform_admin', 'core.position.retire'),
      ('platform_admin', 'core.position.unassign'), ('platform_admin', 'core.position.update'),
      ('platform_admin', 'core.role_grant.create'), ('platform_admin', 'core.role_grant.read'),
      ('platform_admin', 'core.role_grant.revoke'), ('platform_admin', 'hr.employee.create'),
      ('platform_admin', 'hr.employee.delete'), ('platform_admin', 'hr.employee.read'),
      ('platform_admin', 'hr.employee.update'), ('platform_admin', 'it.account.disable'),
      ('platform_admin', 'it.account.enable'), ('platform_admin', 'it.account.provision'),
      ('platform_admin', 'it.account.read'), ('platform_admin', 'it.account.reset_password')
    ) AS x(role_name, perm_key)
  LOOP
    SELECT count(*) INTO got
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND r.name = expected.role_name AND p.key = expected.perm_key;
    IF got <> 1 THEN
      RAISE EXCEPTION '0110: expected bundle pair (%, %) to exist exactly once, found %', expected.role_name, expected.perm_key, got;
    END IF;
  END LOOP;

  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL
     AND (p.key LIKE 'core.role_grant.%' OR p.key LIKE 'core.position.%' OR p.key LIKE 'hr.employee.%' OR p.key LIKE 'it.account.%')
     AND NOT (r.name IN ('company_admin', 'hr_manager', 'hr_staff', 'it_admin', 'it_manager', 'org_unit_lead', 'platform_admin'));
  IF got <> 0 THEN
    RAISE EXCEPTION '0110: % unexpected role(s) hold a new kind''s permission outside the 7-role list above', got;
  END IF;

  -- (e) the 15-relationship / 249->267-grantable boundary is intact (no new row is relationship-class)
  SELECT count(*) INTO got FROM permissions
   WHERE (key LIKE 'core.role_grant.%' OR key LIKE 'core.position.%' OR key LIKE 'hr.employee.%' OR key LIKE 'it.account.%')
     AND class <> 'grantable';
  IF got <> 0 THEN
    RAISE EXCEPTION '0110: % non-grantable row(s) among the 18 new permissions', got;
  END IF;
END $$;
