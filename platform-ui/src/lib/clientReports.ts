// PV7-04b — the staff side of client reports (BFF §55.3): types and pure rules. Client-safe (no I/O, no server-only), so the
// hub's action buttons (a client component) and the tests import it directly. Readers: `clientReports-data.ts`; writes:
// `clientReportsActions.ts`.

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
export function reportActions(r: Pick<StaffClientReport, "status" | "file">): { canPublish: boolean; canWithdraw: boolean; publishBlockedReason: string | null } {
  return {
    canPublish: r.status === "draft",
    canWithdraw: r.status === "published",
    publishBlockedReason: r.status === "draft" && !r.file ? "This draft has no file yet, so it cannot be published." : null,
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
