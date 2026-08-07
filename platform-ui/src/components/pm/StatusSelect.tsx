"use client";
import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Toast } from "@/components/ui";
import "./pm.css";
import "./task-detail.css";

type Res = { ok: boolean; error?: string; spawned?: { id: string; dueDate: string } | null };
// P4-I4: `disabled` marks an option the chain-enforcement courtesy check considers unreachable
// right now (the task has open blockers and this status counts as "started work"). It is always
// paired with `disabledHint` below — a disabled option with no stated reason reads as a bug, not
// a rule, so the hint is rendered whenever any option carries this flag.
interface StatusOption { id: string; label: string; color: string; disabled?: boolean }

interface Props {
  current: string;
  statuses: StatusOption[];
  canEdit: boolean;
  save: (statusId: string) => Promise<Res>;
  // P2-06: present only on a recurring task's status control. Deletes the
  // spawned next occurrence (Undo on the "Next occurrence created…" toast).
  undoSpawn?: (spawnedTaskId: string) => Promise<{ ok: boolean }>;
  // P4-I4: why any `disabled` options above are disabled — e.g. "Blocked by 2 open
  // dependencies…". The caller (TaskDetailView) already names the specific blocking tasks in the
  // banner above this control, so this hint stays short; it exists so the disabled options
  // themselves are never unexplained. Only rendered when at least one option is disabled.
  disabledHint?: string;
}

// Task-detail status control (P2-05, design spec §7) — a select over the task's
// OWN project's statuses (custom-status registry), committing instantly. Read-only
// viewers get a plain coloured pill. The dot uses the status's colour.
export function StatusSelect({ current, statuses, canEdit, save, undoSpawn, disabledHint }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [spawnToast, setSpawnToast] = useState<{ id: string; dueDate: string } | null>(null);
  const active = statuses.find((s) => s.id === current);
  const color = active?.color ?? "var(--accent)";
  const hintId = useId();
  const hasDisabled = statuses.some((s) => s.disabled);

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
        aria-describedby={hasDisabled && disabledHint ? hintId : undefined}
        value={current}
        disabled={pending}
        onChange={(e) => onChange(e.target.value)}
      >
        {statuses.map((s) => (
          // A disabled option is never selectable via the native control, so `onChange` can't fire
          // for it — but it must still SAY why, both to a mouse user (title tooltip) and to anyone
          // who can't hover (the visible hint below, sharing this same reason text via aria-describedby).
          <option key={s.id} value={s.id} disabled={s.disabled} title={s.disabled ? disabledHint : undefined}>
            {s.label}{s.disabled ? " (blocked)" : ""}
          </option>
        ))}
        {!active && <option value={current}>{current}</option>}
      </select>
      {hasDisabled && disabledHint && (
        <span id={hintId} className="pm-statussel__hint" role="note">{disabledHint}</span>
      )}
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
