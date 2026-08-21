"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import type {
  Timeline, TimelineBar, PmTask, GanttGroup, GanttGroupBy, MilestoneMarker, GanttDepEdge,
  BurndownOverlayPoint, UrgencyTier, Tag,
} from "@/lib/pm";
import { addDependency, batchReschedule, type RescheduleItem } from "@/lib/pmActions";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { UrgencyChip } from "./UrgencyChip";
import { TagChip } from "./TagChip";
import { PM_TERMS, PM_STATUS_LADDER } from "@/lib/pmVocabulary";
import "./pm.css";

// Gantt — bars on a shared date axis. Read-only by default (legacy project view);
// the department Timeline turns on `interactive` for drag-to-reschedule +
// dependency-draw. All new props are optional so the existing single-project call
// site (`<Gantt timeline={…} />`) is unchanged.
//
// This is a client component, so it CANNOT import the server-only lib/pm.ts at
// runtime — only its types (erased). Grouping / milestone offsets / dependency
// edges / burndown-overlay points are precomputed by the (server) caller with
// the tested pm.ts helpers and handed in as serializable props. The only logic
// mirrored inline below is the tiny drag-pixel math, the cycle guard (hasCycle
// mirrors pm.ts wouldCreateCycle), and the move-together dependents walk
// (depScan mirrors pm.ts transitiveDependents) — all trivial and needed live
// during interaction (P2-08, design spec §4 phase-2).

type DragMode = "move" | "start" | "end";
type ExtraGroup = { key: string; label: string; note: string };

// P4-H2 — decision 12's pairing: `authoredStart`/`authoredEnd` are `PmProject.startDate`/
// `dueDate` verbatim (null when the project has no authored range yet); `derivedStart`/
// `derivedEnd` are `taskDateEnvelope(tasks)`'s `{ start, end }` (null when the project has no
// dated tasks). Either half — or both — can be null independently; each renders its own bar only
// when it has at least one real date, exactly like `TimelineBar.startsMissing`'s single-date
// fallback below.
export interface GanttProjectBar {
  authoredStart: string | null;
  authoredEnd: string | null;
  derivedStart: string | null;
  derivedEnd: string | null;
}

interface GanttProps {
  timeline: Timeline;
  /** Precomputed groups (server-side, groupTimelineBars). Absent → one flat group (legacy). */
  groups?: GanttGroup[];
  groupBy?: GanttGroupBy;
  milestones?: MilestoneMarker[];
  depEdges?: GanttDepEdge[];
  // Task-link base path (P1-06, design spec §5). `Gantt` is a client
  // component, so a function prop can't cross the RSC boundary from its
  // (server) callers — the caller passes a serializable string instead:
  // `taskHrefBase ? `${taskHrefBase}/${id}` : `/tasks/${id}`. Nested mounts
  // (in-console) pass e.g. `/departments/{deptId}/projects/{projectId}/tasks`
  // so task links stay in-console; the standalone mount passes nothing.
  taskHrefBase?: string;
  // P2-05 (design spec §5): task id → its status colour (hex), resolved by the
  // server caller from the project's ProjectStatus registry. When present the
  // bar renders in that colour; absent (e.g. the dept-timeline mount, unchanged)
  // it falls back to the legacy `pm-gantt__bar--<status>` class colours.
  barColors?: Record<string, string>;
  /** Enables drag-reschedule, dependency-draw, keyboard interactions. Default off. */
  interactive?: boolean;
  /** Gates the write interactions (server still enforces). Default true when interactive. */
  canEdit?: boolean;
  /** Owned projects with no dated work — shown as collapsed note groups, never dropped. */
  undatedGroups?: ExtraGroup[];
  // P2-08 (design spec §4 phase-2): precomputed burndown overlay points (server caller runs
  // lib/pm.ts's `burndownOverlay`). Absent/empty -> the toggle button doesn't render at all (no
  // overlay, no error) — the ONE gate for "hide gracefully when the series is empty".
  burndown?: BurndownOverlayPoint[];
  // P4-G5: task id -> urgency TIER, precomputed by the server caller (`taskUrgency(task, today,
  // { isDone: isDoneStatus(...) })` from lib/pm) — same precedent as `barColors`. Gantt is a client
  // component and must never resolve "today" or done-ness itself (the hydration/drift trap the
  // urgency ticket exists to close); absent/empty renders no indicator, same graceful-degrade
  // convention as every other optional map prop here.
  taskUrgency?: Record<string, UrgencyTier>;
  // P4-L3 — row anatomy: task id -> its OWN project's tag registry entries, resolved server-side.
  // Same shape/precedent as Board's `taskTags` (BoardGrid, taskTags.ts callers) — a plain
  // serializable map so Gantt never has to see a project's tag registry itself. Absent/empty
  // renders no tag chips in the row's meta line (graceful degrade, same convention as barColors).
  taskTags?: Record<string, Tag[]>;
  // P4-H2 — project bars, one per group when `groupBy="project"`: decision 12's AUTHORED range
  // (PmProject.startDate/dueDate — what the team committed to) drawn ALONGSIDE the task-derived
  // envelope (lib/pm.ts `taskDateEnvelope(tasks)` — where the work actually sits). Keyed by group
  // key (== the project id `groupTimelineBars` buckets on), same convention as `barColors`/
  // `taskUrgency` below: this is a client component and cannot import the server-only lib/pm.ts,
  // so the server caller resolves both halves and hands them in as plain ISO strings. Absent, or
  // an entry with all four fields null, renders no project-bar row at all (graceful degrade — a
  // project with no dates yet, or a caller that hasn't wired this up, looks exactly as it did
  // before this ticket).
  projectBars?: Record<string, GanttProjectBar>;
  // P4-H2 — the SAME `projectUrgency` tier (lib/pmUrgency.ts, computed from the authored range)
  // used for project cards/Home/dept lists (P4-H3), precomputed server-side. Drives the authored
  // bar's urgency treatment ONLY; the derived envelope stays neutral on purpose — it's a fact
  // ("here's where the work sits"), not a judgement, and projectUrgency judges the COMMITMENT.
  // Absent renders the bar in the plain accent colour, same graceful-degrade convention as
  // `taskUrgency` above.
  projectUrgency?: Record<string, UrgencyTier>;
  // P4-L3 — the TODAY marker line. Prefer a server-resolved ISO date (same "resolve once,
  // server-side" rule as `taskUrgency`'s `today` parameter — see lib/pmUrgency.ts) so it agrees
  // with whatever urgency tiers were computed for this render. No caller passes this yet, so
  // Gantt falls back to a CLIENT-computed date, but only after mount (see `todayISO` state
  // below) — never during the initial render, so server and client render the SAME thing
  // (no line) on the first pass and the line is added as a normal post-mount update, not a
  // hydration mismatch. This is a purely decorative chrome marker, not a data-bearing tier, so
  // the one-frame-late appearance and the (extremely rare, day-boundary-only) client/server
  // clock disagreement it can introduce are an acceptable trade-off here — unlike urgency tiers,
  // nothing downstream reads this value as ground truth.
  todayISO?: string;
  // P4-C6 — inline "Add a task" per group row. A plain closure prop (unlike a Server Action bound
  // reference) cannot cross the RSC boundary from an async server-component caller — same
  // constraint `taskHrefBase`'s own doc above works around. Only a caller that can hand Gantt a
  // Server Action passes this; every other mount simply doesn't render the affordance (no
  // wiring required, no broken control). Resolves to the same `{ ok, error? }` shape the
  // drag/link actions already use, so failures surface through the existing toast.
  onAddTask?: (groupKey: string, title: string) => Promise<{ ok: boolean; error?: string }>;
}

const DAY = 24 * 3600 * 1000;
const fmt = (d: string) => new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
const dayShift = (isoDate: string, n: number) => new Date(Date.parse(isoDate) + n * DAY).toISOString().slice(0, 10);

// ---- P4-L3: day/week header, weekend banding, today line ----
// `Date.parse("YYYY-MM-DD")` always resolves to UTC midnight, and every function below reads it
// back with the UTC getters — never `toLocaleDateString`/local getters — so weekday/weekend are a
// pure function of the ISO string alone. That makes them safe to compute in a client component:
// server and client always agree, unlike `fmt()` above (locale/timezone-dependent, pre-existing,
// left as-is) or wall-clock "today" (see the `todayISO` prop doc).
const WEEKDAY_ABBR = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
function isWeekendDay(isoDate: string): boolean {
  const d = new Date(Date.parse(isoDate)).getUTCDay();
  return d === 0 || d === 6;
}
function weekdayAbbr(isoDate: string): string {
  return WEEKDAY_ABBR[new Date(Date.parse(isoDate)).getUTCDay()];
}
function dayOfMonth(isoDate: string): string {
  return String(new Date(Date.parse(isoDate)).getUTCDate());
}

interface DayBand { pct: number; widthPct: number }
interface HeaderTick { iso: string; pct: number; labelled: boolean; label?: string }

// P4-C1 — explicit Day/Week/Month zoom, replacing the adaptive-density heuristic below when set.
// `null` (no `?gz=`) keeps the exact prior heuristic behaviour — this is an additive prop-free
// override read straight from the URL (bookmarkable, same convention as `?collapsed=`).
type GanttZoom = "day" | "week" | "month";
function parseZoom(raw: string | null): GanttZoom | null {
  return raw === "day" || raw === "week" || raw === "month" ? raw : null;
}
// P4-C1 — physical pixels-per-day at each zoom, applied to `.pm-gantt`'s min-width (see
// `ganttWidthPx` below) so Day zoom visibly reads wider/finer than Month zoom, not just
// differently-labelled at the same size.
const PX_PER_DAY: Record<GanttZoom, number> = { day: 32, week: 8, month: 4 };

// One band per weekend calendar day, in "day interval" terms (day i spans [i, i+1) of the
// timeline), so the shaded strip lines up with that day's bars, not the point tick beside it.
// Capped by the caller (`dense`) so a pathological multi-year window never renders one <span>
// per day — P4-C2's explicit date window is the real fix for that case (narrow the window).
function buildWeekendBands(start: string, days: number): DayBand[] {
  if (days <= 0) return [];
  const dayWidth = 100 / days;
  const out: DayBand[] = [];
  for (let i = 0; i < days; i++) {
    if (isWeekendDay(dayShift(start, i))) out.push({ pct: i * dayWidth, widthPct: dayWidth });
  }
  return out;
}

// One tick per calendar day (point, not interval — a tick marks the day BOUNDARY at offset i so
// it sits directly under where that day's column starts, same offsetPct convention bars use).
// `labelled` thins the text at wider spans without an explicit zoom. `forceStep` is P4-C1's hook:
// Day zoom pins step=1 (every day labelled), Week zoom pins step=7, and leaving it undefined
// reproduces the exact old heuristic (auto — no `?gz=`) byte-for-byte.
function buildHeaderTicks(start: string, days: number, forceStep?: number): HeaderTick[] {
  if (days <= 0) return [{ iso: start, pct: 0, labelled: true }];
  const step = forceStep ?? (days <= 31 ? 1 : days <= 120 ? 7 : Math.max(1, Math.ceil(days / 16)));
  const out: HeaderTick[] = [];
  for (let i = 0; i <= days; i++) {
    out.push({ iso: dayShift(start, i), pct: (i / days) * 100, labelled: i % step === 0 || i === days });
  }
  return out;
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const isoFromMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
// P4-C1 — Month zoom's OWN guard, independent of the ≤366-day `dense` cap Day/Week zoom keep
// reusing: ticks land on calendar month boundaries, so a multi-year window renders O(months) ticks,
// never O(days) — the performance constraint this ticket owns for the case dense can't cover
// (a legitimate "view years at a glance" use of Month zoom). `MAX_MONTH_TICKS` is a second,
// belt-and-suspenders cap so an extreme multi-decade window can't slowly regress the same way.
const MAX_MONTH_TICKS = 60;
function buildMonthTicks(start: string, end: string): HeaderTick[] {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  const span = Math.max(DAY, endMs - startMs);
  const startD = new Date(startMs);
  let y = startD.getUTCFullYear();
  let m = startD.getUTCMonth();
  const isoDates: string[] = [start]; // always anchor the left edge, even mid-month
  m += 1;
  if (m > 11) { m = 0; y += 1; }
  while (true) {
    const ms = Date.UTC(y, m, 1);
    if (ms > endMs) break;
    isoDates.push(isoFromMs(ms));
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }
  const step = Math.max(1, Math.ceil(isoDates.length / MAX_MONTH_TICKS));
  const thinned = isoDates.filter((_, i) => i % step === 0 || i === isoDates.length - 1);
  return thinned.map((iso, i) => {
    const ms = Date.parse(iso);
    const d = new Date(ms);
    const showYear = i === 0 || d.getUTCMonth() === 0;
    const label = showYear ? `${MONTH_ABBR[d.getUTCMonth()]} ${d.getUTCFullYear()}` : MONTH_ABBR[d.getUTCMonth()];
    return { iso, pct: ((ms - startMs) / span) * 100, labelled: true, label };
  });
}

interface MonthBand { key: string; label: string; pct: number; widthPct: number }
// P5-T1 — the MONTH BAND above the day ticks. The day axis on its own rendered "Tu 23 · Tu 30 ·
// Tu 7 · Tu 14": ticks a fixed step apart necessarily repeat the same weekday, and the month was
// never named anywhere, so 7 July and 7 August were the same label. Each band spans its own
// calendar month's real width on the axis and names it once. Year is appended on the first band
// and on every January, the same rule `buildMonthTicks` already uses for its own labels.
// UTC getters throughout, like every other date helper in this file — never local ones — so a
// band is a pure function of the ISO string and server/client can't disagree.
const MAX_MONTH_BANDS = 120;
function buildMonthBands(start: string, days: number): MonthBand[] {
  if (days <= 0) return [];
  const startMs = Date.parse(start);
  const endMs = startMs + days * DAY;
  const span = Math.max(DAY, endMs - startMs);
  const out: MonthBand[] = [];
  const first = new Date(startMs);
  let y = first.getUTCFullYear();
  let m = first.getUTCMonth();
  let cursor = startMs;
  while (cursor < endMs && out.length < MAX_MONTH_BANDS) {
    m += 1;
    if (m > 11) { m = 0; y += 1; }
    const nextMs = Math.min(Date.UTC(y, m, 1), endMs);
    const cd = new Date(cursor);
    const showYear = out.length === 0 || cd.getUTCMonth() === 0;
    out.push({
      key: `${cd.getUTCFullYear()}-${cd.getUTCMonth()}`,
      label: showYear ? `${MONTH_ABBR[cd.getUTCMonth()]} ${cd.getUTCFullYear()}` : MONTH_ABBR[cd.getUTCMonth()],
      pct: ((cursor - startMs) / span) * 100,
      widthPct: ((nextMs - cursor) / span) * 100,
    });
    cursor = nextMs;
  }
  return out;
}

// Offset (0-100) of `iso` within [start, start+days], or null when it falls outside the
// rendered window — the guard that hides the today line when "today" isn't on this axis at all.
// Also reused by P4-C2 to reposition milestone diamonds against an explicit window.
function pctForDate(start: string, days: number, iso: string): number | null {
  if (days <= 0) return null;
  const idx = Math.round((Date.parse(iso) - Date.parse(start)) / DAY);
  if (idx < 0 || idx > days) return null;
  return (idx / days) * 100;
}

// P4-C2 — an explicit, clearable date window. Mirrors lib/pm.ts's `computeTimeline` per-bar clamp
// math (same precedent as `hasCycle`/`depScan` below: this file cannot import the server-only
// module at runtime, so the pure math is duplicated deliberately) but against an ARBITRARY
// [winStart, winEnd] instead of the task-derived min/max. A task with real dates entirely outside
// the window is DROPPED, not pinned to an edge — pinning would misrepresent where it actually
// falls. A task with no dates at all is pinned to the window start and dashed, same convention
// `computeTimeline` uses for `startsMissing`.
function applyWindowToBars(bars: TimelineBar[], winStart: string, winEnd: string): TimelineBar[] {
  const winStartMs = Date.parse(winStart);
  const winEndMs = Date.parse(winEnd);
  const spanMs = Math.max(DAY, winEndMs - winStartMs);
  const out: TimelineBar[] = [];
  for (const b of bars) {
    const t = b.task;
    const hasDate = !!(t.startDate || t.dueDate);
    const s = t.startDate ? Date.parse(t.startDate) : t.dueDate ? Date.parse(t.dueDate) : winStartMs;
    const e = t.dueDate ? Date.parse(t.dueDate) : s + DAY;
    if (hasDate && (e < winStartMs || s > winEndMs)) continue;
    const clampedS = Math.max(winStartMs, Math.min(s, winEndMs));
    const clampedE = Math.max(clampedS + DAY / 2, Math.min(e + DAY, winEndMs));
    out.push({
      ...b,
      offsetPct: ((clampedS - winStartMs) / spanMs) * 100,
      widthPct: Math.min(100, ((clampedE - clampedS) / spanMs) * 100),
    });
  }
  return out;
}

// P4-C2 — milestone diamonds repositioned (or hidden, if outside) against the explicit window.
function applyWindowToMilestones(markers: MilestoneMarker[], winStart: string, days: number): MilestoneMarker[] {
  const out: MilestoneMarker[] = [];
  for (const m of markers) {
    const pct = pctForDate(winStart, days, m.date);
    if (pct === null) continue;
    out.push({ ...m, offsetPct: pct });
  }
  return out;
}

// P4-H2 — bar geometry for a project's authored range or its task-derived envelope against the
// CURRENT axis (`effStart`/`effDays` — already reflects an active ?gfrom=/?gto= window, same
// values every task bar's own drag/preview math above uses). Mirrors `applyWindowToBars`' own
// clamp math one-for-one (a single date pins to a 1-day bar via the same `+DAY` inclusive-end
// convention `computeTimeline` uses) rather than introducing a second rounding rule that could
// drift from where the task bars underneath actually land. Returns null — render nothing — when
// both dates are absent (no range at all) or the range falls entirely outside the visible axis;
// it deliberately does NOT pin to an edge the way a single missing date does, for the same reason
// `applyWindowToBars` drops rather than pins a task wholly outside the window: pinning would claim
// the range starts/ends somewhere it doesn't.
function projectRangeGeometry(
  start: string | null, end: string | null, axisStart: string, axisDays: number,
): { offsetPct: number; widthPct: number } | null {
  if (!start && !end) return null;
  const axisStartMs = Date.parse(axisStart);
  const axisEndMs = axisStartMs + axisDays * DAY;
  const spanMs = Math.max(DAY, axisEndMs - axisStartMs);
  const s = start ? Date.parse(start) : Date.parse(end!);
  const e = end ? Date.parse(end) : s;
  if (e < axisStartMs || s > axisEndMs) return null;
  const clampedS = Math.max(axisStartMs, Math.min(s, axisEndMs));
  const clampedE = Math.max(clampedS + DAY / 2, Math.min(e + DAY, axisEndMs));
  return {
    offsetPct: ((clampedS - axisStartMs) / spanMs) * 100,
    widthPct: Math.min(100, ((clampedE - clampedS) / spanMs) * 100),
  };
}

// Up to two initials from a display name — the avatar's fallback rendering (no photo store
// exists yet). "Edward Gusde" -> "EG"; "Marketing" (a division/department Ball, our superset of
// Repsona's person-only field) -> "MA", same rule, no special-casing by AssigneeKind needed.
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Meta-line due-date colouring reuses the board card's existing `.pm-due` family (pm.css) —
// driven by the SAME precomputed urgency tier as the row's dot, so the two can never disagree.
function dueUrgencyClass(tier: UrgencyTier | undefined): string {
  if (tier === "overdue") return "pm-due--risk";
  if (tier === "due-soon") return "pm-due--soon";
  return "pm-due--quiet";
}

// New dates from a drag. move = shift both (preserve duration); start/end resize
// one edge and never cross the other. Mirrors intent of the read-only geometry.
function computeNewDates(task: PmTask, mode: DragMode, deltaDays: number): { startDate: string | null; dueDate: string | null } {
  let start = task.startDate;
  let due = task.dueDate;
  if (mode === "move") {
    if (start) start = dayShift(start, deltaDays);
    if (due) due = dayShift(due, deltaDays);
  } else if (mode === "start") {
    const base = start ?? due;
    if (base) { let ns = dayShift(base, deltaDays); if (due && ns > due) ns = due; start = ns; }
  } else {
    const base = due ?? start;
    if (base) { let nd = dayShift(base, deltaDays); if (start && nd < start) nd = start; due = nd; }
  }
  return { startDate: start, dueDate: due };
}

// Mirror of lib/pm.ts wouldCreateCycle (server-only there; needed live on the
// client for immediate snap-back feedback — the server remains authoritative).
function hasCycle(bars: TimelineBar[], blockedId: string, blockerId: string): boolean {
  if (blockedId === blockerId) return true;
  const byId = new Map(bars.map((b) => [b.task.id, b.task]));
  const seen = new Set<string>();
  const reaches = (from: string, target: string): boolean => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    const t = byId.get(from);
    return (t?.dependsOn ?? []).some((d) => reaches(d, target));
  };
  return reaches(blockerId, blockedId);
}

// P2-08: burndown overlay points -> an SVG polyline `points` string. A 0-100/0-100 viewBox lets
// `x`/the pct fields plug straight in; y is inverted (100 - pct) since SVG y grows downward and
// these pct fields are "% of work remaining" (100 = most remaining, at the top of the chart).
function bdPoints(points: BurndownOverlayPoint[], key: "idealPct" | "actualPct"): string {
  return points.map((p) => `${p.x},${100 - p[key]}`).join(" ");
}

// Mirror of lib/pm.ts transitiveDependents (server-only there): every task reachable by walking
// `dependsOn` edges BACKWARD from `taskId` (blocked -> blocker) — the set that must move together
// when `taskId`'s bar is dragged (P2-08). The visited-set guard makes a `dependsOn` cycle
// terminate rather than recurse forever, same as hasCycle above.
function depScan(bars: TimelineBar[], taskId: string): string[] {
  const dependents = new Map<string, string[]>();
  for (const b of bars) {
    for (const dep of b.task.dependsOn ?? []) {
      const arr = dependents.get(dep);
      if (arr) arr.push(b.task.id); else dependents.set(dep, [b.task.id]);
    }
  }
  const out = new Set<string>();
  const stack = [...(dependents.get(taskId) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id) || id === taskId) continue;
    out.add(id);
    for (const next of dependents.get(id) ?? []) stack.push(next);
  }
  return [...out];
}

// ---- P4-C3: filter bar (Keywords · Tags · Status · Responsible · Ball · Priority · Milestones ·
// Due date, + Overdue Only/Show Closed toggles) ----
// `Priority` is a closed 4-value enum owned by the server-only `lib/pm.ts`; duplicated here as a
// plain array/map for the SAME reason `hasCycle`/`depScan` above duplicate their pm.ts twins — a
// client component cannot pull a runtime value out of a `server-only` module, only its erased type.
const GANTT_PRIORITIES: PmTask["priority"][] = ["low", "normal", "high", "urgent"];
const GANTT_PRIORITY_LABEL: Record<PmTask["priority"], string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };

// Best-effort "is this task closed" check that never guesses from a date — only from signals the
// SERVER already resolved. Prefers the precomputed urgency tier (`done`, the exact signal
// `props.taskUrgency` carries — resolved server-side from the task's own project's status
// registry); when a tier WAS supplied but isn't `done`, that is authoritative too (not-closed).
// Only when no tier was supplied at all does this fall back to the shared 5-status ladder, which
// only knows the SYNTHESIZED default set — a task on a customized per-project registry (e.g.
// "Ready to check") with no urgency map reads as "not closed", the safe default that never hides
// a task nobody told this component was done.
function isTaskClosed(t: PmTask, urgencyTier: UrgencyTier | undefined): boolean {
  if (urgencyTier !== undefined) return urgencyTier === "done";
  return PM_STATUS_LADDER.find((s) => s.id === t.status)?.isDone ?? false;
}

interface GanttFilters {
  q: string;
  tags: Set<string>; status: Set<string>; priority: Set<string>;
  responsible: Set<string>; ball: Set<string>; milestone: Set<string>;
  dueFrom: string; dueTo: string;
  overdueOnly: boolean; hideClosed: boolean;
}

// The predicate every facet/toggle funnels through. `overdueOnly` reads ONLY `urgencyTier` — never
// `t.dueDate` directly — per lib/pmUrgency.ts's header rule: one definition of "overdue", computed
// once server-side and handed down, or every surface risks disagreeing with the one next to it.
function taskMatchesFilters(t: PmTask, f: GanttFilters, urgencyTier: UrgencyTier | undefined): boolean {
  if (f.q) {
    const needle = f.q;
    if (!t.title.toLowerCase().includes(needle) && !t.description.toLowerCase().includes(needle)) return false;
  }
  if (f.status.size && !f.status.has(t.status)) return false;
  if (f.priority.size && !f.priority.has(t.priority)) return false;
  if (f.responsible.size && !(t.assignee && f.responsible.has(t.assignee.responsibleId))) return false;
  if (f.ball.size && !(t.assignee && f.ball.has(t.assignee.refId))) return false;
  if (f.tags.size && !t.tags.some((id) => f.tags.has(id))) return false;
  if (f.milestone.size && !(t.milestoneId && f.milestone.has(t.milestoneId))) return false;
  if (f.dueFrom && (!t.dueDate || t.dueDate < f.dueFrom)) return false;
  if (f.dueTo && (!t.dueDate || t.dueDate > f.dueTo)) return false;
  if (f.overdueOnly && urgencyTier !== "overdue") return false;
  if (f.hideClosed && isTaskClosed(t, urgencyTier)) return false;
  return true;
}

// P4-C5: same escape/Blob/createObjectURL shape as components/data/DataTable.tsx's own
// `exportCsv` — no new dependency, one convention for "download this table as CSV" app-wide.
function csvEscape(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

interface DragState { taskId: string; mode: DragMode; startX: number; trackWidth: number; deltaDays: number; moveSet: Set<string> }
interface LinkState { fromId: string; fromTitle: string }
interface Line { x1: number; y1: number; x2: number; y2: number; conflict: boolean }

export function Gantt(props: GanttProps) {
  const { timeline, milestones, depEdges, interactive = false } = props;
  const canEdit = props.canEdit ?? interactive;
  const groupBy = props.groupBy ?? "flat";
  // MUST be memoized. `groups` is a dependency of the dependency-line useLayoutEffect below, which
  // calls setLines() — so an inline fallback array (a fresh reference every render) produced
  // render → effect → setState → render forever: "Maximum update depth exceeded", and the whole
  // page fell to its error boundary. Callers that pass `groups` (the department Timeline) were
  // unaffected because a prop from the server keeps its identity across client re-renders; the two
  // call sites that rely on this fallback — the project workspace timeline and My calendar — did not.
  const groups: GanttGroup[] = useMemo(
    () => props.groups ?? [{ key: "__all", label: "", bars: timeline.bars }],
    [props.groups, timeline.bars],
  );
  const undatedGroups = props.undatedGroups ?? [];
  const grouped = groupBy !== "flat" || groups.length > 1 || undatedGroups.length > 0;
  const taskHref = (id: string) => (props.taskHrefBase ? `${props.taskHrefBase}/${id}` : `/tasks/${id}`);
  const allBars = timeline.bars;

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  // ---- collapsed group state, persisted in ?collapsed= ----
  const collapsedParam = searchParams.get("collapsed") ?? "";
  const collapsed = new Set(collapsedParam.split(",").filter(Boolean));
  const toggleCollapsed = useCallback((key: string) => {
    const next = new Set(collapsedParam.split(",").filter(Boolean));
    if (next.has(key)) next.delete(key); else next.add(key);
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    if (next.size) params.set("collapsed", [...next].join(",")); else params.delete("collapsed");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [collapsedParam, searchParams, pathname, router]);

  const [drag, setDrag] = useState<DragState | null>(null);
  const [link, setLink] = useState<LinkState | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [live, setLive] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  // P2-08 — shift-multiselect (mouse: shift-click; keyboard: Enter/Space on a focused bar).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const burndown = props.burndown ?? [];
  const [showBurndown, setShowBurndown] = useState(false);

  // ---- P4-C1/P4-C2 — zoom + explicit date window, both persisted in the URL (?gz=, ?gfrom=/
  // ?gto=) with the same read/replace convention as ?collapsed= above. Absent params reproduce
  // today's behaviour exactly: `zoomParam` null keeps the adaptive-density heuristic, and with no
  // `gfrom`/`gto` the window stays whatever the server derived (`timeline.start`/`end`/`days`).
  const zoomParam = parseZoom(searchParams.get("gz"));
  const winFromParam = searchParams.get("gfrom");
  const winToParam = searchParams.get("gto");
  const windowActive = !!(
    winFromParam && winToParam &&
    !Number.isNaN(Date.parse(winFromParam)) && !Number.isNaN(Date.parse(winToParam)) &&
    winToParam >= winFromParam // lexical ISO (yyyy-mm-dd) comparison is date-correct
  );
  // P5-T1 — TODAY IS ALWAYS ON THE AXIS.
  // The server-derived timeline spans the tasks' own min/max dates, so on a department whose work
  // all sits in the past the default axis ended weeks before today: every bar was flagged overdue
  // and the one mark that says how overdue — the today rule — fell outside the axis and rendered
  // nothing at all. The axis is stretched to reach `todayISO` whenever it doesn't already.
  // Gated on the SERVER-pinned `todayISO` only, never the post-mount client fallback: stretching
  // the axis moves every bar, and doing that on hydration would be a visible jump (the today rule
  // itself is decorative chrome and can afford to arrive a frame late — the geometry can't).
  // `windowActive` still wins: an explicit window is the reader's own instruction.
  const todayPin = props.todayISO ?? null;
  const needsToday = !windowActive && !!todayPin && (todayPin < timeline.start || todayPin > timeline.end);
  // Two days of air past the pin, so the today rule reads as a marker ON the axis rather than as
  // the chart's own border — flush against the edge it is indistinguishable from the card frame.
  const TODAY_PAD_DAYS = 2;
  const axisStart = windowActive ? winFromParam! : needsToday && todayPin! < timeline.start ? dayShift(todayPin!, -TODAY_PAD_DAYS) : timeline.start;
  const axisEnd = windowActive ? winToParam! : needsToday && todayPin! > timeline.end ? dayShift(todayPin!, TODAY_PAD_DAYS) : timeline.end;
  // Everything downstream — bars, milestones, the burndown overlay — is re-derived against the
  // axis whenever it isn't the server's own; `rescaled` is that single condition.
  const rescaled = windowActive || needsToday;
  const effStart = axisStart;
  const effEnd = axisEnd;
  const effDays = rescaled ? Math.max(1, Math.round((Date.parse(effEnd) - Date.parse(effStart)) / DAY)) : timeline.days;

  const setZoomParams = useCallback((next: URLSearchParams) => {
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [pathname, router]);
  const setZoom = useCallback((z: GanttZoom) => {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    if (zoomParam === z) { params.delete("gz"); setLive("Zoom reset to automatic."); }
    else { params.set("gz", z); setLive(`Zoom set to ${z}.`); }
    setZoomParams(params);
  }, [searchParams, zoomParam, setZoomParams]);
  const applyWindow = useCallback((from: string, to: string) => {
    if (!from || !to) return;
    if (to < from) { setLive("End date must be on or after the start date."); return; }
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.set("gfrom", from);
    params.set("gto", to);
    setZoomParams(params);
    setLive(`Showing ${fmt(from)} to ${fmt(to)}.`);
  }, [searchParams, setZoomParams]);
  const clearWindow = useCallback(() => {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.delete("gfrom");
    params.delete("gto");
    setZoomParams(params);
    setLive("Showing the full timeline.");
  }, [searchParams, setZoomParams]);

  // P4-C2: bars/milestones recomputed against the explicit window (mirrors computeTimeline's own
  // clamp math — see applyWindowToBars). Memoized: `groups`' own memo comment above explains why an
  // unmemoized fallback here would retrigger the dependency-line effect every render.
  const viewGroups: GanttGroup[] = useMemo(
    () => (rescaled ? groups.map((g) => ({ ...g, bars: applyWindowToBars(g.bars, effStart, effEnd) })) : groups),
    [groups, rescaled, effStart, effEnd],
  );
  // P5-T1 — the burndown overlay follows the axis instead of hiding from it. It used to be
  // suppressed outright whenever a window was active, on the stated grounds that "there is no
  // per-point date to remap against an arbitrary window" — but `BurndownOverlayPoint` carries
  // `date` (lib/pm.ts), so each point's x is simply recomputed the same way a milestone diamond's
  // is, and a point outside the axis is dropped rather than misplaced. Same helper, same rule.
  const viewBurndown: BurndownOverlayPoint[] = useMemo(() => {
    if (!rescaled) return burndown;
    const out: BurndownOverlayPoint[] = [];
    for (const pt of burndown) {
      const x = pctForDate(effStart, effDays, pt.date);
      if (x === null) continue;
      out.push({ ...pt, x });
    }
    return out;
  }, [burndown, rescaled, effStart, effDays]);
  const viewMilestones: MilestoneMarker[] = useMemo(
    () => (rescaled ? applyWindowToMilestones(milestones ?? [], effStart, effDays) : (milestones ?? [])),
    [milestones, rescaled, effStart, effDays],
  );

  // ---- P4-C3 — the filter bar, URL-driven like everything above (?gq=/?gtags=/?gstatus=/
  // ?gresponsible=/?gball=/?gpriority=/?gmilestone=/?gduefrom=/?gdueto=/?goverdue=/?gclosed=).
  // A DELIBERATELY separate param family from ?gfrom=/?gto=, which already mean "the visible date
  // WINDOW" — the due-date FACET below is a different question ("only tasks due in this range")
  // and gets its own ?gduefrom=/?gdueto= rather than colliding. Every param defaults to "no
  // filter" (Set()/"" /false), so a caller or bookmark with none of these set renders exactly what
  // it rendered before this ticket.
  const gq = searchParams.get("gq") ?? "";
  const gTagsParam = searchParams.get("gtags") ?? "";
  const gStatusParam = searchParams.get("gstatus") ?? "";
  const gPriorityParam = searchParams.get("gpriority") ?? "";
  const gResponsibleParam = searchParams.get("gresponsible") ?? "";
  const gBallParam = searchParams.get("gball") ?? "";
  const gMilestoneParam = searchParams.get("gmilestone") ?? "";
  const gDueFrom = searchParams.get("gduefrom") ?? "";
  const gDueTo = searchParams.get("gdueto") ?? "";
  const overdueOnly = searchParams.get("goverdue") === "1";
  // "Show Closed" defaults ON — ?gclosed= absent means every task the caller handed in still
  // renders (byte-identical to every Gantt mount before this ticket); unchecking it writes
  // ?gclosed=0 to hide closed tasks.
  const hideClosed = searchParams.get("gclosed") === "0";
  // Memoized on the raw param STRINGS, not on freshly-`new Set()`'d objects — `filteredGroups`
  // below depends on this object, and an unmemoized fallback here would retrigger the
  // dependency-line effect every render (the exact "Maximum update depth exceeded" trap the
  // `groups` memo's own comment documents; this is that lesson applied to a second memo).
  const filters: GanttFilters = useMemo(() => ({
    q: gq.trim().toLowerCase(),
    tags: new Set(gTagsParam.split(",").filter(Boolean)),
    status: new Set(gStatusParam.split(",").filter(Boolean)),
    priority: new Set(gPriorityParam.split(",").filter(Boolean)),
    responsible: new Set(gResponsibleParam.split(",").filter(Boolean)),
    ball: new Set(gBallParam.split(",").filter(Boolean)),
    milestone: new Set(gMilestoneParam.split(",").filter(Boolean)),
    dueFrom: gDueFrom, dueTo: gDueTo, overdueOnly, hideClosed,
  }), [gq, gTagsParam, gStatusParam, gPriorityParam, gResponsibleParam, gBallParam, gMilestoneParam, gDueFrom, gDueTo, overdueOnly, hideClosed]);
  const activeFilterCount =
    (filters.q ? 1 : 0) + (filters.tags.size ? 1 : 0) + (filters.status.size ? 1 : 0) + (filters.priority.size ? 1 : 0) +
    (filters.responsible.size ? 1 : 0) + (filters.ball.size ? 1 : 0) + (filters.milestone.size ? 1 : 0) +
    (filters.dueFrom || filters.dueTo ? 1 : 0) + (filters.overdueOnly ? 1 : 0) + (filters.hideClosed ? 1 : 0);
  const filtersActive = activeFilterCount > 0;

  // Distinct facet options, derived from the FULL unwindowed/unfiltered bar set so the choices on
  // offer never shrink just because another facet already narrowed the view (standard multi-facet
  // UX — Repsona's own filter bar behaves the same way).
  const facetOptions = useMemo(() => {
    const statuses = new Map<string, string>();
    const priorities = new Set<PmTask["priority"]>();
    const responsibles = new Map<string, string>();
    const balls = new Map<string, string>();
    for (const b of allBars) {
      const t = b.task;
      if (!statuses.has(t.status)) statuses.set(t.status, PM_STATUS_LADDER.find((s) => s.id === t.status)?.label ?? t.status);
      priorities.add(t.priority);
      if (t.assignee) {
        responsibles.set(t.assignee.responsibleId, t.assignee.responsibleName);
        balls.set(t.assignee.refId, t.assignee.refName);
      }
    }
    const tags = new Map<string, Tag>();
    for (const list of Object.values(props.taskTags ?? {})) for (const tg of list) tags.set(tg.id, tg);
    return {
      statuses: [...statuses.entries()],
      priorities: GANTT_PRIORITIES.filter((p) => priorities.has(p)),
      responsibles: [...responsibles.entries()],
      balls: [...balls.entries()],
      tags: [...tags.values()],
      milestones: milestones ?? [],
    };
  }, [allBars, props.taskTags, milestones]);

  // Toggles a value in a comma-joined URL param (?gtags=a,b) — reads the CURRENT url fresh at
  // click time, same convention as `toggleCollapsed`/`setZoom` above (not off the memoized
  // `filters`, which lags one render behind a just-fired navigation).
  const toggleSetParam = useCallback((key: string, value: string) => {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    const current = new Set(params.get(key)?.split(",").filter(Boolean) ?? []);
    if (current.has(value)) current.delete(value); else current.add(value);
    if (current.size) params.set(key, [...current].join(",")); else params.delete(key);
    setZoomParams(params);
  }, [searchParams, setZoomParams]);
  const setOverdueOnly = useCallback((checked: boolean) => {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    if (checked) params.set("goverdue", "1"); else params.delete("goverdue");
    setZoomParams(params);
  }, [searchParams, setZoomParams]);
  const setHideClosed = useCallback((hide: boolean) => {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    if (hide) params.set("gclosed", "0"); else params.delete("gclosed");
    setZoomParams(params);
  }, [searchParams, setZoomParams]);
  const applyTextFilters = useCallback((e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const val = (name: string) => ((form.elements.namedItem(name) as HTMLInputElement | null)?.value ?? "").trim();
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    const q = val("gq"); const dueFrom = val("gduefrom"); const dueTo = val("gdueto");
    if (q) params.set("gq", q); else params.delete("gq");
    if (dueFrom) params.set("gduefrom", dueFrom); else params.delete("gduefrom");
    if (dueTo) params.set("gdueto", dueTo); else params.delete("gdueto");
    setZoomParams(params);
  }, [searchParams, setZoomParams]);
  const clearFilters = useCallback(() => {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    for (const key of ["gq", "gtags", "gstatus", "gpriority", "gresponsible", "gball", "gmilestone", "gduefrom", "gdueto", "goverdue", "gclosed"]) {
      params.delete(key);
    }
    setZoomParams(params);
    setLive("Filters cleared.");
  }, [setZoomParams]);

  // Facet/toggle filters layer ON TOP of the window (`viewGroups`/`viewMilestones` above already
  // reflect ?gfrom=/?gto=). `allBars`/the drag-and-dependency machinery below stay against the
  // FULL, unfiltered graph on purpose — hiding a row must never make its dependency edges or
  // move-together cascade behave as if the task didn't exist.
  const filteredGroups: GanttGroup[] = useMemo(
    () => viewGroups.map((g) => ({ ...g, bars: g.bars.filter((b) => taskMatchesFilters(b.task, filters, props.taskUrgency?.[b.task.id])) })),
    [viewGroups, filters, props.taskUrgency],
  );
  const filteredMilestones: MilestoneMarker[] = useMemo(
    () => (filters.milestone.size ? viewMilestones.filter((m) => filters.milestone.has(m.id)) : viewMilestones),
    [viewMilestones, filters.milestone],
  );
  const filteredTotal = useMemo(() => filteredGroups.reduce((n, g) => n + g.bars.length, 0), [filteredGroups]);

  // P4-C5 — CSV of the visible (filtered) rows. Same escape/Blob/anchor-click shape as
  // components/data/DataTable.tsx's own `exportCsv`; no new dependency.
  const exportCsv = useCallback(() => {
    const rows = filteredGroups.flatMap((g) => g.bars.map((b) => b.task));
    const columns: { header: string; get: (t: PmTask) => string }[] = [
      { header: "Title", get: (t) => t.title },
      { header: "Project", get: (t) => t.projectName },
      { header: "Status", get: (t) => PM_STATUS_LADDER.find((s) => s.id === t.status)?.label ?? t.status },
      { header: PM_TERMS.priority, get: (t) => GANTT_PRIORITY_LABEL[t.priority] },
      { header: PM_TERMS.ball, get: (t) => t.assignee?.refName ?? "" },
      { header: PM_TERMS.responsible, get: (t) => t.assignee?.responsibleName ?? "" },
      { header: "Start date", get: (t) => t.startDate ?? "" },
      { header: PM_TERMS.dueDate, get: (t) => t.dueDate ?? "" },
      { header: "Progress %", get: (t) => String(t.progress) },
    ];
    const head = columns.map((c) => csvEscape(c.header)).join(",");
    const body = rows.map((t) => columns.map((c) => csvEscape(c.get(t))).join(",")).join("\n");
    const blob = new Blob([`${head}\n${body}`], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "gantt-export.csv";
    a.click();
    URL.revokeObjectURL(url);
  }, [filteredGroups]);

  // ---- P4-L3/P4-C1: day/week/month header, weekend banding, today line ----
  // Client-only fallback for "today" (see the `todayISO` prop doc above) — starts `null` so the
  // very first render (server AND client, pre-hydration) draws no line, then fills in post-mount.
  const [clientToday, setClientToday] = useState<string | null>(null);
  useEffect(() => { setClientToday(new Date().toISOString().slice(0, 10)); }, []);
  const resolvedToday = props.todayISO ?? clientToday;
  // Capped at ~a year so a pathological multi-year window never renders one <span> per day — Month
  // zoom below has its OWN independent guard (buildMonthTicks/MAX_MONTH_TICKS) so it can still
  // render a long window cheaply; Day/Week zoom and the no-zoom heuristic all share this one.
  const dense = effDays > 0 && effDays <= 366;
  // Weekend bands are per-day elements — never rendered for Month zoom (they'd be both meaningless
  // at that scale and, for a long window, exactly the "one element per day" case this ticket's
  // hard constraint forbids), and still gated on `dense` otherwise (unchanged rule).
  const showWeekendBands = dense && zoomParam !== "month";
  const weekendBands = useMemo(() => (showWeekendBands ? buildWeekendBands(effStart, effDays) : []), [showWeekendBands, effStart, effDays]);
  const headerTicks = useMemo(() => {
    if (zoomParam === "month") return buildMonthTicks(effStart, effEnd);
    if (!dense) return [];
    const forceStep = zoomParam === "day" ? 1 : zoomParam === "week" ? 7 : undefined;
    return buildHeaderTicks(effStart, effDays, forceStep);
  }, [zoomParam, dense, effStart, effEnd, effDays]);
  const useFineAxis = zoomParam === "month" ? headerTicks.length > 0 : dense;
  // Month zoom already names the month on every tick, so the band would only repeat it there.
  const monthBands = useMemo(
    () => (useFineAxis && zoomParam !== "month" ? buildMonthBands(effStart, effDays) : []),
    [useFineAxis, zoomParam, effStart, effDays],
  );
  // The weekday abbreviation earns its place only where consecutive ticks are consecutive days.
  // At a 7-day step every tick reads the same weekday, which is noise dressed as data.
  const showWeekday = zoomParam === "day" || (zoomParam === null && effDays <= 31);
  const todayPct = resolvedToday ? pctForDate(effStart, effDays, resolvedToday) : null;

  // P4-C1: a real zoom, not just denser labels — widening `.pm-gantt`'s min-width scales every
  // bar's PHYSICAL size (offsetPct/widthPct stay percentages of this container, unchanged) so Day
  // zoom actually reads like Day zoom instead of the same pixels with finer tick labels. Unset
  // (no `?gz=`) leaves the CSS default (620px) exactly as before — zero visual change for any
  // caller that hasn't opted in. The existing ResizeObserver on `containerRef` already re-measures
  // dependency lines on any width change, so this needs no extra plumbing.
  const ganttWidthPx = zoomParam ? Math.max(620, effDays * PX_PER_DAY[zoomParam]) : undefined;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const barRefs = useRef(new Map<string, HTMLElement | null>());
  const setBarRef = (id: string) => (el: HTMLElement | null) => { barRefs.current.set(id, el); };

  // ---- dependency lines: measured from the live DOM (grouping/collapse-agnostic) ----
  const recomputeLines = useCallback(() => {
    const edges = depEdges ?? [];
    const container = containerRef.current;
    // Bail out instead of storing a fresh empty array: with no dependencies to draw (every mount
    // that passes no depEdges) an unconditional setLines([]) is a state change on every call, which
    // re-triggers the effect that called it. Defence in depth behind the memoized `groups` above.
    if (!container || edges.length === 0) { setLines((prev) => (prev.length === 0 ? prev : [])); return; }
    const box = container.getBoundingClientRect();
    const next: Line[] = [];
    for (const e of edges) {
      const from = barRefs.current.get(e.fromId);
      const to = barRefs.current.get(e.toId);
      if (!from || !to || !from.isConnected || !to.isConnected) continue;
      const fr = from.getBoundingClientRect();
      const tr = to.getBoundingClientRect();
      if (fr.width === 0 || tr.width === 0) continue;
      next.push({
        x1: fr.right - box.left, y1: fr.top + fr.height / 2 - box.top,
        x2: tr.left - box.left, y2: tr.top + tr.height / 2 - box.top,
        conflict: e.conflict,
      });
    }
    setLines(next);
  }, [depEdges]);

  useLayoutEffect(() => { recomputeLines(); }, [recomputeLines, collapsedParam, filteredGroups, drag]);
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => recomputeLines());
    ro.observe(containerRef.current);
    window.addEventListener("resize", recomputeLines);
    return () => { ro.disconnect(); window.removeEventListener("resize", recomputeLines); };
  }, [recomputeLines]);

  // ---- multiselect (P2-08) ----
  const toggleSelected = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const nowSelected = !next.has(id);
      if (nowSelected) next.add(id); else next.delete(id);
      const title = allBars.find((b) => b.task.id === id)?.task.title ?? "Task";
      setLive(`${title} ${nowSelected ? "selected" : "deselected"}. ${next.size} task${next.size === 1 ? "" : "s"} selected.`);
      return next;
    });
  }, [allBars]);

  // The set of bars a drag/nudge on `anchorId` moves together: the current selection (if the
  // anchor is part of one) or just the anchor alone, UNION every task's transitive dependents
  // (move-together, P2-08) — so a lone drag still cascades to its dependents, and a multiselect
  // drag cascades every selected bar's dependents too.
  const moveSet = useCallback((anchorId: string): Set<string> => {
    const base = selected.size > 0 && selected.has(anchorId) ? new Set(selected) : new Set([anchorId]);
    const out = new Set(base);
    for (const id of base) for (const dep of depScan(allBars, id)) out.add(dep);
    return out;
  }, [selected, allBars]);

  // Commits a batch move for `ids` shifted by `delta` days (mode "move" only — the keyboard
  // arrow-nudge path). `anchorBar` is only used for the human-readable live-region message.
  const commitBatchMove = useCallback((ids: string[], delta: number, anchorBar: TimelineBar) => {
    const items: RescheduleItem[] = ids
      .map((id) => allBars.find((b) => b.task.id === id))
      .filter((b): b is TimelineBar => !!b)
      .map((b) => ({ taskId: b.task.id, ...computeNewDates(b.task, "move", delta) }));
    if (items.length === 0) return;
    startTransition(async () => {
      const r = await batchReschedule(items);
      if (!r.ok) setToast(r.error ?? "Couldn't reschedule."); else setToast(null);
      router.refresh();
    });
    const anchorDates = computeNewDates(anchorBar.task, "move", delta);
    const extra = items.length > 1 ? ` (+${items.length - 1} linked task${items.length - 1 === 1 ? "" : "s"})` : "";
    setLive(`${anchorBar.task.title} moved ${delta > 0 ? "later" : "earlier"} one day${anchorDates.dueDate ? ` — due ${fmt(anchorDates.dueDate)}` : ""}${extra}.`);
  }, [allBars, router, startTransition]);

  // ---- reschedule drag ----
  const beginDrag = (e: React.PointerEvent, bar: TimelineBar, mode: DragMode) => {
    if (!interactive || !canEdit) return;
    // Shift-click (mode "move" only) toggles this bar into/out of the multiselect instead of
    // starting a drag — the keyboard equivalent is Enter/Space on a focused bar (onBarKeyDown).
    if (mode === "move" && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      toggleSelected(bar.task.id);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    const track = el.closest(".pm-gantt__track") as HTMLElement | null;
    const trackWidth = track?.clientWidth ?? 1;
    // Capture on the BAR (which carries the move/up handlers) so edge-handle drags
    // route their move/up events to the same place as body drags.
    const barEl = el.closest(".pm-gantt__bar") as HTMLElement | null;
    barEl?.setPointerCapture?.(e.pointerId);
    // Resize (start/end) never cascades — only a whole-bar "move" drag carries dependents/selection.
    const set = mode === "move" ? moveSet(bar.task.id) : new Set([bar.task.id]);
    setDrag({ taskId: bar.task.id, mode, startX: e.clientX, trackWidth, deltaDays: 0, moveSet: set });
  };
  const onDragMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const deltaDays = Math.round(((e.clientX - drag.startX) / Math.max(1, drag.trackWidth)) * effDays);
    if (deltaDays !== drag.deltaDays) setDrag({ ...drag, deltaDays });
  };
  const endDrag = (e: React.PointerEvent) => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (d.deltaDays === 0) return;
    const anchorBar = allBars.find((b) => b.task.id === d.taskId);
    if (!anchorBar) return;
    const items: RescheduleItem[] = [...d.moveSet]
      .map((id) => allBars.find((b) => b.task.id === id))
      .filter((b): b is TimelineBar => !!b)
      .map((b) => ({ taskId: b.task.id, ...computeNewDates(b.task, d.mode, d.deltaDays) }));
    if (items.length === 0) return;
    startTransition(async () => {
      // Sequential batch commit (no bulk endpoint); "all or nothing" is visual only — a partial
      // failure surfaces the first error and router.refresh() reconciles the UI either way.
      const r = await batchReschedule(items);
      if (!r.ok) setToast(r.error ?? "Couldn't reschedule."); else setToast(null);
      router.refresh();
    });
    const anchorDates = computeNewDates(anchorBar.task, d.mode, d.deltaDays);
    const extra = items.length > 1 ? ` (+${items.length - 1} linked task${items.length - 1 === 1 ? "" : "s"})` : "";
    setLive(`${anchorBar.task.title} rescheduled${anchorDates.startDate ? ` from ${fmt(anchorDates.startDate)}` : ""}${anchorDates.dueDate ? ` to ${fmt(anchorDates.dueDate)}` : ""}${extra}.`);
  };

  // ---- dependency draw ----
  const attemptLink = (targetId: string, fromId: string, fromTitle: string) => {
    if (targetId === fromId) return;
    if (hasCycle(allBars, targetId, fromId)) {
      setToast("Can't link — that would create a circular dependency.");
      setLive("Refused: circular dependency.");
      return;
    }
    const targetTitle = allBars.find((b) => b.task.id === targetId)?.task.title ?? "task";
    startTransition(async () => {
      const r = await addDependency(targetId, fromId);
      if (!r.ok) setToast(r.error ?? "Couldn't add dependency."); else setToast(null);
      router.refresh();
    });
    setLive(`${targetTitle} now blocked by ${fromTitle}.`);
  };
  const beginLinkPointer = (e: React.PointerEvent, bar: TimelineBar) => {
    if (!interactive || !canEdit) return;
    e.preventDefault();
    e.stopPropagation();
    setLink({ fromId: bar.task.id, fromTitle: bar.task.title });
  };
  const finishLinkPointer = (e: React.PointerEvent) => {
    if (!link) return;
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-bar-id]") as HTMLElement | null;
    const targetId = el?.dataset.barId;
    const from = link;
    setLink(null);
    if (targetId) attemptLink(targetId, from.fromId, from.fromTitle);
  };

  // ---- keyboard ----
  // P2-08: Enter/Space toggles multiselect on a focused bar (the bar is `role="button"`, so this
  // is exactly the expected activation semantics); arrow-nudge now moves the WHOLE move-together
  // set (this bar's selection-or-itself + transitive dependents), same batch commit as a mouse drag.
  const onBarKeyDown = (e: React.KeyboardEvent, bar: TimelineBar) => {
    if (!interactive) return;
    if (link) {
      if (e.key === "Enter") { e.preventDefault(); const f = link; setLink(null); attemptLink(bar.task.id, f.fromId, f.fromTitle); return; }
      if (e.key === "Escape") { e.preventDefault(); setLink(null); setLive("Link cancelled."); return; }
    }
    if (!canEdit) return;
    if (!link && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      toggleSelected(bar.task.id);
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const delta = e.key === "ArrowLeft" ? -1 : 1;
      commitBatchMove([...moveSet(bar.task.id)], delta, bar);
    }
  };
  const onLinkHandleKeyDown = (e: React.KeyboardEvent, bar: TimelineBar) => {
    if (!interactive || !canEdit) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      // The dependency-draw handle nests inside the bar's own key-handled div — stop the bubble
      // so a link-mode toggle here doesn't also fire the bar's Enter/Space multiselect handler.
      e.stopPropagation();
      if (link && link.fromId === bar.task.id) { setLink(null); setLive("Link cancelled."); }
      else { setLink({ fromId: bar.task.id, fromTitle: bar.task.title }); setLive(`Linking from ${bar.task.title}. Move to another task and press Enter to make it depend on this one; Escape cancels.`); }
    }
  };

  // ---- bar geometry incl. live drag preview ----
  // P2-08: every bar in `drag.moveSet` shifts together during a "move" drag (resize modes only
  // ever put the anchor itself in the set, so this reduces to the old single-bar behaviour there).
  const barStyle = (bar: TimelineBar): React.CSSProperties => {
    let left = bar.offsetPct;
    let width = bar.widthPct;
    if (drag && drag.moveSet.has(bar.task.id) && drag.deltaDays !== 0) {
      const dPct = (drag.deltaDays / Math.max(1, effDays)) * 100;
      if (drag.mode === "move") left += dPct;
      else if (drag.mode === "start") { left += dPct; width -= dPct; }
      else width += dPct;
    }
    left = Math.max(0, Math.min(100, left));
    width = Math.max(1.5, Math.min(100 - left, width));
    return { left: `${left}%`, width: `${width}%` };
  };
  const previewDates = (bar: TimelineBar): string | null => {
    if (!drag || !drag.moveSet.has(bar.task.id) || drag.deltaDays === 0) return null;
    const d = computeNewDates(bar.task, drag.mode, drag.deltaDays);
    return `${d.startDate ? fmt(d.startDate) : "—"} → ${d.dueDate ? fmt(d.dueDate) : "—"}`;
  };

  const navigate = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    router.push(taskHref(id));
  };

  const renderRow = (bar: TimelineBar) => {
    const t = bar.task;
    const preview = previewDates(bar);
    const dragging = !!drag?.moveSet.has(t.id);
    const linkSource = link?.fromId === t.id;
    const isSelected = selected.has(t.id);
    const urgencyTier = props.taskUrgency?.[t.id];
    // P2-05: colour from the status registry when supplied (inline, overrides the
    // legacy class); the class stays as the fallback for callers that don't pass it.
    const barColor = props.barColors?.[t.id];
    // P5-T1 — the urgency tier now reaches the BAR, as a 3px cap on its due end, not just the dot
    // in the label column. Only the three tiers that carry a judgement get a cap: `done` and
    // `undated` are states, not alarms, and painting them would put colour back on the axis for
    // no reason. The dot stays — colour is never the sole carrier of a tier.
    const uCap = urgencyTier === "overdue" || urgencyTier === "due-soon" || urgencyTier === "on-track"
      ? ` pm-gantt__bar--u-${urgencyTier}` : "";
    const cls = `pm-gantt__bar pm-gantt__bar--${t.status}${uCap}${bar.startsMissing ? " pm-gantt__bar--dashed" : ""}${dragging ? " pm-gantt__bar--dragging" : ""}${linkSource ? " pm-gantt__bar--linksrc" : ""}${isSelected ? " pm-gantt__bar--selected" : ""}`;
    const colorStyle: React.CSSProperties = barColor ? { background: barColor } : {};
    const title = `${t.title} · ${t.progress}%${t.dueDate ? ` · due ${fmt(t.dueDate)}` : ""}`;
    const fill = (
      <>
        <span className="pm-gantt__fill" style={{ width: `${t.progress}%` }} aria-hidden />
        <span className="pm-gantt__pct">{t.progress}%</span>
      </>
    );
    // P4-L3: row anatomy fidelity pass — avatar (Ball/assignee) · title · project name ·
    // tag chips · due date, closer to the reference's per-row layout. `showProjectName` skips
    // the redundant repeat when the caller already grouped rows under a project header
    // (groupBy="project", e.g. the department Timeline) — Repsona's own `@all` view (no
    // project grouping) is exactly the case where the name earns its place on every row.
    const showProjectName = groupBy !== "project";
    const rowTags = props.taskTags?.[t.id] ?? [];
    const assignee = t.assignee;
    return (
      <div className="pm-gantt__row" key={t.id}>
        <div className="pm-gantt__labelcell">
          <a className="pm-gantt__label" href={taskHref(t.id)} onClick={(e) => navigate(e, t.id)}>
            {/* Initials are decorative (aria-hidden); the name itself is real text for a screen
                reader — `title` alone is not reliably announced (same rule urgency.css documents). */}
            {assignee ? (
              <span className="pm-gantt__avatar" title={assignee.refName}>
                <span aria-hidden>{initials(assignee.refName)}</span>
                <span className="pm-sr-only">{assignee.refName}</span>
              </span>
            ) : (
              <span className="pm-gantt__avatar pm-gantt__avatar--empty">
                <span className="pm-sr-only">Unassigned</span>
              </span>
            )}
            <span className="pm-gantt__label-text">
              {/* Dense, many-row context — dot form, same rationale as the board card. */}
              {urgencyTier && <UrgencyChip tier={urgencyTier} variant="dot" />}
              {t.recurrence ? "↻ " : ""}{t.title}
            </span>
          </a>
          {(showProjectName || rowTags.length > 0 || t.dueDate) && (
            <div className="pm-gantt__meta">
              {showProjectName && t.projectName && <span className="pm-gantt__meta-project">{t.projectName}</span>}
              {rowTags.length > 0 && (
                <span className="pm-gantt__meta-tags">
                  {rowTags.map((tg) => <TagChip key={tg.id} label={tg.label} color={tg.color} />)}
                </span>
              )}
              {t.dueDate && <span className={`pm-due ${dueUrgencyClass(urgencyTier)}`}>{fmt(t.dueDate)}</span>}
            </div>
          )}
        </div>
        <div className="pm-gantt__track">
          {interactive ? (
            // Interactive: a div (so the dependency-draw <button> nests validly) —
            // navigation is via the label link, so the bar has no click-navigate to
            // conflict with drag. Focusable + arrow-nudge for the keyboard path.
            <div
              data-bar-id={t.id}
              ref={setBarRef(t.id)}
              role="button"
              tabIndex={0}
              aria-label={`${t.title}, ${t.progress}%${t.dueDate ? `, due ${fmt(t.dueDate)}` : ""}${isSelected ? ", selected" : ""}. Arrow keys reschedule; Enter or Space toggles multiselect; end handle draws a dependency.`}
              aria-pressed={isSelected}
              className={cls}
              style={{ ...barStyle(bar), ...colorStyle }}
              title={title}
              onPointerDown={canEdit ? (e) => beginDrag(e, bar, "move") : undefined}
              onPointerMove={onDragMove}
              onPointerUp={(e) => { if (link) finishLinkPointer(e); else endDrag(e); }}
              onKeyDown={(e) => onBarKeyDown(e, bar)}
            >
              {fill}
              {canEdit && (
                <>
                  <span className="pm-gantt__handle pm-gantt__handle--start" aria-hidden onPointerDown={(e) => beginDrag(e, bar, "start")} />
                  <span className="pm-gantt__handle pm-gantt__handle--end" aria-hidden onPointerDown={(e) => beginDrag(e, bar, "end")} />
                  <button
                    type="button" className="pm-gantt__link pm-gantt__link--end"
                    aria-label={`Draw dependency from ${t.title}`}
                    onPointerDown={(e) => beginLinkPointer(e, bar)}
                    onKeyDown={(e) => onLinkHandleKeyDown(e, bar)}
                  />
                </>
              )}
            </div>
          ) : (
            // Legacy read-only: a plain link, as before (now with an in-bar progress fill).
            <a className={cls} href={taskHref(t.id)} style={{ ...barStyle(bar), ...colorStyle }} title={title} onClick={(e) => navigate(e, t.id)}>
              {fill}
            </a>
          )}
          {preview && <span className="pm-gantt__tip" style={barStyle(bar)}>{preview}</span>}
        </div>
      </div>
    );
  };

  if (allBars.length === 0 && undatedGroups.length === 0) {
    return <EmptyNote>No scheduled work yet — add start/due dates to tasks to see them here.</EmptyNote>;
  }

  return (
    // P5-B5 — the toolbar sits OUTSIDE the horizontal scroller. It used to be the scroller's first
    // child, so scrolling right to reach a later month carried every control off the left edge with
    // the chart: to change the zoom you first had to scroll back. Lifting it out is the whole fix —
    // no sticky positioning, which in a horizontal scroller would also have to fight the fact that
    // the toolbar is as wide as the scrolled CONTENT, not as wide as the viewport.
    <>
      {/* P4-C1/P4-C2 toolbar — zoom + the explicit date window. Renders unconditionally (both are
          read-only-safe chrome, unlike the drag/link interactions gated on `interactive`/`canEdit`
          below), and is entirely URL-driven so it survives navigation/bookmarking like `?collapsed=`. */}
      <div className="pm-gantt__toolbar">
        <div className="pm-gantt__zoomgroup" role="group" aria-label="Gantt zoom">
          {(["day", "week", "month"] as const).map((z) => (
            <button
              key={z} type="button" className="pm-gantt__zoom"
              aria-pressed={zoomParam === z}
              onClick={() => setZoom(z)}
            >
              {z === "day" ? "Day" : z === "week" ? "Week" : "Month"}
            </button>
          ))}
        </div>
        <form
          className="pm-gantt__window"
          aria-label="Date window"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const from = (form.elements.namedItem("gfrom") as HTMLInputElement)?.value ?? "";
            const to = (form.elements.namedItem("gto") as HTMLInputElement)?.value ?? "";
            applyWindow(from, to);
          }}
        >
          {/* `key`'d on the current URL value so an external change (Apply/Clear, or a bookmarked
              link) is reflected in these uncontrolled inputs by remounting them — plain
              `defaultValue` would only apply once and never follow a later prop/URL change. */}
          <input key={`gfrom-${winFromParam ?? effStart}`} name="gfrom" type="date" defaultValue={winFromParam ?? effStart} aria-label="Window start" />
          <span className="pm-gantt__window-sep" aria-hidden>–</span>
          <input key={`gto-${winToParam ?? effEnd}`} name="gto" type="date" defaultValue={winToParam ?? effEnd} aria-label="Window end" />
          {/* P5-B5 — the clear sits with the DATES it clears, before the submit. After it, the
              submit's flush-right alignment pushed it outside the window shell entirely, and a
              destructive reset immediately adjacent to the commit button is a mis-tap waiting to
              happen either way. */}
          {windowActive && (
            <button type="button" className="pm-gantt__window-clear" onClick={clearWindow} aria-label="Clear date window — show the full timeline">×</button>
          )}
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm">Apply</button>
        </form>
        <span className="pm-gantt__toolbar-spacer" aria-hidden />
        {/* P4-C3 — the filter bar. A `<details>` disclosure (same "collapsed by default, state
            survives in the URL" shape as everything else in this toolbar) rather than always-open
            chrome, so a read-only viewer who never filters isn't shown eight facets by default; it
            opens itself when a filter is already active (e.g. from a bookmarked/shared link). */}
        <details className="pm-gantt__filterbar" open={filtersActive || undefined}>
          <summary className="pm-gantt__filterbar-summary">
            Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
          </summary>
          <div className="pm-gantt__filterbar-body">
            <form className="pm-gantt__filterbar-row" onSubmit={applyTextFilters} aria-label="Keywords and due-date filters">
              <label className="pm-gantt__filterbar-field">
                <span className="pm-sr-only">{PM_TERMS.keywords}</span>
                <input key={`gq-${gq}`} name="gq" type="search" placeholder={PM_TERMS.keywords} defaultValue={gq} aria-label={PM_TERMS.keywords} />
              </label>
              <label className="pm-gantt__filterbar-field">
                <span className="pm-sr-only">{PM_TERMS.dueDate} from</span>
                <input key={`gduefrom-${gDueFrom}`} name="gduefrom" type="date" defaultValue={gDueFrom} aria-label={`${PM_TERMS.dueDate} from`} />
              </label>
              <span className="pm-gantt__window-sep" aria-hidden>–</span>
              <label className="pm-gantt__filterbar-field">
                <span className="pm-sr-only">{PM_TERMS.dueDate} to</span>
                <input key={`gdueto-${gDueTo}`} name="gdueto" type="date" defaultValue={gDueTo} aria-label={`${PM_TERMS.dueDate} to`} />
              </label>
              <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm">Apply filters</button>
              {filtersActive && (
                <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={clearFilters}>Clear filters</button>
              )}
            </form>

            {facetOptions.statuses.length > 0 && (
              <div className="pm-tagfilter">
                <span className="pm-tagfilter__label">Status</span>
                <div className="pm-tagfilter__options">
                  {facetOptions.statuses.map(([id, label]) => (
                    <label key={id} className="pm-tagfilter__opt">
                      <input type="checkbox" checked={filters.status.has(id)} onChange={() => toggleSetParam("gstatus", id)} />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {facetOptions.priorities.length > 0 && (
              <div className="pm-tagfilter">
                <span className="pm-tagfilter__label">{PM_TERMS.priority}</span>
                <div className="pm-tagfilter__options">
                  {facetOptions.priorities.map((p) => (
                    <label key={p} className="pm-tagfilter__opt">
                      <input type="checkbox" checked={filters.priority.has(p)} onChange={() => toggleSetParam("gpriority", p)} />
                      {GANTT_PRIORITY_LABEL[p]}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {facetOptions.responsibles.length > 0 && (
              <div className="pm-tagfilter">
                <span className="pm-tagfilter__label">{PM_TERMS.responsible}</span>
                <div className="pm-tagfilter__options">
                  {facetOptions.responsibles.map(([id, name]) => (
                    <label key={id} className="pm-tagfilter__opt">
                      <input type="checkbox" checked={filters.responsible.has(id)} onChange={() => toggleSetParam("gresponsible", id)} />
                      {name}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {facetOptions.balls.length > 0 && (
              <div className="pm-tagfilter">
                <span className="pm-tagfilter__label">{PM_TERMS.ball}</span>
                <div className="pm-tagfilter__options">
                  {facetOptions.balls.map(([id, name]) => (
                    <label key={id} className="pm-tagfilter__opt">
                      <input type="checkbox" checked={filters.ball.has(id)} onChange={() => toggleSetParam("gball", id)} />
                      {name}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {facetOptions.tags.length > 0 && (
              <div className="pm-tagfilter">
                <span className="pm-tagfilter__label">{PM_TERMS.tags}</span>
                <div className="pm-tagfilter__options">
                  {facetOptions.tags.map((tg) => (
                    <label key={tg.id} className="pm-tagfilter__opt">
                      <input type="checkbox" checked={filters.tags.has(tg.id)} onChange={() => toggleSetParam("gtags", tg.id)} />
                      {tg.label}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {facetOptions.milestones.length > 0 && (
              <div className="pm-tagfilter">
                <span className="pm-tagfilter__label">{PM_TERMS.milestones}</span>
                <div className="pm-tagfilter__options">
                  {facetOptions.milestones.map((m) => (
                    <label key={m.id} className="pm-tagfilter__opt">
                      <input type="checkbox" checked={filters.milestone.has(m.id)} onChange={() => toggleSetParam("gmilestone", m.id)} />
                      {m.name}
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="pm-gantt__filterbar-toggles">
              <label className="pm-tagfilter__opt" title={props.taskUrgency ? undefined : "Unavailable — this view wasn't given urgency data."}>
                <input
                  type="checkbox" checked={overdueOnly} disabled={!props.taskUrgency}
                  onChange={(e) => setOverdueOnly(e.target.checked)}
                />
                {PM_TERMS.overdueOnly}
                {!props.taskUrgency && <span className="pm-sr-only"> — unavailable: this view wasn't given urgency data.</span>}
              </label>
              <label className="pm-tagfilter__opt">
                <input type="checkbox" checked={!hideClosed} onChange={(e) => setHideClosed(!e.target.checked)} />
                {PM_TERMS.showClosed}
              </label>
              {/* P4-C3 / plan §5 decision 11 (open): our `Subtasks` are a checklist ON a task, not
                  first-class `pm_tasks` rows, so there is nothing for a "Sub-task" toggle to
                  include/exclude. Rendering it active would silently do nothing — worse than being
                  honest about the gap — so it stays visible (for Repsona-fidelity scanability) but
                  DISABLED, with the reason on the control itself, not hidden in a mouse-only tooltip. */}
              <label
                className="pm-tagfilter__opt pm-tagfilter__opt--disabled"
                title="Not applicable yet — our Subtasks are a checklist on a task, not standalone tasks (open decision, plan §5 decision 11)."
              >
                <input type="checkbox" disabled aria-disabled="true" readOnly checked={false} />
                {PM_TERMS.subTask}
                <span className="pm-sr-only"> — not applicable: Subtasks are a checklist, not standalone tasks (open decision).</span>
              </label>
            </div>
          </div>
        </details>
        {/* P2-08: hides entirely when the series is empty (disabled/stale backend, or a project
            with no tasks yet) — no overlay, no error, per design spec §4 phase-2. P5-T1 dropped
            the extra "also hidden under an explicit window" rule: the points carry dates and are
            remapped onto the live axis now (see `viewBurndown`), so there is nothing left to
            misalign, and the toggle no longer disappears the moment a reader picks a window. */}
        {/* P4-C5 — export the VISIBLE (filtered) rows, never the full unfiltered set; hidden when
            there's nothing to export rather than shown disabled (same convention as the burndown
            toggle beside it — no control, no error, when its data is empty). */}
        {filteredTotal > 0 && (
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={exportCsv}>Export CSV</button>
        )}
        {viewBurndown.length > 0 && (
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" aria-pressed={showBurndown} onClick={() => setShowBurndown((v) => !v)}>
            {showBurndown ? "Hide burndown" : "Show burndown"}
          </button>
        )}
        {/* P5-T1 — the key. The chart shipped with five different bar treatments and no legend
            anywhere on the page, so the fills were tribal knowledge. Status is shape here, which
            is exactly the kind of encoding that needs saying once, out loud. */}
        <div className="pm-gantt__legend">
          <span className="pm-gantt__legend-item"><span className="pm-gantt__legend-swatch" aria-hidden />Doing</span>
          <span className="pm-gantt__legend-item"><span className="pm-gantt__legend-swatch pm-gantt__legend-swatch--hollow" aria-hidden />To do</span>
          <span className="pm-gantt__legend-item"><span className="pm-gantt__legend-swatch pm-gantt__legend-swatch--blocked" aria-hidden />Blocked</span>
          <span className="pm-gantt__legend-item"><span className="pm-gantt__legend-swatch pm-gantt__legend-swatch--done" aria-hidden />Done</span>
          {groupBy === "project" && props.projectBars && (
            <span className="pm-gantt__legend-item"><span className="pm-gantt__legend-swatch pm-gantt__legend-swatch--slip" aria-hidden />Past commitment</span>
          )}
        </div>
      </div>
      <div className="erp-scroll" style={{ overflowX: "auto" }}>
      <div className="pm-gantt" ref={containerRef} style={ganttWidthPx ? { minWidth: `${ganttWidthPx}px` } : undefined}>
        {/* P4-L3/P4-C1: day/week/month header with weekday labels — dense (<=~a year) spans get a
            real per-day/week tick axis (or, at Month zoom, calendar-month ticks regardless of
            span); wider undense spans without Month zoom fall back to the plain start/end label
            rather than one <span> per day. */}
        {useFineAxis ? (
          <div className="pm-gantt__daxis">
            <span className="pm-gantt__daxis-head">Task</span>
            <div>
              {/* P5-T1 — the month band. Without it the day ticks below name a day number and a
                  weekday and nothing else, so the same "7" appears in July and in August with no
                  way to tell them apart. */}
              {monthBands.length > 0 && (
                <div className="pm-gantt__daxis-months" aria-hidden>
                  {monthBands.map((mb) => (
                    <span key={mb.key} className="pm-gantt__daxis-month" style={{ left: `${mb.pct}%`, width: `${mb.widthPct}%` }}>{mb.label}</span>
                  ))}
                </div>
              )}
              <div className="pm-gantt__daxis-track">
                {headerTicks.map((tk) => (
                  <span key={tk.iso} className="pm-gantt__daxis-tick" style={{ left: `${tk.pct}%` }}>
                    {tk.labelled ? (
                      tk.label ? (
                        <span className="pm-gantt__daxis-d">{tk.label}</span>
                      ) : (
                        <>
                          {showWeekday && <span className="pm-gantt__daxis-wd">{weekdayAbbr(tk.iso)}</span>}
                          <span className="pm-gantt__daxis-d">{dayOfMonth(tk.iso)}</span>
                        </>
                      )
                    ) : null}
                  </span>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="pm-gantt__axis"><span>{fmt(effStart)}</span><span>{fmt(effEnd)}</span></div>
        )}

        {/* Weekend banding — a decorative fill behind every row (negative z-index), never text,
            so it carries no contrast duty; capped to `dense` spans (never Month zoom) for the same
            reason as the header ticks above. */}
        {weekendBands.length > 0 && (
          <div className="pm-gantt__weekends" aria-hidden>
            {weekendBands.map((b, i) => (
              <span key={i} className="pm-gantt__weekend" style={{ left: `${b.pct}%`, width: `${b.widthPct}%` }} />
            ))}
          </div>
        )}

        {/* TODAY marker — a red vertical rule spanning every row, Repsona-style. Hidden entirely
            when "today" (server-pinned via `todayISO`, or the post-mount client fallback — see
            the prop doc) falls outside this axis's own [start, end]. Wrapped the same way as the
            weekend bands above: the outer box aligns to the track's left edge, the inner line is
            positioned by percentage OF that box so it shares the bars' own offsetPct math. */}
        {todayPct !== null && (
          <div className="pm-gantt__todaybox" aria-hidden>
            <span className="pm-gantt__todayline" style={{ left: `${todayPct}%` }} />
          </div>
        )}

        {showBurndown && viewBurndown.length > 0 && (
          <>
            <div className="pm-gantt__bdrow">
              <span className="pm-gantt__bdlabel">Burndown</span>
              <div className="pm-gantt__bdtrack">
                <svg className="pm-gantt__bdsvg" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Burndown chart: ideal versus actual remaining work">
                  <polyline className="pm-gantt__bdline pm-gantt__bdline--ideal" points={bdPoints(viewBurndown, "idealPct")} />
                  <polyline className="pm-gantt__bdline pm-gantt__bdline--actual" points={bdPoints(viewBurndown, "actualPct")} />
                </svg>
              </div>
            </div>
            <div className="pm-gantt__bdlegend">
              <span><span className="pm-gantt__bdlegend-dot pm-gantt__bdlegend-dot--ideal" aria-hidden /> Ideal</span>
              <span><span className="pm-gantt__bdlegend-dot pm-gantt__bdlegend-dot--actual" aria-hidden /> Actual remaining</span>
            </div>
          </>
        )}

        {filteredMilestones.length > 0 && (
          <div className="pm-gantt__msrow">
            <span className="pm-gantt__mslabel">Milestones</span>
            <div className="pm-gantt__mstrack">
              {filteredMilestones.map((m) => (
                <span key={m.id} className="pm-gantt__milestone" style={{ left: `${m.offsetPct}%` }} title={`${m.name} · ${fmt(m.date)}`} />
              ))}
            </div>
          </div>
        )}

        {/* vertical dashed guidelines spanning the body */}
        {filteredMilestones.length > 0 && (
          <div className="pm-gantt__guides" aria-hidden>
            {filteredMilestones.map((m) => <span key={m.id} className="pm-gantt__guide" style={{ left: `${m.offsetPct}%` }} />)}
          </div>
        )}

        {filteredGroups.map((g) => {
          const isCollapsed = collapsed.has(g.key);
          return (
            <div className="pm-gantt__group" key={g.key}>
              {grouped && g.label !== "" && (
                <button type="button" className="pm-gantt__group-head" aria-expanded={!isCollapsed} onClick={() => toggleCollapsed(g.key)}>
                  {/* P5-B5 — the head spans the whole scrolled width, so its TEXT is what scrolls
                      away; the inner run is what has to freeze, not the button. */}
                  <span className="pm-gantt__group-headline">
                    <span className="pm-gantt__disc" aria-hidden>{isCollapsed ? "▸" : "▾"}</span>
                    <span className="pm-gantt__group-label">{g.label}</span>
                    <span className="pm-gantt__group-count">{g.bars.length}</span>
                  </span>
                </button>
              )}
              {/* P4-H2 — the project bar: authored range alongside the task-derived envelope
                  (decision 12). Rendered right on the group's header, regardless of `isCollapsed`
                  — it's the "at a glance" summary the ticket asks for, so collapsing the group's
                  individual tasks must not also hide it. Absent `projectBars` entry, or one with
                  no dates in either half, renders nothing (see `projectRangeGeometry`'s doc). */}
              {groupBy === "project" && (() => {
                const pb = props.projectBars?.[g.key];
                if (!pb) return null;
                const authored = projectRangeGeometry(pb.authoredStart, pb.authoredEnd, effStart, effDays);
                const derived = projectRangeGeometry(pb.derivedStart, pb.derivedEnd, effStart, effDays);
                if (!authored && !derived) return null;
                const tier = props.projectUrgency?.[g.key];
                const authoredLabel = pb.authoredStart || pb.authoredEnd
                  ? `${pb.authoredStart ? fmt(pb.authoredStart) : "—"} to ${pb.authoredEnd ? fmt(pb.authoredEnd) : "—"}`
                  : null;
                const derivedLabel = pb.derivedStart || pb.derivedEnd
                  ? `${pb.derivedStart ? fmt(pb.derivedStart) : "—"} to ${pb.derivedEnd ? fmt(pb.derivedEnd) : "—"}`
                  : null;
                // P5-T1 — THE SLIP. Decision 12 calls the gap between the commitment and where the
                // work actually sits the slippage signal, but the gap was only ever implied: two
                // hairline bars 12px apart, and the reader had to measure it by eye. It is a
                // number, so it is rendered as one. Only an OVERRUN counts — a project whose work
                // finishes inside its commitment draws no lane, so the mark can only mean bad news.
                const slipDays = pb.authoredEnd && pb.derivedEnd && pb.derivedEnd > pb.authoredEnd
                  ? Math.round((Date.parse(pb.derivedEnd) - Date.parse(pb.authoredEnd)) / DAY)
                  : 0;
                const slip = slipDays > 0 ? projectRangeGeometry(pb.authoredEnd, pb.derivedEnd, effStart, effDays) : null;
                return (
                  <div className="pm-gantt__row pm-gantt__projectbar-row">
                    <div className="pm-gantt__labelcell">
                      <span className="pm-gantt__projectbar-label">
                        Project range
                        {tier && <UrgencyChip tier={tier} variant="dot" />}
                      </span>
                      {/* The bars below are `aria-hidden` (pure geometry); this is their one
                          accessible description, same "a colour/position is never the sole
                          carrier" rule `UrgencyChip`'s own dot variant follows. */}
                      <span className="pm-sr-only">
                        {authoredLabel ? `Authored ${authoredLabel}.` : "No authored range yet."}
                        {" "}
                        {derivedLabel ? `Actual work spans ${derivedLabel}.` : "No dated tasks yet."}
                        {slipDays > 0 ? ` ${slipDays} day${slipDays === 1 ? "" : "s"} past the committed end.` : ""}
                      </span>
                    </div>
                    <div className="pm-gantt__track pm-gantt__projectbar-track" aria-hidden>
                      {authored && (
                        <span
                          className={`pm-gantt__projectbar pm-gantt__projectbar--authored${tier ? ` pm-gantt__projectbar--${tier}` : ""}`}
                          style={{ left: `${authored.offsetPct}%`, width: `${authored.widthPct}%` }}
                          title={authoredLabel ? `Authored: ${authoredLabel}` : undefined}
                        />
                      )}
                      {derived && (
                        <span
                          className="pm-gantt__projectbar pm-gantt__projectbar--derived"
                          style={{ left: `${derived.offsetPct}%`, width: `${derived.widthPct}%` }}
                          title={derivedLabel ? `Actual work: ${derivedLabel}` : undefined}
                        />
                      )}
                      {slip && (
                        <>
                          <span
                            className="pm-gantt__slip"
                            style={{ left: `${slip.offsetPct}%`, width: `${slip.widthPct}%` }}
                            title={`${slipDays} day${slipDays === 1 ? "" : "s"} past the committed end`}
                          />
                          {/* Clamped so a slip running to the right edge doesn't push its own
                              number off the axis — the label is the payload, not the bar. */}
                          <span className="pm-gantt__slip-label" style={{ left: `${Math.min(slip.offsetPct + slip.widthPct, 88)}%` }}>
                            +{slipDays}d
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                );
              })()}
              {!isCollapsed && g.bars.map(renderRow)}
              {/* P4-C6 — inline "Add a task", only where the caller supplied a creator AND write
                  access is on; every other mount renders nothing extra here (see `onAddTask`'s
                  doc on the props interface for why this can't just be a plain callback). */}
              {!isCollapsed && props.onAddTask && canEdit && (
                <form
                  className="pm-gantt__addtask"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const form = e.currentTarget;
                    const input = form.elements.namedItem("title") as HTMLInputElement;
                    const title = input.value.trim();
                    const addTask = props.onAddTask;
                    if (!title || !addTask) return;
                    const groupKey = g.key;
                    startTransition(async () => {
                      const r = await addTask(groupKey, title);
                      if (!r.ok) setToast(r.error ?? "Couldn't add the task.");
                      else { setToast(null); setLive(`${title} added.`); router.refresh(); }
                    });
                    input.value = "";
                  }}
                >
                  <input
                    name="title" type="text" placeholder={PM_TERMS.addATask}
                    aria-label={`${PM_TERMS.addATask} to ${g.label || "this group"}`}
                  />
                  <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm">+ {PM_TERMS.addATask}</button>
                </form>
              )}
            </div>
          );
        })}

        {filteredTotal === 0 && filtersActive && (
          <EmptyNote>No tasks match these filters.</EmptyNote>
        )}

        {undatedGroups.map((g) => (
          <div className="pm-gantt__group pm-gantt__group--empty" key={g.key}>
            <div className="pm-gantt__group-head pm-gantt__group-head--static">
              <span className="pm-gantt__group-headline">
                <span className="pm-gantt__disc" aria-hidden>▸</span>
                <span className="pm-gantt__group-label">{g.label}</span>
                <span className="pm-gantt__group-note">{g.note}</span>
              </span>
            </div>
          </div>
        ))}

        {/* dependency lines, measured from the DOM */}
        {lines.length > 0 && (
          <svg className="pm-gantt__deps" aria-hidden>
            {lines.map((l, i) => (
              <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
                stroke={l.conflict ? "var(--dept-risk)" : "var(--erp-ink-50)"} strokeWidth={1.5}
                strokeDasharray={l.conflict ? "4 3" : undefined} />
            ))}
          </svg>
        )}
      </div>

      </div>

      {toast && <p className="pm-board__toast" style={{ marginTop: 10 }} role="status">{toast}</p>}
      <div className="pm-sr-only" aria-live="polite">{live}</div>
      {pending && <span className="pm-sr-only" aria-live="polite">Saving…</span>}
    </>
  );
}
