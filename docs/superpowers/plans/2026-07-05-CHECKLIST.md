# Implementation Checklist — WA Bot First

Update this as each item completes. `☐` todo · `▣` in progress · `☑` done. Keep it in sync with the per-phase docs.

---

> **Trial skeleton shipped (commit 619dc47):** a lean, runnable bot (WAHA adapter + PAN/KTP scrubber + file store + Gemini echo/AI + webhook + `/ping`/`/help`/`/summarize`/Q&A), 13 tests passing. It covers Phase-0 items in **trial-lite** form (single package, plaintext file store, key-in-bot). The items below track the **full hardened** Phase 0; ✓(lite) marks what the trial skeleton already delivers in reduced form.

## Phase 0 — Foundations & Walking Skeleton  `▣`

- [x] 0.1 Repo scaffold — ✓(lite) single TS package + vitest (monorepo/CI still TODO)
- [x] 0.2 Postgres provisioned — ✓(trial decision 2026-07-05: self-hosted on personal VPS, NOT managed) `docker compose --profile db up -d` creates PG17 + `gaiada_app` (NOBYPASSRLS); verified end-to-end (init as app role, encrypted round-trip, 4 RLS tests). Redis deferred to Phase 2 (BullMQ). Company server migration = pg_dump + DATABASE_URL swap.
- [x] 0.3 RLS (authorized-tenant-set) — ✓ `messages` table: FORCE RLS, fail-closed when unset, WITH CHECK on insert, verified via non-superuser role against live PG (`pg.rls.test.ts`); `groups`/`schedule_state` tables land with Phase 1
- [x] 0.4 Key custody — ✓ (5a.10) OpenBao transit adapter; envelope v2 double-wraps DEKs (keys never leave Bao); **full crypto suite + shred drill verified against a LIVE transit engine**; `docs/runbooks/key-custody.md` (Shamir 3-of-5, off-box snapshot, break-glass). *(Prod = isolated VPS: provisioning is the remaining user step.)*
- [x] 0.5 Crypto-shred lib — ✓ two-axis `encryptField`/`decryptField` (HKDF of subject_KEK+entity_KEK), HMAC pseudonym, `eraseSubject`/`eraseEntity` (commit b5c8022)
- [x] 0.6 Ingestion scrubber — ✓(lite) Luhn PAN + labelled KTP + basic passport; redact-before-persist (tighten later)
- [x] 0.7 Lean Gateway service — ✓(lite) standalone AI Gateway holds the only model key, bearer-auth fail-closed (commit 3d992af); Claude chain + DLP stub TODO
- [x] 0.8 WAHA adapter + webhook receiver + `WhatsAppGateway` interface — ✓ code done + `docker-compose.yml` (needs a real number + QR scan to go live)
- [x] 0.9 **Walking skeleton** — ✓ inbound → scrub → encrypt (sender PII) → store → reply; verified end-to-end
- [x] 0.10 **Day-one gate drill** — ✓ automated: encrypt → backup → destroy key → restore → unrecoverable; incl. re-onboarding + entity axis (`shred-restore.drill.test.ts`); runbook `docs/runbooks/erasure-divestiture.md`. Re-run against managed PG once 0.2/0.4 land.

## Phase 1 — WA Bot Core  `▣`

- [x] 1.1 Group registry — ✓ `config/groups.yaml` (hot-reload); listed-only ingest; unlisted groups logged once (observable drop); trial fallback = all groups when file absent
- [x] 1.2 Message normalizer → persist (encrypted sender, scrubbed text) incl. bot outbound (`from_bot`) — ✓
- [x] 1.3 Time-window model — ✓ gap-safe, persisted last-run, 12h first-run cap (`window.ts`)
- [x] 1.4 Scheduler — ✓ node-cron 12:00 & 18:00 Asia/Singapore *(idempotency = persisted window end; per-slot/day lock TODO if double-fire ever observed)*
- [x] 1.5 Summarizer — ✓(lite) sectioned project-status digest prompt via Gateway; empty → quiet *(map-reduce for oversized windows TODO)*
- [x] 1.6 Delivery — ✓ opt-in per group posts back; categorized management digest w/ group names; per-group failure → placeholder, never blocks others
- [x] 1.7 Trigger detector — ✓ @mention / `/cmd` / reply-to-bot (quoted-msg) / DM
- [x] 1.8 Interaction router — ✓(lite) `/ping` `/help` `/summarize` + Q&A over own-group history; unknown cmd → help
- [x] 1.9 Identity — ✓(lite) low-assurance principal from `(provider, external_id)`; ceiling enforced in Q&A path; no role assertable *(platform-minted principals + `identity_links` land with the platform)*
- [x] 1.10 Integration test — ✓ `phase1.e2e.test.ts`: ingest (scrub + registry filter) → digest run (opt-in + categorized mgmt) → all four trigger kinds → gap-safe second run

## Phase 2 — Media Enrichment  `▣`

- [x] 2.1 Media intake — ✓ `media_ref` + `media_status=pending` on receipt; **store-backed queue** (no Redis/BullMQ yet — pending rows polled) *(⚠ live media download needs WAHA Plus; core serves no file → observable `failed` row)*
- [x] 2.2 Media worker — ✓(lite) reentrancy-guarded poll loop in the bot process (`startMediaWorker`); size cap; per-row failure isolation; bytes never persisted *(separate entrypoint needs Postgres store — FileStore is single-process)*
- [x] 2.3 Transcriber — ✓(lite) audio → Gemini multimodal via Gateway `/media` *(faster-whisper self-host is target-state)*
- [x] 2.4 VisionDescriber — ✓(lite) images (incl. visible-text OCR) via Gateway; video → placeholder instruction, keyframes TODO
- [x] 2.5 DocExtractor — ✓(lite) pdf via Gemini; docx/xlsx local extraction TODO
- [x] 2.6 Scrubber on ALL media-derived text before persist — ✓ **worker scrubs before write + Gateway DLP-scrubs the extraction (defense-in-depth); covered by dedicated tests**
- [x] 2.7 Summaries consume `media_text` — ✓ done → inline; pending → placeholder (never blocks); failed → visible reason
- [x] 2.8 Integration test — ✓ `phase2.e2e.test.ts`: voice note → pending → worker (PAN in transcript scrubbed) → digest contains the scrubbed transcript

## Phase 3 — Gaiada Assistant + Telegram  `▣`

- [x] 3.1 Skill framework — ✓ registry + router (`skills.ts`); built-ins migrated; unknown → help
- [x] 3.2 General AI chat skill — ✓ default Q&A via Gateway; `minAssurance: "verified"` skills step-up low-assurance callers (data never returned)
- [x] 3.3 Document Q&A RAG — ✓(lite) `rag.ts`: **tenant+ACL pre-filter BEFORE ranking (D9, tested)**, source-driven erasure *(in-memory + keyword scoring; pgvector + Gateway embeddings + a `/doc` skill land when real docs flow — needs WAHA Plus media)*
- [x] 3.4 Action-items skill — ✓ `/actions` over chat incl. transcribed media *(dedicated audio→action-items flow rides the media pipeline)*
- [x] 3.5 Quick capture — ✓ `/capture` + `/captures`, owner-only by construction (per-owner synthetic chat id), scrubbed *(Drive connector TODO)*
- [x] 3.6 Telegram adapter — ✓ same pipeline via `normalizeTelegram` + `TelegramGateway`; fail-closed secret-token webhook *(text-only; TG media TODO)*
- [x] 3.7 WA continuity — ✓ runbook `docs/runbooks/wa-ban-recovery.md`; monitored-set source of truth = `groups.yaml` *(the standby number itself is a user action)*
- [x] 3.8 Discovery instrumentation — ✓ JSONL interaction events, PII-free by shape (tested)

---

## Phase 4 — Platform Core (Solo-Viable v1)  `☑`  *(plan: `2026-07-05-phase-4-platform-core.md`)*

- [x] 4.1 Scaffold `platform/` + migration runner — ✓
- [x] 4.2 Core schema + FORCE RLS (authorized-tenant-set) — ✓ 16 tenant tables + globals, verified via NOBYPASSRLS role; principal_lookup policy for pre-tenant membership discovery
- [x] 4.3 Module framework — ✓ `ModuleContract` verbatim + per-tenant enable gate (404 when disabled)
- [x] 4.4 RBAC engine — ✓ Cerbos-shaped `check()`, scope cascade, multi-role union w/ single deny, decisions audited, D11 session-version revocation
- [x] 4.5 Principal resolution (D4) — ✓ `/principal/resolve` + OBO envelope on the API; verified link → `linked`, else minimal
- [x] 4.6 Core REST API — ✓ companies/projects/tasks, activity audit on mutations, D17 custom-field validation on write
- [x] 4.7 Rollups (D12) — ✓ FK-governed registry, num/den ratios, idempotent recompute, `GET /api/rollups` = the only cross-company read (group_executive)
- [x] 4.8 Agency module — ✓ campaigns/briefs/approvals, `agency_approver` elevated role, module rollups
- [x] 4.9 MCP hub wiring — ✓ `projects.list`/`tasks.list`/`agency.pendingApprovals` front the platform API w/ OBO envelope
- [x] 4.10 Phase e2e — ✓ agency flow end-to-end (gating → approval → rollups → mgmt view); 34 platform tests on live PG
- **Phase 5+ (FULL-FIDELITY MANDATE):** see `2026-07-05-phase-5-full-fidelity.md` — every lite deviation closes to spec; no new shortcuts. WAHA fully free since 2026.6.1 (media + multi-session usable now).

---

## Phase 5 — ERP UI (Plan 1)  `☑`  *(plan: `2026-07-05-erp-ui-plan-1-foundation.md`)*

- [x] 5.1 Scaffold `platform-ui/` (Next.js 15) + plain-CSS luxury design system — ✓
- [x] 5.2 BFF session layer (HMAC dev-login, pending IdP swap) — ✓
- [x] 5.3 App shell + RBAC-gated nav — ✓
- [x] 5.4 My Work dashboard — ✓
- [x] 5.5 Cross-company Approvals inbox — ✓
- [x] 5.6 Platform API client (BFF → `platform/`, no direct DB access) — ✓
- [x] 5.7 Tests (component + integration) — ✓
- [x] 5.8 Docs (spec + plan) — ✓
- [x] 5.9 Dockerfile (Next.js standalone) + VPS compose entry + docs sync — ✓
- **Next:** Plan 2 (business modules — Companies/Projects/Tasks/Agency, Rollups), Plan 3
  (admin APIs + Systems pages), Plan 4 (Admin section + step-up, D4/D11 UI), Plan 5 (polish —
  layout presets, density, a11y, Playwright e2e).

### Plan 2 — Business modules (UI)  `▣`  *(UI-only; plan: `2026-07-05-erp-ui-plan-2-business-modules.md`)*

- [x] Companies (list + detail) — ✓
- [x] Projects (full CRUD w/ D17 custom-field forms) — ✓
- [x] Tasks (list/detail/create) — ✓ edit degrades gracefully pending backend PATCH
- [x] Agency (campaigns list/detail/create) — ✓ briefs degrade gracefully pending backend
- [x] Rollups (exec cross-company view + recompute) — ✓
- [x] Backend: task-update (`PATCH`) endpoint — ✓ `platform-nest` CoreController PATCH `/api/:t/tasks/:id` (+ project PATCH)
- [x] Backend: custom-field-defs endpoint — ✓ GET `/api/:t/custom-fields?entityType=`
- [ ] Backend: company-detail endpoint — still absent; UI falls back to list-derivation (non-blocking)
- [x] Backend: agency-briefs endpoint — ✓ GET/POST `/api/:t/modules/agency/campaigns/:cid/briefs`

### Plan 3 — Systems & Intelligence consoles (UI)  `▣`  *(UI-only; plan: `2026-07-05-erp-ui-plan-3-systems-intelligence.md`)*

- [x] WhatsApp/Telegram Bot console (Systems) — ✓ consumes `lib/admin.ts` contract, degrades
  gracefully (ConnectionState/EmptyNote) pending backend
- [x] Automation console (Systems) — ✓
- [x] AI Gateway console (Systems) — ✓
- [x] MCP Hub console (Systems) — ✓
- [x] AI Agents console (Intelligence) — ✓
- [x] Knowledge console (Intelligence) — ✓
- [ ] Backend: `/api/admin/bot/{status,config}` — dependency on concurrent backend session
- [ ] Backend: `/api/admin/gateway/{status,config}` — dependency on concurrent backend session
- [ ] Backend: `/api/admin/hub/{status,config}` — dependency on concurrent backend session
- [ ] Backend: `/api/admin/automation/{status,config}` — dependency on concurrent backend session
- [ ] Backend: agents goals admin endpoint — dependency on concurrent backend session
- [ ] Backend: knowledge sources/review admin endpoints — dependency on concurrent backend session

---

## Compliance / launch gate (must be green before real-message ingestion — Phase 1)

- [ ] G.1 Lawful basis documented (NOT employee consent) + DPIA/LIA
- [ ] G.2 Monitoring notice + per-individual opt-out; third-party exclusion via `identity_links`
- [ ] G.3 Retention TTL + auto-purge configured
- [ ] G.4 Day-one gate (Phase 0.4–0.6, 0.10) passed
- [ ] G.5 Named WA ToS risk acceptance recorded (risk register)
- [ ] G.6 Legal counsel engaged on jurisdiction/PCI (blocking for launch, not design)

---

**Current status (2026-07-05, later):** Phase 4 platform core also complete — plus standalone
ai-gateway, mcp-hub w/ platform tools, infra v1 (VPS compose incl. platform), automation v1.
WS8 steps 1-3 (specialists + orchestrator + D9 knowledge/memory platform), local-first
Ollama chain + /embed, bot /projects via hub (D4 end-to-end). Suite totals: bot 88 +
gateway 13 + hub 12 + platform 34 + ai-agents 23 = **170 tests**.

**Update (2026-07-09) — this checklist predates the post-07-05 backend work; see `CLAUDE.md`
"Current status" + the full-fidelity gap register for the live picture:**
- **NestJS port DONE (07-05):** `platform-nest/` replaced and DELETED the Fastify `platform/`
  (92 tests). All Phase-4/5c items above now live in `platform-nest`. `2026-07-05-nestjs-port-subspec.md`.
- **Event backbone DONE (07-06):** transactional outbox → Redis Streams relay → consumer w/
  dead-letter (`platform-nest/src/events/`, migration 0010). `2026-07-06-ws1-event-backbone-plan.md`.
- **Go gateway is THE gateway; cutover done (07-14):** `ai-gateway-go/` — contract-parity + mTLS,
  topology, DLP classifier, streaming; runs as the `ai-gateway` service on :3002. The Node gateway
  was retired and its directory deleted.
  `2026-07-06-ws3-go-gateway-rewrite-plan.md` + `2026-07-09-ws3-go-gateway-completion-report.md`.
- **Plan-2 UI backend deps landed** (task/project PATCH, custom-field-defs, agency briefs).
- **Still open (next up):** the **admin/systems API layer** (`/api/admin/:system/{status,config}`
  + plan-4 identity endpoints) — blocks the built-but-placeholder UI Systems/Intelligence/Admin
  pages (Plan-3 backend items below are all still ☐). Sync engine (Go) NOT STARTED. Other verticals.

**Earlier status:** Phases 0–3 code-complete in trial-lite form (84 tests passing:
RLS on live Postgres, day-one shred drill, phase-1/2 e2e, D9 RAG isolation). The WA-bot pilot
codebase is feature-complete for the trial. Blocked on user/infra: 0.4 OpenBao VPS, Gemini key,
WAHA QR scan (+ Plus for media files), warm-standby number, Telegram bot token (optional), and
the compliance G-items (no real ingestion until green). Hardening backlog: 1.5 map-reduce,
2.5 docx/xlsx + video keyframes, 3.3 pgvector embeddings + `/doc` skill, TG media.
