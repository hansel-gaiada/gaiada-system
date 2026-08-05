# Agent re-run-from-the-top idempotency audit (2026-08-05)

**Question audited:** the owner decided a suspended agent goal is resumed by **re-running it from the
top**. `ai-agents/src/write-agent.ts` suspends the WHOLE goal, so every LOW-impact write already
committed at steps 1..N-1 is re-executed. Which of those writes duplicate their side effects?

**Method:** code-only. Every verdict below traces the hub tool → its `platformSend` target → the
platform-nest handler's actual SQL, and where a unique index is claimed as the backstop, to the
migration that creates it (checking column nullability). No verdict rests on a comment or doc prose.

---

## 1. Scope — how the reachable set was determined

### 1.1 Two different scoping mechanisms (they are NOT the same gate)

| | n8n workflow principal | agent principal |
|---|---|---|
| Identity | `{provider:"n8n", externalId:"wf:<name>"}` | `{provider, externalId}` from `POST /goals` body (`runner/service.ts:307-308`, `deps.ts:48-49`) |
| Tool scope | static per-workflow allow-list `AUTOMATION_ALLOWLIST` (`mcp-hub/src/automation-policy.ts:14-82`) | the agent's own `AgentDef.tools` map (`ai-agents/src/agent.ts:15-16`) |
| D14 impact gate | **hub-side**, `mcp-hub/src/policy.ts:46-52` — only reached when `isAutomation(provider)` is true (`policy.ts:40`) | **agent-side only**, `agent.ts:152` (`impact === "high_write"` → throw) |

**Finding S-1 (structural, not an idempotency issue but load-bearing here):** the hub's D14 write gate
is inside `if (isAutomation(principal.provider))` (`policy.ts:40-53`). `isAutomation` returns true only
for `provider === "n8n"` (`automation-policy.ts:85-87`). An agent principal therefore passes **no
hub-side impact gate at all** — its only impact classification is the hand-maintained `impact` value in
its own `AgentDef.tools` map. If an agent's map labels a tool `low_write` while the hub registry labels
the same tool `medium`/`high`, the agent executes it unattended. (Today no such mislabel exists; the
only write-capable agent's one write tool is `low` on both sides.)

**Finding S-2:** `mintPrincipal` returns `assurance:"low"` for every OBO envelope
(`mcp-hub/src/principal.ts:19-25`), and the hub is the only minter (`server.ts:171-172`). Every
`minAssurance:"verified"` tool is therefore **unreachable by both** an agent and an n8n workflow —
this excludes `rollup.metrics` (`tools.ts:114`), `pm.runTracker`
(`platform-nest/src/modules/pm/index.ts:31`), `hr.fileLeave` (`modules/hr/index.ts:69`) and the entire
`search.*` write surface (`modules/search/index.ts:238-490`) from this audit.

### 1.2 The agent-reachable write set TODAY

Write-capable agents are enumerated in `ai-agents/src/specialists.ts:63-65` — exactly one:
`taskTriager` (`specialists.ts:40-58`), whose only write is `tasks.update` (`specialists.ts:46`).
`statusReporter` and `approvalsChaser` are read-only (`specialists.ts:11-13`, `:22-26`).

Plus **one write the agent framework calls outside any allow-list**: `approvals.request`, invoked
directly via `deps.callTool` in `write-agent.ts:53-66` on every suspension. It is not in any
`AgentDef.tools` map and is therefore not subject to the allow-list check at `agent.ts:147`.

So the **agent-reachable low-impact write set is `{tasks.update, approvals.request}`**. That set is
small today only because `writeSpecialists` has one member; the same runner (`runner/service.ts:246-258`,
`orchestrator.ts:173-182`) will execute any future `AgentDef` verbatim, so the whole low-impact write
surface is audited below as the forward-looking blast radius.

### 1.3 There is no resume machinery — re-run really is a fresh goal

`processGoal` claims a goal and, on a miss, does nothing: *"cancelled between enqueue and claim, or
already gone — do nothing (no auto re-run)"* (`runner/service.ts:207`). A "resume" is a new
`POST /goals` → new goal row → new `runId` (`runner/service.ts:313-321`, `:234`/`:252`/`:262`). Nothing
in that path reads the prior goal's committed writes, and nothing reads the decided
`automation_approvals` row.

---

## 2. Verdict table

Reachability: **A** = agent-reachable today · **A\*** = reachable by any future `AgentDef` (registry
tier is `low`, so nothing but the agent's own map stops it) · **N** = n8n workflow, with the workflow
ids from `automation-policy.ts`.

| Tool | Reachable by | Verdict | Evidence (file:line) |
|---|---|---|---|
| `tasks.update` | **A** (`specialists.ts:46`), N (`wf:task-sla`, `automation-policy.ts:27`) | **IDEMPOTENT** (row + notification) | `platform-write-tools.ts:236-259` → `core.controller.ts` `updateTask`: `UPDATE tasks SET title=COALESCE($2,title), status=COALESCE($3,status)…` — absolute-value set, no append (`core.controller.ts:211-215`, i.e. `sed 192,228`). Notification is **transition-guarded**: `if (b.assigneeId && b.assigneeId !== prev.rows[0].assignee_id)` (`core.controller.ts:219`) so a re-run re-sends nothing. **Caveat:** `writeActivity` is unconditional (`core.controller.ts:221`) — see §3. |
| `approvals.request` | **A** (`write-agent.ts:53`), N (`wf:new-client-seed`, `wf:task-sla`, `wf:delivery`) | **DUPLICATING** — and it is on the re-run's critical path | `platform-write-tools.ts:288-302` → `core/automation-approvals.controller.ts:39-47`: `id = newId()` + bare `INSERT INTO automation_approvals …`, no dedupe key, no existence probe. Also re-notifies + re-mails, `:55-65`. |
| `notify` | A\*, N (10 workflows incl. `wf:org-updated-notify`, `wf:wd-digests`, all `wf:reports-*`) | **DUPLICATING** | `platform-write-tools.ts:226-232` → `core/collab.controller.ts:188-200` → `core/http.ts:84-114`: `notificationId = newId()` + bare `INSERT INTO notifications …`. No idempotency key anywhere in the signature. |
| `projects.create` | A\*, N (`wf:new-client-seed`) | **DUPLICATING** | `platform-write-tools.ts:73-74` → `core.controller.ts:123-135` (`sed 107,138`): `id = newId()`; bare `INSERT INTO projects …`, no name/uniqueness probe. `deriveUniqueShortCode` deliberately mints a *new* colliding-suffixed code rather than resolving to the existing project (`core.controller.ts:129-130`). |
| `tasks.create` | A\*, N (`wf:new-client-seed`, `wf:inbound-lead-intake`) | **DUPLICATING** | `platform-write-tools.ts:88-89` → `core.controller.ts:162-172` (`sed 150,174`): `id = newId()`; bare `INSERT INTO tasks …`. |
| `clients.create` | A\*, N (—) | **DUPLICATING** | `platform-write-tools.ts:103-104` → `modules/clients/clients.controller.ts:47`: bare `INSERT INTO clients (id, tenant_id, name, contact, …)`, no `ON CONFLICT`. |
| `clients.update` | A\*, N (—) | **IDEMPOTENT** (row) | `platform-write-tools.ts:118-119` → `modules/clients/clients.controller.ts:57+` — `@Patch` with COALESCE-style absolute set. `writeActivity` still appends (§3). |
| `deliverables.create` | A\*, N (—) | **DUPLICATING** | `platform-write-tools.ts:133-139` → `core/client-work.controller.ts:42-60`: bare `INSERT INTO deliverables (id, …)` (`:55`), no dedupe. |
| `deliverables.update` | A\*, N (—) | **IDEMPOTENT** (row) | `core/client-work.controller.ts:64-80`: `UPDATE deliverables SET name=COALESCE($2,name), status=COALESCE($3,status), due_date=COALESCE($4,due_date)` (`:73`). `writeActivity` appends (§3). |
| `time.log` | A\*, N (—) | **DUPLICATING** | `platform-write-tools.ts:181-187` → `core/client-work.controller.ts:100-117`: bare `INSERT INTO time_entries (id, …)` (`:112`). Nothing keys on `(user, project, entry_date)` — a re-run double-bills. |
| `time.update` | A\*, N (—) | **IDEMPOTENT** (row) | `core/client-work.controller.ts:121-136`: `UPDATE time_entries SET minutes=COALESCE($2,minutes), billable=COALESCE($3,billable), notes=COALESCE($4,notes)` (`:131`). |
| `pipeline.createRun` | A\*, N (`wf:mtg-dispatcher`) | **CONDITIONALLY IDEMPOTENT** — dedupes only when `sourceMeetingId` is supplied | `pipeline-tools.ts:193-229` (schema `required:["tenantId"]` only — `:224`) → `core/pipeline.controller.ts:166-174`: dedupe is inside `if (sourceMeetingId)` and returns `{deduped:true}`; with the key omitted it falls through to `INSERT INTO pipeline_runs` (`:202-206`). DB backstop is likewise partial: `0017_pipeline.sql:30` — `WHERE source_meeting_id IS NOT NULL AND deleted_at IS NULL`. |
| `pipeline.createStage` | A\*, N (`wf:delivery`) | **IDEMPOTENT** for the 6 single-shot names; **CONDITIONAL** for `claude_design`; **DUPLICATING** for any other name | `pipeline-tools.ts:232-255` → `pipeline.controller.ts:360-371`: `lockPipelineRun` then `existingStageForRepeatedCreate` (`:93-123`) → single-shot names dedupe on existence (`:99-106`); `claude_design` is admitted only when the head design carries a decided `customer_feedback: changes_requested` (`:107-122`); **`return null` for any unrecognised name (`:123`) = no dedupe**. Schema backstop verified real, not NULL-defeated: `0052_pipeline_stage_idempotency.sql:139-141` is `UNIQUE(run_id, track, name)` and all three columns are `NOT NULL` (`0017_pipeline.sql:35-37`). |
| `pipeline.openGate` | A\*, N (`wf:delivery`, `wf:scope`) | **IDEMPOTENT while the gate is still PENDING** (row **and** notification); **DUPLICATING once the gate has been DECIDED** | `pipeline-tools.ts:302-326` → `pipeline.controller.ts:484-491`: dup probe uses `stage_id IS NOT DISTINCT FROM $2` (correctly NULL-safe for run-level gates) **and `status = 'pending'`**. On a hit it returns before the INSERT, before `emitEvent`, before `writeActivity`, and before `notifyBestEffort` (`:491`, `:510`). But a *decided* gate does not suppress a new one — which is exactly the re-run-after-a-human-decided case. |
| `pipeline.updateStage` | A\*, N (`wf:mtg-dispatcher`, `wf:delivery`, `wf:report`) | **row IDEMPOTENT / event DUPLICATING** | `pipeline-tools.ts:279-300` → `pipeline.controller.ts:429-441`: `UPDATE … SET status=COALESCE($2,status), artifact_ref=COALESCE($3,artifact_ref)` is an absolute set, but `emitEvent(… "pipeline.stage.updated")` (`:438`) fires unconditionally even when the UPDATE changed nothing. |
| `pipeline.updateRun` | A\*, N (`wf:delivery`) | **row IDEMPOTENT / event DUPLICATING** | `pipeline.controller.ts:254-263`: `UPDATE pipeline_runs SET status=COALESCE($2,status)…` then unconditional `emitEvent(… "pipeline.run.updated")` (`:263`). |
| `pm.createDoc` | A\*, N (`wf:report`) | **DUPLICATING** | `pm-tools.ts:59-62` → `modules/pm/pm.controller.ts:1855-1880`: `id = newId()`, bare `INSERT INTO pm_docs …` (`:1866`), plus `appendDocVersion(… 1 …)` (`:1870`) and an unconditional `emitEvent` (`:1877`). |
| `pm.createTask` | A\*, N (`wf:report`) | **DUPLICATING** (row + assignment notification) | `pm-tools.ts:83-93` → `modules/pm/pm.controller.ts:793-873`: bare `INSERT INTO pm_tasks …` (`:850`), a fresh `allocateTaskSeq` (`:848`), unconditional `emitEvent` (`:864`), and an unconditional `notify(… "assignment")` when `assignee.responsibleId` is set (`:866-870`) — no transition guard, unlike `core.controller.ts`'s `updateTask`. |
| `workActivity.relink` | A\*, N (`wf:wd-digests`) | **IDEMPOTENT** | `work-activity-tools.ts:97-114` → `core/work-activity-ingest.service.ts:173-197`: the driving SELECT is `WHERE NOT EXISTS (SELECT 1 FROM work_activity_links l WHERE l.activity_id = wa.id)` (`:179`) — an already-linked row is structurally unreachable, so a second pass over the same data is a no-op. |
| `agent.feedback` | A\*, N (—) | **DUPLICATING** | `platform-tools.ts:243-270` → `ai-agents/src/knowledge/service.ts:169-176` → `memory/episodic-pg.ts:108-113`: bare `INSERT INTO agent_episode_feedback (run_id, rating, …)`, no unique key on `run_id`. A re-run inflates the trainer signal. |
| `checkin.submit` | A\* (registry tier `low`, `modules/reports/index.ts:203`), N (—) | **IDEMPOTENT** | `modules/reports/checkins.controller.ts:570-578`: `INSERT … ON CONFLICT (tenant_id, user_id, checkin_date) DO UPDATE SET …`. Conflict target verified non-nullable — `0056_module_reports_core.sql:114-116` (`tenant_id uuid NOT NULL`, `user_id uuid NOT NULL`, `checkin_date date NOT NULL`), so the `ON CONFLICT` is not NULL-disabled. |
| `deploy.staging` | A\*, N (`wf:delivery`) | **DUPLICATING — EXTERNAL, UNDOABLE** | `mcp-hub/src/delivery-tools.ts:105-134`: unconditional `fetch(config.deployStagingUrl, {method:"POST", …})`, no dedupe key, no prior-dispatch check, no idempotency header. Declared `impact:"low"` (`:110`) — i.e. it runs **unattended**. |
| `deploy.production` | — (blocked) | n/a — `impact:"high"` (`delivery-tools.ts:142`) suspends for n8n (`policy.ts:46-52`); for an agent it would need `high_write` in its map, which throws at `agent.ts:152` | |
| `github.createRepo` | — (blocked) | n/a — `impact:"medium"` (`delivery-tools.ts:97`) and the handler hard-throws (`:100`) | |
| `design.prototype`, `code.scaffold`, `llm.summarize`, `llm.extract`, `media.transcribe` | A\*, N | **not writes** (no `write:true`) but each **spends** a Gateway/provider call per re-run | `delivery-tools.ts:22-41`, `:43-64`; `tools.ts:28-41`; `pipeline-tools.ts:149`; `tools.ts:87-92` |

---

## 3. Notification / outbox emission — flagged separately

A correctly-deduped row is still a defect if the announcement re-fires.

| Emitter | Behaviour on re-run | Evidence |
|---|---|---|
| `writeActivity` | **Always duplicates.** Bare `INSERT INTO activities (id …)` with a fresh `newId()`, called after every successful write path in `core.controller.ts`, `client-work.controller.ts`, `pipeline.controller.ts`, `pm.controller.ts`, `automation-approvals.controller.ts`. So even the row-idempotent tools (`tasks.update`, `time.update`, `clients.update`, `deliverables.update`, `pipeline.updateStage`, `checkin.submit`) leave a duplicated audit trail. | `core/http.ts:27-42` |
| `emitEvent` (outbox) | **Always duplicates.** Bare `INSERT INTO outbox_events (id …)`, no dedupe, no natural key. This is the WS4 event bridge's source, so a re-emitted `pipeline.stage.updated` / `pipeline.run.updated` / `pm.task.created` **re-triggers the n8n workflows subscribed to it** — a re-run of an agent goal can therefore fan out into automation runs that were never re-requested, and (per TR-05/TR-31) into duplicate `work_activity` evidence rows that feed the WD-26 digests. | `events/outbox.service.ts:16-24`; call sites `pipeline.controller.ts:222,263,438,497`; `pm.controller.ts:864,1877` |
| `notify` | **Always duplicates**, and it is the sole mail trigger. Bare `INSERT INTO notifications` (`http.ts:110-114`) then `mailIntake` (`:119`). | `core/http.ts:76-124` |
| `mailIntake` → **outbound email** | Duplicates for exactly two notification types: `MAIL_NOTIFICATION_TYPES = {"approval.requested", "pipeline.gate.opened"}` (`mail/intake.ts:21`, gated at `:80`). **Both are on the re-run path** — `approvals.request` emits `approval.requested` (`automation-approvals.controller.ts:56`) and `openGate` emits `pipeline.gate.opened` (`pipeline.controller.ts:515`). So a re-run from the top **re-emails the human decider set**. | `mail/intake.ts:21,78-80`; `core/http.ts:118-123` |
| Transition-guarded (the good pattern) | `core.controller.ts:219` (assignment notify only on a real assignee change) and `pipeline.controller.ts:491,510` (a suppressed duplicate gate returns before `emitEvent`, `writeActivity` **and** `notifyBestEffort`). This is the WD-29 shape to copy. | |

---

## 4. External-effect tools (cannot be undone)

Only one external-effect tool is reachable **unattended**:

- **`deploy.staging`** — `impact:"low"` (`delivery-tools.ts:110`), so it passes the D14 gate for both
  principal kinds, and its handler is an unconditional POST to the WS10 release webhook
  (`delivery-tools.ts:123-131`) with no dedupe key and no check for a prior dispatch of the same
  `(repo, ref)`. A re-run from the top re-deploys staging. **This is the single highest-risk item in
  the audit**: the effect leaves the database entirely, so no server-side precondition re-check inside
  platform-nest can retract it after the fact.

Adjacent external effects, for completeness:

- **Outbound email** via the `notify`/`mailIntake` chain (§3) — leaves the estate, cannot be recalled.
- **`github.repoStatus`** is read-only (`delivery-tools.ts:66-91`); **`github.createRepo`** and
  **`deploy.production`** are both blocked (medium/high impact, and `createRepo` hard-throws).
- **AI-provider spend**: `design.prototype`, `code.scaffold`, `llm.summarize`, `llm.extract`,
  `media.transcribe` each consume a Gateway call per re-run against the shared, rate-limited provider.
  Not a data defect, but a real cost of re-running from the top.
- No WhatsApp or ads write tool is reachable: the `search.*` money-path tools are `verified`-only
  (unreachable per Finding S-2) and were deliberately removed from the n8n allow-list
  (`automation-policy.ts:46-52`).

---

## 5. The actionable lists

### DUPLICATING (11 tools + 3 emitters)

Unconditional-INSERT / unconditional-dispatch, in descending re-run risk:

1. **`deploy.staging`** — external, unrecoverable, `impact:"low"` so it runs unattended.
2. **`approvals.request`** — files a second pending approval **and re-emails the deciders** on every
   re-run; on the critical path of *every* suspended goal (`write-agent.ts:53`).
3. **`notify`** — duplicate bell row; duplicate email for the two allowlisted types.
4. **`pm.createTask`** — duplicate task + duplicate assignment notification (unguarded, unlike
   `core.controller.ts`'s `updateTask`).
5. **`pm.createDoc`** — duplicate doc + duplicate v1 version row.
6. **`time.log`** — duplicate time entry → double-billed hours.
7. **`tasks.create`**, **`projects.create`**, **`clients.create`**, **`deliverables.create`** — duplicate
   business entities.
8. **`agent.feedback`** — inflated trainer signal.
9. Emitters: **`writeActivity`**, **`emitEvent`** (re-triggers n8n + duplicates `work_activity`),
   **`mailIntake`**-backed email.

### Conditionally unsafe (idempotent only on a path the caller controls)

- **`pipeline.createRun`** — dedupe requires `sourceMeetingId`, which the tool schema does not require.
- **`pipeline.createStage`** — dedupe covers the 6 single-shot names + the `claude_design` precondition;
  **any other stage name has no guard at all** (`pipeline.controller.ts:123`).
- **`pipeline.openGate`** — dedupes only among `status='pending'`. A re-run after a human decided the
  gate opens a fresh gate and re-notifies/re-emails.
- **`pipeline.updateStage` / `pipeline.updateRun`** — row-safe, event-unsafe.

### UNCLEAR

Nothing in the reachable set is undetermined at the row level. Two items are deliberately scoped out
rather than left ambiguous, and one is a dynamic-surface caveat:

1. **Downstream of `emitEvent`.** I established that the outbox row is duplicated
   (`events/outbox.service.ts:16-24`) and that the WS4 bridge is its consumer, but I did **not** trace
   whether any individual n8n workflow triggered by a re-delivered `pipeline.stage.updated` /
   `pm.task.created` is itself idempotent. To close this I would need `automation/*.json` (the workflow
   definitions) and the bridge's delivery/dedupe code — the file that maps `outbox_events` →
   webhook POSTs.
2. **Module tools registered at runtime.** `mcp-hub/src/module-tools.ts:100-144` registers tools from
   `GET /mcp/tool-defs` (`platform-nest/src/modules/mcp-tools.controller.ts:14-17`) at boot and
   re-fetches every `HUB_MODULE_TOOLS_REFRESH_MS`. I audited the *compiled-in* union
   (`modules/*/index.ts`), which is the whole of it today; a module added later can introduce a new
   `minAssurance:"low"` + `impact:"low"` write without any change to the files audited here. There is
   no code that asserts a low-impact write is idempotent, so nothing would catch it.
3. **`clients.update` / `clients.create` handler bodies** were read at outline granularity
   (`modules/clients/clients.controller.ts:36-60`); the INSERT/UPDATE shapes are confirmed but I did
   not read every branch of the PATCH. If a precise verdict on `clients.update`'s side-effects
   (activity/notify) is needed, that is the file and range.

---

## 6. What must be fixed before re-run-from-the-top can be enabled

**Blocker 0 — re-run-from-the-top cannot currently get past the suspension point at all.**
`agent.ts:152` throws `ApprovalRequiredError` on `impact === "high_write"` unconditionally. It has no
notion of an approved `automation_approvals` row, and neither does `runWriteAgent`
(`write-agent.ts:98-107`) nor `processGoal` (`runner/service.ts:246-258`). A re-run replays steps 1..N-1
(committing duplicates), reaches step N, throws again, and files **another** approval + **another**
email. Until the runner can consult a decided approval for `(agent, tool, args)` and pass through once,
re-run-from-the-top is a duplicate-generator with no forward progress. This is the D14 no-resume gap
expressed in the re-run design.

**Blocker 1 — `deploy.staging` must not be re-dispatchable.** It is external and `low`, so it needs
either a dedupe key checked platform-side before dispatch, or re-tiering to `medium` so it suspends.
No server-side precondition re-check can undo it after the fact; this one has to be prevented, not
reconciled.

**Blocker 2 — `approvals.request` must dedupe on the suspension identity.** A pending/decided row for
the same `(tenant_id, workflow_id, tool_name, tool_args)` must resolve to the existing row and return
`{deduped:true}` (the shape `createRun`/`createStage`/`openGate` already use) **before**
`writeActivity` and **before** `notifyBestEffort` — the WD-29 ordering at
`pipeline.controller.ts:491,510`. Note the trap: a `UNIQUE` index on those columns would be silently
disabled wherever a column is NULL (`reason` and `agent_name` are nullable at
`automation-approvals.controller.ts:45`), so the guard must be an explicit server-side probe under a
lock, not a bare unique index.

**Blocker 3 — the five `*.create` writes and `time.log` need a caller-supplied idempotency key.**
`tasks.create`, `projects.create`, `clients.create`, `deliverables.create`, `pm.createTask`,
`pm.createDoc`, `time.log` all mint `newId()` server-side with no natural key. The re-run has no way to
say "this is the same step 3 as last time". WD-29's lesson applies directly and must be applied in full:
**a lock alone is provably insufficient** (it left 6 duplicate rows) — the fix is *lock + server-side
re-evaluation of the caller's own precondition*, because each racer/replayer acts on a snapshot decided
before the call. For a replay the precondition is "has this goal-step already committed?", which means
the goal/run id has to reach the platform as part of the write, not just the OBO envelope.

**Blocker 4 — announcement suppression must be separated from row suppression.** `writeActivity` and
`emitEvent` fire unconditionally at every call site, including the row-idempotent ones. `emitEvent` is
the worse of the two: a duplicated outbox row re-triggers subscribed n8n workflows, so an agent re-run
can fan out into automation the human never re-requested. Every idempotent path must return **before**
both, exactly as `openGate` does.

**Blocker 5 — close the classification asymmetry (Finding S-1).** Because the hub's D14 gate skips
non-n8n principals, an agent's impact labels are unchecked against the registry's. Before more
write-capable agents exist, `runWriteAgent` (or the hub) should reject any agent whose declared impact
for a tool is weaker than the hub registry's — otherwise the re-run blast radius grows silently.

**Safe to re-run today, verified:** `tasks.update`, `clients.update`, `deliverables.update`,
`time.update`, `checkin.submit`, `workActivity.relink`, `pipeline.updateStage`/`updateRun` (rows only),
`pipeline.createStage` (single-shot names), `pipeline.openGate` (pending gates) — every one of them
still leaving a duplicated `activities`/`outbox_events` row.
