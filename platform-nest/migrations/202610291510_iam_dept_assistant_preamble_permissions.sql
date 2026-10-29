-- IAM — AIP-13b: the `dept_assistant_preamble` permission family (docs/PERMISSION-CONTRACT.md §56, docs/FRONTEND-BFF-CONTRACT.md §65), a NEW
-- core Cerbos kind (no module): a department's own assistant preamble, edited by the department head (owner ruling AIP-D10). Pure IAM
-- seed: no DDL (202610291500 owns the table).
--
-- A new Cerbos kind costs six coupled artifacts; this is #5 (copied from 202610160110_iam_dept_notice_permissions.sql). The others, all in
-- the same change:
--   1. cerbos/policies/resource_dept_assistant_preamble.yaml (+ 1 perm_dept_assistant_preamble_manage derived role in derived_roles.yaml:
--      `manage` ONLY, see the policy header)
--   2. src/rbac/cerbos.ts            — a comment only: `unitAncestors` is already in Resource and in the resourcePayload() allow-list
--   3. src/rbac/permission-catalog.json  — the 3 keys + _meta counts (114 kinds / 502 pairs / 487 grantable)
--   4. src/rbac/permission-groups.json   — 1 group (`assistant_dept_preamble`) + _meta counts
--   6. scripts/generate-role-bundles.mjs (NO resolver change: the kind names only direct roles, which DIRECT already maps) and
--      src/rbac/role-permission-bundles.json regenerated.
--
-- ── THE KEYS (dept_notice's pattern: `core.<kind>.<action>`) ──────────────────────────────────────
--   core.dept_assistant_preamble.read    — see a unit's preamble                         (company_admin; org_unit_lead on its own rule)
--   core.dept_assistant_preamble.edit    — write or reset a unit's preamble              (company_admin; org_unit_lead on its own rule)
--   core.dept_assistant_preamble.manage  — the COMPANY TIER: read and edit ANY unit's    (company_admin; owner through the permission arm)
--
-- ── WHY THERE IS A THIRD KEY: THE OWNER ──────────────────────────────────────────────────────────
-- The owner ruling is that the company admin and the OWNER edit every unit's preamble, a head edits their own unit's. `owner` is
-- permission-native (IAM-04c §3: zero policy rules), so it reaches a kind only through a `perm_*` mirror, and a mirror on `read` or `edit`
-- would let a department head (who holds both keys through the lead rules, over ONE unit) reach EVERY unit
-- (iam-04-reg1-mirror-reach-invariant). dept_notice's answer was "a permission-native owner posts only if it also holds company_admin or
-- leads the unit". The estate's other answer, and the one used here, is IAM-14c's key split: a distinct action for the company tier that
-- only company_admin, owner and platform_admin hold, so its mirror grants exactly the role arm's reach. Nothing new in the pattern.
--
-- ── WHICH REACH IS SEEDED (a mechanical transcription of the policy's role-arm ALLOW rules) ──────
--   platform_admin   — all 3 keys (its Cerbos wildcard; 0094's methodology materialises an explicit row per grantable key anyway, see
--                      202609281704)
--   company_admin, owner — read, edit, manage
--                      (owner MUST mirror company_admin exactly: owner-role.db.test.ts; a new company_admin key does NOT propagate to
--                      owner on its own)
--   org_unit_lead    — read, edit (its own rule per action, over the unit's subtree)
--   everything else (manager, member, viewer, hr_*, client, module tiers, ...) — NOTHING: members do not need the screen, the assistant
--                      applies the text on the server
--
-- ── SELF-SCOPED MARKER ──────────────────────────────────────────────────────────────────────────
-- None. No rule on this kind compares a resource attribute to the caller's id: the head's rules are containment in the unit's ancestry.
--
-- ── SENSITIVE ─────────────────────────────────────────────────────────────────────────────────
-- None of the three is flagged. A preamble is the department's own description of its work and words (plan §3.3: a label that narrows,
-- never an authority that widens); it moves no money and exposes no client, HR or finance data. Flagging `edit` would route every
-- department-head grant of org_unit_lead through the sensitive-grant override path (PERMISSION-CONTRACT §12.2). Owner/architect may tighten
-- this additively.
--
-- `permissions.id` has no default, so it is supplied explicitly. `ui_grantable` is EXPLICIT (0110's default).
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('core.dept_assistant_preamble.read', 'core', 'dept_assistant_preamble', 'read',
   'See a department''s assistant preamble: the text the assistant adds to a turn sent from that department (its own text or the default) and how it reads in the prompt. Reached, by Cerbos rule, by a department head over their own unit''s subtree. Members do not need it: the assistant applies the text on the server. Never needed by agents.',
   'dept_assistant_preamble', 'read', 'grantable', false, true),
  ('core.dept_assistant_preamble.edit', 'core', 'dept_assistant_preamble', 'edit',
   'Write or reset a department''s assistant preamble (1 to 1,000 characters; an empty text goes back to the default). Reached, by Cerbos rule, by a department head over their own unit''s subtree. Never granted to agents or automation.',
   'dept_assistant_preamble', 'edit', 'grantable', false, true),
  ('core.dept_assistant_preamble.manage', 'core', 'dept_assistant_preamble', 'manage',
   'Read and edit ANY department''s assistant preamble in the company: the company tier of this kind (a company admin, and the owner through the permission arm). A department head does not need it: a head reaches their own unit through the read and edit rules. Never granted to agents or automation.',
   'dept_assistant_preamble', 'manage', 'grantable', false, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

INSERT INTO role_permissions (role_id, permission_id, self_scoped)
SELECT r.id, p.id, bundle.self_scoped
FROM (
  -- the full-reach tier: every key (company_admin's reach, mirrored exactly by owner)
  SELECT f.role_name, k.perm_key, false AS self_scoped
    FROM (VALUES ('platform_admin'), ('company_admin'), ('owner')) AS f(role_name)
   CROSS JOIN (VALUES
     ('core.dept_assistant_preamble.read'), ('core.dept_assistant_preamble.edit'), ('core.dept_assistant_preamble.manage')
   ) AS k(perm_key)
  UNION ALL
  -- a department head reads and edits their own unit's preamble (not `manage`: that is the company tier)
  SELECT 'org_unit_lead', k.perm_key, false
    FROM (VALUES ('core.dept_assistant_preamble.read'), ('core.dept_assistant_preamble.edit')) AS k(perm_key)
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
   WHERE cerbos_kind = 'dept_assistant_preamble' AND class = 'grantable' AND module_key = 'core'
     AND sensitive = false AND ui_grantable = true;
  IF got <> 3 THEN
    RAISE EXCEPTION '202610291510: expected 3 grantable, non-sensitive, ui_grantable dept_assistant_preamble permissions, found %', got;
  END IF;

  FOR expected IN
    SELECT * FROM (VALUES
      ('platform_admin', 3), ('company_admin', 3), ('owner', 3), ('org_unit_lead', 2),
      ('manager', 0), ('member', 0), ('viewer', 0), ('hr_staff', 0), ('hr_manager', 0),
      ('client', 0), ('group_executive', 0), ('reports_staff', 0), ('reports_manager', 0), ('webdev_staff', 0), ('webdev_manager', 0)
    ) AS x(role_name, expected_count)
  LOOP
    SELECT count(*) INTO got
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND r.name = expected.role_name
       AND p.cerbos_kind = 'dept_assistant_preamble';
    IF got <> expected.expected_count THEN
      RAISE EXCEPTION '202610291510: role "%": expected % bundled dept_assistant_preamble permission(s), found % (missing/typo''d role name or key, or a prior partial application)',
        expected.role_name, expected.expected_count, got;
    END IF;
  END LOOP;

  -- Nobody outside platform_admin / company_admin / owner / org_unit_lead holds any of the three: `manager` is every head's company-wide
  -- role, so it must never edit a department's preamble.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL
     AND p.cerbos_kind = 'dept_assistant_preamble'
     AND r.name NOT IN ('platform_admin', 'company_admin', 'owner', 'org_unit_lead');
  IF got <> 0 THEN
    RAISE EXCEPTION '202610291510: dept_assistant_preamble leaked to % row(s) outside platform_admin/company_admin/owner/org_unit_lead', got;
  END IF;

  -- `manage` is the company tier ONLY: a department head must not hold it (its permission arm is a flat mirror, and it would reach every
  -- unit). Held by exactly platform_admin, company_admin and owner.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.key = 'core.dept_assistant_preamble.manage'
     AND r.name NOT IN ('platform_admin', 'company_admin', 'owner');
  IF got <> 0 THEN
    RAISE EXCEPTION '202610291510: core.dept_assistant_preamble.manage leaked to % row(s) outside platform_admin/company_admin/owner (org_unit_lead must not hold it)', got;
  END IF;

  -- No self-scoped marker on this kind.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
   WHERE p.cerbos_kind = 'dept_assistant_preamble' AND rp.self_scoped;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610291510: % unexpected self_scoped dept_assistant_preamble row(s)', got;
  END IF;

  -- owner ≡ company_admin, in BOTH directions (equal counts alone would not catch the wrong keys).
  SELECT count(*) INTO got FROM (
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
        AND p.cerbos_kind = 'dept_assistant_preamble'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin'
        AND p.cerbos_kind = 'dept_assistant_preamble')
    UNION ALL
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin'
        AND p.cerbos_kind = 'dept_assistant_preamble'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
        AND p.cerbos_kind = 'dept_assistant_preamble')
  ) diff;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610291510: owner''s dept_assistant_preamble bundle diverges from company_admin''s by % key(s) — owner-role.db.test.ts will fail', got;
  END IF;

  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.cerbos_kind = 'dept_assistant_preamble';
  IF got <> 11 THEN
    RAISE EXCEPTION '202610291510: total bundled dept_assistant_preamble permissions on global roles: expected 11 (3x3 + 2), found %', got;
  END IF;

  RAISE NOTICE '202610291510: role_permissions seeded — % dept_assistant_preamble rows across 4 global roles', got;
END $$;
