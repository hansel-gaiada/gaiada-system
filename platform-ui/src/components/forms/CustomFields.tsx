import type { FieldDef } from "@/lib/entities";
import { Field } from "./Field";
import "./forms.css";

export function CustomFields({ defs, values }: { defs: FieldDef[]; values?: Record<string, unknown> }) {
  if (defs.length === 0) return null;
  return (
    <div className="lux-form-grid">
      {defs.map((d) => (
        <Field
          key={d.key}
          name={`cf_${d.key}`}
          label={d.required ? `${d.label} *` : d.label}
          type={
            d.data_type === "select"
              ? "select"
              : d.data_type === "boolean"
                ? "boolean"
                : d.data_type === "number"
                  ? "number"
                  : d.data_type === "date"
                    ? "date"
                    : "text"
          }
          options={d.options}
          defaultValue={values?.[d.key]}
          required={d.required}
        />
      ))}
    </div>
  );
}
