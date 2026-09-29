"use client";
import { registry, usedBy, type RegistryField } from "@/lib/clientCentre";

// CMC's `fieldControl`: a labelled input carrying the "Shared · N" badge (this field's value is the
// SAME across every section that uses it) and the field's help text, verbatim.
export function FieldControl({
  fieldKey,
  value,
  businessType,
  excludeSectionId,
  canEdit,
  onChange,
}: {
  fieldKey: string;
  value: string;
  businessType: string;
  /** The section currently being edited — excluded from its own "Shared · N" count, matching CMC's
   *  `usedBy(...).filter(n => n !== currentDept.name)`. Omit on Business details (nothing to exclude). */
  excludeSectionId?: string;
  canEdit: boolean;
  onChange: (key: string, value: string) => void;
}) {
  const def: RegistryField | undefined = registry.fields[fieldKey];
  if (!def) return null;
  const others = usedBy(registry, businessType, "fields", fieldKey, excludeSectionId);
  const inputId = `cc-field-${fieldKey}`;
  return (
    <label className={`cc-field${def.type === "textarea" ? " cc-field--wide" : ""}`} htmlFor={inputId}>
      <span className="cc-field__label">
        {def.label}
        {others.length > 0 && (
          <em className="cc-shared" title={`Also used in: ${others.join(", ")}`}>
            Shared · {others.length}
          </em>
        )}
      </span>
      {canEdit ? (
        def.type === "textarea" ? (
          <textarea id={inputId} className="cc-textarea" rows={3} value={value} onChange={(e) => onChange(fieldKey, e.target.value)} />
        ) : (
          <input
            id={inputId}
            className="cc-input"
            type={def.type}
            value={value}
            placeholder={def.type === "url" ? "https://" : undefined}
            onChange={(e) => onChange(fieldKey, e.target.value)}
          />
        )
      ) : (
        <span className="cc-readonly-value">{value || "—"}</span>
      )}
      {def.help && <small className="cc-field__help">{def.help}</small>}
    </label>
  );
}
