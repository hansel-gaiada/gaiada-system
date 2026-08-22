"use server";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { can } from "./rbac";
import { deleteClient } from "./entities";

export interface BulkResult { ok: boolean; error?: string; succeeded?: number }

// Orchestration over the EXISTING single-row delete (`deleteClient`, the same
// `DELETE /api/:t/clients/:id` `deleteClientAction` already calls from the client detail page) —
// no new backend endpoint, per the component inventory's own note on BulkActionBar: "server
// actions underneath per row already exist for most single-row operations, so this is
// orchestration, not new writes." Deliberately does NOT reuse `deleteClientAction` itself: that
// function redirects on success, which is correct for a single form submit but wrong here — a
// bulk caller needs a `{ok, succeeded}` result back, not a navigation.
export async function bulkDeleteClientsAction(ids: string[]): Promise<BulkResult> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { ok: false, error: "Select a company first." };
  if (!can(me, "pm.manage", tenant)) return { ok: false, error: "You don't have permission to delete clients." };

  let succeeded = 0;
  const failures: string[] = [];
  for (const id of ids) {
    try {
      await deleteClient(userId, tenant, id);
      succeeded += 1;
    } catch (e) {
      failures.push(e instanceof PlatformError ? e.message : "unexpected error");
    }
  }

  revalidatePath("/clients");
  if (failures.length === 0) return { ok: true, succeeded };
  if (succeeded === 0) return { ok: false, error: `Delete failed for all ${ids.length} selected client${ids.length === 1 ? "" : "s"}: ${failures[0]}` };
  return { ok: false, error: `Deleted ${succeeded} of ${ids.length} — ${failures.length} failed: ${failures[0]}` };
}
