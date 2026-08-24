-- Finance F0-07 — the IAM half of the finance foundation (F0 wave, 2026-08-24).
--
-- DERIVED from src/rbac/permission-catalog.json and src/rbac/role-permission-bundles.json rather
-- than hand-typed: the 48 (role, permission) rows below were emitted from the generated bundle
-- artifact, so the migration and the artifact cannot disagree. Frozen once applied; a later catalog
-- change is a NEW migration, never a re-run of this file.
--
-- Lands 13 grantable permissions across the THREE new Cerbos kinds this change introduces
-- (`finance_config`, `finance_period`, `finance_control`), plus the two module-tier ROLES the
-- generic `module_staff`/`module_manager` derived roles string-compose against. No schema here; the
-- finance tables live in 202608241010–1013.
--
-- ── THE THREE KINDS, AND WHY THEY ARE THREE ─────────────────────────────────────────────────────
-- The split follows SEGREGATION-OF-DUTIES lines, not code layout
-- (docs/blueprints/finance-accounting-foundation.md §2.2):
--
--   finance_config   the accounting VOCABULARY — chart of accounts, dimensions, fiscal calendar
--                    structure, currencies, exchange rates, company accounting settings. Read is
--                    DELIBERATELY WIDE: an account code and name carry no money, and hiding the
--                    cost-centre list from the people who code expenses to it is a support ticket,
--                    not a posture. Same reasoning resource_hr_policy.yaml applies to a holiday
--                    calendar.
--   finance_period   the CLOSE LIFECYCLE — lock / reopen / close. Its own kind because closing a
--                    period is the `period_close` duty (control function AUTHORISE) and the
--                    blueprint's matrix forbids one person holding `journal_post` + `period_close`.
--                    That separation is only expressible if closing is separately grantable. Folded
--                    into finance_config, every accountant who can add an account could also
--                    declare the year final.
--   finance_control  the GOVERNANCE tier — the SoD duty matrix, elevation grants, the access log.
--                    The narrowest kind, because it governs the other two: whoever can assign
--                    duties can assign themselves any duty, and whoever can grant access can grant
--                    themselves access. Held ABOVE the accounting tiers, never alongside them.
--
-- ── ROLE-ARM ONLY. No perm_* mirror, for any of the three. ──────────────────────────────────────
-- Same posture resource_employee.yaml took under P2-02 and resource_hr_payroll.yaml under HR-FULL
-- ("new kinds get an arm only after their handlers exist and their holders are audited"), and here
-- there are two independent reasons:
--
--   1. F0 IS SCHEMA ONLY. No finance controller, endpoint or UI exists yet — the handlers land in
--      F1+. A permission-arm mirror now would grant reach to a surface nobody can serve, and would
--      have to be audited against holders that do not exist.
--   2. finance_control CANNOT BE MIRRORED SAFELY EVEN LATER. `attr.perms` carries no record of
--      WHICH rule a key came through, so a permission-arm rule testing "does perms contain
--      finance.control.assign_duty" could not tell "in a company you are staffed to" from "in any
--      company in the estate". That is the same granularity gap resource_hr_case.yaml documents for
--      hr.case.read, and a mirrored assign_duty would collapse into an unconditional cross-company
--      grant over the duty matrix itself.
--
-- If anyone later adds a mirror, THIS is the block to re-read: the fix is a scoped mirror carrying
-- the same condition (resource_hr_case.yaml's perm_hr_case_read_self is the worked shape), never an
-- unconditional one — and finance_control should stay unmirrored regardless.
--
-- ── WHY `owner` APPEARS IN THE BUNDLE ───────────────────────────────────────────────────────────
-- `owner` is a permission-native role (IAM-04c §3) with no Cerbos rules anywhere; its reach IS its
-- bundle. It therefore carries all 13 keys here. Note what that does NOT do: it does not decide
-- WHICH COMPANIES the owner may see. Under ruling D-F8 that comes from the ownership graph resolved
-- in 202608241010, so a holding owner reaches subsidiaries because they own them, not because of a
-- row below. The two mechanisms answer different questions and both must pass.
--
-- ── WHAT IS DELIBERATELY NOT GRANTED ────────────────────────────────────────────────────────────
--   * finance_staff holds ONLY the two read keys. A finance assistant reads the vocabulary and the
--     period calendar; they do not close periods, and they cannot see the duty matrix at all.
--   * finance_manager (the controller) holds finance.control.READ but none of its writes. The
--     controller runs the books; they do not decide who else may reach them. Read is granted so
--     they can see the matrix binding their own team — a controller who cannot see their own
--     department's duties cannot plan a close.
--   * company_admin holds finance.period.lock but NOT finance.period.reopen. Soft-locking is
--     administratively reasonable (it stops posting; it destroys nothing). Reversing the
--     accountant's soft lock is an accounting judgement, not an administrative one.
--   * NOTHING is granted to `member`, `viewer`, `manager`, `org_unit_lead` or `client`. Unlike the
--     HR kinds — where `member` legitimately holds keys through self-scoped rules (your own
--     payslip) — finance has no self-service surface: there is no "your own" general ledger.
--
-- Additive. No existing row is updated or deleted.

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) The 13 grantable permissions.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
INSERT INTO permissions (id, key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description, v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('finance.config.read', 'finance', 'config', 'read',
   'Read the chart of accounts, dimensions, fiscal calendar, currencies and accounting settings.',
   'finance_config', 'read', 'grantable', false, true),
  ('finance.config.create', 'finance', 'config', 'create',
   'Create an account, dimension, dimension value, fiscal year/period or exchange rate.',
   'finance_config', 'create', 'grantable', true, true),
  ('finance.config.update', 'finance', 'config', 'update',
   'Edit accounting vocabulary. An account with postings is additionally frozen by trigger.',
   'finance_config', 'update', 'grantable', true, true),
  ('finance.config.delete', 'finance', 'config', 'delete',
   'Delete an unposted account, dimension or calendar row.',
   'finance_config', 'delete', 'grantable', true, true),
  ('finance.period.read', 'finance', 'period', 'read',
   'Read fiscal period state and the close checklist.',
   'finance_period', 'read', 'grantable', false, true),
  ('finance.period.lock', 'finance', 'period', 'lock',
   'Soft-lock a fiscal period: close it to ordinary posting during the close.',
   'finance_period', 'lock', 'grantable', true, true),
  ('finance.period.reopen', 'finance', 'period', 'reopen',
   'Reopen a soft-locked period. Never available for a hard-locked one.',
   'finance_period', 'reopen', 'grantable', true, true),
  ('finance.period.close', 'finance', 'period', 'close',
   'HARD-lock a period: assert the figures are final. Terminal and irreversible.',
   'finance_period', 'close', 'grantable', true, true),
  ('finance.control.read', 'finance', 'control', 'read',
   'Read the segregation-of-duties matrix, live elevation grants and the finance access log.',
   'finance_control', 'read', 'grantable', true, true),
  ('finance.control.assign_duty', 'finance', 'control', 'assign_duty',
   'Grant or revoke one of the finance duties for a person in a company.',
   'finance_control', 'assign_duty', 'grantable', true, true),
  ('finance.control.waive_conflict', 'finance', 'control', 'waive_conflict',
   'Accept a BLOCKING segregation-of-duties conflict under a compensating control.',
   'finance_control', 'waive_conflict', 'grantable', true, true),
  ('finance.control.grant_access', 'finance', 'control', 'grant_access',
   'Approve a cross-company finance elevation. Approving EXECUTES (D14).',
   'finance_control', 'grant_access', 'grantable', true, true),
  ('finance.control.revoke_access', 'finance', 'control', 'revoke_access',
   'Cut a live finance elevation grant short before it lapses.',
   'finance_control', 'revoke_access', 'grantable', true, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) The two module-tier roles.
--
-- The names are NOT free-form. `module_staff`/`module_manager` in derived_roles.yaml string-compose
-- `resource.attr.module + "_staff"|"_manager"` at request time, and the module key is `finance`, so
-- `finance_staff` and `finance_manager` are the only names Cerbos will ever look for.
--
-- Global roles (company_id IS NULL) cannot be de-duplicated with ON CONFLICT, because the unique
-- constraint is on (company_id, name) and SQL NULLs are distinct — the WHERE NOT EXISTS guard
-- scoped explicitly to `company_id IS NULL` is what makes this idempotent. 0073's partial unique
-- index backstops it at the constraint level. Same shape as 0106 and 0117.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
INSERT INTO roles (id, company_id, name, description)
SELECT gen_random_uuid(), NULL, r.name, r.description
FROM (VALUES
  ('finance_staff',
   'Finance module_staff (WSD-2/ORG-6) — served-company grant: reads the accounting vocabulary (chart of accounts, dimensions, cost centres, currencies) and the fiscal period calendar, so expenses and documents can be coded correctly. Deliberately narrow: cannot create or edit an account, cannot enter an exchange rate, cannot lock or close a period, and cannot see the segregation-of-duties matrix or any elevation grant at all — a finance assistant holding the whole duty matrix is a reconnaissance surface with no upside.'),
  ('finance_manager',
   'Finance module_manager (WSD-2/ORG-6) — the CONTROLLER tier, served-company grant: owns the accounting vocabulary (create/edit/delete accounts, dimensions, fiscal calendars, exchange rates, company accounting settings) and runs the close (soft-lock, reopen, and hard-close a period — the last at high assurance only, because it is irreversible and asserts the figures are final). Reads the duty matrix binding their own team but holds NONE of its writes: the controller runs the books, they do not decide who else may reach them.')
) AS r(name, description)
WHERE NOT EXISTS (
  SELECT 1 FROM roles WHERE company_id IS NULL AND roles.name = r.name
);

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- (3) The bundles — 48 (role, permission) pairs, emitted from role-permission-bundles.json.
--
-- `role-permission-parity.db.test.ts` compares this table against what Cerbos ACTUALLY grants, so a
-- row here that the policy does not grant — or a grant the table omits — is a real disagreement and
-- the test is right to fail on it. That is why these rows are generated rather than curated.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('company_admin',    'finance.config.create'),
  ('company_admin',    'finance.config.delete'),
  ('company_admin',    'finance.config.read'),
  ('company_admin',    'finance.config.update'),
  ('company_admin',    'finance.control.assign_duty'),
  ('company_admin',    'finance.control.grant_access'),
  ('company_admin',    'finance.control.read'),
  ('company_admin',    'finance.control.revoke_access'),
  ('company_admin',    'finance.control.waive_conflict'),
  ('company_admin',    'finance.period.close'),
  ('company_admin',    'finance.period.lock'),
  ('company_admin',    'finance.period.read'),

  ('finance_manager',  'finance.config.create'),
  ('finance_manager',  'finance.config.delete'),
  ('finance_manager',  'finance.config.read'),
  ('finance_manager',  'finance.config.update'),
  ('finance_manager',  'finance.control.read'),
  ('finance_manager',  'finance.period.close'),
  ('finance_manager',  'finance.period.lock'),
  ('finance_manager',  'finance.period.read'),
  ('finance_manager',  'finance.period.reopen'),

  ('finance_staff',    'finance.config.read'),
  ('finance_staff',    'finance.period.read'),

  ('owner',            'finance.config.create'),
  ('owner',            'finance.config.delete'),
  ('owner',            'finance.config.read'),
  ('owner',            'finance.config.update'),
  ('owner',            'finance.control.assign_duty'),
  ('owner',            'finance.control.grant_access'),
  ('owner',            'finance.control.read'),
  ('owner',            'finance.control.revoke_access'),
  ('owner',            'finance.control.waive_conflict'),
  ('owner',            'finance.period.close'),
  ('owner',            'finance.period.lock'),
  ('owner',            'finance.period.read'),

  ('platform_admin',   'finance.config.create'),
  ('platform_admin',   'finance.config.delete'),
  ('platform_admin',   'finance.config.read'),
  ('platform_admin',   'finance.config.update'),
  ('platform_admin',   'finance.control.assign_duty'),
  ('platform_admin',   'finance.control.grant_access'),
  ('platform_admin',   'finance.control.read'),
  ('platform_admin',   'finance.control.revoke_access'),
  ('platform_admin',   'finance.control.waive_conflict'),
  ('platform_admin',   'finance.period.close'),
  ('platform_admin',   'finance.period.lock'),
  ('platform_admin',   'finance.period.read'),
  ('platform_admin',   'finance.period.reopen')
) AS v(role_name, perm_key)
JOIN roles       r ON r.company_id IS NULL AND r.name = v.role_name
JOIN permissions p ON p.key = v.perm_key
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
);
