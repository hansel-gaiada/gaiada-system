// Team activity for a head (DW-4i, docs/FRONTEND-BFF-CONTRACT.md section 44.9) as pure rules: the periods, the window a
// period covers, one row per person with their counts BY KIND, and the units a caller may pick. No React and no server
// imports, so every rule here is a plain unit test.
//
// DW-D19: no ranking, no total, no sort by volume. Rows are sorted by NAME and carry counts by kind, never a sum. A person
// whose series was refused or failed to read is a row that says "Unavailable", never a row of zeros.
import { addDaysIso } from "@/lib/checkins";
import {
  countsByKind, countsPhrase, weekStartOf, type ActivitySeries,
} from "@/lib/activitySeriesFormat";

// ── Periods ───────────────────────────────────────────────────────────────────────────────────────

export const TEAM_PERIODS = [
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
  { key: "quarter", label: "This quarter" },
] as const;
export type TeamPeriod = (typeof TEAM_PERIODS)[number]["key"];
export const DEFAULT_TEAM_PERIOD: TeamPeriod = "month";

/** Only an exact period key counts; anything else, forged or repeated, is the default. A repeated param uses its first. */
export function parseTeamPeriod(raw: string | readonly string[] | null | undefined): TeamPeriod {
  const v = typeof raw === "string" || raw == null ? raw : raw[0];
  return TEAM_PERIODS.some((p) => p.key === v) ? (v as TeamPeriod) : DEFAULT_TEAM_PERIOD;
}

/** The first day of `period` ending on `to` (the server's today): the Monday of the week, the 1st of the month, or the 1st
 *  of the calendar quarter. */
export function periodStart(period: TeamPeriod, to: string): string {
  if (period === "week") return weekStartOf(to);
  if (period === "month") return `${to.slice(0, 7)}-01`;
  const month = Number(to.slice(5, 7));
  const quarterFirst = Math.floor((month - 1) / 3) * 3 + 1;
  return `${to.slice(0, 4)}-${String(quarterFirst).padStart(2, "0")}-01`;
}

/** The `from` to request: 100 days back, enough for the longest period (a quarter is at most 92 days) with slack for a server
 *  whose "today" is a day either side of this machine's. `to` is left out, so the server decides what today is, and every
 *  period is cut from the answer's own `to` (`countsInPeriod`). */
export function teamRequestFrom(clientToday: string): string {
  return addDaysIso(clientToday, -100);
}

/** One person's counts by kind over `period`, cut from a series that ends on the server's today. */
export function countsInPeriod(series: ActivitySeries, period: TeamPeriod): { from: string; to: string; counts: Record<string, number> } {
  const from = periodStart(period, series.to);
  const counts: Record<string, number> = {};
  for (const d of series.days) {
    if (d.date < from || d.date > series.to) continue;
    for (const [k, n] of Object.entries(d.counts)) counts[k] = (counts[k] ?? 0) + n;
  }
  return { from, to: series.to, counts };
}

// ── Rows ──────────────────────────────────────────────────────────────────────────────────────────

export interface TeamPerson { userId: string; name: string }
/** What one person's series read said: the series, a refusal, or a failure. */
export type TeamRead = { kind: "ok"; data: ActivitySeries } | { kind: "forbidden" } | { kind: "error"; reason: string };

export type TeamRow =
  | { userId: string; name: string; state: "ok"; /** "Commits 4, Site edits 2", the server's labels; empty when nothing was recorded. */ phrase: string; kinds: { key: string; label: string; n: number }[] }
  | { userId: string; name: string; state: "unavailable" };

export interface TeamActivity {
  rows: TeamRow[];
  /** The period's first and last day, from the first person who could be read; null when nobody could. */
  from: string | null;
  to: string | null;
}

/** Rows by NAME (then by id), never by volume. A person whose read was refused or failed is "unavailable" on their own row. */
export function buildTeamActivity(people: readonly TeamPerson[], reads: readonly TeamRead[], period: TeamPeriod): TeamActivity {
  let from: string | null = null;
  let to: string | null = null;
  const rows: TeamRow[] = people.map((p, i) => {
    const read = reads[i];
    if (!read || read.kind !== "ok") return { userId: p.userId, name: p.name, state: "unavailable" as const };
    const cut = countsInPeriod(read.data, period);
    if (from === null) { from = cut.from; to = cut.to; }
    const kinds = countsByKind(cut.counts, read.data.kinds);
    return { userId: p.userId, name: p.name, state: "ok" as const, phrase: countsPhrase(cut.counts, read.data.kinds), kinds };
  });
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));
  return { rows, from, to };
}

// ── Units a caller may pick ───────────────────────────────────────────────────────────────────────

interface UnitNode { id: string; name: string; kind: string; children?: readonly UnitNode[] }

function findNode(root: UnitNode, id: string): UnitNode | null {
  if (root.id === id) return root;
  for (const c of root.children ?? []) {
    const n = findNode(c, id);
    if (n) return n;
  }
  return null;
}

/** Departments and divisions under `starts` (the whole tree when null), as options by name. A led unit brings everything
 *  beneath it. A mirror of the server, never the authority: the roster read and every person's series are gated there. */
export function unitOptions(root: UnitNode, starts: readonly string[] | null): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const add = (n: UnitNode) => {
    if ((n.kind === "department" || n.kind === "division") && !out.some((o) => o.value === n.id)) out.push({ value: n.id, label: n.name });
    for (const c of n.children ?? []) add(c);
  };
  if (starts === null) add(root);
  else for (const id of starts) { const n = findNode(root, id); if (n) add(n); }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}
