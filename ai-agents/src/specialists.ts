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
