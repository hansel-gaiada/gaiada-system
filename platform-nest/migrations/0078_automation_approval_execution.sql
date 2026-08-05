-- D14-01 — separate EXECUTION state from DECISION state on automation_approvals.
--
-- Ticket: docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md (D14-01)
-- Program: docs/superpowers/plans/2026-08-05-d14-resume-path-plan.md
--
-- WHY THIS COLUMN SPLIT IS THE POINT OF THE WHOLE PROGRAM
-- `status` (pending/approved/rejected) is the HUMAN DECISION. Until now that was the only state a row
-- carried, and 0014's own header said resumption was out of scope — so an `approved` row meant
-- "a human said yes" and NOTHING about whether the refused tool call ever ran. It never did: the
-- `automation_approval.decided` event has exactly one consumer (hr's leave handler, origin='hr'), so
-- for origin automation|agent the approval was a status flip plus an audit row.
--
-- That is why the UI, `writeActivity`, and the audit trail could all agree a human authorized a change
-- that never happened. Conflating decision with execution is what made the failure SILENT and, worse,
-- POSITIVE — it manufactured evidence of work. `execution_status` is the honest second axis, and every
-- other ticket in this program hangs off it.
--
-- Deliberately NOT reusing / extending `status`: a decision and an execution attempt have independent
-- lifecycles (a row can be approved-but-not-yet-run, approved-and-failed, or approved-and-retried),
-- and squeezing those into one enum would break every existing `status = 'pending'` predicate — incl.
-- the idempotency guard the executor itself depends on.
--
-- ── NUMBERING (rule 5, migrations/README.md) ──────────────────────────────────────────────────────
-- Re-verified against migrations/ at authoring time, not inherited from the plan text: head was
-- `0077_mail_core.sql`, so this takes **0078**. `0058`, `0059` and `0070` are permanently-orphaned
-- reservation gaps — do NOT fill them. The assistant program's own core migration re-verifies at its
-- build time and takes 0079 only if this one has landed first (its ticket is wave-serialized after
-- this file for exactly that reason).
--
-- ── NO BACKFILL DML, BY CONSTRUCTION (stated so no reviewer goes looking for the missing backfill) ─
-- Every new column is either nullable or `NOT NULL DEFAULT`, so PostgreSQL's ADD COLUMN fills existing
-- rows itself. There is no DML in this file at all.
--
-- This is not a style preference — it is the only structurally un-no-op-able form. A backfill UPDATE
-- run by a role without BYPASSRLS and without `app.current_tenant_ids` set matches ZERO rows, commits
-- happily, and reports success; the platform has been bitten by exactly that (0050) and
-- `npm run lint:migration-rls` now enforces the set_config wrapping for 0052+. DDL-filled defaults
-- sidestep the trap entirely rather than defending against it.
--
-- Existing rows therefore read `execution_status = 'not_applicable'`, which is the correct history:
-- nothing that was decided before this program existed was ever executed by it, and nothing should
-- retroactively claim to have been.

ALTER TABLE automation_approvals
  -- 'not_applicable' is the DEFAULT and it is load-bearing: the executor is REGISTRY-scoped, not
  -- origin-scoped. A row whose tool has no executable-registry entry must stay 'not_applicable'
  -- forever. That is what keeps two existing designs intact:
  --   * origin='hr'     — modules/hr/leave-decision.ts applies its own domain mutation on the
  --                       decided event; auto-executing would double-apply it.
  --   * origin='agent'  — search's sem-apply path is CALLER-re-driven (sem-apply.ts requires the row
  --     / 'automation'   to already be status='approved' when the caller applies). Auto-executing a
  --                       search row would both double-apply AND spend real client ad money, which
  --                       SM-55/A13 bars outright.
  -- Only 'pending' is set at decide time, and only for tools present in the executable registry.
  ADD COLUMN execution_status text NOT NULL DEFAULT 'not_applicable'
    CHECK (execution_status IN ('not_applicable','pending','executing','executed','failed')),

  -- When the re-driven call actually ran (success or failure), NOT when it was decided.
  ADD COLUMN executed_at timestamptz,

  -- The principal that RAN the call — deliberately distinct from `decided_by`, which is the human who
  -- lifted the impact gate. These are different facts and conflating them destroys the audit trail's
  -- meaning. Execution re-drives as the ORIGINAL filing principal (uuid ⇒ users(id); automation and
  -- bot accounts are users rows by design), never as the approver: the D14 gate suspends on IMPACT
  -- TIER only (mcp-hub/src/policy.ts), so the filing principal was already otherwise authorized.
  -- Executing as the approver would be privilege amplification — and with superadmin as the standing
  -- approver (OQ-1), total amplification.
  ADD COLUMN executed_by uuid REFERENCES users(id),

  -- Why a 'failed' row failed, in human-readable form. With auto-execute-on-approval (OQ-4) there is
  -- no human standing by at execution time, so this column plus its notification are the only things
  -- standing between the platform and a NEW silent failure mode replacing the old one.
  ADD COLUMN execution_error text,

  -- The tool's return payload, for audit and for the re-run path: an already-'executed' row is
  -- CONSUMED by reusing this result rather than calling the tool a second time.
  ADD COLUMN execution_result jsonb,

  -- Retry is human-triggered in v1 (OQ-5). Counting attempts is what lets the UI distinguish
  -- "never ran" from "ran and failed three times" — and bounds any future automatic policy.
  ADD COLUMN execution_attempts int NOT NULL DEFAULT 0;

-- Partial index: the executor and the approvals UI both scan for rows with live execution state, which
-- is a small minority of the table. Excluding 'not_applicable' keeps this index proportional to real
-- work rather than to the whole approvals history.
CREATE INDEX automation_approvals_execution_idx
  ON automation_approvals (tenant_id, execution_status)
  WHERE execution_status <> 'not_applicable';

-- RLS is untouched on purpose: 0014 already set ENABLE + FORCE ROW LEVEL SECURITY with the
-- authorized-tenant-set `tenant_isolation` policy FOR ALL, and ADD COLUMN inherits it. Re-declaring
-- the policy here would risk diverging from 0001/0011's shared shape.
