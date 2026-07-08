import { Eyebrow } from "@/components/ui";
import "./forms.css";

export function Field({ name, label, type = "text", defaultValue, options, required, disabled }: {
  name: string;
  label: string;
  type?: "text" | "number" | "date" | "select" | "textarea" | "boolean";
  defaultValue?: unknown;
  options?: string[];
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
          <option value="" disabled hidden />
          {(options ?? []).map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
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
