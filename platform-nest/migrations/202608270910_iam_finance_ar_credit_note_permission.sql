-- Finance F4b — the IAM half of AR credit notes (2026-08-27), for 202608270900.
--
-- ONE new grantable permission on the EXISTING `finance_ar` Cerbos kind. No new kind, no new duty.
--
-- ── WHY A SEPARATE ACTION WHEN THE DUTY IS SHARED ──────────────────────────────────────────────
-- 202608241013 already seeds the duty as:
--
--     ar_writeoff_approve — "AR credit note / write-off approval" — "Forgive or reduce a receivable"
--
-- so the SoD matrix always intended credit notes to sit under that one duty, in the blocking pair
-- `ar_receipt_posting + ar_writeoff_approve` ("pocket the cash, then write off the debt"). Issuing a
-- credit note is a perfectly good way to run that fraud, and nothing here changes that: the CONTROL
-- stays unified in the duty matrix.
--
-- What is split is the CAPABILITY, and only because the two differ in how often they legitimately
-- happen. `write_off` requires `assurance == "high"` in the Cerbos policy — a step-up. A sales
-- return or a billing correction is routine commercial traffic, sometimes several a day, and putting
-- a step-up in front of every one of them produces exactly one outcome: the step-up gets bypassed by
-- granting people write_off permanently, which destroys the control for the case that actually
-- needs it. Frequency is the argument, not risk.
--
-- ── THE TIERS ───────────────────────────────────────────────────────────────────────────────────
--   finance_staff   NO. A credit note makes a receivable vanish; the AR officer who banks receipts
--                   must not also be able to paper over a missing one. Same reasoning as write_off.
--   finance_manager YES.
--   company_admin   YES — reducing a receivable is a governance decision, matching write_off.
--   owner           mirrors company_admin. ⚠ NOT automatic: IAM-14 built the owner bundle with a
--                   one-time INSERT..SELECT, so every later key must be mirrored EXPLICITLY or
--                   owner-role.db.test.ts goes red. This is the most-repeated cause of that failure.
--   platform_admin  YES.
--
-- ROLE-ARM ONLY, no perm_* mirror — same posture as every other finance kind. Additive; no existing
-- row is updated or deleted.

INSERT INTO permissions (id, key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description, v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('finance.ar.credit_note', 'finance', 'ar', 'credit_note',
   'Raise and issue an AR credit note (sales return, over-billing or agreed discount). Reduces the receivable AND reverses output VAT. Binds to the ar_writeoff_approve duty.',
   'finance_ar', 'credit_note', 'grantable', true, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('company_admin',   'finance.ar.credit_note'),
  ('finance_manager', 'finance.ar.credit_note'),
  ('owner',           'finance.ar.credit_note'),
  ('platform_admin',  'finance.ar.credit_note')
) AS v(role_name, perm_key)
JOIN roles       r ON r.company_id IS NULL AND r.name = v.role_name
JOIN permissions p ON p.key = v.perm_key
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
);
