-- webdesk/migrations/0008_promotion.sql
-- WSK-25 — Promotion engine (content half). Two additive tables only, both senior-be-proposed and
-- narrowly scoped to what the promotion command surface genuinely needs (per this ticket's own
-- instruction: schema changes here do not improvise beyond that, and do NOT touch any existing
-- table — `content_items`/`collections`/`media_assets` etc. from 0002_content.sql are read and
-- written exactly as they already exist, never altered).
--
-- ============================================================================================
-- WHY THIS SHAPE — read before touching promotion/** on top of this
-- ============================================================================================
-- `content_items`/`collections`/`media_assets` (0002_content.sql) are scoped by (tenant_id,
-- site_id) ONLY — there is no `env_id` column anywhere in the content layer. That is a real,
-- observed property of the frozen schema, not an oversight this migration works around: it means
-- "staging content" and "production content" for the SAME site are not two rows in one Zone B
-- database today. Design D-4 ("tenant-scoped logical export through Payload's Local API -> import
-- on the target") and WSK-25's own AC ("simulated two-env topology: two compose projects, one
-- box") both describe promotion as a CROSS-INSTANCE operation: staging and production are
-- separate Zone B deployments, each with its own full copy of this schema, and a promotion moves
-- a content bundle from one instance's local tables into another instance's local tables. Every
-- table below is therefore local-only (no cross-database FK, because Postgres cannot express one)
-- and every promotion/rollback command in `promotion/**` operates ONLY on the Postgres this API
-- process is itself connected to — the "other environment" is reached by the CALLER (Zone A, per
-- D-13: "no standing cross-env credential") supplying an already-exported bundle in the request
-- body, never by this service holding a connection string to a foreign database.
--
-- `promotion_runs` is a durable, tenant-visible, RLS'd replacement for the pattern WSK-21 flagged
-- as a gap in its own `JobsService` (in-memory, single-process, lost on restart) — a promotion is
-- exactly the kind of operation that must survive an api process restart mid-flight, so this
-- migration gives it a real table instead of reusing that in-memory store.
--
-- `promotion_snapshots` is the rollback mechanism's entire reason to exist: a durable, IMMUTABLE
-- (REVOKE UPDATE/DELETE, same doctrine as audit_entries/content_versions/dsr_requests) capture of
-- a target environment's content **as of immediately before a promotion mutates it**. The
-- snapshot-first property this ticket must prove (durable BEFORE any mutation) is enforced at the
-- application layer (promotion/promotion-snapshot.service.ts commits this row in its OWN
-- transaction, which returns before the migrate/import transaction ever begins) — this migration
-- only provides the durable, tamper-proof place that commit lands.
--
-- Requires 0001_platform_core.sql (tenants, sites, environments, webdesk_tenant_ctx()) and
-- 0002_content.sql (collections, content_items — read/written by promotion/**, not altered here).
-- Runs as webdesk_migrator (no SET ROLE) — same posture as every prior migration in this ledger.
-- ============================================================================================

CREATE TABLE promotion_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  site_id        uuid NOT NULL REFERENCES sites(id),
  -- NULL for a rollback run (there is no "source" — it restores FROM a snapshot, not from a
  -- caller-supplied bundle).
  source_env_id  uuid REFERENCES environments(id),
  target_env_id  uuid NOT NULL REFERENCES environments(id),
  kind           text NOT NULL CHECK (kind IN ('promote', 'rollback')),
  version        text NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN (
                    'pending', 'snapshotted', 'content_promoted', 'content_promoted_frontend_pending',
                    'completed', 'failed', 'rolled_back'
                  )),
  current_step   text,
  -- Dual meaning by `kind`, deliberately one column rather than two (`snapshot_taken_id` /
  -- `snapshot_restored_id`) so "was snapshot X ever consumed" is a single indexed lookup
  -- (`WHERE snapshot_id = X AND kind = 'rollback'`) rather than a write-after-insert on the
  -- (immutable, REVOKE UPDATE) `promotion_snapshots` row itself:
  --   - kind='promote': the snapshot THIS run took of the target env's pre-mutation state
  --     (set once that snapshot commits — see promotion-snapshot.service.ts).
  --   - kind='rollback': the pre-existing snapshot THIS run restored FROM.
  -- FK intentionally added AFTER promotion_snapshots below (circular with that table's own FK to
  -- promotion_runs) via ALTER TABLE.
  snapshot_id    uuid,
  error_detail   jsonb,
  created_by     text NOT NULL,          -- Zone A principal id, opaque — attribution only, same convention as releases.created_by
  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz
);
CREATE INDEX ix_promotion_runs_tenant ON promotion_runs (tenant_id);
CREATE INDEX ix_promotion_runs_target_env ON promotion_runs (target_env_id, created_at DESC);

CREATE TABLE promotion_snapshots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  promotion_run_id   uuid NOT NULL REFERENCES promotion_runs(id),
  -- The environment this snapshot restores (always the PROMOTE run's target — the environment
  -- about to be mutated).
  env_id             uuid NOT NULL REFERENCES environments(id),
  -- Serialized collections + content_items (+ media_assets METADATA ONLY — see
  -- content-bundle.types.ts's header: object bytes are not moved by this ticket, D-13's
  -- presigned-URL bulk media transfer is unbuilt) as of `taken_at`. Canonical JSON — see
  -- content-bundle.service.ts's `canonicalize` for the exact ordering that makes `checksum`
  -- reproducible.
  bundle             jsonb NOT NULL,
  checksum           text NOT NULL,        -- sha256(canonical bundle JSON) — integrity proof, checked on restore
  item_count         integer NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  taken_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_promotion_snapshots_tenant ON promotion_snapshots (tenant_id);
-- The query rollback actually runs: "latest snapshot for this environment".
CREATE INDEX ix_promotion_snapshots_env_taken ON promotion_snapshots (env_id, taken_at DESC);
CREATE INDEX ix_promotion_snapshots_run ON promotion_snapshots (promotion_run_id);

-- promotion_runs.snapshot_id -> promotion_snapshots.id, added after both tables exist (circular
-- with promotion_snapshots.promotion_run_id -> promotion_runs.id above).
ALTER TABLE promotion_runs ADD CONSTRAINT fk_promotion_runs_snapshot
  FOREIGN KEY (snapshot_id) REFERENCES promotion_snapshots(id);

-- Append-only, same reasoning and same mechanism as audit_entries/content_versions/dsr_requests
-- (0001/0002/0007): a rollback point that can be edited or deleted after the fact is not a
-- rollback point. Genuinely pure history this time — unlike an earlier draft of this migration,
-- nothing here ever needs a later UPDATE (see promotion_runs.snapshot_id's own comment for why a
-- "was this snapshot consumed" query never has to write back to THIS table).
REVOKE UPDATE, DELETE ON promotion_snapshots FROM webdesk_app;

ALTER TABLE promotion_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE promotion_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON promotion_runs;
CREATE POLICY tenant_isolation ON promotion_runs FOR ALL
  USING      (tenant_id = webdesk_tenant_ctx())
  WITH CHECK (tenant_id = webdesk_tenant_ctx());

ALTER TABLE promotion_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE promotion_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON promotion_snapshots;
CREATE POLICY tenant_isolation ON promotion_snapshots FOR ALL
  USING      (tenant_id = webdesk_tenant_ctx())
  WITH CHECK (tenant_id = webdesk_tenant_ctx());
