"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Subtask } from "@/lib/pm";
import "./pm.css";

interface Props {
  subtasks: Subtask[];
  canEdit: boolean;
  toggle: (subtaskId: string) => Promise<{ ok: boolean }>;
  add: (title: string) => Promise<{ ok: boolean }>;
}

export function Subtasks({ subtasks, canEdit, toggle, add }: Props) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [, startTransition] = useTransition();

  const run = (fn: () => Promise<unknown>) => startTransition(async () => { await fn(); router.refresh(); });

  return (
    <div>
      <div className="pm-subs">
        {subtasks.length === 0 && <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--erp-ink-50)" }}>No subtasks yet.</p>}
        {subtasks.map((s) => (
          <label key={s.id} className="pm-sub">
            <input type="checkbox" checked={s.done} disabled={!canEdit} onChange={() => run(() => toggle(s.id))} />
            <span className={`pm-sub__title${s.done ? " pm-sub__title--done" : ""}`}>{s.title}</span>
          </label>
        ))}
      </div>
      {canEdit && (
        <form
          className="pm-sub"
          style={{ marginTop: 8 }}
          action={() => { const v = title.trim(); if (!v) return; setTitle(""); run(() => add(v)); }}
        >
          <input
            className="lux-field__control"
            placeholder="Add a subtask…"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            style={{ flex: 1 }}
          />
          <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={!title.trim()}>Add</button>
        </form>
      )}
    </div>
  );
}
