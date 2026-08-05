# D14 resume path — why it blocks everything, and how to close it

> **Status: PLAN — all 5 decisions locked (§7), ready for architect decomposition.** No code. Written
> 2026-08-05 because five separate programs have now deferred their write half to this one gap: WS11
> delivery pipeline, PM Phase 4 (`J2`), the mail subsystem, the ERP assistant, and the agentic-native
> readiness bar (criterion 4).
>
> **Headline outcome: Temporal is NOT required for D14.** D14-a is a missing event consumer; D14-b is
> closed by the re-run-from-the-top decision. See §5 and §7.

---

## 1. What D14 actually is

A locked spec decision on **write safety**: every write an automation or agent attempts is
impact-classified. `low` → executes directly. `medium` / `high` / **`unclassified`** → suspend for a
human decision. Unclassified defaults to confirm-required, i.e. the gate **fails closed**.

That decision is correct and it is implemented. The gap is at the other end.

## 2. What is built, precisely

| Step | Where | State |
|---|---|---|
| Classify + refuse | `mcp-hub/src/automation-policy.ts` — returns a `suspend:` reason for medium+/unclassified | Works |
| File the suspension | hub `approvals.request` tool (OBO) → `POST /api/:t/automation-approvals` | Works |
| Durable record | `automation_approvals` (FORCE RLS, 0014). Stores `workflow_id`, **`tool_name`**, **`tool_args`**, `impact`, `reason`, `requested_by`, `origin`, `agent_name` | Works |
| Agent-side suspension | `ai-agents/src/write-agent.ts` — a `high_write` throws `ApprovalRequiredError`, commits nothing, files `origin="agent"` | Works |
| Tell a human | MAIL-06 — `resolveAutomationApprovalDeciders` + `notifyBestEffort` → bell, and email via the MAIL-05 tap | Works |
| Authorize the decision | Cerbos: automation may `create`, elevated humans `read`, only `company_admin` / `group_executive` (or `module_manager` for `origin=hr`) `decide` | Works |
| Decide | `POST .../decide` — flips status, writes activity, **emits `automation_approval.decided` carrying `decision`, `origin`, `toolName`, `toolArgs`, `workflowId`, `decidedBy`** | Works |
| Same event from the façade | `core/approvals-decide.controller.ts` | Works |
| **Execute the approved call** | — | **Does not exist** |

### The one-line diagnosis

`automation_approval.decided` has exactly **one** consumer:
`modules/hr/leave-decision.ts` → `applyLeaveDecision`, which returns immediately unless
`origin === "hr"`. For `origin` `automation` or `agent`, the event is emitted, relayed, and **read by
nobody**. Approval is a status flip plus an audit row.

## 3. Why it blocks so much, and keeps coming back

**It is the terminal node of every write-capable AI path.** Every program that lets an automation,
bot, or agent change something lands on the same dead end, so each one independently discovers it,
writes "blocked on D14", and ships reads only. That is the recurrence you keep seeing — not five
problems, one problem hit from five directions.

Three properties make it worse than an ordinary missing feature:

1. **It fails silently and it fails *positively*.** The UI says approved. `writeActivity` says
   approved. The audit trail says a human authorized the change. Nothing happened. Every other gap in
   the platform announces itself with an error; this one manufactures false evidence that work was
   done. That is a correctness and trust defect, not a backlog item.
2. **It punishes correct classification.** Because `unclassified` fails closed, registering a write
   *properly* with the impact gate is what routes it into the dead end. Doing the safe thing makes
   more things silently not happen — so the gate's incentive is currently inverted.
3. **It caps the platform's ceiling, not its floor.** Reads are fine everywhere. The entire "agents do
   work" premise — the reason the agent runtime, MCP hub, brigade and n8n estate exist — is gated on
   this. WD-08 recorded the sharpest instance: `deploy.production` has a D14 suspend and no resume, so
   `wf:delivery` can *never* complete a production deploy unattended.

## 4. The hard part is not plumbing

The event already carries the full call. Re-driving it is ~50 lines. The reason this sat unbuilt is
that four questions have real answers and getting them wrong is worse than the current gap.

1. **Whose authority executes?** The filing principal was **refused**. Re-driving as that principal is
   either refused again or — if you skip the gate to make it work — a **privilege-escalation
   primitive**: "get a human to approve, then execute with rights that were denied." Executing as the
   **approver** is the defensible reading (a human authorized *this specific act*), but it must be
   re-authorized against Cerbos at execution time, bound to exactly that tool+args, and single-use.
2. **Staleness / TOCTOU.** `tool_args` were captured at filing; the decision may come hours later.
   The precondition must be re-evaluated at execution, not trusted from filing. **House precedent
   exists:** WD-29 fixed exactly this class for the pipeline — a per-entity advisory lock *plus*
   server-side re-evaluation of the caller's own precondition. The lock alone was proven a no-op
   (6 duplicate rows survived it), which is the lesson to carry over.
3. **At-least-once delivery.** The outbox/consumer loop redelivers. The executor must be idempotent.
   `applyLeaveDecision` shows the shape: transition only from the expected state
   (`WHERE status = 'pending'`), so a second pass changes nothing.
4. **Failure semantics.** If execution fails *after* approval, what is the state? Without an answer
   you replace a silent no-op with a silent failure — no improvement. The row needs a terminal
   execution outcome and the approver needs to be told.

## 5. Does this need Temporal? No — and that answer changed

D14 is two different problems wearing one label. Separating them is what makes this shippable:

- **D14-a — resume one approved tool call.** Unit of work = a single call whose full payload is
  already durable. Needs a handler, three columns, and an authority rule. **No durable orchestrator.**
- **D14-b — resume a suspended multi-step run.** A budget exhaustion or a `high_write` at step 7 of 12
  suspends the *whole* goal (`runWriteAgent` suspends the entire goal today). Continuing mid-run is
  genuinely durable-orchestration shaped. This is where Temporal was always the real question.

Two earlier notes pointed at Temporal for D14-a. Both should be retired: the DEF-2 race that made
durability look mandatory **was fixed by WD-29 without Temporal**, and the phase-5 register's Temporal
line is about budget-exhaustion resume — D14-b, not D14-a.

**D14-a unblocks the assistant, PM `J2`, mail approvals, and most of the pipeline.** D14-b is now
**closed by policy** — OQ-2 chose re-run-from-the-top, so no durable mid-run resume is built and
**Temporal is not required for D14 at all**. That choice has a price, paid in per-tool idempotency:
§7.1.

## 6. How to fix it — D14-a

**Step 1 — stop conflating decision with execution (migration).** Add to `automation_approvals`:
`execution_status` (`not_applicable` | `pending` | `executing` | `executed` | `failed`),
`executed_at`, `executed_by`, `execution_error`, `execution_result` (jsonb), `execution_attempts`.
Keep `status` as the *human decision*. This alone stops the UI from lying, and it is the honest state
model everything else hangs off. Existing rows backfill to `not_applicable` — and per the
backfill-RLS trap, that backfill must be written so it can't silently affect zero rows.

**Step 2 — the missing consumer.** New `core/approval-execute.ts` registered as an
`automation_approval.decided` handler for `origin ∈ {automation, agent}` — mirroring
`applyLeaveDecision`, which is the working proof of the wiring. **No wiring change is needed:**
`"automation_approval"` is already in `startConsumerLoop`'s stream list in `main.ts`.

**Step 3 — an allow-list, not a generic bridge.** Resolve `tool_name` through an explicit registry of
executable-approved-writes. A generic "call any MCP tool from an approved row" bridge turns the
approvals inbox into a remote-code-execution surface, and it inherits none of the per-tool precondition
knowledge. Start with the tools that actually have suspended callers today.

**Step 4 — authority: re-drive as the ORIGINAL principal, lifting only the impact gate.**

This corrects the first draft of this plan, which recommended executing as the approver. Reading
`mcp-hub/src/policy.ts:44-51` settles it — the suspension is purely:

```ts
if (tool.write && tool.impact !== "low") {  // -> "suspend: ... requires human approval"
```

**Impact tier only.** Cerbos is a *separate, additional* check (`authorizeCall` = in-code AND Cerbos),
and the per-workflow `AUTOMATION_ALLOWLIST` is a third. So a suspended write is one the principal was
**already otherwise authorized to make** — it was stopped for being consequential, not for being
unauthorized.

That means executing as the approver would be **privilege amplification for no benefit**, and with
superadmin as the standing approver (locked below) the amplification is total: every approved
automation write would run with superadmin authority.

The correct rule:

- Re-drive as the **original filing principal** (`requested_by`).
- The approval lifts **only the impact suspension**, for **that one call**, single-use, keyed on the
  approval row id. It grants nothing else.
- The workflow allow-list, assurance, and every **other** Cerbos condition are re-evaluated
  **unchanged** at execution time; the approval lifts the impact suspension in **both** places it is
  encoded (see the 2026-08-05 correction below — the original "Cerbos unchanged" wording was wrong).
  If the workflow has since been de-scoped or the principal's role revoked, execution **fails** with
  a typed reason and the row goes `failed` — which is the correct outcome, and a strictly better
  failure mode than a superadmin executing it anyway.
- Record `executed_by` (the principal that ran it) separately from `decided_by` (the human who lifted
  the gate). They are different facts; conflating them destroys the audit trail's meaning.

This also keeps the human decision semantically honest: the approver is asked "should this
consequential write happen?", which is exactly the question the impact gate raised — not "should this
principal be granted new authority?"

> **Correction (2026-08-05, architect ruling during decomposition — ticket D14-13):** this step
> originally said "Cerbos … re-evaluated **unchanged**", a conclusion derived from reading
> `mcp-hub/src/policy.ts` alone. That reading was wrong: **the impact gate is encoded in TWO
> places.** `platform-nest/cerbos/policies/resource_mcp_tool.yaml`'s single `call` allow clause
> independently requires `!isAutomation || (name in automationScope && (!write || impact == "low"))`,
> and Cerbos is authoritative whenever `CERBOS_URL` is set — which it is for mcp-hub and
> mcp-hub-central in the prod compose. So a grant lifting only the in-code suspend branch still gets
> a Cerbos DENY, and every `origin='automation'` re-drive lands `failed` (only `origin='agent'`
> re-drives would work, since the gate never applied to non-n8n principals).
>
> **Ruled design:** the hub passes the **verified** grant's `approvalId` as a Cerbos resource
> attribute — set exclusively from the HMAC-verified grant object (signature + canonical-args
> digest + expiry + the platform-side single-use claim), never from caller input — and the policy's
> **impact conjunct only** gains the narrow disjunct
> `has(approvalId) && approvalId != "" && name in <explicit executable list>`, placed INSIDE the
> `automationScope` conjunction (so the workflow allow-list still binds) and list-narrowed (so even
> a hub bug asserting the attribute cannot lift the gate for money tools — SM-55/A13). This is
> acceptable because Cerbos already decides entirely from hub-asserted attributes here; the hub
> process is, and was, the enforcement boundary. The rule this step states is therefore: the
> approval lifts the impact suspension **in both encodings**; assurance, the workflow allow-list,
> and every OTHER Cerbos condition are re-evaluated unchanged. Same drift class as §7.1's
> two-independent-classifications hazard: one gate, two encodings — future impact-gate changes must
> touch both or fail closed.

**Step 5 — precondition re-check under a lock.** Inside the same transaction that moves the row to
`executing`, take the WD-29-style per-entity advisory lock and re-evaluate the tool's own precondition.
Refuse with a typed reason if the world moved; that refusal is a legitimate, *visible* outcome.

**Step 6 — terminal notify.** Tell the approver and the requester what actually happened. `failed`
must be loud — a bell and an email, not a log line.

**Step 7 — surface it.** The approvals UI shows execution state alongside decision state, with a retry
for `failed`. An approved-but-unexecuted row must be visibly distinguishable from a done one.

**Step 8 — tests that target the four hard questions,** not the happy path: redelivery of the same
event; a precondition that went stale between filing and decision; an approver who lost authority
between deciding and executing; execution failure leaving a `failed` row plus a notification; and a
falsifiability anchor that reproduces today's silent no-op.

## 7. Decisions locked (2026-08-05, owner)

| # | Decision | Consequence |
|---|---|---|
| **OQ-1** | **Approval is RBAC-role-based; superadmin approves for now and as the fallback.** | Orthogonal to *execution* authority — see §6 Step 4. Because superadmin is the standing approver, executing-as-approver is explicitly rejected: it would run every approved automation write with superadmin rights. Execution re-drives as the original principal with only the impact gate lifted. Cerbos already gates `decide` to `company_admin`/`group_executive` (+ `module_manager` for `origin=hr`); superadmin-as-fallback must be an *addition* to that, not a replacement, or the HR path regresses. |
| **OQ-2** | **Re-run suspended agent goals from the top** (no durable mid-run resume). | Closes D14-b by policy — **Temporal is not needed for D14 at all**. But it is not free: see §7.1, the re-run duplicate hazard. |
| **OQ-3** | **Allow-list starts with tools that have suspended callers today**, grown deliberately. | Concretely: `wf:delivery`'s `deploy.staging` / `deploy.production` (the WD-08 dead end) and `origin=agent` `high_write` tools. Note every other allow-listed write today is already LOW-impact, so it never suspends — the initial executable list is genuinely small. |
| **OQ-4** | **Auto-execute on approval.** | The decided event drives execution directly; no second click. Makes the `failed` path and its notification load-bearing — with auto-execute there is no human standing by to notice. |
| **OQ-5** | **Human-triggered retry in v1**, and the policy must be **settable in settings**. | Needs a settings home — there is none today, see §7.2. |

### 7.1 The re-run-from-the-top hazard (consequence of OQ-2)

`runWriteAgent` suspends the **whole goal**. A goal that committed low-impact writes at steps 1–6 and
suspended at step 7 will, on re-run, **redo steps 1–6**. Unguarded, that is the DEF-2 duplicate class
exactly: a task created twice, a stage created twice, a notification sent twice.

WD-29 already established the house fix and proved the naive half insufficient (a lock alone left 6
duplicate rows; the real fix was server-side re-evaluation of the caller's own precondition). So OQ-2
carries a hard requirement:

**Before enabling re-run-from-the-top, every low-impact write tool an agent goal can call must be
idempotent or dedupe on a stable key.** Until that holds per tool, a re-run is a duplicate generator.
Track this as an explicit checklist item per tool, not an assumption — and prefer failing a re-run
loudly over silently duplicating.

### 7.2 There is no settings surface yet (consequence of OQ-5)

Verified: no `platform_settings` / `app_settings` / `feature_flag` table exists, and no settings page
exists in `platform-ui`. The retry-policy toggle therefore needs a home. Two options:

1. **Cheap, recommended for v1:** store it in the existing **`companies.settings` jsonb** column under
   a namespaced key (e.g. `automation.approvalRetry`), surfaced on the existing
   `app/(app)/systems/automation` admin page. Zero new schema, already tenant-scoped by the row.
2. **Honest but larger:** a real `platform_settings` table (global default + per-tenant override) plus
   an admin settings page. Worth doing when the second and third setting arrive — do not build a
   settings *subsystem* to hold one boolean.

Either way the setting must be **read at execution time**, not cached at boot, or changing it appears
to do nothing until a redeploy.

## 8. Related

- `platform-nest/src/core/automation-approvals.controller.ts` — the surface, and the header comment
  that states the deferral
- `platform-nest/src/modules/hr/leave-decision.ts` — the one working resume handler; copy its shape
- `ai-agents/src/write-agent.ts` — the agent-side suspension (D13 then D14)
- `docs/superpowers/plans/2026-08-03-agentic-native-erp-plan.md` §criterion 4 — the readiness bar
- WD-29 in `docs/modules/CHANGELOG.md` — the lock + precondition-re-check precedent, incl. why the
  lock alone was proven insufficient
