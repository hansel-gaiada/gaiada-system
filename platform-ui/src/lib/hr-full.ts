import "server-only";
// HR department data layer — waves A–D (HR-FULL, 2026-08-24). The companion to `lib/hr.ts`, which
// owns the original six surfaces (cases, records, leave, attendance, checklist templates, loans).
// Split into its own file rather than appended because `hr.ts` is already ~285 lines of a distinct
// concern and these are five more.
//
// Every reader DEGRADES GRACEFULLY (empty on 403/404), the same pattern lib/hr.ts, lib/it.ts and
// lib/pm.ts use, so a page ships safely against a company where `hr` is not enabled or served.
//
// ⚠ ONE EXCEPTION, and it is deliberate: `getPayrollRun` and `previewSeverance` DO NOT degrade.
//   An empty payroll run and a zero severance figure are indistinguishable from real answers, and
//   this program has already been bitten by "an empty list is a CLAIM". A page that cannot read a
//   payroll run must say so, not render a run with nobody in it.
//
// BFF CONTRACT (see docs/FRONTEND-BFF-CONTRACT.md §10.2, mounted /api/:t/modules/hr/*):
//   ── configuration (hr_policy) ──
//   GET/POST  /calendars                                  -> HolidayCalendar[] / {id}
//   GET/POST  /calendars/:id/holidays                     -> Holiday[] / {upserted}
//   DELETE    /holidays/:id                               -> {ok}
//   GET       /working-days?from&to[&calendarId]          -> WorkingDayBreakdown
//   GET/POST  /leave-policies                             -> LeavePolicy[] / {id}
//   PATCH     /leave-policies/:id                         -> {ok}
//   GET/POST  /leave-policies/:id/assignments             -> LeavePolicyAssignment[] / {id}
//   GET/POST  /review-cycles[?status]                     -> ReviewCycle[] / {id}
//   PATCH     /review-cycles/:id                          -> {ok}
//   GET/POST  /review-cycles/:id/participants             -> ReviewParticipant[] / {added}
//   PATCH     /review-participants/:id                    -> {ok}
//   GET/POST  /pay-grades                                 -> PayGrade[] / {id}
//   GET/POST  /statutory-parameters                       -> ParameterSet[] / {id}
//   GET       /statutory-parameters/:id                   -> ParameterSetDetail
//   POST      /statutory-parameters/:id/ratify            -> {ok}
//   ── recruitment (hr_recruitment) ──
//   GET/POST  /requisitions[?status]                      -> Requisition[] / {id}
//   PATCH     /requisitions/:id                           -> {ok}
//   POST      /requisitions/:id/submit                    -> {approvalId}
//   GET/POST  /candidates[?q]                             -> Candidate[] / {id}
//   POST      /candidates/:id/erasure-request             -> {ok}
//   GET/POST  /applications[?requisitionId&stageKey&status] -> Application[] / {id}
//   GET       /applications/:id                           -> ApplicationDetail
//   POST      /applications/:id/stage                     -> {from,to,status}
//   POST      /applications/:id/interviews                -> {id}
//   PATCH     /interviews/:id                             -> {ok}
//   POST      /applications/:id/scorecards                -> {id}
//   POST      /applications/:id/offers                    -> {id}
//   POST      /offers/:id/status                          -> {ok}
//   POST      /offers/:id/convert                         -> {employeeId}
//   GET/POST  /pipeline-stages                            -> PipelineStage[] / {upserted}
//   GET       /recruitment/funnel[?requisitionId]         -> FunnelStage[]
//   ── compensation + payroll (hr_payroll) ──
//   GET/POST  /compensation[?employeeId&current]          -> Compensation[] / {id}
//   GET/POST  /allowance-types                            -> AllowanceType[] / {id}
//   POST      /employees/:id/allowances                   -> {id}
//   GET/POST  /benefit-plans                              -> BenefitPlan[] / {id}
//   POST      /employees/:id/benefits                     -> {id}
//   POST      /employees/:id/tax-profile                  -> {id}
//   GET/POST  /payroll-runs[?status]                      -> PayrollRun[] / {id}
//   GET       /payroll-runs/:id                           -> PayrollRunDetail
//   POST      /payroll-runs/:id/calculate                 -> CalculateResult
//   POST      /payroll-runs/:id/approve                   -> {ok}
//   POST      /payroll-runs/:id/publish                   -> {published}
//   POST      /payroll-runs/:id/paid                      -> {ok}
//   GET       /payslips[?runId&employeeId]                -> PayslipSummary[]
//   GET       /payslips/:id                               -> PayslipDetail
//   POST      /payroll-inputs                             -> {id}
//   GET/POST  /separations                                -> Separation[] / {id}
//   GET       /separations/preview?employeeId&ground&effectiveOn -> SeverancePreview
//   POST      /separations/:id/approve                    -> {ok}
//   ── lifecycle + compliance + analytics ──
//   GET/POST  /employees/:id/history                      -> JobEvent[] / {id}
//   GET/POST  /cases/:id/events                           -> CaseEvent[] / {id}
//   GET       /compliance/expiring[?days]                 -> {windowDays, documents}
//   POST      /compliance/sweep                           -> {remindersCreated, notified}
//   POST      /leave/accrue                               -> AccrualRunResult
//   GET       /leave/ledger[?subjectUserId&year]          -> {entries}
//   GET       /analytics[?from&to]                        -> HrAnalytics
import { platformFetch, PlatformError } from "./platform";

const base = (tenantId: string) => `/api/${tenantId}/modules/hr`;

/**
 * Read a list, treating 403/404 as "you cannot see this here" rather than as an error.
 *
 * Note what this deliberately CANNOT distinguish: "the module is off" from "there is nothing".
 * That is acceptable for a list view (the page renders an empty state either way) and NOT
 * acceptable for a single record — see `strict` below.
 */
async function soft<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 403 || e.status === 404)) return fallback;
    throw e;
  }
}

/** Read something whose absence must NOT be rendered as emptiness. Rethrows everything. */
const strict = <T>(fn: () => Promise<T>): Promise<T> => fn();

// ════════════════════════════════════════════════════════════════════ CONFIGURATION ═══════════

export interface HolidayCalendar {
  id: string; name: string; countryCode: string; weekendDays: number[];
  isDefault: boolean; holidayCount: number; createdAt?: string;
}
export interface Holiday {
  id: string; day: string; name: string;
  kind: "public" | "joint_leave" | "company"; deductsEntitlement: boolean | null;
}
export interface WorkingDayBreakdown {
  from: string; to: string; calendarId: string | null;
  calendarDays: number; workingDays: number; weekendDays: number;
  holidayDays: number; jointLeaveChargedDays: number; chargeableDays: number;
}

export const listCalendars = (u: string, t: string) =>
  soft(() => platformFetch<HolidayCalendar[]>(u, `${base(t)}/calendars`), []);

export const listHolidays = (u: string, t: string, calendarId: string, year?: number) =>
  soft(() => platformFetch<Holiday[]>(u, `${base(t)}/calendars/${calendarId}/holidays${year ? `?year=${year}` : ""}`), []);

export const getWorkingDays = (u: string, t: string, from: string, to: string, calendarId?: string) =>
  soft(
    () => platformFetch<WorkingDayBreakdown>(
      u, `${base(t)}/working-days?from=${from}&to=${to}${calendarId ? `&calendarId=${calendarId}` : ""}`,
    ),
    null as WorkingDayBreakdown | null,
  );

export type AccrualMethod = "upfront" | "monthly" | "anniversary" | "none";
export interface LeavePolicy {
  id: string; name: string; leaveType: "vacation" | "sick" | "unpaid" | "other";
  accrualMethod: AccrualMethod; annualEntitlementMinutes: number; waitingPeriodMonths: number;
  prorateFirstYear: boolean; carryoverMaxMinutes: number; carryoverExpiryMonths: number;
  allowNegativeBalance: boolean; excludesHolidays: boolean;
  escalateOverMinutes: number | null; minNoticeDays: number; isActive: boolean;
}
export interface LeavePolicyAssignment {
  id: string; subjectUserId: string | null; unitNodeId: string | null;
  effectiveFrom: string; effectiveTo: string | null;
}

export const listLeavePolicies = (u: string, t: string) =>
  soft(() => platformFetch<LeavePolicy[]>(u, `${base(t)}/leave-policies`), []);
export const listPolicyAssignments = (u: string, t: string, policyId: string) =>
  soft(() => platformFetch<LeavePolicyAssignment[]>(u, `${base(t)}/leave-policies/${policyId}/assignments`), []);

export interface ReviewCycle {
  id: string; name: string; kind: "probation" | "periodic" | "project";
  periodStart: string; periodEnd: string; opensOn: string | null; closesOn: string | null;
  status: "draft" | "open" | "closed" | "cancelled";
  participantCount: number; completedCount: number;
}
export interface ReviewParticipant {
  id: string; subjectUserId: string; subjectName: string | null; reviewerUserId: string | null;
  dueOn: string | null; status: "pending" | "in_progress" | "submitted" | "acknowledged" | "waived";
  outcome: "pass" | "extend" | "fail" | null; outcomeNote: string | null;
  appraisalId: string | null; caseId: string | null; submittedAt: string | null;
}

export const listReviewCycles = (u: string, t: string, status?: string) =>
  soft(() => platformFetch<ReviewCycle[]>(u, `${base(t)}/review-cycles${status ? `?status=${status}` : ""}`), []);
export const listReviewParticipants = (u: string, t: string, cycleId: string) =>
  soft(() => platformFetch<ReviewParticipant[]>(u, `${base(t)}/review-cycles/${cycleId}/participants`), []);

export interface PayGrade {
  id: string; code: string; name: string;
  track: "individual" | "management" | "executive" | "support"; level: number;
  minAmount: string; midAmount: string | null; maxAmount: string;
  currency: string; payPeriod: string; isActive: boolean;
}
export const listPayGrades = (u: string, t: string) =>
  soft(() => platformFetch<PayGrade[]>(u, `${base(t)}/pay-grades`), []);

export interface ParameterSet {
  id: string; name: string; countryCode: string; effectiveFrom: string; effectiveTo: string | null;
  ratifiedBy: string | null; ratifiedAt: string | null; sourceNote: string | null; parameterCount: number;
}
export interface ParameterSetDetail extends ParameterSet {
  ratified: boolean;
  parameters: { key: string; valueNum: string | null; valueJson: unknown; unit: string | null; note: string | null }[];
}
export const listParameterSets = (u: string, t: string) =>
  soft(() => platformFetch<ParameterSet[]>(u, `${base(t)}/statutory-parameters`), []);
export const getParameterSet = (u: string, t: string, id: string) =>
  strict(() => platformFetch<ParameterSetDetail>(u, `${base(t)}/statutory-parameters/${id}`));

// ════════════════════════════════════════════════════════════════════ RECRUITMENT ═════════════

export type RequisitionStatus = "draft" | "pending_approval" | "open" | "on_hold" | "filled" | "cancelled" | "closed";
export interface Requisition {
  id: string; reference: string; title: string; positionId: string | null; unitNodeId: string | null;
  openings: number; filled: number; employmentType: string; location: string | null;
  workMode: string | null; salaryMin: string | null; salaryMax: string | null; currency: string;
  status: RequisitionStatus; hiringManagerUserId: string | null; recruiterUserId: string | null;
  targetStartOn: string | null; createdAt: string; activeApplications: number;
}
export interface Candidate {
  id: string; fullName: string; email: string | null; phone: string | null;
  headline: string | null; location: string | null; source: string; sourceDetail: string | null;
  tags: string[]; resumeFileId: string | null; links: Record<string, string>;
  consentGivenAt: string | null; retentionUntil: string | null; erasureRequestedAt: string | null;
  createdAt: string; applicationCount: number;
}
export interface Application {
  id: string; requisitionId: string; requisitionReference: string; requisitionTitle: string;
  candidateId: string; candidateName: string; candidateHeadline: string | null;
  stageKey: string; status: "active" | "hired" | "rejected" | "withdrawn" | "on_hold";
  rating: string | null; appliedOn: string; stageEnteredAt: string; daysInStage: number;
}
export interface ApplicationDetail extends Omit<Application, "daysInStage"> {
  candidateEmail: string | null; candidatePhone: string | null; headline: string | null;
  links: Record<string, string>; resumeFileId: string | null;
  events: { eventType: string; fromStageKey: string | null; toStageKey: string | null; body: string | null; occurredAt: string; createdBy: string | null }[];
  interviews: { id: string; kind: string; scheduledStart: string; scheduledEnd: string; timezone: string; location: string | null; meetingUrl: string | null; status: string; outcome: string | null; panelists: { userId: string; role: string; response: string }[] }[];
  scorecards: { id: string; interviewId: string | null; reviewerUserId: string; scores: unknown[]; overall: string | null; recommendation: string | null; notes: string | null; submittedAt: string | null }[];
  offer: { id: string; baseAmount: string; currency: string; payPeriod: string; employmentType: string; startOn: string | null; expiresOn: string | null; status: string; employeeId: string | null } | null;
}
export interface PipelineStage {
  id: string; key: string; label: string; sortOrder: number;
  isTerminal: boolean; terminalKind: string | null; requiresInterview: boolean; isActive: boolean;
}
export interface FunnelStage { stageKey: string; label: string; sortOrder: number; count: number; medianDaysInStage: string }

export const listRequisitions = (u: string, t: string, status?: string) =>
  soft(() => platformFetch<Requisition[]>(u, `${base(t)}/requisitions${status ? `?status=${status}` : ""}`), []);
export const listCandidates = (u: string, t: string, q?: string) =>
  soft(() => platformFetch<Candidate[]>(u, `${base(t)}/candidates${q ? `?q=${encodeURIComponent(q)}` : ""}`), []);
export const listApplications = (u: string, t: string, params: { requisitionId?: string; stageKey?: string; status?: string } = {}) => {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  return soft(() => platformFetch<Application[]>(u, `${base(t)}/applications${qs ? `?${qs}` : ""}`), []);
};
/** A single application must never render as "empty" — see the header's `strict` note. */
export const getApplication = (u: string, t: string, id: string) =>
  strict(() => platformFetch<ApplicationDetail>(u, `${base(t)}/applications/${id}`));
export const listPipelineStages = (u: string, t: string) =>
  soft(() => platformFetch<PipelineStage[]>(u, `${base(t)}/pipeline-stages`), []);
export const getFunnel = (u: string, t: string, requisitionId?: string) =>
  soft(() => platformFetch<FunnelStage[]>(u, `${base(t)}/recruitment/funnel${requisitionId ? `?requisitionId=${requisitionId}` : ""}`), []);

// ════════════════════════════════════════════════════ COMPENSATION AND PAYROLL ════════════════

export interface Compensation {
  id: string; employeeId: string; employeeName: string; subjectUserId: string | null;
  gradeId: string | null; gradeCode: string | null; baseAmount: string; currency: string;
  payPeriod: string; fte: string; effectiveFrom: string; effectiveTo: string | null;
  changeReason: string | null; approvedAt: string | null; note: string | null;
}
export interface AllowanceType {
  id: string; code: string; label: string; direction: "allowance" | "deduction";
  calcKind: "fixed" | "percentage" | "formula"; defaultAmount: string | null; defaultPercent: string | null;
  taxable: boolean; bpjsBase: boolean; prorated: boolean; isActive: boolean;
}
export interface BenefitPlan {
  id: string; code: string; name: string; kind: string; statutoryCode: string | null;
  provider: string | null; employerRate: string | null; employeeRate: string | null;
  wageCap: string | null; wageFloor: string | null; currency: string; isActive: boolean;
}
export type PayrollRunStatus = "draft" | "calculated" | "pending_approval" | "approved" | "paid" | "cancelled";
export interface PayrollRun {
  id: string; reference: string; kind: "regular" | "thr" | "bonus" | "final" | "correction";
  periodStart: string; periodEnd: string; payDate: string | null; currency: string;
  status: PayrollRunStatus; parameterSetId: string | null; unratifiedOverrideAt: string | null;
  totalGross: string | null; totalNet: string | null; totalEmployerCost: string | null;
  employeeCount: number | null; calculatedAt: string | null; approvedAt: string | null;
  paidAt: string | null; createdAt: string;
}
export interface PayrollRunDetail extends PayrollRun {
  unratifiedOverrideBy: string | null; unratifiedOverrideReason: string | null;
  parameterSetRatifiedAt: string | null; parameterSetName: string | null;
  payslips: { id: string; employeeId: string; employeeName: string; gross: string; taxableGross: string; employeeDeductions: string; taxWithheld: string; net: string; employerCost: string; status: string; publishedAt: string | null }[];
}
export interface PayslipSummary {
  id: string; runId: string; runReference: string; runKind: string;
  periodStart: string; periodEnd: string; payDate: string | null;
  employeeId: string; gross: string; taxWithheld: string; net: string;
  currency: string; status: string; publishedAt: string | null;
}
export interface PayslipDetail extends PayslipSummary {
  employeeName: string; baseAmount: string; fte: string; workingDays: string | null;
  paidDays: string | null; unpaidDays: string | null; ptkpStatus: string | null; hasNpwp: boolean | null;
  taxableGross: string; bpjsBase: string; employeeDeductions: string; employerCost: string;
  lines: { side: "employee" | "employer"; category: string; code: string; label: string; amount: string; taxable: boolean; bpjsBase: boolean; meta: Record<string, unknown>; sortOrder: number }[];
}
export interface Separation {
  id: string; employeeId: string; employeeName: string; ground: string; initiatedBy: string;
  effectiveOn: string; lastWorkingDay: string | null; serviceYears: string | null;
  severanceAmount: string | null; serviceRewardAmount: string | null;
  entitlementCompensationAmount: string | null; totalAmount: string | null;
  currency: string; status: string; approvedAt: string | null;
}
export interface SeverancePreview {
  serviceYears: number; severanceAmount: number; serviceRewardAmount: number;
  entitlementCompensationAmount: number; totalAmount: number;
  workings: Record<string, unknown>; statutoryRatified: boolean; statutoryWarning: string | null;
}

export const listCompensation = (u: string, t: string, params: { employeeId?: string; current?: boolean } = {}) => {
  const qs = new URLSearchParams();
  if (params.employeeId) qs.set("employeeId", params.employeeId);
  if (params.current) qs.set("current", "true");
  return soft(() => platformFetch<Compensation[]>(u, `${base(t)}/compensation${qs.toString() ? `?${qs}` : ""}`), []);
};
export const listAllowanceTypes = (u: string, t: string) =>
  soft(() => platformFetch<AllowanceType[]>(u, `${base(t)}/allowance-types`), []);
export const listBenefitPlans = (u: string, t: string) =>
  soft(() => platformFetch<BenefitPlan[]>(u, `${base(t)}/benefit-plans`), []);
export const listPayrollRuns = (u: string, t: string, status?: string) =>
  soft(() => platformFetch<PayrollRun[]>(u, `${base(t)}/payroll-runs${status ? `?status=${status}` : ""}`), []);

/** A payroll run with no payslips is indistinguishable from an unreadable one — so this rethrows. */
export const getPayrollRun = (u: string, t: string, id: string) =>
  strict(() => platformFetch<PayrollRunDetail>(u, `${base(t)}/payroll-runs/${id}`));

export const listPayslips = (u: string, t: string, params: { runId?: string; employeeId?: string } = {}) => {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  return soft(() => platformFetch<PayslipSummary[]>(u, `${base(t)}/payslips${qs ? `?${qs}` : ""}`), []);
};
export const getPayslip = (u: string, t: string, id: string) =>
  strict(() => platformFetch<PayslipDetail>(u, `${base(t)}/payslips/${id}`));
export const listSeparations = (u: string, t: string) =>
  soft(() => platformFetch<Separation[]>(u, `${base(t)}/separations`), []);
/** A severance estimate of zero is a real answer AND a failure mode. Never degrade it. */
export const previewSeverance = (u: string, t: string, employeeId: string, ground: string, effectiveOn: string) =>
  strict(() => platformFetch<SeverancePreview>(
    u, `${base(t)}/separations/preview?employeeId=${employeeId}&ground=${ground}&effectiveOn=${effectiveOn}`,
  ));

// ════════════════════════════════════════════ LIFECYCLE, COMPLIANCE, ANALYTICS ════════════════

export interface JobEvent {
  id: string; effectiveOn: string; eventType: string;
  previous: Record<string, unknown>; current: Record<string, unknown>;
  reason: string | null; sourceKind: string | null; sourceId: string | null;
  positionId: string | null; positionTitle: string | null; createdBy: string | null; createdAt: string;
}
export interface CaseEvent {
  id: string; eventType: string; body: string | null; data: Record<string, unknown>;
  fileId: string | null; visibility: "hr_only" | "participants"; occurredAt: string; createdBy: string;
}
export interface ExpiringDocument {
  id: string; subjectUserId: string; subjectName: string | null; recordType: string;
  reference: string | null; issuedOn: string | null; expiresOn: string;
  fileId: string | null; daysRemaining: number; expired: boolean;
}
export interface LeaveLedgerEntry {
  kind: "accrual" | "carryover" | "expiry" | "adjustment" | "encashment";
  leaveType: string; minutes: number; periodStart: string | null; periodEnd: string | null;
  reason: string | null; createdBy: string | null; createdAt: string;
}
export interface HrAnalytics {
  window: { from: string; to: string };
  headcountByStatus: Record<string, number>;
  headcountAtStart: number;
  headcountAtEnd: number;
  leavers: number;
  /** NULL when average headcount is zero — "no meaningful rate" is not the same answer as 0%. */
  turnoverRatePct: number | null;
  tenureYears: { median: number | null; mean: number | null };
  movementByType: Record<string, number>;
  absenceByType: { leaveType: string; requests: number; minutes: number; days: number }[];
  attendanceByStatus: Record<string, number>;
  openCasesByKind: Record<string, number>;
  expiringDocuments90d: number;
}

export const listJobEvents = (u: string, t: string, employeeId: string) =>
  soft(() => platformFetch<JobEvent[]>(u, `${base(t)}/employees/${employeeId}/history`), []);
export const listCaseEvents = (u: string, t: string, caseId: string) =>
  soft(() => platformFetch<CaseEvent[]>(u, `${base(t)}/cases/${caseId}/events`), []);
export const listExpiringDocuments = (u: string, t: string, days = 90) =>
  soft(
    () => platformFetch<{ windowDays: number; documents: ExpiringDocument[] }>(u, `${base(t)}/compliance/expiring?days=${days}`),
    { windowDays: days, documents: [] as ExpiringDocument[] },
  );
export const getLeaveLedger = (u: string, t: string, subjectUserId?: string, year?: number) => {
  const qs = new URLSearchParams();
  if (subjectUserId) qs.set("subjectUserId", subjectUserId);
  if (year) qs.set("year", String(year));
  return soft(
    () => platformFetch<{ subjectUserId: string; year: number; entries: LeaveLedgerEntry[] }>(
      u, `${base(t)}/leave/ledger${qs.toString() ? `?${qs}` : ""}`,
    ),
    null as { subjectUserId: string; year: number; entries: LeaveLedgerEntry[] } | null,
  );
};
export const getAnalytics = (u: string, t: string, from?: string, to?: string) => {
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  return soft(() => platformFetch<HrAnalytics>(u, `${base(t)}/analytics${qs.toString() ? `?${qs}` : ""}`), null as HrAnalytics | null);
};

// ════════════════════════════════════════════════════════════════════ FORMATTING ══════════════
// Kept here rather than in each page so the same number never renders two ways across the console.

/** Minutes to a human day figure. 480 minutes = 1 working day, the unit 0028 charges leave in. */
export function minutesToDays(minutes: number, minutesPerDay = 480): string {
  const days = minutes / minutesPerDay;
  return Number.isInteger(days) ? String(days) : days.toFixed(1);
}

/**
 * Money, in the row's own currency.
 *
 * IDR is rendered without decimal places because it has no minor unit in practice, even though the
 * column is `numeric(14,2)` — showing "Rp 10.000.000,00" is noise nobody in the market reads.
 */
export function formatMoney(amount: string | number | null | undefined, currency = "IDR"): string {
  if (amount === null || amount === undefined || amount === "") return "—";
  const n = Number(amount);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency,
    minimumFractionDigits: currency === "IDR" ? 0 : 2,
    maximumFractionDigits: currency === "IDR" ? 0 : 2,
  }).format(n);
}

/** A percentage that may legitimately be "not applicable" rather than zero. */
export function formatRate(pct: number | null | undefined): string {
  return pct === null || pct === undefined ? "—" : `${pct.toFixed(1)}%`;
}
