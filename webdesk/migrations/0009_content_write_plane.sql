-- webdesk/migrations/0009_content_write_plane.sql
-- WSK-65 — the write-plane storage model (ruling WSK-D45: draft is not live).
-- Spec: docs/plans/2026-10-10-webdesk-write-plane-design.md §2.6 (+ §1 rows 5-7 and 14, §12 WSK-65).
--
-- What this adds, all additive (no existing column, constraint, index or policy is altered,
-- dropped or re-declared):
--   1. content_items    — head/published version pointers, soft delete, last-publish attribution,
--                         and a site-scoped UNIQUE (site_id, localization_group_id, locale) over
--                         live (non-deleted) rows.
--   2. content_versions — content_hash (sha256 hex of canonical {blocks, seo}), an editorial note,
--                         and an opaque attribution object.
--   3. audit_entries    — a partial UNIQUE index on ws4_approval_id over non-replay rows, closing
--                         WSK-22's documented WS4 single-use race (fact 14).
--   4. control_idempotency_keys — the durable idempotency store (WSK-21's flagged in-memory gap),
--                         FORCE RLS with the same dual-mode policy shape as audit_entries.
--
-- The read SQL is NOT edited, so WSK-48a's /v1 byte gate holds. The delivery queries select
-- `ci.*`, but the envelope is assembled from named fields only (content-read.ts toEnvelope), so
-- the new columns are fetched and never serialised. migrations/tests/0009_v1_bytes.test.mjs
-- proves the bytes are identical before and after this file on the same rows.
--
-- No backfill DML runs here. Pre-0009 rows keep head_version = 0 and published_version = NULL and
-- are ADOPTED ON FIRST WRITE by the WSK-41 service, which first writes version 1 from the current
-- projection. That keeps this file clear of the RLS zero-row trap (lint-migration-rls.mjs).
--
-- Runs as webdesk_migrator (no SET ROLE), the same posture as every earlier file in this ledger.
-- ============================================================================================
-- WHY THERE ARE NO SELECT-BASED DUPLICATE PRECONDITIONS
-- ============================================================================================
-- Every table below is FORCE RLS and webdesk_migrator is NOBYPASSRLS. During a migration neither
-- webdesk.tenant_ctx nor webdesk.platform_ctx is set, so `SELECT ... GROUP BY ... HAVING count(*) > 1`
-- would see ZERO rows and pass silently on a populated database (the estate's RLS zero-row trap).
-- A UNIQUE INDEX build reads the heap directly, not through the policies, so the build itself IS
-- the precondition. Each build is wrapped so that a duplicate fails the whole migration (the runner
-- rolls the file back atomically; the ledger row is not written) with a message naming this file,
-- the duplicated key (from Postgres' own DETAIL) and the remediation.
-- ============================================================================================

-- ---------------------------------------------------------------------------
-- 0. Precondition: this role owns the three tables it alters.
-- ---------------------------------------------------------------------------
-- ALTER TABLE / CREATE INDEX need ownership. On one live box the tables once ended up owned by
-- `postgres` with zero app grants; fail here, by name, rather than halfway through. pg_class is a
-- catalog and is not subject to RLS, so this check cannot be fooled by the zero-row trap.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname, pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN ('content_items', 'content_versions', 'audit_entries')
       AND NOT pg_has_role(current_user, c.relowner, 'MEMBER')
  LOOP
    RAISE EXCEPTION '0009 precondition FAILED: table % is owned by %, not by the migrating role %',
      r.relname, r.owner, current_user
      USING HINT = 'Run migrations as webdesk_migrator (MIGRATE_DATABASE_URL). Fix ownership before retrying; do not run this file as a superuser.';
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 1. content_items: live/head pointers, soft delete, publish attribution
-- ---------------------------------------------------------------------------
-- Semantics (§2.6):
--   head_version      — the newest content_versions.version for this item. 0 = never written
--                       through the write plane (a pre-0009 row, adopted on first write).
--   published_version — the version the projection currently serves to production; NULL while the
--                       item has never been published. publish(v) is the only path that sets it.
--   deleted_at        — soft delete. The read-path filter (`AND ci.deleted_at IS NULL`) is
--                       WSK-41b's change, not this file's: the read SQL is frozen here.
--   last_published_at / last_published_by — attribution of the most recent publish. by is an
--                       opaque Zone A principal id, same convention as releases.created_by.
-- Constant defaults, so on PG 11+ these ADD COLUMNs are catalog-only (no table rewrite).
--
-- Deliberately NO cross-column CHECK tying publish_state to published_version:
-- payload/test/v1-fixtures.mjs seeds published rows directly (published_version NULL), and the
-- envelope-contract gate must keep passing untouched. The checks below hold for every pre-0009 row
-- by construction (head_version 0, published_version NULL, both last_published_* NULL).
ALTER TABLE content_items
  ADD COLUMN head_version      integer NOT NULL DEFAULT 0,
  ADD COLUMN published_version integer,
  ADD COLUMN deleted_at        timestamptz,
  ADD COLUMN last_published_at timestamptz,
  ADD COLUMN last_published_by text;

ALTER TABLE content_items
  ADD CONSTRAINT content_items_head_version_check
    CHECK (head_version >= 0),
  ADD CONSTRAINT content_items_published_version_check
    CHECK (published_version IS NULL OR published_version >= 1),
  -- A published version must exist, so it can never be ahead of the head. This also forces
  -- adoption (head >= 1) before a pre-0009 row can be published through the write plane.
  ADD CONSTRAINT content_items_published_le_head_check
    CHECK (published_version IS NULL OR published_version <= head_version),
  -- Attribution is all-or-nothing: a publish time with no publisher (or the reverse) is a bug.
  ADD CONSTRAINT content_items_last_published_pair_check
    CHECK ((last_published_at IS NULL) = (last_published_by IS NULL));

-- One live item per (site, localization group, locale). Site-scoped on purpose: a localization
-- group belongs to one site, and a same-database bundle copy (the promotion tests) legitimately
-- reuses group ids on another site. Soft-deleted rows are excluded, so deleting a locale variant
-- frees its slot.
DO $$
DECLARE
  v_detail text;
BEGIN
  CREATE UNIQUE INDEX ux_content_items_group_locale
    ON content_items (site_id, localization_group_id, locale)
    WHERE deleted_at IS NULL;
EXCEPTION WHEN unique_violation THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  RAISE EXCEPTION USING
    ERRCODE = 'unique_violation',
    MESSAGE = '0009 precondition FAILED: content_items has two live rows for the same (site_id, localization_group_id, locale); ux_content_items_group_locale cannot be built',
    DETAIL  = v_detail,
    HINT    = 'Resolve the duplicate locale variants under that tenant''s webdesk.tenant_ctx (keep one, re-group or delete the other), then re-run the migrator. Nothing from 0009 was applied.';
END
$$;

-- ---------------------------------------------------------------------------
-- 2. content_versions: content hash, note, attribution
-- ---------------------------------------------------------------------------
-- content_versions stays append-only (0002's REVOKE UPDATE, DELETE FROM webdesk_app is untouched).
--   content_hash — sha256 hex of the canonical {blocks, seo}. NULL only on pre-0009 rows; the
--                  write plane always sets it (lets a no-op save be detected without a jsonb diff).
--   note         — the editor's change note, bounded.
--   attribution  — {pk, agt?, req?, apr?}: principal, acting agent, request id, approval id.
--                  Opaque to the database; only its shape (an object) is enforced.
ALTER TABLE content_versions
  ADD COLUMN content_hash text,
  ADD COLUMN note         text,
  ADD COLUMN attribution  jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE content_versions
  ADD CONSTRAINT content_versions_content_hash_check
    CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT content_versions_note_check
    CHECK (note IS NULL OR length(note) <= 500),
  ADD CONSTRAINT content_versions_attribution_check
    CHECK (jsonb_typeof(attribution) = 'object');

-- ---------------------------------------------------------------------------
-- 3. audit_entries: WS4 approval ids are single-use (closes WSK-22's race, fact 14)
-- ---------------------------------------------------------------------------
-- Global, not per-tenant: an approval id is minted once by Zone A and must never authorise two
-- executions anywhere (RealPolicyDecisionPoint already checks both the platform ledger and the
-- tenant ledger for that reason). Idempotent replays are audited as `control.<cmd>.replay` rows
-- (command-audit.service.ts, promotion-audit.service.ts) carrying the SAME approval id; they record
-- that no new side effect occurred, so they are excluded from the uniqueness.
--
-- The existing plain index ix_audit_entries_ws4 (0001) is left in place: the PDP's lookup is not
-- filtered on action, so it still needs an index that covers replay rows.
DO $$
DECLARE
  v_detail text;
BEGIN
  CREATE UNIQUE INDEX ux_audit_entries_ws4_once
    ON audit_entries (ws4_approval_id)
    WHERE ws4_approval_id IS NOT NULL AND action NOT LIKE '%.replay';
EXCEPTION WHEN unique_violation THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  RAISE EXCEPTION USING
    ERRCODE = 'unique_violation',
    MESSAGE = '0009 precondition FAILED: audit_entries holds one WS4 approval id on two non-replay rows; ux_audit_entries_ws4_once cannot be built',
    DETAIL  = v_detail,
    HINT    = 'That approval was executed twice (the WSK-22 race) or was reused by hand. audit_entries is append-only: investigate, record the finding, and get a senior-db decision before any repair. Nothing from 0009 was applied.';
END
$$;

-- ---------------------------------------------------------------------------
-- 4. control_idempotency_keys: the durable idempotency store
-- ---------------------------------------------------------------------------
-- Replaces control/idempotency/idempotency-store.ts's in-memory map (WSK-21's flagged gap).
--   tenant_id    — NULL for a platform-level command (tenant.provision and friends), exactly like
--                  audit_entries.tenant_id.
--   scope_key    — the caller's idempotency key, scoped as the service decides (key + principal).
--   request_hash — hash of the canonical request; a same-key different-body retry is a conflict.
--   status       — in_flight while the command runs, completed once `response` is stored.
--   expires_at   — rows past it are treated as absent by the service; deletion is the service's
--                  sweep (it must run per tenant under tenant_ctx, plus once under platform_ctx,
--                  because the app role cannot see across tenants).
CREATE TABLE control_idempotency_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid REFERENCES tenants(id),
  scope_key    text NOT NULL,
  command      text NOT NULL,
  request_hash text NOT NULL,
  status       text NOT NULL,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  CONSTRAINT control_idempotency_keys_status_check   CHECK (status IN ('in_flight', 'completed')),
  CONSTRAINT control_idempotency_keys_expiry_check   CHECK (expires_at > created_at)
);

-- NULL defeats a plain UNIQUE (tenant_id, scope_key): two platform rows with the same key would
-- both be admitted. Hence one partial index per mode.
CREATE UNIQUE INDEX ux_idem_tenant   ON control_idempotency_keys (tenant_id, scope_key) WHERE tenant_id IS NOT NULL;
CREATE UNIQUE INDEX ux_idem_platform ON control_idempotency_keys (scope_key)            WHERE tenant_id IS NULL;
-- The expiry sweep.
CREATE INDEX ix_idem_expires ON control_idempotency_keys (expires_at);

-- Same grant the init-roles.sh default-privilege rule hands every new table, stated explicitly so
-- a database whose default privileges were never set up (the live-box incident) cannot end up with
-- an RLS'd table the app role cannot touch at all. Not a widening: identical to the default rule.
-- UPDATE (in_flight -> completed) and DELETE (the sweep) are both needed, so nothing is revoked.
GRANT SELECT, INSERT, UPDATE, DELETE ON control_idempotency_keys TO webdesk_app;

ALTER TABLE control_idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_idempotency_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON control_idempotency_keys;
-- Dual-mode, the same shape as audit_entries (0001): a tenant session sees and writes only its own
-- tenant's keys; a platform-level key (tenant_id IS NULL) is visible only under platform_ctx. An
-- unset GUC matches nothing (fail-closed).
CREATE POLICY tenant_isolation ON control_idempotency_keys FOR ALL
  USING (
    (tenant_id IS NOT NULL AND tenant_id = webdesk_tenant_ctx())
    OR (tenant_id IS NULL AND webdesk_platform_ctx())
  )
  WITH CHECK (
    (tenant_id IS NOT NULL AND tenant_id = webdesk_tenant_ctx())
    OR (tenant_id IS NULL AND webdesk_platform_ctx())
  );
