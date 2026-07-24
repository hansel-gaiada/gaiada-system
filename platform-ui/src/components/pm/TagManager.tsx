"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Tag } from "@/lib/pm";
import { TAG_COLORS, type TagColor } from "@/lib/tagColors";
import { ColorSwatchPicker } from "./ColorSwatchPicker";
import "./pm.css";

interface Props {
  tags: Tag[];
  create: (label: string, color: TagColor) => Promise<{ ok: boolean; error?: string }>;
  update: (tagId: string, patch: { label?: string; color?: TagColor }) => Promise<{ ok: boolean; error?: string }>;
  remove: (tagId: string, force?: boolean) => Promise<{ ok: boolean; error?: string; inUse?: boolean }>;
}

// AssigneeEditor-style inline reveal: "Manage tags" ghost button → an inline
// panel listing every project tag (swatch + rename + guarded remove) plus a
// trailing "+ New tag" row (P2-02, design spec §6). Guarded delete: a first
// click that comes back 409/inUse shows an inline confirm; clicking again
// re-calls `remove` with `force: true` (matches deleteTag's contract in
// lib/pmActions.ts).
export function TagManager({ tags, create, update, remove }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [newLabel, setNewLabel] = useState("");
  const [newColor, setNewColor] = useState<TagColor>(TAG_COLORS[0]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  if (!open) {
    return <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setOpen(true)}>Manage tags</button>;
  }

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setMsg(r.error ?? "Couldn't save.");
      else { setMsg(null); router.refresh(); }
    });
  }

  function attemptRemove(tagId: string) {
    startTransition(async () => {
      const r = await remove(tagId, false);
      if (r.inUse) { setConfirmDelete(tagId); return; }
      if (!r.ok) setMsg(r.error ?? "Couldn't remove this tag.");
      else { setMsg(null); setConfirmDelete(null); router.refresh(); }
    });
  }

  function forceRemove(tagId: string) {
    setConfirmDelete(null);
    run(() => remove(tagId, true));
  }

  return (
    <div className="pm-tagmgr">
      <div className="pm-tagmgr__list">
        {tags.length === 0 && <p className="pm-tagmgr__empty">No tags yet — create the first one below.</p>}
        {tags.map((tg) => (
          <div key={tg.id} className="pm-tagmgr__row">
            <ColorSwatchPicker value={tg.color} onChange={(c) => run(() => update(tg.id, { color: c }))} label={`${tg.label} color`} />
            <input
              className="lux-field__control"
              defaultValue={tg.label}
              aria-label={`Rename tag ${tg.label}`}
              disabled={pending}
              onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== tg.label) run(() => update(tg.id, { label: v })); }}
            />
            {confirmDelete === tg.id ? (
              <span className="pm-tagmgr__confirm">
                In use — remove anyway?
                <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending} onClick={() => forceRemove(tg.id)}>Remove</button>
                <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setConfirmDelete(null)}>Cancel</button>
              </span>
            ) : (
              <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending} onClick={() => attemptRemove(tg.id)}>Remove</button>
            )}
          </div>
        ))}
      </div>
      <form
        className="pm-tagmgr__new"
        action={() => {
          const v = newLabel.trim();
          if (!v) return;
          setNewLabel("");
          run(() => create(v, newColor));
        }}
      >
        <ColorSwatchPicker value={newColor} onChange={setNewColor} label="New tag color" />
        <input
          className="lux-field__control"
          placeholder="New tag…"
          aria-label="New tag name"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
        />
        <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={!newLabel.trim() || pending}>+ New tag</button>
      </form>
      {msg && <p className="pm-tagmgr__msg" role="alert">{msg}</p>}
      <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setOpen(false)}>Done</button>
    </div>
  );
}
