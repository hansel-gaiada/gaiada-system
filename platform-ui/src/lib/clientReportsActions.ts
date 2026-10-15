"use server";
// PV7-04b — the writes behind `/clients/[id]/reports` (BFF §55.3).
//
//   publishClientReportAction   POST /client-reports/:id/publish
//   withdrawClientReportAction  POST /client-reports/:id/withdraw {reason}
//
// NO CAPABILITY GATE HERE, AND WHY: `lib/rbac.ts` has no client-report capability, and a mirror would be a second, drifting
// copy of resource_client_report.yaml (publish rides on the client's owner, withdraw on the role bundle). Cerbos is the
// authority; a refusal comes back as a 403 and is shown in words ("You can't publish reports for this client."). The same
// `{ ok, error?, field?, id?, notice? }` result as the billing actions.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { WITHDRAW_REASON_MAX, publishErrorText, withdrawErrorText, withdrawReasonState } from "./clientReports";

export interface ClientReportActionState {
  ok: boolean;
  error?: string;
  field?: string;
  id?: string;
  /** A note that is not an error. */
  notice?: string;
}

async function ctx(): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Your session has expired. Sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "Select a company first." };
  return { userId, tenant };
}

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

function refresh(clientId: string): void {
  revalidatePath(`/clients/${clientId}/reports`);
  revalidatePath(`/clients/${clientId}`, "layout");
}

export async function publishClientReportAction(_prev: ClientReportActionState | null, formData: FormData): Promise<ClientReportActionState> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const clientId = str(formData, "clientId");
  const reportId = str(formData, "reportId");
  if (!clientId || !reportId) return { ok: false, error: "Missing report." };
  try {
    await platformFetch<{ id: string; status: string; publishedAt: string }>(
      `/api/${c.tenant}/client-reports/${encodeURIComponent(reportId)}/publish`, c.userId, { method: "POST" },
    );
    refresh(clientId);
    return { ok: true, id: reportId, notice: "Published. The client's contacts have been told." };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: publishErrorText(e.status, e.message) };
    throw e;
  }
}

export async function withdrawClientReportAction(_prev: ClientReportActionState | null, formData: FormData): Promise<ClientReportActionState> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const clientId = str(formData, "clientId");
  const reportId = str(formData, "reportId");
  const reason = str(formData, "reason");
  if (!clientId || !reportId) return { ok: false, error: "Missing report." };
  // The same checks the server makes: a blank or over-long reason is answered here without a round trip.
  const state = withdrawReasonState(reason);
  if (!state.canSubmit) return { ok: false, error: state.hint ?? `A reason of up to ${WITHDRAW_REASON_MAX} characters is required.`, field: "reason" };
  try {
    await platformFetch<{ id: string; status: string; withdrawnAt: string }>(
      `/api/${c.tenant}/client-reports/${encodeURIComponent(reportId)}/withdraw`, c.userId,
      { method: "POST", body: JSON.stringify({ reason }) },
    );
    refresh(clientId);
    return { ok: true, id: reportId, notice: "Withdrawn. The client no longer sees it." };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: withdrawErrorText(e.status, e.message), ...(e.field ? { field: e.field } : {}) };
    throw e;
  }
}
