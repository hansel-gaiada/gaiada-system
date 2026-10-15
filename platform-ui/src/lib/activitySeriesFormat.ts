// The activity series as pure rules (DW-4h-3 and DW-4i, docs/FRONTEND-BFF-CONTRACT.md section 44): the wire types of
// `GET /activity/series` and `GET /activity/day`, and the cells of a year map, a day's tooltip, the kinds legend and a day's
// items grouped by kind. No React and no server imports, so the Overview block, the Analytics pages and the tests share them.
//
// DW-D19 holds throughout: no single score. A day's total (the sum of its counts) is only a SHADE and is always worded as
// volume ("5 things done"), never as a rating. The kinds, their labels and their order are the SERVER's (`kinds`): nothing
// here lists a kind, because which kinds exist depends on the modules a company has switched on.
import { addDaysIso } from "@/lib/checkins";
import { isoWeekday, levelFor, type HeatLevel } from "@/components/pm/activityHeatmap";

// ── The wire (BFF section 44.3, 44.4) ─────────────────────────────────────────────────────────────

export interface ActivityKind { key: string; label: string; source: string }
export interface ActivityDayCounts { date: string; counts: Record<string, number> }
/** `GET /activity/series`. There is deliberately no `total` and no `score` key. */
export interface ActivitySeries {
  userId: string;
  from: string;
  /** The server's own "today" (REPORTS_TZ) when the request carried no `to`. */
  to: string;
  timezone: string;
  kinds: ActivityKind[];
  days: ActivityDayCounts[];
  totals: Record<string, number>;
}
export interface ActivityDayItem { kind: string; title: string; at: string; link?: string }
/** `GET /activity/day`. */
export interface ActivityDay { userId: string; date: string; items: ActivityDayItem[] }

// ── Words ─────────────────────────────────────────────────────────────────────────────────────────

/** "1 thing done", "5 things done": the volume of a day, never a rating. */
export const doneWords = (n: number): string => `${n} thing${n === 1 ? "" : "s"} done`;

/** A day's volume: the sum of its counts. Used only for the shade and the "things done" wording. */
export function dayVolume(counts: Readonly<Record<string, number>>): number {
  let n = 0;
  for (const v of Object.values(counts)) n += v;
  return n;
}

/** `[kind, n]` pairs with n above 0, in the server's `kinds` order. A key the list does not know follows, named by its key
 *  (the server only counts kinds it lists, so this is a guard, not a feature). */
export function countsByKind(
  counts: Readonly<Record<string, number>>,
  kinds: readonly ActivityKind[],
): { key: string; label: string; n: number }[] {
  const out: { key: string; label: string; n: number }[] = [];
  const seen = new Set<string>();
  for (const k of kinds) {
    seen.add(k.key);
    const n = counts[k.key] ?? 0;
    if (n > 0) out.push({ key: k.key, label: k.label, n });
  }
  for (const [key, n] of Object.entries(counts)) {
    if (!seen.has(key) && n > 0) out.push({ key, label: key, n });
  }
  return out;
}

/** The counts of one day as a phrase: "Commits 2, Site edits 1". The labels are the server's and are not pluralised here
 *  (a label such as "Notes and docs" or "Posts scheduled or sent" has no honest singular), so the count follows the label. */
export function countsPhrase(counts: Readonly<Record<string, number>>, kinds: readonly ActivityKind[]): string {
  return countsByKind(counts, kinds).map((c) => `${c.label} ${c.n}`).join(", ");
}

/** The tooltip and the accessible label of one day: "14 Oct 2026: 3 things done. Commits 2, Site edits 1" or
 *  "14 Oct 2026: nothing recorded". */
export function dayLabel(day: ActivityDayCounts, kinds: readonly ActivityKind[], fmtDate: (iso: string) => string): string {
  const volume = dayVolume(day.counts);
  if (volume === 0) return `${fmtDate(day.date)}: nothing recorded`;
  return `${fmtDate(day.date)}: ${doneWords(volume)}. ${countsPhrase(day.counts, kinds)}`;
}

// ── A year map ────────────────────────────────────────────────────────────────────────────────────

export interface YearCell {
  date: string;
  /** The day's volume, only ever a shade and a count of things done. */
  volume: number;
  level: HeatLevel;
  /** The tooltip and the accessible label. */
  label: string;
}
export interface YearMap {
  /** The days padded with leading blanks to their weekday row, Monday-first; null is a blank. */
  cells: (YearCell | null)[];
  weekCount: number;
  from: string | null;
  /** The server's last day (its today). */
  to: string | null;
  /** Days with anything recorded, for "N of M days". */
  activeDays: number;
  dayCount: number;
}

/** Draws `days` (sorted by date). The shade is relative to the busiest day of the drawn window. */
export function buildYearMap(
  days: readonly ActivityDayCounts[],
  kinds: readonly ActivityKind[],
  fmtDate: (iso: string) => string,
): YearMap {
  const sorted = [...days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (sorted.length === 0) return { cells: [], weekCount: 0, from: null, to: null, activeDays: 0, dayCount: 0 };
  const volumes = sorted.map((d) => dayVolume(d.counts));
  const max = Math.max(0, ...volumes);
  const cells: YearCell[] = sorted.map((d, i) => ({
    date: d.date, volume: volumes[i], level: levelFor(volumes[i], max), label: dayLabel(d, kinds, fmtDate),
  }));
  const padded: (YearCell | null)[] = [...Array<null>(isoWeekday(sorted[0].date)).fill(null), ...cells];
  return {
    cells: padded,
    weekCount: Math.ceil(padded.length / 7),
    from: sorted[0].date,
    to: sorted[sorted.length - 1].date,
    activeDays: volumes.filter((v) => v > 0).length,
    dayCount: sorted.length,
  };
}

/** The legend of kinds: every kind the server lists (never a fixed list), with its count over the series. */
export function kindsLegend(series: Pick<ActivitySeries, "kinds" | "totals">): { key: string; label: string; n: number }[] {
  return series.kinds.map((k) => ({ key: k.key, label: k.label, n: series.totals[k.key] ?? 0 }));
}

// ── A day's detail ────────────────────────────────────────────────────────────────────────────────

export interface DayGroup { key: string; label: string; items: ActivityDayItem[] }

/** A day's items grouped by kind, in the server's `kinds` order, items in the order the server gave (newest first). A kind
 *  with no item is left out; a kind the list does not know follows, named by its key. */
export function groupDayItems(items: readonly ActivityDayItem[], kinds: readonly ActivityKind[]): DayGroup[] {
  const groups: DayGroup[] = [];
  const index = new Map<string, DayGroup>();
  for (const k of kinds) {
    const g: DayGroup = { key: k.key, label: k.label, items: [] };
    index.set(k.key, g);
    groups.push(g);
  }
  for (const it of items) {
    let g = index.get(it.kind);
    if (!g) {
      g = { key: it.kind, label: it.kind, items: [] };
      index.set(it.kind, g);
      groups.push(g);
    }
    g.items.push(it);
  }
  return groups.filter((g) => g.items.length > 0);
}

/** The time of an item in the series' own time zone ("14:05"), so the day shown and the hour shown agree. A zone the
 *  runtime does not know falls back to UTC, never to an exception. */
export function timeOfItem(at: string, timeZone: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  try {
    return d.toLocaleTimeString("en-GB", { ...opts, timeZone });
  } catch {
    return d.toLocaleTimeString("en-GB", { ...opts, timeZone: "UTC" });
  }
}

/** A link from the server is the ERP's own page: a path on this site, never an address elsewhere. */
export function safeLink(link: string | undefined): string | null {
  return typeof link === "string" && link.startsWith("/") && !link.startsWith("//") ? link : null;
}

// ── Windows ───────────────────────────────────────────────────────────────────────────────────────

/** The Monday of the week `iso` falls in. */
export function weekStartOf(iso: string): string {
  return addDaysIso(iso, -isoWeekday(iso));
}
