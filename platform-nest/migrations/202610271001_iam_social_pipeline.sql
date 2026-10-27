-- IAM — SCP-1b: the Social Media content pipeline (docs/PERMISSION-CONTRACT.md §53, docs/FRONTEND-BFF-CONTRACT.md §63.1
-- file 2; owner rulings SCP-Q2, SCP-Q9, SCP-Q11, SCP-Q13 to SCP-Q21). Pure IAM seed: no DDL (202610271000_social_pipeline.sql
-- owns the schema). Every statement here touches GLOBAL reference tables (`roles`, `permissions`, `role_permissions`), which
-- carry no RLS, so nothing below can read zero rows behind an unset tenant GUC.
--
-- No new Cerbos kind, so this is the 5th of the six artifacts (§53.13). The others, all in the same change:
--   1. cerbos/policies/resource_social_post.yaml (8 actions, 2 DENY rules, 2 mirrors, read for the two roles),
--      resource_social_engagement.yaml (plan, budget, the automation DENY, read for the two roles),
--      resource_social_report.yaml (approve/deliver narrowed to the four approvers, 3 mirrors, the automation DENY),
--      resource_portal.yaml (approve_spend and its mirror)
--   2. derived_roles.yaml: social_copywriter, social_designer, social_approver_seat, and 8 perm_* mirrors
--   3. src/rbac/cerbos.ts: `approverIds` and `creativeSource`, in the type and the resourcePayload() allow-list
--   4. src/rbac/permission-catalog.json: the 11 keys (497 pairs / 482 grantable / 218 sensitive / 112 kinds);
--      social.report.approve and .deliver become uiGrantable:false
--   5. src/rbac/permission-groups.json: social_pipeline, social_boosts; portal.approve_spend joins portal_pay
--   6. scripts/generate-role-bundles.mjs (REAL_ROLES + the two roles, OWNER_EXTENSION, DIRECT social_approver_seat: [])
--      and src/rbac/role-permission-bundles.json regenerated
--
-- ── WHAT IS SEEDED (a mechanical transcription of the regenerated bundles) ────────────────────────────────────────
--   platform_admin  every one of the 11 keys (its Cerbos wildcard; an explicit row per grantable key, 202609281704)
--   owner           social.post.approve, social.engagement.plan, social.engagement.budget (it already holds
--                   social.report.approve and .deliver): owner == company_admin + OWNER_EXTENSION (§53.11)
--   member          author, design, schedule, manage, record_client, boost: ALL self-scoped (self_scoped = true). Every
--                   rule granting them to member is the officer's (`ownerId == principal.id`) or the request assignee's
--                   (`principal.id in assigneeIds`), so a member holds no authority over another person's post.
--   social_copywriter  social.post.read, social.post.proofread, social.engagement.read
--   social_designer    social.post.read, social.post.design, social.engagement.read
--   client          portal.approve_spend
--   company_admin, manager, viewer, social_staff, social_manager, org_unit_lead and every other role: none of the 11.
--   The seat approvers (social_approver_seat) are a relationship computed per company, not a grant: no role row at all.
--
-- ── WHAT IS REMOVED (§53.7, SCP-Q20) ─────────────────────────────────────────────────────────────────────────────
--   company_admin, manager and social_manager lose social.report.approve and social.report.deliver (six pairs). DELTA-
--   asserted, the 0112 shape: each delete removes at most one row (0 on a database seeded after the policy change, or on a
--   re-run). Any CUSTOM role (company_id NOT NULL) holding one of the five approver-only keys loses it (DELTA-logged), and
--   the five keys become ui_grantable = false, so no custom role, position or request can carry them again.
--
-- ── SENSITIVE ───────────────────────────────────────────────────────────────────────────────────────────────────────
--   approve, record_client, boost, budget, portal.approve_spend (213 -> 218). `permissions.id` has no default: supplied.

-- 1. The two roles (global rows, 0106's NOT EXISTS idiom).
INSERT INTO roles (id, company_id, name, description)
SELECT gen_random_uuid(), NULL, r.name, r.description
FROM (VALUES
  ('social_copywriter',
   'Social Media Copywriter (SCP, PERMISSION-CONTRACT §53.9) — granted at company scope, directly or through a Social Media seat''s role set. Proofreads pipeline posts: suggests edits, approves the copy, returns it. Reads posts and the brand book. Never approves a post for design or publishing, and never proofreads a post they drafted or whose client they are the officer of.'),
  ('social_designer',
   'Social Media in-team Designer (SCP, PERMISSION-CONTRACT §53.9) — granted at company scope. Designs pipeline posts whose creative source is in_team: starts the design, adds and removes designs, submits for the final check. Reads posts and the brand book. A Creatives designer needs no role: they design the posts of the month request they are assigned to.')
) AS r(name, description)
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE company_id IS NULL AND roles.name = r.name);

-- 2. The eleven catalogue keys.
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('social.post.author', 'social', 'post', 'author',
   'Write a client''s pipeline post as its officer: start the draft, edit it, accept a suggestion, send it to proofread, resend it.',
   'social_post', 'author', 'grantable', false, true),
  ('social.post.proofread', 'social', 'post', 'proofread',
   'Proofread a pipeline post as the Copywriter: suggest edits, approve the copy, or return it.',
   'social_post', 'proofread', 'grantable', false, true),
  ('social.post.approve', 'social', 'post', 'approve',
   'Approve a client''s pipeline post (the HoD approval and the final check), and file or unschedule it through the publisher. The four social approvers only.',
   'social_post', 'approve', 'grantable', true, false),
  ('social.post.design', 'social', 'post', 'design',
   'Design a pipeline post: start the design, add and remove designs, submit it for the final check.',
   'social_post', 'design', 'grantable', false, true),
  ('social.post.schedule', 'social', 'post', 'schedule',
   'Schedule a pipeline post by hand at its approved date and time, unschedule or reschedule it, mark it live and enter its metrics.',
   'social_post', 'schedule', 'grantable', false, true),
  ('social.post.manage', 'social', 'post', 'manage',
   'Run a pipeline post''s team steps: block, resolve, follow up, discard, archive.',
   'social_post', 'manage', 'grantable', false, true),
  ('social.post.record_client', 'social', 'post', 'record_client',
   'Record a decision the client gave outside the portal (WhatsApp, email, a meeting), and write a client-visible comment.',
   'social_post', 'record_client', 'grantable', true, true),
  ('social.post.boost', 'social', 'post', 'boost',
   'Request, cancel, start, stop and complete a paid boost of a live post, within the budget the client agreed.',
   'social_post', 'boost', 'grantable', true, true),
  ('social.engagement.plan', 'social', 'engagement', 'plan',
   'Plan a client''s social work: the allocation (officer, creative source, target, report), the deadline table, the settings, and the Team dashboard. The four social approvers only.',
   'social_engagement', 'plan', 'grantable', false, false),
  ('social.engagement.budget', 'social', 'engagement', 'budget',
   'Propose, withdraw and record a client''s monthly boost budget, and record the client''s answer to a boost over it. The four social approvers only.',
   'social_engagement', 'budget', 'grantable', true, false),
  ('portal.approve_spend', 'portal', 'portal', 'approve_spend',
   'Agree or decline the monthly boost budget, and approve or decline a boost over what remains of it (contacts with signing capability only).',
   'portal', 'approve_spend', 'grantable', true, false)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

-- 3. Their role_permissions rows (the regenerated bundles, the owner's three new keys included).
INSERT INTO role_permissions (role_id, permission_id, self_scoped)
SELECT r.id, p.id, bundle.self_scoped
FROM (VALUES
  ('platform_admin',    'social.post.author',         false),
  ('platform_admin',    'social.post.proofread',      false),
  ('platform_admin',    'social.post.approve',        false),
  ('platform_admin',    'social.post.design',         false),
  ('platform_admin',    'social.post.schedule',       false),
  ('platform_admin',    'social.post.manage',         false),
  ('platform_admin',    'social.post.record_client',  false),
  ('platform_admin',    'social.post.boost',          false),
  ('platform_admin',    'social.engagement.plan',     false),
  ('platform_admin',    'social.engagement.budget',   false),
  ('platform_admin',    'portal.approve_spend',       false),
  ('owner',             'social.post.approve',        false),
  ('owner',             'social.engagement.plan',     false),
  ('owner',             'social.engagement.budget',   false),
  ('member',            'social.post.author',         true),
  ('member',            'social.post.design',         true),
  ('member',            'social.post.schedule',       true),
  ('member',            'social.post.manage',         true),
  ('member',            'social.post.record_client',  true),
  ('member',            'social.post.boost',          true),
  ('social_copywriter', 'social.post.read',           false),
  ('social_copywriter', 'social.post.proofread',      false),
  ('social_copywriter', 'social.engagement.read',     false),
  ('social_designer',   'social.post.read',           false),
  ('social_designer',   'social.post.design',         false),
  ('social_designer',   'social.engagement.read',     false),
  ('client',            'portal.approve_spend',       false)
) AS bundle(role_name, perm_key, self_scoped)
JOIN roles r ON r.company_id IS NULL AND r.name = bundle.role_name
JOIN permissions p ON p.key = bundle.perm_key
ON CONFLICT (role_id, permission_id) DO UPDATE SET self_scoped = EXCLUDED.self_scoped;

-- 4. The narrowing (§53.7), the custom-role sweep and ui_grantable, then the self-assertion.
DO $$
DECLARE
  n integer;
  got integer;
  k record;
  approver_keys text[] := ARRAY['social.post.approve', 'social.engagement.plan', 'social.engagement.budget',
                                'social.report.approve', 'social.report.deliver'];
  new_keys text[] := ARRAY['social.post.author', 'social.post.proofread', 'social.post.approve', 'social.post.design',
                           'social.post.schedule', 'social.post.manage', 'social.post.record_client', 'social.post.boost',
                           'social.engagement.plan', 'social.engagement.budget', 'portal.approve_spend'];
BEGIN
  -- The two role rows this file and the bundle rows above depend on.
  SELECT count(*) INTO got FROM roles WHERE company_id IS NULL AND name IN ('social_copywriter', 'social_designer');
  IF got <> 2 THEN
    RAISE EXCEPTION '202610271001: expected the two global roles social_copywriter and social_designer, found %', got;
  END IF;

  -- ── The six deletes: company_admin, manager, social_manager lose report approve and deliver. DELTA (0112): each pair
  -- removes at most one row; 0 is legitimate on an environment seeded after the change, or on a re-run. ──
  FOR k IN
    SELECT * FROM (VALUES
      ('company_admin', 'social.report.approve'), ('company_admin', 'social.report.deliver'),
      ('manager', 'social.report.approve'), ('manager', 'social.report.deliver'),
      ('social_manager', 'social.report.approve'), ('social_manager', 'social.report.deliver')
    ) AS x(role_name, perm_key)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM roles WHERE company_id IS NULL AND name = k.role_name) THEN
      RAISE EXCEPTION '202610271001: global role "%" not found — refusing to guess', k.role_name;
    END IF;
    DELETE FROM role_permissions rp
     USING roles r, permissions p
     WHERE rp.role_id = r.id AND rp.permission_id = p.id
       AND r.company_id IS NULL AND r.name = k.role_name AND p.key = k.perm_key;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 1 THEN
      RAISE EXCEPTION '202610271001: expected at most 1 (%, %) bundle row, deleted % — duplicates in role_permissions',
        k.role_name, k.perm_key, n;
    END IF;
    RAISE NOTICE '202610271001: (%, %) deleted % row(s)', k.role_name, k.perm_key, n;
  END LOOP;

  -- ── No route into the four (§53.4): a CUSTOM role holding any approver-only key loses it. DELTA-logged. ──
  DELETE FROM role_permissions rp
   USING roles r, permissions p
   WHERE rp.role_id = r.id AND rp.permission_id = p.id
     AND r.company_id IS NOT NULL AND p.key = ANY (approver_keys);
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '202610271001: removed % custom-role pair(s) on the five approver-only keys', n;

  -- A GLOBAL role other than owner and platform_admin still holding one would be a bundle this file did not expect: stop.
  SELECT count(*) INTO got
    FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
   WHERE p.key = ANY (approver_keys) AND NOT (r.company_id IS NULL AND r.name IN ('owner', 'platform_admin'));
  IF got <> 0 THEN
    RAISE EXCEPTION '202610271001: % role row(s) other than owner/platform_admin still hold an approver-only key', got;
  END IF;

  -- ── ui_grantable = false on the five approver-only keys (three were inserted false above; this flips the two report
  -- keys). The 6th false key of this file is portal.approve_spend (portal.* is always false). ──
  UPDATE permissions SET ui_grantable = false WHERE key = ANY (approver_keys) AND ui_grantable;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 2 THEN
    RAISE EXCEPTION '202610271001: expected to flip at most the 2 social.report keys to ui_grantable=false, flipped %', n;
  END IF;

  -- ══ Assert, don't assume ══════════════════════════════════════════════════════════════════════════════════════

  -- The eleven keys, with their kind, class, sensitive and ui_grantable flags.
  SELECT count(*) INTO got FROM permissions p
    JOIN (VALUES
      ('social.post.author', 'social_post', false, true), ('social.post.proofread', 'social_post', false, true),
      ('social.post.approve', 'social_post', true, false), ('social.post.design', 'social_post', false, true),
      ('social.post.schedule', 'social_post', false, true), ('social.post.manage', 'social_post', false, true),
      ('social.post.record_client', 'social_post', true, true), ('social.post.boost', 'social_post', true, true),
      ('social.engagement.plan', 'social_engagement', false, false),
      ('social.engagement.budget', 'social_engagement', true, false),
      ('portal.approve_spend', 'portal', true, false)
    ) AS x(key, kind, sensitive, ui) ON x.key = p.key
   WHERE p.cerbos_kind = x.kind AND p.class = 'grantable' AND p.sensitive = x.sensitive AND p.ui_grantable = x.ui;
  IF got <> 11 THEN
    RAISE EXCEPTION '202610271001: expected 11 pipeline keys with their exact kind/class/sensitive/ui_grantable, found %', got;
  END IF;
  SELECT count(*) INTO got FROM permissions WHERE key = ANY (approver_keys) AND NOT ui_grantable AND sensitive = (key <> 'social.engagement.plan');
  IF got <> 5 THEN
    RAISE EXCEPTION '202610271001: expected the five approver-only keys ui_grantable=false (all sensitive but plan), found %', got;
  END IF;

  -- The exact holders of each new key, in BOTH directions, over every role row (custom roles included).
  FOR k IN
    SELECT * FROM (VALUES
      ('social.post.author',        ARRAY['platform_admin', 'member']),
      ('social.post.proofread',     ARRAY['platform_admin', 'social_copywriter']),
      ('social.post.approve',       ARRAY['platform_admin', 'owner']),
      ('social.post.design',        ARRAY['platform_admin', 'member', 'social_designer']),
      ('social.post.schedule',      ARRAY['platform_admin', 'member']),
      ('social.post.manage',        ARRAY['platform_admin', 'member']),
      ('social.post.record_client', ARRAY['platform_admin', 'member']),
      ('social.post.boost',         ARRAY['platform_admin', 'member']),
      ('social.engagement.plan',    ARRAY['platform_admin', 'owner']),
      ('social.engagement.budget',  ARRAY['platform_admin', 'owner']),
      ('portal.approve_spend',      ARRAY['platform_admin', 'client']),
      ('social.report.approve',     ARRAY['platform_admin', 'owner']),
      ('social.report.deliver',     ARRAY['platform_admin', 'owner'])
    ) AS x(perm_key, role_names)
  LOOP
    SELECT count(*) INTO got
      FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND p.key = k.perm_key AND r.name = ANY (k.role_names);
    IF got <> array_length(k.role_names, 1) THEN
      RAISE EXCEPTION '202610271001: %: expected % named role(s) to hold it, found %', k.perm_key, array_length(k.role_names, 1), got;
    END IF;
    SELECT count(*) INTO got
      FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
     WHERE p.key = k.perm_key AND NOT (r.company_id IS NULL AND r.name = ANY (k.role_names));
    IF got <> 0 THEN
      RAISE EXCEPTION '202610271001: % leaked to % role row(s) outside %', k.perm_key, got, k.role_names;
    END IF;
  END LOOP;

  -- The six self-scoped member markers, and no other self_scoped row on a new key.
  SELECT count(*) INTO got
    FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND r.name = 'member' AND rp.self_scoped
     AND p.key IN ('social.post.author', 'social.post.design', 'social.post.schedule', 'social.post.manage',
                   'social.post.record_client', 'social.post.boost');
  IF got <> 6 THEN
    RAISE EXCEPTION '202610271001: expected the six self-scoped member markers, found %', got;
  END IF;
  SELECT count(*) INTO got
    FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
   WHERE p.key = ANY (new_keys) AND rp.self_scoped AND r.name <> 'member';
  IF got <> 0 THEN
    RAISE EXCEPTION '202610271001: % self_scoped row(s) on a new key outside member', got;
  END IF;

  -- The two new roles' EXACT bundles.
  FOR k IN
    SELECT * FROM (VALUES
      ('social_copywriter', ARRAY['social.engagement.read', 'social.post.proofread', 'social.post.read']),
      ('social_designer',   ARRAY['social.engagement.read', 'social.post.design', 'social.post.read'])
    ) AS x(role_name, keys)
  LOOP
    SELECT count(*) INTO got FROM (
      (SELECT p.key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
        WHERE r.company_id IS NULL AND r.name = k.role_name
       EXCEPT SELECT unnest(k.keys))
      UNION ALL
      (SELECT unnest(k.keys)
       EXCEPT SELECT p.key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
        WHERE r.company_id IS NULL AND r.name = k.role_name)
    ) diff;
    IF got <> 0 THEN
      RAISE EXCEPTION '202610271001: %''s bundle diverges from % by % key(s)', k.role_name, k.keys, got;
    END IF;
  END LOOP;

  -- client holds portal.approve_spend and nothing outside portal.* (it gained nothing else).
  SELECT count(*) INTO got
    FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND r.name = 'client' AND p.module_key <> 'portal';
  IF got <> 0 THEN
    RAISE EXCEPTION '202610271001: client holds % key(s) outside portal.*', got;
  END IF;

  -- owner == company_admin + the five approver-only keys, over EVERY social_* kind, in both directions
  -- (owner-role.db.test.ts pins the same over the whole bundle).
  SELECT count(*) INTO got FROM (
    (SELECT p.key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner' AND p.cerbos_kind LIKE 'social\_%'
     EXCEPT
     (SELECT p.key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
       WHERE r.company_id IS NULL AND r.name = 'company_admin' AND p.cerbos_kind LIKE 'social\_%'
      UNION SELECT unnest(approver_keys)))
    UNION ALL
    ((SELECT p.key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
       WHERE r.company_id IS NULL AND r.name = 'company_admin' AND p.cerbos_kind LIKE 'social\_%'
      UNION SELECT unnest(approver_keys))
     EXCEPT
     SELECT p.key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner' AND p.cerbos_kind LIKE 'social\_%')
  ) diff;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610271001: owner''s social bundle diverges from company_admin + the five approver keys by % key(s)', got;
  END IF;
  SELECT count(*) INTO got
    FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND r.name = 'company_admin' AND p.key = ANY (approver_keys);
  IF got <> 0 THEN
    RAISE EXCEPTION '202610271001: company_admin still holds % approver-only key(s)', got;
  END IF;

  RAISE NOTICE '202610271001: social pipeline IAM seeded (2 roles, 11 keys; report approve/deliver narrowed to owner + platform_admin)';
END $$;
