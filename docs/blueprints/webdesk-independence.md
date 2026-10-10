# WebDesk — Independence: replacing Payload, the third-party sweep, the naming ruling, and the market assessment

> **Status:** `PROPOSED` — design and direction. No code changed by this document.
> **Date:** 2026-09-21 · **Owner conversation:** web@gaiada.com
> **Reads with:** [`webdesk-design-v2.md`](./webdesk-design-v2.md) v2.2 (AUTHORITATIVE — this
> document amends §05, §09 and §13 of it, and proposes WSK-D37…D40 for its §14) ·
> [`github-integration-foundation.md`](./github-integration-foundation.md) (the seat-billing
> decision this extends) · [`2026-09-17-market-benchmark.md`](../assessment/2026-09-17-market-benchmark.md)
> (§6 below is the WebDesk section that benchmark is missing).
>
> **📌 OWNER DECISIONS taken 2026-09-21 — these gate everything below:**
> 1. **Payload is removed.** WebDesk owns its own editorial layer.
> 2. **Editorial identity is the ERP identity.** No second account, anywhere, for anyone.
> 3. **The authoring UI lands inside `platform-ui`** as an ERP module, not as a standalone
>    Zone B admin app.
> 4. **The platform keeps the name WebDesk.** The phrase *"the unified backend"* is retired (§5).
> 5. **The rule generalises:** no WebDesk component may require a per-seat third-party account
>    for a person who already has an ERP identity (§4, WSK-D40).

---

## §0 · The four asks, and the short answers

| Ask | Short answer | Section |
|---|---|---|
| Replace Payload with our own CMS | **Cheaper than it sounds — Payload holds two collections, one of which is a boot stub. There is no authoring surface to migrate, because one was never built.** The work is building the thing Payload was standing in for, not unpicking it. | §1, §2 |
| Rely on ERP auth | A short-lived signed **editorial assertion** over the *existing* A→B control channel. Zone B gains no ERP credential and no new channel. The schema already anticipated this: `content_versions.created_by` is documented as *"Zone A principal id, opaque — attribution only."* | §3 |
| Apply the same rule to every other third-party usage | Eleven components audited. **No other per-seat dependency exists inside WebDesk itself.** The real exposures are three AGPL/source-available licences and **one** per-seat platform *around* it — GitHub. *(Cloudflare was listed here too; a 2026-09-21 re-check found Workers Paid is $5/mo per **account**, not per seat — OQ-3.6.)* Since widened estate-wide: [`vendor-independence-doctrine.md`](./vendor-independence-doctrine.md) | §4 |
| Rename the unified backend | **The product name stays WebDesk** (owner, 2026-09-21). What is retired is the *phrase* "the unified backend" — 26 occurrences across 6 files. Replacement vocabulary in §5. | §5 |
| Capability assessment · what it substitutes · what is left | 13 capabilities, ~USD 700–1,900/mo of substituted subscriptions at agency scale, and **the honest number: roughly 60% built, 0% proven in production.** | §6, §7 |

### The one correction to the premise, stated up front

The GitHub cost driver you hit is **editor seats**, and it is worth separating two things that
look like one:

- **Removing Payload does not, by itself, remove a GitHub seat cost.** Payload's own packages are
  all public-npm MIT (`payload`, `@payloadcms/db-postgres`, `@payloadcms/next`,
  `@payloadcms/richtext-lexical` — `webdesk/payload/package.json`). Nothing in the repo requires a
  GitHub account to run Payload.
- **What removes the seat cost is moving editorial identity onto ERP auth** — which is decision 2,
  and which Payload is what stands in the way of: making Payload admin speak ERP SSO means
  Payload's Enterprise tier, and *that* is where a licence and an invite-gated account appear.

So the two decisions are correctly coupled, but the causation runs the other way round from how it
was phrased, and the plan below is sequenced on the real chain: **ERP auth is the goal; removing
Payload is what makes it free.** Three independent reasons make it the right call anyway (§1.3),
and two of them are already open items in v2.2 — so this is less a new direction than the
resolution of `A-11`/`OQ-2.8` and the retirement of `R-1`'s accepted risk.

**Second-order win worth planning around:** v2.2 §10 lever 2 already says an adopted site stops
rebuilding when content changes. Editors who never touch a build never need repo access at all —
which is the *structural* end of the seat problem, not just a licensing one.

---

## §1 · What Payload actually holds today — read from source, 2026-09-21

### 1.1 — The audit

Every claim here is from the working tree, not a tracker.

| Surface | What is actually there |
|---|---|
| **Collections in `payload.config.ts`** | **Two.** `users` (`auth: true`, **zero fields**) and `pages` (`tenantId`/`title`/`body`). The config's own comment: *"ONE minimal collection (\"pages\") carrying tenant_id, just enough to prove the boot end-to-end."* |
| **Tables Payload owns** | `tablesFilter: ['pages', 'users*', 'payload_*']`. That is the entire footprint. |
| **The real content model** | `webdesk/migrations/0002_content.sql` — `collections`, `content_items`, `content_versions`, `media_assets`. **Ours. Not Payload's.** `content_items` already carries `publish_state` (draft/scheduled/published/unpublished), `publish_at`/`unpublish_at`, `preview_token`, `localization_group_id`, `search_text` + `search_vector`, `seo jsonb`. |
| **The `/v1` read path** | **Ours** (WSK-D24, shipped): `payload/collections/router.ts` (136 lines) + `content-read.ts` (331) + `redirects.ts` (157) + `db.ts` (76) + an 18-line Next route. Payload is not in the read path at all. |
| **Vocabulary / contract / codegen** | **Ours.** `payload/vocabulary/*` (8 primitives, 9 blocks, envelope, cache-tags, problem-details, breaking-change) and OpenAPI-first codegen (WSK-D19). `payload generate:types` is **not used**. |
| **GraphQL** | Disabled at the framework level (WSK-D20). |
| **Services (`webdesk/api`)** | 165 TypeScript files, 20 modules, **22 control commands**, zero Payload imports. |

**The finding, stated plainly: Payload is not the CMS. It is a login screen and an empty admin
shell standing next to the CMS.** The directory is named `payload/` and that naming has made the
dependency look load-bearing in every document that describes it.

### 1.2 — What that means for the plan

**There is no content migration.** Nothing is authored anywhere. The only content-shaped Payload
table is `pages`, which by its own comment is a boot proof. Client content lives in
`content_items`, written today only through `POST /v1/t/:tenantSlug/content` — an **API-key,
machine** path (`@RequireScope("write")`), never an editorial one.

So the honest framing of this work is not *"replace Payload"*. It is:

> **Build the authoring surface that was never built, and delete the placeholder.**

That is a materially smaller and lower-risk job than "replace a CMS", and it should be estimated
and reviewed as such.

**The one real piece of unpicking** is that the `/v1` read route physically lives inside the
Payload Next.js app (`payload/app/(payload)/v1/[...slug]/route.ts` + `src/public-gateway.mjs`).
Removing Payload means rehoming it. The envelope is **FROZEN**, so that move is byte-identical or
it is wrong — and `payload/test/envelope-contract.test.mjs` already exists to prove it. That test
is the gate on WSK-48, not a nice-to-have.

### 1.3 — Three reasons to remove it that have nothing to do with GitHub

1. **It retires the program's own highest-rated risk.** The reassessment scored *"Shared DB + RLS
   **under a third-party ORM**"* as **"Below standard in feasibility — highest-risk decision in
   the plan → R-1."** The owner accepted that risk on 2026-08-26 with a written **Option-D
   fallback trigger**. Removing Payload does not exercise the fallback; it **dissolves the
   question** — there is no third-party ORM left to isolate.
2. **It closes WSK-D25, which currently has no closure.** Payload runs an `access` function only
   when `overrideAccess` is false, and the Local API defaults it **true** — so the app-layer
   tenant predicate is **skipped on the Local API path**. v2.2's remedy is *"required, and still
   unbuilt: a lint forcing project Local API callers to pass `overrideAccess: false`."* Deleting
   Payload deletes the gap and makes the unbuilt lint unnecessary.
3. **It removes a documented fail-open from an internet-facing box.** `payload.config.ts` carries
   a 20-line warning block because an ordinary dev boot with `PAYLOAD_ALLOW_PUSH=true`
   *"disables row security on every table Payload touches and DROPS the `tenant_isolation`
   policy, while leaving `relforcerowsecurity=true` — fail-OPEN, and invisible to any check that
   only inspects the FORCE flag."* The mitigation is a second, deliberately ugly env var. The
   better mitigation is not shipping the mechanism.

**Also dissolved:** `OQ-2.8` (Payload trademark check on the rebrand) and `A-11` — both become
moot, not deferred. And the accepted cost recorded under D24 — *"the API-key hash algorithm is
duplicated in two services and must change in both"* — goes away with the second service.

### 1.4 — What we genuinely lose, and what replaces it

| Lost with Payload | Replacement | Cost |
|---|---|---|
| Admin panel UI (lists, forms, field rendering) | A `content` module in `platform-ui`, on the existing design system and dept-interface template | **The real work.** WSK-44 |
| Lexical rich-text editor | Lexical direct (MIT) or TipTap (MIT) — richtext is **one primitive** in a vocabulary of 8, not the content model | WSK-45, small |
| `payload migrate` for `payload_*` tables | Irrelevant — those tables go; WebDesk has its own ledger (`0001`…`0008`) | Zero |
| `payload generate:types` | Already unused — codegen is OpenAPI-first | Zero |
| Media library browse UI | Build it; upload/presign/transform already exist in `api/src/media` | WSK-43 |
| Draft preview | `content_items.preview_token` already in the schema | WSK-46 |
| Next.js 15 + React 19 + drizzle on the delivery surface | **Removed, not replaced.** Fewer dependencies on the one internet-facing box | Negative cost |

---

## §2 · The replacement plan

Ordered so that nothing regresses and Payload is deleted **last**, only once its replacement is
proven.

### Phase E0 · Seam (blocks everything)

| # | Ticket | Notes |
|---|---|---|
| **WSK-40** | **Editorial identity seam** — ERP mints a short-lived signed editorial assertion; Zone B verifies by public key. Full design in §3. | The keystone. `senior-integrator`. Nothing else starts. |
| **WSK-47** | **Cerbos resource kinds** — `webdesk_content_item`, `webdesk_collection`, `webdesk_media_asset`. | ⚠️ Estate rule: **a new Cerbos kind is six artifacts**, not a policy YAML — policy, resource-attrs allowlist, perm mirror, role-bundle entries, pinned count tests, and a Cerbos restart (nothing hot-reloads). Budget it accordingly. |

### Phase E1 · The write plane (Zone B)

| # | Ticket | Notes |
|---|---|---|
| **WSK-41** | **Content authoring commands** — `content.create` · `content.update` · `content.publish` · `content.unpublish` · `content.schedule` · `content.delete`, added to the 22-command control plane with impact classes and scopes. | Today the control plane has `content.export`/`promote`/`rollback` only — **no authoring commands exist**. Writes `content_versions` with `created_by` = the opaque principal id. |
| **WSK-42** | **Collection/schema authoring** — promote `schema.propose`/`schema.apply` from machine commands to a staff-driven surface. | `schema.aiDraft` already exists and is `impactClass: read`. |
| **WSK-43** | **Media library commands** — list/search/tag/delete over `media_assets`; browse reads. Upload stays a Zone-B presigned PUT so bytes never traverse Zone A. | |
| **WSK-51** | **Control-plane read commands** — closes v2.2 §01 gap 2 (*"3 GET routes against 15 write commands"*). The authoring UI cannot render on `stale:true` reads. | **Promoted onto the critical path by this plan.** Previously unscoped. |

### Phase E2 · The authoring surface (Zone A)

| # | Ticket | Notes |
|---|---|---|
| **WSK-44** | **`platform-ui` `content` module** — collection list → item list → item editor (block composer over the 9 block types) → publish controls → media picker → version history. On the dept-interface template. | The largest single ticket. `senior-fe` + `senior-uiux`. Split on review. |
| **WSK-45** | **Rich-text primitive** — pick the editor, freeze the storage shape as a vocabulary primitive. | Storage format is a **contract** decision: it enters the frozen `/v1` envelope. Treat as a vocabulary version bump, not a UI choice. |
| **WSK-46** | **Preview + drafts** — `preview_token` round-trip: editor → unpublished render on the live frontend. | |
| **WSK-49** | **Client editors via the client portal** — client-side is a separate interface with its own route group and shell (estate rule); `isClientOnly`, never `!isElevated`. | **This is the ticket that actually kills the seat cost.** |

### Phase E3 · Deletion

| # | Ticket | Notes |
|---|---|---|
| **WSK-48** | **Delete Payload.** Rehome `/v1` (router + content-read + redirects + db + the Next route) into `webdesk/api`; drop the 4 Payload deps, the Next/React deps, the `payload` and `payload-gateway` compose services; drop `pages`, `users`, `payload_*` and the `20260829_113056_wsk_initial` migration via a new forward migration in WebDesk's own ledger. | **Gate: `envelope-contract.test.mjs` passes byte-identically before and after.** The frozen envelope does not get to drift during a refactor. Also delete the duplicated API-key hash (D24's accepted cost) and the `PAYLOAD_ALLOW_PUSH` machinery. Rename `webdesk/payload/` → `webdesk/delivery/` in this same change (§5). |

### What this does to the v2.2 rollout

It does **not** reorder P1–P6. E0–E3 run as a **parallel track that must land before P2's gate**,
because P2 ("one internal site, content from `/v1`") is the first moment anyone has to actually
author something. Today P2 would be satisfied by seeded rows; with this track it is satisfied by a
person typing.

**P1 is unaffected and must not wait.** The 34 provisional greens still need Linux verification on
`sumopod` and the containment probes still need running on `gda-aicenter` (WSK-D34) — and note
that **P1's scope shrinks** here, because the Payload boot tests and the RLS-under-Payload probe
suite verify code this plan deletes. Re-verify what survives; do not spend a gate on `spike-rls`.

---

## §3 · ERP auth — the editorial identity seam (WSK-40)

### The constraint that shapes it

v2.2 §03's hardening ACs are binding: the delivery surface holds **no ERP database password, no
Keycloak secret, no deploy key**, and there is exactly **one A→B channel** (the control plane —
mTLS + Keycloak client-credentials + WS4 assertion). An editorial UI must not weaken either. So
editorial gets **no new channel and no new credential class** — it rides the one that exists.

### The design

```
platform-ui  /content/*
   │  staff → Keycloak · client editors → client portal   (identities that already exist)
   ▼
platform-nest  webdev module
   │  Cerbos decision in Zone A  (webdesk_content_item · webdesk_collection · webdesk_media_asset)
   │  mints an EDITORIAL ASSERTION, EdDSA-signed:
   │     { tenant, site, collection, action, principal_id, exp ≤ 120s, jti }
   ▼  the existing A→B control channel (mTLS + client-credentials + WS4) — no new channel
WebDesk control plane
   │  verify signature (PUBLIC key only, in Zone B) · exp · jti replay-check in Redis
   │  principal_id is OPAQUE — Zone B never learns who it is
   ▼
content_items · content_versions.created_by = principal_id · media_assets
```

### Why each piece is the way it is

- **Public key only in Zone B.** A signing key in Zone B would be a Zone A credential on an
  internet-facing box — the exact thing §03 forbids. Verification needs only the public half, so
  the boundary statement is unchanged.
- **`exp ≤ 120s` and a `jti` replay check.** An assertion is a single authorised action, not a
  session. A stolen one is worth two minutes and one use.
- **`principal_id` is opaque.** This is not a new idea — it is what
  `content_versions.created_by text NOT NULL -- Zone A principal id, opaque — attribution only`
  already says. The schema was designed for this seam before the seam was designed.
- **Cerbos decides in Zone A, always.** Zone B verifies *that an authorisation happened*; it never
  re-derives one. Zone B holds no role data, and the registry stays Zone A only (WSK-D30).
- **Media bytes never traverse Zone A.** The UI asks Zone B for a presigned PUT and uploads
  browser→Zone B directly. Zone A handles the authorisation, not the payload.

### The three risks this introduces, named now

1. **The control channel becomes interactive-latency-critical.** Today it carries occasional
   commands; now it carries keystroke-adjacent traffic. Needs connection reuse, a circuit breaker,
   and — per the estate's own rule that **an empty list is a CLAIM** — an explicit *"editorial is
   unavailable"* state. Never a confident empty editor.
2. **Clock skew becomes a correctness dependency.** A 120-second window across two hosts needs NTP
   as an acceptance criterion, with a skew-tolerance test. On one box today; not forever.
3. **Attribution is only as good as the ledger.** GitHub's collapse-to-one-bot problem
   (github-integration-foundation §1) repeats here in a milder form: Zone B's audit says
   *"principal 7f3a…"*. The ERP ledger is the only place that resolves it — same consequence,
   already accepted once, and it should be recorded a second time rather than rediscovered.

---

## §4 · The third-party sweep — every component, licence, and seat exposure

The generalisation you asked for. **The organising principle: a dependency is dangerous when it
prices per *human*, not per *resource*.** Per-machine and per-GB scale with the business; per-seat
scales with headcount and taxes every new editor, every new client contact, every new agent.

### 4.1 — Inside WebDesk

| Component | Role | Licence | Per-seat? | Verdict |
|---|---|---|---|---|
| **Payload 3** + `@payloadcms/{db-postgres,next,richtext-lexical}` | Admin shell + `users` | MIT | No — but **Enterprise tier for SSO is**, and that is the chain you hit | **REMOVE** (§1–2) |
| Next.js 15 / React 19 | Payload's host | MIT | No | **Removed with Payload** — from the delivery surface only; `platform-ui` keeps them |
| NestJS + Fastify | `webdesk/api` | MIT | No | **KEEP** |
| PostgreSQL 16 | Zone B store | PostgreSQL | No | **KEEP** |
| **Redis 7-alpine** | BullMQ backend | ⚠️ **RSALv2/SSPL from 7.4** | No | **ACT — cheap.** Not a seat cost, and self-hosting a queue is not the restricted act, but `redis:7-alpine` floats onto source-available tags. **Pin ≤ 7.2 (BSD) or swap to Valkey 8 (BSD)** — drop-in for BullMQ, hours not days. |
| **MinIO** | Object storage | ⚠️ **AGPL-3.0**, community build stripped since 2025 | No | **KEEP, with an exit.** AGPL §13 is satisfiable by pointing at unmodified upstream, and clients never touch MinIO directly (media goes through our api). **A-13 already rules the abstraction + an R2/NAS config swap + an abstraction test — that ruling IS the exit; keep the test green.** |
| **imgproxy v3** | Image transforms | ⚠️ **AGPL-3.0** (Pro is paid) | No | **KEEP, with one standing rule: never patch it.** This is the sharpest AGPL surface in the stack — it serves bytes to end users of client sites. Unmodified upstream keeps §13 trivially satisfied. Escape hatches if ever needed: Thumbor (MIT), or `sharp` in-process (Apache-2.0). |
| ClamAV | Upload scanning | GPL-2.0, separate process over TCP | No | **KEEP** — no derivative work at a socket boundary |
| Caddy | Loopback proxy | Apache-2.0 | No | **KEEP** |
| BullMQ · ioredis · nodemailer · jose · zod · AWS SDK | Libraries | MIT / MIT-0 / Apache-2.0 | No | **KEEP** |
| OTel Collector | Telemetry | Apache-2.0 | No | **KEEP** |

**Result: after Payload goes, WebDesk contains zero per-seat dependencies.** The remaining work is
three licence-hygiene items, none of which costs money and one of which (Redis→Valkey) is hours.

> **Verify before quoting any of the licence rows to a client.** They are read from the pinned
> images and `package.json` in this tree plus upstream licence history, not from counsel.

### 4.2 — Around WebDesk — where the money actually is

| Platform | Pricing shape | Exposure | Action |
|---|---|---|---|
| **GitHub** | **Per seat** (Team/Enterprise) + metered Actions minutes | The one you found. Already half-answered: github-integration-foundation decision 1 puts all ERP→GitHub traffic on **one org-owned machine identity**, *"seat billing is the driver."* | **WSK-49 finishes it** — editors get ERP identities, never org seats. And v2.2 §10 lever 2: an adopted site stops rebuilding on content change, so editors stop needing repo access at all. |
| **Cloudflare Pages/Workers** (R-2, adopted) | Free tier generous; **paid plans are per seat** | A second instance of the same trap, adopted 2026-08-26 before the trap was named. | **Re-check before P6.** Not urgent, but it belongs on the register. |
| **SMTP delivery** | Per volume | `MAIL_SMTP_*` is provider-agnostic; dev uses mailpit. **No provider chosen.** | **Open cost item** — feed into A-10 (§15 Cost & quotas), still unwritten. |
| **web3forms** | Per volume | Being killed at M0 — already the plan. | On track |

### 4.3 — The standing rule to adopt (WSK-D40)

> **PROMOTED 2026-09-21 — this rule is now estate-wide, not WebDesk-only.** The owner ruled *"no
> seat or enterprise tier anywhere; be vendor-lock free."* The full doctrine, an audit of ~45
> estate dependencies, the irreducible set, and the exit ladder live in
> [`vendor-independence-doctrine.md`](./vendor-independence-doctrine.md) (EST-D-VI1…VI4).
> WSK-D40 below stands as the WebDesk-scoped statement of the same rule.

> **No WebDesk component may require a per-seat third-party account for a person who already has
> an ERP identity.** A dependency that prices per human is refused at design time, not negotiated
> at renewal. Where a capability is only available per-seat, either the capability is built, or
> the people are collapsed behind one machine identity and the ERP ledger becomes the record —
> the pattern already ruled for GitHub.

This rule is what makes the ERP's identity layer pay for itself. The market benchmark already
scores authorization and identity **AHEAD of every ERP**; this is the first place that asset
converts into avoided spend rather than architectural pride.

---

## §5 · The naming ruling (WSK-D38)

**Owner, 2026-09-21: the product keeps the name WebDesk.** Nothing renames — not the compose
project, the DB roles, the ledger, the ticket prefix or the module row. Near-zero churn.

**What is retired is the phrase "the unified backend"** — 26 occurrences across 6 files. It is a
mouthful, it names the thing by its architecture rather than its job, and it has been used to mean
three different scopes in three different documents.

### The vocabulary, fixed

| Say this | For |
|---|---|
| **WebDesk** | The platform. In client-facing writing too. |
| **the delivery surface** | The public, multi-tenant, internet-facing half (already v2.2's preferred term) |
| **the control plane** | The ERP half that drives it (already v2.2's preferred term) |
| **`/v1`** | The frozen public contract. Call it by its name. |
| **the `content` module** / **the Web Dev console** | The authoring UI in `platform-ui` |
| ~~the unified backend~~ · ~~Zone A / Zone B~~ | **Retired.** Zone A/B survives only inside sections v2.2 already marks as carried. |

**One naming trap to fix while we are here:** the directory `webdesk/payload/` will still be
called `payload/` after Payload is gone. **Rename it to `webdesk/delivery/` in WSK-48**, in the
same change that deletes the dependency. A directory named after a dependency it no longer has is
exactly how "Payload is load-bearing" became the received wisdom this document had to disprove.

---

## §6 · Capability assessment — what WebDesk substitutes

The market benchmark of 2026-09-17 has **13 sections and none of them is WebDesk**. This is that
missing section. Its scoring key and its caveats apply: *pricing is order-of-magnitude, not a
vendor quote*, and **a module can be strong on capability and at zero on proof.**

### 6.1 — Capability → subscription substituted

| # | WebDesk capability | Built? | Substitutes | Agency-scale list price |
|---|---|---|---|---|
| 1 | **Headless CMS** — collections, items, versions, draft/scheduled/published, locales + `localization_group_id`, SEO jsonb, full-text `search_vector` | Schema ✅ · read path ✅ · **authoring ❌** | Contentful · Sanity · Storyblok · Prismic · Payload Cloud | **$300–700/mo** |
| 2 | **Forms** — CORS allowlist, honeypot, per-IP + per-form rate limits, zod schema, consent records, ClamAV'd attachments, retention purge | ✅ (23/23, Windows-provisional) | web3forms · Formspree · Basin · HubSpot Forms | **$10–75/mo** |
| 3 | **Media + transforms** — presigned upload, virus scan, signed transform URLs, cache tags | ✅ (library UI ❌) | Cloudinary · imgix · Uploadcare | **$99–250/mo** |
| 4 | **Transactional mail** — templates, render, log, suppressions, per-tenant stream isolation | ✅ | Postmark · SendGrid · Resend (templates tier) | **$15–100/mo** + volume |
| 5 | **Tenant webhooks** — signed, rotatable, delivery log, replay-safe | ✅ | Svix · Hookdeck | **$49–250/mo** |
| 6 | **Privacy / DSR** — find · export · erase, WS4-gated, per-submission consent, processor posture | ✅ | Osano · Transcend · Ketch | **$100–1,000+/mo** |
| 7 | **Environments + promotion** — export · promote · rollback, snapshots | ✅ | Contentful environments · Sanity datasets | bundled in enterprise tiers |
| 8 | **API keys, scopes, per-tenant quotas** — mint/rotate/revoke, peppered hashes | ✅ | bundled in CMS tiers | — |
| 9 | **Typed SDK + contract codegen** — OpenAPI-first, TS + PHP, **byte-identical double-run gate** | ✅ | Stainless · Speakeasy · vendor SDKs | **$250+/mo** |
| 10 | **Site registry / portfolio** — every client site, host, access level, adoption state | Schema ✅ · console PROTOTYPED | ManageWP · MainWP | **~$2/site/mo** |
| 11 | **Uptime · TLS · DNS observation** | reuses estate MON-01 | Better Uptime · Pingdom | **$20–100/mo** — benchmark §10 already scores this **SHOULD NOT HAVE BUILT** |
| 12 | **SEO audits + crawler** (`search-crawl-go`, `search_audits`, regression diffs) | ✅ | Semrush · Ahrefs · Screaming Frog | **$140–500/mo** — benchmark §6: **AHEAD on workflow, NOT A CONTEST on data** |
| 13 | **Repo provisioning + scaffolding from a signed PRD** | ✅ scaffolder · ❌ rail demand end | **No market equivalent** | — |

**Substituted subscription value at agency scale: roughly USD 700–1,900/month**, dominated by
rows 1, 3, 6 and 12. Against that, WebDesk's marginal infrastructure cost is a share of a box it
already occupies — which is precisely why **A-10 (§15 Cost & quotas) being unwritten is the most
commercially expensive open item in the program.** The ROI case cannot be made without it, and it
needs numbers only the owner has.

### 6.2 — Verdicts, in the benchmark's own scoring key

| Capability | Verdict | Why |
|---|---|---|
| **Tenancy + contract discipline** | **AHEAD** | FORCE RLS on 15+ tables with a second independent app-layer predicate and **proven mutual independence**; a frozen envelope; a byte-identical codegen determinism gate across two containers. No mid-market CMS ships defence-in-depth tenancy or a determinism gate. |
| **Composite scope** | **AHEAD** | CMS + forms + media + mail + webhooks + DSR + registry + SEO behind **one identity and one authz model** is not a product anyone sells. Buying the equivalent is 6–8 vendors, 6–8 seat lists and 6–8 audit surfaces. |
| **Headless CMS as a product** | **BEHIND** | No authoring UI, no editorial workflow, no scheduling worker, no CDN purge, no roles-for-editors. Contentful's moat is editor experience, and that is exactly the column at zero. |
| **Image delivery** | **COMPETITIVE** | imgproxy + MinIO is genuinely close to Cloudinary's core, minus the AI/auto-format layer. |
| **Deliverability** | **NOT A CONTEST** | IP warming and sender reputation are earned, not built. Keep an SMTP provider; never self-host the MTA. |
| **SEO data** | **NOT A CONTEST** | Benchmark §6 already ruled it — the crawler is ours, the backlink/keyword corpus never will be. |
| **Uptime monitoring** | **SHOULD NOT HAVE BUILT** | Benchmark §10, unchanged. |
| **Proof** | **ZERO** | No production users. Every green is Windows-provisional and predates the Linux-only rule. **This is the column that matters commercially, and it is the one at zero.** |

---

## §7 · What is left to fully substitute third parties

Ordered by what unblocks the most. **⭐ = on the critical path to "a client could use this."**

| # | Gap | Substitution it blocks | Ticket |
|---|---|---|---|
| 1 | ⭐ **Authoring UI** — the single largest gap | Contentful / Sanity / Storyblok | WSK-44 |
| 2 | ⭐ **Editorial identity seam** | all of them — nothing is usable by a human without it | WSK-40 |
| 3 | ⭐ **Control-plane read commands** (3 GETs vs 22 commands) | the console renders `stale:true` today | WSK-51 |
| 4 | ⭐ **Linux verification + containment probes** (v2.2 P1) | **everything** — no claim is currently evidence | WSK-D34 |
| 5 | **Scheduled publish worker** — `publish_at`/`unpublish_at` are columns with no scheduler; the forms retention purge has no scheduler either | CMS scheduling | new |
| 6 | **Rich-text primitive** | the content model is incomplete without it | WSK-45 |
| 7 | **Media library UI** | Cloudinary's DAM half | WSK-43 |
| 8 | **CDN cache purge** — cache tags are emitted; nothing purges on them | stale content after publish. A *correctness* gap, not a performance one | new |
| 9 | **Editor roles** — Cerbos kinds + the six artifacts each | client editors (WSK-49) | WSK-47 |
| 10 | **The rail's demand end** — nothing dereferences an artifact or a snapshot by id | PRD-driven provisioning, live | v2.2 §01 gap 1 |
| 11 | **Site search API** — `search_vector` exists, no endpoint | Algolia / Meilisearch | new |
| 12 | **Web analytics** — nothing at all | Plausible / Umami / GA | new (or buy — self-hosted Plausible is AGPL, same family as §4.1) |
| 13 | **Per-tenant cost + quotas (A-10)** | **the commercial case itself** | A-10 |
| 14 | **WordPress headless (P5)** · **deploy/preview/rollback (P6)** | Hostinger tier · Vercel / Netlify | v2.2 P5/P6 |
| 15 | **Backup + restore drill** — scripts exist, *"nothing ever run"* | any claim of durability | v2.2 §01 |

### The honest summary

**Capability: ~60% built. Proof: 0%.** WebDesk substitutes more subscriptions than anything else
in the estate and is further from being usable by a person than anything else in the estate — the
whole gap is the human-facing end (authoring, identity, reads, roles), which is exactly the end
Payload was standing in for and never actually filled.

Removing Payload does not create that gap. **It makes it visible, and it makes closing it free of
a licence, a trademark question and a per-seat bill.**

---

## §8 · Proposed decisions — for ratification into `webdesk-design-v2.md` §14

Drafted here, **not** self-ratified. Per the standing rule *"no ruling exists outside this log"*,
these belong in v2.2 §14 before any ticket cites them.

| # | Decision | Why |
|---|---|---|
| **WSK-D37** | **Payload is removed; WebDesk owns its editorial layer, and editorial identity is the ERP identity.** The authoring UI is a `content` module in `platform-ui`, not a standalone Zone B admin. **Supersedes A-01/R-1's Option-A ruling** (RLS under shared Payload) and **closes WSK-D25, OQ-2.8 and A-11** — dissolved, not deferred. The Option-D fallback trigger is retired unexercised: there is no third-party ORM left to fall back from. | Payload holds two collections, one of which its own config calls a boot stub; it is not in the `/v1` read path, owns none of the content model, and is what forces an Enterprise licence to reach ERP SSO. Three independent reasons stand without the cost argument (§1.3), and removing it deletes a documented fail-open (`PAYLOAD_ALLOW_PUSH` drops `tenant_isolation` while `relforcerowsecurity` still reads true) from the one internet-facing box. |
| **WSK-D38** | **The platform is called WebDesk. The phrase "the unified backend" is retired** (26 occurrences, 6 files); fixed vocabulary in §5. `webdesk/payload/` is renamed `webdesk/delivery/` in the same change that deletes the dependency. | One name, used by everyone, for a thing that has been described three ways in three documents. A directory named after a dependency it no longer has is how a placeholder gets mistaken for a foundation — the exact error this document had to correct. |
| **WSK-D39** | **Editorial writes ride the existing A→B control channel carrying a short-lived EdDSA editorial assertion (`exp ≤ 120s`, `jti` replay-checked). Zone B holds the PUBLIC key only. Cerbos decides in Zone A, always; Zone B verifies that an authorisation happened and never re-derives one. `principal_id` stays opaque.** | §03's containment statement survives verbatim: no new channel, no new credential class, no ERP secret on the internet-facing box. The schema already assumed it — `content_versions.created_by` is documented as *"Zone A principal id, opaque — attribution only."* Accepted cost, recorded not rediscovered: Zone B's own audit cannot resolve a principal, so the ERP ledger is the sole record — the same consequence already accepted for GitHub. |
| **WSK-D40** | **No WebDesk component may require a per-seat third-party account for a person who already has an ERP identity.** Refused at design time, not negotiated at renewal. Where a capability exists only per-seat: build it, or collapse the people behind one machine identity with the ERP ledger as the record. **Extends github-integration-foundation decision 1 from GitHub to the whole platform.** Licence hygiene rides along: pin or replace source-available Redis, never patch AGPL components (imgproxy, MinIO), keep A-13's storage abstraction test green as the standing exit. | A dependency that prices per human taxes every new editor, client contact and agent; one that prices per machine scales with the business. This is the first rule that converts the estate's identity layer — benchmarked **AHEAD of every ERP** — into avoided spend rather than architectural pride. |

---

## §9 · Open questions

| # | Question | Default if unanswered |
|---|---|---|
| **OQ-3.1** | Rich-text storage format — Lexical JSON, TipTap/ProseMirror JSON, or portable-text? It enters the **frozen** `/v1` envelope, so it is a contract decision with a vocabulary version bump. | Lexical JSON — closest to what the current dependency would have produced, so no consumer changes shape |
| **OQ-3.2** | Do client editors get the `content` module inside the existing client portal, or a narrowed editorial-only shell? | Existing client portal, narrowed by Cerbos — one shell, one RBAC |
| ~~**OQ-3.3**~~ | ~~Redis: pin ≤ 7.2, or swap to Valkey 8?~~ | ✅ **RESOLVED + DONE 2026-09-21 — Valkey 8.** Swapped across 8 services in 7 files (5 compose + both CI service containers), with `redis-server`→`valkey-server` and `redis-cli`→`valkey-cli` where present. Topology unchanged. **Server verification pending** |
| ~~**OQ-3.4**~~ | ~~SMTP provider (A-10 input, still unchosen)~~ | ✅ **RESOLVED 2026-09-21 — see [`vendor-independence-doctrine.md`](./vendor-independence-doctrine.md) §4.1.** Resend free tier now → SES at volume → Postmark as the named upgrade. Never self-host the MTA. The generic `MAIL_SMTP_*` wiring makes this reversible by env var |
| **OQ-3.5** | Does WSK-48 rehome `/v1` into `webdesk/api`, or keep a minimal standalone read gateway? | **Into `webdesk/api`** — one service fewer on the hardened box, and it already owns the tenant pool, key auth, scopes and quotas |
| ~~**OQ-3.6**~~ | ~~Is the Cloudflare Pages per-seat exposure (R-2) worth re-opening before P6?~~ | ✅ **RESOLVED 2026-09-21 — there is no per-seat exposure.** Workers Paid is **$5/mo per account**, not per seat; Cloudflare's per-seat product is Zero Trust/Access, which the estate does not use and must not adopt for auth. **R-2 stands.** Watch only that Pages *Functions* bill at Workers rates |
