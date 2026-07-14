# WS4 — Automation Flows: build plan

**Date:** 2026-07-14
**Status:** Steps 1–4 BUILT 2026-07-15 (foundation + CRON flows + event→n8n bridge + event flows +
gated webhook ingest), plus the automation service-principal + notify tool + compliance-gate/digest
paths. All §8 tool-path gaps closed. Remaining: Temporal (deferred by design) + per-workflow
RBAC-minted creds (target-state).
**Parent spec:** `../specs/2026-07-05-ws4-automation-orchestration.md`
**Depends on:** WS2 mcp-hub (tools + OBO audit), WS1 event backbone (`platform-nest/src/events/`),
WS1 RBAC/Cerbos (service-account principals), WS3 gateway (via `llm.*` hub tools).
**Backbone rule (non-negotiable):** **n8n = orchestration · MCP = access · custom services = logic.**
Workflows hold no business logic and touch no DB; every action is an mcp-hub `tools/call` carrying an
OBO service identity, so it lands in the hub audit trail under least privilege.

---

## 0. Where we are (verified 2026-07-14)

- `automation/` runs n8n in Docker (localhost-bound, basic-auth) + **one** template workflow
  `workflows/summarize-via-mcp.json` — the canonical pattern: webhook → hub `tools/call`
  (`x-obo-provider: n8n`, `x-obo-external-id: wf:<name>`) → parse SSE → respond.
- Event backbone is **live** (`emitEvent()` → `outbox_events` → Redis Streams relay → consumer with
  a module `eventHandlers[eventType]` hook). Events already emitted include `org_structure.updated`,
  `deliverable.updated`, `deliverable.approved`.
- mcp-hub tools available: reads `projects.list`, `tasks.list`, `agency.pendingApprovals`,
  `rollup.metrics`, `knowledge.search`, `llm.summarize`, `media.extract`, `whoami`; writes
  `projects.create`, `tasks.create`, `tasks.update`, plus the non-mutating `authz.check`.
- **The Automation console is built and waiting** (`platform-ui/.../systems/automation/page.tsx`): it
  renders `detail.workflows[]` and an **Open n8n** button from `detail.n8nUrl`. The backend probe
  (`platform-nest/src/admin/admin-systems.controller.ts`) only returns `{ ok, detail: { url } }` — so
  the console permanently shows "appears once connected." **This is the first gap to close.**

### Decisions locked with the user (2026-07-14)
1. **Plan doc first** (this file) before any code.
2. **Write safety = auto for low-impact only:** read/notify flows run fully auto; a write classified
   **low-impact** auto-runs; **medium+ suspends for human approval**; **unclassified ⇒ suspend**
   (spec §D14: "unclassified = confirm-required"). This requires an explicit **impact tier on every
   hub write tool** — see §3.

---

## 1. Two tiers (unchanged from spec §1)

- **Light glue (n8n)** — CRON / webhook / event-triggered "on X → call MCP tool → notify". Everything
  in this plan is n8n. Keep it thin.
- **Durable workflows (Temporal)** — **deliberately absent.** Introduce only when a genuinely durable,
  multi-step, suspend-for-human flow appears (first likely candidate: multi-step agent goals). Do not
  add speculatively.

---

## 2. The flow catalog (the "what")

Grouped by trigger. Each flow names the hub tool(s) it calls and its write class.

### CRON-triggered
| Flow | Schedule | Hub tools | Class |
|---|---|---|---|
| **Management digest fan-out** | 12:00 / 18:00 | (bot digest service is the logic; n8n triggers + routes via notify) | read/notify |
| **Compliance-gate nag** | daily 09:00 | read gates → `llm.summarize` (optional) → notify owners | read/notify |
| **Stale-approval chaser** | hourly | `agency.pendingApprovals` → notify assignees | read/notify |

### Event-triggered (needs the §4 bridge)
| Flow | Event | Hub tools | Class |
|---|---|---|---|
| **Org re-index / notify** | `org_structure.updated` | notify affected assignees | read/notify |
| **Brief → creative lead** | `brief.created` | notify | read/notify |
| **New client → seed deliverables** | `client.created` | `projects.create` / `tasks.create` | **write (low)** — auto |
| **SLA timer on task** | `task.updated` | `tasks.update` (e.g. flag overdue) | **write (low)** — auto |

### Webhook-triggered
| Flow | Trigger | Hub tools | Class |
|---|---|---|---|
| **Out-of-band ingest** | inbound email/form POST | `knowledge.search` / create task | **write (low)** — auto |
| **summarize (template)** | `POST /webhook/summarize` | `llm.summarize` | read (exists) |

> Anything that would touch real employee/client data stays gated behind the legal Gate 1 + day-one
> technical gate regardless of impact class.

---

## 3. Identity, safety & the impact tier (the write-safety spine)

**Per-workflow scoped service accounts.** Replace the shared `REPLACE_WITH_HUB_SERVICE_TOKEN` with a
per-workflow least-privilege hub principal. The OBO envelope already carries `x-obo-external-id:
wf:<name>`; the hub's deny-by-default policy decides which tools each `wf:*` identity may call. Define a
policy entry per workflow so a digest flow cannot call `tasks.create`.

**Impact tier on every write tool (new).** Add an `impact: "low" | "medium" | "high"` field to
`registerTool` for write tools in `mcp-hub` (`platform-write-tools.ts`). Surface it in `tools/list`
metadata. The n8n **impact-gate node** (a shared Code-node snippet) reads the tier and:
- `low` → proceed;
- `medium` / `high` / **absent** → do **not** call; instead POST a suspension to the platform
  approvals inbox (a pending approval keyed to `wf:<name>` + intended tool + args) and stop. A human
  resumes it from the built Approvals UI.

Initial classification: `projects.create`, `tasks.create`, `tasks.update` = **low** (in-tenant,
reversible, Cerbos+RLS still enforced at the platform). Reserve `medium+` for money/status-transition
or external-effect tools when they exist. This satisfies §D14 without over-blocking today's flows.

---

## 4. Event → n8n trigger contract (the deferred v1 gap)

Spec §2 deferred event triggers; this closes it. **Chosen approach: a small relay-side bridge**, not an
n8n polling node (keeps n8n dumb, keeps the consumer group in one place).

- Add an **event→webhook fan-out** as a module `eventHandlers` entry (or a dedicated consumer) in
  `platform-nest/src/events/`: for a configured allow-list of `eventType`s, POST the event to the
  matching n8n webhook (`http://n8n:5678/webhook/ev/<eventType>`).
- **Envelope** (stable, versioned): `{ v:1, eventType, tenantId, entityType, entityId, hlc, createdAt,
  payload }` — the same shape the relay already frames (`src/events/relay.ts`).
- **Idempotency:** include the event id; n8n webhooks dedupe on it (the consumer already has
  at-least-once semantics + a dead-letter, so the bridge must tolerate replays).
- **Auth:** shared bridge secret header; n8n webhook validates it.

---

## 5. Closing the console gap (make the built UI real)

In `admin-systems.controller.ts`, extend the `automation` branch beyond the `/healthz` liveness probe:
- Call n8n's REST API (`GET /rest/workflows`, `GET /rest/executions?limit=...`) with an
  `AUTOMATION_API_KEY`, reshape to `detail.workflows[] = { name, status, lastRun }` and set
  `detail.n8nUrl`.
- Add `AUTOMATION_API_KEY` (+ confirm `AUTOMATION_URL`) to `config.services.automation` and to the
  `platform` service env in `infra/compose/docker-compose.vps.yml` (per the Phase-C deploy TODO).
- Fail-soft: unreachable n8n → `ok:false`, `workflows: []` (UI already degrades).

---

## 6. Build order

1. **Console gap + impact tier + scoped accounts** (§3, §5) — foundation & security spine; unblocks the
   built UI. No new flows yet. **✅ BUILT 2026-07-15:** `Impact` tier + `write` flag on hub tools
   (`registry.ts`, classified on the 3 write tools); per-workflow allow-list + automation write gate
   enforced hub-side (`automation-policy.ts`, `policy.ts`) with 6 new tests; `/tools` catalog exposes
   `write`/`impact`; platform automation probe lists n8n workflows via the Public API →
   `detail.{n8nUrl,workflows[]}` + `counters.workflows` (`admin-systems.controller.ts`, +1 test, live
   PG+Cerbos green); `AUTOMATION_API_KEY` config + full admin-console env block added to the VPS compose
   `platform` service.
2. **CRON flows** (§2) — lowest risk, reuse existing services. **✅ BUILT 2026-07-15:**
   `automation/workflows/stale-approval-chaser.json` (hourly `agency.pendingApprovals` → notify).
   `digest-fanout` and `compliance-gate-nag` are **deferred** — their tool paths don't exist
   (`rollup.metrics` is verified-only, unreachable by a low-assurance automation principal; there's
   no compliance-gates hub tool). They're intentionally NOT in the hub allow-list (see §8).
3. **Event→n8n bridge** (§4) + **event flows** — **✅ BUILT 2026-07-15:** `platform-nest`
   `src/events/n8n-bridge.ts` — a separate `n8n-bridge` Redis consumer group over the event streams,
   forwards allow-listed events to `${N8N_WEBHOOK_BASE_URL}/webhook/ev/<eventType>` with the v1
   envelope + `x-gaiada-bridge-secret`, fail-closed via `n8nBridgeEnabled()`, at-least-once with
   dead-letter after 5 retries; started in `main.ts` (Redis-gated). 6 unit tests (`forwardEvent`
   ack/retry/skip + envelope) + 1 live-Redis loop smoke green. Event workflows:
   `on-org-updated-notify.json` (live — `org_structure.updated` IS emitted) and
   `on-client-created-seed.json` (template; **needs a `client.created` emit** — only
   `org_structure.updated` is emitted today; see §8). Bridge env added to the VPS compose `platform`
   service.
4. **Webhook ingest flows** — behind the legal/day-one gates. **✅ BUILT 2026-07-15:**
   `automation/workflows/on-inbound-lead.json` (`POST /webhook/ingest/lead` → `tasks.create` in the
   intake project). **Fail-closed gate**: inert unless `INGEST_ENABLED=1` + shared `INGEST_SECRET` —
   do not enable until legal Gate 1 + the day-one technical gate are green. Scoped identity
   `wf:inbound-lead-intake` (manager role for `tasks.create`).

### Closed since the plan was written (were §8 blockers)
- **Automation service principal (the real blocker):** an `n8n` OBO envelope resolved to ANONYMOUS at
  the platform (`guards.ts`), so every automation→platform call 403'd. Fixed via `seed:automation`
  (`src/seed/automation.ts`): a least-privilege service user + membership + one scoped role + a
  **verified `identity_link`** per workflow. Two-layer least privilege (hub allow-list bounds tools,
  Cerbos role bounds data). Proven end-to-end in `src/seed/automation.test.ts` (seeded `wf:new-client-seed`
  → project create 201; unseeded → 403).
- **`client.created` emit:** added to `client-work.controller.ts` createClient (transactional outbox);
  `on-client-created-seed` is now live-eligible.
- **`compliance-gate-nag` tool path:** new `compliance.gates` hub read tool → `GET /api/:t/compliance-gates`;
  service account granted `company_admin`. Workflow shipped.
- **`digest-fanout` path:** triggers the bot's existing `POST /run-digests/:slot` admin endpoint directly
  (service-job trigger, no MCP data access) — no new bot endpoint needed. Workflow shipped.
- **In-app notify tool:** new hub `notify` write tool (low impact) → new `POST /api/:t/notifications`
  + Cerbos `create` for company_admin/manager. Wired into `on-client-created-seed`.
5. Temporal: **not now.** Revisit when a durable multi-step flow is real.

## 7. Testing & verification

- Hub: unit-test that each `wf:*` principal sees only its allow-listed tools; that write tools expose an
  `impact` tier and unclassified/`medium+` are refused by the gate node.
- Platform: test the automation probe reshape (stub n8n REST) → `workflows[]` + `n8nUrl`; test the
  event→webhook bridge fires for allow-listed events only, with the v1 envelope, and is replay-safe.
- n8n: import each workflow JSON into a throwaway instance, fire the trigger, assert the hub audit row
  carries `wf:<name>` and the platform activity audit records the write.

## 8. Open items (updated 2026-07-15 — the tool-path/emit/notify/principal blockers are CLOSED, see above)

- **Deploy wiring for the live flows:** set `N8N_BRIDGE_EVENTS`/`N8N_BRIDGE_ENTITY_TYPES` to include
  `client.created`/`client`, run `seed:agency` → `seed:automation`, and set the n8n workflow env
  (`AGENCY_TENANT_ID`, `INTAKE_PROJECT_ID`, `NOTIFY_USER_ID`, `BOT_URL`/`BOT_ADMIN_TOKEN`).
- **Approvals suspension surface:** the hub returns a `suspend: …` reason for medium+/unclassified
  writes, but no workflow-side "create a pending approval" step exists yet — reuse the agency approvals
  inbox (preferred) vs a dedicated `automation_approvals` store.
- **Per-workflow service-account minting:** v1 uses seeded static service users + verified links; the
  shared hub token still authenticates n8n-as-a-service. RBAC-minted short-lived per-workflow creds are
  target-state (spec §3).
- **Bridge n8n dedupe:** workflows should dedupe on envelope `id` (bridge is at-least-once); not yet
  added to the shipped event workflows.
- **RESOLVED (pre-existing, not WS4):** `rls.test.ts` was failing on `site_subscriptions`. Investigated:
  it is the central node→tenant ACL and is **intentionally not tenant-RLS'd** (0013 comment; the Go sync
  engine reads it with NO tenant context — `acl.go` `WHERE node_id=$1`, `tombstone.go` `SELECT DISTINCT
  tenant_id`), so a tenant-isolation policy would return zero rows and break the ACL/GC. The blanket
  invariant test predated the sync tables. Fix: encoded the precise invariant — `rls.test.ts` now has a
  documented `RLS_EXEMPT_TENANT_TABLES` set (with a guard that each exempt name still exists). Full suite
  green (141). Residual (noted, not fixed here): in the shared DB the platform app role has blanket DML
  on sync-engine tables incl. this ACL; the migration relies on it being "central-operator-only"
  operationally, not by grant — a privileges-hardening item for the sync-engine/infra owner.
