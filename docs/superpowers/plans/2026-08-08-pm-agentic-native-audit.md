# PM subsystem — agentic-native readiness audit (P4-J6)

Status: **COMPLETE** (audit; no code changed). Author: architect seat, 2026-08-08.
Subject: the PM subsystem (`platform-nest/src/modules/pm/`, `mcp-hub/src/pm-tools.ts`, the WA bot
PM skill, the ai-agents wiring) measured against the 7-criterion bar in
`docs/superpowers/plans/2026-08-03-agentic-native-erp-plan.md` (OPEN; must close before staging).

PM is the most complete department, so this audit is also the **template** for auditing the rest.
Every claim below carries a file:line citation so the next person can verify without re-deriving.
Line numbers are as of 2026-08-08; the tree moves fast — verify against the cited anchor text, not
the number alone.

---

## 0. Corrections to the received state of the world

Verified against code before auditing. Three items in the commonly-repeated summary are wrong or
imprecise:

1. **"Eight MCP tools" is an undercount.** `mcp-hub/src/pm-tools.ts` registers **ten**: the two
   WD-06 writes (`pm.createDoc` :107, `pm.createTask` :130), four P4-J1 reads (`pm.listTasks` :163,
   `pm.getTask` :222, `pm.listProjects` :235, `pm.taskAssignmentHistory` :248), four P4-J2 writes
   (`pm.setStatus` :297, `pm.setDueDate` :323, `pm.passBall` :345, `pm.comment` :388). All six
   writes are `impact: "low"`; reads carry no impact tier.
2. **"Allowlisted to wf:report only" (the createDoc/createTask descriptions) binds only n8n.**
   The allowlist check runs solely for automation principals (`mcp-hub/src/policy.ts:17-19`;
   `isAutomation` = `provider === "n8n"`, `automation-policy.ts:85-87`). Any human-OBO or agent
   principal at sufficient assurance can call every pm.* tool. The description text misleads
   non-automation callers into self-censoring; the enforcement reality is broader than it says.
3. **The controller's chain-enforcement header cites "migration 0088"** (`pm.controller.ts:315`);
   the actual migration is `0089_pm_dependency_enforcement.sql` (0088 is webdev change requests).
   Cosmetic, but this document exists so citations can be trusted — fix it.

Also verified as claimed: append-only ledger `pm_task_assignment_events` (migration 0087, trigger
enforcement :99-110, composite tenant FK :89-91, FORCE RLS :114-122); server-enforced chains
answering 409 with the blocker named (`enforceStartGate`, `pm.controller.ts:392-414`); one urgency
definition (`urgencyCondition` :111-125 + `parseDueSoonDays` :88-97, pinned against
`platform-ui/lib/pmUrgency.ts`); flag-driven per-project status registry (`effectiveStatuses`
:290-293, `readyStatus` :269-278 — never literal-id matching); tenant-grain faceted list + flow +
burndown (routes :1654, :3109, :3088).

---

## 1. The measured surface

### 1.1 REST (the human/UI driver)

~48 PM endpoints in `platform-nest/src/modules/pm/pm.controller.ts` (route decorators from :1472
to :3581): project get/patch/duplicate, task CRUD + the wide PATCH (subtasks, dependencies,
contributors, tags, custom fields, recurrence, status/progress coupling — :1998-2416), delete
:2418, followers :2460-2503, duplicate :2504/:2567, per-task time :2732-2750 (reuses
`time_entries` via `pm_task_id`), tag registry :2751-2853, status registry :2854-2989,
burndown/flow per-project and tenant-grain :2990-3152, productivity :1916, milestones :3153-3206,
docs + versions + restore :3207-3364, AI-tracker suggestions :3365-3510, templates :3512-3592.
Comments ride the generic `POST/GET /api/:t/comments` (`core/collab.controller.ts:99`, :20).

### 1.2 MCP tools (the automation and agent drivers)

The ten pm.* tools (§0.1) plus adjacent namespaces that LOOK like PM but are not:
`tasks.list`/`tasks.get`/`tasks.create`/`tasks.update` and `projects.*` front the **core `tasks`
table from 0001**, not `pm_tasks` (`platform-tools.ts:51-76`, `platform-write-tools.ts:78-89`,
:236-259); `time.log` fronts core `/time-entries` (`platform-write-tools.ts:163-188`). Two task
universes exist, and the tool names do not say which one they touch.

### 1.3 The three drivers, as actually wired

| Driver | Path | PM surface it can reach |
|---|---|---|
| **Human (UI)** | platform-ui BFF → REST | Everything in §1.1 |
| **n8n** | OBO `wf:*` → hub → REST | `pm.createDoc` + `pm.createTask` for `wf:report` ONLY (`automation-policy.ts:45`); **no workflow is scoped to any J1 read or J2 write** (deny-by-default, `policy.ts:47-49`) |
| **Human via WA bot** | bot OBO envelope → hub → REST | All ten pm.* tools; `wa-chat-bot/src/pm.ts` implements mine/show/history/status/due/pass/comment intents (:35-43) — **no create intent** |
| **Agent (ai-agents runner)** | the requesting human's OWN envelope (`cli.ts:10`, `runner/service.ts:247`) → hub | Whatever the AgentDef allow-list names — today **no production AgentDef carries any J2 write**; task-filer has `pm.createTask`/`pm.createDoc` labeled `high_write` agent-side (suspends; `impact-reconciliation.test.ts:112-115`) |
| **Agent (direct MCP client, e.g. Hermes)** | its own agent-user envelope → hub | All ten pm.* tools, gated ONLY by its user's Cerbos roles — **no impact gate anywhere on this path** (see §Q5) |

Platform-side floor for all hub paths: OBO resolves only a **verified** identity link
(`auth/guards.ts:87-94`; unverified → anonymous), and every PM Cerbos rule requires
`notLow` = assurance ≠ low (`cerbos/policies/_variables.yaml:9`,
`resource_pm_task.yaml:16,21`) — so an unverified chat identity gets nothing. This part is solid.

---

## 2. Verdict per criterion

| # | Criterion | Verdict | One-line basis |
|---|---|---|---|
| 1 | Tool parity | **FAIL** | ~10 of ~48 capabilities tool-reachable; write-without-read asymmetries; alias map shadows the two real PM reads for every ai-agents persona |
| 2 | Deterministic contract | **PARTIAL** | Requests/responses structured; refusals are prose-only, no codes; the 409's structured `blockedBy` is deliberately dropped despite the filter supporting additive fields |
| 3 | Idempotent writes | **PARTIAL** | The four J2 writes are genuinely retry-safe (incl. ledger no-churn); all three creates duplicate on retry; no idempotency-key mechanism exists |
| 4 | Impact-classified | **PARTIAL** | Every PM write is classified — but all `low`, so nothing ever suspends; and the gate binds only `provider === "n8n"`, so direct MCP agents are structurally ungated |
| 5 | Explicit refusal | **PASS (leaning partial)** | No PM reader folds a denial into `[]`; denials carry reasons end-to-end; but "invalid status" gives no discovery path and the hub read-front discards platform messages on non-403 |
| 6 | Observable | **PARTIAL** | Every write lands an activity + outbox event + work_activity row, system actors are explicit — but agent-vs-human is not reconstructable, `patchTask` activity metadata is `{}`, and ALLOW decisions are never audited |
| 7 | One golden case | **PARTIAL** | Real-endpoint platform suites exist (incl. adversarial tier matrix + the 409-names-blocker case); hub tool tests mock fetch; no end-to-end case drives a J2 write hub→platform; no eval case exercises setStatus/passBall |

The detailed answers to the six audit questions follow; the ranked fixes are §4 and the decision-16
recommendation is §5.

---

## Q1 — Parity of capability across the three drivers

**An agent can do roughly a fifth of what a human can, and one of its two read tools is silently
rerouted to the wrong table for ai-agents personas.**

Tool-reachable: list/get/history/projects (reads), create task + doc, set status (+`blockReason`),
set due date, pass ball (+note), comment (+mentions/threads).

NOT tool-reachable (UI/REST only), grouped by what an unattended agent would actually need:

- **Task field edits**: title, description, priority, estimate, startDate, progress, milestone
  assignment, tags-on-task, custom fields, recurrence — all live only in the wide PATCH
  (`pm.controller.ts:2065-2279`); the three J2 PATCH fronts expose status/dueDate/assignee only.
- **Structure**: dependencies add/remove (:2079-2085), subtasks (:2065-2076), contributors
  (:2097-2118) — the agentic plan's own PM goal names "dependencies … as tools" (plan :119-121);
  not met.
- **Write-without-read asymmetries** (worst-in-class for an agent): `pm.createDoc` exists but
  there is **no doc read tool** (docs GET :3251); `pm.comment` exists but there is **no comments
  read tool** (`collab.controller.ts:20`); an agent can write what it can never verify.
- **Discovery**: the per-project **status registry has no read tool** (GET :2854) — see Q2 for why
  this specifically causes retry loops.
- **Analytics**: burndown/flow/productivity (:2990-3152, :1916) — read-only, safe, high-value for
  a reporting persona; absent.
- **Manage-tier**: delete, duplicate, template CRUD, tag/status registry CRUD, project patch
  (incl. the `dependency_enforcement` override :1524) — absence here is **defensible as
  deliberate** (human-decision surfaces); record it as a waiver rather than a gap.

**Two-task-universes hazard.** `tasks.create`/`tasks.list` operate on core `tasks` (0001);
`pm.createTask`/`pm.listTasks` on `pm_tasks` (0018). Nothing in the tool names or descriptions
warns which board a row lands on. The task-filer agent files into `pm_tasks` via `pm.createTask`
but reads via `tasks.list` — a task it just filed is invisible to its own read.

**The alias-map regression (found by this audit).** After the 2026-08-07 live incident (a model
invented `pm.listTasks` before it existed), `ai-agents/src/tool-aliases.ts:66-83` maps
`pm.listTasks → tasks.list` and `pm.getTask → tasks.get`. **P4-J1 then shipped real
`pm.listTasks`/`pm.getTask` the same day.** Alias resolution runs before the allow-list lookup
(`agent.ts:373-376` — deliberately, as a security property), so every ai-agents persona — even one
explicitly granted the real PM reads — has those calls silently rewritten to the **core-tasks**
endpoints. The same tool name returns PM tasks for the WA bot and Hermes, and core tasks for an
ai-agents persona. Driver-dependent semantics is precisely what the bar's "one capability, three
modes" table forbids. Fix is G1 in §4.

Deliberate vs oversight: the J1/J2 scope was a deliberate ticket boundary (phase-4 plan §J);
the field-edit/dependency/milestone gaps are known-but-unticketed; the write-without-read
asymmetries and the alias shadowing are **oversights** — no recorded decision covers them.

---

## Q2 — Legibility of refusal

The full refusal taxonomy an agent actually receives, traced end-to-end:

| Refusal | Wire shape | Agent-actionable? |
|---|---|---|
| Cerbos deny | 403 `{error: "not authorized: <reason>"}` (`core/http.ts:20`) → surfaced verbatim by the write front (`pm-tools.ts:42-46`) and the read front (:87-90) | Yes — distinguishable from "not found", reason text names the gap |
| Chain block (P4-I1) | 409, blocker **names in the message string only** (`enforceStartGate` :410-413); structured `blockedBy` deliberately dropped because `HttpErrorFilter` flattens to `{error, field?, existing?}` (`http-error.filter.ts:38-42`) | Partially — the text is excellent ("cannot move to X: blocked by …") and reaches the caller verbatim, and `pm.setStatus`'s description teaches the stop-retrying rule (:300); but it is prose to parse, not a typed field |
| Not found / cross-tenant | 404 `{error: "task not found"}` (:1817, :2026, :2052) — indistinguishable by design (RLS posture, correct) | Yes for "stop", no for "why" — acceptable |
| Invalid status id | 400 `"invalid status"` (:2175) | **No.** The valid registry is not named, and there is no `statuses` read tool — an agent on a custom-registry project has no way to learn the valid ids except guessing. This is the one refusal that manufactures retry loops |
| Hub-level deny/suspend | Reason strings with a stable prefix convention (`denied:` / `suspend:` — `policy.ts:44,49,60`) | Yes, by convention |
| Rate limit | 429 `"rate limit exceeded — slow down"` (`server.ts:196-201`) | Yes |

Two structural defects:

1. **No error codes anywhere on the PM path.** The house shape is `{error}` prose. The estate
   already knows better in one place — `client-access-error.filter.ts:44` emits `{error, code}` —
   and `HttpErrorFilter` already forwards additive structured fields when a thrown exception sets
   them (`field`, and `existing` added for exactly this class of problem, filter :8-14). The
   comment at `pm.controller.ts:404-408` treats the filter as immutable; it is not — forwarding a
   `blockedBy` array is the same three-line change `existing` was.
2. **The J1 read front is less honest than the write front.** `platformSend` (writes) surfaces the
   platform's `{error}` for **every** non-2xx (`pm-tools.ts:42-46` — a P4-J2 fix, and the file
   says why); `platformGetPm` (reads) surfaces bodies only for 401/403 and degrades everything
   else to `platform <path> <status>` (:91) — a 404's "task not found" is discarded. Same file,
   two error disciplines.

Positive finding worth copying estate-wide: the structured blocker list IS available before any
write is attempted — `GET pm/tasks/:id` returns `blockedBy` computed live (:1806-1818) — and the
WA bot renders every denial verbatim as a non-negotiable (`wa-chat-bot/src/pm.ts:13-22`).

---

## Q3 — Idempotency and replay

**The four J2 writes are the good news; the three creates are the gap.**

Retry-safe (verified mechanism, not assumed):

- **`pm.setStatus`** — a replayed same-status PATCH is a no-op with respect to status
  (`enforceStartGate` rule 3 :400 never blocks it), fires no follower notifications
  (`statusChanged` false :2391), cannot double-spawn a recurrence: the not-done→done **edge** is
  computed under a `FOR UPDATE` row lock (:2047-2054), and an independent
  `(recurrence_spawned_from, due_date)` dedupe guards the same invariant (:2330-2334).
- **`pm.setDueDate`** — idempotent by value.
- **`pm.passBall`** — the realistic dropped-connection-mid-pass replay is genuinely safe: the hub
  handler re-reads current state before each attempt (:374-380), the blob write is idempotent by
  value, and the ledger append is **change-gated** — a no-op re-pass writes zero ledger rows
  (`syncTaskAssignees`, `pm.controller.ts:984-989`). Residual hazard is a **concurrent-bootstrap
  race**, not a replay: two simultaneous passes on an unassigned task both bootstrap
  Responsible=Ball (:2032-2038, hub :378-380) and the last writer silently wins — no version/
  If-Match mechanism exists on the PATCH. Low likelihood, ledger keeps both rows, acceptable.
- **`pm.comment` reactions** (adjacent) — PK-idempotent upsert (`collab.controller.ts:67-74`).

Duplicate on retry (at-least-once callers WILL hit these):

- **`pm.createTask`** — server-mints the id (`createPmTaskInTx`, `pm.controller.ts:1239`), no
  natural key, no client-suppliable id. Retry = second task + second assignment bell (:1989-1993).
- **`pm.createDoc`** — same class (:3223).
- **`pm.comment`** — `newId()` per call (`collab.controller.ts:105`); retry = duplicate comment +
  re-fanned mention notifications + a second mail-tap invocation (`core/http.ts:118-123`).

No `Idempotency-Key`/dedupe-key mechanism exists anywhere in platform-nest (grep verified). The
estate has already paid for this lesson once: the pipeline needed a dedupe branch
(`pipeline.runBySourceMeeting`, `automation-policy.ts:36-39`) precisely because a re-posted
webhook "minted a phantom run". Criterion 3's own failure signal — *"'create' that always
inserts"* — is met verbatim by all three PM creates.

Replay safety downstream is exemplary and should be stated as the pattern: work_activity ingest
dedupes on the outbox event id (`events/work-activity-consumer.ts:18-24, 60-66`), so
crash-and-redeliver never double-books activity.

---

## Q4 — Attribution

**Every PM write is attributed — to the wrong actor, whenever an agent is involved.**

The chain, verified end-to-end:

1. The ai-agents runner authenticates tool calls with the **requesting human's own envelope**
   (`cli.ts:10`, `agent.test.ts:16`, `runner/service.ts:247`) — there is no delegation; the
   agentic plan records this as the unresolved blocking decision (plan :202-209).
2. The hub audit (`audit.ts:21-29`) records ts / tool / principal(provider, externalId, assurance)
   / decision / ok — **args are deliberately not recorded** (:2), and neither are tenant or target
   entity. It can say "tg:555 called pm.setStatus at 14:32, allowed, ok" but never *which task*.
3. The platform resolves the envelope to a bare userId and **drops the channel**
   (`auth/guards.ts:80-94` → `assemblePrincipal(row.user_id, "linked")`); nothing downstream ever
   sees provider/externalId again.
4. So `activities.actor_id` (`core/http.ts:37-39`), `work_activity.actor_user_id` (TR-31,
   `work-activity-consumer.ts:26-35`), and `pm_task_assignment_events.changed_by` (0087) all
   record **the human**. A week later, "Alice moved T to Done" and "Alice's agent moved T to
   Done" are byte-identical in every platform table. The only artifact distinguishing them is the
   hub JSONL (channel ≠ UI), correlatable to a specific write **by timestamp only**.
5. The opposite pattern also exists live: a direct MCP client (Hermes) uses its **own agent user**
   (memory: four-table identity handshake), so its writes attribute to the agent and the human it
   served is unrecorded. Two live patterns, opposite blind spots; neither records the pair.
6. **Cerbos ALLOW decisions are never audited.** `auditDecision` has exactly one call site and it
   is deny-only (`core/http.ts:16-21`), despite its own docstring claiming "allow AND deny — RBAC
   spec §6" (`rbac/principal.ts:112`). Allowed writes leave no authz record to cross-check.
7. The "why" is captured only where a field exists for it: `assignmentNote` on passes (:2289),
   `blockReason` on external-wait blocks, the comment body itself. `setStatus`/`setDueDate`/the
   creates carry no reason, and `patchTask`'s direct activity row has **empty metadata**
   (`writeActivity(..., "updated", "pm_task", taskId, {})` :2403) — what changed lives only in the
   outbox event (:2299-2305).

What is genuinely good and should be the estate template: the 0087 ledger (immutable, statused,
noted, actor'd, trigger-enforced); system-derived actions deliberately null-actor with
`actorExternal` naming the engine (`pm:recurrence-engine` :2363, `pm:dependency-engine` :2315,
`auto_promoted` activity with `closedByUserId` in metadata :2409-2411); the rule-2 override
recorded as `completedWithOpenDependencies` + blocker ids on the event (:2304).

**Answer to the question as posed:** "which agent, on whose behalf, why" is **not reconstructable**
from the platform. The full fix is the deferred delegation decision (persona ∩ acting user, dual
Cerbos check, audit both) — correctly out of this audit's scope. The cheap interim is not: the
channel is in hand at `guards.ts:79` and `writeActivity`'s metadata is a free-form jsonb bag; carry
`via: {provider, externalId}` through the principal and stamp it on activity/ledger writes. Zero
migrations, closes the review-time blindness for both live patterns.

---

## Q5 — Decision 16 (`impact: "low"` for all PM writes), argued

**The facts first, because two of them change the shape of the argument:**

1. **The impact gate binds exactly one driver class.** Both encodings — in-code
   (`mcp-hub/src/policy.ts:47-63`) and Cerbos (`resource_mcp_tool.yaml:106-114`) — apply the
   `write && impact !== "low"` suspend only to `provider === "n8n"`. ai-agents personas are gated
   **agent-side** by their AgentDef labels reconciled stricter-wins against the registry
   (`agent.ts:45-99`, D14-12). A direct MCP agent (Hermes) is gated by **nothing** but Cerbos
   roles. So decision 16 is not "agents write unattended"; it is "the classification is enforced
   for n8n, advisory for ai-agents, and nonexistent for direct MCP clients."
2. **Nobody dangerous holds the J2 tools today.** No n8n workflow is scoped to them
   (`automation-policy.ts` map), no production AgentDef lists them (grep of
   `ai-agents/src/specialists.ts`), task-filer's PM creates are `high_write` agent-side and
   suspend (`impact-reconciliation.test.ts:112-115`). The live unattended-write surface is the WA
   bot (a human typing an explicit per-message command — human accountability holds) and any
   Hermes-class client an operator configures.
3. **Precedent cuts both ways.** Core `tasks.update` is already `impact: "low"` and can set
   `status: done` (`platform-write-tools.ts:236-259`), and n8n's `wf:task-sla` is scoped to it
   (`automation-policy.ts:27`) — an unattended done-move already exists on the core-tasks side.
   Consistency was decision 16's stated rationale (phase-4 plan :799-800).

**Per-tool verdict:**

- `pm.setDueDate`, `pm.passBall`, `pm.comment`, `pm.createDoc`, `pm.createTask` — **`low` is
  correct.** Scalar/append-only, value-reversible, ledgered or notification-bounded; the phase-4
  plan's own reasoning (:796-797, "cheap, attributable, corrected by appending") holds. The
  creates' problem is idempotency (Q3), not impact tier.
- `pm.setStatus` — **`low` is defensible today and wrong as a durable classification.** The
  implementation's stated justification (`pm-tools.ts:277-281, 304`) covers only the chain
  constraint: a blocked move 409s server-side, so an unattended write "can't silently violate
  P4-I1". True, and well-built. But the plan flagged the actual objection — *"'an agent moved my
  task to Done' is the write people will actually object to"* (:798) — and recommended "a
  deliberate call on setStatus" (:797), which the implementation resolved to `low` by
  consistency. The done-edge is not a scalar edit; it cascades:
  - spawns a real recurrence child (:2327-2366); **reopening the parent does not retract it**;
  - promotes every cleared dependent to ToDo + "now startable" notifications (:2312-2317, :503+);
    **no reverse path demotes them on reopen** (verified: none exists — the live
    `openDependencies` check re-blocks the next start *attempt* :2091/:2210, but the board
    placement and notifications stand);
  - books a "completed" work_activity fact into the appraisal/report substrate (TR-05 verb
    classification, `work-activity-consumer.ts:10-11`);
  - propagates progress toward client-visible surfaces (workstream K);
  - and rule 2 lets it close a task **despite open dependencies** unattended (:2211-2214 — audited
    on the event, but Q4 shows the audit can't say an agent did it).

**Recommendation (one, in two layers):**

- **R1 — now, before any persona is granted J2 writes:** reclassify **`pm.setStatus` → `medium`**,
  add its `approval-executables.ts` entry, and implement P4-J2b's precondition re-check exactly as
  the phase-4 plan specified (:594): at execution time re-run `enforceStartGate` against the
  current graph and re-validate the target status id against the project's current registry.
  Cost analysis: **zero behavior change for every current user.** Humans and the WA bot are
  non-automation principals — the gate never binds them (fact 1). No n8n workflow and no
  production agent holds the tool (fact 2), so nothing suspends today. What R1 buys is that the
  D14 protection is in place *before* the first `wf:*` scope or AgentDef grant, instead of being
  retrofitted after the first incident — the exact "build to the bar now" instruction on this
  audit's own ticket (phase-4 plan :598). Keep the other five at `low`. Review core
  `tasks.update` under the same done-edge lens when the cross-cutting "impact-classify every
  existing write" sweep runs (agentic plan :97-98); its blast radius is smaller (no chains, no
  recurrence, no dependent promotion) so `low` may survive there — but let the sweep decide, not
  inertia.
- **R2 — structural, belongs with the `users.kind` exit-bar item (agentic plan :89-91, :185):**
  the gate's predicate must become principal-**kind**-aware rather than provider-string-aware, so
  a direct MCP agent (Hermes-class, `users.kind = agent/bot`) is bound by the same D14 gate as
  n8n. Until R2 lands, decision 16 — at any tier — is unenforceable against the one driver class
  most likely to run unattended for a week. This is the deepest finding of the audit and it is
  not PM-specific; it belongs on the agentic plan's cross-cutting list.

---

## Q6 — What breaks first in an unattended week

Ranked by expected time-to-first-incident, each grounded in a mechanism already observed:

1. **Duplicate creates (day 1).** At-least-once retries against `pm.createTask`/`pm.comment` with
   no dedupe key (Q3). The pipeline already hit this exact class live and needed a dedupe branch
   (`automation-policy.ts:36-39`). Duplicates also fan out duplicate bells and mail taps.
2. **Wrong-universe reads (the first day a persona gets `pm.listTasks`).** The alias map rewrites
   it to core `tasks.list` before the allow-list ever sees it (Q1). The agent plans against a
   different task table than it writes to. Half of this already happened live on 2026-08-07.
3. **Status-discovery dead ends (day 1-2).** `"invalid status"` 400 with no registry read tool
   (Q2). On any project with a materialized custom registry, the bot's cosmetic aliases
   (`wa-chat-bot/src/pm.ts:49-63`) and an agent's ladder assumptions both fail with no recovery
   path — the agent burns its turn budget guessing.
4. **Notification and mail fan-out fatigue (week 1).** Every status flip notifies all followers
   (:2391-2402), every comment fans mentions, every notify row invokes the mail tap
   (`core/http.ts:118-123`). Nothing batches or rate-limits notifications (the hub's per-minute
   limit :196 caps tool calls, not downstream fan-out). An agent doing 50 legitimate board moves
   a day trains humans to ignore the bell — which then buries the notifications that matter.
5. **Attribution erosion (discovered at review time, cost booked all week).** Everything the agent
   did is recorded as the human (Q4); the weekly review cannot separate them, and appraisal-facing
   work_activity facts inherit the confusion.
6. **Un-retracted cascades from one wrong Done (probabilistic).** Phantom recurrence children +
   falsely-promoted dependents + stale "now startable" notifications (Q5). Self-healing only at
   the next write attempt on each dependent.
7. **Slow burn: diagnostic poverty.** `activities` rows with `{}` metadata (:2403), allow
   decisions unaudited, hub audit without args — when something does go wrong, reconstruction
   leans on the outbox stream and timestamps.

What will NOT break, and deserves credit: the ledger cannot be corrupted (trigger-enforced
append-only), chain integrity cannot be violated by any driver (server-side 409), a replayed
passBall cannot churn history (change-gated append), recurrence cannot double-spawn (lock + edge +
dedupe), revocation kills a compromised envelope mid-week (D11, `server.ts:210-215`), and the rate
limiter fails legibly.

---

## 4. Ranked gap list (fix in this order)

| # | Gap | Fix | Size | Cited at |
|---|---|---|---|---|
| **G1** | Alias map shadows the real `pm.listTasks`/`pm.getTask` for every ai-agents persona | Delete (or re-point to the pm.* tools) the two entries — the incident they papered over is fixed by the tools now existing; keep the refusal loop | trivial | `ai-agents/src/tool-aliases.ts:66-83`, `agent.ts:373-376` |
| **G2** | Creates duplicate on retry | Accept a client-suppliable uuid `id` (or dedupe key) on `pm.createTask`/`pm.createDoc`/`POST /comments`, `ON CONFLICT DO NOTHING` returning the existing id — the reactions PK-idempotency pattern | small | `pm.controller.ts:1239`, `collab.controller.ts:105`, precedent :67-74 |
| **G3** | Refusals are prose-only; invalid-status has no discovery path | Forward `blockedBy` on the 409 via the filter's additive-field mechanism (the `existing` precedent); add `code` to the house error shape; include valid status ids in the invalid-status 400; make `platformGetPm` surface `{error}` for all non-2xx like `platformSend` | small | `http-error.filter.ts:8-14,30-42`, `pm.controller.ts:404-413,2175`, `pm-tools.ts:87-93` |
| **G4** | Agent-vs-human attribution unreconstructable; allow decisions unaudited; `{}` activity metadata | Carry `via:{provider,externalId}` from `guards.ts` into the principal and stamp it into `writeActivity` metadata + ledger `note`-adjacent field; audit ALLOWs for writes (or stamp the decision id on the activity); put changed-field names in `patchTask`'s activity metadata | medium | `auth/guards.ts:79-94`, `core/http.ts:14-42`, `pm.controller.ts:2403` |
| **G5** | Decision 16 R1 | `pm.setStatus` → `medium` + executable entry + P4-J2b precondition re-check | small | §Q5 |
| **G6** | Impact gate is provider-string-scoped — direct MCP agents structurally ungated | Principal-kind-aware gate (needs `users.kind`); escalate to the agentic plan's cross-cutting list — **not PM-fixable locally** | large | `policy.ts:47`, `resource_mcp_tool.yaml:106-114`, agentic plan :89-91 |
| **G7** | Missing tools, by leverage | Add: `pm.listStatuses` (unblocks G3 discovery), `pm.getDoc` + `pm.listComments` (close the write-without-read asymmetries), `pm.updateTask` (title/description/priority/estimate/startDate — one general front, not five tools), `pm.addDependency`/`pm.removeDependency`, milestones read. Record registries/templates/delete/duplicate as **deliberate human-only waivers** | medium | §Q1 |
| **G8** | `viewer` can `update` pm_task (incl. setStatus-to-Done via an agent OBO a viewer) while excluded from mere commenting | Decide and pin: if viewers are read-only (every sibling policy + the test's own title say so), drop `viewer` from the update rule; also resolve the pinned dead-`team_lead` finding (either PM resources carry `teamId` or the role leaves the policy text and `pm.passBall`'s description) | small | `resource_pm_task.yaml:13-16` vs `resource_comment.yaml:16-19`; `pm-adversarial-authz.test.ts:294-318, 342-354, 402-412` |
| **G9** | No golden case crosses hub→platform for J2; no eval for the 409-recovery behavior | One live-stack case per J2 write through the hub; one eval asserting the agent stops retrying a chain-blocked status (the harness + suspend-path cases already exist) | small | `pm-tools.test.ts:11-24` (mocked), `ai-agents/src/evals/cases.ts:105-121` |
| **G10** | Doc/description drift | Fix `pm.controller.ts:315` (0088→0089); reword "allowlisted to wf:report only" on the two create tools (binds n8n only); remove `team_lead` from `pm.passBall`'s description pending G8 | trivial | §0 |

G1+G2+G3 are the unattended-week survival kit; G4+G5 are what makes the week reviewable; G6 is the
estate-level hole this audit surfaces for the plan's cross-cutting list.

## 5. Waivers to record (so the exit-bar table can be generated honestly)

Per the bar's waiver mechanism (agentic plan :180-182), these are **deliberate** and should be
recorded as such rather than re-audited as gaps every quarter:

1. n8n gets no J1/J2 PM scope — no workflow needs board moves; least-privilege allowlist stands.
2. Manage-tier surfaces (delete, duplicate, template/tag/status-registry CRUD, project patch incl.
   the dependency-enforcement override) stay UI-only — they are governance decisions, not work.
3. The 404 = cross-tenant = nonexistent collapse — correct RLS posture, keep.
4. `includeSubtasks` no-op on the list endpoint — documented forward-compat (:1680-1684), plan
   decision 11 still open.

---

## 6. What the next department audit should copy from PM

The bar's purpose is a template; these PM mechanisms are the reference implementations: the 0087
append-only ledger (trigger-enforced, composite tenant FK, change-gated writes), verbatim-error
plumbing on the write front (`platformSend`), flag-driven status semantics (never literal ids),
lock+edge+dedupe recurrence idempotency, `actorExternal` for system-derived events, the bot's two
non-negotiables (no client-side authz branches; render denials verbatim), D14-12 stricter-wins
reconciliation, the read-only-at-module-load alias guard, and an adversarial authz suite that pins
real findings instead of working around them (`pm-adversarial-authz.test.ts:342`).

## 7. Open questions for the owner

1. **Decision 16 amendment (R1):** accept `pm.setStatus` → `medium`? Zero current-user impact
   (§Q5); the alternative is accepting that the first persona granted the tool can move work to
   Done unattended, with the cascades in §Q5 and the attribution blindness in §Q4.
2. **G8:** are viewers read-only on PM tasks, yes or no? The policy currently says no (update
   allowed), every adjacent policy and the test's own vocabulary say yes.
3. **G7 scope:** is `pm.updateTask` (general field-edit front) wanted, or should field edits stay
   human-only until the delegation model lands? Either is defensible; it changes whether criterion
   1 can ever fully pass for PM.
