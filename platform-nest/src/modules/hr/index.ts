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
    // HR-FULL (2026-08-24). These five are what the holding-level rollup can show WITHOUT reading a
    // single raw per-subject row — which is the whole point: the blueprint's constraint 3 says
    // cross-company HR reads go through rollups, never raw rows, and `hr_record`/`hr_payroll` are
    // closed to the holding tier by policy. An aggregate headcount and a turnover count are the
    // honest shape of "what the group can see about HR".
    { metricKey: "hr.headcount_active", description: "Active employees", unit: "count", isMonetary: false, aggregationRule: "sum" },
    { metricKey: "hr.open_requisitions", description: "Requisitions accepting applications", unit: "count", isMonetary: false, aggregationRule: "sum" },
    { metricKey: "hr.active_applications", description: "Applications in a live pipeline stage", unit: "count", isMonetary: false, aggregationRule: "sum" },
    { metricKey: "hr.documents_expiring_90d", description: "HR documents expiring within 90 days (incl. already expired)", unit: "count", isMonetary: false, aggregationRule: "sum" },
    { metricKey: "hr.reviews_overdue", description: "Review participants past their due date and not yet submitted", unit: "count", isMonetary: false, aggregationRule: "sum" },
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
    const headcount = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM employees WHERE deleted_at IS NULL AND employment_status = 'active'`,
    );
    const requisitions = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM hr_requisitions WHERE deleted_at IS NULL AND status = 'open'`,
    );
    const applications = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM hr_applications WHERE deleted_at IS NULL AND status IN ('active','on_hold')`,
    );
    const expiring = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM hr_records
        WHERE deleted_at IS NULL AND expires_on IS NOT NULL AND expires_on <= CURRENT_DATE + INTERVAL '90 days'`,
    );
    const overdueReviews = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM hr_review_participants
        WHERE due_on IS NOT NULL AND due_on < CURRENT_DATE AND status IN ('pending','in_progress')`,
    );
    return [
      { metricKey: "hr.open_cases", numerator: Number(open.rows[0].n) },
      { metricKey: "hr.leave_pending", numerator: Number(leavePending.rows[0].n) },
      { metricKey: "hr.onboarding_active", numerator: Number(onboarding.rows[0].n) },
      { metricKey: "hr.headcount_active", numerator: Number(headcount.rows[0].n) },
      { metricKey: "hr.open_requisitions", numerator: Number(requisitions.rows[0].n) },
      { metricKey: "hr.active_applications", numerator: Number(applications.rows[0].n) },
      { metricKey: "hr.documents_expiring_90d", numerator: Number(expiring.rows[0].n) },
      { metricKey: "hr.reviews_overdue", numerator: Number(overdueReviews.rows[0].n) },
    ];
  },
};

export const hrModule: ModuleContract = {
  key: "hr",
  migrations: [
    "0028_module_hr.sql", "0081_hr_loans.sql",
    // HR-FULL (2026-08-24) — the four department waves plus their IAM half.
    "202608240140_hr_time_and_lifecycle.sql",     // A: holidays, leave policy+accrual, job history, doc expiry, review cycles, case timeline
    "202608240141_hr_recruitment.sql",            // B: the ATS
    "202608240142_hr_compensation_benefits.sql",  // C: pay grades, effective-dated comp, allowances, BPJS, tax profiles
    "202608240143_hr_payroll.sql",                // D: statutory parameters, runs, payslips, separations
    "202608240144_iam_hr_full_permissions.sql",   // the 18 new permissions across 3 new Cerbos kinds
  ],
  // IAM-01d migration (§7): `case:read`/`record:read`/`record:export` CLEAN; `case:write` and
  // `record:write` bundles expand to their create/update pair. The other 5 declared keys were
  // ALIAS, each mapping onto a permission already covered above or onto a core permission outside
  // this module's own domain, and are DROPPED per the catalog's recommendation rather than
  // redeclared:
  //   - hr:leave:file   -> hr.case.create (leave is an hr_case type; already covered)
  //   - hr:leave:decide -> hr.leave.decide (IAM-GAP-01, 2026-08-13: split out of
  //       core.automation_approval.decide into its OWN dedicated decision right — see
  //       resource_automation_approval.yaml's `decide_leave` action and migration 0107. Loan
  //       decisions are UNCHANGED and still ride core.automation_approval.decide.)
  //   - hr:loan:request -> hr.case.create (already covered)
  //   - hr:loan:decide  -> core.automation_approval.decide (unchanged — only leave got its own key)
  //   - hr:loan:repay   -> hr.case.{create,update} (already covered)
  // "File leave" / "request loan" / "decide" / "repay" become UI-only permission groups
  // (IAM-01b-3) over these fine-grained permissions, not distinct module declarations.
  permissions: [
    { key: "hr.case.read", description: "View HR cases (onboarding/offboarding/review/grievance/other)" },
    { key: "hr.case.create", description: "Create HR cases (incl. leave/loan requests)" },
    { key: "hr.case.update", description: "Update HR cases (incl. loan repayments)" },
    { key: "hr.leave.decide", description: "Approve or reject a leave request (dedicated decision right)" },
    { key: "hr.record.read", description: "View HR records (contract/document/note)" },
    { key: "hr.record.create", description: "Create HR records" },
    { key: "hr.record.update", description: "Update HR records" },
    { key: "hr.record.export", description: "Bulk-export HR records (high assurance only)" },
    // ── HR-FULL (2026-08-24) — the three new Cerbos kinds. ROLE-ARM ONLY (no perm_* mirror); see
    //    migration 202608240144's header for why all three are deliberately un-mirrored.
    { key: "hr.policy.read", description: "Read HR configuration (holiday calendars, leave policies, review cycles, pay grades, statutory parameters)" },
    { key: "hr.policy.create", description: "Create HR configuration objects" },
    { key: "hr.policy.update", description: "Amend HR configuration objects" },
    { key: "hr.policy.delete", description: "Remove an HR configuration object" },
    { key: "hr.policy.ratify", description: "Sign off a statutory parameter set, unblocking payroll finalization against it (high assurance only)" },
    { key: "hr.recruitment.read", description: "Read requisitions, candidates, applications, interviews and scorecards" },
    { key: "hr.recruitment.create", description: "Create recruitment records, including filing a scorecard as a panelist" },
    { key: "hr.recruitment.update", description: "Advance an application, edit a requisition, reschedule an interview" },
    { key: "hr.recruitment.delete", description: "Delete recruitment records, including purging a candidate on an erasure request" },
    { key: "hr.recruitment.approve", description: "Approve a requisition or an offer (high assurance only)" },
    { key: "hr.recruitment.convert", description: "Convert an accepted offer into an employee record (high assurance only)" },
    { key: "hr.recruitment.export", description: "Bulk-export the candidate pool (high assurance only)" },
    { key: "hr.payroll.read", description: "Read compensation, benefits, payroll runs, payslips and separations" },
    { key: "hr.payroll.create", description: "Create compensation records, allowances, enrolments, payroll runs and separations" },
    { key: "hr.payroll.update", description: "Amend compensation, recalculate a payroll run, edit a separation" },
    { key: "hr.payroll.delete", description: "Delete or void payroll and compensation records" },
    { key: "hr.payroll.approve", description: "Approve a payroll run, compensation change or separation payout (high assurance only)" },
    { key: "hr.payroll.export", description: "Export the payroll register or bank file (high assurance only)" },
  ],
  customFieldTargets: ["hr_case", "hr_record", "hr_requisition", "hr_candidate"],
  mcpTools: [
    // ── P2-07 (partial): the EMPLOYEE READ surface, agent-reachable ──────────────────────────────
    //
    // The `hr` module declares these rather than some core surface because `employees` sits behind the
    // HR module's own RLS wall (`app_module_allowed('hr')`, 0109) — the module that gates the table is
    // the module that should own its tools.
    //
    // ── THE JML WRITES, closed-loop as of 2026-08-19 ─────────────────────────────────────────────
    // hire / transfer / terminate are declared BECAUSE their D14 executors now exist
    // (`registerJmlExecutableApprovals` in core/approval-executables.ts) AND the three names are in
    // `resource_mcp_tool.yaml`'s executable allow-list. All three are required: an entry without the
    // allow-list passes its precondition and is then denied at the hub door; a tool without an entry
    // suspends and then silently does nothing on approval. `hr-employee-tools.test.ts` asserts the
    // declared-implies-executor half so this cannot regress by half.
    //
    // Impact is `high` for terminate and `medium` for the other two, and that is a judgement worth
    // stating: terminate revokes grants, closes seats and can disable a login, and it is the one whose
    // blast radius does not shrink if it fires twice — the others converge. All three are gated behind
    // a human decision regardless (medium and high both suspend); impact drives the urgency and the
    // notification tier, not whether a human is asked.
    {
      name: "hr.listEmployees",
      description: "List the served company's employee records (HR people file). Optional status filter.",
      minAssurance: "verified",
      method: "GET",
      pathTemplate: "/api/:tenantId/hr/employees",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          status: { type: "string", enum: ["pending_start", "active", "on_leave", "suspended", "terminated"] },
        },
        required: ["tenantId"],
      },
    },
    {
      name: "hr.getEmployee",
      description: "Read one employee record plus their position history (current and past seats)",
      minAssurance: "verified",
      method: "GET",
      pathTemplate: "/api/:tenantId/hr/employees/:employeeId",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, employeeId: { type: "string" } },
        required: ["tenantId", "employeeId"],
      },
    },
    {
      name: "hr.hireEmployee",
      description:
        "Create an employee record; with positionId, also open the seat and let the reconciler materialise its grants. Idempotent on (tenant, workEmail).",
      minAssurance: "verified",
      method: "POST",
      pathTemplate: "/api/:tenantId/hr/employees",
      write: true,
      impact: "medium",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          displayName: { type: "string" },
          workEmail: { type: "string" },
          positionId: { type: "string" },
          startDate: { type: "string", description: "YYYY-MM-DD; a FUTURE date is refused (no scheduled JML yet)" },
        },
        required: ["tenantId", "displayName", "workEmail"],
      },
    },
    {
      name: "hr.transferEmployee",
      description:
        "Move an employee to another position: closes the outgoing seat, opens the new one, moves their org-chart node, and lets the reconciler move the grants.",
      minAssurance: "verified",
      method: "POST",
      pathTemplate: "/api/:tenantId/hr/employees/:employeeId/transfer",
      write: true,
      impact: "medium",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          employeeId: { type: "string" },
          toPositionId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["tenantId", "employeeId", "toPositionId"],
      },
    },
    {
      name: "hr.terminateEmployee",
      description:
        "Close every seat, revoke this tenant's manual grants, mark the record terminated, and disable the login when no other company's membership remains. HIGH impact: not self-correcting if repeated.",
      minAssurance: "verified",
      method: "POST",
      pathTemplate: "/api/:tenantId/hr/employees/:employeeId/terminate",
      write: true,
      impact: "high",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          employeeId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["tenantId", "employeeId"],
      },
    },
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
    // ══════════════ HR-FULL (2026-08-24) — the new capabilities' AGENT surface ═══════════════════
    //
    // READS ONLY, and that is a deliberate, honest scope rather than an unfinished one. This file's
    // own sibling test (hr-employee-tools.test.ts) records why: a declared WRITE tool with no D14
    // executable-approval entry SUSPENDS for a human and then, on approval, does nothing at all —
    // silently. For a payroll run or an offer conversion that failure shape is worse than having no
    // agent path, so the writes are left off until their executors exist.
    //
    // The reads that ARE here are the ones an assistant actually needs to answer the questions people
    // ask it: what is my leave balance, who is in the pipeline, what expires soon, how is headcount
    // moving. Every one is `minAssurance: "verified"` — these tables carry personal data behind the
    // module's third RLS wall, and a tool must never be a wider door than the UI.
    {
      name: "hr.getAnalytics",
      description: "HR department analytics for a window: headcount, movement, turnover rate, tenure, absence, open cases, expiring documents.",
      minAssurance: "verified",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/hr/analytics",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          from: { type: "string", description: "YYYY-MM-DD; defaults to 1 January of the `to` year" },
          to: { type: "string", description: "YYYY-MM-DD; defaults to today" },
        },
        required: ["tenantId"],
      },
    },
    {
      name: "hr.listRequisitions",
      description: "List hiring requisitions. An HR caller sees all; a hiring manager or recruiter sees their own.",
      minAssurance: "verified",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/hr/requisitions",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          status: { type: "string", enum: ["draft", "pending_approval", "open", "on_hold", "filled", "cancelled", "closed"] },
        },
        required: ["tenantId"],
      },
    },
    {
      name: "hr.getRecruitmentFunnel",
      description: "Per-stage application counts and median days-in-stage, for one requisition or the whole pipeline.",
      minAssurance: "verified",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/hr/recruitment/funnel",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, requisitionId: { type: "string" } },
        required: ["tenantId"],
      },
    },
    {
      name: "hr.listExpiringDocuments",
      description: "HR documents expiring within a window, plus everything already expired (always included, regardless of the window).",
      minAssurance: "verified",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/hr/compliance/expiring",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, days: { type: "number", description: "1..365, default 90" } },
        required: ["tenantId"],
      },
    },
    {
      name: "hr.getLeaveLedger",
      description: "The accrual ledger behind one person's leave balance — every grant, carryover and expiry, with its reason. A member may read their own.",
      minAssurance: "verified",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/hr/leave/ledger",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          subjectUserId: { type: "string", description: "omitted for a member reading their own" },
          year: { type: "number" },
        },
        required: ["tenantId"],
      },
    },
    {
      name: "hr.getWorkingDays",
      description: "Working-day breakdown for a date range against the company's holiday calendar: calendar days, working days, weekends, holidays, and chargeable leave days.",
      minAssurance: "verified",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/hr/working-days",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          from: { type: "string", description: "YYYY-MM-DD" },
          to: { type: "string", description: "YYYY-MM-DD" },
          calendarId: { type: "string", description: "omitted uses the tenant default calendar" },
        },
        required: ["tenantId", "from", "to"],
      },
    },
    {
      name: "hr.listPayslips",
      description: "List payslips. HR sees the tenant's; a member sees only their OWN PUBLISHED slips (a draft mid-run is never visible to its subject).",
      minAssurance: "verified",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/hr/payslips",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, runId: { type: "string" }, employeeId: { type: "string" } },
        required: ["tenantId"],
      },
    },
    {
      name: "hr.previewSeverance",
      description:
        "Estimate separation pay (uang pesangon / penghargaan masa kerja / penggantian hak) for an employee and a termination ground, WITHOUT persisting anything. Flags whether the multipliers used are ratified.",
      minAssurance: "verified",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/hr/separations/preview",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          employeeId: { type: "string" },
          ground: {
            type: "string",
            enum: ["resignation", "contract_end", "retirement", "mutual_agreement", "redundancy",
                   "efficiency", "misconduct", "prolonged_illness", "death", "probation_fail", "other"],
          },
          effectiveOn: { type: "string", description: "YYYY-MM-DD" },
        },
        required: ["tenantId", "employeeId", "ground", "effectiveOn"],
      },
    },
  ],
  rollupProviders: [hrRollups],
  uiManifest: [
    { label: "HR Workspace", path: "/hr" },
    { label: "Leave", path: "/hr/leave" },
    { label: "Attendance", path: "/hr/attendance" },
    { label: "Onboarding", path: "/hr/onboarding" },
    // HR-FULL (2026-08-24) — the department's new surfaces.
    { label: "Recruitment", path: "/hr/recruitment" },
    { label: "Compensation", path: "/hr/compensation" },
    { label: "Payroll", path: "/hr/payroll" },
    { label: "Reviews", path: "/hr/reviews" },
    { label: "Compliance", path: "/hr/compliance" },
    { label: "Analytics", path: "/hr/analytics" },
    { label: "HR Settings", path: "/hr/settings" },
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
