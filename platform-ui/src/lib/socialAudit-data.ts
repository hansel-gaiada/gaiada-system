import "server-only";
// SCP-5g (BFF §63.28): the audit pages' readers. One egress (`platformFetch`), every answer a `ReadResult`:
//   ok          the read succeeded, and the body is the shape the contract names;
//   forbidden   a 403: the person has no social read tier, which is not "nothing here";
//   unavailable anything else (a 404 when the Social Media module is off for the company included): "cannot tell", never an empty list.
// A single audit that does not exist is a real answer, so it is `ok` with `null`, never a refusal.
import { platformFetch, PlatformError } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import { asAuditDetail, asAuditList, type AuditDetail, type AuditList, type AuditSubject } from "./socialAudit";

const base = (t: string) => `/api/${encodeURIComponent(t)}/modules/social`;

/** `GET audits?subject=` (`social_post` · `read`): every open client with its audit (the draft's live score, else the latest final's frozen one, else none) and every prospect, worst first. */
export function getAudits(userId: string, tenantId: string, subject: AuditSubject | null = null): Promise<ReadResult<AuditList>> {
  return readResult(platformFetch<unknown>(`${base(tenantId)}/audits${subject ? `?subject=${subject}` : ""}`, userId).then(asAuditList));
}

/** `GET audits/:auditId`: the scorecard, with the server's `canWrite` and `canFinalize`. A 404 is `ok` with `null` ("no such audit"). */
export async function getAudit(userId: string, tenantId: string, auditId: string): Promise<ReadResult<AuditDetail | null>> {
  try {
    return { kind: "ok", data: asAuditDetail(await platformFetch<unknown>(`${base(tenantId)}/audits/${encodeURIComponent(auditId)}`, userId)) };
  } catch (err) {
    if (err instanceof PlatformError && err.status === 404 && /audit_not_found/.test(err.message)) return { kind: "ok", data: null };
    return readResult(Promise.reject(err));
  }
}
