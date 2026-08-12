-- SMM-30 — register the `social` module in the IAM layer: 36 catalog permissions, the two module
-- roles Cerbos will actually look for, and every role->permission bundle pair the new policies imply.
--
-- Design: docs/blueprints/smm-design.md §11 as amended by
-- docs/blueprints/smm-design-addendum-2026-08-12.md §A1 (Δ1/Δ2) and §A2 (D-16).
-- Companion policies: cerbos/policies/resource_social_*.yaml (8 new files) + the `approve_post`
-- action added to resource_portal.yaml. Schema: 0105_module_social.sql.
--
-- ── WHY THIS MIGRATION EXISTS AT ALL (the thing the SMM design could not have known) ─────────────
-- When the SMM design was written (2026-07-23) a module declared permissions as free-form strings.
-- Since IAM Phase 1 they are DATA: `permissions` is a DB-seeded catalog (0093), `role_permissions`
-- is a seeded bundle table (0094), and `validateModulePermissions()` REFUSES BOOT if any
-- `ModuleContract.permissions` key does not resolve to a `class='grantable'` catalog row. So the
-- social module cannot register — the platform will not start with it compiled in — until these
-- rows exist. That is why this lands before the module shell (SMM-02), not after it.
--
-- The design's own key format (`social:engagement:read`) is likewise obsolete: the contract is
-- `<domain>.<resource>.<action>`. Every key below is dotted.
--
-- ── ROLE NAMES ARE NOT A CHOICE (corrects the design AND the addendum) ──────────────────────────
-- `derived_roles.yaml`'s module_staff/module_manager pair string-composes the required role name at
-- request time from `resource.attr.module`:
--     g.role == (resource.attr.module + "_staff")  /  (resource.attr.module + "_manager")
-- The module key is `social`, so the ONLY names Cerbos will ever look for are `social_staff` and
-- `social_manager`. The design (§12) and the 2026-08-12 addendum both said "smm_manager/smm_staff" —
-- that would have seeded two roles nothing ever matches, i.e. the exact silent-skip defect
-- 0069/0091/0097 each closed for reports_*/search_*/webdev_* in turn. Corrected here, in the
-- addendum, and in `scripts/generate-role-bundles.mjs`, which carries the same note.
--
-- ── WHAT THIS MIGRATION DOES NOT DO ─────────────────────────────────────────────────────────────
-- It grants nothing to any user. Seeding a `roles` row makes a name grantable; the reconciler still
-- only materializes `social_staff`/`social_manager` onto a SERVED company via an ACTIVE
-- `service_assignments` row, of which there are none for `module_key='social'` (the module does not
-- exist yet). **Zero authorization decisions change for any existing user**: the bundle diff that
-- produced this file's VALUES list adds 162 pairs and REMOVES NONE — machine-checked, not asserted
-- by hand (see PROVENANCE below).
--
-- ── PROVENANCE OF THE VALUES BELOW ──────────────────────────────────────────────────────────────
-- Not hand-typed. The permission rows are the 36 new entries of `src/rbac/permission-catalog.json`;
-- the bundle rows are exactly the set difference between `src/rbac/role-permission-bundles.json`
-- before and after `npm run gen:role-bundles` re-derived it from the new Cerbos policies. That
-- generator IS the third independent expression of 0094's algorithm, so these rows and the
-- checked-in artifact cannot disagree — `role-permission-bundles.db.test.ts` pins that they don't.
--
-- ── NUMBERING ───────────────────────────────────────────────────────────────────────────────────
-- 0106 reserved by creating this file alongside 0105 (SMM-01) before either was written; head at
-- write time was 0104. `0058`/`0059`/`0070` remain permanently-orphaned reservations.
--
-- ── RLS ─────────────────────────────────────────────────────────────────────────────────────────
-- `permissions`, `roles` (company_id IS NULL here) and `role_permissions` are GLOBAL reference
-- tables with no RLS, so the "migration runs NOBYPASSRLS with an unset tenant GUC -> silently
-- matches zero rows and reports success" trap does not apply structurally. Asserted anyway below,
-- per the discipline 0095/0096/0097 established.

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 1 · The 36 catalog permissions (35 social.* + portal.approve_post)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- `portal.approve_post` is `portal.*`, NOT `social.*`, by owner decision DR-4: the client portal is
-- its own trust surface and therefore its own domain. It is the CLIENT's half of the two-sided
-- review seam (addendum D-16); the staff half is `social.client_review.*`, a different Cerbos kind
-- against a differently-walled table.
INSERT INTO permissions (id, key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description, v.cerbos_kind, v.cerbos_action, v.class, v.sensitive
FROM (VALUES
  ('portal.approve_post', 'portal', 'portal', 'approve_post', 'Approve, or request changes to, a social post drafted for your brand.', 'portal', 'approve_post', 'grantable', true),
  ('social.account.connect', 'social', 'account', 'connect', 'Connect a client''s social account, authorizing our platform app to post as that brand.', 'social_account', 'connect', 'grantable', true),
  ('social.account.delete', 'social', 'account', 'delete', 'Disconnect a client''s social account.', 'social_account', 'delete', 'grantable', true),
  ('social.account.read', 'social', 'account', 'read', 'View the social connector registry: connection status, quota and health.', 'social_account', 'read', 'grantable', false),
  ('social.account.update', 'social', 'account', 'update', 'Edit connector-registry metadata for a connected social account.', 'social_account', 'update', 'grantable', false),
  ('social.client_review.read', 'social', 'client_review', 'read', 'View client sign-off state on social posts.', 'social_client_review', 'read', 'grantable', false),
  ('social.client_review.request', 'social', 'client_review', 'request', 'Send a social post to the client for sign-off.', 'social_client_review', 'request', 'grantable', false),
  ('social.client_review.withdraw', 'social', 'client_review', 'withdraw', 'Withdraw a pending client sign-off request.', 'social_client_review', 'withdraw', 'grantable', false),
  ('social.engagement.create', 'social', 'engagement', 'create', 'Create a social-media engagement for a client.', 'social_engagement', 'create', 'grantable', false),
  ('social.engagement.delete', 'social', 'engagement', 'delete', 'Delete a social-media engagement.', 'social_engagement', 'delete', 'grantable', false),
  ('social.engagement.read', 'social', 'engagement', 'read', 'View social-media engagements and their brand-voice profile.', 'social_engagement', 'read', 'grantable', false),
  ('social.engagement.set_scope', 'social', 'engagement', 'set_scope', 'Set an engagement''s tool scope and metered budget: which networks may publish, which AI is enabled, and how much spend is allowed.', 'social_engagement', 'set_scope', 'grantable', true),
  ('social.engagement.update', 'social', 'engagement', 'update', 'Edit a social-media engagement and its brand-voice profile.', 'social_engagement', 'update', 'grantable', false),
  ('social.inbox.assign', 'social', 'inbox', 'assign', 'Assign an inbox thread and set its status.', 'social_inbox', 'assign', 'grantable', false),
  ('social.inbox.escalate', 'social', 'inbox', 'escalate', 'Escalate an inbox thread to a lead.', 'social_inbox', 'escalate', 'grantable', false),
  ('social.inbox.read', 'social', 'inbox', 'read', 'View the engagement inbox: comments, mentions and DMs.', 'social_inbox', 'read', 'grantable', false),
  ('social.inbox.reply', 'social', 'inbox', 'reply', 'Send a reply from a client''s social account.', 'social_inbox', 'reply', 'grantable', true),
  ('social.ledger.admin', 'social', 'ledger', 'admin', 'Override a social metered-spend stop-loss or raise an engagement''s cap.', 'social_ledger', 'admin', 'grantable', true),
  ('social.ledger.read', 'social', 'ledger', 'read', 'View metered social spend against the engagement''s cap.', 'social_ledger', 'read', 'grantable', false),
  ('social.platform_app.admin', 'social', 'platform_app', 'admin', 'Manage our social platform-app fleet: registrations, review outcomes and credential aliases.', 'social_platform_app', 'admin', 'grantable', true),
  ('social.platform_app.read', 'social', 'platform_app', 'read', 'View our approved social platform-app fleet and its review status.', 'social_platform_app', 'read', 'grantable', false),
  ('social.post.cancel', 'social', 'post', 'cancel', 'Cancel a scheduled, not-yet-published post.', 'social_post', 'cancel', 'grantable', true),
  ('social.post.create', 'social', 'post', 'create', 'Create a social post and its per-network variants.', 'social_post', 'create', 'grantable', false),
  ('social.post.delete', 'social', 'post', 'delete', 'Delete an unpublished social post or variant.', 'social_post', 'delete', 'grantable', false),
  ('social.post.delete_published', 'social', 'post', 'delete_published', 'Delete a post that is already public on a client''s social account.', 'social_post', 'delete_published', 'grantable', true),
  ('social.post.import_native', 'social', 'post', 'import_native', 'Record a post that was published by hand in the network''s own app (bookkeeping only).', 'social_post', 'import_native', 'grantable', false),
  ('social.post.publish', 'social', 'post', 'publish', 'Decide that approved content is published to a client''s live social account.', 'social_post', 'publish', 'grantable', true),
  ('social.post.read', 'social', 'post', 'read', 'View the content calendar, posts and per-network variants.', 'social_post', 'read', 'grantable', false),
  ('social.post.submit', 'social', 'post', 'submit', 'Submit a post variant for publish approval.', 'social_post', 'submit', 'grantable', false),
  ('social.post.update', 'social', 'post', 'update', 'Edit a social post, its variants, media and schedule.', 'social_post', 'update', 'grantable', false),
  ('social.report.approve', 'social', 'report', 'approve', 'Approve a social-media client report for delivery.', 'social_report', 'approve', 'grantable', true),
  ('social.report.create', 'social', 'report', 'create', 'Create a social-media client report.', 'social_report', 'create', 'grantable', false),
  ('social.report.delete', 'social', 'report', 'delete', 'Delete a draft social-media report.', 'social_report', 'delete', 'grantable', false),
  ('social.report.deliver', 'social', 'report', 'deliver', 'Deliver a social-media report to the client.', 'social_report', 'deliver', 'grantable', true),
  ('social.report.read', 'social', 'report', 'read', 'View social-media client reports.', 'social_report', 'read', 'grantable', false),
  ('social.report.update', 'social', 'report', 'update', 'Edit a social-media report''s metrics snapshot and narrative.', 'social_report', 'update', 'grantable', false)
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

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 2 · The two module roles
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- IDIOM: identical to 0026 block (E) / 0069 / 0091 / 0095 / 0096 / 0097 — a global role has
-- `company_id IS NULL`, and SQL NULLs are distinct for `UNIQUE (company_id, name)`, so
-- `ON CONFLICT (company_id, name)` cannot de-duplicate a NULL-company_id row. The `NOT EXISTS`
-- guard scoped explicitly to `company_id IS NULL` is what makes this idempotent.
-- `0073_dedupe_global_roles.sql`'s partial unique index backstops it at the constraint level.
INSERT INTO roles (id, company_id, name, description)
SELECT gen_random_uuid(), NULL, r.name, r.description
FROM (VALUES
  ('social_staff',
   'Social Media module_staff (WSD-2/ORG-6) — served-company grant: run the content desk and the engagement inbox. Authors posts and variants, submits them for approval, requests client sign-off, replies to comments, drafts reports, and reads the connector registry and the metered ledger. Cannot publish, cannot take a published post down, cannot connect an account, cannot set the engagement''s scope or budget, cannot approve or deliver a report.'),
  ('social_manager',
   'Social Media module_manager (WSD-2/ORG-6) — served-company grant: the full department working set, including the decisions staff cannot make: publish, cancel, delete_published, connect a client account, set the engagement''s tool scope and metered budget, and approve/deliver client reports. Does NOT include overriding a metered stop-loss — social.ledger.admin sits with company_admin, one tier up from the person spending the budget.')
) AS r(name, description)
WHERE NOT EXISTS (
  SELECT 1 FROM roles WHERE company_id IS NULL AND roles.name = r.name
);

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 3 · The bundles — 162 (role, permission) pairs, machine-derived (see PROVENANCE above)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- This is more rows than two new roles would suggest, because it is not only the two new roles:
-- every role the new Cerbos policies give reach to needs its bundle updated in the SAME change, or
-- `role-permission-bundles.db.test.ts` (checked-in artifact == DB) fails. The split is:
--   platform_admin  +36  (its wildcard rule covers every action on every new kind)
--   company_admin   +33  (full tenant surface, including social.ledger.admin)
--   manager         +32  (identical MINUS social.ledger.admin — the deliberate one-key difference)
--   social_manager  +33  (32 module keys + the generic core.service_assignment.read)
--   social_staff    +19  (17 module keys + core.member.read + core.service_assignment.read)
--   group_executive  +8  (read on each of the 8 new kinds, and nothing else)
--   client           +1  (portal.approve_post)
-- The two `core.*` pairs on the module roles are not a social special case: the underlying rules in
-- resource_member.yaml / resource_service_assignment.yaml carry no module hardcode, so they fire for
-- ANY module string — exactly as 0094 bundled them onto hr_*/search_*/reports_* and 0098 onto
-- webdev_*.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('client', 'portal.approve_post'),
  ('company_admin', 'social.account.connect'),
  ('company_admin', 'social.account.delete'),
  ('company_admin', 'social.account.read'),
  ('company_admin', 'social.account.update'),
  ('company_admin', 'social.client_review.read'),
  ('company_admin', 'social.client_review.request'),
  ('company_admin', 'social.client_review.withdraw'),
  ('company_admin', 'social.engagement.create'),
  ('company_admin', 'social.engagement.delete'),
  ('company_admin', 'social.engagement.read'),
  ('company_admin', 'social.engagement.set_scope'),
  ('company_admin', 'social.engagement.update'),
  ('company_admin', 'social.inbox.assign'),
  ('company_admin', 'social.inbox.escalate'),
  ('company_admin', 'social.inbox.read'),
  ('company_admin', 'social.inbox.reply'),
  ('company_admin', 'social.ledger.admin'),
  ('company_admin', 'social.ledger.read'),
  ('company_admin', 'social.post.cancel'),
  ('company_admin', 'social.post.create'),
  ('company_admin', 'social.post.delete'),
  ('company_admin', 'social.post.delete_published'),
  ('company_admin', 'social.post.import_native'),
  ('company_admin', 'social.post.publish'),
  ('company_admin', 'social.post.read'),
  ('company_admin', 'social.post.submit'),
  ('company_admin', 'social.post.update'),
  ('company_admin', 'social.report.approve'),
  ('company_admin', 'social.report.create'),
  ('company_admin', 'social.report.delete'),
  ('company_admin', 'social.report.deliver'),
  ('company_admin', 'social.report.read'),
  ('company_admin', 'social.report.update'),
  ('group_executive', 'social.account.read'),
  ('group_executive', 'social.client_review.read'),
  ('group_executive', 'social.engagement.read'),
  ('group_executive', 'social.inbox.read'),
  ('group_executive', 'social.ledger.read'),
  ('group_executive', 'social.platform_app.read'),
  ('group_executive', 'social.post.read'),
  ('group_executive', 'social.report.read'),
  ('manager', 'social.account.connect'),
  ('manager', 'social.account.delete'),
  ('manager', 'social.account.read'),
  ('manager', 'social.account.update'),
  ('manager', 'social.client_review.read'),
  ('manager', 'social.client_review.request'),
  ('manager', 'social.client_review.withdraw'),
  ('manager', 'social.engagement.create'),
  ('manager', 'social.engagement.delete'),
  ('manager', 'social.engagement.read'),
  ('manager', 'social.engagement.set_scope'),
  ('manager', 'social.engagement.update'),
  ('manager', 'social.inbox.assign'),
  ('manager', 'social.inbox.escalate'),
  ('manager', 'social.inbox.read'),
  ('manager', 'social.inbox.reply'),
  ('manager', 'social.ledger.read'),
  ('manager', 'social.post.cancel'),
  ('manager', 'social.post.create'),
  ('manager', 'social.post.delete'),
  ('manager', 'social.post.delete_published'),
  ('manager', 'social.post.import_native'),
  ('manager', 'social.post.publish'),
  ('manager', 'social.post.read'),
  ('manager', 'social.post.submit'),
  ('manager', 'social.post.update'),
  ('manager', 'social.report.approve'),
  ('manager', 'social.report.create'),
  ('manager', 'social.report.delete'),
  ('manager', 'social.report.deliver'),
  ('manager', 'social.report.read'),
  ('manager', 'social.report.update'),
  ('platform_admin', 'portal.approve_post'),
  ('platform_admin', 'social.account.connect'),
  ('platform_admin', 'social.account.delete'),
  ('platform_admin', 'social.account.read'),
  ('platform_admin', 'social.account.update'),
  ('platform_admin', 'social.client_review.read'),
  ('platform_admin', 'social.client_review.request'),
  ('platform_admin', 'social.client_review.withdraw'),
  ('platform_admin', 'social.engagement.create'),
  ('platform_admin', 'social.engagement.delete'),
  ('platform_admin', 'social.engagement.read'),
  ('platform_admin', 'social.engagement.set_scope'),
  ('platform_admin', 'social.engagement.update'),
  ('platform_admin', 'social.inbox.assign'),
  ('platform_admin', 'social.inbox.escalate'),
  ('platform_admin', 'social.inbox.read'),
  ('platform_admin', 'social.inbox.reply'),
  ('platform_admin', 'social.ledger.admin'),
  ('platform_admin', 'social.ledger.read'),
  ('platform_admin', 'social.platform_app.admin'),
  ('platform_admin', 'social.platform_app.read'),
  ('platform_admin', 'social.post.cancel'),
  ('platform_admin', 'social.post.create'),
  ('platform_admin', 'social.post.delete'),
  ('platform_admin', 'social.post.delete_published'),
  ('platform_admin', 'social.post.import_native'),
  ('platform_admin', 'social.post.publish'),
  ('platform_admin', 'social.post.read'),
  ('platform_admin', 'social.post.submit'),
  ('platform_admin', 'social.post.update'),
  ('platform_admin', 'social.report.approve'),
  ('platform_admin', 'social.report.create'),
  ('platform_admin', 'social.report.delete'),
  ('platform_admin', 'social.report.deliver'),
  ('platform_admin', 'social.report.read'),
  ('platform_admin', 'social.report.update'),
  ('social_manager', 'core.service_assignment.read'),
  ('social_manager', 'social.account.connect'),
  ('social_manager', 'social.account.delete'),
  ('social_manager', 'social.account.read'),
  ('social_manager', 'social.account.update'),
  ('social_manager', 'social.client_review.read'),
  ('social_manager', 'social.client_review.request'),
  ('social_manager', 'social.client_review.withdraw'),
  ('social_manager', 'social.engagement.create'),
  ('social_manager', 'social.engagement.delete'),
  ('social_manager', 'social.engagement.read'),
  ('social_manager', 'social.engagement.set_scope'),
  ('social_manager', 'social.engagement.update'),
  ('social_manager', 'social.inbox.assign'),
  ('social_manager', 'social.inbox.escalate'),
  ('social_manager', 'social.inbox.read'),
  ('social_manager', 'social.inbox.reply'),
  ('social_manager', 'social.ledger.read'),
  ('social_manager', 'social.post.cancel'),
  ('social_manager', 'social.post.create'),
  ('social_manager', 'social.post.delete'),
  ('social_manager', 'social.post.delete_published'),
  ('social_manager', 'social.post.import_native'),
  ('social_manager', 'social.post.publish'),
  ('social_manager', 'social.post.read'),
  ('social_manager', 'social.post.submit'),
  ('social_manager', 'social.post.update'),
  ('social_manager', 'social.report.approve'),
  ('social_manager', 'social.report.create'),
  ('social_manager', 'social.report.delete'),
  ('social_manager', 'social.report.deliver'),
  ('social_manager', 'social.report.read'),
  ('social_manager', 'social.report.update'),
  ('social_staff', 'core.member.read'),
  ('social_staff', 'core.service_assignment.read'),
  ('social_staff', 'social.account.read'),
  ('social_staff', 'social.client_review.read'),
  ('social_staff', 'social.client_review.request'),
  ('social_staff', 'social.engagement.read'),
  ('social_staff', 'social.inbox.assign'),
  ('social_staff', 'social.inbox.escalate'),
  ('social_staff', 'social.inbox.read'),
  ('social_staff', 'social.inbox.reply'),
  ('social_staff', 'social.ledger.read'),
  ('social_staff', 'social.post.create'),
  ('social_staff', 'social.post.import_native'),
  ('social_staff', 'social.post.read'),
  ('social_staff', 'social.post.submit'),
  ('social_staff', 'social.post.update'),
  ('social_staff', 'social.report.create'),
  ('social_staff', 'social.report.read'),
  ('social_staff', 'social.report.update')
) AS bundle(role_name, perm_key)
JOIN roles r ON r.company_id IS NULL AND r.name = bundle.role_name
JOIN permissions p ON p.key = bundle.perm_key
ON CONFLICT DO NOTHING;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 4 · Assert, don't assume
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  missing text[];
  got integer;
  expected record;
BEGIN
  -- (a) the permission rows landed (spot-check across every new kind, not just the first)
  SELECT array_agg(k) INTO missing FROM (
    SELECT unnest(ARRAY['social.engagement.set_scope','social.account.connect','social.post.publish',
                        'social.post.delete_published','social.inbox.reply','social.report.deliver',
                        'social.ledger.admin','social.platform_app.admin',
                        'social.client_review.request','portal.approve_post']) AS k
    EXCEPT SELECT key FROM permissions
  ) AS x;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0106: catalog rows missing after insert: %', missing;
  END IF;

  SELECT count(*) INTO got FROM permissions WHERE module_key = 'social';
  IF got <> 35 THEN
    RAISE EXCEPTION '0106: expected 35 social.* catalog rows, found %', got;
  END IF;

  -- (b) both roles exist exactly once at global scope
  FOR expected IN SELECT unnest(ARRAY['social_staff','social_manager']) AS name LOOP
    SELECT count(*) INTO got FROM roles WHERE company_id IS NULL AND name = expected.name;
    IF got <> 1 THEN
      RAISE EXCEPTION '0106: role "%": expected exactly 1 global row, found %', expected.name, got;
    END IF;
  END LOOP;

  -- (c) the bundles are the exact size the generator derived. A mismatch means this file and
  --     src/rbac/role-permission-bundles.json have diverged — regenerate, never edit the number.
  FOR expected IN
    SELECT * FROM (VALUES
      ('social_staff', 19),
      ('social_manager', 33)
    ) AS x(role_name, expected_count)
  LOOP
    SELECT count(*) INTO got
      FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
     WHERE r.company_id IS NULL AND r.name = expected.role_name;
    IF got <> expected.expected_count THEN
      RAISE EXCEPTION '0106: role "%": expected % bundled permissions, found %',
        expected.role_name, expected.expected_count, got;
    END IF;
  END LOOP;

  -- (d) the 15-permission relationship boundary is intact: every key this file adds is grantable,
  --     so 0093's `role_permissions_reject_relationship` trigger cannot have fired on the insert
  --     above — and no future edit can quietly reclassify one of these without failing here.
  SELECT count(*) INTO got FROM permissions
   WHERE (module_key = 'social' OR key = 'portal.approve_post') AND class <> 'grantable';
  IF got <> 0 THEN
    RAISE EXCEPTION '0106: % non-grantable social/portal permission rows — the grantable/relationship boundary moved', got;
  END IF;

  -- (e) the module roles reach NOTHING outside their own module except the two generic core keys.
  --     This is the assertion that would catch a copy-paste from another module's bundle list.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND r.name IN ('social_staff','social_manager')
     AND p.module_key <> 'social'
     AND p.key NOT IN ('core.member.read','core.service_assignment.read');
  IF got <> 0 THEN
    RAISE EXCEPTION '0106: social module roles hold % permission(s) outside the social module and the two generic core keys', got;
  END IF;
END $$;
