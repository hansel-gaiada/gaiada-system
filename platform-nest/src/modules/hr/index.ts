// HR module contract (WSD-4, ex-ORG-11; docs/superpowers/specs/2026-07-20-hr-module-design.md §4).
// The ROUTES live in HrController; this object carries the registry/rollup metadata (rollupProviders,
// permissions, customFieldTargets, mcpTools, migrations, uiManifest, eventHandlers) that the engine +
// registry + hub tool-def aggregation consume — same split as agencyModule/index.ts.
//
// Every rollupProvider.compute() below runs under `withTenants([tenantId], fn, {modules:['hr']})`
// (rollups/engine.ts's per-module invocation, WSD-4) — the third wall (app_module_allowed('hr'),
// WSD-3) is open for the duration of the call, so plain SELECTs against hr_* tables just work.
import type { ModuleContract, RollupProvider } from "../contract";
import type { OutboxEvent } from "../../events/types";
import { applyLeaveDecision } from "./leave-decision";
import { applyLoanDecision } from "./loan-decision";
import { instantiateDefaultOnboarding } from "./checklists";

/**
 * `eventHandlers` is keyed BY EVENT TYPE, so the module gets exactly one handler for
 * `automation_approval.decided` — and hr now files two kinds of approval (leave, and loans since
 * wave E). This dispatcher fans the single event out to both appliers rather than either one
 * silently winning. Each applier re-checks `origin === 'hr'` and its own id field, so a decision for
 * the other kind (or any non-hr origin) is a cheap no-op there; running them in sequence rather than
 * in parallel keeps the ordering deterministic if a payload ever carries both.
 */
async function applyHrApprovalDecision(event: OutboxEvent): Promise<void> {
  await applyLeaveDecision(event);
  await applyLoanDecision(event);
}

const hrRollups: RollupProvider = {
  metrics: [
    { metricKey: "hr.open_cases", description: "Open HR cases (onboarding|offboarding|review|grievance|other)", unit: "count", isMonetary: false, aggregationRule: "sum" },
    { metricKey: "hr.leave_pending", description: "Leave requests awaiting a decision", unit: "count", isMonetary: false, aggregationRule: "sum" },
    { metricKey: "hr.onboarding_active", description: "Onboarding cases in progress", unit: "count", isMonetary: false, aggregationRule: "sum" },
  ],
  compute: async (client) => {
    const open = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM hr_cases WHERE deleted_at IS NULL AND status IN ('open','in_progress')`,
    );
    const leavePending = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM hr_leave_requests WHERE deleted_at IS NULL AND status = 'pending'`,
    );
    const onboarding = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM hr_cases WHERE deleted_at IS NULL AND kind = 'onboarding' AND status IN ('open','in_progress')`,
    );
    return [
      { metricKey: "hr.open_cases", numerator: Number(open.rows[0].n) },
      { metricKey: "hr.leave_pending", numerator: Number(leavePending.rows[0].n) },
      { metricKey: "hr.onboarding_active", numerator: Number(onboarding.rows[0].n) },
    ];
  },
};

export const hrModule: ModuleContract = {
  key: "hr",
  migrations: ["0028_module_hr.sql", "0081_hr_loans.sql"],
  // IAM-01d migration (§7): `case:read`/`record:read`/`record:export` CLEAN; `case:write` and
  // `record:write` bundles expand to their create/update pair. The other 5 declared keys were
  // ALIAS, each mapping onto a permission already covered above or onto a core permission outside
  // this module's own domain, and are DROPPED per the catalog's recommendation rather than
  // redeclared:
  //   - hr:leave:file   -> hr.case.create (leave is an hr_case type; already covered)
  //   - hr:leave:decide -> core.automation_approval.decide (module=hr routing rule in policy)
  //   - hr:loan:request -> hr.case.create (already covered)
  //   - hr:loan:decide  -> core.automation_approval.decide (same as leave:decide)
  //   - hr:loan:repay   -> hr.case.{create,update} (already covered)
  // "File leave" / "request loan" / "decide" / "repay" become UI-only permission groups
  // (IAM-01b-3) over these fine-grained permissions, not distinct module declarations.
  permissions: [
    { key: "hr.case.read", description: "View HR cases (onboarding/offboarding/review/grievance/other)" },
    { key: "hr.case.create", description: "Create HR cases (incl. leave/loan requests)" },
    { key: "hr.case.update", description: "Update HR cases (incl. loan repayments)" },
    { key: "hr.record.read", description: "View HR records (contract/document/note)" },
    { key: "hr.record.create", description: "Create HR records" },
    { key: "hr.record.update", description: "Update HR records" },
    { key: "hr.record.export", description: "Bulk-export HR records (high assurance only)" },
  ],
  customFieldTargets: ["hr_case", "hr_record"],
  mcpTools: [
    {
      name: "hr.listCases",
      description: "List the served company's HR cases",
      minAssurance: "verified",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/hr/cases",
      inputSchema: { type: "object", properties: { tenantId: { type: "string" } }, required: ["tenantId"] },
    },
    {
      name: "hr.listLeave",
      description: "List leave requests for the served company",
      minAssurance: "verified",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/hr/leave",
      inputSchema: { type: "object", properties: { tenantId: { type: "string" } }, required: ["tenantId"] },
    },
    {
      name: "hr.fileLeave",
      description: "File a leave request for a subject (D14 medium-impact automation write)",
      minAssurance: "verified",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/hr/leave",
      write: true,
      impact: "medium",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          subjectUserId: { type: "string" },
          leaveType: { type: "string" },
          startsOn: { type: "string" },
          endsOn: { type: "string" },
          minutes: { type: "number" },
        },
        required: ["tenantId", "subjectUserId", "leaveType", "startsOn", "endsOn", "minutes"],
      },
    },
    {
      name: "hr.listLoans",
      description: "List employee loans for the served company (staff see all; a member sees their own)",
      minAssurance: "verified",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/hr/loans",
      inputSchema: { type: "object", properties: { tenantId: { type: "string" } }, required: ["tenantId"] },
    },
    {
      name: "hr.requestLoan",
      // 'high' impact, unlike hr.fileLeave's 'medium': approving this one moves money, so D14
      // suspends it for a human decision on the unified approvals surface.
      description: "Request an employee loan for a subject (D14 high-impact automation write)",
      minAssurance: "verified",
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/hr/loans",
      write: true,
      impact: "high",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          subjectUserId: { type: "string" },
          principalAmount: { type: "number" },
          termMonths: { type: "number" },
          annualInterestRate: { type: "number" },
          currency: { type: "string" },
          purpose: { type: "string" },
        },
        required: ["tenantId", "subjectUserId", "principalAmount", "termMonths"],
      },
    },
  ],
  rollupProviders: [hrRollups],
  uiManifest: [
    { label: "HR Workspace", path: "/hr" },
    { label: "Leave", path: "/hr/leave" },
    { label: "Attendance", path: "/hr/attendance" },
    { label: "Onboarding", path: "/hr/onboarding" },
  ],
  eventHandlers: {
    // Unified approvals surface (UX-2): applies the human decision made via the EXISTING
    // /automation-approvals/:id/decide endpoint (core/automation-approvals.controller.ts) —
    // only for origin='hr' rows (the event carries the row's origin; every other origin's
    // decided event is a harmless no-op here).
    "automation_approval.decided": applyHrApprovalDecision,
    // Auto-instantiate the tenant's default onboarding checklist when a new user is invited
    // AND hr is enabled/served for that tenant (the consumer's isModuleEnabled gate, ex-ORG-11).
    "user.invited": instantiateDefaultOnboarding,
  },
  // routes: served by HrController in the NestJS port.
};
