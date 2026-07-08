# Action Agent — Phase B: Rich I/O — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Grow the bot's single outbound verb (`sendText`) into a full `ChatGateway` (reply/quote, media, react, buttons, typing, group-admin) with a per-surface capability matrix and graceful degradation, and grow inbound from text-only into an `InboundEvent` union (message · button · reaction · member).

**Architecture:** A new `src/gateway/contract.ts` declares the `ChatGateway` interface, verb payload types, and the capability matrix (`supports(surface, verb)`). `WahaGateway` and `TelegramGateway` implement every verb; unsupported verbs return a structured `{ ok:false, unsupported:true }` result so callers degrade honestly. Inbound normalization gains button/reaction/member events. `WhatsAppGateway` stays as a type alias for back-compat.

**Tech Stack:** TypeScript ESM, fetch, vitest. No new deps.

## Global Constraints
- Same as Phase A (ESM, semicolons, colocated `*.test.ts`, no new deps).
- Every new verb returns `Promise<GatewayResult>` — never throws for a *known-unsupported* verb; network errors still reject and are handled by `sendWithRetry`-style callers in later phases.
- `sendText` keeps its existing `Promise<void>` signature (back-compat with all current callers).

## Tasks
- **Task 1:** `ChatGateway` contract + verb payload types + `GatewayResult` (`src/gateway/contract.ts`).
- **Task 2:** Capability matrix + `supports()` (pure, fully tested).
- **Task 3:** `InboundEvent` union + `normalizeEvent` for WAHA (message/reaction/group) and `normalizeTelegramEvent` (message/callback/reaction/member) — pure, tested.
- **Task 4:** Implement verbs on `WahaGateway` (reply/sendMedia/react/sendButtons/typing/group-admin) with degradation fallbacks.
- **Task 5:** Implement verbs on `TelegramGateway` (inline_keyboard, setMessageReaction, sendChatAction, sendPhoto/Document, ban/promote/pin).
- **Task 6:** Typecheck + full-suite regression gate + `.env` docs.

See spec `2026-07-05-wa-bot-action-agent-design.md` §7.1–7.2 for the verb/capability table and event shapes.
