"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ProgressBar } from "./ProgressBar";

interface Props {
  taskId: string;
  value: number;
  canEdit: boolean;
  save: (taskId: string, progress: number) => Promise<{ ok: boolean }>;
}

// Read-only bar for viewers; bar + slider + Save for managers. (Toggling
// subtasks also recomputes progress server-side.)
export function ProgressControl({ taskId, value, canEdit, save }: Props) {
  const router = useRouter();
  const [v, setV] = useState(value);
  const [pending, startTransition] = useTransition();

  if (!canEdit) return <ProgressBar value={value} />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <ProgressBar value={v} />
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <input type="range" min={0} max={100} step={5} value={v} onChange={(e) => setV(Number(e.target.value))} style={{ flex: 1 }} aria-label="Set progress" />
        <button
          type="button"
          className="lux-btn lux-btn--ghost lux-btn--sm"
          disabled={pending || v === value}
          onClick={() => startTransition(async () => { await save(taskId, v); router.refresh(); })}
        >
          {pending ? "Saving…" : "Set"}
        </button>
      </div>
    </div>
  );
}
