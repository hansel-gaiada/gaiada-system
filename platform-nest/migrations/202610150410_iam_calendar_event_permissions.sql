-- IAM — DW-8g: the `calendar_event` permission family (docs/FRONTEND-BFF-CONTRACT.md §47.2, docs/PERMISSION-CONTRACT.md §39), a NEW
-- core Cerbos kind (no module): one event on a company's calendar, which may carry a scheduled meeting recording. Pure IAM seed:
-- no DDL (202610150400 owns the tables).
--
-- A new Cerbos kind costs six coupled artifacts; this is #5 (copied from 202610140610_iam_work_request_permissions.sql).
-- The others, all in the same change:
--   1. cerbos/policies/resource_calendar_event.yaml (+ 1 perm_calendar_event_create derived role in derived_roles.yaml:
--      `create` ONLY, see the policy header)
--   2. src/rbac/cerbos.ts            — `attendeeIds` and `visibility` added to Resource AND to the resourcePayload()
--                                      allow-list (`ownerId` was already there)
--   3. src/rbac/permission-catalog.json  — the 5 keys + _meta counts (109 kinds / 471 pairs / 456 grantable)
--   4. src/rbac/permission-groups.json   — 1 group (`calendar`) + _meta counts
--   6. scripts/generate-role-bundles.mjs (NO resolver change: the kind names only direct roles, which DIRECT already
--      maps) and src/rbac/role-permission-bundles.json regenerated.
--
-- ── WHICH REACH IS SEEDED (a mechanical transcription of the policy's role-arm ALLOW rules) ──────
--   platform_admin   — all 5 keys (its Cerbos wildcard; 0094's methodology materialises an explicit row per
--                      grantable key anyway, see 202609281704)
--   company_admin, owner — read, create, update, cancel, respond
--                      (owner MUST mirror company_admin exactly: owner-role.db.test.ts; a new company_admin key does
--                      NOT propagate to owner on its own)
--   manager          — create; read (organizer, attendee and company-visibility rules, so never every calendar); update, cancel and respond
--                      as SELF-SCOPED pairs. (Added at review, 2026-10-14: a manager-only login could create but not then read its own event.)
--   member           — create; read (organizer, attendee and company-visibility rules); update and cancel as SELF-SCOPED
--                      pairs (the organizer on their own event); respond as a SELF-SCOPED pair (an attendee, for themselves)
--   viewer           — read (attendee and company-visibility rules); respond as a SELF-SCOPED pair
--   everything else (client, org_unit_lead, module tiers, ...) — NOTHING
--
-- ── SELF-SCOPED MARKER ──────────────────────────────────────────────────────────────────────────
-- member·update, member·cancel, member·respond, manager·update, manager·cancel, manager·respond and viewer·respond are the ONLY marked pairs: every rule that grants one of
-- them to that role is an attribute-equality or membership rule (`ownerId == principal.id`, `principal.id in attendeeIds`).
-- role-permission-bundles.json carries them under `selfScoped`, and self-scoped-marker-parity.db.test.ts pins the DB to the
-- JSON. member·read, viewer·read and manager·read are deliberately NOT marked: one of their rules is the company-visibility rule
-- (`visibility == "company"`), a tenant-wide read, so the generator (which derives the marker from the rule shape) leaves
-- them unmarked. company_admin·respond is not marked either: its ALLOW rule is unconditional and the deny-overrides rule
-- (any role, attendee only) is what narrows it.
--
-- ── SENSITIVE ─────────────────────────────────────────────────────────────────────────────────
-- None of the five is flagged. An event moves no money and exposes no client or HR data; flagging `create` would route every
-- department-head grant of `member` through the sensitive-grant override path (PERMISSION-CONTRACT §12.2). Owner/architect
-- may tighten this additively.
--
-- `permissions.id` has no default, so it is supplied explicitly. `ui_grantable` is EXPLICIT (0110's default).
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('core.calendar_event.read', 'core', 'calendar_event', 'read',
   'See a calendar event: the organizer, every person invited, and everyone in the company when the event is shared company-wide. A manager does not read every calendar. Also reached, by Cerbos rule, by the organizer, an attendee and (for a company-visible event) any member or viewer.',
   'calendar_event', 'read', 'grantable', false, true),
  ('core.calendar_event.create', 'core', 'calendar_event', 'create',
   'Schedule a calendar event or a meeting (optionally with a scheduled recording). Never granted to a viewer, agents or automation.',
   'calendar_event', 'create', 'grantable', false, true),
  ('core.calendar_event.update', 'core', 'calendar_event', 'update',
   'Edit an event''s time, title, attendees or place. Also reached, by Cerbos rule, by the organizer on their own event. Never granted to agents or automation.',
   'calendar_event', 'update', 'grantable', false, true),
  ('core.calendar_event.cancel', 'core', 'calendar_event', 'cancel',
   'Call an event off and tell everyone invited. Also reached, by Cerbos rule, by the organizer on their own event. Never granted to agents or automation.',
   'calendar_event', 'cancel', 'grantable', false, true),
  ('core.calendar_event.respond', 'core', 'calendar_event', 'respond',
   'Accept, decline or answer maybe to an invitation, for yourself only: nobody answers for someone else, company_admin and platform_admin included. Reached by Cerbos rule by an attendee. Never granted to agents or automation.',
   'calendar_event', 'respond', 'grantable', false, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

INSERT INTO role_permissions (role_id, permission_id, self_scoped)
SELECT r.id, p.id, bundle.self_scoped
FROM (
  -- the full-reach tier: every event key (company_admin's reach, mirrored exactly by owner)
  SELECT f.role_name, k.perm_key, false AS self_scoped
    FROM (VALUES ('platform_admin'), ('company_admin'), ('owner')) AS f(role_name)
   CROSS JOIN (VALUES
     ('core.calendar_event.read'), ('core.calendar_event.create'), ('core.calendar_event.update'),
     ('core.calendar_event.cancel'), ('core.calendar_event.respond')
   ) AS k(perm_key)
  UNION ALL
  -- a manager schedules and reads (read is NOT self-scoped: it includes the company-visibility rule), and edits, cancels and
  -- answers only its own events (the self-scoped pairs, as for member)
  SELECT 'manager', 'core.calendar_event.create', false
  UNION ALL
  SELECT 'manager', 'core.calendar_event.read', false
  UNION ALL
  SELECT 'manager', 'core.calendar_event.update', true
  UNION ALL
  SELECT 'manager', 'core.calendar_event.cancel', true
  UNION ALL
  SELECT 'manager', 'core.calendar_event.respond', true
  UNION ALL
  -- members schedule and read (read is NOT self-scoped: it includes the company-visibility rule)
  SELECT 'member', 'core.calendar_event.create', false
  UNION ALL
  SELECT 'member', 'core.calendar_event.read', false
  UNION ALL
  -- the ORGANIZER edits and cancels their own event, an ATTENDEE answers for themselves: the self-scoped pairs
  SELECT 'member', 'core.calendar_event.update', true
  UNION ALL
  SELECT 'member', 'core.calendar_event.cancel', true
  UNION ALL
  SELECT 'member', 'core.calendar_event.respond', true
  UNION ALL
  -- viewers read, and answer their own invitations
  SELECT 'viewer', 'core.calendar_event.read', false
  UNION ALL
  SELECT 'viewer', 'core.calendar_event.respond', true
) AS bundle(role_name, perm_key, self_scoped)
JOIN roles r ON r.company_id IS NULL AND r.name = bundle.role_name
JOIN permissions p ON p.key = bundle.perm_key
ON CONFLICT (role_id, permission_id) DO UPDATE SET self_scoped = EXCLUDED.self_scoped;

-- ── Assert, don't assume (202608310900's discipline) ────────────────────────────────────────────
DO $$
DECLARE
  expected record;
  got integer;
BEGIN
  SELECT count(*) INTO got FROM permissions
   WHERE cerbos_kind = 'calendar_event' AND class = 'grantable' AND module_key = 'core'
     AND sensitive = false AND ui_grantable = true;
  IF got <> 5 THEN
    RAISE EXCEPTION '202610150410: expected 5 grantable, non-sensitive, ui_grantable calendar_event permissions, found %', got;
  END IF;

  FOR expected IN
    SELECT * FROM (VALUES
      ('platform_admin', 5), ('company_admin', 5), ('owner', 5), ('manager', 5),
      ('member', 5), ('viewer', 2),
      ('org_unit_lead', 0), ('client', 0), ('group_executive', 0), ('webdev_staff', 0), ('webdev_manager', 0), ('hr_manager', 0)
    ) AS x(role_name, expected_count)
  LOOP
    SELECT count(*) INTO got
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND r.name = expected.role_name
       AND p.cerbos_kind = 'calendar_event';
    IF got <> expected.expected_count THEN
      RAISE EXCEPTION '202610150410: role "%": expected % bundled calendar_event permission(s), found % (missing/typo''d role name or key, or a prior partial application)',
        expected.role_name, expected.expected_count, got;
    END IF;
  END LOOP;

  -- Only the full-reach tier, members and managers (self-scoped) update or cancel: a viewer never edits or cancels.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL
     AND p.key IN ('core.calendar_event.update', 'core.calendar_event.cancel')
     AND r.name NOT IN ('platform_admin', 'company_admin', 'owner', 'member', 'manager');
  IF got <> 0 THEN
    RAISE EXCEPTION '202610150410: update/cancel leaked to % row(s) outside platform_admin/company_admin/owner/member/manager', got;
  END IF;

  -- A viewer never schedules, edits or cancels.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.cerbos_kind = 'calendar_event'
     AND (r.name = 'viewer' AND p.action NOT IN ('read', 'respond'));
  IF got <> 0 THEN
    RAISE EXCEPTION '202610150410: viewer holds % calendar_event permission(s) outside its reach', got;
  END IF;

  -- The self-scoped marker: exactly member and manager update/cancel/respond, and viewer·respond, and nothing else on this kind.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.cerbos_kind = 'calendar_event' AND rp.self_scoped
     AND NOT ((r.name IN ('member', 'manager') AND p.key IN ('core.calendar_event.update', 'core.calendar_event.cancel', 'core.calendar_event.respond'))
              OR (r.name = 'viewer' AND p.key = 'core.calendar_event.respond'));
  IF got <> 0 THEN
    RAISE EXCEPTION '202610150410: % unexpected self_scoped calendar_event row(s)', got;
  END IF;
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND rp.self_scoped
     AND ((r.name IN ('member', 'manager') AND p.key IN ('core.calendar_event.update', 'core.calendar_event.cancel', 'core.calendar_event.respond'))
          OR (r.name = 'viewer' AND p.key = 'core.calendar_event.respond'));
  IF got <> 7 THEN
    RAISE EXCEPTION '202610150410: member and manager update/cancel/respond and viewer·respond must all be marked self_scoped (found %)', got;
  END IF;

  -- owner ≡ company_admin, in BOTH directions (equal counts alone would not catch the wrong keys).
  SELECT count(*) INTO got FROM (
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
        AND p.cerbos_kind = 'calendar_event'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin'
        AND p.cerbos_kind = 'calendar_event')
    UNION ALL
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin'
        AND p.cerbos_kind = 'calendar_event'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
        AND p.cerbos_kind = 'calendar_event')
  ) diff;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610150410: owner''s calendar_event bundle diverges from company_admin''s by % key(s) — owner-role.db.test.ts will fail', got;
  END IF;

  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.cerbos_kind = 'calendar_event';
  IF got <> 27 THEN
    RAISE EXCEPTION '202610150410: total bundled calendar_event permissions on global roles: expected 27 (3x5 + 5 + 5 + 2), found %', got;
  END IF;

  RAISE NOTICE '202610150410: role_permissions seeded — % calendar_event rows across 6 global roles', got;
END $$;
