// "My tasks" (DW-8a, docs/plans/2026-10-13-department-workspaces.md §8): the pure rules behind /me/tasks.
// No React and no server imports, so the page stays thin and every rule is a plain unit test.
import type { AgendaTaskRow } from "@/lib/agenda";

/** Statuses that mean "no longer on the person's plate". `isDoneStatus` in `pm.ts` is server-only and knows
 *  only the literal `done` (a project may flag its own statuses done, which a row from `/api/tasks/mine`
 *  does not carry), so this is the client-safe superset: the PM ladder's `done`, the base task and project
 *  vocabulary's `complete(d)`, and the cancelled-like ends. Anything else, including an unknown status,
 *  counts as open: an unknown status must never hide work. */
const FINISHED = new Set(["done", "complete", "completed", "closed", "cancelled", "canceled", "archived"]);

export function isFinishedStatus(status: string | null | undefined): boolean {
  return FINISHED.has(String(status ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_"));
}

/** Today's date as YYYY-MM-DD, taken the way the Overview's Today block does (the queue's `urgencyBand`
 *  measures from the runtime's local start of day), so the two pages never disagree. */
export function todayIsoOf(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${m}-${d}`;
}

export type MyTaskGroupKey = "overdue" | "today" | "week" | "later" | "none";
export interface MyTaskGroup { key: MyTaskGroupKey; label: string; rows: AgendaTaskRow[] }

const ORDER: { key: MyTaskGroupKey; label: string }[] = [
  { key: "overdue", label: "Overdue" },
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "later", label: "Later" },
  { key: "none", label: "No due date" },
];

// Whole days from `fromIso` to `toIso`, both YYYY-MM-DD, computed in UTC so no zone or DST shifts a day.
function dayDiff(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.slice(0, 10).split("-").map(Number);
  const [ty, tm, td] = toIso.slice(0, 10).split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/** Buckets rows by due date relative to `todayIso`: overdue (before today), today, this week (the next 6
 *  days), later, and no due date. Empty groups are omitted; within a group the reader's order is kept. */
export function groupMyTasks(rows: readonly AgendaTaskRow[], todayIso: string): MyTaskGroup[] {
  const buckets = new Map<MyTaskGroupKey, AgendaTaskRow[]>(ORDER.map((g) => [g.key, []]));
  for (const row of rows) {
    let key: MyTaskGroupKey = "none";
    if (row.dueDate && /^\d{4}-\d{2}-\d{2}/.test(row.dueDate)) {
      const n = dayDiff(todayIso, row.dueDate);
      key = n < 0 ? "overdue" : n === 0 ? "today" : n <= 6 ? "week" : "later";
    }
    buckets.get(key)!.push(row);
  }
  return ORDER.map((g) => ({ key: g.key, label: g.label, rows: buckets.get(g.key)! })).filter((g) => g.rows.length > 0);
}
