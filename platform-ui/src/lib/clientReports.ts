// PV7-04b — the staff side of client reports (BFF §55.3): types and pure rules. Client-safe (no I/O, no server-only), so the
// hub's action buttons (a client component) and the tests import it directly. Readers: `clientReports-data.ts`; writes:
// `clientReportsActions.ts`. PV7-07 adds the monthly account summary's types and rules (BFF §56) at the end.
import type { ResultsServiceCard, ServiceKey } from "./clientCentre";

/** A report's file as the staff list returns it; null while a draft has none. */
export interface StaffReportFile { id: string; filename: string; contentType: string; byteSize: number }

/** One row of `GET :t/clients/:clientId/reports`, every status (BFF §55.3). */
export interface StaffClientReport {
  id: string;
  clientId: string;
  projectId: string | null;
  projectName: string | null;
  source: "social_report" | "search_report" | "account_summary";
  sourceId: string | null;
  deliverableId: string | null;
  title: string;
  periodStart: string;
  periodEnd: string;
  status: "draft" | "published" | "withdrawn";
  file: StaffReportFile | null;
  createdAt: string;
  publishedAt: string | null;
  publishedByName: string | null;
  withdrawnAt: string | null;
  withdrawnByName: string | null;
  withdrawnReason: string | null;
  /** A client-wide contact of this client sees it (the backend's own answer, `staffClientReportClientVisible`). */
  clientVisible?: boolean;
  /** Contacts who have opened it. */
  readCount?: number;
  /** An account summary only (BFF §56.3): the month, the editable narrative, who wrote it, when the snapshot was read, and the frozen snapshot. */
  period?: string;
  narrativeMd?: string;
  narrativeSource?: NarrativeSource;
  generatedAt?: string;
  snapshot?: SummarySnapshot;
}

/** The longest withdrawal reason the backend accepts (`MAX_REASON` in client-reports.controller.ts). */
export const WITHDRAW_REASON_MAX = 2000;

export const REPORT_STATUS_LABEL: Record<StaffClientReport["status"], string> = {
  draft: "Draft",
  published: "Published",
  withdrawn: "Withdrawn",
};

export const REPORT_SOURCE_LABEL: Record<StaffClientReport["source"], string> = {
  social_report: "Social report",
  search_report: "Search report",
  account_summary: "Account summary",
};

/** What the Publish button asks before it acts. */
export const PUBLISH_CONFIRM =
  "Publish to the client? Contacts who can see this project (or, with no project, the client's main contacts) will see it and get a notice.";
/** What the Withdraw button asks before it acts. The reason is kept for staff and never shown to the client. */
export const WITHDRAW_CONFIRM =
  "Withdraw this report from the client? It disappears from their portal at once. Withdrawal is final for this report; you keep it here with your reason.";

/** Draft reports can be published; published ones can be withdrawn; a withdrawn report is final (BFF §55.2). */
export function reportActions(r: Pick<StaffClientReport, "status" | "file"> & { source?: StaffClientReport["source"] }): { canPublish: boolean; canWithdraw: boolean; publishBlockedReason: string | null } {
  return {
    canPublish: r.status === "draft",
    canWithdraw: r.status === "published",
    // An account summary has no file until Publish renders it (BFF §56.3); every other draft needs the file it was delivered with.
    publishBlockedReason: r.status === "draft" && !r.file && r.source !== "account_summary" ? "This draft has no file yet, so it cannot be published." : null,
  };
}

/** The download link's label, from the file's own content type: search reports are Markdown, social reports are PDF. */
export function staffReportDownloadLabel(contentType: string | null | undefined): string {
  const t = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (t === "application/pdf") return "PDF";
  if (t === "text/markdown" || t === "text/x-markdown") return "Markdown";
  return "File";
}

/** Disabled-state check for the Withdraw form: the reason is required and bounded. */
export function withdrawReasonState(reason: string): { canSubmit: boolean; hint: string | null } {
  const t = reason.trim();
  if (!t) return { canSubmit: false, hint: "Say why. The reason is kept for staff and the client never sees it." };
  if (t.length > WITHDRAW_REASON_MAX) return { canSubmit: false, hint: `The reason is too long: ${WITHDRAW_REASON_MAX} characters at most.` };
  return { canSubmit: true, hint: null };
}

/** The platform's refusals for Publish, in words. Machine codes arrive as the error message. */
export function publishErrorText(status: number | null, message: string): string {
  if (status === 403) return "You can't publish reports for this client.";
  if (status === 404) return "This report no longer exists. Refresh the page.";
  if (message === "not_a_draft") return "This report is no longer a draft, so it can't be published. Refresh the page to see where it stands.";
  if (message === "report_has_no_file") return "This report has no file yet, so it can't be published.";
  if (message === "pdf_render_not_configured") return "The PDF could not be made: the report renderer is not set up here. The summary stays a draft.";
  if (message === "pdf_render_failed") return "The PDF could not be made right now. The summary stays a draft; try again in a moment.";
  if (message === "draft_changed") return "The narrative was edited while the PDF was being made, so nothing was published. Check the text and publish again.";
  return message || "The report could not be published. Try again in a moment.";
}

/** The platform's refusals for Withdraw, in words. */
export function withdrawErrorText(status: number | null, message: string): string {
  if (status === 403) return "You can't withdraw reports for this client.";
  if (status === 404) return "This report no longer exists. Refresh the page.";
  if (message === "reason_required") return "Say why you are withdrawing it. The reason is required.";
  if (message === "reason_too_long") return `The reason is too long: ${WITHDRAW_REASON_MAX} characters at most.`;
  if (message === "not_published") return "This report is not published, so there is nothing to withdraw. Refresh the page to see where it stands.";
  return message || "The report could not be withdrawn. Try again in a moment.";
}

// ── The monthly account summary (PV7-07, BFF §56) ───────────────────────────────────────────────────
// The snapshot is mirrored from `platform-nest/src/modules/clients/account-summary/snapshot.ts`. It is the CLIENT-WIDE view of one
// client for one month: no money, no tasks, no time, no people, no internal gates. A section that is `null` could not be read.

export type NarrativeSource = "ai" | "human" | "deterministic";

export interface SummarySnapshot {
  version: 1;
  clientId: string;
  clientName: string;
  period: string;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  projects: Array<{
    projectId: string; name: string; status: string;
    milestones: { total: number; done: number; upcoming: number; late: number; undated: number };
    deliverables: { total: number; delivered: number; late: number };
    nextMilestone: { name: string; dueDate: string } | null;
  }> | null;
  waiting: { onClient: { count: number; oldestSince: string | null }; onUs: { count: number; oldestSince: string | null } } | null;
  completed: {
    milestones: {
      count: number; knownSince: string | null; wholeMonthKnown: boolean | null;
      items: Array<{ projectId: string; projectName: string; name: string; completedOn: string }>;
    } | null;
    deliverables: {
      count: number; basis: "status_changed_in_month";
      items: Array<{ projectId: string; projectName: string; name: string; status: string; on: string }>;
    } | null;
  };
  turnaround: {
    windowDays: 90; windowEnd: string;
    client: { medianDays: number | null; n: number; withheld: boolean };
    ours: { medianDays: number | null; n: number; withheld: boolean };
  } | null;
  results: { generatedAt: string; services: ResultsServiceCard[]; unavailable: ServiceKey[] } | null;
  reports: Array<{ id: string; title: string; source: string; periodStart: string; periodEnd: string; publishedOn: string }> | null;
  unavailable: string[];
}

/** The longest narrative the backend saves (`MAX_SUMMARY_NARRATIVE_CHARS`). */
export const SUMMARY_NARRATIVE_MAX = 20_000;

export const NARRATIVE_SOURCE_LABEL: Record<NarrativeSource, string> = {
  ai: "Drafted by AI from the figures below; not edited yet",
  deterministic: "Standard wording built from the figures below; not edited yet",
  human: "Written by staff",
};

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-09" -> "September 2026"; anything else comes back as it was. */
export function summaryPeriodLabel(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  const n = m ? Number(m[2]) : 0;
  return m && n >= 1 && n <= 12 ? `${MONTH_NAMES[n - 1]} ${m[1]}` : period;
}

/** The month before `now` as YYYY-MM (UTC, the month the backend cuts on): the picker's default. */
export function lastMonth(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The newest month a summary can be drafted for: this one (a part month). */
export function thisMonth(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Is this a month the picker may send? `YYYY-MM`, a real month, not after this one. The backend checks the same. */
export function validSummaryMonth(period: string, now: Date = new Date()): boolean {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  return !!m && Number(m[1]) >= 2000 && period <= thisMonth(now);
}

/** Disabled-state check for the narrative editor: required and bounded. */
export function narrativeState(text: string): { canSave: boolean; hint: string | null } {
  const t = text.trim();
  if (!t) return { canSave: false, hint: "The narrative can't be empty." };
  if (t.length > SUMMARY_NARRATIVE_MAX) return { canSave: false, hint: `The narrative is too long: ${SUMMARY_NARRATIVE_MAX} characters at most.` };
  return { canSave: true, hint: null };
}

/** The platform's refusals for "Draft account summary", in words. */
export function draftSummaryErrorText(status: number | null, message: string): string {
  if (status === 403) return "You can't draft reports for this client.";
  if (status === 404) return "This client no longer exists. Refresh the page.";
  if (message === "invalid_period") return "Pick a month.";
  if (message === "period_in_future") return "That month hasn't started yet. Pick this month or an earlier one.";
  if (message === "internal_client") return "An internal client has no one to send a summary to.";
  if (message === "summary_published") return "A summary for that month is already published. Withdraw it first if you want to draft a new one.";
  return message || "The summary could not be drafted. Try again in a moment.";
}

/** The platform's refusals for saving the narrative, in words. */
export function saveNarrativeErrorText(status: number | null, message: string): string {
  if (status === 403) return "You can't edit reports for this client.";
  if (status === 404) return "This report no longer exists. Refresh the page.";
  if (message === "not_a_draft") return "This summary is no longer a draft, so it can't be edited. Refresh the page to see where it stands.";
  if (message === "not_an_account_summary") return "Only an account summary has a narrative to edit.";
  if (message === "narrative_required") return "The narrative can't be empty.";
  if (message === "narrative_too_long") return `The narrative is too long: ${SUMMARY_NARRATIVE_MAX} characters at most.`;
  return message || "The narrative could not be saved. Try again in a moment.";
}
