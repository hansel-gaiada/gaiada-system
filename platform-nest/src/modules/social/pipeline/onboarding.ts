// SCP-5h (W5-C4) — client onboarding's Social half, the PURE part (FRONTEND-BFF-CONTRACT §63.29; SCP-Q35, SCP-Q36; plan §4.5, SCP-D4).
//
// Onboarding is a PM project template applied to the client's own project: no second task system. This file holds what is
// pure: the start body, the default people, the checklist's shape and the order of the list. `onboarding-data.ts` reads the rows,
// `onboarding.controller.ts` asks the gates and calls PM's `applyProjectTemplate`.
//
// THE START BODY (§63.29.4): `{id, kickoff, people?}`. `id` is the caller's application id (a replay answers the same application),
// `kickoff` a real `YYYY-MM-DD`, `people` an optional `{<roleKey>: userId | null}` that overrides the defaults below. A refusal is
// 400 `invalid_field` with `field`.
//
// THE DEFAULT PEOPLE (§63.29.4): "`people` defaults to the engagement's officer for `officer` and the caller for `lead`; the body
// may name others". The seed's third role, `client`, is the client's to provide, and PM has no client assignee, so the start maps
// it to the officer, who chases it (§63.29.3). A default is only given to a role the company's template HAS (PM refuses a role the
// template does not name, 400 `people.<role>`, and a company may have renamed its roles); the body's own `people` is passed as it is.
import { BadRequestException } from "@nestjs/common";
import { PROJECT_TEMPLATE_LIMITS, isKickoffDate } from "../../pm/project-templates";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const badField = (field: string): BadRequestException => new BadRequestException({ message: "invalid_field", field });

export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

export interface StartBody {
  id: string;
  kickoff: string;
  /** What the body named; `undefined` keys take the defaults. A `null` leaves the role unassigned. */
  people: Record<string, string | null>;
}

/** PURE. Validates the start body. 400 `invalid_field` `{field}`. */
export function parseStartBody(body: unknown): StartBody {
  const b = (body !== null && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  if (!isUuid(b.id)) throw badField("id");
  if (!isKickoffDate(b.kickoff)) throw badField("kickoff");
  const people: Record<string, string | null> = {};
  if (b.people !== undefined && b.people !== null) {
    if (typeof b.people !== "object" || Array.isArray(b.people)) throw badField("people");
    const entries = Object.entries(b.people as Record<string, unknown>);
    if (entries.length > PROJECT_TEMPLATE_LIMITS.roles.max) throw badField("people");
    for (const [role, userId] of entries) {
      if (userId === null) { people[role] = null; continue; }
      if (!isUuid(userId)) throw badField(`people.${role}`);
      people[role] = userId.toLowerCase();
    }
  }
  return { id: b.id.toLowerCase(), kickoff: b.kickoff, people };
}

/**
 * PURE. The people PM's apply gets: for each role the template has, the body's person when it names one (a `null` leaves the role
 * unassigned), else the default (`officer` and `client`: the engagement's officer; `lead`: the caller). A role with no person to
 * default to is left out, so its tasks have no Ball and no Responsible.
 */
export function startPeople(
  roleKeys: readonly string[], named: Record<string, string | null>, officerId: string | null, callerId: string,
): Record<string, string | null> {
  const out: Record<string, string | null> = { ...named };
  for (const role of roleKeys) {
    if (Object.prototype.hasOwnProperty.call(named, role)) continue;
    const person = role === "lead" ? callerId : role === "officer" || role === "client" ? officerId : null;
    if (person) out[role] = person;
  }
  return out;
}

// ── The answer ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One step of a client's checklist: a PM task made by the template, with its place in the template. */
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

/** Why a client cannot be started (the words the page shows beside the button), or null when it can. */
export type StartBlock = "no_project" | "onboarding_template_not_set" | null;

export interface OnboardingItem {
  engagementId: string;
  clientId: string;
  clientName: string;
  engagementStatus: string;
  officer: { id: string; name: string } | null;
  /** The client's own ERP project (the one the tasks are made in), or null. */
  projectId: string | null;
  applicationId: string | null;
  kickoff: string | null;
  progress: { done: number; total: number };
  next: { taskId: string; title: string; dueDate: string | null; late: boolean } | null;
  baselineAudit: { auditId: string; status: string; overall: number | null } | null;
  /** The checklist in the template's order; empty before onboarding starts. */
  steps: OnboardingStep[];
  /** The project's done status, which ticking a step moves its task to (PM's own `PATCH tasks/:taskId`). */
  doneStatusId: string | null;
  startBlock: StartBlock;
}

export interface OnboardingAnswer {
  template: { id: string; name: string } | null;
  items: OnboardingItem[];
  /** The four (`social_engagement` · `plan`): whether the caller may start onboarding and move a kickoff's page controls show. */
  canStart: boolean;
}

/** PURE. A step is late when it is open and due before `today`. */
export const isLateDay = (dueDate: string | null, done: boolean, today: string): boolean => !done && dueDate !== null && dueDate < today;

/** PURE. Why this client cannot be started: no live project, or no company template. The project comes first, as the route's order does. */
export function startBlockOf(projectId: string | null, template: { id: string } | null): StartBlock {
  if (!projectId) return "no_project";
  if (!template) return "onboarding_template_not_set";
  return null;
}

/**
 * PURE. The page's order: clients with an application first, the soonest next step first (a client with nothing left to do and no date
 * after the dated ones), then the clients not started, by name.
 */
export function sortOnboarding(items: readonly OnboardingItem[]): OnboardingItem[] {
  const started = (i: OnboardingItem): boolean => i.applicationId !== null;
  return [...items].sort((a, z) => {
    if (started(a) !== started(z)) return started(a) ? -1 : 1;
    if (started(a)) {
      const ad = a.next?.dueDate ?? null;
      const zd = z.next?.dueDate ?? null;
      if (ad !== zd) return ad === null ? 1 : zd === null ? -1 : ad < zd ? -1 : 1;
    }
    return a.clientName.localeCompare(z.clientName) || a.engagementId.localeCompare(z.engagementId);
  });
}

/** PURE. Whether an application still has a task open: it is listed while it does (§63.29.4). */
export const hasOpenTask = (progress: { done: number; total: number }): boolean => progress.done < progress.total;
