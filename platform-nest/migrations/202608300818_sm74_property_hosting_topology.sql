-- 202608300818_sm74_property_hosting_topology.sql — SM-74, the hosting-topology field set on
-- `search_properties`. Designed in docs/plans/2026-08-23-seo-audit-capability.md §5 (SM-74) and
-- required by webdesk-design-v2.md §07, which is where the portfolio work actually consumes it.
--
-- ── NUMBERING (migrations/README.md — timestamp scheme, WSK-D21) ───────────────────────────────
-- `date -u +%Y%m%d%H%M` at authoring time.
--
-- ── WHY THESE COLUMNS GO HERE AND NOT ON `webdev_sites` ────────────────────────────────────────
-- Both tables describe a site, and it would be easy to duplicate. They are deliberately split by
-- OWNERSHIP, not by convenience:
--
--   `search_properties`  the SEO module's DOMAIN-level record. It already owns domain identity
--                        (`UNIQUE (tenant_id, client_id, domain)`), the crawl-CONSENT gate
--                        (`verified_at`), the audit history and the crawler. Anything true of the
--                        domain as an observable thing on the internet belongs here.
--   `webdev_sites`       the delivery record: which project, which repo, which adoption state,
--                        which contract version. Anything true of how WE deliver it belongs there.
--
-- Hosting topology — who hosts it, behind which control panel, on what stack — is an OBSERVABLE
-- FACT about the domain, discoverable from outside with no access. So it lands here, and
-- `webdev_sites` joins on `(tenant_id, client_id, domain)` rather than restating it. One domain,
-- one row, one consent gate, one crawler. A second registry would fork consent, which is the one
-- thing that must never be ambiguous.
--
-- ── EVERY COLUMN IS NULLABLE, AND THAT IS THE POINT ────────────────────────────────────────────
-- These describe roughly 63 real client properties, most of which nobody has surveyed yet. A
-- NOT NULL DEFAULT 'unknown' would render as a measurement in every console that reads it. NULL
-- says "not surveyed"; 'unknown' would say "surveyed, and we could not tell". Those are different
-- facts and the difference matters when the table's whole job is to be trustworthy about what we
-- actually know.

ALTER TABLE search_properties
  -- Who the site is hosted with, as observed (e.g. 'hostinger', 'helios', 'delphi', 'cloudflare').
  -- Free text rather than an enum: the set is open, and a CHECK constraint we have to migrate every
  -- time a client picks a new host is a constraint that will be widened carelessly under time
  -- pressure. The registry's own `host_kind` enum is where the CLASSIFICATION lives.
  ADD COLUMN IF NOT EXISTS hosting_provider text,

  -- The control panel, which decides what operating on the site even looks like: cPanel means
  -- FTP-and-a-web-UI, no shell. This single field is the difference between "we can deploy here"
  -- and "any change is a DNS-and-export exercise" — see webdesk-design-v2.md §07.
  ADD COLUMN IF NOT EXISTS control_panel text
    CHECK (control_panel IS NULL OR control_panel IN ('cpanel', 'plesk', 'directadmin', 'none', 'other')),

  -- What the site is built with, as fingerprinted from outside ('wordpress', 'astro', 'nextjs',
  -- 'static', 'php', ...). Also free text: a fingerprint is a guess with evidence, not a taxonomy.
  ADD COLUMN IF NOT EXISTS stack text,

  -- WordPress plugin/theme surface when detectable — the thing that actually carries the CVEs on a
  -- WP estate. jsonb because it is a list of observations, each with its own provenance, not a
  -- scalar. `'[]'` (surveyed, nothing found) and NULL (not surveyed) are different answers.
  ADD COLUMN IF NOT EXISTS plugin_surface jsonb,

  -- WHEN the topology above was last observed. Without this the fields silently become folklore:
  -- a 2025 fingerprint reads exactly like this morning's. Every console rendering the fields above
  -- must render this alongside them.
  ADD COLUMN IF NOT EXISTS topology_checked_at timestamptz,

  -- Where the topology came from, so an imported guess never reads as a measurement. The
  -- 2026-08-23 ruling demoted the Nexus corpus from specification to EVIDENCE; 'nexus-import' rows
  -- are leads to verify, and MON-01's live probing is what turns them into observations.
  ADD COLUMN IF NOT EXISTS topology_source text
    CHECK (topology_source IS NULL OR topology_source IN ('nexus-import', 'probe', 'manual'));

-- MON-01's target generator selects on exactly this predicate: consent given, still active, not
-- deleted. Indexing it keeps the generator a lookup rather than a scan as the portfolio grows, and
-- documents the consent gate in the schema itself.
CREATE INDEX IF NOT EXISTS idx_search_properties_probeable
  ON search_properties (tenant_id) WHERE verified_at IS NOT NULL AND status = 'active' AND deleted_at IS NULL;

COMMENT ON COLUMN search_properties.control_panel IS
  'Observed control panel. Decides what operating on the site looks like at all: cpanel means '
  'FTP and a web UI with no shell, so deployment is a DNS-and-export exercise rather than a push.';
COMMENT ON COLUMN search_properties.plugin_surface IS
  'WordPress plugin/theme observations. NULL = not surveyed; [] = surveyed and nothing found. '
  'Those are different answers and the distinction is load-bearing.';
COMMENT ON COLUMN search_properties.topology_checked_at IS
  'When the hosting topology was last OBSERVED. Render this wherever the topology fields are '
  'rendered - without it a 2025 fingerprint is indistinguishable from this morning.';
