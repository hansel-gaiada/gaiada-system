# Pilot Tools — Wave 1

**Date:** 2026-07-04
**Status:** Design draft (brainstorming stage — not being built yet)
**Parent:** `2026-07-04-gaiada-ai-platform-roadmap.md` (Delivery Strategy §5 — "small tools first")
**Goal:** Ship small, self-contained, **broad daily-use** tools to management + employees NOW — deliver value, drive adoption, and generate **discovery signal** for the ERP — while the platform (WS1) is built in parallel.

---

## 1. Principles

- **Self-contained:** depend only on the **Gateway** (AI access) + **media pipeline** — NOT the not-yet-built ERP/MCP.
- **Broad daily use:** tools everyone touches, for maximum adoption + discovery.
- **Discovery is a first-class feature** (see §5).
- **Forward-compatible:** when platform + MCP land, the same assistant gains company-data skills (WA bot Phase 3) via MCP; pilot data migrates into the ERP.

---

## 2. Key synthesis — two deliverables, one runtime (not five apps)

Personal AI chat, Document Q&A, Transcription, and Quick Capture are all "**send content over a chat surface → AI acts → reply**" — i.e. **skills on the WA bot spec's interaction layer** (triggers → intent routing → handler → reply), sharing surface + Gateway + media pipeline + identity. So Wave 1 = **two deliverables sharing one bot runtime:**

### D1 — WhatsApp Assistant (anchor; already specced)
The WA bot Phases 1–2: group summaries (project-status digests, management + opt-in delivery) + group Q&A over chat history + general Q&A. **Ship first.**

### D2 — Gaiada Assistant (personal assistant; skills on the same runtime)
On **WhatsApp/Telegram + a thin web UI**, each pilot tool is a **skill**:
| Skill | What it does | Uses |
|---|---|---|
| **General AI chat** | Governed everyday AI (Q&A, drafting, translation, summarizing) | Gateway → Claude/Gemini |
| **Document Q&A** | Drop / pick a file (incl. from **Google Drive**) → OCR/extract → ask questions (RAG) | media pipeline + Gateway + Drive |
| **Transcription + Action Items** | Voice-note/meeting audio → transcript → summary → action items | media pipeline (Whisper) + Gateway |
| **Quick Capture** | `/capture` task/note/reminder → small pilot store; can save to **Drive** | pilot store + Drive |
| **Image/Video enhance** | Submit media → **Magnific AI** processing | Gateway → Magnific |

---

## 3. Confirmed existing tools (must be integrated)

| Tool | Role in Wave 1 |
|---|---|
| **Claude Team** | AI provider via Gateway (Anthropic **API** for programmatic use — see nuance below). |
| **Gemini Team** | AI provider via Gateway (Google Gemini **API**). Supersedes the bot spec's "Gemini free tier" placeholder — config change only. |
| **Magnific AI** | Image/video processing skill (`image.enhance`) via Gateway. |
| **Google Drive** | First-class file connector: Document Q&A reads/indexes Drive; assistant saves transcripts/summaries/captures to Drive; WhatsApp file shares archive to Drive. (Google Drive MCP usable.) |
| **WhatsApp** | Primary surface (Telegram parity later). |

> ⚠️ **Team-plan vs API nuance:** Claude Team / Gemini Team are **human-facing web/app subscriptions**; **programmatic** bot access needs the **Anthropic API / Gemini API**, billed separately. Humans keep using the Team apps directly; pilots call the APIs of the same model families through the Gateway. **Action:** confirm API access + budget exists (feeds Gateway provider registry).

---

## 4. Shared foundations (build once, reused by D1 + D2)

- **Gateway client** (AI access, provider chains: Claude/Gemini now, local later).
- **Media pipeline** (transcription, OCR, vision, doc extraction).
- **Chat-surface adapters** (WhatsApp via gateway interface; Telegram later).
- **Google Drive connector** (read/list/save).
- **Identity-lite** (WA/Telegram handle → pilot user; upgrades to `identity_links` + RBAC later).
- **Small pilot Postgres store** (captures, doc index, usage logs) — explicit **precursor** to the ERP, migratable.
- **Usage/audit logging.**

---

## 5. Discovery instrumentation (first-class)

Every tool logs (privacy-respecting) signal because the point is to learn what the ERP must do:
- Question types / intents asked of the assistant.
- Captured tasks/notes (structure + fields people actually use → informs ERP task model).
- Document topics/types queried (→ knowledge model).
- Which businesses/roles adopt which skills.
Feeds **Workstream 0 (Discovery)** and the ERP requirements. A pilot that captures no discovery signal wastes the opportunity.

---

## 6. Sequencing

1. **WhatsApp Assistant (D1)** — summaries + group Q&A.
2. **Gaiada Assistant (D2) skills, incrementally:** general AI chat → transcription + action items → document Q&A (+ Drive) → quick capture → image/video enhance (Magnific).

---

## 7. Success criteria

- Adoption: daily active users per skill/business.
- Value: qualitative feedback from management + employees.
- Discovery: volume + quality of signal captured for the ERP.
- Governance: all AI usage now flows through the audited Gateway (replacing ad-hoc usage).

---

## 8. Forward path (pilots → platform)

- Pilots use only the Gateway → no ERP/MCP dependency.
- When WS1 platform + WS2 MCP land: the assistant gains company-data skills (WA bot Phase 3) via MCP with OBO auth; pilot store data (captures, doc index) migrates into the ERP; identity-lite upgrades to full RBAC.

---

## 9. Open items
- Confirm Anthropic/Gemini API access + budget (Team-plan nuance).
- Thin web UI scope (auth, which skills).
- Google Drive auth model (per-user OAuth vs company service account) + scope of access.
- Pilot store schema (captures, doc chunks/embeddings, usage) — keep migration-friendly (UUIDs, tenant-taggable).
- Telegram timing.
