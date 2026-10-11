# TASKS — WebDesk + the gaiada.com CMS

**Overall** <!-- bar:overall -->🟡 `███████████████████░░░░░░░░░░░` **64%** · 144/225<!-- /bar -->

Last updated <!-- updated -->2026-10-11<!-- /updated --> · Goal: finish WebDesk properly, with gaiada.com as the first site run from it.

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
- [ ] Hostinger DNS A record `api.gaiada.com → 35.240.135.48` (owner; D43 amended 2026-10-11 — was `api.gaiada.online` at GoDaddy, never created)
- [x] Content-model questions answered: all 315 pages import, visibility states, locales `en` + `id` (D44, D48)
- [x] Write-plane design questions answered: self-publish, rebuild authority, channel steps, releases, defaults (D46–D48)
- [x] Read-only `BYPASSRLS` backup role approved (D48, WSK-68)

---

## M1 · gaiada.com served from WebDesk
<!-- bar -->🟡 `█████████████████░░░` **87%** · 81/93<!-- /bar -->

### WSK-52 · RustFS replaces MinIO <!-- bar -->🟡 `█████████░` **87%** · 7/8<!-- /bar -->
- [x] RustFS `1.0.0` pinned by digest in every compose file, `/health` check, no host ports (resolved config)
- [x] Idempotent bootstrap: buckets, versioning, GOVERNANCE object lock, least-privilege api key (no `mc`)
- [x] The api refuses to boot without its own storage key or with the root key
- [x] Versioning + object lock proven with a negative control; service key refused bucket-policy writes
- [x] Presigned PUT/GET round-trip with `requestChecksumCalculation: "WHEN_REQUIRED"`
- [x] Backup + sentinel scripts off `mc`; a failed `pg_dump` no longer reports success
- [x] Full `webdesk/api` suite on Linux: 396 passed / 0 failed / 1 skipped
- [ ] CI `webdesk-api` job green on GitHub with RustFS

### WSK-48a · `/v1` moved out of Payload into `webdesk/api` <!-- bar -->✅ `██████████` **100%** · 7/7<!-- /bar -->
- [x] `delivery` module serves `/v1` byte-identically (raw Fastify route, router unchanged)
- [x] One API-key hash implementation; vocabulary vendored with a drift test
- [x] WSK-05 demo `content` controller retired with no loss of guard coverage
- [x] Caddy `/v1/*` → `api`; `payload-gateway` retired from compose and the status page
- [x] Differential gate on Linux: 696/710 pairs identical, 14 classified, 0 unexplained; contract 60/60; api suite 409/0/1
- [x] Combined suite after merging WSK-52 + WSK-48a green on Linux (418/0/1; differential 696/710, 0 unexplained; contract 60/60)
- [x] Envelope + differential tests ported into `webdesk/api` and wired into CI (release gate on sumopod 2026-10-11: webdesk-api 643/0/2 incl. the ported specs)

### WSK-53 · gaiada.com content inventory <!-- bar -->✅ `██████████` **100%** · 5/5<!-- /bar -->
- [x] 33 config modules classified field by field
- [x] 315 long-form pages by kind and language; front-matter schemas
- [x] Globals, media and placeholders counted
- [x] 16 vocabulary gaps with evidence
- [x] Stable ids for every page, home section, CTA and form

### WSK-62 · Write-plane design pass <!-- bar -->✅ `██████████` **100%** · 2/2<!-- /bar -->
- [x] Design doc: contract, draft/live, authoring + read commands, editorial assertion, Cerbos, loader principal, rebuild path, control channel
- [x] Reviewed (claims checked against `breaking-change.ts` and the contract test); rulings landed as D44–D48

### WSK-56 · Deploy to gda-aicenter (`webdesk` project only) <!-- bar -->🟡 `████████░░` **83%** · 10/12<!-- /bar -->
- [x] Backup of the WebDesk database, env and tree (`~/webdesk-backups/20261010T034039Z`)
- [x] Verification tenants removed (250 `wsk<n>-*` fixtures; none other existed)
- [x] RustFS up from the pinned digest and bootstrapped (16 changes, then 0); MinIO container removed
- [x] New api live; `payload-gateway` removed; proxy recreated onto the new Caddyfile
- [x] Defect fixed: compose gave the api `DATABASE_URL` but it reads `APP_DATABASE_URL` — the live api had never had a database
- [x] Defect fixed: every table was owned by `postgres` and `webdesk_app` had 0 grants — DB rebuilt as the repo intends (migrator-owned, 74 app grants, revokes intact, RLS integrity 19/19)
- [x] `/v1` answers on the loopback proxy (401 problem+json for an unknown tenant; lockdown 404s intact)
- [ ] `api.gaiada.com` vhost enabled with TLS (staged as `api.gaiada.com.conf` with token redaction and public 404s for /admin and /control; enable + certbot after the A record)
- [ ] DNS + TLS for the proof site `cms-proof.gaiada.com` → 72.61.142.88 (CloudPanel site created; certificate after the A record)
- [x] The api image on the box built off the live box (sumopod `webdesk-api:1cbee520`, transferred in 30 s)
- [x] The api image signed via a release (`v1.0.0-alpha.344`, cosign-verified digest `sha256:69abc934…`, live on gda-aicenter 2026-10-11)
- [x] ERP egress client's own live probe from `gaiada-platform-1` (344: all four layers reach WebDesk, `404 tenant not found` before provisioning; without the client cert, refused at Layer 1)

### WSK-69 · GitHub build time cut before the first release (owner condition, D47) <!-- bar -->🟡 `█░░░░░░░░░` **14%** · 1/7<!-- /bar -->
- [x] Baseline measured: CI ≈ 34 billed min (21 jobs) + release ≈ 24 min (12 image builds + deploy) per cycle
- [ ] CI runs only the jobs whose component changed; superseded runs are cancelled — first half PROVEN on main 2026-10-11 (347 push, run 38082096371: only the platform-nest jobs ran, 9 jobs skipped); superseded-run cancellation not yet observed
- [ ] Release builds only changed components; unchanged images re-tagged by digest, signatures intact — first real use (346, 2026-10-11) FAILED in retag: a single-manifest image was re-wrapped to a new digest (guard caught it, nothing deployed); fixed with `--prefer-index=false` (`proof branch`), unproven until a partial release retags; 349 (2026-10-11): the plan built ONLY platform-ui and re-tagged 10, and 7 re-tags kept their digests (the fix works, wa-chat-bot included); the 8th failed for a different reason (below), so not yet proven end to end; 351 (2026-10-11): the plan was right (3 builds, 8 retags) but `crane` got no credentials (distroless `nonroot` image never read the /root/.docker mount) — fixed for 352 (`bc637ac7`), reproduced and verified on Linux against GHCR
- [ ] GHCR prune deleted an untagged ATTESTATION of report-renderer `249e5e4c` (`f627854c`); its `sha256-<digest>` referrers index still lists it, so a referrer-walking copy fails (349's retag). The image itself pulls fine (GET manifest 200; corrected 2026-10-11, it is not an index). Prune DISABLED on main (`5cda7ea5`); retag switched to `crane tag` for 350 (`cc05fce7`)
- [ ] A reference-aware GHCR prune (never delete a digest that any tagged index lists) before re-enabling retention
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

### Wave A · WSK-47 · Cerbos kinds <!-- bar -->✅ `██████████` **100%** · 4/4<!-- /bar -->
- [x] `webdesk_content_item` + `webdesk_collection`; maker ≠ checker, single-item self-publish (D46); publish/schedule without an approval denied for every principal
- [x] Six artifacts and re-derived pinned counts in one change (kinds 101, catalog 416, grantable 401)
- [x] `src/rbac` suite green on Linux with Cerbos reachable (849/849, 0 skipped; 41-row probe matrix)
- [x] Live Cerbos restarted; the probe matrix matches (344 deploy restarted it; probe-wsk47: ALL ROWS AS EXPECTED)

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

### Wave B · WSK-51 · Read commands <!-- bar -->✅ `██████████` **100%** · 2/2<!-- /bar -->
- [x] Eight reads; cross-tenant 404 with a positive control (38/38; negative control 16 red; WSK-66 reconcile fields pinned)
- [x] No audit rows written; pagination stable under a concurrent update (api 568/0/1)

### Wave B · WSK-40 · Editorial assertion <!-- bar -->✅ `██████████` **100%** · 4/4<!-- /bar -->
- [x] Adversarial matrix of ≥ 20 rows, each with its exact problem slug (32 rows; JWKS loader 25 cases)
- [x] Signer and verifier pin the same vectors, both directions (+ end-to-end: an approved publish lands through real mTLS)
- [x] Key rotation runbook executed once on a dev stack (overlap accepted, old kid refused after)

- [x] Live keys provisioned on gda-aicenter (ERP signing key + WebDesk JWKS) and probes P1/P2 pass (kid `wde-2026-10`; P1 401 editorial-assertion-missing, P2 403 editorial-assertion-command-mismatch)
### Wave B · WSK-66 · Publish and key mint executed at approval <!-- bar -->✅ `██████████` **100%** · 5/5<!-- /bar -->
- [x] Origin migration unions `webdesk` into the live CHECK (no value lost; planted-value regression test)
- [x] Requester ≠ approver, except a single-item self-publish (D46); 0 Zone B calls on every denial
- [x] Approve → exactly one publish carrying WS4 + editorial assertions; failures typed, never retried blind (stub mTLS Zone B; tampered `tool_args` refused)
- [x] `key.mint` plaintext only in the `decide()` response, never persisted (DB + log scans)

- [x] Fix the platform_admin parity sweep (`authz-permissions.controller.test.ts`) that WSK-47's deny-without-approval rule turned red (31/31; negative control red on a broken unrelated grant; full nest 7453 passed)
### Wave C · WSK-59 · ERP content BFF + MCP tools <!-- bar -->✅ `██████████` **100%** · 4/4<!-- /bar -->
- [x] Routes with `authorize()` first; cross-company 404 wall with a positive control (12 routes; full nest 7564 passed)
- [x] Every editor action is an MCP tool with an impact class; both D14 halves for unpublish/delete (13 tools; unattended unpublish suspends + re-drives as the requester)
- [x] BFF contract §27; breaker open → `editorial_unavailable`; ambiguous writes reconcile by reading

- [x] Editors can read their own pending publish request (new `GET …/publish-requests`, own rows only, behind the wall)
### Wave C · WSK-57 · Provision the gaiada tenant (over the channel) <!-- bar -->🟡 `███░░░░░░░` **33%** · 1/3<!-- /bar -->
- [x] Tenant `gaiada`, site `gaiada-com`, staging + production environments (live 2026-10-11 over the control channel: tenant `b8ed45ee…` → ERP company Gaia Digital Agency; site `fc19fb0c-bc1d-4be0-af8b-b2ff9ce34c43`; staging `24-pyevq.gaiada.com`, production domain unset until the real-domain cutover)
- [ ] Build key (production read) minted through an approval; preview key (staging read) — production READ key minted 2026-10-11 (filed by the Anthony persona, approved by the owner; `/v1` 200 with it, 401 without); the staging preview key is still open
- [ ] Read quota sized for a full site build

### Wave C · WSK-67 · Importer CLI <!-- bar -->✅ `██████████` **100%** · 3/3<!-- /bar -->
- [x] Dry run prints the plan; `--apply` twice → second run writes 0 versions (real 326-item bundle; in-process Zone B fake)
- [x] Refuses human principals; imports no publish/unpublish/delete function (static test; Cerbos probe)
- [x] One batch publish approval filed and approved; gaiada.com content live on `/v1` — APPROVED by the owner 2026-10-11 (decided as hansel@gaiada.com; requested by the importer, so `selfPublish: false`): `content.publish` executed, 326/326 items live in WebDesk's live projection (what `/v1` serves). The staging rebuild recorded `failed: rebuild_not_configured` (honest: the site repo is not wired yet). An HTTP `/v1` read awaits a production read key

### Wave C · WSK-55 · The site builds from `/v1` (gaiada-web-revamp) <!-- bar -->🟡 `████████░░` **83%** · 5/6<!-- /bar -->
- [x] Two git builds of one commit give an identical `dist/` (determinism first) — 303 files, 0 differ
- [x] Source parity on all 315 files (Astro's parser; globals byte-identical; site `webdesk-parity` @ `b49b40a`)
- [x] `dist/` parity, default mode: 302 files, 0 differ
- [x] `dist/` parity, preview-held mode: 380 files, 0 differ, gates PASS on the REAL route fix (site `fix/about-team-preview-held` @ `bd258c2`, merged onto `webdesk-rebuild` in the gate; sumopod 2026-10-11; default mode still 302/0)
- [ ] Site owner merges `fix/about-team-preview-held` into `astro-site` (default `dist/` byte-identical before/after; the site repo has an active redesign program)
- [x] The site's own gates pass; negative control (one FAQ edit → exactly one page differs: `services/seo/index.html`)

### WSK-58 · Linux gate for the proof's suites <!-- bar -->✅ `██████████` **100%** · 1/1<!-- /bar -->
- [x] `webdesk/api`, `webdesk/blocks`, `webdesk` root and vocabulary suites green on sumopod after every merge (`webdesk/qa/linux-gate.sh`; release gate 2026-10-11: root 12, blocks 32, api 643/0/2, vocabulary 247)

---

## M2 · Editing gaiada.com from the ERP
<!-- bar -->🟡 `████████░░░░░░░░░░░░` **42%** · 8/19<!-- /bar -->

### WSK-44 · "Website" workspace in platform-ui <!-- bar -->🟡 `██████░░░░` **57%** · 4/7<!-- /bar -->
- [ ] Sites → collections → items for gaiada.com
- [x] Editor generated from the composition: text, Markdown, groups, lists (drag and keyboard reorder) — on gaiada.com's real compositions
- [ ] Publish with the approval state shown inline
- [ ] Version history with restore as draft
- [x] Unavailable / stale / conflict states (never a confident empty editor — structural: refusal renders before any data)
- [x] Every state reachable in Playwright; `next build` passes (34/34 against the built app; vitest 4456; tsc clean)
- [x] Re-verified against the REAL BFF (26/26 real-contract test through the UI's own parsers + server actions; 12/26 fail on the old parsers; 0 drift)

### WSK-60 · Publish → rebuild → staging <!-- bar -->🟡 `████░░░░░░` **44%** · 4/9<!-- /bar -->
- [x] Restricted deploy user on delphi — for the separate proof site `cms-proof.gaiada.com` (WSK-D56): `gdeploy` (group `ucmsproof` only, no sudo: a gdeploy-only `!ALL` overrides CloudPanel's all-users rule), forced command `gaiada-deploy-forced cms-proof` (site chosen by root; harness 96/0 on Linux), key proven locked (command → 126, no shell) 2026-10-11
- [x] The existing `gaiada-erp` GitHub App (installation `157879245`) can see `gaiadabali/gaiada-web-revamp`: a live, private row in the ERP's `github_repos` sweep cache, which lists only what the installation sees (checked 2026-10-11)
- [ ] The App's `Actions: write` is proven by the first rebuild dispatch (a missing permission refuses as `github_app_permission_missing`)
- [x] Repo secrets `WEBDESK_READ_KEY` + `DELPHI_DEPLOY_KEY` and variables `WEBDESK_API_URL` + `DELPHI_KNOWN_HOSTS` set on the site repo (2026-10-11, as `web-gaiada`; the read key minted through an approval, the host key pinned from the verified session; the deploy key's local copy shredded)
- [ ] `webdesk-rebuild` workflow + CI deploy script in the site repo (on its default branch, so it can be dispatched); build ledger + `build-status` / `rebuild-requests` routes in the ERP — branch `webdesk-rebuild-proof-site` pushed (deploys to cms-proof); the default-branch registration is PR gaiadabali/gaiada-web-revamp#1 (workflow file only, `[skip ci]`), awaiting the owner's merge. ERP target set in the platform `.env` (live from the next deploy)
- [ ] An approved publish dispatches exactly one run; the stamp poll marks "live on staging" honestly
- [ ] Cost per run measured and recorded
- [x] Unpublish/delete call `noteStagingStale()` so the editor's stale-staging banner can ever show (only when the item had a live version; best-effort; Linux: webdev 29 files/484, negative control fails exactly 6)
- [ ] Scheduled takedowns (`content.schedule` with `unpublishAt`) also mark staging stale (they take effect inside Zone B later: needs a Zone B event or a check at build-status time)

### P2 proof gate <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/3<!-- /bar -->
- [ ] A staff member edits gaiada.com in the ERP, publishes, and the staging site shows the change
- [ ] Page-for-page parity holds after the edit cycle
- [ ] The editor cannot approve a batch; the same approval re-presented is refused; `/control/*` is 404 publicly

---

## M3 · A complete CMS, Payload removed
<!-- bar -->🟡 `█████████████░░░░░░░` **64%** · 45/70<!-- /bar -->

Plan and ticket split: [`docs/plans/2026-10-11-webdesk-m3-plan.md`](gaiada-system/docs/plans/2026-10-11-webdesk-m3-plan.md). Rulings WSK-D49–D51.

### WSK-48b · Delete Payload <!-- bar -->✅ `██████████` **100%** · 4/4<!-- /bar -->
- [x] Payload app, dependencies and the `payload` service removed (main `847c15b5`; sumopod gate m3w48: api 709/0/2, vocabulary 187, migrations 178; reviewed by the WebDesk orchestrator)
- [x] Forward migration drops `pages`, `users`, `payload_*` (main `847c15b5`; sumopod gate m3w48: api 709/0/2, vocabulary 187, migrations 178; reviewed by the WebDesk orchestrator)
- [x] `webdesk/payload/` renamed `webdesk/delivery/` (WSK-D38); vendored vocabulary becomes the source (main `847c15b5`; sumopod gate m3w48: api 709/0/2, vocabulary 187, migrations 178; reviewed by the WebDesk orchestrator)
- [x] `v1-differential`'s 662-request edge corpus kept as a golden suite against the api before the old router is deleted (main `847c15b5`; sumopod gate m3w48: api 709/0/2, vocabulary 187, migrations 178; reviewed by the WebDesk orchestrator)

### CMS features <!-- bar -->🟡 `███░░░░░░░` **28%** · 6/21<!-- /bar -->
- [x] WSK-46 ruled by the owner 2026-10-11: an instant preview page on the site, no preview build (WSK-D52, recorded in webdesk-design-v2.md §14 on main `26862851`)
- [x] WSK-46 · WebDesk: hashed, expiring preview tokens per item version (migration 0013) + public `GET /v1/t/:tenant/preview/:token` (no-store, noindex, rate-limited, CORS); `preview` reserved (main `4d28cd8d`; sumopod gate m3w3: api 893/0/2, 0 unhandled, migrations 328)
- [ ] WSK-46 · ERP: Preview action in the editor mints a token and opens the site's preview page
- [ ] WSK-46 · site repo (gaiada-web-revamp): `/preview/` page reads the token from the URL fragment (`#t=`, never a query string), sets `Referrer-Policy: no-referrer`, and renders the draft with the site's own components (coordinate with the site owner; needs `api.gaiada.com` public)
- [x] WSK-61 · scheduled publish worker (+ the forms retention purge schedule, + the idempotency expiry sweep: `sweepExpired()` exists and nothing calls it) (main `4d28cd8d`; sumopod gate m3w3: api 893/0/2, 0 unhandled, migrations 328)
- [ ] WSK-61 ERP half · a scheduled publish going live dispatches the staging rebuild under the schedule's approval (new Zone B event kind; after WSK-60 is live)
- [ ] WSK-61 producer · the content tick emits a Zone B `schedule.fired` wake-up hint (grouped per approval and transition, eventId includes each item's effective time); agreed with a6, who builds the ERP consumer
- [x] OQ-3.1 ruled by the owner 2026-10-11: Markdown, edited WYSIWYG, no vocabulary bump (WSK-D49, recorded in webdesk-design-v2.md §14 on main)
- [ ] WSK-45 · WYSIWYG editor (TipTap) on the `markdown` primitive; an unchanged body saves byte-identical
- [x] WSK-43 ruled by the owner 2026-10-11: library images reach a static site through its build (WSK-D53); an image in use cannot be deleted (WSK-D54) (WSK-D53/D54 recorded in webdesk-design-v2.md §14 on main `4d28cd8d`)
- [x] WSK-43a · WebDesk: asset metadata, token uploads that never pass through the ERP, soft delete refused while in use, purge job, quota in bytes held (main `232b7665`; sumopod gate m3w4: api 1015/0/2, 0 unhandled, migrations 435)
- [ ] WSK-43b · ERP: Cerbos kind `webdesk_media_asset` (six artifacts), BFF routes, MCP tools
- [ ] WSK-43c · Website workspace: Media tab + a picker for media fields (after the M2 editor follow-ups)
- [ ] WSK-43d · site repo: the pull step downloads library images into the static build (with the site owner)
- [ ] WSK-49 ruled by the owner 2026-10-11: build now; a client publisher self-publishes one item, batches need a second client person (WSK-D58); clients edit only client-editable fields (WSK-D59); a `client_website_editor` role granted by staff or the client admin (WSK-D60) (ticked when on main)
- [ ] WSK-49a · vocabulary 1.2.0: `ui.clientEditable` on compositions and fields
- [ ] WSK-49b · WebDesk write plane refuses a client's change to a non-editable path; publish obeys D58
- [ ] WSK-49c · ERP: Cerbos rules for client editors (own company only) + a portal BFF that diff-checks client writes
- [ ] WSK-49d · client portal: a Website area in the portal's own shell, editor in client mode
- [ ] WSK-49e · a seeded test client company with its own WebDesk tenant and site, proven end to end
- [ ] WSK-49f · `client_website_editor` role as data (WSK-D60): Cerbos attribute check, grant/revoke by Gaiada staff and by the client's own admin (bounded: this role, own company, within ceiling, audited)

### Defects found on the way <!-- bar -->🟡 `████████░░` **77%** · 35/45<!-- /bar -->
- [x] Reserved collection keys (`media`, `forms` collide with api routes) (main `b4e5c70d`; sumopod gate m3w1 + m3w1b: api 681/0/2)
- [x] Slugs are never percent-decoded (non-ASCII slugs unreachable) (main `b4e5c70d`; sumopod gate m3w1 + m3w1b: api 681/0/2)
- [x] A bad cursor returns 500 with the raw database message (main `b4e5c70d`; sumopod gate m3w1 + m3w1b: api 681/0/2)
- [x] Undecodable `%` in a path gets Fastify's 400, not a problem+json body (main `b4e5c70d`; sumopod gate m3w1 + m3w1b: api 681/0/2)
- [x] A non-integer `limit` (`limit=2.5`) reached `LIMIT $n` and 500ed — now truncated (found and fixed in M3 T1) (main `b4e5c70d`; sumopod gate m3w1 + m3w1b: api 681/0/2)
- [x] Locked object versions are never freed (no lifecycle rule; quota counts rows, not bytes) — lands with WSK-43a's purge job and byte quota (main `232b7665`; sumopod gate m3w4: api 1015/0/2, 0 unhandled, migrations 435)
- [x] The privacy residency statement still names MinIO to customers (main `b4e5c70d`; sumopod gate m3w1 + m3w1b: api 681/0/2)
- [x] `check-artifact-url-expiry.mjs` still starts a MinIO container (main `b4e5c70d`; sumopod gate m3w1 + m3w1b: api 681/0/2)
- [x] In-memory read quota and idempotency under-enforce with more than one api replica (idempotency: the WSK-21 commands moved to the durable store in T5a; promotion + privacy follow in T5b; the read quota moves to Redis in T6) (main `4d28cd8d`; sumopod gate m3w3: api 893/0/2, 0 unhandled, migrations 328)
- [x] Defence in depth: a Cerbos rule denying `publish`/`schedule` to automation principals (today only the importer's code prevents it) (M3 T7, in 1.0.0-alpha.350: sumopod gate-full m3t7b nest 7716 passed + the known agency-lead flake, and the 350 release gate nest 7723/0; LIVE since the 350 deploy: Cerbos restarted, probe-t7 ALL ROWS AS EXPECTED incl. automation deny + request_publish ALLOW)
- [x] Approvals DETAIL page dead-ends for a requester (`automation_approval:read` 403) — needs a requester-own read rule in Cerbos (M3 T7, in 1.0.0-alpha.350: sumopod gate-full m3t7b nest 7716 passed + the known agency-lead flake, and the 350 release gate nest 7723/0; LIVE since the 350 deploy: Cerbos restarted, probe-t7 ALL ROWS AS EXPECTED incl. automation deny + request_publish ALLOW)
- [x] Editor: `lint.unavailable` is ignored, so an invalid composition shows "no unresolved tokens" (an empty list as a claim) (merged for 348: `webdesk/editor-followups` @ `560ca521`; Linux: platform-ui vitest 229 files/4538, tsc, next build; nest ui-contract 26/26; the new e2e state test passes every run)
- [x] Editor: `502 webdesk_ambiguous` has no dedicated "couldn't confirm the save" state (safe: goes stale) (merged for 348: `webdesk/editor-followups` @ `560ca521`; Linux: platform-ui vitest 229 files/4538, tsc, next build; nest ui-contract 26/26; the new e2e state test passes every run)
- [x] Editor: a rebuild request on a site with no staging target (`503 webdesk_not_configured`) shows the raw slug under `editorial_unavailable`; give it a plain-words "staging rebuild is not set up for this site" state (merged for 348: `webdesk/editor-followups` @ `560ca521`; Linux: platform-ui vitest 229 files/4538, tsc, next build; nest ui-contract 26/26; the new e2e state test passes every run)
- [ ] Importer CLI never wired the editorial signer (own process): the live run refused every write with 503 `editorial_signer_not_configured` — fixed on the proof branch (`f52f9a27`), verify in the next release gate
- [ ] `tenant.provision` cannot declare locales: a new tenant gets `id-ID` only, so every create 422s `composition-violation /locale`. The live `gaiada` tenant was set by hand to default `en`, `{en,id}` (WSK-D48); provisioning must take them
- [x] Approving a `key.mint` on `/approvals/[id]` discards the once-only plaintext (the UI's decide action ignores the response body): until the fix lands (`webdesk/key-request-ui`), approve key mints through the API and read `webdesk.plaintextOnce` — FIXED for 349 (`webdesk/key-request-ui` @ `81040b05`: `KeyMintDecide` shows it once, component state only; Linux: ui vitest 234/4661, build; e2e custody STATE passes on a quiet box)
- [x] `editorial-assertion-matrix.spec.ts` can leak 2 unhandled `ioredis` "Connection is closed" rejections when an app instance closes mid-command: the api suite exits 1 with 0 failures (1 of 2 runs on sumopod, 2026-10-11). Root cause (T8): BullMQ closing a still-connecting Redis client in the mail and tenant-webhook workers re-emits the init failure with no listener; every BullMQ client now closes after it is ready (10 of 10 repeats clean) (main `4d28cd8d`; sumopod gate m3w3: api 893/0/2, 0 unhandled, migrations 328)
- [ ] PRODUCT BUG, mechanism found (a6 probe, 2026-10-11): after a server action the App Router (Next 15.5.20) refetches the page the action started on, unprompted (the action itself revalidates nothing: `x-action-revalidated=[[],0,0]`), and races a navigation issued right after; when the refetch wins, the navigation is DISCARDED (URL never changes). Hits the editor's create / twin / restore pushes and a link click after Approve. Waiting does not fix it. Next: (b) find a Next release that fixes it, (a) `redirect()` inside the editor's own actions. UPSTREAM: fixed in next@16.3.0 (vercel/next.js#95391, issue #88343; regressed in 15.5.1 via #82674; NOT backported to 15.5.x)
- [ ] Editor create / twin / restore navigate via `redirect()` inside the server action — MITIGATION merged for 350 (`163fba56`): measured ×12 on a quiet box, failures 12/36 → 5/36 (twin create 4 → 0; create 2 → 1; restore 6 → 4). Not a fix: the queue can still undo a redirect on 15.5
- [ ] OWNER DECISION: upgrade platform-ui Next 15.5 → 16.3+ to fix dropped navigations after ANY server action ERP-wide (a major upgrade; its own ticket and full UI gate) — EVIDENCE (a6, 2026-10-11, throwaway): next@16.3.8 needs only the package bump (React 19.2.7 unchanged, no code changes; 2 deprecation renames: `middleware`→`proxy`, `middlewareClientMaxBodySize`→`proxyClientMaxBodySize`); platform-ui vitest 4679/4679; webdesk e2e ×3: navigation failures 7 → 0, key.mint link click 3/3 fail → 3/3 pass. Recommended: yes
- [x] WSK-21 HIGH commands (keys, lifecycle, releases) claim the WS4 approval in the same transaction as the effect, through a shared envelope; a reused approval is 403 before any effect (T5a; 10-racer tests) (main `26862851`; sumopod gate m3w2: api 710/0/2, migrations 154)
- [x] WSK-25 promotion and WSK-38 privacy commands still write the audit row after the side effect — move them onto the envelope (T5b) (main `4d28cd8d`; sumopod gate m3w3: api 893/0/2, 0 unhandled, migrations 328)
- [x] Promotion bundle import can hit `ux_content_items_group_locale` (inserts before deletes; upserts on slug) (main `26862851`; sumopod gate m3w2: api 710/0/2, migrations 154)
- [x] Promotion export includes soft-deleted items, so a promotion resurrects them as live (found 2026-10-11) (main `26862851`; sumopod gate m3w2: api 710/0/2, migrations 154)
- [x] Promotion writes the live projection without appending a version, so `published_version` points at content that is no longer live (found 2026-10-11) (main `26862851`; sumopod gate m3w2: api 710/0/2, migrations 154)
- [x] `UNIQUE (collection_id, locale, slug)` ignores soft delete — a deleted item holds its slug forever. Ruled 2026-10-11: a deleted item releases its slug; a restore onto a taken slug is 409 (WSK-D51) (main `26862851`; sumopod gate m3w2: api 710/0/2, migrations 154)
- [x] Idempotency expiry sweep must run per tenant + once at platform scope; reads treat expired rows as absent (both already true in `pg-idempotency-store.ts`; what is missing is a caller: lands with WSK-61) (main `4d28cd8d`; sumopod gate m3w3: api 893/0/2, 0 unhandled, migrations 328)
- [x] Hard deletes of `content_items` (bundle restore) will fail on the `content_versions` FK once versions are written (main `26862851`; sumopod gate m3w2: api 710/0/2, migrations 154)
- [x] `webdesk_app` can write `schema_migrations` via default privileges — revoke in a later migration (main `26862851`; sumopod gate m3w2: api 710/0/2, migrations 154)
- [x] Codegen `versioning.mts` drops `singleton`/`localized`/`ui`/`lint` from the tenant-contract snapshot (flips go unrated) — already fixed by WSK-41 (`toContractSnapshot`); pinned by `codegen-versioning.spec.ts`, green in the 2026-10-11 Linux release gate (api 643/0/2)
- [x] WordPress theme vocabulary drift (9 vs 10 block names); naive re-vendor breaks `block-renderer.php` on `fields` (main `b4e5c70d`; sumopod gate m3w1 + m3w1b: api 681/0/2)
- [x] Codegen generic `oneOf` is ambiguous (a known block also matches the unknown branch) — should be `anyOf` (main `b4e5c70d`; sumopod gate m3w1 + m3w1b: api 681/0/2)
- [x] `schema-draft/prompt.ts` does not teach the model `group`/`itemKey`/`fields` (fails closed today) (main `b4e5c70d`; sumopod gate m3w1 + m3w1b: api 681/0/2)
- [x] WebDesk migration tests (0009, 0010) were never run by the gate or CI; T4 wired a `migrations` suite into `linux-gate.sh` and the `webdesk-api` CI job (found 2026-10-11) (main `26862851`; sumopod gate m3w2: api 710/0/2, migrations 154)
- [x] `tenant.archive` can never replay: the tenant lookup runs before the envelope and 404s once archived, so a lost-response retry gets 404 (found by T5a) (main `4d28cd8d`; sumopod gate m3w3: api 893/0/2, 0 unhandled, migrations 328)
- [ ] `site.archive` is HIGH but always 501 and consumes no approval; decide whether it claims one or leaves the registry (found by T5a)
- [x] `content-commands.service.ts` keeps a private copy of the command envelope; adopt `CommandEnvelope` (T5a follow-up) (main `4d28cd8d`; sumopod gate m3w3: api 893/0/2, 0 unhandled, migrations 328)
- [x] `webdesk/api/src/main.ts` has no `enableShutdownHooks()`: a SIGTERM kills a running scheduler tick mid-item (safe: one transaction per item) instead of draining it (WSK-61 follow-up) (main `4d28cd8d`; sumopod gate m3w3: api 893/0/2, 0 unhandled, migrations 328)
- [x] Preview and upload tokens travel in the URL path: redact `/v1/t/*/preview/*` and `/v1/t/*/media/upload/*` in Caddy's (and any edge's) access log before those endpoints go live (the api already redacts its own logs; the WebDesk orchestrator owns this) — DONE 2026-10-11: Caddy writes no access log; the public nginx host logs via a redacting format (token → `[redacted]`, Referer query dropped). Proven in a throwaway nginx (0 secrets logged); `infra/nginx/api.gaiada.com.conf` (`634675ab`), staged on gda-aicenter, live when the vhost is enabled
- [x] WebDesk emits `form.received` with the internal `tenants.id` where the Zone B envelope documents the ERP company id (`company_ref`); check the ERP intake's mapping and fix one side (found by the WSK-61 producer, 2026-10-11) (main `232b7665`; sumopod gate m3w4: api 1015/0/2, 0 unhandled, migrations 435; contract fixture `contracts/zoneb/form-received.envelope.json` binds the WebDesk emit to the ERP validator)
- [ ] The public media upload route answers refusals with Nest's default body, not problem+json slugs; the UI maps them by status + message (found by WSK-43c)
- [ ] platform-ui needs `WEBDESK_PUBLIC_BASE_URL` in its compose `environment:` for library thumbnails (WSK-43c; the ERP needs it too, WSK-43b)
- [ ] Media controls disable only after a first 403: give the BFF a capabilities answer for `webdesk_media_asset` so the UI can disable up front (WSK-43c)
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
<!-- bar -->⬜ `░░░░░░░░░░░░░░░░░░░░` **0%** · 0/5<!-- /bar -->

### P3 · Portfolio <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/1<!-- /bar -->
- [ ] SM-70 import → SM-74 hosting topology → MON-01 probes → registry console

### P4 · Repo control <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/1<!-- /bar -->
- [ ] Three kinds, refusals lifted together, org credential, both gates, staff button

### P5 · Headless WordPress <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/1<!-- /bar -->
- [ ] A WordPress site renders entirely from `/v1`

### CDN · cache purge <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/1<!-- /bar -->
- [ ] WSK-70 · CDN cache purge on publish — deferred until a CDN fronts `/v1` or a delivered site; for a static site the rebuild is the purge (WSK-D50; was mislabelled WSK-64, which is vocabulary 1.1.0)

### P6 · Client delivery <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/1<!-- /bar -->
- [ ] Deploy identity and hosting for client frontends
