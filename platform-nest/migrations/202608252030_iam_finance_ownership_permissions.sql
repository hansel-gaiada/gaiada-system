-- IAM — UI-01b: the `finance_ownership` permission family.
--
-- Fourth of the five coupled artifacts a new Cerbos kind requires. The others, in order:
--   1. `cerbos/policies/resource_finance_ownership.yaml`      — the policy
--   2. `src/rbac/permission-catalog.json`                     — the keys
--   3. `src/rbac/role-permission-bundles.json`                — GENERATED from (1) + (2)
--   4. this migration                                         — the same rows, in the database
--   5. `scripts/generate-role-bundles.mjs` + `role-permission-parity.db.test.ts` — both resolvers
--
-- (5) is the one that is easy to miss and the generator refuses to guess: it threw
-- `unhandled module_manager kind "finance_ownership"` rather than silently mapping the kind to no
-- role, which would have produced a bundle that looked complete and granted nobody anything.
--
-- ── WHY THE CONTROLLER CAN READ THIS AND NOT WRITE IT ───────────────────────────────────────────
-- ★ An ownership edge is an AUTHORIZATION fact. `finance_owner_company_ids()` resolves a person's
-- visibility from this table, and a `holding` edge confers the company plus every descendant. So a
-- write here can widen the writer's own reach — by inserting one row naming themselves.
--
-- `finance_manager` therefore gets READ only: consolidation basis (full / equity / investment) is
-- derived from these percentages and a controller preparing group figures needs to see them.
-- Writing is `company_admin`, `owner` and `platform_admin`.
--
-- `finance_staff` gets NOTHING. A clerk coding an expense claim has no reason to hold the
-- shareholder register, and a cap table is exactly the kind of thing that is uninteresting until it
-- is very interesting.
--
-- ── THERE IS NO `delete` ───────────────────────────────────────────────────────────────────────
-- Deliberately absent from the catalog, the policy and here. Ownership is effective-dated: removing
-- a holder means setting `effective_to`, which is an `update`. Last year's statements were true
-- under last year's cap table, and a DELETE would make them unexplainable.

INSERT INTO permissions (id, key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description, v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('finance.ownership.read', 'finance', 'ownership', 'read',
   'Read the cap table: who holds what stake in which company, and from when.',
   'finance_ownership', 'read', 'grantable', true, true),
  ('finance.ownership.create', 'finance', 'ownership', 'create',
   'Record a new ownership edge. Confers authorization scope: a holding edge reaches every descendant company.',
   'finance_ownership', 'create', 'grantable', true, true),
  ('finance.ownership.update', 'finance', 'ownership', 'update',
   'Amend or END-DATE an ownership edge. There is no delete: last year''s statements were true under last year''s cap table.',
   'finance_ownership', 'update', 'grantable', true, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

-- ⚠ `owner` is listed EXPLICITLY. IAM-14 built the owner bundle with a one-time INSERT..SELECT from
-- company_admin, so a new company_admin key does NOT propagate — every later key must mirror onto
-- `owner` by hand or `owner-role.db.test.ts` goes red. This is the most-repeated cause of that
-- suite failing, which is why it is called out here rather than assumed.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('company_admin',  'finance.ownership.create'),
  ('company_admin',  'finance.ownership.read'),
  ('company_admin',  'finance.ownership.update'),

  -- READ ONLY. See the header — a controller who could write here could widen their own scope.
  ('finance_manager','finance.ownership.read'),

  ('owner',          'finance.ownership.create'),
  ('owner',          'finance.ownership.read'),
  ('owner',          'finance.ownership.update'),

  ('platform_admin', 'finance.ownership.create'),
  ('platform_admin', 'finance.ownership.read'),
  ('platform_admin', 'finance.ownership.update')
) AS v(role_name, perm_key)
JOIN roles r ON r.company_id IS NULL AND r.name = v.role_name
JOIN permissions p ON p.key = v.perm_key
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
);
