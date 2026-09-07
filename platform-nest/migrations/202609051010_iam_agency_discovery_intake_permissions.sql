-- IAM — AD-7b: the `agency_lead` + `agency_discovery_submission` permission families.
-- Design: docs/superpowers/plans/2026-09-05-agency-discovery-intake-design.md §5.2
-- Sorts after 202609050857_agency_discovery_intake.sql (AD-1, the tables these policies govern).
--
-- ── WHY THIS MIGRATION EXISTS: A REGRESSION CAUGHT BY QA, NOT BY DESIGN ──────────────────────────
-- AD-7 landed `resource_agency_lead.yaml` / `resource_agency_discovery_submission.yaml` plus the
-- catalog and groups JSON, but NOT the database half. `role-permission-parity.db.test.ts` then
-- failed for five roles with its own intended message:
--
--   role "company_admin": Cerbos policy currently grants 8 permission(s) the seeded bundle is
--   MISSING [agency.discovery_submission.delete, agency.discovery_submission.read,
--   agency.lead.convert, agency.lead.create, agency.lead.delete, agency.lead.read,
--   agency.lead.triage, agency.lead.update]
--
-- That test exists precisely to catch "a Cerbos policy changed an authorization decision without an
-- accompanying bundle migration". The practical cost of leaving it: `role_permissions` is what a UI
-- or automation surface reads to decide what to OFFER, so a company_admin's bundle was missing 8
-- real grants — every discovery-intake control would have been hidden from the people who can
-- actually use it, while Cerbos happily allowed the call.
--
-- A NEW Cerbos kind costs six coupled artifacts (the estate's standing lesson, per GH-03's header):
--   1. the policy files                      — AD-7 ✓
--   2. src/rbac/permission-catalog.json      — AD-7 ✓ (8 keys)
--   3. src/rbac/permission-groups.json       — AD-7 ✓ (4 groups)
--   4. THIS migration                        — the same rows, in the database
--   5. generate-role-bundles.mjs + role-permission-parity.db.test.ts taught the two new kinds
--   6. src/rbac/role-permission-bundles.json regenerated via `npm run gen:role-bundles`, from a
--      CLEAN worktree (this checkout is shared), never hand-edited
--
-- ── WHICH REACH IS SEEDED (a mechanical transcription of the two policies' ROLE arms) ────────────
-- Read straight out of the YAML, not from a summary of it:
--   platform_admin  — actions:["*"]                                  -> all 8
--   company_admin   — read, create, update, delete, triage, convert, -> all 8
--                     submission read + delete
--   owner           — MUST mirror company_admin EXACTLY, byte for byte (owner-role.db.test.ts's
--                     invariant; the estate's own note: "a new company_admin key does NOT propagate
--                     to owner"). QA's report did not list owner — it is included here because the
--                     invariant, not the report, is authoritative.       -> all 8
--   manager         — read, create, update, delete, triage, sub.read, sub.delete   -> 7 (NO convert)
--   member          — read, create, update, delete, sub.read                       -> 5
--   viewer          — read, sub.read                                               -> 2
--
-- `convert` is company_admin-only because it MINTS A CLIENT, A PROJECT AND A DELIVERY RUN — design
-- §5.2 requires it strictly narrower than `triage`. Flagged for the owner as a business call: if
-- account managers close their own deals, `manager` is the right tier and this migration plus the
-- policy's role arm must move together.
--
-- The permission-arm derived roles (`perm_agency_lead_*`) are deliberately NOT seeded here: per the
-- Permission Contract §7, role names decide every live authorization today, and the permission arm
-- stays unreached until role-bundle regeneration. Same posture HR-FULL and FINANCE-F0 shipped with.
--
-- `permissions.id` has no default (uuid PRIMARY KEY, no gen_random_uuid()), so it is supplied
-- explicitly — matching 202608310900's own pattern.

INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('agency.lead.read', 'agency', 'lead', 'read',
   'View the discovery-intake lead queue and a lead''s detail.',
   'agency_lead', 'read', 'grantable', false, true),
  ('agency.lead.create', 'agency', 'lead', 'create',
   'Create a lead by hand (a prospect who came in by phone rather than through an invite link).',
   'agency_lead', 'create', 'grantable', false, true),
  ('agency.lead.update', 'agency', 'lead', 'update',
   'Edit a lead, and mint or revoke its discovery invite link.',
   'agency_lead', 'update', 'grantable', false, true),
  ('agency.lead.triage', 'agency', 'lead', 'triage',
   'Dispose of a submitted lead: open for review, decline with a reason, or move to nurturing.',
   'agency_lead', 'triage', 'grantable', false, true),
  ('agency.lead.convert', 'agency', 'lead', 'convert',
   'Convert a lead into a real client: mints the client, the project, the delivery run seeded from the prospect''s own answers, and the delegation tasks.',
   'agency_lead', 'convert', 'grantable', true, true),
  ('agency.lead.delete', 'agency', 'lead', 'delete',
   'Soft-delete a lead.',
   'agency_lead', 'delete', 'grantable', false, true),
  ('agency.discovery_submission.read', 'agency', 'discovery_submission', 'read',
   'Read a prospect''s submitted discovery answers, including the full submission history.',
   'agency_discovery_submission', 'read', 'grantable', false, true),
  ('agency.discovery_submission.delete', 'agency', 'discovery_submission', 'delete',
   'Delete a discovery submission. Destroys an evidentiary record of what the client stated -- the basis of scope.',
   'agency_discovery_submission', 'delete', 'grantable', true, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('platform_admin', 'agency.lead.read'),
  ('platform_admin', 'agency.lead.create'),
  ('platform_admin', 'agency.lead.update'),
  ('platform_admin', 'agency.lead.triage'),
  ('platform_admin', 'agency.lead.convert'),
  ('platform_admin', 'agency.lead.delete'),
  ('platform_admin', 'agency.discovery_submission.read'),
  ('platform_admin', 'agency.discovery_submission.delete'),

  ('company_admin', 'agency.lead.read'),
  ('company_admin', 'agency.lead.create'),
  ('company_admin', 'agency.lead.update'),
  ('company_admin', 'agency.lead.triage'),
  ('company_admin', 'agency.lead.convert'),
  ('company_admin', 'agency.lead.delete'),
  ('company_admin', 'agency.discovery_submission.read'),
  ('company_admin', 'agency.discovery_submission.delete'),

  -- owner MUST mirror company_admin exactly — see this migration's own header.
  ('owner', 'agency.lead.read'),
  ('owner', 'agency.lead.create'),
  ('owner', 'agency.lead.update'),
  ('owner', 'agency.lead.triage'),
  ('owner', 'agency.lead.convert'),
  ('owner', 'agency.lead.delete'),
  ('owner', 'agency.discovery_submission.read'),
  ('owner', 'agency.discovery_submission.delete'),

  -- manager reaches everything EXCEPT convert (design §5.2: convert is strictly narrower).
  ('manager', 'agency.lead.read'),
  ('manager', 'agency.lead.create'),
  ('manager', 'agency.lead.update'),
  ('manager', 'agency.lead.triage'),
  ('manager', 'agency.lead.delete'),
  ('manager', 'agency.discovery_submission.read'),
  ('manager', 'agency.discovery_submission.delete'),

  -- member may keep leads up to date but disposes of nothing, and cannot destroy a submission.
  ('member', 'agency.lead.read'),
  ('member', 'agency.lead.create'),
  ('member', 'agency.lead.update'),
  ('member', 'agency.lead.delete'),
  ('member', 'agency.discovery_submission.read'),

  ('viewer', 'agency.lead.read'),
  ('viewer', 'agency.discovery_submission.read')
) AS v(role_name, perm_key)
JOIN roles r ON r.company_id IS NULL AND r.name = v.role_name
JOIN permissions p ON p.key = v.perm_key
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
);

-- ── Assert, don't assume — the discipline 202608310900's closing block establishes ───────────────
DO $$
DECLARE
  expected record;
  got integer;
  total_got integer;
BEGIN
  FOR expected IN
    SELECT * FROM (VALUES
      ('platform_admin', 8), ('company_admin', 8), ('owner', 8),
      ('manager', 7), ('member', 5), ('viewer', 2)
    ) AS x(role_name, expected_count)
  LOOP
    SELECT count(*) INTO got
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND r.name = expected.role_name
       AND p.cerbos_kind IN ('agency_lead', 'agency_discovery_submission');
    IF got <> expected.expected_count THEN
      RAISE EXCEPTION '202609051010: role "%": expected % bundled agency-intake permission(s), found % (missing/typo''d role name or permission key in the JOIN, or a prior partial application)',
        expected.role_name, expected.expected_count, got;
    END IF;
  END LOOP;

  -- owner must match company_admin EXACTLY (owner-role.db.test.ts's invariant). Equal counts alone
  -- would not catch owner holding the WRONG 8 keys.
  SELECT count(*) INTO got
    FROM (
      SELECT p.key FROM role_permissions rp
        JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
       WHERE r.company_id IS NULL AND r.name = 'owner'
         AND p.cerbos_kind IN ('agency_lead', 'agency_discovery_submission')
      EXCEPT
      SELECT p.key FROM role_permissions rp
        JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
       WHERE r.company_id IS NULL AND r.name = 'company_admin'
         AND p.cerbos_kind IN ('agency_lead', 'agency_discovery_submission')
    ) diff;
  IF got <> 0 THEN
    RAISE EXCEPTION '202609051010: owner''s agency-intake bundle diverges from company_admin''s by % key(s) — owner-role.db.test.ts will fail', got;
  END IF;

  -- convert must be company_admin-tier ONLY (design §5.2's "strictly narrower than triage" ruling,
  -- made assertable). If a future ticket widens it to manager, this line is where that decision is
  -- forced to be deliberate rather than incidental.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.key = 'agency.lead.convert'
     AND r.name NOT IN ('platform_admin', 'company_admin', 'owner');
  IF got <> 0 THEN
    RAISE EXCEPTION '202609051010: agency.lead.convert is bundled to % role(s) outside the company_admin tier — design §5.2 requires it strictly narrower than triage', got;
  END IF;

  SELECT count(*) INTO total_got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.cerbos_kind IN ('agency_lead', 'agency_discovery_submission');
  IF total_got <> 38 THEN
    RAISE EXCEPTION '202609051010: total bundled agency-intake permissions: expected 38, found %', total_got;
  END IF;

  RAISE NOTICE '202609051010: role_permissions seeded — % rows across 6 roles for agency.lead.* + agency.discovery_submission.*', total_got;
END $$;
