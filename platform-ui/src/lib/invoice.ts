import "server-only";
// Invoicing — turns billable time into invoices. Backend TODO (see
// docs/FRONTEND-BFF-CONTRACT.md); degrades gracefully like the other lib layers.
// Contract:
//   GET  /api/:t/invoices                 -> Invoice[]
//   GET  /api/:t/invoices/:id             -> Invoice
//   POST /api/:t/invoices  {clientId,periodStart,periodEnd,rate,currency} -> { id }
//   PATCH/api/:t/invoices/:id  {status}   -> { ok }
// The backend computes line items from billable time in the period (the demo
// store approximates this). Finance capability (company.manage) only.
//
// IAM-GAP-01/IAM-GAP-02 (2026-08-13, UI landed 2026-09-02) — the maker/checker seam:
//   POST /api/:t/invoices/:invoiceId/approve  -> { ok, status: "approved" }
// `draft -> approved` ONLY; requires `invoice.approve` (mirrored in lib/rbac.ts, company_admin/
// manager) and the invoice's OWN creator can never be its own approver (Cerbos denies this
// structurally for EVERY tier, platform_admin included — see resource_invoice.yaml). `status`
// PATCH above can no longer reach 'sent'/'paid' unless the invoice is already 'approved'; 'approved'
// itself is reachable ONLY through this endpoint. The GET/list shape carries `createdBy`/
// `approvedBy`/`approvedAt`/`updatedBy` (raw user ids — no name join on the backend; the invoice
// detail page resolves them against the member list itself, degrading to the raw id).
import { platformFetch, PlatformError } from "./platform";

export type InvoiceStatus = "draft" | "approved" | "sent" | "paid" | "void";
export interface InvoiceLine { description: string; hours: number; rate: number; amount: number }
export interface Invoice {
  id: string;
  clientId: string | null;
  clientName: string;
  periodStart: string | null;
  periodEnd: string | null;
  status: InvoiceStatus;
  currency: string;
  total: number;
  lines: InvoiceLine[];
  createdAt: string | null;
  createdBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  updatedBy: string | null;
}

async function skip<T>(p: Promise<T>, fallback: T): Promise<T> {
  try { return await p; } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 403)) return fallback;
    throw e;
  }
}

// CC-1: optional `clientId` (uuid, or `"internal"` for invoices with no client). Omitted is unchanged.
export const listInvoices = (u: string, t: string, clientId?: string) =>
  skip(platformFetch<Invoice[]>(`/api/${t}/invoices${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ""}`, u), [] as Invoice[]);
export const getInvoice = (u: string, t: string, id: string) =>
  skip(platformFetch<Invoice | null>(`/api/${t}/invoices/${id}`, u), null);
export const createInvoice = (u: string, t: string, body: { clientId: string; periodStart: string; periodEnd: string; rate: number; currency: string }) =>
  platformFetch<{ id: string }>(`/api/${t}/invoices`, u, { method: "POST", body: JSON.stringify(body) });
export const setInvoiceStatus = (u: string, t: string, id: string, status: InvoiceStatus) =>
  platformFetch<{ ok: true }>(`/api/${t}/invoices/${id}`, u, { method: "PATCH", body: JSON.stringify({ status }) });
// IAM-GAP-01 — the maker/checker seam's own endpoint. NOT `setInvoiceStatus({status:"approved"})`:
// the backend's PATCH deliberately rejects 'approved' as an input value (see invoice.controller.ts's
// STATUSES set) — this is the ONLY door into 'approved'. No body; the server reads the resource's
// own `created_by` and runs the creator!=approver check itself, never trusting anything the caller
// could pass. Left uncaught here (no `skip`) so callers see the real 400/403/404 — the approve
// action in invoiceActions.ts is what turns those into an honest, specific message.
export const approveInvoice = (u: string, t: string, id: string) =>
  platformFetch<{ ok: true; status: "approved" }>(`/api/${t}/invoices/${id}/approve`, u, { method: "POST" });
