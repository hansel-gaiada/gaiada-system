"use client";
import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";

// P2-10 / P2-11 / P2-12-FE — one control for every IAM write, because they all share the same three
// outcomes: it worked, it was refused, or it was refused WITH A NEXT STEP.
//
// ⚠ THE THIRD OUTCOME IS THE ONE THIS COMPONENT EXISTS FOR. Two server refusals are not failures:
//   * `assignment_request_required` — a department head tried to place someone directly. The server is
//     saying "propose it instead", which is a different flow, not a smaller version of this one.
//   * `ceiling_exceeded` / `override_required` — the grant is above what this granter may give, and the
//     answer is "request an override", which is again a real next action.
// Rendering either as a red error would teach an operator that the system is broken when it is in fact
// telling them exactly what to do. So a result carrying `nextStep` renders as GUIDANCE with the
// follow-up control attached, and `onNextStep` is how the page supplies that control.
//
// Fields are declared by the caller rather than composed here: a hire needs a name and an email, a
// termination needs a reason, an override needs a justification. What is shared is the SUBMIT
// behaviour and the outcome rendering.

export type ActionResult =
  | { ok: true; message: string; nextStep?: "propose_assignment" | "request_override"; id?: string }
  | { ok: false; error: string; nextStep?: "propose_assignment" | "request_override" };

export interface IamField {
  name: string;
  label: string;
  type?: "text" | "email" | "date" | "number" | "select" | "textarea";
  required?: boolean;
  placeholder?: string;
  hint?: string;
  options?: { value: string; label: string; disabled?: boolean; hint?: string }[];
  defaultValue?: string;
}

interface Props {
  /** Button label when the form is closed. */
  label: string;
  /** Heading shown once the form is open. */
  title?: string;
  fields: IamField[];
  /** Constant values submitted with the form (ids the operator never types). */
  hidden?: Record<string, string>;
  action: (formData: FormData) => Promise<ActionResult>;
  variant?: "solid" | "ghost";
  /** Rendered when a refusal carries a next step — the page's own follow-up control. */
  onNextStep?: (step: "propose_assignment" | "request_override") => ReactNode;
  /** Skip the form entirely: a one-click action with no operator input. */
  immediate?: boolean;
  /** Extra confirmation for the irreversible ones. */
  confirm?: string;
}

export function IamAction({
  label, title, fields, hidden, action, variant = "ghost", onNextStep, immediate, confirm,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  const submit = (formData: FormData) => {
    for (const [k, v] of Object.entries(hidden ?? {})) formData.set(k, v);
    startTransition(async () => {
      const res = await action(formData);
      setResult(res);
      if (res.ok) {
        setOpen(false);
        // Refresh AFTER recording the result, so the success message survives the re-render. The
        // message often carries the only copy of a detail the operator needs (how many grants moved).
        router.refresh();
      }
    });
  };

  const outcome = result ? (
    <div className={result.ok ? "iam-outcome iam-outcome--ok" : result.nextStep ? "iam-outcome iam-outcome--guide" : "iam-outcome iam-outcome--error"}>
      {/* role="alert" only for a genuine refusal. A next-step message is guidance, and interrupting a
          screen-reader user with it would misrepresent what happened. */}
      <span role={result.ok || result.nextStep ? undefined : "alert"}>
        {result.ok ? result.message : result.error}
      </span>
      {!result.ok && result.nextStep && onNextStep ? (
        <span className="iam-outcome__next">{onNextStep(result.nextStep)}</span>
      ) : null}
      <button type="button" className="iam-outcome__dismiss" onClick={() => setResult(null)} aria-label="Dismiss">
        ×
      </button>
    </div>
  ) : null;

  if (immediate) {
    return (
      <span className="iam-action">
        <Button
          size="sm"
          variant={variant}
          disabled={pending}
          onClick={() => {
            if (confirm && !window.confirm(confirm)) return;
            const fd = new FormData();
            submit(fd);
          }}
        >
          {pending ? "Working…" : label}
        </Button>
        {outcome}
      </span>
    );
  }

  return (
    <span className="iam-action">
      {open ? (
        <form
          className="iam-form"
          action={submit}
          onSubmit={(e) => {
            if (confirm && !window.confirm(confirm)) e.preventDefault();
          }}
        >
          {title ? <div className="iam-form__title">{title}</div> : null}
          {fields.map((f) => (
            <label key={f.name} className="iam-form__field">
              <span className="iam-form__label">
                {f.label}
                {f.required ? <span aria-hidden="true"> *</span> : null}
              </span>
              {f.type === "select" ? (
                <select name={f.name} required={f.required} defaultValue={f.defaultValue} className="lux-field__control">
                  <option value="">—</option>
                  {(f.options ?? []).map((o) => (
                    // Unattachable options stay VISIBLE and disabled, with their reason: the server is
                    // the allow-list, and hiding a refusal turns a stated boundary into an invisible one.
                    <option key={o.value} value={o.value} disabled={o.disabled}>
                      {o.label}
                      {o.hint ? ` — ${o.hint}` : ""}
                    </option>
                  ))}
                </select>
              ) : f.type === "textarea" ? (
                <textarea
                  name={f.name}
                  required={f.required}
                  placeholder={f.placeholder}
                  rows={2}
                  className="lux-field__control"
                />
              ) : (
                <input
                  type={f.type ?? "text"}
                  name={f.name}
                  required={f.required}
                  placeholder={f.placeholder}
                  defaultValue={f.defaultValue}
                  className="lux-field__control"
                />
              )}
              {f.hint ? <span className="iam-form__hint">{f.hint}</span> : null}
            </label>
          ))}
          <span className="iam-form__actions">
            <Button size="sm" type="submit" disabled={pending}>
              {pending ? "Working…" : label}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </span>
        </form>
      ) : (
        <Button size="sm" variant={variant} onClick={() => setOpen(true)}>
          {label}
        </Button>
      )}
      {outcome}
    </span>
  );
}
