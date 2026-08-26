# WebDesk — PROGRESS (source of truth)

**Started:** 2026-08-26 · **Design (build from this):** [`webdesk-design.md`](../blueprints/webdesk-design.md) **v1.1** ·
**Reassessment:** [`webdesk-design-reassessment.md`](../blueprints/webdesk-design-reassessment.md) v1.0

**Binding rule:** update the status in the SAME change that moves the work. A stale row here
misleads real tickets.

## Legend

| Mark | Means |
|---|---|
| ✅ | **DONE** = **DEV-VERIFIED** — driven end-to-end and the result observed. Not "the code exists", not "tests are green". |
| 🟡 | **ON PROGRESS** — someone is on it right now |
| ⬜ | **NOT DONE** — not started |
| ⏸ | **BLOCKED** — waiting on a ruling, a box, or another ticket |

> Estate status-language rule still applies to MODULES.md and CHANGELOG entries (`PLANNED` →
> `IN PROGRESS` → `PROTOTYPED` → `DEV-VERIFIED`). ✅ here = **DEV-VERIFIED**.
>
> **Nothing in this session is committed.** This is a shared checkout with concurrent sessions;
> the work sits in the working tree. ✅ does **not** mean merged, and no independent `qa` pass has
> run yet — the M0 gate (WSK-M0) is where that happens.

---

## Roll-up

| Part | Items | ✅ | 🟡 | ⬜ | ⏸ |
|---|---|---|---|---|---|
| A · Close the design | 13 | **10** | 0 | 1 | 2 |
| B · Milestone 0 — gaiada.com live | 13 | **5** | 2 | 6 | 0 |
| C · Contract, codegen & the rail | 7 | 0 | 0 | 7 | 0 |
| D · Control plane · ERP console · envs | 9 | 0 | 0 | 8 | 1 |
| E · AI execution & approvals | 3 | 0 | 0 | 3 | 0 |
| F · WordPress headless | 3 | 0 | 0 | 3 | 0 |
| G · New from reassessment | 2 | 0 | 0 | 2 | 0 |
| **Total** | **50** | **15** | **2** | **31** | **2** |

**Ticket count vs design v1.0:** 36 → **35 build tickets** (+WSK-00 spike from the R-1 ruling,
−1 from merging WSK-26+27 under R-2, −1 from merging the P1/P2 gates into one M0 gate), plus 2
new from the reassessment (Part G) and 13 design-close tasks (Part A).

---

## Owner rulings — 2026-08-26

Recorded here because both change what a ticket must DO, not merely when it runs.

- **WSK-D24 · the `/v1` SQL bypass — ACCEPTED, CONDITIONALLY.** `/v1` reads may keep the hand-rolled
  SQL router rather than going through Payload's query layer. The condition is not optional: the
  Payload-side app-layer tenant predicate (WSK-04b / WSK-D25) **must cover the `/v1` router too**,
  with the same mutual-independence proof WSK-04 ran on `api` — disable one layer, the other still
  returns zero rows, plus a negative control that leaks.
  ★ Why the condition carries the whole ruling: Payload's `access` functions never execute on the
  router path, so without it RLS is the *only* wall on the one read path the public can reach. That
  is precisely the single-wall posture WSK-04 exists to disprove, and a WSK-04b that covered only
  the collections would report DONE while leaving `/v1` single-walled.

- **A-12 · procurement — PROCURE NOW.** See the A-12 row.

## Part A · Close the design

| Status | # | Task | Owner | Notes |
|---|---|---|---|---|
| ✅ | A-01 | **R-1 ruled** — tenant isolation | owner | RLS under shared Payload **retained**. Risk accepted → WSK-00 spike + named-fork rule + app-layer defence + Option-D fallback trigger |
| ✅ | A-02 | **R-2 ruled** — FE hosting | owner | **Cloudflare Pages** adopted. WSK-26+27 merge; WSK-25 shrinks; `[PROC]` set → WSK-28 alone |
| ✅ | A-03 | Reassessment written + indexed | — | Doc written; linked from `BLUEPRINTS.md` |
| ✅ | A-04 | **R-4 — locale + pagination + error envelope in `/v1`** | owner (default) | **Adopted** → WSK-D18. Envelope amended in §05 before the freeze; `locale`, `localizations`, cursor pagination, RFC 9457 errors, `meta.x`. Closes in WSK-06 |
| ✅ | A-05 | **R-3** — derive SDKs from OpenAPI | owner (default) | **Adopted** → WSK-D19. `openapi.v1.json` hand-authored; TS/PHP/Markdown derived |
| ✅ | A-06 | **R-5** — data-protection posture | owner (default) | **Adopted** → WSK-D22 + §11 block. Processor role · DSR command · consent record · residency statement |
| ✅ | A-07 | **No-GraphQL standing decision** recorded | claude | WSK-D20 — both zones, with the Cerbos/perm-mirror rationale. Lockdown is an AC on WSK-02 |
| ✅ | A-08 | Staleness fixes S-1…S-3 applied | claude | Timestamp migrations (WSK-D21, §04) · copy the `finance` module pattern (§09) · **GDA-AI01 explicitly ruled out** as the Zone B box (§03) |
| ✅ | A-09 | **`webdesk-design.md` v1.1 published** | claude | 845 → ~1000 lines. §00/03/04/05/06/08/09/11/12/13/14 amended; 7 new decisions WSK-D16…D22; §12 delta table is authoritative over the v1.0 rows. **The army builds from this one file** |
| ✅ | A-13 | **Storage ruled — fully self-hosted** | owner | WSK-D23. MinIO primary, no new cost. R2/NAS kept as a config-only swap + abstraction test. Backups flip to **pull-model**; Workspace at staging, NAS target-state. New §11a preconditions. WSK-07 + WSK-28 rewritten |
| ⬜ | A-10 | Write §15 · Cost & quotas | claude+owner | Needs real numbers only you have: today's web3forms + hosting spend, target per-client price. Then per-tenant cost · quotas/overage · break-even count — which is what actually answers A-12 |
| ⬜ | A-11 | Payload governance + trademark check | owner | Ownership changed hands 2025; MIT is irrevocable for shipped versions, but rebranding touches trademark, which MIT does not license. ~1 hour |
| ✅ | A-12 | Procurement call (OQ-W1, now narrower) | owner | **RULED 2026-08-26 — PROCURE NOW,** ahead of Part B load data. Unblocks WSK-M0 and all of Part D, which were waiting on a box. ⚠ Sizing is a JUDGEMENT, not a measurement: A-10's numbers do not exist, and §11a named disk + bandwidth as the sizing inputs. Buy for headroom; treat first Part-B traffic as the check, not the spec. Cross-ref B24 (Hermes tracker) ruled *move gaiada observability to its own box* the same day — confirm whether these are ONE procurement before ordering |

---

## Part B · Milestone 0 — "gaiada.com lives on WebDesk"

**Gate:** our own site served from our own platform, our own forms off web3forms, security walls
real. This is the thin vertical slice — everything after generalizes a thing already in production.

| Status | # | Ticket | Tier | Deps |
|---|---|---|---|---|
| ✅ | WSK-00 | **RLS feasibility spike — VERDICT: PROCEED** with 3 mandatory conditions. Layer 1 8/8, layer 2 Local API 5/5 · jobs 2/2 · migrations 3/3 · **pooled-connection leak 6/6 with a negative control** · REST 9/9 · **admin SSR 4/6 FAIL but FAIL-CLOSED** (Next.js module-graph duplication of the ALS singleton — not an adapter defect). **No adapter patch needed** — `postgresAdapter({ pg })` is a typed extension point; mechanism is SESSION-at-the-pool, since Payload does NOT run plain `find` in a transaction. → `webdesk/spike-rls/payload/FINDINGS.md` — prove a per-request tenant GUC survives Payload Local API, REST, admin, jobs, migrations on a pooled connection. ≤2 days. Deliverable = probe suite. **Fails → Option D fallback, no fresh design round** | senior-db | — |
| ✅ | WSK-01 | Zone B project skeleton — compose (project `webdesk`, 9 services, dev profile), own ledger `0001+` + runner, RLS/backfill lint ported from platform-nest, `.env.example`, Caddy/otel/postgres configs | medior | — |
| ✅ | WSK-02 | **Payload 3 vendored + rebranded** — `postgresAdapter({ pg })` + ALS anchored on `globalThis`; `graphQL.disable` + no graphql route file + a separate public gateway process (denylist before allowlist, never imports payload/next); two-flag dev-push guard; telemetry off. **Coordinator-verified:** setup-schema → my RLS gate OK on 15 tables · **lockdown 11/11** (public `/admin`, `/api/*`, `/api/graphql` all 404; internal admin reachable) · push guard refuses a single flag · egress clean. ⚠️ **admin SSR first paint = CANNOT-VERIFY** (fails closed; Local API + REST clean) | senior-be | WSK-01 |
| ✅ | WSK-03 | Platform-core schema `0001`–`0004` (core · content+locale · forms+consent · mail), 15 tables all FORCE RLS, role split NOBYPASSRLS, + permanent 13-assertion probe suite | senior-db | WSK-01 |
| 🟡 | WSK-04 ⚡ | **Condition 1 already DEV-VERIFIED — `webdesk/scripts/check-rls-integrity.mjs`** (3-fact gate, selftest 6/6, wired into `npm test`; proven on a real 14-table migrated schema: PASS healthy → exit 1 when a table is disarmed **with its policy still present**, i.e. the case a force+policy-count check misses). Remainder: **RLS — the tenancy wall.** `opus·high`. Zero rows via *every* access path. **+app-layer scoping alongside** (R-1). **+4 conditions from WSK-00: (1) CI RLS-integrity gate asserting `relrowsecurity` AND `relforcerowsecurity` AND ≥1 policy per tenant table — a Payload **dev schema push** DISABLES row security and drops the policy while leaving `relforcerowsecurity=true`, i.e. FAIL-OPEN and invisible (`migrate` is clean; reproduced twice); (2) decide + encode how RLS survives Payload owning the schema (policy applied BY a migration, or push forbidden + mandatory re-apply); (3) a test pinning our `pg.Pool` subclass to the path Payload actually uses; (4) close the P10 admin-SSR gap (proposed `globalThis`-anchored ALS is UNTESTED)** | senior-db | WSK-00 ✅, 02, 03 ✅ |
| ✅ | WSK-05 | **API keys — DEV-VERIFIED**, `webdesk/api/` (NestJS+Fastify): mint/rotate/revoke (plaintext returned exactly once; sha256+pepper at rest, dump-grep proven — searched every `api_keys`/`audit_entries` column across every tenant for the minted plaintexts, found none); `ApiKeyAuthGuard` resolves key→tenant+env+scope from the route's `:tenantSlug` (never from the key itself, per 0001's own comment) and runs the request under `webdesk.tenant_ctx` (own `TenantAwarePool`, ALS anchored on `globalThis`, per WSK-00's mechanism); `ScopeGuard` (write implies read); per-tenant fixed-window read quota (`TenantQuotaService`/`TenantQuotaGuard`) closing the reassessment's noisy-neighbour AC — keyed by tenant, not by key, so rotating keys can't multiply a budget. 26/26 tests green (scope matrix, revoked-key probe dying on the very next call, no-key probe, plaintext dump-grep, quota isolation, a direct pool forced-reuse leak probe) against a fresh throwaway Postgres via the project's own `init-roles.sh` + `migrations/migrate.mjs`. **Gap flagged, not closed:** `/internal/tenants/:slug/api-keys*` has no control-channel auth of its own yet — WSK-21/22's job. **Needs 2 new vars in `.env.example`** (`API_KEY_PEPPER`, `WEBDESK_READ_QUOTA_PER_MIN`) — reported, not added (WSK-01's file). Not wired into `docker-compose.yml`'s `api` stub (also WSK-01's file) | senior-be | WSK-03 ✅ · **independently re-verified by coordinator** (documented runbook, fresh DB, migrations 4/4, RLS gate OK, `tsc` clean, **26/26 tests**). ⚠️ **Two carried risks:** `/internal/…/api-keys*` has **no control-channel auth of its own** — must NOT be exposed via the public proxy until WSK-21/22; and the read quota is **in-memory single-process**, so it under-enforces with >1 api replica (Redis drop-in shaped, `REDIS_URL` already in compose). |
| 🟡 | WSK-06 ⚡ | **Envelope `/v1` + vocabulary v1** — 8 primitives, 9 blocks, cache tags. **+R-4: locale, localizations, pagination, error envelope, `meta.x`. +redirects/sitemap collection. +tsvector search. +scheduled publishing.** ⚠️ **The freeze happens here** — shape now pinned in design §05 | senior-be | WSK-02 |
| ⬜ | WSK-07 | Media path — **self-hosted MinIO (WSK-D23)**, ClamAV, cookieless serving, imgproxy transforms. **4 buckets: `media` (public) · `video` (public) · `uploads` (PRIVATE, form attachments, presigned-only) · `artifacts` (platform)**. Versioning + object lock on. **AC rewritten: the API refuses cross-tenant prefix reads — storage creds never leave Zone B, no per-tenant keys.** +storage abstraction test (endpoint swap to R2/NAS = config only) | medior | WSK-01, 02 |
| ⬜ | WSK-10 ⚡ | Forms service — CORS allowlist, Turnstile, honeypot, rate limits, zod, retention. **+file uploads. +consent record (R-5)** | senior-be | WSK-04, 05 |
| ⬜ | WSK-11 | Mail service — provider adapter, BullMQ retry, per-tenant templates, suppression. Dev sink Mailpit; Brevo key on the Staging Reopen Register | senior-be | WSK-01 |
| ⬜ | WSK-12 ⚡ | Zone B→A signed events, both halves — HMAC emitter + `wd-zoneb-intake` + `webdev_zoneb_event_log` (**timestamp-named migration**) | senior-integrator | WSK-10 |
| ⬜ | WSK-08′ | **gaiada.com live** — real site on **Cloudflare Pages** (R-2) reading real content through a scoped key | medior | WSK-05, 06, 07 |
| ⬜ | WSK-M0 | **M0 QA gate** (merges old WSK-09+13) — cross-tenant battery × RLS × key scope × storage prefix, envelope contract suite, forms abuse battery, forgery/replay, retention purge walk, egress sweep, **GraphQL-off probe** | qa | all of B |

---

## Part C · Contract, codegen & the rail

| Status | # | Ticket | Tier | Deps |
|---|---|---|---|---|
| ⬜ | WSK-14 ⚡ | Vocabulary contract + composition validator; semver breaking-change rules as a checkable ruleset | senior-be | WSK-06 |
| ⬜ | WSK-15 ⚡ | **Codegen pipeline** — hand-author `openapi.v1.json`; derive TS SDK (`openapi-typescript`) + `CONTENT-CONTRACT.md` (R-3); byte-identical double-run CI gate; artifact store; `GET /control/v1/tenants/:slug/contract`; `contract.published` event | senior-be | WSK-14 |
| ⬜ | WSK-16 | Block-renderer library v0 — 1:1 per block type, unknown-block invariant (render nothing + report), versioned tarball | senior-fe | WSK-14 |
| ⬜ | WSK-17 | Proof rebuild — gaiada.com rebuilt purely from generated SDK + shared blocks, zero hand-written fetches | medior | WSK-15, 16 |
| ⬜ | WSK-18 | P3 QA gate — determinism double-run + cross-machine, SDK↔OpenAPI↔contract coherence, unknown-block probe, artifact-URL expiry | qa | WSK-14–17 |
| ⬜ | WSK-19 ⚡ | **Zone A contract-snapshot mirror** (rail, Zone A end) — `webdev` ModuleContract, **timestamp-named migration**, hash verify + immutability + refuse-on-mismatch alerting, `webdev.refreshContract` MCP tool | senior-be | WSK-15 |
| ⬜ | WSK-20 ⚡ | **`code.scaffold` v2** (rail, demand end) — FROZEN envelope, astro+node templates, SDK from snapshot tarball, `CONTRACT.lock`, conformance test, D-6 never-execute rule | senior-be | WSK-19 |

---

## Part D · Control plane · ERP console · environments

| Status | # | Ticket | Tier | Deps |
|---|---|---|---|---|
| ⬜ | WSK-21 ⚡ | Control-plane API v1 — idempotent commands, tracked jobs, immutable audit, Zone B Cerbos sidecar | senior-be | WSK-03 |
| ⬜ | WSK-22 ⚡ | Control-channel auth — Keycloak `webdesk-control`, offline JWKS verify, synccert mTLS, WS4 assertion mint + single-use verify. *Optional simplification: Cloudflare Access service tokens* | senior-integrator | WSK-21 |
| ⬜ | WSK-23 ⚡ | ERP module egress client + BFF — control client, proxy reads with degrade-to-facts, WS4 wiring, Cerbos `resource_webdesk_site` (+restart) | senior-be | WSK-19, 22 |
| ⬜ | WSK-24 | **Sites tab** (platform-ui) — registry with **backend-env / Pages-deployment split columns** (R-2), contract card **+ locale coverage row** (R-4), shown-once keys, WS4-gated release buttons, submissions | senior-fe | WSK-23 |
| ⬜ | WSK-25 | **Promotion engine (shrunk by R-2)** — snapshot-first → migrate → content export/import → **Pages deploy hook** → purge. Rollback = content restore + Pages rollback. *Re-rate from `opus·medium` at ticket time* | senior-be | WSK-21 |
| ⬜ | WSK-26′ | **Pages deploy + domain adapter** (merges old WSK-26+27) — per-branch preview URLs attached to `customer_feedback` gate rows (D-8 unchanged, only the URL source changes); `setDomain` via Pages custom domains. **Deploy token held in Zone A — Zone B never deploys frontends** | senior-integrator | WSK-25 |
| ⬜ | WSK-28 | **Zone B ops baseline** — box hardening runbook, secrets layout, synccert issuance, OTel + Zone A write-only OTLP listener, `wd-backup-sentinel`. **Backups per WSK-D23: local versioning + object lock, and a PULL-model nightly copy to a second box (Zone B holds NO credential for the backup target). Google Workspace becomes that target at staging; NAS is target-state.** **+stated RTO/RPO. +status page. +CDN-bypass check on every media path** | devops | A-12 |
| ⬜ | WSK-29 ⚡ | Deploy-tool wiring (Zone A) — `deploy.staging`/`deploy.production` at the control plane; `wd-contract-watch` live | senior-integrator | WSK-21–23 |
| ⏸ | WSK-30 ⚡ | **P4 QA gate (the boundary gate)** — full ERP-click walk on the **real box**: provision → deploy → promote → rollback; §03 adversarial matrix; boundary sweep (no Zone A creds/routes in Zone B); backup/restore evidence | qa | all of D + **the box** |

---

## Part E · AI execution & approvals

| Status | # | Ticket | Tier | Deps |
|---|---|---|---|---|
| ⬜ | WSK-31 ⚡ | MCP tool set over the command surface — `wf:webdesk` account, impact classes, WS4 routing, D14 registry entries + Cerbos `approvalId` arms written together | senior-integrator | WSK-21–23 |
| ⬜ | WSK-32 | AI schema drafting — PRD → validated composition proposal + diff summary → WS4 → `applySchema` | medior | WSK-15, 31 |
| ⬜ | WSK-33 | P5 QA gate — agent provisions from a PRD, human-approved, fully audited + **hostile-PRD injection battery** (must die server-side) | qa | all of E |

---

## Part F · WordPress headless

| Status | # | Ticket | Tier | Deps |
|---|---|---|---|---|
| ⬜ | WSK-34 | PHP SDK — **generated from `openapi.v1.json`** (R-3 makes this near-free); joins the determinism gate; `artifacts.sdkPhp` fills in | senior-be | WSK-15 |
| ⬜ | WSK-35 | Headless WP theme pattern — consumes the PHP SDK; `siteKind:"wp"` scaffold template joins WSK-20 | senior-fe | WSK-16, 34 |
| ⬜ | WSK-36 | P6 QA gate — WP renders entirely from the central API; Astro↔WP parity; unknown-block behaviour PHP-side | qa | all of F |

---

## Part G · New from the reassessment

| Status | # | Ticket | Tier | Deps |
|---|---|---|---|---|
| ⬜ | WSK-37 | **Per-tenant outbound webhooks** — clients receive their own form submissions in their CRM. Reuses the WSK-12 HMAC emitter | medior | WSK-12 |
| ⬜ | WSK-38 | **Data & Privacy** (R-5) — DSR find/export/delete a data subject's submissions as a WS4-gated audited control-plane command + the console card | senior-be | WSK-21 |

---

## This session (2026-08-26) — what changed

**Design phase closed.** The program went from *a v1.0 design with five open questions* to
*a v1.1 build document with none*. Eight decisions landed (WSK-D16…D23), two of them reversing
or narrowing earlier locks:

| | Decision | Effect on the build |
|---|---|---|
| D16 | RLS under shared Payload **retained** (owner) | WSK-00 spike added; WSK-04 gains app-layer defence + a written fallback |
| D17 | Client frontends → **Cloudflare Pages** (owner) | WSK-26+27 merge, WSK-25 shrinks, `[PROC]` set 3 → 1 |
| D18 | Envelope gains **locale**, pagination, RFC 9457 errors | Folded into WSK-06 before the freeze — avoided a future `/v2` |
| D19 | **OpenAPI-first** codegen | WSK-15 shrinks, WSK-34 near-free |
| D20 | **No GraphQL** in either zone | Lockdown AC on WSK-02, probe in the M0 gate |
| D21 | **Timestamp-named** migrations | Killed every stale numbering instruction |
| D22 | Data protection as a **role** | New §11 block, WSK-38, new console card |
| D23 | Storage **fully self-hosted** (owner) | MinIO primary; pull-model backups; §11a preconditions; WSK-07 + WSK-28 rewritten |

**Net shape change:** 36 tickets → 35 + 2 new. First production value moved from ~wave 9 to
Milestone 0. Procurement narrowed to one backend box, and now has sizing inputs (media disk +
bandwidth) it did not have this morning.

**Two things got *safer* as a side effect**, worth noting because neither was the goal:
Pages means Zone B holds no frontend deploy credential, and pull-model backups mean Zone B holds
no backup credential. Both shrink the blast radius §03 is built to bound.

**Still owner-side:** A-10 (cost numbers), A-11 (Payload trademark check), A-12 (the box).
None of them block Milestone 0.

---

## Session log

| Date | What moved |
|---|---|
| 2026-08-26 | Reassessment written + indexed in `BLUEPRINTS.md`. **R-1 ruled** (RLS under shared Payload retained; mitigations attached). **R-2 ruled** (Cloudflare Pages adopted). This tracker created. |
| 2026-08-26 | **WSK-02 DEV-VERIFIED (with one honest CANNOT-VERIFY).** Lockdown proven 11/11 in three independent layers. **Security fix applied by coordinator:** WSK-01's Caddyfile stub was routing `/admin*` to Payload on the **public** vhost — a direct contradiction of WSK-D20/D-5 that would have exposed the admin panel anywhere reachable. Public vhost now serves only `/v1`, `/forms`, `/media`, `/healthz` and explicitly 404s `/admin`, `/api/*`, `/control/*`; the internal listener is bound to **127.0.0.1** and a separate `payload-gateway` service is the only Payload process the public vhost may reach. `.env.example` gained the two listener ports + both push-guard flags. Cross-validation worth noting: my WSK-04 gate and WSK-02's own setup-schema check agree independently on the post-push schema. **Open:** admin SSR first paint still does not render rows (fails closed); carried to WSK-04 condition 4. |
| 2026-08-26 | **WSK-05 (API keys) DEV-VERIFIED + independently re-verified.** Coordinator re-ran it from scratch on the documented runbook: 26/26 tests, `tsc` clean, RLS gate OK on the fresh schema. Scope matrix, revoked-key (no cache window), no-key, quota, and a **dump-grep proof that no plaintext key exists in any column** all hold. `.env.example` gained `API_KEY_PEPPER` + quota vars. **Correction on the record:** an earlier local run of mine showed 5 failing suites and I implied the harness override was broken — it is not; a dead-port test proved the override is honoured. That failure was my own invocation. |
| 2026-08-26 | **WSK-04 condition 1 DEV-VERIFIED:** `scripts/check-rls-integrity.mjs` asserts `relrowsecurity` AND `relforcerowsecurity` AND ≥1 policy per tenant-scoped table. Selftest 6/6 (incl. the exact regression); proven live on a freshly-migrated 14-table Zone B schema — OK when healthy, **exit 1 when `sites` was disarmed as `webdesk_migrator` while its policy remained**, catching it purely on `relrowsecurity=false`. Wired into `npm test`. Side finding: `webdesk_owner` **cannot** disable RLS on migrator-owned tables — only the table owner can, so the migrator is the role to watch. |
| 2026-08-26 | **WSK-00 spike CLOSED — verdict PROCEED.** Coordinator ran layer 2 directly after the delegated agent stalled twice. Mechanism: a `pg.Pool` subclass via the adapter's **typed** `pg` option (not a patch) + AsyncLocalStorage, stamping the GUC at checkout and scrubbing at release — this works *below* Payload, which is what makes it hold on paths we do not author. **Biggest finding is not the one we chartered:** a Payload **dev schema push** (`PAYLOAD_ALLOW_PUSH=true` — an ordinary dev boot) **disables row security and drops the policy** while leaving `relforcerowsecurity=true` — so the table still looks protected and is **fail-OPEN**. Reproduced twice with a minimal repro. This caused a confident false-positive "jobs leak" mid-run. **Correction on the record: I first blamed `payload migrate`; direct test disproved that — migrate is clean.** WSK-04 now carries a 3-fact RLS-integrity gate. |
| 2026-08-26 | **WSK-01 + WSK-03 DEV-VERIFIED (coordinator-driven, not just agent-reported).** Fresh PG16 cluster → real `init-roles.sh` → 3 roles confirmed `rolsuper=f rolbypassrls=f` → `migrate.mjs` applied 4/4 from scratch → re-run `0 applied, 4 already in ledger` → `rls.spec.sql` all PASS, exit 0. **The WSK-01/WSK-03 role-bootstrap seam is resolved** (roles belong to the cluster-init script; the migration ledger contains no role DDL). WSK-00 layer 1 also PROTOTYPED, 8/8 with a real negative control. |
| 2026-08-26 | **Storage ruled: fully self-hosted** (WSK-D23). MinIO stays primary — no new recurring cost at this stage. R2 declined for now but kept as a config-only swap, protected by an abstraction test. Offsite backup becomes **pull-model** (Zone B holds no credential for the target) → second estate box now, **Google Workspace** at staging, NAS as target-state. New §11a pins the three preconditions that make self-hosted media viable: mandatory CDN, video off-box by default, disk/bandwidth as A-12 sizing inputs. WSK-07 and WSK-28 rewritten. |
| 2026-08-26 | **R-3, R-4, R-5 adopted as recommended** (owner: "proceed"; open to overturn on cause — but R-4's cost rises sharply once WSK-06 merges). No-GraphQL recorded as WSK-D20. Staleness S-1…S-3 applied. **`webdesk-design.md` folded to v1.1** with decisions WSK-D16…D22 and an authoritative §12 delta. Part A now 9 of 12; only owner-input items remain. |

---

## What's next, in order

**The design is closed and the architecture is de-risked.** WSK-00 returned **PROCEED**, so the
RLS-under-shared-Payload ruling now stands on evidence rather than hope, and the Option-D fallback
is not needed.

1. **WSK-02 - Payload 3 vendored + rebranded.** Now the critical path. Carries the GraphQL/raw-REST
   lockdown AC (WSK-D20). The spike's `payload.config.ts` + pool subclass are a working reference.
2. **WSK-04 - the tenancy wall**, with the three conditions from the spike. Condition 1 (the CI
   policy-presence gate) should land *first* - it is what stops a routine migration from silently
   disarming RLS.
3. **WSK-05 / WSK-06** follow. WSK-06 is where the `/v1` envelope freezes with the locale axis.
4. **A-10 / A-11 / A-12** remain yours: cost numbers, the Payload trademark check, the procurement
   call. None block Milestone 0.
