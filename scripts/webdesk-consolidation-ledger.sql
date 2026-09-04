-- webdesk-consolidation-ledger.sql — the site consolidation ledger generator.
-- Design: docs/blueprints/webdesk-design-v2.md §04 (webdev_sites), §07 (the adoption ladder and
-- the consent gate), §12 (rollout P1-P6), WSK-D30/D31/D35. Companion doc:
-- docs/plans/2026-09-04-site-consolidation-ledger.md.
--
-- STATUS: PLANNED. This file has not been run yet. It becomes DEV-VERIFIED only once it has been
-- executed on the server against the live database and its output has been reviewed by a human —
-- never on the strength of this comment block.
--
-- ── WSK-D35 REWORK (2026-09-04) — DOMAIN IS THE KEY, NOT (client_id, domain) ────────────────────
-- Owner ruling: join `webdev_sites` to `search_properties` on `(tenant_id, lower(domain))`, never
-- `(tenant_id, client_id, domain)`. The old key structurally could not match a `webdev_sites` row
-- with `client_id IS NULL` against `search_properties`, whose `client_id` is NOT NULL — exactly the
-- live case for the two Hostinger-VPS rows. `platform-nest/migrations/
-- 202609040149_search_properties_domain_key.sql` adds the schema-side enforcement (a partial unique
-- index on `(tenant_id, lower(domain)) WHERE deleted_at IS NULL`); this file is the reporting-side
-- rework that actually changes the join. The design doc's decision log (WSK-D35) is authoritative
-- for the ruling text — this comment restates only what changed in THIS file's SQL.
--
-- SECTION 0 below is the migration's own precondition and MUST be run, and return zero rows,
-- BEFORE 202609040149 is applied — see "HOW TO RUN IT" below for the full order.
--
-- ── WHAT THIS IS ───────────────────────────────────────────────────────────────────────────────
-- `webdev_sites` (202608300747) plus `search_properties` (0034, widened by 202608300818/SM-74) hold
-- ~78 tracked sites as a flat inventory: current `adoption`, current hosting facts, nothing about
-- WHERE EACH ONE IS HEADED or WHAT IS STOPPING IT. This script turns that inventory into a ledger:
-- one row per site with a derived bucket (who must consent), a derived target adoption rung, and a
-- derived primary blocker — so "legacy / pre-system" stops being one undifferentiated pile and
-- becomes N named blockers, most of which are NOT engineering work.
--
-- `platform-nest/src/modules/webdev/portfolio-reads.service.ts` (`getPortfolio`) already answers
-- "what does the estate currently consist of" — counts by adoption, by environment, grouped by
-- project. This script deliberately does NOT recompute that. It answers a different question, at a
-- different grain: per site, what is the TARGET and what is the ONE thing blocking it today.
--
-- ── HOUSE STYLE NOTE ───────────────────────────────────────────────────────────────────────────
-- `scripts/` has no existing .sql file to match (checked: none present at authoring time; the
-- directory holds .sh/.mjs/.py helpers only). This follows the MIGRATIONS' commenting convention
-- instead — a banner explaining WHY, not just what — plus `\echo` section headers for psql
-- ergonomics, since this is a report meant to be read by a human at a terminal, not applied as DDL.
--
-- ── THIS FILE IS READ-ONLY ─────────────────────────────────────────────────────────────────────
-- No DDL. No INSERT/UPDATE/DELETE. No CREATE TEMP TABLE/VIEW — each SELECT repeats its own CTE
-- chain rather than sharing one through a session-scoped object, so nothing outlives the session
-- even accidentally. The whole thing runs inside BEGIN/ROLLBACK: ROLLBACK is used instead of COMMIT
-- purely to make the "nothing was written" guarantee explicit at the point of use, even though every
-- SELECT in this file has nothing to commit.
--
-- ── RUN THIS ON THE SERVER. LOCAL RESULTS DO NOT COUNT ────────────────────────────────────────
-- This estate's rule (see the program CLAUDE.md / MEMORY "tests-run-on-server-not-local",
-- "local-stack-off-server-is-truth"): the local 16-container stack is OFF by owner decision, and
-- the portfolio only means anything against the live `gda-aicenter` database. Do not run this
-- against a local/dev Postgres and report its numbers as the estate's state.
--
-- ── HOW TO RUN IT ──────────────────────────────────────────────────────────────────────────────
-- 1. On the server, as the ordinary application runtime role (e.g. `platform_app`) — NEVER as the
--    `postgres`/migrator superuser. A superuser BYPASSES RLS entirely, which would silently widen
--    this from "this tenant's portfolio" to "every tenant's rows in these two tables", and the
--    module-scope GUC below would have no effect at all. RLS bypass looks like success and answers
--    a different, wrong question — the same trap as the withGlobal `set_config` no-op documented
--    in platform-nest/CLAUDE.md.
-- 2. This script needs the AGENCY tenant's `companies.id`. It is not hardcoded here on purpose —
--    guessing a UUID and being wrong is worse than refusing to run. Look it up first, e.g.:
--        SELECT id, name FROM companies WHERE name ILIKE '%gaiada%' ORDER BY name;
--    then pass it on the command line so the placeholder below is never silently used:
--        psql "$DATABASE_URL" -v tenant_id='<the-uuid-you-found>' \
--             -f scripts/webdesk-consolidation-ledger.sql
--    Running it with no -v leaves the placeholder in place, which is written so it FAILS the
--    ::uuid cast loudly rather than quietly running as some other tenant.
-- 3. RLS on `webdev_sites` and `search_properties` needs BOTH walls set for the duration of the
--    read (platform-nest/CLAUDE.md, "the three walls of isolation"): the tenant GUC
--    (`app.current_tenant_ids`, read by `app_current_tenants()`) and the module-scope GUC
--    (`app.scopes`, read by `app_module_allowed(mod)`). Omitting either returns ZERO rows with NO
--    ERROR — this is the single most common way this kind of query "mysteriously" comes back
--    empty. Both are set below via `SET LOCAL` inside the same transaction as the reads, exactly
--    the semantics `withTenants(...)` uses application-side.
-- 4. RUN IN THIS ORDER, not interchangeably: (a) SECTION 0 below, alone, as the migration
--    precondition — it must return zero rows; (b) only then apply
--    `platform-nest/migrations/202609040149_search_properties_domain_key.sql`; (c) only then run
--    the rest of this file (Sections 1-4) against the post-migration database. Running Section 0
--    is cheap and non-destructive, so there is no reason to skip straight to (c) "to save a step" —
--    doing so risks reading Section 3B's data-quality output as if the domain-key invariant already
--    held, when it may not yet.
--
-- ── WHAT THIS SCRIPT CANNOT ANSWER (see the companion doc's "how to read this honestly") ────────
-- - It cannot find a vhost or DNS zone that has NO `webdev_sites` row at all — `helios`'s
--   `enzocafeubud.com` and `clim-pacaservices.fr`, and whatever else is running on the legacy box
--   or `helios` outside the ~78 tracked rows, are invisible to a query that only reads the
--   registry. That is the literal definition of "outside the system" and it is a MANUAL step
--   (server vhost audit + DNS zone dump), called out at the bottom rather than faked as a query.
-- - (WSK-D35, superseded) The primary join is now domain-only (`tenant_id, lower(domain)`), so a
--   `webdev_sites` row with `client_id IS NULL` (the "ours" bucket, and the two Hostinger-VPS rows
--   pending owner assignment) matches its property row exactly like any other. What the join can
--   still miss is a domain that HAS NO `search_properties` row at all under any client_id — that
--   is a real gap, not a structural join limitation, and Section 3a below still reports it. The
--   OLD `(tenant_id, client_id, domain)` key is now a data-quality check only (Section 3b): it
--   flags rows where the registry's `client_id` disagrees with the joined property's `client_id`
--   — a real, detectable inconsistency now, where under the old key it was a structural
--   impossibility for one whole bucket ('ours' + 'pending_client_assignment').
-- - There is no "active management engagement" flag anywhere in `webdev_sites`. Bucket 2 vs 3
--   ("client, managed by us" vs "client-owned, not managed by us") is approximated from `access`
--   (do we hold operational credentials at all) rather than from an engagement record, because no
--   such record is wired to this table today. Flagged here and again in the companion doc — this
--   is the one bucket boundary the current schema cannot express directly.
-- - "No Zone-B/public-surface target exists yet" (P1-of-§12 unstarted) is approximated from
--   `contract_version IS NULL`, because Zone A (this table) is DELIBERATELY never told whether a
--   Zone B tenant exists for a site (WSK-D30) — a stronger signal would require a cross-zone read
--   this table must not have.

\set tenant_id 'REPLACE_WITH_AGENCY_TENANT_UUID'

BEGIN;

-- The two RLS walls, SET LOCAL so they die with this transaction/session and can never leak into
-- another query run against the same connection (SET LOCAL semantics = withTenants' contract).
SET LOCAL app.current_tenant_ids = :'tenant_id';
SET LOCAL app.scopes = 'webdev,search';

\echo '=================================================================================='
\echo ' SECTION 0 — PRECONDITION (run BEFORE 202609040149_search_properties_domain_key.sql)'
\echo ' The exact duplicate check that migration''s own guard runs. This section MUST return'
\echo ' ZERO ROWS before that migration is applied.'
\echo ' A NON-EMPTY result means: this tenant already has the SAME domain (case-insensitive)'
\echo ' on two or more non-deleted search_properties rows under DIFFERENT client_id values --'
\echo ' the exact thing WSK-D31/D35''s new domain-primary unique index refuses to allow. Fix:'
\echo ' reassign the rows to one client_id, merge the duplicates, or soft-delete the wrong'
\echo ' one -- then re-run this section until it is empty, THEN apply the migration.'
\echo '=================================================================================='

SELECT tenant_id, lower(domain) AS domain_lc, count(*) AS row_count,
       array_agg(id ORDER BY created_at)        AS property_ids,
       array_agg(client_id ORDER BY created_at) AS client_ids
FROM search_properties
WHERE deleted_at IS NULL
GROUP BY tenant_id, lower(domain)
HAVING count(*) > 1
ORDER BY domain_lc;

\echo '=================================================================================='
\echo ' SECTION 1 — PER-SITE LEDGER'
\echo ' domain, current state, derived bucket / target adoption / primary blocker.'
\echo ' An imported row (origin = nexus-import) is a LEAD TO VERIFY, never a measurement.'
\echo '=================================================================================='

WITH joined AS (
  -- WSK-D35: join search_properties on DOMAIN ALONE (tenant_id, lower(domain)), never
  -- (tenant_id, client_id, domain). The old key structurally could not match a webdev_sites row
  -- with client_id NULL against search_properties, whose client_id is NOT NULL — exactly the
  -- 'ours' bucket and every 'pending_client_assignment' row. lower() matches the functional
  -- unique index the migration adds (search_properties.domain carries no stored-lowercase CHECK,
  -- unlike webdev_sites.domain — see 202609040149's header). client_id is read from BOTH sides
  -- below (s.client_id, sp.client_id) purely as an ATTRIBUTE now, never as part of the join or the
  -- identity of the row — a disagreement between them is a data-quality finding, not a join miss
  -- (see Section 3B).
  SELECT
    s.id, s.domain, s.environment, s.project_id, s.client_id, s.host_kind, s.host_ref, s.access,
    s.kind, s.adoption AS current_adoption, s.origin, s.repo_url, s.repo_branch, s.vault_ref,
    s.contract_version, s.last_seen_at, s.last_http_status,
    cl.name AS client_name, pr.name AS project_name,
    sp.id AS property_id, sp.client_id AS property_client_id, sp.verified_at AS consent_verified_at,
    -- ── BUCKET ──────────────────────────────────────────────────────────────────────────────
    -- 'ours'                          — no consent question; must never appear in a client-facing
    --                                   monitor. Detected by domain PATTERN, not by client_id being
    --                                   null, because a real client domain can also have a
    --                                   temporarily-null client_id (see 'pending_client_assignment'
    --                                   below) and that is a very different situation.
    -- 'client_managed_by_us'         — consent comes from the active management engagement. No
    --                                   engagement flag exists on this table (see header note);
    --                                   approximated as "we hold operational access at all".
    -- 'client_owned_not_managed_by_us' — needs an explicit ask; access = 'none' is the closest
    --                                   schema signal to "we have no relationship with this host".
    -- 'pending_client_assignment'    — client_id is NULL and the domain is NOT an internal pattern:
    --                                   a real site (e.g. the two Hostinger-VPS rows) that cannot
    --                                   even be sorted into bucket 2 vs 3 yet.
    CASE
      WHEN s.domain ~ '\.(hostingersite\.com|gaiada\.online|gaiada1\.online|gaiada2\.online)$'
        THEN 'ours'
      WHEN s.client_id IS NOT NULL AND s.access <> 'none'
        THEN 'client_managed_by_us'
      WHEN s.client_id IS NOT NULL AND s.access = 'none'
        THEN 'client_owned_not_managed_by_us'
      ELSE 'pending_client_assignment'
    END AS bucket
  FROM webdev_sites s
  LEFT JOIN projects pr ON pr.id = s.project_id AND pr.tenant_id = s.tenant_id
  LEFT JOIN clients  cl ON cl.id = s.client_id
  LEFT JOIN search_properties sp
         ON sp.tenant_id    = s.tenant_id
        AND lower(sp.domain) = lower(s.domain)
        AND sp.deleted_at   IS NULL
  WHERE s.deleted_at IS NULL
),
targeted AS (
  SELECT j.*,
    -- ── TARGET ADOPTION ────────────────────────────────────────────────────────────────────
    -- kind unknown -> no target can be stated at all (that IS the blocker, see below).
    -- kind = 'wp'  -> ceiling is 'linked', ON PURPOSE, and permanently for now: WordPress is a
    --                 permanent platform tier that stays on Hostinger (§12 P5), not a deferred
    --                 phase of the SAME migration every other kind gets. Reaching 'adopted' for a
    --                 WP site requires the headless-WP conversion (§12 P5) which does not exist
    --                 yet; that is sequenced deliberately LAST, so 'linked' (forms via one
    --                 endpoint, no rebuild) is the honest near-term target today.
    -- 'ours'                     -> 'adopted' is realistic: no consent question, we hold the host.
    -- 'client_managed_by_us'     -> 'adopted' is the same target once consent + credentials exist.
    -- 'client_owned_not_managed_by_us' -> capped at 'linked': §07 says adoption never requires
    --                 owning the host, but reaching 'adopted' without any operational access on our
    --                 side has no deploy channel by definition (access = 'none' is exactly this
    --                 bucket's defining fact) unless the client does the FTP upload themselves,
    --                 which is a bigger ask than the forms-only 'linked' rung.
    -- 'pending_client_assignment' -> no target until the client_id question resolves.
    CASE
      WHEN j.kind IS NULL THEN NULL
      WHEN j.kind = 'wp' THEN 'linked'
      WHEN j.bucket = 'ours' THEN 'adopted'
      WHEN j.bucket = 'client_managed_by_us' THEN 'adopted'
      WHEN j.bucket = 'client_owned_not_managed_by_us' THEN 'linked'
      WHEN j.bucket = 'pending_client_assignment' THEN NULL
      ELSE NULL
    END AS target_adoption
  FROM joined j
),
blocked AS (
  SELECT t.*,
    -- ── PRIMARY BLOCKER, deterministic precedence (documented in full in the companion doc) ──
    -- "no registry row at all" is NOT a branch here — by construction every row reaching this
    -- query already has one; that state is what SECTION 3's manual step covers.
    --
    -- WSK-D35 RE-EXAMINATION: does client_id_null still rank #1 now that the join is
    -- domain-primary? Re-examined rather than left unchanged, because the join fix's WHOLE POINT
    -- was that a NULL client_id used to block something it should not have (the JOIN itself) — so
    -- the obvious question is whether it still blocks anything real. It does, for two reasons
    -- neither of which the join rewrite touches:
    --   (a) BUCKETING still branches on client_id IS NULL — the CASE in `joined` above still sends
    --       every client_id-NULL, non-'ours' row to 'pending_client_assignment', because bucket is
    --       "who must consent", and nobody can be asked to consent for a client that has not been
    --       identified yet. That is a fact about consent, not about which row search_properties
    --       matched, and the domain-key fix has nothing to say about it.
    --   (b) TARGETING still returns NULL for that bucket ('pending_client_assignment' -> no
    --       target) — you cannot pick 'adopted' vs 'linked' without knowing which of buckets 2/3
    --       the site falls into, and that split is defined BY client_id.
    -- So client_id_null stays #1: it no longer blocks the JOIN (fixed), but it still blocks
    -- BUCKETING and TARGETING (unchanged) — the ruling moved which downstream step fails, not
    -- whether one does. A site can now have has_search_property = true while primary_blocker
    -- still reads client_id_null, which is the visible proof that the join and the blocker are
    -- now two independent facts about the row rather than one masking the other.
    -- 1. client_id NULL           — nothing else (consent target, credentials) can even be asked
    --                                for until ownership is assigned; this is an OWNER decision,
    --                                not engineering, so it outranks everything below it.
    -- 2. consent not recorded     — only meaningful once a client is known; asking for credentials
    --                                or doing engineering work before consent is the wrong order,
    --                                and never applies to 'ours' (consent is not a question there).
    -- 3. no vault credential      — access implies we are SUPPOSED to be able to reach the host,
    --                                but the pointer to the actual credential (never the secret
    --                                itself, WSK-D30 rule 2) is missing; this is a PROCUREMENT/ops
    --                                task (get the credential into the vault), not code.
    -- 4. kind unknown             — an unsurveyed stack; needs a look at the site, not a decision.
    -- 5. no Zone-B target yet     — approximated via contract_version IS NULL when the target is
    --                                'adopted'/'mandated'; this is the one purely ENGINEERING gap
    --                                (§12 P1-P2 unstarted), which is why it is ranked last: it is
    --                                the only blocker on this list actually blocked on code.
    -- 6. none                     — ready for the next rung today.
    CASE
      WHEN t.bucket = 'pending_client_assignment' THEN 'client_id_null'
      WHEN t.bucket IN ('client_managed_by_us', 'client_owned_not_managed_by_us')
           AND t.consent_verified_at IS NULL THEN 'consent_not_recorded'
      WHEN t.access <> 'none' AND t.vault_ref IS NULL THEN 'no_vault_credential'
      WHEN t.kind IS NULL THEN 'kind_unknown'
      WHEN t.target_adoption IN ('adopted', 'mandated') AND t.contract_version IS NULL
        THEN 'no_zoneb_target_yet'
      ELSE 'none'
    END AS primary_blocker
  FROM targeted t
)
SELECT
  domain,
  environment,
  client_name,
  project_name,
  host_kind,
  host_ref,
  access,
  kind,
  current_adoption,
  origin,
  (repo_url IS NOT NULL)     AS has_repo_url,
  last_seen_at,
  last_http_status,
  (property_id IS NOT NULL) AS has_search_property,
  property_client_id,
  -- WSK-D35 data-quality signal (repurposed from the old structural join miss — see Section 3B):
  -- true only when BOTH sides have an opinion and disagree. A NULL on either side is not a
  -- mismatch by itself (that is bucket 'pending_client_assignment' / no property row at all,
  -- both already visible elsewhere in this row).
  (property_id IS NOT NULL AND client_id IS DISTINCT FROM property_client_id) AS client_id_mismatch,
  consent_verified_at,
  bucket,
  target_adoption,
  primary_blocker
FROM blocked
ORDER BY bucket, primary_blocker, domain;

\echo '=================================================================================='
\echo ' SECTION 2 — ROLL-UP: bucket x target adoption x blocker'
\echo ' Every count below is COMPUTED from Section 1''s logic, never hand-entered.'
\echo '=================================================================================='

WITH joined AS (
  SELECT
    s.id, s.domain, s.client_id, s.access, s.kind, s.vault_ref, s.contract_version,
    sp.verified_at AS consent_verified_at,
    CASE
      WHEN s.domain ~ '\.(hostingersite\.com|gaiada\.online|gaiada1\.online|gaiada2\.online)$'
        THEN 'ours'
      WHEN s.client_id IS NOT NULL AND s.access <> 'none'
        THEN 'client_managed_by_us'
      WHEN s.client_id IS NOT NULL AND s.access = 'none'
        THEN 'client_owned_not_managed_by_us'
      ELSE 'pending_client_assignment'
    END AS bucket
  FROM webdev_sites s
  -- WSK-D35: domain-only join, matching Section 1 — see that section's header comment for why.
  LEFT JOIN search_properties sp
         ON sp.tenant_id     = s.tenant_id
        AND lower(sp.domain) = lower(s.domain)
        AND sp.deleted_at    IS NULL
  WHERE s.deleted_at IS NULL
),
targeted AS (
  SELECT j.*,
    CASE
      WHEN j.kind IS NULL THEN NULL
      WHEN j.kind = 'wp' THEN 'linked'
      WHEN j.bucket = 'ours' THEN 'adopted'
      WHEN j.bucket = 'client_managed_by_us' THEN 'adopted'
      WHEN j.bucket = 'client_owned_not_managed_by_us' THEN 'linked'
      WHEN j.bucket = 'pending_client_assignment' THEN NULL
      ELSE NULL
    END AS target_adoption
  FROM joined j
),
blocked AS (
  SELECT t.*,
    CASE
      WHEN t.bucket = 'pending_client_assignment' THEN 'client_id_null'
      WHEN t.bucket IN ('client_managed_by_us', 'client_owned_not_managed_by_us')
           AND t.consent_verified_at IS NULL THEN 'consent_not_recorded'
      WHEN t.access <> 'none' AND t.vault_ref IS NULL THEN 'no_vault_credential'
      WHEN t.kind IS NULL THEN 'kind_unknown'
      WHEN t.target_adoption IN ('adopted', 'mandated') AND t.contract_version IS NULL
        THEN 'no_zoneb_target_yet'
      ELSE 'none'
    END AS primary_blocker
  FROM targeted t
)
SELECT bucket, target_adoption, primary_blocker, count(*) AS site_count
FROM blocked
GROUP BY bucket, target_adoption, primary_blocker
ORDER BY bucket, target_adoption, primary_blocker;

\echo '=================================================================================='
\echo ' SECTION 3 — COMPLETENESS CHECK: registry rows with no search_properties match'
\echo ' WSK-D35: the join is now domain-only (tenant_id, lower(domain)), so this is the'
\echo ' single, primary completeness check — not one of two variants working around a'
\echo ' structural join gap, as it was before the domain-key fix.'
\echo '=================================================================================='

\echo '--- 3a. Domain has NO search_properties row at all (true gap, needs a property row) ---'
SELECT s.domain, s.client_id, s.host_kind
FROM webdev_sites s
WHERE s.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM search_properties sp2
    WHERE sp2.tenant_id = s.tenant_id AND lower(sp2.domain) = lower(s.domain) AND sp2.deleted_at IS NULL
  )
ORDER BY s.domain;

\echo '=================================================================================='
\echo ' SECTION 3B — DATA QUALITY (repurposed from the old structural join-miss check):'
\echo ' registry client_id disagrees with the joined property''s client_id.'
\echo ' Under the OLD (tenant_id, client_id, domain) key this case was structurally'
\echo ' impossible to detect for a whole bucket (a mismatch meant the join simply missed);'
\echo ' under the domain-only join it is a real, detectable inconsistency — TWO rows'
\echo ' describing the same domain disagree about who the client is. Fix by correcting'
\echo ' whichever side is wrong, never by picking one arbitrarily.'
\echo '=================================================================================='
SELECT s.domain, s.client_id AS webdev_sites_client_id, sp2.client_id AS search_properties_client_id
FROM webdev_sites s
JOIN search_properties sp2
  ON sp2.tenant_id = s.tenant_id AND lower(sp2.domain) = lower(s.domain) AND sp2.deleted_at IS NULL
WHERE s.deleted_at IS NULL
  AND (s.client_id IS DISTINCT FROM sp2.client_id)
ORDER BY s.domain;

\echo '=================================================================================='
\echo ' SECTION 4 — COMPLETENESS CHECK, REVERSE DIRECTION — MANUAL, not SQL'
\echo '=================================================================================='
\echo 'Nothing in this database can prove a vhost or DNS zone has NO webdev_sites row --'
\echo 'that absence is precisely what makes it invisible to a query against the registry.'
\echo 'This is the one remaining true "outside the system" category. Known instances at'
\echo 'authoring time (from the surveys that populated the registry, NOT re-verified by'
\echo 'this script — treat as leads, per the origin=probe/nexus-import distinction):'
\echo '  - helios: enzocafeubud.com, clim-pacaservices.fr (in NO registry row at all).'
\echo '  - helios''s nginx access.log is 0 bytes, so "is this vhost still live" cannot be'
\echo '    answered from logs either -- it needs an active probe or a manual check.'
\echo '  - the legacy box''s *.gaiada.online / *.gaiada1.online apps and its four client'
\echo '    WordPress sites -- cross-check against this ledger''s output, do not assume.'
\echo 'To actually close this: enumerate nginx vhosts on helios/delphi/the legacy box AND'
\echo 'the DNS zones Hostinger/Cloudflare hold, then diff that list against Section 1''s'
\echo 'domain column. That diff is a manual step on purpose -- doing it in SQL would mean'
\echo 'this database already contains the answer, which is exactly the problem.'

ROLLBACK;
