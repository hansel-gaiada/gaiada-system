// SCP-5h / W5-C3 (docs/FRONTEND-BFF-CONTRACT.md §63.29.1) — PM's `project` template: its payload, and THE DATE MATHS of applying
// it. PURE: no database, no clock, no config. The routes (pm.controller.ts) read the template, the company's calendar and the
// clock, and call these.
//
// Nothing here knows about Social. Any department may keep a project template; Social's onboarding is one user of it.
//
// ── THE PAYLOAD ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
//   {title, phases: [{key, title}] (1 to 12), roles: [{key, label}] (1 to 10),
//    tasks: [{key, title <= 200, description? <= 2,000, phase, role, dueOffsetWorkingDays: 0 to 250, subtasks?: string[] <= 20}] (1 to 80)}
// Keys are unique within each list, and a task's `phase` and `role` name the template's own. A refusal is 400 `invalid_field`
// with `field: "payload.<path>"` (`payload.tasks.3.phase`). The validator answers a NORMALIZED copy (trimmed strings, known keys
// only), which is what the database stores, the way the `task` and `doc` kinds already work.
//
// ── THE WORKING DAY ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// The company's default HR holiday calendar (`loadWorkingCalendar`), or Monday to Friday when it has none: the same calendar,
// through the same `hr/working-days.ts` primitive (`countWorkingDays`), that Social's schedule health counts with. The two
// helpers below are the same definitions as `social/pipeline/schedule-health.ts`'s (a pin in the pure test compares them), kept
// here so PM does not import Social's module (that file loads Social's stage-machine fixture at import).
//
// DUE DATE of a task = `dueOffsetWorkingDays` working days after the START DAY, where the start day is the kickoff when it is a
// working day, else the first working day after it ("a kickoff on a day off counts from the next working day"). The start day
// itself is never counted, so offset 0 is the start day: a Saturday kickoff with offset 0 is due the Monday.
// START DATE of every task is the kickoff as typed (§63.29.1: "starting on the kickoff").
// A MILESTONE per phase is due on its last task's day (the latest due date of the phase's tasks); a phase with no task has none.
import { BadRequestException } from "@nestjs/common";
import { addDays, countWorkingDays, type WorkingCalendar } from "../hr/working-days";

export const PROJECT_TEMPLATE_LIMITS = {
  phases: { min: 1, max: 12 },
  roles: { min: 1, max: 10 },
  tasks: { min: 1, max: 80 },
  subtasks: { max: 20 },
  offset: { min: 0, max: 250 },
  titleMax: 200,
  descriptionMax: 2000,
  labelMax: 120,
  keyMax: 40,
} as const;

export interface ProjectTemplatePhase { key: string; title: string }
export interface ProjectTemplateRole { key: string; label: string }
export interface ProjectTemplateTask {
  key: string;
  title: string;
  description?: string;
  phase: string;
  role: string;
  dueOffsetWorkingDays: number;
  subtasks?: string[];
}
export interface ProjectTemplatePayload {
  title: string;
  phases: ProjectTemplatePhase[];
  roles: ProjectTemplateRole[];
  tasks: ProjectTemplateTask[];
}

/** A key: lower-case letters, digits, `_` and `-`, starting with a letter or digit (it appears in `people.<role>` field paths). */
const KEY_RE = /^[a-z0-9][a-z0-9_-]*$/;

const bad = (path: string): BadRequestException => new BadRequestException({ message: "invalid_field", field: `payload${path ? `.${path}` : ""}` });

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function text(v: unknown, path: string, max: number, required = true): string | undefined {
  if (v === undefined && !required) return undefined;
  if (typeof v !== "string") throw bad(path);
  const t = v.trim();
  if ((required && t.length === 0) || t.length > max) throw bad(path);
  return t;
}

function key(v: unknown, path: string): string {
  if (typeof v !== "string" || v.length === 0 || v.length > PROJECT_TEMPLATE_LIMITS.keyMax || !KEY_RE.test(v)) throw bad(path);
  return v;
}

function list(v: unknown, path: string, min: number, max: number): unknown[] {
  if (!Array.isArray(v) || v.length < min || v.length > max) throw bad(path);
  return v;
}

/** Validate and normalize a `project` template payload (BFF §63.29.1). Throws 400 `invalid_field` `{field: "payload.<path>"}`. */
export function validateProjectTemplatePayload(payload: unknown): ProjectTemplatePayload {
  const L = PROJECT_TEMPLATE_LIMITS;
  if (!isObject(payload)) throw bad("");
  const title = text(payload.title, "title", L.titleMax)!;

  const phaseKeys = new Set<string>();
  const phases = list(payload.phases, "phases", L.phases.min, L.phases.max).map((p, i): ProjectTemplatePhase => {
    if (!isObject(p)) throw bad(`phases.${i}`);
    const k = key(p.key, `phases.${i}.key`);
    if (phaseKeys.has(k)) throw bad(`phases.${i}.key`);
    phaseKeys.add(k);
    return { key: k, title: text(p.title, `phases.${i}.title`, L.labelMax)! };
  });

  const roleKeys = new Set<string>();
  const roles = list(payload.roles, "roles", L.roles.min, L.roles.max).map((r, i): ProjectTemplateRole => {
    if (!isObject(r)) throw bad(`roles.${i}`);
    const k = key(r.key, `roles.${i}.key`);
    if (roleKeys.has(k)) throw bad(`roles.${i}.key`);
    roleKeys.add(k);
    return { key: k, label: text(r.label, `roles.${i}.label`, L.labelMax)! };
  });

  const taskKeys = new Set<string>();
  const tasks = list(payload.tasks, "tasks", L.tasks.min, L.tasks.max).map((t, i): ProjectTemplateTask => {
    if (!isObject(t)) throw bad(`tasks.${i}`);
    const k = key(t.key, `tasks.${i}.key`);
    if (taskKeys.has(k)) throw bad(`tasks.${i}.key`);
    taskKeys.add(k);
    const out: ProjectTemplateTask = {
      key: k,
      title: text(t.title, `tasks.${i}.title`, L.titleMax)!,
      phase: key(t.phase, `tasks.${i}.phase`),
      role: key(t.role, `tasks.${i}.role`),
      dueOffsetWorkingDays: 0,
    };
    if (!phaseKeys.has(out.phase)) throw bad(`tasks.${i}.phase`);
    if (!roleKeys.has(out.role)) throw bad(`tasks.${i}.role`);
    const off = t.dueOffsetWorkingDays;
    if (typeof off !== "number" || !Number.isInteger(off) || off < L.offset.min || off > L.offset.max) {
      throw bad(`tasks.${i}.dueOffsetWorkingDays`);
    }
    out.dueOffsetWorkingDays = off;
    // An empty description is the same as none (the editor sends "" for a cleared field).
    const description = text(t.description, `tasks.${i}.description`, L.descriptionMax, false);
    if (description) out.description = description;
    if (t.subtasks !== undefined) {
      const subs = list(t.subtasks, `tasks.${i}.subtasks`, 0, L.subtasks.max).map((s, j) => text(s, `tasks.${i}.subtasks.${j}`, L.titleMax)!);
      if (subs.length > 0) out.subtasks = subs;
    }
    return out;
  });

  return { title, phases, roles, tasks };
}

// ── Dates ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day `YYYY-MM-DD` between 2000 and 2100 (what a kickoff may be; the table's CHECK holds the same range). */
export function isKickoffDate(v: unknown): v is string {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false;
  const ms = Date.parse(`${v}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== v) return false;
  return v >= "2000-01-01" && v <= "2100-12-31";
}

/** Scans never run longer than this many calendar days: a calendar with no working day at all must end, not loop. */
const MAX_SCAN_DAYS = 400;

/** True when `iso` is a working day of `calendar`. Same definition as schedule-health's `isWorkingDay`. */
export function isWorkingDay(iso: string, calendar: WorkingCalendar): boolean {
  return countWorkingDays(iso, iso, calendar).workingDays === 1;
}

/** The first working day on or after `iso` (`iso` unchanged when the scan finds none). Same as schedule-health's. */
export function firstWorkingDayOnOrAfter(iso: string, calendar: WorkingCalendar): string {
  let d = iso;
  for (let i = 0; i < MAX_SCAN_DAYS; i++) {
    if (isWorkingDay(d, calendar)) return d;
    d = addDays(d, 1);
  }
  return iso;
}

/** Step `n >= 0` working days forward from `iso`; `iso` itself is never counted. Same as schedule-health's `addWorkingDays` for n >= 0. */
export function addWorkingDaysForward(iso: string, n: number, calendar: WorkingCalendar): string {
  let left = Math.max(0, Math.trunc(n));
  let d = iso;
  let scanned = 0;
  while (left > 0 && scanned < MAX_SCAN_DAYS * 40) {
    d = addDays(d, 1);
    scanned += 1;
    if (isWorkingDay(d, calendar)) left -= 1;
  }
  return d;
}

/** A task's due date: `offset` working days after the kickoff's start day (the kickoff, or the next working day after a day off). */
export function templateDueDate(kickoff: string, offset: number, calendar: WorkingCalendar): string {
  return addWorkingDaysForward(firstWorkingDayOnOrAfter(kickoff, calendar), offset, calendar);
}

/**
 * The holiday window a caller must load the calendar for (`loadWorkingCalendar(tenantId, from, to)`): from the kickoff to far
 * enough past it that `maxOffset` working days always land inside it. Two calendar days per working day plus a month covers a
 * five-day week with every public holiday of Indonesia's calendar several times over; past the window a day counts as working.
 */
export function templateCalendarWindow(kickoff: string, maxOffset: number): { from: string; to: string } {
  return { from: kickoff, to: addDays(kickoff, Math.max(0, maxOffset) * 2 + 30) };
}

export function maxOffsetOf(payload: ProjectTemplatePayload): number {
  return payload.tasks.reduce((m, t) => Math.max(m, t.dueOffsetWorkingDays), 0);
}

export interface PlannedTask {
  key: string;
  title: string;
  description: string;
  phase: string;
  role: string;
  subtasks: string[];
  startDate: string;
  dueDate: string;
}
export interface PlannedMilestone { phase: string; title: string; dueDate: string | null }

/** The latest of `dates`, or null for none. ISO dates compare as strings. */
export function lastDay(dates: readonly string[]): string | null {
  return dates.reduce<string | null>((m, d) => (m === null || d > m ? d : m), null);
}

/** What applying `payload` on `kickoff` makes: a task per template task (in template order) and a milestone per phase (in phase order). */
export function planApplication(payload: ProjectTemplatePayload, kickoff: string, calendar: WorkingCalendar): { tasks: PlannedTask[]; milestones: PlannedMilestone[] } {
  const tasks = payload.tasks.map((t): PlannedTask => ({
    key: t.key,
    title: t.title,
    description: t.description ?? "",
    phase: t.phase,
    role: t.role,
    subtasks: t.subtasks ?? [],
    startDate: kickoff,
    dueDate: templateDueDate(kickoff, t.dueOffsetWorkingDays, calendar),
  }));
  const milestones = payload.phases.map((p): PlannedMilestone => ({
    phase: p.key,
    title: p.title,
    dueDate: lastDay(tasks.filter((t) => t.phase === p.key).map((t) => t.dueDate)),
  }));
  return { tasks, milestones };
}

/** One task of an application as it stands, for the kickoff move. */
export interface AppliedTaskState { key: string; taskId: string; phase: string; dueDate: string | null; done: boolean; live: boolean }

/**
 * The kickoff move (§63.29.1 `PATCH template-applications/:id`): each LIVE task NOT YET DONE re-dates to its template offset from
 * the new kickoff (its start date becomes the new kickoff); a done task, or one deleted since, never moves. A task whose key the
 * applied copy no longer names (it cannot happen through the routes) keeps its date. Each phase's milestone is then due on the
 * latest due date among the phase's live tasks, moved or not (null when none is left).
 */
export function planKickoffMove(
  payload: ProjectTemplatePayload,
  kickoff: string,
  calendar: WorkingCalendar,
  applied: readonly AppliedTaskState[],
  milestones: readonly { phase: string; milestoneId: string }[],
): { moves: { taskId: string; startDate: string; dueDate: string }[]; milestones: { phase: string; milestoneId: string; dueDate: string | null }[] } {
  const offsetByKey = new Map(payload.tasks.map((t) => [t.key, t.dueOffsetWorkingDays]));
  const moves: { taskId: string; startDate: string; dueDate: string }[] = [];
  const dueAfter = new Map<string, string | null>();
  for (const t of applied) {
    const offset = offsetByKey.get(t.key);
    if (t.live && !t.done && offset !== undefined) {
      const due = templateDueDate(kickoff, offset, calendar);
      moves.push({ taskId: t.taskId, startDate: kickoff, dueDate: due });
      dueAfter.set(t.taskId, due);
    } else {
      dueAfter.set(t.taskId, t.dueDate);
    }
  }
  return {
    moves,
    milestones: milestones.map((m) => ({
      ...m,
      dueDate: lastDay(applied.filter((t) => t.phase === m.phase && t.live).map((t) => dueAfter.get(t.taskId)).filter((d): d is string => !!d)),
    })),
  };
}
