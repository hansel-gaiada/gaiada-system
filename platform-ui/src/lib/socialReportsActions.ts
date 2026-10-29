"use server";
// SCP-5a (BFF §63.18): the monthly report pages' writes.
//
//   draftMonthlyReport   `POST engagements/:engagementId/reports`   kind `monthly`, the month's `period`; idempotent: an existing report for the month is returned as it is
//   saveReport           `PATCH reports/:id`                         the narrative, the three notes and the action plan (while `draft` or `in_review`)
//   submitReport         `PATCH reports/:id` {status: in_review}     the officer's hand-off to the HoD check
//   sendBackReport       `PATCH reports/:id` {status: draft}         one of the HoD check's two answers (the four approvers)
//   proposeReportDraft   `POST reports/:id/ai-draft`                 a PROPOSAL for the form: nothing is saved until the person saves
//   approveReport        `POST reports/:id/approve`                  the HoD check passes (the four approvers); 400 `notes_incomplete` while an area lacks its insight or suggestion
//   deliverReport        `POST reports/:id/deliver`                  renders the PDF and publishes it to the client's portal reports (the four approvers)
//
// The gates here are hints; the server's 403 is the boundary. Every refusal comes back as the contract's own code with the words for it (`reportRefusalText`), and a 403 says who may.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { refusalFromBody, type Refusal } from "./socialPipeline";
import { asCreatedReport, asProposal, reportRefusalText, type CreatedReport, type ReportProposal, type ReportWriteKind } from "./socialReports";

export type ReportWrite<T = object> = ({ ok: true } & T) | { ok: false; refusal: Refusal; message: string };
export interface DeliverAnswer { filename: string | null; clientReportId: string | null }

const base = (t: string) => `/api/${encodeURIComponent(t)}/modules/social`;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const fail = (refusal: Refusal, kind: ReportWriteKind): { ok: false; refusal: Refusal; message: string } => ({ ok: false, refusal, message: reportRefusalText(refusal, kind) });

async function run<T extends object>(kind: ReportWriteKind, fn: (c: { userId: string; tenant: string }) => Promise<T>): Promise<ReportWrite<T>> {
  const userId = await getSessionUserId();
  if (!userId) return fail({ status: 401, error: "session_expired" }, kind);
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return fail({ status: 400, error: "no_company" }, kind);
  try {
    const out = await fn({ userId, tenant });
    revalidatePath("/departments", "layout");
    return { ok: true, ...out };
  } catch (e) {
    if (e instanceof PlatformError) return fail(refusalFromBody(e.status, e.message, e.body, e.field, e.reason), kind);
    throw e;
  }
}

const send = (c: { userId: string; tenant: string }, path: string, method: string, body: unknown) =>
  platformFetch<unknown>(`${base(c.tenant)}/${path}`, c.userId, { method, body: JSON.stringify(body) });

/** `POST engagements/:engagementId/reports`. `period` is `YYYY-MM`; `id` is a fresh uuid for this click, so a replay of it is the same report. */
export async function draftMonthlyReport(engagementId: string, period: string, id: string): Promise<ReportWrite<{ report: CreatedReport }>> {
  return run("create", async (c) => ({ report: asCreatedReport(await send(c, `engagements/${encodeURIComponent(engagementId)}/reports`, "POST", { id, kind: "monthly", period })) }));
}

/** `PATCH reports/:id` with the form's body: nothing but what the person typed. */
export async function saveReport(reportId: string, body: { narrativeMd: string; notes: object; actionPlan: object[] }): Promise<ReportWrite> {
  return run("save", async (c) => { await send(c, `reports/${encodeURIComponent(reportId)}`, "PATCH", body); return {}; });
}

/** `PATCH reports/:id` {status: "in_review"}: the officer submits for the HoD check. */
export async function submitReport(reportId: string): Promise<ReportWrite> {
  return run("submit", async (c) => { await send(c, `reports/${encodeURIComponent(reportId)}`, "PATCH", { status: "in_review" }); return {}; });
}

/** `PATCH reports/:id` {status: "draft"}: the HoD check's other answer; the four approvers only. */
export async function sendBackReport(reportId: string): Promise<ReportWrite> {
  return run("send_back", async (c) => { await send(c, `reports/${encodeURIComponent(reportId)}`, "PATCH", { status: "draft" }); return {}; });
}

/** `POST reports/:id/ai-draft`: a proposal for the form. Nothing is saved by this call or by anything in this module until `saveReport`. */
export async function proposeReportDraft(reportId: string): Promise<ReportWrite<{ proposal: ReportProposal }>> {
  return run("ai_draft", async (c) => ({ proposal: asProposal(await send(c, `reports/${encodeURIComponent(reportId)}/ai-draft`, "POST", {})) }));
}

/** `POST reports/:id/approve`: the four approvers. */
export async function approveReport(reportId: string): Promise<ReportWrite> {
  return run("approve", async (c) => { await send(c, `reports/${encodeURIComponent(reportId)}/approve`, "POST", {}); return {}; });
}

/** `POST reports/:id/deliver`: the four approvers; the PDF is rendered and published to the client's portal reports. */
export async function deliverReport(reportId: string): Promise<ReportWrite<DeliverAnswer>> {
  return run("deliver", async (c) => {
    const o = await send(c, `reports/${encodeURIComponent(reportId)}/deliver`, "POST", {});
    return { filename: isObj(o) && typeof o.filename === "string" ? o.filename : null, clientReportId: isObj(o) && typeof o.clientReportId === "string" ? o.clientReportId : null };
  });
}
