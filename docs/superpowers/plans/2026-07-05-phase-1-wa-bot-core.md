# Phase 1 — WA Bot Core — Implementation Plan

> **For agentic workers:** task-structured; expand each task to bite-sized TDD steps immediately before executing it. Use `superpowers:subagent-driven-development`. Update `2026-07-05-CHECKLIST.md`.
> **GATE:** do not ingest real group messages until Phase 0.10 + checklist G.1–G.6 are green.

**Goal:** Monitored groups produce twice-daily project-status digests (management + opt-in delivery) and the bot answers questions over each group's own history — the headline pilot value.

**Consumes from Phase 0:** `WhatsAppGateway`, `normalize`, `scrub`, `encryptField`/`decryptField`/`pseudonym`, `db`, `withTenant`, `gatewaySummarize`/`gatewayChat`.

---

### Task 1.1 — Group registry (auto-discover + YAML config)
- **Files:** `packages/app/src/groups/registry.ts`, `config/groups.yaml`, test `registry.test.ts`.
- **Produces:** `getMonitoredGroups(): GroupConfig[]`, `GroupConfig = { id, name, category, optIn, isManagement }`; auto-discovery logs all groups WAHA sees but not in config.
- **Test:** config with 2 groups + 1 management → parsed; an unlisted discovered group is logged, not monitored. Hot-reload on file change.
- **Deliverable:** monitored-group list + management-group resolution.

### Task 1.2 — Message normalize + persist (encrypted)
- **Files:** `packages/app/src/ingest/persist.ts`, extend `schema.ts` (`messages` cols: `sender_enc`, `sender_pseudonym`, `text`, `from_bot`, `type`, `media_ref`, `raw`), test.
- **Consumes:** `scrub`, `encryptField`, `pseudonym`. **Produces:** `persistMessage(InboundMessage, {fromBot})`.
- **Test:** inbound persisted with scrubbed text, encrypted sender, stable pseudonym; bot outbound stored with `from_bot=true`.
- **Deliverable:** every monitored-group message + bot reply persisted, PII-encrypted.

### Task 1.3 — Time-window model + schedule state
- **Files:** `packages/app/src/schedule/window.ts`, test.
- **Produces:** `windowFor(slot: 'noon'|'evening', now): {start, end}` using persisted `last_run_at` (gap-safe; first run caps 24h). 12:00 covers prev-18:00→12:00; 18:00 covers 12:00→18:00.
- **Test:** boundaries correct across a down-period (no gap/overlap); first-run cap.

### Task 1.4 — Scheduler
- **Files:** `packages/app/src/schedule/cron.ts`, test.
- **Produces:** cron @ 12:00 & 18:00 `Asia/Singapore` → triggers `runDigest(slot)`. **Test:** fires at the right local instant (inject clock); idempotent per slot/day.

### Task 1.5 — Summarizer (project-status digest)
- **Files:** `packages/app/src/summarize/digest.ts`, `prompts/digest.ts`, test.
- **Consumes:** `gatewaySummarize`, decrypted messages for the window. **Produces:** `summarizeGroup(groupId, window): GroupDigest` with sections: Discussion summary · Projects (ongoing/new) · Needs help/not finished · Behind schedule · Open questions · Answered questions. Map-reduce for oversized windows.
- **Test:** fixture transcript → digest contains the sections; empty window → "quiet"; fake Gateway (no model call in CI).

### Task 1.6 — Delivery (opt-in groups + management digest)
- **Files:** `packages/app/src/deliver/deliver.ts`, test.
- **Consumes:** `WhatsAppGateway.sendMessage`, group registry. **Produces:** `deliverDigests(slot)` — posts each opt-in group's own digest; assembles a category-grouped combined digest to the management group. Runs as the **management-digest service account** (D4): read-only, scoped, audited — never a standing `group_executive`.
- **Test:** opt-in group receives its digest; management receives combined; a per-group send failure still delivers the management digest; LLM failure → placeholder for that group.

### Task 1.7 — Trigger detector
- **Files:** `packages/app/src/interact/trigger.ts`, test.
- **Produces:** `detectTrigger(msg): {kind: 'mention'|'command'|'reply'|'dm'|null, payload}`. Reply-to-bot resolved via `from_bot` message ids.
- **Test:** each of @mention / `/cmd` / reply-to-bot / DM detected; ordinary group chatter → null.

### Task 1.8 — Interaction router (Q&A + workflow scaffold)
- **Files:** `packages/app/src/interact/router.ts`, `packages/app/src/interact/workflows.ts`, test.
- **Consumes:** trigger, group history (decrypted), `gatewayChat`. **Produces:** `/`-command → workflow registry (`/ping`, `/help`); else → Q&A over the group's own stored history (recency/keyword retrieval) + general. Reply-to-bot keeps last-N-turn context.
- **Test:** `/ping` → "pong"; a question → answer citing history fixtures; unknown `/x` → help.

### Task 1.9 — Identity (platform mints principal; low-assurance ceiling)
- **Files:** `packages/app/src/identity/principal.ts`, extend schema (`identity_links`), test.
- **Produces:** `resolvePrincipal({provider, externalId}): Principal` — the **app** resolves it (bot passes only the envelope, never a role). Unlinked/low-assurance → `{assurance:'low'}` → router allows only general + own-group Q&A; sensitive/bulk denied with a step-up prompt.
- **Test:** unlinked sender cannot trigger any company-data path; low-assurance ceiling enforced; bot cannot assert a role.

### Task 1.10 — Phase integration test
- **Files:** `packages/app/test/phase1.e2e.test.ts`.
- **Test:** seed a window of messages across 2 groups → `runDigest('evening')` → assert stored `summaries` + delivery calls (fake WA + fake Gateway); simulate each trigger → assert routed reply. Commit.

---

## Self-review
- Covers WA bot spec §5 (Phase 1) + D4 identity (1.9) + management-digest service account (1.6). Media (§6) is Phase 2; company-DB Q&A (§7) is post-MCP (future). No summary is delivered before the compliance gate is green (top-of-doc gate).
