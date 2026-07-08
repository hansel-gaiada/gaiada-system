# Action Agent — Phase D: Business Writes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** Ship the first real actions end-to-end: a chat user can create/assign/complete tasks and create projects — verified-only, confirmed, audited — with the write flowing bot → hub → platform (Cerbos + RLS + activity audit).

**Architecture:** The platform ALREADY exposes the needed Cerbos-gated write endpoints (`POST /projects`, `POST /projects/:id/tasks`, `PATCH /tasks/:id`). Phase D adds: (1) a non-mutating `POST /:tenantId/authz/check` probe on the platform (reuses the same `check()`); (2) hub write-tools (`projects.create`, `tasks.create`, `tasks.update`) + an `authz.check` tool, all forwarding the OBO envelope; (3) bot business actions + the dispatch wiring (command → executor; button/affirmative-reply → confirm), and an event router (`handleEvent`) so the webhooks feed the full inbound-event union.

**Tech Stack:** TS ESM across platform/ (Fastify), mcp-hub/ (express + MCP SDK), wa-chat-bot/ (Fastify). No new deps.

## Global Constraints
- Additive only in platform/ and mcp-hub/ (concurrent sessions own other files); commit only Phase-D files.
- Bot holds no keys, asserts no identity — writes carry the (surface, senderId) OBO envelope; the platform is the enforcement point.
- Verified-only: `authz.check` returns `stepup` for unresolved identities; the executor blocks non-allow.

## Tasks (all complete)
- **Task 1 (platform):** `core/authz-check.ts` + 2 wiring lines in `server.ts` — non-mutating Cerbos probe → `{decision: allow|deny|stepup}`.
- **Task 2 (hub):** `platform-write-tools.ts` (`platformSend` POST/PATCH; `authz.check`, `projects.create`, `tasks.create`, `tasks.update`) + registration in `server.ts`. 5 tests (OBO forwarded, PATCH shape, 403→throw, authz probe).
- **Task 3 (bot):** `actions/builtins.ts` — `project.create`, `task.create`, `task.assign`, `task.complete` (execute → hub tool).
- **Task 4 (bot):** `actions/dispatch.ts` — command→propose (buttons), button→confirm, affirmative-reply→confirm; `handleEvent` router; wired into `bot.ts` + `server.ts` webhooks. 6 integration tests (propose-not-execute, button-executes-once, reply-confirms, unverified→stepup).

## Verification
- Bot: 174/174, typecheck clean. Hub: 17/17, typecheck clean. Platform: typecheck clean.
- **Deferred to Phase G (needs live stack):** platform `authz/check` + full bot→hub→platform→Cerbos→PG round-trip must be exercised against running Cerbos + Postgres + platform (the platform test suite already requires Cerbos live).

See spec `2026-07-05-wa-bot-action-agent-design.md` §7.8, §8.
