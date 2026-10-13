"use client";
import { useActionState, useState } from "react";
import { preassignCodeAction, saveServiceLineAction } from "@/lib/billingNumberingActions";
import { NUMBER_FORMAT, suggestKey, type NumberCodes, type ServiceLine } from "@/lib/billingNumbering";
import type { ProfileSaveResult } from "@/lib/billingProfile";
import { HairlineTable } from "@/components/ui";
import "@/components/billing/billing-screens.css";

// PV5-04b (PV-D35) — the two numbering sections of the billing profile page.
//
// An invoice number reads {company}/{yyyy}/{mm}/{code}/{nnnn}. The {code} stands for a service line and the client's business
// type; it is deliberately not readable by a client, so the decode table below is STAFF-ONLY and is never shown in the portal.
//
// ── A CODE IS NEVER EDITED ────────────────────────────────────────────────────────────────────────────
// There is no edit control on a code. It is generated the first time a pair is needed (at the first invoice), or here ahead of
// time, and from then on an issued invoice may carry it. A pair that already has a code answers with it and changes nothing.

function Message({ state }: { state: ProfileSaveResult | null }) {
  if (!state) return null;
  if (!state.ok && state.error) return <p className="bs-error" role="alert">{state.error}</p>;
  if (state.ok && state.notice) return <p className="bs-ok" role="status">{state.notice}</p>;
  return null;
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="bs-field">
      <label className="bs-field__label" htmlFor={id}>{label}</label>
      {children}
      {hint && <span className="bs-field__hint" id={`${id}-hint`}>{hint}</span>}
    </div>
  );
}

/** One existing line: rename, link a department, switch on or off. Each save is its own request. */
function ServiceLineRow({ line }: { line: ServiceLine }) {
  const [state, formAction, pending] = useActionState<ProfileSaveResult | null, FormData>(saveServiceLineAction, null);
  const [toggleState, toggleAction, togglePending] = useActionState<ProfileSaveResult | null, FormData>(saveServiceLineAction, null);
  return (
    <li className="bs-line" data-active={line.active}>
      <form action={formAction} className="bs-form" aria-label={`Service line ${line.name}`}>
        <input type="hidden" name="key" value={line.key} />
        <div className="bs-grid">
          <Field id={`sl-name-${line.key}`} label="Name">
            <input id={`sl-name-${line.key}`} name="name" required maxLength={120} defaultValue={line.name} disabled={pending} />
          </Field>
          <Field id={`sl-dept-${line.key}`} label="Department" hint="Optional. An invoice whose projects all belong to this department defaults to this line.">
            <input
              id={`sl-dept-${line.key}`} name="departmentId" defaultValue={line.departmentId ?? ""} disabled={pending}
              placeholder="Department id" aria-describedby={`sl-dept-${line.key}-hint`}
            />
          </Field>
        </div>
        <div className="bs-actions">
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
          <span className="bs-note">
            Key <code>{line.key}</code> · {line.invoiceCount} invoice{line.invoiceCount === 1 ? "" : "s"}{line.active ? "" : " · switched off"}
          </span>
        </div>
        <Message state={state} />
      </form>
      <form action={toggleAction} aria-label={`${line.active ? "Switch off" : "Switch on"} ${line.name}`}>
        <input type="hidden" name="key" value={line.key} />
        <input type="hidden" name="active" value={line.active ? "false" : "true"} />
        <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={togglePending}>
          {line.active ? "Switch off" : "Switch on"}
        </button>
        <Message state={toggleState} />
      </form>
    </li>
  );
}

export function ServiceLinesPanel({ lines }: { lines: ServiceLine[] }) {
  const [state, formAction, pending] = useActionState<ProfileSaveResult | null, FormData>(saveServiceLineAction, null);
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  return (
    <section aria-labelledby="service-lines-title" id="service-lines" className="bs-bank">
      <h2 id="service-lines-title" className="bs-bank__title">Service lines</h2>
      <p className="bs-note">
        The kinds of work this company invoices for. Staff pick one on each invoice before issuing it, and it sets the code in the
        invoice number ({NUMBER_FORMAT}). A line is switched off, never deleted, because issued invoices refer to it.
      </p>
      {lines.length === 0 ? (
        <p className="bs-note">No service lines yet, so no invoice can be issued. Add the first one below.</p>
      ) : (
        <ul className="bs-lines" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 16 }}>
          {lines.map((l) => <ServiceLineRow key={l.key} line={l} />)}
        </ul>
      )}

      <form action={formAction} className="bs-form" aria-label="Add a service line">
        <div className="bs-grid">
          <Field id="sl-new-name" label="Name">
            <input
              id="sl-new-name" name="name" required maxLength={120} value={name} disabled={pending}
              onChange={(e) => { setName(e.target.value); if (!keyTouched) setKey(suggestKey(e.target.value)); }}
            />
          </Field>
          <Field id="sl-new-key" label="Key" hint="Lower case letters, digits and underscores. It cannot be changed later.">
            <input
              id="sl-new-key" name="key" required maxLength={32} value={key} disabled={pending} aria-describedby="sl-new-key-hint"
              onChange={(e) => { setKeyTouched(true); setKey(e.target.value); }}
            />
          </Field>
          <Field id="sl-new-dept" label="Department" hint="Optional.">
            <input id="sl-new-dept" name="departmentId" disabled={pending} placeholder="Department id" aria-describedby="sl-new-dept-hint" />
          </Field>
        </div>
        <div className="bs-actions">
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>{pending ? "Adding…" : "Add service line"}</button>
        </div>
        <Message state={state} />
      </form>
    </section>
  );
}

export function NumberCodesPanel({ data, lines }: { data: NumberCodes; lines: ServiceLine[] }) {
  const [state, formAction, pending] = useActionState<ProfileSaveResult | null, FormData>(preassignCodeAction, null);
  return (
    <section aria-labelledby="number-codes-title" id="number-codes" className="bs-bank">
      <h2 id="number-codes-title" className="bs-bank__title">Number codes</h2>
      <p className="bs-note">
        Each invoice number carries a short code for its service line and the client&apos;s business type. It is not meant to be
        readable by a client: only staff can see what a code stands for, here and on the invoice page. A code is created the first
        time a pair is invoiced and is never changed or reused, so every number issued stays decodable.
      </p>
      {data.codes.length === 0 ? (
        <p className="bs-note">No codes yet. One is created automatically for each pair when its first invoice is issued.</p>
      ) : (
        <HairlineTable
          columns={[{ label: "Code" }, { label: "Service line" }, { label: "Client business type" }, { label: "Invoices", align: "right" }]}
          rows={data.codes.map((c) => [
            <code key={c.code} className="bs-code">{c.code}</code>, c.serviceLineName, c.businessTypeLabel, String(c.invoiceCount),
          ])}
          tcols="0.6fr 1.6fr 1.6fr 0.6fr"
        />
      )}

      <form action={formAction} className="bs-form" aria-label="Assign a code ahead of the first invoice">
        <p className="bs-note">
          Optional: give a pair its code before its first invoice, so you can see it here first. Leave the code blank to have one
          generated. A pair that already has a code keeps it.
        </p>
        <div className="bs-grid">
          <Field id="nc-line" label="Service line">
            <select id="nc-line" name="serviceLineKey" required defaultValue="" disabled={pending || lines.length === 0}>
              <option value="" disabled>Pick a service line</option>
              {lines.map((l) => <option key={l.key} value={l.key}>{l.name}{l.active ? "" : " (switched off)"}</option>)}
            </select>
          </Field>
          <Field id="nc-type" label="Client business type">
            <select id="nc-type" name="businessType" required defaultValue="" disabled={pending}>
              <option value="" disabled>Pick a business type</option>
              {data.businessTypes.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
            </select>
          </Field>
          <Field id="nc-code" label="Code (optional)" hint="2 to 4 capital letters or digits.">
            <input id="nc-code" name="code" maxLength={4} disabled={pending} autoComplete="off" aria-describedby="nc-code-hint" />
          </Field>
        </div>
        <div className="bs-actions">
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending || lines.length === 0}>
            {pending ? "Assigning…" : "Assign code"}
          </button>
        </div>
        <Message state={state} />
      </form>
    </section>
  );
}
