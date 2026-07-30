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

// An editable config row that also carries the ONE fact a plain form can't express: whether this
// value is a console override shadowing the env. Without that, an operator who fixed the env and
// redeployed would see the old value and conclude the deploy failed — so an overridden field says so
// and offers the revert that puts the env back in charge.
export function OverridableConfigField({
  field,
  overridden,
  action,
  revertAction,
}: {
  field: ConfigFieldType;
  overridden?: boolean;
  action: (prev: ConfigActionState | null, formData: FormData) => Promise<ConfigActionState>;
  revertAction?: (prev: ConfigActionState | null, formData: FormData) => Promise<ConfigActionState>;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const [revertState, revertFormAction, reverting] = useActionState(
    revertAction ?? (async () => ({ ok: false, error: "Revert isn't available." })),
    null,
  );

  // Defense in depth: even if a caller mistakenly routes a secret field here, never render its value
  // in an input — only whether one is present, and never editable.
  if (field.kind === "secretPresence") {
    return (
      <div className="sys-config-field" style={{ alignItems: "center" }}>
        <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>{field.label}</Eyebrow>
        <StatusBadge label={field.value ? "Configured" : "Absent"} />
      </div>
    );
  }

  return (
    <div className="sys-config-row">
      <form action={formAction} className="sys-config-field">
        <input type="hidden" name="kind" value={field.kind} />
        <Field
          name="value"
          label={field.label}
          type={FIELD_TYPE[field.kind]}
          defaultValue={Array.isArray(field.value) ? field.value.join(", ") : field.value}
          options={field.options}
        />
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {overridden && <StatusBadge label="override" />}
      </form>
      {overridden && revertAction && (
        <form action={revertFormAction}>
          <Button type="submit" size="sm" variant="ghost" disabled={reverting}>
            {reverting ? "Reverting…" : "Revert to env"}
          </Button>
        </form>
      )}
      {state?.error && <Toast message={state.error} />}
      {state?.ok && <Toast message="Saved." />}
      {revertState?.error && <Toast message={revertState.error} />}
      {revertState?.ok && <Toast message="Reverted to the environment value." />}
    </div>
  );
}
