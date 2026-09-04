# Site consolidation ledger

**Status: PLANNED.** The generator (`scripts/webdesk-consolidation-ledger.sql`) has not been run
yet. This document has zero real rows in it by design — see "How to read this honestly" before
you fill any in. Design basis: `docs/blueprints/webdesk-design-v2.md` §04 (domain model), §07 (the
adoption ladder and the consent gate), §12 (rollout P1-P6), WSK-D30/D31/D35.

## WSK-D35 (2026-09-04) — domain is the key, client_id is an attribute

Two owner rulings, implemented this turn. The design doc's decision log records WSK-D35 as the
authoritative statement of the ruling text — this section says only what changed in the two
artifacts this ticket owns (the migration and this ledger), not the ruling itself.

**The defect.** `search_properties` carried `UNIQUE (tenant_id, client_id, domain)` (0034), which
permits the SAME domain under TWO DIFFERENT clients — directly contradicting WSK-D31's own words
("one domain, one property row, one consent gate, one crawler"). The symptom: §04's join of
`webdev_sites.domain` to `search_properties` on `(tenant_id, client_id, domain)` can never match a
`webdev_sites` row with `client_id IS NULL` (nullable there, 202608300747) against
`search_properties.client_id` (NOT NULL, 0034) — exactly the live state of the two Hostinger
cPanel/WHM VPS rows (`interlacenetwork.com`, `cosmedic.bimcbali.com`), imported pending owner
assignment.

**The fix, in two artifacts:**

1. **Schema** — `platform-nest/migrations/202609040149_search_properties_domain_key.sql` adds a
   partial, case-insensitive unique index, `ux_search_properties_tenant_domain` on
   `(tenant_id, lower(domain)) WHERE deleted_at IS NULL`. It does **not** touch the existing
   `(tenant_id, client_id, domain)` constraint — additive only, per the DROP+ADD lesson in
   `202608311000_integration_connections_github_app_owner_kind.sql`'s header (a DROP+ADD on a
   shared constraint silently re-declares it from whatever list the author happens to know, and
   has already deleted a value another migration added, live). The migration guards its own
   precondition with a `RAISE EXCEPTION` naming every duplicated domain, rather than surfacing a
   bare index-violation error.
2. **Reporting** — `scripts/webdesk-consolidation-ledger.sql`'s primary join is now
   `(tenant_id, lower(domain))`, promoted from what used to be a secondary diagnostic. The retired
   `(tenant_id, client_id, domain)` comparison becomes a **data-quality check** (Section 3B): a
   disagreement between the registry's `client_id` and the joined property's `client_id` is now a
   real, detectable inconsistency, not a structural join impossibility.

**Second ruling — the sentinel internal client.** Internal sites (the "ours" bucket) get a sentinel
`clients` row rather than a second monitoring path, so they are first-class in the SEO/monitoring
flow WSK-D31 already built. Specified as a ticket below (not an INSERT — see why).

**Follow-up raised, not fixed here:** `search_properties.domain` has **no stored-lowercase CHECK**
(verified against 0034 and every later migration touching the table — see "Follow-ups" below).
`webdev_sites.domain` does (202608300747). The new unique index's `lower(domain)` closes the gap
functionally; a CHECK would be a live-table behaviour change beyond this ruling's scope.

## What this is

`webdev_sites` went from 32 to roughly 78 rows across several survey sessions (Nexus import,
Hostinger VPS + shared-hosting surveys, `helios`). Until now that growth has been reported as one
number under one label — "legacy / pre-system" — which answers "how many" and nothing else. This
ledger is the burn-down that replaces that label: **one row per site, with a bucket (who has to
consent), a target adoption rung, and exactly one named primary blocker**, generated from the live
registry rather than asserted by memory of the survey sessions that populated it.

**The one-line definition of "consolidated" this ledger serves:** `origin` stops predicting
anything about a site — capability is a function of `adoption` and `access` only, and nothing in
any console, report, or decision branches on which tool (Nexus import, manual entry, our own
provisioning) created the row. A site is consolidated when knowing its `origin` tells you nothing
you couldn't already read off `adoption` and `access`.

## The three buckets

Bucket is about **who must consent**, which is why it is tracked separately from `adoption` (how
much of WebDesk a site uses) and from `host_kind`/`access` (who owns the machine) — §07 already
keeps those two independent for the same reason: consent, adoption, and hosting are three
different questions that happen to correlate on most rows but must not be collapsed into one.

| Bucket | Consent rule | Notes |
|---|---|---|
| **Ours** | Not a question. These must also **never appear in a client-facing monitor** — that direction of leakage (an internal scaffold showing up as if it were a client property) is the actual risk, not the reverse. | The `*.hostingersite.com` project-staging rows, the blank colour-animal auto-scaffolds, and internal `*.gaiada.online`/`*.gaiada1.online`/`*.gaiada2.online` apps. This is the safe first adoption wave — no ask required before doing anything to these. |
| **Client, managed by us** | Comes from the **active management engagement** (owner ruling): we already manage the site, and the client seeing their own monitoring record is a reason *to* consent, not a risk to guard against. | Cannot even be **selected** into this bucket until `client_id` is backfilled — it is NULL today on at least the two Hostinger-VPS rows (`interlacenetwork.com`, `cosmedic.bimcbali.com`). The schema has no direct "engagement is active" flag on `webdev_sites`; the generator approximates this bucket using `access <> 'none'` (see "What the schema cannot express" below). |
| **Client-owned, not managed by us** | Still needs an **explicit ask**. Nothing is probed while `search_properties.verified_at` is null — MON-01's "verified rows only" rule (§07) is load-bearing, not a suggestion. | Approximated using `access = 'none'` — we hold no operational credential for the host, which is the closest available signal to "no relationship with this site today." |

A fourth state falls out of the schema and is worth naming even though the prompt that started
this ledger only asked for three: **pending client assignment** — `client_id` is NULL and the
domain does **not** match an internal pattern, so the row cannot yet be sorted into bucket 2 vs 3
at all. This is not "ours" (it's a real client domain, e.g. the two Hostinger-VPS rows) and it is
not yet either client bucket. It is its own blocker (`client_id_null`, see below), ranked first
precisely because nothing else about the row can be decided until it resolves.

## Target-state policy, per bucket and per `kind`

The adoption ladder (§07): `tracked` → `linked` (one WebDesk service, own hosting; kills web3forms
first, no rebuild) → `adopted` (content served from `/v1`, a real Zone B tenant) → `mandated`
(every new project, enforced at scaffold). Adoption is independent of who owns the host — `/v1` is
HTTPS with a scoped key, so a site on a client's own cPanel can be `linked` or fully `adopted`;
what a client-owned host costs is deploy automation, never the platform itself.

- **`kind = wp` adopts LAST, on purpose, and its ceiling is `linked` for now.** This is not a
  deferred phase of the same migration every other kind gets — it is a **permanent platform
  tier**: WordPress sites stay on Hostinger permanently (§12 P5, "Headless WP — permanent tier, not
  a deferred phase"). Reaching `adopted` for a WP site requires the headless-WP conversion, which
  does not exist yet and is sequenced deliberately last in the rollout. Until then, `linked` (one
  endpoint — forms — with no rebuild) is the honest, reachable target.
- **`kind = static` / `kind = fullstack`** in the **Ours** or **Client, managed by us** buckets can
  target `adopted` once their blockers clear — §07 calls this out explicitly: the live sites on
  `delphi` and `helios` are already static/Astro/Vite/Next, so adoption there is a re-point, not a
  rebuild.
- **Client-owned, not managed by us** is capped at `linked` regardless of `kind`, because reaching
  `adopted` needs a deploy channel (built static uploaded over FTP, or equivalent) and `access =
  none` is exactly this bucket's defining fact. A client willing to do their own upload would move
  the row out of this bucket first, not stay in it at a higher rung.
- **`kind` unknown** (unsurveyed stack) has no stated target at all — that absence of a target *is*
  the blocker (`kind_unknown`), not a separate fact to track alongside it.
- **Pending client assignment** has no target either, for the same reason.

## The blocker taxonomy, and who owns each one

Every row gets **exactly one** primary blocker, chosen by a deterministic precedence. The
precedence is ordered so that an OWNER decision always outranks a PROCUREMENT task, which always
outranks an ENGINEERING task — because the expected finding, and the reason this ledger exists, is
that **most of the ~78 rows are blocked on credentials and consent, not on code**:

| Order | Blocker | Owner | Why it outranks what's below it |
|---|---|---|---|
| 0 | *(no registry row at all)* | — | Not produced by the generator — every row it sees already has a registry row by construction. This is Completeness Check, reverse direction (Section 4), and it is manual (see below), because a query against the registry cannot prove the registry is missing something. |
| 1 | `client_id_null` | **Owner** | Nothing downstream — consent target, credential ask, even which of buckets 2/3 applies — can be decided until ownership is assigned. This is a decision only the owner can make, not a lookup. |
| 2 | `consent_not_recorded` | **Owner / Client relationship** | Only evaluated once a client is known, and never fires for the **Ours** bucket. Asking for credentials or doing engineering work before consent exists is the wrong order regardless of how ready everything else is. |
| 3 | `no_vault_credential` | **Procurement / Ops** | `access` says we are *supposed* to be able to reach the host, but `vault_ref` — a pointer, never the secret itself (WSK-D30 rule 2) — is missing. Getting the actual credential into the vault is an ops/procurement task, not a code change. |
| 4 | `kind_unknown` | **Engineering (survey)** | A quick look at the site (what serves it, what framework) rather than a design decision — cheap, but still a task nobody has done yet. |
| 5 | `no_zoneb_target_yet` | **Engineering (build)** | Approximated as `contract_version IS NULL` when the target rung is `adopted`/`mandated`. This is the **only** blocker on this list that is actually blocked on code (§12 P1/P2 — Zone B hardened and proven with one internal site). Ranked last deliberately: it is the rarest reason a site is stuck, not the default one. |
| 6 | `none` | — | Ready for the next rung today. |

If the roll-up in Section 2 of the generator's output shows most rows sitting on blockers 1-3
rather than 4-5, that confirms the premise this ledger was built to test. If it shows the opposite,
that is itself a finding worth surfacing, not a reason to distrust the ledger.

**WSK-D35 re-examination of rank 1.** The domain-key fix removes the reason `client_id_null` used
to block the *join* (a `webdev_sites` row with no client could never reach its own property row at
all under the old key) — so it is worth asking honestly whether `client_id_null` still deserves
rank 1, rather than assuming the old precedence survives unexamined. It does, for two reasons the
join fix does not touch: **bucketing** still routes every non-'ours' row with `client_id IS NULL`
to `pending_client_assignment` (bucket answers "who must consent", and nobody can consent on behalf
of an unidentified client), and **targeting** still returns no target for that bucket (you cannot
choose `adopted` vs `linked` without knowing whether the site is bucket 2 or 3, and that split is
defined BY `client_id`). So the ruling moved *which* downstream step fails on a NULL client — the
join no longer does, bucketing and targeting still do — not whether one does. The generator's
`blocked` CTE (Section 1) carries this reasoning in full as an inline comment, and the ledger's
`has_search_property` / `client_id_mismatch` columns now let you see a row where the join succeeded
(`has_search_property = true`) while `primary_blocker` still reads `client_id_null` — visible proof
the two are independent facts now, not one masking the other.

## What the schema cannot express (found while building this)

- **No "active management engagement" flag on `webdev_sites`.** Bucket 2 vs 3 is defined in terms
  of an engagement, but `webdev_sites` has no such column, and the nearest real engagement record
  (`search_engagements.status`) only exists once a `search_properties` row exists AND has an
  engagement wired to it — a chain most legacy rows don't have. The generator approximates the
  boundary with `access <> 'none'` (do we hold credentials at all). This is a proxy, not the fact
  itself, and should be revisited once engagement data reaches this join.
- **(WSK-D35, RESOLVED)** The strict `(tenant_id, client_id, domain)` join key could not match a
  `client_id IS NULL` row against `search_properties` (`client_id NOT NULL`) — this used to be
  listed here as a schema limitation. It no longer is: the generator's primary join is now
  `(tenant_id, lower(domain))`, so a NULL `client_id` no longer affects whether the JOIN succeeds.
  The retired key survives only as the Section 3B data-quality check (registry `client_id` vs
  property `client_id` disagreement) — see the WSK-D35 section above and the blocker
  re-examination immediately above this list.
- **No cross-zone signal for "does a Zone B tenant exist for this site."** WSK-D30 makes this a
  design invariant, not an oversight: Zone A must never be able to answer that question directly.
  `no_zoneb_target_yet` is therefore approximated via `contract_version IS NULL`, a same-zone proxy,
  and will need re-deriving once §12 P1/P2 actually exist to check against.

## How to run this — precondition, then migration, then ledger, IN THIS ORDER

WSK-D35 adds a schema precondition ahead of the ledger that did not exist before. Run these three
steps **in order**, on the server, against the live database — never interchangeably, and never
skip straight to step 3:

1. **Duplicate-domain diagnostic (precondition).** Run Section 0 of
   `scripts/webdesk-consolidation-ledger.sql` alone (or the equivalent standalone query — see the
   file's own Section 0 header) and confirm it returns **zero rows**. A non-empty result means the
   SAME domain already exists on two or more non-deleted `search_properties` rows under different
   `client_id` values for this tenant — exactly what the new unique index refuses to allow. Resolve
   every one first (reassign to one `client_id`, merge the duplicates, or soft-delete the wrong
   row), then re-run this step until it is empty.
2. **Apply the migration.** `platform-nest/migrations/202609040149_search_properties_domain_key.sql`
   — via the normal migration runner (`npm run migrate` / boot), not by hand. It re-runs the
   identical precondition check itself and `RAISE EXCEPTION`s with the offending domains if step 1
   was skipped or a duplicate appeared between steps 1 and 2 — it does not trust step 1 blindly.
3. **Run the ledger.**
   ```
   psql "$DATABASE_URL" -v tenant_id='<agency-company-uuid>' \
        -f scripts/webdesk-consolidation-ledger.sql
   ```
   Run as the ordinary application role (e.g. `platform_app`), **never** as the migrator/superuser
   — a superuser bypasses RLS and would silently return every tenant's rows instead of this one
   tenant's portfolio. **Run this on the server, against the live database.** This estate's rule is
   that local results do not count: the local 16-container stack is off by owner decision, and the
   portfolio only means anything measured against `gda-aicenter`'s live Postgres. The script is
   read-only (BEGIN/ROLLBACK, no DDL, no temp objects that outlive the session) and prints five
   sections: the duplicate-domain precondition (Section 0, re-runnable any time, harmless after the
   migration has landed), the per-site ledger, the bucket × target × blocker roll-up, and the two
   completeness checks (Section 3/3B, Section 4).

## How to read this honestly

- **An imported row is a LEAD TO VERIFY, never a measurement.** `origin = nexus-import` rows come
  from the 2025 Gaia Nexus corpus, demoted from specification to evidence by the 2026-08-23 ruling.
  `origin = probe` is the only provenance that means "observed from outside, recently." Reading
  this ledger's counts as today's uptime/adoption state — rather than as a work list — makes exactly
  the mistake that ruling exists to prevent: **a 2025 audit must never render as today's status.**
- **This ledger is a snapshot the moment it is run, not a live view.** Re-run it before making a
  decision that depends on its numbers being current; do not quote a run from last week.
- **A row's bucket and blocker are only as good as the columns behind them.** `access = 'none'` is
  read here as "not managed by us," but it is equally consistent with "managed by us and we simply
  never recorded the access level" — the ledger cannot distinguish those from inside the schema
  (see "what the schema cannot express" above). Treat every derived column as a strong prior to
  investigate, not a verdict.
- **The per-site table below is intentionally empty.** Populate it by running the generator on the
  server and pasting its Section 1 output under the header row — never by reconstructing rows from
  memory of the survey sessions that built the registry. A hand-written row here would be exactly
  the "2025 audit rendering as today's status" failure this document exists to prevent.

## Per-site ledger

*Populated by running `scripts/webdesk-consolidation-ledger.sql` on the server (Section 1 output).
Empty until then — do not fill in rows from memory or from the survey notes that built the
registry.*

| domain | environment | client | project | host_kind | host_ref | access | kind | current_adoption | origin | has_repo_url | last_seen_at | last_http_status | has_search_property | property_client_id | client_id_mismatch | consent_verified_at | bucket | target_adoption | primary_blocker |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| *(none yet — run the generator)* | | | | | | | | | | | | | | | | | | | |

## Roll-up (bucket × target adoption × blocker)

*Populated by running the generator's Section 2 output. Empty until then.*

| bucket | target_adoption | primary_blocker | site_count |
|---|---|---|---|
| *(none yet — run the generator)* | | | |

## Completeness

*Populated by running the generator's output, three parts:*

- **Section 3** (registry rows with NO `search_properties` match at all, domain-only — the true
  gap under the WSK-D35 join; previously "3a").
- **Section 3B** (data quality: registry `client_id` disagrees with the joined property's
  `client_id` — a real, detectable inconsistency now that the join is domain-primary; previously
  "3b", and previously undetectable at all for the 'ours'/'pending_client_assignment' rows under
  the old key).
- **Section 4** (the reverse direction — MANUAL, not SQL: vhosts/DNS zones with no registry row at
  all, which no query against the registry can prove by construction. See the generator's closing
  `\echo` block for known leads to check first: `helios`'s `enzocafeubud.com` and
  `clim-pacaservices.fr`, and the legacy box's untracked WordPress/`*.gaiada.online` sites).

## Ticket: the sentinel internal client (WSK-D35, second ruling)

**Status: PLANNED — not implemented anywhere in this ticket.** No migration, no seed, no INSERT
ships with this change. This section specifies the row a follow-up ticket must create, and why it
is a ticket rather than DML in the domain-key migration.

**Why not an INSERT in `202609040149_search_properties_domain_key.sql` (or any migration):**
1. **It touches live client data.** `clients` is a business table, not a schema artifact — creating
   a row in it is an operational decision, not a structural one, and does not belong inside a
   migration whose entire point (per its own header) is "no data changes, no UPDATE, no INSERT."
2. **`clients` is tenant-scoped under RLS.** Migrations run as `platform_owner` with no tenant GUC
   set (`platform-nest/CLAUDE.md`, "the three walls of isolation") — a bare `INSERT` against a
   FORCE-RLS table either fails the `WITH CHECK` loudly on live, or (worse) succeeds silently with
   zero effect if the GUC trap is hit a different way. This is exactly the
   migration-backfill-RLS trap this estate has already been bitten by (unset GUC → zero rows
   touched, no error) — see `lint:migration-rls`'s own header for the confirmed incident class.
3. **It needs an owner-visible name.** A migration cannot decide what the sentinel client is
   *called* in a way a human browsing the client list would recognize as "this is us, not a real
   client" — that is a naming decision, not a technical one.

**What the follow-up ticket must create:**

| Field | Value / rule |
|---|---|
| Table | `clients` |
| Name | Owner-approved, but must be unmistakably internal at a glance — e.g. `Gaiada (Internal)` — never a name that could be confused with a real client in a list view. |
| Distinguishing marker | The row must be **distinguishable, not just present** — client-facing monitoring surfaces must be able to filter it out programmatically, not rely on staff recognizing the name. Verified: `clients` (`0001_core.sql`) has no `is_internal`/marker column today — that flag exists only on `projects` (`0001_core.sql` line 142), which is a different table and does not cover this row. Two options, in order of preference: (a) add a migration widening `clients` with an `is_internal boolean NOT NULL DEFAULT false` column (mirroring `projects`' own precedent) as part of the SAME follow-up ticket that creates the row, so the marker ships with the row it marks; or (b) a documented, tested filter in every client-facing query path (portal reads, MON-01's target generator) that excludes this specific row **by a stable id constant**, never by name-matching. (a) is preferred — a schema column is enforceable and greppable, a filter-by-id constant is a convention that a future query can forget, exactly like the `is_internal`-vs-`client_id IS NULL` disagreement `platform-nest/CLAUDE.md` already records as a live footgun on `projects`. |
| Idempotency | The creating script must be `SELECT ... WHERE name = $1 -> INSERT` (the `ensureCompany()`/`ensureClient()` pattern `platform-nest/CLAUDE.md`'s seeds already use), resolved by name or by a stable, documented identifier — never a bare `INSERT` that creates a duplicate on every re-run. |
| Approver | Owner (this is a new row in a business-facing table, same bar as any other client record). |
| Who runs it | A seed script or an ops-run one-off SQL statement against the live database with the tenant GUC correctly set — **never** a migration, for the three reasons above. |

**Interaction with `search_properties.verified_at` (MON-01's "verified rows only" rule):** for our
own sites, consent is trivially ours to give — there is no external party to ask. **`verified_at`
can and should be set immediately** when a `search_properties` row is created for an internal
site, unlike a client property, where `verified_at` must wait for an actual consent event. This is
stated explicitly here because MON-01's probe generator selects strictly on
`verified_at IS NOT NULL` (`idx_search_properties_probeable`, 202608300818) — an internal site
sitting with `verified_at = NULL` "to be safe" would simply never be probed, silently defeating
the whole point of making internal sites first-class in the monitoring path (the second WSK-D35
ruling's stated rationale).

**Once the sentinel row exists**, every `webdev_sites` row in the **'ours'** bucket gets its
`client_id` backfilled to the sentinel's id (a separate, later data-migration ticket — also not
this one) — at which point `pending_client_assignment`/`client_id_null` stops applying to internal
sites entirely, and the "ours" bucket bucketing pattern-match on domain (see the generator's own
comment on why it uses a domain pattern rather than `client_id IS NULL`) becomes a secondary check
rather than the only signal.

## Follow-up: `search_properties.domain` has no stored-lowercase CHECK

Verified by reading `0034_module_search.sql` (the table's origin) and every later migration that
touches `search_properties` (`202608300818_sm74_property_hosting_topology.sql` and the grep result
across `platform-nest/migrations/` for the table name) directly, rather than assumed:
`search_properties.domain` carries **no** `CHECK (domain = lower(domain))`, unlike
`webdev_sites.domain`, which has carried exactly that CHECK since it was created
(`202608300747_webdev_sites_portfolio_registry.sql`).

The new unique index (`202609040149_search_properties_domain_key.sql`) closes the practical gap
functionally — it indexes `lower(domain)`, so a case-only duplicate cannot slip past it and the
ledger's join is total regardless of stored case. But the underlying inconsistency remains: two
`search_properties` rows differing only by case (`Client.com` vs `client.com`) currently pass every
existing constraint on the table, and any code path that compares `domain` values by simple string
equality rather than through this new index (or an explicit `lower()`) can still be fooled by it.

**Raised, not fixed, in this ticket** — deliberately, per this migration's own scope boundary: a
CHECK constraint on a live table with existing rows is a behaviour change (any row already stored
with mixed case would need normalizing or the CHECK would need `NOT VALID` handling), which is
bigger than what a domain-key join fix should carry. A follow-up ticket should: (1) survey how many
existing `search_properties.domain` values are not already lowercase, (2) if any, migrate them to
lowercase (a genuine backfill, with the tenant GUC set correctly per-row, per the migration-
backfill-RLS trap), and (3) then add the matching CHECK, mirroring `webdev_sites.domain`'s.
