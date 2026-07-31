# Automation & Orchestration — WS4

**Status: v1 glue built** — self-hosted N8N + a template workflow that calls the MCP hub.
Temporal is deliberately absent until a genuinely durable multi-step flow exists (spec §4).

**Spec:** `../docs/superpowers/specs/2026-07-05-ws4-automation-orchestration.md`

## The backbone rule (non-negotiable)

**N8N = orchestration · MCP = access · custom services = logic.**
Workflows here hold no business logic and touch no database — every action is an
**mcp-hub tool call** carrying a named service identity (`x-obo-provider: n8n`,
`x-obo-external-id: wf:<workflow>`), so every automation action lands in the hub's audit
trail with least-privilege visibility (the hub's policy decides what n8n may call).

### Scoped service accounts + the write gate (enforced hub-side)

Each workflow is **least-privilege by its `wf:<name>` id**, not by a broad shared principal.
The hub's `automation-policy.ts` maps every workflow id to the exact tool names it may call
(deny-by-default: an unlisted workflow id can call nothing). **Adding a workflow means adding
its allow-list entry** — otherwise the hub denies every call with `workflow wf:<x> is not
scoped for <tool>`.

On top of scoping, a **D14 write gate** runs in `policy.ts`: an unattended automation run may
execute **low-impact writes only**. A `medium`/`high`-impact write — or any write tool that
declares no impact tier (unclassified) — is refused with a `suspend: … requires human
approval` reason; the workflow surfaces that as a pending approval rather than committing.
Today's write tools (`projects.create`, `tasks.create`, `tasks.update`) are all classified
`low`. This is enforced in the hub (not trusted to an n8n node), so it's unit-tested
(`automation-policy.test.ts`).

> Note: the shared hub **service token** still authenticates n8n-as-a-service; the per-workflow
> scoping is by the OBO `wf:<name>` id. True per-workflow *credentials* (RBAC-minted, short-lived)
> are target-state — see the WS4 plan §8.

### The impact-gate: suspending a write for human approval (§3/D14)

When the gate refuses a write, the hub reply is a `tools/call` result with `isError: true` and a
`text` that starts with `suspend:`. A workflow that calls any **medium+/unclassified** write must
detect that and, instead of failing, file a pending approval via the low-impact `approvals.request`
tool — which lands in the platform's tenant-scoped `automation_approvals` inbox (FORCE RLS,
Cerbos-gated) for a human to approve/reject in **platform-ui → Approvals**. Drop this Code node
between the write attempt and its parse step:

```js
// After an MCP write call, before treating the reply as success:
const raw  = $input.first().json.data ?? $input.first().json.body ?? '';
const line = String(raw).split('\n').find((l) => l.startsWith('data:')) ?? '';
const rpc  = JSON.parse(line.slice(5).trim());
const text = rpc.result?.content?.[0]?.text ?? '';
if (rpc.result?.isError && text.startsWith('suspend:')) {
  // Route to an `approvals.request` MCP node instead of proceeding:
  return [{ json: { suspended: true, toolName: '<the tool>', toolArgs: { /* intended args */ },
                    impact: 'medium', reason: text } }];
}
return [{ json: { suspended: false /* …parsed result… */ } }];
```

The `approvals.request` node is an ordinary hub `tools/call` (same OBO headers) with
`params.name = "approvals.request"` and args `{ tenantId, workflowId: "wf:<name>", toolName,
toolArgs, impact, reason }`. Today all shipped write tools are `low`, so no live workflow hits this
branch — but the surface is built and tested end-to-end, ready the moment a `medium+` tool lands.
**v1 records + decides; it does not auto-resume the approved call** (re-driving it is a Temporal
concern the spec defers — the approved row is the durable artifact a resume step would read).

## Run

```bash
cp .env.example .env       # set N8N_ENCRYPTION_KEY (openssl rand -hex 32)
docker compose up -d       # http://localhost:5678 (localhost-bound; tunnel in remotely)
```

n8n 2.x has **no basic-auth** — the first visit to the UI shows an **owner-account setup
wizard** (create admin email + password there). Pin `N8N_ENCRYPTION_KEY` in `.env` so saved
credentials survive a volume reset; the compose refuses to start without it.

## Workflows

Import each JSON in the n8n UI and activate. They read the hub token + tenant/notify targets
as **container env vars** (`$env.<NAME>`), all pre-wired through `.env` → compose, so there's
nothing to hand-edit in the UI — just fill the values in `.env` and `docker compose up -d`:
`HUB_SERVICE_TOKEN`, `AGENCY_TENANT_ID`, `N8N_BRIDGE_SECRET`, `NOTIFY_WEBHOOK_URL`,
`NOTIFY_USER_ID`, `INTAKE_PROJECT_ID`, `SLA_PROJECT_ID`, `BOT_URL`, `BOT_ADMIN_TOKEN`,
`INGEST_ENABLED`, `INGEST_SECRET`, `SEARCH_CALLBACK_SECRET`, `PLATFORM_URL`,
`PLATFORM_SERVICE_TOKEN` (see `.env.example` for what each drives;
`SEARCH_CALLBACK_SECRET` is **now consumed** by the platform's search rank-pull collect edge (SM-56) and
is **required** to use it — the route refuses every request while the value is empty. Set the same value
in the platform's own env).

| File | Trigger | Does | Scoped identity |
|---|---|---|---|
| `summarize-via-mcp.json` | `POST /webhook/summarize` | hub `llm.summarize` → return summary (the base pattern) | `wf:summarize-via-mcp` |
| `stale-approval-chaser.json` | CRON hourly | hub `agency.pendingApprovals` → if any, in-app notify the ops lead (hub `notify`) | `wf:stale-approval-chaser` |
| `task-sla.json` | CRON every 6h | hub `tasks.list` → escalate overdue-and-unfinished tasks (`tasks.update` priority→high, LOW write); single project via `SLA_PROJECT_ID` | `wf:task-sla` |
| `compliance-gate-nag.json` | CRON daily 09:00 | hub `compliance.gates` → if any open, in-app notify the ops lead (hub `notify`) | `wf:compliance-gate-nag` |
| `digest-fanout.json` | CRON 12:00 & 18:00 | trigger the bot's digest sweep on its admin API | — (bot admin, no hub) |
| `on-org-updated-notify.json` | event bridge `POST /webhook/ev/org_structure.updated` | verify bridge secret → in-app notify the ops lead (hub `notify`) | `wf:org-updated-notify` |
| `on-client-created-seed.json` | event bridge `POST /webhook/ev/client.created` | seed onboarding project + kickoff task, then notify the ops lead (three LOW-impact writes) | `wf:new-client-seed` |
| `on-inbound-lead.json` | `POST /webhook/ingest/lead` **(gated)** | inbound lead → intake task; inert unless `INGEST_ENABLED=1` (legal Gate 1) | `wf:inbound-lead-intake` |
| `mtg-dispatcher.json` | `POST /webhook/mtg/recording-complete` (bridge secret, dedupe on `meetingId`) | **WS11** meeting → `llm.summarize` (MOM) → 3 separate `llm.extract` passes (prd/report/scope) → `pipeline.createRun` with all three stages populated. Fan-out to delivery/report/scope is event-driven via `pipeline.run.created`. **WD-08-R1:** a bad/missing bridge secret now short-circuits to an explicit `401 {"error":"unauthorized"}` (no detail leakage) via a `Secret bad?` gate, instead of relying on n8n's default 200-on-uncaught-throw behavior — 0 rows are created either way. **WD-08-R2:** the dedupe branch now calls `meeting.recordingContext` (already allow-listed for this workflow) to echo the ALREADY-linked `runId` alongside `deduped:true`, instead of `runId:null` — best-effort (falls back to `null` if the meetingId never went through the `meeting_recordings` registry, e.g. a raw pasted-transcript test). | `wf:mtg-dispatcher` |
| `pipeline-fanout.json` | event bridge `POST /webhook/ev/pipeline.run.created` | **WS11** scope track: open the client `scope_signoff` gate + notify PM (`wf:scope`); report track: route to internal process — STUB in-app notify (`wf:report`). | `wf:scope`, `wf:report` |
| `pipeline-delivery.json` | event bridge `ev/pipeline.gate.decided` + `ev/scope.signed` | **WS11** delivery spine: on PRD signed **AND** scope signed → `design.prototype` → add `claude_design` stage → open first Submission (`pm_review`) → notify PM. (v1 spine; code/deploy/3-beat/revise are the documented extension.) **DEF-3 (2026-07-30):** `deploy.production` is impact:`high`, so the D14 write gate ALWAYS suspends it for the automation principal (`wf:delivery`) regardless of upstream pipeline-gate approvals — that suspend is now routed to `approvals.request` (a real WS4 `automation_approvals` row, `origin:'automation'`, `tool_name:'deploy.production'`) instead of silently dead-ending into the fail-soft `production` stage write. The fail-soft path (write `production`=`failed` + notify) is unchanged and still fires for genuine (non-suspend) dispatch failures. **Known boundary, unchanged by this fix:** approving the WS4 row does NOT itself re-drive the deploy — there is no generic "resume a D14-suspended automation write" mechanism in this codebase (confirmed live: deciding the approval leaves the run with no `production` stage). The only existing precedent for resuming after an `automation_approval.decided` event is HR's bespoke `leave-decision.ts` handler, which mutates its own domain row directly rather than replaying a suspended hub tool call — building a generic equivalent for `deploy.production` is a Temporal/durable-callback-class design decision (see the impact-gate note above: "v1 records + decides; it does not auto-resume the approved call"), not wiring, and is left to the architect. | `wf:delivery` |
| `reports-nightly-facts.json` | CRON daily 02:00 | **TR-11** (tracker/reporting §10 flow 1). `POST facts/recompute {from:D-2, to:D-1}` **DIRECT to platform-nest** (not the hub — recompute is deliberately never an MCP tool, §9.2) under its own `PLATFORM_SERVICE_TOKEN`; idempotent (recompute the same window twice → byte-identical rows). Retries ×3 (native `retryOnFail`), then dead-letters an in-app notification via hub `notify` (no ntfy reachable from n8n's own docker network in this deployment — see the note below). | `wf:reports-nightly-facts` |
| `reports-eod-reminder.json` | CRON daily 17:30 | **TR-11** (§10 flow 2). `GET checkins/pending-reminders` **DIRECT to platform-nest** (also not an MCP tool — service/admin tier, not agent-callable) → for each pending person with a verified WA link (the additive `waExternalId` field), the **bot's** `POST /admin/notify` fetches THEIR OWN prefill (D4 OBO, never asserted) and awaits their reply; everyone else gets an in-app notification (hub `notify`). §5.3's guard means a holiday/leave day returns `pending: []` and this flow delivers **nothing** — quiet by construction, not a special case in this workflow. | `wf:reports-eod-reminder` |
| `reports-morning-escalation.json` | CRON daily 09:00 | **TR-11** (§10 flow 3). `GET checkins/missed-yesterday` **DIRECT to platform-nest** — the platform (not this workflow) groups yesterday's misses by unit and resolves each unit's own lead server-side (no per-org-node Cerbos primitive exists, so it narrows in-app the same way TR-09 already does elsewhere); this flow only fans out one hub `notify` per (unit, lead) pair the platform already resolved. A unit with no resolvable lead is skipped, never broadcast to someone outside it. | `wf:reports-morning-escalation` |

Every hub call is a raw JSON-RPC `tools/call` (the hub is stateless — no handshake; replies are
SSE-framed and parsed by a Code node) carrying the workflow's OBO identity headers. Adding a
workflow that calls a new tool **requires an `AUTOMATION_ALLOWLIST` entry in the hub** (§ scoped
accounts above) — otherwise the hub denies it.

> **Automation calls need a platform service principal.** An `n8n` OBO envelope only becomes a
> real (non-anonymous) principal once a **verified `identity_link`** maps `wf:<name>` to a
> least-privilege service user. Seed them with `npm run seed:automation` in `platform-nest`
> (after `seed:agency`) — without it every hub→platform call is denied as anonymous. The hub
> allow-list bounds *which tools*; the service user's role bounds *which data/actions*.

Note: workflows call the hub at `http://mcp-hub:3003`. On the VPS stack n8n shares the network
and that resolves natively; standalone, the compose adds `extra_hosts: mcp-hub:host-gateway`
so the same URL reaches a hub on the host's port 3003 — no workflow edits either way.

## TR-11's direct-to-platform pattern (new, distinct from the hub calls above)

`reports-nightly-facts` / `reports-eod-reminder` / `reports-morning-escalation` are the FIRST
workflows in this repo to call **platform-nest directly**, bypassing the hub entirely, because
their reads/writes (`facts/recompute`, `checkins/pending-reminders`, `checkins/missed-yesterday`)
are deliberately **not** MCP tools (tracker-reporting blueprint §9.2 excludes `recompute`
outright; the two checkin reads are service/admin-tier, not agent-callable). They authenticate
with `PLATFORM_SERVICE_TOKEN` — the exact same shared secret platform-nest's own
`config.serviceToken` and mcp-hub's own `config.platformToken` already read from that env var
name — carrying the standard `x-obo-provider: n8n` / `x-obo-external-id: wf:<name>` envelope so
`seed:automation`'s `company_admin` service account resolves the same way every other workflow's
identity does. **Note the blast-radius difference from every hub-routed call above:** a direct
platform call is bounded only by Cerbos + that service account's role, not by the hub's
per-workflow tool allow-list — treat `PLATFORM_SERVICE_TOKEN` with the same care as
`HUB_SERVICE_TOKEN`, and do not widen these three service accounts' roles casually. Resolved via
`extra_hosts: platform:host-gateway` standalone, mirroring the existing `mcp-hub:host-gateway`
entry (platform-nest is published on the host at `:3004` in this deployment).

**The WA reply round trip is NOT this workflow's job — it's the bot's.** `reports-eod-reminder`
only tells the bot WHICH chat to remind (`POST /admin/notify {tenantId, chatId}`); the bot itself
(`wa-chat-bot/src/checkin.ts`) fetches that person's own prefill via the hub's `checkin.getToday`
tool and, on their reply, submits via `checkin.submit` — both registered in
`platform-nest/src/modules/reports/index.ts`'s `mcpTools`, both under the OBO envelope of the
person who actually replied (never n8n, never an assertion by the bot). This is what "n8n
orchestrates, MCP accesses, no business logic in workflows" means concretely here: the workflow
never sees a summary, a draft, or a submission — only "remind this chat" and "notify this person".

**Why `reports-nightly-facts`'s dead-letter goes through the hub's `notify` tool, not ntfy
directly (§10's literal text says "ntfy"):** the self-hosted `ntfy` container in this deployment
has no published host port (unlike `mcp-hub`/`platform`), so n8n's separate docker network cannot
reach it without an infra change outside this ticket's scope. Every other alerting path in this
repo already substitutes an in-app notification via the hub's `notify` tool for exactly this reason
(see "Notifications" above — `NOTIFY_WEBHOOK_URL` itself is optional/unused today), so the
dead-letter branch follows that same established convention rather than introduce a new one.

## Notifications (internal, no external channel)

The notify flows (`stale-approval-chaser`, `compliance-gate-nag`, `on-org-updated-notify`) raise
an **in-app notification** for `NOTIFY_USER_ID` via the hub **`notify`** tool → `POST
/api/:t/notifications` → the platform's per-user inbox (the bell + `/notifications` page in
platform-ui). No Slack/Teams/webhook is required. Cerbos gates `notification.create` to
`company_admin`/`manager`, so those workflows' **service accounts are granted `manager`** (or
`company_admin` for the compliance flow) in `seed:automation`, and `notify` is on each one's hub
allow-list. `NOTIFY_WEBHOOK_URL` is now optional — only for a custom flow you add that posts
externally.

## Deferred flows (off by design — activate when their dependency exists)

- **`digest-fanout`** — needs the **wa-chat-bot** running: it calls the bot's admin API
  (`BOT_URL` + `BOT_ADMIN_TOKEN`) to trigger the categorized 12:00/18:00 digest sweep to WhatsApp/
  Telegram groups. This is inherently a bot function (chat-group delivery), not something the
  in-app notifier replaces. Activate once the bot is deployed (its WAHA number scanned or Telegram
  token set — see the bot README; blocked on infra, not on this stack).
- **`on-inbound-lead`** — kept inert by `INGEST_ENABLED=false`. This is a **deliberate legal gate**
  (Gate 1: DPIA/LIA/notices in `legal/`); inbound-lead ingestion must not run until legal sign-off
  **and** the day-one technical gate are both green. The flow is built + scoped (`wf:inbound-lead-intake`
  → `tasks.create` into `INTAKE_PROJECT_ID`); flip `INGEST_ENABLED=true` only after Gate 1 clears.
- **Recurring search-marketing pull cadence (formerly SM-15's `sm-rank-pull`/`sm-keyword-refresh`/
  `sm-rank-collect`) — RETIRED, not deferred.** Architect ruling (tracker §6ad/A13, 2026-07-30):
  automation must never be able to trigger a paid vendor pull through any mechanism, so lowering
  `search.pullRanks`'s `minAssurance` was refused. Recurring cadence work now lives entirely in
  **SM-54**, a platform-side module scheduler job in `platform-nest` (precedent:
  `startReconcileLoop`/`startDriftSweepLoop`/`startBurndownSnapshotLoop`) — the engagement's own
  `tool_scope` (toggle + cadence + budget cap), written by a verified human under
  `search:scope:write`, is the standing authorization; the vendor-postback collect edge is SM-56
  (parked). The three workflow JSONs and their `AUTOMATION_ALLOWLIST` entries are deleted, not kept
  for reference — git history has them if anyone needs to look. Do not re-file this as an n8n flow.

## Event → n8n bridge (business-event triggers)

The event flows above are driven by the **platform's event→n8n bridge** (`platform-nest`
`src/events/n8n-bridge.ts`): a separate Redis consumer group over the event-backbone streams that
POSTs allow-listed events to `${N8N_WEBHOOK_BASE_URL}/webhook/ev/<eventType>` with an
`x-gaiada-bridge-secret` header and a stable **v1 envelope** `{ v:1, id, eventType, entityType,
tenantId, entityId, originSite, createdAt, payload }`. It's at-least-once — n8n should dedupe on
`id`. Enable it by setting on the `platform` service: `N8N_WEBHOOK_BASE_URL`, `N8N_BRIDGE_SECRET`
(must match the workflows' `N8N_BRIDGE_SECRET`), `N8N_BRIDGE_EVENTS` (comma list, e.g.
`org_structure.updated,client.created`), and `N8N_BRIDGE_ENTITY_TYPES` (the streams to watch, e.g.
`org_structure,client`). All four must be set or the bridge stays off (fail-closed).

## Admin console

The platform's **Systems → Automation** console lists these workflows + last-run and links
"Open n8n" once the platform has an n8n **Public-API key**: set `AUTOMATION_URL` +
`AUTOMATION_API_KEY` on the `platform` service (create the key in n8n → Settings → API).
Without a key the console still shows liveness but an empty workflow list.

## What comes later (WS4 plan)

The build order, flow catalog, and per-step status live in
`../docs/superpowers/plans/2026-07-14-ws4-automation-flows-plan.md`. Steps 1–4 (foundation, CRON
flows, event→n8n bridge + event flows, gated webhook ingest) are built. Temporal stays absent
until a genuinely durable multi-step flow exists; per-workflow RBAC-minted short-lived credentials
(vs today's seeded service users) are target-state.

## WS11 meeting-to-delivery pipeline (new, in progress)

`mtg-dispatcher.json` is the entry point of the WS11 pipeline
(`../docs/superpowers/plans/2026-07-16-ws11-delivery-pipeline-plan.md`). Its hub tools
(`llm.extract`, `pipeline.createRun|updateStage|openGate`, reads) and platform state (migration
`0017_pipeline.sql`, `PipelineController`) are **built + tested**. The delivery/scope/report
sub-workflows + the client portal are subsequent build items.

**Test the dispatcher with a pasted transcript** (before the meeting bot exists), once the stack
runs the WS11 platform + hub build:

```bash
curl -sX POST http://localhost:5678/webhook/mtg/recording-complete \
  -H "x-gaiada-bridge-secret: $N8N_BRIDGE_SECRET" -H 'Content-Type: application/json' \
  -d '{"v":1,"meetingId":"mtg-demo-1","tenantId":"'"$AGENCY_TENANT_ID"'",
       "title":"Acme kickoff",
       "transcript":"Client wants a 3-page marketing site. Budget 5k, 3 weeks. ..."}'
# -> { ok, runId, deduped, prdConfidence }   then inspect: pipeline.getRun / platform-ui dashboard
```

Fan-out is **event-driven**: the run's `pipeline.run.created` event (plus later stage/gate events)
is what the delivery/scope/report sub-workflows subscribe to via the event→n8n bridge — the
dispatcher does not call Execute Workflow directly. Add
`pipeline.run.created` to `N8N_BRIDGE_EVENTS` and `pipeline_run` to `N8N_BRIDGE_ENTITY_TYPES` when
those sub-workflows land.

> **Live n8n import is pending a stack rebuild.** The running containers predate the WS11
> platform/hub code, so importing + triggering this workflow needs the `platform` + `mcp-hub`
> images (or tsx processes) rebuilt from the current source first. The workflow JSON is
> structure-validated and its tool chain is verified (platform endpoints against live PG+Cerbos;
> hub tools unit-tested); only the in-n8n execution is not yet exercised.
