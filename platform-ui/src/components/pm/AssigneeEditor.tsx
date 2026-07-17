"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Assignable, Assignee } from "@/lib/pm";
import { AssigneePicker } from "./AssigneePicker";

interface Props {
  label: string; // e.g. "Assign owner" / "Reassign"
  assignable: Assignable;
  current?: Assignee | null;
  save: (formData: FormData) => Promise<{ ok: boolean; error?: string }>;
}

// Toggle → AssigneePicker (person/department/division + responsible) → save.
// Used for both project owner and task assignee.
export function AssigneeEditor({ label, assignable, current, save }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!open) {
    return <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setOpen(true)}>{label}</button>;
  }

  return (
    <form
      action={(fd) => startTransition(async () => {
        const r = await save(fd);
        if (r.ok) { setMsg(null); setOpen(false); router.refresh(); } else setMsg(r.error ?? "Couldn't save.");
      })}
      style={{ display: "flex", flexDirection: "column", gap: 12, border: "0.5px solid var(--erp-hairline)", padding: 14 }}
    >
      <AssigneePicker assignable={assignable} current={current} />
      {msg && <p style={{ margin: 0, font: "400 12px var(--font-body)", color: "var(--erp-accent)" }}>{msg}</p>}
      <div style={{ display: "flex", gap: 10 }}>
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
      </div>
    </form>
  );
}
