-- 0111_iam_phase2_employee_work_email_key.sql — P2-06: make the joiner flow's stated natural key
-- real at the DB layer.
--
-- Design: docs/superpowers/plans/2026-08-13-iam-phase2-design.md §5.1 — "Idempotency:
-- `(tenant_id, work_email)` natural key; a retry converges." P2-01's schema (`0109`) shipped the
-- partial unique on `(tenant_id, user_id) WHERE user_id IS NOT NULL`, which is the right constraint
-- for the linked-principal axis but does NOT cover the key the joiner actually retries on: a
-- `pending_start` candidate has NO `user_id` yet (0109's own comment says so), so two retries of the
-- same hire before the principal exists would have produced two employee rows for one person, with
-- nothing at the DB layer to stop it. Found while building the flow, not assumed from the design.
--
-- ── NUMBERING (migrations/README.md rule 5) ────────────────────────────────────────────────────
-- `ls migrations | sort | tail` immediately before writing showed the head as
-- `0110_iam_phase2_role_grant_kinds_ui_grantable.sql` with `0111` free. `0058`/`0059`/`0070` remain
-- the permanently orphaned reservation gaps from earlier programs — not touched, not filled.
--
-- ── WHY PARTIAL, AND WHY THESE TWO PREDICATES ──────────────────────────────────────────────────
-- `work_email IS NOT NULL`: a plain UNIQUE would never fire for candidates with no email, because
-- SQL NULLs are distinct — the [null-defeats-unique-constraints] trap this program has already been
-- bitten by twice (0073/0092 on `user_roles`). `deleted_at IS NULL`: a soft-deleted record must not
-- block re-hiring the same person later; the constraint governs LIVE rows only.
--
-- Emails are lowercased in the application layer before every write
-- (`employees.controller.ts::hire`), so this is a plain column index rather than a
-- `lower(work_email)` expression index — matching how `users.email` is already handled (0001 +
-- `inviteUser`). Recorded here because the invariant lives half in code: if a future writer stops
-- lowercasing, this index stops being the case-insensitive key the design describes.
--
-- ── ZERO DML ───────────────────────────────────────────────────────────────────────────────────
-- Index creation only. `employees` is a P2-01 table with no live rows in any environment yet
-- (nothing wrote to it before P2-06), so there is no pre-existing duplicate to reconcile; the
-- CREATE would fail loudly rather than silently drop data if that assumption were ever wrong.

CREATE UNIQUE INDEX ux_employees_tenant_work_email
  ON employees (tenant_id, work_email)
  WHERE work_email IS NOT NULL AND deleted_at IS NULL;

COMMENT ON INDEX ux_employees_tenant_work_email IS
  'IAM Phase 2 (P2-06) — design §5.1''s joiner natural key. Partial on work_email IS NOT NULL '
  '(NULLs are distinct, so a plain UNIQUE would not fire for pending_start candidates) and on '
  'deleted_at IS NULL (a soft-deleted record must not block a re-hire). Case-insensitivity is '
  'maintained by the application lowercasing every work_email before write.';
