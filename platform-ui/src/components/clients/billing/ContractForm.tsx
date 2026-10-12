"use client";
import { useActionState } from "react";
import { createContractAction, updateContractAction, type BillingActionState } from "@/lib/contractsActions";
import type { Contract } from "@/lib/contracts";
import { Field } from "@/components/forms/Field";
import "./billing.css";

// PV3-08 — the draft form: create a contract for this client, or edit one that is still a draft.
//
// ── WHAT IT DOES NOT DO ──────────────────────────────────────────────────────────────────────────
// It never sends. Saving a draft reaches nobody; Send is its own button on the row, separately
// authorized by the backend. And a contract that is already sent or signed has no edit form at all (the
// row offers none): a signature attests to the exact terms the signer saw, so a sent contract is re-issued,
// never edited in place.
//
// ── THE PDF ─────────────────────────────────────────────────────────────────────────────────────
// Optional. It goes up through the files route with the `contract` target once the draft exists (the
// server action does both steps). If the draft saves and the file does not, the error says the draft WAS
// saved, so nobody creates it a second time.
//
// `projects` is `null` when the projects read was refused or failed: the form then says so and omits the
// field, which is not the same as "this client has no projects".
export function ContractForm({
  clientId,
  projects,
  contract,
  onDone,
}: {
  clientId: string;
  projects: { id: string; name: string }[] | null;
  /** Present: edit this draft. Absent: create a new one. */
  contract?: Contract;
  onDone?: () => void;
}) {
  const editing = Boolean(contract);
  const [state, action, pending] = useActionState<BillingActionState | null, FormData>(
    editing ? updateContractAction : createContractAction,
    null,
  );
  const fieldError = (name: string) => (state && !state.ok && state.field === name ? state.error : undefined);
  const generalError = state && !state.ok && !state.field ? state.error : undefined;

  // After a successful create the form remounts empty (the key changes), and the confirmation stays above
  // it. An edit stays as it is: the person is looking at the draft they just changed.
  const formKey = !editing && state?.ok ? `saved-${state.id}` : "form";

  return (
    <div>
      {state?.ok && (
        <p className="bl-msg bl-msg--ok" role="status">
          {editing ? "Saved." : "Draft saved. It is not sent: open it below and press Send when it is ready."}
        </p>
      )}
      <form key={formKey} action={action} className="bl-form" aria-label={editing ? "Edit draft contract" : "New draft contract"}>
        <input type="hidden" name="clientId" value={clientId} />
        {contract && <input type="hidden" name="contractId" value={contract.id} />}
        {generalError && <p className="bl-msg bl-msg--error" role="alert">{generalError}</p>}

        <div className="lux-form-grid">
          <Field name="title" label="Title" required defaultValue={contract?.title} error={fieldError("title")} />
          <Field name="reference" label="Reference" defaultValue={contract?.reference ?? ""} hint="Your own contract number, e.g. GDA-2026-014. Each reference can be used once." error={fieldError("reference")} />
          {projects ? (
            !editing && (
              <Field
                name="projectId" label="Project" type="select" placeholder="The whole relationship (no single project)"
                optionItems={projects.map((p) => ({ value: p.id, label: p.name }))}
                hint="Leave blank for a master agreement that covers everything."
              />
            )
          ) : (
            !editing && <p className="bl-form__hint">This client&apos;s projects cannot be read right now, so the contract cannot be tied to one. Save it without a project, or try again later.</p>
          )}
          <Field name="value" label="Value" type="number" defaultValue={contract?.value ?? ""} error={fieldError("value")} />
          <Field name="currency" label="Currency" defaultValue={contract?.currency ?? "IDR"} hint="Three-letter code, e.g. IDR or USD." />
          <Field name="startsOn" label="Starts" type="date" defaultValue={contract?.startsOn ?? ""} error={fieldError("startsOn")} />
          <Field name="endsOn" label="Ends" type="date" defaultValue={contract?.endsOn ?? ""} error={fieldError("endsOn")} />
        </div>

        <Field
          name="bodyMd" label="Terms" type="textarea" defaultValue={contract?.bodyMd ?? ""}
          hint="Markdown. The client reads this in their portal. A contract needs these terms or a PDF before it can be sent."
        />

        <div className="bl-form__file">
          <label htmlFor={`contract-file-${contract?.id ?? "new"}`}>PDF (optional)</label>
          <input
            id={`contract-file-${contract?.id ?? "new"}`}
            name="file"
            type="file"
            accept="application/pdf"
            disabled={pending}
            aria-describedby={`contract-file-hint-${contract?.id ?? "new"}`}
          />
          <span className="bl-form__hint" id={`contract-file-hint-${contract?.id ?? "new"}`}>
            Up to 10 MB.{contract?.fileId ? " A PDF is already attached; choosing another replaces it." : ""}
          </span>
          {fieldError("file") && <span className="bl-msg bl-msg--error" role="alert">{fieldError("file")}</span>}
        </div>

        <div className="bl-form__actions">
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
            {pending ? "Saving…" : editing ? "Save changes" : "Save draft"}
          </button>
          {onDone && (
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={onDone} disabled={pending}>
              Close
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
