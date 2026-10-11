"use client";
import { useActionState, useEffect, useRef } from "react";
import { Field } from "./Field";
import { Eyebrow, Button } from "@/components/ui";
import type { CWState } from "@/lib/clientWorkActions";
import { registry } from "@/lib/clientCentre";
import type { GroupCompanyOption } from "@/lib/clientGroupCompany";
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

type OwnerOpt = { id: string; name: string };

/** CC-D10 — the owner picker: "No owner" is a real, selectable state, never a silent default. */
function OwnerSelect({ owners, defaultValue }: { owners: OwnerOpt[]; defaultValue?: string | null }) {
  return (
    <label className="lux-field">
      <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Owner (account manager)</Eyebrow>
      <select name="ownerUserId" className="lux-field__control" defaultValue={defaultValue ?? ""}>
        <option value="">No owner</option>
        {owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </label>
  );
}

/** PV3-04 (PV-D1): the business-type picker. REQUIRED, with no default: the placeholder is not a
 *  choice, so the browser refuses to submit until one is picked (and the action refuses it too). "Other"
 *  is a real, explicit option. `defaultValue` is `null` for a client with no profile row yet: nothing is
 *  preselected, because a synthesised "other" is not a choice anybody made. */
function BusinessTypeSelect({ defaultValue }: { defaultValue?: string | null }) {
  return (
    <label className="lux-field">
      <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Business type</Eyebrow>
      <select name="businessType" className="lux-field__control" required defaultValue={defaultValue ?? ""}>
        <option value="" disabled hidden>Choose a business type…</option>
        {registry.businessTypes.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
      </select>
    </label>
  );
}

/** PV3-04 (PV-D2): "the group company this client IS". Rendered only when the server-side page decided
 *  the person is a platform operator (`groupCompanyOptions` returned a list); the backend re-checks. */
function GroupCompanySelect({ options, defaultValue }: { options: GroupCompanyOption[]; defaultValue?: string | null }) {
  return (
    <label className="lux-field">
      <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Group company</Eyebrow>
      <select name="groupCompanyId" className="lux-field__control" defaultValue={defaultValue ?? ""}>
        <option value="">Not a group company</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </label>
  );
}

/** The contact inputs, named exactly as `CLIENT_CONTACT_KEYS` so `readContact()` in
 *  clientWorkActions.ts picks every one of them up. */
function ContactFields({ contact }: { contact?: Record<string, unknown> }) {
  const v = (k: string) => (typeof contact?.[k] === "string" ? (contact[k] as string) : "");
  return (
    <>
      <Field name="email" label="Primary email" defaultValue={v("email")} />
      <Field name="phone" label="Phone" defaultValue={v("phone")} />
      <div style={{ gridColumn: "1 / -1" }}><Field name="address" label="Address" type="textarea" defaultValue={v("address")} /></div>
      <Field name="billingName" label="Billing contact" defaultValue={v("billingName")} />
      <Field name="billingEmail" label="Billing email" defaultValue={v("billingEmail")} hint="Where invoices go, if not the primary email." />
    </>
  );
}

export function ClientForm({ action, owners = [], groupCompanies = null }: { action: Action; owners?: OwnerOpt[]; groupCompanies?: GroupCompanyOption[] | null }) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className="lux-form-grid" style={{ maxWidth: 640 }}>
      <Field name="name" label="Client name" required />
      <BusinessTypeSelect />
      <Field name="status" label="Status" type="select" options={["active", "prospect", "archived"]} defaultValue="active" />
      <OwnerSelect owners={owners} />
      {groupCompanies && <GroupCompanySelect options={groupCompanies} />}
      <ContactFields />
      <Err state={state} />
      <div style={{ gridColumn: "1 / -1" }}><Button type="submit" size="md" disabled={pending}>{pending ? "Saving…" : "Add client"}</Button></div>
    </form>
  );
}

/** Edit an existing client. `statusOptions` always includes the client's CURRENT status, so a value
 *  outside the usual three (written by the API or an import) is shown as-is rather than silently
 *  replaced by the first option on save. */
export function EditClientForm({ action, name, status, statusOptions, contact, ownerUserId, owners, businessType = null, groupCompanies = null, groupCompanyId = null }: {
  action: Action; name: string; status: string; statusOptions: string[];
  contact: Record<string, unknown>; ownerUserId: string | null; owners: OwnerOpt[];
  /** The current type, or `null` for a client with no profile row: nothing is preselected and the form will not submit until one is chosen. */
  businessType?: string | null;
  /** The picker's options when the person is a platform operator; `null` hides the picker (and the field is never sent). */
  groupCompanies?: GroupCompanyOption[] | null;
  groupCompanyId?: string | null;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className="lux-form-grid" style={{ maxWidth: 640 }}>
      <Field name="name" label="Client name" required defaultValue={name}
        hint="Shown on invoices, contracts and the client portal." />
      <BusinessTypeSelect defaultValue={businessType} />
      <Field name="status" label="Status" type="select" options={statusOptions} defaultValue={status} />
      <OwnerSelect owners={owners} defaultValue={ownerUserId} />
      {groupCompanies && <GroupCompanySelect options={groupCompanies} defaultValue={groupCompanyId} />}
      <ContactFields contact={contact} />
      <Err state={state} />
      <div style={{ gridColumn: "1 / -1" }}><Button type="submit" size="md" disabled={pending}>{pending ? "Saving…" : "Save changes"}</Button></div>
    </form>
  );
}

/** CC-D10 — add a note. Clears itself after a successful save; keeps the text on an error. */
export function ClientNoteForm({ action }: { action: Action }) {
  const [state, formAction, pending] = useActionState(action, null);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => { if (state && !state.error) formRef.current?.reset(); }, [state]);
  return (
    <form ref={formRef} action={formAction} className="lux-form-grid" style={{ maxWidth: 720 }}>
      <div style={{ gridColumn: "1 / -1" }}>
        <Field name="body" label="New note" type="textarea" required hint="Internal — never shown to the client." />
      </div>
      <Err state={state} />
      <div style={{ gridColumn: "1 / -1" }}><Button type="submit" size="md" disabled={pending}>{pending ? "Saving…" : "Add note"}</Button></div>
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
