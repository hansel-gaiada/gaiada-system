"use client";
import { useCallback, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { AxisColumn, PmTask, Tag, UrgencyTier } from "@/lib/pm";
import type { GridRow } from "@/lib/departments";
import { ProgressBar } from "./ProgressBar";
import { TagChip } from "./TagChip";
import { UrgencyChip } from "./UrgencyChip";
import "./pm.css";

// The board unifies every grouping axis (status/assignee/priority/division —
// P1-03) through this one component. `K` is the column-key type for whichever
// axis is being rendered (TaskStatus/Priority/string), inferred from the
// `columns`+`move` props at the call site — no separate BoardLanes anymore.
interface Props<K extends string> {
  columns: AxisColumn<K>[];
  // Commits a drag/keyboard move. `responsibleId` is only ever passed on the
  // division axis (columns carrying `people`) — either the current
  // responsible already belongs to the target division, or it's whatever the
  // ambiguity popover's pick resolved to.
  move: (taskId: string, columnKey: K, responsibleId?: string) => Promise<{ ok: boolean; error?: string; pick?: { options: { id: string; name: string }[] } }>;
  // P2-05 dept board (union-by-label, §7 D-4): when `move` resolves with a
  // `pick` (the card's project has no same-label status), Board opens the
  // anchored popover with those options and commits the chosen status id via
  // `movePick`. Unused by single-project / other-axis boards.
  movePick?: (taskId: string, choiceId: string) => Promise<{ ok: boolean; error?: string }>;
  // P2-05: render a status-colour dot on each column head. Off by default so
  // un-customized (default-status) boards stay pixel-identical to before.
  colorColumns?: boolean;
  blockedIds?: Set<string>;
  // Task-link base path (P1-06, design spec §5). `Board` is a client
  // component, so a function prop can't cross the RSC boundary from its
  // (server) callers — the caller passes a serializable string instead:
  // `taskHrefBase ? `${taskHrefBase}/${id}` : `/tasks/${id}`. Nested mounts
  // (in-console) pass e.g. `/departments/{deptId}/projects/{projectId}/tasks`
  // so task links stay in-console; the standalone mount passes nothing.
  taskHrefBase?: string;
  // P2-02 — each card's tag ids (`task.tags`, project-scoped) resolved to full
  // Tag objects by the SERVER caller, keyed by task id. Board is a client
  // component and can't import lib/pm's `resolveTags` (that module is
  // "server-only"); the caller (ProjectWorkspaceView / dept board page)
  // already has each task's own project's registry in hand, so it resolves
  // once and hands the plain, serializable result down — same pattern as
  // `blockedIds` below.
  taskTags?: Record<string, Tag[]>;
  // P4-G5: each card's urgency TIER, precomputed by the SERVER caller —
  // `taskUrgency(task, today, { isDone: isDoneStatus(task.status, projectStatuses) })`
  // (lib/pm, re-exported from the client-safe lib/pmUrgency.ts). Board never resolves
  // `today` or an "is this done" flag itself; that is exactly the drift the ticket
  // exists to prevent (two boards disagreeing about whether a card is late). Same
  // precedent as `taskTags`/`blockedIds`: a plain serializable map keyed by task id.
  taskUrgency?: Record<string, UrgencyTier>;
}

interface PendingPick<K extends string> {
  taskId: string;
  columnKey: K;
  // "responsible" = division-axis ambiguity (commit(taskId, columnKey, choice));
  // "status" = union-by-label no-match (movePick(taskId, choice) — choice is a
  // status id in the card's OWN project).
  mode: "responsible" | "status";
  label: string;
  options: { id: string; name: string }[];
  anchor: { x: number; y: number };
  returnFocus: HTMLElement | null;
}

interface MoveMenu {
  taskId: string;
  anchor: { x: number; y: number };
}

// ---- drag auto-scroll (P5-B1) ----------------------------------------------
// The board scrolls sideways whenever the columns outrun the viewport, and on a five-column
// department board Done is routinely off-screen. During an HTML5 drag the browser will not scroll
// that container for you: the pointer is captured by the drag, wheel/trackpad events go nowhere,
// and there is no way to reach a column you cannot see — the card had to be dropped back where it
// came from and moved through the ⇅ Move menu instead. So the container scrolls itself while the
// pointer sits near an edge, the same affordance every board tool has.
//
// Driven by requestAnimationFrame rather than by the `dragover` event itself, deliberately:
// `dragover` fires on pointer MOVEMENT (and only lazily, ~every 350ms, when the pointer is
// stationary), so a user holding the card still at the edge — exactly what someone does when they
// are waiting for the board to come to them — would get a stutter instead of a scroll. dragover
// only updates the direction; the frame loop does the scrolling.
const EDGE_PX = 110;        // how close to an edge starts the scroll
const EDGE_MAX_PX = 24;     // top speed, per frame, at the very edge

interface AutoScrollState { raf: number | null; dx: number; dy: number }

// Distance-proportional speed: a nudge into the edge zone creeps, the last few pixels race. A flat
// speed is either too slow to cross a wide board or too fast to stop on the column you want.
function edgeVelocity(pos: number, min: number, max: number, enabled: boolean): number {
  if (!enabled) return 0;
  if (pos > max - EDGE_PX) return Math.ceil(((pos - (max - EDGE_PX)) / EDGE_PX) * EDGE_MAX_PX);
  if (pos < min + EDGE_PX) return -Math.ceil((((min + EDGE_PX) - pos) / EDGE_PX) * EDGE_MAX_PX);
  return 0;
}

// `onDragOver` is attached to the SCROLLER, and the columns' own dragover handlers deliberately
// don't stop propagation, so every move over any drop target reaches this. `stop` must be called
// on drop and on dragend — a loop left running would keep scrolling a board nobody is dragging on.
function useDragAutoScroll(
  ref: React.RefObject<HTMLDivElement | null>,
  onScrolled?: () => void,
  axis: "x" | "xy" = "x",
) {
  const state = useRef<AutoScrollState>({ raf: null, dx: 0, dy: 0 });

  const stop = useCallback(() => {
    const s = state.current;
    if (s.raf !== null) cancelAnimationFrame(s.raf);
    s.raf = null; s.dx = 0; s.dy = 0;
  }, []);

  const step = useCallback(() => {
    const el = ref.current;
    const s = state.current;
    if (!el || (s.dx === 0 && s.dy === 0)) { stop(); return; }
    if (s.dx !== 0) el.scrollLeft += s.dx;
    if (s.dy !== 0) el.scrollTop += s.dy;
    onScrolled?.();
    s.raf = requestAnimationFrame(step);
  }, [ref, stop, onScrolled]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const s = state.current;
    s.dx = edgeVelocity(e.clientX, r.left, r.right, true);
    s.dy = edgeVelocity(e.clientY, r.top, r.bottom, axis === "xy");
    if ((s.dx !== 0 || s.dy !== 0) && s.raf === null) s.raf = requestAnimationFrame(step);
    else if (s.dx === 0 && s.dy === 0) stop();
  }, [ref, axis, step, stop]);

  // A drag abandoned outside the window fires no drop, and an unmount mid-drag fires nothing at
  // all; both would leave the loop running against a detached node.
  useEffect(() => stop, [stop]);

  return { onDragOver, stop };
}

export function Board<K extends string>({ columns, move, movePick, colorColumns, blockedIds, taskHrefBase, taskTags, taskUrgency }: Props<K>) {
  const taskHref = (id: string) => (taskHrefBase ? `${taskHrefBase}/${id}` : `/tasks/${id}`);
  const showToast = (msg: string) => { setToast(msg); window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 4000); };
  const router = useRouter();
  const [dropCol, setDropCol] = useState<K | null>(null);
  const [, startTransition] = useTransition();
  const dragId = useRef<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [live, setLive] = useState("");
  const [moveMenu, setMoveMenu] = useState<MoveMenu | null>(null);
  const [pending, setPending] = useState<PendingPick<K> | null>(null);
  const moveBtnRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  // Does the board run past its right edge, and is there still something out there? A board of five
  // columns clipped the last one with no sign it existed. This cannot be done in CSS — nothing in a
  // stylesheet can compare scrollWidth to clientWidth — and this component is already client-side,
  // so it measures and lets CSS draw the edge.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const measureOverflow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 2px of slack: sub-pixel layout leaves a scrollWidth a hair over clientWidth on boards that
    // actually fit, and a permanent fade on a board with nothing hidden is a lie.
    setHasMore(el.scrollWidth - el.clientWidth - el.scrollLeft > 2);
  }, []);
  useEffect(() => {
    measureOverflow();
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measureOverflow);
    ro.observe(el);
    return () => ro.disconnect();
    // `columns` so adding/removing a column (a filter change, a drag) re-measures.
  }, [measureOverflow, columns]);

  // Carrying a card toward either edge scrolls the board — without it a column that starts
  // off-screen (Done, on most department boards) simply cannot be dropped into.
  const autoScroll = useDragAutoScroll(scrollRef, measureOverflow);

  function findTask(id: string): PmTask | undefined {
    for (const c of columns) {
      const t = c.tasks.find((x) => x.id === id);
      if (t) return t;
    }
    return undefined;
  }

  // A successful drop into an over-WIP-limit column shows a one-line toast but
  // NEVER blocks the move (design spec §2). Count reflects the incoming card.
  function wipNotice(col: AxisColumn<K> | undefined) {
    if (!col || col.wipLimit == null) return;
    const next = col.tasks.length + 1;
    if (next > col.wipLimit) showToast(`“${col.label}” is over its WIP limit (${next}/${col.wipLimit}).`);
  }

  function commit(taskId: string, columnKey: K, opts: { responsibleId?: string; anchor?: { x: number; y: number }; returnFocus?: HTMLElement | null } = {}) {
    startTransition(async () => {
      const r = await move(taskId, columnKey, opts.responsibleId);
      if (r.ok) {
        const col = columns.find((c) => c.key === columnKey);
        setLive(`Moved to ${col?.label ?? String(columnKey)}.`);
        wipNotice(col);
      } else if (r.pick && movePick) {
        // Union-by-label no-match (§7 D-4): open the pick popover with the card's
        // own project's statuses; the chosen id commits via movePick.
        setPending({ taskId, columnKey, mode: "status", label: "Pick a status", options: r.pick.options, anchor: opts.anchor ?? { x: 120, y: 120 }, returnFocus: opts.returnFocus ?? null });
        return; // no refresh — nothing committed yet
      } else {
        showToast(r.error ?? "Couldn't move this task.");
      }
      router.refresh();
    });
  }

  function commitPick(taskId: string, choiceId: string) {
    startTransition(async () => {
      const r = movePick ? await movePick(taskId, choiceId) : { ok: false, error: "Can't set status here." };
      if (!r.ok) showToast(r.error ?? "Couldn't move this task.");
      else setLive("Status updated.");
      router.refresh();
    });
  }

  // Shared by drag-drop and the keyboard "⇅ Move" menu: unambiguous columns
  // commit straight away; a division column whose people don't already
  // include the task's current responsible opens the pick popover instead
  // (and the union-by-label no-match popover is opened by `commit` on a `pick`).
  function attempt(taskId: string, columnKey: K, anchor: { x: number; y: number }, returnFocus: HTMLElement | null) {
    const col = columns.find((c) => c.key === columnKey);
    if (col?.people) {
      const current = findTask(taskId)?.assignee?.responsibleId;
      if (current && col.people.some((p) => p.id === current)) {
        commit(taskId, columnKey, { responsibleId: current });
      } else {
        setPending({ taskId, columnKey, mode: "responsible", label: "Pick who's responsible", options: col.people, anchor, returnFocus });
      }
    } else {
      commit(taskId, columnKey, { anchor, returnFocus });
    }
  }

  function openMoveMenu(taskId: string, btn: HTMLButtonElement) {
    const r = btn.getBoundingClientRect();
    setMoveMenu({ taskId, anchor: { x: r.left, y: r.bottom + 4 } });
  }
  function closeMoveMenu() {
    const id = moveMenu?.taskId;
    setMoveMenu(null);
    if (id) moveBtnRefs.current.get(id)?.focus();
  }
  function pickFromMoveMenu(taskId: string, columnKey: K, anchor: { x: number; y: number }) {
    const returnFocus = moveBtnRefs.current.get(taskId) ?? null;
    setMoveMenu(null);
    attempt(taskId, columnKey, anchor, returnFocus);
  }
  function closePending() {
    const el = pending?.returnFocus ?? null;
    setPending(null);
    el?.focus();
  }
  function pickOption(choiceId: string) {
    if (!pending) return;
    const { taskId, columnKey, mode, returnFocus } = pending;
    setPending(null);
    if (mode === "status") commitPick(taskId, choiceId);
    else commit(taskId, columnKey, { responsibleId: choiceId });
    returnFocus?.focus();
  }

  return (
    /* The fade lives on this NON-scrolling frame, not on the scroller itself: a pseudo-element inside
       an overflow container is positioned against the scrolled content, so it slides out of view the
       moment you scroll (tried it — the edge was invisible at every position but 0). */
    <div className={`pm-board-frame${hasMore ? " pm-board-frame--more" : ""}`}>
    <div
      ref={scrollRef}
      className="pm-board-scroll erp-scroll"
      onScroll={measureOverflow}
      onDragOver={autoScroll.onDragOver}
      onDrop={autoScroll.stop}
      onDragEnd={autoScroll.stop}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) autoScroll.stop(); }}
    >
      {toast && <p className="pm-board__toast" role="alert">{toast}</p>}
      <div aria-live="polite" className="pm-sr-only">{live}</div>
      {/* `--dragging` un-collapses the empty columns for the duration of a drag: a 34px strip is not
          a drop target anyone can hit, and "move this to Backlog" has to stay possible by drag, not
          only through the ⇅ Move menu. */}
      <div className={`pm-board${draggingId ? " pm-board--dragging" : ""}`}>
        {columns.map((col) => (
          <section
            key={col.key}
            /* An empty column collapses to a labelled strip. At full width it spends 280px — the
               same as a staffed one — to say "nothing here", and on the department board that put an
               empty Backlog first in reading order, so a phone user swiped past a blank column
               before reaching any work. */
            className={`pm-col${col.tasks.length === 0 ? " pm-col--empty" : ""}`}
            aria-label={col.label}
            onDragOver={(e) => { e.preventDefault(); setDropCol(col.key); }}
            onDragLeave={() => setDropCol((s) => (s === col.key ? null : s))}
            onDrop={(e) => {
              e.preventDefault();
              autoScroll.stop();
              const id = dragId.current;
              dragId.current = null;
              setDropCol(null);
              if (!id) return;
              attempt(id, col.key, { x: e.clientX, y: e.clientY }, null);
            }}
          >
            {(() => {
              const over = col.wipLimit != null && col.tasks.length > col.wipLimit;
              return (
                <div className={`pm-col__head${over ? " pm-col__head--over" : ""}`}>
                  <span className="pm-col__title">
                    {colorColumns && col.color && <span className="pm-col__dot" style={{ background: col.color }} aria-hidden />}
                    {col.label}
                  </span>
                  <span className="pm-col__count">
                    {col.tasks.length}{col.wipLimit != null ? `/${col.wipLimit}` : ""}
                  </span>
                </div>
              );
            })()}
            <div className={`pm-col__body${dropCol === col.key ? " pm-col__body--drop" : ""}`} role="list">
              {col.tasks.map((t) => (
                <Card
                  key={t.id}
                  task={t}
                  taskHref={taskHref}
                  blocked={blockedIds?.has(t.id) ?? false}
                  dragging={draggingId === t.id}
                  tags={taskTags?.[t.id] ?? []}
                  urgencyTier={taskUrgency?.[t.id]}
                  onDragStart={(id) => { dragId.current = id; setDraggingId(id); }}
                  onDragEnd={() => { autoScroll.stop(); setDraggingId(null); }}
                  moveBtnRef={(el) => { if (el) moveBtnRefs.current.set(t.id, el); else moveBtnRefs.current.delete(t.id); }}
                  onOpenMove={(btn) => openMoveMenu(t.id, btn)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>

      {moveMenu && (
        <Popover x={moveMenu.anchor.x} y={moveMenu.anchor.y} label="Move task to…" onClose={closeMoveMenu}>
          {columns.map((col) => (
            <button
              key={col.key}
              type="button"
              role="menuitem"
              className="pm-dropmenu__item"
              onClick={() => pickFromMoveMenu(moveMenu.taskId, col.key, moveMenu.anchor)}
            >
              {col.label}
            </button>
          ))}
        </Popover>
      )}

      {pending && (
        <Popover x={pending.anchor.x} y={pending.anchor.y} label={pending.label} onClose={closePending}>
          <label className="pm-dropmenu__select-label">
            <span>{pending.mode === "status" ? "Move to which status?" : "Who's responsible?"}</span>
            <select
              className="pm-dropmenu__select"
              defaultValue=""
              onChange={(e) => { if (e.target.value) pickOption(e.target.value); }}
            >
              <option value="" disabled>Choose…</option>
              {pending.options.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        </Popover>
      )}
    </div>
    </div>
  );
}

// A `move`-shaped commit fn, shared by `Board`'s single axis and `BoardGrid`'s two axes —
// every server action in lib/pmActions.ts (moveTask/moveTaskToStatusLabel/setTaskPriority/
// reassignResponsible/setDivisionAssignee) already conforms to this one signature.
type MoveFn = (taskId: string, columnKey: string, responsibleId?: string) => Promise<{ ok: boolean; error?: string; pick?: { options: { id: string; name: string }[] } }>;

interface GridPending {
  taskId: string;
  mode: "responsible" | "status";
  // "responsible": the TARGET row to commit against once a person is picked (rowMove(taskId,
  // rowKey, choice)). "status": within-row union-by-label no-match (columnMovePick(taskId, choice)).
  rowKey?: string;
  label: string;
  options: { id: string; name: string }[];
  anchor: { x: number; y: number };
  returnFocus: HTMLElement | null;
}

interface GridMoveMenu { taskId: string; rowKey: string; anchor: { x: number; y: number } }

interface GridProps {
  rows: GridRow[];
  // Within-row drag/keyboard: a plain status change (unambiguous — design spec §8). Reuses the
  // dept board's own union-by-label status axis (moveTaskToStatusLabel + movePick=moveTask).
  columnMove: MoveFn;
  columnMovePick?: (taskId: string, choiceId: string) => Promise<{ ok: boolean; error?: string }>;
  // Cross-row drag/keyboard: the division/assignee axis (setDivisionAssignee / reassignResponsible)
  // — reuses the SAME anchored responsible-person popover as Board's own division axis whenever
  // the target row carries `people`.
  rowMove: MoveFn;
  rowAxisLabel: string; // "Division" | "Assignee" — labels the row-axis section of the keyboard menu
  colorColumns?: boolean;
  blockedIds?: Set<string>;
  taskHrefBase?: string;
  taskTags?: Record<string, Tag[]>;
  // P4-G5 — same precomputed-tier map as `Board.Props.taskUrgency`; see that comment.
  taskUrgency?: Record<string, UrgencyTier>;
}

// True 2-axis swimlane grid (P2-09, design spec §8): ROWS = Division/Assignee, COLUMNS = Status,
// built by `divisionStatusGrid`/`assigneeStatusGrid` (lib/departments.ts). A CSS grid with a
// sticky left row-label column + the same fixed-width status columns from `Board`, repeated per
// row, scrolling BOTH axes inside its own container (never the page body). Dropping within a row
// (across status columns) is an unambiguous status change; dropping across a row boundary
// (different division/assignee) reuses Board's anchored responsible-person popover / straight
// reassignment. The keyboard "⇅ Move" menu offers BOTH axes, symmetric with the mouse.
export function BoardGrid({ rows, columnMove, columnMovePick, rowMove, rowAxisLabel, colorColumns, blockedIds, taskHrefBase, taskTags, taskUrgency }: GridProps) {
  const taskHref = (id: string) => (taskHrefBase ? `${taskHrefBase}/${id}` : `/tasks/${id}`);
  const showToast = (msg: string) => { setToast(msg); window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 4000); };
  const router = useRouter();
  const [, startTransition] = useTransition();
  const dragRef = useRef<{ taskId: string; rowKey: string } | null>(null);
  // The grid scrolls on BOTH axes (it is capped at 72vh), so a drag near any edge has to be able
  // to reach an off-screen column AND an off-screen row.
  const gridScrollRef = useRef<HTMLDivElement | null>(null);
  const autoScroll = useDragAutoScroll(gridScrollRef, undefined, "xy");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropCell, setDropCell] = useState<{ rowKey: string; colKey: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [live, setLive] = useState("");
  const [moveMenu, setMoveMenu] = useState<GridMoveMenu | null>(null);
  const [pending, setPending] = useState<GridPending | null>(null);
  const moveBtnRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  // Every row's `columns` shares the same key/label/color set by construction (see
  // divisionStatusGrid/assigneeStatusGrid) — the first row (or an empty fallback) is the
  // canonical header/menu list.
  const columns = rows[0]?.columns.map((c) => ({ key: c.key, label: c.label, color: c.color })) ?? [];

  function findTask(id: string): PmTask | undefined {
    for (const r of rows) for (const c of r.columns) { const t = c.tasks.find((x) => x.id === id); if (t) return t; }
    return undefined;
  }

  function commitStatus(taskId: string, columnKey: string, anchor?: { x: number; y: number }, returnFocus?: HTMLElement | null) {
    startTransition(async () => {
      const r = await columnMove(taskId, columnKey);
      if (r.ok) {
        setLive(`Moved to ${columns.find((c) => c.key === columnKey)?.label ?? columnKey}.`);
      } else if (r.pick && columnMovePick) {
        setPending({ taskId, mode: "status", label: "Pick a status", options: r.pick.options, anchor: anchor ?? { x: 120, y: 120 }, returnFocus: returnFocus ?? null });
        return;
      } else {
        showToast(r.error ?? "Couldn't move this task.");
      }
      router.refresh();
    });
  }

  function commitStatusPick(taskId: string, choiceId: string) {
    startTransition(async () => {
      const r = columnMovePick ? await columnMovePick(taskId, choiceId) : { ok: false, error: "Can't set status here." };
      if (!r.ok) showToast(r.error ?? "Couldn't move this task.");
      else setLive("Status updated.");
      router.refresh();
    });
  }

  function commitRow(taskId: string, rowKey: string, responsibleId?: string) {
    startTransition(async () => {
      const r = await rowMove(taskId, rowKey, responsibleId);
      if (r.ok) setLive(`Moved to ${rows.find((r2) => r2.key === rowKey)?.label ?? rowKey}.`);
      else showToast(r.error ?? "Couldn't move this task.");
      router.refresh();
    });
  }

  // Cross-row commit: mirrors Board's own `attempt` for the division axis — if the task's
  // current responsible already sits in the target row's division, commit outright; otherwise
  // open the same anchored popover. Assignee rows carry no `people`, so they always commit
  // straight away (same as Board's non-division axes).
  function attemptRow(taskId: string, rowKey: string, anchor: { x: number; y: number }, returnFocus: HTMLElement | null) {
    const row = rows.find((r) => r.key === rowKey);
    if (row?.people) {
      const current = findTask(taskId)?.assignee?.responsibleId;
      if (current && row.people.some((p) => p.id === current)) {
        commitRow(taskId, rowKey, current);
      } else {
        setPending({ taskId, mode: "responsible", rowKey, label: "Pick who's responsible", options: row.people, anchor, returnFocus });
      }
    } else {
      commitRow(taskId, rowKey);
    }
  }

  function openMoveMenu(taskId: string, rowKey: string, btn: HTMLButtonElement) {
    const r = btn.getBoundingClientRect();
    setMoveMenu({ taskId, rowKey, anchor: { x: r.left, y: r.bottom + 4 } });
  }
  function closeMoveMenu() {
    const id = moveMenu?.taskId;
    setMoveMenu(null);
    if (id) moveBtnRefs.current.get(id)?.focus();
  }
  function closePending() {
    const el = pending?.returnFocus ?? null;
    setPending(null);
    el?.focus();
  }
  function pickOption(choiceId: string) {
    if (!pending) return;
    const { taskId, mode, rowKey, returnFocus } = pending;
    setPending(null);
    if (mode === "status") commitStatusPick(taskId, choiceId);
    else commitRow(taskId, rowKey!, choiceId);
    returnFocus?.focus();
  }

  return (
    <div
      ref={gridScrollRef}
      className="pm-grid-scroll erp-scroll"
      onDragOver={autoScroll.onDragOver}
      onDrop={autoScroll.stop}
      onDragEnd={autoScroll.stop}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) autoScroll.stop(); }}
    >
      {toast && <p className="pm-board__toast" role="alert">{toast}</p>}
      <div aria-live="polite" className="pm-sr-only">{live}</div>
      <div className="pm-grid" style={{ gridTemplateColumns: `200px repeat(${columns.length}, 280px)` }}>
        <div className="pm-grid__corner" aria-hidden />
        {columns.map((col) => (
          <div key={col.key} className="pm-grid__colhead">
            {colorColumns && col.color && <span className="pm-col__dot" style={{ background: col.color }} aria-hidden />}
            {col.label}
          </div>
        ))}
        {rows.map((row) => (
          <FragmentRow key={row.key}>
            <div className="pm-grid__rowhead" aria-label={`${rowAxisLabel}: ${row.label}`}>{row.label}</div>
            {row.columns.map((col) => (
              <div
                key={col.key}
                className={`pm-grid__cell${col.tasks.length === 0 ? " pm-grid__cell--empty" : ""}${dropCell?.rowKey === row.key && dropCell?.colKey === col.key ? " pm-grid__cell--drop" : ""}`}
                role="list"
                aria-label={`${row.label} — ${col.label}`}
                onDragOver={(e) => { e.preventDefault(); setDropCell({ rowKey: row.key, colKey: col.key }); }}
                onDragLeave={() => setDropCell((s) => (s && s.rowKey === row.key && s.colKey === col.key ? null : s))}
                onDrop={(e) => {
                  e.preventDefault();
                  autoScroll.stop();
                  const drag = dragRef.current;
                  dragRef.current = null;
                  setDropCell(null);
                  if (!drag) return;
                  if (drag.rowKey === row.key) commitStatus(drag.taskId, col.key, { x: e.clientX, y: e.clientY }, null);
                  else attemptRow(drag.taskId, row.key, { x: e.clientX, y: e.clientY }, null);
                }}
              >
                {col.tasks.map((t) => (
                  <Card
                    key={t.id}
                    task={t}
                    taskHref={taskHref}
                    blocked={blockedIds?.has(t.id) ?? false}
                    dragging={draggingId === t.id}
                    tags={taskTags?.[t.id] ?? []}
                    urgencyTier={taskUrgency?.[t.id]}
                    onDragStart={(id) => { dragRef.current = { taskId: id, rowKey: row.key }; setDraggingId(id); }}
                    onDragEnd={() => { autoScroll.stop(); setDraggingId(null); }}
                    moveBtnRef={(el) => { if (el) moveBtnRefs.current.set(t.id, el); else moveBtnRefs.current.delete(t.id); }}
                    onOpenMove={(btn) => openMoveMenu(t.id, row.key, btn)}
                  />
                ))}
              </div>
            ))}
          </FragmentRow>
        ))}
      </div>

      {moveMenu && (
        <Popover x={moveMenu.anchor.x} y={moveMenu.anchor.y} label="Move task to…" onClose={closeMoveMenu}>
          <div className="pm-dropmenu__group-label">Status</div>
          {columns.map((col) => (
            <button
              key={`col-${col.key}`}
              type="button"
              role="menuitem"
              className="pm-dropmenu__item"
              onClick={() => { const rf = moveBtnRefs.current.get(moveMenu.taskId) ?? null; const a = moveMenu.anchor; setMoveMenu(null); commitStatus(moveMenu.taskId, col.key, a, rf); }}
            >
              {col.label}
            </button>
          ))}
          <div className="pm-dropmenu__group-label">{rowAxisLabel}</div>
          {rows.map((row) => (
            <button
              key={`row-${row.key}`}
              type="button"
              role="menuitem"
              className="pm-dropmenu__item"
              onClick={() => { const rf = moveBtnRefs.current.get(moveMenu.taskId) ?? null; const a = moveMenu.anchor; setMoveMenu(null); attemptRow(moveMenu.taskId, row.key, a, rf); }}
            >
              {row.label}
            </button>
          ))}
        </Popover>
      )}

      {pending && (
        <Popover x={pending.anchor.x} y={pending.anchor.y} label={pending.label} onClose={closePending}>
          <label className="pm-dropmenu__select-label">
            <span>{pending.mode === "status" ? "Move to which status?" : "Who's responsible?"}</span>
            <select
              className="pm-dropmenu__select"
              defaultValue=""
              onChange={(e) => { if (e.target.value) pickOption(e.target.value); }}
            >
              <option value="" disabled>Choose…</option>
              {pending.options.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        </Popover>
      )}
    </div>
  );
}

// A CSS Grid needs its cells emitted as direct children in row-major order (no wrapper element
// per row — a `<div>` per row would itself become a grid item and break the column count). This
// is a plain fragment alias so each row's JSX reads as one block above.
const FragmentRow = ({ children }: { children: ReactNode }) => <>{children}</>;

// Small anchored popover (`.erp-usermenu__pop` styling, see shell.css) that
// closes on outside-click or Escape and moves focus into itself on open /
// back to `onClose`'s caller on close (§9 a11y: focus moves in, returns out).
function Popover({ x, y, label, onClose, children }: { x: number; y: number; label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    const first = ref.current?.querySelector<HTMLElement>("button, select, [tabindex]");
    first?.focus();
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const left = typeof window !== "undefined" ? Math.max(8, Math.min(x, window.innerWidth - 228)) : x;
  const top = typeof window !== "undefined" ? Math.max(8, Math.min(y, window.innerHeight - 180)) : y;

  return (
    <div ref={ref} className="pm-dropmenu" role="menu" aria-label={label} style={{ left, top }}>
      {children}
    </div>
  );
}

// P4-G5: the ad hoc "days until due" tone this used to compute inline is exactly the drift the
// urgency ticket exists to prevent — a card comparing dates against its OWN clock, disagreeing with
// every other render site the instant they straddle midnight differently. Removed in favour of the
// server-precomputed `urgencyTier` prop (see `Props.taskUrgency`), rendered via the shared
// `UrgencyChip`. Only pure FORMATTING (no comparison) is left here, for the chip's tooltip detail —
// locale + timeZone pinned per the chartHover.ts precedent, since an unpinned `toLocaleDateString`
// is the other half of this codebase's documented hydration trap.
function fmtDueDetail(dueDate: string): string {
  return `due ${new Date(`${dueDate.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" })}`;
}

function Card({
  task, onDragStart, onDragEnd, blocked = false, dragging = false, taskHref, moveBtnRef, onOpenMove, tags = [], urgencyTier,
}: {
  task: PmTask;
  onDragStart: (id: string) => void;
  onDragEnd?: () => void;
  blocked?: boolean;
  dragging?: boolean;
  taskHref: (id: string) => string;
  moveBtnRef?: (el: HTMLButtonElement | null) => void;
  onOpenMove?: (btn: HTMLButtonElement) => void;
  tags?: Tag[];
  urgencyTier?: UrgencyTier;
}) {
  const who = task.assignee ? (task.assignee.responsibleName || task.assignee.refName) : "Unassigned";
  const unitTag = task.assignee && task.assignee.kind !== "person" ? task.assignee.refName : null;
  return (
    // A "⇅ Move" trigger button sits BESIDE the card link (not nested inside
    // it — a button inside an <a> is invalid/inaccessible) so a11y focus
    // (:focus-within) can reveal it without disturbing the whole-card link.
    <div className="pm-card-wrap" role="listitem">
      <Link
        href={taskHref(task.id)}
        className={`pm-card pm-card--p-${task.priority}${dragging ? " pm-card--dragging" : ""}`}
        draggable
        onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", task.id); onDragStart(task.id); }}
        onDragEnd={() => onDragEnd?.()}
      >
        <span className="pm-card__title">
          {task.recurrence ? "↻ " : ""}
          {task.displayCode && <span className="pm-card__code">{task.displayCode}</span>}
          {task.title}
        </span>
        {tags.length > 0 && (
          <div className="pm-card__tags">
            {tags.map((tg) => <TagChip key={tg.id} label={tg.label} color={tg.color} />)}
          </div>
        )}
        {/* A 0% bar on every untouched card is a row of identical empty rails that says nothing; the
            column the card sits in already communicates "not started". The bar appears once there is
            progress to show, and disappears again at 100% because the Done column says that. */}
        {task.progress > 0 && task.progress < 100 && <ProgressBar value={task.progress} />}
        <div className="pm-card__meta">
          <span className="pm-who">{who}</span>
          {/* A "NORMAL" chip on every ordinary card is a label with no reader: it takes the same
              weight as HIGH/URGENT and says only that nothing is unusual. Same rule the rail already
              follows (`MyWorkRail` prints a priority only at high/critical). The unit tag still wins
              when there is one — it names WHO holds the work, which no other line on the card says. */}
          {unitTag
            ? <span className="pm-chip">{unitTag}</span>
            : (task.priority === "high" || task.priority === "urgent") && <span className="pm-chip">{task.priority}</span>}
        </div>
        <div className="pm-card__meta">
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {/* `subtasks` is declared required on `PmTask` and normalized to `[]` at the lib/pm.ts
                reader boundary — but a single malformed row (a stale demo fixture, a future
                backend regression) must never blank the whole board again, so this card defends
                itself too rather than trusting the type alone. */}
            {(task.subtasks ?? []).length > 0 && (
              <span className="pm-card__subs">{task.subtasks.filter((s) => s.done).length}/{task.subtasks.length}</span>
            )}
            {blocked && <span className="pm-blocked-chip">Blocked</span>}
          </span>
          {/* Dense, high-count context (a column can hold many cards) — dot form, so a `done`/
              `undated` card (most tasks have no due date) shows nothing, matching the old
              behaviour of rendering no pill at all in those cases. */}
          {urgencyTier && (
            <UrgencyChip tier={urgencyTier} variant="dot" detail={task.dueDate ? fmtDueDetail(task.dueDate) : undefined} />
          )}
        </div>
      </Link>
      {onOpenMove && (
        <button
          type="button"
          ref={moveBtnRef}
          className="pm-card__move"
          aria-label={`Move "${task.title}" to a different column`}
          onClick={(e) => onOpenMove(e.currentTarget)}
        >
          ⇅ Move
        </button>
      )}
    </div>
  );
}
