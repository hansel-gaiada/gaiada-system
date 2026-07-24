"use client";
import { useState, useTransition } from "react";
import type { Template } from "@/lib/pm";
import "./pm.css";

interface Props {
  templates: Template[];
  update: (templateId: string, patch: { title?: string }) => Promise<{ ok: boolean; error?: string }>;
  remove: (templateId: string) => Promise<{ ok: boolean; error?: string }>;
  // Lets the caller (NewTaskForm) refetch its own template list after a
  // rename/delete so the picker stays in sync without a page reload.
  onChange?: () => void;
}

// TagManager-style inline reveal (design spec §6's grammar, reused here):
// hairline list rows, rename-on-blur, guarded remove, no modal. Task
// templates are created ONLY via TaskDetailView's "Save as template" (they
// need a whole task's worth of fields) — this panel is management-only
// (rename/delete), fully keyboard-operable (native inputs + buttons).
export function TemplateManager({ templates, update, remove, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  if (!open) {
    return <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setOpen(true)}>Manage templates…</button>;
  }

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setMsg(r.error ?? "Couldn't save.");
      else { setMsg(null); onChange?.(); }
    });
  }

  return (
    <div className="pm-tagmgr">
      <div className="pm-tagmgr__list">
        {templates.length === 0 && (
          <p className="pm-tagmgr__empty">No task templates yet — open a task and “Save as template” to create one.</p>
        )}
        {templates.map((tpl) => (
          <div key={tpl.id} className="pm-tagmgr__row">
            <input
              className="lux-field__control"
              defaultValue={tpl.title}
              aria-label={`Rename template ${tpl.title}`}
              disabled={pending}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== tpl.title) run(() => update(tpl.id, { title: v }));
              }}
            />
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending} onClick={() => run(() => remove(tpl.id))}>
              Remove
            </button>
          </div>
        ))}
      </div>
      {msg && <p className="pm-tagmgr__msg" role="alert">{msg}</p>}
      <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setOpen(false)}>Done</button>
    </div>
  );
}
