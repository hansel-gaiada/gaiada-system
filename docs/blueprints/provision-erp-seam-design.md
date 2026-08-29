# Provision ⇄ ERP Seam — Architect Design (signed PRD → repo + hosting, on the One Rail)

> # ⛔ SUPERSEDED — 2026-08-29
>
> **[`webdesk-design-v2.md`](./webdesk-design-v2.md) §08 replaces this design.** The owner ruled
> (WSK-D29) that provisioning is **rebuilt inside the ERP** and the external `provision` tool
> retired once parity is proven — it is internet-facing with demo credentials on its own login
> screen, and repo creation depended on an individual's personal PAT.
>
> **Still valuable here, and cited by v2.0 §08:** the read of what one `provision` run actually
> creates (template repo → vhost → TLS → sealed Actions secrets), its idempotency and
> crash-resume behaviour (which the rebuild must not regress), the credential-custody analysis
> (D-P4, now amended), and PRV-01/02's shipped code. The **direction** is superseded; the
> **field research is not**.

> **Status:** Design blueprint — PLANNED. Nothing in this document changes any module version;
> the first merged ticket flips the relevant registry rows per the status-language doctrine
> ([`../modules/MODULES.md`](../modules/MODULES.md)).
> **Version:** v1.0 · **Date:** 2026-08-08 · **Author:** System Architect (Claude)
> **Scope (owner directive):** make the owner's existing **`provision`** tool an ERP capability —
> a signed-off PRD auto-generates a GitHub repo + project structure — **as a seam that is ready
> for future extension, NOT the unified backend itself.** Design only.
> **Primary inputs:** the `provision` repo (read-only, verified against code at
> `c:\Users\Hansel\Documents\Hansel\Projects\provision`) ·
> [`webdesk-design.md`](./webdesk-design.md) (Zone A/B doctrine, §03 control channel, §06 rail,
> WSK ticket program) · [`webdev-design.md`](./webdev-design.md) (§03 trust zones, §05 frozen
> scaffold envelope, §07 gate spine, WS11 locks) ·
> [`webdev-foundation.md`](./webdev-foundation.md) (one-rail lock).
> **Siblings:** [`webdesk-design.md`](./webdesk-design.md) · [`webdev-design.md`](./webdev-design.md)
> — same section map, same rigor. Where webdesk's defining hazard is cross-tenant leakage on a
> platform that doesn't exist yet, **this seam's defining hazard is wiring the ERP to a tool that
> already exists, already shells out to a production web server, and was built for one trusted
> human** — the boundary must be imposed from the ERP side, because the far side won't impose it.

---

## §00 · Executive summary

1. **Verdict (§02): `provision` stays a separate tool behind a shared, webdesk-shaped contract.**
   It does not become webdesk's control plane (its codebase is an internal single-user CRUD with
   shell-out provisioning — promoting it would cost more than building webdesk's control plane per
   the already-approved 36-ticket design) and it is not absorbed now (webdesk is `0.0.0 PLANNED`,
   zero code). Direction: **absorbed at webdesk P4+, executed as a driver swap** behind a provider
   abstraction this seam introduces (`provider: 'provision' | 'webdesk'`). The ERP-side work —
   egress client, WS4 gating, mirror table, idempotency ledger, console card — is the durable
   asset; it is the same work webdesk P4 needs, built early against a live backend.
2. **The seam (§04):** `prd_sign` decided → n8n proposes → hub tool `webdev.provisionSite`
   (medium write) → **suspends into WS4** (automation principal, D14) → a human approves → the
   D14 executor re-drives the call as the original principal → platform-nest's provisioning
   service calls `POST /api/provision` on `provision.gaiada.online`, polls status, writes one
   mirror row, emits events. A manual "Provision" action on the run workspace drives the same
   endpoint for staff. The existing delivery workflow's `github.repoStatus` gate then passes
   with **zero workflow changes** (slug grammars already match — verified, §04).
3. **Trust boundary (§03):** `provision` on gda-s01 is treated as **Zone B′** — internet-facing,
   holds an org-admin GitHub PAT and a fleet SSH key, runs `sudo`. The seam is a **real
   cross-host hop** (the ERP on gda-aicenter calling gda-s01 over public HTTPS — two machines,
   two trust zones, nothing localhost can imitate). One-way control applies from
   day one: the ERP authenticates *to* provision with a dedicated, revocable credential;
   **the PAT and SSH key never enter Zone A**; provision holds **zero** ERP credentials; v1 has
   **no B′→A channel at all** (the ERP polls). Auth upgrades to Keycloak offline-JWT (the exact
   WSK-22 shape) as a provision-side hardening ticket.
4. **Idempotency (§04) is two-layer, per the house rule that a lock without a server-side
   precondition re-check does nothing:** ERP side — partial unique index (one non-failed site per
   run) + `lockPipelineRun` + precondition re-read, in the D14 registry entry AND the endpoint;
   provision side (already shipped, verified) — DB-unique name + repo-exists-before-create.
   A 409 from provision triggers **adopt-only-if-ours, refuse otherwise** — never auto-adopt a
   name that another client's site already holds.
5. **Ticket split (§07): 6 buildable now** (mock provider · migration · service+module shell ·
   hub/D14/n8n · console card · CI gate) with one **opus·medium** flag (PRV-02, the
   idempotency/adoption core), **4 blocked** on a credential or an owner decision (live wiring;
   three provision-repo hardening tickets). CI proves the logic against a mock before any
   credential exists; **verification that counts happens on the servers** (owner steer,
   2026-08-08): the seam is a real cross-host hop (gda-aicenter → gda-s01) and no claim above
   PROTOTYPED is made until PRV-07 discharges the live leg on the boxes — local proof would be a
   double test against capabilities local does not have.
6. **One standing decision is amended, explicitly (§09 D-P6):** WS11's "repo creation is a manual
   PM step" lock. `github.createRepo` **stays fail-closed exactly as shipped**
   (`mcp-hub/src/delivery-tools.ts:93-100`); this seam adds a *scoped* alternative — template-only,
   org-fixed, WS4-gated, one-per-run — which is the owner's explicit ask. Ratify at OQ-P6.

---

## §01 · What `provision` is today (verified against code) and what it must not lose

Everything below was read from the repo at `c:\Users\Hansel\Documents\Hansel\Projects\provision`
(clone of the live system at `provision.gaiada.online` on gda-s01). Citations are `file:line` in
that repo.

### Verified composition

- **Payload CMS on Next.js** (`next start -p 3090` under PM2 as `provision-backend`) + a
  Vite/React SPA served statically by nginx (`docs/architecture.md:5-30`,
  `docs/handover.md:3-11`). Postgres DB `provision`; schema via Payload **`push: true` forced in
  production** — no migrations exist and retrofitting them once generated a drop-all script
  (`backend/src/payload.config.ts:62-72`, `docs/handover.md:39-49`).
- **Collections:** `Prds` (`backend/src/collections/Prds.ts` — fields incl.
  `stack: A|B|C` where **B is "WordPress+MySQL"** at `Prds.ts:33-38`), `Projects`
  (`Projects.ts` — `name` DB-unique at `:21`, status `pending|provisioned|live` at `:33-41`,
  `repoUrl`/`serverPath`/`stagingUrl` at `:43-45`), `Users` (`Users.ts` — Payload local auth,
  roles `developer|admin`).
- **Endpoints:** `POST /api/provision` (`payload.config.ts:28-34` →
  `endpoints/provisionProject.ts:241-282`) and `GET /api/prds/:id/markdown`
  (`endpoints/exportPrdMarkdown.ts`). Plus Payload's generic REST (`/api/projects`,
  `/api/users/login` — the SPA logs in at `frontend/src/lib/api.ts:27-38`).
- **What one provision run creates** (`provisionProject.ts:205-239`): a **private GitHub repo
  from a template** (`provision-project-template-nonssg` | `-nextjs`) under `Gaia-Digital-Agency`
  (`:8-12, :30-49`); `/var/www/<name>` via `sudo mkdir` + `chown azlan:azlan` (`:136-142`); an
  nginx vhost written through a `/bin/sh -c` heredoc + `sudo mv` (`:143-157`); symlink +
  `nginx -t` + reload + a certbot cert, certbot serialized by an in-process queue (`:159-203`);
  and the template's `deploy.yml` patched (`__REMOTE_PATH__` → real path, `replaceAll`,
  `:71-98`) with **3 repo Actions secrets** (`GCP_HOST`, `GCP_USER`, `GCP_SSH_PRIVATE_KEY`)
  sealed via libsodium (`:100-134`) so the *provisioned project's own* Actions rsync its build on
  every push to `main`.
- **Auth to GitHub is a PAT** (`GITHUB_TOKEN`, read at `provisionProject.ts:20`), **not a GitHub
  App** — repo-admin scope on the org, no `delete_repo` (`docs/handover.md:33-35`). Two personal
  PATs exist (`azlangaiada`, `azlanabas`; `handover.md:82-87`). **This is why the ERP's WD-21/OQ-2
  GitHub-App blocker does NOT block this capability** — the App remains the right answer for
  *webhooks/work-activity* (webdev-design §03 row 5), while repo *creation* rides provision's PAT
  inside Zone B′.
- **Idempotency + crash-resume are already real** (found live, not aspirational): repo-exists
  check before create (`provisionProject.ts:30-49`), skip-if-already-patched deploy.yml
  (`:71-77`), and an `onInit` resume that re-drives any project stuck at `pending|provisioned`
  >3 min after a backend restart (`payload.config.ts:35-61`). Failure semantics: SSL-only failure
  stays `provisioned` (retryable); a hard failure is **logged only** and the row sits at
  `pending` until the next restart resume (`provisionProject.ts:228-238`) — the seam must absorb
  that (poll timeout → honest `failed` + reconciler, §04).
- **Provisioned projects are always static exports** — no per-project DB, PM2 process, or port
  (`docs/architecture.md:46-48`). Decommissioning is fully manual, deliberately
  (`Projects.ts:14-17`, `handover.md:59-73`).

### What the seam must NOT lose (binding constraints on every ticket)

1. **The manual SPA flow keeps working unchanged.** The ERP is *another authenticated API
   client*, nothing more. No change to `runProvisioningSteps` semantics.
2. **The name grammar** `^[a-z0-9-]+$` (`provisionProject.ts:261` — DNS/GoDaddy constraint,
   owner directive 2026-07-28) is enforced ERP-side too, *before* egress (defense in depth for
   the `/bin/sh -c` heredoc at `:155`, which is safe only under that grammar).
3. **Certbot serialization** (`:159-188`) and the resume loop stay provision-owned. The ERP never
   orchestrates provision's internals — it requests, polls, and records.
4. **No automated teardown.** The seam adds creation only; decommissioning stays the manual
   runbook (`handover.md:59-73`, incl. its "only when explicitly told" warning).
5. **provision's own deploy model** (git-pull-on-server on push to `main`,
   `.github/workflows/deploy.yml:18-25`) means any provision-repo ticket ships to prod on merge.
   Provision-side tickets in §07 carry that warning.

### Findings register (security/tenancy observations — reported, not silently fixed)

| # | Finding | Where | Disposition |
|---|---|---|---|
| P-1 | **Any authenticated provision user can provision** — the handler checks `req.user` only, no role gate; default role is `developer` | `provisionProject.ts:242-244`, `Users.ts:14` | PRV-08 adds a role/service gate (provision repo, owner-gated). The ERP seam does not depend on it but the blast radius does |
| P-2 | **Demo credentials are displayed on the public login screen** (`web@gaiada.com / Teameditor@123`) and the tool is internet-facing | `docs/todo.md:66-67`, `backend/src/components/BeforeLogin.tsx` | Combined with P-1 this approaches "unauthenticated repo+vhost creation on gda-s01". **Rotate before PRV-07 live wiring** (OQ-P2 default). Goes on the rotate-before-staging register regardless |
| P-3 | **One SSH private key is fanned out to every provisioned repo's Actions secrets** (`DEPLOY_SSH_PRIVATE_KEY_B64` → `GCP_SSH_PRIVATE_KEY`); any provisioned repo's CI can SSH to gda-s01 as `azlan` | `provisionProject.ts:129-133`, `handover.md:33-37` | Pre-existing; the seam *increases the number of repos carrying it* (auto-creation). v1 accepts + registers it; the real fix (per-repo deploy keys or an `rrsync`-forced key) is PRV-10 / webdesk absorption. OQ-P3 |
| P-4 | **`push: true` forced in production** — schema drift by construction, no migration history | `payload.config.ts:62-72` | Accepted for the internal tool (its own doc justifies it). A reason *against* growing provision into the multi-tenant control plane (§02) |
| P-5 | SPA stores the Payload JWT in `localStorage` | `frontend/src/lib/api.ts:1-13` | Internal-tool grade; noted. The ERP seam never uses the SPA path |
| P-6 | `.env.example` omits `GITHUB_TOKEN` / `DEPLOY_SSH_*` that the code reads — env drift trap for any rebuild | `backend/.env.example` vs `provisionProject.ts:20,129-133` | Provision-repo docs chore; folded into PRV-08 |
| P-7 | **Generated nginx vhost is not framework-aware** — multi-page Next.js exports 403 on sub-routes; soft-404s on both frameworks | `docs/todo.md:35-62` (known bug, reproduced live) | Seam v1 defaults `framework: vite`; the fix is provision-side (owner decision already pending there). The console card surfaces provider status honestly either way |
| P-8 | No audit trail on manual admin `status` edits | `docs/todo.md:70` | The ERP mirror row + reconcile log becomes the ERP-side audit; provision-side audit is not this program's to fix |

---

## §02 · The verdict — provision vs webdesk vs the unified backend

**Question (owner):** should `provision` become webdesk's control plane, be absorbed by it, or
stay a separate tool with a shared contract? *"This is the embryo, as we need to handle the
WordPress project, so there would need more planning combined with the unified backend plan."*

**Verdict: (c) separate tool behind a shared contract now — with absorption INTO webdesk at its
P4+ as the recorded direction, executed as a driver swap, not a rebuild.** Not (a), and not (b)
yet.

### Why provision must not become webdesk's control plane (a)

- **Wrong substrate for a multi-tenant, internet-facing platform.** provision is a single-team
  internal CRUD: no tenancy anywhere, no RLS, `push: true` with an un-migratable schema history
  (`handover.md:39-49`), password-login + JWT-in-localStorage, `req.user`-only authorization
  (P-1), and provisioning by `sudo`/`execFile` on the same box that serves the fleet. webdesk's
  approved design (webdesk-design §04, WSK-01..04) starts from a clean ledger `0001+`, FORCE RLS
  under Payload (its one opus·high ticket), and role-split DB custody. Retrofit cost exceeds
  greenfield cost, and the retrofit would inherit exactly the scars (P-4) the webdesk design
  exists to avoid.
- **Same brand, different role.** In webdesk, Payload is the *content engine*; the control plane
  is a purpose-built NestJS `api` (blueprint C-05). In provision, Payload is an *admin CRUD for
  PRDs/projects* with one imperative endpoint bolted on. Growing (a) means writing webdesk's
  control plane anyway — inside a weaker chassis.
- **The WordPress tell.** provision's own PRD vocabulary already anticipates WordPress
  (`Prds.ts:33-38`, stack B) but its provisioner cannot express it (`framework ∈ vite|nextjs`,
  `provisionProject.ts:9-12,253`), because a WP site needs what provision deliberately never
  creates: a database, a runtime, a content backend (`architecture.md:46-48,57-64`). The owner's
  WordPress requirement is **structurally** the unified backend — webdesk P6 (PHP SDK + headless
  WP theme over the central content API) is its designed home. The embryo grows *demand* for
  webdesk; it cannot grow *into* webdesk.

### Why not absorb now (b)

webdesk is `0.0.0 PLANNED` — zero code, and its control plane (P4) sits ~20 tickets deep with a
procurement gate (webdesk-design §12). provision is **live and working** (verified end-to-end in
its own repo history). Parking the owner's ask on webdesk P4 wastes the one asset that exists;
absorbing provision's code into webdesk imports P-1..P-8 into the program that must be cleanest.

### Why (c) is strictly better than both

- **The ERP-side work is identical either way.** Egress client with WS4 gating, an idempotent
  mirror table, D14 registry entry, console card, reconcile flow — webdesk's Zone A end (WSK-19/
  WSK-23) needs the same organs. Building them now against a live backend is webdesk P4 risk
  retired early, for free.
- **The seam is shaped like webdesk's control channel from day one** (§03/§04): one-way A→B
  control, ERP-held credential, no far-side ERP secrets, WS4 on the irreversible-adjacent
  command, idempotent commands, facts recorded Zone-A-side. When webdesk P4 lands, the swap is a
  **driver** (`ProvisionProvider` → `WebdeskProvider`) behind the same table and the same tool
  name — `provider` is a column, not a redesign (D-P2).
- **provision keeps a legitimate niche even after webdesk P4:** zero-backend static brochureware
  on the existing gda-s01 fleet is a real, cheap tier. Whether it survives long-term as that tier
  or retires into webdesk static hosting is an owner decision **at webdesk P6**, not now (OQ-P5).

### Migration direction (recorded so nobody re-derives it)

```
NOW        seam v1: ERP —(webdesk-shaped contract)→ provision (Zone B′, static tier)
webdesk P3 rail live: contract snapshots + code.scaffold v2 (unchanged by this seam)
webdesk P4 WebdeskProvider driver lands; new content-backed sites provision via webdesk;
           provision remains the static tier behind the same ERP surface
webdesk P6 WordPress headless real → owner decides provision's end-state (OQ-P5):
           keep as static tier | fold static hosting into webdesk and retire provision
```

---

## §03 · Trust boundary — provision as Zone B′

`provision.gaiada.online` is public, holds an org-admin PAT + the fleet deploy SSH key, and runs
`sudo` on gda-s01 (the box serving every provisioned client site). By the estate's zone doctrine
(webdev-design §03, webdesk-design §03) that is **Zone B-class**, and this design names it
**Zone B′** to keep it distinct from webdesk's future Zone B boxes. The doctrine applies
one-way-control from day one; the failure mode to prevent is *an ERP that can shell out to a
production web server through an unauthenticated hop* — which, given P-1 + P-2, is nearly what a
naive integration would build.

### Deployed topology — the seam is a real cross-host hop, not an in-process call

| | Zone A (caller) | Zone B′ (callee) |
|---|---|---|
| Box | **gda-aicenter** (`https://erp.gaiada.online`, the deployed 13-container stack; Postgres/Redis on the host) | **gda-s01** (`https://provision.gaiada.online`; nginx → PM2 `provision-backend`, `next start -p 3090`) |
| Process | platform-nest's `webdev` module egress client | provision's Payload endpoint + Payload REST |
| Transport | Outbound HTTPS from gda-aicenter to gda-s01's public nginx `:443` (Let's Encrypt server cert); nginx proxies `/api` to `127.0.0.1:3090` (`handover.md:10`). No VPN/private link exists between the boxes and none is required — the credential + TLS carry the channel; provision's `:3090` is never exposed directly | inbound only |

Nothing about this seam can be faked with localhost: a developer's machine has neither box's
capabilities, and per the standing owner decision (2026-07-31, reaffirmed 2026-08-08) **the
servers are the truth** — CI proves logic, the boxes prove the capability (§07's verification
doctrine).

**When the hop is unavailable** (gda-s01 down, nginx broken, DNS, cert expiry, credential
revoked): the egress client fails the call after bounded retries (connect/TLS errors: 3 attempts,
exponential backoff, ≤30 s total — never a blind re-POST beyond the idempotent create, §04);
the mirror row lands `failed / egress_error` (or stays `requested` if the failure precedes any
successful egress — indistinguishable and safe, since re-drive is precondition-gated); the run
owner + dept lead are notified; the WS4 row's `execution_status` records `failed` with the typed
reason, so the approvals surface shows *authorized-but-not-done* honestly (the D14 axis split).
Recovery is the reconcile flow or a manual re-drive through the same idempotent endpoint — the
pipeline itself is **never blocked** by provision being down (the run merely lacks its repo, and
the `release_code` `repoStatus` gate keeps waiting exactly as it does today for a missing manual
repo).

### A→B′ — the ONE control channel (who authenticates to whom)

| Property | v1 (buildable now) | Hardened (PRV-09, provision-side) |
|---|---|---|
| Transport | HTTPS to `https://provision.gaiada.online` (Let's Encrypt, public CA) | same; optional nginx client-cert pinning later if it ever carries more than provisioning |
| Credential | A dedicated provision **service account** (`erp-service@gaiada.com`, role `developer`) — platform-nest logs in via `POST /api/users/login` and caches the JWT, re-authenticating on 401. Credential custody: platform-nest env (`PROVISION_BASE_URL`, `PROVISION_SERVICE_EMAIL`, `PROVISION_SERVICE_PASSWORD`) → OpenBao target-state. **Unset ⇒ the capability is fail-closed** (exactly the `deploy.*` / `github.repoStatus` precedent, `mcp-hub/src/delivery-tools.ts:78`) | Keycloak client-credentials client `provision-control`, verified **offline** in provision against the public issuer JWKS (`https://erp.gaiada.online/idp/...`) — the literal WSK-22 / webdesk §03 Layer-2 shape, so the egress client is reusable for webdesk P4 unchanged |
| Direction | **Zone A → B′ only.** provision holds **zero** ERP credentials in both variants (with KC, it verifies with public key material only) | same |
| Command surface | `POST /api/provision` + Payload REST reads on `projects` (`GET /api/projects/:id`, `GET /api/projects?where[name][equals]=`) — nothing else. The ERP never calls provision's users/prds admin surface | same |
| Human gate | WS4 approval **before** egress when automation-initiated (D14 suspension); Cerbos-gated staff action otherwise (§04). provision cannot verify approvals in v1 — the gate is Zone-A-enforced, which is acceptable because the command is reversible-by-runbook (empty repo + empty folder + vhost on our own wildcard; contrast webdesk promote-to-live) | PRV-09 may add an `x-ws4-assertion`-style check later if provision outlives expectations; not required for v1's blast radius |

### B′→A — deliberately NOTHING in v1

The ERP **polls**. provision gains no webhook, no ERP URL, no bridge secret. This is the cheapest
possible containment: a fully compromised gda-s01 learns nothing about Zone A from this seam and
gains no new inbound path (it already serves public websites; that exposure is unchanged).
PRV-10(a) (optional, deferred) adds HMAC-signed fact webhooks into the n8n bridge — the webdesk
channel-1 shape — only if polling latency ever matters.

### Custody map (who holds what — the load-bearing table)

| Secret | Lives | Never |
|---|---|---|
| GitHub PAT (`GITHUB_TOKEN`, repo-admin on `Gaia-Digital-Agency`) | provision `.env` on gda-s01 only (`provisionProject.ts:20`) | **never in Zone A**, never in the ERP env, never in a hub tool arg, never logged |
| Fleet deploy SSH key (`DEPLOY_SSH_PRIVATE_KEY_B64`) | provision `.env` on gda-s01; copies land in each provisioned repo's Actions secrets (P-3) | never in Zone A |
| provision service credential (v1) / `provision-control` KC secret (hardened) | platform-nest env → OpenBao target-state; `CREDENTIALS.local.md` §new; **rotate-before-staging register** | never in platform-ui, never in n8n (n8n calls the hub, not provision), never in the mirror table |
| Keycloak JWKS (hardened path) | public key material, fetched by provision | — |

### Blast radius, stated

**If the ERP's provision credential is stolen:** the thief can create template repos in the org,
empty folders, and vhosts under `*.gaiada.online` — noisy, reversible by runbook, and bounded by
the credential's provision-role; they cannot read other tenants' ERP data (the credential is not
an ERP credential) and cannot touch the PAT. Revoke = disable the provision user / rotate the KC
client. **If gda-s01 is compromised:** unchanged from today (P-3 is today's exposure); this seam
adds zero Zone A reach because provision holds no Zone A credential or URL. **If Zone A is
compromised:** the attacker gets what the ERP has — the provision service credential — i.e. the
same bounded provisioning power, still not the PAT.

---

## §04 · The seam — trigger, contract, idempotency, failure

### Trigger (D-P3)

**Primary — automation, human-approved:** on `pipeline.gate.decided` with `kind='prd_sign'` and
`decision ∈ {approved, signed}` (emitted at `platform-nest/src/core/pipeline.controller.ts:585-587`),
a thin n8n flow `wd-provision` calls hub tool `webdev.provisionSite`. The caller is an automation
principal, the tool is a **medium-impact write**, so the hub's D14 impact gate **suspends it into
WS4** — that suspension IS the human approval beat the owner's "auto-generates" needs: creating
an org repo + a public vhost is not obviously low-impact, so a human decides, then D14 executes
as the original principal (the shipped D14 semantics; registry entry in §06).

**Secondary — manual staff action:** a "Provision site & repo" action on the run workspace
(`/pipeline/[runId]`) drives the same platform endpoint under the staff principal, gated by
Cerbos action `provision` on the new resource kind (elevated dept roles). A human click *is* the
approval on this path — no second WS4 beat (consistent with the estate rule: automation suspends,
humans act under Cerbos). This also covers manual runs and mini-runs.

**Why `prd_sign` and not scope dual-sign:** the owner's words ("a signed-off PRD auto-generates…")
name the PRD gate, and the WS4 beat gives the approver discretion to hold a pre-scope provision.
The D14 precondition deliberately does **not** hard-require `scope.signed` in v1 — OQ-P1 lets the
owner flip that with one added predicate, no redesign.

### Slug + framework mapping (D-P8, D-P7)

- **Slug:** platform-nest derives it with the *same grammar the delivery workflow already uses*
  (verified in `automation/workflows/pipeline-delivery.json`, "Load + decide":
  `run.title → lowercase → [^a-z0-9]+ → '-' → trim → slice(0,40)`), exposed as one shared
  `deriveRunSlug()`; a QA case asserts string parity with the workflow's expression. This is what
  makes the existing `release_code` → `github.repoStatus(repo: slug)` gate pass **with zero
  workflow changes** once provision has run. Grammar re-validated against provision's
  `^[a-z0-9-]+$` before egress. An explicit `slug` override parameter exists for collisions.
- **Framework:** parameter `framework ∈ {vite, nextjs}`, chosen by the approver / staff actor,
  default **`vite`** (P-7 makes nextjs the buggier target today). No AI in this loop (v1).
  Anything the PRD implies beyond a static site (provision's own stack B "WordPress+MySQL" or C
  "full stack") is **refused with a routed notification** — "needs manual provisioning /
  unified-backend candidate" — never silently downgraded to a static site. That refusal is the
  seam's honest edge until webdesk absorbs the content-backed tiers (§02).

### Contract — ERP side (new; shapes canonical in `platform-ui/src/lib/` at ticket time)

```
POST /api/:tenantId/modules/webdev/provision            (Cerbos: webdev_provisioned_site/provision)
  { runId: uuid, framework?: "vite"|"nextjs",           // default "vite"
    slug?: string }                                     // default deriveRunSlug(run.title)
  → 201 { site }                                        // mirror row created, egress begun
  → 200 { site }                                        // idempotent re-call: existing non-failed row
  → 409 { error: "slug_conflict_foreign" }              // provision name taken by a site that is not ours
  → 422 { error: "unsupported_stack" | "invalid_slug" | "run_blocked" | ... }

GET  /api/:tenantId/modules/webdev/provisioned-sites?runId=…       (read)
POST /api/:tenantId/modules/webdev/provisioned-sites/:id/reconcile (re-poll now; staff + n8n)
```

MCP tool (module-aggregated via `ModuleContract.mcpTools`, per `contract.ts:14-28`):
`webdev.provisionSite` — `write: true`, `impact: "medium"`, `minAssurance: "low"`,
`pathTemplate: "/api/:tenantId/modules/webdev/provision"`, method POST.

### Contract — provision side (existing; NO provision changes in v1)

```
POST /api/users/login {email,password}        → { token }            (session mint; cached, re-login on 401)
POST /api/provision  {devName,name,framework} → 202 {id} | 400 | 401 | 409   (provisionProject.ts:241-282)
GET  /api/projects/:id                        → { status, repoUrl, serverPath, stagingUrl, ... }
GET  /api/projects?where[name][equals]=<slug> → find-by-name         (Payload REST; the 409-reconcile read)
```

`devName` carries the ERP requester's display name (attribution inside provision's own UI).
Correlation is ERP-side only: `provider_ref` = provision's `projects.id` from the 202 (or the
find-by-name on adopt). No provision schema change needed for v1.

### Idempotency — a double-fire must not create two repos (D-P5)

Two independent layers, each sufficient alone:

1. **ERP side (the authoritative one):** the endpoint runs inside `withTenants`, takes
   `lockPipelineRun(runId)` **first**, then re-reads (the WD-29 lesson — the lock is only the
   enabling half): run exists, not `blocked`, gate state satisfied, and **no existing
   `webdev_provisioned_sites` row for the run with `status <> 'failed'`** (backed structurally by
   the partial unique index in §05 — the-schema-half, exactly the 0088 `ux_wcr_run` pattern).
   Loser of any race gets the existing row (200), not a second egress. The **same precondition**
   is registered in the D14 executable-registry entry, so approve-execute re-checks it at
   execution time under the same lock (`approval-executables.ts` doctrine).
2. **provision side (already shipped, verified):** `projects.name` is DB-unique
   (`Projects.ts:21`) and repo creation checks existence before `/generate`
   (`provisionProject.ts:30-49`). Even a bug that slips layer 1 cannot double-create the repo.

**The 409 rule — adopt-only-if-ours:** provision project names are global (no tenancy there). On
`409` the service finds the project by name and adopts it **only if** a mirror row already
references that `provider_ref` (a crashed earlier attempt by us). Otherwise the name belongs to
someone else's site → the mirror row lands `failed / slug_conflict_foreign`, staff notified,
manual `slug` override is the path forward. **Never auto-adopt a foreign site** — adoption of
another client's project row is the tenancy breach this seam could otherwise invent.

### Failure & retry (absorbing provision's logged-only failure hole)

Two distinct failure families, absorbed differently. **The hop itself failing** (gda-s01
unreachable — §03's unavailability contract): bounded retries → `failed / egress_error` →
notify → reconcile/manual re-drive; the pipeline is never blocked. **provision accepting but
stalling:** its async steps log-and-sit on hard failure until its restart-resume re-drives them
(`provisionProject.ts:236-238`, `payload.config.ts:35-61`). The ERP therefore treats time as the
only honest signal:

- After egress, the service polls `GET /api/projects/:id` with backoff (~5s → 30s, ≤5 min).
  `pending→provisioned` normally lands in ~1 min; `live` after certbot.
- Status mapping: ERP `requested` (pre-egress) → `pending` → `provisioned` → `live` (terminal);
  poll window exhausted ⇒ `failed / poll_timeout` — **honest, not final**: the scheduled
  `wd-provision-reconcile` n8n flow re-polls every non-terminal/failed-timeout row hourly and
  flips it forward when provision's resume loop eventually succeeds. `provisioned` (SSL pending —
  DNS/certbot retryable) keeps reconciling to `live`.
- Every transition emits an outbox event (§06) → bell notification; `failed` routes to the run
  owner + dept lead. **No automatic re-POST ever** — retry-of-create is always precondition-gated
  through the same endpoint (idempotent by construction above).
- LE rate limits (50 certs/week/registered-domain) are a real ceiling on burst provisioning; the
  WS4 beat throttles naturally; the runbook notes it.

### What each side stores

| Side | Stores | Explicitly does NOT store |
|---|---|---|
| ERP (Zone A) | One `webdev_provisioned_sites` mirror row per run (§05): provider, `provider_ref`, slug, framework, `repo_url`, `staging_url`, status, `requested_by`, `approval_id` linkage; outbox events; WS4 row on the automation path | the PAT, the SSH key, provision's DB internals, any provision credential in a table (env only) |
| provision (Zone B′) | Its normal `projects` row (`devName` = requester display name) | any ERP URL, credential, tenant id, or run id (v1); correlation is Zone-A-side only |

---

## §05 · ERP schema delta (DDL sketch — number = NEXT-UNUSED AT MERGE TIME)

One table. **No number is allocated here** (README rule 5; head was `0089_pm_dependency_enforcement.sql`
on disk 2026-08-08 and the ledger races across concurrent programs — `0058`/`0059`/`0070` remain
permanently-orphaned gaps, never fill them). Byte-patterns to copy: composite tenant FK +
partial-unique + FORCE RLS from `0088_webdev_change_requests.sql`.

```sql
-- platform-nest migration NNNN_webdev_provisioned_sites.sql (sketch — refine at PRV-01)
-- Composite parent key: 0088 already added ux_pipeline_runs_id_tenant — reuse, don't recreate.

CREATE TABLE webdev_provisioned_sites (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  pipeline_run_id uuid,                    -- nullable: a site may be provisioned off-pipeline
  provider text NOT NULL DEFAULT 'provision' CHECK (provider IN ('provision','webdesk')),  -- D-P2: the absorption seam
  provider_ref text NOT NULL,              -- provision projects.id — opaque, no cross-zone FK
  slug text NOT NULL,                      -- ^[a-z0-9-]{1,40}$ (CHECK); repo + hostname name
  framework text NOT NULL CHECK (framework IN ('vite','nextjs')),   -- provider vocabulary v1
  repo_url text,                           -- https://github.com/Gaia-Digital-Agency/<slug>
  staging_url text,                        -- https://<slug>.gaiada.online
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','pending','provisioned','live','failed')),
  failure_reason text,                     -- typed token: poll_timeout | slug_conflict_foreign | egress_error | ...
  requested_by uuid REFERENCES users(id),
  approval_id uuid,                        -- automation_approvals.id when WS4-pathed (attribution, not authz)
  last_reconciled_at timestamptz,
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_wps_run_tenant FOREIGN KEY (pipeline_run_id, tenant_id)
    REFERENCES pipeline_runs (id, tenant_id)          -- FK checks run outside RLS: two-column form required (0088 §0)
);
-- Idempotency, schema half (NULL defeats UNIQUE — partial-unique house pattern, 0088:100-106):
CREATE UNIQUE INDEX ux_wps_run  ON webdev_provisioned_sites (pipeline_run_id)
  WHERE pipeline_run_id IS NOT NULL AND status <> 'failed';         -- one live attempt per run
CREATE UNIQUE INDEX ux_wps_slug ON webdev_provisioned_sites (tenant_id, slug)
  WHERE status <> 'failed';
CREATE INDEX ix_wps_nonterminal ON webdev_provisioned_sites (tenant_id, status)
  WHERE status IN ('requested','pending','provisioned');            -- the reconciler's scan

-- FORCE RLS with the webdev THIRD WALL (webdev-design D-2: dept-private new surface; contrast
-- 0088's D-2a — that table took the plain wall because the PORTAL writes it; nothing portal- or
-- core-scoped touches this one, every access path is the webdev module controller declaring
-- withTenants(tenants, { modules: ['webdev'] }) — the two-sided app.scopes handshake, wd23a1):
--   USING/WITH CHECK: tenant_id = ANY(app_current_tenants()) AND app_module_allowed('webdev')
-- Ships EMPTY — zero backfill DML, so the 0050 NOBYPASSRLS backfill trap cannot occur; the CI
-- RLS lint (0052+) applies regardless.
```

Deliberately **not** created: any column on `pipeline_runs` (the mirror row carries the linkage;
0072 already gave runs `project_id`/`owner_id` and this design adds no third), and no
`webdev_contract_snapshots` (that stays WSK-19's, untouched).

---

## §06 · ERP integration points

| Subsystem | Integration (concrete) |
|---|---|
| **platform-nest** | NEW `webdev` **ModuleContract shell** (key `webdev`, `@Controller("api/:tenantId/modules/webdev")`, `ModuleEnabledGuard`) — verified absent from `src/modules/` today; **this program creates the shell, WSK-19 extends it** (coordination note in both tickets; whoever merges second rebases). Inside: the provisioning controller + service, the `ProvisionProvider` driver interface (`provision-http` v1; `webdesk` at its P4), the poller, and the `webdev.provisionSite` McpToolDef. Fail-closed without `PROVISION_BASE_URL` + credential env |
| **DB** | §05 migration, next-unused at merge; third-wall RLS; lint green |
| **mcp-hub** | Tool arrives via `GET /mcp/tool-defs` aggregation (nothing hub-side hardcoded); `AUTOMATION_ALLOWLIST` adds `webdev.provisionSite` to **`wf:delivery`** (`mcp-hub/src/automation-policy.ts:41`); hub Cerbos `mcp_tool` policy lists the tool — **unlisted kind/action = silent DENY that reads like a logic bug; restart `gaiada-test-cerbos` after the policy edit** (standing trap) |
| **D14 / WS4** | Registry entry in `platform-nest/src/core/approval-executables.ts`: `toolName: "webdev.provisionSite"`, `lockKey = runId`, `precondition` = the §04 re-check (run exists ∧ not blocked ∧ `prd_sign` decided approved/signed ∧ no non-failed mirror row). Registered per the registry doctrine (one entry, own precondition — never a generic bridge). Approval origin stays `'automation'` — no CHECK widen needed on this path. Cerbos approval policies: remember the two-place impact gate — write the `approvalId` ALLOW arms explicitly (standing D14 lesson) |
| **Cerbos (Zone A)** | NEW resource kind `webdev_provisioned_site` (actions `read` · `provision` · `reconcile`; provision/reconcile gated to elevated dept roles); `lib/rbac.ts` mirror (defense-in-depth; Cerbos authoritative); **restart the test Cerbos container** |
| **Event backbone** | NEW outbox events `webdev.site.provision_requested` / `.provisioned` / `.provision_failed` → bell notifications + the reconcile flow's wake-ups |
| **n8n** | `wd-provision.json` (trigger: `pipeline.gate.decided`, filter kind/decision → `tools/call webdev.provisionSite` with the OBO envelope → expect `suspended_for_approval` as the SUCCESS outcome) and `wd-provision-reconcile.json` (schedule → platform reconcile endpoint). Reuse the existing event→n8n bridge fan-out (`pipeline-fanout.json` precedent — verify the delivery mechanism to a second consumer at build time); triggers stay outside the `/n8n/` basic-auth gate (standing doctrine) |
| **platform-ui** | Run workspace `/pipeline/[runId]`: a **"Site & repo" card** — status chip (`requested/pending/provisioned/live/failed` + failure reason), repo + staging links, Provision action (framework picker, slug override, Cerbos-gated), WS4 state rendered inline when the automation path is in flight; DEMO fixtures. BFF rows into [`../FRONTEND-BFF-CONTRACT.md`](../FRONTEND-BFF-CONTRACT.md) at the next free § (**the §19+ region is racing — claim at ticket time**, same rule as migration numbers) |
| **Delivery workflow** | **Unchanged.** `release_code`'s `github.repoStatus(repo: slug)` gate passes once provision has run (slug parity, §04). `github.createRepo` stays fail-closed as shipped (`delivery-tools.ts:93-100`) — D-P6 |
| **Registries / docs** | First merged ticket: `MODULES.md` webdev row minor-bump + CHANGELOG; `BLUEPRINTS.md` gains this doc's row; rotate-before-staging register gains the provision service credential (and P-2/P-3 rows if not already carried) |

---

## §07 · Rollout & ticket decomposition (/army-ready)

**Split: 6 buildable now (PRV-00…05) · 4 blocked on a credential or an owner decision
(PRV-07…10).** Opus flags: **1** (PRV-02 opus·medium). All else seat defaults (seniors
Sonnet·high, medior Sonnet·medium, junior Haiku, qa Sonnet·medium). ⚡ = QA gate + architect
design-review on the diff. Concurrency 1–2 per the standard; the QA gate runs alone, last.
Status language: everything below is PLANNED until merged.

### Verification doctrine (owner steer 2026-08-08 — binding on every AC below)

**Verification that counts happens on the servers, by a human or an agent with SSH + the live
API.** Local runs are a double test against capabilities local does not have. Concretely:

- CI (tests, lints, `next build`) is the merge bar and proves *logic* — a green CI suite caps a
  ticket's claim at **PROTOTYPED**. The **DEV-VERIFIED** claim for this capability belongs to
  PRV-07's live leg alone, on the real boxes, end to end.
- Ship-to-verify rides the standing pipeline: merge → `git push --tags` → signed GHCR images →
  the boxes. **Server hard rules apply to every verification step:** check tag parity FIRST
  (`.env` `GAIADA_TAG`/`APP_VERSION` go stale, so any bare `up -d` silently rolls a service
  back — trust `docker inspect`, not `/health`); **never `--remove-orphans`** (it deletes
  out-of-profile project containers); the server compose set is ALWAYS
  `-f docker-compose.vps.yml -f docker-compose.hostdata.yml` (Postgres/Redis run on the host —
  the vps file alone is an invalid project); n8n is a **separate compose project** (import
  workflows through its console at `/n8n/`, triggers stay outside the basic-auth gate); Cerbos
  policy changes deploy to the box but **require a service restart** to load.
- Live-API steps authenticate as a real user via `scripts/sso-login.sh` (real auth-code+PKCE)
  and talk to platform-nest **on the box**, not the public vhost, where the runbook says so.

### Buildable now (no credential, no provision change — CI-proven against the PRV-00 mock; claims cap at PROTOTYPED until PRV-07)

| # | Ticket | Seat · model | Files (primary) | Deps | Done when (AC) |
|---|---|---|---|---|---|
| PRV-00 | **Mock provision fixture**: a tiny HTTP fixture implementing the §04 provision contract (`/api/users/login`, `/api/provision` incl. 202/400/401/409 arms, `/api/projects` find/byId) with scriptable status progression + failure modes (409-foreign, stuck-pending, SSL-stuck) for use by PRV-02/05 suites | junior · default | `platform-nest/test/fixtures/mock-provision.ts` (or sibling test-util path) | — | Fixture serves all four shapes; failure modes switchable per test; used by at least one passing smoke test; zero real network egress |
| PRV-01 | **Migration `webdev_provisioned_sites`** per §05: composite tenant FK (reuse 0088's `ux_pipeline_runs_id_tenant`), partial uniques, slug CHECK, third-wall FORCE RLS, ships empty | senior-db · default | `platform-nest/migrations/NNNN_webdev_provisioned_sites.sql` (**next-unused at merge**) | — | Applies from scratch + on the seeded DB; RLS probes: no-GUC ⇒ zero rows, wrong-module scope ⇒ zero rows (the two-sided handshake asserted both ways); partial-unique proven (second non-failed row for a run refused; a `failed` row does NOT block a retry row); `npm run lint:migration-rls` green |
| PRV-02 ⚡ | **`webdev` module shell + provisioning service**: ModuleContract shell (key, guard, McpToolDef `webdev.provisionSite` write/medium); `ProvisionProvider` interface + `provision-http` driver (login/JWT-cache/re-login-on-401, fail-closed unset env); `POST …/provision` with `lockPipelineRun` + precondition re-read + slug derivation (parity function) + framework/stack refusal (422 `unsupported_stack`); poller + status mapping; **409 adopt-only-if-ours vs `slug_conflict_foreign`**; reconcile endpoint; outbox events | senior-be · **opus·medium** — the idempotency/adoption core across a process boundary: a wrong call here double-creates public infrastructure or **adopts another client's site**; the race tests are the ticket | `platform-nest/src/modules/webdev/*` (new), `src/events/*` (event types) | PRV-00, PRV-01 | Double-fire race test (two concurrent POSTs, one row, one egress — proven against the mock with an injected barrier); D14-style precondition unit-tested for every arm (blocked run, undecided gate, existing row); 409-foreign refused + notified, 409-ours adopted; poll timeout lands `failed/poll_timeout` and reconcile flips it forward; env unset ⇒ 503-fail-closed, regression-pinned; module absent from `app.scopes` ⇒ zero rows (proves the controller declares `modules:['webdev']`) |
| PRV-03 ⚡ | **Automation path**: `wf:delivery` allowlist entry + hub Cerbos `mcp_tool` policy (+ container restart step in the ticket runbook); D14 executable-registry entry (lockKey runId, §04 precondition); Zone A Cerbos `webdev_provisioned_site` policy + `lib/rbac.ts` mirror; n8n `wd-provision.json` + `wd-provision-reconcile.json` (bridge fan-out to a second gate.decided consumer verified at build) | senior-integrator · default | `mcp-hub/src/automation-policy.ts`, hub policy dir, `platform-nest/src/core/approval-executables.ts`, `platform-nest/cerbos/policies/*`, `automation/workflows/wd-provision{,-reconcile}.json` | PRV-02 | Automation call suspends (never executes direct) — asserted; approve **executes as the original principal** and the mirror row lands (D14 semantics probed end-to-end vs the mock); reject leaves zero side effects; precondition-failed at execute time lands the typed reason on the approval row; staff principal skips suspension but hits Cerbos (deny matrix for member role); n8n JSONs import clean **into the server's n8n project** (separate compose project; console at `/n8n/`; triggers outside the basic-auth gate) and the ticket runbook carries the **Cerbos-restart-on-the-box** step for both policy files |
| PRV-04 | **Run-workspace "Site & repo" card** (platform-ui): status chip + links + Provision action (framework picker, slug override) + WS4-in-flight state + failure-reason surface; DEMO fixtures; BFF contract rows (claim the § at merge) | senior-fe · default | `platform-ui/src/lib/` (new shapes + actions), run-workspace components, `docs/FRONTEND-BFF-CONTRACT.md` | PRV-02 | Every §06 UI state renderable in DEMO_MODE; action disabled states match Cerbos verdicts; degraded (backend-down) state honest; tsc + unit + e2e green |
| PRV-05 ⚡ | **CI gate (vs mock)**: the full battery — double-fire, 409 both arms, D14 suspend/approve/execute/reject, precondition matrix, RLS third-wall probes, slug-parity assertion against the workflow expression string, `github.repoStatus` gate satisfied post-provision (mock GitHub or assertion on stored repo_url), fail-closed env sweep, **secret-hygiene grep** (no PAT/SSH/`GITHUB_TOKEN` provision-side names anywhere in ERP code or env samples) | qa · default | evidence doc per house pattern | PRV-00…04 | Written evidence per check, all discharged in CI (no local-stack dependency); zero critical findings; **caps the capability at PROTOTYPED** — DEV-VERIFIED belongs to PRV-07's server leg only |

**Waves:** W1 `PRV-00 ∥ PRV-01` → W2 `PRV-02` (alone, opus) → W3 `PRV-03 ∥ PRV-04` → W4 `PRV-05`
(gate, alone) → [credential] `PRV-07` → [owner decisions] `PRV-08/09/10`.

### Blocked — needs a credential or an owner decision (do not start; listed so nothing is invisible)

| # | Ticket | Seat · model | Blocked on | Done when (AC) |
|---|---|---|---|---|
| PRV-07 ⚡ | **Live wiring + server E2E (the verification that counts)**: owner creates the `erp-service` provision account (P-2 demo creds rotated first — OQ-P2); env onto **gda-aicenter** — value in `.env` AND the service's `environment:` block (the compose env-passthrough trap), applied under the server hard rules (tag parity FIRST, both compose files, never `--remove-orphans`); `CREDENTIALS.local.md` + rotate-register entries; one real run end-to-end on a throwaway slug (`erp-seam-test-*`); manual decommission per the provision runbook afterwards | devops · default | **credential** (service account) + P-2 rotation | All discharged **on the boxes**: (1) drive a real `prd_sign` decision + approval as a real user via `scripts/sso-login.sh` against platform-nest on gda-aicenter; (2) mirror row reaches `live` (live API read, remembering a missing field reads as NULL — assert the columns, not just a 200); (3) **SSH gda-s01**: vhost file + `sites-enabled` symlink exist, `/var/www/<slug>` owned `azlan:azlan`, cert live (`sudo certbot certificates` or `curl -vI https://<slug>.gaiada.online`); (4) repo exists private under `Gaia-Digital-Agency` and `github.repoStatus(slug)` returns exists through the hub; (5) hop-down drill: with the credential temporarily revoked, a provision attempt lands `failed/egress_error` + notification and the pipeline is not blocked; (6) teardown completed + evidenced; running services verified via `docker inspect` tags, not `/health`. Capability may then claim **DEV-VERIFIED (live)** |
| PRV-08 | **provision-side auth hardening (provision repo — ships to prod on merge, mind its git-pull deploy):** role/service gate on `POST /api/provision` (close P-1), rotate/remove the login-screen demo creds (P-2), `.env.example` truth pass (P-6) | senior-be · default | **owner decision to modify provision** (OQ-P2) | ERP service + admin can provision; a plain new `developer` cannot (or per owner's chosen policy); demo creds gone from the UI and rotated; deployed via its own pipeline without breaking the SPA flow |
| PRV-09 | **KC offline-JWT verify in provision** (the WSK-22 shape): middleware verifying `Bearer` against the public issuer JWKS, audience `provision-control`; owner action: create the confidential client (the shipped `gaiada-provisioner` is the precedent — different client, don't reuse); ERP driver switches from password-login to client-credentials | senior-integrator · default | **owner decision** + KC client (owner action) | provision accepts a valid client-credentials token and refuses: expired / wrong-audience / wrong-issuer / password-path-disabled-for-service (matrix); provision still holds zero ERP secrets (env grep); ERP driver swap behind the same `ProvisionProvider` interface |
| PRV-10 | **Optional hardening pair (evaluate at webdesk P4, not before):** (a) signed fact webhooks provision→n8n bridge (HMAC raw-bytes + event id, the webdesk channel-1 shape) replacing polling; (b) P-3 fix — per-repo deploy keys or an `rrsync`-forced restricted key instead of the fleet key fan-out | senior-integrator · default | **owner decision** (both touch provision + its templates/fleet) | (a) forged/replayed webhooks refused before parse; polling demoted to backstop; (b) a provisioned repo's CI can write ONLY its own `/var/www/<name>` (probe) |

---

## §08 · Open questions (owner decisions — each with a default)

| # | Question | Blocks | Default if unanswered |
|---|---|---|---|
| OQ-P1 | **Trigger timing:** auto-propose at `prd_sign` decided (owner's words), or hold until scope dual-sign (the commercial gate)? | nothing (one predicate either way) | **`prd_sign`**, with the WS4 approver holding discretion; add the `scope.signed` predicate later if pre-scope provisions ever cause regret |
| OQ-P2 | **May the program modify the provision repo** (PRV-08/09), given its push-to-main-deploys-to-prod model? And: rotate the P-2 demo creds now or at PRV-07? | PRV-08/09; PRV-07 start | **Yes to minimal hardening; rotate P-2 before any live wiring.** PRV-07 does not start with a credential advertised on a public login page |
| OQ-P3 | **P-3 (fleet SSH key fan-out):** accept for v1 or pull PRV-10(b) forward? | PRV-10(b) | **Accept for v1, register it**; the structural fix arrives with webdesk absorption — spending it twice is waste unless a provisioned-repo compromise becomes plausible sooner |
| OQ-P4 | **Who picks the framework** and is `vite` the right default while P-7 stands? | PRV-02 param defaults | **Approver/staff picks at action time; default `vite`** |
| OQ-P5 | **provision's end-state at webdesk P6:** keep as the zero-backend static tier, or fold static hosting into webdesk and retire it? | nothing now | **Defer to webdesk P6 exit** — the provider column keeps both futures one driver away |
| OQ-P6 | **Ratify the WS11-lock amendment:** repo creation stays manual *except* through this scoped, WS4-gated, template-only path; `github.createRepo` (the generic tool) stays fail-closed forever | PRV-03 (the n8n auto-path) | **Ratify as scoped.** The original lock's target was an ungated generic tool in agent reach; this path is narrower than what a PM does by hand today |

---

## §09 · Decision log (new decisions; overturn only with cause)

| # | Decision | Why |
|---|---|---|
| D-P1 | **provision stays a separate tool behind a shared, webdesk-shaped contract; absorption into webdesk at its P4+ is the direction, executed as a driver swap** | §02 in full: wrong substrate for (a); nothing to absorb into for (b); the seam work is webdesk P4 work either way |
| D-P2 | **Provider abstraction from day one:** `provider ∈ {provision, webdesk}` on the mirror row + a `ProvisionProvider` driver interface | Makes D-P1's migration direction a column value + a class, not a redesign; the console, tool name, approvals, and table survive the swap |
| D-P3 | **Trigger = `prd_sign` decided → automation proposes → WS4 suspension is the human beat → D14 executes as original principal; manual staff action rides Cerbos without a second beat** | Matches the owner's ask, D14 doctrine (automation suspends, humans act), and the webdesk §07 classification of `site.provision` as medium-write-WS4-for-automation; a human is in every loop |
| D-P4 | **The GitHub PAT and fleet SSH key never enter Zone A; v1 has no B′→A channel (poll-only); provision holds zero ERP credentials** | The containment statement in §03 — the seam must not widen either zone's blast radius |
| D-P5 | **Idempotency is two-layer (ERP partial-unique + lock + precondition re-check; provision name-unique + repo-exists) with 409 adopt-only-if-ours** | The house rule (a lock without a server-side precondition re-check does nothing) plus the tenancy edge unique to a global-namespace far side |
| D-P6 | **`github.createRepo` stays fail-closed; this seam is a scoped alternative, not an enablement** — flagged as an explicit WS11-lock amendment for ratification (OQ-P6) | Preserves the lock's intent (no generic repo-creation in agent reach) while delivering the owner's ask through a gated, template-only, one-per-run path |
| D-P7 | **Unsupported stacks (WordPress/full-stack) are refused-with-routing, never downgraded** | provision cannot express them (verified); silently shipping a static site against a WP PRD is a client-facing lie; the refusal is the demand signal for webdesk P6 |
| D-P8 | **One slug grammar, one derivation function, parity-tested against the delivery workflow's expression** | The `repoStatus` gate passing with zero workflow changes is the seam's cheapest win and silently breaks the moment two derivations drift |
| D-P9 | **v1 uses a provision service account (password login), upgraded to KC client-credentials offline-verify (PRV-09) — never a shared human credential** | Smallest correct step now (zero provision changes), converging on the exact WSK-22 shape so the webdesk driver inherits real auth |

---

*Cross-references:* [`webdesk-design.md`](./webdesk-design.md) (§03 control channel · §06 rail ·
WSK-19/22/23) · [`webdev-design.md`](./webdev-design.md) (§03 zones · §05 frozen envelope · §07
gate spine · WS11 locks) · [`webdev-foundation.md`](./webdev-foundation.md) ·
[`../FRONTEND-BFF-CONTRACT.md`](../FRONTEND-BFF-CONTRACT.md) ·
[`../modules/MODULES.md`](../modules/MODULES.md) ·
[migrations numbering protocol](../../platform-nest/migrations/README.md) ·
`platform-nest/src/core/{pipeline.controller.ts, pipeline-lock.ts, approval-executables.ts}` ·
`mcp-hub/src/{delivery-tools.ts, automation-policy.ts}` ·
provision repo (read-only input): `backend/src/endpoints/provisionProject.ts`,
`backend/src/payload.config.ts`, `backend/src/collections/{Prds,Projects,Users}.ts`,
`docs/{architecture,handover,todo}.md`.
