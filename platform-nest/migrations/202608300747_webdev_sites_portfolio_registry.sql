-- 202608300747_webdev_sites_portfolio_registry.sql — the site portfolio registry.
-- Design: docs/blueprints/webdesk-design-v2.md §04 (this table) and §07 (the adoption ladder).
--
-- ── NUMBERING (migrations/README.md — the timestamp scheme; WSK-D21) ───────────────────────────
-- `date -u +%Y%m%d%H%M` at authoring time. No number to reserve, nobody to coordinate with; a
-- same-minute collision fails the name lint loudly rather than corrupting an order silently.
--
-- ── WHY THIS TABLE EXISTS ──────────────────────────────────────────────────────────────────────
-- The design assumed every client site would become a full Zone B tenant. Most never will. The
-- owner's requirement (2026-08-29) is two-sided: FUTURE projects must use the unified backend;
-- PAST and CURRENT ones must never be touched — they are already in production, some on our
-- servers and some on the client's own — but they must at least be TRACKED, and may adopt later,
-- per site, by choice.
--
-- `webdev_provisioned_sites` (0090) cannot hold these rows and should not be widened to: its
-- `framework CHECK IN ('vite','nextjs')` refuses everything else BY DESIGN (D-P7), and its status
-- column models a PROVISIONING lifecycle, not the life of a site. It stays the record of how a
-- site was BORN, for the subset we provisioned. This table is the record of what EXISTS.
--
-- ── THE TWO RULES THAT MATTER MORE THAN THE COLUMNS ────────────────────────────────────────────
-- 1. IT LIVES IN ZONE A AND NEVER IN ZONE B. A tracked site must not require a Zone B tenant row.
--    Otherwise the internet-facing content backend accumulates rows for sites it does not serve,
--    and a Zone B compromise hands over an inventory of the entire client estate — including the
--    sites hosted on clients' own infrastructure, which are exactly the ones we cannot defend.
-- 2. IT REFERENCES CREDENTIALS AND NEVER STORES THEM. `vault_ref` is a pointer. Client cPanel and
--    FTP logins live in an operator vault; putting them in the ERP database would be a custody
--    decision made by accident. There is deliberately no column they could go in.
--
-- ── HOSTING AND ADOPTION ARE INDEPENDENT AXES, ON PURPOSE ──────────────────────────────────────
-- `host_kind`/`access` describe who owns the machine and what we can reach. `adoption` describes
-- how much of WebDesk the site uses. Modelling them separately is what makes the useful case
-- expressible: `/v1` is HTTPS with a scoped key, so a site on a CLIENT'S OWN cPanel can be
-- `linked` (its forms POST to WebDesk) or even fully `adopted` (built static uploaded by FTP,
-- content read from `/v1`). What a client-owned host costs us is deploy automation — not the
-- platform. Collapsing these into one column would have quietly ruled that out.

CREATE TABLE IF NOT EXISTS webdev_sites (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES companies(id),

  -- One row per SITE/DOMAIN, not per project: a project routinely owns production, staging and a
  -- microsite, each with its own host, stack and adoption state.
  domain         text NOT NULL CHECK (domain = lower(domain) AND domain !~ '\s' AND length(domain) BETWEEN 3 AND 253),

  -- Nullable: an internal site has no client project behind it. `projects` carries
  -- `ux_projects_id_tenant`, so this one gets the composite FK that makes cross-tenant linkage
  -- structurally impossible. `clients` has no such constraint today, so `client_id` takes the
  -- plain FK — the same choice `projects.client_id` itself already makes, rather than inventing a
  -- new constraint on another module's table from here.
  project_id     uuid,
  client_id      uuid REFERENCES clients(id),

  -- Who owns the machine, and what we can actually reach on it.
  host_kind      text NOT NULL DEFAULT 'unknown'
                 CHECK (host_kind IN ('our-box', 'client-cpanel', 'shared-hosting', 'external', 'unknown')),
  host_ref       text,
  access         text NOT NULL DEFAULT 'none'
                 CHECK (access IN ('none', 'ftp', 'cpanel', 'ssh', 'full')),

  -- The §08 project-kind vocabulary — ONE set of words, mapped through every component that had
  -- its own. Nullable while a legacy site's stack is still unsurveyed: `unknown` would be a claim,
  -- NULL is an admission.
  kind           text CHECK (kind IN ('static', 'wp', 'fullstack')),
  repo_url       text,

  -- The adoption ladder (§07). Everything already live starts at `tracked`, which means we know it
  -- exists and touch nothing.
  adoption       text NOT NULL DEFAULT 'tracked'
                 CHECK (adoption IN ('tracked', 'linked', 'adopted', 'mandated')),
  contract_version text,

  -- An imported row is a LEAD TO VERIFY, never a measurement. The 2026-08-23 ruling demoted the
  -- Nexus corpus from specification to evidence; provenance is what keeps a 2025 audit from
  -- rendering as today's status.
  origin         text NOT NULL DEFAULT 'manual'
                 CHECK (origin IN ('nexus-import', 'provisioned', 'manual')),

  -- A POINTER to an operator vault item. Never a credential. See rule 2 above.
  vault_ref      text,

  notes          text,
  origin_site    text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,

  CONSTRAINT fk_webdev_sites_project FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id),
  CONSTRAINT ux_webdev_sites_id_tenant UNIQUE (id, tenant_id)
);

-- One domain, one row, per tenant. Partial so a soft-deleted row does not block re-registering a
-- domain we later take back on — NULL does not defeat this one, because the predicate excludes the
-- deleted rows rather than relying on NULL comparison.
CREATE UNIQUE INDEX IF NOT EXISTS ux_webdev_sites_tenant_domain
  ON webdev_sites (tenant_id, domain) WHERE deleted_at IS NULL;

-- The console's two real questions: "what does this project own" and "what is still only tracked".
CREATE INDEX IF NOT EXISTS idx_webdev_sites_tenant_project
  ON webdev_sites (tenant_id, project_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_webdev_sites_tenant_adoption
  ON webdev_sites (tenant_id, adoption) WHERE deleted_at IS NULL;

ALTER TABLE webdev_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE webdev_sites FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON webdev_sites;
CREATE POLICY tenant_isolation ON webdev_sites FOR ALL
  USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('webdev'))
  WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('webdev'));

COMMENT ON TABLE webdev_sites IS
  'v2.0 §04/§07. The site portfolio: one row per domain, Zone A only. Tracks sites we do NOT touch '
  '(client-owned hosts included) alongside ones that have adopted WebDesk. host_kind/access are '
  'independent of adoption on purpose - /v1 is just HTTPS, so a site on a client cPanel can be '
  'linked or adopted; what a client-owned host costs us is deploy automation, not the platform. '
  'Stores NO credentials: vault_ref is a pointer, and there is deliberately no column for one.';

COMMENT ON COLUMN webdev_sites.adoption IS
  'tracked = we know it exists and touch nothing (everything live starts here) | linked = keeps its '
  'own hosting, uses one WebDesk service, forms first | adopted = content served from /v1, a real '
  'Zone B tenant | mandated = every new project, enforced at scaffold and deploy.';

COMMENT ON COLUMN webdev_sites.vault_ref IS
  'Pointer to an operator vault item. NEVER a credential. Client cPanel/FTP logins currently live '
  'in a gitignored local file, which is not a system of record - the fix is a vault plus this '
  'pointer, not a column.';
