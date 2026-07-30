"use client";
import { useActionState } from "react";
import { Button, Toast } from "@/components/ui";

export interface ActionState {
  ok: boolean;
  error?: string;
  message?: string;
}

// A single-button server action with pending + result feedback. Used for the console's discrete
// levers (activate a workflow, replay dead letters) where there is nothing to fill in — only a
// decision to confirm. `confirm` adds a native confirmation for the destructive direction, so
// deactivating automation can't happen on a stray click.
export function ActionButton({
  label,
  pendingLabel,
  action,
  variant = "ghost",
  confirm,
  disabled,
}: {
  label: string;
  pendingLabel?: string;
  action: (prev: ActionState | null, formData: FormData) => Promise<ActionState>;
  variant?: "solid" | "ghost";
  confirm?: string;
  disabled?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, null);

  return (
    <form
      action={formAction}
      style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      <Button type="submit" size="sm" variant={variant} disabled={pending || disabled}>
        {pending ? (pendingLabel ?? "Working…") : label}
      </Button>
      {state?.error && <Toast message={state.error} />}
      {state?.ok && state.message && <Toast message={state.message} />}
    </form>
  );
}
