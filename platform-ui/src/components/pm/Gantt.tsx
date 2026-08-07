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
  const effStart = windowActive ? winFromParam! : timeline.start;
  const effEnd = windowActive ? winToParam! : timeline.end;
  const effDays = windowActive ? Math.max(1, Math.round((Date.parse(effEnd) - Date.parse(effStart)) / DAY)) : timeline.days;

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
    () => (windowActive ? groups.map((g) => ({ ...g, bars: applyWindowToBars(g.bars, effStart, effEnd) })) : groups),
    [groups, windowActive, effStart, effEnd],
  );
  const viewMilestones: MilestoneMarker[] = useMemo(
    () => (windowActive ? applyWindowToMilestones(milestones ?? [], effStart, effDays) : (milestones ?? [])),
    [milestones, windowActive, effStart, effDays],
  );

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

  useLayoutEffect(() => { recomputeLines(); }, [recomputeLines, collapsedParam, viewGroups, drag]);
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
    const cls = `pm-gantt__bar pm-gantt__bar--${t.status}${bar.startsMissing ? " pm-gantt__bar--dashed" : ""}${dragging ? " pm-gantt__bar--dragging" : ""}${linkSource ? " pm-gantt__bar--linksrc" : ""}${isSelected ? " pm-gantt__bar--selected" : ""}`;
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
    <div className="erp-scroll" style={{ overflowX: "auto" }}>
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
          <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm">Apply</button>
          {windowActive && (
            <button type="button" className="pm-gantt__window-clear" onClick={clearWindow} aria-label="Clear date window — show the full timeline">×</button>
          )}
        </form>
      </div>

      {/* P2-08: hides entirely when the series is empty (disabled/stale backend, or a project
          with no tasks yet) — no overlay, no error, per design spec §4 phase-2. Also hidden while
          an explicit window is active: the overlay's x-positions are computed against the
          SERVER-derived timeline (there is no per-point date to remap against an arbitrary
          window — unlike bars/milestones, which carry real dates), so showing it here would
          silently misalign rather than degrade gracefully. */}
      {burndown.length > 0 && !windowActive && (
        <div className="pm-gantt__bdtoggle">
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" aria-pressed={showBurndown} onClick={() => setShowBurndown((v) => !v)}>
            {showBurndown ? "Hide burndown" : "Show burndown"}
          </button>
        </div>
      )}
      <div className="pm-gantt" ref={containerRef} style={ganttWidthPx ? { minWidth: `${ganttWidthPx}px` } : undefined}>
        {/* P4-L3/P4-C1: day/week/month header with weekday labels — dense (<=~a year) spans get a
            real per-day/week tick axis (or, at Month zoom, calendar-month ticks regardless of
            span); wider undense spans without Month zoom fall back to the plain start/end label
            rather than one <span> per day. */}
        {useFineAxis ? (
          <div className="pm-gantt__daxis">
            <span className="pm-gantt__daxis-head">Task</span>
            <div className="pm-gantt__daxis-track">
              {headerTicks.map((tk) => (
                <span key={tk.iso} className="pm-gantt__daxis-tick" style={{ left: `${tk.pct}%` }}>
                  {tk.labelled ? (
                    tk.label ? (
                      <span className="pm-gantt__daxis-d">{tk.label}</span>
                    ) : (
                      <>
                        <span className="pm-gantt__daxis-wd">{weekdayAbbr(tk.iso)}</span>
                        <span className="pm-gantt__daxis-d">{dayOfMonth(tk.iso)}</span>
                      </>
                    )
                  ) : null}
                </span>
              ))}
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

        {showBurndown && burndown.length > 0 && !windowActive && (
          <>
            <div className="pm-gantt__bdrow">
              <span className="pm-gantt__bdlabel">Burndown</span>
              <div className="pm-gantt__bdtrack">
                <svg className="pm-gantt__bdsvg" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Burndown chart: ideal versus actual remaining work">
                  <polyline className="pm-gantt__bdline pm-gantt__bdline--ideal" points={bdPoints(burndown, "idealPct")} />
                  <polyline className="pm-gantt__bdline pm-gantt__bdline--actual" points={bdPoints(burndown, "actualPct")} />
                </svg>
              </div>
            </div>
            <div className="pm-gantt__bdlegend">
              <span><span className="pm-gantt__bdlegend-dot pm-gantt__bdlegend-dot--ideal" aria-hidden /> Ideal</span>
              <span><span className="pm-gantt__bdlegend-dot pm-gantt__bdlegend-dot--actual" aria-hidden /> Actual remaining</span>
            </div>
          </>
        )}

        {viewMilestones.length > 0 && (
          <div className="pm-gantt__msrow">
            <span className="pm-gantt__mslabel">Milestones</span>
            <div className="pm-gantt__mstrack">
              {viewMilestones.map((m) => (
                <span key={m.id} className="pm-gantt__milestone" style={{ left: `${m.offsetPct}%` }} title={`${m.name} · ${fmt(m.date)}`} />
              ))}
            </div>
          </div>
        )}

        {/* vertical dashed guidelines spanning the body */}
        {viewMilestones.length > 0 && (
          <div className="pm-gantt__guides" aria-hidden>
            {viewMilestones.map((m) => <span key={m.id} className="pm-gantt__guide" style={{ left: `${m.offsetPct}%` }} />)}
          </div>
        )}

        {viewGroups.map((g) => {
          const isCollapsed = collapsed.has(g.key);
          return (
            <div className="pm-gantt__group" key={g.key}>
              {grouped && g.label !== "" && (
                <button type="button" className="pm-gantt__group-head" aria-expanded={!isCollapsed} onClick={() => toggleCollapsed(g.key)}>
                  <span className="pm-gantt__disc" aria-hidden>{isCollapsed ? "▸" : "▾"}</span>
                  <span className="pm-gantt__group-label">{g.label}</span>
                  <span className="pm-gantt__group-count">{g.bars.length}</span>
                </button>
              )}
              {!isCollapsed && g.bars.map(renderRow)}
            </div>
          );
        })}

        {undatedGroups.map((g) => (
          <div className="pm-gantt__group pm-gantt__group--empty" key={g.key}>
            <div className="pm-gantt__group-head pm-gantt__group-head--static">
              <span className="pm-gantt__disc" aria-hidden>▸</span>
              <span className="pm-gantt__group-label">{g.label}</span>
              <span className="pm-gantt__group-note">{g.note}</span>
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

      {toast && <p className="pm-board__toast" style={{ marginTop: 10 }} role="status">{toast}</p>}
      <div className="pm-sr-only" aria-live="polite">{live}</div>
      {pending && <span className="pm-sr-only" aria-live="polite">Saving…</span>}
    </div>
  );
}
