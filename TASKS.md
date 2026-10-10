# TASKS — WebDesk + the gaiada.com CMS

**Overall** <!-- bar:overall -->🟡 `████████████░░░░░░░░░░░░░░░░░░` **39%** · 67/170<!-- /bar -->

Last updated <!-- updated -->2026-10-10<!-- /updated --> · Goal: finish WebDesk properly, with gaiada.com as the first site run from it.

**How this file works**
- A box is ticked **only when the item is verified**: driven on a Linux server and the result observed (DEV-VERIFIED), or — for a decision or document — landed in the repo. Code that exists but is unverified stays unticked.
- Tick boxes in the **same change** that moves the work, then run `node scripts/tasks-progress.mjs`. Bars are computed from the boxes, never typed. `--check` fails when a bar is stale.
- Context, evidence and open questions: [`docs/plans/2026-10-10-webdesk-gaiada-proof.md`](docs/plans/2026-10-10-webdesk-gaiada-proof.md). Rulings: [`webdesk-design-v2.md`](docs/blueprints/webdesk-design-v2.md) §14.

---

## M0 · Decisions and record
<!-- bar -->🟡 `██████████████████░░` **90%** · 10/11<!-- /bar -->

### Rulings in the decision log <!-- bar -->✅ `██████████` **100%** · 7/7<!-- /bar -->
- [x] WSK-D37–D40 (2026-09-21: Payload removed, ERP identity for editors, the name, no per-seat tools) landed in v2.3 §14
- [x] WSK-D41 — gaiada.com is the P2 proof site
- [x] WSK-D42 — RustFS replaces MinIO
- [x] WSK-D43 — authority inside the `webdesk` project on gda-aicenter; `/v1` at `api.gaiada.online`
- [x] WSK-D44–D48 — `fields` block contract, draft ≠ live, publishing rules, channel + release authority, proof defaults
- [x] The colliding "D37" proposal in the replatform plan renumbered to next-free
- [x] Working tracker + this task board created

### Owner inputs <!-- bar -->🟡 `████████░░` **75%** · 3/4<!-- /bar -->
- [ ] GoDaddy A record `api.gaiada.online → 35.240.135.48` (owner)
- [x] Content-model questions answered: all 315 pages import, visibility states, locales `en` + `id` (D44, D48)
- [x] Write-plane design questions answered: self-publish, rebuild authority, channel steps, releases, defaults (D46–D48)
- [x] Read-only `BYPASSRLS` backup role approved (D48, WSK-68)

---

## M1 · gaiada.com served from WebDesk
<!-- bar -->🟡 `█████████████░░░░░░░` **66%** · 57/86<!-- /bar -->

### WSK-52 · RustFS replaces MinIO <!-- bar -->🟡 `█████████░` **87%** · 7/8<!-- /bar -->
- [x] RustFS `1.0.0` pinned by digest in every compose file, `/health` check, no host ports (resolved config)
- [x] Idempotent bootstrap: buckets, versioning, GOVERNANCE object lock, least-privilege api key (no `mc`)
- [x] The api refuses to boot without its own storage key or with the root key
- [x] Versioning + object lock proven with a negative control; service key refused bucket-policy writes
- [x] Presigned PUT/GET round-trip with `requestChecksumCalculation: "WHEN_REQUIRED"`
- [x] Backup + sentinel scripts off `mc`; a failed `pg_dump` no longer reports success
- [x] Full `webdesk/api` suite on Linux: 396 passed / 0 failed / 1 skipped
- [ ] CI `webdesk-api` job green on GitHub with RustFS

### WSK-48a · `/v1` moved out of Payload into `webdesk/api` <!-- bar -->🟡 `█████████░` **85%** · 6/7<!-- /bar -->
- [x] `delivery` module serves `/v1` byte-identically (raw Fastify route, router unchanged)
- [x] One API-key hash implementation; vocabulary vendored with a drift test
- [x] WSK-05 demo `content` controller retired with no loss of guard coverage
- [x] Caddy `/v1/*` → `api`; `payload-gateway` retired from compose and the status page
- [x] Differential gate on Linux: 696/710 pairs identical, 14 classified, 0 unexplained; contract 60/60; api suite 409/0/1
- [x] Combined suite after merging WSK-52 + WSK-48a green on Linux (418/0/1; differential 696/710, 0 unexplained; contract 60/60)
- [ ] Envelope + differential tests ported into `webdesk/api` and wired into CI

### WSK-53 · gaiada.com content inventory <!-- bar -->✅ `██████████` **100%** · 5/5<!-- /bar -->
- [x] 33 config modules classified field by field
- [x] 315 long-form pages by kind and language; front-matter schemas
- [x] Globals, media and placeholders counted
- [x] 16 vocabulary gaps with evidence
- [x] Stable ids for every page, home section, CTA and form

### WSK-62 · Write-plane design pass <!-- bar -->✅ `██████████` **100%** · 2/2<!-- /bar -->
- [x] Design doc: contract, draft/live, authoring + read commands, editorial assertion, Cerbos, loader principal, rebuild path, control channel
- [x] Reviewed (claims checked against `breaking-change.ts` and the contract test); rulings landed as D44–D48

### WSK-56 · Deploy to gda-aicenter (`webdesk` project only) <!-- bar -->🟡 `███████░░░` **72%** · 8/11<!-- /bar -->
- [x] Backup of the WebDesk database, env and tree (`~/webdesk-backups/20261010T034039Z`)
- [x] Verification tenants removed (250 `wsk<n>-*` fixtures; none other existed)
- [x] RustFS up from the pinned digest and bootstrapped (16 changes, then 0); MinIO container removed
- [x] New api live; `payload-gateway` removed; proxy recreated onto the new Caddyfile
- [x] Defect fixed: compose gave the api `DATABASE_URL` but it reads `APP_DATABASE_URL` — the live api had never had a database
- [x] Defect fixed: every table was owned by `postgres` and `webdesk_app` had 0 grants — DB rebuilt as the repo intends (migrator-owned, 74 app grants, revokes intact, RLS integrity 19/19)
- [x] `/v1` answers on the loopback proxy (401 problem+json for an unknown tenant; lockdown 404s intact)
- [ ] `api.gaiada.online` vhost enabled with TLS (after the A record)
- [x] The api image on the box built off the live box (sumopod `webdesk-api:1cbee520`, transferred in 30 s)
- [ ] The api image signed via a release
- [ ] ERP egress client's own live probe from `gaiada-platform-1` (needs the release that ships WSK-63b + its compose `extra_hosts`)

### WSK-69 · GitHub build time cut before the first release (owner condition, D47) <!-- bar -->🟡 `██░░░░░░░░` **20%** · 1/5<!-- /bar -->
- [x] Baseline measured: CI ≈ 34 billed min (21 jobs) + release ≈ 24 min (12 image builds + deploy) per cycle
- [ ] CI runs only the jobs whose component changed; superseded runs are cancelled
- [ ] Release builds only changed components; unchanged images re-tagged by digest, signatures intact
- [ ] Dependency and Docker layer caching
- [ ] Billed minutes for a WebDesk-only change measured after, and recorded

### Wave A · WSK-64 · Vocabulary 1.1.0 <!-- bar -->✅ `██████████` **100%** · 4/4<!-- /bar -->
- [x] Classifier extended (group recursion, scalar `multiple`, `localized`, `ui`) with negative controls (1.0.0 rated them PATCH; now MAJOR)
- [x] 1.0.0 → 1.1.0 computes MINOR; `envelope.ts` untouched; contract test unchanged and green (60/60)
- [x] `validateItemContent` (52 table cases; 108/108) and the composition validator
- [x] Codegen + every vendored copy (api delivery, schema-draft, blocks) re-vendored; drift checks green on Linux (api 428/0/1; codegen determinism gate passed)

### Wave A · WSK-65 · Migration 0009 (write plane) <!-- bar -->✅ `██████████` **100%** · 3/3<!-- /bar -->
- [x] Applies on 0001–0008, idempotent; fails loudly on seeded duplicates (negative controls) — 96/96 checks; refuses non-migrator-owned tables
- [x] RLS integrity includes `control_idempotency_keys` (20 tables); cross-tenant probe with a positive control
- [x] Every existing suite green after 0009 (api 419/0/0; `/v1` bytes 32/32 identical; contract 60/60)

### Wave A · WSK-63 · The control channel made real <!-- bar -->✅ `██████████` **100%** · 4/4<!-- /bar -->
- [x] Internal vhost `control.webdesk.internal`: mTLS, verified-cert header overwrite, Caddy gate header; no new host port (live on 172.17.0.1:9443 only)
- [x] On the box: Keycloak client `webdesk-control`, client + server certs from the internal CA, NTP offset < 1 s (token: aud `webdesk-control-plane`, four `webdesk:*` scopes)
- [x] ERP egress client: shared hash vectors, single-flight token cache, circuit breaker, no secret in logs (42/42 + 7/7 on Linux)
- [x] Live: certificate + token reach the contract handler; no cert / foreign CA → 400 at nginx; forged cert + gate headers overwritten (Layer 2 answers, never Layer 1); garbage token → 401 Layer 2

### Wave A · WSK-47 · Cerbos kinds <!-- bar -->🟡 `████████░░` **75%** · 3/4<!-- /bar -->
- [x] `webdesk_content_item` + `webdesk_collection`; maker ≠ checker, single-item self-publish (D46); publish/schedule without an approval denied for every principal
- [x] Six artifacts and re-derived pinned counts in one change (kinds 101, catalog 416, grantable 401)
- [x] `src/rbac` suite green on Linux with Cerbos reachable (849/849, 0 skipped; 41-row probe matrix)
- [ ] Live Cerbos restarted; the probe matrix matches

### Wave A · WSK-54 · Bundle export (site repo) <!-- bar -->✅ `██████████` **100%** · 3/3<!-- /bar -->
- [x] Two exports of one commit are byte-identical (site `webdesk-importer` @ `10c2d21`; content sha256 `3a23fc70…` twice)
- [x] Every page and global round-trips to what the site's own loader reads (315/315 exact against Astro's `getEntryInfo`; 22/22 tests on Linux)
- [x] Every item validates against vocabulary 1.1.0 (326 items, 17 compositions, 0 invalid, 0 disagreements — Linux, site `5b4476a`)

### Wave B · WSK-41 · Authoring commands <!-- bar -->✅ `██████████` **100%** · 5/5<!-- /bar -->
- [x] Seven commands with impact classes in the registry; real `AppModule` boots (api 524/0/1)
- [x] Draft isolation: publish is the only way to change what a production key sees
- [x] Concurrency (1×200, 9×409) and durable idempotency across a restart
- [x] Gate order proven with valid bodies; WS4 single-use under concurrency (claimed in the same transaction as the effect)
- [x] `content.published` webhook event without prop values (2 deliveries to 2 enabled hooks; raw body carries no values)

### Wave B · WSK-41b · The read path hides deleted drafts <!-- bar -->✅ `██████████` **100%** · 1/1<!-- /bar -->
- [x] Deleted draft 404 on item, list, search, sitemap; localizations exclude it; envelope gate unchanged (api 450/0/2; contract 60/60)

### Wave B · WSK-51 · Read commands <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/2<!-- /bar -->
- [ ] Eight reads; cross-tenant 404 with a positive control
- [ ] No audit rows written; pagination stable under a concurrent update

### Wave B · WSK-40 · Editorial assertion <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/3<!-- /bar -->
- [ ] Adversarial matrix of ≥ 20 rows, each with its exact problem slug
- [ ] Signer and verifier pin the same vectors, both directions
- [ ] Key rotation runbook executed once (overlap accepted, old kid refused after)

### Wave B · WSK-66 · Publish and key mint executed at approval <!-- bar -->✅ `██████████` **100%** · 5/5<!-- /bar -->
- [x] Origin migration unions `webdesk` into the live CHECK (no value lost; planted-value regression test)
- [x] Requester ≠ approver, except a single-item self-publish (D46); 0 Zone B calls on every denial
- [x] Approve → exactly one publish carrying WS4 + editorial assertions; failures typed, never retried blind (stub mTLS Zone B; tampered `tool_args` refused)
- [x] `key.mint` plaintext only in the `decide()` response, never persisted (DB + log scans)

- [x] Fix the platform_admin parity sweep (`authz-permissions.controller.test.ts`) that WSK-47's deny-without-approval rule turned red (31/31; negative control red on a broken unrelated grant; full nest 7453 passed)
### Wave C · WSK-59 · ERP content BFF + MCP tools <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/3<!-- /bar -->
- [ ] Routes with `authorize()` first; cross-company 404 wall with a positive control
- [ ] Every editor action is an MCP tool with an impact class; both D14 halves for unpublish/delete
- [ ] BFF contract §27; breaker open → `editorial_unavailable`

### Wave C · WSK-57 · Provision the gaiada tenant (over the channel) <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/3<!-- /bar -->
- [ ] Tenant `gaiada`, site `gaiada-com`, staging + production environments
- [ ] Build key (production read) minted through an approval; preview key (staging read)
- [ ] Read quota sized for a full site build

### Wave C · WSK-67 · Importer CLI <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/3<!-- /bar -->
- [ ] Dry run prints the plan; `--apply` twice → second run writes 0 versions
- [ ] Refuses human principals; imports no publish/unpublish/delete function
- [ ] One batch publish approval filed and approved; gaiada.com content live on `/v1`

### Wave C · WSK-55 · The site builds from `/v1` (gaiada-web-revamp) <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/4<!-- /bar -->
- [ ] Two git builds of one commit give an identical `dist/` (determinism first)
- [ ] Source parity on all 315 files
- [ ] `dist/` parity: empty diff in default and preview-held modes
- [ ] The site's own gates pass; negative control (one FAQ edit → exactly one page differs)

### WSK-58 · Linux gate for the proof's suites <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/1<!-- /bar -->
- [ ] `webdesk/api`, `webdesk/blocks`, `webdesk` root and vocabulary suites green on sumopod after every merge

---

## M2 · Editing gaiada.com from the ERP
<!-- bar -->⬜ `░░░░░░░░░░░░░░░░░░░░` **0%** · 0/14<!-- /bar -->

### WSK-44 · "Website" workspace in platform-ui <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/7<!-- /bar -->
- [ ] Sites → collections → items for gaiada.com
- [ ] Editor generated from the composition: text, Markdown, groups, lists (drag and keyboard reorder)
- [ ] Publish with the approval state shown inline
- [ ] Version history with restore as draft
- [ ] Unavailable / stale / conflict states (never a confident empty editor)
- [ ] Every state reachable in Playwright; `next build` passes
- [ ] Re-verified against the REAL BFF once WSK-59 lands (every field the UI reads diffed against a live response — built on a stub first)

### WSK-60 · Publish → rebuild → staging <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/4<!-- /bar -->
- [ ] Restricted deploy user on delphi (forced command swaps the `24-pyevq` docroot only)
- [ ] ERP GitHub App on the site repo; `webdesk-rebuild` workflow
- [ ] An approved publish dispatches exactly one run; the stamp poll marks "live on staging" honestly
- [ ] Cost per run measured and recorded

### P2 proof gate <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/3<!-- /bar -->
- [ ] A staff member edits gaiada.com in the ERP, publishes, and the staging site shows the change
- [ ] Page-for-page parity holds after the edit cycle
- [ ] The editor cannot approve a batch; the same approval re-presented is refused; `/control/*` is 404 publicly

---

## M3 · A complete CMS, Payload removed
<!-- bar -->⬜ `░░░░░░░░░░░░░░░░░░░░` **0%** · 0/28<!-- /bar -->

### WSK-48b · Delete Payload <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/3<!-- /bar -->
- [ ] Payload app, dependencies and the `payload` service removed
- [ ] Forward migration drops `pages`, `users`, `payload_*`
- [ ] `webdesk/payload/` renamed `webdesk/delivery/` (WSK-D38); vendored vocabulary becomes the source

### CMS features <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/6<!-- /bar -->
- [ ] WSK-46 · preview links for drafts
- [ ] WSK-61 · scheduled publish worker (+ the forms retention purge schedule)
- [ ] WSK-45 · rich-text editor; storage format ruled (OQ-3.1)
- [ ] WSK-43 · media library
- [ ] WSK-64 · CDN cache purge on publish
- [ ] WSK-49 · client editors through the client portal

### Defects found on the way <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/19<!-- /bar -->
- [ ] Reserved collection keys (`media`, `forms` collide with api routes)
- [ ] Slugs are never percent-decoded (non-ASCII slugs unreachable)
- [ ] A bad cursor returns 500 with the raw database message
- [ ] Undecodable `%` in a path gets Fastify's 400, not a problem+json body
- [ ] Locked object versions are never freed (no lifecycle rule; quota counts rows, not bytes)
- [ ] The privacy residency statement still names MinIO to customers
- [ ] `check-artifact-url-expiry.mjs` still starts a MinIO container
- [ ] In-memory read quota and idempotency under-enforce with more than one api replica
- [ ] Older HIGH commands (WSK-21/25/38) write the audit row after the side effect: a concurrent approval reuse now 500s but the effect already ran — claim the approval first
- [ ] Promotion bundle import can hit `ux_content_items_group_locale` (inserts before deletes; upserts on slug)
- [ ] `UNIQUE (collection_id, locale, slug)` ignores soft delete — a deleted item holds its slug forever (senior-db decision)
- [ ] Idempotency expiry sweep must run per tenant + once at platform scope; reads treat expired rows as absent
- [ ] Hard deletes of `content_items` (bundle restore) will fail on the `content_versions` FK once versions are written
- [ ] `webdesk_app` can write `schema_migrations` via default privileges — revoke in a later migration
- [ ] Codegen `versioning.mts` drops `singleton`/`localized`/`ui`/`lint` from the tenant-contract snapshot (flips go unrated)
- [ ] WordPress theme vocabulary drift (9 vs 10 block names); naive re-vendor breaks `block-renderer.php` on `fields`
- [ ] Codegen generic `oneOf` is ambiguous (a known block also matches the unknown branch) — should be `anyOf`
- [ ] `schema-draft/prompt.ts` does not teach the model `group`/`itemKey`/`fields` (fails closed today)
- [ ] Not ours, flagged: `agency-lead-convert-race.db.test.ts` is flaky (failed 1 of 3 identical runs) and `monitoring.controller.test.ts` is a date time bomb (red since ~09-17) — both red on main, owners elsewhere

---

## M4 · WebDesk production-ready
<!-- bar -->⬜ `░░░░░░░░░░░░░░░░░░░░` **0%** · 0/14<!-- /bar -->

### P1 · Linux verification of everything that survives <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/2<!-- /bar -->
- [ ] Every provisional green from August 2026 re-run on Linux (minus what D37 deletes)
- [ ] `webdesk` has its own deploy step in CI (signed image, never inside the `gaiada` project)

### Containment probes on gda-aicenter (§03, WSK-D34) <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/6<!-- /bar -->
- [ ] Resolved-config port audit
- [ ] nginx → loopback Caddy routing; `:80`/`:443` still nginx's
- [ ] Host Postgres unreachable from a webdesk container (with a negative control)
- [ ] CPU, memory and pids limits on every service
- [ ] `--remove-orphans` on the ERP project cannot reach `webdesk`
- [ ] Egress sweep: no ERP credential, no route to an ERP service

### Operations <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/6<!-- /bar -->
- [ ] Deploy procedure committed: LF-safe shipping (`git -c core.autocrlf=false archive`), images built off the live box
- [ ] WSK-68 · backup role, nightly backup producing a real dump
- [ ] Restore drill from a backup, timed
- [ ] OTel to sumopod; status page live
- [ ] Stale WebDesk copy on sumopod retired
- [ ] Per-tenant cost and quotas written (A-10 / OQ-2.7)

---

## M5 · gaiada.com admin panel beyond content (handoff phases)
<!-- bar -->⬜ `░░░░░░░░░░░░░░░░░░░░` **0%** · 0/13<!-- /bar -->

### Analytics (phase 0 / 5) <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/4<!-- /bar -->
- [ ] OQ-5 ruled: Umami unparked
- [ ] Umami deployed; one website per property; ERP reads with a read-only token
- [ ] Section, CTA and form events from the site tracker land
- [ ] Website-visitor DPIA/LIA addendum drafted for counsel

### Writers' room (phase 2) <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/3<!-- /bar -->
- [ ] Roles: writer, editor, SEO reviewer, translator, publisher
- [ ] Brief → draft → review → approve → schedule flow
- [ ] On-save checks (placeholders, SEO/AEO, ID twin)

### Leads into the ERP (phase 3) <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/3<!-- /bar -->
- [ ] Contact, audit and onboard forms on the WebDesk forms API (field ids kept)
- [ ] Attribution on every submission
- [ ] `form.received` → `agency_leads` + WhatsApp alert (needs legal Gate 1)

### Ad loop and visitor intelligence (phases 4–5) <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/3<!-- /bar -->
- [ ] Lead stage + deal value in platform-nest
- [ ] Google Ads / Meta / LinkedIn conversion uploads (WS4-gated)
- [ ] Enrichment collector (IP dropped after lookup)

---

## M6 · WebDesk platform phases after the proof (v2.3 §12)
<!-- bar -->⬜ `░░░░░░░░░░░░░░░░░░░░` **0%** · 0/4<!-- /bar -->

### P3 · Portfolio <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/1<!-- /bar -->
- [ ] SM-70 import → SM-74 hosting topology → MON-01 probes → registry console

### P4 · Repo control <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/1<!-- /bar -->
- [ ] Three kinds, refusals lifted together, org credential, both gates, staff button

### P5 · Headless WordPress <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/1<!-- /bar -->
- [ ] A WordPress site renders entirely from `/v1`

### P6 · Client delivery <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/1<!-- /bar -->
- [ ] Deploy identity and hosting for client frontends
