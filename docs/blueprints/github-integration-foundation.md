# GitHub Integration — Foundation Blueprint

> **Status:** `PLANNED` — design/direction only, no code. Supersedes two rulings that named a
> decommissioned host (§0). Feeds `/army` tickets (§7).
> **Date:** 2026-08-31 · **Owner conversation:** web@gaiada.com
>
> **📌 DECISIONS (2026-08-31, owner) — these gate implementation:**
> 1. **One GitHub identity for the ERP.** `web@gaiada.com` is the org's primary human account;
>    all ERP→GitHub traffic rides a single org-owned machine identity, not per-user seats. Seat
>    billing is the driver. Per-user accountability moves into the ERP ledger.
> 2. **`gaiadabali` replaces `Gaia-Digital-Agency`.** One org, migration not coexistence.
> 3. **The ERP gets full GitHub capability**, not read-only. This reverses the WS11 ruling that
>    disabled `github.createRepo` in favour of a manual PM step (§0.2).
> 4. **All ERP GitHub usage is monitored in the ERP.** The ledger is the system of record for
>    who did what, because GitHub will no longer hold it.
> 5. **Build order:** GitHub first (this doc), then the aicenter consolidation, then observability
>    on helios/delphi. Those two run as separate workstreams.

---

## §0 · What this supersedes

Two written rulings are stale. Both named **gda-s01**, which is decommissioned.

### 0.1 — The Zone A credential boundary

[`provision-erp-seam-design.md:285`](./provision-erp-seam-design.md) rules that the repo-admin PAT
lives in the provision `.env` on gda-s01 only — *"never in Zone A, never in the ERP env, never in a
hub tool arg, never logged."*

That ruling protected a real property: **the credential that can rewrite every client repo should
not sit in the same blast radius as the ERP.** The host it named is gone, and decision 3 above puts
the ERP squarely in the write path.

**This document does not discard the property — it re-implements it as scope rather than distance**
(§2). Where the old design separated by machine, this one separates by installation scope and by
which service may mint a token at all. That is weaker than a separate host, and it is stated as a
known reduction rather than glossed.

### 0.2 — The manual-repo-creation ruling

[`delivery-tools.ts:92-103`](../../mcp-hub/src/delivery-tools.ts) disables `github.createRepo` with
*"repo creation is a manual PM step (WS11)."* Decision 3 reverses it. Recorded here as a deliberate
reversal so it does not read as drift.

**What the old ruling was protecting** was that repo creation is an external, not-trivially-
reversible act with no approval gate. That concern is answered by routing creation through **D14
approval** (§4.2), not by keeping the tool disabled.

---

## §1 · The decision, and what it actually costs

The ERP acts on GitHub as one identity. Every push, PR, merge, and repo creation carries the same
GitHub actor regardless of which staff member triggered it.

**The stated downside — "GitHub records show only one account" — is smaller than it looks for
commits and larger than it looks for API actions.**

- **Commits keep real attribution.** Git's `author` field is a free string. The ERP sets
  `author = "Real Name <person@gaiada.com>"` and `committer = gaiada-erp[bot]`. Blame, `git log`,
  and history show the actual person. GitHub only fails to *link a profile* when the email matches
  no account — the name and email still appear.
- **API actions genuinely collapse.** PR opens, reviews, merges, issue comments, and label changes
  all read as the bot. Nothing recovers this on the GitHub side.

**The consequence that matters:** the ERP ledger stops being a convenience and becomes the only
record. Everything in §4 follows from that.

---

## §2 · Credential topology — two Apps and a break-glass PAT

### 2.1 — GitHub App, not a PAT

Decided on one argument above the rest: **a PAT on `web@gaiada.com` cannot be distinguished from a
human using that account.** The ERP ledger would claim to be the complete record of GitHub activity
while being structurally unable to see anything done out-of-band, and unable to tell the two apart
afterward. An unfalsifiable audit trail is not an audit trail.

A GitHub App acts as `gaiada-erp[bot]`, an identity no human can log into. Anything in the org
authored by the bot *must* have come through the ERP; anything authored by `web@` is by construction
out-of-band. That makes ledger completeness **checkable** (§4.6).

Secondary reasons, all pointing the same way:

| | PAT on `web@` | GitHub App |
|---|---|---|
| Separable from human use | **No** | Yes |
| Credential at rest | Long-lived token | Private key → 1-hour installation tokens |
| Rate limit | 5,000/hr for the whole user | Per-installation, scales with org size |
| Revocation | All-or-nothing, manual rotation | Per-installation; rotate the key |
| Scope | Bound to the user's access | Per-repo, per-permission, enforced org-side |
| Org audit log | Shows `web@` | Shows the App by name |
| Seats consumed | 1 (already paid as owner) | 0 |
| Survives account recovery / 2FA loss | No | Yes |

### 2.2 — The two Apps

**`gaiada-erp`** — held by `platform-nest` on gda-aicenter. The ERP's hands.

| Scope | Permission |
|---|---|
| Repository | Administration `write` · Contents `write` · Metadata `read` · Pull requests `write` · Issues `write` · Actions `write` · Workflows `write` · Commit statuses `read` · Deployments `write` · Environments `write` · Webhooks `write` |
| Organization | Members `read` |
| Events | `push` · `pull_request` · `workflow_run` · `check_suite` · `repository` · `release` · `deployment_status` |

**`gaiada-agents`** — held by `mcp-hub`. **Read-only, no write permission anywhere.**

| Scope | Permission |
|---|---|
| Repository | Contents `read` · Metadata `read` · Pull requests `read` · Actions `read` · Commit statuses `read` |

The reason this is a separate App rather than a scope of the first: **mcp-hub is the agent-facing
tool surface, and agents are prompt-injectable.** If the hub can write, a poisoned input becomes a
repo write. Read-only there also keeps the ledger complete — a hub that can write directly creates a
path the ERP audit trail never sees. All writes route through `platform-nest`.

**`gaiadabali-deploy`** — **ALREADY EXISTS, discovered 2026-08-31. Not created by this design.**
Installed ~2026-08-19, all repositories, **read access to code and metadata only.** Its purpose is
the client-site deploy bridge, and understanding it matters because it explains why no repo carries
a helios/delphi credential:

> `gaiadabali/deploy-workflows` (public, `workflow_call`) is a central reusable workflow called by
> every project repo. It **builds and publishes a deploy artifact to branches**
> (`deploy/staging-*` → delphi, `deploy/production-*` → helios). The servers then **pull** those
> branches. CI never pushes to a server, so no server credential lives in any repo — and the App
> needs only *read*, across *all* repos, because it is what the servers authenticate with to fetch.

**This is a sound pattern and should be left alone.** It is read-only, so it **cannot** forge
bot-authored changes: the §4.6 completeness argument survives intact. Record it as a known third App
rather than folding it into `gaiada-erp` — separate credentials mean revoking the agents' access
cannot break client deploys, and vice versa. It overlaps `gaiada-agents` in scope; keep them
separate anyway, for exactly that independent-revocation reason.

⚠ **`gaiada-deploy` (a second, older App private key dated 2026-08-14) is still unaccounted for** —
most likely a pre-rename predecessor. Confirm whether the App still exists and delete it if not in
use; an orphaned App key is a credential nobody is watching.

### 2.2b — TWO PATs, not one (corrected 2026-08-31)

An earlier draft of this document had the break-glass PAT doing double duty as the credential for
the GH-15 org sweep. **That is a contradiction:** a token a server uses on a schedule is not
break-glass, it is a live super-credential inside the blast radius. Split them.

**`web@` break-glass PAT** — org owner, **classic** PAT.

| | |
|---|---|
| Scopes | `repo` · `workflow` · `admin:org` · `delete_repo` |
| Lives | **offline, human-only. Never in a service, env file, CI secret, or container.** |
| Purpose | org administration (members, billing, settings), recovering a broken App, deleting or transferring a repo — the things a GitHub App structurally cannot do |
| Expiry | **set one (1 year), do not choose "no expiration"** — see below |

**`gaiada-org-sweep` PAT — CONFIRMED WORKING with `read:org` ONLY. Measured 2026-08-31.**

| | |
|---|---|
| Scopes | **`read:org`** — verified via `X-OAuth-Scopes` response header, nothing else granted |
| Result | `GET /orgs/gaiadabali/installations` → **200**, all three installations listed |
| Lives | sealed in `integration_connections`, server-side |
| Purpose | enumerate installed Apps, members, outside collaborators — read, diff, alert |

> **Correction, recorded because the wrong version was briefly written into this document.** An
> earlier test concluded this endpoint *requires* `admin:org`, and the sweep token was dropped on
> that basis. **That conclusion was wrong.** The test ran under a `gh` CLI session authenticated as
> `hansel-gaiada`, an account that **belongs to no organizations** — so the 404 was "you cannot see
> this org at all", not "your scope is too narrow". `gh` appends *"This API operation needs the
> admin:org scope"* to any 404 on an org endpoint, and that hint was taken as authoritative.
>
> **The lesson is reusable:** GitHub masks org-level 403 as 404, so a 404 on an org endpoint is
> ambiguous between *insufficient scope* and *not a member*. Distinguish them by checking
> membership (`GET /user/orgs`) before concluding anything about scope.

So the split holds, and the least-privilege version of it is achievable: **the server-side token
needs `read:org` and nothing more.**

**Additionally — and independent of the token — a stronger upstream control already exists:**

> **The org already requires owner approval to install a GitHub App.** Members can only *request*
> one (the org's Installed GitHub Apps page shows a "Pending GitHub Apps installation requests"
> queue). A new App therefore cannot appear without an owner acting.

That is **prevention**, which beats detection: a new App cannot appear without an owner acting. Keep
it. The `read:org` sweep then covers the case prevention cannot — an *owner* installing something —
and it does so without any privileged credential on a server.

So GH-15 is: (1) keep the owner-approval restriction, (2) the scheduled `read:org` sweep.

⚠ **PAT Status (2026-08-31):** The two PATs described above (`web@` break-glass and
`gaiada-org-sweep`) were created, exposed in a chat transcript, and have been **REVOKED**. They must
be **RECREATED** before this design can proceed to GH-01/GH-15 implementation. Do not assume they
are currently in place.

**Baseline as measured 2026-08-31** (all three `repository_selection: all`):

| App | Installation ID | Access |
|---|---|---|
| `gaiada-erp` | `157879245` | write (14 scopes) |
| `gaiada-agents` | `157885994` | read (5 scopes) |
| `gaiadabali-deploy` | `155078042` | read (code + metadata) |

Org owner account: **`web-gaiada`** (= `web@gaiada.com`), confirmed holding `admin:org`.

**Why the break-glass PAT gets an expiry, despite the obvious objection.** A token that expires
might be expired when you need it. But GH-15 no longer depends on it, and an eternal unrotated
super-credential is the larger risk — that is the failure mode the estate's own rotate register
exists for. Put it on the register with the expiry date.

**Lockout insurance, independent of any token:** at least one human account besides the Apps must
hold org admin. A GitHub App cannot recover itself.

### 2.3 — Token flow

App ID + private key (PEM) are sealed via [`secret-box.ts`](../../platform-nest/src/core/secret-box.ts)
into `integration_connections` with `owner_kind='company'`, `provider='github'`. The existing
**token non-exposure rule holds unchanged** — `toConnectionResponse()` never surfaces ciphertext,
and the PEM is no different.

Runtime: sign a short JWT (RS256, ≤10 min) → `POST /app/installations/{id}/access_tokens` → 1-hour
installation token → cache in memory, refresh at T−5min. **The installation token is never
persisted and never leaves the process.**

> **GAPS CLOSED 2026-08-31.** GH-01 hit three things this section did not specify and correctly
> refused to decide silently. Rulings:
>
> **(a) Which column holds the PEM.** `integration_connections.access_token_enc`. A GitHub App's
> private key *is* its single long-lived credential — exactly the role that column already plays for
> every other provider. **No new schema.** `refresh_token_enc` stays unused here (there is nothing to
> refresh; the JWT is re-minted from the key each time).
>
> **(b) Two Apps in one table — RULING CORRECTED 2026-08-31, the first version did not compile.**
>
> The original ruling said "use a synthetic `owner_id` of `github-app:<slug>`". **That is not
> implementable.** GH-03/04 proved it live: `credential-store.test.ts` (8/8) and one of GH-06's DB
> tests fail with `invalid input syntax for type uuid: "github-app:gaiada-erp"`. Migration `0033`
> declares `owner_id uuid NOT NULL` — polymorphic and carrying no FK, but still a uuid — and
> `owner_kind text NOT NULL CHECK (owner_kind IN ('user','company'))`.
>
> So the problem is real (the `UNIQUE(tenant_id, owner_kind, owner_id, provider)` genuinely collides
> if both Apps use `owner_id = tenantId`) but the fix was wrong twice over: a string cannot go in
> that column, and neither existing `owner_kind` truthfully describes these rows.
>
> **Corrected ruling — an additive migration, not a smuggled value:**
> 1. Widen the CHECK to `owner_kind IN ('user','company','github_app')`.
> 2. For these rows: `owner_kind = 'github_app'`, and `owner_id` = a **deterministic UUIDv5 derived
>    from the App slug** (stable across environments, distinct per App, so UNIQUE is satisfied).
> 3. Put the human-readable slug in `meta.appSlug` for legibility.
>
> **Why not just put a synthetic uuid under `owner_kind='company'`:** migration `0033` documents
> `owner_kind='company' -> owner_id = the company's id`. Storing a value that is not a company id
> under that discriminator makes the row lie about its own meaning — the precise objection the
> `activities` attribution migration raises about audit columns ("a column with a foreign key cannot
> lie that way"). A new `owner_kind` costs one `ALTER ... CHECK` and keeps the discriminator honest.
>
> **✅ IMPLEMENTED AND VERIFIED 2026-08-31** —
> `platform-nest/migrations/202608311000_integration_connections_github_app_owner_kind.sql`
> (DDL-only, no backfill: existing rows are `user`/`company` and stay valid, `github_app` had no
> prior rows). `owner_id` is a deterministic UUIDv5 over the App slug with a fixed namespace
> constant. Verified against a real disposable Postgres: constraint confirmed live,
> `credential-store.test.ts` **0/8 → 8/8**, `github-repos-rls.test.ts` 17/17 (no regression),
> `integrations.test.ts` + `wsux12-security-gate.test.ts` + `github-app.service.test.ts` 43/43.
>
> **CORRECTION to this section's own claim.** It said `github_app` rows would be "list-only,
> token-masked" on the generic connections API. **They are less reachable than that:** the list
> endpoint's `owner=` selector recognises only `me | company | user:<id>` — there is no
> `github_app` branch — so these rows are unreachable through the generic HTTP API in **either**
> direction, and exist only via `credential-store.ts`'s direct service calls. More restrictive than
> claimed, not less, but the doc should not assert a reachability that does not exist.
>
> Write-path exclusion is enforced by a **new, separate** `CLIENT_CREATABLE_OWNER_KINDS =
> {'user','company'}`, distinct from the schema-valid `CONNECTION_OWNER_KINDS` — mirroring the
> existing `CLIENT_SETTABLE_STATUSES` idiom. The distinction is the point: **schema-valid is not the
> same as client-writable**, and collapsing the two is how a value becomes accidentally creatable
> through a UI. A client `POST /connections` naming `github_app` is rejected 400 before reaching
> `createConnection`. No RLS or GRANT change was needed.
>
> **(c) Which tenant holds an org-wide credential.** **The operating company that owns the GitHub
> org (Gaiada)** — the *same* ruling as §5.2's for `github_repos`, and for the same reason: the
> `gaiadabali` org is Gaiada's asset, so its credentials are Gaiada's regardless of which client's
> work passes through them. Two agents independently hit this question, which is a sign it belonged
> in the design from the start rather than in a follow-up.
>
> Every function still takes `tenantId` as a parameter rather than resolving a "home company"
> internally (matching `integrations.service.ts`'s convention) — the ruling says which value callers
> pass, not that the layer should guess.

---

## §3 · Org migration — `Gaia-Digital-Agency` → `gaiadabali`

> **✅ CLOSED 2026-08-31 — nothing to migrate. But NOT a rename; corrected below.**
>
> Owner confirmed `Gaia-Digital-Agency` is retired. Measured:
> `GET /orgs/Gaia-Digital-Agency` → **404**, and `gaiadabali` has **`created_at = 2026-08-16`**.
>
> **A GitHub org rename preserves `created_at`.** This one does not, so `gaiadabali` is a *new* org
> (created Aug 16, repos landed Aug 17) and the old org no longer resolves — it was replaced, not
> renamed. Nothing remains to migrate either way, so the conclusion holds. **But one consequence
> flips:**
>
> ⚠ **There is no rename redirect.** A stored URL naming `Gaia-Digital-Agency` will hard-404, not
> redirect. GH-11's `repo_url` rewrite is therefore **load-bearing, not hygiene** — any ERP row
> still holding an old-org URL is already broken. Raise its priority accordingly.
>
> *(If repos were re-created rather than transferred, issue/PR history from the old org is gone.
> Past the point of action, but worth knowing before anyone goes looking for it.)*
>
> **Two items close as verified-absent rather than pending:**
> - **P-3 (the fanned-out deploy key) is GONE.** Across all 221 repos: **zero deploy keys**, and
>   zero occurrences of `DEPLOY_SSH_PRIVATE_KEY_B64` / `GCP_SSH_PRIVATE_KEY`. The exposure the old
>   provision design logged and accepted no longer exists in this estate. Verified, not assumed.
> - **Only two Apps are installed** (owner-confirmed via the org's Installed GitHub Apps page):
>   `gaiada-erp` (write) and `gaiadabali-deploy` (read). No pending install requests. The §4.6
>   completeness argument holds today; GH-15 is what keeps it true tomorrow.
>
> ⚠ **`gaiada-deploy` is therefore an ORPHANED App key** — its private key sits in the owner's
> Downloads (dated 2026-08-14) but the App is not installed on the org. Delete the key.

> **MEASURED 2026-08-31 — the org is not greenfield; this section was drafted assuming it was.**
>
> A read-only crawl through the live `gaiada-erp` installation
> (`scripts/github-app/inventory-org.mjs`) found **221 repositories already in `gaiadabali`** —
> 113 archived (51%), 2 public, ~108 active. The bulk carry `pushed_at = 2026-08-17`, which reads
> as a mass transfer on that date. Corrections that follow from it:
>
> - **P-3 is NOT present in this org.** Zero repos carry `DEPLOY_SSH_PRIVATE_KEY_B64` or
>   `GCP_SSH_PRIVATE_KEY`, and **zero repos have any deploy key at all**. The fanned-out-key
>   exposure item 3 below is written against either the old org or a state that no longer exists.
>   Verify before spending work on it.
> - **Only 7 of 221 repos have any Actions secret; 214 are clean.** Almost nothing here is wired
>   for CI deploy, so "repoint every `deploy.yml`" is a far smaller job than assumed.
> - **No repository-level webhooks anywhere.** That rules out classic webhook integrations. It does
>   **not** rule out other GitHub Apps — Apps receive events through their own webhook, not per-repo
>   hooks — so the "is there a second writer" question still needs an org-owner look at
>   `/organizations/gaiadabali/settings/installations`.
> - **Q2 is partly answered.** The deploy targets actually in use are **client-side hosting** —
>   FTP, cPanel, GoDaddy SFTP — plus one repo (`baligirls-new`) deploying to **`gda-ce01`, which is
>   being decommissioned**. Nothing points at helios/delphi yet.
> - **`gaiadabali/deploy-workflows` is PUBLIC.** Plausible (reusable workflows must be reachable),
>   but confirm it carries no host paths or credentials, given the estate's repos are otherwise private.
> - **113 archived repos** means the registry (§5) needs archived as a first-class state, not a
>   footnote — half the rows will be archived, and they should not read as "stale sync".

Not a rename; a move with live consequences.

1. **Inventory first — now partly done.** `inventory-org.mjs` gives the `gaiadabali` side. What is
   still unknown is **what remains in `Gaia-Digital-Agency`**: that needs the owner PAT, since the
   ERP App is not installed there. Until that is enumerated, "the migration is done" is an
   assumption, not a fact.
2. **`repo_url` values are stored in the ERP.** The provision mirror holds
   `https://github.com/Gaia-Digital-Agency/<slug>`. GitHub redirects transferred repos, so nothing
   breaks immediately — but the stored values become lies. Rewrite them as part of the migration;
   do not rely on redirects.
3. **Kill the fanned-out deploy key.** The old provisioner wrote **one** SSH private key into
   **every** provisioned repo's Actions secrets (`DEPLOY_SSH_PRIVATE_KEY_B64`), so any provisioned
   repo's CI could SSH to the deploy host — logged as P-3 and accepted at the time. gda-s01 is gone,
   so those secrets are now stale *and* dangerous. **The migration is the moment to replace them
   with per-repo deploy keys.** Carrying P-3 into `gaiadabali` would be a choice, not an inheritance.
4. **Confirm where client-site deploys now point.** Under the new zoning, client production is
   `helios`, staging is `delphi`, WordPress its own host. Every migrated repo's `deploy.yml` targets
   a host that may no longer exist.
5. **Billing.** The old org billed to a different account. Consolidating orgs consolidates billing;
   verify that is intended before transfer, not after.

---

## §4 · What the ERP must own

Each item below exists because a GitHub-side control stopped working when the identity collapsed.

### 4.1 — Single chokepoint
One `github` provider service in `platform-nest`. No other service mints or holds an installation
token. No code path returns a token to a caller. mcp-hub gets the read-only App and nothing else.

### 4.2 — Authorization before every call
GitHub can no longer tell users apart, so **Cerbos is the only thing standing between a staff member
and the org.** Every operation is gated per action and per repo: push, merge, deploy, secret-write,
create-repo, delete-repo. Destructive operations (create-repo, delete-repo) and high-impact writes
(deploy, secret-write) route through **D14 approval** — which is what answers the WS11 concern that
§0.2 reversed.

### 4.3 — The ledger
Every GitHub call writes an [`activities`](../../platform-nest/migrations/202608261100_activity_approval_attribution.sql)
row: `actor_id` (the human), `metadata.via` (the agent, if any), `approved_by` + `approval_channel`
(if D14 gated it), `executed_by` (the seat), plus repo, action, ref, resulting SHA, and outcome.

The row is written **before** the call, so a crashed or failed call still leaves a record of the
attempt. Append-only. **Retention must meet or exceed the repo history it describes** — this ledger
is now the only place the mapping exists.

> **CLARIFIED 2026-08-31 — TWO rows, not one.** "Write before the call" and "append-only" together
> were underspecified: with no UPDATE path on `activities` (there is none anywhere in the codebase),
> a single row cannot record both the attempt and its outcome. GH-04 resolved it as an **`attempted`
> row before the call and a `succeeded`/`failed` row after, joined by correlation id** — and the
> correlation id is the `attempted` row's own `activities.id`, which is exactly what §4.4's
> `Gaiada-Activity:` trailer carries. No second identifier is minted.
>
> This shape is what makes §4.6 mechanisable: an `attempted` row with no resolution row past a grace
> window is a call that vanished — the process died, or the write happened and was never recorded.
> Both need looking at, and neither is visible in a one-row design.

### 4.4 — Commit attribution

```
author    = "Real Name <person@gaiada.com>"        # the staff member
committer = "gaiada-erp[bot] <...@users.noreply.github.com>"
trailer   = Gaiada-Actor: <erp_user_id>
            Gaiada-Activity: <activities.id>
```

The trailer is the correlation handle §4.5 depends on. PR bodies carry the same activity id.

> ⚠ **MEASURED TRAP (2026-08-31).** The Q1 probe wrote a file through the Contents API without
> passing an author, and the resulting commit came back:
>
> ```
> author = gaiada-erp[bot]      committer = GitHub
> ```
>
> **The default silently collapses attribution to the bot.** `author` / `committer` are optional
> fields on the Contents and Git Data APIs — omit them and you get the failure this whole design
> exists to prevent, with nothing erroring. GH-10 must pass `author` explicitly on **every** write
> path, and QA must assert the real human appears in `git log`, not merely that the call returned
> 2xx. This is the estate's familiar shape: the dangerous default is the one that looks like it
> worked.

### 4.5 — Webhook reverse-mapping
Inbound events all say `gaiada-erp[bot]`. The receiver resolves the real actor by correlating
SHA / PR number / delivery id back to the `activities` row written at request time.

**When correlation fails, record it as unattributed** — `actor_external='gaiada-erp[bot]'`,
`actor_user_id=NULL`, flagged. Do not silently credit the bot. An unattributed bot action is either
an out-of-band change or a ledger gap, and both are things you want to see.
[`work_activity`](../../platform-nest/src/core/work-activity-ingest.service.ts) already carries both
columns for exactly this shape.

### 4.6 — Ledger completeness is checkable, so check it
A reconcile sweep compares GitHub events authored by `gaiada-erp[bot]` against `activities` rows.
**Any bot action with no ledger row is an alert.** This is the control that makes the audit story
falsifiable rather than merely asserted, and it is the whole reason §2.1 chose an App.

### 4.7 — Rate limiting is now a shared bucket
One installation bucket for the entire company. One user's bulk operation starves everyone else.
Requires a queue with per-user fairness and backoff — not naive retry. Surface remaining quota on
`/admin/info` so exhaustion is diagnosable rather than mysterious.

### 4.8 — Reviewer distinctness
GitHub's *"require review from someone other than the author"* becomes meaningless when the bot
authors everything. **The ERP must enforce reviewer ≠ requester itself**, or four-eyes is silently
lost while branch protection still displays green.

### 4.9 — Secret hygiene

> **CORRECTED 2026-08-31 — the original text pointed at the wrong tests.** It named
> `modules/webdev/egress-inventory.test.ts` and `provisioning-idempotency.test.ts` as the files to
> extend. GH-01 checked them: both assert on the **old provisioning seam's** fanned-out SSH deploy
> key (`DEPLOY_SSH_PRIVATE_KEY_B64` → gda-s01), a different subsystem that never touches the GitHub
> App credential. Extending them would have added assertions that pass without testing anything —
> coverage-shaped, not coverage. **Correct home: a dedicated `core/github/egress-inventory.test.ts`**
> (built in GH-01) asserting the egress allowlist plus PEM/token non-logging.

Hygiene coverage lives with the credential it protects. Assert: the PEM never appears in a response,
a log line, or an outbound payload; minted installation tokens likewise; and the egress allowlist
admits only `api.github.com`.

---

## §5 · The repo registry — what the owner asked for first

**Goal:** the ERP lists the org's repos, links them to sites and projects, and shows source-code
status per site.

### 5.1 — Source of truth
- **GitHub is truth** for repo facts: existence, visibility, default branch, head SHA, CI outcome.
- **The ERP is truth** for the link to a site/project, and for who did what.

Never invert these. A registry that drifts from GitHub is worse than no registry, because it looks
authoritative.

### 5.2 — Shape

`github_repos` — tenant-scoped, FORCE RLS, one row per repo:

| Column | Note |
|---|---|
| `org`, `name`, `full_name`, `html_url` | identity |
| `visibility`, `archived`, `topics[]` | GitHub facts |
| `default_branch`, `head_sha`, `head_committed_at`, `head_author` | source state |
| `open_pr_count`, `latest_run_status`, `latest_run_conclusion`, `latest_run_at` | CI state |
| `latest_release_tag`, `deployed_ref` | release state |
| `webdev_site_id`, `project_id` | the ERP link — nullable, and **an unlinked repo is a finding** |
| `repo_created_at`, `pushed_at`, `last_synced_at` | freshness |

`last_synced_at` matters: a stale row must be *visibly* stale in the UI rather than quietly wrong.

> **GAP CLOSED 2026-08-31 — which tenant owns an UNLINKED repo?** GH-05 correctly refused to decide
> this silently: `tenant_id` is `NOT NULL` (RLS requires it), but §5.2 as drafted never said what a
> repo with no site and no project gets.
>
> **Ruling: `tenant_id` = the operating company that owns the GitHub org (Gaiada), always.** The
> `gaiadabali` org is Gaiada's own asset; a client deliverable *hosted in it* is still Gaiada's
> repository. Client identity rides the `webdev_site_id` link (and the site's own client record), not
> the repo's tenancy. So linking or unlinking a repo **never changes its `tenant_id`** — which also
> means the sync job needs no tenant-resolution logic at all, and cannot mis-file a repo into a
> client's tenant where the client portal might surface it.
>
> ⚠ Owner confirmation wanted on one consequence: this makes the repo list visible only within the
> Gaiada tenant. If a client should ever see their own repo's build status through the portal, that
> must be an explicit projection over the site link — never a tenancy change on this table.

### 5.3 — Sync strategy
1. **Initial crawl** via installation token — full org enumeration, seeds the table.
2. **Webhooks keep it fresh** — `push`, `repository`, `workflow_run`, `pull_request`.
3. **Periodic reconcile sweep** catches missed deliveries and drift. Webhooks are not reliable
   delivery; a registry that trusts them alone will silently diverge.

> **COST OF A FULL SWEEP — measured against the real org, 2026-08-31 (GH-06).** The list call gives
> identity and state for free. The columns that make §5.4 useful — head commit, open PR count,
> latest Actions run, latest release — cost **3–4 additional calls PER REPO**. At 221 repos that is
> **~650–850 extra round trips per detailed sweep**, against a shared installation bucket whose
> floor is 5,000/hr.
>
> So a detailed sweep is roughly **a fifth of the hourly budget for the entire company**, and §4.7's
> fairness queue is what stops it starving interactive work. **Consequences for whoever sets the
> cadence:** an hourly detailed sweep is not affordable; the sweep should run detail-light and lean
> on webhooks for the volatile columns, with a full detailed pass on a much slower cycle. Do not
> schedule this without doing that arithmetic.
>
> Two safety properties GH-06 built that should not be regressed: every per-repo sub-fetch is
> independently wrapped, so one flaky repo degrades to null rather than aborting the crawl; and **if
> the installation reports zero repos the soft-delete pass is skipped entirely** — 221 repos
> vanishing at once is far less likely than a transient empty response, and treating it as truth
> would empty the registry.

> ⚠ **`deployed_ref` is NULL for every row today, and will be until a ticket owns it.** GH-06 has no
> source for it: the deployed ref lives in `deploy-workflows`' artifact-branch state
> (`deploy/staging-*`, `deploy/production-*` — see §2.2), which is a webhook/GH-07 concern.
> §5.4 lists "deployed ref vs head" as part of the surface and §5.2 has the column, so **the UI must
> render this as "unknown", never as "up to date"** — a missing field reads as NULL, and a NULL here
> silently means "no drift" if rendered naively. Assign it explicitly before claiming §5.4 complete.

### 5.4 — The surface
A Sites/Repos view showing, per site: repo, default branch, last commit (author + when), open PRs,
last CI run, deployed ref vs head, and **unlinked repos** as their own bucket. An unlinked repo is
either a site nobody registered or a repo nobody owns — both worth seeing.

> **This is the phase-1 deliverable.** It is read-mostly, exercises the token path, the registry,
> and the webhook receiver, and produces something visible — without needing the full write arm.

---

## §6 · What already exists

| Piece | Where | State |
|---|---|---|
| `integration_connections` + sealed tokens, `provider='github'` allowed | [`integrations.service.ts`](../../platform-nest/src/core/integrations.service.ts) | **Built.** Token non-exposure rule already enforced. |
| `activities` with actor / `via` / `approved_by` / `executed_by` | [migration](../../platform-nest/migrations/202608261100_activity_approval_attribution.sql) | **Built.** Columns exist; ambient-context wiring is a known follow-up. |
| `work_activity` with `actor_user_id` + `actor_external`, `source='github'` | [`work-activity-ingest.service.ts`](../../platform-nest/src/core/work-activity-ingest.service.ts) | **Built.** Already the right shape for §4.5. |
| `github.repoStatus` (read) + `github.createRepo` (disabled) | [`delivery-tools.ts`](../../mcp-hub/src/delivery-tools.ts) | **Built, fails closed.** Env wired at `docker-compose.vps.yml:966`, currently blank. |
| Tracked-sites concept | webdesk design §02, `webdev_sites` | **Planned.** The registry in §5 is its GitHub half. |
| App auth, repo registry, webhook receiver, ledger writes | — | **Nothing.** |

The substrate is better than it looks. What is missing is the client, the registry, and the wiring.

---

## §7 · Tickets

| ID | Work | Seat | Deps | Acceptance |
|---|---|---|---|---|
| **GH-00** ⚡ | Owner creates `gaiada-erp` + `gaiada-agents` Apps on `gaiadabali`, installs both, records App ids / installation ids / PEMs in `CREDENTIALS.local.md` + rotate register | owner · devops | — | Both Apps installed; PEMs stored; **`web@` break-glass PAT confirmed held offline**; App is not the only org admin |
| **GH-01** | Credential storage + installation-token minting: PEM sealed into `integration_connections`, JWT→token exchange, in-memory cache w/ T−5min refresh | senior-be | GH-00 | Token minted against the live org; **never persisted, never in any response**; secret-hygiene tests extended per §4.9 |
| **GH-02** | GitHub client core: shared rate-limit bucket w/ per-user fairness queue, backoff, error mapping, quota on `/admin/info` | senior-be | GH-01 | Bulk op by one user provably does not starve another; quota visible |
| **GH-03** | Cerbos policy: per-action + per-repo gating; repo-create and destructive ops routed through D14 | senior-be | GH-01 | Policy probe after restart — nothing hot-reloads; prove the decision, don't trust health |
| **GH-04** | Ledger writes: `activities` row **before** every call; correlation id issued; retention documented | senior-be | GH-03 | Failed call still leaves a row; retention ≥ repo history |
| **GH-05** | `github_repos` migration — schema per §5.2, FORCE RLS, timestamp-named | senior-db | — | RLS third-wall probe; unset-GUC returns zero rows without error |
| **GH-06** | Initial org crawl + periodic reconcile sweep | medior | GH-02, GH-05 | Full org enumerated; sweep detects an out-of-band change made by hand |
| **GH-07** | Webhook receiver + reverse attribution (§4.5), incl. **unattributed** path | senior-be | GH-04, GH-05 | A bot push correlates to the right human; an out-of-band push lands `actor_user_id=NULL` **flagged**, not credited to the bot |
| **GH-08** | BFF endpoints: repo list + detail + link/unlink to site/project | medior | GH-05 | Contract matches `FRONTEND-BFF-CONTRACT.md` |
| **GH-09** | UI: Sites/Repos view per §5.4, incl. unlinked bucket + visible staleness | senior-fe | GH-08 | RBAC-gated; stale rows read as stale |
| **GH-10** | Write arm: commit/PR with author attribution + trailers (§4.4); **reviewer-distinctness enforcement** (§4.8) | senior-be | GH-04, GH-07 | Commit shows real author in blame; a self-review is refused by the ERP |
| **GH-11** | ~~Org migration~~ **DESCOPED 2026-08-31 — the org was renamed, not migrated (§3).** Residual: rewrite any ERP-stored `repo_url` still naming `Gaia-Digital-Agency` so it does not depend on GitHub's rename redirect; delete the orphaned `gaiada-deploy` App key | junior | GH-06 | No stored URL names the old org; orphaned key gone. *(P-3 and the deploy-repoint work are closed — verified absent / pull-model, see §3)* |
| **GH-12** | mcp-hub cutover to `gaiada-agents` read-only App; `github.createRepo` re-enabled **behind D14** in platform-nest, not in the hub | senior-integrator | GH-03, GH-01 | Hub provably cannot write; creation requires an approval |
| **GH-13** | Ledger-completeness reconcile job (§4.6) + alert | senior-be | GH-07 | A hand-made bot-authored change raises the alert |
| **GH-15** | **Org access sweep** — scheduled job on the **`gaiada-org-sweep` PAT** (§2.2b), *not* the break-glass one; no App can enumerate Apps. Records installed Apps + permissions, org members, outside collaborators; diffs vs last run, alerts on change | senior-be | GH-00 | Installing a new App raises an alert. **First step is the `read:org` vs `admin:org` 200/403 test (§2.2b caveat)** — if it needs `admin:org`, escalate the design decision rather than shipping an admin token to the server. Baseline: `gaiada-erp` (write), `gaiada-agents` (read), `gaiadabali-deploy` (read) |
| **GH-14** ⚡ | QA gate: full battery — authz matrix, RLS probes, rate-limit fairness, attribution round-trip, unattributed path, secret-hygiene grep | qa | all | Written evidence per check; zero critical findings. Caps the capability at **PROTOTYPED** |

⚡ = needs the owner or a live credential.

**Sequencing:** GH-00→01→02 unlocks everything. GH-05→06→08→09 is the phase-1 registry the owner
asked for first, and can ship before the write arm. GH-10 onward is the write capability. GH-11 can
run in parallel once GH-06 gives it an inventory.

**Status ceiling:** nothing here claims **DEV-VERIFIED** until exercised against the live org.
Local greens do not count — tests run on the server.

---

## §8 · Open questions

| # | Question | Why it blocks |
|---|---|---|
| Q1 | ~~Does an App installation token trigger Actions?~~ **CLOSED — PROVEN 2026-08-31.** Ran live against `gaiadabali` (`scripts/github-app/probe-actions-trigger.mjs`, throwaway repo created + deleted): **branch push → run created in 6s; TAG push → run created in 6s.** Both attributed to `gaiada-erp[bot]` as `actor` and `triggering_actor`. The deploy pipeline's `git push --tags` → Actions rail works under App auth | — |
| Q2 | ~~Where do client-site deploys point?~~ **CLOSED 2026-08-31.** Delphi/helios use a **pull** model: `deploy-workflows` publishes artifact branches, the servers fetch them (§2.2). Legacy direct pushes on 6 repos (FTP / cPanel / GoDaddy) are client-side hosting and out of scope. `baligirls-new` (→ `gda-ce01`) is redundant and will be archived — no repoint needed | — |
| Q2b | ~~What is still in `Gaia-Digital-Agency`?~~ **CLOSED**: the org was renamed to `gaiadabali` and retired. Nothing remains | — |
| Q2c | ~~Other Apps on the org?~~ **ANSWERED 2026-08-31**: `gaiadabali-deploy`, read-only, legitimate (§2.2). `gaiada-deploy` still unaccounted for. **No App can enumerate other Apps** — `GET /orgs/{org}/installations` requires owner auth, and the audit-log API is Enterprise-only. This is what GH-15 exists for | Left unwatched, a *future* App install is what would break §4.6 |
| Q3 | Billing consolidation on org transfer — intended? | Irreversible-ish, and the old org billed elsewhere |
| Q4 | Retention period for `activities` | It is now the only record; the number should be chosen, not defaulted |
| Q5 | Do client-owned repos (hosted on client infra) enter the registry as unlinked, or stay out? | Changes what "unlinked is a finding" means |
