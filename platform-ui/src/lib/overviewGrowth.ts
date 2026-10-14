// DW-3g: the Overview's Growth band, as data: Learning and Appraisal, both about the signed-in person. Each block is
// what its reader said, kept in the three kinds of `ReadResult`, so a refused or failed read can never become
// "nothing assigned" or "no appraisal yet" (plan §3.3, §3.7). Everything here is pure; the widgets do the reading.
import type { ReadResult } from "./readResult";
import type { MyLearning, MyEnrollment } from "./lms";
import type { AppraisalPack, AppraisalStatus } from "./appraisals";

export const LEARNING_HREF = "/me/learning";
export const APPRAISAL_HREF = "/appraisals/mine";

// ── Learning ─────────────────────────────────────────────────────────────────────────────────────

export interface NextDue { title: string; dueOn: string; overdue: boolean }

export type LearningView =
  | {
    kind: "ok";
    /** Assigned or in progress: what is still to do (the same "outstanding" /me/learning counts). */
    outstanding: number;
    inProgress: number;
    /** Outstanding items the backend flags overdue. */
    overdue: number;
    /** The soonest-due outstanding item that has a due date; null when none is dated. */
    nextDue: NextDue | null;
  }
  | { kind: "forbidden" }
  | { kind: "unavailable" };

const isOutstanding = (e: Pick<MyEnrollment, "status">): boolean => e.status === "assigned" || e.status === "in_progress";

/** The counts come only from a successful read, and only from what the type carries: there is no per-course progress
 *  here, so "next course" is "next due". An overdue item is still the soonest due (its date has passed). */
export function learningView(result: ReadResult<MyLearning>): LearningView {
  if (result.kind !== "ok") return { kind: result.kind };
  const open = result.data.enrolments.filter(isOutstanding);
  const dated = open
    .filter((e) => !!e.dueOn && !Number.isNaN(new Date(e.dueOn).getTime()))
    .sort((a, b) => new Date(a.dueOn as string).getTime() - new Date(b.dueOn as string).getTime() || a.title.localeCompare(b.title));
  const first = dated[0];
  return {
    kind: "ok",
    outstanding: open.length,
    inProgress: open.filter((e) => e.status === "in_progress").length,
    overdue: open.filter((e) => e.overdue).length,
    nextDue: first ? { title: first.title, dueOn: first.dueOn as string, overdue: first.overdue } : null,
  };
}

// ── Appraisal ────────────────────────────────────────────────────────────────────────────────────

/** A status in words, as the person would say it. */
export function appraisalStatusText(s: AppraisalStatus): string {
  switch (s) {
    case "draft": return "Draft";
    case "submitted": return "Submitted to you";
    case "acknowledged": return "Acknowledged";
    case "disputed": return "Disputed";
    case "finalized": return "Finalized";
  }
}

/** The subject's own next step, from the status alone. Only `submitted` asks something of them (acknowledge or
 *  dispute). After that the move is the manager's or HR's, and a draft is never shown to its subject, so both say none. */
export function appraisalNextStep(s: AppraisalStatus): string | null {
  return s === "submitted" ? "Read it, then acknowledge or dispute it" : null;
}

export interface AppraisalCurrent { cycleName: string; status: AppraisalStatus; statusText: string; nextStep: string | null }
export interface AppraisalLast { cycleName: string; composite: number | null; scoreText: string | null; finalizedAt: string | null }

export type AppraisalView =
  | { kind: "ok"; current: AppraisalCurrent | null; last: AppraisalLast | null }
  | { kind: "forbidden" }
  | { kind: "unavailable" };

type PackFields = Pick<AppraisalPack, "cycleName" | "status" | "composite" | "submittedAt" | "finalizedAt" | "createdAt">;

const at = (v: string | null | undefined): number => {
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isNaN(t) ? 0 : t;
};

/** "4.25 of 5": the same figure and scale the pack view shows as its composite score. */
export const scoreText = (composite: number | null): string | null => (composite === null ? null : `${composite.toFixed(2)} of 5`);

/** The current pack is the latest one not finalized; the last result is the latest finalized one. An empty `ok` (no
 *  pack at all) is a real "No appraisal yet"; a failed read never reaches it. */
export function appraisalView(result: ReadResult<{ appraisals: readonly PackFields[] }>): AppraisalView {
  if (result.kind !== "ok") return { kind: result.kind };
  const packs = result.data.appraisals;
  const newest = (a: PackFields, b: PackFields) => at(b.submittedAt ?? b.createdAt) - at(a.submittedAt ?? a.createdAt);
  const cur = packs.filter((p) => p.status !== "finalized").sort(newest)[0];
  const fin = packs.filter((p) => p.status === "finalized").sort((a, b) => at(b.finalizedAt ?? b.createdAt) - at(a.finalizedAt ?? a.createdAt))[0];
  return {
    kind: "ok",
    current: cur ? { cycleName: cur.cycleName, status: cur.status, statusText: appraisalStatusText(cur.status), nextStep: appraisalNextStep(cur.status) } : null,
    last: fin ? { cycleName: fin.cycleName, composite: fin.composite, scoreText: scoreText(fin.composite), finalizedAt: fin.finalizedAt } : null,
  };
}
