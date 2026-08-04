# Gaiada — Module Changelog

Per-module change history. Format follows [Keep a Changelog](https://keepachangelog.com) +
[SemVer](https://semver.org) (all `0.x` — nothing is in production yet). **Append an entry on every
notable module change or commit; bump the version in [`MODULES.md`](./MODULES.md) to match.**

Status vocabulary: `PLANNED` · `IN PROGRESS` · `PROTOTYPED` (dev-only) · `DEV-VERIFIED` (e2e on the
local stack). None of these mean "production-done".

---

## App release log

Every cut app version and the exact module manifest it contains, so any deployed build can be
reconstructed from this table alone. Format defined in [`VERSIONING.md`](./VERSIONING.md).

> **⚠ LOG GAP (noted 2026-08-04).** Tags `alpha-01.009.0028a`, `alpha-01.011.0030a` and
> `alpha-01.012.0031a` exist in git but have **no entry here** — rule 2 ("every app version records its
> module manifest") was skipped by the concurrent sessions that cut them, so those three builds are not
> reconstructible from this file. Not back-filled here because the contents are not known to this
> session; whoever cut them should add them. Related drift found at the same time: the **App version**
> line in `MODULES.md` had been left at `01.005.0021a` — eight releases stale — while `/VERSION` was at
> `01.012.0031a`. Per VERSIONING rule 5 `/VERSION` is authoritative; the `MODULES.md` line is now
> corrected and should be moved with every cut.

### `Alpha 01.015.0036a` — 2026-08-04 — the seed hit its own RLS wall

`portal-workspace.js` ran on the live box and skipped **all five** clients with
*"run seed:agency then the portal-clients seed first"* — immediately after those seeds had printed
those same five clients as succeeding. The prerequisite was fine; the seed was wrong.

`findClient` read `clients` through `withGlobal`, on the reasoning that the seed does not know which
member company serves a client. True, and not a licence to skip the tenant context: `clients` is FORCE
RLS and the seed runs as `platform_app` with `bypassrls = false`, so with no `app.current_tenant_ids`
GUC the policy matched **nothing**. `anyStaffUser` had the same bug over `company_memberships` +
`client_contacts`, which would have left every project unowned — the one thing that function exists to
prevent, since the portal resolves notification recipients from `projects.owner_id`.

Verified against the live catalogue rather than assumed: only **`companies` and `users`** are RLS-free;
`clients`, `client_contacts`, `company_memberships`, `projects`, `invoices` and `contracts` are all
FORCE RLS. Both lookups now go through `withTenants`, searching company by company.

The "skipped" message also blamed only the prerequisite, sending the reader to re-run a seed that had
already worked. It now names both causes and says how to tell them apart — a zero-row RLS read and a
missing prerequisite are indistinguishable from the outside, which is the whole difficulty.

`platform-nest` `0.12.1 → 0.12.2`.

### `Alpha 01.014.0035a` — 2026-08-04 — data to look at, and a lie to a customer

Closes the gap that made the deployed client portal unusable: it was authorized, routed and empty. The
live database had 3 companies and 47 users but **zero clients, projects, invoices or contracts**, and
zero `client_contacts` rows — so all nine `client`-role accounts resolved to 403.

- **`seed/portal-workspace.ts`** — the half of the portal demo `portal-clients.ts` never covered:
  milestones, tasks (they drive every progress %), deliverables with attachments, invoices, the payment
  ledger, and contracts with signatures. Deliberately **uneven across five clients**, because the
  branches that break are the ones no fixture reaches: an overdue milestone, an overdue invoice, a
  partial payment, a payment awaiting verification, a **rejected** payment with a reason, a voided
  invoice, a voided agreement, an agreement countersigned by us and waiting on the client, an agreement
  nobody has signed, a fully-signed one, a **view-only contact who cannot sign**, a delivered item with
  no file, and a settled account. Idempotent; `files` rows are reference attachments (a URL, no
  `storage_key`) because a seed cannot write bytes into the storage volume and a metadata row pointing
  at nothing produces a download that 404s.

- **A false statement to a customer, fixed.** `/portal` answered a 403 from the BFF with "You're signed
  in as a staff member" — but that 403 covers **two** people: a staff member, and a genuine client whose
  contact row does not exist yet or was revoked. Nine real client accounts on the live box would have
  been told they were staff. `isClientOnly(me)` is the discriminator the UI already had; clients now get
  "your portal isn't linked yet — nothing is wrong on your side".

Counter `0033 → 0035`: `platform-nest` `0.12.0 → 0.12.1`, `platform-ui` `0.15.0 → 0.15.1`.

**No npm script was added for the new seed** — `platform-nest/package.json` carries a concurrent
session's uncommitted `seed:departments` line, and staging it would have dragged their work into this
commit. Run it as `node dist/seed/portal-workspace.js`; the script can be added by whoever lands that.

### `Alpha 01.013.0033a` — 2026-08-04 — the client portal

The client side gets its own interface. Contents: the CP-* program — `(portal)` route group (11
routes, own shell), the portal BFF (workspace · commerce · profile · SSE stream), migration `0075`
(`contracts`, `contract_signatures`, `invoice_payments`), the staff contract/payment-confirmation
counterpart, `resource_contract.yaml` + two new `portal` actions, an nginx SSE location block, and an
explicit Cerbos-reload step in `deploy.yml`. Full detail:
[`docs/plans/2026-08-04-client-portal-deployment.md`](../plans/2026-08-04-client-portal-deployment.md)
and §16 of [`../FRONTEND-BFF-CONTRACT.md`](../FRONTEND-BFF-CONTRACT.md).

Counter moved `0031 → 0033`: two modules bumped (`platform-nest` `0.11.1 → 0.12.0`, `platform-ui`
`0.14.0 → 0.15.0`), so the revision letter resets to `a`.

**⚠ This cut carries the first execution of migration `0075` against a real database.** It was
developed with no local Postgres and no Docker daemon available, so it is hand-reviewed but
**never applied anywhere** — and it `ALTER`s four existing tables (`clients`, `projects`, `invoices`,
`files`) to add the composite uniques its tenant-scoped FKs need. The 25-case DB-backed portal
isolation suite has likewise never run. CI is the gate; see the deployment plan §7.

**Module manifest (21 — the full registry):**

| Module | Ver | Module | Ver | Module | Ver |
|---|---|---|---|---|---|
| platform-nest | `0.12.0` | wa-chat-bot | `0.9.2` | webdesk | `0.0.0` |
| platform-ui | `0.15.0` | ai-agents | `0.5.0` | search-marketing | `0.5.0` |
| ai-gateway-go | `0.13.0` | hermes-gateway | `0.2.0` | social-media | `0.0.0` |
| mcp-hub | `0.9.3` | capture-helper | `0.2.0` | creative | `0.1.0` |
| sync-engine-go | `0.7.0` | webdev | `0.10.0` | render-gateway-go | `0.0.0` |
| automation (n8n) | `0.4.1` | reports | `0.3.1` | report-renderer | `0.1.0` |
| observability | `0.6.0` | infra | `0.8.0` | mail | `0.0.0` |

### `Alpha 01.010.0029a` — 2026-08-04 — the team's UI branch, consolidated (manifest recorded after the fact)

Cut by a concurrent session for its client-portal fix. Recorded here because **the same cut also
shipped the whole `reva/ui` consolidation**, which would otherwise appear in no release entry at all:
merge `04459ef` is an ancestor of this cut, so reva's work is inside `platform-ui 0.12.0` rather than
awaiting a version of its own. No second cut was made for it — the work is already versioned; only
the record was missing.

**Branch audit that produced it.** Of five remote branches only `reva/ui` still held unmerged work —
15 commits, 79 files, 59 behind main. `fix/backup-silent-skip-and-n8n-overlay`, `zafir/ui`, `UI` and
`trial/alpha-cut` were already absorbed. **Every remote branch is now `ahead=0`.** That branch never
touched `VERSION` or `MODULES.md`, which is why its work arrived unversioned.

**From `reva/ui`:** a token layer (`styles/tokens/`, 5 files) moving the chart palette out of
component CSS, with light + both dark blocks and the parity test now covering chart colours, and 5
hard-coded colours fixed — including `--erp-ink-40`, which was defined nowhere and had been silently
rendering its `#999` fallback with no dark-mode value. `/calendar` rewritten (personal focus, real
month/week/day grids, explicit "N of yours have no date — not shown here"). PM tasks in a slide-over;
the Gantt no longer re-renders itself to death without a `groups` prop. Dashboard hierarchy, state-
legible inputs, loading feedback, unboxed empty states, one-line page header, KPI tiles that explain
the rule their label hides, a Settings → About page, and a component guide. Plus two real fixes:
**My Work was blind to every PM task** (the queue read core `tasks` while the app writes `pm_tasks`,
and never loaded `lib/pm`'s `statusFlags` — structurally empty while looking healthy), and
**`seal_hash` verified nothing** (`canonicalStringify` mishandled `undefined`, so a freshly-built
document and the same document re-read from JSONB hashed differently; a tamper check that never
reproduces is indistinguishable from one that caught tampering). Main had fixed the seal bug
independently — what reva adds is `report-seal.hash.test.ts`, the regression test it shipped without.

**From the concurrent session:** the client portal could never have shown a client anything, plus
migration `0074` backfilling `pipeline_runs.client_id` from the source meeting.

Merge resolutions for the 10 conflicting files are in `04459ef`. Two worth repeating: `/calendar`
took reva's side wholesale because the rewrite deletes a workload panel `0.10.3` had just repaired —
the rewrite serves that fix's purpose better; and `report-seal.ts` kept main's implementation because
it also closes the `toJSON()` case reva's did not, while keeping reva's test.

Verified on the merge result rather than on either side: both `tsc` clean, `next build` green,
**974 UI tests pass** (945 before — 29 new), CI green on main including the DB suites.

| Module | | Why |
|---|---|---|
| platform-ui | `0.11.0 → 0.12.0` | reva/ui design-system pass + queue PM-task fix; concurrent session's portal fix |
| platform-nest | `0.10.0 → 0.11.0` | concurrent session's portal/pipeline fix + `0074`; reva's `report-seal.hash.test.ts` |

> **Ledger gaps, recorded rather than invented.** Rules 1 and 2 (every notable module change gets an
> entry; every app version records its manifest) are currently unmet for several cuts, across both
> sessions and including my own. Still owed: the **`Alpha 01.009.0028a`** app entry (webdev W0/W1 +
> infra deploy fixes; it moved five modules against a counter that advanced by one); per-module
> entries for **platform-ui `0.10.4`, `0.11.0`** and **platform-nest `0.9.5`, `0.10.0`** — `0.10.4`
> and `0.9.5` are mine, from the `0027a` cut, where I bumped `MODULES.md` without writing the module
> sections. Left for whoever holds the context on each rather than reconstructed from commit messages
> here. Deployed tags are untouched; the consequence is only that counter gaps understate churn.

### `Alpha 01.008.0027a` — 2026-08-03 — a workflow is a principal, not a colleague

HR reported 36 people. 19 were people; **17 were n8n automation service accounts.**

Non-human principals are `users` rows on purpose — authorization is defined over principals, and
`OBO envelope -> identity_links -> users -> user_roles -> Cerbos` is the only path to being
authorized at all. (Proven the hard way the same day: five unseeded `wf:reports-*` accounts made
every reports CRON fail `403 cerbos denied`.) The cost of that design is that "principal" and
"person" are different sets, and every people-shaped surface has to know it.

`company_memberships.kind ('employee','service')` — added by `0026` for the shared-service
reconciler — already existed for this, and `GET /api/:t/members` already filtered on it. Two gaps:

- **Nothing ever set it.** The seed calls `addMembership()`, which never passed `kind`, so all 17
  accounts took the column default `'employee'`. Zero `service` rows existed. `addMembership()` now
  takes `kind`, and the automation seed passes `'service'`.
- **`GET /api/:t/users` had no filter at all** — and that, not `/members`, is what backs the People
  directory and HR. Now employee-only by default with `?includeService=1` to opt in, matching the
  `/members` convention. Settings → Users & Roles opts in and badges the row (that is where
  automation grants get audited and revoked); the directory and HR take the default.

Reconciler-safe: it only deletes rows that are `kind='service'` **AND** `managed_by IS NOT NULL`,
and seeded automation memberships have `managed_by NULL`.

Interim by design. Reusing `company_memberships.kind` overloads one column with two questions —
*why is this principal in this company* vs *what kind of account is this* — and they are independent
axes (a served-company HR manager is a human with `kind='service'`). The owner-approved target is
`users.kind` with **four** kinds — `employee`, `client`, `automation`, `bot` — keeping `bot` distinct
from `automation` because a Hermes persona's next action is not enumerable the way a pinned workflow
allow-list is. Design + migration sketch: `docs/superpowers/specs/2026-08-03-principal-kinds-design.md`.

| Module | | Why |
|---|---|---|
| platform-nest | `0.9.4 → 0.9.5` | `/users` employee-only + `?includeService=1` + `isService`; `addMembership(kind)`; automation seed tags `service` |
| platform-ui | `0.10.3 → 0.10.4` | `listUsers(includeService)`; Users & Roles opts in and badges; directory/HR exclude |

### `Alpha 01.007.0025a` — 2026-08-03 — the ten identical "manager" options were ten real rows

**Corrects the previous release.** `0024a` shipped a tenant-narrowed roles catalog and reported the
duplicate-role-picker bug as fixed. It was not: that change was verified by `tsc` and unit tests,
never against the live symptom. Re-checking the deployed build showed the picker still offering
`manager` ten times, `company_admin` three times and `member` twice.

The cause was not cross-company name collision at all. Every role in the table is GLOBAL
(`company_id IS NULL`), and there were genuinely ten `manager` ROWS. `roles` has carried
`UNIQUE (company_id, name)` since `0001`, which reads as though it protects this — but SQL treats
NULLs as DISTINCT for uniqueness, so `(NULL, 'manager')` never collides with `(NULL, 'manager')`.
Every global role has always been exempt from the constraint that appears to cover it.

The inserter closed the loop: `createRole()` used `ON CONFLICT (company_id, name) DO NOTHING`, whose
conflict target likewise never matched for a global role — so `DO NOTHING` never fired and each run
of the re-runnable seed appended another row. Ten `manager` rows ≈ ten seed runs; the lower counts on
`company_admin`/`member` just mean they joined the seed later.

- Migration `0073` collapses the duplicates and adds `roles_global_name_uniq ON roles (name) WHERE
  company_id IS NULL` — a partial index, which is what `0001` was reaching for.
- **The dedupe repoints before it deletes.** `user_roles.role_id` and `role_permissions.role_id` are
  `ON DELETE CASCADE`, so removing the losing rows first would have silently stripped every grant
  held against them and still reported success.
- `company_memberships.primary_role_id` is repointed per tenant under
  `set_config('app.current_tenant_ids', …)`. The repo's own migration lint caught this: that table is
  FORCE-RLS, migrations run as `platform_owner` (NOBYPASSRLS), so a bare `UPDATE` would have matched
  ZERO rows and committed happily — the exact failure `0050` shipped and `0051` had to repair.
- `createRole()` and `teams.controller.ts`'s check-then-insert now target the partial index, so the
  seed stays idempotent and the previously-silent `team_lead` race resolves instead of duplicating.

The `0024a` roles change is kept: narrowing the catalog to the active tenant is still correct for
per-company roles, which the original constraint DOES protect. It was necessary and insufficient.

| Module | | Why |
|---|---|---|
| platform-nest | `0.9.3 → 0.9.4` | migration `0073` (dedupe global roles + partial unique index); `createRole`/`team_lead` conflict targets corrected |

### `Alpha 01.006.0024a` — 2026-08-03 — the surfaces that reported something untrue

Cut from a full audit of the live site: signed in as a real user and drove all 84 routes under both
companies, so "empty because this tenant has no data" could be told apart from "broken". Every
finding here is a surface that **claimed a state it was not in** — the failure mode that costs the
most trust, because nothing looks wrong.

The audit's own headline was config, not code: `enabled_modules` held `{agency, hr}` on Gaia and
`{}` on Sanur, so eight compiled-in modules were dark. Enabling them (all 10 on Gaia, 9 on Sanur)
lit up clients, billing, reports, appraisals, knowledge, IT and PM with real data — and cleared the
stalled delivery pipeline as a side effect: the WS11 fan-out had been dying on
`/api/:t/pm/projects/:id/docs 404`, which was the PM module being off, not a workflow bug.

- **`Open in n8n` pointed into the compose network.** `detail.n8nUrl` was assigned from
  `services.automation.url` — the in-cluster base (`http://n8n:5678`) the platform calls the Public
  API on. The console reported the service healthy and listed its workflows while offering a link no
  browser could follow. Split into `AUTOMATION_PUBLIC_URL`; absent ⇒ the UI hides the button.
- **The roles picker offered ten identical options.** `GET /api/roles` returned every company's role
  rows, and per-company roles share names, so `manager` appeared ten times with nothing to tell them
  apart — nine of them granting a row owned by another company.
- **HR contradicted itself on one screen.** The scope selector called every company "served" (an
  elevated caller was folded in as a `home` grant) while the envelope beneath it reported those same
  companies "not served".
- **A task you just created vanished.** The default all-companies leg is assignee-scoped, so an
  unassigned task was invisible with no affordance to reveal it.
- **The calendar workload panel demanded a narrowed scope** while all-companies is the default — dead
  for every visitor. Now breaks down by company instead.
- **React #418 on three Systems consoles** — bare `toLocaleString()` renders in the container's UTC
  server-side and the visitor's zone client-side, so React discarded the server HTML. Fixed with a
  fixed-zone `formatTimestamp()`.
- **Staff were told a client project was on its way to them.** The portal BFF 403s "not a portal
  client" for any staff member; the reader folded that into an empty list.
- **The platform read the bot's admin token from a different `.env` name than the bot** — it got an
  empty token, every proxy call 401'd, and the console said "bot admin unreachable" as though the bot
  were down.
- **n8n was proxied on eight ERP root paths** (`/webhook`, `/form`, `/mcp` + variants) because
  `N8N_WEBHOOK_URL` was the bare origin. Narrowed to `/n8n/` only; the first platform-ui route under
  any of those names would otherwise have been silently answered by n8n.

Also found and **not** fixed here, since neither is code: the n8n Public-API key held only the four
read scopes (`workflow:activate` missing ⇒ the ACTIVATE button returned `Forbidden`), and its
replacement was minted with all 72 — over-granted, on the rotation queue. And no client portal user
is provisioned, so that surface is still unexercised end-to-end.

Two corrections to the audit's own first pass, recorded because both were wrong in the same
direction — assuming a missing endpoint: `/rollups` and the services API were probed on the wrong
paths (`/api/rollups` is tenant-less; service assignments live under
`/api/:t/org-structure/service-units`), and the client portal was never broken.

| Module | | Why |
|---|---|---|
| platform-nest | `0.9.2 → 0.9.3` | tenant-narrowed roles catalog; `n8nUrl` split from the in-cluster base via `AUTOMATION_PUBLIC_URL` |
| platform-ui | `0.10.2 → 0.10.3` | six honesty fixes: roles picker, HR scope, tasks empty state, calendar workload, hydration-safe timestamps, portal staff view |
| infra | `0.7.3 → 0.7.4` | platform falls through to `ADMIN_TOKEN` for the bot proxy; n8n triggers no longer squat the ERP root; `AUTOMATION_PUBLIC_URL` wired; `*.local.md` ignored |

### `Alpha 01.005.0021a` — 2026-08-03 — the module switch works in both directions

First cut that carries the IT discovery work (`0.9.0`/`0.10.0`), which was committed but never
tagged — `0015b`'s deploy died mid-`docker pull` on a `connection reset by peer` and auto-rolled back
to `0015a`, so the box has been serving `0015a` while `/VERSION` claimed `0015b`.

Reported as "I disabled a module to see the difference and now it's gone." Both halves were real:

- **The toggle was one-way.** Settings → Modules & Fields rendered `union(["agency"], enabled_modules)`,
  so disabling a module removed the key AND the row that offered to re-enable it. Recovery required
  SQL. The list now comes from the compiled-in catalog.
- **The company edit form silently stripped modules** — it knew only `agency` and sent that derived
  set as `enabled_modules`, so renaming a company dropped `hr`/`reports`.
- **A disabled module looked identical to an empty one.** Nothing outside the settings page read the
  flag, so gated pages stayed clickable and returned nothing. They now say so, and say how to undo it.

Found live on `gda-aicenter`: Gaia Digital Agency held `{agency}` where the seed grants
`{agency, hr, reports}`. `hr` was restored by hand before this cut; **`reports` is deliberately still
off** — the owner was mid-experiment with it.

| Module | | Why |
|---|---|---|
| platform-nest | `0.8.1 → 0.9.2` | IT discovery + device writes (`0.9.0`, previously untagged); module catalog endpoint (`0.9.1`); `enabledModuleKeys` + per-tenant `modules-enabled` (`0.9.2`) |
| platform-ui | `0.6.5 → 0.10.2` | real IT topology + device edit/remove (`0.10.0`, previously untagged); two-way module toggle (`0.10.1`); legible module-disabled state (`0.10.2`) |

### `Alpha 01.005.0015b` — 2026-08-03 — index the tasks people actually use

`0015a`'s first live sweep on `gda-aicenter` ingested 130 sources / 306 chunks with 0 errors, and
the per-table counts matched the sources exactly (projects 5→5, pm_docs 1→1, meetings 3→3) — except
tasks, which produced **nothing**. Not a silent no-op: the core `tasks` table genuinely holds 0 rows.
The PM console writes `pm_tasks`, which held the real backlog of 6.

So the corpus was task-free while looking healthy — exactly the failure the run summary is supposed
to make visible, caught by reconciling its numbers against the source tables rather than trusting
"0 errors".

`pm_tasks` is now indexed alongside the core table (both are real, and a tenant may populate either),
carrying the fields the PM row actually has: description, progress %, milestone, tags, and the JSONB
poly-assignee — rendering BOTH the assigned party (which may be a person, division or department)
and the named responsible human, because "who is doing this?" and "who is accountable?" are
different questions.

| Module | | Why |
|---|---|---|
| platform-nest | `0.8.0 → 0.8.1` | `pm_tasks` source builder in the knowledge ingester |

### `Alpha 01.005.0015a` — 2026-08-03 — knowledge/RAG gets a two-tier corpus and something to retrieve

Status: **PROTOTYPED** (unit- and store-verified; the live sweep on `gda-aicenter` is the
DEV-VERIFIED gate).

The D9 vector store had been correct and completely **empty** since it was built —
`knowledge_chunks` held 0 rows on the server, so every `knowledge.search` returned nothing. It also
had no way to express public company knowledge: `store.search()` returned `[]` for any caller
without a resolved tenant, so a lead or client could never be answered at all.

| Module | | Why |
|---|---|---|
| ai-agents | `0.4.0 → 0.5.0` | D9.4 `audience` tier (`public`/`internal`) in the store + service; `/search` no longer needs an OBO envelope; fail-closed default |
| platform-nest | `0.7.1 → 0.8.0` | the ingestion module: gaiada.com crawler, ERP source builders, sweep scheduler, admin trigger/status endpoints |
| mcp-hub | `0.9.1 → 0.9.2` | `knowledge.search` describes both tiers; `scope` now optional |
| wa-chat-bot | `0.9.1 → 0.9.2` | `/know` no longer claims a verified identity is required for all results |
| infra | `0.7.2 → 0.7.3` | `KNOWLEDGE_INGEST_*` compose wiring |

**Two tiers.** `public` is the gaiada.com corpus, world-readable with no identity at all — that is
what lets an agent answer a lead or client who has no ERP account. `internal` is ERP content
(clients, projects, tasks, deliverables, meeting transcripts, PM docs, latest-revision reports,
files, org structure, people) under the unchanged D9.1 tenant pre-filter. The tier is a SQL
disjunction whose internal branch self-disables on an empty tenant set, so an unauthorized chunk is
never a ranking candidate, and `audience` fails closed — anything not literally `"public"` is
internal, and the in-place column default can only narrow visibility on existing rows.

Notable within the cut:
- **Retirement is gated on a clean run.** The sweep deletes stored sources it did not re-ingest, but
  only if the build succeeded and produced something — otherwise a transient DB error would look
  identical to "everything was deleted upstream" and one bad run would wipe the corpus.
- **Boilerplate is stripped by frequency, not by tag.** The live site's nav is not in a `<nav>`
  element, so tag-stripping alone put the whole menu in the first chunk of every page.
- The store's D9 suite had **never actually run against pgvector** — a 64-d fixture embedder against
  a 768-d column meant it silently only exercised the array fallback. Fixed; 13/13 now pass on real
  pgvector against the server's own cluster.

Dead tags, for the record: `alpha-01.004.0006a` never built (its commit swept in unrelated in-flight
IT-discovery edits whose module file was untracked, breaking `tsc`), and `alpha-01.004.0006b` built
but died at the same backup gate `0014b` fixes. Neither reached the server; this cut supersedes both
and is rebased on `0014b`, so it carries that fix rather than a competing one.

Known limits carried forward: PDF/DOCX bodies are metadata-only by design, and ACL sub-scoping stays
unsafe while `scope` is caller-supplied (see `platform-nest/src/modules/knowledge/README.md`).

### `Alpha 01.005.0014b` — 2026-08-03 — re-cut: the backup gate rejected its own compose project

Identical module set to `0014a` (hence a letter bump, not a counter move — "a re-tag after a failed
deploy" is exactly what the revision letter is for). `0014a` built and signed all 9 images
successfully, then **`deploy` failed at the backup step, before pull/migrate/up — production was
never touched** (containers stayed up 2–3 days; `erp.gaiada.online` served throughout).

```
backup FAILED: cannot read compose project (service pg-bot):
service "platform" depends on undefined service "postgres": invalid compose project
```

`backup.sh` required its CALLER to pass the `hostdata` overlay, and the caller that matters most
never did: `deploy.yml` has `COMPOSE_FILES` in its job env but does not forward it across the
`ssh vps` that runs the script, so the box got the single-file default. On a host-Postgres box the
base file alone is an invalid project. Because the backup is deliberately the **gate for
migrations**, that is a hard stop for the whole deploy rather than a degraded backup.

Sharp edge worth naming: it had backed up cleanly ten minutes earlier. `deploy.yml`'s rsync step
runs **before** the backup, so the box was already holding the newer `vps.yml` when the backup ran
— the failure needed the new compose file and the old call site together.

- **Fix:** `backup.sh` now picks up `docker-compose.hostdata.yml` automatically whenever it sits
  next to the base file, instead of relying on every call site to remember. An explicit
  `COMPOSE_FILES` still wins. This also repairs the **nightly cron backup**, which had the same
  defective invocation. Verified on gda-aicenter: all 5 databases + the WAHA volume, exit 0.
- Folded into `infra 0.7.2` rather than opening `0.7.3`, since `0014a` shipped nothing — keeping
  the module set identical is what makes the letter bump the honest description.

**Rollback is broken for any release that ADDS a service** — flagged, not fixed here. The failure
path ran `up -d` at the previous tag and died on
`ghcr.io/hansel-gaiada/gaiada-report-renderer:alpha-01.004.0005a: not found`, because
`report-renderer` did not exist at that tag. Harmless this time (nothing had changed, so there was
nothing to undo), but a genuine deploy would have been left half-rolled-back. `deploy.yml`'s
rollback needs to roll back only services present in the previous tag.

### `Alpha 01.005.0014a` — 2026-08-03 — SUPERSEDED, no deployment (see 0014b above)

Carries the tracker/multi-grain-reporting programme, the search-marketing SEM/Google-Ads work, the
`report-renderer` sidecar, the in-ERP audio/video recorder, the webdev server fixes, and the n8n
console at `/n8n/`. Ships migrations **0064–0069 + 0072** (the box is at 0063).

> **Migration gap, flagged not fixed:** `0070` and `0071` do not exist in the repo at this commit —
> `0072` was committed while they were still uncommitted in another seat's tree. The runner applies
> unapplied files in filename order, so if `0070`/`0071` land later they will execute *after*
> `0072` has already run. Harmless only if they are independent of it. Worth resolving before the
> next cut rather than discovering it as a failed migration.

**Counter derivation (`0005 → 0014`, +9; letter resets to `a`).** Counted as bump *steps* per rule 3
("don't flatten it by batching bumps into one"), read from the `MODULES.md` registry:

| Module | at `01.004.0005a` | now | steps |
|---|---|---|---|
| platform-ui | `0.7.1` | `0.9.0` | 2 |
| reports | `0.1.0` | `0.3.1` | 3 |
| infra | `0.7.0` | `0.7.2` | 2 |
| search-marketing | `0.4.0` | `0.5.0` | 1 |
| report-renderer | `0.0.0` | `0.1.0` | 1 |

> **Rule-1 debt, recorded not papered over:** the counter had to be derived from the *registry*,
> because the registry and this log have drifted. `platform-ui`'s newest entry here is `0.6.5`
> (2026-07-27) though the registry says `0.9.0`, and `reports` had no section at all until this cut
> opened one at `0.3.1`. The registry is the source of truth per the `infra 0.7.1` numbering note,
> so the derivation follows it. Back-filling the missing entries is outstanding work; inventing
> them from diffs would have been worse than admitting the gap.

**`Alpha 01.004.0006a` — SUPERSEDED, no image.** A concurrent session cut and pushed that tag at
`e901ab9` while this cut was being prepared. Its `release` run failed at
`build-sign (platform-nest)`:

```
src/main.ts(72,38): error TS2307: Cannot find module './modules/it/discovery.service'
```

`main.ts` was committed carrying an import of `discovery.service`, but that file was still
**untracked** in that seat's working tree — a commit referencing a file that was never committed.
`ci` failed on the same commit for the same reason. `deploy` was skipped, so nothing reached the
box. This is the **third** instance of the exact `001` post-mortem failure: snapshotting a tree
another seat is mid-write on. The number is burned, never reused.

Accordingly this cut was taken from **`9d65686`, the last commit with a green `ci`** — which
excludes only `e901ab9` (the knowledge two-tier RAG corpus, plus the half-committed IT-discovery
work). Nobody's uncommitted work was committed to unblock it.

**Full manifest** (all 19 registry rows, so this build is reconstructible):

| Module | Version | | Module | Version |
|---|---|---|---|---|
| platform-nest | `0.7.1` | | webdev | `0.8.1` |
| platform-ui | `0.9.0` | | webdesk | `0.0.0` |
| ai-gateway-go | `0.13.0` | | search-marketing | `0.5.0` |
| mcp-hub | `0.9.1` | | social-media | `0.0.0` |
| sync-engine-go | `0.7.0` | | creative | `0.1.0` |
| observability | `0.6.0` | | render-gateway-go | `0.0.0` |
| infra | `0.7.2` | | reports | `0.3.1` |
| wa-chat-bot | `0.9.1` | | report-renderer | `0.1.0` |
| ai-agents | `0.4.0` | | hermes-gateway | `0.2.0` |
| capture-helper | `0.2.0` | | | |

**Cut discipline.** Taken from a **frozen `git worktree`** (another seat held ~35 uncommitted files
throughout), and `platform-nest` was verified with **`tsc -p tsconfig.build.json`** — the exact
command the Dockerfile runs, and the exact command `01.004.0006a` died on — not `tsconfig.json`.

**Known-unverified at cut time:** `platform-nest`'s live-service suite passed 2560/2560 against real
Postgres/Cerbos/Redis on gda-aicenter, but the in-ERP recorder and the webdev server fixes came from
a concurrent session and were not independently re-driven here.

### `Alpha 01.004.0005a` — 2026-07-31 — trial branch merged back to main

The `trial/alpha-cut` line and `main` rejoin. `main` carried the search-marketing and reports work;
the branch carried everything that made the stack actually deployable and reachable. This cut is
the first that contains **both**.

Three module bumps (counter `0002 → 0005`, letter resets to `a`):

| Module | | Why |
|---|---|---|
| platform-nest | `0.7.0 → 0.7.1` | main's SEO/reports work **+** the branch's `GET /health` version field |
| platform-ui | `0.7.0 → 0.7.1` | main's Google/GSC/rankings/reports panels **+** the branch's SSO-only login and `PUBLIC_ORIGIN` redirect fix |
| infra | `0.6.0 → 0.7.0` | Hermes systemd units, the nginx public edge, GHCR runner auth, bind-mount sync, OIDC plumbing |

Nothing was dropped in the merge: the compose conflict was additive (the branch's OIDC block against
an untouched region on main) and the registry conflict was two sides bumping the same two rows.
Merged compose re-validated to the same 13 services.

**Superseded numbering note:** `0001a` and `0001b` were cut from `main` and produced no image;
`0002`/`0003` were cut from the branch and are what actually runs. The release counter never reuses
a number, so the sequence reads oddly on purpose — it is the honest record of what was attempted.

### `Alpha 01.003.0002a` — 2026-07-31 — SSO-only login page

One module bump (**platform-ui `0.6.5 → 0.6.6`**), so the module-reference counter moves to `0002`
and the revision letter resets to `a`.

The OIDC cutover left the login page showing the dev-login **email box as the primary action**,
with SSO as a secondary link underneath. Under `AUTH_MODE=oidc` that email path is disabled
server-side, so the most prominent control on the page was the one guaranteed to fail — reported
as "login is not working" when SSO itself was healthy throughout.

- `login/page.tsx` + `LoginForm.tsx` — under `AUTH_MODE=oidc`, render SSO alone and surface the
  `?error=` reasons the callback already emits (`sso` / `token` / `provision`), which previously
  went nowhere.
- `auth/callback/route.ts` — build redirects from `PUBLIC_ORIGIN` rather than `req.url`. Behind a
  proxy `req.url` resolves to the container's own bind address, so the callback sent authenticated
  users to `https://<container-id>:3005/`. An nginx `proxy_redirect` was papering over it; the app
  is now correct on its own and that rule becomes defence in depth instead of load-bearing.
- compose — `AUTH_MODE` and `PUBLIC_ORIGIN` passed to platform-ui; neither was set before.

### `Alpha 01.002.0001b` — 2026-07-31 — first deployable build

Cut to bring the trial stack up on **gda-aicenter** (the Hermes/DeepSeek box). Baseline manifest,
so the module-reference counter starts at `0001`.

| Module | Ver | Module | Ver |
|---|---|---|---|
| platform-nest | `0.6.4` ↑ | wa-chat-bot | `0.9.1` |
| platform-ui | `0.6.5` | ai-agents | `0.4.0` |
| ai-gateway-go | `0.13.0` | hermes-gateway | `0.2.0` |
| mcp-hub | `0.9.0` | capture-helper | `0.2.0` |
| sync-engine-go | `0.7.0` | webdev | `0.8.1` |
| automation (n8n) | `0.4.0` | search-marketing | `0.2.0` |
| observability | `0.6.0` | infra | `0.6.0` ↑ |

- **infra `0.5.2 → 0.6.0`** — compose profile lanes (`data`/`bot`/`auth`/`multisite`/`whisper`) and
  the host-data overlay for gda-aicenter, where Postgres+pgvector, Redis and Ollama live on the
  host so other projects can share one cluster. `GATEWAY_TOPOLOGY_MODE` was hardcoded to `central`
  and silently ignored its env var — now honoured, with `GATEWAY_CENTRAL_URL`, which is the switch
  that routes all generation through the Hermes shim. `EMBED_CHAIN`/`OLLAMA_EMBED_MODEL` declared
  (previously absent) so embeddings resolve to nomic-embed-text at 768 dims, matching `vector(768)`.
  Deploy pipeline parameterized by compose file + profiles. Hermes systemd units added.
- **platform-nest `0.6.3 → 0.6.4`** — `GET /health` reports the app version.

**Why `002` and not `001`:** `001` was cut twice (`0001a`, `0001b`) and produced no deployable
image both times. The app release counter never reuses a number, so those attempts keep `001` and
this cut takes `002` — the history stays honest about what was tried.

**What this deliberately EXCLUDES:** the in-flight search-marketing (Google OAuth/GSC/GA4,
provider layer) and reports work, plus migrations `0053`–`0063`. Those seats were writing
continuously, and two cuts in a row captured a file mid-edit — a type error, then a syntax error.
Neither was a defect in their work; both were snapshot artifacts. That work lands as its own cut
once the seats are done, which is exactly what the versioning scheme is for.
### `Alpha 01.001.0001b` — 2026-07-31 — re-cut (build fixes)

Same module set as `0001a`, so the module-reference counter holds at `0001` and only the revision
letter moves — exactly the case the letter exists for. `0001a` never produced a deployable image.

Two failures in the `0001a` release run, both real:

- **platform-nest image failed to build.** `dataforseo.ts(247,42) TS2345: 'string | undefined' not
  assignable to 'string'`. `0001a` snapshotted that file mid-edit while the SEO seat was writing it;
  the seat fixed it moments later. Root cause on our side was the **verification gate**: the cut was
  checked with `tsc` against `tsconfig.json`, while the Dockerfile builds with `tsconfig.build.json`.
  Cuts are now verified with the build config, which is what CI actually runs.
- **SLSA provenance failed for all 8 components** — "Feature not available for user-owned private
  repositories." `actions/attest-build-provenance` needs a public repo or an org plan. Made
  non-blocking; the controls `deploy.yml` **enforces** (cosign keyless signature + attested SBOM)
  both succeeded. This is a genuine reduction in supply-chain assurance, not a formality — remove
  `continue-on-error` once the repo is org-owned.

Registry note: the SEO/tracker seats added `search-marketing` and `reports` to the registry during
this window, so the manifest below is now 20 modules rather than 14.

### `Alpha 01.001.0001a` — 2026-07-31 — first versioned build (SUPERSEDED, no image)

Baseline manifest. Cut to deploy the trial stack onto **gda-aicenter**, the new Hermes/DeepSeek
box, and the first app version to exist at all.

| Module | Ver | Module | Ver |
|---|---|---|---|
| platform-nest | `0.7.0` ↑ | wa-chat-bot | `0.9.1` |
| platform-ui | `0.7.0` ↑ | ai-agents | `0.4.0` |
| ai-gateway-go | `0.13.0` | hermes-gateway | `0.2.0` |
| mcp-hub | `0.9.1` ↑ | capture-helper | `0.2.0` |
| sync-engine-go | `0.7.0` | webdev | `0.8.1` |
| automation (n8n) | `0.4.1` ↑ | webdesk | `0.0.0` |
| observability | `0.6.0` | infra | `0.6.0` ↑ |

**Five module bumps** (↑). Because this is the baseline manifest the module-reference counter
starts at `0001` rather than `0005` — from here it advances by the number of bumps per release.

- **platform-nest `0.6.3 → 0.7.0`** — search-marketing provider layer (DataForSEO, Ahrefs, typed
  dispatch, cost ledger), Google OAuth + GSC/GA4 + search terms + SEM export, a new `reports`
  module with its Cerbos policy, PM task assignees/contributors, dept resolution, last-resort
  exception filter. Migrations `0053`–`0057`, `0060`–`0063`.
- **platform-ui `0.6.5 → 0.7.0`** — Google connections + GSC/GA4 panels, rankings panel, change
  proposals, paid-action gate, PM contributors.
- **mcp-hub `0.9.0 → 0.9.1`** — automation-policy tightening.
- **automation `0.4.0 → 0.4.1`** — SM n8n flows retired (superseded by the platform-side pull
  scheduler); env/README updated.
- **infra `0.5.2 → 0.6.0`** — compose profile lanes (`data`/`bot`/`auth`/`multisite`/`whisper`)
  and the host-data topology overlay for gda-aicenter; `GATEWAY_TOPOLOGY_MODE` un-hardcoded;
  `EMBED_CHAIN`/`OLLAMA_EMBED_MODEL` declared; deploy pipeline parameterized; `APP_VERSION`
  plumbed to `GET /health`.

**Verification at cut time:** platform-nest typecheck clean; platform-ui typecheck + 729 tests
green; mcp-hub typecheck + 106 tests green. platform-nest's suite needs live PG + Cerbos and was
not run locally — it runs in CI.

**Known caveat:** migrations `0058` and `0059` do not exist in the tree. If they surface later they
will apply *after* `0060`–`0062`, which the ledger orders by filename — check before they run
anywhere real.

---

## Program log — module additions

| Date | Event |
|---|---|
| 2026-08-04 | `mail` **design REVISED to v2 the same day it was authored — the owner materially narrowed AND widened the scope; still `0.0.0` PLANNED, no code.** **CUT:** staff notification email is dead (notifications stay realtime in-app); the digest engine (old MAIL-07) and the per-user channel-prefs surface + `mail_notification_prefs` table (old MAIL-08) are **cancelled** — a required approval must reach its decider, so approval mail is not opt-out-able. The owner's 12:00/18:00 WITA cadence is the **WhatsApp/Telegram group rollup** (the bot's existing digest feature), not email — noted out of scope. **Triggers now attach to EXISTING classification, no new classifier:** mail fires only on (a) automation/AI medium+/unclassified writes — exactly the set the WS4 impact gate already suspends into `automation_approvals` — and (b) anything requiring human approval, routed to the resolved decider set (no per-approval decider column exists anywhere — confirmed; resolution mirrors the Cerbos DECIDE sets per origin: `company_admin`/`group_executive`, hr adds the providing unit's `hr_manager`, pipeline client gates use the existing `client-notify.ts` signer resolution — clients ride the SAME path, no separate stream). **D14-aware sequencing:** warning wording ships first for automation/agent origins (approving a suspended write executes NOTHING today — the mail must never imply execution); actionable wording for those origins is gated on the D14 resume path (Temporal decision, out of this program). **Link security locked:** approval mail carries a plain deep link behind SSO — no action buttons, no approve-by-reply, **never magic links** (magic links stay low-risk convenience login only, now an explicit non-goal). **WIDENED:** the module becomes **bidirectional** — inbound system-mail threads (`reply+<token>@notify.gaiada.com` VERP → new `mail_messages` global table, untrusted intake: signature+token auth, size caps, server-side sanitizer, ClamAV quarantine — MAIL-14 is ClamAV's first actual instantiation in the estate) + an ERP mail surface (`/admin/mail` sent-log UI + entity thread panels) + a **staging-ready staff Gmail read surface** (internal-type OAuth app ⇒ no CASA, employees only; per-user OAuth, NO domain-wide delegation; `gmail.readonly`; render-on-demand/cache-nothing so staging never mirrors real mail; tokens in the 0033 vault; state machine = WD-23A-1's staged core `google_oauth_states` — hard dependency, do not duplicate). **Domains locked (supersedes v1 Q1):** `auth.gaiada.com` + `notify.gaiada.com` (Workspace root) + `forms.gaiada.online` (Zone B only, off the employee-mail domain); **Google Workspace SMTP relay becomes Zone A primary** (free with seats, ~10k/day vs a handful/day of actual volume — the free-tier question is moot), Brevo = failover + inbound + Zone B forms; DNS guardrails: never touch root MX/root SPF, MX only on `notify.`, check `_dmarc` `sp=`. Both v1 findings preserved: approvals notify NOBODY on create (now also verified for `agency_approvals`), and NULL-tenant rows under FORCE-RLS are readable by nobody ⇒ mail tables stay GLOBAL. Ledger re-verified: head `0075` ⇒ mail core still `0076` (now incl. `mail_messages`); Gmail CHECK-widening at build-time next-unused (hint `0077`); `0058`/`0059`/`0070` untouched. Ticket plan re-cut: MAIL-01A/01B…MAIL-18 (07/08 dropped, numbers not reused), two Opus flags (MAIL-10 magic links, MAIL-13 inbound intake — both opus·medium). Blueprint `webdesk` → v1.2 (Zone B unaffected; Zone A provider/domain notes). Same docs, revised in place. |
| 2026-08-04 | `mail` **registered at `0.0.0` PLANNED — design only, no code; the ERP currently sends zero email** (no mail module in platform-nest, Alertmanager SMTP vars all empty, Keycloak realm has no `smtpServer`, provisioning sidesteps verification with `emailVerified:true`). New cross-cutting subsystem: [`../superpowers/specs/2026-08-04-zone-a-mail-design.md`](../superpowers/specs/2026-08-04-zone-a-mail-design.md) + ticket plan [`../superpowers/plans/2026-08-04-mail-subsystem-tickets.md`](../superpowers/plans/2026-08-04-mail-subsystem-tickets.md). Owner-locked shape: **sending only** (no mailboxes/IMAP); self-hosted service layer, **rented SMTP hop** (Brevo free tier → ZeptoMail/SES; Hostinger SMTP unpinned — shared-mailbox relay, low caps, can't send as arbitrary domains, VPS port block to verify); **three sending subdomains + three separate provider keys** (`forms.`/`notify.`/`auth.`) so form abuse can never rate-limit employee login mail; `From:` our domain + `Reply-To:` human default with per-tenant custom-domain upgrade; **Zone A mail never routes through webdesk C-03** (trust wall); portal email **digests by default** (immediate only for an approvals/mentions allowlist) riding the existing `notify()`/`notifications` surface; magic links designed now (single-use hashed tokens, always-202 enumeration resistance, `sealSession` coexistence with hybrid SSO+dev-login) but **built last behind a measured p95 delivery SLO** on the auth stream. Design found two real gaps while reading the code: creating an `automation_approvals` row notifies NOBODY today (MAIL-06 adds decider notifications), and NULL-tenant rows under the standard FORCE-RLS policy are readable by nobody at all (owner is NOBYPASSRLS) — which forces the mail tables global (design §6.1). Migration verified against the live ledger: head `0075`, `0058`/`0059`/`0070` claimed/dead ⇒ mail core takes **`0076`** (re-verify at DDL time per README rule 5). 12 tickets MAIL-01…12, one Opus flag (MAIL-10 magic links, opus·medium), blocked at W0 on owner Q1 (subdomain root) + Q2 (provider signup). **Same session: `webdesk` blueprint amended to v1.1** (C-02 recipient-config note, C-03 provider path + reputation split + Zone A separation, new D14, portability row) — HTML only; PDF + hosted artifact not re-rendered. |
| 2026-08-04 | `webdev` **The last four department gaps closed: B2, B6, C1 and the missing demo client. `platform-nest 0.11.0 -> 0.11.1`, `platform-ui 0.13.0 -> 0.14.0`.** **C1** — `GET /pipeline/runs` now accepts `clientId`/`projectId`, so `/pipeline` narrows **server-side**; it previously fetched the 200-row cap and hid rows in the browser, which stops being a filter past 200 runs. Ids compare as **text**, so a hand-edited query string matches nothing instead of 500ing on a uuid cast. The page also stops reconstructing the client from the recordings registry — C4 made the list carry `client_id`, so a run with **no meeting** now shows its client too, and the teach-state that blamed "the list doesn't carry a client id" is corrected to say what a blank now actually means: the run really has no client and will never appear in a portal. **B2** — start a delivery run with no source meeting. Real work does not always begin with a recorded call, and the only prior workaround was fabricating a meeting, which corrupts the capture registry to satisfy a UI limit. `sourceMeetingId` stays **null** deliberately: that is what marks the run human-originated, and it is the dispatcher's dedupe key, so inventing one could collide with a later real ingest. The form REQUIRES a client even though the API permits null — a clientless run can never reach a portal, so creating one here would silently produce invisible work. **B6** — `relink-orphans` was API-only, so recovering meant curling production; now a button, safe to expose because the sweep is idempotent, and it reports **"Nothing to repair"** rather than a silent success. Both live in a collapsed "Recovery tools" panel, worded as recovery: putting "start a run by hand" beside the everyday controls would invite bypassing capture, which is where the transcript, MOM and artifacts all come from. **The demo client identity — the portal was the ONE shipped surface with no demo identity at all**, so `/portal` could not be browsed backend-free even though `DEMO_MODE=1 next build` and the Playwright smoke project both run that way. New `demo-client` (Northwind Traders, the client that actually owns `run-demo-1` — naming it after a different client would show "your projects" for a company the person has nothing to do with) holding **only** the `client` role, plus `portalDemo` served from the SAME runs/stages/gates the staff surface uses, because two fixture sets would let the demo show a client a different reality from the run workspace. It **403s a staff user** exactly as the real BFF does — without that the staff teach-state would be unreachable dead code — filters the internal `report` track in the FIXTURE (where the real BFF filters it, so the guarantee is not vacuous), and 404s another client's run indistinguishably from a nonexistent one. **The dev-login tier resolver moved to `lib/demoIdentity.ts` and got tests, because I had documented ordering as "pinned" when nothing pinned it:** `actions.ts` is `"use server"` and may export only async functions, so the pure helper could not live there. The client test must run BEFORE the IC test — "ic" is an extremely common substring in real names (`erica@`, `nicole@`), and getting the order wrong hands external clients the staff dashboard. **23 new tests** (4 backend filter cases incl. the malformed-id and the exclusion assertion; 13 demo-fixture cases incl. "an unknown clientId returns nothing rather than everything", the failure mode indistinguishable from working; 5 tier-ordering cases; relink idempotency). platform-ui **997/997 across 100 files**, `tsc` + `DEMO_MODE=1 next build` + both nest lint gates clean. ⚠️ The nest DB suites did not run locally (Docker Desktop is down on this machine) — CI executes them on push, as it did for the seed. Docs updated per this repo's own rules: `platform-ui/CLAUDE.md` (tiers, identities, `isClientOnly`) and `FRONTEND-BFF-CONTRACT.md` (C1/B2/B6 + C3/C5 deltas). |
| 2026-08-04 | `webdev` **5 seeded clients across 2 companies VERIFIED live, and a client-routing bug fixed on the way. `platform-ui 0.12.0 -> 0.13.0`.** `seed:portal-clients` ran on gda-aicenter and provisioned 7 Keycloak accounts; each of 6 contacts was then **logged in for real via PKCE** and asserted: sees exactly their OWN run (the exact expected title, so neither a leak nor a broken link passes), sees **only their own company** — the two Sanur Resort contacts see no trace of the agency, which is cross-company isolation shown rather than claimed — gets **403** on `/clients` and `/meetings/recordings`, and gets `['delivery','scope']` from the run detail with the internal **`report` track absent every time**. `ALL CHECKS PASSED`. ⚠️ **My first verification run reported two failures that were my own assertion's fault, not the product's:** it matched the client's first word against the run title, and "Bali Wedding Planners" owns "Wedding microsite" while "Sanur Dive Center" owns "Dive Center". A substring heuristic is not an isolation assertion; it now compares against the exact expected run per contact. 🔴 **THE BUG THE SEED EXPOSED — a client-only user had nowhere to land, and fixing that uncovered a worse one already shipped:** nothing outside `navFor` consulted client-ness, so a client logging in landed on the staff **My Work** dashboard (every read 403-degrading) and had to find "Project Portal" in the sidebar. Adding the redirect surfaced that `navFor`'s guard, `isClient && !isElevated`, is **wrong**: `isElevated` is only global `platform_admin`/`group_executive`, so a **manager or company_admin who is also a client contact** matched it and was already being handed portal-only navigation — losing the entire staff surface. The redirect would have escalated that to locking them out of the app. A PM added as a contact on their own client is ordinary, so this was reachable. New `isStaff` / `isClientOnly` in `rbac.ts` ("any role that is not `client`", so a role added later counts as staff by default and fails toward KEEPING someone's workspace), used by both call sites. 6 new rbac tests pin it, including the manager-who-is-a-client case and an explicit `isElevated(both) === false` to record exactly why the old guard misfired. **The seed itself:** deliberately uneven — a viewer-only client (so "nobody here can sign" is visible), a client with nothing pending, a `complete` run, and a provider signature pre-placed on scope runs so the client's signature is the last one needed. Its **10 tests executed in CI** against real Postgres (Docker Desktop was down locally, so this is where they ran). platform-ui **979/979**, `tsc` + `DEMO_MODE=1 next build` clean. |
| 2026-08-04 | `webdev` **Portal demo seed — clients across several companies, each with a real login. `seed:portal-clients`.** The portal was provably correct with nothing to look at: one client, one company, and (before WD-30) runs that carried no client. This seeds the shape the real thing has — a holding whose member companies each serve their own clients — so the portal can be exercised as five different people and the tenant boundary can be SEEN rather than asserted. Per client it creates the `clients` row on **that client's own company**, a project with `client_id` set, contacts, the global `client` role granted at that company (without which a contact resolves a tenant and is then denied everything), and a `pipeline_run` carrying **both** `client_id` and `project_id`, with real PRD/Scope artifacts and — on some runs — a PENDING client gate so "N things need you" is a real state. **Deliberately uneven, because a fixture that is uniformly happy has not been reviewed:** one client has two contacts, one has only a **viewer** (so "nobody here can sign" is a state you can actually see, and the staff-side warning fires), one has nothing pending (so "Nothing needed from you right now" is exercised), and one run is already `complete`. Every run also gets an internal-only `report` stage — seeded precisely so "the client cannot see the report track" is testable instead of vacuously true. Scope runs carry a **provider** signature already, so the client's own signature is the last one needed and `complete: true` is reachable in one click from the portal. **Keycloak is optional and fail-soft, but not fail-dishonest:** configured, it provisions each account and sets one documented password so contacts are `active` and can log in immediately; absent, contacts stay `invited` and the seed prints real single-use invite links — marking them `active` would claim a login that does not exist. A company it cannot find is **skipped and reported**, never created: inventing a member company would produce a tenant with no org structure, people or modules, which reads as corrupt data rather than a missing seed step. Idempotent throughout, and it re-asserts `client_id`/`project_id` on rows an earlier seed left unlinked. **10 tests** that EXECUTE the seed against real Postgres rather than reading its INSERTs (the standard `agency.db.test.ts` set after three seed bugs `tsc` could not see): clients land on BOTH companies, every run carries both links, each run's project agrees with the run about who the client is, the role is scoped to the right company, signer and viewer are distinguishable, the hidden report stage exists, contacts stay `invited` without Keycloak, and a second full run duplicates nothing (by row count). ⚠️ `tsc` is clean but **those tests have not been executed yet** — Docker Desktop went down on this machine, so the DB suite could not run locally; CI runs it on push and the live seed run is the other half of the evidence. |
| 2026-08-04 | `webdev` **WD-30 PROVEN LIVE, and C4/C6 closed. `alpha-01.010.0029a` deployed.** The portal now returns **real data** to a real client: an invited contact on Bali Beach Resort logged in through the actual PKCE flow and `/portal/runs` answered with their runs — titles, `"Waiting for your signature on the Scope Agreement"`, and `pendingActions: 1` — while `/clients` and `/meetings/recordings` stayed **403**. That is the assertion the earlier walk could not make: it got a 200 carrying `[]`. Migration **0074** attached the 2 runs whose meetings had a client and correctly left `Dispatcher latency probe` NULL, whose meeting had none — it never invents an attachment. ⚠️ **A probe of my own misreported this first.** Step 0 of the proof read `/api/:t/pipeline/runs` and reported "0 of 5 runs now carry a client_id", which would have meant the backfill silently no-opped — the exact 0050 signature I had written 0074 to avoid. It was the probe that was wrong: the LIST select omitted `client_id` entirely, so every row's field was absent and read as null. A missing FIELD and a null VALUE are indistinguishable in JSON, and the run DETAIL endpoint showed the real client ids immediately. Worth recording because the failure mode is invisible: a 200 with a field the caller expects and the server never sends looks exactly like data that is not there. **C4/C6 (that same omission, now fixed):** the list SELECT carries `client_id`, `project_id` and `owner_id`, so the pipeline list can show whose work a run is without cross-referencing the recordings registry, and the run workspace links straight to its project. C6 had been filed as blocked by the absent `project_id` column — W0 added it, WD-30 populates it, so it was only ever waiting on those. UI types mark the new fields OPTIONAL on the list so a server on an older tag renders no link rather than an empty one. **Two stale teach-states corrected:** the run workspace warned "the n8n dispatcher currently drops client context on ingest" as a known gap; that is what WD-30 fixed, so it now explains the one case that legitimately remains (a run created directly, with no source meeting). **Deploy verification:** the new retention step ran and the box holds exactly two tags (this one plus the rollback target), disk steady at 71%; `Prune superseded images` and `Record deployed tag` both succeeded and `Roll back on failure` was **skipped** — the first deploy since the rollback was re-gated on health. platform-nest pipeline+portal+meetings **84/84**, platform-ui **974/974**, `tsc` + `DEMO_MODE=1 next build` clean. **Known gap, stated rather than papered over:** there is no `client` demo identity, so `/portal` and `/portal/[runId]` cannot be browsed in DEMO_MODE at all — adding one means new login tiers, a `/me` fixture and an rbac change, which is wider than this pass. Automated invite email also remains unbuilt (no mail transport in the estate). |
| 2026-08-04 | `webdev` **WD-30 + C3 + C5 — the client portal could never have shown a client anything, and the login hop is now driven for real. `platform-nest 0.10.0 -> 0.11.0`, `platform-ui 0.11.0 -> 0.12.0`.** **THE LOGIN GAP IS CLOSED, not worked around.** `gaiada-ui` is a public PKCE client with direct access grants disabled, so the previous entry recorded the browser hop as undriven. Rather than weaken a production auth client to make it scriptable, the real authorization-code + PKCE flow was driven end to end — authorize, POST Keycloak's own login form, capture `code` from the 302 without following it to the callback, exchange with the verifier. The invited contact **logged in**, and the token was accepted by the platform. `/api/companies` returning the tenant is the load-bearing part: it proves `provisionUser()` linked the first login (so `emailVerified: true` at accept did its job) AND that principal.ts's `client_contacts` union granted the tenant — without either, that call is empty or 401. Then an ALLOW and two DENYs from one token: `/portal/runs` **200**, `/clients` **403 cerbos denied**, `/meetings/recordings` **403**. 🔴 **WD-30, and it is the real reason the portal showed nothing:** every `pipeline_run` on the server had `client_id NULL` — 5 of 5, verified. `createRun` has always ACCEPTED `clientId`; the n8n extraction flow has never sent one. `/portal/runs` filters by the caller's client ids, so a contact who was correctly invited, provisioned, role-granted, tenant-ed and Cerbos-allowed still got `[]`. Every layer reported success and the portal was structurally blind — the W0 fix that made the portal *authorize* correctly could never have made it *show* anything. `createRun` now derives client/project from the source meeting when the caller omits them (explicit body value still wins), derived server-side rather than by editing the workflow because an n8n artifact can be re-imported and a contract this load-bearing must not depend on every caller remembering. Migration **0074** repairs the 4 historical runs that resolve to a client, written as a per-tenant `set_config` loop: a bare UPDATE would have matched ZERO rows under FORCE RLS as `platform_owner` (no BYPASSRLS, GUC unset), reported success, and left the portal just as blind while looking fixed — the confirmed 0050 class. **C3 (N+1):** the list computed each run's blockage with two queries per run — 201 round trips on a full page, on the one surface whose latency is paid by someone outside the company — now two batched queries grouped in memory, plus a free `pendingActions` count. **C5:** `getPortalRun` and `PortalRunDetail` already existed and NOTHING rendered them; the list page fetched every run's detail (1+N HTTP calls, four queries each) and inlined it, so a client could not open a single project and the reader was dead code. New `/portal/[runId]` reads documents OUTSIDE a signature prompt (a client could previously only ever see an artifact while being asked to sign it, never re-read what they had agreed to) and shows BOTH scope parties, since hiding the provider side lets a client think an agreement is settled while it waits on us. Gate actions extracted to `PortalGateActions` so the D-3 guarantee — what the client sees is what they sign — has one implementation, and a sign button with no artifact is now disabled with a reason rather than presented bare. **8 new tests, each shown red against the PLAUSIBLE defect, not a syntactic deletion:** reverting the derivation to `clientId ?? null` reds exactly the 2 inheritance tests while the 3 controls (explicit wins, null stays null, no-meeting) stay green — which is what makes them controls; dropping `?? []` from the batch grouping reds the empty-run and gate-count tests, the case a brand-new run hits most. platform-nest **2753 passed / 4 skipped / 0 failed** before the portal work, portal+pipeline **48/48** after; platform-ui **949/949**, `tsc` + `next build` (`/portal/[runId]` present) + both lint gates clean. **Two stale header comments corrected from verified behaviour** rather than left to mislead: portal.controller.ts and lib/portal.ts both described an external client Keycloak realm and `portal_user_id` linkage that was never built. **Still true:** `hasAccount` tracks `idp_subject` ("has linked"), so its name still misleads; automated invite email remains unbuilt (no mail transport in the estate). |
| 2026-08-03 | `webdev` **W0+W1 largely DEV-VERIFIED on gda-aicenter (module row stays IN PROGRESS: client LOGIN is the one hop still undriven) — `alpha-01.009.0028a` is deployed and the invite -> accept -> provision -> schedule -> participants chain was driven against it.** Live results, each with its HTTP status recorded because a 200 carrying `[]` is not a pass: contact create **201** (Cerbos manager tier, D-2), a **146-char** invite token accepted **200** (the length that used to 404 at find-my-way's `maxParamLength`, now in the body), the same token replayed **400** (single-use holds), the contact moved `invited -> active` with an `activated_at`, and a **real Keycloak account** exists for it — read back through the provisioner admin API as `enabled: true`, `emailVerified: true`, no pending required actions. Scheduling returned **201** with a minted `meeting_id` and the `?scheduled=upcoming` filter returned it as `scheduled`. Participant add sent `side:"internal"` **deliberately** and the API answered `side: "client"` — derivation beats the body, live, not just in tests. **Two design properties confirmed by observation rather than assertion:** the contact is ABSENT from `GET /api/:t/users`, which is the whole point of not giving client contacts a `company_memberships` row (they cannot leak into staff listings), and `hasAccount: false` after a successful accept is CORRECT — it tracks `users.idp_subject`, which `provisionUser()` sets at first login, so the field means "has linked" not "an account exists". The name is misleading and is worth renaming; the behaviour is right. **THE GAP THE WALK FOUND, invisible to every test and to `docker compose config`:** `INTEGRATION_TOKEN_KEY` was never forwarded to the platform container. A 43-char value sat in `.env` while the container read `""`, and that key signs W0 invite tokens, signs SEO's Google OAuth state tokens, and is what `secret-box.ts` encrypts stored integration secrets with — so **three shipped features could never have worked in production**. It surfaced as a typed **503** naming the variable (`ClientAccessErrorFilter` doing its job instead of a 500), which is what made it a five-minute diagnosis instead of a hunt. Now forwarded in `docker-compose.vps.yml`, deliberately without `:?` so absence stays a specific runtime refusal rather than blocking the whole stack from starting. **NOT driven, and the limit is specific:** the browser login hop. `gaiada-ui` is a public PKCE client with direct access grants disabled — the correct posture — so a user token cannot be minted headlessly, and weakening a production auth client to script a test is not a trade worth making. Everything the ERP controls is verified; the Keycloak redirect itself is not. The `client` role grant is likewise test-covered but not live-observed, because the endpoint that would show it deliberately excludes client contacts. |
| 2026-08-03 | `infra` **The deploy could fill the disk and then revert a healthy release. `0.7.4` -> `0.8.0`.** Deploying `alpha-01.009.0028a` exposed both halves. Nothing pruned release images: nine per deploy, none removed, eleven tags resident, `report-renderer` ~3.6GB each — the 49GB disk hit **100% with zero bytes free**, and `docker image prune -f` reclaims **0B** because the images are tagged rather than dangling, so only an explicit `docker rmi` per tag frees anything. Then the sharper fault: `Record deployed tag` is a single `echo` into a file, it failed for want of one byte, and `Roll back on failure` was gated on bare `failure()` — which fires for ANY earlier step. **`Start services` and `Wait for health` had both already passed**, so a bookkeeping write reverted a working release and `/health` then reported the old version, reading exactly like a deploy that never happened. Rollback is now gated on `steps.health.outcome != 'success'`; a skipped health step is also not `success`, so genuine failures still roll back. New retention step keeps this tag plus `steps.prev.outputs.tag` — the previous tag IS the rollback target, and pruning it would convert a bad deploy into an outage — and is `continue-on-error`, because housekeeping must never fail a healthy deploy, which is the very bug being fixed. Also caught before it bit: `COMPOSE_PROFILES` was `bot,auth` while `whisper` sits behind `profiles: [whisper]` and had been started by hand, so `up -d --remove-orphans` would have **deleted** it and killed the transcription chain; the variable is now `bot,auth,whisper`. n8n was never at risk — it runs in a separate compose project — which is worth stating because "n8n always survives deploys" is not evidence that a hand-started container will. 14GB reclaimed by hand, all 15 services verified healthy afterwards, and the server `.env` re-synced (its `GAIADA_TAG`/`APP_VERSION` had gone stale again, and `APP_VERSION` was unquoted so sourcing the file errored). |
| 2026-08-03 | `release` **Merged `origin/main` (14 commits) and cut `Alpha 01.009.0028a`.** Both lines had bumped module versions independently, so the table is rebased on main's numbers (which carry other sessions' work) and only this wave's modules are bumped on top: `platform-nest 0.9.5 -> 0.10.0` (migration 0072, client contacts/invites/Keycloak provisioning, scheduling, client notify), `platform-ui 0.10.4 -> 0.11.0` (recorder, invite accept page, contacts + scheduling + participants panels), `mcp-hub 0.9.2 -> 0.9.3` (`pipeline.runBySourceMeeting`). Main's `infra 0.7.4` / `wa-chat-bot` / `ai-agents` dates are kept untouched — taking this branch's older rows would have silently reverted them. Two content conflicts were resolved to **main's** side after checking which was newer: `knowledge/ingest/erp-source.ts` and its README, because main carries `741ad4e fix(knowledge): index pm_tasks` that this branch predates, so keeping ours would have reverted that fix. |
| 2026-08-03 | `webdev` **W1 — scheduling, participants, client notifications, pipeline lifecycle UI. `webdev 0.9.0` -> `0.10.0`, `platform-ui 0.10.0` -> `0.11.0`.** Makes D-3 walkable: a PM can now invite client contacts, schedule the meeting, and set who attends on both sides — all before anyone presses record. The client page reads in setup order (Client access -> Scheduled -> Meetings), which is the reframe rather than decoration. **Scheduling** (`POST .../recordings/schedule`, participants add/remove, `?scheduled=upcoming`) over migration 0072's columns, no DDL. `meeting_id` is minted through a shared `mintMeetingId()` that `start` also calls, so the two paths cannot drift — that id is the frozen dispatcher dedupe key. The hardcoded `STATUSES` set disagreed with the 0072 CHECK and is widened. `side` is derived server-side and never taken from the body, proven by tests that send the OPPOSITE side and assert the derivation wins. **Corrected the agent's `side` derivation**, which gated `client` on `status='active'`: a `client_contacts` row IS a PM's assertion of which side someone is on, while `status` answers whether they can log in yet. Gating on active mislabels a client as internal staff in exactly the pre-acceptance window D-3 exists for — and `internal` is the MORE privileged label, so an active-only check is conservative about naming and permissive about exposure. Now derived from presence; `revoked` still reads `client` because the column is denormalised so a historical attendee list stays truthful. **Client notifications** on four write paths (client gate opens, client decides, scope.signed completes) through one exported resolver: active-only, client-wide-or-matching-project, and signature requests restricted to `signer` contacts since a viewer asked to sign cannot act. Per-recipient try/catch, so a notify failure can never roll back a transition — asserted by forcing one. 🔴 **THE GAP THAT MADE W0 INERT, and no existing test could catch it:** `PortalController` resolved clients ONLY via the legacy `clients.portal_user_id`, which the invite flow never writes. A contact could accept, get a Keycloak account, receive the `client` role, gain the tenant via principal.ts's union, pass `resource_portal` authz — and then be refused with "not a portal client". Every step upstream reported success and the portal showed nothing. The W0 spec said the portal "resolves through this table instead"; that intent was never implemented, and the previous CHANGELOG entry's claim that W0 closed this root was overstated. Now resolves a SET of clients (D-1 made contacts many-per-client) from active `client_contacts` UNIONed with the legacy column — unioned, not replaced, since that column has live rows and its own tests. Project scoping is now enforced, and a client-wide row WIDENS access so adding a narrower row cannot take access away. 9 tests, all on the invite-flow configuration (no `portal_user_id`, no staff membership) that `portal.test.ts` never exercises. 🔴 **A defect the previous entry itself created and misreported:** `scope-signoffs` checked `party` only for truthiness, so the server walk's `party:"agency"` was stored and answered `complete:false` — indistinguishable from a correct "waiting on the client", which is how it was reported. "agency" satisfies neither entry of `REQUIRED_SCOPE_PARTIES ["provider","client"]`, so that run could never complete, and the unique index on `(run_id, party)` means the junk row permanently occupies a slot. Now validated with a 400. Found by an agent that read the live Cerbos policy instead of trusting the gap-assessment doc. 🟠 **`pipeline_runs.owner_id` was unwritable** — `createRun` never accepted it and `updateRun` took only `status`, so the column 0072 added was permanently NULL and every "notify the owner, else created_by" resolved to `created_by`. A column no code can set is indistinguishable from one that does not exist. Now settable on create and PATCH; `ownerId:null` clears it while omitting the key leaves it untouched (a `CASE` on key-presence, not a `COALESCE`, so a status-only park cannot silently unassign the PM). The owner must be ACTIVE STAFF, never a client contact, because `owner_id` is who INTERNAL notifications address. **UI:** agency scope sign-off (gap B1 — without it no scope agreement could complete from either side), run lifecycle recovery tools (collapsed and warning-toned, not beside routine controls), `/pipeline` and `/meetings` filters, and a client column resolved WITHOUT an API change or invented data (cross-referencing `source_meeting_id` against the recordings registry, showing "—" where a run has no traceable meeting). Scheduling surfaces two states a PM would otherwise learn too late: a scheduled time that passed while still `scheduled` ("Time passed — not recorded" — the capture never happened) and a client meeting with nobody from the client side attending. **An existing registration pin caught a 6th global filter** and was updated deliberately, as its own message demands — `LastResortExceptionFilter` stays FIRST because Nest reverses the argument list, pinned independently. **Timezone assumption stated, not left implicit:** `datetime-local` is zone-less and conversion happens server-side, so the platform and the PM are assumed to share a timezone; a multi-timezone agency needs an explicit offset, which is a contract change. Suites: platform-nest **2739 passed / 4 skipped / 0 failed** (full sweep), platform-ui **943/943**, `tsc` + `next build` + `lint:withtenants` + `lint:migration-rls` clean, both service images build. Cerbos `resource_client_contact` is DEPLOYED and proven live on gda-aicenter with both an allow and a deny. **Still PROTOTYPED:** the running server image predates all of this, so the live invite->accept->login and schedule->record walks have not been driven. **Known remaining:** the portal's N+1 and missing `/portal/[runId]` detail (C3/C5), run<->project navigation (C6), and automated invite email (W0 ships copy-the-link deliberately — there is no mail transport in this estate). |
| 2026-08-03 | `webdev` **W0 — client engagement setup: contacts, magic-link invites, Keycloak provisioning, scheduling schema. `platform-ui 0.9.0` -> `0.10.0`, `webdev 0.8.1` -> `0.9.0`.** Closes the two structural roots the gap assessment found: `pipeline_runs` had no `project_id` (a recording started from a project workspace knew its project and the run it produced forgot it — the reason WD-06 needed a one-project-per-tenant env var), and `clients.portal_user_id` was written **only in test fixtures**, so the client half of every gate could never be countersigned in production. **Migration 0072:** `client_contacts` (many per client, `project_id NULL` = client-wide per D-1, signer/viewer capability because "on the same page" implies contacts who watch but must not sign, two partial uniques because UNIQUE treats NULLs as distinct), `client_invites`, `meeting_participants`, `pipeline_runs.project_id`/`owner_id`, scheduling on `meeting_recordings` (new `scheduled` status; rides the existing registry rather than a parallel calendar because that registry already mints the `meeting_id` the frozen dispatcher contract keys on), and the global **`client` role, which had never been seeded** despite two policies depending on it. **Design correction found by audit:** client contacts deliberately do NOT get a `company_memberships` row. Only 6 of 27 non-test queries over that table filter `kind`, so widening it would have needed a defensive filter at ~10 staff-listing sites and left every future site free to forget — a client contact appearing in `/people` and HR as an employee. Instead `rbac/principal.ts` unions `client_contacts` into `principal.companies` and `notify()` accepts them: two deliberate edits instead of ten defensive ones, and the leak becomes structurally impossible. Safe because of a VERIFIED property — `"user"`, the parent of the `client` derived role, is granted by **no** policy, and `derivedRoles: ["client"]` appears only in `resource_portal.yaml`. **`notify()` was silently dropping every client notification** (memberships-only check with a bare `return`) — exactly the failure D-3 exists to prevent, in its least detectable form. **Keycloak:** the platform's first Admin API integration. Real `gaiada-provisioner` service-account client created on the `gaiada` realm (manage-users + view-users only; boundary probed — creating a client 403, mapping `realm-admin` onto its own created user 403 and verifiably not sticking), then `keycloak-admin.ts` driven against the LIVE realm over HTTPS: create with `emailVerified:true` -> read-back -> setPassword -> disable -> enable -> exact-match guard -> cleanup. That flag is load-bearing: `provisionUser()` **throws** on a first login whose invited email is not IdP-verified, so A (provision) and C (magic link) are two halves of one flow, not alternatives — the clicked token is what makes the flag honest. Revocation DISABLES rather than deletes (the audit trail must survive; deleting the IdP identity orphans `idp_subject` so a re-invite could mint a second account) and only when it was the contact's LAST active engagement. **Invite token** reuses the shape and reasoning of the estate's Google OAuth state token, with its own published attack list: forgery/tenant-pivot (HMAC over both ids, compared before any DB read and over a CANONICAL re-encoding), replay (one atomic `UPDATE ... WHERE consumed_at IS NULL RETURNING`), wrong-address redemption (email bound at issue), leaked-DB redemption (only sha256 stored), indefinite validity (72h enforced INSIDE the consume predicate), cross-tenant read (FORCE RLS + the signed tenant being the only tenant opened). The tenant travels in the TOKEN, not the row: the accept route is tenant-agnostic and the table is FORCE-RLS, so reading the row to learn its own tenant is circular. **Three bugs caught by tests rather than inspection, all invisible to `tsc`:** (1) the accept route was **unreachable for every invite ever minted** — a real token is 146 chars and find-my-way's `maxParamLength` defaults to 100, so it 404'd at the raw router before Nest; fixed by moving the token into the request BODY rather than raising the ceiling, which also keeps a bearer-equivalent secret out of access/proxy logs, `Referer` and browser history. (2) `KeycloakNotConfiguredError` **and** `ClientInviteError` both extend `Error`, so every typed refusal surfaced as a generic 500 discarding `.status`/`.code`/`.missing` — a doc comment had asserted a filter that did not exist; new `ClientAccessErrorFilter` covers both (fifth instance of this bug class here). (3) a `"use server"` module may export only async functions, and a client component may `import type` from a server-only module but not value-import from it — two module splits `tsc` and vitest accept while `next build` rejects. **Cerbos:** new `resource_client_contact` (create/update/revoke at manager tier per D-2 so the PM who owns the engagement acts without an admin; `group_executive` gets its OWN rule gated on `notLow` only, never `inTenant`, per WD-20-R1), and `scope_signoff.create` widened to `manager` — a deliberate scope change, not a fix for the correct 403 a manager-tier automation account hit during the server walk. `team_lead` documented as a DEAD TIER on this kind (it needs a team-scoped grant matching `resource.teamId`, which client contacts have no concept of). **Deployed and proven live on gda-aicenter** (policies are bind-mounted server files): manager ALLOW / member DENY on create, and an exec who is a member of NO tenant still allowed — both an allow and a deny, because an unlisted kind is a silent DENY that reads like a logic bug. **UI:** public `/invite/[token]` page (middleware allowlist) that deliberately does not pre-validate the token — single-use means a check would spend it, and distinguishing valid from invalid would be the exact oracle the coarse API refusal denies — plus `ClientContactsPanel` on the client page, above Meetings because setup precedes capture. It surfaces "link not used yet" as a normal waiting state and warns when no contact can sign off, since a scope agreement would otherwise wait indefinitely. The invite link is shown ONCE and says so, because the API keeps only a hash. Suites: platform-nest **92/92** across the five W0 suites (invite tokens 19, contacts 14, keycloak-admin 18, Cerbos matrix 26, HTTP 17) plus meetings 30 and pipeline/race 32; mcp-hub 32; platform-ui **939/939**; `tsc` + `next build` + `lint:withtenants` + `lint:migration-rls` clean; both service images build. **Still PROTOTYPED, not DEV-VERIFIED:** the running server image predates this code, so the live invite->accept->login walk has not been driven; the server env, Cerbos policies and provisioner client are pre-staged and verified so a tag rollout should light it up. |
| 2026-08-03 | `platform-ui` `0.8.0` → `0.9.0` · `platform-nest` **video recording works end to end — the gap in the audio-only recorder is closed.** The recorder shipped audio-only that morning for one reason: `isAllowedAudio` accepted no `video/*` container, so a browser video take would have been refused *after* the whole upload was sent. Rather than widen a validator on a guess, that was left as a stated gap. **The guess is now a measured fact.** **VERIFIED against the running `gaiada-whisper-1`** (`fedirz/faster-whisper-server`, which carries `/usr/bin/ffmpeg`): it demuxes a video container and transcribes its audio stream. The probe used a CONTROL, which is what makes it evidence — an opus-only `.webm` and a vp8+opus `.webm` built by ffmpeg from the SAME 3s audio track, differing only by the presence of a video stream, both returned HTTP 200 with the **identical transcript**; an h264+aac `.mp4` also decoded. Re-run recipe is in the code comment (POST to `http://whisper:8000/v1/audio/transcriptions` from inside the compose network — whisper publishes no host port — and prefix `MSYS_NO_PATHCONV=1` on Git Bash). **Backend:** `isAllowedAudio` → `classifyMedia` returning `'audio'|'video'|null`, adding `video/webm|mp4|quicktime|x-matroska|ogg|3gpp` + `.mov/.mkv/.ogv/.3gp/.m4v`; the generic-content-type extension fallback is unchanged (a plausible mimetype OR a recognised extension, never a spoofed name alone). Ambiguous `.webm`/`.mp4`/`.ogg` under a generic type resolve to **video**, the harmless direction — guessing audio on a real video refuses a valid upload, guessing video only permits a larger one. New `MEETING_VIDEO_MAX_BYTES` (default 500MB) beside the 200MB audio cap. **The subtle part, and the one that got its own test:** @fastify/multipart can register only ONE `fileSize` for the whole app, so `main.ts` now registers `maxUploadBytes()` = MAX(audio, video) and the **real cap is enforced per-kind in the handler**. Without that handler check, raising the plugin limit for video would have silently opened the audio path to 500MB uploads — an audio file sitting *between* the two caps sails past busboy, and before this change that case could not arise. Tested with a positive control: 2048 bytes is refused as audio and accepted as video under a 1KB/4KB test config, so the refusal is provably the per-kind cap and not just "2KB is too big". **Frontend:** `useMediaRecorder({ video })` requests the camera (720p `ideal`, never `exact` — an `exact` constraint turns an older webcam into OverconstrainedError, i.e. "recording is broken"), picks a video container, and caps bitrate at ~800 kbps video + 32 kbps audio so a 60-minute meeting lands near 220MB instead of the browser's multi-Mbps default force-stopping a meeting mid-sentence. Live mirrored `<video>` preview while recording (muted — an unmuted self-preview is an instant feedback howl) with a Paused overlay; the take plays back in a `<video>`, unmirrored because that is the real footage. `RecordControls` gains an Audio / Audio+Video radiogroup, **keyed** so switching modes mounts a fresh recorder rather than carrying a finished audio take into a video session and uploading the wrong medium. `RecordingWorkbench` follows the row's own `kind`, so an audio recording never raises a camera prompt it does not need. Upload `accept` and all user-facing copy now say audio *or* video. **A test-harness trap was hit and is now documented in place:** `routedWhisperFetch` matches on `url.startsWith(config.whisper.url)`, and in the byte-cap suite that config value is `""` — so `startsWith("")` matched EVERY url including Cerbos's own fetch, and `authorize()` began returning spurious 403s (then the stub leaked into the next test). This is exactly the failure that file's own header warns about; the fix is that the cap suite stubs nothing, because it asserts a 202 and never needs whisper. Verification: `platform-nest` **2555 passed / 1 failed / 4 skipped (178 files)** — the 1 failure is `src/modules/reports/report-seal.db.test.ts`'s seal-hash recomputation, **pre-existing and reports-owned**, confirmed by running it in isolation and by this change touching nothing under `modules/reports`. `meetings.test.ts` **27/27** against live PG + Cerbos (6 new: video/webm transcribes and keeps `content_type: video/webm` on the stored file, generic-type `.mov` classifies as video, and the three cap cases). `platform-ui` **928/928 across 95 files** (25 recorder tests, 6 new for video: camera constraint requested, video container + bitrate ceilings applied, preview stream exposed only for video and cleared before tracks die, audio takes never request video, the larger cap is used, and unsupported/blocked messaging names the camera). `tsc` clean both sides, `next build` green, `lint:withtenants` + `lint:migration-rls` clean. **Still not DEV-VERIFIED, same specific gap as the audio recorder:** the browser half runs against a faked `MediaRecorder` under jsdom, so no real camera or encoder has driven it. What IS now real rather than assumed is the whisper side. |
| 2026-08-03 | `platform-ui` **In-ERP audio recorder with real transport controls (start · pause · resume · stop · play), `0.7.1` → `0.8.0` PROTOTYPED.** The ERP's "Record" buttons never recorded anything — they only REGISTERED a `meeting_recordings` row and waited for the desktop capture-helper to attach a file, so there was no capture to pause, stop or play back. New `useMediaRecorder.ts` (state machine + lifecycle) and `LiveRecorder.tsx` (transport + playback + upload), wired into **both** call paths: `RecordControls` (register-and-upload in one step — reaches `/meetings`, PRD Studio, the client detail page and the project workspace, all four via that one component) and `RecordingWorkbench` on `/meetings/[id]` (upload into the existing row, hidden once a transcript exists so re-recording cannot silently overwrite a transcribed meeting). The take goes down the SAME server-side path as an uploaded file (`POST /api/:t/meetings/recordings/:id/audio` → whisper → `transcribed`), so nothing new was added to the backend. **AUDIO ONLY, deliberately:** `isAllowedAudio` (`meetings.controller.ts:42`) accepts `audio/webm|mp4|ogg…` and **no `video/*` container**, so an in-browser video take would be refused *after* the whole upload; rather than widen a validation allowlist on a guess about what the whisper container accepts, video capture stays with the desktop helper. **Correctness the tests pin, not the click-through:** the elapsed clock accumulates completed segments so paused time never accrues (asserted across a 2s-record → 5s-pause → 1s-record walk); every `MediaStream` track is stopped on stop/reset/**unmount** (the mic-indicator-stays-on bug); the 200 MB cap (mirroring `MEETING_AUDIO_MAX_BYTES`) force-stops and **keeps** the audio already captured rather than discarding it; a recorder error likewise preserves the take; `pause()`/`resume()` are inert outside their matching states; every object URL minted is revoked (create/revoke counted, not assumed); and `MediaRecorder.pause` absence hides the Pause control instead of rendering a dead button. **A real bug was caught by these tests, not by inspection:** `fileName`'s extension derived from the container requested at `start()` while the Blob's type followed the recorder's *negotiated* `mimeType` — so a browser negotiating `audio/ogg` produced `meeting-recording.webm`, and since the backend accepts a generic content-type ONLY when the extension is a known audio one, a stale extension can turn a good recording into a 400. Both now derive from one source in `finalise()`. Also: the recorder degrades honestly rather than silently — `unsupported` (no `mediaDevices`/`MediaRecorder`/container) raises no permission prompt at all, and a blocked mic is distinguished from an absent one in the user-facing copy, both pointing at the still-present upload fallback. **Status is PROTOTYPED, not DEV-VERIFIED, and the gap is specific:** 19 new unit tests drive a faked `MediaRecorder` under jsdom (which implements neither `MediaRecorder` nor `navigator.mediaDevices` nor `URL.createObjectURL`), so the state machine and lifecycle are verified but **no real microphone, real encoder, or real browser has ever exercised this path** — and the upload→whisper→`transcribed` hop has not been re-driven live. `tsc` clean, `next build` green, suite **921/922**. **The 1 failure is pre-existing and NOT this change:** `src/styles/tokens.test.ts` "components never hardcode a colour literal" — it scans only `.css` files under `src/components` and this change adds none; proven by stashing the change and re-running on clean HEAD, where it fails identically. It belongs to the UI-polish token program. |
| 2026-07-31 | `reports` **TR-30 — documentation + seed + registry sweep, 0.1.0 IN PROGRESS → 0.3.0 PROTOTYPED.** P0–P2 substrate + fact fabric + check-ins complete; P3–P4 documents + exports + PDF endpoints built (sidecar DEV-VERIFIED); P5–P6 appraisal engine + MCP tools built (6 tools registered). Four controllers + 25 HTTP endpoints + 6 MCP tools live. **P1–P6 honest status: mostly PROTOTYPED with DEV-VERIFIED parts** (fact job 403+ tests, TR-35 report-rollups DEV-VERIFIED, sidecar 14 tests, MCP tools + appraisal engine tested). Known gaps: appraisal UI (TR-26), retroactive leave stale-history (TR-41), the live mint→sidecar→print-route PDF hop (TR-29), production deployment. **⚠ CORRECTED 2026-07-31 by the architect: this entry originally also listed "report viewer/charts" and "print route" as gaps — both were FALSE.** TR-16/TR-17 (chart kit, `ReportViewer`, `PeriodSelector`, all four grain routes, 862 UI tests green) and TR-20 (`app/print/reports/[jobToken]` + `print.css`, real PDFs inspected) had already landed and were verified on disk. The claims came from reading the blueprint's ticket list instead of the filesystem — **a registry that declares an existing surface unbuilt invites someone to rebuild it, which is worse than an omission.** Registration: `FRONTEND-BFF-CONTRACT.md` §15 added (documents/checkins/appraisals surface detail + known gaps), `MODULES.md` version bumped (detailed P0–P6 completion report), `CHANGELOG.md` entry recorded. Demo seed extended: `npm run seed:agency` now populates check-ins + work-facts for seeded tenants so report surfaces are reviewable. Full summary: design section 514–547 of `MODULES.md`, blueprint `tracker-reporting-foundation.md` §15 amendments. |
| 2026-07-31 | `search-marketing` **`0.3.0 → 0.4.0` IN PROGRESS. Bundled ⚡ gate PASSED (SM-54/56/59/61/25b all LANDED); echo-validation standing rule adopted + audited; a hardening wave opened and mostly closed; SM-23 docs/registration reconcile executed.** The bundled owed gate from 0.3.0 (tracker §6bc) passed SM-54 (scheduler), SM-56 (collect-scope double-charge, fixed by SM-63), SM-59 (`vendor_ref` reconciliation predicate) and SM-25b (GSC/GA4 reads, one residual → SM-64) — all four move to **LANDED**. SM-63 (collect-edge scope check, `ledgerRowScopeMatches`) LANDED. Architect rulings (§6bc) adopted **echo-validation** as a standing rule (any request-side constraint must be re-verified on the response before persistence; addendum §A14, now A1.7) and a **negative-control rule** for concurrency/serialization guard tests (a guard test is evidence only when shown red with the guard removed AND the removal is the *plausible* defect, not a syntactic deletion — sharpened twice this session after catching two more equivalent-mutant false passes). SM-65 (read-only audit) found 6 echo-validation gaps across the three vendor drivers and spawned SM-66…70: **SM-66/67/69 DEV-VERIFIED** (Ahrefs true-up header hardening, DataForSEO `task_get` identity refusal, DataForSEO backlinks target identity) — all gates owed. **SM-30** (manual apply/export twin — Ads-Editor CSV + `apply_manual` door, zero OAuth) and **SM-20** (search-terms callback + reader, migration `0062`, second callback secret, schema-level idempotency) are both DEV-VERIFIED, gates owed — both had shipped to disk with their §1 rows still reading `TODO`, now corrected. **SM-68/70** (DataForSEO billing-identity ruling — record every vendor-ack'd charge, refuse the *data* on a canonical keyword-echo mismatch, §6bi) reached DEV-VERIFIED with the full module tree green (894 passed / 4 skipped, zero reds, §6bj) — **and then an orchestrator `git checkout` destroyed the uncommitted `providers/dataforseo.ts`**, reverting SM-56/67/68/69/70's work in the one file it lived in. **RECOVERED same-session** (tracker §6bk): a rebuild against the surviving, untouched test files restored the implementation in full — `tsc` clean, `dataforseo.test.ts` 48/48, full tree **895/4 skipped, zero reds**, six mutation probes each `sha256sum`-verified byte-identical. SM-56 stays LANDED unaffected; SM-67/68/69/70 still owe their ⚡/QA gates, now against the recovered code, not against nothing. **SM-23 (this entry) also found:** SM-19's dual-mode apply-execution picker (`PaidActionGate.tsx`, `ApplyProposalTwins.tsx`, wired live into the Rankings and planner console pages) is real, committed, and covered by the `platform-ui 0.7.0` release's "729 tests green" figure recorded in the App release log above — but had **no §6 ticket narrative anywhere in the tracker** and its own row still read a bare `TODO`; corrected to `IN FLIGHT`, not promoted to `DEV-VERIFIED` (no ticket-scoped AC pass exists). `FRONTEND-BFF-CONTRACT.md`'s PENDING table had two stale rows claiming the Rankings and Ads-Studio (manual-mode) console UI was "unclaimed" — both corrected. `MODULES.md`'s search-marketing section had fallen one gate-cycle stale (still called SM-56/59 "gate owed" after they'd LANDED) and its migration list stopped at `0060`, missing the already-applied `0061`/`0062` — both corrected, version bumped `0.3.0 → 0.4.0`. **The at-ticket-creation-row standing rule (adopted §6au after SM-56/59 fell through a gate-bundling gap) was breached a second time** — SM-66/67/68/69 were created (§6be) with no §1 rows until §6bi noticed — recorded as SM-23's own regression case; the rule needs a mechanical check, not another reminder. **Still open:** SM-19's ticket-scoped verification, all the gates named above (now including SM-67/68/69/70 against the recovered driver), SM-25c/SM-26/SM-21/SM-22 (SEM apply/reports, still TODO), and real-vendor-account verification (OQ-2/9/10/11, unfunded). |
| 2026-07-30 | `search-marketing` **P1 fully LANDED (M2 reached) · P3's SM-18 LANDED · P5 hardening wave (SM-50…SM-61) opened and mostly closed · SM-23 doc-reconcile pulled forward.** ⚡ gates cleared: SM-08/SM-10/SM-13 (§6y — the oldest gate debt), SM-18 (cluster→plan generator + RSA/negative AI drafts + change-proposal CRUD, §6r+§6x.1), SM-25a-service/SM-58/SM-60 (§6ar), SM-51 (Google OAuth sandbox, §6ar), SM-14 remainder + its gate (§6af/§6ak). **The money-path P0 (SM-50, incurred-cost ledger rows) FAILED its first gate (§6ak), was fixed by SM-60, and PASSED (§6ar)** — migration `0053`. SM-52 (money-env-guard widened to all nine cap/price/ratio vars), SM-53 (typed dispatch refusals → honest HTTP, never 500) and SM-55 (SM-15's blocked n8n flows retired + deny-by-default regression test) also LANDED. SM-25a's HTTP surface (Google OAuth routes, `search-google-oauth.controller.ts`) is DEV-VERIFIED with its gate PASSED (§6as). **Correction applied by SM-23 (this entry) to two rows this seat itself wrote wrong:** SM-56 (collect-edge double-charge fix) and SM-59 (`vendor_ref` reconciliation predicate) are DEV-VERIFIED (§6an) but had **no gate section naming them** — §1's legend requires merged **and** gated for `LANDED`, so both are corrected to **IN FLIGHT** pending a bundled ⚡ gate (§6au) that also covers SM-54 (the platform-side pull scheduler, off by default — a money control) and the newly-ruled SM-61 (absent-cadence = on-demand, never weekly-default). **SM-23 also found:** twelve P5 tickets (SM-50…SM-61) existed only in narrative sections with no §1 ledger row at all — now added, and two standing rules adopted (a ticket gets its ledger row at creation; a gate section must name every ticket it covers). Added `SEARCH_SCHEDULER_ENABLED`/`SEARCH_SCHEDULER_INTERVAL_MS` to `platform-nest/.env.example` and `infra/compose/.env.example` (present in code/`config.ts` since SM-54 but missing from both example files) — documented as a money control (does this environment spend vendor money unattended), not a performance knob. `docs/FRONTEND-BFF-CONTRACT.md` §14 corrected: the engagement ledger read (SM-17, `GET engagements/:id/ledger`) is built and UI-wired (`CostLedgerPanel.tsx`) and was wrongly still listed as fully PENDING; only the tenant-scope MTD/threshold-event reads remain unbuilt. `docs/modules/MODULES.md`'s search-marketing "What exists (dev)" narrative was three landings stale (still described P0 as in-progress and SM-07/SM-11 as unbuilt) and has been rewritten against current code. **Still open:** the bundled ⚡ gate (SM-54/56/59/61), SM-17's own QA gate, SM-25b/25c (Google read paths, TODO), SM-19/20/21/22/30 (SEM apply/report loop, TODO), and real-vendor-account verification (OQ-2/9/10/11, unfunded). |
| 2026-07-30 | `reports` **TR-07 — nightly fact job + attribution engine (P1's correctness heart), `0.0.0` PLANNED → `0.1.0` IN PROGRESS.** `src/modules/reports/fact-job.ts` computes `report_work_facts` — the atomic `person × project × day` grain — plus `POST /api/:t/reports/facts/recompute {from,to}` (new Cerbos kind `report_admin`/`recompute`: platform-admin + group-executive + own-company admin; dept lead deliberately EXCLUDED per design §8). **Pure core, I/O at the edges** (house pattern): `computeFactRows()` is DB-free and clock-free, `gather*()`/`writeFactSlice()` hold every query; department resolution CALLS TR-04's `resolveDepartment` rather than re-deriving precedence ①–④, and the drift sweep CALLS TR-02's `logAssigneeDriftIfAny`. **Idempotent by construction:** each `(tenant, fact_date)` slice is a DELETE+INSERT in ONE transaction, and row ids are **deterministic uuid v5 over the table's own UNIQUE key** so two recomputes produce byte-identical rows — asserted on FULL row snapshots, with `computed_at`/`job_run_id` required to MOVE (proving the slice was genuinely rewritten, not silently skipped). §3.1's attribution table is pinned case-by-case (person-owner · unit-owner+responsible · unit-only · no-assignee) and a unit-assigned task never invents a person; Σperson ≤ Σunit = company holds with the unattributed bucket EXPLICIT; a 60-day backfill converges. Rulings honoured: `actor_user_id IS NULL` stays person-unattributed (TR-31's machine actors) but still lands on the unit axis; a SUSPENDED service edge still resolves a cross-company person's own unit and only withholds the provider stamp (TR-04 ruling); done-ness reads the consumer's `is_done`-FLAG-derived verbs; `pm_tasks.deleted_at` is filtered by the job (TR-01 backfilled soft-deleted tasks on purpose); `origin_site` passed explicitly. §5.3's leave-aware `auto_missed` check-ins ship with it (holiday/weekend/approved-leave/attendance produce nothing; a submitted or excused row is never overwritten; today is never marked missed). **Two substrate findings for TR-08:** `report_work_facts` has no `tasks_completed_with_due_date` counter, so metric #3's specified denominator (Σ completed-**with-due-date**) is not computable from the landed grain; and the shared `HttpErrorFilter` flattens every error body to `{error, field?}`, so §6.2's `422 {error:'range_too_large', maxDays:400}` ships as `{error:'range_too_large', field:'to'}`. 57 new tests (31 pure + 26 live-PG/Cerbos), `tsc` + `lint:withtenants` clean. |
| 2026-07-30 | `webdev` **WD-29 — pipeline state-transition idempotency (DEF-2 fix), DEV-VERIFIED live on a genuinely-racing driver.** `pipeline-delivery.json` is **byte-identical** (untouched, D-10 spirit); the whole fix is platform-side. New `src/core/pipeline-lock.ts`: a per-run xact advisory lock (`pg_advisory_xact_lock(0x50520001, hashtext(run_id))`) taken as the first statement inside `withTenants` by **every** run-state transition — `createStage`, `updateStage`, `openGate`, `decideGate`, `recordScopeSignoff`, `updateRun`, **plus the two client-side portal paths** (`portal.decideGate`, `portal.scopeSign`), which is where `prd_sign` and `customer_feedback` actually land in production; locking only the internal controller would have left the real-world race fully alive. **The lock alone is a no-op and that was proven, not assumed:** with the lock in place but the precondition re-check removed, the racing driver still produced **6 duplicate rows** — because each racer executes a decision computed from a snapshot read seconds earlier in n8n. The actual fix is lock + server-side re-evaluation of the workflow's own precondition (`existingStageForRepeatedCreate`): a `claude_design` create is admitted only if no design exists (initial `release_design`) or the CURRENT head design carries a decided `customer_feedback: changes_requested` (a genuine revision) — mirroring `Load + decide`'s own rule, so WD-05's bounded revise loop keeps working while raced twins resolve to the live head with `deduped:true` (same shape `createRun` already returns). Single-shot names (`prd_extract`/`report_extract`/`scope_extract`/`claude_code`/`staging`/`production`) dedupe on existence; `openGate` additionally suppresses a duplicate PENDING gate per `(run, stage, kind, actor_side)` — a duplicate pending twin would **stall a run forever**, since `gof()` resolves a beat to the LAST gate of its kind. `scope.signed` now emits on the TRANSITION to complete only (a re-filed signature was previously a row-level no-op that still re-announced the event, starting a delivery execution from nothing). Migration **`0052_pipeline_stage_idempotency.sql`**: partial `UNIQUE(run_id, track, name)` over the six single-shot names + a causal data repair. **The architect's stated repair rule ("keep-oldest, drop the rest") was wrong on all three counts and the live audit caught it before it destroyed data:** (1) the headline "4 groups / 6 excess rows" **over-counts** — run `019fb0a4` is WD-08 §1.6's *correct* rev-1/rev-2 revise pair (0 excess) and `019faebe` raced twice around one genuine revision (2, not 3), so true excess = **4**; (2) keep-oldest keeps the WRONG row — `Load + decide` always operates on `designs[designs.length-1]`, so the newest is the live lineage (run `019faec4`'s older twin held an orphaned *pending* `pm_review` while its newer row carried the whole decided chain incl. the client approval); (3) the rows aren't interchangeable (each `artifact_ref` differs — LLM output) and `pipeline_gates.stage_id` is a real FK, so a naive delete either fails or orphans human decisions. Repair instead pairs consecutive designs and treats them as raced unless a `changes_requested` was decided BETWEEN them; the excess row's gates are DETACHED + **soft**-deleted (never hard-deleted — two carried a `pm_review` a human really did approve). Live: 13→9 designs, 67→63 stages, 4 gates detached+soft-deleted with `decided_by`/`decided_at`/`decision` intact, dup groups 4→2 (both remaining are legitimate revise pairs); **idempotency proven by deleting the ledger row and re-running the real migration as `platform_owner`** — all counts unchanged. `npm run lint:migration-rls` green on `0052`, and the lint was shown to be load-bearing (removing the `set_config` wrapping makes it flag both the gate UPDATE and the stage DELETE). **Live racing verification against the running `:3004`:** 8 concurrent deciders parked behind a pre-taken lock → exactly 1 row, 7 `deduped`, one stage id; lock scope proven correct by holding run A's lock while run B transitioned in **48ms** (a per-tenant lock — the plausible wrong scope — would have serialized the entire pipeline, since every run shares the one agency tenant). **The genuine end-to-end race was reproduced, not merely hoped for:** firing the two platform triggers only serializes (the bridge delivers events one at a time — executions ran 171ms APART), so both workflow webhooks were POSTed concurrently instead, yielding **three overlapping `WS11 delivery track` executions (04:06:08.614/.660/09.259) that ALL returned `action:"released_design"`** — every one decided to create a design — and exactly **ONE** `claude_design` row plus exactly ONE pending `pm_review` resulted. New `pipeline-race.test.ts` (15 tests) is built on a deterministic race window (pre-take the lock, fire N, release) and carries a falsifiability anchor that reproduces the pre-fix duplicate at SQL level. Suites: `platform-nest` **1235/1238** (the 3 failures are the pre-existing `search-notifications.test.ts` `REDIS_URL not set` baseline, SEO-owned), WD-03 signature-lock + façade + WD-05 `updateRun` tests specifically re-verified green, `tsc` + `lint:withtenants` + `lint:migration-rls` clean. **Known limitation, stated plainly:** the schema-level backstop deliberately does NOT cover `claude_design`, because a legitimate revision and a raced duplicate are indistinguishable by the columns on the row (the discriminator is cross-table and causal) — covering it needs an additive revision-discriminator column, which is a write-contract change outside this ticket's approved DDL scope and is filed as a follow-up. |
| 2026-07-30 | `webdev` **WD-26 — digests + stale-nag + relink + n8n hygiene, DEV-VERIFIED live.** Two new n8n CRON flows modeled on `compliance-gate-nag.json` (read → `llm.summarize` → `notify`), the sole `work_activity`-reading digest source (explicitly NOT the legacy `activity.feed` hub tool, which reads the OLD flat `activities` table — LD-16's named trap). `wd-digests.json`: daily 17:00 (1-day window) + weekly Friday 17:00 (7-day window) per-person AND per-project activity digests, one `llm.summarize` call per grouped person/project (never per activity row — the shared/rate-limited Ollama Cloud key stays protected); the weekly branch also fires one `workActivity.relink` sweep. `wd-stale-nag.json`: daily, open `pm_tasks` with no linked activity in N=5 days → nag the assignee; ≥2N=10 days → ALSO notify the project owner (proven with real seeded tasks at 6 and 12 days stale — the 12-day task produced BOTH a `stale_task_nag` and a `stale_task_escalation` row, the 6-day task only the nag). New hub tools (`mcp-hub/src/work-activity-tools.ts`): `workActivity.feed`, `workActivity.staleTasks` (BE computes `daysStale` server-side off `COALESCE(last linked activity, task.created_at)` so N/2N bucketing needs no extra call), `workActivity.relink` (LD-16's deterministic relink sweep — re-runs the pure `deriveLinks` engine over zero-link rows, bounded batch, idempotent by construction). New scoped accounts `wf:wd-digests` (company_admin — needed for the relink tool's admin-only write tier) and `wf:wd-stale-nag` (manager), allowlisted to exactly their own tools (cross-checked: neither can see the other's). **A separate, narrower sweep rides the same ticket per the coordinator's live-data finding:** `POST /api/:t/meetings/recordings/relink-orphans` reconciles `meeting_recordings` rows orphaned by the (now-fixed) 5s ingest-proxy timeout (DEF-1) — matches `meeting_id` ↔ `pipeline_runs.source_meeting_id`; **3 real orphaned rows existed in the live DB and were fixed live** (scanned 13 → relinked 3 → re-run scanned 10/relinked 0, proving idempotency). WD-08-R1 (dispatcher 401 on bad secret) and R2 (dedupe echoes `runId`) were already fixed by another agent before this ticket started — verified still intact post-verification (not re-fixed, not clobbered), along with `pipeline-delivery.json`'s DEF-3 `Suspended (D14)?`/`approvals.request` nodes. **Live verification method:** n8n's CLI `execute` refuses schedule-triggered workflows outright in 2.30.4 ("Missing node to start execution") and the REST API requires an authenticated session, so both flows were fired via a temporary `executeWorkflowTrigger` node patched directly into the n8n Postgres store (never the committed file) routed at each branch in turn, using a one-off `docker run` sharing the real container's data volume + `--add-host=mcp-hub:host-gateway` (the compose `extra_hosts` trick standalone n8n needs); the temp node was stripped by re-importing the clean committed JSON before final reactivation — verified byte-identical after. **A real bug was found and fixed via this live testing, not by inspection:** the digest flow's `Is project?` IF-fan-out reconverges two branches into one downstream node without a Merge, so that node executes once PER BRANCH (separate "runs", not one batched call); `$('NodeName').first()` blindly grabs run-index 0 regardless of which branch's item is actually in flight, and crashed when the project branch's zero-item run happened to land at index 0. Fixed by switching the two affected back-references to `.item` (pairedItem-resolved), which is correct regardless of run ordering — confirmed by an end-to-end `status:"success"` execution producing a real `llm.summarize` call over 49 real live activity rows and a real `notifications` row. **Two rebuild surprises, not migration-related:** `platform-nest` and `mcp-hub` both run compiled `dist/` images in this stack (`build: ../../X` in the vps compose file, no source bind-mount) — the stale-tasks endpoint's live 500 and the hub's initial "unknown tool: workActivity.feed" were both stale-image artifacts, not code bugs; both rebuilt+recreated clean. Two SQL bugs caught only by the live Postgres (not the test suite, which happened to tolerate them): `$2 || ' days'`'s implicit-text-parameter ambiguity (fixed via `make_interval(days => $2::int)`) and a bare `l.target_id = t.id` comparing `text` against `uuid` (fixed via `t.id::text`) in the stale-tasks LATERAL join. No migration in this ticket (stale-tasks/relink are pure reads/writes over existing `work_activity`/`pm_tasks`/`pm_project_meta` tables). `platform-nest` full suite: 106 files/1223 tests, 3 pre-existing failures unrelated (`search-notifications.test.ts` `REDIS_URL not set`) + `tsc` clean; `mcp-hub` full suite 16 files/105 tests green + `tsc` clean except the pre-existing `module-tools.test.ts` `fetch.mock` typing issue. `docs/FRONTEND-BFF-CONTRACT.md` §11 extended with the new stale-tasks/relink rows. |
| 2026-07-30 | `webdev` **WD-28 — PM per-project short-codes (OQ-7 default), Phase-3's first landed ticket — DEV-VERIFIED.** `projects.short_code` (`UNIQUE(tenant_id, short_code) WHERE deleted_at IS NULL AND short_code IS NOT NULL`, derived on creation: first 3-4 uppercase alnum chars of the name, numeric-suffixed on collision) + `projects.task_seq` (atomic per-project counter) + `pm_tasks.seq` (`UNIQUE(tenant_id, project_id, seq) WHERE seq IS NOT NULL`); `CODE-SEQ` display form (e.g. `WEB-142`) computed server-side and returned on every `pm_tasks` read. **Atomicity:** single `UPDATE projects SET task_seq = task_seq + 1 WHERE id=$1 RETURNING task_seq` inside the same transaction as the task INSERT — the row lock serializes concurrent allocators; proven with 30 genuinely concurrent live HTTP POSTs against the running `:3004` container (`Promise.all`/backgrounded curl, not sequential) yielding seq `{1..30}` with zero duplicates. **Two migrations, not one — `0050` shipped a real defect, corrected by `0051` the same day:** `0050`'s backfill DO block ran as `platform_owner` (no `BYPASSRLS`, per the 2026-07-15 DB-topology role split) against `projects`/`pm_tasks`' FORCE ROW LEVEL SECURITY with no `app.current_tenant_ids` GUC set — RLS silently filtered every row to zero, so the backfill inserted nothing while the DDL half still committed and the ledger recorded "applied" with no error. Caught by this ticket's own live-DB verification (not by the test suite, which runs migrations as an unrestricted superuser and never exercises this path). `0051` reruns the identical backfill logic wrapped per-tenant (`set_config('app.current_tenant_ids', <company id>, true)` before each tenant's rows), verified idempotent by direct re-execution against `platform_owner` bypassing the ledger three times running (zero changes after the first). Cross-tenant isolation verified live: two different tenants derived the identical literal short_code text with zero collision. `tsc` + full `platform-nest` suite (106 files/1213 tests, 3 pre-existing failures unrelated — `search-notifications.test.ts` `REDIS_URL not set`, SEO/search-owned) and full `platform-ui` suite (67/67, `tsc` + `next build` clean) both green. |
| 2026-07-30 | `reports` + `report-renderer` **registered at `0.0.0` PLANNED — design only, no code.** New cross-cutting program: [`../blueprints/tracker-reporting-foundation.md`](../blueprints/tracker-reporting-foundation.md) — a multi-grain (person → project → department → company) reporting + appraisal layer over the **existing** PM tracker, at day/week/month periods, for management presentation and appraisal. **Deliberately not a new tracker:** the reuse audit found the substrate mostly already present — `work_activity`/`work_activity_links` (`0030`) is already the 4-grain evidence fabric, `metric_definitions`/`rollup_metrics` is already a governed metric registry with `ratio_of_sums`, `pm_progress_snapshots` (`0040`) already does nightly project-grain snapshots. **Three verified substrate blockers gate everything and are solved in P0:** (1) `pm_tasks.assignee` is a single unindexed JSONB blob with no multi-assignee — and a dept-assigned task has no person at all — so person-grain SQL is not trustworthy → relational `pm_task_assignees` with JSONB backfill + dual-write; (2) department resolution lives in the **frontend** (`platform-ui/src/lib/departments.ts`) off the org blob and is **not time-aware**, so a dept transfer would retroactively rewrite history → server-side resolution + as-of-date `org_unit_memberships`; (3) the estate has no chart lib, no XLSX and no PDF anywhere (only a hand-rolled SVG sparkline and a client-side CSV blob). Locked owner decisions: owner-takes-all attribution + listed contributors (company totals never double-count), **mandatory** per-person EOD check-ins (compliance measured against the HR working calendar so leave is not a false negative), manager-weighted blended appraisals with mandatory commentary + append-only acknowledgement, and server-side PDF now via a Playwright sidecar. Architecture invariants: one atomic `person × project × day` grain with additive rollups and numerator/denominator ratios; one typed `ReportDocument` feeding viewer + exporters + AI narrative + MCP tools; sealed period-close snapshots for management/appraisal vs live recompute for ops. Migrations `0050`–`0055` (**not 0048** — `0048`/`0049` were consumed by search/meeting work while the brief was being drafted; re-verify at TR-01). 30 `TR-*` tickets, P0=5 · P1=3 · P2=4 · P3=6 · P4=4 · P5=4 · P6=4, 12 QA-gated, 3 tagged Opus with in-doc justification. **Verdict recorded:** reporting NEEDS the never-built P1-05 pm→`work_activity` outbox consumer (TR-05), so person-grain completion history starts at TR-05 go-live and the first sealed month is the first appraisal-grade month. Five open questions await owner ratification (see design §13). |
| 2026-07-30 | `webdev` **WD-07 — WD-04's missing frontend + capture UX polish + docs truth (7 of 8 Phase-1 tickets landed).** Built the browser-upload half of WD-04's AC (backend was curl-only verified): `AudioUploadForm` on `/meetings/[id]` (poll-until-terminal via new `GET /api/meetings/:id/status`, mirrors `WhatsAppConnect.tsx`'s pattern) + a combined register-and-upload path in `RecordControls` for the no-existing-recording case; surfaces `transcribing` progress and a `failed`→retry affordance; DEMO_MODE equivalent (`demoUploadAudio`/`demoRetryAudio`, filename-triggered failure simulation) with 7 new unit tests. Verified client/project context end-to-end from the UI: `RecordControls` takes optional `clientId`/`projectId` (wired into the project workspace's new "Meetings" card and the client detail page); the dispatcher's client-context drop (WD-01 finding F-1) was already fixed by another agent — this ticket verified the chain, not re-fixed it. Added run-status chips on `/meetings` (linked pipeline run's own status) and a source-meeting deep link on PRD Studio. Reconciled `FRONTEND-BFF-CONTRACT.md` §8 — the meetings/pipeline/portal rows were still flagged "no UI consumer yet", which had been false since WD-02/WD-04 landed. Registered `webdev` `0.7.0 IN PROGRESS` in `MODULES.md` (was unregistered — the design doc's "register on approval" instruction had never been carried out). `tsc` + `next build` clean, 66 test files / 645 tests green. **Known defect surfaced, not fixed (queued WD-08):** the ingest proxy's `N8N_BRIDGE_TIMEOUT_MS` (5000ms default) is shorter than real dispatcher latency (15–23s), so ingest reports `dispatcher_unreachable` even though the run completes server-side — the UI already degrades honestly here (no false-success claim). |
| 2026-07-29 | `search-marketing` **P1 feature-complete — M2 reached PENDING GATES.** SM-08 (audit ingest, idempotency enforced by a `UNIQUE(tenant_id, property_id, kind, report_hash)` + `ON CONFLICT DO NOTHING`, not just in code), SM-10 (AI briefs/triage/report drafts, ≤1 gateway call per request with all network I/O outside any transaction), SM-12 (Site Audit + Keywords tabs now real surfaces; volume renders three distinct states so "switched off" is distinguishable from "no data"), SM-13 (9 event types → deep-linked notifications, dedupe + cross-tenant isolation tested) and SM-29 (editable scope grid) all AC-discharged. Verified: platform-nest **83 files / 821 tests**, platform-ui **577/577**, `tsc` + `lint:withtenants` + `next build` all clean. **Recurring bug class documented (tracker §4i): three silent frontend-first drift bugs in one day** — the console read fields the backend never sent (`limit` vs `maxKeywords`, a bare-vs-wrapped scope envelope, `tool_scope` missing from the LIST SELECT), each rendering a confident wrong answer while nothing threw; typecheck cannot catch it and demo fixtures hide it. Also fixed a real hydration divergence mis-reported as cosmetic (`toLocaleString` depends on runtime ICU data). ⚠️ **Five tickets sit AC-discharged but UNGATED** (SM-08/10/12/13/29) — the largest current risk in the module, given today's gates caught a money-path fail-open, two SSRF defects, a permanently-broken route and two fabricated doc citations. |
| 2026-07-29 | `search-marketing` **⚡ P1 gate CLEARED — SM-07 + SM-09 LANDED.** Final verified state: platform-nest **79 files / 785 tests**, `tsc` + `lint:withtenants` clean, `search-crawl-go` build/vet/test green. **The mandatory SSRF gate earned its name:** QA attacked the guard past its original 12 cases and two got through — (1) `isDeniedIP` missed the deprecated IPv4-**compatible** IPv6 form (`::7f00:1` = 127.0.0.1; `To4()` only unwraps the *mapped* `::ffff:` form, so every private/CGNAT branch skipped it and the classifier called it public — low/theoretical since modern kernels don't route it, but fixed regardless); (2) a **reachable** rate-limiter key skew — the allowlist stripped the FQDN trailing dot while `RoundTrip` only lowercased, so `site.example` and `site.example.` were one host to the allowlist but two budgets to the pacing layer, defeatable via same-host redirects. Both fixed, the second at its cause: one shared `normalizeHost()` now serves every host-keyed layer. **Cerbos decision: ACCEPT `update` for `/embed` + `/cluster`** — the architect overturned the concern with repo evidence (`resource_search_keyword.yaml` already grants `research`, a real-dollar paid pull, at the same baseline tier; design §07 types clustering as "AI draft | low"; embed/cluster never enter the SM-04 metered path). **SM-04 carry-overs applied:** 30s in-process TTL cache on `sumGlobalMonthToDate`, its read-only/aggregate-only invariant now **enforced by a SQL-shape test** rather than a comment, and `recordBlocked` guarded so a failing audit write can't mask `GlobalCeilingUnavailableError`. **Ticketed rather than silently accepted:** SM-32 (no cap on keyword-set size — one sequential gateway call per keyword inside a single held-open transaction) and a `parseKeywordImport` defect that corrupts commas inside quoted CSV fields. |
| 2026-07-28 | `search-marketing` **P1 begun: SM-09 + SM-07 AC discharged** (both awaiting their ⚡ gates). **SM-09** — keyword import (CSV/paste), `/embed` embeddings, deterministic dual-mode clustering, Hermes intent labels; no migration needed (0034 already had the columns); gateway is the asserted sole AI egress path; 1k-keyword determinism proven twice (pure-function scale test + full HTTP→DB integration), dual vector mode proven by an array-vs-pgvector-literal parity test since pgvector is absent. ⚠️ Flagged for architect: `/embed` and `/cluster` are gated under the existing Cerbos **`update`** action (no dedicated action exists), so keyword-edit rights also confer gateway-compute spend — may warrant new actions. **SM-07** — new standalone Go project `search-crawl-go/` + a `search-crawl` compose job. The egress guard enforces at `DialContext` and dials the **literal validated IP**, closing the resolve-then-connect race; redirect SSRF is covered by construction; rate limiting sits at `RoundTrip` so keep-alive can't dodge it; JSONL audit on every decision. 27 Go tests cover every required bypass class (DNS-to-private, redirect-to-private, IP-literal, IPv4-mapped IPv6, metadata IP, multi-A-record, DNS-failure-fails-closed); verified end-to-end in Docker incl. a real DNS rebind. SEONaut/open-seo-crawler/Unlighthouse runners **deliberately deferred** — one honest crawler proves the guard. **SM-31 (harness) RESOLVED:** per-file DB isolation replaced a shared destructively-reset database, so the full suite is trustworthy in one invocation for the first time — **78 files / 772 tests green, verified independently**, `tsc` + `lint:withtenants` clean. |
| 2026-07-28 | `search-marketing` **SM-11 console AC discharged — the SEO department now has a UI** (awaiting its own ⚡ gate). Pulled forward out of design order at the owner's call, since the department had no visible surface; legitimate because SM-11's only hard dep is SM-02. `platform-ui/src/lib/searchMarketing.ts` (typed BFF client — deliberately NOT `lib/search.ts`, which is unrelated global search) + the `seo` toolkit as the first **three**-craft-group console (Accounts / Optimize / Campaigns, D-10) + 12 routes. Engagements list + engagement detail render REAL landed data incl. the metered-tools table that explains why a paid pull was refused; the 10 capabilities whose backends are unbuilt render `BackendPending` naming their cost tier, missing endpoint and owning ticket rather than an empty table. `tsc` clean · UI suite **537/537** · `next build` green with all 12 routes. Two pre-existing toolkit tests that asserted SEO was unbuilt now assert the new spine (generic-fallback guard repointed at SMM). **Not done, deliberately:** the ticket's Connections additions — GSC/GA4/Ads need SM-25's OAuth work, which is externally gated. Contract documented in `FRONTEND-BFF-CONTRACT.md` §14. |
| 2026-07-28 | `search-marketing` **⚡ P0 gate CLEARED — SM-04 + SM-05 + SM-06 declared LANDED; M1 reached.** 126/126 across the six search suites on live PG + Cerbos (one file at a time, DB reset between files — see SM-31); `tsc` + `lint:withtenants` clean. **The gate found and fixed a fail-OPEN on the money path:** `dispatchProviderOp` degraded `globalMtd` to 0 when `sumGlobalMonthToDate()` threw, and a $0 month-to-date can never breach — so any error silently disabled the platform-wide ceiling, which on the default config (`globalMonthlyCapUsd` $150 always set, `tenantMonthlyCapUsd` null and skipped) is the ONLY platform-wide tier. Now fails closed via a new `GlobalCeilingUnavailableError` + a cost-0 `failed` audit row, pinned by a regression test. Architect decision: the `lint:withtenants` allowlist entry for `ledger.ts` `sumGlobalMonthToDate` is **RATIFIED** (aggregate-only/read-only; `SECURITY DEFINER` rejected because it would hide the cross-tenant read from the linter). **New ticket SM-31** (repo-wide, not search): the vitest harness destructively resets a test DB shared by all 74 suites, so multi-file runs fail nondeterministically — every failure is a schema-availability artifact, never a behavioural assertion; the full-repo `639/1` baseline is not reproducible until it lands. |
| 2026-07-27 | `search-marketing` **SM-03 declared** after verification (60/60 across the four search suites on live PG + Cerbos); status-doc drift reconciled (MODULES.md section said `0.0.0 PLANNED` while the registry said `0.1.0 IN PROGRESS`); execution tracker added (`blueprints/seo-sem-execution-tracker.md`). SM-04 confirmed half-built and now the critical path. |
| 2026-07-24 | **D1: WhatsApp + Agent runtime verified and documented** (`erp-whatsapp-and-agent-runtime-e2e.md`). wa-chat-bot 0.8.0 (session-lifecycle admin plane + writable group registry), platform-nest 0.6.0 (bot+agent proxies), platform-ui 0.6.0 (Connect-WhatsApp + Group Registry + agents-live surfaces), ai-agents 0.4.0 → PROTOTYPED (agent-runner service + goal/run store + queue), ai-gateway-go 0.11.0 (provider timeout + 429/RateLimitError breaker + error taxonomy), infra 0.5.0 (agent-runner + bot writable volumes + .env updates). Agent runtime DEV-VERIFIED end-to-end (pipeline+gateway+D13 forced_read_only persisted); bot session e2e (start→SCAN_QR_CODE→QR). UI-through path PROTOTYPED (not yet deployed — pending search-marketing build blocker). |
| 2026-07-23 | **Baseline versions assigned** to all modules for tracking-forward; this registry + changelog created. |
| 2026-07-23 | `creative` registered `PROTOTYPED` (Image Studio + `creative_assets` already in dev) with a v1.0 expansion design; new `render-gateway-go` added `PLANNED`. Foundation + design + PDF authored; 4 owner decisions locked; 27 tickets CR-00–CR-26. |
| 2026-07-23 | `social-media` added as `PLANNED` (foundation + v1.0 design; Postiz AGPL-contained; 3 decisions locked — scope, publisher, drop Chatwoot). |
| 2026-07-23 | `search-marketing` added as `PLANNED` (foundation + v1.1 design ratified; 4 owner decisions locked). |
| 2026-07-23 | `webdesk` added as `PLANNED` (blueprint approved). |
| 2026-07-15 | `observability` + `automation` reached DEV-VERIFIED (e2e on live Docker stack). |
| 2026-07-14 | `sync-engine-go` first prototyped; Node `ai-gateway` retired in favor of `ai-gateway-go`. |

> Older "Built/Complete" wording in `README.md` / `CLAUDE.md` predates this vocabulary — read it as
> `PROTOTYPED` / `DEV-VERIFIED` unless a production deploy is explicitly stated.

---

## platform-nest
### [0.12.0] — 2026-08-04 · PROTOTYPED (client portal backend, CP-*)

The backend for the client portal — the client side as a **separate interface** (owner decision,
2026-08-04). Plan + runbook: `docs/plans/2026-08-04-client-portal-deployment.md`; contract §16 of
`docs/FRONTEND-BFF-CONTRACT.md`.

- **Migration `0075_client_portal.sql`** — `contracts` (versioned, with a term and a value,
  `supersedes_id` for re-issues), `contract_signatures` (one row per party, UNIQUE — the
  `scope_signoffs` shape reused deliberately rather than a second signing idiom), and
  `invoice_payments` (an append-only money ledger behind `invoices.status`, which had a status enum
  and nothing else: no amount, no date, no method, no reference, no proof, and therefore no partial
  payments and no balance). Head was 0074; `0058`/`0059` remain the reports program's orphaned
  reservation gaps. Pure DDL — no backfill, so the `migration-backfill-rls-trap` does not apply.

- **`portal-scope.ts`** — the portal's isolation kernel, extracted from `PortalController` because the
  portal grew from 3 routes to ~20 across four controllers and a rule re-derived four times is a rule
  that will disagree with itself.

- **TWO LATENT IDOR GAPS CLOSED while extracting it**, both of the same shape — a value resolved and
  then not applied:
  - `decideGate` and `scopeSign` both resolved `projectIds` and **never used it**. The read paths
    (`listRuns`/`getRun`) carried the project predicate, so a project-scoped contact could not SEE a
    run outside their project — but could DECIDE its gate or SIGN its scope, addressable by one id
    with no listing step.
  - `client_contacts.capability` (`signer`|`viewer`) existed since 0072 explicitly so that "contacts
    who WATCH but must not SIGN" was expressible, and **nothing ever read it**: every invited
    stakeholder could countersign a scope agreement. Now enforced on both signing paths, while a
    viewer keeps feedback and payment (paying is not signing).

- **Portal BFF, three read/write controllers**: `portal-workspace` (overview, projects, project
  detail, milestones, timeline, deliverables), `portal-commerce` (invoices, payment-with-proof,
  contracts, e-signature, and the portal's own scoped file download), `portal-profile` (profile,
  own-details PATCH, change-request). Client-safe by construction, not by filtering: individual tasks,
  effort/cost, and the raw `activities` log are structurally absent, and the timeline is a UNION over
  client-visible OBJECTS so a new internal event type cannot leak into a client's feed by default.

- **Realtime (`portal-live.service.ts` + `portal-stream.controller.ts`)** — the first SSE in this
  platform and the first long-lived connection served to external parties. **A frame carries a topic
  and a timestamp and nothing else**; the browser's reaction is to refetch through the
  ownership-enforcing BFF, so authorization still happens exactly once where it already worked and a
  fan-out filtering bug costs a wasted refetch rather than a disclosure. Tails the existing Redis
  Streams with a plain `XREAD` from the tail (at-most-once, no consumer group — joining the
  `in-process-platform` group would have STOLEN entries from module dispatch). Owns its own Redis
  connection with its own `error` listener: `getRedis().duplicate()` would have constructed the shared
  lazy client purely to clone its options, and that client has no error handler — which surfaced
  immediately as an "[ioredis] Unhandled error event" on a machine where `REDIS_URL` points at a
  Redis that is not running (every dev box). 9 unit tests, no infrastructure needed.

- **`contracts.controller.ts` — the staff counterpart**, shipped in the same change because without it
  the portal's contracts section is permanently empty and a client-recorded payment can never leave
  `pending`. Draft → send → countersign (owner-only, deliberately narrower than `company_admin`), plus
  the payment confirm/reject decision that **refuses self-confirmation** and derives
  `invoices.status='paid'` from the confirmed ledger rather than from the request.

- **Cerbos**: `resource_portal.yaml` gains `pay` + `update_profile` (each its own action, so one can be
  revoked without the other); **new** `resource_contract.yaml`. A new policy file has been observed not
  to hot-reload through a bind mount, and an unloaded policy DENIES silently — so `deploy.yml` now
  restarts Cerbos explicitly after syncing policies.

- **Two client-facing notification hrefs corrected** (`client-notify.ts`, `pipeline.controller.ts`):
  both pointed at bare `/portal` for run-specific events, which now lands on the dashboard rather than
  the thing that needs the client. Both deep-link to `/portal/approvals/:runId`.

- **`files` target kinds** gain `contract` and `invoice_payment`. Note this grants a client nothing:
  the staff upload route re-authorizes against the parent kind, which the `client` role does not hold.

**Verification:** `tsc --noEmit` clean; `portal-live.test.ts` 9/9. `portal-dashboard.test.ts` (25
DB-backed isolation/capability cases, incl. cross-client 404s, viewer-cannot-sign, overpayment refusal,
and the download IDOR) is **written and typechecked but UNVERIFIED** — the local Postgres/Cerbos pair is
deliberately off (the server is the source of truth); it runs in CI.

### [0.11.0] — 2026-08-04 · PROTOTYPED (the regression test the seal-hash fix shipped without)
Recorded after the fact for the `reva/ui` half of this version; the concurrent session's client-portal
/ pipeline work and migration `0074` also land under it. See `Alpha 01.010.0029a`.

- **`report-seal.hash.test.ts`**, from `reva/ui`. `canonicalStringify` mishandled `undefined`:
  `JSON.stringify` omits an undefined-valued property when writing JSONB but returns the VALUE
  `undefined` when called on it directly, which interpolates as the literal text `"undefined"`. So a
  freshly-built document hashed as `..."warnings":undefined...` while the same document re-read from
  storage hashed as nothing at all — `seal_hash` could never be reproduced, for essentially every
  sealed period. Because a tamper check that never reproduces is indistinguishable from one that
  caught tampering, the failure presented as a permanent false "these rows were altered".
- Both branches had fixed the code independently and identically. **What this adds is the test**, not
  the fix — the fix shipped unverified. Main's implementation was kept through the merge because it
  additionally handles `toJSON()` (a `Date` would otherwise hash as `{}`), which reva's did not.

> `0.9.5` and `0.10.0` have no entries — see the ledger-gaps note in `Alpha 01.010.0029a`.

### [0.9.3] — 2026-08-03 · PROTOTYPED (two endpoints that described the wrong world)
- **`GET /api/roles` returned every company's role rows.** Per-company roles share their NAMES across
  companies, so the assign-role picker rendered `manager` ten times and `company_admin` three times
  with nothing to distinguish them — and nine of those ten grant a role row owned by a different
  company. Now takes an optional `tenantId` and narrows to `company_id IS NULL OR company_id = $1`.
  Optional, so tenant-less callers keep working; membership-checked when passed, so it cannot be used
  to enumerate the roles of a company the caller has nothing to do with.
- **`automation/status`'s `n8nUrl` was the in-cluster base.** The UI turns that field into the "Open
  in n8n" link, so it was handing browsers `http://n8n:5678` — a name that resolves only inside the
  compose network. The console reported the service healthy and listed its workflows the whole time,
  which is why it went unnoticed. Split out `config.automationPublicUrl`
  (`AUTOMATION_PUBLIC_URL`); `n8nUrl` is now that value, omitted when unset so the UI hides the
  button rather than rendering a dead link, and the config panel shows both values labelled.
  Deliberately NOT inside `config.services` — that object is indexed by system name, so an extra key
  there would read as one more probeable service.

Verified: `tsc --noEmit` clean; `admin-systems` suite 24 pass. The pre-existing `n8nUrl` assertion
(`toContain("/n8n")`) had been passing only because this suite's `AUTOMATION_URL` happens to contain
that substring — replaced with one that asserts the public origin is used, that it differs from the
reported in-cluster base, and that the field is absent when unconfigured.

### [0.9.2] — 2026-08-03 · PROTOTYPED (effective module set, one query)

- `enabledModuleKeys(tenantId)` in `modules/registry.ts` — the SET form of the enablement rule
  (`enabled_modules` UNION active `service_assignments`). **`isModuleEnabled` now delegates to it**,
  so the OR-clause exists in exactly one query instead of two hand-written copies that can drift
  (the failure mode being a served tenant authorized on one path and denied on another).
- `GET /api/:tenantId/modules-enabled` — the effective set for one company. Membership-gated (403
  without a membership or a global `platform_admin`), not `authorize()`d: it is metadata about which
  surfaces exist, needed by every page a member can already open.
- The rewritten query was diffed against the old per-key `EXISTS` form on the live `gda-aicenter`
  database for all three companies — identical results, including the empty case (`{}` → no rows →
  `[]`, so `isModuleEnabled` stays false).

Verified: 8 unit tests (4 new, covering the membership branches with the registry mocked),
`tsc --noEmit` clean. The DB-backed paths are covered by the hr/reports suites against live PG,
which were **not** run — no local Postgres by standing decision.

### [0.9.1] — 2026-08-03 · PROTOTYPED (module catalog endpoint)

- `GET /api/module-catalog` (AuthGuard, no `authorize()`, deliberately **no** `ModuleEnabledGuard`) —
  the modules **compiled into the running build**: key + `uiManifest[0].label` + owned paths. The
  registry is a compile-time artifact, so this is tenant-agnostic; per-tenant enablement stays in
  `isModuleEnabled()` at each module's controller. Gating the catalog on enablement would recreate the
  very disappearing-row bug it exists to fix (see platform-ui `0.10.1`).
- No migration, no schema change, no behaviour change to any existing route.

Verified: 4 new unit tests, `tsc --noEmit` clean. The endpoint has **not** been driven at runtime —
the deployed `alpha-01.005.0015a` image predates it.

### [0.9.0] — 2026-08-03 · PROTOTYPED (IT network discovery + the device write half)

Migration `0071`. **The reported bug was not a bug.** "IT > Topology doesn't show all the devices in
the network" — measured against the real office network the same day: SSID `GDA`, `10.10.0.0/22`,
**~58 live hosts** behind a UniFi OS gateway at `10.10.0.1`. The ERP held **8 rows**, all hand-seeded
fiction on a `10.0.x.x` range that does not exist here, and a codebase-wide grep for
UniFi/SNMP/ARP/mDNS discovery returned **zero hits**. The feature never existed.

- **The ERP cannot poll the controller — verified, not assumed.** `10.10.0.1` is RFC1918 behind office
  NAT; `curl` from `gda-aicenter` returns HTTP `000`. Discovery is therefore a **push**:
  `POST /api/:t/it/discovery/report`, fed by `it-site-collector` (**not built** — blocked on a
  read-only UniFi API key and an always-on office host).
- `GET /api/:t/it/topology` — server-computed `{ devices, links, lastRun }`. `lastRun` is load-bearing:
  a **dead collector** and an **empty network** otherwise render identically.
- `PATCH` + `DELETE /api/:t/it/devices/:id` — the edit/delete half `0019_it_devices.sql` and
  `lib/it.ts` both promised and that was never built. `deleted_at` was filtered on by every query and
  written by nothing, so devices were immortal.
- **Status is now derived** from `last_seen_at` freshness (dark-by-default reaper). Nothing had ever
  called the heartbeat endpoint, so every UI-registered device kept the DB default `unknown` forever
  and rendered grey.
- New tables `it_device_links` (resolved edges) + `it_discovery_runs` (audit/staleness), both
  FORCE-RLS; the classify backfill is wrapped per tenant so it cannot silently no-op.

Three measured facts drove the design: **MAC is not an identity** (~60% of observed MACs are
randomized, so upserts key on UniFi's stable client id); **ICMP undercounts 5×** (12 of 58 hosts
answer ping, so liveness comes from the controller's client table, never a probe); and **BYOD is
counted, never stored** — ~25 of the 58 hosts are personal phones whose hostnames name staff outright,
so persisting them would build a presence log of named employees, which CLAUDE.md forbids before legal
Gate 1. Classification is recomputed server-side so a mis-set collector cannot launder them in.

Discovered rows carry an `overrides` layer so an operator's correction survives the next poll instead
of reverting ~5 minutes later. Seed fiction is now off by default (`SEED_DEMO_DEVICES=1`) and labelled
`demo-fixture`.

Deliberate deviation from the design doc: ingest authorizes on the existing Cerbos `create` action,
not a new `discover` one — a new action is a silent DENY until Cerbos restarts, and `create` is
already scoped to `company_admin`/`it_staff`.

Verified: 34 IT tests (20 pure + 14 against live Postgres + Cerbos incl. `0071`); full suite
2628 passed / 4 skipped / 0 failed; `tsc` clean; both migration lints clean. Carried forward: the live
tenant's 8 seeded rows still need purging (per-tenant SQL in the design doc §12).

### [0.6.3] — 2026-07-27 · PROTOTYPED (systems-console write levers)
- **NEW `PUT` + `DELETE /api/admin/gateway/config`** — proxies the gateway's new config-write route.
  The gateway owns validation/bounds/persistence; this layer re-throws its 4xx VERBATIM (400 bounds,
  400 non-writable key, 409 can't-take-effect) so a rejected value explains itself instead of
  collapsing into "gateway unreachable". `editable` on each ConfigField is driven by the gateway's own
  `writableKeys`, so this layer can never offer a save the gateway would refuse — and an older gateway
  yields a read-only page automatically.
- **NEW `POST /api/admin/automation/workflows/:id/activate|deactivate`** — n8n Public API, returning
  n8n's own resulting state. Gated to `isElevated`, deliberately NARROWER than the `isItOrElevated`
  read-only canvas: deactivating silently stops business automation with no other signal.
- **NEW `POST /api/admin/automation/bridge/:entityType/replay`** + `replayBridgeDeadLetters()` — moves
  dead-lettered entries back onto the source stream for redelivery. Re-adds BEFORE deleting, so a
  crash duplicates (which the at-least-once bridge + n8n's envelope-id dedupe already handle) rather
  than dropping. Refuses any stream the bridge isn't configured to watch, so an arbitrary Redis key
  can't be targeted through the route. This is the sanctioned "retry a failed automation": n8n's
  Public API has no execution-retry route, and re-running from the real input beats resuming a
  half-finished run.
- 723 tests green on live PG + Cerbos (+15: 6 admin-systems write cases, 9 new `bridge-health` unit
  tests covering the replay ordering guarantee, NOGROUP-vs-real-error, and fail-soft reads).

### [0.6.2] — 2026-07-27 · PROTOTYPED (systems-console depth: real config projections + 6 new admin reads/writes)
- **Root cause of three thin consoles:** `connectionConfig()` returned only `{url, tokenConfigured}`
  for every system except `bot`, so the Gateway/Hub/Automation "Configuration" cards were a two-row
  descriptor forever — and the Gateway page's "Provider chain" card looked for a config field keyed
  `providers` that nothing ever emitted, so it showed its empty state permanently. `GET
  /api/admin/:system/config` now returns a REAL projection per system (`gatewayConfigFields` /
  `hubConfigFields` / `automationConfigFields`), with the honest connection descriptor **appended,
  not replaced**, and every credential still `kind:"secretPresence"` (presence only).
- **NEW `GET /api/admin/gateway/detail`** — proxies the gateway's new `GET /admin/config`: chain in
  failover ORDER + live breaker state, provider inventory, budget breakdown **incl. per-tenant
  spend**, reliability tuning, security/topology posture.
- **NEW `POST /api/admin/gateway/dr-mode`** (`isElevated`) — WS9 D15 failover lever, proxied so the
  gateway token never reaches the browser. It raises the daily cap, so it is a platform-admin action.
- **`GET /api/admin/gateway/egress-audit` extended** — `?limit&provider&capability&decision` and the
  block taxonomy carried as structured `{capability, ok, blocked, redactions, latencyMs}` instead of
  being flattened into the free-text `detail`. Legacy fields retained.
- **NEW `GET /api/admin/hub/detail` + `GET /api/admin/hub/audit`** — the hub's posture block and its
  §8 tool-call decision trail. The audit had been written to JSONL and was readable nowhere.
- **NEW `GET /api/admin/automation/executions`** — n8n run history with `workflowId` resolved to a
  name + `durationMs`. The executions list was already being fetched and then discarded except for
  one "last run" cell per workflow.
- **NEW `GET /api/admin/automation/bridge`** + `src/events/bridge-health.ts` — event→n8n bridge
  delivery health (per-stream backlog, dead-letters, oldest-pending age, bridged event allow-list).
  A stalled bridge silently stops every event-triggered workflow while the workflow list still reads
  "active"; nothing in the console could show that. Fail-soft: Redis unreachable / no consumer group
  degrades to a per-stream note, never an exception.
- 708 tests green on live PG + Cerbos (admin-systems suite 17, +9 new cases).

### [0.6.1] — 2026-07-27 · PROTOTYPED (bot-proxy honesty fixes)
- **`botCall` swallowed 404s:** only a 400 was surfaced verbatim; every other non-OK status became
  `502 bot admin unreachable`. So the bot correctly answering `404 {"error":"unknown chat (no stored
  messages)"}` made the Chats tab report the bot as DOWN. 404 is now surfaced as a `NotFoundException`
  carrying the bot's own message. Found because the assertion covering it had never actually executed —
  see the stub fix below.
- **Status probe treated "unknown" as a real session:** `admin-systems.controller.ts` did
  `typeof h.session === "string" ? h.session : undefined`, and the bot's `/health` placeholder for
  "no session event observed yet" is the literal string `"unknown"` — truthy, so the fallback to the
  authoritative `/admin/session/status` never fired and the ERP pill showed UNKNOWN on a WORKING session.
  Now `"unknown"` is treated as missing.
- **Test-harness fix (`bot-admin.test.ts`):** the bot stub matched the thread route with
  `url.endsWith("/messages")`, which is false once `?limit=2` is appended — the request silently fell
  through to the chats-LIST branch, so the thread assertions were validating the wrong response and every
  assertion after the first was dead. Stub now matches on the path. New coverage: `/health` reporting
  `session:"unknown"` must still resolve to WORKING via the fallback.

### [0.6.0] — 2026-07-24 · PROTOTYPED (bot-admin + agents intelligence proxies)
- **Workstream A+B admin proxy layer (design §2.4 + §3.3):** NEW `admin/bot-admin.controller.ts` (`@Controller("api/admin/bot")`), isElevated-gated,
  proxies wa-chat-bot's `/admin/*` routes with fail-soft (bot unreachable → 502, unconfigured → 404). Routes: POST session/start, GET session/status,
  GET session/qr (Cache-Control: no-store), POST session/{stop,logout,restart}, GET/PUT groups (validates `{groups:[…]}` before forwarding),
  PUT config (`{key,value}` allow-list `{postToGroups,managementGroupId}` → 400 otherwise). Extracted `isElevated` helper to shared `admin/elevated.ts`.
- **Real agent-runner proxy (vs. old hardcoded stubs):** `intelligence.controller.ts` now makes live HTTP calls to agent-runner service. Config: `services.agents
  = {url: AGENTS_URL, token: AGENT_RUNNER_TOKEN}`. Routes: `GET /api/:t/agents/goals` (tenant-filtered, `authorize(activity read)`), `POST /api/:t/agents/goals`
  (isElevated, idempotently upserts platform self-link `identity_links(provider='platform', external_id=userId)`, calls runner `POST /goals` with envelope),
  `GET /api/:t/agents/goals/:goalId` (detail + blackboard + run summaries, tenant-pinned), `GET /api/:t/agents/runs/:runId` (full run + steps, isElevated only —
  transcript can carry user-triggered tool output). `probeStatus("agents")` now hits `/health` real-time; `connectionConfig("agents")` no longer says "CLI/library".
- **Not deployed yet:** nest endpoints verified against running agent-runner (pipeline+gateway working end-to-end per design spec §3.2).

### [0.5.0] — 2026-07-23 · PROTOTYPED
- Baseline. Core schema (FORCE RLS), ModuleContract + custom fields, Cerbos RBAC, OBO/identity links,
  rollups, agency vertical, event backbone (outbox→Redis Streams). ~92 dev tests.
- **Unreleased / next:** identity writes, org-structure endpoints.

## platform-ui
### [0.15.0] — 2026-08-04 · DEV-VERIFIED (the client portal, CP-*)

The client portal as a **separate interface** from the employee ERP (owner decision, 2026-08-04). The
separation that was missing was presentational — the backend split was already clean — so this is a new
route group with its own shell, navigation, vocabulary and empty states, sharing the design system and
none of the staff layout.

- **`(portal)` route group, 11 routes.** Overview · Projects (+detail) · Timeline · Deliverables ·
  Approvals (+run detail) · Invoices (+detail) · Agreements (+detail) · Profile. `(app)/portal/*` was
  **deleted** — two route groups cannot both serve `/portal` — and the old `/portal/[runId]` moved to
  `/portal/approvals/[runId]`, which also removes a dynamic segment that sat one static sibling away
  from swallowing `/portal/invoices`.

- **Route group, not a second Next app.** It is genuinely a separate interface; what it does not
  duplicate is the plumbing (HMAC session, the single server-side egress, tokens, DEMO_MODE, the
  Playwright harness, the CI build gate). Splitting it out later is moving one folder; unpicking a
  divergent copy of the session layer would not be.

- **Own chrome** (`components/portal/`): sticky header + horizontal tab strip, a live-state indicator,
  and a two-item account menu. Deliberately absent: the company switcher (a client belongs to the one
  company that serves them), global search over internal entities, the approvals inbox, the departments
  rail, and the density/width preferences. All colours come from the token layer — `portal.css` contains
  no literal, so `styles/tokens.test.ts` still governs it.

- **`PortalLive`** — EventSource against a new `/api/portal/stream` route handler (one of the enumerated
  exceptions to "pages call `platformFetch` directly": EventSource is a browser API and the token never
  leaves the server). It renders no stream data — a frame triggers `router.refresh()`. **Polling is
  always armed** (120s live / 30s otherwise) rather than switched on after a detected failure, because
  SSE fails invisibly from the client: a buffering proxy, a network that kills long-lived connections, a
  backend with no Redis. Also refreshes on tab focus.

- **`lib/portal.ts` split into the documented trio** (`portal.ts` pure + `portal-data.ts` server-only +
  `portalActions.ts`). It used to BE the reader module; a `"use client"` live component importing
  `PortalTopic` from it would have pulled `server-only` into the browser bundle — the exact trap where
  `tsc` and vitest pass and `next build` breaks.

- **Money and dates are locale-pinned** (`money`, `portalDate`, `relativeDays`, `isPastDue`). Bare
  `toLocaleString` reads the host's ICU data, so server render and client hydration disagree; on a due
  date that is the difference between "today" and "overdue", and on an invoice it is a client's total.

- **Write flows use `useActionState`, not void form actions.** The server refuses these for reasons a
  client can act on ("your access is view-only", "amount exceeds the outstanding balance", "this
  agreement's term has ended"). A void action swallows all of them and re-renders unchanged, which reads
  as "the button is broken" on the two most consequential things a client does here.

- **The payment form never says "paid".** It records a claim that finance verifies, and the copy says
  so — a client who believes the portal has settled their invoice will not answer the reminder that
  follows. The contract page puts the terms ABOVE the signature block, always: a sign button on a page
  that does not show what is being signed is not a signature, and the form does not render at all when
  no document is attached.

- **A real bug the tests caught, fixed in the backend too:** re-signing a contract returned **400 "this
  agreement is signed and cannot be signed"** to the person who had just successfully signed it, because
  the status check ran before the already-signed check — and signing is what changes the status. A
  double-tapped button on a phone hit it. Both the controller and the fixture now check idempotency
  first.

- **`demoPortal.ts`** — a stateful demo store carrying the states that make branches reachable in a
  browser: an overdue open milestone, a contract awaiting the client with our side already signed, a
  partially-paid invoice. It mirrors the real BFF's *behaviour*, not just its shapes — the identity 403
  and the payment claim/confirm split are asserted, because DEMO_MODE is what the build gate and
  Playwright run against, and a fixture more permissive than the backend makes every downstream check
  pass against a backend that does not exist.

**Verification (local):** `tsc --noEmit` clean · `DEMO_MODE=1 npm run build` green with all 11 portal
routes emitted · `npm test` **1040/1040** across 102 files (43 new: 25 pure-helper, 18 fixture-fidelity)
· `playwright --project=portal` **6/6** — the shell swap (staff surfaces asserted ABSENT), all 8 tabs,
contract signing, payment recording, and the staff teach-state.

### [0.12.0] — 2026-08-04 · PROTOTYPED (design-system pass from `reva/ui`, plus the queue fix)
Authored on `reva/ui` across 15 commits and consolidated in merge `04459ef`; that branch never
versioned its own work, and the cut it landed in (`Alpha 01.010.0029a`) was made by a concurrent
session for a different change, so this entry is written after the fact. Full context in that release
entry. The concurrent session's own portal fix also lands under this same version.

- **Token layer** (`styles/tokens/`, 5 files). The chart palette moves out of component CSS into
  tokens — light, both dark blocks, and the print override side by side — so the existing parity test
  now covers chart colours too. 5 hard-coded colours fixed, including `--erp-ink-40`, which was
  defined nowhere in the codebase and had been silently rendering its `#999` fallback with no
  dark-mode value.
- **`/calendar` rewritten** — personal focus, real month/week/day grids, and an explicit "N of yours
  have no date — not shown here" instead of quietly dropping undated items. This deletes the workload
  panel `0.10.3` had just repaired; the rewrite serves that fix's purpose better.
- **PM** — tasks open in a slide-over, the project workspace leads with the work, and the Gantt no
  longer re-renders itself to death when handed no `groups` prop.
- **`fix(queue)`: My Work was blind to every PM task.** The queue read the core `tasks` table while
  the app writes `pm_tasks`, and never loaded `lib/pm`'s `statusFlags`, so it could not tell done from
  open either. Structurally empty while looking healthy — the same class as `0015b`'s
  knowledge-indexing miss.
- Dashboard hierarchy with real tasks · state-legible form inputs · loading feedback where Next
  showed none · empty states unboxed ("a sentence, not a boxed panel") · page header cut to one line ·
  KPI tiles explain the rule their label hides · Settings → About reporting the deployed version ·
  a component guide for the project.

Verified on the merge result: `tsc` clean, `next build` green, 974 tests pass (945 before — 29 new).

> `0.10.4` and `0.11.0` have no entries — see the ledger-gaps note in `Alpha 01.010.0029a`.

### [0.10.3] — 2026-08-03 · PROTOTYPED (six surfaces that reported a state they were not in)
Found by driving the live site as a signed-in user across all 84 routes under both companies. None of
these threw; each one asserted something false, which is why they had survived.

- **Roles picker** — passes the active tenant to `listRoles` so the catalog stops listing every
  company's identically-named roles.
- **HR scope** — the selector called every company "served" because an elevated caller was folded in
  as a `home` grant, while the envelope directly beneath reported those same companies "not served".
  Adds an explicit `elevated` reason, renames the option to "All companies in scope", and widens the
  404 label to "HR not enabled or not served" (the backend returns 404 for both).
- **Tasks** — the default all-companies leg is assignee-scoped, so a task you had just created
  unassigned looked like it was never saved. The empty state now says the view shows only your own
  tasks and links each company's "All tasks" view.
- **Calendar workload** — refused to render without a narrowed scope, while all-companies IS the
  default: dead for every visitor. A per-person split is meaningless there (the union is the caller's
  own tasks), so it breaks the same rows down by company.
- **Hydration** — React #418 on `/systems/gateway`, `/hub`, `/automation`. Bare `toLocaleString()`
  formats in the container's zone server-side and the visitor's client-side, so the text differed and
  React threw away the server HTML for that subtree. Adds `formatTimestamp()` on a fixed display zone
  (`NEXT_PUBLIC_DISPLAY_TZ`, default `Asia/Singapore`, inlined at build so both sides agree) and moves
  those call sites onto it; `formatDate`/`formatDateTime` pinned to the same zone.
- **Client portal** — the BFF 403s "not a portal client" for any staff member, which the reader folded
  into an empty list, so staff were told "once your kickoff is processed, your project appears here"
  as though a project were on its way to them. The reader carries that distinction now.

Verified: `tsc --noEmit` clean, `next build` green, 945 tests pass.

### [0.10.2] — 2026-08-03 · PROTOTYPED (a disabled module now says so)

Closes the mismatch `0.10.1` left open: nothing outside the settings page read `enabled_modules`, so
a disabled module's pages stayed clickable and merely came back empty — **identical to a company
that genuinely has no clients, no devices, no invoices**.

- `lib/modules.ts` — `moduleGate()` / `isModuleOnForActiveCompany()` over
  `GET /api/:t/modules-enabled`. **Fail-open on purpose:** a module reads as disabled ONLY when the
  backend positively said so. Missing endpoint, error, odd payload shape, no active company → every
  module passes, because a false "disabled" panel hides a working page, which is worse than the
  empty-page problem being fixed. The shape check is deliberate (`Array.isArray`) rather than
  `?? []` — coercing a generic empty-list response to "no modules" would dark every gated section.
- `ModuleDisabled` panel + section layouts for `/agency`, `/clients`, `/billing`, `/hr`, `/it`,
  `/knowledge`, `/reports`, `/appraisals`. It states that nothing was deleted and links to
  Settings → Modules & Fields with the module key.
- **The nav is deliberately NOT filtered.** Hiding the entry would repeat `0.10.1`'s bug in the other
  direction — the surface disappears with no trace of why or how to get it back. The section is
  reachable and explains itself.
- **Gated only where the module actually owns the endpoints**, each verified against the controller's
  guards. Explicitly NOT gated: `/projects` + `/tasks` (core `CoreController`, unguarded — the `pm`
  module owns `/api/:t/pm/*`, so honouring its `uiManifest` claim of `/projects` would have hidden two
  working pages from every company, none of which currently has `pm` on); `/systems/automation`
  (`automation-console` is a documented non-per-tenant deviation — global admin console, no
  `:tenantId` to gate on); `/deliverables` + `/timesheets` (core `client-work.controller`); `/search`
  (global search, unrelated to the `search` module).
- DEMO_MODE reports the full compiled-in set, so the backend-free tour is unchanged — without a
  fixture the generic empty-list default would have darked half the app.

Verified: **945 unit tests pass** (6 new for the gate's fail-open branches), `tsc` clean,
`next build` green (66 pages). **Not driven in a browser** — the Playwright suite needs a local
server on :3005, which standing policy says not to run here.

### [0.10.1] — 2026-08-03 · PROTOTYPED (the module toggle was one-way)

Pairs with platform-nest `0.9.1`. Reported as "I disabled a module to see the difference and now it's
gone" — accurate. **Settings → Modules & Fields could turn a module off and never back on.**

- The toggle list was `union(["agency"], company.enabled_modules)`. Disabling a module removes its key
  from that array, so the row it was rendered from **disappeared with it** — every module except the
  one hardcoded key was a one-way switch recoverable only by direct API/SQL write. The list now comes
  from `GET /api/module-catalog` (all ten compiled-in modules), still unioned with `enabledModules` so
  an enabled-but-no-longer-compiled key stays visible and removable. Falls back to a static list of
  the ten keys on 404, so it works against a backend without the endpoint.
- Each row now shows the module's real label and the nav paths it owns — disabling a module 404s those
  routes via `ModuleEnabledGuard`, and the row previously said nothing about what would go dark.
- **The company edit form was silently stripping modules.** `CompanyForm` knew only about `agency` and
  its update action sent the derived set as `modules`, replacing `enabled_modules` — so editing a
  company's *name* dropped `hr`/`reports`/etc. The field is now create-only; on edit the form shows the
  current set read-only and `updateCompanyAction` omits `modules` entirely, leaving the backend's
  `COALESCE($5, enabled_modules)` to preserve it.

Live consequence of the old behaviour, found on `gda-aicenter`: Gaia Digital Agency held `{agency}`
though the seed grants `{agency, hr, reports}`. `hr` was restored by direct SQL; **`reports` is still
off**. The nav is gated by RBAC and never reads `enabled_modules`, so a disabled module's pages stay
clickable and merely return empty — that mismatch is NOT fixed here.

Verified: 939 unit tests pass, `tsc` clean, `next build` green. Not driven in a browser; the running
image predates both changes.

### [0.10.0] — 2026-08-03 · PROTOTYPED (real IT topology + device edit/remove)

Pairs with platform-nest `0.8.0`.

- **Topology** now draws the real graph — gateway → access point/switch → device — from the resolved
  edge set, replacing a `buildTopology()` that could only regroup rows by two free-text strings and
  had no way to express an uplink. Falls back to the old site→network grouping while no edges exist,
  so today's view is unchanged until a collector reports.
- A **sync banner** states the feed's age, host count and BYOD aggregate, and says plainly when
  nothing has ever reported. Without it an operator reads silence as "all clear".
- Devices with no resolved uplink get their own bucket rather than being omitted — hand-registered
  devices never report one, so hiding them would make the map disagree with the device list.
- **Device edit + remove** (neither existed). On a discovered row the collector-owned facts
  (`ip`/`mac`/`hostname`/`status`) are hidden because the API rejects them; descriptive fields are
  kept in an overrides layer and survive the next sync.
- Devices tab gains search (name/hostname/IP/MAC), a class filter, a discovered-vs-manual badge, and a
  50-row cap with "Show all" — the table was unusable at a real estate's ~58 rows.

New `Device` fields are all optional, so the UI still renders against a backend without `0071`.
Verified: 939 unit tests pass, `tsc` clean, `next build` green. Not driven in a browser.

### [0.6.5] — 2026-07-27 · PROTOTYPED (console write controls)
- **Gateway config is editable** where the gateway says it is: new `OverridableConfigField` renders a
  save per writable key AND the one fact a plain form can't express — whether the value is a console
  override shadowing the env — with a **Revert to env** action. Without that, an operator who fixed
  the env and redeployed would see the old value and conclude the deploy failed. Read-only keys
  (credentials, egress allowlist, TLS mode, topology) stay in the description list, and the card shows
  a "read-only" badge when the running gateway exposes no write route at all.
- **Workflow activate/deactivate** in the Automation workflows table (elevated only), driven off the
  ID-bearing `/automation/workflows` list rather than the status probe's name-only rows — which never
  carried an id. Deactivation is confirm-gated because it stops real automation. When the ID list is
  unavailable (no n8n API key) the table still renders from the probe rows and says why the controls
  are missing.
- **Dead-letter replay** per bridge stream, offered only where something is actually parked, with a
  confirm naming the count.
- **NEW** `components/systems/ActionButton.tsx` (single-lever server action + pending/result feedback
  + optional confirm), `OverridableConfigField.tsx`; `lib/admin.ts` gained `setGatewayConfig`,
  `revertGatewayConfig`, `setWorkflowActive`, `replayBridgeStream` over a shared `writeCall` helper
  that surfaces the service's own 4xx message verbatim and maps 404/405 to "not available".
- 462 unit tests green (+7); `tsc` clean; `next build` green. Demo fixtures cover every new write.

### [0.6.4] — 2026-07-27 · PROTOTYPED (Gateway / MCP Hub / Automation consoles rebuilt with real content)
- The three pages were rendering everything the contract gave them; the contract was the problem
  (see platform-nest 0.6.2). With the backend widened, all three were rebuilt around what an operator
  actually acts on.
- **AI Gateway** — budget first (calls today vs effective cap, **per-tenant spend table**), a DR-burst
  card that states the consequence and separates declare/resolve instead of being an ambiguous toggle,
  one `ChainTable` per capability showing failover ORDER + breaker state with a plain-language reason
  per provider (and calling out providers configured in the env but never built by the gateway), a
  provider inventory with credential presence only, a DLP/egress-posture card, and an egress audit
  that is filterable by decision (incl. specific block reasons) and capability. Filters are `<Link>`s,
  so the page stays a server component and a filtered view is shareable.
- **MCP Hub** — policy card leading with **which engine decided** (Cerbos vs in-code fallback), limits
  & transport, tool registry with source attribution + filter, the **decision audit** (previously
  unreadable), the per-workflow automation scope matrix, and the **Resources + Prompts** primitives
  the page had never shown.
- **Automation** — at-a-glance strip, workflows, **execution history**, **event-bridge health** with a
  dead-letter warning band, and the **suspended-writes approval queue** (tenant-scoped, and labeled as
  such). Links to the existing read-only n8n canvas rather than duplicating it.
- **NEW** `components/systems/ChainTable.tsx` (+5 tests), `components/systems/DrModeCard.tsx`;
  `lib/admin.ts` gained the detail/audit/executions/bridge readers, a filterable `getEgressAudit`, and
  `setDrMode` (+11 tests). Demo fixtures extended so all of it is browsable with `DEMO_MODE=1`.
- 455 unit tests green; `tsc` clean; `next build` green.

### [0.6.3] — 2026-07-27 · PROTOTYPED (bot page correctness)
- **Data loss — `optIn` dropped on save:** `BotGroupConfig` had no `optIn`, and the bot's `PUT /admin/groups`
  is a FULL REPLACE that normalizes `optIn: Boolean(g.optIn)`. Any save from the ERP therefore turned
  per-group digest post-back OFF for every group. Added the "Digest back" checkbox column; `optIn` now
  round-trips (covered by the payload-shape test).
- **Unwarned mode switch:** the registry is a mode switch, not a list — while it is empty the bot ingests
  every group it sees; the first saved entry makes it ingest ONLY listed groups. The Groups tab now warns
  before that first save and names how many discovered groups would be dropped.
- **Stuck "Loading…":** a failed fetch leaves the state null, so the Chats thread and both Logs panels
  claimed to be loading forever while only a small toast showed the error. They now render an explicit
  "couldn't be loaded" state.

### [0.6.2] — 2026-07-27 · PROTOTYPED (bot Logs empty state)
- **Action audit:** the empty state said only "No audited actions yet.", which reads as a broken panel. It
  now states what populates it (member add/remove, admin promote, group rename — including denied and
  step-up attempts) and what doesn't (ordinary messages, digests). No behavior change; the audit was
  correctly empty.

### [0.6.1] — 2026-07-27 · PROTOTYPED (discovered-group rows)
- `GroupRegistry` renders the JID when a discovered group's subject is unresolved (was a blank row next to
  an Add button), and Add seeds the registry row with the JID rather than an empty name. See wa-chat-bot
  `0.8.1` for the bot-side cause.

### [0.6.0] — 2026-07-24 · PROTOTYPED (Connect-WhatsApp + Group Registry + agents-live surfaces)
- **Workstream A WhatsApp self-service UI (design §2.5, not yet deployed):** PROTOTYPED `src/components/systems/WhatsAppConnect.tsx` (client-side).
  Status pill (status + engine + paired number when WORKING), buttons Connect/Show-QR/Restart/Stop/Logout (confirm on logout). QR `<img>` from data URL.
  Poll status+qr every 3s while panel open and status ∈ {STARTING, SCAN_QR_CODE}; stop on WORKING (success) or FAILED (error + hint). Show `lastEvent` (reconnect/ban trail).
  Mutations = server actions in `systems/bot/actions.ts`; poll read via route handler `src/app/api/admin/bot/session/route.ts` (GET, no-store, server-side platformFetch).
- **Group Registry UI:** PROTOTYPED `src/components/systems/GroupRegistry.tsx` (client-side). Monitored-groups table (name/category/optIn/remove), discovered list
  with one-click add, management-group radio, single Save → PUT groups. Server action `updateBotGroups`. `updateBotConfig` action kept (degrades if backend 404).
  StatusCard now renders `detail.session` as a badge.
- **Workstream B agents-live surfaces (design §3.4):** agents UI extended with trigger card (goal textarea + agent select from status probe's `agents` list, elevated-only).
  Goals table now links to detail; status card consumes real `/health` probe. NEW `/agents/goals/[goalId]` page: status/budget/fan-out header, blackboard entries
  (specialist/task/status), run summaries linking to transcripts, `approval_id` deep-link to approvals inbox when suspended. NEW `/agents/runs/[runId]` or expandable
  detail panel: step list as text chips (model/tool kind + detail only, never HTML/markdown, never raw JSON). Poll every 4s while goal queued|running, stop otherwise.
- **NOT deployed yet:** UI-through path PROTOTYPED; backend for `/systems/bot` and `/agents` surfaces now answering (but not yet deployed container).

### [0.5.0] — 2026-07-23 · PROTOTYPED
- Baseline. ERP UI Plans 1–5 + People 360 + org builder + dept consoles + PM/AI-tracker + IT console;
  OIDC PKCE; `DEMO_MODE`; Playwright e2e.
- **Unreleased / next:** deploy once backend admin API is live.

## ai-gateway-go
### [0.13.0] — 2026-07-27 · PROTOTYPED (runtime config writes + a real chain lock)
- **NEW bearer-gated `PUT /admin/config`** (one key per call) **+ `DELETE /admin/config?key=`**
  (revert to env). Writable: the two budget caps, breaker threshold/cooldown, provider timeout, the
  DLP-classifier toggle, and each capability's chain ORDER. Every write is validated + bounds-checked,
  applied to the LIVE objects, and persisted — in that order, so a persist failure is reported rather
  than leaving the running state ahead of the file.
- **NOT writable, deliberately:** provider credentials, egress allowlist, TLS mode, topology. Those
  either can't take effect at runtime (credentials are captured in provider objects at boot) or would
  let a console session widen the gateway's own security boundary. `GET /admin/config` advertises
  `writableKeys` so the console renders exactly what it can change — and nothing more.
- **NEW `internal/adminconfig`** — the override store: pointer-per-key `Overrides` (nil = use env),
  an explicit `WritableKeys` allowlist, numeric sanity bounds, chain validation against the known
  provider set (an unknown name would otherwise silently SHORTEN the chain, since `buildProviderList`
  skips names it can't resolve), and an atomic temp+rename persist. `Apply()` folds overrides onto the
  env in `main` BEFORE anything is built, so a persisted override is in force from the first request.
- **Chain is now properly locked.** `Chain` had no mutex while `Run` mutated its `breakers` map from
  every concurrent request — a pre-existing latent data race that runtime reordering would have made
  much worse. Added `sync.Mutex` over all mutable state, with `Run` snapshotting the provider list so
  the lock is never held across a provider call. `SetProviders` keeps breaker state for retained
  providers (reordering is not a reason to forget a provider is rate-limited) and drops it for removed
  ones. New concurrency test drives Run + SetProviders + Report together.
- **The DLP-classifier toggle is now real:** `main` always constructs the classifier (building it
  makes no calls) and a runtime flag decides whether it RUNS. Previously a nil classifier meant the
  toggle could never be switched on without a restart; enabling it in a process that has none is a
  409 with an actionable message rather than a silent no-op.
- `GET /admin/config` reports the LIVE chain order plus `envOrder`, and the live classifier state --
  an override must never be mistakable for the env value.
- 13 new server tests (auth, allowlist refusal, bounds/type validation, live+persisted application,
  lowered-cap-degrades-immediately, reorder echo/rejection/breaker-preservation, revert, 409, and
  writes-absent-when-unwired). `go vet` + full `go test ./...` green.

### [0.12.0] — 2026-07-27 · PROTOTYPED (admin config surface: chain order, breaker internals, per-tenant budget)
- **NEW bearer-gated `GET /admin/config`** — the operational state the ERP console needs and could
  not previously see: per-capability chain **in failover order**, provider inventory, budget
  breakdown, reliability tuning, and security/topology posture. Provider credentials are NEVER
  returned — only `keyConfigured` presence (the gateway is the only component holding provider keys).
- **NEW `chain.Report()` / `chain.Settings()`** — `State()` returns a map, which loses the failover
  order that is the entire contract of a chain. `Report()` reports position + state + breaker
  internals (`consecutiveFails`, `rateLimited`, `openUntil`) so a console can explain WHY a provider
  is being skipped, and distinguish a rate-limit breaker (wait it out) from a failure breaker (fix it).
- **NEW `budget.Breakdown()`** — the same numbers `State()` reports plus the **per-tenant spend map**
  and the DR-burst window, so "who is burning the cap" is answerable. Stale-day counters still read
  as zero rather than being misattributed to today.
- 2 new server tests (auth gate + no-secret-leak + ordered chain; per-tenant attribution). `go vet`,
  `go build`, full `go test ./...` green on go1.26.5.

### [0.11.0] — 2026-07-24 · PROTOTYPED (provider timeout + 429/RateLimitError breaker + error taxonomy)
- **Provider timeouts (§3.5 Workstream B reliability):** NEW `PROVIDER_TIMEOUT_MS` env (default 60000). Every capability handler (Complete/Media/Embed) wraps
  provider calls with `context.WithTimeout(r.Context(), timeout)` — hung provider → clean failover + client disconnect cancels upstream (no hanging goroutines).
  Stream path (`/complete/stream`) handled separately (keeps its own flush loop, retains timeout safety).
- **429 taxonomy & breaker:** providers return typed `providers.RateLimitError{RetryAfter}` on HTTP 429. Chain.Run() parses Retry-After seconds, caps at 5m,
  opens provider's circuit breaker immediately for min(RetryAfter, cap) — one 429 stops hammering for exactly the advertised window without poisoning the
  "dying provider" consecutive-fail signal. No more treating 429 as a generic failure on the failover path.
- **Error taxonomy in audit + 502 body:** attempted-provider errors tagged `timeout|rate_limit|provider_error` in egress audit + 502 response (ERP console can
  distinguish causes). `Blocked: "rate_limit"` when all providers in chain are rate-limited (not a generic error). Audit trail now surfaceable for SLA/alerting.
- **Per-tenant call cap:** already EXISTS (`budget.perTenantCap` via x-tenant-id header) — runner NOW sends `x-tenant-id` on `/complete` calls (1-line change in
  gateway init) so agent load is tenant-attributed for daily cap enforcement.
- **Not yet live:** WhatsApp transport (WAHA up but no paired session).

### [0.10.0] — 2026-07-24 · DEV-VERIFIED (openai provider path, full stack)
- New `openai` provider (`internal/providers/openai.go`): OpenAI-compatible `/v1/chat/completions`
  with Bearer auth, fronting any compatible endpoint (Ollama Cloud, OpenRouter, vLLM …). Registered in
  the chain, excluded in `site` topology like other cloud-key providers.
- **Vision media:** `Media()` handles `image/*` via a configurable vision model (`OPENAI_VISION_MODEL`,
  default `qwen3.5:397b`) using the OpenAI `image_url` content part; audio/PDF/video decline → fail over
  to whisper/gemini. Embeddings decline (Ollama Cloud has no `/v1/embeddings`).
- Config: `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` (default `deepseek-v4-flash`) /
  `OPENAI_VISION_MODEL` / `OPENAI_MAX_TOKENS`. Compose `LLM_CHAIN` defaults `openai,ollama,gemini,claude`,
  `MEDIA_CHAIN` defaults `openai,whisper,gemini`; `ollama.com` added to `EGRESS_ALLOWLIST`. 11 provider
  tests; `go vet` + full suite green.
- **e2e (full local stack):** rebuilt+restarted `gaiada-ai-gateway-1`; verified from inside the running
  containers — bot→`ai-gateway:3002`/complete and mcp-hub→gateway both returned `{"provider":"openai",…}`;
  gateway egress-audit shows every LLM call `provider:openai, ok:true`. `/health` reports `openai:ok` on
  both llm + media chains.
- **Trial:** shared Ollama Cloud key wired into dev `.env` as the stack brain (bot, MCP `llm.*`, n8n, WS8
  agents inherit it). Shared + weekly-rate-limited — dev/test only, not a prod dependency.
  **Capability:** NO image/video *generation* (that's the GPU render-gateway's job) and NO embeddings on
  Ollama Cloud; image *understanding* works (qwen3.5). `glm-5.2`/`kimi-k2.7-code` are reasoning models
  that reply empty unless `OPENAI_MAX_TOKENS` is large — `deepseek-v4-flash` returns clean content.
- **Not yet live:** WhatsApp transport (WAHA up but no paired session — needs a QR scan).

### [0.9.0] — 2026-07-23 · PROTOTYPED
- Baseline. THE gateway (`:3002`), provider chain + failover + DLP + cost cap + egress audit + mTLS +
  site/central + DR-burst. go build/vet/test green.
- **Known risk:** docker build unverified. **Next:** verify container build, OpenBao creds, media DLP.

## mcp-hub
### [0.9.0] — 2026-07-27 · PROTOTYPED (readable decision audit + posture surface + tool attribution)
- **NEW bearer-gated `GET /audit`** (`readRecentAudit` in `audit.ts`) — the READ side of the §8
  tool-call trail, newest-first. Every allow/deny decision with its reason was being appended to
  JSONL and exposed by no route, so the hub's accountability record existed on disk and nowhere else
  (while the console's own subtitle advertised it). A missing file reads as "no activity yet"; a torn
  last line is skipped rather than blanking the whole trail.
- **NEW bearer-gated `GET /admin/info`** — the posture the console needs: **which engine actually
  decided** (Cerbos vs the in-code fail-closed fallback — the most load-bearing fact about the hub),
  deny-by-default, assurance ranks, the D14 automation write gate stated in words, revocation
  settings, rate limits (per principal AND the 10× per-service-token ceiling), mTLS mode + peer
  allowlist + topology, tool counts by source, **Resources and Prompts** (the two primitives the
  console never showed at all), and the per-workflow `AUTOMATION_ALLOWLIST` least-privilege matrix.
  Presence flags only — no secrets, mirroring the gateway's rule.
- **Tool source attribution** — `registry.withSource()` stamps each registration GROUP so a tool
  carries where it came from (`core`/`platform-read`/`platform-write`/`pipeline`/`delivery`/`module`)
  without every call site having to agree on a label. Surfaced on the open `/tools` catalog too.
- 81 tests green (+22 from the 59 baseline; 4 new cases here).

### [0.8.0] — 2026-07-23 · PROTOTYPED
- Baseline. MCP server fronting platform-nest; OBO, Cerbos policy, Tools/Resources/Prompts, rate limit,
  revocation, mTLS, site/central. 59 dev tests.
- **Next:** OpenBao creds, Redis-backed multi-instance rate limiting.

## sync-engine-go
### [0.7.0] — 2026-07-23 · PROTOTYPED
- Baseline. Central/site reconciliation, HLC, conflict rules, RLS, bootstrap, GC; property-based + chaos
  tests on a 2-Postgres harness. Runs idle (`sync-central`).
- **Next:** activate against a real second site.

## automation (n8n)
### [0.4.0] — 2026-07-23 · DEV-VERIFIED
- Baseline. n8n + MCP templates, scoped accounts, impact gate, event bridge, approvals suspension.
  3 flows verified e2e on the live dev stack (2026-07-15).
- **Next:** more flows; Temporal for durable orchestration.

## observability
### [0.6.0] — 2026-07-23 · DEV-VERIFIED
- Baseline. OTel across all services; opt-in Grafana stack; SLOs; alerting; restore drill. Verified e2e
  on a live Docker stack (2026-07-15).
- **Next:** deploy to a real host; tune SLOs on prod traffic.

## infra
### [0.7.4] — 2026-08-03 · PROTOTYPED (one secret under two names; n8n squatting the ERP root)
- **The platform read the bot's admin token from `${BOT_ADMIN_TOKEN}` while the bot read
  `${ADMIN_TOKEN}`** — one shared secret, two `.env` names. A deployment that set only `ADMIN_TOKEN`
  handed the platform an empty string, every bot-admin proxy call 401'd, and the Systems console
  reported "bot admin unreachable" as though the bot were down (it was up and answering `/health` 200
  throughout). Now `${BOT_ADMIN_TOKEN:-${ADMIN_TOKEN:-}}`, so one name suffices. Verified live: all
  four admin routes went 401 → 200 and the console shows a real session state with event history.
- **n8n was proxied on eight ERP top-level paths** — `/webhook`, `/form`, `/mcp` and their
  `-test`/`-waiting` variants — because `N8N_WEBHOOK_URL` was the bare origin. The first platform-ui
  route to land under any of those names would have been silently answered by n8n, presenting as a 404
  on a page that demonstrably exists. Narrowed to the `/n8n/` prefix only (still outside the basic-auth
  gate, which the event bridge requires since it acks 4xx as delivered). Verified safe first: all 8
  registered webhooks are called in-cluster except `/ingest/lead`, which has never run.
- **`AUTOMATION_PUBLIC_URL`** added, so the console's "Open in n8n" link stops being derived from the
  in-cluster `AUTOMATION_URL`.
- **`*.local.md` gitignored** for operator credential notes kept beside the code.

Standing caveat, recorded because it bit this session: `deploy.yml` ships `infra/compose/*.yml`,
scripts and mounted config — **not** host nginx and **not** `automation/.env`. Those two are manual
(see `infra/nginx/README.md`).

### [0.7.2] — 2026-08-03 · IN PROGRESS (CI reached the redis it was already running; deploy unblocked)
- **`platform-nest` CI set `REDIS_URL`, but every suite reads `REDIS_URL_TEST`** (18 files). The
  redis service container was running and being ignored, so **14 test files / 146 tests had never
  once executed in CI** — they skipped themselves silently. Only visible because TR-29's preflight
  deliberately converts that skip into a loud failure. Same URL, correct name. Un-skipping them
  immediately surfaced a real bug — see `reports` 0.3.1.
- `infra/scripts/wire-env.sh` — the one piece of the live box that was not reproducible from the
  repo (it existed only as `~/gaiada/wire-automation.sh` on gda-aicenter). Generalised to a service
  list + a `VERIFY` regex. Encodes two traps: `docker compose restart` does NOT re-read `.env`
  (compose bakes the environment at container *create* time, so a restart re-runs the old
  environment while looking like it worked — only a recreate re-reads the file), and the VPS
  invocation needs `-f docker-compose.hostdata.yml --profile bot --profile auth` or postgres/redis
  are profile-disabled and compose rejects the project. It reports explicitly when NONE of the
  expected vars are present, because that is the signature of a missing compose passthrough rather
  than an unset value — the shape that has now bitten four times (Google/Ads credentials,
  `N8N_BRIDGE_TIMEOUT_MS`, `MEETING_VIDEO_MAX_BYTES`, `N8N_BRIDGE_ENTITY_TYPES`).
- **Deploy unblocked.** `RENDERER_TOKEN` is `${RENDERER_TOKEN:?}` in `docker-compose.vps.yml`, so
  its absence from the box's `.env` made `docker compose` refuse the ENTIRE project, not just the
  new sidecar. Minted on gda-aicenter alongside `PLATFORM_UI_INTERNAL_URL` / `REPORT_RENDERER_URL`;
  `docker compose config` now resolves against the live `.env` with no mandatory var missing.
- Runbook: added a "changing a variable in `.env` on a running box" section, and **discharged the
  `report-renderer` "unverified on the production Linux VPS" caveat** — built and exercised on
  gda-aicenter itself (Docker 29.7.0, linux/amd64): a real 16 624-byte `%PDF-` from
  `chromium.launch()` → `page.pdf()`, 403 on a foreign origin (SSRF guard), 401 without a token.

### [0.7.1] — 2026-07-31 · IN PROGRESS (WAHA image bump 2026.6.2 → 2026.7.2)
> Numbering note: this jumps from `0.5.2` because the registry table in `MODULES.md` was advanced
> to `0.7.0` by the trial-deploy/nginx work without matching entries here. The table is the source
> of truth, so this entry continues from it rather than from the last logged entry.
- Bumped the pinned WAHA image `devlikeapro/waha:noweb-2026.6.2` → `noweb-2026.7.2` in
  `infra/compose/docker-compose.vps.yml`. Deliberate bump, still pinned — never `:latest`.
- **This is not a re-test of the ruled-out 2026.7.1.** The 2026-07-29 incident
  (`docs/runbooks/wa-ban-recovery.md`) established that 7.1 failed byte-identically, so the re-pair
  failure is not a minimum-client-version rejection. 2026.7.2 is a later release (published
  2026-07-29) whose changelog names a NOWEB **"WhatsApp Web version compatibility"** fix plus a
  message-timestamp/sorting fix. Taken to stay current with WA-side protocol drift — the one thing
  a pinned Baileys build silently rots against.
- **Status is IN PROGRESS, not DEV-VERIFIED.** Only `docker compose config` was validated (resolves
  cleanly, all profiles). No live pairing was exercised: the number is still out of the loop and dev
  runs against the WAHA sim. Re-pair remains **UNPROVEN** until a QR scan actually succeeds. If the
  same `Connection Failure` registration loop recurs, the upstream-block conclusion stands — stop
  the session and wait; do not bump again.
- Noted the 2026.7.x escape hatch `WAHA_NOWEB_WA_VERSION` / `WAHA_NOWEB_WA_VERSION_FORCE` (pins the
  WA Web protocol version without an image change). Left unset.
- Docs updated to match: the ban-recovery runbook incident log and the WhatsApp e2e blueprint.

### [0.5.2] — 2026-07-28 · DEV-VERIFIED (platform-nest test harness: per-file database)
- **The suite was untrustworthy, not the code.** Two root causes: (1) `initTestDb()` held a session advisory lock
  released only in `teardownTestDb()`, so a single failed `beforeAll` never released it and every later file blocked
  until `hookTimeout` — one flake cascaded into dozens (19 files, then 57); (2) `initialized` is module-scoped, so
  each vitest worker re-ran `DROP SCHEMA public CASCADE` on first use, landing underneath another worker's
  in-progress migration (`relation "schema_migrations" does not exist`).
- A third cause only visible once the race was fixed: 20+ files reuse literal fixture emails (`admin@a.test`), so
  ANY single-shared-database design collides on `users.email` regardless of timing — an interim global-setup fix
  still failed 16 suites for this reason.
- **Fix:** per-test-file physical database, `pgtest_f_<sha1(testPath)>`, dropped `WITH (FORCE)` and recreated +
  migrated in that file's own `beforeAll`; pools cleaned in `try/catch` so a throwing hook cannot leak connections.
  Locks, drops and unique constraints are all scoped to one file, so overlapping hooks cannot contend. The DB name
  is always the literal prefix plus a hex hash, so `DROP DATABASE` can never resolve to a real database (checked).
- **Verified:** 3 consecutive green full runs by the implementer + 1 independent re-run — 74 files / **734 tests** /
  0 failed / **0 skipped**, ~6m46s. No assertion touched or weakened; no suite skipped. A deliberately injected
  failing `beforeAll` no longer fails unrelated files.
- **Costs / leftovers:** ~7min per full run (migrations replay per file) and ~730MB across 60 reused
  `pgtest_f_*` databases that persist between runs by design (force-dropped and recreated, not accumulating).
  Schema-per-file within one database is the lighter-weight follow-up if runtime becomes a problem. One stray
  `gaiada_platform_test_h31` (7MB) is left from the interim attempt and can be dropped at any time.

### [0.5.1] — 2026-07-27 · PROTOTYPED (local test-infra in the dev override)
- **Why:** several suites could not run on a dev box at all. Cerbos published no ports (every authz
  check fails from the host), the bot's isolated Postgres published no port, and both projects' `.env`
  files pointed at a `localhost:5432/5433` Postgres that doesn't exist here (a native Windows Postgres
  squats :5433). Result: 3 bot tests failing + 7 skipped, and 104 nest tests skipped.
- **`docker-compose.local.yml`** (dev override; the VPS compose stays internal-only) now also publishes
  `cerbos` 3592/3593, `pg-bot` 55434, and adds a **disposable `redis-test`** on 56380. The test Redis is
  deliberately NOT the live one: `n8n-bridge.integration.test.ts` calls `FLUSHALL`, which would wipe the
  running event backbone.
- **`.env` wiring:** `wa-chat-bot` → `DATABASE_URL_TEST` at a dedicated `gaiada_bot_test` database (never
  the live crypto-shred store) and `DATABASE_URL` at the real `gaiada_bot` for host-run dev;
  `platform-nest` → test DB on 55433 plus `CERBOS_URL` and `REDIS_URL_TEST`.
- **Hazard found the hard way:** `docker compose -f docker-compose.vps.yml up -d platform` (VPS file
  alone) **silently unpublishes** `platform:3004`, which the host-run UI depends on — compose recreates
  the container without the override's ports. Always bring the stack up with BOTH files. Noted in
  `CLAUDE.md`.
- **Result:** wa-chat-bot 295/295 (was 285 passing, 3 failing, 7 skipped); platform-nest 700/700
  (was 596 passing, 104 skipped). No product code involved — infra + env only.

### [0.5.0] — 2026-07-24 · PROTOTYPED (agent-runner service + bot writable volumes + .env updates)
- **Workstream A+B compose changes:** NEW `agent-runner` service in `docker-compose.vps.yml` (build: ../../ai-agents, command: ["npx", "tsx", "src/runner/service.ts"],
  port 3006, restart unless-stopped). Env: AGENT_RUNNER_TOKEN, AGENTS_DATABASE_URL (knowledge_app role), MIGRATE_DATABASE_URL (knowledge_owner role),
  GATEWAY_URL/TOKEN, HUB_URL/HUB_SERVICE_TOKEN. Depends on postgres/ai-gateway/mcp-hub.
- **Bot writable group registry:** `wa-chat-bot` service: `GROUPS_FILE=/app/data/groups.yaml` (writable, points to bot-data volume), `GROUPS_SEED_FILE=/app/config/groups.seed.yaml`
  (read-only seed). Volumes: bot-data:/app/data (NEW), ./groups.yaml:/app/config/groups.seed.yaml:ro (updated mount path from was :/app/config/groups.yaml:ro).
  Old groups.yaml file stays as the first-boot seed (boot copy logic if file absent).
- **platform service updates:** AGENTS_URL: http://agent-runner:3006, AGENT_RUNNER_TOKEN env (reuses AGENT_RUNNER_TOKEN secret).
- **`.env.example` updates:** added AGENT_RUNNER_TOKEN secret placeholder; noted that bot groups.yaml is now the first-boot seed only (registry lives in the volume).
- **Not deployed yet:** compose stack verified locally; container builds not verified on a Docker host (same caveat as ai-gateway-go).

### [0.4.0] — 2026-07-23 · PROTOTYPED
- Baseline. VPS Compose stack, Dockerfiles, local CI, backups, supply-chain pipeline (SBOM/cosign/SLSA).
- **Next:** first production deploy; GitOps; K8s/SPIFFE (target-state).

## reports
> Section opened 2026-08-03. The registry has carried a `reports` module since `0.1.0`, but no
> section existed here, so `0.1.0 → 0.3.0` (the TR tracker/reporting programme) has no per-entry
> history — rule 1 debt, recorded rather than back-filled from guesswork. Entries start at 0.3.1.

### [0.3.1] — 2026-08-03 · PROTOTYPED (seal_hash could never be verified from storage)
- **`computeSealHash()` hashed a string the stored `jsonb` can never reproduce, so `seal_hash`
  NEVER verified.** `canonicalStringify` sorted keys (correct — jsonb does not preserve key order)
  but did not drop `undefined`-valued keys the way `JSON.stringify` — the thing that actually
  writes the column — does. `Object.keys()` lists such a key, and `JSON.stringify(undefined)`
  returns the *value* `undefined`, which interpolates as the literal text `undefined`.
  `computeHeaderWarnings` returns `undefined` whenever a period has no warnings, i.e. the common
  case, so essentially every sealed period hashed as `..."warnings":undefined...` at seal time and
  as nothing at all when read back.
- **Why this mattered more than a red test:** `seal_hash` is the module's tamper evidence, and a
  check that can never reproduce is indistinguishable from one that caught real tampering. It would
  have read as "these sealed rows were altered" forever, on every period, with the rows intact.
- Diagnosed by dumping both hash inputs and diffing: byte-identical for 606 characters, then
  `"warnings":undefined` on one side and nothing on the other.
- Also closed the same failure mode for values carrying `toJSON` (a `Date` would have hashed as
  `{}` while storing an ISO string) — unreachable through `ReportDocument` today, one field away
  from reachable. Applied to `narrative.ts`'s deliberate independent copy too, where the defect is
  latent (nothing re-derives a `groundingHash` from storage yet), rather than leave a copy of
  something known-broken.
- Locked in with 4 DB-free tests asserting the invariant **over a JSON round-trip** rather than
  against a frozen digest, so they keep holding if the canonical form is ever legitimately changed,
  and so this class is catchable in 1 ms instead of only by a full live-Postgres run.
- **Verified** against real Postgres 17 + Cerbos + Redis (throwaway containers on gda-aicenter
  mirroring the CI job): **177 files / 2560 tests pass, 0 failures**. Before: 162 files, 1 failure,
  14 skipped. Found only because `infra` 0.7.2 fixed the CI redis wiring that had been skipping it.

## report-renderer
### [0.1.0] — 2026-07-31 · DEV-VERIFIED (TR-19: sidecar service + compose + CI)
- **What:** new standalone component `report-renderer/` — Node + Express + Playwright, the only
  image in the estate carrying Chromium (platform-ui's Next standalone image stays browser-free).
  `GET /health` (no auth); `POST /render {url}` behind `Authorization: Bearer RENDERER_TOKEN` →
  `chromium.launch()` → `page.goto(url, {waitUntil:'networkidle'})` → `page.pdf({format:'A4',
  printBackground:true, headerTemplate/footerTemplate w/ page numbers})`. Lifted the print
  technique directly from the working in-repo precedent `docs/blueprints/render-pdf.js` per the
  ticket brief, rather than rediscovering exact-color printing / page-fitting / footer numbering.
- **SSRF guard (the security-critical part):** `src/auth.ts`'s `isAllowedRenderUrl` requires the
  requested `url`'s origin to exactly match `PLATFORM_UI_INTERNAL_URL` — this service will render
  whatever URL it's handed, so a leaked `RENDERER_TOKEN` alone cannot turn it into a proxy against
  the internal network (mirrors ai-gateway-go's `DialContext` egress allowlist / search-crawl-go's
  egress guard, the local precedents this ticket named). `isAuthorized` never fails open on an
  unset server-side token.
- **Compose:** new `report-renderer` service in `infra/compose/docker-compose.vps.yml`
  (internal network only — no published port; healthcheck via `node -e fetch(...)` since
  curl/wget aren't guaranteed on the Playwright base image; `depends_on: platform-ui
  condition: service_started`); dev-only published port 3007 added in `docker-compose.local.yml`;
  `build: ../../report-renderer` added in `docker-compose.build.yml`.
- **`.env.example`:** added `RENDERER_TOKEN` (required) and `PLATFORM_UI_INTERNAL_URL` (defaults
  to `http://platform-ui:3005` in compose).
- **CI:** added `report-renderer` to the `ci.yml` unit-test matrix (typecheck + vitest) and to the
  `release.yml` image-build/sign/SBOM/SLSA matrix + the `deploy.yml` `COMPONENTS` cosign-verify
  list.
- **Verified without Docker:** `npm run typecheck` clean; `npx vitest run` → 2 files, **14/14
  tests green**, incl. the acceptance-criteria check that a token-less `POST /render` returns 401.
  Ran the service directly (`npx tsx src/server.ts`) and smoke-tested it live with curl:
  `GET /health` → 200; token-less render → 401; wrong-token render → 401; right-token +
  disallowed-origin render → 403 (SSRF guard); right-token + allowed-origin render → 502 with a
  clean JSON error body (no Chromium binary in that bare shell — the expected failure mode there,
  not a crash/hang).
- **Docker WAS available in this session (Docker Desktop, Windows/Linux-VM backend) — so unlike
  the ticket's assumed caveat, the container build and a real render were actually verified, not
  just assumed:**
  - `docker build -t gaiada-report-renderer:test .` → succeeds (base image
    `mcr.microsoft.com/playwright:v1.61.1-noble` pulled, `npm ci` installed `playwright@1.61.1`
    against the preinstalled browser revision, image exported).
  - `docker run -d -p 3999:3007 -e RENDERER_TOKEN=testtoken -e
    PLATFORM_UI_INTERNAL_URL=http://example.com gaiada-report-renderer:test` → container starts,
    `GET /health` → 200.
  - Full auth/SSRF matrix against the live container: token-less render → **401**; wrong-token
    render → **401**; right-token + `http://evil.example.com/` → **403**; right-token +
    `http://example.com/` (same-origin) → **200**, and `curl`'s output piped through `file`
    reported **`PDF document, version 1.4, 1 page(s)`** (12,348 bytes) — a real Chromium render,
    not a stub.
  - `docker exec ... node -e "fetch('http://127.0.0.1:3007/health')..."` → exit 0 (the exact
    compose healthcheck command works inside the image); `docker exec ... whoami` → `pwuser`
    (confirmed running as the base image's non-root user, not root).
  - `docker compose -f docker-compose.vps.yml -f docker-compose.local.yml -f
    docker-compose.build.yml config --services` (with `COMPOSE_PROFILES=data,bot,auth,multisite,
    whisper,jobs` and dummy `.env` values for every required var) → resolves cleanly, lists
    `report-renderer` among all 20 services; `config report-renderer` → confirms the intended
    image name, healthcheck, env, and `depends_on: platform-ui condition: service_started`.
  - `docker compose ... build report-renderer` then `up -d --no-deps report-renderer` →
    `docker ps` shows `gaiada-report-renderer-1  Up ... (healthy)`, published on
    `127.0.0.1:3007`. `GET /health` → 200; token-less render → 401; disallowed-origin render → 403
    — all reconfirmed through the compose-managed container, not just a bare `docker run`.
  - Test container/image torn down afterward (`docker stop/rm`, `.env` deleted from
    `infra/compose/`); no state left running.
- **NOT verified:** an actual deploy to the production Linux VPS this image is meant to run on —
  only Docker Desktop was available in this session. Re-confirm `docker compose ps` shows this
  service healthy on the real target host before relying on it there. TR-20 (print route) and
  TR-21 (one-shot token orchestration) aren't built, so no real report renders through the whole
  pipeline yet — this entry proves the sidecar's own contract (auth, SSRF guard, real PDF
  output), not the end-to-end export flow. Documented in `infra/runbooks/deploy-vps.md`.
- **Deliberate version pin:** `package.json`'s `playwright` dependency is pinned to the exact
  `1.61.1` (no `^`) to match the base image's baked-in browser revision — a caret range could
  resolve a newer patch whose browser binary isn't preinstalled there, and `chromium.launch()`
  would fail at runtime with no network egress intended for this container.
- **Out of scope by design (TR-20/TR-21, other seats):** the platform-ui print route this sidecar
  targets and the one-shot, 5-min-TTL, doc-scoped `jobToken` orchestration that mints the URL —
  `PLATFORM_UI_INTERNAL_URL` points at a real origin today, but nothing serves
  `/print/reports/:jobToken` yet.

## wa-chat-bot
### [0.9.1] — 2026-07-28 · DEV-VERIFIED (digest delivery target, async run, preview)
- **Scheduled digests were broken and nobody knew.** `schedule-state.ts` ran `CREATE TABLE IF NOT EXISTS` on the
  RUNTIME pool, which under the owner/runtime role split is `bot_app` — no rights on schema public. Every digest,
  cron included, died with `permission denied for schema public` (42501) inside `loadLastRun()` before summarizing
  anything; the empty history was the symptom. Now uses the owner DSN via `MIGRATE_DATABASE_URL` exactly like
  `PgStore.init()`, memoized (a failure is not cached). Confirmed fixed live: the 18:00 SGT cron ran successfully.
- **Delivery target may be a direct chat.** `MGMT_TARGET_RE` accepts `@c.us`/`@lid`/legacy `N-N@g.us`/`tg:` for the
  target only — a MONITORED entry must still be a real group. This enables the lowest-risk setup: deliver the
  digest to the operator's own number instead of posting into any group. Verified live end-to-end
  (`mgmtDelivered: true`, 9 groups, 0 failed).
- **INCIDENT + root fix: setting the target used to stop all ingestion.** `setManagementGroupId` wrote the target
  as a registry row, making `loadGroups()` non-null → registry mode with ZERO monitored groups (the target itself is
  never monitored) → the bot silently stored nothing. Observed live for ~2 minutes on 2026-07-28 before being
  caught and reverted; messages arriving in that window were dropped. The target now lives in its own
  `digest-target.json` (`DIGEST_TARGET_FILE`); precedence is registry `isManagement` row > standalone target >
  `MANAGEMENT_GROUP_ID`. Choosing where a digest is DELIVERED can no longer change what the bot READS. Three tests
  pin it; three older tests that encoded the unsafe "adds a minimal entry" behaviour were rewritten to the new
  contract (documented, not weakened).
- **Async run:** `POST /admin/digests/run/:slot` → 202 `{started,slot,startedAt}`, 409 if that slot is already in
  flight (two concurrent runs would double-post), errors from the detached run recorded in history instead of
  becoming unhandled rejections. The synchronous `/run-digests/:slot` is untouched — n8n's digest-fanout calls it.
- **Preview:** `GET /admin/digests/preview?chatId=&limit=` returns the digest text with no send path in the route
  and nothing persisted. Verified live: history unchanged, zero outbound sends.
- **Legacy group ids:** the chat-id validator rejected `<creator>-<created-at>@g.us`, so that group 400'd on click
  like the `@lid` DMs did. Shapes enumerated against the live store (18 `N@g.us`, 12 `N@lid`, 1 `N-N@g.us`).
- Tests 385 → **408**, `tsc` clean.

### [0.9.0] — 2026-07-28 · DEV-VERIFIED (console depth: ignore list, digests, search, paging)
Built by a 4-agent parallel run against a frozen contract (`docs/superpowers/plans/2026-07-28-wa-bot-console-depth.md`).
- **Ignore list** (`groups.ts`, own persisted `ignored-groups.json`): an ignored group is dropped before storage in
  BOTH trial and registry mode and skipped by digests, while still appearing in the snapshot so it can be un-ignored.
  `groupsSnapshot()` gains `ignored`; `discovered` now excludes ignored entries.
- **Digest history** (`digest-history.ts`, counts-only, last 50) + `GET /admin/digests` with timezone-aware next-run
  times (`next-run.ts`). **Skills catalog** `GET /admin/skills`. **Media health** `GET /admin/media/status`.
- **Search + paging:** `searchMessages` and `getMessagesPage` added to the `Store` interface and implemented for
  FileStore AND PgStore (parameterized ILIKE inside `withTenant`, so RLS still applies); `GET /admin/search`,
  plus `q`/`kind` on the chat list and `beforeTs`/`hasMore` on the thread.
- **`managementGroupId` is now a labelled select** built from registry AND discovered groups, with an explicit None.
  It falls back to free text only when there is genuinely nothing to choose — a select offering just "None" plus the
  current value would remove the ability to type an id, which is strictly worse than the text box.
- **Three defects found during integration, not by the agents:**
  1. `listChats` applied `q`/`kind` AFTER the store's limit, so filters only saw the newest N — `kind=dm&limit=8`
     returned 1 of 12 DMs and searching an older chat returned nothing. A search that silently answers "no results"
     is worse than one that errors. Now filters, then limits.
  2. **`@lid` chat ids were rejected.** The NOWEB/Baileys engine addresses most DMs by linked identity
     (`<digits>@lid`); the validator allowed only `c.us`/`g.us`/`tg:`, so all 12 LID DMs listed fine and 400'd the
     instant they were clicked. The regex was ALSO duplicated in `server.ts` and had drifted — there is now one
     definition (`isValidChatId`), imported.
  3. The kill switch answers `{actionsEnabled}` while its audit read answers `{enabled}` — see platform-ui 0.7.0.
- Tests 296 → **385**, `tsc` clean. Verified live through the ERP's own BFF: skills, media, digest next-run
  (18:00 today / 12:00 tomorrow Asia/Singapore), filters, paging, ignore-list write (reverted after), kill switch
  (restored), and a LID DM thread loading real messages.

### [0.8.3] — 2026-07-27 · DEV-VERIFIED (group names in the Chats tab + digests)
- `groupName()` consulted ONLY the registry and fell back to the raw JID. In trial mode the registry is
  empty, so the ERP's Chats tab listed groups as `1203…@g.us` while the Groups tab (which reads the
  discovery store) showed real names. It now checks registry → discovered subject → JID. Digest headers
  (`schedule.ts`) get the same benefit. Verified live: Chats now lists General, Marketplace, CLASS 7C, etc.

### [0.8.2] — 2026-07-27 · DEV-VERIFIED (session timeline: seeded from WAHA + persistent)
- **Bug:** the ERP Logs tab showed "No session events recorded yet" and the status pill read UNKNOWN, even
  with a healthy WORKING session. Two causes: the transition ring buffer was in-memory only (wiped on every
  bot restart), and it was fed *exclusively* by the `session.status` webhook — which WAHA fires only on a
  CHANGE, so a session that was already WORKING before the bot booted produced no event at all, leaving
  `/health` reporting `session: "unknown"` indefinitely.
- **`session-state.ts`:** timeline persisted atomically (tmp+rename) to `SESSION_EVENTS_FILE`
  (default `data/session-events.json`, i.e. the bot-data volume) on every append; NEW `loadSessionEvents()`
  called once at boot in `server.ts` (explicit, not lazy, so tests stay deterministic); NEW `observeStatus()`
  records a POLLED status, de-duplicated against the last known one so ERP polling can't spam the ring, and
  refusing to let `unreachable`/`unknown`/empty overwrite a real status.
- **`waha-admin.ts`:** `getSessionStatus()` feeds every REST read through `observeStatus()`, so the boot
  `refreshSelfJid()` call seeds the current status and any transition WAHA's webhook dropped is still caught
  while an operator has the console open.
- **Verified on the live stack:** after rebuild `/health` reports `WORKING` immediately, `/admin/session/events`
  carries the seeded entry, and both survive a `docker restart` with no duplicate entry. Confirmed through the
  ERP's own BFF path (`/api/admin/bot/status|session/events`).
- **Test hygiene:** `phase1/phase2.e2e` mock the store and pin `scheduleStateFile`, but `schedule-state`
  switches to Postgres whenever `config.databaseUrl` is set — so the suites passed or failed on whatever
  `DATABASE_URL` happened to be in the developer's `.env`. Both now pin `config.databaseUrl = ""`, keeping
  them on the intended file fallback (and unable to write into the live bot store).
- **Action audit: not a bug.** `/admin/actions/audit` returns `{enabled: true, entries: []}` — no mutating
  action has ever been attempted, and the audit file lives on the persistent volume. Coverage confirmed in
  `actions/executor.ts` (kill-switch, rate-limit, step-up, deny and execute outcomes all audited). The UI
  empty state now explains this instead of reading as a fault.

### [0.8.1] — 2026-07-27 · DEV-VERIFIED (discovered groups: named + persistent)
- **Bug:** the ERP Groups tab listed discovered groups as blank rows with only an Add button. Two causes: `bot.ts`
  called `noteDiscovered(chatId)` with no name (WAHA's `message` webhook carries the SENDER's `notifyName`, never the
  group subject, and `InboundMessage` has no chat-name field), and the discovery map was in-memory only, so the list
  reset on every restart.
- **NEW `src/group-names.ts`:** out-of-band subject resolution from WAHA, read-only and fail-soft (WAHA down /
  unpaired / endpoint absent → no name, never an error on the message path). One cached bulk sweep (60s TTL,
  in-flight dedup) of `GET /api/{session}/groups`, falling back to `/chats`, then bounded per-group probes.
  Shape-tolerant against the live NOWEB engine: `/groups` answers with a **JID-keyed object** (not an array),
  ids are bare strings on NOWEB and `{_serialized}` on WEBJS, subject is `subject` (NOWEB) or `name` (WEBJS).
- **`groups.ts`:** discovery persisted atomically (tmp+rename) to `discovered-groups.json` derived from
  `dirname(GROUPS_FILE)` (override `DISCOVERED_GROUPS_FILE`) so it follows the registry onto the writable volume;
  lazy hydrate on read; 500-entry oldest-first cap; NEW `setDiscoveredName()` late-binds a subject (never blanks or
  churns an existing one); re-seeing a persisted group no longer re-announces it as new.
- **Wiring:** `bot.ts` fires `ensureGroupName()` fire-and-forget per group message (no-op once known);
  `GET /admin/groups` awaits `backfillDiscoveredNames()` so the ERP shows real names on first load.
- **platform-ui `0.6.1`:** `GroupRegistry` falls back to the JID when a subject is still unresolved (was rendering a
  blank row), and seeds the registry row with the JID rather than an empty name on Add.
- **Verified on the live stack:** all 13 discovered groups resolved to real subjects on the first admin read after
  rebuild, and the list survived the restart. 32 unit tests for the two modules; bot suite green except the
  pre-existing Postgres-credential failures in this dev env.

### [0.8.0] — 2026-07-24 · PROTOTYPED (session-lifecycle admin plane + writable group registry)
- **Workstream A (WhatsApp go-live self-service, design §2):** new `waha-admin.ts` client + ADMIN_TOKEN-gated Fastify routes for session lifecycle
  (POST start, GET status, GET qr with data-URL base64, POST stop/logout/restart); all engine-tolerant (NOWEB status strings pass verbatim).
  Routes: `/admin/session/{start,status,qr,stop,logout,restart}` with responses per design spec §2.1.
- **Writable group registry:** moved from read-only compose bind mount to writable bot-data volume (`/app/data/groups.yaml`); YAML + mtime
  hot-reload unchanged; NEW `writeGroups()` validates (id regex, name/category lengths, ≤1 isManagement, ≤500 groups, atomic write);
  `discoveredGroups()` returns in-memory map of auto-discovered groups with firstSeenAt. Routes: `GET /admin/groups` (registry snapshot + discovered
  + managementGroupId), `PUT /admin/groups` (full-replace, idempotent, field-level validation 400).
- **Safe config write:** `GET /admin/config` (read-only snapshot + editable values), `PUT /admin/config {postToGroups?, managementGroupId?}` rewrites registry
  isManagement flag when managementGroupId changes (empty string clears to env fallback). **No editing of other env-backed config from ERP** (design 2.3 §2.6).
- **Session-state tracker (NEW `session-state.ts`):** extends InboundEvent with `{kind:"session", session, status, ts}`; normalizeWahaEvent maps webhook
  `session.status` events (tolerates both payload.status + payload.body.status shapes); ring buffer of last 20 transitions `{status,ts}` + WARN logs on
  FAILED|STOPPED transitions; `/health` gains `session` field (status string only, no identifiers).
- **Bot environment updates:** `GROUPS_FILE=/app/data/groups.yaml` (writable), `GROUPS_SEED_FILE=/app/config/groups.seed.yaml` (read-only seed);
  boot logic: if `groupsFile` absent and seed exists → copy seed → log one line. Existing `WHATSAPP_HOOK_EVENTS` already subscribed `message,session.status`.
- **NOT deployed yet:** bot session e2e tested (start→SCAN_QR_CODE→QR); UI surfaces pending (WS5 scope, not yet built).

### [0.7.1] — 2026-07-24 · NOWEB engine + aire-lesson hardening
- WAHA switched to the **NOWEB (Baileys) engine**, image pinned `devlikeapro/waha:noweb-2026.6.2`
  (no more `:latest` — aire hit floating-tag drift). Added `WHATSAPP_DEFAULT_ENGINE=NOWEB`,
  `WHATSAPP_DOWNLOAD_MEDIA=True` (feeds media enrichment), `WHATSAPP_HOOK_EVENTS="message,session.status"`
  (see reconnect/ban state, not just messages). Kept `RESTART_ALL_SESSIONS` + persisted `.sessions`
  volume (relink survives restart w/o re-QR).
- Bot persona renamed **Gaia → Rhea** (`BOT_NAME` default); persona still playful/professional by stakes.
- `normalize()` hardened engine-tolerant (aire lessons): `replyToBot` now also reads NOWEB-normalized
  `replyTo.fromMe`; `senderName` falls back to `_data.pushName`; **system-chat guard** drops
  `status@broadcast`/`@broadcast`/`@newsletter` (never reply there). Webhook already ACKs 200 before
  detached processing (dup-reply lesson already satisfied). +4 normalize tests; suite green.
- **NOWEB caveat:** the store must be enabled at SESSION CREATION (`config.noweb.store.enabled`), not
  via env, and final NOWEB payload shape can only be validated once a number is paired (needs the phone).

### [0.7.0] — 2026-07-24 · DEV-VERIFIED (persona + prompt-safety)
- New `src/persona.ts`: agency persona (voice adapts to stakes — playful/low-stakes, direct/work,
  firm/at-risk), scope limits, graceful decline, and an injection guard. `fence()` wraps untrusted
  content and neutralizes fence-breakout attempts; `dataNote()` marks fenced data as non-instructions.
- Wired into every chat-facing prompt: `answerQuestion` (persona + scope-narrowed — no open-ended
  general knowledge), `/know` + `/actions` skills, digest map/reduce (injection guard only, stays a
  neutral report), intent router (message fenced + "classify only, ignore embedded instructions").
- Reply gating hardened: `@bot` match changed from loose `includes()` to a standalone-token regex
  (`mentionsBot`) so "@bottom"/"x@bot.com" no longer trigger the bot. Gating unchanged otherwise:
  groups reply only on command/@mention/reply-to-bot; DMs always; non-triggered messages stored
  silently for digests. Digests remain management-only unless a group opts in / `POST_TO_GROUPS=true`.
- Config: `BOT_NAME` (default "Gaia"), `AGENCY_NAME` (default "Gaiada").
- Tests: new `persona.test.ts` + mention-hardening cases; 194 pass (3 pre-existing e2e fails are
  Postgres-auth env issues, unrelated). **Live e2e** against Ollama Cloud via the rebuilt gateway:
  in-scope Q&A answers naturally & grounded; jailbreak/prompt-leak declined w/o leaking; off-topic
  declined + redirected; at-risk prompt drew a firm, accountable reply. Bot container rebuilt + live.
- Baseline. WA + Telegram bot; scrub → crypto-shred → skills/Q&A; digests; media enrichment. Telegram live
  in dev; P5a features.
- **Blocked:** infra (OpenBao/Gemini/WAHA) + legal Gate 1 before real ingestion.

## ai-agents
### [0.4.0] — 2026-07-24 · PROTOTYPED (agent-runner service + goal/run store + queue)
- **Workstream B agent runtime e2e (design §3):** NEW `src/runner/service.ts` Fastify microservice (port 3006, AGENT_RUNNER_TOKEN auth, mirroring knowledge/service.ts patterns).
  `buildRunnerApp(deps)` factory for tests. Env: `GATEWAY_URL/GATEWAY_TOKEN`, `HUB_URL/HUB_SERVICE_TOKEN`, `AGENTS_DATABASE_URL` (runtime role), `MIGRATE_DATABASE_URL`
  (owner role), `AGENT_MAX_CONCURRENT_GOALS` (default 1), `AGENT_MAX_QUEUE` (default 10), `AGENT_SERVING_PROVIDER` (optional override for D13 gate).
- **Data model (gaiada_knowledge):** NEW tables created by owner-DSN DDL (zero infra/DB-role changes needed, auto-grant to knowledge_app per existing pattern).
  `agent_goals` (queued|running|ok|suspended|budget_exhausted|failed|interrupted|cancelled, outcome, error_kind, approval_id, model_calls, tool_calls, budget caps,
  fan_out, blackboard jsonb for supervisor goals), `agent_runs` (full traced run per direct-specialist goal, TraceStatus, steps transcript, tools_called array).
  Indexes on (tenant_id, created_at DESC) for both.
- **Execution semantics:** supervisor → `runOrchestrator` → approval suspension → `suspended` + `approval_id`; write-specialist → `runWriteAgent` → `forced_read_only`
  (outcome notes the gate); read-specialist → `traceRun` → `agent_runs` row. Boot-recovery sweep: `UPDATE agent_goals SET status='interrupted'` for orphaned (queued|running)
  goals — deterministic, human re-triggers. In-process FIFO queue, workers unref'd, max-concurrent + max-queue gates. Typed error mapping:
  Budget → `budget_exhausted`, Approval/Suspended → `suspended`, Unknown/Planner/Model/ToolNotAllowed → `failed` + `error_kind`.
- **HTTP endpoints:** `GET /health` (agents/writeAgents/queue list), `POST /goals` (token, 202 queued), `GET /goals?tenant=uuid&limit=50` (list, newest first),
  `GET /goals/:id?tenant=uuid` (goal + blackboard + run summaries), `GET /runs/:id?tenant=uuid` (full run + steps), `POST /goals/:id/cancel?tenant=uuid` (queued→cancelled),
  `GET /metrics/agents` (collector summary + alerts). All reads tenant-pinned (no cross-tenant id probing).
- **Existing integrations preserved:** episodic store (PgEpisodicStore) auto-records every finished goal/run, D9 RAG, D11 revocation, D13 forced_read_only, D14 approvals.
  `evaledProviders` enrollment via eval suite + tool-contract check (runbook: `docs/runbooks/agent-evaled-providers-enrollment.md`).
- **DEV-VERIFIED end-to-end** (2026-07-24): agent-runner container lives; goal/run store persists on gaiada_knowledge; goal execution follows approval-suspension
  path (D14 gates untouched); D13 forced_read_only surfaces in status + UI; gateway timeout + 429 breaker work with runner calls (x-tenant-id propagated).
- **NOT deployed yet:** agent-runner container exists but not deployed; pending search-marketing build blocker for full UI-through.

### [0.3.0] — 2026-07-23 · IN PROGRESS
- Baseline. Specialist framework + supervisor + pgvector RAG; D14 safety.
- **Next:** eval harness (root gate) → memory/RAG → local-model registry → trainer.

## hermes-gateway
### [0.2.0] — 2026-07-23 · PROTOTYPED
- Baseline. Local Hermes brain via the Gateway contract; verified headless.

## capture-helper
### [0.2.0] — 2026-07-23 · IN PROGRESS
- Baseline. Capture edge: record → local Whisper → ingest → Shared Drive.
- **Next:** complete the MOM→PRD delivery pipeline tails.

## mail
### [0.0.0] — 2026-08-04 · PLANNED · design v2 (owner revision, same day)
- Design + ticket plan revised in place (still no code). Cut: email digest + channel prefs
  (staff notifications are in-app only; approval mail to a required decider is not opt-out-able).
  Re-scoped triggers: only medium+/unclassified automation suspensions (the existing WS4/D14
  impact gate — no new classifier) and human-approval asks, routed to the mirrored Cerbos DECIDE
  set per origin; clients ride the same path. D14-aware wording split (warning vs actionable;
  automation/agent stays warning until a resume path exists). Approval links: plain deep links
  behind SSO — never action buttons, reply-approval, or magic links. Widened: inbound system-mail
  threads (`mail_messages`, VERP `reply+<token>@notify.gaiada.com`, untrusted-intake hardening +
  ClamAV), `/admin/mail` log UI + entity thread panels, and a staging-ready staff Gmail read
  surface (internal OAuth app, per-user consent, no DWD, `gmail.readonly`, render-on-demand /
  cache-nothing; reconciles with the 0033 vault + WD-23A-1's staged `google_oauth_states`).
  Domains locked: `auth.`/`notify.gaiada.com` + `forms.gaiada.online`; Zone A primary = Google
  Workspace SMTP relay, Brevo failover/inbound/forms. Migrations: mail core still `0076` (adds
  `mail_messages`; drops the prefs/digest tables from the draft DDL); Gmail CHECK widening at
  build-time next-unused. Tickets re-cut to MAIL-01A/01B…18 (07/08 dropped); Opus flags: MAIL-10,
  MAIL-13 (both opus·medium).
### [0.0.0] — 2026-08-04 · PLANNED
- Registered (design only, no code). Zone A email subsystem for platform-nest: provider adapter over
  a rented relay (Brevo → ZeptoMail/SES), PG-backed queue + `mail_log`/suppressions/bounce webhooks
  (migration `0076` — re-verify at DDL time), notification email as immediate-allowlist + daily
  digest on the existing `notify()` surface, Keycloak/Alertmanager SMTP wiring (zero code), magic
  links designed for a later ticket behind an auth-stream p95 SLO gate. Three sending subdomains +
  three separate keys for reputation isolation; Zone A mail never routes through webdesk C-03.
  Design: `docs/superpowers/specs/2026-08-04-zone-a-mail-design.md` · tickets:
  `docs/superpowers/plans/2026-08-04-mail-subsystem-tickets.md`.

## webdesk
### [0.0.0] — 2026-07-23 · PLANNED
- Blueprint approved; no code. Phased plan P1–P6 (see BLUEPRINTS.md).
- **2026-08-04 — blueprint amended to v1.1 (still no code, version unchanged):** C-03 unpinned from
  Hostinger SMTP → rented relay (Brevo free tier → ZeptoMail/SES at volume); three sending
  subdomains with separate per-stream provider keys (new decision D14 — form abuse must never burn
  login mail's reputation); default identity `From:` our domain + `Reply-To:` the human, per-tenant
  "send as your own domain" as an SPF/DKIM opt-in upgrade; explicit statement that **Zone A (ERP)
  mail does not route through C-03** (platform-nest carries its own mail module — see the `mail`
  module above); C-02 annotated that per-tenant recipient addresses are plain config (no DNS or
  mailbox work on our side); portability table Mail row updated. HTML is v1.1; **PDF + hosted
  artifact not re-rendered yet** (see BLUEPRINTS.md regeneration note).

## search-marketing
### [0.5.0] — 2026-08-01 · DEV-VERIFIED
- **Promoted `IN PROGRESS` → `DEV-VERIFIED`** by the SM-24 final QA gate (tracker §6bu, re-verdict
  §6by) after SM-19/20/21/22/25c/63–75 all landed with their own gates discharged.
- **One dev-provable defect found and closed in this window:** `main.ts` wired
  `registerLiveAdsExecutor`/`assertAdsWriteModeBootSafe` inside only the `SEARCH_PROVIDER_MODE=live`
  branch (a stale comment claimed the registration ran "unconditionally"), so `simulate`-data +
  `live`-ad-writes booted silently and would have failed at request time, after an approval had
  already been spent — reproducible with two env vars, no vendor account. Fixed by hoisting both
  calls to function scope outside the mode branch (§6bv) and made test-executable via an extracted
  `wireSearchProviderModeAndAdsWriteMode()` that `bootstrap()` calls (SM-75, §6bx), so a boot-wiring
  smoke test drives the real production call site instead of a copy of its ordering. The QA gate
  independently re-derived the negative control (re-nesting the calls) and reproduced the exact
  2-of-5-red symptom before restoring via `sha256sum`-verified `cp` (§6by).
- **A related infra fail-open, found and fixed in the same window:** `docker-compose.vps.yml` had no
  environment passthrough for `GOOGLE_OAUTH_*`, `GOOGLE_ADS_*`, or either callback secret — real
  credentials set in `infra/compose/.env` would have had zero effect on the container while the
  platform reported the vendor "not configured" (indistinguishable from a deliberate choice not to
  configure it). Both `docker-compose.vps.yml` and `.env.example` fixed (§6bw).
- Local stack brought to latest (image rebuilt, DB migration head `0061 → 0069`) and re-verified:
  `src/modules/search` **1061 passed / 4 skipped, zero reds**; full platform tree **2552 passed /
  4 skipped, zero FAIL markers**, identical count pre/post-migration (§6bw/§6bx.1).
- Real-vendor-account fidelity (Google OAuth client, Ads developer token, DataForSEO/Semrush/Ahrefs
  keys) remains deliberately unproven — staging-only per standing policy (SM-41G) — and is not a
  condition of `DEV-VERIFIED`, which measures dev-stack end-to-end exercise, not production
  readiness.

### [0.1.0] — 2026-07-23 · IN PROGRESS
- **SM-01 landed** (migrations `0034_module_search.sql` + `0035_integration_connections_search_providers.sql`
  + `module-search-rls.test.ts`): 18 `search_*` tenant tables under third-wall FORCE-RLS + the no-RLS
  `search_data_cache` (D-4), dual-mode embedding col (float8[] fallback — pgvector absent, OQ-8),
  additive `integration_connections` widen. Merge gate cleared: QA PASS (45/45 db tests, adversarial
  RLS matrix on a second DB) + architect APPROVE-WITH-NOTES (full §04/§11 conformance).
- **SM-02 landed** (`src/modules/search/` — ModuleContract, controller `api/:t/modules/search`, 18
  `search.*` mcpTools, property/engagement/kpi CRUD, `engagements/:id/scope` + preset seeding,
  service-layer same-tenant FK validation). Full repo suite 512/512 green; tsc + withTenants lint clean.
  Module is fail-closed until SM-03 adds Cerbos policy (by design).
- **SM-03 landed** (`cerbos/policies/resource_search_{property,engagement,keyword,audit,campaign,report,
  ledger}.yaml` + derived-roles wiring + `search-cerbos.test.ts` + the `platform-ui/src/lib/rbac.ts`
  capability mirror with `search_staff`/`search_manager` derived roles). **Declared 2026-07-27 after
  verification** — the code landed 2026-07-24 but the gate was never recorded. Re-run against live
  Cerbos (49 executable policies): 25/25 parity tests green, covering owner/manager/member/served-dept
  plus every deny case in the AC (`launch`/`apply_manual`/`apply_negatives`/`set_budget` denied to staff
  and to served-dept staff, `approve`/`deliver` denied to member, `set_scope` denied to member per D-11,
  ledger `admin` denied to member, cross-tenant grants denied, low-assurance principals get nothing).
- **SM-00 (reconcile, off-design ticket) 2026-07-27:** all four search suites re-run against live
  Postgres + Cerbos → **60/60 green** (`search.test.ts` 13, `search-cerbos.test.ts` 25,
  `module-search-rls.test.ts` 15, `scope-presets.test.ts` 7). MODULES.md section header corrected
  (`0.0.0 · PLANNED` → `0.1.0 · IN PROGRESS`, matching the registry row it contradicted); execution
  tracker added at `blueprints/seo-sem-execution-tracker.md`.
- **SM-04 AC discharged 2026-07-27 (awaiting the ⚡ QA + architect gate).** The provider layer
  (`providers/{types,registry,dispatch,cache,ledger,mock-provider}.ts`, landed 07-24) gained its
  missing halves: **`providers/dispatch.test.ts` (35 tests)** and the **`GET
  engagements/:id/cost-projection`** endpoint (+3 controller tests, with `?toolScope=` what-if
  pricing and an `overBudget` flag). All five AC clauses proven on live PG — scope-disabled refused
  naming the *toggle*, cache hit = cost 0 (incl. the cross-tenant D-4 reuse that IS the cost model),
  8 concurrent identical queries → exactly 1 dispatch, engagement+tenant breach refuses/emits/blocks,
  ledger sums reconcile with the stop-loss's own reader. Plus true-up (same row, never a second),
  rollback-on-provider-failure, and fail-closed provider resolution. Search suites **98/98**; tsc and
  `lint:withtenants` clean. Three findings fixed: (1) a scope refusal could be masked by
  `unknown_provider` when no driver is registered; (2) `lint:withtenants` was **failing** on
  `ledger.ts:70` — SM-04 had landed without that gate, now a reasoned allowlist entry **pending
  architect ratification**; (3) the 80%-warn float boundary documented. Full-repo suite: 574 passed /
  1 failed / 60 skipped — the one failure is `admin/bot-admin.test.ts` (WhatsApp chat-thread proxy),
  reproducible, pre-existing and unrelated to search.
- **SM-05 + SM-06 AC discharged 2026-07-27 (awaiting the same ⚡ gate).** `providers/dataforseo.ts` —
  the real driver behind SM-04's interface (Standard-queue `task_post`→`task_get` with the 40602
  in-queue poll, keyword metrics, backlinks, AI-visibility, §8a rate table) with **25 mock-server
  tests** on an injected `fetchImpl`: no network, no credentials, no deposit needed. Live queue exists
  but only via an exact `live` string — a typo cannot triple the bill. Config: `config.search.
  {dataforseo,pillars}`, keyless bootstrap registration in `main.ts`, and env rows in
  `platform-nest/.env.example`, `infra/compose/.env.example` and `docker-compose.vps.yml`.
  **Keyless is first-class** — no credentials means the paid driver is never registered, paid
  capabilities fail closed, and the $0 pillars keep working. Added beyond the ticket text: the
  per-pillar kill switches needed somewhere to bite, so dispatch gained a **gate (-1)**
  (`PillarDisabledError`) ahead of the scope gate. Search suites **125/125**; tsc + lint clean.
  **Still gated on the $50 deposit:** the real-data pull (SM-05's one remaining AC clause).
- **M1 reached pending the gate** — the money path is fail-closed at four independent gates
  (pillar → engagement tool-scope → ordered budget stop-loss → provider capability).
- **Next:** the ⚡ QA + architect gate over the P0 tail, then P1 (SM-07 crawl workers ∥ SM-09 keywords).

### [0.0.0] — 2026-07-23 · PLANNED
- Foundation research + v1.1 architect design ratified; no code. See
  `blueprints/seo-sem-foundation.md` + `blueprints/seo-sem-design.md`.
- Owner decisions locked: dept name SEO (3-craft-group Web-Dev console), dual-mode SEM execution,
  no-RLS shared market-data cache, per-engagement tool-scope config.
- 26 tickets P0–P3 + 2 committed P4 (design §12).

## social-media
### [0.0.0] — 2026-07-23 · PLANNED
- Foundation research + v1.0 architect design; no code. See `blueprints/smm-foundation.md` +
  `blueprints/smm-design.md` (+ print `GAIADA-Social-Media-Engineering-Blueprint.pdf`).
- Decisions locked: scope v1 = organic publish + engagement + copy + assets (paid/listening/influencer
  parked); publisher = Postiz (AGPL-3.0) run AGPL-CONTAINED (Mixpost Pro paid fallback); Chatwoot dropped
  (engagement uses Postiz's comment/collab surface). Module key `social`, tables `social_*`; mandatory
  human-in-the-loop (one-shot payload-hash approvalId, no auto-publish); one usage ledger (X fees + gen
  credits); no shared no-RLS cache.
- **Next:** P0 contracts + AGPL-containment spike (SMM-01 migrations/RLS → SMM-02 module/contract →
  SMM-03 Cerbos → SMM-04 Postiz adapter/containment → SMM-05 tenant mapping → SMM-09 approve-execute).
  27 tickets P0–P4 + 2 decision-gated (design §12).

## creative
### [0.1.0] — 2026-07-23 · PROTOTYPED
- Baseline (pre-existing dev code): **Image Studio** client-side grading engine (WebGL2 LUT + Canvas2D
  fallback, pure imaging lib, 35 UI tests, visually verified) + `creative_assets` persistence (migrations
  `0031`/`0032`, `/api/:t/creative/assets`) + grading-trainer ONNX scaffold. See memory `creative-image-studio`.
- **Expansion designed (no code yet):** v1.0 architect design authored — `blueprints/creative-foundation.md`
  (research + Magnific head-to-head) + `blueprints/creative-design.md` (§00–§14) + print
  `GAIADA-Creative-Engineering-Blueprint.pdf`. Module key `creative`, tables `creative_*`, third-wall RLS,
  migration `0036`; `creative_assets` extended in place + versions/collections/brand-kits/render-jobs/
  usage-ledger/scopes. Build-light DAM (RLS store + Shared Drive + pgvector CLIP search + BLIP tags +
  imgproxy renditions). Default model stack commercial-license-CLEAN; SUPIR/FLUX-dev/RMBG/IC-Light-V2/SVD
  quarantined behind license gates.
- Owner decisions locked (2026-07-23): serverless-GPU-first · hybrid image licensing (clean default + FLUX
  paid opt-in) · hybrid video (Wan 2.2 OSS + Veo/Kling API budget) · build-light DAM.
- **Next:** Phase 0 clarity-upscaler Replicate spike (kill Magnific now) → P0 contracts → P1 upscale via
  the Render Gateway → P2 gen/edit → P3 DAM → P4 video. 27 tickets CR-00–CR-26 (design §12); Opus-flagged
  CR-01/06/13; QA gates CR-01/06/12/13/20.

## render-gateway-go
### [0.0.0] — 2026-07-23 · PLANNED
- Design only — the centerpiece of `blueprints/creative-design.md` §05; no code. Separate Go service
  (mirror of `ai-gateway-go`): typed render job-queue, `RenderBackend` abstraction (serverless GPU /
  self-host ComfyUI / commercial API) routed per capability+license+cost+health, ComfyUI-workflow-as-JSON,
  signed per-job I/O URLs, idempotent render-callback, fail-closed stop-loss (image $200 / video $300),
  structural license wall, egress audit. Outputs land in the `creative` DAM; job state on platform-nest rows.
- **Next:** built under the `creative` P1–P4 tickets; container-build verification before deploy.