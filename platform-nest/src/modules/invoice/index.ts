// Invoice module contract (WSA-2). Routes live in InvoiceController (mounted at
// /api/:tenantId/invoices*, gated by ModuleEnabledGuard("invoice")). Invoices are computed
// from billable time_entries (CORE) on a client's projects and frozen at creation.
//
// ── RENAMED FROM `billing` (2026-08-26) ────────────────────────────────────────────────────────
// The module key, its permission prefix and its UI path all said "billing" while every route,
// table and Cerbos kind already said "invoice". The owner's framing settled which word is right:
// this module is for the OUTSIDE contract — Gaia Digital Agency and its clients — and what it
// produces is an invoice. "Billing" also collided with two unrelated senses already in the tree
// (a client's billing ADDRESS, and vendor billing in the search providers), so the word carried
// three meanings and disambiguated none of them.
//
// Permission keys are now TWO-part (`invoice.read`), not `invoice.invoice.read`. That follows the
// `portal.*` precedent, which is the other place in this catalog where the domain and the Cerbos
// kind are the same word.
import type { ModuleContract } from "../contract";

export const invoiceModule: ModuleContract = {
  key: "invoice",
  migrations: ["0021_invoices.sql"],
  // IAM-01d migration: all 3 CLEAN — pure colon-to-dot renames (invoice.delete also exists
  // in the catalog, undeclared here — module declarations are a partial subset by design).
  // IAM-GAP-01 (2026-08-13): added `invoice.approve` — the maker/checker seam. Approver
  // must not be the invoice's own creator (resource_invoice.yaml); see migration 0107.
  permissions: [
    { key: "invoice.read", description: "View invoices" },
    { key: "invoice.create", description: "Generate invoices" },
    { key: "invoice.update", description: "Transition invoice status" },
    { key: "invoice.approve", description: "Approve an invoice (maker/checker: not its own creator)" },
  ],
  customFieldTargets: [],
  mcpTools: [
    {
      name: "invoice.listInvoices",
      description: "List the tenant's invoices with status and totals",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/invoices",
      inputSchema: { type: "object", properties: { tenantId: { type: "string" } }, required: ["tenantId"] },
    },
  ],
  rollupProviders: [],
  uiManifest: [{ label: "Invoices", path: "/invoices" }],
  // routes: served by InvoiceController (src/modules/invoice/invoice.controller.ts).
};
