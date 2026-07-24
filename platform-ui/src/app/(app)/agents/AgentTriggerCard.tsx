"use client";
import { useActionState } from "react";
import { Field } from "@/components/forms/Field";
import { Button, Toast } from "@/components/ui";
import type { AgentActionState } from "@/lib/admin";
import { triggerAgentGoal } from "./actions";

// Elevated-only trigger card (doc §3.4) — the parent server page only renders
// this for isElevated(me) callers; the real gate is nest's `isElevated` on
// POST /api/:t/agents/goals (this is cosmetic, defense-in-depth).
export function AgentTriggerCard({ agentOptions }: { agentOptions: string[] }) {
  const [state, formAction, pending] = useActionState<AgentActionState | null, FormData>(triggerAgentGoal, null);

  return (
    <form action={formAction} style={{ display: "grid", gap: 14 }}>
      <Field
        name="goal"
        label="Goal"
        type="textarea"
        placeholder="Describe the goal for the agent to pursue…"
        required
      />
      <Field name="agent" label="Agent" type="select" options={agentOptions} defaultValue="supervisor" />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Triggering…" : "Trigger goal"}
        </Button>
      </div>
      {state?.error && <Toast message={state.error} />}
      {state?.ok && <Toast message={`Goal queued${state.id ? ` (#${state.id.slice(0, 8)})` : ""}.`} />}
    </form>
  );
}
