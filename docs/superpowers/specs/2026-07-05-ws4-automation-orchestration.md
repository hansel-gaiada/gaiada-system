# Workstream 4 — Automation & Orchestration

**Date:** 2026-07-05
**Status:** Design stub (brainstorming stage)
**Parent:** `2026-07-04-gaiada-ai-platform-roadmap.md` (Workstream 4)
**Depends on:** WS2 MCP (tools), WS3 Gateway (AI), WS1 RBAC (service-account principals).
**Backbone rule:** N8N = orchestration, MCP = access, custom = logic. Automations hold **no business logic**; they **call MCP tools**.

---

## 1. Two tiers

- **Durable workflows (Temporal)** — reliable, resumable, long-running AI + business processes where correctness matters (multi-step agent goals, financial/reconciliation flows, migrations). Failure/retry/suspend-for-human are first-class (ties D14: budget-exhaustion suspends for human resume, never commits a placeholder).
- **Light glue (N8N)** — simple triggered/scheduled automations (CRON, "on X → notify/index") wired visually. For anything that outgrows a couple of steps or needs testing, promote to code + Temporal.

## 2. Triggers
- **Schedule/CRON** (e.g. the 12:00/18:00 digests — though the digest itself is a custom service).
- **Events** (via the event backbone — deferred in v1; v1 uses direct calls / queue jobs).
- **Webhooks** (e.g. WAHA message events → ingestion).

## 3. Identity & safety
- Automations run as **scoped, least-privilege service accounts** (WS1 RBAC), never a standing broad principal. The management-digest service account (D4) is the reference pattern: pre-scoped, read-only where possible, short-lived per-run credential, named in the audit.
- Any automation that triggers agent actions inherits D14 (impact taxonomy, per-run budget, precondition re-check).

## 4. v1 vs Target-State
- **v1:** BullMQ/Redis queues + minimal N8N for glue; Temporal introduced only when a genuinely durable multi-step flow appears. Keep it thin.
- **Target-State:** Temporal for all critical flows; N8N estate for broad glue; event-backbone-driven triggers.

## 5. Open items
- First real workflows worth Temporal (vs queue jobs).
- N8N hosting + credential scoping.
- Event-backbone trigger contract (with WS-event backbone, deferred).
