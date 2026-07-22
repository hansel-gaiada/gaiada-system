import { Eyebrow } from "@/components/ui";
import "./forms.css";

export function Field({ name, label, type = "text", defaultValue, options, optionItems, placeholder, required, disabled }: {
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
}) {
  if (type === "boolean") {
    return (
      <label className="lux-field lux-field--checkbox">
        <input
          type="checkbox"
          name={name}
          defaultChecked={Boolean(defaultValue)}
          required={required}
          className="lux-field__checkbox"
        />
        <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>{label}</Eyebrow>
      </label>
    );
  }

  if (type === "select") {
    return (
      <label className="lux-field">
        <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>{label}</Eyebrow>
        <select name={name} defaultValue={defaultValue != null ? String(defaultValue) : ""} required={required} className="lux-field__control">
          <option value="">{placeholder ?? ""}</option>
          {optionItems
            ? optionItems.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)
            : (options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </label>
    );
  }

  if (type === "textarea") {
    return (
      <label className="lux-field">
        <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>{label}</Eyebrow>
        <textarea name={name} defaultValue={defaultValue != null ? String(defaultValue) : ""} required={required} className="lux-field__control lux-field__control--textarea" />
      </label>
    );
  }

  return (
    <label className="lux-field">
      <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>{label}</Eyebrow>
      <input
        type={type}
        name={name}
        defaultValue={defaultValue != null ? String(defaultValue) : ""}
        required={required}
        disabled={disabled}
        className="lux-field__control"
      />
    </label>
  );
}
