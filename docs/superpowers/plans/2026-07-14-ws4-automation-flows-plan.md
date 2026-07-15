# WS4 — Automation Flows: build plan

**Date:** 2026-07-14
**Status:** Steps 1–4 BUILT 2026-07-15 (foundation + CRON flows + event→n8n bridge + event flows +
gated webhook ingest), plus the automation service-principal + notify tool + compliance-gate/digest
paths, **plus the approvals suspension surface (§3/D14) — WS4 is now code-complete.** All §8
tool-path gaps closed. Remaining is target-state only: Temporal (deferred by design) + per-workflow
RBAC-minted short-lived creds + auto-resume of an approved suspension (a Temporal concern).
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
- **Bridge n8n dedupe — ✅ DONE 2026-07-15.** Both event workflows (`on-client-created-seed`,
  `on-org-updated-notify`) now dedupe on the envelope `id` via n8n workflow static data + an IF branch
  that always responds 200 (so the at-least-once bridge still gets its ack on a duplicate). This closes a
  real correctness gap — a redelivered `client.created` would otherwise double-seed onboarding.
- **`wf:task-sla` service account — ✅ DONE 2026-07-15.** The task-SLA flow was allow-listed + shipped
  (`task-sla.json`) but had no seeded principal (would 403 as anonymous). Added to `seed:automation`
  (member role — `resource_task` lets member update in-tenant tasks). Proven in `automation.test.ts`.
- **Approvals suspension surface — ✅ BUILT 2026-07-15 (supersedes the earlier "deliberately not built"
  call).** An earlier pass deferred this as speculative-YAGNI (all current write tools are `low`, so
  nothing triggers a `suspend:` today). Reconsidered under the full-fidelity mandate + the explicit
  "finish WS4" ask: the write-safety spine (§3/D14) is incomplete without a durable place for a suspended
  write to land, so the surface is now built and tested end-to-end — the one thing missing was NOT the
  trigger (that arrives with the first medium+ tool) but the mechanism, which shouldn't be improvised
  under pressure later. What shipped:
  - A **dedicated** `automation_approvals` store — migration `0014_automation_approvals.sql`, FORCE-RLS
    tenant-isolated (NOT the agency approvals table, which is campaign/asset-bound; a cross-cutting
    automation concern deserves its own store).
  - `platform-nest` `src/core/automation-approvals.controller.ts`: `POST /api/:t/automation-approvals`
    (file a suspension), `GET` (pending inbox), `POST .../:id/decide` (approve|reject). Cerbos
    `resource_automation_approval.yaml`: automation service accounts + members may **create**; elevated
    humans **read**; only `company_admin`/`group_executive` may **decide**.
  - mcp-hub `approvals.request` tool (LOW write — it records an *intent*, never the gated write) so the
    workflow files the suspension **through the hub** (backbone rule preserved: n8n → MCP OBO → platform).
    Added to the write workflows' allow-list (`wf:new-client-seed`, `wf:task-sla`).
  - The reusable **impact-gate Code-node snippet** (detect `suspend:` → route to `approvals.request`) is
    documented in `automation/README.md`; live workflows stay clean (no dead branch) until a medium+ tool
    exists. Verified: hub tsc + 14 tests; platform tsc + `automation-approvals.test.ts` (4) live PG+Cerbos+RLS.
  - **Still deferred (Temporal):** *auto-resuming* an approved suspension (re-driving the tool call) — v1
    records + decides; the approved row is the durable artifact a future resume step reads.
- **Per-workflow service-account minting:** v1 uses seeded static service users + verified links; the
  shared hub token still authenticates n8n-as-a-service. RBAC-minted short-lived per-workflow creds are
  target-state (spec §3).
- **`site_subscriptions` D5 gap — ✅ FIXED + VERIFIED 2026-07-15 (was pre-existing, not WS4).**
  `rls.test.ts` flagged that this table (a `tenant_id` column) had no FORCE RLS. It is the central
  node→tenant ACL and is **not tenant-isolated** — the Go sync engine reads it with NO tenant context
  (`acl.go` `WHERE node_id=$1`, `tombstone.go` `SELECT DISTINCT tenant_id`), so a tenant-isolation policy
  would return zero rows and break the ACL/GC. But leaving it with NO RLS let the shared `gaiada_app`
  owner (which also runs the platform) read/tamper with the sync ACL, and `gaiada_app` owns the DB so
  `REVOKE` can't bind it. **Fix (migration `0015_site_subscriptions_rls.sql`):** FORCE RLS gated on a
  session GUC `app.sync_context='on'` that ONLY the sync engine opts into (`sync-engine-go`
  `internal/db.NewPool` now sets it per connection via `AfterConnect`). The platform never sets it →
  fail-closed out of the ACL (zero rows / RLS-violation on write); the sync engine's context-free reads
  still work. This restores the clean invariant (the test's `RLS_EXEMPT_TENANT_TABLES` exemption was
  removed) **and** closes the exposure — a real barrier against the shared role, not just accidental.
  **Verified on WSL (Go 1.26.5):** manual gate check (0 rows without ctx / 1 with / INSERT-without-ctx
  → RLS violation) + the **full `sync-engine-go` suite green** against a NOBYPASSRLS role (bootstrap,
  server, gc, protocol, 2-DB chaos harness) + `go vet` clean; platform full suite green (146). The test
  helpers were switched from raw `pgxpool.New` to the production `db.NewPool` so they exercise the real
  connection setup. **Note (still target-state):** a *hard* boundary against a compromised platform would
  need a separate DB role (platform + sync-central currently share `gaiada_app`); the GUC gate is
  defense-in-depth within the shared-role model, not a role split.
