"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import type {
  Timeline, TimelineBar, PmTask, GanttGroup, GanttGroupBy, MilestoneMarker, GanttDepEdge,
  BurndownOverlayPoint,
} from "@/lib/pm";
import { addDependency, batchReschedule, type RescheduleItem } from "@/lib/pmActions";
import { EmptyNote } from "@/components/systems/EmptyNote";
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
}

const DAY = 24 * 3600 * 1000;
const fmt = (d: string) => new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
const dayShift = (isoDate: string, n: number) => new Date(Date.parse(isoDate) + n * DAY).toISOString().slice(0, 10);

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
  const groups: GanttGroup[] = props.groups ?? [{ key: "__all", label: "", bars: timeline.bars }];
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

  const containerRef = useRef<HTMLDivElement | null>(null);
  const barRefs = useRef(new Map<string, HTMLElement | null>());
  const setBarRef = (id: string) => (el: HTMLElement | null) => { barRefs.current.set(id, el); };

  // ---- dependency lines: measured from the live DOM (grouping/collapse-agnostic) ----
  const recomputeLines = useCallback(() => {
    const edges = depEdges ?? [];
    const container = containerRef.current;
    if (!container || edges.length === 0) { setLines([]); return; }
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

  useLayoutEffect(() => { recomputeLines(); }, [recomputeLines, collapsedParam, groups, drag]);
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
    const deltaDays = Math.round(((e.clientX - drag.startX) / Math.max(1, drag.trackWidth)) * timeline.days);
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
  const onBallKeyDown = (e: React.KeyboardEvent, bar: TimelineBar) => {
    if (!interactive || !canEdit) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      // The ball nests inside the bar's own key-handled div — stop the bubble so a link-mode
      // toggle here doesn't also fire the bar's Enter/Space multiselect-toggle handler above.
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
      const dPct = (drag.deltaDays / Math.max(1, timeline.days)) * 100;
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
    return (
      <div className="pm-gantt__row" key={t.id}>
        <a className="pm-gantt__label" href={taskHref(t.id)} onClick={(e) => navigate(e, t.id)}>{t.recurrence ? "↻ " : ""}{t.title}</a>
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
                    type="button" className="pm-gantt__ball pm-gantt__ball--end"
                    aria-label={`Draw dependency from ${t.title}`}
                    onPointerDown={(e) => beginLinkPointer(e, bar)}
                    onKeyDown={(e) => onBallKeyDown(e, bar)}
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
      {/* P2-08: hides entirely when the series is empty (disabled/stale backend, or a project
          with no tasks yet) — no overlay, no error, per design spec §4 phase-2. */}
      {burndown.length > 0 && (
        <div className="pm-gantt__bdtoggle">
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" aria-pressed={showBurndown} onClick={() => setShowBurndown((v) => !v)}>
            {showBurndown ? "Hide burndown" : "Show burndown"}
          </button>
        </div>
      )}
      <div className="pm-gantt" ref={containerRef}>
        <div className="pm-gantt__axis"><span>{fmt(timeline.start)}</span><span>{fmt(timeline.end)}</span></div>

        {showBurndown && burndown.length > 0 && (
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

        {milestones && milestones.length > 0 && (
          <div className="pm-gantt__msrow">
            <span className="pm-gantt__mslabel">Milestones</span>
            <div className="pm-gantt__mstrack">
              {milestones.map((m) => (
                <span key={m.id} className="pm-gantt__milestone" style={{ left: `${m.offsetPct}%` }} title={`${m.name} · ${fmt(m.date)}`} />
              ))}
            </div>
          </div>
        )}

        {/* vertical dashed guidelines spanning the body */}
        {milestones && milestones.length > 0 && (
          <div className="pm-gantt__guides" aria-hidden>
            {milestones.map((m) => <span key={m.id} className="pm-gantt__guide" style={{ left: `${m.offsetPct}%` }} />)}
          </div>
        )}

        {groups.map((g) => {
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
