-- CLIENT-QA B.3a — the IAM half of change-request verification (2026-08-27).
-- Program: PROGRESS-CLIENT-QA.md. Pairs with 202608271900_change_request_verification.sql, which
-- adds the `verified` status and its attribution columns.
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────────────
-- Timestamp naming (migrations/README.md rule 5). Written from a worktree cut at e02ba16c, where
-- `ls migrations/*.sql | sort | tail` showed head = 202608272010_iam_finance_ap_credit_writeoff.sql
-- (204 files). NOT written from the shared checkout, which is 54 commits behind and would have had
-- me derive every count below from a stale base — the root cause of three separate red runs on
-- 2026-08-27.
--
-- ── ONE GRANTABLE PERMISSION ON AN EXISTING KIND ─────────────────────────────────────────────────
-- `webdev.change_request.verify` on the existing `webdev_change_request` kind. No new Cerbos kind,
-- no new duty, no SoD pair — this is not a finance-style custody act. Counts moved 387 -> 388
-- concrete pairs and 372 -> 373 grantable; kind count unchanged at 96.
--
-- ── WHY IT IS NOT `sensitive` ────────────────────────────────────────────────────────────────────
-- Verification attests that work already done is actually done. It moves no money, exposes no PII,
-- and produces no artefact that leaves the ERP. Marking it sensitive would put a step-up in front of
-- routine QA traffic, which is the frequency argument F4b makes for `finance.ar.credit_note` — a
-- step-up in front of everything gets granted away permanently.
--
-- ── THE TIERS, AND THE ONE DELIBERATE OMISSION ───────────────────────────────────────────────────
-- Granted to exactly the roles that already hold `triage`:
--   platform_admin, company_admin, manager, webdev_manager, owner
-- and deliberately NOT to `webdev_staff`, which holds only `read`.
-- resource_webdev_change_request.yaml's own comment draws that line — the dept's staff read the
-- queue but do not decide it — and verification IS a decision: it closes the loop and asserts a fix
-- is real. If QA turns out to sit at staff tier operationally, widening it is an OWNER decision, and
-- widening later is cheap. Granting it now and discovering the department's staff can self-certify
-- their own work is not.
-- ⚠ `owner` is NOT automatic — IAM-14's one-time INSERT..SELECT does not backfill later permissions,
-- so it is named explicitly here, exactly as 202608272010 names it.
--
-- ROLE-ARM ONLY — no perm_* mirror. A mirror was written and then REMOVED on evidence: IAM-04-REG1's
-- sweep flagged that mirroring `verify` the way `triage` is mirrored adds
--     "webdev_change_request.verify": ["webdev_manager"]
-- to the out-of-scope register, the SAME hazard shape the already-baselined
-- `webdev_change_request.triage` entry carries. `module_manager` composes from `attr.module`, so its
-- role-arm reach is narrower than the mirror's tenant-wide condition and the mirror would grant a
-- webdev_manager reach its role does not. That pin says "do not widen this baseline to silence it",
-- and adding a second instance of a known hazard to close a ticket is silencing it.
-- Consequence, stated plainly: a principal granted this key through the PERMISSION arm gets nothing
-- until a follow-up IAM ticket audits triage's mirror and this one together. Fail-closed on purpose.
-- Additive.

INSERT INTO permissions (id, key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description, v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('webdev.change_request.verify', 'webdev', 'change_request', 'verify',
   'Confirm a completed change request was actually fixed, recording who verified it and against which build. Separate from triage: triage decides what to do with a request, verification attests the result is real.',
   'webdev_change_request', 'verify', 'grantable', false, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('platform_admin', 'webdev.change_request.verify'),
  ('company_admin',  'webdev.change_request.verify'),
  ('manager',        'webdev.change_request.verify'),
  ('webdev_manager', 'webdev.change_request.verify'),
  ('owner',          'webdev.change_request.verify')
) AS v(role_name, perm_key)
JOIN roles       r ON r.company_id IS NULL AND r.name = v.role_name
JOIN permissions p ON p.key = v.perm_key
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id);

-- Assert, rather than trust — the ui_grantable invariant that took nine files red on 2026-08-27 when
-- 202608271400 inserted a grantable non-portal key with ui_grantable = false. `position_roles_guard()`
-- (0110 clause b) refuses to attach a role to a position if that role's bundle holds even ONE such
-- permission, which is invisible on live (existing rows keep true) and breaks every FRESH database,
-- CI included. Copied verbatim from 202608272010_iam_finance_ap_credit_writeoff.sql so the two cannot
-- drift into disagreeing about what the invariant is.
DO $$
DECLARE v_bad integer;
BEGIN
  SELECT count(*) INTO v_bad FROM permissions
   WHERE ui_grantable IS NOT TRUE AND class <> 'relationship' AND key NOT LIKE 'portal.%';
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'IAM_UI_GRANTABLE_INVARIANT_BROKEN: % non-relationship, non-portal permission(s) are ui_grantable=false', v_bad;
  END IF;
END $$;
