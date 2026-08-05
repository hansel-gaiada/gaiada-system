-- ASST-01 — the tenancy foundation for the ERP assistant: threads / messages / tool_calls / memory.
--
-- Ticket: docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md ("### ASST-01").
-- Data model + rationale: docs/blueprints/assistant-foundation.md §4 (why this can't be
-- localStorage the way the aivory reference implementation does it: threads need RLS, `eraseTenant`
-- reach, audit, and multi-device continuity) and §6 (authorization — threads are owner-private,
-- tools run as the chatting user, never a service principal).
--
-- ── NUMBERING (rule 5, migrations/README.md) ──────────────────────────────────────────────────────
-- Re-verified at authoring time, not inherited from the plan doc: `ls migrations | sort | tail`
-- showed the real head as `0078_automation_approval_execution.sql` (D14-01, landed), so this takes
-- **0079**, exactly as the plan's own wave-serialization predicted (D14-01 first, assistant second).
-- `0058`, `0059`, `0070` remain permanently-orphaned reservation gaps from other programs — not
-- touched, not filled.
--
-- ── THE TWO-SIDED MODULE WALL (constraint 2, WD-23A-1 lesson) ────────────────────────────────────
-- Every assistant_* table gets BOTH RLS walls composed into ONE `tenant_isolation` policy, mirroring
-- 0028's hr_* pattern byte-for-byte:
--   tenant_id = ANY(app_current_tenants())   -- wall 1: which tenant (the authorized-tenant-set)
--   AND app_module_allowed('assistant')      -- wall 2: did THIS REQUEST declare the assistant scope
-- `app_module_allowed` was defined once in 0028 (CREATE OR REPLACE, GRANT EXECUTE TO PUBLIC) and is
-- NOT redefined here — this migration only composes it into four new policies with mod='assistant'.
-- The handshake is real, not decorative: a request with the correct tenant but NO `app.scopes`
-- GUC entry for 'assistant' (i.e. `withTenants([t], fn)` without `{modules:['assistant']}`) reads
-- ZERO rows from every table below, proven by src/db/module-assistant-rls.test.ts.
--
-- ── COMPOSITE TENANT-SCOPED FKs (constraint 3) — applied where the referenced parent is a
--    TENANT-SCOPED CHILD table, per the 0027/0056/0067/0068/0075 convention ────────────────────────
-- `assistant_messages.thread_id` and `assistant_tool_calls.message_id` get the composite form
-- `(child_fk, tenant_id) REFERENCES parent (id, tenant_id)` — a plain FK would let a row carry
-- tenant A's tenant_id while its parent pointer resolves into tenant B, invisible to any RLS-scoped
-- SELECT. Both parents (`assistant_threads`, `assistant_messages`) are brand-new in THIS migration,
-- so their `UNIQUE (id, tenant_id)` is declared directly in the CREATE TABLE (no retrofit ALTER
-- needed, unlike 0075's ALTER on the pre-existing `files`/`clients`/`projects`/`invoices`).
--
-- ── `assistant_memory.source_thread_id` IS COMPOSITE **AND** SET NULL (PG 15+ column list) ────────
-- Constraint 4 requires `ON DELETE SET NULL` here. The naive composite form
-- `(source_thread_id, tenant_id) REFERENCES assistant_threads (id, tenant_id) ON DELETE SET NULL`
-- would indeed null EVERY local FK column including this row's own `tenant_id`, which is NOT NULL —
-- aborting the transaction on any thread delete. That is why the first draft of this migration used a
-- plain FK and documented composite+SET-NULL as "structurally impossible".
--
-- It is not impossible: **PostgreSQL 15 added `ON DELETE SET NULL (column_list)`**, which restricts
-- the nulling to the named columns. Verified against THIS server before making the change —
-- `SELECT version()` reports PostgreSQL 17.10, and the two-table probe below compiles:
--   FOREIGN KEY (src, tenant_id) REFERENCES parent (id, tenant_id) ON DELETE SET NULL (src)
-- So the composite form is used, and only `source_thread_id` is nulled.
--
-- Keeping it composite is not pedantry: a plain FK lets a memory row carry tenant A's `tenant_id`
-- while `source_thread_id` resolves into tenant B — a cross-tenant reference no RLS-scoped SELECT can
-- see, because RLS filters by the row's own tenant column, not by where its pointers land. RLS and
-- the app's in-tenant stamping are real defences, but they are the same argument that has left this
-- schema MIXED on composite FKs; this migration does not add to that.
--
-- Cascades that delete the whole child row (messages, tool_calls) never had this problem — CASCADE
-- removes tenant_id along with everything else — so they use the plain composite form.
--
-- ── CASCADES (constraint 4) ───────────────────────────────────────────────────────────────────────
--   assistant_threads --CASCADE--> assistant_messages --CASCADE--> assistant_tool_calls
--   assistant_memory.source_thread_id --SET NULL (composite, column-list)--> (row survives)
-- Deleting a thread therefore leaves nothing orphaned in messages/tool_calls, and a memory row that
-- happened to cite a since-deleted thread survives with its provenance link cleared, not deleted —
-- the durable fact is more valuable than the pointer to where it came from.
--
-- ── UNIQUE (thread_id, seq) HAS NO NULLABLE COLUMN (constraint 5) ─────────────────────────────────
-- Both `thread_id` and `seq` are NOT NULL. This is the exact trap that let 10 duplicate `manager`
-- role rows through a `UNIQUE (company_id, name)` with a nullable `company_id` (SQL NULLs are
-- pairwise distinct, so a NULL column silently defeats both the constraint and ON CONFLICT) — avoided
-- here by construction, not by discipline.
--
-- ── ZERO BACKFILL DML (constraint 6) ──────────────────────────────────────────────────────────────
-- Every table below is CREATE TABLE'd fresh in this file. There is no ALTER-with-default, no
-- UPDATE, no DELETE-with-a-row-set, no INSERT ... SELECT anywhere in this migration — nothing whose
-- effect depends on which rows the migration runner (platform_owner, NOBYPASSRLS) can see under RLS.
-- `npm run lint:migration-rls` has nothing to flag here by construction.
--
-- ── ERASURE REACH (constraint 7, OQ-1 hard-delete default) ────────────────────────────────────────
-- No `deleted_at` / soft-delete column on any of the four tables, unlike most of the estate's
-- tenant-scoped tables. That is deliberate, not an oversight: OQ-1's default is a real hard DELETE
-- for the assistant surface, and a soft-delete flag here would let a "deleted" thread's messages and
-- tool-call transcripts (assistant history, potentially containing tool args / PII) linger
-- indefinitely in storage while merely being hidden from the UI — the wrong shape for an erasure
-- guarantee. `eraseTenant`'s reach for these four tables is therefore a real `DELETE FROM
-- assistant_threads WHERE tenant_id = ...` (cascading to messages/tool_calls) plus
-- `DELETE FROM assistant_memory WHERE tenant_id = ...` — nothing is left for a future undelete to
-- resurrect. Verified by src/db/module-assistant-rls.test.ts's cascade test.
--
-- ── ATTACHMENTS (explicitly out of scope here) ────────────────────────────────────────────────────
-- No new attachment table. Per the ticket and blueprint §4, attachments reuse the EXISTING
-- `files` reference-attach mechanism (0009/0022: `target_entity_type`/`target_entity_id`,
-- nullable `storage_key`, optional `url`) — a future ticket (ASST-05/06) will have the assistant
-- module write `files` rows with `target_entity_type='assistant_message'`. Nothing for this
-- migration to add.
--
-- ── `assistant_tool_calls.approval_id` HAS NO FK, ON PURPOSE ──────────────────────────────────────
-- Mirrors `hr_leave_requests.approval_id` (0028) exactly: a bare `uuid` column pointing at an
-- `automation_approvals` row, commented, no REFERENCES. `automation_approvals` carries no
-- `UNIQUE (id, tenant_id)` today (0078 did not add one), so a composite FK is not available without
-- a separate retrofit migration touching a live, unrelated table — out of scope for a new-tables-only
-- ticket. The approvals inbox is not an access-control gate for reading a tool_call row (tenant RLS
-- already is); this column is audit/cross-reference only.

-- ══ (1) assistant_threads — the top-level conversation. Owner-private (blueprint §6); a
--        thread's `brain` is stored (provider+model) but NOT routed in Phase 1 (ASST-06 note).
CREATE TABLE assistant_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),          -- Cerbos ownerId attribute (§6)
  title text,
  brain_provider text,                                        -- e.g. 'ollama' | 'claude' | 'hermes'
  brain_model text,
  hermes_session_id text,                                     -- Hermes' own session/resume token
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  pinned boolean NOT NULL DEFAULT false,
  last_message_at timestamptz,
  total_tokens bigint NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),      -- rolling counters
  total_cost_usd numeric(12,6) NOT NULL DEFAULT 0 CHECK (total_cost_usd >= 0),
  compaction_summary text,                                    -- v1 compaction: summarized prefix
  compaction_summary_upto_seq int,                             -- last message seq folded into it
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_assistant_threads_id_tenant UNIQUE (id, tenant_id)
);
CREATE INDEX ix_assistant_threads_list ON assistant_threads (tenant_id, owner_user_id, pinned DESC, last_message_at DESC);

COMMENT ON TABLE assistant_threads IS
  'ASST-01: one ERP-assistant conversation. Owner-private (blueprint §6) — no company_admin/'
  'group_executive/superadmin read rule, by design (Cerbos policy resource_assistant_thread, '
  'ASST-02). brain_provider/brain_model are stored but not routed until Phase 2.';

-- ══ (2) assistant_messages — the transcript. seq is the append-only ordering within a thread.
CREATE TABLE assistant_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  thread_id uuid NOT NULL,
  seq int NOT NULL CHECK (seq > 0),
  role text NOT NULL CHECK (role IN ('user','assistant','tool','system')),
  content text,                                               -- rendered/plain text
  parts jsonb NOT NULL DEFAULT '[]',                          -- structured parts (markdown/code/tool refs)
  provider text,
  model text,
  tokens int CHECK (tokens >= 0),
  latency_ms int CHECK (latency_ms >= 0),
  error_kind text,                                            -- set on an abnormal stream end
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_assistant_messages_id_tenant UNIQUE (id, tenant_id),
  -- No nullable column in this key (constraint 5) — thread_id and seq are both NOT NULL above.
  CONSTRAINT ux_assistant_messages_thread_seq UNIQUE (thread_id, seq),
  CONSTRAINT fk_assistant_messages_thread_tenant
    FOREIGN KEY (thread_id, tenant_id) REFERENCES assistant_threads (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX ix_assistant_messages_thread ON assistant_messages (thread_id, seq);

COMMENT ON TABLE assistant_messages IS
  'ASST-01: one message in an assistant thread. UNIQUE (thread_id, seq) is the append-only ordering '
  'guard; ON DELETE CASCADE from assistant_threads (composite FK, tenant-checked).';

-- ══ (3) assistant_tool_calls — one MCP tool invocation made inside an assistant message.
--        Authority is always the CHATTING USER (blueprint §6) — never a service principal.
CREATE TABLE assistant_tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  message_id uuid NOT NULL,
  tool_name text NOT NULL,
  mcp_server text,
  args jsonb NOT NULL DEFAULT '{}',                           -- REDACTED before persist (app layer)
  result_summary text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','succeeded','failed','denied')),
  authority_user_id uuid NOT NULL REFERENCES users(id),       -- the Cerbos principal the call ran as
  approval_id uuid,                                           -- automation_approvals row; NO FK, see header
  duration_ms int CHECK (duration_ms >= 0),
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_assistant_tool_calls_id_tenant UNIQUE (id, tenant_id),
  CONSTRAINT fk_assistant_tool_calls_message_tenant
    FOREIGN KEY (message_id, tenant_id) REFERENCES assistant_messages (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX ix_assistant_tool_calls_message ON assistant_tool_calls (message_id);

COMMENT ON TABLE assistant_tool_calls IS
  'ASST-01: one MCP tool call made from an assistant message. authority_user_id is always the '
  'chatting user (blueprint §6) — tools never run as a service/automation principal here. '
  'ON DELETE CASCADE from assistant_messages (composite FK, tenant-checked).';

-- ══ (4) assistant_memory — durable user/company facts & preferences (the second of the "four
--        memories", blueprint §4.1). Writes are PROPOSALS: unconfirmed rows are recorded but never
--        fed as fact (trust='untrusted' until confirmed_at is set) — the same quarantine discipline
--        as the episodic HumanFeedback trust rule (ai-agents/src/memory/episodic.ts).
CREATE TABLE assistant_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),           -- Cerbos ownerId; owner-only (ASST-02)
  scope text NOT NULL DEFAULT 'user' CHECK (scope IN ('user','company')),
  content text NOT NULL,
  provenance text NOT NULL DEFAULT 'user' CHECK (provenance IN ('user','assistant')),
  trust text NOT NULL DEFAULT 'untrusted' CHECK (trust IN ('trusted','untrusted')),
  -- Plain FK, deliberately not composite — see the header rationale (composite + SET NULL would
  -- null out this table's own NOT NULL tenant_id).
  source_thread_id uuid,
  pinned boolean NOT NULL DEFAULT false,
  confirmed_at timestamptz,                                   -- set when trust flips to 'trusted'
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- COMPOSITE tenant-scoped FK *with* SET NULL, using Postgres 15+'s column-list form so ONLY
  -- `source_thread_id` is nulled and this row's own NOT NULL `tenant_id` is left alone. The earlier
  -- draft of this migration used a plain FK, on the belief that a composite FK and a same-column-only
  -- SET NULL were structurally incompatible; that is true on PG <15 but NOT here — the server is
  -- PostgreSQL 17.10 and `ON DELETE SET NULL (col)` was verified against it before this change.
  -- Keeping the composite form matters: a plain FK would let a memory row carry tenant A's tenant_id
  -- while `source_thread_id` resolves into tenant B, which no RLS-scoped SELECT can see.
  FOREIGN KEY (source_thread_id, tenant_id)
    REFERENCES assistant_threads (id, tenant_id) ON DELETE SET NULL (source_thread_id)
);
CREATE INDEX ix_assistant_memory_owner ON assistant_memory (tenant_id, owner_user_id, pinned DESC);

COMMENT ON TABLE assistant_memory IS
  'ASST-01: durable user/company-scoped assistant memory (blueprint §4.1, memory #2 of 4). '
  '`trust` mirrors the episodic HumanFeedback convention (trusted/untrusted quarantine); '
  '`source_thread_id` is a COMPOSITE tenant-scoped FK with PG15+ ON DELETE SET NULL (source_thread_id) '
  '— see this file''s header. Owner-only access end to end (Cerbos resource_assistant_memory, ASST-02).';

-- ══ FORCE RLS + the ONE composed tenant_isolation policy per assistant_* table — byte-identical
--    shape to 0028's hr_* loop, with mod='assistant'. app_module_allowed() itself is defined once in
--    0028 (CREATE OR REPLACE, GRANT EXECUTE TO PUBLIC) and is only referenced here.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'assistant_threads','assistant_messages','assistant_tool_calls','assistant_memory'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''assistant''))
         WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''assistant''))',
      t
    );
  END LOOP;
END $$;
