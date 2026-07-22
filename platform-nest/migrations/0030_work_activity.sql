-- P1-04 (Web-Dev Phase 1) — the work-activity/evidence CORE model (not a gated module; every
-- module's real-work signal lands here so "what did we actually do for this client" can be answered
-- without per-module bespoke reporting). Two tables + a read view:
--
--   work_activity        — one row per real-world unit of work, normalized across sources (pm task
--                           moves, pipeline stage advances, github commits/PRs, google_drive file
--                           edits, claude/agent actions, manual entries, system-generated rows).
--                           `UNIQUE(tenant_id, source, source_ref)` IS the idempotency key: the P1-05
--                           outbox consumer (a SEPARATE ticket, not built here) re-delivers safely by
--                           upserting on this key. This ticket builds the schema + a synchronous
--                           ingest/read API + the pure auto-link engine only — no outbox consumer, no
--                           backfill (see src/core/work-activity-linker.ts header).
--   work_activity_links   — the auto-link engine's output: which pm_task/project/person/department
--                           each activity evidences, with a confidence tier (exact = structured hint,
--                           inferred = uuid-scan or derived-chain) and the rule name that produced it,
--                           for auditability. `UNIQUE(activity_id, target_kind, target_id)` makes
--                           re-linking (e.g. a backfill re-run) idempotent (ON CONFLICT DO NOTHING).
--   deliverable_evidence  — a plain (invoker-rights) VIEW: work_activity rows whose object_kind is
--                           file/doc/deliverable, left-joined to their links. No RLS of its own is
--                           needed — Postgres evaluates a plain view under the querying role, so the
--                           FORCE RLS policies on the two base tables apply exactly as if queried
--                           directly (same mechanism relied on by every other read in this codebase).
--
-- FORCE RLS composed from the app_current_tenants() helper (0025) — the current house idiom for a
-- core (non-module) tenant-scoped table; NOT the raw inline-NULLIF text 0018/0023 used before the
-- helper existed (see migrations/README.md + 0025's header). No app_module_allowed() wall: this is
-- CORE, always-on, not gated behind companies.enabled_modules.
--
-- GitHub/Drive linking rules are Phase-2 slots — the `source` CHECK already accepts 'github' and
-- 'google_drive' rows (so P1-05's consumer can start writing them), but the auto-link engine does
-- not yet implement source-specific rules for them (see the linker file's extension-point comment).

CREATE TABLE work_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  source text NOT NULL CHECK (source IN ('pm','pipeline','github','google_drive','claude','manual','system')),
  source_ref text NOT NULL,              -- the idempotency leg of the UNIQUE key (source's own stable id)
  actor_user_id uuid REFERENCES users(id),   -- the acting platform user, when known
  actor_external text,                       -- external actor identity when NOT a platform user (e.g. a GitHub login)
  verb text NOT NULL,                        -- e.g. 'created','updated','completed','committed','edited'
  object_kind text NOT NULL,                 -- e.g. 'task','project','file','doc','deliverable','commit','pr'
  object_ref text NOT NULL,                  -- the object's id/ref in its own source system
  title text,
  payload jsonb NOT NULL DEFAULT '{}',       -- raw source payload + structured link hints (taskId/projectId/actorId)
  occurred_at timestamptz NOT NULL DEFAULT now(),
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source, source_ref)
);
CREATE INDEX ix_work_activity_tenant_occurred ON work_activity (tenant_id, occurred_at DESC);
CREATE INDEX ix_work_activity_object ON work_activity (tenant_id, object_kind, object_ref);

CREATE TABLE work_activity_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  activity_id uuid NOT NULL REFERENCES work_activity(id) ON DELETE CASCADE,
  target_kind text NOT NULL CHECK (target_kind IN ('pm_task','project','person','department')),
  target_id text NOT NULL,   -- polymorphic: pm_task/project are uuids-as-text, person is a user id,
                              -- department is an org-node id (free text, no FK — org-node ids are not
                              -- a database table, matching projects.department_id's own convention)
  confidence text NOT NULL CHECK (confidence IN ('exact','inferred')),
  rule text NOT NULL,        -- which linker rule produced this (e.g. 'hint:taskId','uuid_scan','derived:task_project')
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (activity_id, target_kind, target_id)
);
CREATE INDEX ix_work_activity_links_target ON work_activity_links (tenant_id, target_kind, target_id);
CREATE INDEX ix_work_activity_links_activity ON work_activity_links (activity_id);

-- FORCE RLS + the standard tenant_isolation policy, composed from the 0025 helper (mirrors 0026/0028).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['work_activity', 'work_activity_links'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = ANY(app_current_tenants()))
         WITH CHECK (tenant_id = ANY(app_current_tenants()))',
      t
    );
  END LOOP;
END $$;

-- deliverable_evidence: file/doc/deliverable activity, left-joined to its auto-links (unlinked
-- evidence still surfaces with link_id/target_kind/target_id/confidence/rule all NULL).
CREATE VIEW deliverable_evidence AS
SELECT
  wa.id AS activity_id,
  wa.tenant_id,
  wa.source,
  wa.source_ref,
  wa.actor_user_id,
  wa.actor_external,
  wa.verb,
  wa.object_kind,
  wa.object_ref,
  wa.title,
  wa.payload,
  wa.occurred_at,
  wa.origin_site,
  wa.created_at,
  l.id AS link_id,
  l.target_kind,
  l.target_id,
  l.confidence,
  l.rule
FROM work_activity wa
LEFT JOIN work_activity_links l ON l.activity_id = wa.id
WHERE wa.object_kind IN ('file', 'doc', 'deliverable');
