-- 202608301055_webdev_sites_environments_and_repo.sql — the environment dimension the registry
-- shipped without, plus the GitHub wiring. Design: webdesk-design-v2.md §04/§07.
--
-- ── WHY THIS IS A SECOND MIGRATION AND NOT AN EDIT ─────────────────────────────────────────────
-- `202608300747_webdev_sites_portfolio_registry.sql` is APPLIED on the live database. Editing an
-- applied migration only ever reaches fresh databases, which is the exact bug class that put two
-- wrong functions into production this month. Additive follow-up, always.
--
-- ── WHAT THE SURVEY FOUND, AND WHY IT FORCED THIS ──────────────────────────────────────────────
-- The registry was modelled as one row per domain, which is right, but with no way to say WHICH
-- ENVIRONMENT a domain is. The live estate makes that untenable — a single project routinely owns
-- several:
--
--   bali-girls.com            production
--   baligirls-prod / -live / -new / -old / -diff / -source / -nosource .gaiada2.online
--   blossomsteakhouse.com  +  sst.  +  preview-sst.
--   essentialbali.com      +  essentialbali.gaiada2.online
--
-- Without `environment`, "the production URL for this project" is not a query — it is a guess made
-- from a naming convention, and the conventions here are four deep (`gaiada.online`,
-- `gaiada1.online`, `gaiada2.online`, plus per-project slots). A console built on that guess would
-- confidently show a client their staging site.
--
-- ── WHY NOT A `site_environments` CHILD TABLE ──────────────────────────────────────────────────
-- Considered and rejected. Each environment here IS a distinct domain with its own host, TLS,
-- adoption state and audit history — that is precisely a `webdev_sites` row. A child table would
-- duplicate every one of those columns to express "same project, different URL", and the parent
-- would become a row with no domain of its own. The grouping already exists: `project_id`. One
-- project, N site rows, each labelled with its environment.

ALTER TABLE webdev_sites
  -- 'preview' is separate from 'staging' on purpose: staging is a durable, named environment a
  -- client may be shown, while preview slots are ephemeral and machine-generated (delphi is
  -- currently serving ~11 of them under NN-xxxxx.gaiada.com). Merging them would make "show the
  -- client their staging site" ambiguous, which is the failure this whole column exists to prevent.
  ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'production'
    CHECK (environment IN ('production', 'staging', 'preview', 'development')),

  -- The GitHub half. `repo_url` (already present) says WHICH repository; this says which ref that
  -- environment is actually built from. A repo link without a branch cannot answer "is production
  -- running what main says it is", which is the question the wiring exists to answer.
  ADD COLUMN IF NOT EXISTS repo_branch text,

  -- Observation, kept deliberately thin. MON-01 owns real probing against `search_properties`;
  -- these two are only so the console can render "last seen, and what it answered" without a join
  -- to a metrics store the ERP has no business querying synchronously.
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_http_status int;

-- ONE production per project. This is the constraint that makes "the production URL" a fact rather
-- than a convention, and it is partial three ways: only production, only live rows, only rows that
-- actually belong to a project (an internal site with no project_id is unconstrained, which is
-- correct — there is nothing to be the production OF).
CREATE UNIQUE INDEX IF NOT EXISTS ux_webdev_sites_one_production_per_project
  ON webdev_sites (tenant_id, project_id)
  WHERE environment = 'production' AND project_id IS NOT NULL AND deleted_at IS NULL;

-- The console's grouping query: every environment of a project, ordered.
CREATE INDEX IF NOT EXISTS idx_webdev_sites_project_env
  ON webdev_sites (tenant_id, project_id, environment) WHERE deleted_at IS NULL;

COMMENT ON COLUMN webdev_sites.environment IS
  'production | staging | preview | development. preview is distinct from staging on purpose: '
  'staging is durable and client-visible, preview slots are ephemeral and machine-generated. '
  'Exactly one production row per project is enforced by ux_webdev_sites_one_production_per_project.';
COMMENT ON COLUMN webdev_sites.repo_branch IS
  'The ref this environment is built from. repo_url says which repository; without the branch you '
  'cannot answer whether production is running what main says it is.';
