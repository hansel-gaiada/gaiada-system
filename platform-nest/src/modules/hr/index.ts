// HR module contract (WSD-4, ex-ORG-11; docs/superpowers/specs/2026-07-20-hr-module-design.md §4).
// The ROUTES live in HrController; this object carries the registry/rollup metadata (rollupProviders,
// permissions, customFieldTargets, mcpTools, migrations, uiManifest, eventHandlers) that the engine +
// registry + hub tool-def aggregation consume — same split as agencyModule/index.ts.
//
// Every rollupProvider.compute() below runs under `withTenants([tenantId], fn, {modules:['hr']})`
// (rollups/engine.ts's per-module invocation, WSD-4) — the third wall (app_module_allowed('hr'),
// WSD-3) is open for the duration of the call, so plain SELECTs against hr_* tables just work.
import type { ModuleContract, RollupProvider } from "../contract";
import { applyLeaveDecision } from "./leave-decision";
import { instantiateDefaultOnboarding } from "./checklists";

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
  migrations: ["0028_module_hr.sql"],
  permissions: [
    { key: "hr:case:read", description: "View HR cases (onboarding/offboarding/review/grievance/other)" },
    { key: "hr:case:write", description: "Create/update HR cases" },
    { key: "hr:leave:file", description: "File a leave request" },
    { key: "hr:leave:decide", description: "Approve/deny a leave request (unified approvals surface)" },
    { key: "hr:record:read", description: "View HR records (contract/document/note)" },
    { key: "hr:record:write", description: "Create/update HR records" },
    { key: "hr:record:export", description: "Bulk-export HR records (high assurance only)" },
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
    "automation_approval.decided": applyLeaveDecision,
    // Auto-instantiate the tenant's default onboarding checklist when a new user is invited
    // AND hr is enabled/served for that tenant (the consumer's isModuleEnabled gate, ex-ORG-11).
    "user.invited": instantiateDefaultOnboarding,
  },
  // routes: served by HrController in the NestJS port.
};
