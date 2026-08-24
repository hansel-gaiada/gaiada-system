-- Finance F1-07 — the IAM half of the ledger core (2026-08-24).
--
-- DERIVED from src/rbac/permission-catalog.json and src/rbac/role-permission-bundles.json, like
-- 202608241014. Frozen once applied; a later catalog change is a NEW migration.
--
-- Lands 4 grantable permissions on ONE new Cerbos kind, `finance_ledger`, for the journal tables in
-- 202608241015. No new roles: `finance_staff` / `finance_manager` already exist from 202608241014.
--
-- ── FOUR ACTIONS, AND THE TWO THAT ARE DELIBERATELY MISSING ─────────────────────────────────────
--   read     see journals and lines
--   verify   run finance_verify_ledger_chain() — the integrity check
--   post     create a journal
--   reverse  correct one by posting its mirror
--
-- There is NO `update` and NO `delete`. Not an oversight: a posted journal cannot be edited or
-- removed — `FINANCE_LEDGER_IMMUTABLE` refuses both at the trigger, for every principal — so
-- cataloguing those actions would advertise an operation that can never succeed and would invite a
-- handler to attempt it. The absence is the statement.
--
-- ── WHY company_admin CAN READ AND VERIFY BUT NOT POST ──────────────────────────────────────────
-- Because `company_admin` is a platform-ADMINISTRATIVE role and creating entries in the book of
-- record is accounting work — the same ground on which it is excluded from `finance.period.reopen`
-- in 202608241014.
--
-- ⚠ This is NOT a segregation-of-duties argument, and the difference is worth stating because the
-- first draft of the policy header got it wrong. `finance_manager` holds BOTH `finance.ledger.post`
-- and `finance.period.close` — because closing the books IS the controller's job. Segregation of
-- duties binds per company, per PERSON, through `finance_duty_assignments` + `finance_sod_check()`,
-- never through role bundles. That is what allows a real conflict to be WAIVED deliberately, with a
-- named compensating control recorded against it, instead of being either impossible (so people
-- work around it) or invisible (so nobody knows it exists).
--
-- ── `verify` IS THE ONE FINANCE KEY THAT IS NOT SENSITIVE ───────────────────────────────────────
-- It returns problems, not figures, and its entire value is that anyone can run it. An integrity
-- check runnable only by the person who could have broken the chain is not an integrity check.
--
-- ROLE-ARM ONLY, no perm_* mirror — same posture as the other four finance kinds. F1 is schema plus
-- functions with no HTTP surface yet.
--
-- Additive. No existing row is updated or deleted.

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) The 4 grantable permissions.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
INSERT INTO permissions (id, key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description, v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('finance.ledger.read', 'finance', 'ledger', 'read',
   'Read journal entries and their lines.',
   'finance_ledger', 'read', 'grantable', true, true),
  ('finance.ledger.verify', 'finance', 'ledger', 'verify',
   'Run the ledger chain integrity check (hash links, sequence gaps, balance).',
   'finance_ledger', 'verify', 'grantable', false, true),
  ('finance.ledger.post', 'finance', 'ledger', 'post',
   'Post a journal entry to the ledger.',
   'finance_ledger', 'post', 'grantable', true, true),
  ('finance.ledger.reverse', 'finance', 'ledger', 'reverse',
   'Reverse a posted journal by posting its mirror. The only sanctioned correction.',
   'finance_ledger', 'reverse', 'grantable', true, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) The bundles — emitted from role-permission-bundles.json so the two cannot disagree.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('company_admin',    'finance.ledger.read'),
  ('company_admin',    'finance.ledger.verify'),

  ('finance_manager',  'finance.ledger.post'),
  ('finance_manager',  'finance.ledger.read'),
  ('finance_manager',  'finance.ledger.reverse'),
  ('finance_manager',  'finance.ledger.verify'),

  ('finance_staff',    'finance.ledger.read'),
  ('finance_staff',    'finance.ledger.verify'),

  ('owner',            'finance.ledger.read'),
  ('owner',            'finance.ledger.verify'),

  ('platform_admin',   'finance.ledger.post'),
  ('platform_admin',   'finance.ledger.read'),
  ('platform_admin',   'finance.ledger.reverse'),
  ('platform_admin',   'finance.ledger.verify')
) AS v(role_name, perm_key)
JOIN roles       r ON r.company_id IS NULL AND r.name = v.role_name
JOIN permissions p ON p.key = v.perm_key
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
);
