# Action Agent — Phase E: LLM Intent Router — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** Let a user trigger an action in natural language ("mark task t-9 done", "assign the logo to Budi") — mapped to ONE catalog action, always confirmation-gated, never auto-executed.

**Architecture:** `src/actions/intent.ts` sends the action catalog + the message to the ai-gateway LLM and demands strict JSON (`{action,args,confidence}` | `clarify` | `none`). Output is constrained to the registered allow-list and schema-validated by the action itself; anything else degrades to `none`/`clarify`. `dispatchIntent` (in `dispatch.ts`) funnels a proposed action through the SAME `proposeAction` gauntlet as a command; `bot.ts` calls it for triggered non-command messages before the Q&A fallback.

**Tech Stack:** TS ESM, ai-gateway `complete()`, vitest. No new deps.

## Global Constraints
- The router NEVER executes; it only proposes. Confirmation + authorization are unchanged.
- Prompt-injection containment: allow-list + confidence threshold + schema validation + mandatory confirm + execute-time authz. A message cannot cause an unauthorized/unconfirmed mutation.
- Defensive parsing: non-JSON, unknown action, or low confidence → `none`/`clarify` (fail safe to Q&A).

## Tasks (all complete)
- **Task 1:** config `INTENT_ROUTING` (default on) + `INTENT_CONFIDENCE` (default 0.7).
- **Task 2:** `intent.ts` — `buildCatalog`, `routeIntent(text, complete?)`, balanced-brace JSON extractor. 8 tests (high-conf proposes, low-conf clarifies, explicit clarify, none, hallucinated→none, non-JSON→none, prose-embedded JSON, disabled).
- **Task 3:** `dispatch.ts` — extract shared `proposeAndSend`; add `dispatchIntent` (action→propose, clarify→ask, none→false).
- **Task 4:** `bot.ts` — call `dispatchIntent` for triggered non-command messages before Q&A.

## Verification
Bot 182/182, typecheck clean. Live model behavior (real proposals from the running ai-gateway) exercised in Phase G.

See spec `2026-07-05-wa-bot-action-agent-design.md` §7.5.
