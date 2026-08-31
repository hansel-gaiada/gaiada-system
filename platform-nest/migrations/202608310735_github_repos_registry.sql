-- 202608310735_github_repos_registry.sql — GH-05: the repo registry (blueprint §5).
-- Design: docs/blueprints/github-integration-foundation.md §5.2 (column set), §4.1 (single
-- chokepoint), §3 (the org migration and its "no rename redirect" lesson).
--
-- ── FILENAME NOTE (see migrations/README.md — the timestamp scheme is NORMATIVE) ──────────────────
-- Stamped from a real `date -u +%Y%m%d%H%M` read (202608310735). The on-disk head at authoring time
-- is `202608300818_sm74_property_hosting_topology.sql` — `docs/MAP.md` still names the older
-- `202608272010_iam_finance_ap_credit_writeoff.sql` as head, because MAP is generated and had not
-- been refreshed since two more files landed. **The directory, not the doc, is authoritative** for
-- what to sort after; MAP is checked here for context, never trusted over `ls`. A migration that
-- sorts BEFORE an already-applied one never runs, silently — see 202608261100's own header for the
-- one time this actually cost a deploy. `2026083107 > 2026083008`, so this file is safe.
--
-- ── WHY THIS TABLE IS CORE, NOT MODULE-OWNED ───────────────────────────────────────────────────────
-- `github_repos` links to BOTH `webdev_site_id` (webdev) and `project_id` (pm, any department) —
-- it is not owned by one module the way `hr_*` or `search_*` are. `integration_connections` (0033)
-- already drew this exact line for the same reason ("every department and every future provider
-- reuses it") and composes RLS from `app_current_tenants()` ALONE, no `app_module_allowed()` wall.
-- This table follows that precedent: tenant isolation only, not module-sliced. A future BFF/UI
-- ticket (GH-08/GH-09) still gates the ENDPOINT with Cerbos per §4.2 — that is authorization, this
-- is tenancy, and the two are already kept separate everywhere else in this schema.
--
-- ── WHY `tenant_id` IS NOT NULL DESPITE "AN UNLINKED REPO IS A LEGITIMATE FINDING" ─────────────────
-- §5.2 says `webdev_site_id`/`project_id` are nullable and unlinked is a finding, not an error. That
-- is about the LINK, not the TENANT. Every other tenant-scoped table in this schema (`companies`,
-- `projects`, `webdev_sites`, `clients`) requires `tenant_id NOT NULL` — RLS is built on
-- `tenant_id = ANY(app_current_tenants())`, and a NULL there is invisible to every authorized set,
-- which would make an unlinked repo a finding NOBODY CAN SEE. Decision #1 in the blueprint (one
-- GitHub identity, one org) means the crawl (GH-06) currently has exactly one company to assign
-- unlinked rows to; which company that is, and what happens the day a second company acquires its
-- own GitHub footprint, is GH-06's call to make and document — flagged here because §5.2 does not
-- specify it and this migration should not quietly decide it by omission.
--
-- ── THE PARTIAL-UNIQUE-INDEX TRAP, APPLIED (estate memory: null-defeats-unique-constraints) ────────
-- §5.2: "full_name is unique per org." The wrong shape for that is a PLAIN `UNIQUE (org, full_name)`
-- alongside a `deleted_at` soft-delete column used elsewhere in this migration's own indexes: a
-- three-column `UNIQUE (org, full_name, deleted_at)` would look like it protects live rows while
-- actually protecting NOTHING, because `deleted_at IS NULL` on every live row makes every live row's
-- NULL distinct from every other — Postgres never considers two NULLs equal in a unique index. Two
-- ACTIVE rows for the same repo would then insert without complaint, which is the exact failure this
-- table exists to catch (a duplicate crawl). The fix is the estate's own idiom
-- (`ux_webdev_sites_tenant_domain`, 202608300747): a PARTIAL unique index scoped `WHERE deleted_at IS
-- NULL`, so uniqueness is enforced across live rows and soft-deleted history is exempt by exclusion,
-- never by a NULL comparison that was never going to work.
--
-- ── WHY `org` IS NOT CHECK-CONSTRAINED TO ONE VALUE ─────────────────────────────────────────────────
-- §3 already burned this estate once: `gaiadabali` is a NEW org (created 2026-08-16), not a rename
-- of `Gaia-Digital-Agency`, and stored URLs naming the old org now hard-404 with no redirect. Baking
-- `CHECK (org = 'gaiadabali')` into this table would repeat exactly that mistake one layer down —
-- the day the org changes again, every row would need a migration instead of a resync. `org` is
-- free text, supplied by the crawl, because GitHub is the source of truth for it (§5.1).
--
-- ── WHY `latest_run_status`/`latest_run_conclusion`/`visibility` ARE NOT ALL CHECK-CONSTRAINED ──────
-- `approval_channel` (202608261100) is CHECK-constrained because Gaiada owns that vocabulary — "an
-- invented channel is a channel no query will find." GitHub Actions run status/conclusion are NOT a
-- vocabulary this estate owns; GitHub has already added values to both enums over time (e.g.
-- `waiting`, `action_required`), and §5.1's own rule is "GitHub is truth for repo facts" — a CHECK
-- that rejects a real GitHub value on the day GitHub ships a new one would make the sync job fail
-- LOUDLY at exactly the moment "GitHub is truth" is supposed to hold. Left as free text, nullable
-- (most of the 221 repos have no Actions history at all — §3 measured only 7/221 with any Actions
-- secret). `visibility` gets a light CHECK: GitHub's three values (public/private/internal) have been
-- stable for years and this is a much smaller, much more load-bearing surface (visibility drives
-- what the UI is allowed to say about a repo) — the trade-off runs the other way there.
--
-- ── SYNC (§5.3) OWNS THIS TABLE'S FRESHNESS, THIS MIGRATION ONLY BUILDS THE SHAPE ───────────────────
-- `last_synced_at` exists so a stale row is VISIBLY stale (§5.2) rather than quietly wrong — the
-- crawl/webhook/reconcile machinery that keeps it current is GH-06/07, out of scope here. This
-- migration's job is to make staleness a queryable fact (indexed) and archived a first-class,
-- indexed state (113 of 221 repos measured archived on 2026-08-31 — half the table, not a footnote).

CREATE TABLE github_repos (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES companies(id),

  -- ── identity (§5.2) ────────────────────────────────────────────────────────────────────────────
  org            text NOT NULL,                 -- GitHub org login, e.g. 'gaiadabali'. Not
                                                 -- CHECK-constrained — see header.
  name           text NOT NULL,                 -- repo short name
  full_name      text NOT NULL,                 -- 'org/name', GitHub's own canonical identity string
  html_url       text NOT NULL,

  -- ── GitHub facts (§5.2) ────────────────────────────────────────────────────────────────────────
  visibility     text NOT NULL DEFAULT 'private'
                 CHECK (visibility IN ('public', 'private', 'internal')),
  -- First-class, not an afterthought: 113/221 repos measured archived 2026-08-31 (51%). Plain
  -- boolean, indexed below — this is a state the UI partitions on, not a rare edge case.
  archived       boolean NOT NULL DEFAULT false,
  topics         text[] NOT NULL DEFAULT '{}',

  -- ── source state (§5.2) ────────────────────────────────────────────────────────────────────────
  default_branch text NOT NULL,
  -- Nullable: GitHub returns null head_sha/head_committed_at/head_author for a genuinely empty repo
  -- (created, never pushed to) — treating that as an error would be wrong, it is a true fact.
  head_sha             text,
  head_committed_at    timestamptz,
  head_author          text,                    -- free-form "Name <email>", as GitHub's commit API gives it

  -- ── CI state (§5.2) ────────────────────────────────────────────────────────────────────────────
  open_pr_count        integer NOT NULL DEFAULT 0 CHECK (open_pr_count >= 0),
  latest_run_status     text,                   -- GitHub Actions run status vocab — see header, no CHECK
  latest_run_conclusion text,                   -- GitHub Actions run conclusion vocab — see header, no CHECK
  latest_run_at         timestamptz,

  -- ── release state (§5.2) ───────────────────────────────────────────────────────────────────────
  latest_release_tag   text,
  deployed_ref          text,                   -- e.g. a deploy-workflows artifact branch (§2.2); free text pointer

  -- ── the ERP link (§5.2) — NULLABLE ON PURPOSE, an unlinked repo is a finding, not an error ───────
  webdev_site_id uuid,
  project_id     uuid,

  -- ── freshness (§5.2) ───────────────────────────────────────────────────────────────────────────
  repo_created_at timestamptz NOT NULL,          -- GitHub's repo creation time (a GitHub fact, not this row's)
  pushed_at        timestamptz,                  -- nullable: null on GitHub for a repo with zero pushes
  last_synced_at   timestamptz NOT NULL DEFAULT now(),

  origin_site    text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,

  -- Composite FKs make cross-tenant linkage structurally impossible — same pattern webdev_sites
  -- (202608300747) uses for its own project_id FK, reusing the id_tenant unique constraints both
  -- tables already carry.
  CONSTRAINT fk_github_repos_project      FOREIGN KEY (project_id, tenant_id)      REFERENCES projects (id, tenant_id),
  CONSTRAINT fk_github_repos_webdev_site  FOREIGN KEY (webdev_site_id, tenant_id)  REFERENCES webdev_sites (id, tenant_id),

  -- Offered proactively for GH-07/GH-08/GH-10 (webhook reverse-mapping, BFF, write arm) to compose
  -- their own composite FKs against this table exactly as webdev_sites does against projects.
  CONSTRAINT ux_github_repos_id_tenant UNIQUE (id, tenant_id)
);

-- THE partial-unique-index trap, applied (see header). Scoped to org — not tenant — because
-- full_name is a GitHub-level fact (§5.1: "GitHub is truth"), independent of which ERP tenant a row
-- happens to be assigned to today.
CREATE UNIQUE INDEX ux_github_repos_org_full_name
  ON github_repos (org, full_name) WHERE deleted_at IS NULL;

-- The two partition queries the §5.4 surface actually runs: "what does this tenant have" filtered by
-- archived state (half the table either way), and "what is unlinked" as its own bucket.
CREATE INDEX idx_github_repos_tenant_archived
  ON github_repos (tenant_id, archived) WHERE deleted_at IS NULL;
CREATE INDEX idx_github_repos_tenant_project
  ON github_repos (tenant_id, project_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_github_repos_tenant_webdev_site
  ON github_repos (tenant_id, webdev_site_id) WHERE deleted_at IS NULL;
-- The unlinked bucket (§5.4): a repo with NEITHER link. A plain index on the two nullable columns
-- would not serve this query well (most rows have at least one NULL, so it is not selective); this
-- partial index targets exactly the "both NULL" predicate the UI's unlinked view issues.
CREATE INDEX idx_github_repos_unlinked
  ON github_repos (tenant_id)
  WHERE project_id IS NULL AND webdev_site_id IS NULL AND deleted_at IS NULL;
-- Staleness (§5.2: "a stale row must be VISIBLY stale") — lets a sweep or a UI badge cheaply find
-- the oldest-synced rows for a tenant without a full scan.
CREATE INDEX idx_github_repos_tenant_last_synced
  ON github_repos (tenant_id, last_synced_at) WHERE deleted_at IS NULL;

ALTER TABLE github_repos ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_repos FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON github_repos FOR ALL
  USING (tenant_id = ANY(app_current_tenants()))
  WITH CHECK (tenant_id = ANY(app_current_tenants()));

COMMENT ON TABLE github_repos IS
  'GH-05 / blueprint §5. One row per GitHub repo GitHub reports for the org; GitHub is truth for the '
  'repo facts (existence, visibility, head, CI, release), the ERP is truth for the project/site link '
  'and for who did what (§5.1). CORE table (tenant isolation only, no module wall) because it is '
  'linked from webdev_site_id AND project_id, not owned by one module — same reasoning as '
  'integration_connections (0033). Half the rows are expected archived; that is normal, not stale.';

COMMENT ON COLUMN github_repos.archived IS
  'A first-class GitHub state, not a proxy for staleness. 113/221 repos measured archived 2026-08-31 '
  '(51%) — an archived row with a fresh last_synced_at is a CORRECT sync, not a problem to chase.';

COMMENT ON COLUMN github_repos.last_synced_at IS
  'When the crawl/webhook/reconcile sweep (GH-06/07, not this migration) last confirmed this row '
  'against live GitHub. A stale value must read as stale in the UI (§5.2) rather than quietly wrong '
  '— this column is what makes that a queryable fact instead of an assumption.';

COMMENT ON COLUMN github_repos.webdev_site_id IS
  'The ERP link (§5.2), nullable. An unlinked repo (this AND project_id both NULL) is a legitimate '
  'finding to surface — either a site nobody registered or a repo nobody owns — never an error '
  'state. See idx_github_repos_unlinked.';

COMMENT ON COLUMN github_repos.project_id IS
  'The ERP link (§5.2), nullable — see webdev_site_id. A repo may link to a project with no '
  'webdev_sites row (e.g. a library, not a hosted site) or to neither.';

COMMENT ON COLUMN github_repos.full_name IS
  '"org/name", GitHub''s own canonical identity string. Unique among LIVE rows via '
  'ux_github_repos_org_full_name (a PARTIAL index, not a plain UNIQUE — see the migration header for '
  'why a plain one across a soft-deletable table would not have worked).';

COMMENT ON COLUMN github_repos.org IS
  'GitHub org login as reported by GitHub, e.g. ''gaiadabali''. Deliberately NOT CHECK-constrained to '
  'one value — §3 already recorded the cost of assuming an org identity is permanent (gaiadabali is '
  'a NEW org, not a rename, and old-org URLs now hard-404 with no redirect).';

COMMENT ON COLUMN github_repos.latest_run_status IS
  'GitHub Actions run status, verbatim from GitHub. No CHECK: this is GitHub''s vocabulary, not '
  'ours, and it has grown new values over time. Nullable — most repos have no Actions history '
  '(§3 measured 7/221 with any Actions secret).';

COMMENT ON COLUMN github_repos.latest_run_conclusion IS
  'GitHub Actions run conclusion, verbatim from GitHub. Same no-CHECK reasoning as latest_run_status.';
