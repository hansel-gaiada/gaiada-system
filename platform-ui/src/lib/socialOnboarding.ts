// SCP-5h (BFF §63.29.4, §63.29.5) — client onboarding's types and pure helpers. No server-only import, so a client component may import the values.
//
// Onboarding is a PM project template applied to the client's own project, so a step is an ordinary PM task: ticking it and moving the kickoff are PM's own
// routes with PM's own gates, which the server actions call (`socialOnboardingActions.ts`). The list and the start are Social's (`socialOnboarding-data.ts`).
//
// The answers are parsed defensively (`asOnboarding`): a 200 with the wrong shape must read as "cannot tell", never as a plausible-looking empty list.
import { PLAN_REFUSAL_REASON } from "./socialCycles";

export interface OnboardingStep {
  key: string;
  taskId: string;
  title: string;
  phase: string;
  phaseTitle: string;
  role: string;
  roleLabel: string;
  dueDate: string | null;
  done: boolean;
  late: boolean;
}

export type StartBlock = "no_project" | "onboarding_template_not_set";

export interface OnboardingItem {
  engagementId: string;
  clientId: string;
  clientName: string;
  engagementStatus: string;
  officer: { id: string; name: string } | null;
  projectId: string | null;
  applicationId: string | null;
  kickoff: string | null;
  progress: { done: number; total: number };
  next: { taskId: string; title: string; dueDate: string | null; late: boolean } | null;
  baselineAudit: { auditId: string; status: "draft" | "final"; overall: number | null } | null;
  steps: OnboardingStep[];
  doneStatusId: string | null;
  startBlock: StartBlock | null;
}

export interface Onboarding {
  template: { id: string; name: string } | null;
  items: OnboardingItem[];
  canStart: boolean;
}

// ── Parsing ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

function asStep(raw: unknown): OnboardingStep {
  if (!isObj(raw) || typeof raw.taskId !== "string" || typeof raw.title !== "string") throw new Error("onboarding: not a step");
  return {
    key: str(raw.key) ?? raw.taskId, taskId: raw.taskId, title: raw.title, phase: str(raw.phase) ?? "", phaseTitle: str(raw.phaseTitle) ?? str(raw.phase) ?? "",
    role: str(raw.role) ?? "", roleLabel: str(raw.roleLabel) ?? str(raw.role) ?? "", dueDate: str(raw.dueDate), done: raw.done === true, late: raw.late === true,
  };
}

function asItem(raw: unknown): OnboardingItem {
  if (!isObj(raw) || typeof raw.engagementId !== "string" || typeof raw.clientName !== "string") throw new Error("onboarding: not a row");
  const p = isObj(raw.progress) ? raw.progress : {};
  const next = isObj(raw.next) && typeof raw.next.title === "string"
    ? { taskId: str(raw.next.taskId) ?? "", title: raw.next.title, dueDate: str(raw.next.dueDate), late: raw.next.late === true }
    : null;
  const a = isObj(raw.baselineAudit) && typeof raw.baselineAudit.auditId === "string" ? raw.baselineAudit : null;
  const block = raw.startBlock === "no_project" || raw.startBlock === "onboarding_template_not_set" ? raw.startBlock : null;
  return {
    engagementId: raw.engagementId, clientId: str(raw.clientId) ?? "", clientName: raw.clientName, engagementStatus: str(raw.engagementStatus) ?? "",
    officer: isObj(raw.officer) && typeof raw.officer.id === "string" ? { id: raw.officer.id, name: str(raw.officer.name) ?? "" } : null,
    projectId: str(raw.projectId), applicationId: str(raw.applicationId), kickoff: str(raw.kickoff),
    progress: { done: int(p.done) ?? 0, total: int(p.total) ?? 0 }, next,
    baselineAudit: a ? { auditId: a.auditId as string, status: a.status === "final" ? "final" : "draft", overall: typeof a.overall === "number" ? a.overall : null } : null,
    steps: Array.isArray(raw.steps) ? raw.steps.map(asStep) : [],
    doneStatusId: str(raw.doneStatusId), startBlock: block,
  };
}

/** `GET onboarding`. Throws on a body that is not one. */
export function asOnboarding(raw: unknown): Onboarding {
  if (!isObj(raw) || !Array.isArray(raw.items)) throw new Error("onboarding: not a list");
  const t = isObj(raw.template) && typeof raw.template.id === "string" ? { id: raw.template.id, name: str(raw.template.name) ?? "" } : null;
  return { template: t, items: raw.items.map(asItem), canStart: raw.canStart === true };
}

/** What `POST engagements/:id/onboarding` answers (PM's apply): the application and its tasks. */
export interface StartedOnboarding { applicationId: string; taskCount: number }
export function asStarted(raw: unknown): StartedOnboarding {
  if (!isObj(raw) || typeof raw.applicationId !== "string") throw new Error("onboarding: not an application");
  return { applicationId: raw.applicationId, taskCount: Array.isArray(raw.tasks) ? raw.tasks.length : 0 };
}

// ── What the page draws ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface PhaseGroup { phase: string; title: string; steps: OnboardingStep[]; done: number; late: number }

/** The checklist by phase, in the template's order (the first step of a phase fixes the phase's place). */
export function groupByPhase(steps: readonly OnboardingStep[]): PhaseGroup[] {
  const out: PhaseGroup[] = [];
  for (const s of steps) {
    let g = out.find((x) => x.phase === s.phase);
    if (!g) { g = { phase: s.phase, title: s.phaseTitle, steps: [], done: 0, late: 0 }; out.push(g); }
    g.steps.push(s);
    if (s.done) g.done += 1;
    if (s.late) g.late += 1;
  }
  return out;
}

export const lateCount = (i: OnboardingItem): number => i.steps.filter((s) => s.late).length;

/** "5 of 15 steps", or "Not started". */
export function progressText(i: OnboardingItem): string {
  if (i.applicationId === null) return "Not started";
  if (i.progress.total === 0) return "No steps";
  return `${i.progress.done} of ${i.progress.total} steps`;
}

export const progressPercent = (i: OnboardingItem): number => (i.progress.total === 0 ? 0 : Math.round((100 * i.progress.done) / i.progress.total));

/** Why the "Start onboarding" button cannot be used, in words; null when it can. The server's own gate still decides. */
export function startBlockWords(i: OnboardingItem, canStart: boolean): string | null {
  if (!canStart) return PLAN_REFUSAL_REASON.replace("change this", "start onboarding");
  if (i.startBlock === "no_project") return "This client has no ERP project yet, so there is nowhere to make the tasks. Add the project to the client first.";
  if (i.startBlock === "onboarding_template_not_set") return "The company has not chosen an onboarding template yet. Choose one in Settings.";
  return null;
}

export const ONBOARDING_PATH = (deptId: string): string => `/departments/${encodeURIComponent(deptId)}/onboarding`;
export const projectHref = (projectId: string): string => `/projects/${encodeURIComponent(projectId)}`;
export const auditHref = (deptId: string, auditId: string): string => `/departments/${encodeURIComponent(deptId)}/social-audit/${encodeURIComponent(auditId)}`;
export const allocationHref = (deptId: string): string => `/departments/${encodeURIComponent(deptId)}/allocation`;

/** A real calendar day `YYYY-MM-DD` between 2000 and 2100: the kickoff the server accepts. null is fine; otherwise the problem in words. */
export function kickoffProblem(text: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "Choose the kickoff day.";
  const ms = Date.parse(`${text}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== text || text < "2000-01-01" || text > "2100-12-31") return "That is not a day the kickoff can be.";
  return null;
}

// ── Words for a refusal ──────────────────────────────────────────────────────────────────────────────────────────────────

export type OnboardingWrite = "start" | "tick" | "move" | "audit";

/**
 * The sentence for a refusal of an onboarding write (the token itself stays the contract). A bare 403 is PM's own gate (the project's manage right for a start or a
 * move, the task's update right for a tick), so it says which.
 */
export function onboardingRefusalText(code: string, kind: OnboardingWrite, field?: string): string {
  switch (code) {
    case "not_a_social_approver": return kind === "audit" ? PLAN_REFUSAL_REASON : PLAN_REFUSAL_REASON.replace("change this", "start onboarding");
    case "automation_cannot_act": return "An automated account cannot do this.";
    case "engagement_not_found": return "This client is no longer in the list. Reload the page and try again.";
    case "no_project": return "This client has no ERP project yet, so there is nowhere to make the tasks. Add the project to the client first.";
    case "onboarding_template_not_set": return "The company has not chosen an onboarding template yet. Choose one in Settings.";
    case "template_already_applied": return "Onboarding was already started for this client. Reload the page to see it.";
    case "application_not_found": return "This onboarding no longer exists. Reload the page.";
    case "session_expired": return "Session expired — sign in again.";
    case "no_company": return "No active company selected.";
    case "invalid_field": {
      if (field === "kickoff") return "Choose a real kickoff day.";
      if (field === "id") return "Something went wrong with the request. Reload the page and try again.";
      if (field?.startsWith("people")) return "A person named for a step must be an active member of this company.";
      return field ? `${field} is not valid.` : "A value is not valid.";
    }
    default:
      if (code.startsWith("not authorized")) {
        if (kind === "start") return "Starting onboarding also needs the right to manage this client's project. Ask the Social Media head or the project's manager.";
        if (kind === "move") return "Moving the kickoff needs the right to manage this client's project.";
        if (kind === "tick") return "You cannot change this step.";
        return "You cannot do this.";
      }
      return code;
  }
}
