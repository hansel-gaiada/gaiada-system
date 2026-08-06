# ASST-23 unblock — design ruling: the assistant's first proposable write

**Architect ruling, 2026-08-06.** Consumes: `2026-08-06-d14-17-report.md` (freshest analysis),
`2026-08-05-d14-and-assistant-tickets.md` § ASST-23, `docs/blueprints/assistant-foundation.md`
§6/§7, and the current code (every claim below was read from the checkout, cited by file).
Status vocabulary per `docs/modules/MODULES.md`: everything here is **PLANNED**.

---

## 0. Verdict in one paragraph

ASST-23 does **not** need a new hub tool, a re-tiered PM tool, or any mcp-hub change at all.
The proposal mechanism for the assistant is the **agent-side write gate**
(`ai-agents/src/agent.ts`), which fires on the AgentDef's **declared** impact — not on the hub
registry tier. Declare `pm.createTask` as `high_write` in a **new, assistant-only AgentDef** in
`writeSpecialists`, add `"pm.createTask"` to `RERUN_CAPABLE_HIGH_WRITES` (both documented
prerequisites already hold, citable by name), let the broker reach that agent, and the entire
D14 chain — file → decide → execute-as-requester → notify — already exists and is
already proven origin-agnostic for exactly this tool (d14-17 test C). Two real defects sit on
the path and must be fixed first: **(a)** a latent impact-vocabulary bug that 400s every
agent-origin filing (`fileApproval` sends `impact:"high_write"`; the platform accepts only
`medium|high|unclassified`), and **(b)** the FE has **no** tool/proposal rendering at all —
`tool_call`/`approval_required` frames are decoded to `null` by pinned test, and `GET thread`
returns no tool-call rows. Five tickets, three waves, no migration, no Cerbos change.

---

## 1. Corrections to the brief's established facts (challenge mandate)

### 1.1 Fact #5 is wrong about WHICH gate decides — and that inverts the conclusion

The claim: *"a `low` tool produces NO proposal card. The D14 gate suspends on impact tier only
(`mcp-hub/src/policy.ts`) … ASST-23 therefore needs a medium-or-high impact write."*

Two different gates exist, and the one in `mcp-hub/src/policy.ts` is **not on the assistant's
path**:

- **Hub-side gate** (`policy.ts:47-63` and the Cerbos mirror in `resource_mcp_tool.yaml`):
  suspends medium+/unclassified writes **for `isAutomation` (n8n) principals only**. The
  assistant's OBO principal is `provider:"platform"` — the entire branch is skipped
  (`!isAutomation` short-circuits the Cerbos conjunct too).
- **Agent-side gate** (`ai-agents/src/agent.ts:344-353`): fires when
  `effectiveImpact(declared, registry) === "high_write"`. D14-12's stricter-wins rule is
  explicit **in both directions**: *"an AgentDef label stricter than the registry entry is left
  alone (test: `high_write` + registry `"low"` ⇒ stays `high_write`)"* (agent.ts:46-49, pinned
  by `impact-reconciliation.test.ts`). So a hub-`low` tool declared `high_write` **does**
  suspend, **does** file an `origin='agent'` row, and **does** produce the proposal card.

The registry's own D14-15 section (`platform-nest/src/core/approval-executables.ts:290-321`)
states this exact mechanism and names it the intended consumer: *"The only path that can reach
these entries is the AGENT path, and only if an AgentDef declares one of these tools as a
`high_write` … adding a `high_write` is now the single remaining step."* And d14-17's test (C)
proved live that an `origin='agent'` `pm.createTask` row executes exactly once and fails closed
on an archived project.

**Consequence:** no medium/high hub tool is needed; no new tool is needed. The "new
assistant-scoped write tool" idea is REJECTED — it would mint a second name for an existing
capability purely to satisfy a misread of the gate, and would drag its own registry entry,
precondition, and Cerbos-list evaluation behind it (D14-17's own doctrine: don't invent tools).

### 1.2 Fact #6 is right about execution, wrong about the happy path's dependencies

Correct: the **human approver's decision** triggers execution. `decide()`
(`automation-approvals.controller.ts:281-305`) flips `execution_status='pending'` for
registry-listed tools and the outbox consumer drives `executeApprovedAutomationWrite`, which
re-drives **as the original filing principal** (for `origin='agent'`: the requester's own
verified identity link — `approval-execute.ts:377-399`). The assistant never resolves its own
approval.

**But** `approvals.resolveExecute` is still on ASST-23's critical path, in a different role:
`agent.ts:349` consults `deps.resolveApproval` **before every `high_write` throw — including
the very first one**. `liveDeps.resolveApproval` (`ai-agents/src/deps.ts:217-240`) calls the
hub tool `approvals.resolveExecute` (`minAssurance:"verified"`), gets `{match:"none"}`, and
only then does the runner throw-and-file. A fault during that consult **must throw** (never
map to `none` — the duplicate-generator contract), so:

- If the runner's assurance elevation is not live (unset `HUB_ASSURANCE_TOKEN`, or
  `HUB_REVOCATION_CHECK=false`, which silently caps assurance at `low` —
  `mcp-hub/src/revocation.ts:53-57`), the hub denies the consult, `callTool` throws, and the
  goal lands **`failed` with no proposal filed**. Loud, but a dead feature.
- Chat itself stays `low` — the elevation happens only on the **runner's** hub calls (it holds
  the token; platform-nest's broker calls use the ordinary token), and `elevateAssurance`
  refuses n8n by the explicit §A13 line. No change to `mcp-hub/src/principal.ts` is needed or
  proposed (that file belongs to the concurrent assurance session — untouched).

**Future "assistant retries its own failed write":** already answered by the machinery —
`match:"failed"` returns `ApprovalNotResumableError`; a **human** retries via D14-07 (Cerbos
`retry` = company_admin/group_executive/platform_admin), because a `tool_error` may have
partially applied. The assistant never retries its own failed write; the card links the human
there. No gap to close.

### 1.3 NEW finding — a latent bug 400s every agent-origin filing (must fix first)

`write-agent.ts:65-93 fileApproval` sends `impact: err.impact` where the only reachable value
is the AgentDef vocabulary **`"high_write"`**. The platform's `create()` validates
`IMPACTS = {medium, high, unclassified}` (`automation-approvals.controller.ts:22,144`) and the
column CHECK agrees (`migrations/0014_automation_approvals.sql:17`). So the first real
`high_write` in history will have its filing **rejected with 400** → `platformSend` throws →
propagates out of `runWriteAgent`'s catch → goal `failed`, **no proposal**. Never caught
because: every `write-agent`/`approval-resume` test scripts `callTool`, and d14-17's tests
insert rows via SQL with `impact='high'`. The n8n path is unaffected (workflows pass the enum).
Fix at the filing boundary (T1): map gate vocabulary → row vocabulary (`high_write`→`"high"`,
pass `unclassified` through). Rejected alternative: widening the platform validator/CHECK to
accept `high_write` or `low` — schema/API churn to represent states the system defines as
non-suspendable, and it would leak the AgentDef vocabulary across the wire contract the hub
schema already declares (`platform-write-tools.ts:281`).

### 1.4 Everything else in the brief checks out

D14 both halves live (verified against `deps.ts`, `platform-write-tools.ts`, the controller,
the executor); broker proposal mechanics + redaction real (`assistant-broker.test.ts:557`
drives them via the `TOOLRUN_SUSPEND` seam and a pre-inserted row); the three blockers of
fact #4 confirmed at `broker.ts:408`, `specialists.ts:63`, `agent-write-guard.test.ts:108`.
One addition to fact #4: the FE is a **fourth** independent blocker — `platform-ui`'s
`decodeAssistantEvent` returns `null` for `tool_call`/`tool_result`/`approval_required`
(pinned by `lib/assistant.test.ts:105`), no component renders tool calls or proposals, `GET
thread` (`assistant.controller.ts:257-290`) returns no tool-call rows, and no UI path sends
`mode:'tools'` at all.

---

## 2. The design

### 2.1 Q1 — which write tool, at what tier, and why the tier is honest

**`pm.createTask`, and only it, in v1.** Hub tier stays `impact:"low"` (untouched — `wf:report`
keeps working); the assistant's AgentDef declares it **`high_write`**.

Why this is honest and not demo-rigging: the two labels answer **different questions**. The hub
tier classifies the write's blast radius for the *automation* gate (in-tenant, reversible,
no external effect ⇒ `low` — correct, and load-bearing for WD-06). The AgentDef label is the
*agent policy* knob: "may an LLM commit this unattended?" — and the blueprint's locked D-A says
assistant write intents become proposals, so **`high_write` is the truthful declaration of the
policy actually in force**, exactly the asymmetry D14-12 built stricter-wins for. The same
write IS fine when a human deliberately wired it into a scoped n8n workflow with deterministic
inputs, and IS proposal-gated when a model composes the arguments from a chat. Filed row
impact = `"high"` (after T1's mapping) — the row's `impact` records the gate tier that caused
the suspension, which is what the approver is being asked to lift; the UI copy renders it as
"agent write — requires approval", not as a claim about blast radius.

`pm.createDoc` is a deliberate **fast-follow, not v1**: identical machinery (registry entry
already live), but every additional model-selectable write widens the eval surface and the
tool-contract check for zero additional proof value in ASST-23's acceptance. Adding it later is
a three-line diff (def + allowlist + eval case) — rejected for v1, recorded so the omission
reads as a choice. Money tools stay permanently barred at both layers (unchanged; restated
here per standing instruction).

Rejected alternatives, with reasons: **re-tier PM tools at the hub** (suspends `wf:report`'s
WD-06 sink — breaks a working program; also dishonest, the write IS low-impact);
**new assistant-scoped write tool** (§1.1 — a second name for an existing capability);
**widen the hub `isAutomation` branch** (forbidden by the broker header §"must stay narrow" —
would push every human/OBO medium+ write into suspension and break the read path);
**route through `taskTriager`** (it holds `tasks.update: low_write`, which executes
*immediately* on an evaled provider — a chat turn through it would violate D-A's
all-writes-are-proposals; the assistant's defs must hold **no** `low_write`, pinned by a new
guard in T2).

### 2.2 Q2 — how the broker reaches it

A **new AgentDef `task-filer`** in `ai-agents/src/specialists.ts`, exported via
`writeSpecialists` (the runner routes `writeSpecialists` through `runWriteAgent` —
`runner/service.ts:261-273` — which is the D13+D14-gated path; placing it in `specialists`
would run it through `traceRun`, which **suspends without filing** — wrong path, stated so
nobody "simplifies" it there):

```
name: "task-filer"
tools: { "projects.list": "read", "tasks.list": "read", "pm.createTask": "high_write" }
maxSteps: 8, maxToolCalls: 4
evaledProviders: []  → ["openai"] after the T2 eval run (D13; taskTriager precedent)
```

Broker side (`platform-nest/src/modules/assistant/broker.ts`): `ASSISTANT_AGENT_TOOLS` gains
`"task-filer": ["projects.list","tasks.list","pm.createTask"]`, **plus a new parallel map**
`ASSISTANT_AGENT_WRITE_TOOLS = { "task-filer": ["pm.createTask"] }` — the write subset. The
existing map's shape and every consumer (send-time 400, wall-1 gate, capabilities comment)
stay unchanged. `DEFAULT_TOOL_AGENT` stays `status-reporter` — write turns are always explicit.

**The read-only guarantee:** it is load-bearing in exactly **one** place with teeth —
`core/d14-17-assistant-write-registry.test.ts` tests (A)+(A-reverse) pin the mirror as
read-only and disjoint from the registry. ASST-23 legitimately supersedes that finding, so T3
**rewrites (A) into its successor invariant** (do not delete-and-forget): *every tool in
`ASSISTANT_AGENT_WRITE_TOOLS` has a `getExecutable()` entry; every mirror tool NOT in the
write map has none; the write map is a subset of the agent's tool list*. The broker header's
"Read-only agents only, deliberately" comment is updated to describe the write-map contract.
Nothing else consumes the read-only property (grep-verified: controller uses keys only;
`capabilities.ts` references it in a comment).

**D13 applies to the proposal path and stays.** `runWriteAgent` forces an un-evaled provider
read-only (write tools stripped ⇒ `ToolNotAllowedError` ⇒ no proposal). Waiving D13 for
"proposal-only" turns was considered and REJECTED: the proposal carries model-composed
arguments a human will approve; the eval + tool-contract run is precisely the evidence that the
model can compose them; and one rule ("write-capable defs need enrollment") beats two. So T2
includes authoring the eval cases and enrolling `openai` (Ollama Cloud) per
`docs/runbooks/agent-evaled-providers-enrollment.md` — the same evidence bar `taskTriager`
cleared on 2026-07-24. Operational corollary (T6): the runner's D13 provider input is
`AGENT_SERVING_PROVIDER ?? lastProvider() ?? "echo"` (`runner/service.ts:235,263`) —
**unset in compose today**, so the live box must pin `AGENT_SERVING_PROVIDER=openai` or the
first post-restart write turn lands `forced_read_only`.

### 2.3 Q3 — the guard-allowlist path, read from the code (not the comment)

The PR extending `RERUN_CAPABLE_HIGH_WRITES` to `["pm.createTask"]` must show, by name:
- **(a)** the live resolver: TRUE globally since D14-14 — cite `ai-agents/src/deps.ts`
  `liveDeps.resolveApproval` → hub `approvals.resolveExecute`
  (`mcp-hub/src/platform-write-tools.ts:345`).
- **(b)** the registry entry with a real server-side precondition: TRUE — cite
  `platform-nest/src/core/approval-executables.ts` `registerPmExecutableApprovals()`
  (`pmCreateTaskPrecondition`: project exists ∧ not archived ∧ assignee still an active
  member; typed reasons `project_not_found` / `project_archived` / `assignee_gone`), plus
  d14-17 test (C) as live proof.

**Is `medium` subject to the same gate?** Precisely: there is **no `medium` in the AgentDef
vocabulary** (`Impact = read | low_write | high_write`, agent.ts:10). The CI guard filters on
the **declared** label only (`impact === "high_write"` at `agent-write-guard.test.ts:173`;
declared `low_write` is separately gated by `VERIFIED_IDEMPOTENT_LOW_WRITES` at :232). Hub
`medium` enters only at **runtime**, via `effectiveImpact` — registry `medium|high|undefined`
maps to `high_write` rank and promotes a weaker declaration. Two consequences worth stating:
a hub-`medium` tool declared `low_write` would pass the high-write guard (declared label isn't
`high_write`) yet **suspend at runtime** — the guard is shape-CI on declarations, not the
runtime authority; and `RERUN_CAPABLE_HIGH_WRITES` itself is **test-only** — nothing at runtime
consults it. Our declaration is `high_write`, so the guard applies exactly as documented. (The
registry cache can also promote a declared-`read` tool if the hub reclassifies it `write:true`;
the fallback in that odd case is a filed-then-`not_applicable` row — safe, covered by test (B).)

**"Unregistered tool proposal refused at proposal time"** is enforced where the registry
actually lives (platform-nest — same process as the broker, no cross-repo mirror):
`runToolTurn` gains a step (0.5): for the chosen agent, every `ASSISTANT_AGENT_WRITE_TOOLS`
entry must satisfy `getExecutable(name) !== undefined`, else the turn is refused typed
(`errorKind:"tool_not_executable"`, a `denied` ledger row, **runner never contacted** — same
provable-refusal shape as wall 1). The rewritten parity test (§2.2) makes shipping a drifted
mirror impossible; the model-invented-tool case is already `ToolNotAllowedError` (off
allow-list); and the residual cross-repo drift case (an ai-agents def gains a write the
platform mirror doesn't know) degrades to D14-17's proven `not_applicable` dead end — never
auto-execution.

### 2.4 Q4 — does the chat-as-write-vector need controls beyond D14?

**No new control layer. Argued, not assumed:**

1. **Authority is already correct.** Every leg runs as the chatting user: wall-1 + hub + Cerbos
   + RLS at proposal time under the user's OBO envelope; execution at decide time re-drives as
   `requested_by`'s own verified link (never the approver — privilege-amplification rule intact,
   `approval-execute.ts` invariant 1). A user who lacks PM-write rights gets an honest
   execution-time failure surfaced on the card (proposal-time Cerbos *simulation* of the future
   platform write was considered and rejected as over-engineering for v1 — PlanResources probing
   for a write that may never be approved).
2. **[SUPERSEDED by §7.2 — owner override 2026-08-06: an in-thread confirm chip ships. The
   argument below is preserved as the record of the tradeoff.]**
   **The user needs no in-thread confirmation before filing.** D-A's human-in-the-loop is the
   *approver*; a second confirm (the user confirming their own request to the assistant) is
   double ceremony, and mechanically expensive — the filing happens inside the runner's goal
   (`runWriteAgent` catch), so a pre-file confirm would need a new suspend-without-filing runner
   state or a two-phase turn. Spam on the decider bell is bounded: at most **one** filing per
   message (the first unresolved `high_write` throws and ends the goal), and an exact re-ask of
   a **rejected** call returns `{match:"rejected"}` — typed refusal in-transcript, **no re-file**
   (`agent.ts:378-391`). This is also precisely ASST-23's "rejected files no duplicate"
   criterion, mechanized. Flagged as owner-reversible (OQ-2) since it's a one-way-door only in UX.
3. **Per-tenant opt-in already exists** — the `assistant` module gate is the opt-in
   (`app_module_allowed`, two-sided handshake). A second toggle for "assistant writes" adds a
   config axis nobody asked for; if wanted later it's a `companies.settings` flag read in the
   broker's step (0.5) (note the `jsonb_set` ancestor trap if implemented).
4. **No assurance floor change.** Chat stays `low` by construction; the only `verified` leg is
   the runner's own consult (§1.2), already gated by the second token. Raising `pm.*`
   `minAssurance` would break `wf:report` (n8n is permanently `low` — §A13).
5. **Transcript safety unchanged.** The proposal card persists **redacted** args in the thread
   (`redactToolArgs` over the approval row's real args — the one redaction that matters,
   broker.ts:754-767); the approver sees real args on `/approvals/[id]` under their own read
   authority. The ledger row is immutable; live card state comes from a read-time join, so no
   writer ever mutates the transcript (§2.5).

### 2.5 The end-to-end flow being built (normative sequence)

1. User (composer, explicit **tools mode + agent `task-filer`**) →
   `POST …/messages {mode:'tools', agent:'task-filer'}` (send-time 400 for unknown agents,
   unchanged).
2. Broker: envelope (unchanged single spelling) → **step 0.5 registry gate** (§2.3) → wall-1
   capability gate under the user's envelope (`pm.createTask` is `minAssurance:"low"`, visible)
   → goal POSTed to the runner with the user's envelope.
3. Runner: `writeSpecialists["task-filer"]` → `runWriteAgent` (D13: provider must be enrolled)
   → model reads projects/tasks, composes `pm.createTask` args → write gate:
   `effectiveImpact("high_write", registry:"low") = "high_write"` → consult
   `resolveApproval` (verified-assurance leg, §1.2) → `{match:"none"}` →
   `ApprovalRequiredError` → `fileApproval` files `origin:'agent'`,
   `workflow_id:'task-filer'`, `requested_by:<user>`, **`impact:'high'` (T1)**; deciders get
   the existing `approval.requested` bell/mail (MAIL-06).
4. Broker harvests `suspended`: reads the approval row, **redacts real args**, persists the
   `pending` ledger row with `approval_id`, emits `approval_required` SSE; terminal frame stays
   `error` + `errorKind:'approval_required'` (contract §18 — FE renders this as
   proposal-pending, not failure).
5. Approver decides on the existing approvals surface (Cerbos `decide`:
   company_admin/group_executive/platform_admin). `decide()` → registry-listed →
   `execution_status:'pending'` → outbox → executor: claim → advisory lock → precondition
   re-check → hub call **as the requester** → `executed` (or typed `failed`).
   `notifyOutcome` bells **requester + decider** (`automation_approval.executed` /
   `execution_failed`, href `/approvals/:id`) — this existing notification **is** ASST-23's
   "terminal notify"; the card is the in-thread rendering of the same fact.
6. Thread reload / focus-poll: `GET thread` now returns per-message tool calls **joined** to
   `automation_approvals` (`status`, `execution_status`, `execution_error`) → card states:
   `proposed → sent for approval → approved+executed | approved+failed (admin can retry) |
   rejected | approved+not executable`. The ledger row itself is never updated — state is
   derived at read time. (RLS note for the implementer: the join runs under
   `withTenants([t], …, {modules:['assistant']})`; `automation_approvals` is a core
   tenant-gated table with no module conjunct, so the join is legal — verify with a live-DB
   test, per the missing-field-reads-as-null trap.)

No migration (0079 + 0014 suffice). No Cerbos edit (mcp_tool: non-automation conjunct is
trivially true; automation_approval: `create` covers member-tier requesters via the OBO'd
user principal — the D14-09 agent-origin suite already exercises this). No mcp-hub edit.

---

## 3. Tickets

Seat defaults per the army standard (seniors Sonnet·high, medior Sonnet·medium, junior Haiku,
qa Sonnet·medium). **No ticket needs Opus**: every hard decision is pinned above; the remaining
work is bounded implementation against named files with in-file invariants.

### T1 — `ai-agents`: impact vocabulary at the filing boundary  — `medior` (Sonnet·medium)
- **Files:** `ai-agents/src/write-agent.ts` (map `high_write→"high"`, `unclassified`
  passthrough, in `fileApproval` only — `agent.ts` untouched), `ai-agents/src/write-agent.test.ts`.
- **Done when:** the `approvals.request` call's args carry `impact:"high"` for a suspended
  `high_write` (asserted on the recorded call, plus a comment naming the platform enum +
  0014 CHECK as the wire contract); existing suites green; `reason` still carries the
  `high_write` framing for the approver.
- **Deps:** none. **QA gate:** no (T5 covers live).

### T2 — `ai-agents`: `task-filer` def + guard allowlist + eval enrollment — `senior-be` (Sonnet·high)
- **Files:** `ai-agents/src/specialists.ts` (def per §2.2, into `writeSpecialists`),
  `ai-agents/src/agent-write-guard.test.ts` (`RERUN_CAPABLE_HIGH_WRITES = ["pm.createTask"]`
  citing (a)+(b) per §2.3, in the documented format; NEW guard: an
  `ASSISTANT_FACING_AGENTS = ["status-reporter","approvals-chaser","task-filer"]` const + test
  that no assistant-facing def declares any `low_write` — the ai-agents half of the two-sided
  no-immediate-writes handshake), `ai-agents/src/evals/*` (cases: files exactly one proposal
  with plausible args; refuses off-list writes; read path; protocol adherence),
  then the enrollment run per `docs/runbooks/agent-evaled-providers-enrollment.md` against
  `openai` (Ollama Cloud — note the shared weekly cap before running) and
  `evaledProviders: ["openai"]` with the documented commit format.
- **Done when:** guard suite green with the new allowlist; a scripted-provider runner test
  drives `task-filer` end to end to `suspended` with a filed `impact:"high"` row (T1 landed);
  eval + tool-contract green against the live provider; enrollment committed.
- **Deps:** T1 (same repo — serialize; also the filed-impact assertion needs it). **QA:** no (T5).

### T3 — `platform-nest`: broker write turn + registry gate + card-state read — `senior-be` (Sonnet·high)
- **Files:** `modules/assistant/broker.ts` (mirror entry + `ASSISTANT_AGENT_WRITE_TOOLS` +
  step 0.5 registry gate importing `getExecutable`; update the "read-only agents only" header
  to the write-map contract; `oboEnvelopeFor`/redaction/walls untouched),
  `modules/assistant/assistant.controller.ts` (GET thread: additive per-message `toolCalls`
  with the approval join per §2.5), `modules/assistant/capabilities.ts` (additive `toolAgents:
  [{name, tools, writeTools}]` so the FE has an authoritative agent list — no FE mirror),
  `core/d14-17-assistant-write-registry.test.ts` (rewrite (A)/(A-reverse) into the §2.2
  successor parity invariant — keep the file, invert the finding),
  `modules/assistant/assistant-broker.test.ts` (+ registry-gate refusal case proving the
  runner got zero goals; + card-state test: seam-suspended row → real `decide()` → GET shows
  `executed`), `docs/FRONTEND-BFF-CONTRACT.md` §18 addendum.
- **Done when:** all listed suites green against live test PG + Cerbos; a turn naming an agent
  whose write tool is unregistered is refused typed with zero runner contact; GET thread
  returns joined card state for the suspended fixture; `tsc --noEmit` clean.
- **Deps:** none (mirror is platform-side strings; fake runner accepts any agent name — can
  land before T2). **QA gate:** yes (T5).

### T4 — `platform-ui`: event grammar + proposal card + write-turn affordance — `senior-fe` (Sonnet·high)
- **Files:** `src/lib/assistant.ts` (decode `tool_call`/`tool_result`/`approval_required`;
  reducer state for tool calls + proposal; message/toolCalls shapes from the new GET field;
  proposal-state derivation helper with unit tests), `src/lib/assistant.test.ts` (the :105
  "decodes to null" pins are **deliberately inverted** — contract change, cite T3),
  `src/components/assistant/Message.tsx`/`ThreadView.tsx` (tool chips; ProposalCard with
  states `proposed / sent for approval / approved+executed / approved+failed (an administrator
  can retry) / rejected / approved but not executable`; `errorKind:'approval_required'` renders
  as proposal-pending, never error styling; link to `/approvals/[id]`; **no** "approval does
  not execute" copy — verified none exists today, so the requirement is: don't introduce it),
  `Composer.tsx`/`AssistantWorkspace.tsx` + `lib/assistantActions.ts` (explicit tools-mode +
  agent select fed from `toolAgents`; plain chat default and byte-identical), focus/interval
  refetch while any proposal is pending; dark theme + a11y on the new card (standing gap rule).
- **Done when:** unit + `next build` green; with a mocked stream, the full card lifecycle
  renders from SSE and from reload-joined state; e2e (DEMO_MODE or mocked BFF) covers
  propose→approve→executed chip.
- **Deps:** T3 (BFF shapes). **QA gate:** yes (T5).

### T5 — QA gate: the ASST-23 loop, adversarially — `qa` (Sonnet·medium)
- **Scope:** on the live test stack: propose → approver decides → row `executed` with
  `executed_by = requester` (never the approver) → card `executed` on reload → requester bell
  received; reject → card `rejected` → **identical re-ask files no duplicate** (scripted
  provider for arg-stability; assert exactly one row); unregistered-write refusal (zero runner
  goals); un-enrolled provider ⇒ `forced_read_only` note, no filing; archived-project
  precondition ⇒ `failed` card + `precondition_failed:project_archived`; thread stays
  owner-private incl. tool ledger; ledger args redacted (no raw values anywhere on wire or
  rows); regression: `wf:report`'s `pm.createTask` n8n path still executes unattended.
- **Done when:** every ASST-23 "done when" line demonstrated with evidence, plus the negatives
  above; findings filed, not fixed.
- **Deps:** T1–T4. **QA gate:** it IS the gate.

### T6 — DevOps: live-box prerequisites — `devops` (Sonnet·medium, small)
- **Files:** `infra/compose/docker-compose.vps.yml` (add `AGENT_SERVING_PROVIDER:
  ${AGENT_SERVING_PROVIDER:-openai}` to `agent-runner` — remember the env-passthrough trap:
  `.env` alone does nothing), `.env.example`. Verify on the box: `HUB_ASSURANCE_TOKEN` set for
  agent-runner + hub, `HUB_REVOCATION_CHECK` not false, runner `/health` `writeAgents`
  includes `task-filer` post-deploy, tag parity (stale-tag footgun).
- **Done when:** a real chat write turn on the deployed stack files a proposal (not
  `forced_read_only`, not `failed`).
- **Deps:** T2 (def deployed). **CONFLICT:** OBS-01 owns `infra/compose/**` — see §5.

---

## 4. Wave order (hard cap ≤2 genuinely-independent tickets per wave)

| Wave | Tickets | Why safe together |
|---|---|---|
| 1 | **T1** + **T3** | different repos (`ai-agents` vs `platform-nest`); T3 provably independent of T2 (fake runner) |
| 2 | **T2** + **T4** | `ai-agents` (serialized after T1 in-repo) vs `platform-ui` (T3's shapes landed) |
| 3 | **T5** (+ **T6** only if OBS-01 has released `infra/compose/**`, else T6 trails solo) | QA drives the whole loop; T6 is one env line + box verification |

Critical path: T1 → T2 → T5; T3 → T4 → T5. T6 gates only the *deployed-box* demo, not the
test-stack gate.

## 5. Conflict map (one shared checkout, three concurrent sessions)

| Concurrent session | Their files | Overlap with this plan |
|---|---|---|
| Mail | `platform-nest/src/mail/**` | **None.** This plan touches `modules/assistant/**`, `core/d14-17-…test.ts`, `docs/` only. `client-notify`/`approval-execute` are read, not edited. |
| OBS-01 | `infra/compose/**` | **T6 only** (one line in `docker-compose.vps.yml` `agent-runner` env). Sequence T6 after OBS-01 merges, or hand the line to that session; never edit concurrently. Everything else ships without it. |
| Password-reset / IdP | `platform-nest` auth/Keycloak surfaces | **None.** No auth/guards/Keycloak files touched. |
| Assurance | `mcp-hub/src/principal.ts` | **None — by design.** This plan edits no mcp-hub file at all; it *depends* on assurance behavior already deployed (alpha-01.020.0052a). If that session changes elevation semantics for platform-provider envelopes, T5's consult leg breaks loudly — flag them: §1.2 documents the dependency. |

Shared-checkout discipline applies to every seat: commit early, never `git add -A`, re-check
main before push; migration ledger untouched (no migration in this program).

## 6. Open questions for the OWNER (explicit; everything else is ruled above)

- **OQ-1 — scope of the v1 write set.** Ruling is `pm.createTask` only, `pm.createDoc` as a
  fast-follow (§2.1). Confirm, or say "both now" (adds ~an eval case + two allowlist lines to
  T2/T3; no structural change). **ANSWERED 2026-08-06: both — see §7.1.**
- **OQ-2 — no in-thread user confirmation before filing** (§2.4.2). The approver is the only
  human gate; ≤1 filing per message; rejected calls never re-file. Confirm, or T4 gains a
  local confirm chip on the composer's write turns (pure FE, cheap, adds a click).
  **ANSWERED 2026-08-06: OVERRIDDEN — confirm chip ships; full mechanism ruling in §7.2.**
- **OQ-3 — eval spend.** T2's enrollment run consumes shared, weekly-capped Ollama Cloud quota
  (per the provider's standing note). Approve running it, or name another provider to enroll
  (changes the `evaledProviders` value and T6's pin).
  **ANSWERED 2026-08-06: Ollama Cloud, kept minimal — floor defined in §7.3.**

---

## 7. DELTA — owner decisions on OQ-1/2/3 (architect ruling, 2026-08-06, appended)

Owner answered §6. OQ-1 and OQ-2 change the design; this section is the authoritative delta.
Everything above stands except where explicitly superseded here. T1 is already dispatched and
is unaffected.

### 7.1 OQ-1 — BOTH `pm.createTask` AND `pm.createDoc` ship in v1

**Readiness check (re-verified in code, not assumed):** `pm.createDoc`'s registry entry is
exactly as ready as `createTask`'s — `registerPmExecutableApprovals()`
(`approval-executables.ts:421-432`) registers both; `createDoc`'s precondition is
`pmProjectPrecondition` (project exists ∧ not archived; typed `project_not_found` /
`project_archived`; no assignee branch because the tool has no assignee field — a documented
scope call, not a gap); both share `pmLockKey` (same-project writes serialize, malformed ids
never collapse onto a shared lock).

**One honest caveat:** d14-17's test (C) proved the `origin='agent'` **execution** path for
`pm.createTask` only (both cases at `d14-17-assistant-write-registry.test.ts:188-212` drive
`pm.createTask`; `createDoc` appears only in the (A)-reverse registration check). The
executor and `decide()` are origin-agnostic by construction and the createTask proof carries
the mechanism, but the claim "both covered" must be made true, not asserted: **T3a's rewritten
registry test adds one `origin='agent'` `pm.createDoc` executes-once case + one
archived-project refusal case** (mirror of :188/:200, ~20 lines against existing fixtures).

**Revised cost (confirming the estimate, slightly up from "~3 lines"):**
`specialists.ts` def tools map +1 line; `RERUN_CAPABLE_HIGH_WRITES` +1 name (same (a)/(b)
citations — both point at D14-14 and D14-15, verbatim); broker mirror + write map +2 small
edits; +1 live eval case (a doc-proposal turn) and +1 scripted containment case; +2 registry
test cases per above. No structural change anywhere. The §2.1 "createTask-only" ruling and its
rationale remain on record; the owner priced the wider eval surface and chose both.

### 7.2 OQ-2 — OVERRIDDEN: in-thread confirm-before-file (the full mechanism)

My §2.4.2 argument (the approver is already the human gate; a second confirm is double
ceremony; the filing lives inside the runner's goal) is preserved above and was heard; the
owner decided the chip ships. What follows is the mechanism that implements it without
breaking any standing invariant. **The flow becomes:** model wants a write → run suspends
**without filing** → thread shows a confirm chip (redacted args) → user confirms → the
approval row is filed and deciders are notified → the existing D14 chain proceeds unchanged.

#### 7.2.1 Where the un-confirmed intent lives — a NEW table, one migration, ledger untouched

**`assistant_write_intents`** (new tenant-scoped table, `assistant`-module RLS per 0079's
composed-policy pattern): `id, tenant_id, thread_id, message_id, tool_call_id (composite
tenant-scoped FK -> assistant_tool_calls, ON DELETE CASCADE), owner_user_id, agent, tool_name,
tool_args jsonb NULL (the ONLY pre-filing home of the REAL args — see 7.2.4), impact,
status CHECK (draft|filed|dismissed|expired), approval_id uuid NULL, expires_at, created_at,
origin_site`.

- **Migration discipline:** brand-new table, **zero DML, zero backfill** — trivially immune to
  the no-BYPASSRLS backfill trap; the authoring seat must take the **next unused number from
  the migration ledger at authoring time** (sessions share this checkout; the head moves) and
  must **never fill 0058/0059/0070** (permanently-orphaned reservations). NULL-defaulted
  columns throughout; no ALTER of any existing table.
- **`assistant_tool_calls` is NOT migrated.** Its status CHECK (`pending|running|succeeded|
  failed|denied`) and its redaction invariant stay byte-identical. The pre-confirm card state
  is **derived at read time**: ledger `status='pending'` ∧ `approval_id IS NULL` ∧ intent join
  discriminates `awaiting confirmation` (intent `draft`) / `dismissed` / `expired`; once
  filed, `approval_id IS NOT NULL` and the §2.5 approval join takes over. One amendment to
  §2.5's "the ledger row is never updated": the confirm transaction performs exactly **one**
  ledger write ever — `approval_id NULL → value`, once, atomically with the filing. Status is
  never touched.
- **Rejected alternatives:** a `proposed` value in the ledger CHECK (a migration + a status
  union change in `BrokerToolCallRecord`/`persistToolCalls` for a state the intent row already
  carries authoritatively); a draft/unconfirmed state on `automation_approvals` (spreads
  assistant-only state into the shared WS4 core — `decide()`, the list endpoint, the
  `resolve-and-execute` candidate rank, and the n8n path would all grow a fourth status to
  reason about); transient-only in-process state (confirm must survive reload and redeploy and
  be server-authorizable); client-carried args (see 7.2.4).

#### 7.2.2 What carries the confirm — two owner-only endpoints + one same-file Cerbos edit

`POST /api/:t/assistant/threads/:id/tool-calls/:callId/confirm` and `.../dismiss`. **Not** a
flag on the message-send path: a confirm is not a message — overloading send would mint a fake
user turn, entangle the placeholder/stream lifecycle, and put the confirm inside the SSE
reservation machinery for no reason.

- **Authorization:** `AuthGuard` principal (the chatting user, from the session — never a
  body field) → `authorize(principal, { kind: "assistant_thread", id, tenantId, ownerId },
  "confirm_write")`. `resource_assistant_thread.yaml` gains `"confirm_write"` (and the same
  action gates dismiss) in the ONE existing owner rule's action list at line 71 — same file,
  same `inTenant && notLow && owns` condition, no new rule, and emphatically **no admin
  path** (the file's own header forbids it). Per the standing memory, treat EVERY policy
  change as needing the `gaiada-test-cerbos` restart + owner-ALLOW smoke check, even though
  ASST-21 observed same-file edits hot-reloading — the restart costs nothing and the silent-
  DENY trap costs an afternoon.
- **The filing itself moves in-process:** extract the body of `create()`
  (`automation-approvals.controller.ts:135-180` — INSERT + `writeActivity('suspended')` +
  decider resolution + `approval.requested` notify) into one shared core function
  `fileAutomationApproval({tenantId, workflowId, toolName, toolArgs, impact, reason, origin,
  agentName, requestedBy})`; `create()` becomes a thin HTTP wrapper (n8n path byte-identical),
  and the confirm handler calls the same function with `origin:'agent'`,
  `workflowId/agentName = intent.agent`, **`requestedBy = the chatting user`** — which is what
  keeps the whole downstream authority chain intact: `requested_by` drives the executor's
  re-drive principal AND `resolve-and-execute`'s `requested_by == principal.id` gate. The
  transcript-safety invariant is untouched: the confirm is a first-party user HTTP action;
  the runner-side hub-audited filing simply no longer happens on this path (n8n's does,
  unchanged).
- **Response:** the post-confirm card state (approvalId + joined approval state), so the FE
  needs no extra fetch. Dismiss returns the `dismissed` card state.

#### 7.2.3 Idempotency and abandonment

- **Double-click / concurrent confirm:** the confirm transaction opens with a single-winner
  claim — `UPDATE assistant_write_intents SET status='filed', approval_id=$new, tool_args=NULL
  WHERE id=$1 AND status='draft' AND expires_at > now() RETURNING tool_args` (the RETURNING
  carries the args into the filing INSERT inside the same transaction — claim, file, ledger
  `approval_id` write: one transaction, exactly-once by the claim, same idiom as the
  executor's `pending→executing` claim). A loser (second click, replayed request) gets the
  row's CURRENT state back as a 200 — idempotent UX ("already sent for approval"), never a
  second filing. Dismiss claims the same way (`draft → dismissed`).
- **Abandonment:** `expires_at = created_at + ASSISTANT_INTENT_TTL_MS` (default **1 hour**,
  config knob). Correctness does not depend on the TTL — execution-time staleness is what the
  registry precondition re-checks — so the TTL is purely a raw-args retention bound. Reaping
  is **lazy, no background job**: the confirm/dismiss claims refuse expired drafts
  structurally (the `expires_at > now()` conjunct), and the thread GET's card-state join
  opportunistically flips past-expiry drafts to `expired` and **scrubs `tool_args` to NULL**
  in the same statement. Thread deletion CASCADEs through `tool_call_id`. An expired,
  dismissed, or filed intent can never file — there is no code path that files from any
  status but `draft`, and no client-supplied args exist to file with (7.2.4).

#### 7.2.4 Where the REAL args live between proposal and filing (the subtle one)

The transcript stores redacted args by invariant, so the unredacted args must survive
elsewhere. Custody chain, exhaustively:

1. **Runner, in flight:** the args exist inside `ApprovalRequiredError` exactly as today. With
   deferred filing they are handed back on the goal detail (7.2.5) from an **in-memory,
   TTL'd (~15 min) map keyed by goalId** — deliberately NOT the agents-DB goal row, preserving
   the documented property that **the agents database never holds raw args** (broker.ts
   redaction header). This is safe because runner restarts already kill in-flight/queued goals
   (`sweepInterrupted` on boot), so the map is exactly as durable as the goal lifecycle it
   serves; the sub-second worst case (restart between `finishGoal` and the broker's next poll)
   surfaces as an honest typed error card ("proposal lost — ask again"), never a silent hang.
2. **Platform, pre-confirm:** the broker's suspended-harvest writes them into
   `assistant_write_intents.tool_args` — the ONE durable pre-filing home: tenant-scoped, RLS'd
   under the `assistant` module, reachable only through owner-gated endpoints, TTL-bounded,
   scrubbed to NULL on dismiss/expiry.
3. **At confirm:** they move into `automation_approvals.tool_args` inside the claim
   transaction — exactly where they live today post-filing (the approver reads them on
   `/approvals/[id]` under their own authority) — and the intent row is scrubbed in the same
   UPDATE. Net new raw-args surface: one bounded, expiring, scrubbed-on-terminal table.
4. **Never:** the wire to the browser. The `confirm_required` SSE frame and every GET carry
   **redacted** args + `intentId` only; the confirm request carries NO args at all — the
   server files what the intent row holds. Client-carried args were rejected because raw
   values would enter the client transcript (the exact thing redaction exists to prevent) and
   a tampered confirm could file user-authored args wearing model provenance — the approver's
   trust decision ("the assistant proposed this") must be about what the model actually
   proposed. Re-derivation (re-running the goal at confirm with filing enabled) was rejected
   because a second run may compose different args than the ones the user confirmed — the
   confirmed thing and the filed thing must be byte-identical, the same principle as D14's
   argsSha256 binding downstream.

#### 7.2.5 The runner leg — per-goal deferred filing (new ticket T2b)

`POST /goals` gains optional **`fileOnSuspend?: boolean` (default `true`)** — stored in an
in-memory per-goal options map (no agents-DB migration; same durability argument as 7.2.4.1).
`runWriteAgent` gains the option: on `ApprovalRequiredError` with `fileOnSuspend:false` it
does NOT call `fileApproval` and returns `{ status: "suspended", filed: null, intent: { tool,
impact, args } }`; `mapWriteResult` keeps goal `status:'suspended'`,
`errorKind:'approval_required'`, no `approvalId`; the service parks the intent in the TTL map
and `GET /goals/:id` merges it as `suspendedIntent` (absent once evicted). Every existing
caller — CLI, intelligence controller, **ASST-21 handoffs**, tests — passes no flag and keeps
today's file-immediately behavior byte-for-byte. **Scope note, stated so it is a decision and
not an accident:** a handoff to `task-filer` still files WITHOUT the in-thread confirm — the
handoff click is itself the explicit user consent to that agent acting, and the run-watch
chip + approvals inbox surface it. If the owner wants confirm-on-handoff too, that is a
follow-up ticket on `createHandoff`, not this program.

The consult ordering is untouched: `agent.ts` still calls `resolveApproval` BEFORE throwing,
so a rejected identical call returns `{match:"rejected"}` and produces **no intent and no
chip** (7.2.6). The T1 impact mapping applies at the (now confirm-time) filing boundary the
same way — `fileAutomationApproval` receives `impact:'high'` derived once, stored on the
intent row by the broker (`high_write → 'high'` — T1's mapping logic lives in ONE exported
helper both `fileApproval` and the broker reuse, not two copies).

#### 7.2.6 The invariants, re-proven under the new state

- **≤1 filing per message — HOLDS, now as a product of two halves:** ≤1 *intent* per message
  (the first unresolved `high_write` still ends the goal) × ≤1 filing per intent (the 7.2.3
  claim).
- **Rejected exact re-ask never re-files — HOLDS, unchanged mechanism:** the consult runs
  before suspension, upstream of everything this delta adds; a confirm-time-filed row is
  shape-identical to a runner-filed row (`origin='agent'`, `workflow_id=agent`,
  `requested_by=user`, same canonical args), so `resolve-and-execute` matching, the executor,
  and the grant chain need zero changes.
- **NEW invariant the override exists to buy:** an unconfirmed intent notifies NOBODY — no
  decider bell/mail exists until the confirm-time `fileAutomationApproval`. T5 asserts the
  zero-notification property directly.
- **Unchanged:** single envelope spelling; walls 1+2; redacted-only transcript and wire;
  owner-privacy incl. the two new endpoints; D13; registry gate (step 0.5 runs before any
  goal exists, unchanged by the confirm flow).

#### 7.2.7 Wire/contract delta

New SSE frame `confirm_required` `{callId, toolName, args(REDACTED), intentId, expiresAt}`;
the tool turn's terminal frame becomes `error` + `errorKind:'confirm_required'` for this
path (FE renders as awaiting-confirmation, never error styling). `approval_required` keeps its
exact current meaning (a FILED proposal) — it simply no longer occurs on the chat path's first
leg; it remains correct for handoff-origin suspensions and any `fileOnSuspend:true` turn.
`GET thread` messages gain `toolCalls[]` with `{…ledger fields, intent: {status, expiresAt} |
null, approval: {status, executionStatus, executionError} | null}`. Contract §18 addendum
covers all three. Card states, full set: `awaiting confirmation → sent for approval →
approved+executed | approved+failed (admin retry) | rejected | approved but not executable`,
plus terminal-without-filing `dismissed` / `expired`.

### 7.3 OQ-3 — Ollama Cloud, minimal eval (the honest floor, not a number picked for thrift)

The D13 gate's evidence bar is "this provider follows the tool-calling protocol for THIS
def's tools and contains off-list writes." Floor against the LIVE provider (`openai` =
Ollama Cloud): **one protocol-adherence turn, one proposal-shaped turn per write tool (2),
one containment probe (off-list write attempt) — ≈4 live goals, single-digit completions.**
Everything else (budget exhaustion, arg-shape assertions, refusal typing, D14 wiring) runs on
scripted deps at zero quota. Check `limits.weekly.usage` before and after the run; do not
loop retries against the live provider — a red case gets diagnosed on scripted deps first.

### 7.4 Revised tickets, waves, and what T1 already covers

T1 (dispatched) — unchanged, still correct: its mapping helper is reused at the confirm-time
boundary (7.2.5). Revised/new tickets:

- **T2b (NEW) — `ai-agents`: deferred-filing mode** — `senior-be` (Sonnet·high).
  Files: `write-agent.ts` (option + unfiled-suspend result variant — note `mapWriteResult`'s
  exhaustiveness warning in its own doc), `runner/service.ts` (options map, intent TTL map,
  `suspendedIntent` on goal detail), `runner/service.test.ts`, `write-agent.test.ts`.
  Done when: default-path callers byte-identical (existing suites green untouched);
  `fileOnSuspend:false` yields suspended+intent with `fileApproval` NEVER called; intent
  evicted on TTL; agents DB provably never stores args (test reads the goal row).
  Deps: T1 (same files — serialize in-repo).
- **T3a — platform broker write turn (as §3 T3 originally, minus confirm):** mirror + write
  map (now both PM tools), step 0.5 registry gate, capabilities `toolAgents`, d14-17 rewrite
  **including the two new `pm.createDoc` origin-agent cases (7.1)**, contract addendum.
  `senior-be` (Sonnet·high). Deps: none.
- **T3b (NEW) — platform confirm machinery:** the migration (7.2.1 — verify ledger head;
  never fill 0058/0059/0070), broker harvest-to-intent + `confirm_required` emission (codes
  against a fake runner's `suspendedIntent` — the 7.2.5 contract, so T2b need not land
  first), `fileAutomationApproval` extraction (n8n path proven unchanged by existing
  approvals suites), confirm/dismiss endpoints + Cerbos `confirm_write` edit (+ restart
  step), lazy reap in thread GET, tests incl. double-click single-filing, dismiss/expiry
  scrub (DB-level NULL assertion), zero-decider-notification pre-confirm, owner-privacy 403s
  on both endpoints. `senior-be` (Sonnet·high — the state machine is fully specified here;
  no Opus). Deps: T3a (same files).
- **T4 — FE (delta):** decode `confirm_required` + the 7.2.7 shapes; ConfirmChip
  ([Send for approval] / [Dismiss]) with awaiting/dismissed/expired states; confirm action →
  optimistic transition to sent-for-approval from the endpoint's response; the rest as §3 T4.
  `senior-fe` (Sonnet·high). Deps: T3a+T3b.
- **T2 — def + guards + evals (delta):** both PM tools (7.1), minimal live-eval floor (7.3);
  otherwise as §3. `senior-be` (Sonnet·high). Deps: T2b (same repo).
- **T5 — QA (delta):** add — double-click files exactly once (DB count); dismiss files
  nothing and notifies nobody; unconfirmed intent ⇒ deciders have zero notifications; expiry
  scrubs `tool_args` (raw values absent from EVERY row and every wire frame — sweep both);
  confirm after expiry/dismiss refused typed; confirm by a non-owner 403s; handoff-to-
  task-filer still files directly (scope note 7.2.5); plus everything in §3 T5.
  `qa` (Sonnet·medium). Deps: all.
- **T6 — unchanged** (compose env; OBS-01 conflict handling as §5).

**Revised waves (cap ≤2, shared-checkout discipline unchanged):**

| Wave | Tickets | Why safe together |
|---|---|---|
| 1 | T1 *(dispatched)* + **T3a** | different repos |
| 2 | **T2b** + **T3b** | `ai-agents` (after T1 in-repo) vs `platform-nest` (after T3a in-repo); T3b codes against the 7.2.5 contract with a fake runner |
| 3 | **T2** + **T4** | `ai-agents` (after T2b) vs `platform-ui` (after T3a/T3b) |
| 4 | **T5** (+ **T6** per the §5 OBS-01 rule) | the gate |

Critical path grows one wave (T3b). Conflict map §5 unchanged: the delta adds no mcp-hub, no
mail, no auth files; the one migration is assistant-owned; T6's compose line is still the
only OBS-01 contact point.
