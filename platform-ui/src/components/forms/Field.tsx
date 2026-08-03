import { useId } from "react";
import "./forms.css";

// One form field: label, control, and — when given — a hint and an error.
//
// What changed and why. The label used to be an <Eyebrow>: 10px, uppercase, 0.6 opacity. That is a
// CAPTION treatment — correct for labelling a KPI whose value is the loud part, wrong for a form
// where the label is the only thing telling you what to type. Labels are now 12px sentence case at
// full ink. The eyebrow remains the system's signature elsewhere; it just stopped being used where
// legibility matters more than texture.
//
// Also added, because their absence was the actual "unclear inputs" problem:
//   - a required marker (before, required and optional looked identical until submit failed)
//   - a per-field error slot, wired with aria-describedby + aria-invalid
//   - an optional hint for format expectations ("YYYY-MM-DD", "minutes")
//   - a visible focus treatment and a hover state (before: one 0.5px line changing colour)
//   - a caret on selects, which had appearance:none and so looked identical to a text input
export function Field({
  name, label, type = "text", defaultValue, options, optionItems, placeholder, required, disabled, hint, error,
}: {
  name: string;
  label: string;
  type?: "text" | "number" | "date" | "select" | "textarea" | "boolean";
  defaultValue?: unknown;
  options?: string[];
  // Value/label pairs for selects where the submitted value differs from the
  // display text (e.g. a department id → name). Takes precedence over `options`.
  optionItems?: { value: string; label: string }[];
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  /** Format or meaning the label cannot carry on its own. Shown under the control, quietly. */
  hint?: string;
  /** Validation message. Its presence also sets aria-invalid, so the state is announced rather than
   *  only coloured — colour alone fails on a monochrome or high-contrast display. */
  error?: string;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [errId, hintId].filter(Boolean).join(" ") || undefined;
  const value = defaultValue != null ? String(defaultValue) : "";

  // The required marker is drawn by CSS, not inserted into the DOM: as a text node it becomes part
  // of the label's accessible name ("Summary*"), which breaks every getByLabelText("Summary") and,
  // worse, is read aloud as "Summary star". The `required` attribute on the control is what actually
  // conveys the state to assistive tech; this is purely the visual cue.
  const labelEl = <span className={`lux-field__label${required ? " lux-field__label--req" : ""}`}>{label}</span>;
  const below = (
    <>
      {error && <span id={errId} className="lux-field__error" role="alert">{error}</span>}
      {hint && !error && <span id={hintId} className="lux-field__hint">{hint}</span>}
    </>
  );
  const shared = {
    name,
    required,
    disabled,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
    className: `lux-field__control${error ? " lux-field__control--error" : ""}`,
  } as const;

  if (type === "boolean") {
    return (
      <label className={`lux-field lux-field--checkbox${disabled ? " lux-field--disabled" : ""}`}>
        <input
          type="checkbox"
          name={name}
          defaultChecked={Boolean(defaultValue)}
          required={required}
          disabled={disabled}
          className="lux-field__checkbox"
          aria-describedby={describedBy}
        />
        <span className="lux-field__checkbox-text">{labelEl}{below}</span>
      </label>
    );
  }

  if (type === "select") {
    return (
      <label className={`lux-field${disabled ? " lux-field--disabled" : ""}`}>
        {labelEl}
        <span className="lux-field__selectwrap">
          <select {...shared} defaultValue={value}>
            <option value="">{placeholder ?? "Select…"}</option>
            {optionItems
              ? optionItems.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)
              : (options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </span>
        {below}
      </label>
    );
  }

  if (type === "textarea") {
    return (
      <label className={`lux-field${disabled ? " lux-field--disabled" : ""}`}>
        {labelEl}
        <textarea
          {...shared}
          className={`${shared.className} lux-field__control--textarea`}
          defaultValue={value}
          placeholder={placeholder}
        />
        {below}
      </label>
    );
  }

  return (
    <label className={`lux-field${disabled ? " lux-field--disabled" : ""}`}>
      {labelEl}
      <input {...shared} type={type} defaultValue={value} placeholder={placeholder} />
      {below}
    </label>
  );
}
