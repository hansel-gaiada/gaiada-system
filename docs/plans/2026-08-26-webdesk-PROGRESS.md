# WebDesk — PROGRESS (source of truth)

**Started:** 2026-08-26 · **Design (build from this):** [`webdesk-design.md`](../blueprints/webdesk-design.md) **v1.1** ·
**Reassessment:** [`webdesk-design-reassessment.md`](../blueprints/webdesk-design-reassessment.md) v1.0

**Binding rule:** update the status in the SAME change that moves the work. A stale row here
misleads real tickets.

## Legend

| Mark | Means |
|---|---|
| ✅ | **DONE** = **DEV-VERIFIED** — driven end-to-end and the result observed. Not "the code exists", not "tests are green". **⚠️ Owner rule 2026-08-26: verification must run on a LINUX SERVER, never the local Windows box.** Every ✅ below was obtained in Docker-for-Windows BEFORE that rule and is therefore **provisional** — see the re-verification note. |
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
| B · Milestone 0 — gaiada.com live | 14 | **12** | 0 | 1 | 1 |
| C · Contract, codegen & the rail | 7 | **7** | 0 | 0 | 0 |
| D · Control plane · ERP console · envs | 9 | **5** | 0 | 3 | 1 |
| E · AI execution & approvals | 3 | **2** | 0 | 1 | 0 |
| F · WordPress headless | 3 | 0 | 0 | 3 | 0 |
| G · New from reassessment | 2 | **2** | 0 | 0 | 0 |
| **Total** | **51** | **38** | **0** | **10** | **3** |

**Ticket count vs design v1.0:** 36 → **35 build tickets** (+WSK-00 spike from the R-1 ruling,
−1 from merging WSK-26+27 under R-2, −1 from merging the P1/P2 gates into one M0 gate), plus 2
new from the reassessment (Part G) and 13 design-close tasks (Part A).

---

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
| ⬜ | A-12 | Procurement call (OQ-W1, now narrower) | owner | Under R-2 only the **backend** box is gated. Decide staging-box timing against Part B's real load |

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
| ✅ | WSK-04 ⚡ | **The tenancy wall** — consolidated cross-path suite (`scripts/wsk04-cross-path-suite.mjs`) + **mutual independence PROVEN** (RLS off ⇒ app layer alone still isolates, with a negative control that leaks; app predicate omitted ⇒ RLS alone still isolates) + pool-subclass identity pin + condition 3 (**Option B**: push forbidden, generic `reapply-and-verify-rls.mjs` gated by `check-rls-integrity.mjs`). **Coordinator-verified:** 12/12 on a fresh migrated DB; gate exits 1 on a disarmed table, repair tool exits 1 when it cannot fix. ⚠️ **Two carried gaps — see session log:** Payload-side app-layer scoping is absent (independence proven only on `api`), and the repair tool's coverage is narrower than the gate's detection. Condition 4 (admin SSR) **left labelled**, reproduced on a clean env. | senior-db | WSK-00 ✅ |
| ✅ | WSK-04b ⚡ | **Payload-side app-layer predicate** (WSK-D25) — `src/tenant-access.mjs` reads the `globalThis`-anchored ALS directly and never touches Postgres, so the two layers genuinely fail separately. **Coordinator-verified:** mutual independence **19/19** incl. a negative control that **leaked both tenants** with the predicate removed, RLS restored and re-confirmed via the CI gate's own `evaluate()`; create-side positive control 4/4. ⚠️ **Only PARTIALLY closes the gap, structurally:** Payload runs `access` only `if (!overrideAccess)` and **Local API defaults it to `true`** — so REST gets two walls, the default Local API path gets RLS alone. Client reads unaffected (WSK-D24: `/v1` never touches Payload). **Needs a lint forcing `overrideAccess: false`** or the gap returns silently | senior-be | WSK-04 ✅ |
| ✅ | WSK-05 | **API keys — DEV-VERIFIED**, `webdesk/api/` (NestJS+Fastify): mint/rotate/revoke (plaintext returned exactly once; sha256+pepper at rest, dump-grep proven — searched every `api_keys`/`audit_entries` column across every tenant for the minted plaintexts, found none); `ApiKeyAuthGuard` resolves key→tenant+env+scope from the route's `:tenantSlug` (never from the key itself, per 0001's own comment) and runs the request under `webdesk.tenant_ctx` (own `TenantAwarePool`, ALS anchored on `globalThis`, per WSK-00's mechanism); `ScopeGuard` (write implies read); per-tenant fixed-window read quota (`TenantQuotaService`/`TenantQuotaGuard`) closing the reassessment's noisy-neighbour AC — keyed by tenant, not by key, so rotating keys can't multiply a budget. 26/26 tests green (scope matrix, revoked-key probe dying on the very next call, no-key probe, plaintext dump-grep, quota isolation, a direct pool forced-reuse leak probe) against a fresh throwaway Postgres via the project's own `init-roles.sh` + `migrations/migrate.mjs`. **Gap flagged, not closed:** `/internal/tenants/:slug/api-keys*` has no control-channel auth of its own yet — WSK-21/22's job. **Needs 2 new vars in `.env.example`** (`API_KEY_PEPPER`, `WEBDESK_READ_QUOTA_PER_MIN`) — reported, not added (WSK-01's file). Not wired into `docker-compose.yml`'s `api` stub (also WSK-01's file) | senior-be | WSK-03 ✅ · **independently re-verified by coordinator** (documented runbook, fresh DB, migrations 4/4, RLS gate OK, `tsc` clean, **26/26 tests**). ⚠️ **Two carried risks:** `/internal/…/api-keys*` has **no control-channel auth of its own** — must NOT be exposed via the public proxy until WSK-21/22; and the read quota is **in-memory single-process**, so it under-enforces with >1 api replica (Redis drop-in shaped, `REDIS_URL` already in compose). |
| ✅ | WSK-06 ⚡ | **`/v1` envelope FROZEN + vocabulary v1** — 8 primitives · 9 blocks · locale + `localizations` + `meta.x` · cursor pagination · RFC 9457 errors · cache tags · redirects + sitemap · scheduled publish · tsvector search. **Coordinator-verified:** vocabulary 40/40 · envelope contract **60/60** on a real migrated DB (two differently-composed tenants) · RLS gate OK 15 tables · **lockdown still 11/11 after I wired `/v1` publicly**. New `0005_tenant_locales.sql` (additive columns only). ⚠️ **See WSK-D24 — `/v1` reads bypass Payload's query layer entirely (hand-rolled SQL router); needs an owner ruling.** | senior-be | WSK-02 |
| ✅ | WSK-07 | **Media path** — 4 buckets (`media`/`video` public, **`uploads` PRIVATE**, `artifacts`) with versioning + GOVERNANCE object-lock verified via `mc`; EICAR refused + audit row; **corrected AC honoured** (cross-tenant → 404, no existence oracle, no per-tenant storage creds ever issued); cookieless serving + `Cache-Tag`; 3-layer storage-abstraction proof; per-tenant quota. 21/21 media, 47/47 combined with WSK-05. **Coordinator wired** `MediaModule`, the `imgproxy` compose service, and the media env vars. ⚠️ **imgproxy transform route is PROTOTYPED only** (no live instance was up during its run); **`STORAGE_ACCESS_KEY_ID` unset falls back to MinIO ROOT — dev-only, must be a scoped service account before A-12's box** | medior | WSK-01, 02 |
| ✅ | WSK-10 ⚡ | **Forms service — the web3forms kill** — CORS allowlist · Turnstile seam (stub; real key stays on the Reopen Register) · honeypot · per-IP + per-form rate limits · zod from `form_defs.schema` · consent record (WSK-D22) · attachments to the PRIVATE `uploads` bucket, ClamAV-scanned · retention purge sweep. **Coordinator-verified 23/23** on my own stack via its README runbook: hostile payload stored inert, EICAR refused, honeypot silently dropped, both notification + autoresponder landed in Mailpit. ⚠️ **Route deviates from the design's literal `/v1/forms/:formId/submit` → `/v1/t/:tenantSlug/forms/:formId/submit`**, forced by `0003_forms.sql`'s single-mode RLS (a form cannot be resolved by id before a tenant context exists); consistent with WSK-06's `/v1/t/:slug/…` shape. Purge sweep has no scheduler yet | senior-be | WSK-04 ✅, 05 ✅ |
| ✅ | WSK-11 | **Mail service (C-03)** — agent-reported DEV-VERIFIED, **coordinator verification IN FLIGHT**. Identity rule is the strong part: `resolveFromIdentity()` takes **zero arguments** and `MailJobData` has **no `from` field**, so a queued job physically cannot spoof identity; Zone A domains denylisted on both `From:` and `Reply-To:`; 3 test layers incl. a source-literal sweep and an `as never`-smuggled override. Retry proven by a **real `docker stop`/`start`** of Mailpit mid-flight. Suppression re-checked at worker time, not just enqueue. `mail_log` DELETE denied to `webdesk_app`. **Coordinator wired** `MailModule`, compose env passthrough, and reconciled `.env.example` (`MAILPIT_SMTP_URL` was dead config nothing read). ✅ **Coordinator-verified 25/25** on my own stack (its 6 specs incl. retry-backoff). Earlier I could not reproduce it: My own harness (pg/redis/mailpit on 55470-3, migrations 5/5 clean) got **11 passed / 13 failed**, all environment-shaped (blank `AggregateError`s, `ECONNREFUSED` to the hardcoded `:55450` default) despite exporting every env var I could find by reading the code. **Root cause is a missing runbook** — WSK-05 documented one I followed verbatim and reproduced 26/26 first try; this ticket shipped none. Also `mail-retry-backoff.spec.ts` shells `docker stop wsk11-mailpit` and, when that container is absent, **stalled for 2.8 hours** instead of skipping. **Root cause was undocumented shadow env vars** (`WSK11_APP_DATABASE_URL`, plus a `WSK05_TEST_DATABASE_URL` copy-pasted from another ticket) — my correct exports were silently ignored. Fixed: real env names, a documented runbook, and the retry spec now **skips in 3.3s** instead of stalling 2.8h. ⚠️ **Gaps:** `mail_log` has **no persisted render payload** — if Redis is lost a `queued` row can never be resent or diagnosed; no `tenants` domain column for the own-domain seam (adapter half only); the BullMQ worker runs **in-process** with `api`, not in the `worker` service | senior-be | WSK-01 |
| ✅ | WSK-12 ⚡ | **Zone B→A signed events, both halves** — first ticket to touch Zone A, and it added **only new files** there (verified). Emitter: HMAC-SHA256 over `timestamp.rawBody`, `timingSafeEqual`, fail-soft on every path. Zone A: timestamp-named migration with third-wall RLS + `ON CONFLICT DO NOTHING` idempotency + an MCP-reachable endpoint (n8n's backbone rule forbids DB nodes) + a new Cerbos policy. n8n flow driven against a **real throwaway n8n**. **Coordinator-verified:** 16/16 HMAC battery; shared-repo `lint:migration-names` + `lint:migration-rls` green across 193 migrations; `tsc` 0. Forgery/replay/mutation/future-date/malformed all refused **before parse** with distinct reasons. ⚠️ **Needs 5 edits to EXISTING shared files + a live Cerbos restart — owner sign-off (see log)**; notify recipient-routing deliberately left ungated-on-a-guess | senior-integrator | WSK-10 ✅ |
| ⏸ | WSK-08′ | **gaiada.com live** — **BLOCKED by WSK-D26's two collisions** (observe-only ruling on `delphi`/`helios`; neither host reachable) **plus a tenant-zero conflict**: gaiada.com is WordPress on Hostinger, so under D26 it stays there — which makes tenant zero P6 work, not Milestone 0. See the findings block below | medior | owner decisions |
| ⬜ | WSK-M0 | **M0 QA gate** (merges old WSK-09+13) — cross-tenant battery × RLS × key scope × storage prefix, envelope contract suite, forms abuse battery, forgery/replay, retention purge walk, egress sweep, **GraphQL-off probe** | qa | all of B |

---

## Part C · Contract, codegen & the rail

| Status | # | Ticket | Tier | Deps |
|---|---|---|---|---|
| ✅ | WSK-14 ⚡ | **Vocabulary contract + composition validator** — versioned public surface (barrel; existing direct imports unbroken), Layer-2 composition validator with actionable errors, and §05's **breaking-change rules encoded as a computed classifier** across all three axes. **Coordinator-verified:** 27 + 34 + 17 + 8 = **86 new assertions**, and WSK-06's 40 + 60 still green. Validates the two real tenants AND the live `redirect` collection, not just fixtures. ⚠️ **Three interpretations WSK-15/19 will inherit:** the `collections.schema` composition shape was **undefined anywhere** and is now de-facto `{fields?, blocks?}` (presence of `blocks` = closed set, absence = unrestricted); a newly-added **required** field is treated MAJOR though §05 only names optional-add as MINOR; the renderer axis still needs a human to flag which components broke — the bump is then computed, never re-judged | senior-be | WSK-06 ✅ |
| ✅⚠ | WSK-15 ⚡ | **Codegen pipeline** — **PROVISIONAL: verified on WINDOWS, not re-run on Linux.** OpenAPI hand-authored, TS SDK + `CONTENT-CONTRACT.md` **derived** (WSK-D19); pinned `openapi-typescript`/`tsx`. **Determinism proven properly:** two *separately spawned node processes* per tenant, byte-identical across 4 artifacts for two differently-composed tenants, with the `generatedAt` timestamp kept OUT of every hashed artifact (it lives only in `latest.json`). Replaced WSK-21's contract `501` with the real §06 shape, or an honest `404 contract-not-generated`. 46/46 + WSK-21/22 50/50. Found and fixed a real 500 (storage error escaping when the bucket is absent). ⚠️ `blockLibrary` is a documented placeholder (WSK-16 unbuilt); PHP SDK null (WSK-34); **`applySchema` does not yet trigger codegen** — manual/CI entrypoint only until WSK-19/32 | senior-be | WSK-14 ✅ |
| ✅ | WSK-16 | **Block-renderer library v0** — **the FIRST ticket verified on real LINUX** (`node:22-bookworm-slim`), per the 2026-08-26 rule. 9 components 1:1 with the vocabulary; props **mechanically cross-checked** against `BLOCKS[type].fields` rather than asserted, and round-tripped through the vocabulary's own `validateBlock()`. **Renderer invariant proven with real output:** an unknown `pricingTable` between a hero and a richText appears **0 times** in the built HTML while both known blocks still render; the QA hook captured it. `meta.draft` + `meta.x.localeFallback` both surfaced. Tarball (23 files, 14.6kB) genuinely `npm pack`-ed and installed by path into a separate consumer. Vocabulary **vendored with a drift check** (`vendor:check` in `prepack`) so a tarball consumer outside this repo still has ONE source of truth. 26/26 unit, `astro check` clean. Honest status: PROTOTYPED — nothing in-repo imports it yet (WSK-17/20 own that) | senior-fe | WSK-14 ✅ |
| ✅ | WSK-17 | **The proof rebuild — and it is real proof.** `dist/case-study/acme-rebrand/index.html` contains all 9 `data-block-type` markers **and** the distinctive seeded strings that exist nowhere but that run's Postgres: **Postgres → `/v1` → generated SDK → block components → HTML**, with **grep-proven zero hand-rolled fetches**. Linux-verified, RLS gate green twice. ⚠️ Findings handed back: codegen emits **types-only** (no runtime client — used `openapi-fetch`); `CONTRACT.lock.snapshotId` is a labelled placeholder because no hub tool can read the mirror (see WSK-20) | medior | WSK-15 ✅, 16 ✅ |
| ✅ | WSK-18 | **P3 QA gate** — all 4 conditions run for real, on Linux, each with a deliberate-break proof. **(1) Determinism cross-machine:** two INDEPENDENT Docker containers (own `npm ci` each, no copied node_modules), a DB-free fixture generator, byte-identical across 2 tenants + pinned tool versions compared, not assumed. **(2) SDK↔OpenAPI↔contract coherence:** cross-extracts schema/path/collection names from all three artifacts; a schema injected into `openapi.v1.json` alone is caught and NAMED. **(3) Unknown-block probe:** the system has two deliberately opposite behaviours at two moments — composition/authoring (WSK-14) genuinely REJECTS an out-of-vocabulary block type with an actionable, named error; render-time (WSK-16) genuinely skips-and-reports, by frozen design (§05 hard rule 2) — this gate probes the right one and documents the other rather than forcing a "fix" that would break a shipped invariant. **(4) Artifact-URL expiry:** the real `S3StorageAdapter.presignGetObject` against a real, throwaway MinIO — 200 before TTL, 403 "Request has expired" after, a fresh URL for the same object still works — both the check process AND MinIO ran as Linux containers on a shared network. Found and fixed 3 bugs of its own while building this (Windows-built node_modules copied into Linux — wrong platform binary; a missing `payload/package.json` silently flipping ESM→CJS resolution; a JSDoc comment defeating the coherence extractor's regex) — see `webdesk/qa/p3-gate/README.md` for each transcript. ⚠️ **Honest limits:** not wired into CI (`.github/workflows/` is out of this ticket's area); "cross-machine" is 2 Docker containers, not 2 physical hosts; condition 4 has no live-infra deliberate-break (TTL expiry is SigV4 math, not an app-level knob — the synthetic classifier selftest is the honest ceiling, matching `check-rls-integrity.mjs`'s own house pattern); nothing here ran against a live Zone B tenant (no box yet, A-12) | qa | WSK-14–17 ✅ |
| ✅ | WSK-19 ⚡ | **Zone A contract-snapshot mirror** — verified on a real **Linux** container. **Immutability is a DB TRIGGER**, not just an absent app route, so a direct UPDATE/DELETE is refused too. **Both tripwires proven with real output:** hash mismatch → refused with **zero writes**; same version + different bytes → **determinism breach**, alerts via an `outbox_events` row + a `severity:critical` activity, original row untouched, 409 to the caller. Lives in a **sibling** `src/modules/webdev-contracts/` because `webdev`'s own `egress-inventory.test.ts` statically asserts exactly one egress file there — same module key, same third-wall RLS. All six Cerbos artifacts + every pinned count. **Coordinator-verified: `src/rbac` 793/793 on Linux** (the 1 failure the agent saw did not reproduce). ⚠️ Control-channel auth is a **bearer stub** — real mTLS+KC+WS4 is WSK-22/23 | senior-be | WSK-15 ✅ |
| ✅ | WSK-20 ⚡ | **`code.scaffold` v2** — **WSK-D6 PROVEN, not asserted**: composes files and pushes, never runs `npm install`, never executes SDK/template code in the agent-runner. Tested **two ways** — statically (no `child_process` import; no `eval`/`new Function`/`vm.Script`/dynamic import) and dynamically (a real run's exec log contains only `git`). 77/77 on Linux; wider `ai-agents` 295 passed / 0 failed. ⚠️ **Cannot run live:** no hub tool reads a snapshot by id, downloads artifact bytes, or resolves a `pipeline_stages.artifact_ref` — I verified this (the report overstated it: `pipeline.*` tools DO exist, but none returns a snapshot or file bytes). Seams defined; a hub ticket must register them | senior-be | WSK-19 ✅ |

---

## Part D · Control plane · ERP console · environments

| Status | # | Ticket | Tier | Deps |
|---|---|---|---|---|
| ✅ | WSK-21 ⚡ | **Control-plane API v1 (Zone B)** — 18 commands / 6 controllers, every one carrying an §07 impact class asserted entry-by-entry; idempotency proven by double-fire (+ a DB unique constraint proven as an **independent cross-process backstop**); long commands job-tracked; audit row per command; authz **seam + dev stub only** (WSK-22 owns the real channel). **Coordinator-verified 36/36**, `tsc` 0 errors, WSK-05 26/26 no regression. **Caddyfile already 404s `/control/*` on the public vhost** — confirmed, so the exposure warning is satisfied today. ⚠️ **Two documented 501s** (`site.archive` needs a `sites.status` column; `contract.read` waits on WSK-15) and **no Cerbos sidecar** — interface + stub only | senior-be | WSK-03 ✅ |
| ✅⚠ | WSK-22 ⚡ | **Control-channel auth, layers 1-4** — **PROVISIONAL: built + agent-verified on WINDOWS, not re-verified on Linux** (owner rule 2026-08-26). 19-row adversarial matrix all refusing with distinct reasons: no cert · token-without-cert · wrong CA/CN · cert-without-token · wrong audience/issuer/kid · tampered signature · **missing WS4 on a HIGH command** · commandHash mismatch · expired assertion · **replay: same approvalId 201 then 403**. Layer-1 certs **actually issued by `synccert`** (real EC P256 CA via WSL), and the **real public issuer was proven reachable** with zero Zone A credential. ⚠️ **Deterministic matrix used a fixture JWKS** — no `webdesk-control` Keycloak client exists, so no token can genuinely verify against the real issuer. ⚠️ **WS4 dedup is a `SELECT` with no unique constraint** — closes realistic replay, not a concurrent double-fire; needs a migration. Proxy-side mTLS termination unbuilt | senior-integrator | WSK-21 ✅ |
| ✅ | WSK-23 ⚡ | **ERP egress + BFF console read model** — Linux-verified. 4 read endpoints under the `webdev` module, **no new Cerbos kind** (reused `webdev_provisioned_site:read` / `webdev_contract_snapshot:read`, so no policy edit and no restart). Reuses WSK-19's egress driver **verbatim — zero new egress code**, proven against BOTH directories' `egress-inventory` scanners. **The required degrade test passes:** live → 60s cache → last `contract.published` fact → explicit `unavailable`; killing the upstream keeps the **last-good version** with `stale:true, source:"cache"`, never nulled. 13/13 + 8/8 + 6/6; `platform-nest`+`webdev-contracts` 151/151. Claimed **§24** in FRONTEND-BFF-CONTRACT. ⚠️ **Site registry / releases / submissions are ALWAYS `stale:true`** — see the log; that is honesty, not a defect | senior-be | WSK-19 ✅ |
| ✅ | WSK-24 | **The Sites tab — the first actual WebDesk UI.** Registry with the **two independent columns kept independent** (backend env · frontend deployment: `delphi` staging / `helios` production / Hostinger for WP), contract card + locale-coverage row, shown-once key mint, WS4-gated release buttons rendering approval state inline, PII-aware submissions. **The load-bearing property is honesty about staleness, and it is what the tests assert.** WSK-23 proved these reads can *never* be live (WSK-21 exposes only `contract`, `jobs`, `jobs/:id` as GETs), so `stale:true` is the always-case — and the suite pins the distinction the estate's frontend-first-drift bug class turns on: a **genuinely-unavailable read renders differently from a confirmed-empty one** (`asOf: null`), the degrade banner sits **above** the table rather than being an empty-state one-off, zero sites renders a teach-state not a bare table, and the rare live case renders distinctly so `stale` is not the only state a viewer can ever see. **26/26 + `tsc --noEmit` 0 errors, run on LINUX** (`node:22-bookworm-slim`) per the server-only test rule — `platform-ui/node_modules` is broken on the Windows checkout (rollup native missing), which is an environment fault, not this ticket's. Shared-file edits verified **pure additions** (`+5 -0`, `+8 -0`) | senior-fe | WSK-23 ✅ |
| ⬜ | WSK-25 | **Promotion engine (shrunk by R-2)** — snapshot-first → migrate → content export/import → **Pages deploy hook** → purge. Rollback = content restore + Pages rollback. *Re-rate from `opus·medium` at ticket time* | senior-be | WSK-21 |
| ⬜ | WSK-26′ | **Pages deploy + domain adapter** (merges old WSK-26+27) — per-branch preview URLs attached to `customer_feedback` gate rows (D-8 unchanged, only the URL source changes); `setDomain` via Pages custom domains. **Deploy token held in Zone A — Zone B never deploys frontends** | senior-integrator | WSK-25 |
| ✅⚠ | WSK-28 | **Zone B ops baseline — authored, and honest that the box does not exist.** 9 deliverables: hardening runbook, secrets layout (zero secret values), synccert issuance written from `sync-engine-go/cmd/synccert`'s REAL flags, OTel + a **write-only** Zone A OTLP proposal, `wd-backup-sentinel`, WSK-D23 backups (local versioning + object lock, **pull-model** offsite so Zone B holds NO target credential — an `authorized_keys` forced-command, target initiates), stated RTO/RPO, status page, CDN-bypass check. **Two security properties are asserted by a check that FAILS in the wrong direction**, verified independently: `check-otlp-write-only` rejects a config carrying a `zpages` extension, and `check-cdn-bypass` flags a bypassable origin. Compose verified on **exit code** (`config` exit 0, dev and dev+ops), 12 env vars each wired into an `environment:` block. Caddy CDN gate driven live: unset→200, set+no/wrong header→403, set+correct→200. ⚠ **Coordinator addition — the gate was fail-OPEN:** the Caddy matcher is false when the secret is unset, so production with a missing var served `/media/*` unguarded and **no check complained** (`--probe` can't tell it from a dev box). Added `--assert-configured`; selftest 7/7 and all four directions driven. ⚠ Nothing past PLANNED until **A-12**; the Zone A OTLP listener needs `infra/observability/` (not owned); status page adds a new public `/status/*` route | devops | A-12 ⏸ |
| ⬜ | WSK-29 ⚡ | Deploy-tool wiring (Zone A) — `deploy.staging`/`deploy.production` at the control plane; `wd-contract-watch` live | senior-integrator | WSK-21–23 |
| ⏸ | WSK-30 ⚡ | **P4 QA gate (the boundary gate)** — full ERP-click walk on the **real box**: provision → deploy → promote → rollback; §03 adversarial matrix; boundary sweep (no Zone A creds/routes in Zone B); backup/restore evidence | qa | all of D + **the box** |

---

## Part E · AI execution & approvals

| Status | # | Ticket | Tier | Deps |
|---|---|---|---|---|
| ✅ | WSK-31 ⚡ | **MCP tool set + the automation identity** — **closes a LIVE PRODUCTION GAP**: before this, `wd-zoneb-intake`'s OBO envelope resolved to **no `identity_links` row → anonymous → Cerbos denied everything → every real bridge call 403'd**. `seed/automation.ts` now provisions `wf:webdesk-zoneb-intake`, confined by the hub allow-list to exactly `recordZoneBEvent` + `notify`. **42 assertions pin the always-WS4 rule** — HIGH-impact commands suspend for **every** principal class incl. a human admin; the impact-registry entry and the Cerbos `approvalId` arm written together (D14). New `operate`/`promote` actions land with their full six-artifact chain. **Coordinator-verified** (the agent parked 3× and never reported): rbac 793/793, webdev suites 187/187, mcp-hub 42/42, lints clean. ⚠️ Its Zone A control endpoints are **honest 501s** — the real command channel is WSK-22 | senior-integrator | WSK-21 ✅, 22 ✅ |
| ✅⚠ | WSK-32 | **AI schema drafting** — new `webdesk/api/src/schema-draft/` module: PRD → gateway `llm.extract(kind=webdesk_schema)` → parse → vocabulary validation (vendored WSK-14 rules, since NestJS commonjs cannot import `payload/vocabulary`'s ESM-`.ts` files — same constraint WSK-15 documented) → reviewer diff summary, **never persisted**. Reject-and-positive-control proven: unknown block type, unknown field primitive, and unknown composition key each refused with a distinct named reason; a clean additive proposal passes with zero issues. Diff summary flags a removed field/block, a new required field, and a required-flip as `destructive:true` with a data-loss message, and a purely additive diff as `destructive:false`. **Linux-verified (33/33)**: `tsc --noEmit` clean + `vitest run test/schema-draft` (6 files) on `node:22-bookworm-slim`, no Postgres/Cerbos needed (fakes throughout, matching `control-command-registry.spec.ts`'s own "pure" style). Applying a proposal still goes through the PRE-EXISTING, untouched `schema.propose`/`schema.apply` control commands (`webdesk/api/src/control/schema/`), so the D14/WS4 gate on the actual write is exactly what WSK-21 already shipped — this ticket adds nothing to `COMMAND_REGISTRY` and does not touch `control/`. ⚠️ Its own new route has only a self-built dev-mode header guard (not WSK-22's real mTLS/WS4 channel — `ControlModule` doesn't export the tokens needed to reuse it from a sibling module) protected today only by the pre-existing Caddy `/control/*` 404; and the gateway client is proven against a stand-in HTTP server, not a live ai-gateway-go — no live AI brain was reachable to drive kind=webdesk_schema end-to-end | medior | WSK-15 ✅, 31 ✅ |
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
| ✅⚠ | WSK-37 | **Per-tenant outbound webhooks** — **PROVISIONAL: verified on Windows, not Linux.** 32/32 across SSRF (19 unit), registration pre-flight, and end-to-end delivery on real PG+Redis+HTTPS sink. Signature reuses WSK-12's signer verbatim and is **independently verifiable by a receiver**; retry/backoff proven against a genuinely failing sink; cross-tenant isolation proven. **SSRF guard re-validates on EVERY attempt AND every redirect hop** (DNS rebinding + mid-delivery redirects), HTTPS-only, private/loopback/link-local/CGNAT/metadata denied on both address families — the metadata-address test proves **the sink's request log never grew**, i.e. nothing touched the network. Immutable delivery log (`REVOKE DELETE`). RLS gate OK on 16 tables. **Coordinator wired** app.module + forms.module + the step-10 dispatch + env/compose. ⚠️ **Corrected MY spec:** I said hash the secret like `api_keys`; a SIGNING secret cannot be hashed (HMAC needs the bytes back), so it is **AES-256-GCM encrypted** under its own pepper. ⚠️ Control endpoints share WSK-21's unauthenticated gap until WSK-22 fronts them | medior | WSK-12 ✅ |
| ✅ | WSK-38 | **Data-subject requests** — all three commands **HIGH/WS4-gated**, a deliberate widening: finding/exporting a person's whole footprint concentrates PII as much as destroying it. **Erasure = SCRUB not DELETE**; consent columns **preserved** (they evidence the notice, not the subject); attachments hard-deleted object-then-row with abort-before-mutate; the erasure recorded in an append-only `dsr_requests` ledger keyed on a **SHA-256 of the identifier** — so the proof of erasure cannot become a second un-erasable copy of the erased PII. 23/23, and the load-bearing test queries the ledger **after** erasure to prove it survived and the runtime role cannot UPDATE or DELETE it. RLS gate 17/17. ⚠️ Console card is WSK-24's; 2 pre-existing gaps flagged in `submissions-purge` | senior-be | WSK-21 ✅ |

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


## ⏸ Tenant-zero findings (2026-08-26) — two prerequisites WSK-08′ cannot proceed without

Established by direct, zero-touch inspection (DNS + HTTP headers), not from documentation:

| Fact | Evidence |
|---|---|
| **gaiada.com is on Hostinger** | Nameservers `ns1/ns2.dns-parking.com` (Hostinger's); A records `88.223.91.188`, `153.92.12.49` + `2a02:4780::/29` IPv6 (Hostinger ranges); response header **`platform: hostinger`**, `Server: hcdn` |
| **gaiada.com is WordPress** | `Link: <https://gaiada.com/wp-json/>; rel="https://api.w.org/"` — the WP REST discovery link |
| **It is NOT on `delphi` or `helios`** | Neither IP matches: `delphi` = `72.61.142.88`, `helios` = `187.77.116.133`, gaiada.com resolves to Hostinger space. Owner's belief confirmed |
| **Both boxes are unreachable from the dev machine** | SSH and HTTP to both time out — firewalled to specific sources or tunnel-only. Could not enumerate their vhosts; DNS made that unnecessary. Note both are **OBSERVE-ONLY** (owner ruling 2026-08-22) so nothing was modified |
| **No gaiada domain is on Cloudflare DNS** | `gaiada.com` → Hostinger `dns-parking.com`; `gaiada.online` → GoDaddy `ns37/ns38.domaincontrol.com` (`erp.gaiada.online` → `35.240.135.48`) |

### ✅ SUPERSEDED — the Cloudflare prerequisite is MOOT (owner ruling, 2026-08-26 later same day)

**WSK-D26 reverses WSK-D17/R-2: no move to Cloudflare, respect the current estate.** Hosting routes
by project type — **WP → Hostinger WP host** · **non-WP staging → `delphi`** · **non-WP production
→ `helios`**. No nameservers move, so the zone-control prerequisite disappears entirely.

**Net win:** frontend hosting needs **no new box**, so procurement (A-12 / OQ-W1) narrows to the
Zone B *backend* only.

**What the reversal reinstates** — work WSK-D17 had deleted:

| Ticket | Was, under Pages | Is again, under WSK-D26 |
|---|---|---|
| **WSK-26′** | one small "Pages deploy + domain adapter" | **splits back into two**: per-branch **preview slots on `delphi`** (D-8 gate-scoped, slot caps, TTLs) + **custom domains & TLS** |
| **WSK-25** | shrunk to content promotion + a deploy hook | **regrows**: FE artifact deploy, domain/TLS activation, purge/warm. Re-rate toward `opus·medium` again |
| **WSK-29** | tools pointed at a Pages token | deploy tooling must reach `delphi`/`helios` — see blocker 2 |

### ⛔ Two blockers WSK-D26 must clear before any frontend ships

| # | Blocker | Why it is hard |
|---|---|---|
| 1 | **`delphi`/`helios` are OBSERVE-ONLY** (owner ruling 2026-08-22: collect FROM, never modify ON) | Deploying a frontend *is* modifying them. Needs an explicit ruling lifting observe-only **for deployment**, which is a narrower question than re-authorising the monitoring agent tier |
| 2 | **Neither host is reachable from the dev machine** — SSH and HTTP both time out (`delphi` 72.61.142.88, `helios` 187.77.116.133) | Access is clearly *intended* (both are in `~/.ssh/config`), so this is an allowlist / tunnel / CI-identity question. WSK-29's deploy tooling needs the same answer |

### Tenant zero, under the new rule

`gaiada.com` is **WordPress on Hostinger**, so WSK-D26 keeps it on the WP host — making tenant zero
a **headless-WP** case (Phase 6: WSK-34 PHP SDK + WSK-35 theme), not the Astro/Node path Milestone 0
assumed. Options: pull P6 forward for our own site, or make tenant zero a **non-WP site on `delphi`**
and let gaiada.com join at P6.

Hostinger is **shared hosting** — per `infra/runbooks/onboard-server.md` there is no shell-access
model, so any migration is a DNS + content-export exercise, never a server-side one.

---

## Session log

> **Pushed `f14cb3f5` — WSK-20 + WSK-17 + WSK-38, plus a vendor drift I caused.**
>
> **🐞 THE DRIFT WAS MINE, and WSK-16's own guard caught it.** Fixing the media validator in
> `payload/vocabulary` left `webdesk/blocks`' **vendored copy stale** — exactly what WSK-16 built its
> `vendor:check` for. Re-vendored, and then its regression guard failed **by design**, with the
> instruction written into the assertion message: *"if this now passes, the gap has been fixed
> upstream — flip this and delete it from the set"*. I followed it. The set is now **empty rather than
> deleted**: it is the seam where the next such gap gets recorded, and that loop is what turned an
> invisible bug into a failing test. Blocks 26/26; gallery + logoCloud now validate.
>
> **⚠️ A REAL SCOPE GAP, verified not assumed:** WSK-20 cannot run live because **no hub tool reads a
> contract snapshot by id, downloads artifact bytes, or resolves a `pipeline_stages.artifact_ref`.**
> I checked before recording it — the report claimed "zero pipeline tool registrations", which is
> wrong (`pipeline.createRun/getRun/...` exist), but the specific reads genuinely do not. §06 assumed
> them. **Someone must register them, or the rail's demand end stays fake-driven.**
>
> Also removed `webdesk/postgres/init-roles.sh;C` — an empty dir created by the MSYS path-mangling
> trap during **my own** WSK-01 verification, which then broke a bind mount for WSK-17.


> **Wave dispatched 2026-08-27 — 4 agents, partitioned so they cannot collide:**
> **WSK-24** owns `platform-ui/src/app` + components (the FIRST UI) · **WSK-17** owns a new
> `webdesk/sites/` · **WSK-20** owns `ai-agents/` · **WSK-38** owns `webdesk/api/src/privacy/`.
> Each prompt carries the hazards this session has actually paid for: foreground-only (nine stalls),
> Linux-only verification, the MSYS docker-path trap that fails green, the six-artifact Cerbos tax,
> `docs/MAP.md` being generated — and newly, **"Cerbos must be REACHABLE"**, because a dead sidecar
> produced 296 phantom failures twice and I nearly reported a security regression that did not exist.
>
> Each also carries the honest-limits requirement that has produced this session's best findings:
> WSK-24 must make staleness **visible** (WSK-23 proved those reads can never be live); WSK-17 must
> report **which link of the rail broke** rather than rendering fixtures; WSK-20 must **prove** it
> never executes snapshot-derived code (WSK-D6); WSK-38 must **explain** how erasure coexists with an
> immutable ledger rather than issuing an unexamined DELETE.


> **🐞 A LATENT BUG OF MINE, found by WSK-31, fixed in `61074252`.** `position_roles_guard()`
> refuses to attach a role to a position if that role's bundle holds even ONE `ui_grantable=false`
> permission. My WSK-12 migration granted `webdev.zoneb_event.record` — flagged false — directly to
> `company_admin`/`manager`/`owner`/`platform_admin`. WSK-31 followed the precedent and added two more.
>
> **It was invisible because production is fine.** I checked live before acting: the row pre-existed
> with `ui_grantable=true`, so `INSERT ... WHERE NOT EXISTS` skipped and the flag stayed true —
> `manager`/`company_admin`/`owner` do not appear in the broken-roles list at all. But on a **fresh**
> database (CI, a new environment, **the Zone B box when it lands**) the insert runs, the flag lands
> false, and **no position can ever hold `manager` again**. That is why `positions-controller` and
> three seed suites were red on this checkout while live was healthy.
>
> **The fix is `true`, not a guard workaround.** The Cerbos policies genuinely grant these to human
> roles; `ui_grantable=false` asserted the opposite. I made that call in WSK-12, corrected the
> *description* at the time, and left the *flag* wrong — the same overclaim, half-fixed.
> **`202608271400` was NOT edited** — it is applied in production, and editing an applied migration
> only ever reaches fresh databases, which is the exact bug class that put two wrong functions into
> production this month. A new idempotent, self-asserting migration instead.
> Verified on a fresh DB: rbac + positions **804/804** (positions was 5/11), seeds 28/28.


> **Pushed `f6a29bbf` — WSK-23 + WSK-31.** Both Linux-verified with **Cerbos actually reachable**.
>
> **⚠️ A false alarm I nearly reported as a catastrophe — worth remembering.** An earlier run of the
> same rbac suite showed **296 of 793 failing**, including cross-root boundary tests. I was one step
> from calling it a serious regression in WSK-31's uncommitted work. It was **my harness**:
> `gaiada-cerbos-1` had exited 3 hours earlier, so every authz call was `TypeError: fetch failed`.
> With `CERBOS_URL` pointed at a live instance: **793/793**. "Tests fail" and "the code is broken"
> are not the same claim, and the gap between them is where a bad call gets made.
>
> **Cross-ticket scope conflict, now resolved by fact:** WSK-31's control endpoints assumed WSK-23
> would deliver a live Zone B **command** client. WSK-23 delivered **read-only** (correctly — there is
> no command channel until WSK-22 lands). WSK-31 therefore ships **honest 501s** rather than pretending.
> The reconciliation is: **WSK-22's real channel is the blocker for both**, not a disagreement.


> **🚀 LIVE at `Alpha 01.071.0190a`, and my work is ON it — verified, not assumed.** Another session
> tagged past my 0189a; 0190a is cut from the same main, so it carries WSK-19/16/37 + the IAM chain.
> Confirmed on the live database: **3/3 migrations applied**, `webdev_contract_snapshots` has RLS
> **enabled AND forced** with a policy, the **immutability trigger exists**, and all four
> `webdev.zoneb_event.*` / `webdev.contract_snapshot.*` permission rows are present. **CI is green
> again** — the finance shard failures cleared.
>
> **⚠️ A REAL ARCHITECTURAL FINDING from WSK-23, worth more than the ticket:** the console's site
> registry, releases and submissions **cannot be live**, because **WSK-21's control plane ships only
> THREE GET routes** (`contract`, `jobs`, `jobs/:id`) — everything else is a write command. So those
> three reads are built from Zone A's own facts and are **honestly always `stale:true`**. That is the
> right call (the alternative is a console confidently rendering an empty list), but it means
> **§08's registry needs read commands on the Zone B control plane that nobody has scoped.**
> WSK-24 must read §24's "stale:false is rare" warning before building.
>
> **⚠️ Cross-ticket conflict to reconcile:** WSK-31 (concurrent) built `webdesk.*` tools whose comments
> assume WSK-23 delivers a live Zone B **command** egress client. WSK-23 delivered a **read-only**
> proxy reusing WSK-19's GET-only driver. Neither is wrong; they disagree about scope.


> **Pushed to main 2026-08-27 — `9a7c8be2`, 92 files.** WSK-19 + WSK-16 + WSK-37 + the vocabulary
> bug fix. Staged file-by-file against `origin/main` in a worktree, and **every shared file was
> diffed in BOTH directions first** — `package.json` (finance's CI scripts) and
> `src/core/webdev-change-requests*` (another session's bug-intake work) were identified as not mine
> and deliberately excluded. `docs/MAP.md` regenerated from the clean worktree.


> **🐞 WSK-16 found a real bug in the frozen vocabulary, and it broke TWO of the nine block types.**
> `primitives.ts`'s `media` validator ignored `field.multiple` while `relation` honoured it — so
> `gallery.items` and `logoCloud.logos`, both declared `multiple: true` media in `blocks.ts`, could
> **never** pass `validateBlock()`. Confirmed by reading both branches, then fixed by mirroring the
> `relation` branch exactly. **Proven, not assumed:** gallery + logoCloud now validate, a bare object
> is refused (`expected an array of media objects`), and a member missing `url` is refused. WSK-06's
> 40 and WSK-14's 78 assertions all still pass.
> **Why it survived until now:** every existing test fed those blocks fixtures that happened to avoid
> the multiple-media path, and the renderer never called the validator. It took a ticket that
> round-tripped props through the vocabulary's OWN validator to surface it — which is exactly what
> WSK-16 was asked to do and did.


> **WSK-37 corrected an instruction of mine, and was right.** I specified the webhook signing secret
> be "hashed at rest the way `api_keys` does — sha256 + pepper". That is correct for a *verification*
> secret and **mathematically impossible for a signing one**: HMAC needs the original bytes back and a
> one-way hash cannot return them. It implemented AES-256-GCM under a separate pepper instead, same
> custody model (Zone B env only, never in DB or git), and flagged the deviation rather than either
> following a broken spec or silently diverging. That is the behaviour these prompts are asking for.
> **Also worth carrying to §03:** this is the **first client-controlled egress destination** in the
> design — every other row in the egress table names an operator-chosen host. §03 should say so.


> **🚀 DEPLOYED 2026-08-27 — live is `Alpha 01.071.0188a`.** The WebDesk rail + control channel +
> the first Zone A bridge shipped through the normal pipeline (main -> tag -> release -> deploy).
> **Verified on live:** `webdev_zoneb_event_log` migration applied, table has RLS **enabled AND
> forced** with 1 policy. Cerbos restarted as part of the deploy.
>
> **Three follow-ups from the deploy, stated honestly:**
> 1. **CI red on my commits was partly mine and is now fixed.** The WSK-12 Cerbos kind landed without
>    its **six coupled artifacts**; IAM-07b caught it. All six closed in `03d6caa1` (catalog, groups,
>    a seeding migration, BOTH bundle resolvers, the regenerated bundle, and every pinned count with
>    its own note). `src/rbac`: 40 files / 792 tests / 0 failures.
> 2. **The remaining CI red is NOT mine.** All four `platform-nest` shards have failed since
>    `a4a84292` (a finance commit); `100bf749` = 0184a was the last green. This is the known
>    finance+rbac interaction — pass alone, fail together. Finance session's area.
> 3. **Could NOT prove the live Cerbos loaded the new policy.** Probes were inconclusive: a kind
>    Cerbos has never heard of denies identically to one it knows, and a control probe against
>    `webdev_provisioned_site` (which certainly exists) also denied, so the principal was
>    under-specified. The admin API is 404 (disabled). Real proof needs an end-to-end call once
>    **WSK-31** provisions the `wf:webdesk-zoneb-intake` identity. Until then the bridge is
>    **fail-closed on live** — the permission rows ship with the NEXT tag, so every call 403s.


> **2026-08-27 — a bug I introduced, caught by WSK-15, now fixed.** My WSK-12 hook made `FormsService`
> inject `ZoneBEventEmitterService`, but I registered `EventsModule` only in `AppModule` — not in
> `FormsModule`, where the injection happens. That breaks a full `AppModule` boot. `forms.module.ts`'s
> OWN header comment states the rule I broke: injection resolves against providers visible to the
> injecting module, not transitively. Fixed by importing `EventsModule` there. **This is the exact
> failure mode of applying an agent-reported edit without booting the app** — `tsc` was clean both
> before and after, so only a real boot (or WSK-15's run) could surface it.
> Also updated WSK-21's now-stale `expect(501)` contract test to the `404 contract-not-generated`
> surface WSK-15 shipped, keeping the assertion that actually matters: **never a fabricated artifact**.


> **⛔ THREE HARD BLOCKERS on "push → deploy → verify", found 2026-08-26/27:**
> **(1) WebDesk is in NO workflow.** `grep webdesk .github/workflows/` = zero hits. No job builds a
> webdesk image, so there is nothing to deploy even once a box exists. Unscoped work between WSK-28
> and the WS10 pipeline program.
> **(2) The branch would ROLL THE LIVE STACK BACK.** `webdesk-zone-b-2026-08-26` is **30 commits behind
> `origin/main`**; its VERSION is `0173a`, live runs `0184a`, main is `0187a`. Tagging from it builds
> 0173a images and reverses 11 builds — the estate's own stale-tag footgun. **Must rebase onto main and
> bump to 0188a BEFORE any tag.**
> **(3) Zone B has no box** (A-12). So the Zone B half cannot be deployed, therefore cannot be
> server-verified, therefore its greens cannot stop being provisional. **A-12 now gates the whole
> verification approach, not just WSK-28.**
>
> Zone A's half (bridge migration + consumer + Cerbos policy + hub allow-list) IS shippable through the
> existing pipeline once rebased — and it runs a migration against the LIVE database, so it wants a
> deliberate go-ahead, not a batch. Push itself is currently blocked by the permission classifier.


> **⛔ STANDING RULE CHANGE — 2026-08-26: all tests run on a Linux server, never locally.**
> Local is Windows; the servers are Linux. This is not cosmetic — three Windows-only artifacts bit us
> this session and none exist on the target platform: MSYS silently rewriting container-side docker
> paths and **failing green**, a `cp1252` console-encoding crash that killed a script mid-write, and
> CRLF/LF churn on every `git add`.
>
> **Consequence, stated plainly: all 24 ✅ in this tracker are PROVISIONAL.** Every one was verified in
> Docker-for-Windows. Under the new rule none of them count until re-run on Linux. The code is not in
> doubt — the *evidence* is, and this program's whole discipline has been evidence over assertion.
>
> **Re-verification is now a real work item** and the natural owner is **WSK-M0**, the Milestone-0 gate,
> which already had to run every suite at once. Reachable Linux hosts with Docker (probed 2026-08-26):
> `sumopod` (6.8, **4 cores**, observability hub) · `gda-aicenter` (6.1, 2 cores — **the LIVE ERP box,
> ~13 containers; heavy suites here can degrade production**) · `aire-vps` (6.8, 2 cores, another
> project). `gda-ai01` unreachable; `delphi`/`helios` observe-only AND unreachable.
> **Blocked on an owner decision: which host is the test host.**


> **2026-08-26 — WSK-12's 5 shared-file edits APPLIED by coordinator, all additive, all verified:**
> `forms.service.ts` emit hook (step 9, best-effort — the agent's suggested `form.siteSlug` did not
> exist on `ResolvedForm`, corrected to `tenantSlug`) · `platform-nest/src/app.module.ts` controller ·
> `modules/webdev/index.ts` migration + one `mcpTools` entry · `mcp-hub/src/automation-policy.ts`
> allow-list. **`tsc` 0 errors in webdesk/api, platform-nest AND mcp-hub;** webdev suite 25/25.
> `docs/modules/CAPABILITY-INVENTORY.md` regenerated via `UPDATE_INVENTORY=1` — **diff checked before
> trusting it: 5 insertions / 4 deletions, only my tool + the counts it moves, no concurrent session's
> work baked in.** The agent's reported pre-existing drift did not reproduce.
> **NOT done deliberately:** restarting the LIVE Cerbos. That is a production action and nothing is
> deployed — it belongs to deploy time. The dev Cerbos was already restarted by the agent.


> **⛔ WSK-12 needs owner sign-off before it is live — 5 edits to EXISTING shared files + a restart.**
> Zone B's side is wired (EventsModule, env vars, compose passthrough — all mine, done). Outstanding:
> (a) `webdesk/api/src/forms/forms.service.ts` — the actual emit hook in `submit()`;
> (b) `platform-nest/src/app.module.ts` — register `ZoneBEventsController`;
> (c) `platform-nest/src/modules/webdev/index.ts` — append the migration + one `mcpTools` entry;
> (d) `mcp-hub/src/automation-policy.ts` — allow-list `wf:webdesk-zoneb-intake`;
> (e) **restart the live Cerbos** so the new policy loads (nothing hot-reloads — standing trap).
> Until (a)-(e) land the bridge is inert: the emitter has no hook and every real call 403s — which is
> the correct fail-closed state, and WSK-31 still owes the `wf:webdesk-zoneb-intake` service identity.
> **Also note:** the agent restarted the SHARED `gaiada-cerbos-1` dev container to load its policy.
> Additive only, and it re-ran the sibling suite green afterwards — but other sessions share that box.


> **⚠️ Two accumulating patterns to fix before WSK-M0 — neither is one ticket's bug:**
> **(1) Test-harness env naming is fragmenting.** Four different names now mean "the app DB URL":
> `APP_DATABASE_URL`, `WSK05_TEST_DATABASE_URL`, `WSK11_APP_DATABASE_URL`, `WSK21_TEST_DATABASE_URL`.
> WSK-21's are *documented* (unlike WSK-11's, which were not) so they are reproducible — but the gate
> has to run every suite at once, and per-ticket prefixes make that a puzzle. Normalise on the real
> names the app code reads.
> **(2) In-memory single-process state, now in three tickets:** WSK-05's read quota, WSK-11's BullMQ
> worker running in-process, and WSK-21's idempotency store + jobs registry. Each is correct for a
> one-container topology and each silently under-enforces at two replicas. Decide deliberately
> (Redis/DB-backed) rather than discovering it at the first scale-out.


> **2026-08-26 — owner authorised Zone A work.** The connection path (WSK-21 → 22 → 23 → 24) is
> unblocked. WSK-12 is the first ticket to touch `platform-nest`/`automation`, under tight rules:
> **new files only, no edits to existing Zone A files** — any needed edit is reported to the coordinator.
> That is the direct lesson from this session's two seams and the debug block a concurrent commit captured.
> **Honest scope note:** there is still **zero** live connection between the ERP and WebDesk — no `webdev`
> module, no BFF route, no MCP tool, no event flow, and **no UI at all**.


> **Full `webdesk/api` suite, coordinator-run 2026-08-26: 105/107, `tsc` 0 errors.** The 2 failures were
> **WSK-07's** media specs and were purely my missing env (`MINIO_*`, `WEBDESK_MEDIA_MAX_UPLOAD_BYTES`) —
> both pass once set. **WSK-07 shipped no verification runbook**, the same gap that cost hours on WSK-11;
> it should get one before WSK-M0.


> **WSK-04b caveat worth re-reading before WSK-M0:** the Payload predicate is real and proven, but
> Payload's Local API defaults `overrideAccess: true`, so the second wall is opt-IN there. Two existing
> project callers rely on that default and therefore run RLS-only today. A lint is the fix.


> **Committed 2026-08-26:** `c943a586` on branch **`webdesk-zone-b-2026-08-26`** — 66 files, +5482/-32,
> made via `git worktree` so the shared checkout's HEAD (another session's `office-floor` branch) was
> never moved. Also removes the 8-line debug block a concurrent commit had captured into history.


| Date | What moved |
|---|---|
| 2026-08-26 | Reassessment written + indexed in `BLUEPRINTS.md`. **R-1 ruled** (RLS under shared Payload retained; mitigations attached). **R-2 ruled** (Cloudflare Pages adopted). This tracker created. |
| 2026-08-26 | **WSK-04 + WSK-07 DEV-VERIFIED.** WSK-04 proved WSK-D16's mutual independence for real: with RLS disabled the app-layer predicate alone still isolated tenants (negative control leaked, so the predicate did the work), and with the app predicate omitted RLS alone still isolated. Condition 3 ruled **Option B** — push forbidden + a generic reapply step — rejecting a migration-based fix because a migration's `up()` runs once and would never cover future collections. **Three real gaps recorded rather than absorbed:** (1) **Payload's collections have NO independent app-layer tenant filter** — mutual independence is proven on `webdesk/api` only, so WSK-D16's guarantee is **not yet symmetric**; needs an `access` predicate in `payload.config.ts`. (2) The repair tool scopes to `relowner = current_user`, but **all 16 tables are owned by `webdesk_migrator`** — so run as owner it silently matches nothing; it exits 1 and says GATE FAILED (fail-loud, correct) but gives no hint to re-run as the owning role. (3) Jobs path unprobed — `payload.config.ts` has no `jobs` block. **Git hygiene:** a concurrent session's commit captured an 8-line debug block into HEAD; my working tree has it removed and is correct — **HEAD is not**. |
| 2026-08-26 | **WSK-06 DEV-VERIFIED — the `/v1` contract is FROZEN.** 40/40 vocabulary + **60/60** envelope contract assertions on a real DB, re-run by coordinator. **A real bug its own AC caught:** `pg` parses `timestamptz` to a millisecond-precision JS `Date` while Postgres stores microseconds, so a cursor built from the truncated value re-returned the boundary row on the next page — reproduced live, fixed by building the cursor from `created_at::text` and never round-tripping through `Date`. Exactly what "pagination stable under concurrent publish" exists to catch. **Coordinator wired the blocker:** WSK-06 was fenced out of `app/**`, so I added `app/(payload)/v1/[...slug]/route.ts` and the compose `DATABASE_URI`/`API_KEY_PEPPER` vars; **lockdown re-verified 11/11 afterwards**. |
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

> **WSK-24 closed — the first WebDesk UI, and the 🟡 column is now empty.** 35 ✅ · 0 🟡 · 13 ⬜ · 3 ⏸.
>
> Two things worth keeping from how it was verified:
>
> 1. **The agent parked without reporting for the tenth time this wave**, so its work was assessed
>    directly rather than nudged again. That assessment is the only reason the next point was found.
> 2. **The local test run was meaningless and would have read as a pass.** `platform-ui`'s Windows
>    `node_modules` is broken — `vitest` unresolvable, and the direct binary path dies with
>    `MODULE_NOT_FOUND` on rollup's native module. That is *not* a red suite; it is **no suite**, and
>    a session in a hurry reports "couldn't run tests, code looks fine". The owner's server-only test
>    rule exists for exactly this: re-run in `node:22-bookworm-slim` and the suite is **26/26**.
>
> **What the tests actually pin** is the property the ticket was written around. `stale:true` is not
> an edge case here — WSK-23 established it is the *permanent* case, because WSK-21 exposes only
> three GETs (`contract`, `jobs`, `jobs/:id`) and the registry/releases/submissions reads have no
> live source at all. So the suite pins the distinction that the frontend-first-drift bug class
> turns on: **an unavailable read must not look like an empty one.** `asOf: null` renders distinctly
> from a confirmed-empty list, the degrade banner is above the table rather than an empty-state
> one-off, and the rare live case renders distinctly too — so `stale` never becomes wallpaper the
> viewer stops reading. A confident empty list is the failure this estate has already shipped once.
>
> **Still open and NOT hidden by this close:** the console's demand end remains fixture-driven,
> because no hub tool can read a contract snapshot by id, download artifact bytes, or resolve a
> `pipeline_stages.artifact_ref`. §08's site registry **cannot** go live until control-plane read
> commands exist. And `webdesk` still appears in **zero** CI/deploy workflows.
