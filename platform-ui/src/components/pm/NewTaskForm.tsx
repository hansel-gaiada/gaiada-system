"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Assignable, Milestone, Priority } from "@/lib/pm";
import { Field } from "@/components/forms/Field";
import { Card } from "@/components/ui";
import { AssigneePicker } from "./AssigneePicker";
import "@/components/forms/forms.css";

const PRIORITIES: Priority[] = ["low", "normal", "high", "urgent"];

interface Props {
  assignable: Assignable;
  milestones: Milestone[];
  create: (formData: FormData) => Promise<{ ok: boolean; error?: string }>;
}

export function NewTaskForm({ assignable, milestones, create }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!open) {
    return <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => setOpen(true)}>New task</button>;
  }

  return (
    <Card title="New task" style={{ marginBottom: 16 }}>
      <form
        action={(fd) => startTransition(async () => {
          const r = await create(fd);
          if (r.ok) { setMsg(null); setOpen(false); router.refresh(); } else setMsg(r.error ?? "Couldn't create task.");
        })}
        className="lux-form-grid"
      >
        <Field name="title" label="Title" required />
        <Field name="priority" label="Priority" type="select" options={PRIORITIES} />
        <Field name="dueDate" label="Due date" type="date" />
        <label className="lux-field">
          <span className="type-eyebrow" style={{ fontSize: 10, opacity: 0.6 }}>Milestone</span>
          <select name="milestoneId" className="lux-field__control" defaultValue="">
            <option value="">None</option>
            {milestones.map((mst) => <option key={mst.id} value={mst.id}>{mst.name}</option>)}
          </select>
        </label>
        <div style={{ gridColumn: "1 / -1" }}>
          <AssigneePicker assignable={assignable} />
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <Field name="description" label="Description" type="textarea" />
        </div>
        {msg && <p style={{ margin: 0, gridColumn: "1 / -1", font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>{msg}</p>}
        <div style={{ gridColumn: "1 / -1", display: "flex", gap: 10 }}>
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>{pending ? "Creating…" : "Create task"}</button>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
        </div>
      </form>
    </Card>
  );
}
