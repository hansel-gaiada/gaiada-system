"use client";
import { useActionState } from "react";
import { Field } from "./Field";
import { Eyebrow, Button } from "@/components/ui";
import type { CWState } from "@/lib/clientWorkActions";
import "./forms.css";

type Action = (prev: CWState | null, fd: FormData) => Promise<CWState>;
type Opt = { id: string; name: string };

function Err({ state }: { state: CWState | null }) {
  return state?.error ? <p style={{ margin: 0, gridColumn: "1 / -1", font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>{state.error}</p> : null;
}
function Select({ name, label, options, placeholder, required }: { name: string; label: string; options: Opt[]; placeholder: string; required?: boolean }) {
  return (
    <label className="lux-field">
      <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>{label}</Eyebrow>
      <select name={name} className="lux-field__control" defaultValue="" required={required}>
        <option value="" disabled={required} hidden={required}>{placeholder}</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </label>
  );
}

export function ClientForm({ action }: { action: Action }) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className="lux-form-grid" style={{ maxWidth: 560 }}>
      <Field name="name" label="Client name" required />
      <Field name="status" label="Status" type="select" options={["active", "prospect", "archived"]} defaultValue="active" />
      <Err state={state} />
      <div style={{ gridColumn: "1 / -1" }}><Button type="submit" size="md" disabled={pending}>{pending ? "Saving…" : "Add client"}</Button></div>
    </form>
  );
}

export function DeliverableForm({ action, projects, clients }: { action: Action; projects: Opt[]; clients: Opt[] }) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className="lux-form-grid" style={{ maxWidth: 640 }}>
      <Field name="name" label="Deliverable" required />
      <Select name="projectId" label="Project" options={projects} placeholder="— none —" />
      <Select name="clientId" label="Client" options={clients} placeholder="— none —" />
      <Field name="dueDate" label="Due date" type="date" />
      <Err state={state} />
      <div style={{ gridColumn: "1 / -1" }}><Button type="submit" size="md" disabled={pending}>{pending ? "Saving…" : "Add deliverable"}</Button></div>
    </form>
  );
}

export function TimeEntryForm({ action, projects }: { action: Action; projects: Opt[] }) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className="lux-form-grid" style={{ maxWidth: 640 }}>
      <Field name="hours" label="Hours (e.g. 1.5)" type="number" required />
      <Field name="entryDate" label="Date" type="date" />
      <Select name="projectId" label="Project" options={projects} placeholder="Select a project…" required />
      <Field name="billable" label="Billable" type="boolean" />
      <div style={{ gridColumn: "1 / -1" }}><Field name="notes" label="Notes" /></div>
      <Err state={state} />
      <div style={{ gridColumn: "1 / -1" }}><Button type="submit" size="md" disabled={pending}>{pending ? "Saving…" : "Log time"}</Button></div>
    </form>
  );
}
