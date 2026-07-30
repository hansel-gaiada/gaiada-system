"use client";
import { useActionState } from "react";
import type { ConfigField as ConfigFieldType } from "@/lib/admin";
import { Field } from "@/components/forms/Field";
import { Button, Eyebrow, StatusBadge, Toast } from "@/components/ui";
import "./systems.css";

export interface ConfigActionState {
  ok: boolean;
  error?: string;
}

const FIELD_TYPE: Record<Exclude<ConfigFieldType["kind"], "secretPresence">, "text" | "number" | "boolean" | "select"> = {
  text: "text",
  number: "number",
  boolean: "boolean",
  select: "select",
};

// A small, self-contained editable-config row: one Field + submit + Toast.
// The server action is already bound to the field's key by the caller, so
// this component only forwards `value`/`kind` and reports the result.
export function ConfigField({
  field,
  action,
}: {
  field: ConfigFieldType;
  action: (prev: ConfigActionState | null, formData: FormData) => Promise<ConfigActionState>;
}) {
  const [state, formAction, pending] = useActionState(action, null);

  // Defense in depth: even if a future caller mistakenly routes a secret
  // field into ConfigField, never render its value in a form/input — only
  // whether one is present. This is not editable.
  if (field.kind === "secretPresence") {
    return (
      <div className="sys-config-field" style={{ alignItems: "center" }}>
        <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>{field.label}</Eyebrow>
        <StatusBadge label={field.value ? "Configured" : "Absent"} />
      </div>
    );
  }

  // Field always renders its own leading blank option (value="") ahead of whatever list it's
  // given, with `placeholder` as that option's label. When the source already supplied its own
  // blank-value entry (e.g. the bot's explicit "None" for clearing managementGroupId), use its
  // label as that placeholder and drop it from the list instead of stacking two empty rows.
  const blankOption = field.optionItems?.find((o) => o.value === "");
  const optionItems = blankOption ? field.optionItems?.filter((o) => o.value !== "") : field.optionItems;

  return (
    <form action={formAction} className="sys-config-field">
      <input type="hidden" name="kind" value={field.kind} />
      <Field
        name="value"
        label={field.label}
        type={FIELD_TYPE[field.kind]}
        defaultValue={field.value}
        options={field.options}
        optionItems={optionItems}
        placeholder={blankOption?.label}
      />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
      {state?.error && <Toast message={state.error} />}
      {state?.ok && <Toast message="Saved." />}
    </form>
  );
}
