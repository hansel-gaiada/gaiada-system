"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Toast } from "@/components/ui";
import "./pm.css";

type Res = { ok: boolean; error?: string; spawned?: { id: string; dueDate: string } | null };
interface StatusOption { id: string; label: string; color: string }

interface Props {
  current: string;
  statuses: StatusOption[];
  canEdit: boolean;
  save: (statusId: string) => Promise<Res>;
  // P2-06: present only on a recurring task's status control. Deletes the
  // spawned next occurrence (Undo on the "Next occurrence created…" toast).
  undoSpawn?: (spawnedTaskId: string) => Promise<{ ok: boolean }>;
}

// Task-detail status control (P2-05, design spec §7) — a select over the task's
// OWN project's statuses (custom-status registry), committing instantly. Read-only
// viewers get a plain coloured pill. The dot uses the status's colour.
export function StatusSelect({ current, statuses, canEdit, save, undoSpawn }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [spawnToast, setSpawnToast] = useState<{ id: string; dueDate: string } | null>(null);
  const active = statuses.find((s) => s.id === current);
  const color = active?.color ?? "#6E5A43";

  function onChange(id: string) {
    if (id === current) return;
    startTransition(async () => {
      const r = await save(id);
      if (!r.ok) setMsg(r.error ?? "Couldn't change status.");
      else {
        setMsg(null);
        if (r.spawned) setSpawnToast(r.spawned);
        router.refresh();
      }
    });
  }

  function undo() {
    if (!spawnToast || !undoSpawn) return;
    const { id } = spawnToast;
    setSpawnToast(null);
    startTransition(async () => { await undoSpawn(id); router.refresh(); });
  }

  if (!canEdit) {
    return (
      <span className="lux-badge" style={{ color }}>
        <span className="lux-badge__dot" style={{ background: color }} />
        {active?.label ?? current}
      </span>
    );
  }

  return (
    <span className="pm-statussel">
      <span className="lux-badge__dot" style={{ background: color }} aria-hidden />
      <select
        className="pm-statussel__select"
        aria-label="Task status"
        value={current}
        disabled={pending}
        onChange={(e) => onChange(e.target.value)}
      >
        {statuses.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        {!active && <option value={current}>{current}</option>}
      </select>
      {msg && <span className="pm-tagmgr__msg" role="alert">{msg}</span>}
      {spawnToast && (
        <Toast
          message={`Next occurrence created for ${spawnToast.dueDate}`}
          onUndo={undoSpawn ? undo : undefined}
        />
      )}
    </span>
  );
}
