# Phase 3 — Gaiada Assistant + Telegram — Implementation Plan

> **For agentic workers:** task-structured; expand to bite-sized TDD before executing. Update `2026-07-05-CHECKLIST.md`.

**Goal:** Turn the interaction rails into the **Gaiada Assistant** (personal AI skills across chat + a thin web UI), add the **Telegram fallback** surface, and harden WhatsApp continuity — completing the daily-use pilot.

**Consumes from Phase 0–2:** interaction router, `gatewayChat`, media pipeline, `db`, identity/principal, `scrub`, `encryptField`.

---

### Task 3.1 — Skill framework
- **Files:** `packages/app/src/assistant/skills.ts`, test.
- **Produces:** `registerSkill(name, handler)`, `routeToSkill(intent, ctx)`; skills plug into the Phase-1 interaction router. **Test:** a registered skill is invoked for its intent; unknown → help.

### Task 3.2 — General AI chat skill
- **Files:** `packages/app/src/assistant/skills/chat.ts`, test.
- **Produces:** general Q&A/drafting/translation via `gatewayChat`, honoring the requester's assurance tier (low = general only). **Test:** prompt → reply; sensitive request from low-assurance → step-up prompt, not an answer.

### Task 3.3 — Document Q&A (isolated RAG)
- **Files:** `packages/app/src/assistant/skills/docqa.ts`, `packages/app/src/rag/index.ts`, extend schema (`doc_chunks` w/ `tenant_id`, `acl`, `source_ref`, `embedding vector`), test.
- **Produces:** ingest a doc (via media pipeline) → chunk → embed (Gateway) → store with tenant+ACL; query = **Cerbos/scope pre-filter on candidates BEFORE similarity ranking** (D9); source-driven invalidation (re-embed on update, hard-delete on erasure).
- **Test:** a chunk from group/tenant B is **never** returned to a group/tenant A querent even on high similarity; deleting the source removes its chunks. **Critical (D9).**

### Task 3.4 — Transcription + action items skill
- **Files:** `packages/app/src/assistant/skills/transcribe.ts`, test.
- **Produces:** audio → transcript (media pipeline) → summary + extracted action items via Gateway. **Test:** fixture audio → transcript + ≥1 action item (fakes in CI).

### Task 3.5 — Quick capture skill
- **Files:** `packages/app/src/assistant/skills/capture.ts`, extend schema (`captures` — migration-friendly UUIDs, `tenant_id`), test.
- **Produces:** `/capture <note>` → stored capture (PII-encrypted); optional Drive save via the governed connector. Precursor to the ERP task model. **Test:** capture persisted + retrievable by the owner only.

### Task 3.6 — Telegram adapter (fallback surface)
- **Files:** `packages/tg/src/gateway.ts` (implements the same surface contract), test.
- **Produces:** a Telegram adapter satisfying the same `Surface` contract as WA (receive → `handleInbound`, send). Official Bot API (no ban risk). **Test:** a Telegram update normalizes to `InboundMessage` and routes identically.

### Task 3.7 — WA continuity (warm standby + runbook)
- **Files:** `docs/runbooks/wa-ban-recovery.md`, `packages/app/src/wa/standby.ts`, test.
- **Produces:** a pre-warmed standby number joined (passive) to every monitored group; a scripted re-add from the `groups` table + auto re-post of the compliance notice + `last_run_at` backfill. **Test:** the recovery script reconstructs the monitored set from `groups`.

### Task 3.8 — Discovery instrumentation
- **Files:** `packages/app/src/telemetry/discovery.ts`, test.
- **Produces:** privacy-respecting logging of intents/question-types/captures (no PII) → feeds WS0 discovery + ERP requirements. **Test:** an interaction emits a discovery event without raw PII.

---

## Self-review
- Covers `pilot-tools-wave1` D2 (Gaiada Assistant skills) + D6 (Telegram fallback + warm standby) + D9 (isolated RAG, 3.3) + discovery instrumentation. Company-DB skills remain post-MCP (future P5). All skills route AI via the Gateway; no keys, no identity assertion.
