// SCP-5f (BFF §63.27.4) — the monthly cycle's steps as `GET cycles/:cycleId/health` answers them (`steps`, `stepsReason`): the types, the defensive parser and the
// words the Plan tab's strip draws. No server-only import, so a client component may import the values.
//
// The steps are the company's own (BFF §63.30, `cycle.steps`): the server names their keys, titles and order, so nothing here lists them. A step's state is its PM
// task's: done or open, late once past its due date. The strip says each state in words ("Late, was due 12 Feb"); colour is only a second signal.

export type StepsReason = "no_project" | "project_not_found";

export interface CycleStep {
  step: string;
  title: string;
  /** The step's PM task, or null for a cycle made before the steps existed (no task yet). */
  taskId: string | null;
  dueDate: string | null;
  done: boolean;
  /** 0 to 99 until done, 100 when done. */
  progress: number;
  /** `auto`: the pipeline closes and reopens it; `manual`: it is closed by hand only. */
  autoClose: "auto" | "manual";
  /** The role holding an open step ("The officer"), never a person. */
  holder: string | null;
  late: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** The steps of a health answer: `null` when the answer carries no `steps` at all (an older server: the strip says nothing, it does not claim "no steps"). */
export function asCycleSteps(raw: unknown): CycleStep[] | null {
  if (!Array.isArray(raw)) return null;
  const out: CycleStep[] = [];
  for (const r of raw) {
    if (!isObj(r) || typeof r.step !== "string" || !r.step) continue;
    const done = r.done === true;
    const n = typeof r.progress === "number" && Number.isFinite(r.progress) ? Math.round(r.progress) : 0;
    out.push({
      step: r.step, title: str(r.title) ?? r.step, taskId: str(r.taskId), dueDate: str(r.dueDate), done,
      progress: done ? 100 : Math.max(0, Math.min(99, n)),
      autoClose: r.autoClose === "manual" ? "manual" : "auto",
      holder: isObj(r.holder) ? str(r.holder.label) : null,
      // A done step is never late, whatever the server said: the words must not contradict each other.
      late: !done && r.late === true,
    });
  }
  return out;
}

export function asStepsReason(raw: unknown): StepsReason | null {
  return raw === "no_project" || raw === "project_not_found" ? raw : null;
}

// ── The words ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Why a cycle has no steps, in a sentence. */
export const STEPS_REASON_TEXT: Readonly<Record<StepsReason, string>> = {
  no_project: "This client has no project, so its monthly steps have no tasks. Link a project to the client and they are made the next time the cycle is saved.",
  project_not_found: "This client's project was deleted, so its monthly steps have no tasks.",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "12 Feb" from `YYYY-MM-DD`; an unreadable date reads "an unknown day". */
export function dayText(iso: string | null): string {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  if (!m) return "an unknown day";
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? "?"}`;
}

export type StepState = "done" | "late" | "open" | "untracked";
export const stepStateOf = (s: Pick<CycleStep, "done" | "late" | "taskId">): StepState => (s.done ? "done" : s.late ? "late" : s.taskId === null ? "untracked" : "open");

/**
 * The state in words, never colour alone: "Done", "Late, was due 12 Feb", "Open, due 20 Feb", "Open, no due date", or "No task yet" for a step the cycle has no task for.
 * A step the pipeline never closes says so beside it ("closed by hand only").
 */
export function stepStateText(s: Pick<CycleStep, "done" | "late" | "taskId" | "dueDate" | "autoClose" | "progress">): string {
  const state = stepStateOf(s);
  const base =
    state === "done" ? "Done"
    : state === "late" ? `Late, was due ${dayText(s.dueDate)}`
    : state === "untracked" ? "No task yet"
    : s.dueDate ? `Open, due ${dayText(s.dueDate)}` : "Open, no due date";
  const progress = (state === "open" || state === "late") && s.progress > 0 ? `, ${s.progress}% of the way` : "";
  const manual = s.autoClose === "manual" && state !== "untracked" ? ", closed by hand only" : "";
  return `${base}${progress}${manual}`;
}

/** The strip's heading line: how many steps are done, and how many are late ("2 of 6 done, 1 late"). */
export function stepsSummary(steps: readonly CycleStep[]): string {
  const done = steps.filter((s) => s.done).length;
  const late = steps.filter((s) => s.late && !s.done).length;
  return `${done} of ${steps.length} done${late > 0 ? `, ${late} late` : ""}`;
}

/** Where a step opens: its PM task. */
export const stepTaskHref = (taskId: string): string => `/tasks/${encodeURIComponent(taskId)}`;
