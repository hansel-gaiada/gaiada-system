"use server";
// SCP-5g (BFF §63.28): the audit pages' writes.
//
//   startClientAudit     `POST audits` {subject: client, engagementId}   a client's draft for the last full month; a client with a draft answers it as it is (`created: false`)
//   startProspectAudit   `POST audits` {subject: prospect, ...}          a prospect's audit (the four)
//   saveAudit            `PATCH audits/:id`                              typed scores with notes, "Use automatic" (a null score entry), the summary, the month or the prospect's fields; drafts only
//   proposeAuditSummary  `POST audits/:id/ai-summary`                    a PROPOSAL for the form: nothing is saved until the person saves
//   finalizeAudit        `POST audits/:id/finalize`                      freezes the scorecard; on a final audit `alreadyApplied`
//   attachAudit          `POST audits/:id/attach` {engagementId}         a prospect's audit records the client it became (the four); once
//   deleteAudit          `DELETE audits/:id`                             a draft only
//
// The gates here are hints; the server's 403 is the boundary (SCP-Q34): a client's audit is its officer's, the HoD's or the GM's (the owner and the superadmin too), a prospect's is the four's.
// Every refusal comes back as the contract's own code with the words for it (`auditRefusalText`), and a 403 says who may.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { refusalFromBody, type Refusal } from "./socialPipeline";
import { asAuditWrite, asSummaryProposal, auditRefusalText, type AuditDetail, type AuditWriteKind, type SummaryProposal } from "./socialAudit";

export type AuditWrite<T = object> = ({ ok: true } & T) | { ok: false; refusal: Refusal; message: string };
export interface AuditAnswer { audit: AuditDetail; created: boolean; alreadyApplied: boolean }

const base = (t: string) => `/api/${encodeURIComponent(t)}/modules/social`;
const fail = (refusal: Refusal, kind: AuditWriteKind): { ok: false; refusal: Refusal; message: string } => ({ ok: false, refusal, message: auditRefusalText(refusal, kind) });

async function run<T extends object>(kind: AuditWriteKind, fn: (c: { userId: string; tenant: string }) => Promise<T>): Promise<AuditWrite<T>> {
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

const send = (c: { userId: string; tenant: string }, path: string, method: string, body?: unknown) =>
  platformFetch<unknown>(`${base(c.tenant)}/${path}`, c.userId, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const id = encodeURIComponent;

/** `POST audits` for a client: `id` is a fresh uuid for this click, so a replay of it is the same audit. The month is the server's default (the last full month). */
export async function startClientAudit(engagementId: string, newId: string): Promise<AuditWrite<AuditAnswer>> {
  return run("start", async (c) => asAuditWrite(await send(c, "audits", "POST", { id: newId, subject: "client", engagementId })));
}

/** `POST audits` for a prospect, with the body `buildProspectCreate` made. */
export async function startProspectAudit(body: Record<string, unknown>): Promise<AuditWrite<AuditAnswer>> {
  return run("start_prospect", async (c) => asAuditWrite(await send(c, "audits", "POST", body)));
}

/** `PATCH audits/:id` with only what changed (`buildAuditPatch`). A null score entry is "Use automatic". */
export async function saveAudit(auditId: string, body: Record<string, unknown>): Promise<AuditWrite<AuditAnswer>> {
  return run("save", async (c) => asAuditWrite(await send(c, `audits/${id(auditId)}`, "PATCH", body)));
}

/** `POST audits/:id/ai-summary`: a proposal for the form. Nothing is saved by this call or by anything in this module until `saveAudit`. */
export async function proposeAuditSummary(auditId: string): Promise<AuditWrite<{ proposal: SummaryProposal }>> {
  return run("ai_summary", async (c) => ({ proposal: asSummaryProposal(await send(c, `audits/${id(auditId)}/ai-summary`, "POST", {})) }));
}

/** `POST audits/:id/finalize`: the scorecard is frozen as a dated record. */
export async function finalizeAudit(auditId: string): Promise<AuditWrite<AuditAnswer>> {
  return run("finalize", async (c) => asAuditWrite(await send(c, `audits/${id(auditId)}/finalize`, "POST", {})));
}

/** `POST audits/:id/attach`: a prospect's audit records the client it became. */
export async function attachAudit(auditId: string, engagementId: string): Promise<AuditWrite<AuditAnswer>> {
  return run("attach", async (c) => asAuditWrite(await send(c, `audits/${id(auditId)}/attach`, "POST", { engagementId })));
}

/** `DELETE audits/:id`: a draft only. */
export async function deleteAudit(auditId: string): Promise<AuditWrite> {
  return run("delete", async (c) => { await send(c, `audits/${id(auditId)}`, "DELETE"); return {}; });
}
