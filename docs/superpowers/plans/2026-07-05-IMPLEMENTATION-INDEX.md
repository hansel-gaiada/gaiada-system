# Gaiada AI Platform — Implementation Plan (Master Index)

> **For agentic workers:** each phase is its own plan document. Use `superpowers:subagent-driven-development` to execute a phase task-by-task. Steps use checkbox (`- [ ]`) syntax. Track progress in `2026-07-05-CHECKLIST.md`.

**Goal:** Get the **WhatsApp bot running first** as a real, compliant, hardened pilot — then expand toward the platform. Built as **Solo-Viable v1** (managed-first, cloud-AI-first, single-region) per roadmap §3c.

**Governing specs:** everything here implements the committed specs under `docs/superpowers/specs/` (see `2026-07-04-INDEX-overview.md`). The adversarial-review resolutions (D1–D17, U1–U11) are binding constraints, especially the **day-one gate** (`2026-07-05-day-one-crypto-shred-and-ingestion-scrubber.md`).

---

## Delivery path — WA bot first

| Phase | Document | Goal | Depends on | Status |
|---|---|---|---|---|
| **0** | `2026-07-05-phase-0-foundations-and-gate.md` | Repo, managed infra, key custody + crypto-shred, ingestion scrubber, lean Gateway, WAHA connection, **walking skeleton** (message → scrub → encrypt → store → reply) | — | ☐ Not started |
| **1** | `2026-07-05-phase-1-wa-bot-core.md` | Group discovery + config, persistence, scheduled project-status digests (12:00/18:00 GMT+8), delivery, interaction rails (Q&A over own-group history) | 0 | ☐ Not started |
| **2** | `2026-07-05-phase-2-media-enrichment.md` | Media pipeline: transcription + vision + doc extraction, scrubbed before persist, feeding summaries | 1 | ☐ Not started |
| **3** | `2026-07-05-phase-3-assistant-and-telegram.md` | Gaiada Assistant skills (chat, doc Q&A w/ isolated RAG, transcription, capture), Telegram fallback, WA warm-standby | 2 | ☐ Not started |

**After Phase 3, the WA bot + Gaiada Assistant pilot is fully live.** Everything below is the broader program, detailed just-in-time when reached.

## Future phases (program — not yet detailed)

| Phase | Goal | Depends on |
|---|---|---|
| P4 | Platform core (common core + agency module) on managed Postgres, RBAC (IdP + Cerbos), Observability | 3 |
| P5 | MCP hub over the platform → light up WA bot Phase 3 company-data skills (OBO) | P4 |
| P6+ | Additional verticals, event backbone, Temporal, AI brigade, target-state migration (all-local, sync engine, AI-SOC) | P5 |

---

## Conventions

- **Just-in-time detail:** Phase 0 is fully task-detailed. Phases 1–3 are task-structured (files, interfaces, tasks, tests, checkboxes); each is expanded to bite-sized TDD steps immediately **before** its execution, so detail doesn't drift.
- **TDD, DRY, YAGNI, frequent commits** throughout.
- **Tech stack (v1):** Node.js + TypeScript; managed Postgres (Neon/Supabase); Redis + BullMQ; WAHA (WhatsApp gateway); OpenBao on an isolated VPS (key custody); Claude + Gemini via a lean Gateway service (cloud-AI-first); faster-whisper (self-host or API) for transcription.
- **Hard gate before Phase 1 ingestion:** the day-one gate checklist (crypto-shred KEK live, ingestion scrubber active, encryption of PII, erasure/divestiture runbooks drafted + one verification drill passed) **must pass**. Phase 0 builds it; Phase 1 must not ingest real messages until it's green.

## Global constraints (apply to every task)

- **No provider keys outside the Gateway** (D8). The bot calls the Gateway; the Gateway holds keys.
- **The bot never asserts identity** (D4): it presents `(provider, external_id)`; the platform mints the principal. Low-assurance WA sessions get general + own-group Q&A only.
- **PII fields + media encrypted** under `KDF(subject_KEK, entity_KEK)`; non-personal data plaintext + RLS; HMAC pseudonym for lookups (day-one spec).
- **Ingestion scrubber (PAN/KTP, Luhn, redact-before-persist)** runs on message text AND all media-derived text (day-one spec).
- **RLS keys on an authorized-tenant-SET; no BYPASSRLS on app roles** (D5).
- **Every drop/merge/degrade is observable** (audit/log row) — no silent failure.

---

## Execution

Recommended: **subagent-driven** — a fresh subagent per task with review between tasks. Update `2026-07-05-CHECKLIST.md` after each task/phase.
