"use client";
// DW-5c UI — the request form (/requests/new). One form for both kinds: the receiving department decides the kind
// (Creatives takes asset requests, Web Dev takes engineering requests; contract §32.4). What a person types is checked
// by `validateRequestDraft`, which mirrors §32.4 bound for bound, so a mistake is explained next to its field before the
// server is asked; the server still validates and its refusal lands on the same field. Everything is plain text.
import { useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { Field } from "@/components/forms/Field";
import { createRequestAction } from "@/lib/requestActions";
import {
  DELIVERABLE_FORMATS, DELIVERABLE_FORMAT_LABEL, ENGINEERING_KINDS, ENGINEERING_KIND_LABEL, LIMITS,
  emptyDeliverable, validateRequestDraft,
  type DeliverableDraft, type FieldErrors, type PartOption, type RequestDraft, type RequestKind,
} from "@/lib/requests";
import "@/components/forms/forms.css";
import "./requests.css";

export interface RequestFormProps {
  kind: RequestKind;
  toUnitId: string;
  toUnitName: string;
  /** The campaigns where the receiving department has a part. `null` when they could not be read. */
  campaigns: PartOption[] | null;
}

const val = (fd: FormData, k: string) => String(fd.get(k) ?? "");

export function RequestForm({ kind, toUnitId, toUnitName, campaigns }: RequestFormProps) {
  const router = useRouter();
  const nextKey = useRef(1);
  const [rows, setRows] = useState<number[]>([0]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const deliverables: DeliverableDraft[] = rows.map((k) => ({
      format: val(fd, `d-format-${k}`), size: val(fd, `d-size-${k}`), quantity: val(fd, `d-qty-${k}`),
    }));
    const draft: RequestDraft = {
      kind,
      toUnitId,
      title: val(fd, "title"),
      brief: val(fd, "brief"),
      neededBy: val(fd, "neededBy"),
      campaignPartId: val(fd, "campaignPartId"),
      assets: { deliverables, channel: val(fd, "channel"), references: val(fd, "references"), notes: val(fd, "notes") },
      engineering: { kind: val(fd, "engKind"), affectedUrl: val(fd, "affectedUrl") },
    };
    const check = validateRequestDraft(draft);
    if (!check.ok) {
      setErrors(check.errors);
      setFormError("Some details need another look. They are marked below.");
      return;
    }
    setErrors({});
    setFormError(null);
    startTransition(async () => {
      const res = await createRequestAction(check.body);
      if (!res.ok) {
        setFormError(res.error);
        // A server refusal names its field the way the validator does: show it beside the field too.
        if (res.field) setErrors({ [res.field]: res.error });
        return;
      }
      router.push(`/requests/${encodeURIComponent(res.id)}`);
    });
  }

  const addRow = () => setRows((r) => (r.length < LIMITS.deliverables ? [...r, nextKey.current++] : r));
  const removeRow = (k: number) => setRows((r) => (r.length > 1 ? r.filter((x) => x !== k) : r));

  return (
    <form className="req-form" onSubmit={submit} aria-label="New request" noValidate>
      <p className="req-form__to">To <strong>{toUnitName}</strong></p>

      <Field name="title" label="Title" type="text" required error={errors.title} hint={`Up to ${LIMITS.title} characters.`} />
      <Field name="brief" label="Brief" type="textarea" error={errors.brief} hint="What you need and why. Plain text." />
      <div className="req-form__row">
        <Field name="neededBy" label="Needed by" type="date" error={errors.neededBy} />
        {campaigns === null ? (
          <p className="req-note" style={{ alignSelf: "end" }}>
            The campaigns could not be read, so a campaign cannot be named now. You can still send the request.
          </p>
        ) : campaigns.length > 0 ? (
          <Field
            name="campaignPartId" label="Campaign" type="select" placeholder="No campaign" error={errors.campaignPartId}
            optionItems={campaigns.map((c) => ({ value: c.partId, label: c.label }))}
            hint={`Campaigns where ${toUnitName} has a part.`}
          />
        ) : null}
      </div>

      {kind === "assets" ? (
        <>
          <fieldset className="req-form__group">
            <legend className="req-form__legend">What you need</legend>
            {errors["form.deliverables"] && <p className="req-error" role="alert">{errors["form.deliverables"]}</p>}
            {rows.map((k, i) => (
              <div className="req-deliverable" key={k}>
                <Field
                  name={`d-format-${k}`} label="Format" type="select" placeholder="Choose" required
                  optionItems={DELIVERABLE_FORMATS.map((f) => ({ value: f, label: DELIVERABLE_FORMAT_LABEL[f] }))}
                  error={errors[`form.deliverables[${i}].format`]}
                />
                <Field
                  name={`d-size-${k}`} label="Size" type="text" placeholder="1080x1350"
                  error={errors[`form.deliverables[${i}].size`]}
                />
                <Field
                  name={`d-qty-${k}`} label="Quantity" type="number" defaultValue="1" required
                  error={errors[`form.deliverables[${i}].quantity`]}
                />
                <Button variant="ghost" size="sm" onClick={() => removeRow(k)} disabled={rows.length <= 1 || pending}>Remove</Button>
              </div>
            ))}
            <div className="req-actions">
              <Button variant="ghost" size="sm" onClick={addRow} disabled={rows.length >= LIMITS.deliverables || pending}>Add a deliverable</Button>
              <span className="req-note">{rows.length} of {LIMITS.deliverables}</span>
            </div>
          </fieldset>
          <div className="req-form__row">
            <Field name="channel" label="Channel" type="text" placeholder="Instagram, website, print" error={errors["form.channel"]} />
          </div>
          <Field
            name="references" label="Reference links" type="textarea" error={errors["form.references"]}
            hint={`One link per line, http or https, up to ${LIMITS.references}.`}
          />
          <Field name="notes" label="Notes" type="textarea" error={errors["form.notes"]} hint="Anything else the team should know. Plain text." />
        </>
      ) : (
        <div className="req-form__row">
          <Field
            name="engKind" label="What kind of change" type="select" placeholder="Choose" required error={errors["form.kind"]}
            optionItems={ENGINEERING_KINDS.map((k) => ({ value: k, label: ENGINEERING_KIND_LABEL[k] }))}
          />
          <Field name="affectedUrl" label="Affected page" type="text" placeholder="https://" error={errors["form.affectedUrl"]} hint="Optional. An http or https link." />
        </div>
      )}

      {formError && <p className="req-error" role="alert">{formError}</p>}
      <div className="req-actions">
        <Button type="submit" size="md" disabled={pending}>{pending ? "Sending…" : "Send request"}</Button>
      </div>
    </form>
  );
}
