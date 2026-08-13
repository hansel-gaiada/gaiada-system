-- IAM-GAP-01 — close two known authorization gaps the owner approved defaults for:
--   (1) invoices have no maker/checker seam (no created_by, no approved state, no `approve` action);
--   (2) HR leave decisions ride the generic core.automation_approval.decide instead of their own
--       dedicated decision right.
--
-- Companion policies: cerbos/policies/resource_invoice.yaml (`approve` action),
-- cerbos/policies/resource_automation_approval.yaml (`decide_leave` action). Companion catalog:
-- src/rbac/permission-catalog.json (+2 grantable: billing.invoice.approve, hr.leave.decide).
-- Companion handlers: src/modules/billing/billing.controller.ts (POST .../invoices/:id/approve,
-- created_by on create, approved-gate on the sent/paid transition),
-- src/core/automation-approvals.controller.ts (decide() now requests `decide_leave` for
-- origin='hr' rows whose workflow_id is 'hr:leave'; every other origin/workflow is unaffected).
-- Report: docs/superpowers/plans/2026-08-13-iam-gap-01-report.md.
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────────────
-- 0107 reserved by creating this file; docs/MAP.md's generated head at the time was 0106
-- (`0058`/`0059`/`0070` remain permanently-orphaned dead reservations, untouched).
--
-- ── PART 1: invoices — the maker/checker schema (BLOCKER per the ticket: policy cannot express
--    "approver != creator" while nothing records the creator) ─────────────────────────────────────
-- `created_by` is added with NO BACKFILL. There is no reliable historical-actor signal on this
-- table (`origin_site` records which deployment wrote the row, not which user) — inventing one
-- would be a fabricated audit trail, worse than an honest NULL. CONSEQUENCE, stated plainly: every
-- invoice that exists before this migration runs has `created_by IS NULL` forever unless an
-- operator sets it by hand, and resource_invoice.yaml's new `approve` rule is written to FAIL
-- CLOSED on a NULL/unknown creator (`has(...) && creatorId != "" && creatorId != principal.id` —
-- an empty creatorId can never satisfy the inequality check on its own, by design) — so every
-- legacy invoice is permanently unapprovable by company_admin/manager until that hand-fix happens.
-- Only the pre-existing platform_admin/group_executive wildcard rule (unchanged by this migration)
-- can still approve a legacy row, exactly as it already bypasses create/read/update/delete today.
--
-- `approved_by`/`approved_at` are the checker's own attribution, parallel to `created_by`/
-- `created_at`. `status` CHECK gains `'approved'` as a new state between `draft` and `sent`/`paid`
-- — the constraint is dropped and re-added by DISCOVERED name (not a hardcoded guess) because
-- 0021's inline `CHECK (status IN (...))` was never given an explicit constraint name, and this
-- migration must not assume Postgres's default-naming convention holds forever.
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

DO $$
DECLARE con text;
BEGIN
  SELECT conname INTO con
    FROM pg_constraint
   WHERE conrelid = 'invoices'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%status%';
  IF con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE invoices DROP CONSTRAINT %I', con);
  END IF;
END $$;

ALTER TABLE invoices
  ADD CONSTRAINT invoices_status_check CHECK (status IN ('draft', 'approved', 'sent', 'paid', 'void'));

-- No RLS backfill trap here (migration-backfill-rls-trap): this file writes NO DML against
-- `invoices` at all (no UPDATE, no INSERT ... SELECT) — only DDL (ADD COLUMN / constraint
-- swap), which is unconditional and unaffected by an unset `app.current_tenant_ids` GUC or FORCE
-- RLS. Asserted below anyway, per this program's "assert, don't assume" discipline.

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 · The 2 catalog permissions
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
INSERT INTO permissions (id, key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description, v.cerbos_kind, v.cerbos_action, v.class, v.sensitive
FROM (VALUES
  ('billing.invoice.approve', 'billing', 'invoice', 'approve',
   'Approve an invoice for send/payment. Maker/checker seam: the approver may not be the invoice''s own creator; fails closed if the creator is unknown (legacy pre-migration rows).',
   'invoice', 'approve', 'grantable', true),
  ('hr.leave.decide', 'hr', 'leave', 'decide',
   'Approve or reject a leave request. Dedicated decision right, separate from the generic core.automation_approval.decide so "who may approve leave" is scopeable on its own; maps onto automation_approval''s new decide_leave Cerbos action (loan requests keep the generic decide).',
   'automation_approval', 'decide_leave', 'grantable', true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive)
ON CONFLICT (key) DO UPDATE SET
  module_key = EXCLUDED.module_key,
  resource = EXCLUDED.resource,
  action = EXCLUDED.action,
  description = EXCLUDED.description,
  cerbos_kind = EXCLUDED.cerbos_kind,
  cerbos_action = EXCLUDED.cerbos_action,
  class = EXCLUDED.class,
  sensitive = EXCLUDED.sensitive;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 · The 8 role_permissions bundle pairs — machine-derived (PROVENANCE: the set difference
-- between src/rbac/role-permission-bundles.json before/after `npm run gen:role-bundles` re-derived
-- it from the two new Cerbos rules above; see 0106's own header for why this is trustworthy —
-- generate-role-bundles.mjs is a THIRD independent expression of the same algorithm
-- role-permission-parity.db.test.ts checks live).
--   platform_admin   +2  (billing.invoice.approve, hr.leave.decide — its wildcard covers both kinds)
--   company_admin    +2  (billing.invoice.approve, hr.leave.decide — both new role-arm rules name it)
--   group_executive  +2  (billing.invoice.approve via the PRE-EXISTING invoice wildcard [platform_admin,
--                         group_executive] — unchanged by this ticket, just newly exposed by the new
--                         action; hr.leave.decide via its own new IAM-TRAP4-shaped rule)
--   manager          +1  (billing.invoice.approve only — the owner's "department manager tier"
--                         default; manager is NOT named on decide_leave)
--   hr_manager       +1  (hr.leave.decide only, via module_manager gated module=='hr' && subKind=='leave')
-- Zero pairs removed. No existing user's reach narrows.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('company_admin', 'billing.invoice.approve'),
  ('company_admin', 'hr.leave.decide'),
  ('group_executive', 'billing.invoice.approve'),
  ('group_executive', 'hr.leave.decide'),
  ('hr_manager', 'hr.leave.decide'),
  ('manager', 'billing.invoice.approve'),
  ('platform_admin', 'billing.invoice.approve'),
  ('platform_admin', 'hr.leave.decide')
) AS bundle(role_name, perm_key)
JOIN roles r ON r.company_id IS NULL AND r.name = bundle.role_name
JOIN permissions p ON p.key = bundle.perm_key
ON CONFLICT DO NOTHING;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- PART 4 · Assert, don't assume
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  missing text[];
  got integer;
  expected record;
BEGIN
  -- (a) invoices DDL landed
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'invoices' AND column_name IN ('created_by', 'approved_by', 'approved_at')
    HAVING count(*) = 3
  ) THEN
    RAISE EXCEPTION '0107: invoices is missing one or more of created_by/approved_by/approved_at';
  END IF;

  -- Real assertion, not a `WHERE FALSE` no-op (a zero-row INSERT never evaluates a CHECK at all):
  -- inspect the constraint's own definition text for the new 'approved' literal.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'invoices'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%''approved''%'
  ) THEN
    RAISE EXCEPTION '0107: no CHECK constraint on invoices.status admits ''approved'' after the swap';
  END IF;

  -- (b) the 2 catalog rows landed
  SELECT array_agg(k) INTO missing FROM (
    SELECT unnest(ARRAY['billing.invoice.approve', 'hr.leave.decide']) AS k
    EXCEPT SELECT key FROM permissions
  ) AS x;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0107: catalog rows missing after insert: %', missing;
  END IF;

  SELECT count(*) INTO got FROM permissions
   WHERE key IN ('billing.invoice.approve', 'hr.leave.decide') AND class = 'grantable';
  IF got <> 2 THEN
    RAISE EXCEPTION '0107: expected both new permissions class=grantable, found %', got;
  END IF;

  -- (c) the bundle pairs are exactly the 8 the generator derived — a mismatch means this file and
  --     src/rbac/role-permission-bundles.json have diverged; regenerate, never edit the number.
  FOR expected IN
    SELECT * FROM (VALUES
      ('company_admin', 'billing.invoice.approve'),
      ('company_admin', 'hr.leave.decide'),
      ('group_executive', 'billing.invoice.approve'),
      ('group_executive', 'hr.leave.decide'),
      ('hr_manager', 'hr.leave.decide'),
      ('manager', 'billing.invoice.approve'),
      ('platform_admin', 'billing.invoice.approve'),
      ('platform_admin', 'hr.leave.decide')
    ) AS x(role_name, perm_key)
  LOOP
    SELECT count(*) INTO got
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.company_id IS NULL AND r.name = expected.role_name AND p.key = expected.perm_key;
    IF got <> 1 THEN
      RAISE EXCEPTION '0107: expected bundle pair (%, %) to exist exactly once, found %', expected.role_name, expected.perm_key, got;
    END IF;
  END LOOP;

  -- (d) no OTHER role picked up either key (a copy-paste from the wrong role list would show up here)
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.company_id IS NULL AND p.key IN ('billing.invoice.approve', 'hr.leave.decide')
     AND NOT (r.name IN ('company_admin', 'group_executive', 'hr_manager', 'manager', 'platform_admin'));
  IF got <> 0 THEN
    RAISE EXCEPTION '0107: % unexpected role(s) hold billing.invoice.approve/hr.leave.decide outside the 5-role list above', got;
  END IF;

  -- (e) the 15-permission relationship boundary is intact
  SELECT count(*) INTO got FROM permissions
   WHERE key IN ('billing.invoice.approve', 'hr.leave.decide') AND class <> 'grantable';
  IF got <> 0 THEN
    RAISE EXCEPTION '0107: % non-grantable row(s) among the new permissions — the grantable/relationship boundary moved', got;
  END IF;
END $$;
