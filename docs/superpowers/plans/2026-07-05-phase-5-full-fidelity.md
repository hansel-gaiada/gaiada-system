# Phase 5+ — Full-Fidelity Completion (NO corner-cutting mandate)

**Decision (user, 2026-07-05, BINDING):** the solo-dev "lite" simplifications are no longer
acceptable end-states. Every recorded deviation below must be closed to the ORIGINAL specs.
Time is not a constraint; completeness is the goal. New work must not introduce new "lite"
shortcuts without an explicit user decision.

**WAHA note:** since 2026.6.1 all former Plus features are FREE in `devlikeapro/waha`
(media, unlimited sessions, storages, security) — media pipeline and warm-standby second
session are now fully exercisable at no cost.

## Gap register (spec → current → close by)

### P5a — Bot production-grade (spec: whatsapp-automation-bot-design, day-one)
- [ ] Redis + BullMQ media queue; media worker as its OWN process (needs PG store)
- [ ] faster-whisper self-hosted transcriber in the chain (local-first before Gemini)
- [ ] ffmpeg video keyframes + audio-track split; docx/xlsx local extraction (mammoth/xlsx) + OCR fallback
- [ ] Fuller scrubber ruleset (day-one spec: more ID types, tighter KTP, model-assisted classifier via Gateway)
- [ ] Map-reduce summarizer for oversized windows (1.5)
- [ ] Telegram media (getFile) through the same media pipeline
- [ ] Scheduler per-slot/day idempotency lock; groups/schedule_state as PG tables w/ RLS
- [ ] Remove interim `rag.ts` shim → all retrieval through the WS8 knowledge service (D9)
- [ ] Drive connector for /capture through the governed boundary (D8.4)
- [ ] OpenBao replaces LocalKms (transit engine, isolated VPS, unseal + break-glass runbook) — 0.4

### P5b — Identity & authorization to spec (ws1-rbac-engine)
- [ ] Self-hosted IdP (Zitadel or Keycloak — decide) + OIDC on the platform; auto-provision on first login
- [ ] Step-up MFA flow; dual-proof `identity_links` enrollment (D4.4); assurance `high` becomes real
- [ ] Cerbos deployed: versioned policy repo + CI policy tests; in-code policy module retired; derived roles for the scope cascade; `PlanResources` for set-returning tools + RAG pre-filter (D16)
- [ ] Minute-scale token TTL + session-version deny-list on every MCP call (D11 full)
- [ ] Team-scope coverage in policies (currently unimplemented scope tier)

### P5c — Platform to spec (ws1-architecture, ws1-core-schema)
- [x] NestJS port of the core — **DONE (2026-07-05)**. `platform-nest/` replaces the Fastify
  core (Fastify-adapter, tsc→dist, Dockerfile); 92 tests pass on NestJS; `platform/` deleted;
  compose + test-all repointed. Each vertical is a NestJS module + `ModuleEnabledGuard`. See
  `2026-07-05-nestjs-port-subspec.md`. Only backend now — no more Fastify/Nest dual stack.
- [x] Full core API surface: clients, deliverables, time_entries, comments, notifications,
  files (storage backend), teams CRUD — **ALL DONE** (5c.2–5c.8), Cerbos-gated + tested.
- [~] Custom-fields registry endpoint + validation-on-write DONE (5c.6); re-validation on the
  sync-apply path waits on the sync engine; expand/contract migration discipline still to document.
- [ ] Web UI (Next.js, WS5) — auth via IdP, module UI manifests rendered, management rollup dashboard
- [ ] Event backbone (Redpanda/NATS) — modules emit/consume; outbox table feeds it
- [ ] Sync engine (Go, own sub-spec FIRST — highest risk): outbox → scheduled sync, idempotent apply, LWW + human-review conflicts, hub-first migrations
- [ ] Go edge services: realtime hub (WebSockets), media workers
- [ ] Next vertical modules (resort, marine, printing) via ModuleContract

### P5d — Gateway to spec (ws3)
> **Go rewrite is THE gateway; cutover done 2026-07-14** (`ai-gateway-go/`, go1.26.4
> build/vet/test green). It now runs as the `ai-gateway` compose service on :3002; the Node
> `ai-gateway/` was retired and its directory deleted. Closes several items below. Plan + report:
> `2026-07-06-ws3-go-gateway-rewrite-plan.md` (STATUS header),
> `2026-07-09-ws3-go-gateway-completion-report.md`.
- [x] Deterministic egress floor (default-deny outbound, FQDN allowlist) **DONE** — Node
  `egress.ts` wraps global fetch; the Go rewrite enforces it at `http.Transport.DialContext`
  (stronger, catches every outbound dial). **per-site/central split DONE** (topology mode +
  central-forward provider); **mTLS + peer allowlist DONE** (self-signed internal CA, CN
  allowlist). Remaining: DNS control, SIEM rule.
- [ ] Vault/OpenBao-issued short-TTL provider creds; per-key provider-side spend caps
- [~] Per-tenant budgets **DONE** (`budget.ts` / Go `budget.go` per-tenant cap + scope on breach, x-tenant-id).
  Remaining: alert escalation (management group message), provider-account load balancing, HA pair.
- [~] Model-assisted DLP classifier (fail-closed) **DONE (text, opt-in)** — Go `dlp/classifier.go`,
  local Ollama, synchronous, fail-closed, `DLP_CLASSIFIER_ENABLED`-gated. Remaining: media DLP classification.
- [~] Token streaming pass-through **DONE (wire contract)** — Go `POST /complete/stream` (SSE),
  single-event fallback + optional `StreamingProvider` interface. Remaining: native per-provider token streaming.

### P5e — Agents to spec (ws8, D13/D14)
- [~] pgvector **DONE** (dual-mode: `vector(dim)` + HNSW + SQL ranking where the extension
  exists, float8[]+app-cosine fallback otherwise; D9.1 pre-filter preserved). Remaining:
  dedicated vector DB decision; ingestion pipelines subscribed to the source outbox (auto
  re-embed/tombstone) — waits on the event backbone.
- [ ] Knowledge graph / semantic layer; episodic memory
- [ ] Eval harness: per-agent suites, held-out + rotating sets, adversarial/prompt-injection regression (D13); write-capable failover requires eval + tool-contract pass
- [ ] Temporal for durable orchestration; budget exhaustion suspends workflow for human resume (D14 full)
- [ ] Local frontier models + model registry (weight provenance: safetensors, pinned SHA) + LoRA fine-tuning (WS10 GPU plan)
- [ ] Trainer agent (eval-gated, human-approved improvements)

### P5f — Infra/observability/security to spec (ws9, ws10, ws7)
- [ ] OpenTelemetry traces/metrics/logs across all services; SLOs; run tracing for agents
- [ ] Uptime alerting → Telegram; off-box backup automation
- [ ] Zero-trust floor: mTLS everywhere, SPIFFE/SPIRE identities; k3s/K8s + GitOps + Sigstore/SBOM/SLSA (staged as estate grows)
- [ ] Temporal + N8N hardening (credential scoping, event triggers)

**Sequencing:** P5a → P5b → P5c (NestJS+UI) → P5d/P5e in parallel → P5c (sync) → P5f
staged throughout. Each sub-phase gets its own task-detailed plan doc before execution
(same discipline as Phases 0–4).
