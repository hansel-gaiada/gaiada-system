// The shared ranked-list model — UX-2 §1.4 `NeedsMeQueue`. Pure (no fetches),
// so both Home variants and the department console rail (R-1 projection) can
// share one scoring function with no server dependency. Ship with a
// documented default weighting (Q13 left open by the owner — see
// docs/superpowers/specs/2026-07-20-daily-work-ux-spec.md §7): overdue
// approvals/gates first, then overdue tasks, then due-today items by due
// time, then everything else by age descending. Tuning the weights below is a
// one-file change.
export type QueueItemType = "approval" | "gate" | "task" | "mention";

export interface QueueItem {
  id: string;
  type: QueueItemType;
  /** Which origin-specific decide endpoint a decidable item routes through
   *  (mirrors contract §9(a)'s `origin`); undefined for tasks/mentions. */
  origin?: "agency" | "automation" | "pipeline";
  /** The origin's own record id (what its decide endpoint expects) — kept
   *  separate from `id` (this queue's own composite, globally-unique React
   *  key) so a decide action never has to parse a string apart. */
  originId?: string;
  title: string;
  meta?: string; // secondary caption — campaign name, project name, "waiting on X"
  companyId: string;
  company: string;
  href?: string; // deep-link; undefined renders unlinked text, never a dead link
  dueDate?: string | null; // ISO date, undefined/null when there is none
  createdAt: string; // ISO — required, used for age tie-breaks
  /** true if the requesting principal may act on THIS item (approvals.decide
   *  for its company; always true for task/mention "Open" navigation). */
  decidable: boolean;
  urgencyScore: number; // set by computeUrgency; 0 until scored
}

// Named weight table (Q13's one-file tuning knob) — four strict tiers, exactly
// the doc's documented default: (1) approvals/gates always rank as needing a
// decision NOW — our data model gives them no due date at all, so "overdue
// approvals/gates first" is read as "all pending approvals/gates are already
// in the top tier"; (2) overdue tasks; (3) due-today tasks; (4) everything
// else (not-yet-due tasks, mentions), ranked by age descending. Tiers are
// separated by a wide gap so no in-tier modifier can ever cross a boundary.
export const TIER_WEIGHT = {
  approvalOrGate: 30_000,
  overdueTask: 20_000,
  dueToday: 10_000,
  rest: 0,
} as const;

const OVERDUE_PER_DAY = 10;
const OVERDUE_CAP_DAYS = 365;
const AGE_CAP_DAYS = 60; // in-tier age tie-break cap (tiers 1/3)
const AGE_WEIGHT_REST = 100; // primary sort key within tier 4 ("age descending")
const PROXIMITY_CAP_DAYS = 30; // small same-age tie-break nudge within tier 4

const DAY_MS = 24 * 3600 * 1000;

function daysUntil(dueDate: string, now: Date): number {
  const due = new Date(dueDate);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor((due.getTime() - startOfToday.getTime()) / DAY_MS);
}

function ageDays(createdAt: string, now: Date): number {
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return 0;
  return Math.max(0, Math.floor((now.getTime() - created.getTime()) / DAY_MS));
}

/** Pure scoring function — higher sorts first. Never mutates `item`. */
export function computeUrgency(
  item: Pick<QueueItem, "type" | "dueDate" | "createdAt">,
  now = new Date(),
): number {
  if (item.type === "approval" || item.type === "gate") {
    return TIER_WEIGHT.approvalOrGate + Math.min(ageDays(item.createdAt, now), AGE_CAP_DAYS);
  }
  if (item.dueDate) {
    const days = daysUntil(item.dueDate, now);
    if (days < 0) {
      return TIER_WEIGHT.overdueTask + Math.min(-days, OVERDUE_CAP_DAYS) * OVERDUE_PER_DAY;
    }
    if (days === 0) {
      return TIER_WEIGHT.dueToday + Math.min(ageDays(item.createdAt, now), AGE_CAP_DAYS);
    }
  }
  // Tier 4 — "everything else, by age descending." A small proximity nudge
  // breaks same-day ties in favour of the nearer due date without ever
  // outweighing age (AGE_WEIGHT_REST dwarfs PROXIMITY_CAP_DAYS).
  const age = ageDays(item.createdAt, now);
  const proximity = item.dueDate
    ? Math.max(0, PROXIMITY_CAP_DAYS - Math.min(daysUntil(item.dueDate, now), PROXIMITY_CAP_DAYS))
    : 0;
  return TIER_WEIGHT.rest + age * AGE_WEIGHT_REST + proximity;
}

/** Ranked-list bucket for the row's urgency dot (NOW/TODAY/SOON, UX-2 §1.2 mockup). */
export type UrgencyBand = "now" | "today" | "soon";

export function urgencyBand(
  item: Pick<QueueItem, "type" | "dueDate">,
  now = new Date(),
): UrgencyBand {
  if (item.type === "approval" || item.type === "gate") return "now";
  if (item.dueDate) {
    const days = daysUntil(item.dueDate, now);
    if (days < 0) return "now";
    if (days === 0) return "today";
  }
  return "soon";
}

/** Scores + sorts a list of items, urgency descending (stable on ties by id
 *  so re-renders don't jitter row order). Does not mutate the input array. */
export function rankByUrgency<T extends Pick<QueueItem, "type" | "dueDate" | "createdAt" | "id">>(
  items: T[],
  now = new Date(),
): (T & { urgencyScore: number })[] {
  return items
    .map((item) => ({ ...item, urgencyScore: computeUrgency(item, now) }))
    .sort((a, b) => (b.urgencyScore - a.urgencyScore) || a.id.localeCompare(b.id));
}
