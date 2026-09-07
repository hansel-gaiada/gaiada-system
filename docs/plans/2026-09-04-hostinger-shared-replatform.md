# Replatform: retire `delphi`/`helios`, client delivery moves to Hostinger shared

**Date:** 2026-09-04 · **Status: PLANNED — authoring only.** Nothing has been executed against
`helios`, `delphi`, or any Hostinger account. No site has been moved, no file deleted, no DNS
record changed, no migration applied.

**Owner direction (2026-09-04):** we stop using `delphi` and `helios` for client websites.
**Production** goes to a Hostinger **shared** account on the **Agency Startup** plan. **Staging**
goes onto the **existing Hostinger shared hosting the WordPress sites already use** — so the
delivery estate becomes shared-only, mixed across two shared accounts. The team must first delete
unused sites in the staging (shared) account to make room.

**Related:** `docs/blueprints/webdesk-design-v2.md` §03/§07/§12/§14 (WSK-D32 zoning, which this
amends) · `docs/plans/2026-09-04-site-consolidation-ledger.md` (the 81-row registry this migrates)
· `docs/plans/2026-09-04-client-hosting-credential-vault.md` (VLT-1..7 — the credentials this needs)
· `docs/plans/2026-08-31-helios-delphi-plane-a-rollout.md` (the observe-only tier being retired) ·
`infra/runbooks/onboard-server.md` §0 (never-touch entries for both hosts).

---

## 1 · The ruling this creates, and what it supersedes

Per this program's own standing rule — *no ruling exists outside the decision log* — the direction
above is not in force until it is written into `webdesk-design-v2.md` §14. Proposed entry, next
free id:

> **WSK-D37 — Client delivery is shared hosting only; `delphi`/`helios` are retired
> (owner-ruled 2026-09-04). Amends WSK-D32.** The *role zoning* of WSK-D32 stands — control plane
> (`gda-aicenter`), client project delivery, observation (`sumopod`). What changes is **which
> machines fill the delivery role**: no longer `delphi` (staging) and `helios` (production), but
> **two Hostinger shared accounts** — Agency Startup for **production**, the existing WordPress
> shared account for **staging**. Consequences that follow directly and are not separately
> negotiable: delivery hosts have **no root, no Docker, no daemons, and no arbitrary runtime**;
> `host_kind` for every delivery row becomes `shared-hosting`, never `our-box`; the deploy channel
> becomes file transfer into a document root, not `ssh + rsync` to a box we administer; and the
> §12 P6 gate ("reachability and deploy identity for `delphi`/`helios`") is rewritten against
> Hostinger, not deleted.

**WSK-D32's own words that this amends:** *"client project delivery = `delphi` (staging) ·
`helios` (production) · the Hostinger WP servers · client-owned servers."* Three of those four
survive; the first two do not.

**What this does NOT change, and must not be read as changing:**

- **WordPress stays on Hostinger permanently** (§03 corollary, §12 P5). That was already true. This
  ruling makes the *rest* of the portfolio join it — it does not reopen the WP tier.
- **WebDesk still installs on `gda-aicenter` only.** A shared host cannot run it; if anything, this
  ruling makes WSK-D32's placement of the platform *more* forced, not less.
- **The observe-only ruling on client-owned hosts** (MON-01, `verified_at` consent gate) is
  untouched.

---

## 2 · What is actually on the two boxes (verified 2026-08-31, must be re-verified before any move)

From the read-only survey in `2026-08-31-helios-delphi-plane-a-rollout.md` §1 — the last time
anyone looked, four days ago:

| | `helios` (production) | `delphi` (staging) |
|---|---|---|
| Containers | 0 | 0 |
| Web stack | native nginx + **10 PHP-FPM pools, 7.1 → 8.5** | native nginx + **8 PHP-FPM pools, 7.1 → 8.5** |
| Control panel | CloudPanel CE (`clp-nginx`, `clp-php-fpm`), UI on `:8443` open to `0.0.0.0` | same |
| Datastores | MariaDB, **PostgreSQL**, Redis, MinIO, Memcached, pgbouncer, Varnish — all `127.0.0.1` | same shape |
| Other | — | `monarx-agent` (third-party malware scanner, not ours) |
| Known slots | ~23 live third-party client sites (WSK-D27's own count) | ~11 ephemeral preview slots under `NN-xxxxx.gaiada.com` |

> **CORRECTED 2026-09-05 by the §10 re-survey. Read §10 before using this table.** Item 1 below is
> **wrong** and the vhost/site counts are wrong. Kept in place rather than rewritten, so the error
> and its correction are both visible.

**Three facts in that table decide the whole migration and are easy to skate past:**

1. ~~**PHP-FPM pools at eight different versions, down to 7.1.**~~ **WRONG — retracted 2026-09-05.**
   The ten `/etc/php/*` trees are installed *runtimes*, each carrying CloudPanel's stock
   `default.conf`/`global.conf`. Counting those as sites invented a legacy-PHP crisis that does not
   exist. **Actual per-site pools: 7 on `helios`, all on PHP 8.3/8.4; zero on `delphi`.** See §10.
2. **PostgreSQL, Redis, MinIO, Memcached and Varnish are all installed on those boxes.** Hostinger
   shared gives **MySQL/MariaDB and nothing else**. Any site backed by Postgres, using Redis for
   sessions/cache, or serving assets from MinIO **cannot be lifted to shared hosting as-is**. It
   needs a rewrite, a managed external service, or a different home. Until we know *which* sites
   those are, the migration has no schedule.
3. **The registry says adoption on `delphi`/`helios` was "a re-point, not a rebuild."** That
   sentence (`site-consolidation-ledger.md`, target-state policy) was true *because those were our
   boxes*. Under D37 it is **no longer true** for anything that needs a runtime. The ledger's
   target-state policy has to be re-derived — see §6, HSR-9.

> **Precondition R0 (§5) is a fresh survey, not a re-read of the above.** Those numbers are four
> days old, were taken for a different purpose, and this checkout is known to lag `main`.

---

## 3 · The capability delta — what "shared" costs us

Every row here is a **claim to verify against the real accounts**, not a settled fact. Hostinger's
plan matrix changes, and Agency Startup's exact entitlements must be read out of the actual plan
and hPanel — not assumed from this table. Each row carries the check that settles it.

| Capability | `delphi`/`helios` today | Hostinger shared (expected) | How we settle it |
|---|---|---|---|
| Root / package install | yes | **no** | given |
| Docker / long-running daemons | possible (0 in use) | **no** | given |
| Node.js SSR (Next.js `next start`) | yes | **assume no** | HSR-1: deploy one throwaway Next app on the account before promising any client |
| Static build hosting (Astro/Vite/Next `export`) | yes | **yes** | HSR-1 |
| PHP versions | 7.1 → 8.5 | bounded modern set | HSR-1: list selectable versions in hPanel |
| MySQL / MariaDB | yes | **yes** | HSR-1 |
| PostgreSQL / Redis / MinIO / Memcached / Varnish | yes | **no** | HSR-2: which sites depend on these |
| Shell access | full SSH | **jailed SSH on some plans, or none** | HSR-1 — decides the deploy transport (§6, HSR-5) |
| Cron | full | limited, per-plan | HSR-1 |
| Site count cap | disk-bound | **plan-capped** | HSR-1 — this is what forces the staging cleanup (§7) |
| Control panel | CloudPanel | **hPanel** (not cPanel) | given — and a schema problem, §6 HSR-4 |
| Per-site isolation | separate PHP-FPM pools, one kernel | shared account, weaker | accept; note in the risk register |
| Ephemeral preview slots (~11 on `delphi`) | free | **each consumes a plan slot** | HSR-3 — decide whether previews survive at all |

**The honest summary:** this is a move from *a machine we administer* to *a hosting product*. Static
and PHP/WordPress sites travel well. Anything with a runtime or a non-MySQL datastore does not, and
for those the choice is rebuild, retire, or keep on `gda-aicenter` — which is the control plane and
under WSK-D32 is **not** a delivery host. That conflict is real and is OQ-3.4 below.

---

## 4 · Open questions — owner decisions this plan cannot make

| # | Question | Why it blocks | Default if unanswered |
|---|---|---|---|
| **OQ-3.1** | **When do `delphi`/`helios` stop being paid for?** | The only real deadline in the plan. Everything in §5 is sequenced against it. | Assume no deadline; the plan runs at safe pace and the boxes stay up |
| **OQ-3.2** | Is the Agency Startup account **new**, or an upgrade of an existing one? And is the WordPress staging account the same estate as the Hostinger WP VPS `srv599617`, or a separate shared plan? | Decides whether staging and production share a billing/credential boundary, and whether "delete unused" touches live client WP. | Treat as two distinct accounts, two distinct vault entries |
| **OQ-3.3** | Do the **~11 `delphi` preview slots** survive the move, or is ephemeral preview retired? | Each costs a slot on a capped plan; preview is deliberately distinct from staging in the schema (`environment` CHECK). | **Retire ephemeral preview.** Staging is durable and client-visible; preview is machine-generated and can be rebuilt |
| **OQ-3.4** | Sites that **cannot run on shared** (Node SSR, Postgres/Redis/MinIO-backed): rebuild as static, retire, move to the client's own host, or a **named exception** on `gda-aicenter`? | An exception weakens WSK-D32's zoning — the control plane would start carrying client deliverables. That is a ruling, not an engineering call. | **No exception.** Each such site gets an individual owner decision, recorded per-row in the ledger |
| **OQ-3.5** | Sites on **PHP below the Hostinger floor**: update or end-of-life? | Same shape as 3.4 but cheaper per site; still a client conversation. | Flag per row, move nothing until answered |
| **OQ-3.6** | Retention rule for the staging cleanup: what makes a staging site "unused"? | Deletion is irreversible and some of these are client-visible. §7 refuses to run without a stated rule. | **Nothing is deleted.** §7 produces an inventory and stops |
| **OQ-3.7** | Does any **email** (MX, mailboxes, `wp_mail` relay) run on `delphi`/`helios`? | Silent breakage that surfaces days later, after the box is gone. | Assume yes until R0 proves otherwise |
| **OQ-3.8** | Where do the **DNS records** for these domains live, and who can change them? | The cutover *is* a DNS exercise; without this the plan has no cutover step. | R0 must answer it before any phase past R2 |

---

## 5 · Phases

Sequenced so that **nothing is deleted or moved before it is inventoried**, and the first real
client cutover happens only after the path has been proven on a site nobody would miss.

| Phase | Contents | Gate — do not pass without this |
|---|---|---|
| **R0 · Survey (read-only)** | Fresh survey of both boxes: every vhost, its PHP version, its datastore dependencies, its DNS provider, its mail role, its registry row (or absence of one). Output is a gitignored `*.local.md` worklist keyed by domain — the estate inventory is client data and this repo is public. Answers OQ-3.7 and OQ-3.8; supplies the evidence for 3.4/3.5. | A per-domain row for **every** vhost on both boxes, each reconciled against `webdev_sites`. Any vhost with no registry row is a finding, not a rounding error. |
| **R1 · Account facts** | Read the real entitlements off both Hostinger accounts (§3's "how we settle it" column). One throwaway static site and one throwaway PHP site deployed and torn down on each account. Credentials land in the vault via VLT-1/VLT-4 — **never** in this repo, never in a new laptop file. | Every row of §3 answered from hPanel or a live test, not from documentation. |
| **R2 · Staging cleanup** | §7. Inventory → owner rule → gated deletion. Runs in parallel with R1; blocks R3 only because slot count blocks R3. | Enough free slots on the staging account for the R3 wave, with the deletion log written. |
| **R3 · Prove the path** | Migrate **one internal site we own outright** (bucket "Ours" in the consolidation ledger — a `*.gaiada*.online` scaffold, no client, no consent gate) end to end: export → upload → DNS → verify → keep the old vhost up for rollback. Do it for staging and for production separately. | The internal site serves correctly from Hostinger, and the documented rollback has been *executed once* and re-cut forward. A rollback nobody has run is not a rollback. |
| **R4 · ERP change surface** | The code and schema work in §6. Deliberately **after** R1: the deploy transport cannot be written before we know whether the account has shell access. | The registry can express the new topology; deploy tooling either works against Hostinger or fails closed with an accurate message. |
| **R5 · Client waves** | Migrate in waves ordered by risk, easiest first: (a) static, ours-managed, no client-visible URL change; (b) WordPress, ours-managed; (c) PHP-with-MySQL; (d) everything gated on OQ-3.4/3.5, one owner decision per site. Each wave: notify → migrate → verify → hold both live → cut DNS → hold the old vhost 14 days → only then remove. | Per wave: every domain answers 200 from the new host with correct TLS, and the old vhost is still serving. |
| **R6 · Decommission** | Only when R5 is complete and the 14-day hold has expired on the last wave: final backup of both boxes retained off-box, then cancel. Retire the observe-only tier (§8). | A restorable backup exists somewhere that is **not** `delphi`, `helios`, or the only copy on `sumopod`. |

**R0 and R1 can start today. Nothing from R2 onward should start before OQ-3.1 and OQ-3.6 are
answered** — one sets the deadline, the other authorises deletion.

---

## 6 · ERP change surface

Everything below currently encodes `delphi`/`helios` as first-class nouns. This is the "this will
also affect the ERP too" the owner named, enumerated.

| # | Ticket | Where | What changes |
|---|---|---|---|
| **HSR-1** | Account capability survey | — | R1's output. Not code; it is the input every other ticket needs. |
| **HSR-2** | Datastore dependency audit | R0 worklist | Which live sites touch Postgres / Redis / MinIO / Memcached / Varnish on either box. Feeds OQ-3.4. |
| **HSR-3** | Preview-slot decision | `webdev_sites.environment` | If OQ-3.3 retires ephemeral preview, the `'preview'` CHECK value **stays** (it is a valid concept, and dropping a CHECK value is exactly the DROP+ADD hazard this estate has a production incident about) — but the ~11 `delphi` preview rows are soft-deleted with a `notes` marker, not hard-deleted. |
| **HSR-4** | `control_panel` cannot say **hPanel** | `search_properties.control_panel` CHECK `('cpanel','plesk','directadmin','none','other')` (`202608300818`) | hPanel is not cPanel. Today every Hostinger row would have to record `'other'`, erasing the distinction the column exists to make. **Additive** widening migration adding `'hpanel'` — a new migration, never an edit to the applied one, and never a DROP+ADD on the shared CHECK. |
| **HSR-5** | Deploy transport is no longer `ssh + rsync` | `webdesk/deploy/src/config.ts`, `ssh-rsync-driver.ts`, their tests | `PREFIX = { staging: "DELPHI", production: "HELIOS" }` and `ALIAS = { staging: "delphi", production: "helios" }` are hardcoded host identities. Replace with target-neutral config (`WEBDESK_DEPLOY_<TARGET>_*`) and a driver selected by transport kind. If R1 finds no usable shell, `ssh-rsync-driver` becomes **inapplicable to delivery** and an SFTP/FTPS driver replaces it — keeping the existing fail-closed doctrine (`MissingHostConfig`), never a guessed default. |
| **HSR-6** | Release transport seam text | `webdesk/api/src/control/release/release-transport.ts`, `not-yet-available-release-transport.ts` | Both name "the delphi/helios/Hostinger adapters" in the interface docs and in the operator-visible `TransportNotAvailableError` message. The seam is right; the nouns are wrong. The message must not tell an operator to configure a host that no longer exists. |
| **HSR-7** | MCP reachability tool | `mcp-hub/src/webdesk-deploy-tools.ts`, `mcp-hub/src/config.ts` | The probe tool's description and target enum name `delphi (staging)` / `helios (production)`. Re-point at the two Hostinger targets, or fail closed if shared hosting gives no probe surface beyond HTTP. |
| **HSR-8** | Registry re-classification | `webdev_sites` rows; `scripts/registry-fix-hostref-helios-2026-09-04.local.sql` is the precedent | Per migrated row: `host_kind` `'our-box'` → `'shared-hosting'`; `host_ref` `'helios'`/`'delphi'` → the new account identifiers; `access` re-derived from what the account actually grants (`'ssh'` → likely `'ftp'` or `'cpanel'`). **Row-by-row as each site actually moves**, never one bulk UPDATE ahead of the move — the registry must describe reality, not intent. |
| **HSR-9** | Ledger target-state policy re-derivation | `docs/plans/2026-09-04-site-consolidation-ledger.md` | Its policy says adoption for `delphi`/`helios` sites is "a re-point, not a rebuild." Under D37 that holds only for static sites. Add a blocker `runtime_incompatible` (owner: **Owner**), ranked between `consent_not_recorded` and `no_vault_credential`, for rows that cannot run on shared hosting at all. |
| **HSR-10** | Vault entries for two shared accounts | VLT-1/VLT-4 in `2026-09-04-client-hosting-credential-vault.md` | `integration_connections.provider` widening must cover Hostinger hPanel/FTP credential kinds. `CREDENTIALS.local.md` gains nothing new — the import path is VLT-4, not another line in a laptop file. |
| **HSR-11** | Decision log + zoning text | `docs/blueprints/webdesk-design-v2.md` §03, §07, §12 P6, §14 | Land WSK-D37 (§1). Rewrite §12 P6's gate. Update the §03 zoning table's delivery row. **This is step 0 of the whole effort** — D32 sat unrecorded for four days and this program has already produced that exact drift twice. |
| **HSR-12** | UI fixtures and portfolio helpers | `platform-ui/src/lib/webdeskPortfolio.ts` + `.test.ts`, `demoFixtures.ts` | Hardcoded host names in fixtures will render a retired host in a live console. |
| **HSR-13** | Persona / seat text | `persona/dept-pm/boundaries.md`, `platform-nest/src/seed/agent-seats.ts` | Agent-facing text naming the retired hosts as delivery targets teaches agents a false estate. |
| **HSR-14** | Risk policy rows | `platform-nest/migrations/202608221746_risk_policy_and_host_risk.sql` | Host-risk entries for both boxes. Retire with the hosts, at R6 — not before, or the risk record is lost while the boxes are still live. |

**Sequencing:** HSR-11 first (record the ruling), HSR-1/2 next (find out what is true), then
everything else. HSR-8 runs continuously through R5, one row per actual move.

---

## 7 · The staging cleanup — an inventory, then a gate, then deletions

The owner's phrasing was *"the team need to delete some unused in shared staging."* That is a
destructive, irreversible operation on an account that also carries **live client WordPress**. This
plan will not hand anyone a delete list it cannot justify.

**Protocol, in order — no step may be skipped:**

1. **Inventory.** Every site on the staging account: domain, disk, last-modified of the newest file
   in the document root, last DB write if it has a DB, whether it resolves in DNS, whether it has a
   `webdev_sites` row, and which client it belongs to. Output is gitignored (`*.local.md`) — this is
   a client inventory and this repo is public.
2. **Classify, do not decide.** Each site gets exactly one proposed disposition: `keep`,
   `archive-then-delete`, `delete`, `unknown`. **`unknown` is a valid and expected answer** and never
   silently becomes `delete`.
3. **Owner sets the rule (OQ-3.6).** A stated retention rule — e.g. "no file change and no DNS record
   for 180 days, and no `webdev_sites` row above `tracked`" — applied uniformly. Without a written
   rule the classification is one person's judgment about another company's website.
4. **Client-owned sites are never in scope.** Anything whose bucket is *Client-owned, not managed by
   us*, or whose `client_id` is NULL and whose domain is not internal, is excluded regardless of how
   dormant it looks. The consolidation ledger's `pending_client_assignment` state exists for exactly
   this and blocks deletion.
5. **Archive before delete, always.** Full document root + DB dump, retained off-account for a stated
   period, restore tested on **one** archive before the first deletion. An archive nobody has restored
   is not a backup.
6. **Delete in small batches, log every one.** Domain, size, archive location, who approved, when.
   Hold 14 days between the first batch and the rest.

**Expected finding worth pre-empting:** the ~11 ephemeral `delphi` preview slots and the blank
colour-animal auto-scaffolds (bucket "Ours" in the ledger) are almost certainly the bulk of the
reclaimable space, and they need **no client consent at all**. Sweeping those first may free enough
slots that no client-adjacent deletion is needed — the best possible outcome of this section. **Do
that sweep first and re-measure before proposing anything else for deletion.**

---

## 8 · Observability

`2026-08-31-helios-delphi-plane-a-rollout.md` built a blackbox tier for these two hosts, and its own
§4 records that it was **never applied** — `targets/blackbox-estate.json` still ships `[]` because
OQ-6 (owner-named endpoints) was never answered. That is convenient timing: there is no live
monitoring to unwind, only authored config.

- **Do not apply that rollout's estate half.** Populating `blackbox-estate.json` with `helios`/
  `delphi` now would build monitoring for hosts scheduled to disappear.
- **Do apply its client half if it is still wanted.** `client-properties` (MON-01) monitors client
  *sites*, wherever they are hosted; it is unaffected by which host serves them, and the
  `account-managers` receiver split is orthogonal to this replatform.
- **`EstateProbeDown`'s `env=production`(helios)/`env=staging`(delphi) labelling becomes wrong**, not
  merely stale — under D37 those labels belong to two Hostinger accounts. Rewrite when R5 begins, not
  before.
- **`infra/runbooks/onboard-server.md` §0** carries both hosts as hard never-touch entries. They stay
  never-touch through R5 (they serve live client sites the whole time); the entries are removed at
  R6, with the removal noted rather than silently dropped.
- **The dead-man's-switch work in that rollout's §2.3 is independent** of this replatform and should
  not be held hostage to it.

---

## 9 · What this plan deliberately does not do

- **Nothing was executed.** No SSH session, no hPanel login, no probe, no migration, no deletion, no
  DNS change. Every number in §2 is quoted from a dated prior survey and explicitly marked as needing
  re-verification.
- **No Hostinger entitlement is asserted as fact.** §3 is a table of claims, each paired with the
  check that settles it, because a plan built on an assumed feature matrix fails at the first client
  cutover.
- **No site is classified for deletion.** §7 produces an inventory and stops at an owner gate.
- **WSK-D37 is proposed, not landed.** §1 is draft ruling text; HSR-11 is the ticket that lands it in
  §14. Until then the design doc still says `delphi`/`helios`, and it is correct that it does.
- **No Linear tickets were filed.** HSR-1..14 are a proposed set; filing them into team GDA is a
  separate, explicit action.

---

## 10 · Re-survey, 2026-09-05 — actual state

Read-only survey run 2026-09-05 against `helios`, `delphi`, `kvm8`/`srv599617` and the live
`gaiada_platform` registry on `gda-aicenter`. Direct SSH to the Hostinger boxes is edge-blocked from
the office IP; the documented `gda-ce01` jump path (`helios-j` / `delphi-j`) was used. **Nothing was
modified on any host and no row was written.**

### 10.1 Migration progress: zero

**No site has moved.** All 9 `helios` rows still read `host_kind='our-box'`, `host_ref='helios'`,
`adoption='tracked'`. Both boxes are up (`helios` 47d, `delphi` 39d) and serving. This is expected —
the plan was authored yesterday and OQ-3.1/OQ-3.6 are still unanswered — but it means the honest
status is **pre-R0**, not "in progress".

### 10.2 `helios` — 9 client sites, and only 2 are hard

387G disk, **42% used, 227G free.** 12 nginx vhosts → 9 real client sites.

| Site | Stack | Size | Moves to shared? |
|---|---|---|---|
| `viceroybali.com` | WordPress | 16G | yes |
| `aperitif.com` | WordPress | 12G | yes |
| `cascadesbali.com` | WordPress | 4.3G | yes |
| `pinstripebar.com` | WordPress | 4.3G | yes |
| `akoyaspabali.com` | WordPress | 1.6G | yes |
| `hubblebali.com` | WordPress | 854M | yes |
| `balispaguide.com` | PHP (non-WP) | 2.5G | probably |
| `essentialbali.com` | **Node, `pm2-uessentialbali`** | 3.5G | **NO** |
| `freetaxreturns.com.au` | **Node, `pm2-ufreetax`** (`next-server` :4010) | 548M | **NO** |

**The whole `helios` migration is 7 lift-and-shifts and 2 decisions.** That is a far smaller problem
than §2 implied. The two `pm2` apps are OQ-3.4 made concrete: shared hosting cannot run `pm2` or
`next-server`, so each needs rebuild-as-static, retire, or a named exception — 2 owner decisions,
not a programme.

**Sizes are the real cost.** ~45G of WordPress, with two sites over 10G each. Any migration window
has to be sized against that, and a 16G site is not a lunchtime job.

### 10.3 `delphi` — the actual problem, and it is not PHP

96G disk, **88% used, 13G free.** 24 vhosts. **Zero per-site PHP-FPM pools — nothing on `delphi` is
a PHP site.** What it actually runs: five `next-server` processes (:3014, :3015, :3021, :3201,
:3223), four other `node` listeners (:3100, :3200, :3202, :3222, :8090), PostgreSQL (342M in use),
MinIO, Redis, Varnish, and a `pilot-fullstack-cms-webhook.service`.

Named (non-preview) vhosts: `pilot-fullstack-cms{,-api,-admin}.gaiada.online`,
`bookingviceroy.gaiada.online`, `kalmra.gaiada.online`, plus an `aivoicesync` home directory.
The remaining **17 are `NN-xxxxx.gaiada.com` ephemeral preview slots.**

Two findings that change the plan:

- **`delphi` is a Node/Next runtime host. It has no shared-hosting equivalent.** For `helios` the
  question was "which sites are the exception"; for `delphi` the runtime *is* the host's purpose.
  "Move staging to shared hosting" cannot mean "move `delphi`'s workload to shared hosting" — those
  workloads have to be rebuilt, retired, or rehomed to a box that runs Node. **This is the single
  biggest gap between the ruling as stated and the estate as it exists.**
- **Disk is the live pressure, and it is one directory.** `/home/u19kobpm` is **34G of the 84G
  used** — one preview slot is 40% of the box. The next four (`u25qjdoc` 6.5G, `u14gmkqn` 5.0G,
  `u21mtqvb` 3.8G, `u13ezgmo` 1.8G) add ~17G. At 88% full, `delphi` has a capacity problem *today*,
  independent of the replatform.

### 10.4 `delphi` is invisible to the ERP

**24 vhosts on the box; zero rows in `webdev_sites` with `host_ref='delphi'`.** Not one preview
slot, not the pilot CMS, not `kalmra`, not `bookingviceroy`. The registry has 81 live rows and
records `helios` accurately — `delphi` was simply never surveyed into it.

This voids the §7 protocol as written for anything on `delphi`: step 1 reconciles each site against
its registry row, and there are none to reconcile against. **R0 must survey `delphi` into the
registry before any deletion decision is made about it.**

### 10.5 A third delivery host the ruling does not mention: `gda-ce01`

The registry carries **10 rows on `host_ref='gda-ce01'`, 8 of them `environment='production'`** —
`blossomsteakhouse.com`, `huntermotorcycles.co.id`, `isort.id`, `ypi-asia.com` (all WP),
`blossomcatering.online` (fullstack), plus `dmsviceroy`/`schoolcatering`/`bsc` on `gaiada*.online`.

`gda-ce01` is the GCE box the SSH config describes as the *durable operator lifeline* — the jump
host that stays reachable when Hostinger edge-blocks the office IP. **It is also carrying live
production client sites.** WSK-D37 as drafted retires `delphi`/`helios` and says nothing about this,
so retiring those two would leave client production on an unnamed third host — and one whose stated
job is emergency access. **New open question, OQ-3.9 (§10.7).**

### 10.6 The target accounts are not what the plan assumed

- **The shared staging account already exists and is already populated.** `host_ref =
  'hstgr-shared-gda-staging'` holds **49 rows** — 34 `*.hostingersite.com` auto-URLs and 15 real
  domains. This is the account the owner means, and the cleanup target. It is *not* empty and *not*
  new.
- **`kvm8`/`srv599617` is a cPanel/WHM VPS, not shared hosting.** 5 WHM accounts, 2 live domains
  (`interlacenetwork.com`, `cosmedic.bimcbali.com`), 399G disk at 37%. It also carries **email** —
  `mail.`, `webmail.`, `autodiscover.`, `autoconfig.` vhosts for both domains. The registry
  nonetheless files its 2 rows under `host_kind='shared-hosting'`, which is wrong. **OQ-3.2 needs a
  sharper answer than yesterday's:** if "the shared hosting the WordPress use" means *this* box, it
  is a VPS and the plan's whole capability delta (§3) does not apply to it. If it means the
  `hstgr-shared-gda-staging` account, then `kvm8` is a fourth host with no place in the ruling.
- **Liveness of the 49 staging sites could not be settled from outside — do not treat the probe as a
  delete signal.** Probing from `gda-ce01` (HTTP/1.1, browser UA, follow redirects): 15 answer 200,
  1 answers 403, and 33 fail to connect. But DNS resolves for all of them (Hostinger's
  `free.cdn.hstgr.net`), the failures are a uniform `HTTP/2 stream not closed cleanly:
  PROTOCOL_ERROR` / connect failure **at the CDN edge**, and three `*.hostingersite.com` URLs answer
  fine while thirty-one identical-shaped ones do not. A uniform edge-level failure across a whole
  URL class is an **account or CDN state**, not 31 independently dead websites. **hPanel settles
  this; curl does not.** Reporting those 31 as "unused" would have been the exact error §7 step 2
  exists to prevent.

### 10.7 What the re-survey changes

| Was | Now |
|---|---|
| §2: "PHP pools down to 7.1 — the largest unknown" | **Retracted.** Per-site pools are PHP 8.3/8.4 only. **OQ-3.5 closes as a non-issue** pending per-site version confirmation in hPanel. |
| §2: "~23 live sites on helios, ~11 previews on delphi" | 9 sites on `helios`; **17** previews + ~6 named apps on `delphi`. |
| §3/OQ-3.4: "some sites may not run on shared" | Named and counted: **`essentialbali.com` and `freetaxreturns.com.au` on `helios`** (2 decisions), and **effectively all of `delphi`** (a Node host with no shared equivalent). |
| §7: inventory reconciles each site to its registry row | Works for the staging account; **impossible for `delphi`**, which has no rows at all. |
| Delivery estate = `helios` + `delphi` + Hostinger | **Five hosts**: `helios`, `delphi`, `gda-ce01` (8 production rows), `kvm8` cPanel VPS, and the `hstgr-shared-gda-staging` account. |

**New open questions:**

- **OQ-3.9 — What happens to the 8 production client sites on `gda-ce01`?** Retiring `helios`/
  `delphi` while leaving client production on the emergency-access jump host is not a coherent end
  state. Either it is named as a delivery host in D37, or its sites migrate too. *Default if
  unanswered: it is in scope and its rows migrate with the rest.*
- **OQ-3.10 — `delphi`'s Node workloads (pilot CMS, `bookingviceroy`, `kalmra`, `aivoicesync`):
  rebuild, retire, or rehome?** They cannot go to shared hosting in any form. *Default: R0 surveys
  them into the registry and each gets an individual owner decision — nothing is assumed retirable
  because it is unregistered.*
- **OQ-3.11 — `delphi` is at 88% disk with one preview slot holding 34G. Is that urgent on its own?**
  This is a today problem, not a migration problem. *Default: treat as a separate capacity ticket,
  not folded into the replatform.*

### 10.8 Recommended next actions

1. **Survey `delphi` into the registry** (R0, `delphi` half). It is the only host in the estate with
   live vhosts and no ERP record, and nothing else about it can be decided first.
2. **Get hPanel read access to `hstgr-shared-gda-staging`** and settle §10.6's 33 unreachable URLs
   from the account, not from outside. This is also HSR-1's plan-entitlement survey — same login.
3. **Put OQ-3.9 (`gda-ce01`) to the owner** before D37 is landed, so the ruling names the real
   delivery estate the first time rather than being amended later.
4. **Two named decisions on `helios`** — `essentialbali.com` and `freetaxreturns.com.au`. Everything
   else on that box is a straightforward WordPress/PHP move whenever the owner sets a date.
5. **Do not touch `delphi`'s 34G slot** without step 1. It is the obvious win and the least
   documented object on the estate.

---

## 11 · Does Hostinger shared's "web app" replace `delphi`'s Node stack? (2026-09-05)

Owner question. Two separate answers, because it is two questions.

### 11.1 The feature itself is UNVERIFIED — and must not be assumed either way

Nobody in this estate has hPanel access to `hstgr-shared-gda-staging` recorded anywhere: the vault
(`integration_connections`) holds **three** providers today — `github` (3), `claude` (1),
`google_drive` (1) — and **no hosting credential of any kind**. `CREDENTIALS.local.md` has no
Hostinger shared entry. `scripts/vault-import-hosting-credentials.local.mjs` (VLT-4) exists but is
delivered **unrun**.

So the honest answer to "does the web-app feature do what `delphi` does" is: **we cannot say from
here, and neither can documentation.** Hostinger's plan entitlements change, and a shared-tier app
runtime is usually *not* a general Node host — the usual shape is a request-triggered, memory-
capped, restart-between-requests runtime with no arbitrary listening ports and no background
workers. Whether that is what Agency Startup offers is a **one-login question**, and it is already
HSR-1. **Do not promise a client a Node app on shared hosting before that login happens.**

### 11.2 The better news: `delphi` needs far less Node than §10.3 implied

§10.3 said "effectively all of `delphi`" was runtime-bound. **That was too pessimistic — corrected
here by a per-docroot survey.** Of the 20 `u*` slots:

| Classification | Count | Notes |
|---|---|---|
| **STATIC** (`index.html`, no `package.json`) | **11** | move to shared hosting trivially, or delete |
| **NO DOCROOT** (empty home) | **4** | `u20liwrt`, `u22ojgzp`, `u24pyevq`, `u26qxhon` — nothing to migrate at all |
| **OTHER** | 3 | `u21mtqvb`, `u21nakzq`, `u23pmzha` — need a look |
| **NODE** | **1** | `u19kobpm` — and it is the **34G** slot |

The named apps are mostly static too: `kalmra` **STATIC** (471M), `pilotfeonl` (the pilot CMS
front end) **STATIC** (161M). `bookingviceroy.gaiada.online` is served out of the `25-qjdoc` vhost,
whose docroot is **STATIC**. Only `pilotapionl` (502M) and `pilotcmsonl` (1.6G) — the pilot CMS API
and admin — plus `u19kobpm` look genuinely runtime-bound.

**Revised read: `delphi`'s real Node surface is roughly three things, not twenty-four.** Most of the
box is static output from builds that happen elsewhere, which is exactly what shared hosting serves
well. The five `next-server` processes are concentrated in that small named set, not spread across
the previews.

### 11.3 Even a working "web app" feature is not equivalent — the datastores are the gap

Node support alone would not make `delphi`'s workload portable, because `delphi` also provides
**PostgreSQL (342M in use), MinIO, Redis and Varnish**. Hostinger shared gives **MySQL/MariaDB and
nothing else**. An app that persists to Postgres or stores objects in MinIO does not become portable
because a Node runtime appeared — it needs its datastore rehomed too. That is a bigger question
than the runtime and it applies to `pilotapionl`/`pilotcmsonl` specifically.

### 11.4 The test that settles it — one login, one throwaway app

Run this on the Agency Startup account before any client is promised anything:

1. Does the plan expose a Node/"web app" runtime **at all**, and at which Node version?
2. Does it keep a process **alive between requests**, or start one per request? (Decides whether an
   API can hold connections, run a queue, or serve WebSockets.)
3. Can it **listen on a port** nginx/the panel proxies to, or is it passenger-style only?
4. Is there any **background worker / long-running process** allowance? (`pilot-fullstack-cms-webhook.service`
   is exactly this shape on `delphi`.)
5. **Memory ceiling** per app — a Next.js server is not small.
6. **PostgreSQL: yes or no.** If no, `pilotapionl`/`pilotcmsonl` need a rehome or a rewrite to MySQL
   regardless of what the runtime supports.

Deploy one throwaway Next.js app and one throwaway static site, confirm both, tear them down. That
single exercise answers §3's whole capability table, HSR-1, and this section together.

### 11.5 What this changes in the plan

- **§10.3's "effectively all of `delphi`" is retracted** — replaced by 11.2. The `delphi` migration
  is mostly static files plus **~3 runtime decisions**, not a wholesale rebuild.
- **OQ-3.10 narrows** to: `pilotapionl`, `pilotcmsonl`, `u19kobpm`, and the 3 `OTHER` slots. The 4
  empty homes need no decision at all, and the 11 static slots are ordinary migrations or deletions.
- **The `delphi` disk problem stays exactly what §10.3 said it was:** one Node slot holding 34G on a
  box that is 88% full.
