"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionUserId } from "./session-server";
import { getMe, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { can, isElevated } from "./rbac";
import { createInvoice, approveInvoice, issueInvoice, type IssueBlocker } from "./invoice";

export interface InvoiceFormState { error?: string }
// Shared shape for the status-transition actions below (approve/mark-sent/mark-paid), driven by
// useActionState from a client component so a refusal renders as a real message next to the
// button that produced it — never a silent no-op.
export interface InvoiceActionState { error?: string; ok?: boolean; blockers?: IssueBlocker[] }

async function ctx() {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." } as const;
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "Select a company first." } as const;
  if (!can(me, "company.manage", tenant) && !isElevated(me)) return { error: "Invoicing is limited to finance administrators." } as const;
  return { userId, tenant } as const;
}

export async function createInvoiceAction(_prev: InvoiceFormState | null, formData: FormData): Promise<InvoiceFormState> {
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
  revalidatePath("/invoices");
  redirect(`/invoices/${id}`);
}

// PV5-04 (PV-D7): "mark as sent" and "mark paid" are gone. An approved invoice is ISSUED: numbered, posted to the
// ledger and frozen in one step on the server. Paid follows from confirmed payments, never from a button. A refusal
// carries every blocker (no billing profile, finance module off, no open period, PKP unknown on a taxed invoice, ...),
// which is returned here so the button can list them instead of failing one reason at a time.
export async function issueInvoiceAction(invoiceId: string, _prev: InvoiceActionState | null, _formData?: FormData): Promise<InvoiceActionState> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "Select a company first." };
  try {
    await issueInvoice(userId, tenant, invoiceId);
  } catch (e) {
    if (e instanceof PlatformError) {
      if (e.status === 403) return { error: "Issuing invoices is limited to company administrators, managers and owners." };
      const blockers = (e.body as { blockers?: IssueBlocker[] } | undefined)?.blockers;
      if (e.status === 409 && Array.isArray(blockers) && blockers.length > 0) {
        return { error: "This invoice can't be issued yet:", blockers };
      }
      return { error: e.message };
    }
    throw e;
  }
  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath("/invoices");
  return { ok: true };
}

// IAM-GAP-01 — separate gate from `ctx()` above: approving is `invoice.approve` (company_admin/
// manager), not the wider `company.manage` tier createInvoiceAction uses. Reusing `ctx()` would
// show the Approve control to an `owner` grant, which `company.manage` covers but `invoice.approve` structurally does not (see rbac.ts's capability comment) — a dead
// button Cerbos would always 403.
async function approveCtx() {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." } as const;
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "Select a company first." } as const;
  if (!can(me, "invoice.approve", tenant) && !isElevated(me)) {
    return { error: "Approving invoices is limited to managers and company administrators." } as const;
  }
  return { userId, tenant } as const;
}

// IAM-GAP-01/02 — the maker/checker seam's own action. The 403 case is the one this ticket calls
// out by name: Cerbos denies creator===approver structurally, for every tier, so a company_admin or
// manager who raised the invoice sees a clear, honest refusal here — never a crash, never a bare
// "Forbidden". The invoice page ALSO pre-empts this by hiding the button entirely when the viewer is
// the invoice's own createdBy; this catch is the fallback for the race the page can't see (role
// changed, or a second tab) and for a legacy invoice with no recorded creator (fails closed server-
// side for company_admin/manager — only platform_admin's wildcard can still reach those).
export async function approveInvoiceAction(invoiceId: string, _prev: InvoiceActionState | null, _formData?: FormData): Promise<InvoiceActionState> {
  const c = await approveCtx();
  if ("error" in c) return { error: c.error };
  try {
    await approveInvoice(c.userId, c.tenant, invoiceId);
  } catch (e) {
    if (e instanceof PlatformError) {
      if (e.status === 403) {
        return { error: "You raised this invoice — a different approver must sign off before it can move forward." };
      }
      if (e.status === 404) {
        return { error: "That invoice could not be found — it may have been removed." };
      }
      return { error: e.message };
    }
    throw e;
  }
  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath("/invoices");
  return { ok: true };
}
