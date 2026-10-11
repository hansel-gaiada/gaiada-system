-- clients.is_internal — the marker WSK-D36 requires: an internal (sentinel) client must be
-- DISTINGUISHABLE, not merely present, so client-facing surfaces can filter it programmatically.
-- Plan: docs/plans/2026-09-04-site-consolidation-ledger.md ("the sentinel internal client", option (a)),
-- mirroring `projects.is_internal` (0001_core.sql). Ruling: docs/blueprints/webdesk-design-v2.md §14 WSK-D36.
--
-- DDL only, purely additive. NO row is inserted or updated here: the sentinel row itself is created by
-- the one-off `internal-sentinel` script (src/seed/internal-sentinel.ts), never by a migration, because
-- `clients` is tenant-scoped FORCE-RLS data (a migration runs with the tenant GUC unset, so DML would
-- silently touch zero rows) and the display name is an owner decision. Existing rows get the DEFAULT false.
--
-- The partial unique index states "at most one live internal client per tenant" — what lets the script
-- find the sentinel by the marker (never by name) and what makes a concurrent double-run fail loudly
-- instead of creating a second sentinel. Partial on `deleted_at IS NULL` so a soft-deleted sentinel never
-- blocks a replacement.

ALTER TABLE clients ADD COLUMN is_internal boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX ux_clients_one_internal_per_tenant
  ON clients (tenant_id)
  WHERE is_internal AND deleted_at IS NULL;

COMMENT ON COLUMN clients.is_internal IS
  'WSK-D36: true marks the internal sentinel client that owns our own sites'' search_properties rows. '
  'Client-facing surfaces (portal, client lists, client-facing monitoring/reports) must exclude it.';
