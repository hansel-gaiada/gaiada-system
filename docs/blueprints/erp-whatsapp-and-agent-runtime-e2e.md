# ERP WhatsApp Go-Live Self-Service + Agent Runtime E2E — Design

**Status: PLANNED (design approved for build; no code exists yet for anything below unless
explicitly marked EXISTS).** Author: system architect, 2026-07-24.
Workstreams: **A** = WhatsApp pairing/monitoring from the ERP. **B** = agent runtime end-to-end.

Everything below was verified against the code on 2026-07-24 (not against status docs).

---

## 0. Context (verified)

| Fact | Where |
|---|---|
| Bot admin routes are `ADMIN_TOKEN`-gated Fastify routes; webhook ACKs 200 then processes detached | `wa-chat-bot/src/server.ts` |
| `WahaGateway` calls only WAHA *messaging* endpoints; **no session lifecycle / QR anywhere in the bot** | `wa-chat-bot/src/waha.ts` |
| Group registry = YAML file, hot-reload by mtime, **read-only bind mount in compose** (`./groups.yaml:/app/config/groups.yaml:ro`) | `wa-chat-bot/src/groups.ts`, `infra/compose/docker-compose.vps.yml:387` |
| WAHA compose already subscribes `WHATSAPP_HOOK_EVENTS: "message,session.status"`, but `normalizeWahaEvent` returns `null` for `session.status` → events silently dropped | compose:85, `wa-chat-bot/src/gateway/events.ts` |
| platform-nest admin aggregator EXISTS (`api/admin/:system/status|config`, gateway/hub/automation extras), gate = `isElevated` (global `platform_admin` / `group_executive`); bot token already configured (`config.services.bot`) but never used against bot `/admin/*` | `platform-nest/src/admin/admin-systems.controller.ts`, `src/config.ts:52` |
| `intelligence.controller.ts` returns `[]` for agent goals ("no goal store") | `platform-nest/src/admin/intelligence.controller.ts` |
| ai-agents: `runAgent`/`runOrchestrator`/`runWriteAgent` (D13/D14 in code), `traceRun` (typed statuses + transcript), `PgEpisodicStore` (Postgres, owner-DSN DDL), `ObservabilityCollector`, models registry, evals — all EXIST and tested. **No HTTP runtime**: Dockerfile CMD runs `knowledge/service.ts`; `cli.ts` persists nothing. `fastify` + `pg` already in package.json | `ai-agents/src/*` |
| `gaiada_knowledge` DB: `knowledge_owner` DDL role with `ALTER DEFAULT PRIVILEGES … GRANT … TO knowledge_app` → **new tables created by owner-DSN DDL auto-grant to the runtime role; zero infra/db changes needed** | `infra/db/init-cluster.sh:55-58` |
| Gateway providers are invoked with `context.Background()` and a **timeout-less** shared `http.Client`; a hung provider hangs `/complete` forever. Provider 429 is treated as a generic failure (feeds the consecutive-fail breaker). **Per-tenant daily cap already EXISTS** (`budget.perTenantCap`, `x-tenant-id`) — do not rebuild | `ai-gateway-go/internal/server/server.go:181-183`, `cmd/gateway/main.go:95`, `internal/budget/budget.go` |
| `/principal/resolve` is strictly `identity_links(provider, external_id)`-based; **no "platform" provider exists** — a UI-triggered agent has no resolvable OBO envelope today | `platform-nest/src/identity/identity.controller.ts` |
| aire reference (port, don't copy): `ensureSession` POST `/api/sessions/start`, status GET `/api/sessions/{s}`, QR GET `/api/{s}/auth/qr?format=image` → base64 data-URL JSON; UI = status pill + Connect/Get-QR + refresh + img polling | `aire/apps/backend/src/modules/whatsapp/whatsapp.service.ts:199-242`, `apps/frontend/src/app/dashboard/ai-agent/page.tsx:141-181` |
| UI: `/systems/bot` + `/agents` pages EXIST read-only; `updateBotConfig` server action already PUTs `/api/admin/bot/config` `{key,value}` (404s today); `lib/admin.ts` is the reader contract | `platform-ui/src/app/(app)/systems/bot/*`, `(app)/agents/page.tsx`, `src/lib/admin.ts` |

---

## 1. Architecture

```mermaid
flowchart LR
  subgraph UI [platform-ui]
    BOTPG["/systems/bot<br/>Connect WhatsApp + groups"]
    AGPG["/agents<br/>trigger + goals + transcripts"]
  end
  subgraph NEST [platform-nest]
    BADM["api/admin/bot/*<br/>(NEW proxy, isElevated)"]
    INTC["api/:t/agents/*<br/>(intelligence.controller, NOW REAL)"]
  end
  subgraph BOT [wa-chat-bot]
    ADMR["/admin/session/* /admin/groups /admin/config<br/>(NEW, ADMIN_TOKEN)"]
    SST["session-state tracker (NEW)"]
    GRP["groups.ts (now writable)"]
  end
  RUNNER["agent-runner (NEW Fastify svc :3006)<br/>goal queue + goal/run store"]
  WAHA["WAHA noweb-2026.7.2"]
  GW["ai-gateway :3002"]
  HUB["mcp-hub :3003"]
  KDB[("gaiada_knowledge<br/>agent_goals/agent_runs/agent_episodes")]

  BOTPG --> BADM --> ADMR --> WAHA
  WAHA -- "session.status webhook" --> SST
  AGPG --> INTC --> RUNNER
  RUNNER --> GW
  RUNNER -- "tools/call + OBO" --> HUB
  RUNNER --> KDB
```

Trust boundaries (unchanged): the UI never talks to bot/runner directly — everything goes
through platform-nest with the `isElevated` gate; nest holds the bot admin token and the
runner service token; the runner holds no provider keys and no platform-DB access (models via
Gateway, actions via hub OBO only, exactly like the CLI today).

---

## 2. Workstream A — WhatsApp go-live self-service

### 2.1 Bot: session lifecycle (NEW `wa-chat-bot/src/waha-admin.ts` + routes in `server.ts`)

A small WAHA session client, separate from `WahaGateway` (messaging) — same headers
(`X-Api-Key`), same base URL, operates **only on the configured `config.wahaSession`**. No
route accepts a session name from the caller (the ERP can never touch another session).

All routes: `Bearer ADMIN_TOKEN` via the existing `safeEqual`/`bearer` helpers; 503 when
`ADMIN_TOKEN` unset (existing pattern). All engine-tolerant: WAHA status strings pass through
verbatim (`STOPPED|STARTING|SCAN_QR_CODE|WORKING|FAILED|…`), never enumerated-and-rejected.

| Method | Path | Behavior | Response |
|---|---|---|---|
| POST | `/admin/session/start` | Create-or-start with the NOWEB store body (below). `POST {waha}/api/sessions`; on 409/422 "already exists" → `POST {waha}/api/sessions/{s}/start`. Then read status. | `200 {session, status, engine}` |
| GET | `/admin/session/status` | `GET {waha}/api/sessions/{s}` merged with the last webhook event | `200 {session, status, engine, me: {id,pushName}\|null, lastEvent: {status,ts}\|null}` |
| GET | `/admin/session/qr` | `GET {waha}/api/{s}/auth/qr?format=image` → base64. When paired/starting (no QR available) → `{qr:null,status}` — never an error | `200 {qr: "data:image/png;base64,…"\|null, status}` |
| POST | `/admin/session/stop` | `POST {waha}/api/sessions/{s}/stop` (keeps auth; no re-scan needed) | `200 {session, status}` |
| POST | `/admin/session/logout` | `POST {waha}/api/sessions/{s}/logout` (**unpairs the number** — next start needs a fresh QR) | `200 {session, status}` |
| POST | `/admin/session/restart` | `POST {waha}/api/sessions/{s}/restart`; fall back to stop→start if the route is absent on this image | `200 {session, status}` |

**NOWEB session-create body** (the exact contract; store MUST be enabled at creation or
chats/contacts stay invisible on the Baileys engine):

```json
POST {WAHA_URL}/api/sessions
{
  "name": "<config.wahaSession>",
  "start": true,
  "config": {
    "noweb": { "store": { "enabled": true, "fullSync": false } }
  }
}
```

Webhook config is NOT set per-session — the compose env (`WHATSAPP_HOOK_URL`,
`WHATSAPP_HOOK_EVENTS`) already applies globally. Implementer must verify exact
create/start/logout paths against the pinned image's Swagger (`localhost:3000`) —
`devlikeapro/waha:noweb-2026.7.2` — and adjust only the *paths*, never the response contract
above.

### 2.2 Bot: session.status visibility (NEW `wa-chat-bot/src/session-state.ts`)

- Extend `InboundEvent` (`gateway/events.ts`) with
  `{ kind: "session"; session: string; status: string; ts: number }`; `normalizeWahaEvent`
  maps `e.event === "session.status"` (payload `{name?, status}` — tolerate both `payload.status`
  and `payload.body?.status` shapes).
- `session-state.ts`: module-level last-known status + ring buffer of the last 20 transitions
  `{status, ts}`. `handleEvent` records `kind:"session"` events here (and logs a `warn` on
  transitions into `FAILED|STOPPED` from `WORKING` — ban/logout visibility). No reply logic.
- `/health` gains a `session` field (status string only — no identifiers):
  `{ ok, ai, session: "WORKING"|"…"|"unknown" }`. The nest bot status card picks it up.

### 2.3 Bot: writable group registry (`groups.ts` + NEW routes)

The registry file moves to the writable bot-data volume; YAML + hot-reload stay.

- `config.ts`: `groupsFile` default unchanged (`config/groups.yaml`, dev); NEW
  `groupsSeedFile` (`GROUPS_SEED_FILE`, default empty). Boot (in `start()`): if `groupsFile`
  is absent and the seed exists → copy seed → log one line. Compose sets
  `GROUPS_FILE=/app/data/groups.yaml` and mounts the old file read-only at
  `/app/config/groups.seed.yaml` (see §2.6).
- `groups.ts` gains `writeGroups(groups: GroupConfig[]): Promise<void>` — validate then
  **atomic write** (tmp file + rename, then `resetRegistryCache()`). Validation: `id` matches
  `/^\d+@(g\.us)$/`; `name` ≤ 200 chars; `category` ≤ 64; booleans coerced; **at most one**
  `isManagement`; ≤ 500 groups; reject with a field-level error otherwise.
- `noteDiscovered` additionally records into an exported in-memory map;
  NEW `discoveredGroups(): {id, name, firstSeenAt}[]` (still warn-once).
- NEW `postToGroups` runtime toggle (mirror `safety/kill-switch.ts`): env is the boot
  default, `setPostToGroups(bool)` overrides at runtime, digest send path reads the getter.

| Method | Path | Behavior | Response |
|---|---|---|---|
| GET | `/admin/groups` | Registry snapshot | `200 {registryActive, groups: GroupConfig[], discovered: [{id,name,firstSeenAt}], managementGroupId}` |
| PUT | `/admin/groups` | **Full-replace** write (idempotent; the UI computes the list). Validates per above. | `200` = new GET shape; `400 {error, field?}` |
| GET | `/admin/config` | Safe, read-only snapshot + editable values | `200 {fields:[…]}` (shape mirrors nest ConfigField: `wahaSession` ro, `botName` ro, `postToGroups` editable bool, `managementGroupId` editable text, `monitoredCount` ro) |
| PUT | `/admin/config` | Body `{postToGroups?: boolean, managementGroupId?: string}`. `managementGroupId` rewrites the registry (set `isManagement` on that id — adding a minimal entry if unknown — clear it elsewhere); empty string clears to the env fallback. | `200` = new GET shape |

### 2.4 platform-nest: bot admin proxy (NEW `src/admin/bot-admin.controller.ts`)

`@Controller("api/admin/bot")`, `AuthGuard`, **`isElevated` on every route** (extract the
helper from `admin-systems.controller.ts` into a shared `admin/elevated.ts`). All calls go to
`config.services.bot.url` with `Authorization: Bearer config.services.bot.token`;
`adminProbeTimeoutMs` per call except start/qr which get a dedicated 10s
(`ADMIN_SESSION_TIMEOUT_MS`). Fail-soft contract: bot unreachable/unconfigured →
`502 {error:"bot admin unreachable"}` / `404 {error:"bot not configured"}` (never fabricate).

| Method | Path | Proxies |
|---|---|---|
| POST | `/api/admin/bot/session/start` | bot `POST /admin/session/start` |
| GET | `/api/admin/bot/session/status` | bot `GET /admin/session/status` |
| GET | `/api/admin/bot/session/qr` | bot `GET /admin/session/qr` (pass the JSON through; response header `Cache-Control: no-store`) |
| POST | `/api/admin/bot/session/stop` / `logout` / `restart` | bot equivalents |
| GET / PUT | `/api/admin/bot/groups` | bot `/admin/groups` (PUT body validated as `{groups: […]}` before forwarding) |
| PUT | `/api/admin/bot/config` | body `{key, value}` (**matches the existing UI stub**); allow-list `key ∈ {postToGroups, managementGroupId}` → forward as bot `PUT /admin/config {[key]: value}`; anything else `400` |

Also in `admin-systems.controller.ts`: `probeStatus("bot")` adds `detail.session` from the
bot `/health.session`; `connectionConfig("bot")` is replaced for bot by proxying the bot's
own `GET /admin/config` fields when reachable (falling back to the current honest
connection-descriptor when not) — this is what makes the existing `/systems/bot` ConfigField
save flow light up with `editable:true` fields.

### 2.5 platform-ui: Connect WhatsApp surface (extend `/systems/bot`)

Port the aire WahaConnect UX onto the existing design system:

- NEW `src/components/systems/WhatsAppConnect.tsx` (client): status pill (status + engine +
  paired number when WORKING), buttons **Connect / Show QR** (POST start, then poll),
  **Restart**, **Stop**, **Logout** (confirm dialog: "This unpairs the WhatsApp number; you
  will need to re-scan"). QR `<img>` from the data URL. Poll status+qr every 3s **only**
  while the panel is open and status ∈ {STARTING, SCAN_QR_CODE}; stop on WORKING (show
  success) or FAILED (show error + Restart hint). Show `lastEvent` (reconnect/ban/logout
  trail).
- Mutations = server actions in `systems/bot/actions.ts`; the poll read = a route handler
  `src/app/api/admin/bot/session/route.ts` (GET, `no-store`) that server-side
  `platformFetch`es nest — the session cookie/RBAC path is unchanged, nothing bot-related is
  callable anonymously.
- NEW `src/components/systems/GroupRegistry.tsx` (client): monitored-groups table
  (name/category/optIn/remove), "discovered" list with one-click add, management-group radio,
  single Save → PUT groups. Server action `updateBotGroups`.
- `updateBotConfig` action: remove nothing — the 404 fallback copy stays as a degrade path;
  backend now answers.
- StatusCard: render `detail.session` as a badge.

### 2.6 Compose changes (Workstream A)

`infra/compose/docker-compose.vps.yml` `bot` service:

```yaml
    environment:
      GROUPS_FILE: /app/data/groups.yaml          # writable registry (bot-data volume)
      GROUPS_SEED_FILE: /app/config/groups.seed.yaml
    volumes:
      - bot-data:/app/data
      - ./groups.yaml:/app/config/groups.seed.yaml:ro   # was :/app/config/groups.yaml:ro
```

`.env.example`: no new secrets (reuses `ADMIN_TOKEN`/`BOT_ADMIN_TOKEN` already threaded to
both sides). Note in the file: the registry now lives in the volume; `groups.yaml` is only
the first-boot seed.

---

## 3. Workstream B — agent runtime e2e

### 3.1 Data model (NEW tables in `gaiada_knowledge`, created by the runner's owner-DSN
`init()` exactly like `PgEpisodicStore` — **no platform migration, no new DB roles**)

```sql
CREATE TABLE IF NOT EXISTS agent_goals (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  goal                 text NOT NULL,
  agent                text NOT NULL DEFAULT 'supervisor',      -- 'supervisor' | specialist name
  envelope_provider    text NOT NULL,                           -- OBO envelope (e.g. 'platform')
  envelope_external_id text NOT NULL,
  requested_by         text,                                    -- platform userId (audit)
  status               text NOT NULL DEFAULT 'queued',
    -- queued|running|ok|suspended|budget_exhausted|failed|interrupted|cancelled
  outcome              text,                                    -- final answer / error message
  error_kind           text,                                    -- TraceStatus + planner kinds
  approval_id          text,                                    -- WS4 approval id when suspended
  model_calls          int NOT NULL DEFAULT 0,
  tool_calls           int NOT NULL DEFAULT 0,
  budget               jsonb,                                   -- caps at submit {modelCalls,toolCalls}
  fan_out              int NOT NULL DEFAULT 0,                  -- blackboard length
  blackboard           jsonb,                                   -- BlackboardEntry[] (supervisor goals)
  created_at           timestamptz NOT NULL DEFAULT now(),
  started_at           timestamptz,
  ended_at             timestamptz
);
CREATE INDEX IF NOT EXISTS idx_agent_goals_tenant ON agent_goals (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_runs (          -- direct-specialist goals: full traced run
  run_id       text PRIMARY KEY,                 -- = AgentTrace.runId
  goal_id      uuid NOT NULL REFERENCES agent_goals(id) ON DELETE CASCADE,
  tenant_id    uuid NOT NULL,                    -- denormalized tenant pre-filter (D9.1 style)
  agent        text NOT NULL,
  status       text NOT NULL,                    -- TraceStatus
  outcome      text,
  steps        jsonb NOT NULL DEFAULT '[]',      -- AgentStep[] transcript
  model_calls  int NOT NULL DEFAULT 0,
  tool_calls   int NOT NULL DEFAULT 0,
  tools_called text[] NOT NULL DEFAULT '{}',
  provider     text,
  started_at   bigint NOT NULL DEFAULT 0,
  ended_at     bigint NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_goal   ON agent_runs (goal_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_tenant ON agent_runs (tenant_id, created_at DESC);
```

Supervisor goals persist the **blackboard** on the goal row (the orchestrator does not expose
per-specialist step transcripts — per-sub-run tracing is a v2 item, see §6). Direct
specialist goals get one `agent_runs` row via `traceRun`. Every finished goal/run is ALSO
recorded to the EXISTING `PgEpisodicStore` (same DB/pool) and `ObservabilityCollector` — that
is the "wire the existing episodic/obs" requirement, not a rebuild.

### 3.2 Runner service (NEW `ai-agents/src/runner/{service,store,queue}.ts`)

Fastify, mirroring `knowledge/service.ts` conventions exactly (telemetry import first,
`fastifyLoggerOption`, `safeEqual` bearer auth fail-closed on empty token, `buildRunnerApp(deps)`
factory for tests). Port **3006** (`RUNNER_PORT`). Auth token: `AGENT_RUNNER_TOKEN`.

Env: `GATEWAY_URL/GATEWAY_TOKEN`, `HUB_URL/HUB_SERVICE_TOKEN` (consumed via the existing
`liveDeps`), `AGENTS_DATABASE_URL` (runtime `knowledge_app`), `MIGRATE_DATABASE_URL`
(`knowledge_owner`), `AGENT_MAX_CONCURRENT_GOALS` (default 1), `AGENT_MAX_QUEUE` (default 10),
`AGENT_SERVING_PROVIDER` (optional override; else `deps.lastProvider()` drives the D13 gate).

| Method | Path | Auth | Behavior |
|---|---|---|---|
| GET | `/health` | open | `{ok, agents: string[], writeAgents: string[], queue:{running,queued}}` |
| POST | `/goals` | token | Body `{tenantId: uuid, goal: string(1..4000), agent?: string, envelope:{provider,externalId}, requestedBy?}`. `agent` must be `supervisor` or a registered (write)specialist → else 400. Queue full → 429. Insert `queued` row, enqueue → `202 {id, status:"queued"}` |
| GET | `/goals?tenant=<uuid>&limit=50` | token | Tenant-filtered list, newest first (no blackboard/steps) |
| GET | `/goals/:id?tenant=<uuid>` | token | Goal + blackboard + run summaries. **`tenant` required and must match → else 404** (no cross-tenant id probing) |
| GET | `/runs/:id?tenant=<uuid>` | token | Full run incl. `steps` transcript; same tenant rule |
| POST | `/goals/:id/cancel?tenant=<uuid>` | token | `queued`→`cancelled`; anything else 409 (in-flight cancel is Temporal-land) |
| GET | `/metrics/agents` | token | `collector.summary()` + `collector.alerts()` (in-memory since boot) |

Execution semantics (ALL existing gates preserved — the runner adds persistence around the
proven runners, it never reimplements them):

- `agent === 'supervisor'` → `runOrchestrator(supervisor, goal, envelope, liveDeps, {tenantId})`
  — approval suspension arrives as `GoalSuspendedError` (approval already durably filed via
  `runWriteAgent` → hub `approvals.request` → WS4 inbox) → status `suspended` + `approval_id`.
- `agent ∈ writeSpecialists` → `runWriteAgent(def, goal, envelope, liveDeps, tenantId, servingProvider)`
  → `completed` / `suspended` (+filed) / `forced_read_only` (status `ok`, note appended to outcome).
- `agent ∈ specialists` → `traceRun(randomUUID(), def, goal, envelope, liveDeps)` → `agent_runs` row.
- Typed-error mapping: `GoalBudgetExhaustedError|BudgetExhaustedError` → `budget_exhausted`;
  `ApprovalRequiredError|GoalSuspendedError` → `suspended`; `UnknownSpecialistError|
  PlannerProtocolError|ModelProtocolError|ToolNotAllowedError` → `failed` + `error_kind`;
  anything else → `failed`/`unknown_error`. Outcome always carries the message; blackboard is
  persisted from the error object when present (typed errors carry it).
- In-process FIFO queue, `AGENT_MAX_CONCURRENT_GOALS` workers, loop `unref()`d.
- **Boot recovery sweep**: `UPDATE agent_goals SET status='interrupted' WHERE status IN
  ('queued','running')` — deterministic; no surprise autonomous re-runs after a restart; a
  human re-triggers from the ERP.
- `evaledProviders` stays `[]` on `task-triager` — **nothing in this workstream flips write
  capability on**; the D13 forced-read-only path is expected and surfaced honestly in the UI.

### 3.3 platform-nest: real intelligence proxy (`admin/intelligence.controller.ts` + `config.ts`)

`config.services.agents = { url: AGENTS_URL, token: AGENT_RUNNER_TOKEN }` (new env). The
`probeStatus("agents")` hardcoded "CLI/library" note is replaced by a real `/health` probe.

| Method | Path | Gate | Behavior |
|---|---|---|---|
| GET | `/api/:t/agents/goals` | `authorize(activity read)` (unchanged) | Runner `GET /goals?tenant=:t` → reshape to the UI `AgentGoal` (`budgetSpent = model_calls + tool_calls`, `budgetTotal` from `budget` caps, `fanOut = fan_out`) + additive fields `{agent, createdAt, endedAt, errorKind, approvalId}`. Degrade `[]` when unconfigured/unreachable (existing convention) |
| POST | `/api/:t/agents/goals` | **`isElevated`** | Body `{goal, agent?}`. (1) **Platform self-link upsert** (see §5.2); (2) runner `POST /goals` with `envelope = {provider:'platform', externalId: req.principal.userId}`, `requestedBy = userId`, `tenantId = :t` → `202 {id}` passthrough. 503 when runner unconfigured |
| GET | `/api/:t/agents/goals/:goalId` | `authorize(activity read)` | Runner detail (tenant-pinned) |
| GET | `/api/:t/agents/runs/:runId` | **`isElevated`** | Runner run incl. transcript (tenant-pinned). Elevated-only because a transcript can contain tool output fetched under the *triggering* user's authority |

### 3.4 platform-ui: `/agents` live (extend existing page + new detail routes)

- `lib/admin.ts`: extend `AgentGoal` (additive), add `getAgentGoal`, `getAgentRun`; NEW
  server action `triggerAgentGoal` + poll route handler `src/app/api/admin/agents/goals/route.ts`
  (GET, `no-store`, tenant from active company) for the running-goal refresh.
- `/agents` page: trigger card (goal textarea + agent select populated from the status
  probe's `agents` list; visible only to elevated users via the existing rbac helpers), goals
  table now linking to detail; status card consumes the real `/health` probe.
- NEW `/agents/goals/[goalId]` page: status/budget/fan-out header, blackboard entries
  (specialist/task/status/summary), run summaries linking to transcripts, `approval_id`
  deep-link to the WS4 approvals inbox when suspended.
- NEW `/agents/runs/[runId]` (or an expandable panel on the goal page — implementer's
  choice): step list rendered as **text chips** (`model`/`tool` kind + detail). Never render
  step content as HTML/markdown; never pretty-print raw tool JSON as executable UI (aire
  injection lesson — transcripts are untrusted model output).
- Poll every 4s while a goal is `queued|running`, stop otherwise.

### 3.5 Gateway reliability (aire lessons — its own contained ticket)

`ai-gateway-go` only; keep the HTTP contract byte-identical:

1. **Timeouts**: NEW `PROVIDER_TIMEOUT_MS` (default 60000). In every capability handler,
   replace `p.Complete(context.Background(), …)` with a ctx derived from `r.Context()` +
   `context.WithTimeout` — a hung provider becomes a clean failover + client disconnect
   cancels upstream work. (Applies to Complete/Media/Embed paths; verify `/complete/stream`
   separately — it must keep its own flush loop.)
2. **429 taxonomy**: providers return a typed `providers.RateLimitError{RetryAfter}` on HTTP
   429 (parse `Retry-After` seconds, cap at e.g. 5m). `chain.Run` on a rate-limit error opens
   that provider's breaker for `min(RetryAfter, cap)` **immediately** (instead of counting
   toward `consecutiveFails`) and fails over — one 429 stops hammering for exactly the
   advertised window, and doesn't poison the "dying provider" signal.
3. **Error taxonomy in the audit + 502 body**: attempted-provider errors already join into
   the 502; tag each as `timeout|rate_limit|provider_error` so the egress audit + ERP console
   can distinguish. `Blocked: "rate_limit"` when *all* providers were rate-limited.
4. Per-tenant call cap: **already EXISTS** (`budget.perTenantCap` via `x-tenant-id`) — no work;
   the runner SHOULD send `x-tenant-id: <tenant>` on `/complete` calls (1-line in `deps.ts`,
   folded into the runner ticket) so agent load is tenant-attributed.

### 3.6 Compose changes (Workstream B)

```yaml
  agent-runner:
    build:
      context: ../../ai-agents
    command: ["npx", "tsx", "src/runner/service.ts"]
    restart: unless-stopped
    environment:
      AGENT_RUNNER_TOKEN: ${AGENT_RUNNER_TOKEN:?}
      AGENTS_DATABASE_URL: postgres://knowledge_app:${KNOWLEDGE_APP_PASSWORD:?}@postgres:5432/gaiada_knowledge
      MIGRATE_DATABASE_URL: postgres://knowledge_owner:${KNOWLEDGE_OWNER_PASSWORD:?}@postgres:5432/gaiada_knowledge
      GATEWAY_URL: http://ai-gateway:3002
      GATEWAY_TOKEN: ${GATEWAY_TOKEN:?}
      HUB_URL: http://mcp-hub:3003
      HUB_SERVICE_TOKEN: ${HUB_SERVICE_TOKEN:?}
    depends_on:
      postgres: { condition: service_healthy }
      ai-gateway: { condition: service_started }
      mcp-hub: { condition: service_started }
```

`platform` service adds: `AGENTS_URL: http://agent-runner:3006`,
`AGENT_RUNNER_TOKEN: ${AGENT_RUNNER_TOKEN:-}`. `.env.example` adds `AGENT_RUNNER_TOKEN`.
(Reusing the knowledge DB roles is deliberate: `gaiada_knowledge` is the WS8-owned store and
`init-cluster.sh` already default-grants new owner-created tables to `knowledge_app`.)

---

## 4. Security / authz notes

- **Elevated gate everywhere new**: every `api/admin/bot/*` route and the agent trigger +
  transcript reads are `isElevated` (global `platform_admin`/`group_executive`) — the same
  bar as the existing consoles. Goal *listing* stays tenant-`authorize`d like today.
- **QR is a pairing secret** (scanning it = owning the WhatsApp identity). It is served only
  through the elevated nest proxy, `Cache-Control: no-store` end-to-end, held in client state
  only (no persistence), and **never logged** (bot/nest/UI must not log the data URL).
- **Bot admin surface stays token-gated + fail-closed** (503 without `ADMIN_TOKEN`), is not
  exposed on any published port (internal compose network only), and never accepts a session
  name or file path from the caller.
- **OBO for UI-triggered agents (§5.2)**: envelope `provider='platform'`,
  `externalId = req.principal.userId` — **both values fixed server-side from the
  authenticated session, never from the request body**. The self-link row a user mints always
  points at themselves; hub/knowledge/Cerbos/RLS/D11-revocation behavior is unchanged because
  it is an ordinary verified `identity_links` row.
- **Agent writes stay gated**: D13 `evaledProviders=[]` (forced read-only) + D14 approvals →
  WS4 inbox are untouched. This program adds *observability and triggering*, not authority.
- **Injection posture** (aire): goals are free text from elevated humans; tool results and
  model output land in prompts exactly as today (allow-list + impact taxonomy is the
  containment). The UI renders transcripts as inert text; no raw protocol JSON is ever shown
  or executed. The bot's reply path is untouched by workstream A (admin plane only).
- **PII**: no message content flows through any new surface. Session status strings, group
  ids/names, goal text, and agent transcripts only. Group names/ids are business metadata,
  not subject PII; transcripts are elevated-only.

## 5. Two decisions locked here

### 5.1 Group registry stays a YAML file (moved to the data volume) — not a DB table
The hot-reload registry, engine-fallback and trial semantics all live on the file today and
are well-tested; the bot's Postgres is the *PII* store (crypto-shred domain) and adding
config tables there buys nothing. Atomic write + mtime hot-reload keeps every existing
consumer unchanged. Tradeoff: last-write-wins between concurrent admin editors (acceptable;
single-operator reality) and the file is per-instance (fine: one bot instance by design).

### 5.2 Platform OBO = a real `identity_links` self-link, not a resolver special-case
Verified: `/principal/resolve` only reads `identity_links`. Options: (a) special-case
`provider='platform'` in the resolver → new code path in the security-critical resolver;
(b) **chosen**: the nest trigger endpoint idempotently upserts
`identity_links(provider='platform', external_id=<userId>, user_id=<userId>, verified_at=now())`
with `ON CONFLICT (provider, external_id) DO NOTHING` before calling the runner. Zero new
resolver code; D11 revocation, assurance ceilings, hub audit and knowledge D9 pre-filters all
work unchanged. The row is not user-forgeable (both sides pinned to the session principal).

## 6. Deferred from v1 (explicitly out of scope)

- Multi-session / warm-standby number management from the ERP (single configured session).
- In-flight goal cancellation, resume of suspended goals, durable queue → **Temporal** target
  state (the approval row is the durable resume artifact, as designed in WS8).
- Per-sub-run step transcripts under the supervisor (needs a run-recorder injected through
  `budgetedDeps`; blackboard summaries are the v1 truth).
- Auto-resume of approved agent writes; `evaledProviders` enrollment automation (runbook only).
- Management-group WhatsApp alert on session drop (v1 = log + ERP visibility).
- SSE/streaming run progress in the UI (poll v1); Redis-backed runner queue / horizontal scale.
- Editing env-backed bot config beyond `{postToGroups, managementGroupId}` from the ERP.

## 7. Risks

| Risk | Mitigation |
|---|---|
| WAHA path drift on the pinned NOWEB image (session create/logout variants) | A1 verifies against the image's Swagger; response contract is ours, paths adjust in one module (`waha-admin.ts`) |
| Registry move (ro bind → volume) loses edits on first deploy | Seed-copy boot logic + one-line log; groups.yaml stays the seed |
| Runner restart orphans goals | Boot sweep → `interrupted` (deterministic, human re-triggers; no auto re-run) |
| Transcript leakage across tenants/roles | Tenant pin on every runner read + elevated-only transcript in nest/UI |
| QR mishandling | no-store, never logged, elevated-only, client-state only |
| Gateway stream path regression while adding timeouts | `/complete/stream` handled separately in the ticket; contract-parity tests must stay green |
| `session.status` payload shape differs by engine | Tolerant normalizer (both shapes), passthrough strings, ring buffer keeps raw status |

## 8. Dependency-ordered build sequence

Wave 1 (parallel-safe): **A1** bot session module, **A2** bot groups/config write,
**B1** runner service+store, **B5** gateway reliability.
Wave 2 (contracts frozen by this doc; stub-tested): **A4** nest bot proxy, **B3** nest
intelligence proxy, **A3** compose (bot), **B2** compose (runner).
Wave 3: **A5** UI connect surface, **A6** UI groups panel, **B4** UI agents pages.
Wave 4: **A7** WhatsApp e2e (stops at the human QR scan), **B7** agents e2e, **D1** docs
(contract doc, runbook, MODULES/CHANGELOG bumps).

Respect the army concurrency cap (1–2 agents); waves express *allowed* parallelism, not a
requirement to parallelize.
