-- IAM — GH-03: the `github_repo` permission family (docs/blueprints/github-integration-foundation.md
-- §4.2). Sorts after 202608310735_github_repos_registry.sql (GH-05, the table this policy governs).
--
-- A NEW Cerbos kind costs six coupled artifacts (the estate's own standing lesson, most recently paid
-- by WSK-19 for `webdev_contract_snapshot` and caught both times by IAM-07b's CI gate). In order:
--   1. `cerbos/policies/resource_github_repo.yaml`               — the policy (GH-03)
--   2. `src/rbac/permission-catalog.json`                        — the 9 keys + _meta.counts (GH-03)
--   3. `src/rbac/permission-groups.json`                         — the authoring layer + counts (GH-03)
--   4. this migration                                            — the same rows, in the database
--   5. `scripts/generate-role-bundles.mjs` +
--      `src/rbac/role-permission-parity.db.test.ts`              — BOTH resolvers taught `github_repo`
--                                                                   (they refuse to guess; an unknown
--                                                                   kind throws by design)
--   6. `src/rbac/role-permission-bundles.json`                   — regenerated via
--                                                                   `npm run gen:role-bundles`, from a
--                                                                   clean worktree (this checkout is
--                                                                   shared — platform-nest/CLAUDE.md's
--                                                                   own warning), never hand-edited
--
-- ── WHICH REACH IS SEEDED, AND WHY (mirrors resource_github_repo.yaml's own role tiers exactly) ────
-- The Cerbos policy's role-arm rules are the source of truth; this migration is a MECHANICAL
-- transcription of them into `role_permissions`, per 0094's bundling methodology — including the
-- FOUR D14-gated actions (deploy/secret_write/create_repo/delete_repo), which a role still "reaches"
-- for bundling purposes even though the Cerbos condition additionally requires a verified approvalId
-- (the exact same convention role_grant/position/hr_recruitment's attribute-gated rules already use —
-- see derived_roles.yaml's IAM-04a header and P2-02's own note in this table's sibling migrations).
--
--   platform_admin, company_admin, owner  — all 9 actions (owner MUST mirror company_admin exactly,
--                                            byte for byte — owner-role.db.test.ts's "DB bundle
--                                            matches company_admin EXACTLY" invariant; the estate's
--                                            own CLAUDE.md note: "a new company_admin key does NOT
--                                            propagate to owner").
--   manager                                — read, link, unlink, push, merge, deploy (6). Manager
--                                            never appears on secret_write/create_repo/delete_repo's
--                                            derivedRoles list, approved or not.
--   member                                 — read only (1).
--   webdev_staff                           — read, push, merge, deploy (4) — the module_staff tier's
--                                            reach on this kind (see resource_github_repo.yaml's
--                                            module-scoping note: no handler resolves `module` to
--                                            anything but "webdev" today).
--   webdev_manager                         — read, push, merge, deploy, secret_write (5) — the
--                                            module_manager tier additionally reaches secret_write,
--                                            matching a department admin managing their own service's
--                                            credentials.
--
-- link/unlink are NEVER granted to webdev_staff/webdev_manager: `github-repos.controller.ts` (GH-08)
-- authorizes them against company_admin/manager only (resource_github_repo.yaml's own header — no
-- module gate on the registry-bookkeeping actions), so a module-tier grant there would be dead code
-- no caller can reach, same reasoning the policy file itself already states.
--
-- `permissions.id` has no default (uuid PRIMARY KEY, no gen_random_uuid()), so it is supplied
-- explicitly, matching 202608271510's own pattern.
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('core.github_repo.read', 'core', 'github_repo', 'read',
   'View a repo''s registry row (list/detail) -- GitHub facts plus the ERP''s site/project link.',
   'github_repo', 'read', 'grantable', false, true),
  ('core.github_repo.link', 'core', 'github_repo', 'link',
   'Link a github_repo row to a webdev_site_id and/or project_id.',
   'github_repo', 'link', 'grantable', false, true),
  ('core.github_repo.unlink', 'core', 'github_repo', 'unlink',
   'Clear a github_repo row''s webdev_site_id/project_id link.',
   'github_repo', 'unlink', 'grantable', false, true),
  ('core.github_repo.push', 'core', 'github_repo', 'push',
   'Push a commit to a repo through the ERP''s single GitHub chokepoint.',
   'github_repo', 'push', 'grantable', false, true),
  ('core.github_repo.merge', 'core', 'github_repo', 'merge',
   'Merge a pull request through the ERP''s single GitHub chokepoint.',
   'github_repo', 'merge', 'grantable', false, true),
  ('core.github_repo.deploy', 'core', 'github_repo', 'deploy',
   'Dispatch a GitHub Actions deploy workflow_run. D14-gated (approvalId required).',
   'github_repo', 'deploy', 'grantable', true, true),
  ('core.github_repo.secret_write', 'core', 'github_repo', 'secret_write',
   'Write a repo''s Actions/environment secret. D14-gated (approvalId required).',
   'github_repo', 'secret_write', 'grantable', true, true),
  ('core.github_repo.create_repo', 'core', 'github_repo', 'create_repo',
   'Create a new repo in the org. D14-gated (approvalId required) -- GH blueprint section 0.2.',
   'github_repo', 'create_repo', 'grantable', true, true),
  ('core.github_repo.delete_repo', 'core', 'github_repo', 'delete_repo',
   'Delete a repo. D14-gated (approvalId required) -- irreversible, GH blueprint section 4.2.',
   'github_repo', 'delete_repo', 'grantable', true, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('platform_admin', 'core.github_repo.read'),
  ('platform_admin', 'core.github_repo.link'),
  ('platform_admin', 'core.github_repo.unlink'),
  ('platform_admin', 'core.github_repo.push'),
  ('platform_admin', 'core.github_repo.merge'),
  ('platform_admin', 'core.github_repo.deploy'),
  ('platform_admin', 'core.github_repo.secret_write'),
  ('platform_admin', 'core.github_repo.create_repo'),
  ('platform_admin', 'core.github_repo.delete_repo'),

  ('company_admin', 'core.github_repo.read'),
  ('company_admin', 'core.github_repo.link'),
  ('company_admin', 'core.github_repo.unlink'),
  ('company_admin', 'core.github_repo.push'),
  ('company_admin', 'core.github_repo.merge'),
  ('company_admin', 'core.github_repo.deploy'),
  ('company_admin', 'core.github_repo.secret_write'),
  ('company_admin', 'core.github_repo.create_repo'),
  ('company_admin', 'core.github_repo.delete_repo'),

  -- owner MUST mirror company_admin exactly — see this migration's own header.
  ('owner', 'core.github_repo.read'),
  ('owner', 'core.github_repo.link'),
  ('owner', 'core.github_repo.unlink'),
  ('owner', 'core.github_repo.push'),
  ('owner', 'core.github_repo.merge'),
  ('owner', 'core.github_repo.deploy'),
  ('owner', 'core.github_repo.secret_write'),
  ('owner', 'core.github_repo.create_repo'),
  ('owner', 'core.github_repo.delete_repo'),

  ('manager', 'core.github_repo.read'),
  ('manager', 'core.github_repo.link'),
  ('manager', 'core.github_repo.unlink'),
  ('manager', 'core.github_repo.push'),
  ('manager', 'core.github_repo.merge'),
  ('manager', 'core.github_repo.deploy'),

  ('member', 'core.github_repo.read'),

  ('webdev_staff', 'core.github_repo.read'),
  ('webdev_staff', 'core.github_repo.push'),
  ('webdev_staff', 'core.github_repo.merge'),
  ('webdev_staff', 'core.github_repo.deploy'),

  ('webdev_manager', 'core.github_repo.read'),
  ('webdev_manager', 'core.github_repo.push'),
  ('webdev_manager', 'core.github_repo.merge'),
  ('webdev_manager', 'core.github_repo.deploy'),
  ('webdev_manager', 'core.github_repo.secret_write')
) AS v(role_name, perm_key)
JOIN roles r ON r.company_id IS NULL AND r.name = v.role_name
JOIN permissions p ON p.key = v.perm_key
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
);

-- ── Assert, don't assume — same discipline 202608271510's own closing block applies ─────────────
DO $$
DECLARE
  expected record;
  got integer;
  total_got integer;
BEGIN
  FOR expected IN
    SELECT * FROM (VALUES
      ('platform_admin', 9), ('company_admin', 9), ('owner', 9),
      ('manager', 6), ('member', 1),
      ('webdev_staff', 4), ('webdev_manager', 5)
    ) AS x(role_name, expected_count)
  LOOP
    SELECT count(*) INTO got
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND r.name = expected.role_name
       AND p.cerbos_kind = 'github_repo';
    IF got <> expected.expected_count THEN
      RAISE EXCEPTION '202608310900: role "%": expected % bundled github_repo permission(s), found % (missing/typo''d role name or permission key in the JOIN, or a prior partial application)',
        expected.role_name, expected.expected_count, got;
    END IF;
  END LOOP;

  -- owner must match company_admin EXACTLY (owner-role.db.test.ts's own invariant) — assert it here
  -- too, not just via the equal counts above (equal counts alone would not catch owner holding the
  -- WRONG 9 keys).
  SELECT count(*) INTO got
    FROM (
      SELECT p.key FROM role_permissions rp
        JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
       WHERE r.company_id IS NULL AND r.name = 'owner' AND p.cerbos_kind = 'github_repo'
      EXCEPT
      SELECT p.key FROM role_permissions rp
        JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
       WHERE r.company_id IS NULL AND r.name = 'company_admin' AND p.cerbos_kind = 'github_repo'
    ) diff;
  IF got <> 0 THEN
    RAISE EXCEPTION '202608310900: owner''s github_repo bundle diverges from company_admin''s by % key(s) — owner-role.db.test.ts will fail', got;
  END IF;

  SELECT count(*) INTO total_got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.cerbos_kind = 'github_repo';
  IF total_got <> 43 THEN
    RAISE EXCEPTION '202608310900: total bundled github_repo permissions: expected 43, found %', total_got;
  END IF;

  RAISE NOTICE '202608310900: role_permissions seeded — % rows across 7 roles for core.github_repo.*', total_got;
END $$;
