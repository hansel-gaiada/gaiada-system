"use client";
import { useActionState } from "react";
import { Button, Card, StatusBadge, Toast } from "@/components/ui";
import type { GatewayBudget } from "@/lib/admin";
import "./systems.css";
import { formatTimestamp } from "@/lib/format";

export interface DrModeActionState {
  ok: boolean;
  error?: string;
  drMode?: boolean;
}

// WS9 D15 failover lever. Declaring DR mode RAISES the daily AI spend cap for a bounded window, so
// this is a blast-radius action, not a toggle: the consequence is stated inline, the duration is
// explicit, and enabling and resolving are separate buttons rather than one ambiguous switch.
export function DrModeCard({
  budget,
  drDurationMinutes,
  drBurstCap,
  action,
  canEdit,
}: {
  budget?: GatewayBudget;
  drDurationMinutes?: number;
  drBurstCap?: number;
  action: (prev: DrModeActionState | null, formData: FormData) => Promise<DrModeActionState>;
  canEdit: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  // The action's echoed value wins after a submit; before that, the server-rendered snapshot.
  const active = state?.drMode ?? budget?.drActive ?? false;

  return (
    <Card
      title="Disaster-recovery burst"
      headerRight={<StatusBadge label={active ? "DR mode active" : "Steady state"} />}
    >
      <p className="sys-empty-note">
        {active
          ? `A declared failover is raising the global daily cap by ${drBurstCap ?? "—"} calls` +
            (budget?.drUntil ? ` until ${formatTimestamp(budget.drUntil)}.` : ".")
          : `Declaring a failover adds a bounded ${drBurstCap ?? "—"}-call allowance on top of the daily cap for ` +
            `${drDurationMinutes ?? "—"} minutes, so a real outage doesn't instantly degrade AI to placeholders.`}
      </p>
      {canEdit ? (
        <form action={formAction} style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 14 }}>
          <input type="hidden" name="enable" value={active ? "false" : "true"} />
          <Button type="submit" size="sm" variant={active ? "ghost" : "solid"} disabled={pending}>
            {pending ? "Applying…" : active ? "Resolve failover" : "Declare failover"}
          </Button>
          {state?.error && <Toast message={state.error} />}
          {state?.ok && <Toast message={state.drMode ? "DR mode declared." : "DR mode resolved."} />}
        </form>
      ) : (
        <p className="sys-empty-note" style={{ marginTop: 12 }}>
          Declaring a failover requires platform-admin or owner access.
        </p>
      )}
    </Card>
  );
}
