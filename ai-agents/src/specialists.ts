// The first specialists (WS8 §2.1). Each: single responsibility, own prompt, own
// tool allow-list with impacts, own budget. All read-only in v1 — write-capable agents
// wait for the eval + tool-contract gates (D13) and the approval flow (D14).
import type { AgentDef } from "./agent";

export const statusReporter: AgentDef = {
  name: "status-reporter",
  systemPrompt:
    "You are Gaiada's project status reporter. Gather the company's projects and their tasks, then produce a concise, factual status report grouped by project. Never invent data — report only what the tools returned.",
  tools: {
    "projects.list": "read",
    "tasks.list": "read",
  },
  maxSteps: 8,
  maxToolCalls: 6,
};

export const approvalsChaser: AgentDef = {
  name: "approvals-chaser",
  systemPrompt:
    "You are Gaiada's approvals chaser. Find approvals that are waiting for a decision and produce a short nudge list: what is waiting, for which campaign, since when. Only report what the tools returned.",
  tools: {
    "agency.pendingApprovals": "read",
  },
  maxSteps: 4,
  maxToolCalls: 2,
};

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// P4-J5 — the PM read specialist (Phase-4 plan, workstream J: "The AI agents also capable of full
// access if the RBAC is enough"). Reads only — safe to reach through the plain supervisor/orchestrator
// path with no D13 gate, same as status-reporter/approvals-chaser above.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// All four tools are real, tenant-wide hub tools (mcp-hub/src/pm-tools.ts, P4-J1) — NOT the
// project-scoped tasks.list/tasks.get this agent could have reached for instead. Authorization is
// entirely the platform's: every call carries this run's OWN OBO envelope, so a triggering user with
// no PM role in a tenant gets exactly the 403/empty-result a human in their position would get — this
// AgentDef adds no role/tenant check of its own (the same non-negotiable the P4-J4 bot skill and this
// ticket's whole design rest on).
export const pmReporter: AgentDef = {
  name: "pm-reporter",
  systemPrompt:
    "You are Gaiada's PM reporter. Answer questions about tasks and projects tenant-wide: what's " +
    "assigned to someone, what's overdue or due soon, who currently holds the Ball on a task, who is " +
    "Responsible for it, and what open dependency is blocking it. Prefer pm.listTasks' own facets " +
    "(status/tag/priority/responsible/ball/dueSoon/overdueOnly/mine) over listing everything and " +
    "filtering yourself. Never invent a task, project, person, or blocker that a tool didn't return.",
  tools: {
    "pm.listTasks": "read",
    "pm.getTask": "read",
    "pm.listProjects": "read",
    "pm.taskAssignmentHistory": "read",
  },
  maxSteps: 8,
  maxToolCalls: 6,
};

export const specialists: Record<string, AgentDef> = {
  [statusReporter.name]: statusReporter,
  [approvalsChaser.name]: approvalsChaser,
  [pmReporter.name]: pmReporter,
};

// The first WRITE-CAPABLE specialist (WS8 Step B). It keeps the company's open tasks healthy with
// LOW-impact `tasks.update` writes (in-tenant, reversible, Cerbos+RLS enforced at the platform).
// D13: `evaledProviders` is EMPTY, so until an operator runs its eval + tool-contract suite against a
// real provider and adds that provider here, `runWriteAgent` serves it READ-ONLY. This is the correct
// safe default — write capability is earned per provider, never assumed. Run it through
// `runWriteAgent` (not the plain runner / supervisor) so the D13 gate + D14 approval-filing apply.
export const taskTriager: AgentDef = {
  name: "task-triager",
  systemPrompt:
    "You are Gaiada's task triager. Review the company's open tasks and keep them healthy: raise priority on overdue tasks and mark clearly-finished ones done. Change only what the returned data justifies; never invent tasks. Make one tool call at a time.",
  tools: {
    "tasks.list": "read",
    "tasks.update": "low_write", // auto per D14 (low + reversible); still Cerbos+RLS-gated at the platform
  },
  maxSteps: 10,
  maxToolCalls: 6,
  // D13 enrollment (2026-07-24): `openai` (Ollama Cloud, deepseek-v4-flash) cleared for task-triager —
  // eval/containment suite green (12 tests), tool-contract green (tasks.list read + tasks.update
  // low_write registered + Cerbos/impact-gated in the MCP hub), and the provider follows the tool-call
  // protocol live. Writes are LOW-impact (reversible, in-tenant) and STILL bounded by: the triggering
  // user's Cerbos permissions + RLS at the hub/platform, and the D14 impact gate (a high_write would
  // suspend for approval — task-triager has none). Revert to [] to force read-only. See
  // docs/runbooks/agent-evaled-providers-enrollment.md.
  evaledProviders: ["openai"],
};

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// T2 (ASST-23, §7.1) — `task-filer`: the assistant's first proposable write. Reachable ONLY through
// the platform-nest assistant broker's `writeSpecialists` route (`runner/service.ts` routes anything
// named here through `runWriteAgent` — the D13+D14-gated path; the plain `runAgent`/`traceRun`/
// orchestrator path would suspend WITHOUT filing, which is the wrong gate for a chat-triggered write —
// see this file's own header and D14-11's guard test for why that distinction is load-bearing).
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// WHY `high_write` HERE IS THE HONEST DECLARATION, NOT A DEMO HACK (preserve this reasoning — it is
// the crux of the whole ticket, not incidental color):
//
// The hub tier and this AgentDef's label answer TWO DIFFERENT QUESTIONS, and conflating them is the
// mistake this ticket exists to avoid making.
//
//   - The HUB tier (`mcp-hub/src/pm-tools.ts`: `pm.createTask`/`pm.createDoc` are both `impact:"low"`)
//     classifies the write's BLAST RADIUS for the automation gate: in-tenant, reversible, no external
//     effect. That is correct and it is LOAD-BEARING for a working program — `wf:report` (WD-06) calls
//     both tools unattended today, and the n8n suspend branch only fires on `impact !== "low"`
//     (`mcp-hub/src/policy.ts`'s `isAutomation` conjunct). Re-tiering either tool at the hub to justify
//     this ticket would suspend that pipeline for no reason — it would also be DISHONEST, because the
//     write genuinely IS low-impact when a human wired it into a scoped workflow with deterministic
//     inputs. Do NOT do this; it is listed as a rejected alternative in the design for exactly this
//     reason.
//   - This AgentDef's label answers a DIFFERENT question: "may an LLM commit this unattended, when IT
//     composed the arguments from a chat turn?" The blueprint's locked decision D-A is that every
//     assistant write becomes a proposal, never a silent commit — so `high_write` is the truthful
//     declaration of the policy actually in force for THIS caller, even though the SAME tool call made
//     by a human-authored n8n workflow is fine unattended. Same tool, same hub tier, two different
//     callers, two different risk postures — the AgentDef label is where that distinction lives.
//
// D14-12's stricter-wins reconciliation (`agent.ts`'s `effectiveImpact`) is what makes this SAFE to
// declare: the effective impact is `max(declared, registry)`, so a registry `"low"` never weakens a
// declared `high_write` back down — the exact case its own header pins as a test ("`high_write` +
// registry `"low"` ⇒ stays `high_write`"). Declaring `high_write` on a hub-`low` tool is therefore not
// a workaround, it is the mechanism D14-12 was built for.
//
// TWO PREREQUISITES, BOTH VERIFIED FOR BOTH TOOLS (see `agent-write-guard.test.ts`'s
// `RERUN_CAPABLE_HIGH_WRITES` and its header for the full citation):
//   (a) the live `AgentDeps.resolveApproval` transport — TRUE globally since D14-14
//       (`ai-agents/src/deps.ts`'s `liveDeps.resolveApproval` calls the hub's
//       `approvals.resolveExecute`, `mcp-hub/src/platform-write-tools.ts:345`).
//   (b) `platform-nest/src/core/approval-executables.ts`'s `registerPmExecutableApprovals()` registers
//       BOTH `pm.createTask` (a real `pmCreateTaskPrecondition`: project exists ∧ not archived ∧
//       assignee still an active member) and `pm.createDoc` (the shared `pmProjectPrecondition`: project
//       exists ∧ not archived) — neither is the fail-closed `NO_PRECONDITION_REASON` default.
//
// `pm.createDoc` ships alongside `pm.createTask` in v1 per the owner's OQ-1 answer (2026-08-06,
// design §7.1) — both tools are equally ready per (b) above (same registry function, same project
// precondition; `createDoc` simply has no assignee branch because the tool has no assignee field).
//
// evaledProviders: `openai` (Ollama Cloud, `deepseek-v4-flash` — the same "openai" gateway provider
// slot `task-triager` was enrolled on) — cleared 2026-08-06 after the eval + adversarial-containment
// suite (`evals/cases.ts`) went green on scripted deps and a live floor run (one protocol-adherence
// turn, one proposal-shaped turn per write tool, one containment probe — §7.3 of the design) confirmed
// the provider follows the strict single-JSON-action protocol and never escapes the allow-list. See
// `docs/superpowers/plans/2026-08-06-t2-task-filer-report.md` for the run transcript + quota consumed.
// Revert to [] to force read-only.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 2026-08-07 — LIVE INCIDENT: the model called `pm.listTasks` (at the time, on NEITHER this allow-list
// NOR the hub registry at all) and, before `agent.ts`'s recoverable-off-list fix landed alongside this
// change, that killed the whole turn.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// `agent.ts` now gives an off-list guess a bounded, recoverable nudge rather than ending the turn (see
// its own 2026-08-07 header) — that is the structural fix and it covers every specialist, not just this
// one. This systemPrompt change is the OTHER half: reduce the INVITATION to guess in the first place.
//
// WHY THIS AGENT IS THE ONE THAT INVITES IT: its own allow-list mixes two naming namespaces for one
// domain — reads under `projects.`/`tasks.` (`projects.list`, `tasks.list`) and creates under `pm.`
// (`pm.createTask`, `pm.createDoc`). A model that can see `pm.createTask` in its own tool list has every
// reason to guess a sibling `pm.listTasks` "read" by analogy — the exact guess that happened live. THAT
// INCONSISTENCY IS A KNOWN DESIGN WART, left as-is on purpose: `pm.createTask`/`pm.createDoc` are
// load-bearing across D14 (`agent-write-guard.test.ts`'s `RERUN_CAPABLE_HIGH_WRITES`), the hub registry
// (`mcp-hub/src/pm-tools.ts`), `wf:report`'s automation allowlist, and the Cerbos policy list — renaming
// either to match the `projects.`/`tasks.` namespace (or vice versa) would touch all four for a
// naming-hygiene reason alone, which is out of scope here. Naming the exact tools below, verbatim, is
// the cheaper mitigation that doesn't touch any of that surface.
//
// `projects.get`/`tasks.get` (single-resource reads, also real hub tools) were considered as additions
// to this allow-list — they would let the model resolve "the right project" without re-listing
// everything. NOT added here: doing so would also require widening platform-nest's broker mirrors
// (`ASSISTANT_AGENT_TOOLS`/`ASSISTANT_AGENT_WRITE_TOOLS` in
// `platform-nest/src/modules/assistant/broker.ts`) and confirming Cerbos's `mcp_tool` policy already
// makes them visible to an ordinary chatting user's OBO principal — a contract-surface change, not a
// naming fix, and outside this ticket's scope (see the 2026-08-07 off-list-recovery report).
//
// CORRECTION, 2026-08-08 (P4-J5): `pm.listTasks`/`pm.getTask` are no longer hypothetical — P4-J1 made
// both REAL, tenant-wide hub tools (`mcp-hub/src/pm-tools.ts`), and the `tool-aliases.ts` near-miss
// entry that used to redirect a guess of either name to `tasks.list`/`tasks.get` has been retired for
// exactly that reason (see that file's header). Neither is added to THIS agent's allow-list — its job
// stays narrowly "read via projects.list/tasks.list, write via pm.createTask/createDoc", and widening
// it is the same out-of-scope contract-surface change as `projects.get`/`tasks.get` above. The
// systemPrompt below is corrected to stop asserting `pm.listTasks` "does not exist" (now false) while
// still steering the model to the tools THIS agent actually has.
export const taskFiler: AgentDef = {
  name: "task-filer",
  systemPrompt:
    "You are Gaiada's task filer. Your ONLY callable tools are exactly these four — calling any other " +
    "name will be refused, even a real tool that exists elsewhere in the system: " +
    "projects.list (read all projects), tasks.list (read all tasks), pm.createTask (file a task), " +
    "pm.createDoc (file a project document). Reads live under the projects./tasks. names; creates live " +
    "under the pm. name — do NOT guess a tool name by analogy across those two (e.g. pm.listTasks is a " +
    "DIFFERENT tool you do not have; to read tasks, call tasks.list). When asked to create a task or a " +
    "project document, first call projects.list and tasks.list to find the right project (and, for a " +
    "task, a plausible assignee) before filing. File exactly the create you were asked for — never " +
    "invent a project, assignee, or extra task/doc nobody asked for. Make one tool call at a time; " +
    "every create you propose is reviewed by a human before it takes effect.",
  tools: {
    "projects.list": "read",
    "tasks.list": "read",
    "pm.createTask": "high_write",
    "pm.createDoc": "high_write",
  },
  maxSteps: 8,
  maxToolCalls: 4,
  evaledProviders: ["openai"],
};

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// SMM-35 — `social-drafter`: closing the assistant's "no social write reachable from chat" gap.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// Reachable ONLY through the platform-nest assistant broker's `writeSpecialists` route, same as
// `task-filer` above (`ai-agents/CLAUDE.md`'s D13/D14 gate; `runner/service.ts` routes any name in
// `writeSpecialists` through `runWriteAgent`).
//
// WHY `high_write` ON A HUB-`"low"` TOOL, AGAIN THE HONEST DIVERGENCE (see `taskFiler`'s own header
// for the fuller argument — restated briefly rather than re-derived from scratch):
//   - The HUB tier (`platform-nest/src/modules/social/index.ts`: `social.createReplyDraft` is
//     `write:true, impact:"low"`) answers "how much damage can this do" — an insert into OUR OWN row,
//     never sent, never network-visible, never client-visible. That is genuinely low blast radius.
//   - This AgentDef's label answers "may an LLM commit this unattended, when it composed the args
//     from a chat turn?" — D-A's answer is no, always, regardless of the hub tier. `high_write` is
//     the truthful declaration of the policy actually in force for THIS caller.
//
// TWO PREREQUISITES, BOTH VERIFIED FOR THIS TOOL (see `agent-write-guard.test.ts`'s
// `RERUN_CAPABLE_HIGH_WRITES` entry for `social.createReplyDraft` and its header for the full
// citation):
//   (a) the live `AgentDeps.resolveApproval` transport — TRUE globally since D14-14, unchanged by
//       this ticket.
//   (b) `platform-nest/src/core/approval-executables.ts`'s `registerSocialReplyDraftExecutableApproval()`
//       registers `social.createReplyDraft` with a real precondition (thread exists ∧ not deleted ∧
//       a non-empty body was proposed) — not the fail-closed `NO_PRECONDITION_REASON` default.
//
// DELIBERATELY NOT GIVEN `social.updateReplyDraft`/`social.approveReplyDraft`/`social.sendReply` —
// see `approval-executables.ts`'s own SMM-35 section for the full "what this pass did not expose, and
// why" reasoning (the send/publish tools stay excluded on SECURITY grounds, unrelated to file surface
// or registration).
//
// `evaledProviders` is EMPTY — the SAME safe default `task-triager`/`task-filer` shipped with before
// their own dedicated eval runs (see either header above). `evals/cases.ts`'s new social-drafter
// cases (baseline + injection containment) are the eval half of D13's gate; this file's own CLAUDE.md
// is explicit that an agent change without an eval case is unverifiable by construction. Running that
// suite against a REAL provider and adding it here — spending the shared, weekly-rate-limited Ollama
// Cloud quota to do so — is a follow-up an operator runs deliberately, per
// docs/runbooks/agent-evaled-providers-enrollment.md, not something this ticket spends unilaterally.
// Until then `runWriteAgent` forces this agent's `readOnlyProjection` — `social.listThreadMessages`
// still works today; the write is CONTAINED, not merely undeclared.
export const socialDrafter: AgentDef = {
  name: "social-drafter",
  systemPrompt:
    "You are Gaiada's social inbox reply drafter. Your ONLY callable tools are exactly these two: " +
    "social.listThreadMessages (read a thread's existing messages) and social.createReplyDraft " +
    "(propose a reply). ALWAYS call social.listThreadMessages first so your reply actually answers " +
    "what the thread says — never invent what a comment said. Draft exactly the reply you were asked " +
    "for, in the tone the user requested; never invent a thread, never send anything, and never call " +
    "any tool other than these two. Make one tool call at a time; every draft you propose is reviewed " +
    "by a human before it is even filed for approval, and reviewed again before it is ever sent.",
  tools: {
    "social.listThreadMessages": "read",
    "social.createReplyDraft": "high_write",
  },
  maxSteps: 6,
  maxToolCalls: 4,
  evaledProviders: [],
};

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// P4-J5 — the write-capable PM specialist ("the AI agents also capable of full access if the RBAC is
// enough" — owner request, 2026-08-04 Phase-4 plan, workstream J).
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// WHY `low_write` HERE IS THE HONEST LABEL, NOT A LOOSER ONE INVENTED FOR THIS TICKET: unlike
// `task-filer` above (whose `high_write` is a DELIBERATE divergence from the hub's `low` tier — see
// that section's header for why), this agent's write tools declare EXACTLY what
// `mcp-hub/src/pm-tools.ts` already declares for them: `pm.setStatus`, `pm.passBall`, `pm.setDueDate`
// are all `impact:"low"` (decision 16 of the Phase-4 plan). D14-12's stricter-wins reconciliation
// (`agent.ts`'s `effectiveImpact`) means declaring anything looser here would make no difference (the
// registry would promote it right back to `low_write`) and anything stricter would suspend a write the
// plan's own decision 16 says should run unattended — `low_write` is the one label that is actually
// TRUE, not a convenience.
//
// `pm.comment` is DELIBERATELY NOT on this allow-list, even though decision 16 also classifies it
// `impact:"low"` at the hub tier. Hub impact answers "how much damage can this do" (blast radius);
// this ticket also has to answer a SEPARATE question `agent-write-guard.test.ts`'s
// `VERIFIED_IDEMPOTENT_LOW_WRITES` exists to enforce — "does re-executing it with IDENTICAL arguments
// produce a second effect", because the owner's D14-b decision resumes a suspended goal by RE-RUNNING
// IT FROM THE TOP, replaying every low_write a prior attempt already committed. `pm.comment`'s target
// (`core/collab.controller.ts`'s `createComment`) mints a fresh id and unconditionally INSERTs with no
// dedup key — two identical re-runs create two comment rows. `pm.setStatus`/`pm.passBall`/
// `pm.setDueDate` are all provably idempotent instead (see that file's own header for the per-tool
// proof against `pm.controller.ts`'s actual handlers); the difference is why three of the four decision-
// 16 writes are here and the fourth is a named follow-up, not an oversight.
//
// `pm.setStatus` is also the one tool of the three with a REAL server-side refusal mode: with chain
// enforcement (P4-I1) a move into a non-`isBlocked` "started" status 409s when the task has open
// dependencies, and the platform's `{error}` body names the blocker verbatim
// (`cannot move to "doing": blocked by 1 open dependency (Design mockup)`). `deps.callTool` throws on
// any non-2xx (see `ai-agents/src/deps.ts`'s `callTool`), and `agent.ts`'s low_write path (the `try`
// around `deps.callTool` at the bottom of `runAgent`) already turns that throw into a transcript line
// the model reads on its NEXT turn — `TOOL pm.setStatus FAILED: <message>` — so the systemPrompt below
// only needs to tell the model what to DO with that fact (stop retrying the same move, report or
// resolve the blocker) rather than re-plumb the failure path itself.
//
// evaledProviders is EMPTY — the SAME safe default `task-triager` and `task-filer` shipped with before
// their own dedicated eval runs (see either of their headers above for the reasoning). This is not a
// smaller ticket doing less than asked: decision 16 already made these writes safe to run unattended AT
// THE HUB TIER (Cerbos + RLS + the append-only ball ledger — migration 0087 — are what make that safe,
// not an approval queue). D13's `evaledProviders` gate answers an ORTHOGONAL question — has THIS
// specific model, for THIS agent's own prompt, been proven to follow the strict single-JSON tool-call
// protocol and stay on its allow-list — and assuming that without running the eval + tool-calling
// contract suite (`evals/cases.ts`) would be assuming reliability nobody verified. Until an operator
// runs that suite against a real provider and adds it here, `runWriteAgent` (`write-agent.ts`) forces
// this agent's `readOnlyProjection` — i.e. its four `pm.*` reads still work today; the writes are
// contained, not merely undeclared. See docs/runbooks/agent-evaled-providers-enrollment.md to enroll a
// provider.
export const pmTaskManager: AgentDef = {
  name: "pm-task-manager",
  systemPrompt:
    "You are Gaiada's PM task manager. You may read tenant-wide task/project data (pm.listTasks, " +
    "pm.getTask, pm.listProjects, pm.taskAssignmentHistory) and act on a single task: move its status " +
    "(pm.setStatus), pass its Ball to a person (pm.passBall), or set/clear its due date " +
    "(pm.setDueDate). You cannot post comments — that tool is not available to you. If pm.setStatus is " +
    "REFUSED with a message naming an open dependency (e.g. 'blocked by 1 open dependency (Design " +
    "mockup)'), do NOT retry the same status — that task genuinely cannot move yet; report the named " +
    "blocker instead, or resolve it first. Change only what you were asked to change; never invent a " +
    "task, project, or person. Make one tool call at a time.",
  tools: {
    "pm.listTasks": "read",
    "pm.getTask": "read",
    "pm.listProjects": "read",
    "pm.taskAssignmentHistory": "read",
    "pm.setStatus": "low_write",
    "pm.passBall": "low_write",
    "pm.setDueDate": "low_write",
  },
  maxSteps: 10,
  maxToolCalls: 6,
  evaledProviders: [],
};

/** Write-capable specialists — driven via runWriteAgent (D13 provider gate + D14 approval filing),
 *  deliberately NOT in the read-only supervisor set until the orchestrator routes writes through the
 *  same gate (WS8 Step B follow-up). */
export const writeSpecialists: Record<string, AgentDef> = {
  [taskTriager.name]: taskTriager,
  [taskFiler.name]: taskFiler,
  [pmTaskManager.name]: pmTaskManager,
  [socialDrafter.name]: socialDrafter,
};

/** The default supervisor over all registered specialists (WS8 §2.2). */
export const supervisor = {
  name: "supervisor",
  systemPrompt:
    "You are the Gaiada work supervisor. Decompose the goal into subtasks for your specialists, then aggregate their blackboard results into one coherent answer. Be factual; report failures honestly.",
  specialists,
  maxPlannerSteps: 10,
  maxSubRuns: 5,
  goalBudget: { modelCalls: 40, toolCalls: 20 },
};
