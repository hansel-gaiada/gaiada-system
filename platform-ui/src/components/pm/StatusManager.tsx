"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ProjectStatus } from "@/lib/pm";
import { TAG_COLORS, statusHexForColor, tagColorFromHex } from "@/lib/tagColors";
import { ColorSwatchPicker } from "./ColorSwatchPicker";
import "./pm.css";

type Res = { ok: boolean; error?: string };
export interface StatusPatch { label?: string; color?: string; isDone?: boolean; isBlocked?: boolean; wipLimit?: number | null; position?: number }

interface Props {
  statuses: ProjectStatus[];
  // status id -> number of tasks currently in it (for the guarded delete). The
  // parent already has the task list, so the count is computed server-side and
  // handed down — no extra round-trip and no reliance on the delete error body.
  usageCounts: Record<string, number>;
  create: (input: { label: string; color: string; isDone: boolean; isBlocked: boolean; wipLimit?: number }) => Promise<Res>;
  update: (statusId: string, patch: StatusPatch) => Promise<Res>;
  reorder: (orderedIds: string[]) => Promise<Res>;
  remove: (statusId: string, moveTo?: string) => Promise<Res>;
}

// "⚙ Edit statuses" inline editor (P2-05, design spec §7) — AssigneeEditor-style
// reveal, gated on `pm.manage` by the caller (which conditionally renders this).
// An ordered list of status rows: vertical native drag-reorder + keyboard
// reorder buttons (announced via aria-live, §9), label input, the shared
// ColorSwatchPicker, mutually-exclusive Done/Blocked chips, an optional WIP
// number, and a guarded delete (in-use → inline "move N tasks to …"). A default
// project seeds today's 4 statuses on its first write (backend/demo materialize).
export function StatusManager({ statuses, usageCounts, create, update, reorder, remove }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [live, setLive] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [moveTo, setMoveTo] = useState("");

  // Local order mirrors props (sorted) so drag/keyboard reorder feels instant;
  // re-synced whenever the server round-trips fresh statuses in.
  const sorted = [...statuses].sort((a, b) => a.position - b.position);
  const [rows, setRows] = useState<ProjectStatus[]>(sorted);
  useEffect(() => { setRows([...statuses].sort((a, b) => a.position - b.position)); }, [statuses]);

  const dragIndex = useRef<number | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [newColor, setNewColor] = useState(statusHexForColor(TAG_COLORS[0]));

  if (!open) {
    return <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setOpen(true)}>⚙ Edit statuses</button>;
  }

  function run(fn: () => Promise<Res>) {
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setMsg(r.error ?? "Couldn't save.");
      else { setMsg(null); router.refresh(); }
    });
  }

  function applyOrder(next: ProjectStatus[], announce: string) {
    setRows(next);
    setLive(announce);
    run(() => reorder(next.map((s) => s.id)));
  }

  function moveRow(from: number, to: number) {
    if (to < 0 || to >= rows.length || from === to) return;
    const next = [...rows];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    applyOrder(next, `${moved.label} moved to position ${to + 1} of ${next.length}.`);
  }

  function toggleFlag(s: ProjectStatus, flag: "isDone" | "isBlocked") {
    const turningOn = !s[flag];
    // Done/Blocked are mutually exclusive (both optional).
    const patch: StatusPatch = flag === "isDone"
      ? { isDone: turningOn, isBlocked: turningOn ? false : s.isBlocked }
      : { isBlocked: turningOn, isDone: turningOn ? false : s.isDone };
    run(() => update(s.id, patch));
  }

  function attemptRemove(s: ProjectStatus) {
    if (rows.length <= 1) { setMsg("A project needs at least one status."); return; }
    if ((usageCounts[s.id] ?? 0) > 0) { setConfirmDelete(s.id); setMoveTo(""); return; }
    run(() => remove(s.id));
  }

  return (
    <div className="pm-statusmgr">
      <div className="pm-sr-only" aria-live="polite">{live}</div>
      <ul className="pm-statusmgr__list" role="list">
        {rows.map((s, i) => (
          <li
            key={s.id}
            className="pm-statusmgr__row"
            role="listitem"
            draggable
            onDragStart={() => { dragIndex.current = i; }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const from = dragIndex.current;
              dragIndex.current = null;
              if (from != null && from !== i) moveRow(from, i);
            }}
          >
            <span className="pm-statusmgr__handle" aria-hidden title="Drag to reorder">⋮⋮</span>
            <span className="pm-statusmgr__reorder">
              <button type="button" className="pm-statusmgr__nudge" disabled={i === 0 || pending} aria-label={`Move ${s.label} up`} onClick={() => moveRow(i, i - 1)}>↑</button>
              <button type="button" className="pm-statusmgr__nudge" disabled={i === rows.length - 1 || pending} aria-label={`Move ${s.label} down`} onClick={() => moveRow(i, i + 1)}>↓</button>
            </span>
            <ColorSwatchPicker
              value={tagColorFromHex(s.color) ?? TAG_COLORS[0]}
              onChange={(c) => run(() => update(s.id, { color: statusHexForColor(c) }))}
              label={`${s.label} colour`}
            />
            <input
              className="lux-field__control pm-statusmgr__label"
              defaultValue={s.label}
              aria-label={`Rename status ${s.label}`}
              disabled={pending}
              onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== s.label) run(() => update(s.id, { label: v })); }}
            />
            <span className="pm-statusmgr__flags">
              <button type="button" className={`pm-statusmgr__flag${s.isDone ? " pm-statusmgr__flag--on" : ""}`} aria-pressed={s.isDone} disabled={pending} onClick={() => toggleFlag(s, "isDone")}>Done</button>
              <button type="button" className={`pm-statusmgr__flag${s.isBlocked ? " pm-statusmgr__flag--on" : ""}`} aria-pressed={s.isBlocked} disabled={pending} onClick={() => toggleFlag(s, "isBlocked")}>Blocked</button>
            </span>
            <input
              type="number"
              min={1}
              className="lux-field__control pm-statusmgr__wip"
              defaultValue={s.wipLimit ?? ""}
              placeholder="WIP"
              aria-label={`WIP limit for ${s.label}`}
              disabled={pending}
              onBlur={(e) => {
                const raw = e.target.value.trim();
                const next = raw === "" ? null : Math.max(1, Math.round(Number(raw)));
                if ((s.wipLimit ?? null) !== next) run(() => update(s.id, { wipLimit: next }));
              }}
            />
            {confirmDelete === s.id ? (
              <span className="pm-statusmgr__confirm">
                Move {usageCounts[s.id]} task{usageCounts[s.id] === 1 ? "" : "s"} to
                <select className="pm-dropmenu__select" value={moveTo} onChange={(e) => setMoveTo(e.target.value)} aria-label="Move tasks to status">
                  <option value="" disabled>status…</option>
                  {rows.filter((o) => o.id !== s.id).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
                <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={!moveTo || pending} onClick={() => { setConfirmDelete(null); run(() => remove(s.id, moveTo)); }}>Confirm</button>
                <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setConfirmDelete(null)}>Cancel</button>
              </span>
            ) : (
              <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm pm-statusmgr__del" disabled={pending} aria-label={`Delete status ${s.label}`} onClick={() => attemptRemove(s)}>Remove</button>
            )}
          </li>
        ))}
      </ul>

      <form
        className="pm-statusmgr__new"
        action={() => {
          const v = newLabel.trim();
          if (!v) return;
          setNewLabel("");
          run(() => create({ label: v, color: newColor, isDone: false, isBlocked: false }));
        }}
      >
        <ColorSwatchPicker value={tagColorFromHex(newColor) ?? TAG_COLORS[0]} onChange={(c) => setNewColor(statusHexForColor(c))} label="New status colour" />
        <input
          className="lux-field__control"
          placeholder="New status…"
          aria-label="New status name"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
        />
        <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={!newLabel.trim() || pending}>+ Add status</button>
      </form>

      {msg && <p className="pm-tagmgr__msg" role="alert">{msg}</p>}
      <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setOpen(false)}>Done</button>
    </div>
  );
}
