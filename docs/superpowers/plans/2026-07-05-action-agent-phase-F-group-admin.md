# Action Agent — Phase F: Group Administration — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** The highest-risk action category — remove/promote members, rename the group, pin a message — gated hardest (verified company_admin only) and honest about per-surface capability limits.

**Architecture:** `src/actions/group-admin.ts` registers `group.remove/promote/rename/pin` as `category:"group-admin"`, `riskTier:"high"`, mapped to a new `chat_group` Cerbos resource. execute() calls the Phase-B `ChatGateway` verbs directly (chat state, not platform data) after checking `supports(surface, verb)` and mapping the `GatewayResult` (unsupported/error/ok) to a clear message. A new Cerbos policy `resource_chat_group.yaml` allows these actions only for `company_admin`/`platform_admin` with `inTenant && notLow` — so a low-assurance chat identity is denied by policy, and an unlinked one gets step-up.

**Tech Stack:** TS ESM, ChatGateway (Phase B), Cerbos policy YAML, vitest. No new deps.

## Global Constraints
- Group-admin actions never touch the DB — they act on the chat surface via the gateway.
- Still fully gated by the executor gauntlet (verified-only, confirmed, rate-limited, audited).
- Capability honesty: unsupported verb per surface → clear message, never a silent failure.

## Tasks (all complete)
- **Task 1 (fix):** `authorize.ts` now passes `tenantId` (config.defaultTenantId) to `authz.check` — the platform route is `/:tenantId/authz/check` (also fixes business-action authz against a live platform).
- **Task 2:** `group-admin.ts` — 4 actions + `runVerb` capability/degradation helper. 6 tests (verb called, WhatsApp-pin degrades, Telegram pin works, error surfaced, validation).
- **Task 3:** `resource_chat_group.yaml` Cerbos policy (company_admin/platform_admin only).
- **Task 4:** register in `bot.ts` (both business + group-admin); catalog now exposes group verbs to the intent router too.

## Verification
Bot 188/188, typecheck clean. Live WhatsApp/Telegram group-admin calls + the `chat_group` policy decision exercised in Phase G (needs live WAHA/Telegram + Cerbos).

See spec `2026-07-05-wa-bot-action-agent-design.md` §7.1, §7.4.
