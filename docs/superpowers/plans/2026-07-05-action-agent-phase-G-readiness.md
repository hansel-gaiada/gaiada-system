# Action Agent — Phase G: Hardening & Live-Integration Readiness

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** Close the action-agent to "industry usage capable": runtime incident controls, replay
resilience proof, incident runbook, honest docs — and an explicit checklist of what still needs
the LIVE stack (Cerbos + platform + Postgres + WAHA/Telegram + ai-gateway) to verify, since those
can't run in the build sandbox.

## Done in this phase (code + tests + docs)
- **Runtime kill-switch + audit admin routes** (`server.ts`): `POST /admin/actions/:on|off`,
  `GET /admin/actions/audit` — ADMIN_TOKEN-gated. 4 tests (`admin-actions.test.ts`).
- **Replay/chaos test** (`actions/chaos.test.ts`): redelivered message proposes once; redelivered
  button confirmation executes once (single-use token). 2 tests.
- **Incident runbook** (`wa-chat-bot/docs/runbooks/action-incident.md`): kill-switch, audit
  reading, identity revocation (D11), rate limits, undo guidance.
- **README truth update**: the bot is documented as an action agent, not "just a trial skeleton".
- **`.env.example`**: all action env vars documented (ACTIONS_ENABLED, ACTION_AUDIT_FILE,
  INTENT_ROUTING, INTENT_CONFIDENCE, DEFAULT_TENANT_ID already present).

## MUST verify against the live stack before enabling real writes

These are integration checks the unit suite cannot cover (they need running services). Run them on
the VPS/staging with the full compose up (postgres + cerbos + platform + hub + gateway + waha).

1. **Cerbos loads the new policy.** Start Cerbos with `platform/cerbos/policies/` mounted; confirm
   `resource_chat_group.yaml` loads with no schema error (`cerbos compile`). Without it, group-admin
   actions fail closed (deny) — safe, but non-functional.
2. **authz.check round-trip.** As a verified company_admin (via enrollment), `POST /api/:tenant/authz/check`
   `{resource:"task",action:"create"}` → `{decision:"allow"}`; as an unlinked identity → `{decision:"stepup"}`;
   as a verified viewer → `{decision:"deny"}`.
3. **End-to-end business write.** From a linked+verified WhatsApp/Telegram identity: `/task create
   <projectId> <title>` → confirmation card → confirm → task appears in the platform; one `activities`
   row + one bot `action-audit.jsonl` row; unlinked identity gets step-up and NO write.
4. **Revocation mid-flow (D11).** Propose an action; revoke the user (`/admin/users/:id/revoke`)
   before confirming; confirm → denied, no write.
5. **Rich outbound on each surface.** `sendButtons` (Telegram inline keyboard; WhatsApp numbered
   fallback), `react`, `reply`, `sendMedia` — verify degradation matches the capability matrix.
6. **Group-admin verbs.** As company_admin: `/group rename`, `/group remove <id>` on both surfaces;
   confirm WhatsApp `pin` reports unsupported; Telegram `pin` works; `addMember` unsupported on TG.
7. **Intent router with a real model.** With the ai-gateway up (ollama/gemini): "mark task X done"
   → proposes `task.complete`; adversarial "delete everything" → `none` (no catalog match); low-info
   "assign it" → clarify. No unconfirmed/unauthorized mutation from any phrasing.
8. **Idempotency under real webhooks.** Force a WAHA/Telegram redelivery; confirm single store +
   single execute (matches `chaos.test.ts` at the unit level).
9. **Kill-switch drill.** Flip `/admin/actions/off`; confirm a write is blocked and reads still work;
   flip on; confirm writes resume.

## Follow-ups (non-blocking, tracked)
- Redis-backed dedup + outbound queue for horizontal scale (Phase A shipped in-process versions).
- Reaction-triggered confirmations (✅ to approve) — inbound reaction events are normalized (Phase B)
  but not yet wired to the confirm FSM.
- Per-chat → company (tenant) mapping to replace the single DEFAULT_TENANT_ID.
- Multi-step agentic actions via the ai-agents supervisor (spec non-goal for this cycle).
