"use server";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { setWorkflowActive, replayBridgeStream } from "@/lib/admin";

export interface AutomationActionState {
  ok: boolean;
  error?: string;
  message?: string;
}

// Activate/deactivate one workflow. The backend gates this to platform-admin/owner (narrower than
// the read-only canvas) because deactivating silently stops business automation.
export async function toggleWorkflow(
  workflowId: string,
  activate: boolean,
  _prev: AutomationActionState | null,
  _formData: FormData,
): Promise<AutomationActionState> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired — sign in again." };

  const me = await getMe(userId);
  const res = await setWorkflowActive(userId, me, workflowId, activate);
  if (!res.ok) return { ok: false, error: res.error };

  revalidatePath("/systems/automation");
  // Report n8n's own resulting state rather than assuming the requested one took effect.
  return { ok: true, message: res.active ? "Workflow activated." : "Workflow deactivated." };
}

// Re-deliver a stream's dead-lettered events so the workflows they trigger run again.
export async function replayDeadLetters(
  entityType: string,
  _prev: AutomationActionState | null,
  _formData: FormData,
): Promise<AutomationActionState> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired — sign in again." };

  const me = await getMe(userId);
  const res = await replayBridgeStream(userId, me, entityType);
  if (!res.ok) return { ok: false, error: res.error };

  revalidatePath("/systems/automation");
  const replayed = res.replayed ?? 0;
  return {
    ok: true,
    message:
      replayed === 0
        ? "Nothing to replay — this stream has no dead-lettered events."
        : `Requeued ${replayed} event${replayed === 1 ? "" : "s"}${res.remaining ? ` (${res.remaining} still parked)` : ""}.`,
  };
}
