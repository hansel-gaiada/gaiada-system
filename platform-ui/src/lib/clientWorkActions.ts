"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionUserId } from "./session-server";
import { getMe, PlatformError, type Me } from "./platform";
import { getActiveTenant } from "./tenant";
import { can } from "./rbac";
import { createClient, deleteClient, createDeliverable, createTimeEntry } from "./entities";

export interface CWState { error?: string }

async function ctx(): Promise<{ userId: string; tenant: string; me: Me } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "Select a company first." };
  return { userId, tenant, me };
}

function pending(e: unknown): CWState {
  if (e instanceof PlatformError) {
    if (e.status === 404 || e.status === 405) return { error: "Not available yet — the backend endpoint is pending." };
    return { error: e.message };
  }
  throw e;
}

export async function createClientAction(_prev: CWState | null, formData: FormData): Promise<CWState> {
  const c = await ctx();
  if ("error" in c) return { error: c.error };
  if (!can(c.me, "pm.manage", c.tenant)) return { error: "You don't have permission to add clients." };
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Client name is required." };
  let id: string;
  try { id = (await createClient(c.userId, c.tenant, { name, status: String(formData.get("status") ?? "active") })).id; }
  catch (e) { return pending(e); }
  revalidatePath("/clients");
  redirect(`/clients/${id}`);
}

export async function deleteClientAction(clientId: string): Promise<CWState> {
  const c = await ctx();
  if ("error" in c) return { error: c.error };
  if (!can(c.me, "pm.manage", c.tenant)) return { error: "You don't have permission." };
  try { await deleteClient(c.userId, c.tenant, clientId); } catch (e) { return pending(e); }
  revalidatePath("/clients");
  redirect("/clients");
}

// Form-friendly void wrapper (form actions must return void).
export async function deleteClientForm(clientId: string): Promise<void> {
  await deleteClientAction(clientId);
}

export async function createDeliverableAction(_prev: CWState | null, formData: FormData): Promise<CWState> {
  const c = await ctx();
  if ("error" in c) return { error: c.error };
  if (!can(c.me, "pm.manage", c.tenant)) return { error: "You don't have permission to add deliverables." };
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Deliverable name is required." };
  try {
    await createDeliverable(c.userId, c.tenant, {
      name,
      projectId: String(formData.get("projectId") ?? "") || undefined,
      clientId: String(formData.get("clientId") ?? "") || undefined,
      dueDate: String(formData.get("dueDate") ?? "") || undefined,
    });
  } catch (e) { return pending(e); }
  revalidatePath("/deliverables");
  redirect("/deliverables");
}

export async function logTimeEntryAction(_prev: CWState | null, formData: FormData): Promise<CWState> {
  const c = await ctx();
  if ("error" in c) return { error: c.error };
  const minutes = Math.round(Number(formData.get("hours") ?? 0) * 60);
  if (!minutes || minutes <= 0) return { error: "Enter time in hours (e.g. 1.5)." };
  const projectId = String(formData.get("projectId") ?? "").trim();
  if (!projectId) return { error: "Pick a project — time is logged against a project." };
  try {
    await createTimeEntry(c.userId, c.tenant, {
      minutes,
      projectId,
      billable: formData.get("billable") === "on",
      entryDate: String(formData.get("entryDate") ?? "") || new Date().toISOString().slice(0, 10),
      notes: String(formData.get("notes") ?? ""),
    });
  } catch (e) { return pending(e); }
  revalidatePath("/timesheets");
  redirect("/timesheets");
}
