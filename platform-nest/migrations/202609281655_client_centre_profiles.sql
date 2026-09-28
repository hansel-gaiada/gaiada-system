-- 202609281655_client_centre_profiles.sql — Client Centre (CC-D3): the profile table.
--
-- Design: docs/plans/2026-09-29-client-centre.md (decision log CC-D1..D7, "Data model" section).
-- One row per (tenant_id, client_id). A missing row means an empty profile — the GET route
-- synthesises the registry defaults and the first PATCH inserts this row (upsert, app-layer).
--
-- ── RLS: CORE plain tenant wall, deliberately NOT app_module_allowed('clients') ───────────────────
-- This table is CLIENT-REACHABLE (the portal PATCH/GET routes in src/core/portal-centre.controller.ts
-- read and write it directly, scoped by src/core/portal-scope.ts, never by the `clients` module
-- guard), so the 0072:214 / 0075:242 / 202609050857 doctrine applies: a client-reachable table is
-- never module-walled. Module-walling it would make a legitimate client contact's read/write
-- silently return ZERO ROWS the moment their agency has not (or no longer has) the `clients` module
-- enabled — a portal contact has no idea what modules their agency's tenant has turned on, and
-- nothing about "may I see my own company's profile" should depend on it. The STAFF routes are still
-- gated at the app layer by ModuleEnabledGuard("clients") (src/modules/clients/centre/*.controller.ts)
-- — that gate is orthogonal to this table's RLS shape, exactly as it is for the `clients` table
-- itself (core schema, module-routed).
--
-- ── Tenant-consistency guard ────────────────────────────────────────────────────────────────────
-- `client_id` is constrained to belong to the SAME tenant via a composite FK against
-- `clients (id, tenant_id)`, using the `ux_clients_id_tenant` unique index 202609050857 already
-- added (0075 §0 pattern: a single-column FK to clients(id) runs as the table owner, outside RLS,
-- and would happily accept another tenant's client id). No new unique index needed here — it
-- already exists on `clients`.
--
-- No DML in this migration — nothing to backfill, so the NOBYPASSRLS backfill-silence trap
-- (migration-backfill-rls-trap) does not apply; `npm run lint:migration-rls` has nothing to flag.

CREATE TABLE client_centre_profiles (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES companies(id),
  client_id          uuid NOT NULL,
  business_type      text NOT NULL DEFAULT 'other',
  profile            jsonb NOT NULL DEFAULT '{}',   -- registry field key -> string
  connections        jsonb NOT NULL DEFAULT '{}',   -- registry/custom connection key -> ConnectionEntry
  departments        jsonb NOT NULL DEFAULT '{}',   -- department id (or "ix") -> boolean
  custom_connections jsonb NOT NULL DEFAULT '{}',   -- section id -> [{id, name}]
  registry_version   int  NOT NULL DEFAULT 1,
  revision           int  NOT NULL DEFAULT 0,       -- +1 per accepted write (CC §API contract)
  legacy_cmc_id      text,                          -- CMC companies.id this row was imported from (CC-D2)
  origin_site        text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid REFERENCES users(id),
  UNIQUE (tenant_id, client_id),
  CONSTRAINT fk_ccp_client_same_tenant FOREIGN KEY (client_id, tenant_id) REFERENCES clients (id, tenant_id)
);

-- ── RLS (D5): FORCE + authorized-tenant-SET, NULLIF-hardened (0025) ────────────────────────────────
-- Table is CREATE TABLE'd in this same file — zero pre-existing rows by construction, so there is
-- nothing for the backfill-silence trap to bite (no DML follows).
ALTER TABLE client_centre_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_centre_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON client_centre_profiles FOR ALL
  USING (tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]))
  WITH CHECK (tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]));
