-- ASST-23/T3b — the confirm-before-file machinery: an unconfirmed assistant write proposal, held
-- durably OUTSIDE the shared `automation_approvals` ledger until the owner explicitly confirms it.
--
-- Ticket: T3b, docs/superpowers/plans/2026-08-06-t3b-confirm-machinery-report.md.
-- Design: docs/superpowers/plans/2026-08-06-asst-23-unblock-design.md §7.2 (the owner's OQ-2
-- override, RULED and AUTHORITATIVE over the earlier §2.4.2 argument it supersedes).
--
-- ── WHY A NEW TABLE, NOT A NEW STATUS ON AN EXISTING ONE (§7.2.1's rejected alternatives) ──────────
-- A `proposed` value on `assistant_tool_calls.status` would need a migration ANYWAY (its CHECK is
-- closed) and would still need somewhere to hold the REAL (unredacted) args, since that column is
-- documented (0079) as "REDACTED before persist" — the redaction is an invariant this migration must
-- not touch. A draft/unconfirmed state ON `automation_approvals` was rejected for a sharper reason:
-- that table is WS4's shared core (n8n + agent + hr origins; `decide()`, the list endpoint, the
-- `resolve-and-execute` candidate rank) and giving it a fourth, assistant-only status would spread
-- assistant-specific state into surfaces three other subsystems reason about. A brand-new,
-- assistant-owned table with its OWN status vocabulary keeps every existing `automation_approvals`
-- consumer, including the n8n wrapper, byte-for-byte unaffected — nothing there even knows this table
-- exists.
--
-- ── NUMBERING (rule 5, migrations/README.md) ──────────────────────────────────────────────────────
-- Re-verified at authoring time, not inherited from the plan doc: `ls migrations | sort | tail`
-- showed the real head as `0084_assistant_handoffs.sql` (ASST-21, landed), so this takes **0085**.
-- `0058`, `0059`, `0070` remain permanently-orphaned reservation gaps from other programs — not
-- touched, not filled.
--
-- ── ZERO DML, ZERO BACKFILL (the migration-backfill-rls-trap memory, applied deliberately) ─────────
-- A fresh CREATE TABLE with no ALTER-with-default, no UPDATE, no DELETE-with-a-row-set, no
-- INSERT ... SELECT anywhere in this file. There is nothing here whose effect could depend on which
-- rows the migration runner (`platform_owner`, NOBYPASSRLS) happens to see — the exact shape that has
-- silently no-op'd before (an UPDATE matching zero rows and reporting success). If a future change to
-- THIS table ever needs a backfill, that is a signal to stop and get an architect-approved migration
-- spec, not to add an UPDATE here.
--
-- ── THE TWO-SIDED MODULE WALL (constraint 2, WD-23A-1's lesson) ───────────────────────────────────
-- Same composed `tenant_isolation` policy every assistant_* table gets (0079/0084), mod='assistant':
-- `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('assistant')`. A request that reads
-- the right tenant but never declared `{modules:['assistant']}` reads ZERO rows here too — including
-- the confirm/dismiss transaction itself, which is why every caller in this ticket runs inside
-- `withTenants([tenantId], …, {modules:['assistant']})`, never a bare withTenants.
--
-- ── COMPOSITE TENANT-SCOPED FK TO assistant_tool_calls (constraint 3) ────────────────────────────
-- `(tool_call_id, tenant_id) REFERENCES assistant_tool_calls (id, tenant_id) ON DELETE CASCADE` — the
-- same reasoning 0079/0084 already documented for their own composite FKs: a plain FK would let an
-- intent row carry tenant A's tenant_id while tool_call_id resolves into tenant B's row, invisible to
-- any RLS-scoped SELECT. `assistant_tool_calls` already carries `UNIQUE (id, tenant_id)` (0079), so no
-- retrofit ALTER is needed on that side. CASCADE means a thread delete (which already CASCADEs to
-- assistant_messages -> assistant_tool_calls, 0079) reaches this table for free — no new erasure code
-- path, exactly like 0084's own handoffs table.
--
-- ── `UNIQUE (tool_call_id)` HAS NO NULLABLE COLUMN (the "NULL defeats UNIQUE" trap, checked) ───────
-- `tool_call_id` is NOT NULL — every intent row is created FOR a specific suspended tool call, never
-- floating free of one — so the uniqueness this migration declares (one intent per tool call) is a
-- REAL constraint, not the silently-inert kind the null-defeats-unique memory warns about. This is
-- also the confirm/dismiss endpoints' own lookup key (`WHERE tool_call_id = $1 AND thread_id = $2`),
-- so the index the UNIQUE constraint creates is load-bearing for that query too, not merely a guard.
--
-- ── `approval_id` HAS NO FK, ON PURPOSE (mirrors 0079's `assistant_tool_calls.approval_id`) ────────
-- Bare `uuid`, commented, pointing at an `automation_approvals` row once (and only once) this intent
-- is confirmed/filed. `automation_approvals` carries no `UNIQUE (id, tenant_id)` (0078 did not add
-- one), so a composite FK is not available without a separate retrofit migration touching a live,
-- unrelated table — out of scope here, and unnecessary: nothing reads this column as an access-control
-- gate, only as an audit/cross-reference pointer once set.
--
-- ── LIFECYCLE, restated from the design (§7.2.1/§7.2.3) ─────────────────────────────────────────────
-- draft -(confirm, single-winner claim)-> filed        [tool_args scrubbed to NULL in the SAME UPDATE]
-- draft -(dismiss, single-winner claim)-> dismissed     [tool_args scrubbed to NULL in the SAME UPDATE]
-- draft -(lazy reap on GET thread, expires_at <= now())-> expired [tool_args scrubbed to NULL]
-- There is no code path that files from any status but `draft`, and once `tool_args` is NULL there is
-- no raw argument value left in this row to file even if one tried — the scrub is not merely
-- defensive, it removes the substrate a bug would need.
CREATE TABLE assistant_write_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  thread_id uuid NOT NULL,
  message_id uuid NOT NULL,
  tool_call_id uuid NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users(id),      -- Cerbos ownerId: the CHATTING USER, restated
                                                          -- directly (mirrors 0084's own reasoning) so
                                                          -- the confirm/dismiss authz check never needs
                                                          -- a second join back through the thread.
  agent text NOT NULL,                                   -- the AgentDef name (workflow_id at filing time)
  tool_name text NOT NULL,
  -- The ONLY durable pre-filing home of the REAL (unredacted) args (§7.2.4, step 2 of the custody
  -- chain). NULL from the moment this row leaves 'draft', in every direction (filed/dismissed/expired)
  -- — never merely "not selected", genuinely absent from the row.
  tool_args jsonb,
  impact text NOT NULL,                                  -- ALREADY the wire label (toWireImpact's
                                                          -- output, T1/T2b) — never re-derived here.
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','filed','dismissed','expired')),
  approval_id uuid,                                      -- set once, atomically with status->'filed';
                                                          -- no FK, see header.
  expires_at timestamptz NOT NULL,                        -- created_at + ASSISTANT_INTENT_TTL_MS
                                                          -- (default 1h, config-driven) — the raw-args
                                                          -- retention bound; correctness (can this
                                                          -- write still legally happen) is re-checked
                                                          -- at EXECUTION time by the registry
                                                          -- precondition, never by this column.
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_assistant_write_intents_tool_call UNIQUE (tool_call_id),
  CONSTRAINT fk_assistant_write_intents_tool_call_tenant
    FOREIGN KEY (tool_call_id, tenant_id) REFERENCES assistant_tool_calls (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX ix_assistant_write_intents_thread ON assistant_write_intents (thread_id, created_at DESC);
-- Backs the lazy-reap sweep in GET thread (`WHERE thread_id = $1 AND status = 'draft' AND
-- expires_at <= now()`), and the general "is this thread carrying any live drafts" question.
CREATE INDEX ix_assistant_write_intents_draft_expiry ON assistant_write_intents (thread_id, expires_at) WHERE status = 'draft';

COMMENT ON TABLE assistant_write_intents IS
  'T3b (§7.2 of the 2026-08-06 ASST-23 unblock design DELTA): an unconfirmed assistant write '
  'proposal, held outside automation_approvals until the owner explicitly confirms it via '
  'POST …/tool-calls/:callId/confirm. tool_args is the ONE durable pre-filing home of the REAL '
  '(unredacted) args — NULL from the moment status leaves ''draft'' in every direction. '
  'owner_user_id is the CHATTING USER; confirming files with requestedBy = this same user, never '
  'the approver — see core/approval-filing.ts''s fileAutomationApproval().';

ALTER TABLE assistant_write_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_write_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON assistant_write_intents FOR ALL
  USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('assistant'))
  WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('assistant'));
