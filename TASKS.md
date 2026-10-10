# TASKS — WebDesk + the gaiada.com CMS

**Overall** <!-- bar:overall -->🟡 `██████░░░░░░░░░░░░░░░░░░░░░░░░` **18%** · 23/124<!-- /bar -->

Last updated <!-- updated -->2026-10-10<!-- /updated --> · Goal: finish WebDesk properly, with gaiada.com as the first site run from it.

**How this file works**
- A box is ticked **only when the item is verified**: driven on a Linux server and the result observed (DEV-VERIFIED), or — for a decision or document — landed in the repo. Code that exists but is unverified stays unticked.
- Tick boxes in the **same change** that moves the work, then run `node scripts/tasks-progress.mjs`. Bars are computed from the boxes, never typed. `--check` fails when a bar is stale.
- Context, evidence and open questions: [`docs/plans/2026-10-10-webdesk-gaiada-proof.md`](docs/plans/2026-10-10-webdesk-gaiada-proof.md). Rulings: [`webdesk-design-v2.md`](docs/blueprints/webdesk-design-v2.md) §14.

---

## M0 · Decisions and record
<!-- bar -->🟡 `████████████░░░░░░░░` **60%** · 6/10<!-- /bar -->

### Rulings in the decision log <!-- bar -->✅ `██████████` **100%** · 6/6<!-- /bar -->
- [x] WSK-D37–D40 (2026-09-21: Payload removed, ERP identity for editors, the name, no per-seat tools) landed in v2.3 §14
- [x] WSK-D41 — gaiada.com is the P2 proof site
- [x] WSK-D42 — RustFS replaces MinIO
- [x] WSK-D43 — authority inside the `webdesk` project on gda-aicenter; `/v1` at `api.gaiada.online`
- [x] The colliding "D37" proposal in the replatform plan renumbered to next-free
- [x] Working tracker + this task board created

### Owner inputs <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/4<!-- /bar -->
- [ ] GoDaddy A record `api.gaiada.online → 35.240.135.48` (owner)
- [ ] Content-model questions from the inventory: import scope (Q3), visibility states (Q4), default locale (Q11)
- [ ] Owner questions from the write-plane design (WSK-62)
- [ ] Backup role: approve a read-only `BYPASSRLS` role for `pg_dump` in the WebDesk database (WSK-63)

---

## M1 · gaiada.com served from WebDesk (delivery half)
<!-- bar -->🟡 `███████░░░░░░░░░░░░░` **36%** · 17/46<!-- /bar -->

### WSK-52 · RustFS replaces MinIO <!-- bar -->🟡 `█████████░` **87%** · 7/8<!-- /bar -->
- [x] RustFS `1.0.0` pinned by digest in every compose file, `/health` check, no host ports (resolved config)
- [x] Idempotent bootstrap: buckets, versioning, GOVERNANCE object lock, least-privilege api key (no `mc`)
- [x] The api refuses to boot without its own storage key or with the root key
- [x] Versioning + object lock proven with a negative control; service key refused bucket-policy writes
- [x] Presigned PUT/GET round-trip with `requestChecksumCalculation: "WHEN_REQUIRED"`
- [x] Backup + sentinel scripts off `mc`; a failed `pg_dump` no longer reports success
- [x] Full `webdesk/api` suite on Linux: 396 passed / 0 failed / 1 skipped
- [ ] CI `webdesk-api` job green on GitHub with RustFS

### WSK-48a · `/v1` moved out of Payload into `webdesk/api` <!-- bar -->🟡 `███████░░░` **71%** · 5/7<!-- /bar -->
- [x] `delivery` module serves `/v1` byte-identically (raw Fastify route, router unchanged)
- [x] One API-key hash implementation; vocabulary vendored with a drift test
- [x] WSK-05 demo `content` controller retired with no loss of guard coverage
- [x] Caddy `/v1/*` → `api`; `payload-gateway` retired from compose and the status page
- [x] Differential gate on Linux: 696/710 pairs identical, 14 classified, 0 unexplained; contract 60/60; api suite 409/0/1
- [ ] Combined suite after merging WSK-52 + WSK-48a green on Linux
- [ ] Envelope + differential tests ported into `webdesk/api` and wired into CI

### WSK-53 · gaiada.com content inventory <!-- bar -->✅ `██████████` **100%** · 5/5<!-- /bar -->
- [x] 33 config modules classified field by field
- [x] 315 long-form pages by kind and language; front-matter schemas
- [x] Globals, media and placeholders counted
- [x] 16 vocabulary gaps with evidence
- [x] Stable ids for every page, home section, CTA and form

### WSK-62 · Write-plane design pass <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/2<!-- /bar -->
- [ ] Design doc: content-model contract, authoring + read commands, editorial assertion, Cerbos kinds, loader principal, rebuild path
- [ ] Reviewed and accepted; rulings landed in §14

### WSK-41 · Authoring commands <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/5<!-- /bar -->
- [ ] Field-value storage: migration + additive envelope member, rated by `breaking-change.ts`
- [ ] `FieldDef` extensions the site needs (group, list, boolean, scalar lists, Markdown)
- [ ] create · update · publish · unpublish · schedule · delete, each with an impact class
- [ ] `content_versions`, audit, cache tags and the `content.published` webhook event
- [ ] Tests with negative controls, green on Linux

### WSK-51 · Read commands for the editor <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/2<!-- /bar -->
- [ ] Collections, items, item detail with drafts, versions, media
- [ ] Green on Linux

### WSK-54 · Importer <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/3<!-- /bar -->
- [ ] Site repo → deterministic bundle (EN + ID, stable ids)
- [ ] Loader through the authoring commands, idempotent
- [ ] Round trip: bundle → WebDesk → bundle is identical

### WSK-55 · The site builds from `/v1` (gaiada-web-revamp) <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/4<!-- /bar -->
- [ ] Generated SDK for the `gaiada` tenant
- [ ] `CONTENT_SOURCE=webdesk|git` content loader
- [ ] Parity gate: both builds, `dist/` differs on 0 pages
- [ ] The site's own build gates pass on the CMS build

### WSK-56 · Deploy to gda-aicenter (`webdesk` project only) <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/6<!-- /bar -->
- [ ] Backup of the WebDesk database and volumes
- [ ] `wsk05-*` verification tenants removed
- [ ] RustFS up and bootstrapped; MinIO removed
- [ ] New api live; `payload-gateway` removed
- [ ] `/v1` answers on the loopback proxy
- [ ] `api.gaiada.online` vhost enabled with TLS (after the A record)

### WSK-57 · Provision the gaiada tenant <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/3<!-- /bar -->
- [ ] Tenant `gaiada`, site `gaiada-com`, staging + production environments
- [ ] Build key (production read) and preview key (staging read)
- [ ] Read quota sized for a full site build

### WSK-58 · Linux gate for the proof's suites <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/1<!-- /bar -->
- [ ] `webdesk/api`, `webdesk/blocks`, `webdesk` root and vocabulary suites green on sumopod after every merge

---

## M2 · Editing gaiada.com from the ERP (authoring half)
<!-- bar -->⬜ `░░░░░░░░░░░░░░░░░░░░` **0%** · 0/21<!-- /bar -->

### WSK-40 · Editorial identity seam <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/3<!-- /bar -->
- [ ] EdDSA key custody and minting in platform-nest
- [ ] Verification by public key + `jti` replay store in WebDesk
- [ ] Clock-skew and failure-mode tests

### WSK-47 · Cerbos kinds (six artifacts each) <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/4<!-- /bar -->
- [ ] Policies for `webdesk_content_item`, `webdesk_collection`, `webdesk_media_asset`
- [ ] Resource-attribute allow-list, permission catalog, role bundles in both resolvers
- [ ] Pinned count tests updated
- [ ] Live Cerbos restarted and the new decisions proven by a probe

### WSK-59 · ERP BFF + MCP tools <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/3<!-- /bar -->
- [ ] BFF routes + `FRONTEND-BFF-CONTRACT.md` section
- [ ] Every editor action is also an MCP tool with an impact class
- [ ] Tests green on Linux

### WSK-44 · "Website" workspace in platform-ui <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/6<!-- /bar -->
- [ ] Section and page list for gaiada.com
- [ ] Editor for fields, lists and Markdown
- [ ] Publish with the approval state shown inline
- [ ] Version history
- [ ] Unavailable / stale / conflict states (never a confident empty editor)
- [ ] Driven end to end in a browser

### WSK-60 · Publish → rebuild → staging <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/2<!-- /bar -->
- [ ] Where the build runs (P-2), decided
- [ ] `content.published` → site build → deploy to `24-pyevq.gaiada.com`

### P2 proof gate <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/3<!-- /bar -->
- [ ] A staff member edits gaiada.com in the ERP, publishes, and the staging site shows the change
- [ ] Page-for-page parity holds after the edit cycle
- [ ] Evidence recorded in the tracker

---

## M3 · A complete CMS, Payload removed
<!-- bar -->⬜ `░░░░░░░░░░░░░░░░░░░░` **0%** · 0/17<!-- /bar -->

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

### Defects found on the way <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/8<!-- /bar -->
- [ ] Reserved collection keys (`media`, `forms` collide with api routes)
- [ ] Slugs are never percent-decoded (non-ASCII slugs unreachable)
- [ ] A bad cursor returns 500 with the raw database message
- [ ] Undecodable `%` in a path gets Fastify's 400, not a problem+json body
- [ ] Locked object versions are never freed (no lifecycle rule; quota counts rows, not bytes)
- [ ] The privacy residency statement still names MinIO to customers
- [ ] `check-artifact-url-expiry.mjs` still starts a MinIO container
- [ ] In-memory read quota and idempotency under-enforce with more than one api replica

---

## M4 · WebDesk production-ready
<!-- bar -->⬜ `░░░░░░░░░░░░░░░░░░░░` **0%** · 0/13<!-- /bar -->

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

### Operations <!-- bar -->⬜ `░░░░░░░░░░` **0%** · 0/5<!-- /bar -->
- [ ] WSK-63 · backup role, nightly backup producing a real dump
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
