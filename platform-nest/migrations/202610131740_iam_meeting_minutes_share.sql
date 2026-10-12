-- IAM — PV4-05: one new action, `share_minutes`, on the EXISTING `meeting_recording` Cerbos kind (docs/plans/2026-10-12-pv4-conversation-tickets.md,
-- PV4-05; design decision 9; owner ruling PV-D23). Pure IAM seed on the global reference tables: no DDL, no tenant rows, no new kind.
-- (PV4-01's 202610122330 owns the `meeting_minutes` table.)
--
--   core.meeting_recording.share_minutes   meeting_recording   share_minutes   grantable, sensitive, ui_grantable
--
-- WHAT THE ACTION DOES: it publishes a meeting's MINUTES (a new object; the recording, transcript and participants stay internal)
-- to the meeting's client in the portal. It is sensitive for the same reason core.conversation.post is: it puts words in front of
-- a client under a named person's accountability.
--
-- WHO HOLDS IT (a mechanical transcription of the policy's role arm): exactly the roles that hold `update` on this kind today.
--   platform_admin (wildcard; 0094's methodology materialises an explicit row per grantable key anyway), company_admin, owner
--   (owner MUST mirror company_admin: owner-role.db.test.ts), manager, member.  viewer and every other role: NOTHING.
-- Saving a draft of the minutes is `update`, not this action, so an agent may DRAFT minutes.
--
-- NOTE ON THE AGENT DENY: `share_minutes` is DENIED by Cerbos to principal.attr.kind in [automation, bot] regardless of any bundle
-- row below (an EFFECT_DENY on roles: ["user"], resource_meeting_recording.yaml). The bundle rows say what a ROLE may be granted;
-- they cannot widen an agent, and a bot holding company_admin keeps `update` and `read`.
--
-- The `perm_meeting_recording_share_minutes` mirror exists in cerbos/policies/derived_roles.yaml, so a holder of the key reaches
-- the action through the permission arm (that is also how the permission-native `owner` reaches it).
--
-- `permissions.id` has no default, so it is supplied explicitly (202608310900's pattern). Idempotent.
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, 'grantable', true, true
FROM (VALUES
  ('core.meeting_recording.share_minutes', 'core', 'meeting_recording', 'share_minutes',
   'Share a meeting''s minutes with the meeting''s client in the portal (words a client reads and a named person answers for). Held by the roles that may edit the meeting. Cannot be undone from the product. Refused to bot and automation principals by a Cerbos DENY: an agent may draft minutes, a person shares them.',
   'meeting_recording', 'share_minutes')
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('platform_admin', 'core.meeting_recording.share_minutes'),
  ('company_admin',  'core.meeting_recording.share_minutes'),
  ('owner',          'core.meeting_recording.share_minutes'),
  ('manager',        'core.meeting_recording.share_minutes'),
  ('member',         'core.meeting_recording.share_minutes')
) AS v(role_name, perm_key)
JOIN roles r ON r.company_id IS NULL AND r.name = v.role_name
JOIN permissions p ON p.key = v.perm_key
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
);

-- ── Assert, don't assume ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  got integer;
BEGIN
  SELECT count(*) INTO got FROM permissions
   WHERE key = 'core.meeting_recording.share_minutes' AND class = 'grantable' AND module_key = 'core'
     AND cerbos_kind = 'meeting_recording' AND cerbos_action = 'share_minutes'
     AND sensitive = true AND ui_grantable = true;
  IF got <> 1 THEN
    RAISE EXCEPTION '202610131740: expected exactly 1 grantable, sensitive, ui_grantable core.meeting_recording.share_minutes row, found %', got;
  END IF;

  -- The exact holder set, in BOTH directions: the five global roles hold it, and no other role row (global or company-defined)
  -- does. A hand-written custom role that already carried the key is refused rather than left in place.
  SELECT count(*) INTO got FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
   WHERE p.key = 'core.meeting_recording.share_minutes' AND r.company_id IS NULL
     AND r.name IN ('platform_admin', 'company_admin', 'owner', 'manager', 'member');
  IF got <> 5 THEN
    RAISE EXCEPTION '202610131740: share_minutes should be held by the 5 global roles (platform_admin, company_admin, owner, manager, member), found %', got;
  END IF;
  SELECT count(*) INTO got FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
   WHERE p.key = 'core.meeting_recording.share_minutes'
     AND NOT (r.company_id IS NULL AND r.name IN ('platform_admin', 'company_admin', 'owner', 'manager', 'member'));
  IF got <> 0 THEN
    RAISE EXCEPTION '202610131740: share_minutes is held by % role row(s) outside its expected set', got;
  END IF;

  -- share_minutes is held by exactly the roles that hold `update` on this kind (the plan's rule), in BOTH directions.
  SELECT count(*) INTO got FROM (
    (SELECT r.id FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND p.key = 'core.meeting_recording.update'
     EXCEPT
     SELECT r.id FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND p.key = 'core.meeting_recording.share_minutes')
    UNION ALL
    (SELECT r.id FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND p.key = 'core.meeting_recording.share_minutes'
     EXCEPT
     SELECT r.id FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND p.key = 'core.meeting_recording.update')
  ) diff;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610131740: the global roles holding share_minutes diverge from those holding core.meeting_recording.update by % role(s)', got;
  END IF;

  -- owner stays equal to company_admin on the kind's whole bundle, in both directions.
  SELECT count(*) INTO got FROM (
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner' AND p.cerbos_kind = 'meeting_recording'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin' AND p.cerbos_kind = 'meeting_recording')
    UNION ALL
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin' AND p.cerbos_kind = 'meeting_recording'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner' AND p.cerbos_kind = 'meeting_recording')
  ) diff;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610131740: owner''s meeting_recording bundle diverges from company_admin''s by % key(s) — owner-role.db.test.ts will fail', got;
  END IF;
END $$;
