-- ASST-21 — link an assistant thread to a goal run created via "hand off to a specialist".
--
-- Ticket: docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md ("### ASST-21").
-- Design: docs/blueprints/assistant-foundation.md §8's "agent roster" line + the "Proposed BFF
-- contract" table's `POST /api/:t/assistant/threads/:id/handoff` row.
--
-- ── WHY THIS TABLE EXISTS (the authz design pin, restated) ────────────────────────────────────────
-- A handoff runs under the CHATTING USER's own OBO envelope (broker.ts's `oboEnvelopeFor`, the ONE
-- function that can spell one — reused here, not re-implemented). That is what makes it SAFE for a
-- non-elevated owner to read the run's transcript back: the run executed under their own authority,
-- so reading it is not an elevation. `admin/intelligence.controller.ts`'s `GET :t/agents/runs/:runId`
-- needs to answer "is THIS runId a handoff THIS caller triggered?" without trusting anything in the
-- request — this table is that answer, keyed by run_id, carrying the triggering user's id directly
-- (not merely by joining back through assistant_threads.owner_user_id) so the additive Cerbos rule
-- (`resource_agent_run.yaml`) can be checked from one row, no second join.
--
-- ── NUMBERING (rule 5, migrations/README.md) ──────────────────────────────────────────────────────
-- Re-verified at authoring time: `ls migrations | sort | tail` showed the real head as
-- `0083_approval_status_cancelled.sql`, so this takes 0084.
--
-- ── goal_id / run_id ARE BARE uuid, NO FK (mirrors 0079's `assistant_tool_calls.approval_id`) ──────
-- Both ids come from the ai-agents runner's OWN Postgres store (`agent_goals`/`agent_runs`), a
-- separate database/service — there is no FK target in THIS database to reference, exactly the same
-- cross-service situation 0079 already documented for `assistant_tool_calls.approval_id` pointing at
-- `automation_approvals` (which at least lives in this DB but still has no composite unique to FK
-- against). `run_id` is NULL until the runner reports a terminal run for the goal (a single-specialist
-- handoff's run is created once traceRun/runWriteAgent finishes — see runner/service.ts's
-- `processGoal`); `GET .../assistant/threads/:id/handoffs` lazily backfills it by polling the goal.
--
-- ── THE TWO-SIDED MODULE WALL (constraint 2, WD-23A-1 lesson) ────────────────────────────────────
-- Same composed `tenant_isolation` policy as 0079's four assistant_* tables, mod='assistant'.
--
-- ── COMPOSITE TENANT-SCOPED FK to assistant_threads (constraint 3) ───────────────────────────────
-- `(thread_id, tenant_id) REFERENCES assistant_threads (id, tenant_id) ON DELETE CASCADE` — same
-- reasoning as 0079's `assistant_messages.thread_id`: a plain FK would let a handoff row carry
-- tenant A's tenant_id while thread_id resolves into tenant B, invisible to any RLS-scoped SELECT.
--
-- ── ZERO BACKFILL DML (constraint 6) ──────────────────────────────────────────────────────────────
-- Fresh CREATE TABLE only. Nothing for `npm run lint:migration-rls` to flag.
--
-- ── ERASURE REACH (constraint 7) ──────────────────────────────────────────────────────────────────
-- ON DELETE CASCADE from assistant_threads means `eraseTenant`'s existing
-- `DELETE FROM assistant_threads WHERE tenant_id = ...` already reaches this table too — no new
-- erasure code path needed.
CREATE TABLE assistant_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  thread_id uuid NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users(id),   -- Cerbos ownerId: the CHATTING USER (== the thread's own owner; authorize() at creation already enforces that — stored directly so a run-transcript read never needs a second join)
  agent text NOT NULL,
  goal_text text NOT NULL,
  goal_id uuid NOT NULL,                              -- ai-agents runner's own goal id (separate DB; no FK, see header)
  run_id uuid,                                         -- filled once the runner reports a terminal run for this goal (separate DB; no FK)
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','ok','suspended','budget_exhausted','failed','interrupted','cancelled')),
  outcome text,
  error_kind text,
  approval_id uuid,                                    -- automation_approvals row when suspended; no FK (mirrors assistant_tool_calls.approval_id)
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_assistant_handoffs_id_tenant UNIQUE (id, tenant_id),
  CONSTRAINT fk_assistant_handoffs_thread_tenant
    FOREIGN KEY (thread_id, tenant_id) REFERENCES assistant_threads (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX ix_assistant_handoffs_thread ON assistant_handoffs (thread_id, created_at DESC);
CREATE INDEX ix_assistant_handoffs_owner ON assistant_handoffs (tenant_id, owner_user_id);
-- A goal fans out into at most one run per single-specialist handoff (supervisor fan-out is not
-- offered by this endpoint — see handoffs.ts's agent validation), so run_id is unique when present;
-- the partial index lets it stay NULL for every still-queued/running row without colliding.
CREATE UNIQUE INDEX ux_assistant_handoffs_run_id ON assistant_handoffs (run_id) WHERE run_id IS NOT NULL;

COMMENT ON TABLE assistant_handoffs IS
  'ASST-21: links an assistant thread to a goal run created via "hand off to a specialist". '
  'owner_user_id is the CHATTING USER whose OBO envelope the run executed under (broker.ts''s '
  'oboEnvelopeFor) — the fact that makes owner-only transcript reads of THIS run safe '
  '(resource_agent_run.yaml''s additive Cerbos rule, admin/intelligence.controller.ts). '
  'ON DELETE CASCADE from assistant_threads (composite FK, tenant-checked).';

ALTER TABLE assistant_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_handoffs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON assistant_handoffs FOR ALL
  USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('assistant'))
  WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('assistant'));
