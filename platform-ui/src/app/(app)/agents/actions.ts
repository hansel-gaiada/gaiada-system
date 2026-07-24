"use server";
// Server Actions for the /agents console (B4, doc §3.4). Thin wrappers that
// pull session/company context and hand off to the testable core in
// lib/admin.ts — mirrors the systems/bot/actions.ts + lib/hrActions.ts `ctx()`
// convention used elsewhere in this app.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { triggerAgentGoal as triggerAgentGoalCore, type AgentActionState } from "@/lib/admin";

export async function triggerAgentGoal(
  _prev: AgentActionState | null,
  formData: FormData,
): Promise<AgentActionState> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired — sign in again." };

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { ok: false, error: "No active company selected." };

  const goal = String(formData.get("goal") ?? "");
  const agentRaw = String(formData.get("agent") ?? "").trim();

  const result = await triggerAgentGoalCore(userId, tenant, me, {
    goal,
    agent: agentRaw || undefined,
  });

  if (result.ok) {
    revalidatePath("/agents");
    if (result.id) revalidatePath(`/agents/goals/${result.id}`);
  }
  return result;
}
