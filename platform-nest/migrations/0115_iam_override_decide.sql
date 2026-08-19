-- 0115_iam_override_decide.sql — P2-08 part B: the ROUTED OVERRIDE decision right.
--
-- Number RESERVED by creating this file before any DDL was written (migrations/README.md rule 5),
-- because `ls | tail` lost that race twice in two days and produced the 0114 double-booking.
--
-- Design: docs/superpowers/plans/2026-08-13-iam-phase2-design.md §6.5. An override is a per-person
-- grant beyond what a POSITION confers: a dept head requests it, a ROUTED approver decides it, and an
-- approving decision executes the grant in-band with `expires_at` + `origin_approval_id`.
--
-- ── WHAT THIS SEEDS ────────────────────────────────────────────────────────────────────────────
-- One catalog permission — `core.role_grant.decide_override` -> (automation_approval, decide_override) —
-- and its bundle rows for the 4 roles whose Cerbos rules name it. Both are DERIVED, not chosen
-- here: the catalog entry mirrors `src/rbac/permission-catalog.json` and the holder list below is
-- generated from `role-permission-bundles.json`, which is itself generated from the policies. The
-- three-way parity suite fails if they disagree.
--
-- ── WHY A LITERAL ACTION RATHER THAN THE GENERIC `decide` ──────────────────────────────────────
-- The generic `decide` is held by `manager` and the module tiers for ordinary approvals. An override
-- hands out AUTHORITY, so its decider set must be narrower than "whoever can approve an expense".
-- Exactly the reasoning (and mechanism) IAM-GAP-01 used for `decide_leave`.
--
-- ── SENSITIVE, AND DELIBERATELY NOT SELF-SCOPED ────────────────────────────────────────────────
-- `sensitive = true`: deciding an override is authority over another person's access, which is the
-- clearest case the flag exists for (owner's 2026-08-19 review kept every non-read decision right
-- flagged). `self_scoped` stays FALSE — the 0114 marker means "acts on the holder's OWN rows", and
-- this acts on somebody else's, so the grant ceiling must keep demanding a grantor hold it.

-- ── WIDEN automation_approvals.origin TO ADMIT 'iam' ──────────────────────────────────────────
-- An override request is filed as an approval row with origin='iam'. The CHECK currently admits
-- ('automation','agent','hr') — 0016 created it, 0028 widened it once to add 'hr'. Postgres cannot
-- ALTER a CHECK in place, so the only way is drop-and-re-add, and this copies 0028's own DO block
-- verbatim: it looks the constraint up BY DEFINITION rather than by name, because 0016 created it
-- auto-named and a hardcoded name would break on any environment where that differs.
--
-- Purely additive: no existing row can violate a WIDER set, so this cannot fail on live data.
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
   WHERE conrelid = 'automation_approvals'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%origin%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE automation_approvals DROP CONSTRAINT %I', cname);
  END IF;
END $$;
ALTER TABLE automation_approvals
  ADD CONSTRAINT automation_approvals_origin_check CHECK (origin IN ('automation','agent','hr','iam'));

DO $$
DECLARE
  perm uuid;
  seeded integer;
  expected integer := 4;
BEGIN
  -- Column names read from 0093, not assumed: the catalog's "domain" is stored as `module_key`
  -- (0093's own comment says so), and `ui_grantable` is P2-03's required field.
  -- `permissions.id` carries NO default (0001/0093 supply it explicitly), so this does too.
  INSERT INTO permissions (id, key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
  VALUES (gen_random_uuid(), 'core.role_grant.decide_override', 'core', 'role_grant', 'decide_override',
          'Decide a routed request to grant a person authority beyond what their position confers.',
          'automation_approval', 'decide_override', 'grantable', true, true)
  ON CONFLICT (key) DO UPDATE SET sensitive = EXCLUDED.sensitive
  RETURNING id INTO perm;

  IF perm IS NULL THEN
    SELECT id INTO perm FROM permissions WHERE key = 'core.role_grant.decide_override';
  END IF;
  IF perm IS NULL THEN
    RAISE EXCEPTION 'could not resolve the core.role_grant.decide_override permission after upsert';
  END IF;

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

  -- DELTA assertion, not a total (the 0093 lesson). 0 is legitimate on a re-run; anything between 1
  -- and expected-1 means a role in the generated holder list has no `roles` row, which would leave a
  -- Cerbos rule naming a role nobody can hold — the silent-skip defect 0069/0091/0097 each closed.
  IF seeded <> 0 AND seeded <> expected THEN
    RAISE EXCEPTION
      'decide_override: expected to seed % bundle rows (or 0 on a re-run), seeded % — a role named by '
      'resource_automation_approval.yaml has no global roles row. Re-run `npm run gen:role-bundles` '
      'and check role-catalog-drift.db.test.ts before deploying.', expected, seeded;
  END IF;
END $$;
