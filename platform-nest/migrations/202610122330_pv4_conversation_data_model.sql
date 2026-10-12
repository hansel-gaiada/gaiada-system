-- 202610122330_pv4_conversation_data_model.sql — PV-4 / PV4-01: the data model for client Conversation,
-- price-changing change requests (amendments) and shareable meeting minutes.
-- Plan: docs/plans/2026-10-12-pv4-conversation-tickets.md (PV4-01; findings 3, 7, 8; decisions 3, 4, 8).
--
-- WHAT THIS ADDS
--   New tables : conversation_threads, conversation_messages, conversation_drafts,
--                conversation_reads, meeting_minutes.
--   New columns: contracts            (kind, amends_id, change_request_id)
--                webdev_change_requests (price_impact, amendment_contract_id, source_message_id)
--   New uniques: projects (id, client_id, tenant_id), meeting_recordings (id, tenant_id),
--                webdev_change_requests (id, tenant_id), and one per new table that is FK-targeted.
--
-- ── DECISION 1: "a thread's project belongs to the thread's client" = a COMPOSITE FK, not a trigger ──
-- conversation_threads (project_id, client_id, tenant_id) REFERENCES projects (id, client_id, tenant_id).
-- The referenced unique is new: ux_projects_id_client_tenant. It is trivially unique (id is the PK).
--   * Why not a trigger: a declarative FK is checked by the engine for every writer (app, backfill,
--     psql) and cannot be skipped by DISABLE TRIGGER / session_replication_role = replica the way a
--     trigger can, and it also protects the OTHER direction (below), which a trigger on the thread
--     table cannot.
--   * project_id NULL = the client-wide thread. The FK is MATCH SIMPLE, so a NULL project_id skips the
--     check entirely, which is exactly right. The plain (client_id, tenant_id) -> clients FK covers
--     that case.
--   * An INTERNAL project (projects.client_id IS NULL) cannot be given a thread: the thread's
--     client_id is NOT NULL and a NULL client_id in projects never equals it, so no parent row matches.
--   * WHAT HAPPENS WHEN A PROJECT'S client_id IS LATER CHANGED: the FK is left at its default
--     ON UPDATE NO ACTION, so `UPDATE projects SET client_id = ...` is REFUSED (23503) while ANY thread
--     (soft-deleted ones included, they still carry the row) references the project. That is the
--     intended behaviour, not an accident: moving a project to another client while its thread
--     history stays put would show the OLD client's conversation to the NEW client. Re-homing a
--     project that has threads is therefore a deliberate act: hard-delete or re-point the threads
--     first (an operator task; no route does it). ON UPDATE CASCADE was rejected on purpose: it would
--     silently move the whole conversation, messages included, to the other client.
--   * ON DELETE: NO ACTION too (projects are soft-deleted; a hard delete of a project with threads
--     should fail, not erase a client-facing record).
--
-- ── DECISION 2: the contracts <-> webdev_change_requests cycle ──────────────────────────────────────
-- contracts.change_request_id -> webdev_change_requests and webdev_change_requests.amendment_contract_id
-- -> contracts reference each other. Both columns are added with ADD COLUMN (nullable, no inline REFERENCES)
-- and the two composite FKs are added afterwards with ALTER TABLE, so creation order is never a problem.
-- BOTH FKs are DEFERRABLE INITIALLY DEFERRED, so a single transaction can insert the amendment and the
-- change request that points at it (or the reverse) in either order; the pair is checked at COMMIT.
-- A pair where only one half exists still fails at COMMIT, so deferral does not weaken integrity.
--
-- ── RLS (all five new tables): CORE plain tenant wall, deliberately NOT app_module_allowed() ───────
-- conversation_threads / conversation_messages / conversation_reads / meeting_minutes are
-- CLIENT-REACHABLE (the portal reads and writes them, scoped by portal-scope.ts / portal-visibility.ts,
-- never by a module guard), so the 0072:214 / 0075:242 / 202609281655 doctrine applies: a client-reachable
-- table is never module-walled, or a client's read silently returns ZERO ROWS when the agency has the
-- module off. conversation_drafts is STAFF-ONLY BY TABLE: it has the same tenant wall (RLS cannot tell
-- staff from client), and the staff-only guarantee is that no portal route ever reads it (design
-- decision 3). Each new table has the `tenant_isolation` FOR ALL policy, ENABLE + FORCE, NULLIF-hardened
-- per 0025. An unset GUC therefore reads ZERO rows with no error (migration-backfill-rls-trap) and the
-- DB test asserts that on purpose.
--
-- NO DML in this file: nothing to backfill, so the NOBYPASSRLS backfill-silence trap does not apply.
-- Existing contracts take kind = 'agreement' and existing change requests take price_impact =
-- 'unassessed' from constant column DEFAULTs (metadata-only on PG11+, no table rewrite).
--
-- ── ROLLOUT ─────────────────────────────────────────────────────────────────────────────────────
-- Purely additive; safe to deploy before any code that uses it. Brief ACCESS EXCLUSIVE locks while the
-- three new UNIQUE constraints build on projects / meeting_recordings / webdev_change_requests (small
-- tables). Rollback (only before any PV4-03+ code writes): DROP the five tables, then DROP the six
-- columns and the three unique constraints; no existing row changes.
--
-- ── GRANTS (security-relevant: stated for review; this adds NO widening of any existing grant) ─────
-- The runtime role `platform_app` already receives SELECT/INSERT/UPDATE/DELETE on every owner-created
-- table from infra/db/init-cluster.sh's ALTER DEFAULT PRIVILEGES; the guarded GRANT below restates it so
-- the table is correct even where the default privilege was not set. `sync_app` gets NOTHING on these
-- tables (the hard platform<->sync boundary): the guarded REVOKE is a belt over a no-op. Both are
-- guarded on the role existing (dev/test have a single shared role; see migrate.ts RUNTIME_GRANTS_SQL).

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 0 · The composite uniques the new composite FKs target (0075 §0 pattern)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- Trivially unique (id is each table's PK), so additive and cannot fail on live data.
ALTER TABLE projects
  ADD CONSTRAINT ux_projects_id_client_tenant UNIQUE (id, client_id, tenant_id);
ALTER TABLE meeting_recordings
  ADD CONSTRAINT ux_meeting_recordings_id_tenant UNIQUE (id, tenant_id);
ALTER TABLE webdev_change_requests
  ADD CONSTRAINT ux_wcr_id_tenant UNIQUE (id, tenant_id);

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 1 · conversation_threads — one per (client, project) pair, plus one client-wide thread per client
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE conversation_threads (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES companies(id),
  client_id       uuid NOT NULL,
  -- NULL = the client-wide ("general") thread (PV-D22).
  project_id      uuid,
  subject         text,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_by      uuid NOT NULL REFERENCES users(id),
  created_side    text NOT NULL CHECK (created_side IN ('client', 'staff')),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  origin_site     text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CONSTRAINT fk_conv_threads_client_tenant FOREIGN KEY (client_id, tenant_id)
    REFERENCES clients (id, tenant_id),
  -- Decision 1 (header): the project must belong to THIS client, in THIS tenant.
  CONSTRAINT fk_conv_threads_project_client_tenant FOREIGN KEY (project_id, client_id, tenant_id)
    REFERENCES projects (id, client_id, tenant_id),
  -- FK target for messages / drafts / reads.
  CONSTRAINT ux_conv_threads_id_tenant UNIQUE (id, tenant_id)
);
-- The thread list: newest activity first, per client.
CREATE INDEX ix_conv_threads_client_recent
  ON conversation_threads (tenant_id, client_id, last_message_at DESC) WHERE deleted_at IS NULL;
-- The per-project thread list and the project page.
CREATE INDEX ix_conv_threads_project
  ON conversation_threads (tenant_id, project_id) WHERE project_id IS NOT NULL AND deleted_at IS NULL;
-- PV-D22: at most ONE live client-wide thread per client. Trap: NULL defeats UNIQUE, so a plain
-- UNIQUE (tenant_id, client_id, project_id) would constrain nothing for the client-wide case. A PARTIAL
-- unique over the project_id IS NULL set is the house pattern (0072:73-79 / 0075:148-153).
CREATE UNIQUE INDEX ux_conv_threads_client_wide
  ON conversation_threads (tenant_id, client_id) WHERE project_id IS NULL AND deleted_at IS NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 2 · conversation_messages — every row is client-visible by definition (§2.4): NO visibility column
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE conversation_messages (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES companies(id),
  thread_id    uuid NOT NULL,
  author_id    uuid NOT NULL REFERENCES users(id),
  -- Set by the server from the principal, never from the request body.
  author_side  text NOT NULL CHECK (author_side IN ('client', 'staff')),
  body         text NOT NULL,
  -- The agent user whose draft this message was sent from (decision 4: the AUTHOR is the staff member
  -- who sent it; this column only records provenance).
  drafted_by   uuid REFERENCES users(id),
  edited_at    timestamptz,
  retracted_at timestamptz,
  origin_site  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conv_messages_body_length CHECK (char_length(body) BETWEEN 1 AND 10000),
  CONSTRAINT fk_conv_messages_thread_tenant FOREIGN KEY (thread_id, tenant_id)
    REFERENCES conversation_threads (id, tenant_id),
  -- FK target for webdev_change_requests.source_message_id and conversation_drafts.sent_message_id.
  CONSTRAINT ux_conv_messages_id_tenant UNIQUE (id, tenant_id)
);
CREATE INDEX ix_conv_messages_thread ON conversation_messages (thread_id, created_at);

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 3 · conversation_drafts — agent drafts; STAFF-ONLY BY TABLE (decision 3). No portal route reads this.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE conversation_drafts (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES companies(id),
  thread_id       uuid NOT NULL,
  body            text NOT NULL,
  drafted_by      uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'discarded')),
  decided_by      uuid REFERENCES users(id),
  decided_at      timestamptz,
  sent_message_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conv_drafts_body_length CHECK (char_length(body) BETWEEN 1 AND 10000),
  -- A draft is 'sent' exactly when it points at the message it became; a pending or discarded draft
  -- never does. A decided draft records who and when.
  CONSTRAINT conv_drafts_sent_has_message CHECK ((status = 'sent') = (sent_message_id IS NOT NULL)),
  CONSTRAINT conv_drafts_decided_has_actor CHECK (
    (status = 'pending' AND decided_by IS NULL AND decided_at IS NULL)
    OR (status <> 'pending' AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
  ),
  CONSTRAINT ux_conv_drafts_idempotency UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT fk_conv_drafts_thread_tenant FOREIGN KEY (thread_id, tenant_id)
    REFERENCES conversation_threads (id, tenant_id),
  CONSTRAINT fk_conv_drafts_message_tenant FOREIGN KEY (sent_message_id, tenant_id)
    REFERENCES conversation_messages (id, tenant_id)
);
-- The staff "waiting drafts" read. Partial: only pending drafts are ever listed.
CREATE INDEX ix_conv_drafts_pending ON conversation_drafts (thread_id, created_at) WHERE status = 'pending';
-- One draft becomes at most one message.
CREATE UNIQUE INDEX ux_conv_drafts_sent_message ON conversation_drafts (sent_message_id) WHERE sent_message_id IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 4 · conversation_reads — per-user read marker (unread counts)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE conversation_reads (
  tenant_id    uuid NOT NULL REFERENCES companies(id),
  thread_id    uuid NOT NULL,
  user_id      uuid NOT NULL REFERENCES users(id),
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, user_id),
  CONSTRAINT fk_conv_reads_thread_tenant FOREIGN KEY (thread_id, tenant_id)
    REFERENCES conversation_threads (id, tenant_id)
);
-- "All my read markers" for the unread-count join.
CREATE INDEX ix_conv_reads_user ON conversation_reads (tenant_id, user_id);

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 5 · meeting_minutes — shareable notes for a meeting (decision 8: NO client_id/project_id copy)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- The client and project are read THROUGH meeting_recordings, so a re-linked meeting never leaves a
-- stale copy here. `meeting` stays NEVER_CLIENT_VISIBLE; only these minutes, once `shared`, can reach
-- the portal (PV4-05 owns the predicate).
CREATE TABLE meeting_minutes (
  id                   uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL REFERENCES companies(id),
  meeting_recording_id uuid NOT NULL,
  body_md              text NOT NULL DEFAULT '',
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'shared')),
  -- Set when an agent wrote the draft; the human who shares it is `shared_by`.
  drafted_by           uuid REFERENCES users(id),
  updated_by           uuid REFERENCES users(id),
  shared_at            timestamptz,
  shared_by            uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- Shared means someone shared it, and said when; a draft carries neither.
  CONSTRAINT meeting_minutes_share_stamp CHECK (
    (status = 'shared' AND shared_at IS NOT NULL AND shared_by IS NOT NULL)
    OR (status = 'draft' AND shared_at IS NULL AND shared_by IS NULL)
  ),
  -- One minutes row per meeting; also the join key for the portal read.
  CONSTRAINT ux_meeting_minutes_recording UNIQUE (meeting_recording_id),
  CONSTRAINT fk_meeting_minutes_recording_tenant FOREIGN KEY (meeting_recording_id, tenant_id)
    REFERENCES meeting_recordings (id, tenant_id)
);
CREATE INDEX ix_meeting_minutes_shared ON meeting_minutes (tenant_id) WHERE status = 'shared';

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 6 · contracts — amendments (finding 7)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE contracts
  ADD COLUMN kind              text NOT NULL DEFAULT 'agreement',
  ADD COLUMN amends_id         uuid,
  ADD COLUMN change_request_id uuid;
ALTER TABLE contracts
  ADD CONSTRAINT contracts_kind_check CHECK (kind IN ('agreement', 'amendment')),
  -- An amendment names what it amends; it cannot amend itself. (An agreement may carry no amends_id.)
  ADD CONSTRAINT contracts_amendment_amends CHECK (kind <> 'amendment' OR amends_id IS NOT NULL),
  ADD CONSTRAINT contracts_not_self_amending CHECK (amends_id IS NULL OR amends_id <> id),
  -- Tenant-scoped self FK (same treatment as supersedes_id, 0075).
  ADD CONSTRAINT fk_contracts_amends_tenant FOREIGN KEY (amends_id, tenant_id)
    REFERENCES contracts (id, tenant_id);
-- Decision 2 (header): half of the cycle; DEFERRABLE so the pair can be inserted in one transaction.
ALTER TABLE contracts
  ADD CONSTRAINT fk_contracts_change_request_tenant FOREIGN KEY (change_request_id, tenant_id)
    REFERENCES webdev_change_requests (id, tenant_id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX ix_contracts_amends ON contracts (tenant_id, amends_id) WHERE amends_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX ix_contracts_change_request ON contracts (tenant_id, change_request_id) WHERE change_request_id IS NOT NULL AND deleted_at IS NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 7 · webdev_change_requests — price impact and the amendment it waits on (finding 7)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE webdev_change_requests
  ADD COLUMN price_impact          text NOT NULL DEFAULT 'unassessed',
  ADD COLUMN amendment_contract_id uuid,
  ADD COLUMN source_message_id     uuid;
ALTER TABLE webdev_change_requests
  ADD CONSTRAINT wcr_price_impact_check CHECK (price_impact IN ('unassessed', 'none', 'changes_price')),
  -- The other half of the cycle (decision 2).
  ADD CONSTRAINT fk_wcr_amendment_contract_tenant FOREIGN KEY (amendment_contract_id, tenant_id)
    REFERENCES contracts (id, tenant_id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT fk_wcr_source_message_tenant FOREIGN KEY (source_message_id, tenant_id)
    REFERENCES conversation_messages (id, tenant_id);
CREATE INDEX ix_wcr_amendment ON webdev_change_requests (tenant_id, amendment_contract_id)
  WHERE amendment_contract_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX ix_wcr_source_message ON webdev_change_requests (tenant_id, source_message_id)
  WHERE source_message_id IS NOT NULL AND deleted_at IS NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 8 · RLS + grants for the five new tables
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['conversation_threads', 'conversation_messages', 'conversation_drafts',
                           'conversation_reads', 'meeting_minutes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I FOR ALL
        USING (tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]))
        WITH CHECK (tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]))
    $f$, t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO platform_app', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sync_app') THEN
      EXECUTE format('REVOKE ALL ON %I FROM sync_app', t);
    END IF;
  END LOOP;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 9 · Self-assertion: a migration that cannot prove its own shape fails loudly instead of shipping
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  t text;
  c text;
  i text;
BEGIN
  -- 9a · every new table exists, has RLS enabled AND forced, and the tenant_isolation policy.
  FOREACH t IN ARRAY ARRAY['conversation_threads', 'conversation_messages', 'conversation_drafts',
                           'conversation_reads', 'meeting_minutes'] LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE EXCEPTION 'PV4-01: table % was not created', t;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = format('public.%I', t)::regclass
                   AND relrowsecurity AND relforcerowsecurity) THEN
      RAISE EXCEPTION 'PV4-01: RLS is not ENABLED+FORCED on %', t;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t
                   AND policyname = 'tenant_isolation') THEN
      RAISE EXCEPTION 'PV4-01: tenant_isolation policy missing on %', t;
    END IF;
  END LOOP;

  -- 9b · the CHECK constraints this ticket promised.
  FOREACH c IN ARRAY ARRAY['conv_messages_body_length', 'conv_drafts_body_length', 'conv_drafts_sent_has_message',
                           'conv_drafts_decided_has_actor', 'meeting_minutes_share_stamp', 'contracts_kind_check',
                           'contracts_amendment_amends', 'contracts_not_self_amending', 'wcr_price_impact_check'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c AND contype = 'c') THEN
      RAISE EXCEPTION 'PV4-01: CHECK % is missing', c;
    END IF;
  END LOOP;

  -- 9c · the FKs that carry a guarantee, and that the cycle's two halves are DEFERRABLE.
  FOREACH c IN ARRAY ARRAY['fk_conv_threads_client_tenant', 'fk_conv_threads_project_client_tenant',
                           'fk_conv_messages_thread_tenant', 'fk_conv_drafts_thread_tenant', 'fk_conv_reads_thread_tenant',
                           'fk_meeting_minutes_recording_tenant', 'fk_contracts_amends_tenant',
                           'fk_wcr_source_message_tenant'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c AND contype = 'f') THEN
      RAISE EXCEPTION 'PV4-01: FK % is missing', c;
    END IF;
  END LOOP;
  FOREACH c IN ARRAY ARRAY['fk_contracts_change_request_tenant', 'fk_wcr_amendment_contract_tenant'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c AND contype = 'f'
                   AND condeferrable AND condeferred) THEN
      RAISE EXCEPTION 'PV4-01: FK % is missing or not DEFERRABLE INITIALLY DEFERRED', c;
    END IF;
  END LOOP;

  -- 9d · the indexes the guarantees and the hot reads rest on. The partial unique is the PV-D22 net.
  FOREACH i IN ARRAY ARRAY['ux_conv_threads_client_wide', 'ix_conv_threads_client_recent', 'ix_conv_messages_thread',
                           'ux_conv_drafts_sent_message', 'ux_conv_drafts_idempotency'] LOOP
    IF to_regclass(format('public.%I', i)) IS NULL THEN
      RAISE EXCEPTION 'PV4-01: index % is missing', i;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'ux_conv_threads_client_wide'
                 AND indexdef LIKE 'CREATE UNIQUE INDEX%' AND indexdef LIKE '%project_id IS NULL%') THEN
    RAISE EXCEPTION 'PV4-01: ux_conv_threads_client_wide is not a partial UNIQUE over project_id IS NULL';
  END IF;

  -- 9e · the new columns, with the defaults existing rows rely on.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'contracts'
                 AND column_name = 'kind' AND column_default LIKE '''agreement''%') THEN
    RAISE EXCEPTION 'PV4-01: contracts.kind default is not agreement';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'webdev_change_requests'
                 AND column_name = 'price_impact' AND column_default LIKE '''unassessed''%') THEN
    RAISE EXCEPTION 'PV4-01: webdev_change_requests.price_impact default is not unassessed';
  END IF;
END $$;

COMMENT ON TABLE conversation_threads IS
  'PV-4 client Conversation threads. project_id NULL = the one live client-wide thread per client (ux_conv_threads_client_wide). The project must belong to the client (composite FK); changing projects.client_id is refused while threads reference it.';
COMMENT ON TABLE conversation_messages IS
  'PV-4 thread messages. Every row is client-visible by definition (no visibility column). author_side is set by the server; drafted_by records the agent whose draft this was sent from.';
COMMENT ON TABLE conversation_drafts IS
  'PV-4 agent reply drafts. STAFF-ONLY BY TABLE: no portal route may read this. Sending a draft creates a conversation_messages row authored by the sending staff member.';
COMMENT ON TABLE meeting_minutes IS
  'PV-4 shareable meeting minutes. Client and project are read through meeting_recordings, never copied. Only status = shared rows may reach the portal; the recording and transcript stay internal.';
