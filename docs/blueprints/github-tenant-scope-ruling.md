# GitHub tenant scope — where org-wide GitHub data is visible, and how

> **Status:** RULING (architect, 2026-09-02) — design decision only, no code shipped with this doc.
> Implementation tickets are `PLANNED` (§9). Basis: `origin/main` @ `93c7dddd`
> (1.0.0-alpha.325) + live reads against gda-aicenter `gaiada_platform` on 2026-09-01/02.
> **Owner sign-off wanted on:** §8 Q1–Q3. Everything else is decided here.
>
> Companion to [`github-integration-foundation.md`](./github-integration-foundation.md) — this doc
> CLOSES the consequence that blueprint flagged at its §5.2 ruling (line 531: *"⚠ Owner
> confirmation wanted on one consequence: this makes the repo list visible only within the Gaiada
> tenant"*). That consequence is now a measured live defect: the owner lands on the holding tenant
> and the entire GitHub surface reads empty.

---

## §0 · The ruling, in five sentences

1. **The data stays where it is**: every org-wide GitHub row (`github_repos`,
   `github_webhook_deliveries`, the `github_app` rows in `integration_connections`) keeps
   `tenant_id` = **Gaia Digital Agency**, the operating company that owns the `gaiadabali` org —
   reaffirming the three recorded rulings that already say so.
2. **RLS is not touched**: `app_current_tenants()` keeps flat equality; no policy changes; no
   hierarchy expansion anywhere in the database (option (b) is disqualifying — it would silently
   change the meaning of **231 policies on 229 tables**, measured live; §4).
3. **The fix is option (c), hardened**: the GitHub BFF surface resolves an **effective org
   tenant** — the already-existing `config.githubRepoSync.tenantId` — authorizes the caller
   **against that tenant** in Cerbos, verifies it shares the caller's `root_company_id` (same-root
   guard, mirroring MON-00b Wall 1), and only then runs `withTenants([orgTenant])`.
4. Result: the registry and its writes behave identically from **any company context in the same
   root** for principals who have reach into the org-owning tenant (hansel has an active agency
   membership, so the holding-root landing page shows all 221 repos), while cross-root callers,
   client principals, and same-root staff **without** org-tenant reach are refused — refused, not
   shown a lying empty list.
5. The **Connections tab is not widened**: it stays per-company by the 0033 locked owner decision,
   and `owner=me` stays exactly as it is (its emptiness for hansel is **correct** — the `user` row
   belongs to `web@gaiada.com`); the org's App-connection *health* surfaces through the GitHub
   surface itself via a new resolver-scoped read (GHT-2), never through the generic connections API.

---

## §1 · Established facts this ruling stands on

Live (gda-aicenter, `gaiada_platform`, read-only, 2026-09-01/02):

| Fact | Value |
|---|---|
| Company tree | 3 live companies, ONE root: `D & A Syrowatka` (holding, root = itself), `Gaia Digital Agency` (agency), `Viceroy Bali` (resort) — both children carry `root_company_id` = the holding id |
| `github_repos` | 221 rows, all `tenant_id` = agency (`019fb652-c68b-728f-b779-04465fcec5ae`) |
| `github_webhook_deliveries` | 273 rows, all agency |
| `integration_connections` github | 3 live rows, all agency: 1 `owner_kind='user'` (`web@gaiada.com`), 2 `owner_kind='github_app'` (`gaiada-erp`, `gaiada-agents`) |
| RLS proof | as `platform_app` with `set local app.current_tenant_ids`: agency → 221 rows; holding → **0 rows** (flat equality, no rollup) |
| hansel | `home_company_id` = holding (lands there); active memberships in **both** holding and agency |
| `app_current_tenants()` callers | **231 policies / 229 distinct tables** reference it (`pg_policies`, qual or with_check); **184** of those also compose `app_module_allowed()` |
| `companies` RLS | **none** — zero `pg_policies` rows; the hierarchy is readable in any context |

Repo (all at `93c7dddd`):

- Function: `platform-nest/migrations/0025_rls_empty_set_hardening.sql:28-38` — GUC → `uuid[]`,
  empty/unset → NULL → zero rows, fail-closed. The comment names it "the authorized-tenant-set",
  and names a second consumer: **sync-engine-go sets the same GUC** under `sync_app`
  (`sync-engine-go/internal/db/db.go`).
- GUC establishment: `platform-nest/src/db/index.ts:107-142` — `withTenants(tenantIds)` is the ONE
  place the set is set (`set_config` at :130); MON-00b **Wall 1** (:116-129) refuses any set
  spanning two `root_company_id` trees unless the call site declares `crossRoot.reason`.
- The endpoints: `platform-nest/src/core/github-repos.controller.ts` — every route authorizes
  `{kind:"github_repo", tenantId}` with the **URL tenant** and runs `withTenants([tenantId])`
  (list :119/:133, detail :154-155, link :184/:194, unlink :234/:241, creation-requests :275).
- Cerbos: `platform-nest/cerbos/policies/resource_github_repo.yaml:78-105` — read/link/unlink
  gated on `variables.inTenant && variables.notLow`; `_variables.yaml:7` defines `inTenant` as
  membership containment; `:29-31` defines `inRoot` over `rootCompanies`
  (anchored on `users.home_company_id` per MON-00a, `202608201326_mon00a_root_anchor.sql:1-28`).
  Principal assembly: `platform-nest/src/rbac/principal.ts:312-373` (`companies` = active
  memberships ∪ client_contacts; `rootCompanies` = every company under the staff anchor's root).
- The org-tenant knob **already exists**: `platform-nest/src/config.ts:496-511` —
  `GITHUB_ORG` and `GITHUB_REPO_SYNC_TENANT_ID` ("set once by ops at deploy time to the id of the
  company that owns the gaiadabali GitHub org", NO DEFAULT EVER, name-lookup explicitly rejected as
  the rename trap). The webhook receiver already refuses to run without it
  (`github-webhook.controller.ts:85-92`) and stamps every write with it (:103, :119-129). The 221
  live rows exist **because this env var is set to the agency id on the server**.
- Recorded tenancy rulings this doc must not (and does not) contradict:
  - `github-integration-foundation.md:524` (§5.2): *"`tenant_id` = the operating company that owns
    the GitHub org (Gaiada), always."*
  - `github-integration-foundation.md:301` (§2.3-c): the org-wide credential lives in the same
    operating company, *"the same ruling as §5.2's… every function still takes `tenantId` as a
    parameter rather than resolving a 'home company' internally."*
  - `github-repos.controller.ts` header: *"`tenant_id` NEVER MOVES ON LINK/UNLINK (binding
    ruling)."*
  - `0033_integration_connections.sql:12-20` (owner's locked decision, verbatim): connections are
    *"PER-COMPANY (RLS-consistent)… There is NO cross-tenant / holding-wide path."*
- The UI is innocent: `platform-ui/src/app/(app)/departments/[deptId]/repositories/page.tsx`
  fetches with the **active** tenant (`getActiveTenant`, :39) and renders refusal vs empty
  distinctly (`githubRepos-data.ts:11-13`). The GitHub chip on the pipeline card reads the
  **viewer's own** connection (`owner:"me"`, page.tsx:52/:78) — a different question from "is the
  org's App healthy", conflated today (§5).
- Documentation gap found while reading: `githubRepos-data.ts:2` cites
  `docs/FRONTEND-BFF-CONTRACT.md §25`, but **no §25 exists** in the contract at `93c7dddd`
  (sections end at §24 plus unnumbered IAM/Finance blocks). GH-08's contract section was never
  written. GHT-5 owns it.

One root cause, two symptoms: the GUC set is always exactly the URL tenant, the rows are stamped
agency, so any non-agency context reads zero — on the repositories page AND on the Connections tab.

---

## §2 · The question

One GitHub org (`gaiadabali`) serves the whole group. Where should org-wide GitHub data be visible,
and how?

**Answer: org-wide GitHub data is visible from anywhere in the org-owning company's root tree,
gated by the viewer's Cerbos reach into the org-owning tenant — implemented as an explicit
effective-tenant resolution at the BFF layer, with tenancy, RLS, and the credential vault
untouched.** A GitHub org is a group-level *asset* with a single accountable *operating owner*;
the ERP models the owner as tenancy (already ruled, three times) and must model the group-level
reach as authorization — not by moving the rows, and not by re-defining what "tenant" means for
229 tables.

---

## §3 · The mechanism (what GHT-1 builds)

One resolver, applied to all five `:tenantId/github/*` routes in
`github-repos.controller.ts` (list, detail, link, unlink, creation-requests) plus the new
org-status read (GHT-2):

```
resolveGithubOrgTenant(requestTenantId):
  org = config.githubRepoSync.tenantId          // the existing knob, aliased in config as the
                                                // org-owner anchor; empty => UNCONFIGURED
  if org == "":            return UNCONFIGURED  // reads: explicit "no GitHub org registered"
                                                // state; writes: 503. Never a fake empty list.
  if org == requestTenantId: return org         // fast path, no query
  // companies carries NO RLS (verified live) — readable in any context:
  same_root = SELECT c1.root_company_id = c2.root_company_id
                FROM companies c1, companies c2
               WHERE c1.id=$1 AND c2.id=$2
                 AND c1.deleted_at IS NULL AND c2.deleted_at IS NULL
  if !same_root (or either row missing): return NOT_IN_THIS_ROOT   // treated exactly like
                                                                   // UNCONFIGURED. Never served.
  return org
```

Then, per route, in this order:

1. `authorize(req.principal, { kind: "github_repo", tenantId: ORG, ...}, action)` — Cerbos is
   asked about the tenant that **owns the rows**, not the URL tenant. `inTenant` therefore means
   "has reach into the org-owning company", which is the honest question. No new resource
   attributes are introduced (Cerbos resource attrs are an allow-list — an attr not added to
   `rbac/cerbos.ts`'s `Resource` type silently vanishes; we add none).
2. `withTenants([ORG])` — a single-tenant set, so MON-00b Wall 1 is never even exercised; the
   same-root guard in the resolver reproduces Wall 1's property at the one new place a tenant
   substitution happens.
3. Response meta (list + detail + org-status): `org: { login, tenantId, tenantName }` — so the UI
   can say *"GitHub org gaiadabali — registered to Gaia Digital Agency"* instead of implying the
   registry belongs to the active company, and can aim its `can()` mirror checks at
   `org.tenantId`.

Consequences, stated:

- **hansel at the holding root sees all 221 repos** (agency membership ⇒ `inTenant` at ORG passes;
  GUC = agency ⇒ RLS matches). Same result from the agency context. Same person, same answer,
  any same-root vantage — an org-wide surface behaving like one.
- **Behavior change to pin:** a same-root principal **without** org-tenant reach (e.g. a
  Viceroy-only member) today gets `200 {repos: [], total: 0}` (authorized at their own tenant,
  RLS-empty); after GHT-1 they get **403**. That is more honest — they may not read the org
  registry — and the UI already renders refusal and emptiness as distinct states
  (`githubRepos-data.ts:11-13`, the "empty list is a CLAIM" rule). QA case, not a bug.
- **Cross-root:** a second root's principals resolve NOT_IN_THIS_ROOT and see the explicit no-org
  state; the agency's registry is structurally unreachable from a foreign root even if a future
  mis-set env pointed there — the same-root guard refuses before any query runs.
- **Client principals:** unchanged — `isClientOnly` principals match no rule on this kind
  (structural exclusion, `resource_github_repo.yaml` header), regardless of resolution.
- **Writes:** link/unlink run against ORG, so the composite FKs
  (`202608310735_github_repos_registry.sql:125-126`) keep refusing any site/project that is not the
  org tenant's — from every vantage. `creation-requests` (:275) files its `automation_approval`
  into ORG, which **fixes a latent misfiling**: today a filing from the holding context would land
  the approval in the holding tenant, where no agency `company_admin` inbox would ever surface it
  and where the D14 decider set is wrong. The webdev provision seam
  (`erp-repo-control-provider.ts`, WSK-D33) already files under the site's tenant (= agency) and
  needs no change.
- **Failure modes stay loud:** unset env ⇒ the same "misconfigured" refusal family the webhook
  receiver already has (`github-webhook.controller.ts:85-92`); an empty string can never become a
  zero/default (the config comment's own NO-DEFAULT-EVER ruling holds).

Why the mapping stays in config rather than a new table: `config.ts:497-506` records the decision
freshly and with reasons (ops-set id, name-lookup rejected, no default); the env var is set and
proven live (221 rows exist because of it); and a second mapping home would be a second thing to
disagree with the first. The day the estate has a **second GitHub org or a second root**, the
mapping must be promoted to data — that trigger is recorded as GHT-7, deliberately unscheduled.

---

## §4 · Rejected options, each with the reason it lost

### (a) Re-stamp org-wide rows at the holding root — REJECTED

- **It cannot be done without destroying the links.** `github_repos` carries composite FKs
  `(project_id, tenant_id) → projects(id, tenant_id)` and `(webdev_site_id, tenant_id) →
  webdev_sites(id, tenant_id)` (`202608310735:125-126`). Every linked row's project/site lives in
  the **agency** tenant; re-stamping `tenant_id` to the holding root violates those FKs unless
  every link is first severed or `projects`/`webdev_sites` move too. The schema itself vetoes this.
- **Mirror-image blindness.** Flat equality then hides the registry from every agency-membership
  principal without a holding membership — i.e. the actual web-dev staff who work these repos
  daily. "Fixing" that by handing staff holding memberships widens their reach on *everything*
  holding-scoped: a real escalation bought to solve a display problem.
- **It contradicts three recorded rulings** (§1 list): blueprint §5.2, blueprint §2.3-c, and the
  controller's binding header. Those rulings encode a true fact — the org is the agency's operated
  asset; client identity rides the link, not the tenancy — and nothing in the live evidence makes
  that fact false. (Flagged explicitly: choosing (a) would mean overriding standing decisions,
  and there is no cause to.)
- Plus mechanical cost for nothing: crawl/webhook config repoint, a 221+273-row backfill (under
  §7's GUC-stamping discipline), and every future sync write re-aimed.

### (b) Teach `app_current_tenants()` (or the policies) parent→descendant rollup — REJECTED, DISQUALIFYING

This is the crux, so it is stated with the measured number: **231 policies across 229 tables**
compose their `USING` *and* `WITH CHECK` from `app_current_tenants()` (live `pg_policies`,
2026-09-01). By live table-name prefix: `finance_*` 51 (ledger, AP/AR, treasury, consolidation),
`hr_*` 43 (records, payroll, recruitment, compensation), `search_*` 27, `social_*` 17, `pm_*` 13,
`lms_*` 13, `monitor*` 12, `report*` 8, `assistant_*` 6, `webdev_*` 4, `it_*` 4,
`position*`/`org_*`/`service_*` (the IAM Phase-2 grant machinery itself) 9, `pipeline_*` 3, plus
`integration_connections` (the credential vault), `invoices`, `employees`, `work_activity*`,
`client*`, `github_*`, and the remaining core singles. 184 of the 231 also carry the
`app_module_allowed()` wall — reshaping the tenant term reshapes the module wall's reach with it.

Making that one function expand descendants would, in a single stroke:

- **Grant every holding-context request read over every child company's finance ledger, HR and
  payroll rows, credential-vault rows, and IAM grant tables.** Not the GitHub surface — everything.
- **Grant writes, not just reads.** These policies are `FOR ALL`; the same expression sits in
  `WITH CHECK`, so a parent-context handler could INSERT/UPDATE rows *into* descendant tenants.
- **Silently change a second service.** sync-engine-go sets the same GUC under `sync_app`
  (0025's own comment; `sync-engine-go/internal/db/db.go`) — its reconciliation scope would widen
  without a line of its code changing. `modules/search/providers/cache.ts:157` sets it too.
- **Contradict the 0033 locked owner decision** ("NO cross-tenant / holding-wide path" for
  connections) and double-grant what Finance deliberately models as explicit materialization
  (the consolidation ledger writes parent-visible rows *at* the parent — `202608251530` — precisely
  because rollup-by-policy was not the chosen semantics).
- **Invert the estate's fail direction.** Today the GUC under-shows on mistakes (zero rows);
  expansion makes it over-show on mistakes — the wrong way to fail for the value that is "the
  single point of failure for the root boundary" (`db/index.ts:116-118`).
- Cost tail: the helper is a deliberately inlinable, table-free `STABLE` SQL function
  (0025:28-32); expansion adds a `companies` walk to statements against 229 tables, and re-opens
  essentially the whole RLS estate for re-test (the `platform-nest/src/rbac/` 812-test battery
  plus every `module-*-rls.test.ts`).

**Verdict: not acceptable at function level under any qualifier.** A scoped variant — expansion
inside `github_repos`' own policy only — fails smaller but still fails: it forks the estate's
single tenant-isolation idiom for one table, leaves the Connections symptom unexplained, and
encodes "parent membership ⇒ child data" as a *database* rule when the estate everywhere else
keeps reach decisions in Cerbos plus the handler-computed set.

### (c-ii) Descendant expansion computed per-request at the BFF (`withTenants([:t ∪ descendants])`) — REJECTED in favour of the chosen (c-i)

Closer — it uses the GUC as designed (the set is already plural; 0025 anticipated "computed,
possibly-empty tenant sets"). But it answers the wrong question: it encodes **"standing at a
parent grants the child's data"** generally for whatever the transaction touches, gives
inconsistent answers by vantage (visible from holding, invisible from Viceroy, for the same person
with the same agency reach), and authorizes at `:t` while reading other tenants' rows — Cerbos
never gets asked about the tenant whose data actually flows. (c-i) asks Cerbos exactly the right
question ("may you act on the org-owning tenant's GitHub surface") and gives one answer from every
same-root vantage.

### UX-only ("switch company to Gaia Digital Agency" banner) — REJECTED as the whole fix

Cheap, and GHT-3 keeps a variant of it (the org meta banner names the registered owner). But alone
it institutionalizes the wrong model: the GitHub org is group infrastructure, and requiring a
context switch to see group infrastructure would reproduce this ticket for every future org-wide
asset. It also leaves `creation-requests` misfiling from non-agency contexts (§3).

### Materialized projection at the root (finance-consolidation style) — REJECTED

Duplicating 221 registry rows at the holding root creates a second copy GH-06/07 must keep in
sync, against the blueprint's own §5.1 warning ("a registry that drifts from GitHub is worse than
no registry"). Consolidation earns that cost for accounting semantics (parent-owned derived
facts); a mirror of a mirror earns nothing.

---

## §5 · The Connections tab, and `owner=me` — same root cause, different verdicts

- **The tab is correct and stays per-company.** `integration_connections` tenancy is the 0033
  locked owner decision (:12-20). At the holding root the tab truthfully shows the holding's
  connections — there are none. This ruling adds **no** cross-tenant path on the generic
  connections API; the `github_app` rows are additionally unreachable through it in either
  direction by design (blueprint §2.3-b correction: the `owner=` selector has no `github_app`
  branch, and `CLIENT_CREATABLE_OWNER_KINDS` excludes it on the write side).
- **The org's App health belongs to the GitHub surface**, resolved like everything else: GHT-2
  adds `GET /api/:t/github/org-status` → resolver → Cerbos `github_repo read` at ORG → the two
  `github_app` rows' `status` / `externalAccount` / `meta.appSlug` / `tokenExpiresAt` + a
  `hasToken` boolean, **never** ciphertext (the WSUX-12 non-exposure rule holds unchanged). The
  repositories page's GitHub chip then means "the org's ERP App is linked and healthy".
- **`owner=me` is not a bug and must not be widened.** The one `owner_kind='user'` GitHub row
  belongs to `web@gaiada.com`; for hansel, `owner=me` returning nothing is the truth. The page's
  chip conflating "my personal GitHub link" with "the org's App" (page.tsx:52/:78) is a UI framing
  issue GHT-3 fixes by *splitting* the two readings — not by widening `me`.

---

## §6 · Scope of visibility: client-linked repos at the holding root

**Whoever may read the org registry sees all of it — including client-delivery repos.** Reasons:

- Every row is the agency's asset (§5.2 ruling); client identity rides `webdev_site_id` → the
  site's client record, not tenancy. There is no "client-scoped repo" at the tenancy level to
  filter by.
- The §5.4 surface's value is exactly its completeness: the unlinked bucket and the
  linked/archived partitions are findings over the WHOLE org (`idx_github_repos_unlinked`).
  A vantage-dependent subset would turn "the unlinked bucket is empty" into a lie — the
  "empty list is a CLAIM" rule applies to buckets too.
- Estate zoning (client production on helios, staging on delphi) is **hosting topology**, not
  repo tenancy: those repos still live in `gaiadabali` and deploy via the pull-model
  `deploy-workflows` bridge (blueprint §2.2). Zoning changes nothing about who may see a registry
  row.
- **Client exposure is unchanged and stays closed**: `isClientOnly` principals structurally match
  no rule on `github_repo`; if a client should someday see their own repo's build status in the
  portal, that is the blueprint's own recorded answer — "an explicit projection over the site
  link — never a tenancy change on this table" (§5.2 caveat). Blueprint Q5 (client-infra repos
  entering the registry) stays open and is unaffected by this ruling.

---

## §7 · Migration / backfill implications

**None required.** That is a load-bearing virtue of this ruling: the live data (221 + 273 rows,
3 connection rows) is already stamped correctly per the standing rulings; the org→tenant mapping
already exists as live server config; no DDL, no policy DDL, no backfill, and no Cerbos policy
change in the mandatory path (GHT-1..5). Consequently there is **no Cerbos restart-ordering
concern** (nothing changes policy) and no deploy-order coupling beyond an ordinary code ship.

For the two optional arms:

- **GHT-6** (group_executive read) is a Cerbos policy + bundle change: Cerbos **must be restarted**
  after the policy lands (running ≠ current — verify the decision after restart, not the health
  endpoint), and the pinned bundle/parity tests move (§10).
- **GHT-7** (promote mapping to data, trigger-gated): its backfill would read FORCE-RLS tables and
  therefore MUST stamp the GUC first —
  `PERFORM set_config('app.current_tenant_ids', (SELECT string_agg(id::text, ',') FROM companies WHERE deleted_at IS NULL), true)`
  — because an unset GUC yields ZERO rows silently and the backfill "succeeds" having read nothing
  (the estate's documented migration-backfill trap). It must also abort-not-guess on ambiguity
  (0 or >1 distinct owning tenants ⇒ RAISE), mirroring MON-00a's abort condition.

---

## §8 · Open questions — genuinely the owner's

| # | Question | Default until answered |
|---|---|---|
| Q1 | Should `group_executive` (global grant, zero memberships, root-anchored via `home_company_id`) read the org registry? GHT-6 would add `read` gated `inRoot` — the same shape `resource_activity.yaml:22` already uses for global oversight. Today they are denied; this ruling does not change that. | Not granted (GHT-6 stays parked) |
| Q2 | Repo-creation approvals now consistently file into the **agency** tenant, so the decider set is agency `company_admin`s. Is that the intended governance, or should group-level (holding) admins decide repo creation? If the latter, that is a D14-routing design change, not a tenancy change — it gets its own ticket. | Agency company_admins decide |
| Q3 | Blueprint Q5 (do client-infra-hosted repos enter the registry as unlinked?) — untouched by this ruling, still open. | Stays open |

---

## §9 · Implementation plan — tiered tickets

Sequencing: GHT-1 → (GHT-2, GHT-3) → GHT-4; GHT-5 alongside GHT-1. GHT-6 owner-gated. GHT-7
trigger-gated, unscheduled. All `PLANNED`.

### GHT-1 — Effective org-tenant resolution on the GitHub BFF surface
**Seat:** senior-be · **Model: opus·medium** — bounded diff, but it swaps the authorization target
and the RLS GUC away from the URL tenant on a tenancy boundary; a mistake here is a cross-root
read, and a cheap first pass that gets the authorize/resolve order or the same-root guard subtly
wrong wastes a full re-run.
**Deps:** none.
**Scope:** `config.ts` alias (`githubOrgTenantId` reading `GITHUB_REPO_SYNC_TENANT_ID`; comment
updated to name both consumers; env var NOT renamed — the server env is live and stale-env rollback
is a documented footgun), resolver per §3, applied to all five existing routes in
`github-repos.controller.ts`, response meta `org{login, tenantId, tenantName}` on list + detail.
No Cerbos policy change, no DDL, no new `Resource` attrs.
**Done when:**
- From a holding-context request by a principal with agency reach: list returns the seeded
  registry and `meta.org.tenantId` = the configured org tenant.
- Same-root principal WITHOUT org-tenant reach: **403** on read (was `200 []`) — pinned as a
  deliberate change.
- Second-root tenant in the URL: no-org state on reads, 503-family on writes; **zero** queries
  against `github_repos` executed (the resolver refuses before `withTenants`).
- Unset `githubOrgTenantId`: explicit UNCONFIGURED state, never an empty-list 200.
- `creation-requests` files the `automation_approval` row with `tenant_id` = ORG from any
  same-root vantage.
- `db/github-repos-rls.test.ts` (17) passes UNCHANGED — proof RLS was not touched.

### GHT-2 — `GET /api/:t/github/org-status`
**Seat:** medior (seat default).
**Deps:** GHT-1.
**Scope:** resolver-scoped read of the two `github_app` rows via `integrations.service.ts` direct
service calls; returns `{apps: [{slug, status, externalAccount, tokenExpiresAt, hasToken}], org}`;
Cerbos `github_repo read` at ORG. No generic-connections-API change; `CLIENT_CREATABLE_OWNER_KINDS`
untouched.
**Done when:** the response never contains `access_token_enc`/`refresh_token_enc`/PEM material
(extend `core/github/egress-inventory.test.ts` and the `wsux12-security-gate.test.ts` probes);
holding context shows the same status agency context does; a Viceroy-only persona gets 403.

### GHT-3 — UI: the registry is an org surface, and the chip stops conflating
**Seat:** senior-fe (seat default).
**Deps:** GHT-1 (meta), GHT-2 (chip).
**Scope:** `OrgRegistry`/`GithubRepoRegistry` (page.tsx:137/:180/:221) consume `meta.org` and
render "GitHub org `gaiadabali` — registered to Gaia Digital Agency"; the `can()` mirror checks
for link/unlink aim at `meta.org.tenantId` (today they aim at the active tenant); split the GitHub
chip — org-App health from GHT-2, viewer's personal link stays `owner:"me"` with an empty state
that says "you have no personal GitHub link", never "GitHub is not connected"; explicit no-org and
refused states (reuse `ReadRefusal`/`EmptyNote`; the two must not look alike).
**Done when:** at the holding root as the owner the registry renders the full org with the banner;
as a Viceroy-only persona the page shows a refusal, not an empty registry; `owner=me` emptiness
renders as the personal-link state. (Playwright persona helpers: `platform-ui/e2e/personas.ts`.)

### GHT-4 — QA gate
**Seat:** qa (seat default). **Deps:** GHT-1..3.
Matrix: {holding, agency, Viceroy, second-root fixture} × {member-with-agency-reach, agency-only
member, holding-only member, client contact, platform_admin, no-role} × {list, detail, link,
unlink, creation-request, org-status}. Adversarial: denial probes MUST use uuid-shaped tenant ids —
the `tenant-param.ts` hook 400s malformed ones BEFORE auth, and a non-uuid "denial" test silently
stops testing authz (the estate's validation-preempts-authz trap). Assert the `200 [] → 403` flip.
Live drill (server, not local — local greens do not count): `scripts/sso-login.sh` as hansel →
`GET /api/<holding-id>/github/repos` expect `total=221` + org meta; bearer against platform-nest
directly (the public `/api/` path 307s to `/login` and reads as a broken route). Full-suite
discipline: 5 env vars + 3 containers (463/463 when complete; a missing var reads as a code
regression); in agent worktrees export all 3 test env vars (the vitest phantom-file trap).

### GHT-5 — Documentation debt this ruling settles
**Seat:** junior (seat default). **Deps:** GHT-1 merged (the contract must describe shipped shape).
Write the missing **§25** in `docs/FRONTEND-BFF-CONTRACT.md` (GH-08 endpoints + GHT-1 resolution
semantics + `org` meta + GHT-2 — the section number the code already cites at
`githubRepos-data.ts:2`); amend `github-integration-foundation.md` §5.2's "⚠ Owner confirmation
wanted" caveat to point at this ruling; index this doc in `docs/BLUEPRINTS.md`; changelog entries
per component rules (authors append their own; NEVER delegate changelog appends to a subagent).
**Done when:** the `§25` citation in `platform-ui/src/lib/githubRepos-data.ts` resolves to a real
section; the blueprint caveat names this file.

### GHT-6 — (owner-gated, Q1) `group_executive` reads the org registry
**Seat:** senior-be (seat default). **Deps:** GHT-1, owner "yes" on Q1.
Add to `resource_github_repo.yaml` a `read` rule for `group_executive` gated on `inRoot` per the
estate's existing global-grant shape (`rootCompanies` anchored via `home_company_id`, never a
membership — MON-00a/00c). Cerbos restart required; verify the decision post-restart.
**Known movers:** `role-permission-bundles.json` (+1 pair) ⇒ `role-permission-parity.db.test.ts`
pinned counts; `rbac/cerbos-github.test.ts` matrix (+cases); possibly `iam-215-boundary-pin.test.ts`
if the boundary set is enumerated there. Catalog counts do NOT move (no new kind, key, or action).

### GHT-7 — (trigger-gated, unscheduled) promote the org→tenant mapping to data
**Trigger:** a second GitHub org, or a second company root, enters the estate. Until then this is
recorded intent, not work. Shape when triggered: `companies.github_org` (nullable text, partial
unique across live rows — a plain UNIQUE on a soft-deletable table is the estate's documented
NULL-defeats-UNIQUE trap) or a `github_orgs` registry table; resolver + crawl + webhook receiver
read it; the env knob retires. Backfill per §7 (GUC stamped, abort-not-guess).

---

## §10 · Test and verification plan — what moves, what must not

**Must move (the change's evidence):**
- `platform-nest/src/core/github-repos-http.test.ts` — every route now resolves; the harness gains
  a `githubRepoSync.tenantId` stub; new holding-context / sibling / second-root / unconfigured
  cases.
- `platform-ui/src/lib/githubRepos-data.test.ts`, `githubRepos.test.ts` (and
  `demoGithubRepos.test.ts` if the demo fixture gains org meta) — response meta shape.
- `platform-nest/src/rbac/cross-root-boundary.db.test.ts` — extended with the resolver's
  second-root refusal (the new tenant-substitution point gets the same adversarial coverage the
  GUC chokepoint has).
- New: resolver unit tests; `core/github/egress-inventory.test.ts` +
  `wsux12-security-gate.test.ts` extended for GHT-2's response.

**Must NOT move (non-regression pins; a diff here means the implementation exceeded this ruling):**
- `platform-nest/src/db/github-repos-rls.test.ts` (17) — RLS untouched.
- `platform-nest/src/core/github-webhook.db.test.ts` — receiver tenancy unchanged.
- `rbac/cerbos-github.test.ts` and the five pinned catalog/bundle suites —
  `cerbos-catalog-alignment.test.ts`, `permission-groups-catalog-parity.test.ts`,
  `role-permission-parity.db.test.ts`, `ui-grantable-catalog.test.ts`,
  `iam-215-boundary-pin.test.ts` — GHT-1..5 add no kind, no action, no key, no bundle pair.
  (GHT-6, if taken, moves the bundle/parity pins — enumerated in its own ticket.)

**Live verification (status caps at DEV-VERIFIED only when driven on the server):** re-run the §1
RLS probe unchanged (agency 221 / holding 0 — proving RLS is still flat); then the GHT-4 drill
through the real HTTP surface from both vantages; then the repositories page in a browser as the
owner at the holding root.

---

*Ruling authored 2026-09-02 against `93c7dddd`. File paths are repo-relative; line numbers are as
of that commit.*
