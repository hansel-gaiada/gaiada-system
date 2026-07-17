-- WS11 build item 4: client portal linkage. A run may belong to a client (so the portal can scope a
-- client to only THEIR runs), and an external portal account (a user auto-provisioned from the client
-- Keycloak realm) links to a clients row. Client isolation is enforced in the portal controller
-- (run.client_id must map to the caller's clients.portal_user_id) on top of RLS (tenant) + Cerbos
-- (the `client` role). This mirrors the "owned by the caller" pattern used for time entries.

ALTER TABLE pipeline_runs ADD COLUMN client_id uuid REFERENCES clients(id);
CREATE INDEX pipeline_runs_client_idx ON pipeline_runs (tenant_id, client_id) WHERE client_id IS NOT NULL;

-- Links an external portal login (a users row from the client realm) to the client it represents.
ALTER TABLE clients ADD COLUMN portal_user_id uuid REFERENCES users(id);
CREATE INDEX clients_portal_user_idx ON clients (portal_user_id) WHERE portal_user_id IS NOT NULL;
