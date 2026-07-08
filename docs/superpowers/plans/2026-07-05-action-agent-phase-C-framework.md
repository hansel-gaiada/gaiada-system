# Action Agent — Phase C: Action Framework + Confirmation FSM + Verified-only Authz — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** Build the action framework, the confirm-before-execute FSM, and the verified-only authorization gate — the single gauntlet every mutating action passes through, independent of any specific action (those arrive in Phase D/F).

**Architecture:** `src/actions/` holds: `types.ts` (Action/ActionContext/Authorizer), `registry.ts`, `confirm.ts` (single-use-token pending store), `executor.ts` (the gauntlet: kill-switch → rate-limit → validate → authorize → propose+confirm → re-authorize → execute → audit), and `authorize.ts` (the real fail-closed authorizer that delegates to the hub's `authz.check`). Authorization is delegated, never decided in the bot (D4). It is checked twice — at propose and at execute — so a revocation in between denies.

**Tech Stack:** TypeScript ESM, node:crypto, vitest. Reuses Phase A safety (kill-switch, rate-limit, audit). No new deps.

## Tasks (all complete)
- **Task 1:** `types.ts` — Action, ActionCategory, RiskTier, ActionContext (gateway + hub), ActionResult, AuthzDecision, Authorizer.
- **Task 2:** `registry.ts` — register/get/list/reset actions.
- **Task 3:** `confirm.ts` — pending store keyed by (chatId,senderId); single-use `consumeToken`; TTL expiry; cancel.
- **Task 4:** `executor.ts` — `proposeAction` (stage 1) + `confirmAction`/`confirmByReply` (stage 2); RATE tiers; kill-switch + rate-limit + double-authorize; audit on every branch. 16 tests incl. execute-once, revocation-denies, kill-switch, expiry, step-up.
- **Task 5:** `authorize.ts` — `makeHubAuthorizer` (allow/deny passthrough; HubDeniedError→stepup; any other error→deny fail-closed). 5 tests.

## Deferred to Phase D
Bot dispatch wiring (command/button/reply → executor) lands with the first real actions + the hub `authz.check` tool + platform write endpoints, so it can be verified end-to-end rather than against a stub.

See spec `2026-07-05-wa-bot-action-agent-design.md` §7.3–7.6.
