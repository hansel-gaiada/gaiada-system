# Workstream 5 — Surfaces

**Date:** 2026-07-05
**Status:** Design stub (brainstorming stage)
**Parent:** `2026-07-04-gaiada-ai-platform-roadmap.md` (Workstream 5)
**Depends on:** WS2 MCP, WS3 Gateway, WS1 RBAC (assurance-tiered identity, D4).
**Principle:** API-first — one backend serves every surface identically; surfaces are thin presentation + a `(provider, external_id)` identity envelope. **No surface ever asserts a principal or holds provider keys** (D4, D8).

---

## 1. Surface inventory

| Surface | Role | Tier |
|---|---|---|
| **WhatsApp** | Surface #1 — group summaries, Q&A, assistant skills | **v1** |
| **Telegram** | Ban-fallback + parity (official API, no ban risk) | **v1** (D6 fallback) |
| **Gaiada Assistant (chat)** | Personal AI: chat, doc Q&A, transcription, capture, image-enhance | **v1** |
| **Thin web UI** | Assistant + admin/config; identity step-up landing (D4) | **v1** |
| **User-facing web app / ERP UI** | The human "one interface" to track all work | Target |
| **Native mobile (iOS/Android)** | RN/Flutter over the same API | Target |
| **Voice** | Voice command & reply | Target |

## 2. Cross-surface rules
- **Identity (D4):** every surface presents `(provider, external_id)`; the platform mints the principal. Low-assurance surfaces (WA/Telegram) get general + own-group Q&A; sensitive/bulk/cross-company actions require an **IdP step-up** (the thin web UI hosts the step-up landing).
- **Localization (U10):** Indonesian + local-language first-class in UI copy and in the AI eval suites — not English-only.
- **Accessibility:** the web/ERP UI meets standard a11y from the start.
- **Realtime:** WebSocket updates for the web/ERP surfaces (target); v1 surfaces are request/response + push messages.

## 3. v1 vs Target-State
- **v1:** WhatsApp + Telegram-fallback + Gaiada Assistant + a thin web UI (chat + config + step-up). That's it.
- **Target-State:** the full ERP web app, native mobile, voice — built on the same API-first backend once the platform core lands.

## 4. Open items
- Web stack for the ERP UI (Next.js) + component system.
- Mobile: React Native vs Flutter vs PWA-first.
- Voice pipeline (STT/TTS) — reuse the media pipeline + Gateway.
- Telegram group-parity onboarding friction (D6).
