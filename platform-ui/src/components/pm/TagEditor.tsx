"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Tag } from "@/lib/pm";
import { TAG_COLORS, type TagColor } from "@/lib/tagColors";
import { TagChip } from "./TagChip";
import { ColorSwatchPicker } from "./ColorSwatchPicker";
import "./pm.css";

interface Props {
  registry: Tag[]; // this task's own project's tag registry
  selected: string[]; // task.tags
  canEdit: boolean;
  setTags: (tags: string[]) => Promise<{ ok: boolean; error?: string }>;
  createTag: (label: string, color: TagColor) => Promise<{ ok: boolean; error?: string; id?: string }>;
}

// Editable tag row for the task detail view (P2-02, design spec §6): every
// registry tag renders as a toggleable chip that commits INSTANTLY on click
// (no separate Save step — same pattern as Subtasks' checkboxes), plus an
// inline "+ New tag" create that both adds the tag to the project's registry
// AND turns it on for this task in one action.
export function TagEditor({ registry, selected, canEdit, setTags, createTag }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("");
  const [color, setColor] = useState<TagColor>(TAG_COLORS[0]);
  const [msg, setMsg] = useState<string | null>(null);

  function toggle(tagId: string) {
    const next = selected.includes(tagId) ? selected.filter((id) => id !== tagId) : [...selected, tagId];
    startTransition(async () => {
      const r = await setTags(next);
      if (!r.ok) setMsg(r.error ?? "Couldn't update tags.");
      else { setMsg(null); router.refresh(); }
    });
  }

  function submitNew() {
    const v = label.trim();
    if (!v) return;
    startTransition(async () => {
      const r = await createTag(v, color);
      if (!r.ok) { setMsg(r.error ?? "Couldn't create tag."); return; }
      if (r.id) {
        const applied = await setTags([...selected, r.id]);
        if (!applied.ok) setMsg(applied.error ?? "Tag created but couldn't be applied.");
        else setMsg(null);
      }
      setLabel("");
      setCreating(false);
      router.refresh();
    });
  }

  return (
    <div>
      <div className="pm-tags-row">
        {registry.map((tg) => (
          <button
            key={tg.id}
            type="button"
            className="pm-tag--btn"
            disabled={!canEdit}
            aria-pressed={selected.includes(tg.id)}
            aria-label={`${selected.includes(tg.id) ? "Remove" : "Add"} tag ${tg.label}`}
            onClick={() => toggle(tg.id)}
          >
            <TagChip label={tg.label} color={tg.color} selected={selected.includes(tg.id)} />
          </button>
        ))}
        {registry.length === 0 && <span className="pm-tagmgr__empty">No tags on this project yet.</span>}
        {canEdit && (
          creating ? (
            <span className="pm-tags-new">
              <ColorSwatchPicker value={color} onChange={setColor} label="New tag color" />
              <input
                className="lux-field__control"
                autoFocus
                placeholder="Tag name…"
                aria-label="New tag name"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); submitNew(); }
                  if (e.key === "Escape") setCreating(false);
                }}
              />
              <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={submitNew} disabled={!label.trim()}>Add</button>
              <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setCreating(false)}>Cancel</button>
            </span>
          ) : (
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setCreating(true)}>+ New tag</button>
          )
        )}
      </div>
      {msg && <p className="pm-tagmgr__msg" role="alert">{msg}</p>}
    </div>
  );
}
