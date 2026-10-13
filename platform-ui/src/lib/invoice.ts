import "server-only";
// Invoicing — turns billable time into invoices. Backend TODO (see
// docs/FRONTEND-BFF-CONTRACT.md); degrades gracefully like the other lib layers.
// Contract:
//   GET  /api/:t/invoices                 -> Invoice[]
//   GET  /api/:t/invoices/:id             -> Invoice
//   POST /api/:t/invoices  {clientId,periodStart,periodEnd,rate,currency} -> { id }
//   PATCH/api/:t/invoices/:id  {status}   -> { ok }        draft|void only (PV5-04; an ISSUED invoice: 409)
//   GET  /api/:t/invoices/:id/issue-readiness -> { ready, issued, invoiceNo, blockers: [{code,message}] }
//   POST /api/:t/invoices/:id/issue       -> the issued invoice (number, dates, totals), or 409 { reason:
//                                            "issue_blocked", blockers } with nothing written (PV5-04, PV-D7)
//   POST /api/:t/invoices/:id/void {reason} -> { creditNoteId, alreadyVoid? } for an ISSUED invoice; 409 { reason:
//                                            not_issued | not_voidable | pending_payment | ... } (PV5-04, PV5-09)
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
  /** PV3-07: computed by the backend from the portal's own predicates. True when a client-wide contact of
   *  this row's client can read it in the portal; a project-scoped contact may see less. Optional because
   *  an older server omits it. Never derive it in the browser (BFF §22d). */
  clientVisible?: boolean;
  /** PV5-04: the invoice of record. All null until the invoice is ISSUED (shown as "Issued"; status `sent`). Optional
   *  because an older server omits them. */
  invoiceNo?: string | null;
  issuedAt?: string | null;
  issueDate?: string | null;
  dueDate?: string | null;
  subtotal?: number | null;
  taxTotal?: number | null;
  taxCode?: string | null;
  /** PV5-04: who issued it, the issuer as FROZEN when it was issued (never today's profile), and the ledger invoice behind
   *  it. `legacyUnissued` marks a sent/paid row from before PV-5: it has no number and no snapshot. */
  issuedBy?: string | null;
  issuer?: InvoiceIssuer | null;
  arInvoiceId?: string | null;
  legacyUnissued?: boolean;
  /** PV5-07: the stored PDF of an issued invoice, rendered once after the commit. Absent (an older server) and null (not
   *  rendered yet) read alike: an issued invoice says "being prepared", any other says nothing (lib/billingView.ts). */
  pdfFileId?: string | null;
}

/** PV5-04: the issuer block frozen on an invoice at issue (decision 5). The bank block is where the client pays. */
export interface InvoiceIssuer {
  legalName: string | null;
  address: string | null;
  npwp: string | null;
  isPkp: boolean | null;
  bank: { name: string | null; accountName: string | null; accountNo: string | null } | null;
}

/** PV5-04: one reason an invoice cannot be issued yet (stable `code`, human `message`). */
export interface IssueBlocker { code: string; message: string }
export interface IssueReadiness { invoiceId: string; status: string; issued: boolean; invoiceNo: string | null; ready: boolean; blockers: IssueBlocker[] }

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
// PV5-04: `draft` and `void` only. `sent` is reached by issueInvoice(), and `paid` follows from confirmed payments.
export const setInvoiceStatus = (u: string, t: string, id: string, status: "draft" | "void") =>
  platformFetch<{ ok: true }>(`/api/${t}/invoices/${id}`, u, { method: "PATCH", body: JSON.stringify({ status }) });
export const getIssueReadiness = (u: string, t: string, id: string) =>
  skip(platformFetch<IssueReadiness | null>(`/api/${t}/invoices/${id}/issue-readiness`, u), null);
// Left uncaught (no `skip`): the 409 carries the blocker list, which issueInvoiceAction turns into the list it shows.
export const issueInvoice = (u: string, t: string, id: string) =>
  platformFetch<{ id: string; invoiceNo: string; alreadyIssued: boolean }>(`/api/${t}/invoices/${id}/issue`, u, { method: "POST" });
// IAM-GAP-01 — the maker/checker seam's own endpoint. NOT `setInvoiceStatus({status:"approved"})`:
// the backend's PATCH deliberately rejects 'approved' as an input value (see invoice.controller.ts's
// STATUSES set) — this is the ONLY door into 'approved'. No body; the server reads the resource's
// own `created_by` and runs the creator!=approver check itself, never trusting anything the caller
// could pass. Left uncaught here (no `skip`) so callers see the real 400/403/404 — the approve
// action in invoiceActions.ts is what turns those into an honest, specific message.
export const approveInvoice = (u: string, t: string, id: string) =>
  platformFetch<{ ok: true; status: "approved" }>(`/api/${t}/invoices/${id}/approve`, u, { method: "POST" });
// PV5-04/PV5-09: void an ISSUED invoice (a full credit note is posted and both rows read `void`). Left uncaught (no
// `skip`): the 409's `reason` (not_issued, not_voidable, pending_payment, ...) is what voidInvoiceAction puts in words.
export const voidInvoice = (u: string, t: string, id: string, reason: string) =>
  platformFetch<{ creditNoteId?: string; alreadyVoid?: boolean }>(`/api/${t}/invoices/${id}/void`, u, {
    method: "POST", body: JSON.stringify({ reason }),
  });
