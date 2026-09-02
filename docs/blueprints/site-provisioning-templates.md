# Site provisioning templates — `static` · `fullstack` · `wp`

**Status: PLANNED.** The provisioning code path is DEV-VERIFIED and live in `v1.0.0-alpha.325`
(ERP repo control, GH-12, D14-gated). This document covers the three template repositories it
generates from, which **do not exist yet**. Until they do, provisioning is shipped but inert.

## Why this document exists before the templates

Provisioning went live today and is currently unusable, for two reasons that are both facts, not
guesses, verified against the live estate on 2026-09-01:

```
gh api orgs/gaiadabali/repos --jq '.[]|select(.is_template==true)'   -> nothing
ERP_REPO_TEMPLATE_* in gda-aicenter .env                             -> 0 lines
ERP_REPO_TEMPLATE_* visible inside gaiada-platform-1                 -> 0
```

So a provision request today resolves no template and fails with
`ErpRepoControlNotConfiguredError`. That is the correct fail-closed behaviour — a provisioner that
invented a template name would be worse — but it means the Repositories tab's provision button
cannot yet succeed. Two design questions must be answered before the templates are written, because
each has a wrong answer that would be expensive to unwind once client sites are generated from it.

## Tension A — "fullstack includes PostgreSQL" versus "one unified DB"

The owner stated both of these, and read literally they conflict:

> fullstack will use next.js + nest.JS, tailwind, typescript, postgresql

> the important point is we have unified backend and all the client backend should use that so all
> are in 1 unified DB

A template that runs `docker compose up postgres` gives every client site its own database. That is
the normal Next+Nest starter, and it is exactly what the second statement forbids: N client
databases, N backup regimes, N migration ledgers, and no cross-client reporting — the opposite of
the holding-OS direction the ERP is built around.

**RULING (proposed, needs owner confirmation): PostgreSQL stays in the stack; a separate database
does not.** The fullstack template's Nest service is a client-specific *business-logic* service
whose persistence is the **unified WebDesk Postgres**, reached as a tenant-scoped role under
per-tenant RLS — the same isolation model the ERP already runs on. Concretely: the template ships
with a `DATABASE_URL` pointing at the unified instance and a tenant GUC stamped on every
connection, not a `postgres:` service in its compose file.

This satisfies both statements honestly. The client's engineers still write SQL, still get
migrations, still get Postgres. What they do not get is a private database nobody else can see or
back up. The cost is real and worth naming: a noisy client can now affect a shared instance, and a
client who demands physical data separation cannot be served by this template. Both are acceptable
at current scale (250 tenants migrated in WebDesk Phase 1) and both are the ordinary trade of a
multi-tenant platform.

**What must be true before the first fullstack site ships:** the estate's `NULL defeats UNIQUE`,
`RLS zero-row trap` (an unset GUC yields ZERO rows with no error), and FORCE-RLS rules apply to
every table the template creates. The template must therefore ship a migration *example* that gets
this right, because the first thing a client engineer does is copy it.

## Tension B — WordPress cannot consume a Node backend

WordPress is PHP with its own database and its own content model. It cannot import the generated
TypeScript SDK, and rewriting it to read from a Node API would stop it being WordPress.

**RULING (proposed): WordPress keeps its own content store for presentation, and bridges to the
unified backend through the generated PHP SDK.** This is not a workaround invented here — WebDesk's
codegen already emits a PHP SDK (`webdesk/api/src/codegen/generator/sdk-php.mts`, alongside
`sdk-ts`), written to MinIO per tenant as `contracts/<tenantSlug>/latest.json`. The PHP half exists
precisely because something non-Node was always going to need it.

The template ships a must-use plugin (`wp-content/mu-plugins/gaiada-webdesk/`) that consumes that
SDK. Must-use, not a normal plugin, so a client admin cannot deactivate the bridge from the WP
dashboard and silently detach the site from the estate.

**Honest limitation:** this makes WordPress *bridged*, not unified. Its posts and pages live in the
WP database. On the §08 adoption ladder (`tracked → linked → adopted → mandated`) a `wp` site can
reach **`adopted`** but not `mandated` — the ladder's top rung assumes the unified content model.
Anyone promising a client "one database" should not be shown a WordPress site as the example.

## CMS: Payload, not Decap

The owner offered either. Payload, for one reason that decides it: Decap is a git-based CMS — it
commits content to the site's repository. That puts client content in Git, per-site, which is the
same fragmentation Tension A rejects, just for content instead of rows. Payload is already in-repo
(`webdesk/payload/`) with a **frozen, DEV-VERIFIED vocabulary** (WSK-06/WSK-14) that the codegen
builds on.

Payload's role is deliberately narrow and worth stating so it is not over-read: **admin and
editorial only.** It is not the client's runtime API. Sites read content through WebDesk's
tenant-aware gateway, not by talking to Payload directly.

"CMS now or later" is therefore not a fork in the template — every template is CMS-capable from
birth. Choosing "later" provisions the repo without a Payload tenant binding; choosing "now" also
creates the binding. Adding it later is a binding, never a re-scaffold.

## Known gaps — these block a *complete* template, and none are worked around here

1. **No forms endpoint exists.** The owner noted the estate should already have "equivalent of
   web3forms". It does not — a search of `webdesk/api/src` finds API keys, audit and auth, but no
   form-submission route. All three templates need one (it is the single most common thing a
   brochure site does). This must be built in WebDesk before the templates can ship a working
   contact form, and a template shipping a form that posts nowhere would be worse than one shipping
   no form.
2. **webdesk-api does not run.** It has restarted 379+ times on gda-aicenter. The CA loading fix is
   committed (`02a0b220`) and the CA file is now placed at `/etc/webdesk/certs/ca-cert.pem` with a
   verified fingerprint, but webdesk is **not in `deploy.yml`** — the running container is a
   hand-built image from an rsync'd tree outside the pipeline, so nothing deploys the fix. Every
   template's backend wiring is untestable end-to-end until this is resolved. This is the single
   highest-leverage blocker in this document.
3. **No public route to WebDesk.** The Caddy mTLS proxy that terminates the control channel and
   forwards `x-webdesk-mtls-cert-pem` does not exist in `webdesk/proxy/**`.
4. **Cloudflare is unverified here.** The owner states the company has Cloudflare. Cloudflare Pages
   is the natural target for `static`, but no token, account id, or zone has been confirmed in this
   estate, so the template must treat deployment as configuration, not bake in an account.

## Template shapes

Common to all three: `README.md` stating which kind it is and what it may not do; `.env.example`
with every variable named and none valued; a CI workflow; and no secret, token or client name
committed. Provisioning stamps the tenant binding at generate time, never a human editing a file.

### `static` — Astro
```
src/{pages,layouts,components}/     astro.config.mjs, tsconfig.json
src/lib/webdesk.ts                  the generated TS SDK client (content + forms)
.env.example                        WEBDESK_BASE_URL, WEBDESK_TENANT_SLUG, WEBDESK_API_TOKEN
wrangler.toml                       Cloudflare Pages target, account left unset
.github/workflows/deploy.yml
```

### `fullstack` — Next + Nest + Tailwind + TypeScript
```
apps/web/                           Next + Tailwind
apps/api/                           Nest — client business logic
apps/api/src/db/                    unified Postgres, tenant-scoped role, GUC stamped per connection
apps/api/migrations/                ONE example migration that gets FORCE RLS + the GUC right
.env.example                        DATABASE_URL (unified), WEBDESK_*, tenant slug
```
No `postgres:` service in its compose file. That absence is the ruling above, and the compose file
should carry a comment saying so, or the first engineer to look will "fix" it.

### `wp` — WordPress
```
wp-content/themes/gaiada-base/
wp-content/mu-plugins/gaiada-webdesk/    the PHP SDK bridge — must-use, not deactivatable
composer.json
docker-compose.yml                       LOCAL DEV ONLY — label it, or it will reach a server
.github/workflows/deploy.yml             to the WP server, per estate zoning
```

## Wiring, once the templates exist

Three env vars, set on gda-aicenter's `infra/compose/.env` **and** listed under the platform
service's `environment:` block — a var in `.env` alone does nothing in this estate, which has caught
people before:

```
ERP_REPO_TEMPLATE_STATIC=gaiadabali/template-static-astro
ERP_REPO_TEMPLATE_FULLSTACK=gaiadabali/template-fullstack-next-nest
ERP_REPO_TEMPLATE_WP=gaiadabali/template-wp
```

Each repo must have `is_template: true` set, or GitHub's
`POST /repos/{owner}/{repo}/generate` refuses.

## Verification bar before this leaves PLANNED

Not "the repos exist" — that proves nothing. Per estate practice, drive the real surface:

1. Provision one site of each kind through the actual Repositories tab, as a real logged-in user.
2. Approve each in the Approvals inbox — approving EXECUTES (D14), so this is the real GitHub call.
3. Confirm each generated repo has the expected tree, and that the ledger recorded the call.
4. `git clone` each generated repo, install, build. A template that generates but does not build is
   not DEV-VERIFIED.
5. For `fullstack`, confirm the example migration's RLS actually isolates two tenants — write a row
   as one, prove the other cannot read it.
