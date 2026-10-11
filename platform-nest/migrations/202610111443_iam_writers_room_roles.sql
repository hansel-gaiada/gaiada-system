-- 202610111443 — M5-W1a: the writers' room roles and review permissions (IAM seed; no DDL).
-- docs/plans/2026-10-11-m5-writers-room-design.md §2 (roles as data-driven grants), §6 (this file), §7 (the six
-- artifacts), §9 row W1a. PERMISSION-CONTRACT §27.
--
-- WHAT THIS ADDS
--   1. Four GLOBAL roles stored as data: webdesk_writer, webdesk_translator, webdesk_seo_reviewer, webdesk_editor.
--      Each is granted as a `user_roles` row at scope_type `company` PLUS scope rows (site; collections or all;
--      locales or all) that W1b adds in its own migration (`user_role_editorial_scopes`). Cerbos matches them by
--      ATTRIBUTE conditions (derived_roles.yaml: the grant's scope rows against resource.attr.siteId /
--      collectionKey / locale). **NO bundle (0 role_permissions rows) and NO perm_* mirror, permanently**: a flat
--      catalog key cannot say "this site, these collections, these locales", so a bundle would overstate reach
--      and a mirror would over-grant (the client_website_editor precedent, 202610110520).
--   2. Seven catalog permissions on two EXISTING Cerbos kinds (no new kind):
--        webdev.webdesk_content_item.{submit, comment, request_changes, seo_signoff, approve, assign}
--        webdev.webdesk_collection.manage_editorial
--      sensitive: approve, seo_signoff, manage_editorial. All ui_grantable, like every other key on both kinds.
--   3. Their role_permissions rows, a mechanical transcription of the policies' role-arm ALLOW rules (exactly what
--      `npm run gen:role-bundles` derives; role-permission-bundles.json carries the same 30 pairs):
--        platform_admin, company_admin, owner, webdev_manager — all 7 (owner MUST mirror company_admin exactly:
--                                                               owner-role.db.test.ts; a new company_admin key
--                                                               does NOT propagate to owner on its own)
--        webdev_staff — submit, comment (2)                    (module_staff, the unscoped editor tier)
--        manager, member, client, viewer, every other role — NOTHING; the four new roles — NOTHING.
--
-- WHAT THIS DOES NOT DO (later tickets, by design)
--   - The scope-row table, the `user_roles_editorial_guard` trigger that keeps the four roles at `company` scope
--     and off position role sets, assemblePrincipal()'s `editorialScopes`, and the dedicated grant path: W1b.
--     Until then a grant of one of these roles (e.g. through the legacy admin path) carries no scope rows and
--     matches NOTHING in Cerbos (the derived roles require has(g.editorialScopes) and a matching row), so the
--     window between this file and W1b is fail-closed: the roles exist, but no grant of them reaches anything.
--   - The contributor principal (users.kind = 'contributor', design §3): W1d, gated on owner question O-4.
--
-- RLS / DML NOTE: migrations run as platform_owner, which has NO BYPASSRLS. The only DML is on `roles`,
-- `permissions` and `role_permissions`, which are GLOBAL reference tables with no RLS (0093's own conclusion),
-- so the zero-rows trap does not apply. No tenant row is written or backfilled.

-- ═══════════════ (1) the four roles, as data ═══════════════════════════════════════════════════════════════
-- `roles` has UNIQUE (company_id, name) which never fires for company_id IS NULL, so NOT EXISTS is the guard.
INSERT INTO roles (id, company_id, name, description)
SELECT gen_random_uuid(), NULL, v.name, v.description
FROM (VALUES
  ('webdesk_writer',
   'Writers'' room (M5-W1): writes WebDesk content in the sites, collections and locales of its grant''s scope rows; edits, submits and comments on its OWN items only, and edits only a draft or an item with changes requested. Company scope only. No bundle and no perm_* mirror: checked by an attribute condition in Cerbos.'),
  ('webdesk_translator',
   'Writers'' room (M5-W1): creates locale twins of WebDesk items whose source has an approved or live version, in its grant''s scope; otherwise the writer''s rights on its own items. Company scope only. No bundle and no perm_* mirror.'),
  ('webdesk_seo_reviewer',
   'Writers'' room (M5-W1): reviews WebDesk items in its grant''s scope: edits while in review, comments, requests changes, records the SEO/AEO sign-off. Never approves or requests publication. Company scope only. No bundle and no perm_* mirror.'),
  ('webdesk_editor',
   'Writers'' room (M5-W1): the scoped review desk: creates, edits, submits, comments, requests changes, assigns, approves (maker != checker against the version''s creator) and requests publication in its grant''s scope. Never publishes, schedules, unpublishes or deletes. Company scope only. No bundle and no perm_* mirror.')
) AS v(name, description)
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.company_id IS NULL AND r.name = v.name);

-- ═══════════════ (2) the seven catalog permissions ═══════════════════════════════════════════════════════════
-- `permissions.id` has no default, so it is supplied explicitly (202608310900's pattern). ui_grantable is
-- explicit (0110's DEFAULT true would otherwise decide).
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('webdev.webdesk_content_item.submit', 'webdev', 'webdesk_content_item', 'submit',
   'Submit a WebDesk item''s head version for editorial review, or withdraw it (writers'' room; WebDesk editorial.submit / editorial.withdraw, MEDIUM). Scoped roles: own items only.',
   'webdesk_content_item', 'submit', 'grantable', false, true),
  ('webdev.webdesk_content_item.comment', 'webdev', 'webdesk_content_item', 'comment',
   'Comment on (and resolve comments on) a WebDesk item under review (writers'' room; editorial.comment, MEDIUM). Writers and translators: own items only.',
   'webdesk_content_item', 'comment', 'grantable', false, true),
  ('webdev.webdesk_content_item.request_changes', 'webdev', 'webdesk_content_item', 'request_changes',
   'Send a WebDesk item under review back to its author with a note (writers'' room; editorial.requestChanges, MEDIUM).',
   'webdesk_content_item', 'request_changes', 'grantable', false, true),
  ('webdev.webdesk_content_item.seo_signoff', 'webdev', 'webdesk_content_item', 'seo_signoff',
   'Record the SEO/AEO sign-off of the submitted version of a WebDesk item (writers'' room; editorial.seoSignoff, MEDIUM). Never an automation or bot principal.',
   'webdesk_content_item', 'seo_signoff', 'grantable', true, true),
  ('webdev.webdesk_content_item.approve', 'webdev', 'webdesk_content_item', 'approve',
   'Approve the submitted version of a WebDesk item for publication (writers'' room; editorial.approve, MEDIUM). Maker != checker against the version''s creator, for every principal; never an automation, bot or contributor principal. Publishing it is still a separate WS4 publish.',
   'webdesk_content_item', 'approve', 'grantable', true, true),
  ('webdev.webdesk_content_item.assign', 'webdev', 'webdesk_content_item', 'assign',
   'Assign a WebDesk item to an author with due and planned-publish dates and a brief (writers'' room; editorial.assign, MEDIUM).',
   'webdesk_content_item', 'assign', 'grantable', false, true),
  ('webdev.webdesk_collection.manage_editorial', 'webdev', 'webdesk_collection', 'manage_editorial',
   'Grant and revoke the writers'' room roles (writer, translator, SEO reviewer, editor) on a WebDesk site and set a collection''s review policy. Same holders as apply_schema; the live ceiling for an editorial grant.',
   'webdesk_collection', 'manage_editorial', 'grantable', true, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

-- ═══════════════ (3) role_permissions — the role arm, transcribed ═════════════════════════════════════════════
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (
  -- the full tier: every new key
  SELECT f.role_name, k.perm_key
    FROM (VALUES ('platform_admin'), ('company_admin'), ('owner'), ('webdev_manager')) AS f(role_name)
   CROSS JOIN (VALUES
     ('webdev.webdesk_content_item.submit'), ('webdev.webdesk_content_item.comment'),
     ('webdev.webdesk_content_item.request_changes'), ('webdev.webdesk_content_item.seo_signoff'),
     ('webdev.webdesk_content_item.approve'), ('webdev.webdesk_content_item.assign'),
     ('webdev.webdesk_collection.manage_editorial')
   ) AS k(perm_key)
  UNION ALL
  -- the unscoped editor tier (module_staff)
  SELECT 'webdev_staff', k.perm_key
    FROM (VALUES ('webdev.webdesk_content_item.submit'), ('webdev.webdesk_content_item.comment')) AS k(perm_key)
) AS v(role_name, perm_key)
JOIN roles r ON r.company_id IS NULL AND r.name = v.role_name
JOIN permissions p ON p.key = v.perm_key
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
);

-- ═══════════════ Assert, don't assume (202608310900's discipline) ═════════════════════════════════════════════
DO $$
DECLARE
  expected record;
  got integer;
BEGIN
  -- the four roles: exactly one global row each, and NOT ONE bundle row (no perm_* mirror may ever be implied)
  SELECT count(*) INTO got FROM roles
   WHERE company_id IS NULL
     AND name IN ('webdesk_writer', 'webdesk_translator', 'webdesk_seo_reviewer', 'webdesk_editor');
  IF got <> 4 THEN
    RAISE EXCEPTION '202610111443: expected exactly 4 global writers'' room roles, found %', got;
  END IF;
  SELECT count(*) INTO got FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
   WHERE r.name IN ('webdesk_writer', 'webdesk_translator', 'webdesk_seo_reviewer', 'webdesk_editor');
  IF got <> 0 THEN
    RAISE EXCEPTION '202610111443: the writers'' room roles must carry no permission bundle, found % row(s)', got;
  END IF;

  -- the seven keys, with their flags
  SELECT count(*) INTO got FROM permissions
   WHERE class = 'grantable' AND ui_grantable
     AND ((cerbos_kind = 'webdesk_content_item'
           AND cerbos_action IN ('submit', 'comment', 'request_changes', 'seo_signoff', 'approve', 'assign'))
       OR (cerbos_kind = 'webdesk_collection' AND cerbos_action = 'manage_editorial'));
  IF got <> 7 THEN
    RAISE EXCEPTION '202610111443: expected 7 writers'' room permissions, found %', got;
  END IF;
  SELECT count(*) INTO got FROM permissions
   WHERE sensitive AND key IN ('webdev.webdesk_content_item.seo_signoff', 'webdev.webdesk_content_item.approve',
                               'webdev.webdesk_collection.manage_editorial');
  IF got <> 3 THEN
    RAISE EXCEPTION '202610111443: expected approve, seo_signoff and manage_editorial to be sensitive, found % of 3', got;
  END IF;

  -- per-role counts over the seven keys
  FOR expected IN
    SELECT * FROM (VALUES
      ('platform_admin', 7), ('company_admin', 7), ('owner', 7), ('webdev_manager', 7),
      ('webdev_staff', 2),
      ('manager', 0), ('member', 0), ('client', 0), ('viewer', 0)
    ) AS x(role_name, expected_count)
  LOOP
    SELECT count(*) INTO got
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND r.name = expected.role_name
       AND (p.key LIKE 'webdev.webdesk\_content\_item.%'
            AND p.cerbos_action IN ('submit', 'comment', 'request_changes', 'seo_signoff', 'approve', 'assign')
            OR p.key = 'webdev.webdesk_collection.manage_editorial');
    IF got <> expected.expected_count THEN
      RAISE EXCEPTION '202610111443: role "%": expected % bundled writers'' room permission(s), found % (missing/typo''d role name or key, or a prior partial application)',
        expected.role_name, expected.expected_count, got;
    END IF;
  END LOOP;

  -- webdev_staff holds exactly submit + comment, never a review decision
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND r.name = 'webdev_staff'
     AND p.key IN ('webdev.webdesk_content_item.request_changes', 'webdev.webdesk_content_item.seo_signoff',
                   'webdev.webdesk_content_item.approve', 'webdev.webdesk_content_item.assign',
                   'webdev.webdesk_collection.manage_editorial');
  IF got <> 0 THEN
    RAISE EXCEPTION '202610111443: webdev_staff must not hold a review decision key, found %', got;
  END IF;

  -- owner ≡ company_admin over the seven keys, in BOTH directions (equal counts alone would not catch wrong keys)
  SELECT count(*) INTO got FROM (
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
        AND p.cerbos_kind IN ('webdesk_content_item', 'webdesk_collection')
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin'
        AND p.cerbos_kind IN ('webdesk_content_item', 'webdesk_collection'))
    UNION ALL
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin'
        AND p.cerbos_kind IN ('webdesk_content_item', 'webdesk_collection')
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
        AND p.cerbos_kind IN ('webdesk_content_item', 'webdesk_collection'))
  ) diff;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610111443: owner''s webdesk_content_item/webdesk_collection bundle diverges from company_admin''s by % key(s) — owner-role.db.test.ts will fail', got;
  END IF;

  -- the total, and no leak to any role outside the five named holders
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE p.key IN ('webdev.webdesk_content_item.submit', 'webdev.webdesk_content_item.comment',
                   'webdev.webdesk_content_item.request_changes', 'webdev.webdesk_content_item.seo_signoff',
                   'webdev.webdesk_content_item.approve', 'webdev.webdesk_content_item.assign',
                   'webdev.webdesk_collection.manage_editorial');
  IF got <> 30 THEN
    RAISE EXCEPTION '202610111443: total bundled writers'' room permissions: expected 30 (4x7 + 2), found % (a row on a role outside platform_admin/company_admin/owner/webdev_manager/webdev_staff, or a per-company role)', got;
  END IF;

  RAISE NOTICE '202610111443: 4 writers'' room roles (no bundle), 7 permissions, % role_permissions rows', got;
END $$;
