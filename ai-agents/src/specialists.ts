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
  evaledProviders: [], // none cleared yet ⇒ forced read-only until a provider passes this agent's evals
};

/** Write-capable specialists — driven via runWriteAgent (D13 provider gate + D14 approval filing),
 *  deliberately NOT in the read-only supervisor set until the orchestrator routes writes through the
 *  same gate (WS8 Step B follow-up). */
export const writeSpecialists: Record<string, AgentDef> = {
  [taskTriager.name]: taskTriager,
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
