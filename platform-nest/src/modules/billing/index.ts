// Billing / invoicing module contract (WSA-2). Routes live in BillingController (mounted at
// /api/:tenantId/invoices*, gated by ModuleEnabledGuard("billing")). Invoices are computed
// from billable time_entries (CORE) on a client's projects and frozen at creation.
import type { ModuleContract } from "../contract";

export const billingModule: ModuleContract = {
  key: "billing",
  migrations: ["0021_invoices.sql"],
  // IAM-01d migration: all 3 CLEAN — pure colon-to-dot renames (billing.invoice.delete also exists
  // in the catalog, undeclared here — module declarations are a partial subset by design).
  // IAM-GAP-01 (2026-08-13): added `billing.invoice.approve` — the maker/checker seam. Approver
  // must not be the invoice's own creator (resource_invoice.yaml); see migration 0107.
  permissions: [
    { key: "billing.invoice.read", description: "View invoices" },
    { key: "billing.invoice.create", description: "Generate invoices" },
    { key: "billing.invoice.update", description: "Transition invoice status" },
    { key: "billing.invoice.approve", description: "Approve an invoice (maker/checker: not its own creator)" },
  ],
  customFieldTargets: [],
  mcpTools: [
    {
      name: "billing.listInvoices",
      description: "List the tenant's invoices with status and totals",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/invoices",
      inputSchema: { type: "object", properties: { tenantId: { type: "string" } }, required: ["tenantId"] },
    },
  ],
  rollupProviders: [],
  uiManifest: [{ label: "Billing", path: "/billing" }],
  // routes: served by BillingController (src/modules/billing/billing.controller.ts).
};
