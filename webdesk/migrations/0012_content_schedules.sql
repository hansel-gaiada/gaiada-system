-- webdesk/migrations/0012_content_schedules.sql
-- WSK-61 (WebDesk M3, the scheduler): pending VERSION SWAPS on LIVE items.
-- Plan: docs/plans/2026-10-11-webdesk-m3-plan.md, section "WSK-61 · The scheduler".
--
-- Why a table. content.schedule on an item that is NOT live puts the scheduled version into the live
-- projection (content_items) immediately and lets the read path's time rule hide it until publish_at.
-- That cannot work for an item that IS live: the projection is what production serves right now, so
-- writing the new version into it would publish it early. The new version has to wait somewhere that
-- the projection does not read, until publish_at, and a worker then swaps it in. This table is that
-- place: one row per requested swap, written by content.schedule, executed (or cancelled, or failed)
-- by the scheduler (webdesk/api/src/scheduler). Until the row is executed the projection is untouched.
--
-- Lifecycle of a row (exactly one of the three terminal timestamps ever gets set, never two):
--   pending    executed_at, cancelled_at and failed_at are all NULL
--   executed   the scheduler applied the swap                     (executed_at)
--   cancelled  a newer decision won: a later schedule, a publish, an unpublish or a delete of the item,
--              or the item stopped being live before the swap was due (cancelled_at + cancel_reason)
--   failed     the version no longer validates against the collection's composition (failed_at +
--              fail_reason); nothing was changed
-- Rows are history and are never deleted (the app role has no DELETE, see below).
--
-- ONE PENDING SWAP PER ITEM. The partial UNIQUE index ux_content_schedules_one_pending is the
-- race-proof backstop for "the newest approved decision wins": content.schedule cancels the item's
-- pending row (reason 'superseded') and inserts the new one in one transaction, under the item's row
-- lock, so two concurrent schedules serialise and the loser cancels the winner's row or is cancelled.
--
-- RLS and grants follow 0002/0009 exactly: FORCE ROW LEVEL SECURITY with the single-mode
-- tenant_isolation policy (every row belongs to exactly one tenant, so there is no platform_ctx
-- escape), fail-closed on an unset webdesk.tenant_ctx. The scheduler walks tenants one at a time
-- under their own tenant_ctx.
--
-- ws4_approval_id is the approval that authorised the swap, kept for the audit trail. It is NOT
-- covered by 0009's single-use index on audit_entries; the scheduler's own audit row never carries
-- it in audit_entries.ws4_approval_id (that index must never see a second use of an approval).
--
-- No DML runs here (nothing to backfill), so this file is clear of the RLS zero-row trap
-- (lint-migration-rls.mjs). It is re-runnable: every statement is IF NOT EXISTS / DROP IF EXISTS, so
-- a second execution changes nothing. Runs as webdesk_migrator (no SET ROLE) in the runner's
-- per-file transaction, like every earlier file. Migration 0011 is reserved by another ticket
-- (Payload removal); the ledger orders by file name, so the gap is harmless.

CREATE TABLE IF NOT EXISTS content_schedules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  site_id         uuid NOT NULL REFERENCES sites(id),
  content_item_id uuid NOT NULL REFERENCES content_items(id),
  version         integer NOT NULL CHECK (version >= 1),
  publish_at      timestamptz NOT NULL,
  unpublish_at    timestamptz,
  requested_by    text NOT NULL,          -- opaque principal (EditorialPrincipal.sub), attribution only
  ws4_approval_id text,                   -- the WS4 approval that authorised the swap (audit trail only)
  created_at      timestamptz NOT NULL DEFAULT now(),
  executed_at     timestamptz,
  cancelled_at    timestamptz,
  cancel_reason   text,
  failed_at       timestamptz,
  fail_reason     text,
  CONSTRAINT content_schedules_window_check
    CHECK (unpublish_at IS NULL OR unpublish_at > publish_at),
  CONSTRAINT content_schedules_one_terminal_check
    CHECK (num_nonnulls(executed_at, cancelled_at, failed_at) <= 1),
  CONSTRAINT content_schedules_cancel_reason_check
    CHECK (cancel_reason IS NULL OR cancelled_at IS NOT NULL),
  CONSTRAINT content_schedules_fail_reason_check
    CHECK (fail_reason IS NULL OR failed_at IS NOT NULL)
);

-- One pending swap per item.
CREATE UNIQUE INDEX IF NOT EXISTS ux_content_schedules_one_pending
  ON content_schedules (content_item_id)
  WHERE executed_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL;

-- The scheduler's sweep: only rows that still have work pending, in due order.
CREATE INDEX IF NOT EXISTS ix_content_schedules_due
  ON content_schedules (publish_at)
  WHERE executed_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_content_schedules_tenant ON content_schedules (tenant_id);

-- Grants. The default-privilege rule in init-roles.sh would hand the app role SELECT/INSERT/UPDATE/
-- DELETE on a new table; say it explicitly (a database whose default privileges were never set up
-- must not end up with an RLS'd table the app role cannot touch) and take DELETE back: the table is
-- history. UPDATE is needed for the pending -> executed/cancelled/failed transitions.
REVOKE ALL ON content_schedules FROM webdesk_app;
GRANT SELECT, INSERT, UPDATE ON content_schedules TO webdesk_app;

ALTER TABLE content_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_schedules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON content_schedules;
CREATE POLICY tenant_isolation ON content_schedules FOR ALL
  USING      (tenant_id = webdesk_tenant_ctx())
  WITH CHECK (tenant_id = webdesk_tenant_ctx());
