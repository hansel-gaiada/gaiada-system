"use client";
// SCP-5 W5-C5 (BFF §63.30.5) — the controls the rules editors share. Each one is labelled, shows the default beside the current value in words, and puts a refused field's message right beside
// itself: the panel hands down the refusal's `field` (`<section>.<path>`) through a context, and a control whose `path` is that field draws the words and is marked invalid (in words, never colour alone).
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";

export interface FieldError { field: string | null; message: string }
export const RulesErrorContext = createContext<FieldError | null>(null);
/** The refusal's words when it points at `path` exactly. */
export const useFieldError = (path: string): string | null => {
  const e = useContext(RulesErrorContext);
  return e && e.field === path ? e.message : null;
};

interface Common { path: string; label: string; hint?: string; def?: string; wide?: boolean }

function Shell({ id, path, label, hint, def, wide, children }: Common & { id: string; children: ReactNode }) {
  const err = useFieldError(path);
  return (
    <div className={`rules__field${wide ? " rules__field--wide" : ""}`}>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <span className="rules__hint" id={`${id}-hint`}>{hint}</span>}
      {def !== undefined && <span className="rules__hint">Default: {def}</span>}
      {err && <span className="rules__err" id={`${id}-err`}>{err}</span>}
    </div>
  );
}
const describedBy = (id: string, hint: boolean, err: boolean): string | undefined => [hint ? `${id}-hint` : "", err ? `${id}-err` : ""].filter(Boolean).join(" ") || undefined;

/** A whole number. It keeps what is typed; an empty or non-numeric box sends NaN (JSON null), and the server names the field. */
export function NumberField({ path, label, value, onChange, min, max, step = 1, hint, def, wide }: Common & { value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number }) {
  const id = useId();
  const err = useFieldError(path);
  const [text, setText] = useState(Number.isFinite(value) ? String(value) : "");
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current && !(Number.isNaN(value) && Number.isNaN(last.current))) { last.current = value; setText(Number.isFinite(value) ? String(value) : ""); }
  }, [value]);
  const typed = text.trim() === "" ? NaN : Number(text);
  return (
    <Shell id={id} path={path} label={label} hint={hint} def={def} wide={wide}>
      <input
        id={id} className="scp-input" type="number" inputMode={step === 1 ? "numeric" : "decimal"} min={min} max={max} step={step} value={text} data-rule-field={path}
        aria-invalid={!!err || Number.isNaN(typed)} aria-describedby={describedBy(id, !!hint, !!err)}
        onChange={(e) => { const n = e.target.value.trim() === "" ? NaN : Number(e.target.value); last.current = n; setText(e.target.value); onChange(n); }}
      />
    </Shell>
  );
}

export function TextField({ path, label, value, onChange, hint, def, wide, multiline, maxLength }: Common & { value: string; onChange: (s: string) => void; multiline?: boolean; maxLength?: number }) {
  const id = useId();
  const err = useFieldError(path);
  const props = { id, value, "data-rule-field": path, "aria-invalid": !!err, "aria-describedby": describedBy(id, !!hint, !!err), maxLength, className: "scp-input rules__input--wide" };
  return (
    <Shell id={id} path={path} label={label} hint={hint} def={def} wide={wide}>
      {multiline
        ? <textarea {...props} rows={2} onChange={(e) => onChange(e.target.value)} />
        : <input {...props} type="text" onChange={(e) => onChange(e.target.value)} />}
    </Shell>
  );
}

export function SelectField({ path, label, value, options, onChange, hint, def, wide }: Common & { value: string; options: ReadonlyArray<{ value: string; label: string }>; onChange: (v: string) => void }) {
  const id = useId();
  const err = useFieldError(path);
  return (
    <Shell id={id} path={path} label={label} hint={hint} def={def} wide={wide}>
      <select id={id} className="scp-input" value={value} data-rule-field={path} aria-invalid={!!err} aria-describedby={describedBy(id, !!hint, !!err)} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Shell>
  );
}

/** An on or off box. The words say the state ("on" or "off" in the label's default line), not a colour. */
export function ToggleField({ path, label, checked, onChange, hint, def, disabled }: Common & { checked: boolean; onChange: (b: boolean) => void; disabled?: boolean }) {
  const id = useId();
  const err = useFieldError(path);
  return (
    <div className="rules__field">
      <span className="rules__check">
        <input id={id} type="checkbox" checked={checked} disabled={disabled} data-rule-field={path} aria-invalid={!!err} aria-describedby={describedBy(id, !!hint, !!err)} onChange={(e) => onChange(e.target.checked)} />
        <label htmlFor={id}>{label}</label>
      </span>
      {hint && <span className="rules__hint" id={`${id}-hint`}>{hint}</span>}
      {def !== undefined && <span className="rules__hint">Default: {def}</span>}
      {err && <span className="rules__err" id={`${id}-err`}>{err}</span>}
    </div>
  );
}

/** A group of boxes or a list the server refuses as a whole (`path` is the group's own path): it carries the group's message under its legend. */
export function Group({ path, legend, children, hint }: { path: string; legend: string; children: ReactNode; hint?: string }) {
  const err = useFieldError(path);
  return (
    <fieldset className="rules__group" data-rule-field={path} tabIndex={-1}>
      <legend>{legend}</legend>
      {hint && <span className="rules__hint">{hint}</span>}
      {children}
      {err && <span className="rules__err">{err}</span>}
    </fieldset>
  );
}
