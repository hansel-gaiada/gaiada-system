// Finance & Accounting module contract.
//
// The APPLICATION layer over the finance foundation built in migrations 202608241010..1028
// (F0 foundations · F1 ledger · F2 posting rules · F3 statements · F4 AR · F5 AP · F6 bank/close
// · F7 tax). Design: docs/blueprints/finance-accounting-foundation.md.
//
// ── WHAT THIS MODULE DOES AND DOES NOT DO ───────────────────────────────────────────────────────
// The accounting itself lives in SQL — balance validation, immutability, the hash chain, the
// subledger tie-outs, the statements. That is deliberate and it is not laziness: those are
// invariants, and an invariant enforced in a service layer is an invariant a script can walk past.
//
// So this module is THIN on purpose. It authorizes, it scopes, it shapes JSON. It computes no
// accounting. If a handler here ever starts doing arithmetic on money, that arithmetic belongs in
// the database next to the constraint that guards it.
//
// ── THE MODULE SCOPE IS LOAD-BEARING ────────────────────────────────────────────────────────────
// Every finance_* table carries the third wall:
//   tenant_id = ANY(app_current_tenants()) AND app_module_allowed('finance')
// A handler that calls withTenants() WITHOUT { modules: ["finance"] } reads and writes ZERO rows
// and gets NO error. That silence is why `withFinance()` in finance.controller.ts is the only way
// this module touches the database.
import type { ModuleContract } from "../contract";

export const financeModule: ModuleContract = {
  key: "finance",
  migrations: [
    "202608241010_finance_ownership_and_scope.sql",
    "202608241011_finance_coa_and_dimensions.sql",
    "202608241012_finance_fiscal_calendar_and_currency.sql",
    "202608241013_finance_sod_and_elevation.sql",
    "202608241014_iam_finance_f0_permissions.sql",
    "202608241015_finance_ledger_core.sql",
    "202608241016_iam_finance_f1_ledger_permissions.sql",
    "202608241017_finance_statements.sql",
    "202608241018_iam_finance_f3_statement_permissions.sql",
    "202608241019_finance_ar_subledger.sql",
    "202608241020_iam_finance_f4_ar_permissions.sql",
    "202608241021_finance_ap_subledger.sql",
    "202608241022_iam_finance_f5_ap_permissions.sql",
    "202608241023_finance_bank_and_close.sql",
    "202608241024_iam_finance_f6_bank_permissions.sql",
    "202608241025_finance_tax_and_returns.sql",
    "202608241026_iam_finance_f7_tax_permissions.sql",
    "202608241027_finance_posting_rules.sql",
    "202608241028_iam_finance_f2_posting_rule_permissions.sql",
  ],

  // Only what this module's own surface actually authorizes on. `validateModulePermissions()`
  // fails boot if any of these is not a `class='grantable'` catalog row, which is the point.
  permissions: [
    { key: "finance.config.read", description: "View the chart of accounts, dimensions and fiscal calendar" },
    { key: "finance.config.create", description: "Create accounts, dimensions and fiscal periods" },
    { key: "finance.config.update", description: "Edit the accounting vocabulary" },
    { key: "finance.period.read", description: "View fiscal period state" },
    { key: "finance.period.lock", description: "Soft-lock a fiscal period" },
    { key: "finance.period.close", description: "Hard-close a fiscal period (irreversible)" },
    { key: "finance.period.reopen", description: "Reopen a soft-locked period" },
    { key: "finance.ledger.read", description: "Read journal entries and lines" },
    { key: "finance.ledger.post", description: "Post a journal entry" },
    { key: "finance.ledger.reverse", description: "Reverse a posted journal" },
    { key: "finance.ledger.verify", description: "Run the ledger chain integrity check" },
    { key: "finance.statement.read", description: "View trial balance, P&L and balance sheet" },
    { key: "finance.ar.read", description: "View receivables and the aging schedule" },
    { key: "finance.ar.reconcile", description: "Run the AR subledger reconciliation" },
    { key: "finance.ap.read", description: "View payables and the aging schedule" },
    { key: "finance.ap.reconcile", description: "Run the AP subledger reconciliation" },
    { key: "finance.bank.read", description: "View bank statements and match state" },
    { key: "finance.bank.reconcile", description: "Run bank reconciliation and close readiness" },
    { key: "finance.tax.read", description: "View tax summaries and e-Faktur exceptions" },
    { key: "finance.posting_rule.read", description: "View posting rules and the finance event queue" },
    { key: "finance.posting_rule.process", description: "Process queued finance events" },
  ],

  customFieldTargets: [],

  // ── MCP: READ-ONLY THIS WAVE, DELIBERATELY ────────────────────────────────────────────────────
  // Every tool below is a GET. An agent may LOOK at the books — the trial balance, the aging, what
  // is blocking the close — and that is genuinely useful: "why can't we close January" is exactly
  // the question worth asking an assistant.
  //
  // No tool posts a journal, and that is not caution for its own sake. A write tool here would be
  // an agent-initiated accounting entry, which under D14 must be a PROPOSAL a human approves — and
  // the approval surface for finance does not exist yet. Shipping the write tool first would put
  // the estate one mis-parsed instruction away from a posted journal nobody asked for.
  mcpTools: [
    {
      name: "finance.trialBalance",
      description: "Trial balance for a company as at a date — account, debit, credit, balance",
      minAssurance: "verified",
      method: "GET",
      pathTemplate: "/api/:tenantId/finance/trial-balance",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, asOf: { type: "string" } },
        required: ["tenantId"],
      },
    },
    {
      name: "finance.profitAndLoss",
      description: "Profit and loss for a company over a period, by section",
      minAssurance: "verified",
      method: "GET",
      pathTemplate: "/api/:tenantId/finance/profit-and-loss",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, from: { type: "string" }, to: { type: "string" } },
        required: ["tenantId", "from", "to"],
      },
    },
    {
      name: "finance.balanceSheet",
      description: "Balance sheet as at a date, including the A = L + E check",
      minAssurance: "verified",
      method: "GET",
      pathTemplate: "/api/:tenantId/finance/balance-sheet",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, asOf: { type: "string" }, fyStart: { type: "string" } },
        required: ["tenantId", "asOf", "fyStart"],
      },
    },
    {
      name: "finance.arAging",
      description: "Accounts receivable aging by customer — current / 30 / 60 / 90 / 90+",
      minAssurance: "verified",
      method: "GET",
      pathTemplate: "/api/:tenantId/finance/ar/aging",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, asOf: { type: "string" } },
        required: ["tenantId"],
      },
    },
    {
      name: "finance.apAging",
      description: "Accounts payable aging by vendor — what the company owes and when",
      minAssurance: "verified",
      method: "GET",
      pathTemplate: "/api/:tenantId/finance/ap/aging",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, asOf: { type: "string" } },
        required: ["tenantId"],
      },
    },
    {
      name: "finance.closeReadiness",
      description: "Why a fiscal period cannot be closed — one row per blocker, empty means ready",
      minAssurance: "verified",
      method: "GET",
      pathTemplate: "/api/:tenantId/finance/periods/:periodId/close-readiness",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, periodId: { type: "string" } },
        required: ["tenantId", "periodId"],
      },
    },
  ],

  // Rollups deliberately empty this wave. A finance metric that reached the group dashboard would
  // be a cross-company money figure, and blueprint §10.3a is explicit that a naive sum of companies
  // DOUBLE-COUNTS intercompany and must never be presented as a group total. That needs F9's
  // elimination engine, not a rollup provider.
  rollupProviders: [],

  uiManifest: [{ label: "Finance", path: "/finance" }],
};
