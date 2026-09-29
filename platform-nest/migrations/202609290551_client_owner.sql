-- client_owner — the staff member who owns the client relationship (account manager).
--
-- Plan: docs/plans/2026-09-29-client-centre.md (CC-D10). Nullable: every existing client starts with
-- no owner, and "no owner" is a real, visible state in the UI rather than a guessed default.
--
-- ── Tenancy is enforced in the APP, not by this FK ──────────────────────────────────────────────
-- `REFERENCES users(id)` only proves the user exists. An FK check runs as the table owner, OUTSIDE
-- RLS, so it would accept a user from another tenant. ClientsController writes this column only after
-- `assertActiveStaff` reads `company_memberships` through the TENANT-SCOPED connection (the same idiom
-- as pipeline_runs.owner_id), so another tenant's user id, or a client-contact user, is a 400.
--
-- `ON DELETE SET NULL`: a hard-deleted user leaves the client ownerless rather than blocking the delete.
--
-- No DML — nothing to backfill, so the NOBYPASSRLS zero-row trap (migration-backfill-rls-trap) does
-- not apply. `clients` keeps its existing RLS policy; adding a column changes nothing about it.

ALTER TABLE clients ADD COLUMN owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX idx_clients_owner ON clients (tenant_id, owner_user_id) WHERE owner_user_id IS NOT NULL;
