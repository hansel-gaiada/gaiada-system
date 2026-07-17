"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionUserId } from "./session-server";
import { getMe, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { can, isElevated } from "./rbac";
import { createInvoice, setInvoiceStatus, type InvoiceStatus } from "./billing";

export interface BillingState { error?: string }

async function ctx() {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." } as const;
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "Select a company first." } as const;
  if (!can(me, "company.manage", tenant) && !isElevated(me)) return { error: "Billing is limited to finance administrators." } as const;
  return { userId, tenant } as const;
}

export async function createInvoiceAction(_prev: BillingState | null, formData: FormData): Promise<BillingState> {
  const c = await ctx();
  if ("error" in c) return { error: c.error };
  const clientId = String(formData.get("clientId") ?? "");
  if (!clientId) return { error: "Pick a client." };
  let id: string;
  try {
    id = (await createInvoice(c.userId, c.tenant, {
      clientId,
      periodStart: String(formData.get("periodStart") ?? ""),
      periodEnd: String(formData.get("periodEnd") ?? ""),
      rate: Number(formData.get("rate") ?? 0),
      currency: String(formData.get("currency") ?? "USD"),
    })).id;
  } catch (e) {
    if (e instanceof PlatformError) {
      if (e.status === 404 || e.status === 405) return { error: "Invoicing isn't available yet — the backend endpoint is pending." };
      return { error: e.message };
    }
    throw e;
  }
  revalidatePath("/billing");
  redirect(`/billing/${id}`);
}

async function setStatus(invoiceId: string, status: InvoiceStatus) {
  const c = await ctx();
  if ("error" in c) return;
  try { await setInvoiceStatus(c.userId, c.tenant, invoiceId, status); } catch (e) { if (!(e instanceof PlatformError)) throw e; }
  revalidatePath(`/billing/${invoiceId}`);
  revalidatePath("/billing");
}
export async function markInvoiceSent(invoiceId: string): Promise<void> { await setStatus(invoiceId, "sent"); }
export async function markInvoicePaid(invoiceId: string): Promise<void> { await setStatus(invoiceId, "paid"); }
