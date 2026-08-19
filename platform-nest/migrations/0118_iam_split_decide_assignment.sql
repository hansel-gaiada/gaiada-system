-- 0118_iam_split_decide_assignment.sql — split the placement decision out of `decide_override`.
--
-- Number reserved by creating the file before any DDL (migrations/README.md rule 5).
--
-- ── WHY ────────────────────────────────────────────────────────────────────────────────────────
-- `0115` shipped ONE action, `decide_override`, and `0117`'s dept-head flip made it decide two kinds
-- of IAM exception: a routed ROLE override, and a lead's PLACEMENT request. The owner instructed a
-- split (2026-08-19). Two reasons it is right:
--   * the catalog description said "grant a person authority beyond what their position confers",
--     which reads narrowly for a placement — a permission whose description is not what it does is a
--     permission nobody can audit;
--   * one action cannot be narrowed for one request kind without narrowing the other, so the split is
--     what makes "a senior lead may approve placements but never role grants" expressible later.
--
-- ── NO BEHAVIOUR CHANGE TODAY, STATED PLAINLY ──────────────────────────────────────────────────
-- The 4 holders below are IDENTICAL to `decide_override`'s, and the Cerbos tiers are identical too.
-- Nobody gains or loses the ability to decide anything by this migration. What changes is that the
-- decision is recorded against the right permission, and the two can diverge without a schema change.
--
-- Also corrects `core.role_grant.decide_override`'s own description, which now says role grants only
-- and points at this key for placements.

DO $$
DECLARE
  perm uuid;
  seeded integer;
  expected integer := 4;
BEGIN
  INSERT INTO permissions (id, key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
  VALUES (gen_random_uuid(), 'core.position.decide_assignment', 'core', 'position', 'decide_assignment',
          'Decide a department head''s request to place a person in a position.',
          'automation_approval', 'decide_assignment', 'grantable', true, true)
  ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description, sensitive = EXCLUDED.sensitive
  RETURNING id INTO perm;

  IF perm IS NULL THEN
    SELECT id INTO perm FROM permissions WHERE key = 'core.position.decide_assignment';
  END IF;
  IF perm IS NULL THEN
    RAISE EXCEPTION 'could not resolve core.position.decide_assignment after upsert';
  END IF;

  -- the override key stops claiming to cover placements
  UPDATE permissions
     SET description = 'Decide a routed request to grant a person a ROLE beyond what their position '
                       'confers (role grants only; placement requests are core.position.decide_assignment).'
   WHERE key = 'core.role_grant.decide_override';

  WITH holders(role_name) AS (VALUES
    ('company_admin'),
    ('group_executive'),
    ('hr_manager'),
    ('platform_admin')
  )
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, perm FROM holders h JOIN roles r ON r.name = h.role_name AND r.company_id IS NULL
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS seeded = ROW_COUNT;

  -- DELTA assertion (0093 lesson): 0 on a re-run is fine; a partial seed means a role named by
  -- resource_automation_approval.yaml has no global `roles` row — the silent-skip defect 0069/0091/0097
  -- each closed, and a Cerbos rule naming an unholdable role is worse than no rule.
  IF seeded <> 0 AND seeded <> expected THEN
    RAISE EXCEPTION
      'decide_assignment: expected % bundle rows (or 0 on a re-run), seeded % — regenerate bundles and '
      'check role-catalog-drift.db.test.ts before deploying.', expected, seeded;
  END IF;
END $$;
