import "server-only";
// Billing / invoicing — turns billable time into invoices. Backend TODO (see
// docs/FRONTEND-BFF-CONTRACT.md); degrades gracefully like the other lib layers.
// Contract:
//   GET  /api/:t/invoices                 -> Invoice[]
//   GET  /api/:t/invoices/:id             -> Invoice
//   POST /api/:t/invoices  {clientId,periodStart,periodEnd,rate,currency} -> { id }
//   PATCH/api/:t/invoices/:id  {status}   -> { ok }
// The backend computes line items from billable time in the period (the demo
// store approximates this). Finance capability (company.manage) only.
import { platformFetch, PlatformError } from "./platform";

export type InvoiceStatus = "draft" | "sent" | "paid" | "void";
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
}

async function skip<T>(p: Promise<T>, fallback: T): Promise<T> {
  try { return await p; } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 403)) return fallback;
    throw e;
  }
}

export const listInvoices = (u: string, t: string) =>
  skip(platformFetch<Invoice[]>(`/api/${t}/invoices`, u), [] as Invoice[]);
export const getInvoice = (u: string, t: string, id: string) =>
  skip(platformFetch<Invoice | null>(`/api/${t}/invoices/${id}`, u), null);
export const createInvoice = (u: string, t: string, body: { clientId: string; periodStart: string; periodEnd: string; rate: number; currency: string }) =>
  platformFetch<{ id: string }>(`/api/${t}/invoices`, u, { method: "POST", body: JSON.stringify(body) });
export const setInvoiceStatus = (u: string, t: string, id: string, status: InvoiceStatus) =>
  platformFetch<{ ok: true }>(`/api/${t}/invoices/${id}`, u, { method: "PATCH", body: JSON.stringify({ status }) });
