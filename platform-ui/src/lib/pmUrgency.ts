// Urgency: overdue · almost late · in time (P4-G1/G2, plan
// `2026-08-04-pm-repsona-parity-phase4-plan.md` workstream G).
//
// ONE definition, consumed by every surface that shows a task or project. The whole point of the
// feature is glanceability across many projects, so two surfaces disagreeing about whether
// something is late defeats it entirely — a board card contradicting the row above it is worse
// than no indicator at all. Hence: pure, tested, zero-I/O, and the only place the rule lives.
//
// Client-safe by design (same split rationale as `pmRecurrence.ts` / `tagColors.ts`): `lib/pm.ts`
// is `server-only`, but the board cards, Gantt bars and List rows that render urgency are CLIENT
// components, so the rule cannot live there. `pm.ts` re-exports this module so server callers keep
// importing from "./pm". This file deliberately has NO imports at all.
//
// `today` is a REQUIRED parameter, never read from the clock in here. Two reasons, both real:
//   1. Hydration. `Date.now()` on the server and on the client straddle midnight differently, and
//      locale/timezone divergence is a documented trap in this codebase (see charts/chartHover.ts).
//      The server resolves "today" once per render and passes it down; every consumer of one page
//      then agrees by construction.
//   2. Testability. Every case below is a plain string pair.
//
// Owner decisions encoded here (2026-08-06):
//   - The tier is computed from stored facts ONLY — no manual "at risk" flag, no per-task override.
//     Urgency is objective or it is not trustworthy.
//   - DATES ONLY, not progress-weighted. A single amber badge that silently mixes "the date is
//     close" with "you haven't done enough" stops being trusted the first time someone disputes it.
//     A progress-weighted RISK signal is a separate, separately-labelled thing (deferred).
//   - Default window is 3 days, configurable per project.

/** Calendar-day tier. `undated` is a real answer, not a missing one — most tasks have no due date. */
export type UrgencyTier = "done" | "overdue" | "due-soon" | "on-track" | "undated";

/** Default "almost late" window, in calendar days. Per-project override via `UrgencyOptions`. */
export const DUE_SOON_DAYS_DEFAULT = 3;

/**
 * `isDone` is passed in rather than derived: done-ness comes from the task's own project's status
 * registry (`isDoneStatus` in the server-only `pm.ts`), which this client-safe module cannot reach.
 * Same precedent as every other precomputed prop the server hands to these client components.
 */
export interface UrgencyInput {
  dueDate: string | null; // "YYYY-MM-DD"
  isDone: boolean;
}

export interface UrgencyOptions {
  /** "Almost late" window in calendar days. Defaults to `DUE_SOON_DAYS_DEFAULT`. */
  dueSoonDays?: number;
}

/** Ordered worst → best. Drives `rollUpUrgency` and gives every consumer one sort order. */
export const URGENCY_SEVERITY: UrgencyTier[] = ["overdue", "due-soon", "on-track", "undated", "done"];

export const URGENCY_LABEL: Record<UrgencyTier, string> = {
  overdue: "Overdue",
  "due-soon": "Almost late",
  "on-track": "In time",
  undated: "No due date",
  done: "Done",
};

const DAY_MS = 86_400_000;

/** True for a well-formed "YYYY-MM-DD". Guards against a backend sending a full ISO timestamp. */
function isDayString(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * Whole calendar days from `from` to `to` (negative when `to` is earlier). Parsed as UTC midnight
 * so the result is a pure calendar difference with no timezone or DST component — the reason both
 * arguments are date STRINGS and not `Date`s. A full ISO timestamp is tolerated by truncating to
 * its date part, so one stray backend field can't silently produce fractional-day nonsense.
 */
export function dayDiff(from: string, to: string): number {
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / DAY_MS);
}

/**
 * The rule. `done` outranks everything: a finished task never glows red on a board, however late
 * it was (the owner's "was late" marker belongs in history views, which need a completion date we
 * do not currently store — deliberately out of scope here).
 *
 * Boundaries, pinned by tests because they are what people notice: due TODAY is `due-soon`, not
 * overdue — you still have the day. Due exactly `dueSoonDays` out is `due-soon`; one day further
 * is `on-track`. `dueSoonDays: 0` therefore means "warn only on the due date itself".
 */
export function taskUrgency(task: UrgencyInput, today: string, opts: UrgencyOptions = {}): UrgencyTier {
  if (task.isDone) return "done";
  const due = task.dueDate;
  if (!due || !isDayString(due.slice(0, 10))) return "undated";
  const window = Math.max(0, opts.dueSoonDays ?? DUE_SOON_DAYS_DEFAULT);
  const days = dayDiff(today, due);
  if (days < 0) return "overdue";
  if (days <= window) return "due-soon";
  return "on-track";
}

/**
 * Worst tier in a set. `undated` and `done` never win: a project whose only signal is "some tasks
 * have no due date" is not more urgent than one running on time, and an all-done set is `done`.
 * Empty (or all-`undated`) collapses to the least-alarming tier actually present.
 */
export function rollUpUrgency(tiers: UrgencyTier[]): UrgencyTier {
  if (tiers.length === 0) return "undated";
  for (const tier of URGENCY_SEVERITY) {
    if (tiers.includes(tier)) return tier;
  }
  return "undated";
}

export interface UrgencyRollUp {
  /** Worst tier present — what a project row/card shows at a glance. */
  tier: UrgencyTier;
  /** Per-tier counts, so a card can say "2 overdue, 5 almost late" without re-walking the tasks. */
  counts: Record<UrgencyTier, number>;
}

/**
 * Project-grain roll-up (P4-G2) — the half that makes "glancing many projects" work. Without it,
 * urgency only ever answers a question about one task and a portfolio view stays blind.
 *
 * `projectDueDate` (the authored target from workstream H) is folded in as one more input, so a
 * project that has slipped past its own target reads as overdue even when every remaining task is
 * comfortably scheduled — which is exactly the case a task-only roll-up hides.
 */
export function projectUrgency(
  tasks: UrgencyInput[],
  today: string,
  opts: UrgencyOptions & { projectDueDate?: string | null; projectIsDone?: boolean } = {},
): UrgencyRollUp {
  const tiers = tasks.map((t) => taskUrgency(t, today, opts));
  if (opts.projectDueDate !== undefined) {
    tiers.push(taskUrgency({ dueDate: opts.projectDueDate, isDone: opts.projectIsDone ?? false }, today, opts));
  }
  const counts: Record<UrgencyTier, number> = { done: 0, overdue: 0, "due-soon": 0, "on-track": 0, undated: 0 };
  for (const t of tiers) counts[t] += 1;
  return { tier: rollUpUrgency(tiers), counts };
}
