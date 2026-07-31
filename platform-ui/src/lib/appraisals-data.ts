import "server-only";
// TR-26 — the typed BFF client for the appraisal read surface (appraisals.controller.ts's actual
// routes — read before writing, per this ticket's brief: multiple defects in this program came from
// a stand-in written from assumption). Separate module from lib/appraisals.ts for the same reason
// lib/reports-data.ts is separate from lib/reports.ts: that file is zero-I/O so client components
// can import it directly; this one actually fetches.
import { platformFetch, PlatformError } from "./platform";
import type { AppraisalCycleRow, AppraisalListEntry, AppraisalPack } from "./appraisals";

export { PlatformError };

export function isForbidden(e: unknown): e is PlatformError {
  return e instanceof PlatformError && e.status === 403;
}
export function isNotFound(e: unknown): e is PlatformError {
  return e instanceof PlatformError && e.status === 404;
}

// ---------------- cycles (HR-appraisal / appraisal.cycle.admin only) ----------------

export function getAppraisalCycles(tenantId: string, userId: string): Promise<{ cycles: AppraisalCycleRow[] }> {
  return platformFetch(`/api/${tenantId}/appraisals/cycles`, userId);
}

export function getAppraisalCycle(tenantId: string, userId: string, id: string): Promise<AppraisalCycleRow> {
  return platformFetch(`/api/${tenantId}/appraisals/cycles/${id}`, userId);
}

// ---------------- reads ----------------

export interface ListAppraisalsParams { cycleId?: string; subjectId?: string }

export function listAppraisals(tenantId: string, userId: string, params: ListAppraisalsParams = {}): Promise<{ appraisals: AppraisalListEntry[] }> {
  const qs = new URLSearchParams();
  if (params.cycleId) qs.set("cycleId", params.cycleId);
  if (params.subjectId) qs.set("subjectId", params.subjectId);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return platformFetch(`/api/${tenantId}/appraisals${suffix}`, userId);
}

/** `GET /appraisals/mine` — the subject's own, already-hydrated packs (never a draft — self reads
 *  are status >= submitted only, enforced server-side). */
export function getMyAppraisals(tenantId: string, userId: string, cycleId?: string): Promise<{ appraisals: AppraisalPack[] }> {
  const suffix = cycleId ? `?cycleId=${encodeURIComponent(cycleId)}` : "";
  return platformFetch(`/api/${tenantId}/appraisals/mine${suffix}`, userId);
}

export function getAppraisal(tenantId: string, userId: string, id: string): Promise<AppraisalPack> {
  return platformFetch(`/api/${tenantId}/appraisals/${id}`, userId);
}
