# WS11 — Meeting-to-Delivery Pipeline: end-to-end plan

**Date:** 2026-07-16
**Status:** PLAN / direction-setting. Nothing built yet. Intended to be executed across several
sessions, one component at a time.
**Owner conversation:** hansel@gaiada.com
**Backbone rule (inherited from WS4, non-negotiable):**
**n8n = orchestration · MCP hub = access · custom services = logic.** Every action an n8n workflow
takes is an mcp-hub `tools/call` carrying an OBO identity (`x-obo-provider: n8n`,
`x-obo-external-id: wf:<name>`). Workflows hold **no** business logic and touch **no** DB directly.
**Depends on:** WS2 mcp-hub, WS4 automation (event→n8n bridge + approvals suspension surface),
WS8 ai-agents (design/code specialists), WS3 gateway (`llm.*`), platform-nest (data), platform-ui (UX).

---

## 1. The idea, restated

A meeting is recorded; from it we auto-produce three artifacts and drive three independent tracks:

```
Meeting recording (device / meeting-bot)
  → transcribe → MOM (minutes)
  → 3 SEPARATE targeted LLM extractions:
        • PRD              • Report              • Scope Agreement
        │                  │                     │
   ┌────▼─────────┐   ┌────▼──────────┐   ┌──────▼───────────────┐
   │ DELIVERY     │   │ REPORT        │   │ SCOPE AGREEMENT      │
   │ track        │   │ track         │   │ track                │
   └──────────────┘   └───────────────┘   └──────────────────────┘
```

**Delivery track (HARD PRD gate first, then auto-advance between AI stages with human gates at Submissions):**
```
PRD extract → [PRD REVIEW gate: internal PM review] → [PRD SIGN gate: client signs PRD]
      ═══ HARD BLOCK: delivery build starts only when PRD signed AND Scope Agreement signed ═══
      (both signed) → Claude Design → Prototype → [SUBMISSION gate] →
      (approved) → PM creates GitHub repo → Claude Code → ready-to-staging → [SUBMISSION gate] →
      (approved) → deploy Staging → done
      (changes requested at any gate) → revise loop (bounded) back to the AI stage
```
**PRD and Scope are two separate client signatures** (PRD = *what* we build; Scope = commercial terms),
and **the delivery build is gated on BOTH being signed** (decided 2026-07-16). So the Scope track is not
fully independent — its sign-off is a joint precondition to Claude Design. Auto-advance applies only
after both signatures land.

**Report track:** format report → route to *internal process* (**not yet designed** — stub for now).

**Scope Agreement track:** draft scope doc → **dual sign-off (both parties)** → countersigned → store.

**The blockages** (human-in-the-loop hard stops):
1. **PRD sign-off** (internal PM review → client **signs** the PRD). Delivery build blocked until signed.
2. **Scope-agreement sign-off** (dual-party, commercial/legal) → durable platform surface (not raw n8n Wait).
   **Delivery build is blocked until BOTH #1 and #2 are signed** (a separate signature each).
3. **Feedback / review** at each **Submission** → n8n Wait + platform-owned state.

**Client portal (added 2026-07-16):** an external-facing portal where the client and we see live pipeline
status, perform their sign-offs + feedback, and are shown **the current blockage in plain language**
("Waiting on your signature", "In UI review", "Building"). Transparency + professionalism. This is where
all client-facing gates (PRD sign, scope sign, customer feedback) are surfaced — it resolves the earlier
open question about where customer feedback is captured.

---

## 2. Decisions locked with the user (2026-07-16)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Ingestion | **Meeting-bot integration** — bot records + POSTs transcript to a dispatcher webhook. **Bot not built yet; build after this.** So we define the webhook *contract* now and stub the bot. |
| 2 | Gate durability | **Hybrid** — n8n Wait for short feedback loops; durable platform surface (WS4 approvals-style) for the long scope sign-off. |
| 3 | AI autonomy | **Auto-advance** between AI stages — **but only after the client has signed the PRD.** The PRD extraction is followed by a mandatory internal PM review + a hard **client sign-off** before Claude Design fires (supersedes the earlier soft "confidence gate"). Added 2026-07-16. |
| 8 | Client portal | **Build a client-facing portal** (added 2026-07-16): live pipeline status + client sign-offs + feedback + plain-language "current blockage" reminders. Hosts all client-facing gates. |
| 9 | PRD vs Scope sign | **Two separate client signatures** — PRD (product spec) and Scope Agreement (commercial). Decided 2026-07-16. |
| 10 | Delivery build gate | **Blocked until BOTH PRD and Scope are signed** — Scope sign-off is a joint precondition to Claude Design, not just its own track. Decided 2026-07-16. |
| 11 | Portal auth | **Lightweight client accounts via an external Keycloak realm** (separate from staff realm). Decided 2026-07-16. |
| 4 | The split | **Three separate LLM passes** — one targeted extraction prompt per output. |
| 5 | "Submission" means | **PM review & approval → customer feedback → PM approval.** A 3-beat gate, reused at each Submission point (see §5). |
| 6 | Claude Code target | Pushes to a **new GitHub repo**; **PM must create the repo** in company GitHub first → this is a data dependency / manual pre-step before the Claude Code stage. |
| 7 | Where setup/data lives | **platform-ui (ADNARA ERP)** provides all setup + data entry + the review/approval inboxes; **platform-nest** persists pipeline state. n8n stays thin. |

---

## 3. Architecture — one dispatcher + three sub-workflows

Do **not** model this as one linear workflow. The three tracks run on different clocks
(delivery = hours–days with loops; report = seconds; scope = days–weeks external). Split them:

- **`wf:mtg-dispatcher`** — webhook entry (meeting-bot). Transcribe → MOM → 3 extraction passes →
  persist a `pipeline_run` → fire the three sub-workflows (n8n *Execute Workflow* / internal webhook).
- **`wf:delivery`** — the long PRD→staging chain with two Submission gates + revise loops.
- **`wf:report`** — format + route to internal process (stub).
- **`wf:scope`** — draft + dual sign-off + store.

**Cross-track dependency (decided 2026-07-16):** the delivery track's Claude Design stage is gated on
**both** the PRD sign (delivery-track gate) **and** the Scope sign (scope-track completion). So the
dispatcher must correlate the two tracks on the `run_id`: `wf:delivery` waits at the hard gate until
`pipeline.gate.decided(prd_sign=signed)` AND `scope.signed` (both parties) have both fired for the run.

**State ownership (critical):** n8n Wait nodes are **not** the source of truth. Every pipeline run and
every stage/gate lives in **platform-nest** as a `pipeline_run` + `pipeline_stage` row. n8n calls hub
tools to advance state; humans act in platform-ui; platform-nest calls back into n8n (resume webhook)
when a gate clears. This survives n8n restarts and multi-day waits — the failure mode of naive Wait-only
flows.

> **Target-state note:** the delivery track is genuinely durable + stateful + suspend-for-human — it is
> the **first real Temporal candidate** WS4 predicted. We deliberately build it in n8n now for
> adjustability (user requirement); the platform-nest state store is what makes a later Temporal swap
> cheap. Do not add Temporal speculatively.

---

## 4. Capability inventory — what must exist, and where it's built

This is the multi-session backlog. Grouped by component. n8n can only orchestrate things that exist as
**hub tools**, so most net-new work is hub tools + the services behind them + platform data/UI.

### A. mcp-hub — new tools (the n8n action surface)
Each carries an impact tier (WS4 §3): read/notify = auto; write = low auto-runs, medium+ suspends.
- `media.transcribe` — **exists** (AI-backed hub tool). Reuse.
- `llm.extract` (or three prompt-specialized tools `prd.extract`, `report.extract`, `scope.extract`) —
  targeted extraction with a **confidence score** in the result. New (thin wrappers over gateway `/complete`).
- `design.prototype` — kicks off the WS8 **design specialist** (async job), returns a job id. New.
- `code.scaffold` — kicks off the WS8 **code specialist** to push to a given repo URL (async job). New.
- `github.createRepo` — *or* keep repo creation manual (PM) and only add `github.repoStatus` (read).
  Decision in §Open. New.
- `deploy.staging` — trigger a staging deploy of a repo/ref (medium-impact write ⇒ suspends unless the
  Submission gate already approved it). New — wraps WS10 release pipeline.
- `pipeline.advance` / `pipeline.gate.open` / `pipeline.gate.decide` — read/write pipeline state in
  platform-nest. New (thin over platform-nest endpoints).
- `notify` — **exists.** Reuse for all human pings.

### B. platform-nest — data + endpoints
- **Migration:** `pipeline_runs`, `pipeline_stages`, `pipeline_gates`, `scope_signoffs` (see §6).
- **Endpoints** (mirrors the WS4 approvals surface shape):
  - `POST /api/:t/pipeline/runs` (dispatcher creates a run)
  - `PATCH /api/:t/pipeline/stages/:id` (advance/annotate)
  - `POST /api/:t/pipeline/gates` (open a Submission or sign-off gate → pending inbox)
  - `GET /api/:t/pipeline/gates` (elevated inbox; RBAC like automation-approvals)
  - `POST /api/:t/pipeline/gates/:id/decide` (approve / request-changes / sign)
  - On a terminal decision, **emit an event** (`pipeline.gate.decided`) → event→n8n bridge resumes the
    waiting workflow. This is the durable callback.
- **Events emitted:** `pipeline.run.created`, `pipeline.stage.updated`, `pipeline.gate.opened`,
  `pipeline.gate.decided`, `scope.signed`.

### C. ai-agents (WS8) — the two heavy specialists
- **Design specialist** — PRD → prototype artifact (design files / preview URL). Async; reports completion
  via a callback that flips a `pipeline_stage`.
- **Code specialist** — PRD + approved prototype → code pushed to the PM-created repo; opens a PR / marks
  ready-to-staging. Async + callback. Reuses WS8 approval-suspension bubbling for any risky write.

### D. platform-ui (ADNARA) — all human touchpoints + setup
- **Pipeline dashboard** — list of runs, each showing the 3 tracks + current stage (Kanban-ish; reuse the
  PM module patterns from `pm-ai-tracker-contract`).
- **Submission inbox** — PM review, customer-feedback capture, PM final approval (the 3-beat gate UI).
- **Scope sign-off page** — dual-party signature capture + status.
- **Setup screens** — meeting-bot webhook config, extraction confidence threshold, revise-loop max,
  report internal-process target, GitHub org/repo settings, staging target.
- **Report → internal process** config (stub until that process is designed).
- Reuse `lib/rbac.ts` capabilities + CompanyContext scope (`ui-rbac-and-company-scope`).

### E. n8n (automation/) — the four workflows in §3, thin.

### F. meeting-bot — **built later**, to the §8 webhook contract.

### G. Client portal (NEW, added 2026-07-16) — external-facing
A separate, hardened, **client-facing** surface (not the internal ADNARA ERP). Responsibilities:
- **Read:** per-project pipeline status across the three tracks; the current stage; and a prominent
  **"current blockage" banner in plain language** ("Waiting on your signature to proceed",
  "Our UI team is reviewing", "Building your prototype").
- **Act (client-facing gates):** sign the **PRD**, sign the **Scope Agreement**, submit **feedback** at
  Submission points. These write to the same `pipeline_gates` / `scope_signoffs` rows the internal inbox uses.
- **Scoping:** a client sees only their own tenant/project(s). **Auth = lightweight client accounts via an
  external Keycloak realm** (decided 2026-07-16), separate from the staff IdP realm — reusable logins,
  auditable. Least-privilege, read-mostly, no access to internal PM notes/AI internals.
- **Build:** likely a distinct Next.js app (or a locked-down `/portal` route tree) reading a **portal-scoped
  BFF** over the same platform-nest pipeline endpoints, filtered to client-safe fields. Signatures captured
  here emit `pipeline.gate.decided` / `scope.signed` → same durable resume path as internal decisions.

---

## 5. The reusable "Submission" gate (3-beat)

Every Submission point is the same sub-pattern, parameterized by which artifact/stage:

```
[open gate: PM review]  → PM approves? ──no──► request-changes → revise loop
          │ yes
[open gate: customer feedback] → capture feedback
          │
[open gate: PM approval] → PM signs off feedback addressed?
          │ yes → advance to next stage
          └ no  → revise loop (back to the AI stage that produced the artifact)
```

Implementation: each beat is a `pipeline_gate` row (kind = `pm_review` | `customer_feedback` |
`pm_approval`). n8n opens beat 1 (hub `pipeline.gate.open` → returns pending), then **waits** (n8n Wait
node registered to a resume URL); platform-nest emits `pipeline.gate.decided` on decision → bridge hits
the resume URL → n8n opens the next beat or loops. **Revise loop is bounded** (config, default 3); on
exhaustion → escalate via `notify` + park the run as `blocked`.

---

## 6. Data model (platform-nest migration sketch)

```
pipeline_runs(id, tenant_id, source_meeting_id, mom_ref, status, created_at)
   status: extracting | delivery_active | report_done | scope_pending | complete | blocked
pipeline_stages(id, run_id, track, name, status, artifact_ref, confidence, updated_at)
   track: delivery | report | scope ;  status: pending|running|awaiting_gate|done|failed
pipeline_gates(id, run_id, stage_id, kind, actor_side, status, opened_by, decided_by, decision, note, ...)
   kind: prd_review | prd_sign | pm_review | customer_feedback | pm_approval | scope_signoff
   actor_side: internal | client            -- drives which surface (ERP inbox vs client portal) shows it
   status: pending | decided ;  decision: approved | changes_requested | signed | rejected
scope_signoffs(id, run_id, party, signer, signed_at, signature_ref)   -- two rows, both required
```
All tenant-scoped under FORCE RLS, same as existing tables. Gate RBAC mirrors `automation-approvals`
(elevated humans read/decide; members denied).

---

## 7. Guardrails against auto-advance going wrong

The mandatory **PRD review + client sign-off** (added 2026-07-16) is now the real guardrail — no AI build
work happens on an unreviewed/unsigned PRD, so garbage-in cannot auto-build. The confidence score is kept
only as an *input to the internal PM review* (flag low-confidence extractions), not as an auto-advance gate.
Remaining safeguards:
1. **Hard PRD sign gate:** Claude Design cannot fire until `prd_sign` is `signed`. This is the primary
   protection against building the wrong thing.
2. **Staging is isolated + reversible** by construction (WS10 pipeline) — auto-deploy is acceptable
   *because* the PRD sign + both Submission gates all precede anything customer-facing.
3. **Repo pre-step is an explicit gate:** Claude Code cannot start until the PM-created repo exists
   (`github.repoStatus` read gates the stage) — a natural human checkpoint anyway.

---

## 8. Contracts to freeze now (so the bot + backend can be built to them)

### Meeting-bot → dispatcher webhook
```
POST /webhook/mtg/recording-complete        (n8n; bridge-secret header, like the event bridge)
headers: x-gaiada-bridge-secret: <N8N_BRIDGE_SECRET>
body: {
  v: 1,
  meetingId: string,          // stable id for dedupe (dispatcher dedupes like on-client-created-seed)
  tenantId: string,
  transcript?: string,        // if bot transcribes
  audioRef?: string,          // else a storage ref for media.transcribe
  participants: [...], title, startedAt   // startedAt is a string; scripts can't call Date.now()
}
```
Dispatcher **dedupes on `meetingId`** (bot delivery is at-least-once) — copy the static-data dedupe from
`on-client-created-seed.json`.

### Gate resume callback (platform-nest → n8n)
`pipeline.gate.decided` event → bridge → `POST /webhook/pipeline/resume/<gateId>` → the waiting workflow
continues. Same secret + dedupe discipline.

---

## 9. Build order across sessions (dependency-first)

Each numbered item is roughly one session; earlier blocks later.

1. **platform-nest data + endpoints + events** (§4B, §6). Foundation everything else calls. Ship with tests
   mirroring `automation-approvals.test.ts`. — **✅ BUILT + VERIFIED 2026-07-16.** Migration
   `0017_pipeline.sql` (pipeline_runs/stages/gates + scope_signoffs, all FORCE RLS); `PipelineController`
   (`src/core/pipeline.controller.ts`) with runs/stages/gates/scope-signoffs + events
   (`pipeline.run.created`, `pipeline.stage.updated`, `pipeline.gate.opened`, `pipeline.gate.decided`,
   `scope.signed`); 4 Cerbos policies (`resource_pipeline_{run,stage,gate}` + `resource_scope_signoff`);
   4 pipeline automation accounts seeded (`wf:mtg-dispatcher|delivery|scope|report`). 11 tests green
   against live PG+Cerbos+RLS; automation-approvals still green; typecheck clean.
2. **mcp-hub pipeline + extraction tools** (`pipeline.*`, `llm.extract`/`prd|report|scope.extract` with
   confidence). Thin over §1 + gateway. — **✅ BUILT + VERIFIED 2026-07-16.** `src/pipeline-tools.ts`:
   `llm.extract` (kind=prd|report|scope → `{kind,content,confidence}`, Gateway-wrapped, robust to
   non-JSON replies) + LOW-write `pipeline.createRun|updateStage|openGate` + reads
   `pipeline.getRun|listGates`, all thin OBO fronts over PipelineController. Wired in `server.ts`;
   `AUTOMATION_ALLOWLIST` scopes `wf:mtg-dispatcher|delivery|scope|report` to exactly their tools.
   **Deliberately NOT exposed:** gate-decide / scope-sign (human/UI actions — n8n only opens gates then
   waits for the decided event). 11 hub tests + full suite 70/70 green; typecheck clean.
3. **n8n `wf:mtg-dispatcher`** (transcribe → MOM → 3 passes → create run → fan out). Testable with a
   pasted transcript before the bot exists. — **✅ BUILT 2026-07-16** (`automation/workflows/mtg-dispatcher.json`,
   15 nodes): webhook (bridge-secret + `meetingId` dedupe) → `llm.summarize` (MOM) → 3 separate
   `llm.extract` passes → `pipeline.createRun` with all three stages populated (artifact+confidence) in
   one call (small enhancement: `createRun` now accepts per-stage `artifactRef`/`confidence`/`status`;
   platform test added, 12/12 green). Fan-out is **event-driven** via `pipeline.run.created` (not Execute
   Workflow). JSON structure-validated; tool chain verified (platform live, hub unit). **Live n8n import
   pending a stack rebuild** (running containers predate WS11 code) — curl test recipe in `automation/README.md`.
4. **Client portal + portal-scoped BFF** (§4G). — **✅ BACKEND BUILT + VERIFIED 2026-07-16.**
   Migration `0018_pipeline_portal.sql` (`pipeline_runs.client_id`, `clients.portal_user_id`);
   `PortalController` (`src/core/portal.controller.ts`): client-scoped `GET /portal/runs`,
   `/portal/runs/:id` (client-safe — hides report track + internal gates, plus a plain-language
   `currentBlockage`), `POST /portal/gates/:id/decide` (client signs their client-side gates),
   `POST /portal/runs/:id/scope-sign`. THREE isolation layers: RLS (tenant) + Cerbos (`client`
   derived role + `resource_portal`) + controller (run.client_id → clients.portal_user_id). 9 tests
   green (incl. client-A-vs-client-B isolation, non-client denial, no cross-gate decide). **REMAINING:
   the portal FRONTEND app + the external client Keycloak realm wiring** (the OIDC path already
   auto-provisions; needs the second realm's issuer accepted + a portal UI).
5. **n8n scope track.** — **✅ BUILT 2026-07-16** in `automation/workflows/pipeline-fanout.json`
   (merged with the report track — one workflow per unique webhook path; per-node OBO keeps least
   privilege). On `pipeline.run.created`: open the client `scope_signoff` gate (as `wf:scope`) + notify PM.
6. **platform-ui pipeline dashboard + internal gate inbox.** — **✅ BUILT (MVP) 2026-07-16.**
   `lib/pipeline.ts` + `lib/pipelineActions.ts` + `app/(app)/pipeline/page.tsx` (runs table + internal
   review inbox with approve/request-changes, gated on `approvals.decide`) + nav entry. Degrades
   gracefully; `tsc` clean. Per-run detail drill-down is a later enhancement.
7. **design + code specialists** (`design.prototype`, `code.scaffold`). — **✅ BUILT 2026-07-16** as
   synchronous Gateway-wrapped hub tools in `src/delivery-tools.ts` (v1 produces the prototype/impl
   artifacts; a running prototype + real git push are the target-state refinement — an async WS8
   specialist + github write). 7 hub tests.
8. **n8n `wf:delivery`** (hard gate + stages + Submission + revise loop). — **✅ BUILT (v1 spine) 2026-07-16**
   `automation/workflows/pipeline-delivery.json` (16 nodes, dual triggers gate.decided + scope.signed):
   loads run, computes readiness, and on **PRD signed AND scope signed** → `design.prototype` →
   `pipeline.createStage(claude_design)` → open the first Submission (`pm_review`) → notify PM.
   **REMAINING (documented in the workflow):** the full 3-beat Submission (pm_review→customer_feedback→
   pm_approval), the Claude Code stage gated on `github.repoStatus`, `deploy.staging` after the web-dev
   Submission, and the bounded revise loop — the durable looping state machine the plan flags as the
   **Temporal candidate**. All the hub tools it needs are already built + scoped to `wf:delivery`.
9. **`deploy.staging` + GitHub tools.** — **✅ BUILT 2026-07-16** `src/delivery-tools.ts`:
   `github.repoStatus` (gates the code stage), `github.createRepo` (fail-closed-not-enabled — PM
   creates repos manually), `deploy.staging` (LOW; fail-closed until `DEPLOY_STAGING_URL` set). Config
   added; 7 tests cover fail-closed + enabled paths.
10. **n8n report track.** — **✅ BUILT (STUB sink) 2026-07-16** in `pipeline-fanout.json` (as `wf:report`):
    routes the report via an in-app notify until the real internal process is designed (§10 open).
11. **meeting-bot.** — **✅ STUB BUILT 2026-07-16** (`meeting-bot/` — `submit.mjs` + README): a
    contract-faithful poster that drives the pipeline from a pasted transcript. The real recording-bot
    provider is a deferred decision (§10); everything downstream is unchanged when it lands.

**✅ RUN LIVE END-TO-END 2026-07-16** on the `gaiada` compose stack. Rebuilt `platform` + `mcp-hub`
images, wired the bridge env (`pipeline.run.created,pipeline.gate.decided,scope.signed` +
streams `pipeline_run,pipeline_gate,scope`), seeded the 4 wf automation accounts, and
imported+activated the 3 WS11 workflows into the standalone n8n (2.30.4). Proven chain:
dispatcher webhook → MOM + 3 extracts → `pipeline.createRun` (run + 3 stages) → `run.created` → bridge →
**fan-out opened the scope gate** → PRD sign + dual scope sign → `scope.signed` → bridge → **delivery
hard gate (both signed) → `design.prototype` → `claude_design` stage + `pm_review` Submission gate** →
the internal-inbox endpoint returns it. Gateway ran in echo mode (no key) so `llm.*` returned echo text
and `llm.extract` yielded `confidence:null` — the robust wrapper worked live.
**One real bug caught + fixed by the live run** (invisible to unit tests): n8n's expression sandbox
blocks any data field literally named `prototype` ("Cannot access prototype due to security concerns"),
so `pipeline-delivery.json` renamed that field to `prototypeDoc`. Ops notes: workflow JSON needs a
top-level `id` for CLI import; activate then RESTART n8n to register webhooks; hub is on `127.0.0.1:3003`.

### Follow-up 2026-07-17 — the remaining edges
- **Real AI (#1): WIRED + documented.** The gateway supports local Ollama (`OLLAMA_URL`/`OLLAMA_MODEL` in
  `infra/compose/.env`; egress already allows `host.docker.internal`), but local CPU models exceed the
  gateway's fetch timeout on this box (~2.5 min/call → `fetch failed`), so `OLLAMA_URL` is left empty
  (fast echo default). **Real fast output = drop `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` in
  `infra/compose/.env`** (provider chain `ollama,gemini,claude`) — no code change.
- **Delivery 3-beat Submission (#2): BUILT + LIVE-VERIFIED.** `pipeline-delivery.json` is now a stateless
  event-driven state machine (20 nodes): hard gate → `design.prototype` → `claude_design` stage →
  **`pm_review` (beat 1) → `customer_feedback` (beat 2) → `pm_approval` (beat 3) → `prototype_accepted`**.
  Gates are tied to the design stage via `stage_id`. Walked live: each approval opened the next beat; the
  final approval fired the accepted notification. **Remaining (the Temporal-candidate loop, tools ready):**
  the Claude Code phase (`github.repoStatus` → `code.scaffold` → `claude_code` → web-dev Submission →
  `deploy.staging`) + bounded revise loop.
- **Client portal frontend (#3): BUILT as a client-role-gated DASHBOARD in platform-ui** (user's call:
  separate dashboard, not a separate app). `lib/portal.ts` + `lib/portalActions.ts` +
  `app/(app)/portal/page.tsx` (per-project cards, plain-language blockage banner, PRD-sign / scope-sign /
  feedback actions) + `isClient()` in `rbac.ts` + a **portal-only nav** for client-only users (never the
  staff surface). `tsc` clean; nav+rbac tests 12/12. **BFF live-verified** with a real `client` principal
  against the running stack: `GET /portal/runs` → 200 with the client's run + "Waiting for your signature
  on the Scope Agreement". Prod still swaps client login to the external Keycloak realm (same dashboard).
  A dev preview client exists: `clientportal@acme.test` (linked to a client on the Beats-demo run).
- **Delivery code+deploy (#2): NOW BUILT + wired** (`pipeline-delivery.json`, 36 nodes, generated). Full
  chain: hard gate → design → 3-beat Submission → `release_code` (`github.repoStatus` gate → `code.scaffold`
  → `claude_code` stage → web-dev `pm_review`; else notify `repo_needed`) → web-dev approved → `deploy.staging`
  → `staging` stage + notify. `github.repoStatus`/`deploy.staging` **fail SOFT** (onError continue → a
  graceful notify, never a crash). **Live-verified**: `release_code` fired and returned `repo_needed` with an
  actionable reason (no GitHub token). Dev creds via `GITHUB_TOKEN`/`GITHUB_ORG`/`DEPLOY_STAGING_URL` in
  `infra/compose/.env` (placeholders added; drop a dev PAT to advance); prod swaps to a dedicated account.
  Bounded revise loop on `changes_requested` is the last remaining refinement.
- **Report internal-process sink (#4): still a documented STUB** — needs the business-process decision
  (PM ticket / Slack / email) before it's implemented; not invented.

**Ops finding:** the running `gaiada-cerbos-1` did NOT hot-reload policies added mid-session from its bind
mount — a `docker restart gaiada-cerbos-1` was needed for the new `client`/`portal` policies to take
effect. Restart Cerbos after adding/editing policy files on the live stack.

---

## 10. Open questions / to design later

- **Report → internal process:** undefined sink. Design before item 9. (Slack/Teams post? PM ticket per
  `pm-ai-tracker-contract`? email? ticket-per-report?)
- **GitHub repo creation:** manual by PM (only add `github.repoStatus` read) vs. automated
  `github.createRepo` behind a gate. Leaning manual first (matches user: "PM need to make the repo").
- **Meeting-bot choice:** self-hosted (Recall.ai-style, we control) vs. SaaS transcriber webhook. Deferred
  to when the bot is built.
- **Customer-facing feedback capture:** RESOLVED 2026-07-16 — captured in the **client portal** (§4G).
- **Client portal auth model:** RESOLVED 2026-07-16 — lightweight client accounts via an external
  Keycloak realm (separate from staff realm).
- **PRD vs. Scope sign-off:** RESOLVED 2026-07-16 — two distinct client signatures; delivery build gated
  on **both** signed. Scope sign-off (`scope_signoffs`, dual-party) is thus a joint precondition to the
  delivery track's Claude Design stage, not merely its own track.
- **Does `wf:delivery` need Temporal yet?** Not for v1; revisit if n8n Wait durability bites despite the
  platform-nest state store.
