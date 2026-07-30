"use client";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { AxisColumn, PmTask, Tag } from "@/lib/pm";
import type { GridRow } from "@/lib/departments";
import { ProgressBar } from "./ProgressBar";
import { TagChip } from "./TagChip";
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

export function Board<K extends string>({ columns, move, movePick, colorColumns, blockedIds, taskHrefBase, taskTags }: Props<K>) {
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
    <div className="pm-board-scroll erp-scroll">
      {toast && <p className="pm-board__toast" role="alert">{toast}</p>}
      <div aria-live="polite" className="pm-sr-only">{live}</div>
      <div className="pm-board">
        {columns.map((col) => (
          <section
            key={col.key}
            className="pm-col"
            aria-label={col.label}
            onDragOver={(e) => { e.preventDefault(); setDropCol(col.key); }}
            onDragLeave={() => setDropCol((s) => (s === col.key ? null : s))}
            onDrop={(e) => {
              e.preventDefault();
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
                  onDragStart={(id) => { dragId.current = id; setDraggingId(id); }}
                  onDragEnd={() => setDraggingId(null)}
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
}

// True 2-axis swimlane grid (P2-09, design spec §8): ROWS = Division/Assignee, COLUMNS = Status,
// built by `divisionStatusGrid`/`assigneeStatusGrid` (lib/departments.ts). A CSS grid with a
// sticky left row-label column + the same fixed-width status columns from `Board`, repeated per
// row, scrolling BOTH axes inside its own container (never the page body). Dropping within a row
// (across status columns) is an unambiguous status change; dropping across a row boundary
// (different division/assignee) reuses Board's anchored responsible-person popover / straight
// reassignment. The keyboard "⇅ Move" menu offers BOTH axes, symmetric with the mouse.
export function BoardGrid({ rows, columnMove, columnMovePick, rowMove, rowAxisLabel, colorColumns, blockedIds, taskHrefBase, taskTags }: GridProps) {
  const taskHref = (id: string) => (taskHrefBase ? `${taskHrefBase}/${id}` : `/tasks/${id}`);
  const showToast = (msg: string) => { setToast(msg); window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 4000); };
  const router = useRouter();
  const [, startTransition] = useTransition();
  const dragRef = useRef<{ taskId: string; rowKey: string } | null>(null);
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
    <div className="pm-grid-scroll erp-scroll">
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
                    onDragStart={(id) => { dragRef.current = { taskId: id, rowKey: row.key }; setDraggingId(id); }}
                    onDragEnd={() => setDraggingId(null)}
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

// Due-date pill tone — same overdue/today/normal thresholds as the dept
// rail's MyWorkRail.dueBadge (components/departments/MyWorkRail.tsx), kept
// as a local pure fn so Board doesn't reach across into departments/.
function dueTone(dueDate: string | null): { label: string; tone: "risk" | "soon" | "quiet" } | null {
  if (!dueDate) return null;
  const due = new Date(dueDate);
  if (Number.isNaN(due.getTime())) return null;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.floor((due.getTime() - startOfToday.getTime()) / 86_400_000);
  if (days < 0) return { label: "Overdue", tone: "risk" };
  if (days === 0) return { label: "Due today", tone: "soon" };
  return { label: `Due ${due.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`, tone: "quiet" };
}

function Card({
  task, onDragStart, onDragEnd, blocked = false, dragging = false, taskHref, moveBtnRef, onOpenMove, tags = [],
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
}) {
  const who = task.assignee ? (task.assignee.responsibleName || task.assignee.refName) : "Unassigned";
  const unitTag = task.assignee && task.assignee.kind !== "person" ? task.assignee.refName : null;
  const due = dueTone(task.dueDate);
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
        <ProgressBar value={task.progress} />
        <div className="pm-card__meta">
          <span className="pm-who">{who}</span>
          {unitTag ? <span className="pm-chip">{unitTag}</span> : <span className="pm-chip">{task.priority}</span>}
        </div>
        <div className="pm-card__meta">
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {task.subtasks.length > 0 && (
              <span className="pm-card__subs">{task.subtasks.filter((s) => s.done).length}/{task.subtasks.length}</span>
            )}
            {blocked && <span className="pm-blocked-chip">Blocked</span>}
          </span>
          {due && <span className={`pm-due pm-due--${due.tone}`}>{due.label}</span>}
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
