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

export const specialists: Record<string, AgentDef> = {
  [statusReporter.name]: statusReporter,
  [approvalsChaser.name]: approvalsChaser,
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
// 2026-08-07 — LIVE INCIDENT: the model called `pm.listTasks` (does not exist anywhere — not on this
// allow-list, not in the hub registry) and, before `agent.ts`'s recoverable-off-list fix landed
// alongside this change, that killed the whole turn.
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
export const taskFiler: AgentDef = {
  name: "task-filer",
  systemPrompt:
    "You are Gaiada's task filer. Your ONLY callable tools are exactly these four — there is no " +
    "pm.listTasks, tasks.read, or any other name, and calling anything else will be refused: " +
    "projects.list (read all projects), tasks.list (read all tasks), pm.createTask (file a task), " +
    "pm.createDoc (file a project document). Reads live under the projects./tasks. names; creates live " +
    "under the pm. name — do NOT guess a tool name by analogy across those two (e.g. there is no " +
    "pm.listTasks: to read tasks, call tasks.list). When asked to create a task or a project document, " +
    "first call projects.list and tasks.list to find the right project (and, for a task, a plausible " +
    "assignee) before filing. File exactly the create you were asked for — never invent a project, " +
    "assignee, or extra task/doc nobody asked for. Make one tool call at a time; every create you " +
    "propose is reviewed by a human before it takes effect.",
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

/** Write-capable specialists — driven via runWriteAgent (D13 provider gate + D14 approval filing),
 *  deliberately NOT in the read-only supervisor set until the orchestrator routes writes through the
 *  same gate (WS8 Step B follow-up). */
export const writeSpecialists: Record<string, AgentDef> = {
  [taskTriager.name]: taskTriager,
  [taskFiler.name]: taskFiler,
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
