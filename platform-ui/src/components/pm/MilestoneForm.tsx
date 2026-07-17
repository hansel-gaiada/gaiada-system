"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eyebrow } from "@/components/ui";
import "@/components/forms/forms.css";

interface Props {
  add: (name: string, dueDate: string) => Promise<{ ok: boolean; error?: string }>;
}

export function MilestoneForm({ add }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [due, setDue] = useState("");
  const [pending, startTransition] = useTransition();

  if (!open) {
    return <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setOpen(true)}>Add milestone</button>;
  }

  return (
    <form
      action={() => {
        const n = name.trim();
        if (!n) return;
        startTransition(async () => { await add(n, due); setName(""); setDue(""); setOpen(false); router.refresh(); });
      }}
      style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}
    >
      <label className="lux-field" style={{ flex: "1 1 200px" }}>
        <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Milestone</Eyebrow>
        <input className="lux-field__control" value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label className="lux-field">
        <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Due date</Eyebrow>
        <input type="date" className="lux-field__control" value={due} onChange={(e) => setDue(e.target.value)} />
      </label>
      <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending || !name.trim()}>{pending ? "Adding…" : "Add"}</button>
      <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
    </form>
  );
}
