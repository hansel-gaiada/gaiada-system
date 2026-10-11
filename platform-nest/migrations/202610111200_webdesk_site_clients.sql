-- 202610111200_webdesk_site_clients.sql — WSK-49c: which CLIENT a WebDesk site serves.
--
-- Rulings: WSK-D58, WSK-D59, WSK-D60 (amended: the website-editor role is scoped to a client record, in the
-- SERVING company's tenant) in docs/blueprints/webdesk-design-v2.md §14; brief for WSK-49c.
--
-- ── WHY THIS TABLE EXISTS (what was found, and what was not there) ──────────────────────────────────────
-- A client editor may touch only the WebDesk site(s) of THEIR client record. The ERP had two registries that
-- carry a `client_id`: `webdev_sites` (the portfolio registry, 202608300747, keyed by DOMAIN) and
-- `webdev_provisioned_sites` (202608270659, keyed by the repo/provisioning row). Neither knows a WebDesk
-- (tenant slug, site id): WebDesk's tenants are owned by `company_ref` (the SERVING company), and a WebDesk
-- site has no ERP client on either side. So there was no link to read, and a client-mode BFF cannot guess
-- one: matching by domain would let a typo, a shared domain or a registry import decide who may edit a
-- live site. This is the smallest link that can carry the decision explicitly.
--
--   one row = "(serving company tenant_id, WebDesk tenant slug, WebDesk site id) serves client_id"
--
-- It is STAFF-MANAGED (the staff routes under /api/:tenantId/modules/webdev/content/sites/:slug/:siteId/client,
-- authorised as `webdev_provisioned_site` · `operate`) and READ by the client-mode portal BFF, which loads it
-- server-side in the request's tenant and feeds its `client_id` to Cerbos as `resource.attr.clientId`. A
-- client id taken from a URL or a body is never an authority.
--
-- ── ONE SITE, ONE CLIENT ────────────────────────────────────────────────────────────────────────────────
-- UNIQUE (tenant_id, tenant_slug, site_id): a site serves one client. A client may have many sites. The
-- unique key has no nullable column, so NULL cannot defeat it.
--
-- ── TENANT CONSISTENCY ──────────────────────────────────────────────────────────────────────────────────
-- (client_id, tenant_id) is a composite FK to `clients (id, tenant_id)` (the `ux_clients_id_tenant` unique
-- index of 202609050857), the 0075 §0 pattern: a single-column FK to clients(id) runs as the table owner,
-- outside RLS, and would accept another company's client id. A link can therefore only join a site of this
-- company's tenant to a client of this same tenant.
--
-- ── RLS: THE PLAIN TENANT WALL, deliberately NOT app_module_allowed('webdev') ───────────────────────────
-- Same reasoning and same shape as `client_centre_profiles` (202609281655): this table is CLIENT-REACHABLE.
-- The portal BFF reads it for a caller who is a client contact, not a webdev module member, and a module
-- wall would silently return ZERO rows for them (the RLS zero-row trap) whatever their grant says. The STAFF
-- routes are gated at the application layer (Cerbos + ModuleEnabledGuard("webdev")), which is orthogonal to
-- this table's RLS shape, exactly as it is for `clients`. FORCE + the authorised-tenant-set predicate,
-- NULLIF-hardened (0025).
--
-- No DML, no CHECK widened, no existing object altered: nothing to backfill, so neither the NOBYPASSRLS
-- backfill-silence trap nor the shared-CHECK trap has anything to bite.

CREATE TABLE webdesk_site_clients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES companies(id),
  -- WebDesk's own identifiers (opaque here: Zone B owns them; the slug grammar mirrors WebDesk's).
  tenant_slug text NOT NULL CHECK (tenant_slug ~ '^[a-z0-9]([a-z0-9-]{0,198}[a-z0-9])?$'),
  site_id     uuid NOT NULL,
  client_id   uuid NOT NULL,
  -- Who linked it (audit lives in `activities`; this is the quick answer). NULL only for a future importer.
  linked_by   uuid REFERENCES users(id),
  origin_site text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_wsc_site UNIQUE (tenant_id, tenant_slug, site_id),
  CONSTRAINT fk_wsc_client_same_tenant FOREIGN KEY (client_id, tenant_id) REFERENCES clients (id, tenant_id)
);

-- "which sites serve this client": the portal's list.
CREATE INDEX ix_wsc_client ON webdesk_site_clients (tenant_id, client_id);

ALTER TABLE webdesk_site_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE webdesk_site_clients FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON webdesk_site_clients;
CREATE POLICY tenant_isolation ON webdesk_site_clients FOR ALL
  USING (tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]))
  WITH CHECK (tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]));

COMMENT ON TABLE webdesk_site_clients IS
  'WSK-49c: which client record a WebDesk site (tenant slug + site id) serves, in the serving company''s tenant. '
  'Staff-managed; read server-side by the client-mode portal BFF, whose Cerbos resource.attr.clientId it feeds. '
  'One site, one client (UNIQUE tenant_id, tenant_slug, site_id). Composite FK to clients (id, tenant_id). '
  'CORE plain tenant-wall RLS, like client_centre_profiles: client-reachable, so never module-walled.';
