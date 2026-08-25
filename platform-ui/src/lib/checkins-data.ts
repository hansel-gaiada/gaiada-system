import "server-only";
// TR-10/TR-38 — the typed BFF client for the check-in read surface (checkins.controller.ts §6.2).
//
// Deliberately a SEPARATE module from lib/checkins.ts, same split as lib/reports.ts/reports-data.ts:
// that file carries the canonical types + pure helpers and is intentionally NOT server-only (so
// CheckinCard, a "use client" component, can import its types/pure functions directly). This file
// is the one place the fetch actually happens.
import { platformFetch, PlatformError } from "./platform";
import { addDaysIso, summarizeSelfCompliance, SELF_HISTORY_WINDOW_DAYS, type CheckinToday, type CheckinHistory, type CheckinCompliance, type SelfComplianceSummary } from "./checkins";

export { PlatformError };

/** `GET /checkins/today` — self only; the endpoint composes `userId` from the caller's own
 *  principal, never a query param, so there is nothing to pass here beyond the tenant. */
export function getTodayCheckin(tenantId: string, userId: string): Promise<CheckinToday> {
  return platformFetch<CheckinToday>(`/api/${tenantId}/checkins/today`, userId);
}

export interface CheckinHistoryParams {
  /** Defaults to the caller's own history when omitted (matches the controller's own default). */
  subjectUserId?: string;
  from: string;
  to: string;
}

/** `GET /checkins?userId&from&to` — self is always allowed; reading someone else's requires the
 *  broader lead/exec/HR tier the controller enforces server-side (never re-checked here). */
export function getCheckinHistory(tenantId: string, userId: string, params: CheckinHistoryParams): Promise<CheckinHistory> {
  const qs = new URLSearchParams();
  if (params.subjectUserId) qs.set("userId", params.subjectUserId);
  qs.set("from", params.from);
  qs.set("to", params.to);
  return platformFetch<CheckinHistory>(`/api/${tenantId}/checkins?${qs.toString()}`, userId);
}

export interface CheckinComplianceParams {
  /** Org-unit node id to narrow to, or omit for the whole company. ⚠ The server may OVERRIDE this:
   *  a unit-scoped (dept-lead) principal gets its led subtree regardless of what is sent, and a
   *  self-only principal gets its own row with `unit: null`. Read the response's `unit` echo. */
  unit?: string;
  periodKind: "day" | "week" | "month" | "custom";
  start: string;
  /** Required when `periodKind === "custom"` (the controller's own rule). */
  end?: string;
}

/** `GET /checkins/compliance` — the expected/submitted/missed/excused grid.
 *
 *  Authz is lead/exec/HR, with a self-only fallback the controller applies rather than refusing
 *  (§6.2 / TR-39): a plain member does NOT get a 403 here, they get a one-row grid of themselves.
 *  So a caller must not treat "rows.length === 1" as an error, and must not present a self-only
 *  grid as a team view — check the row set against who you expected. */
export function getCheckinCompliance(
  tenantId: string,
  userId: string,
  params: CheckinComplianceParams,
): Promise<CheckinCompliance> {
  const qs = new URLSearchParams();
  if (params.unit) qs.set("unit", params.unit);
  qs.set("periodKind", params.periodKind);
  qs.set("start", params.start);
  if (params.end) qs.set("end", params.end);
  return platformFetch<CheckinCompliance>(`/api/${tenantId}/checkins/compliance?${qs.toString()}`, userId);
}

export function isForbidden(e: unknown): e is PlatformError {
  return e instanceof PlatformError && e.status === 403;
}

export function isExcusedConflict(e: unknown): e is PlatformError {
  return e instanceof PlatformError && e.status === 409;
}

export interface CheckinCardData {
  today: CheckinToday;
  selfCompliance: SelfComplianceSummary;
}

/** My Work's single data-gathering call: `GET /checkins/today` + a trailing self-history read for
 *  the streak/compliance strip (§6.2's history endpoint — self is always allowed, unlike the
 *  lead/exec/HR-only compliance grid; see lib/checkins.ts's header comment). Returns `null` on ANY
 *  backend failure (module not enabled, network down, endpoint absent on a stale deploy) so the
 *  page can render the estate's standard `BackendPending` banner instead of crashing — the same
 *  graceful-degradation convention every other BFF-backed surface in this app follows. */
export async function getCheckinCardData(tenantId: string, userId: string): Promise<CheckinCardData | null> {
  try {
    const today = await getTodayCheckin(tenantId, userId);
    const to = addDaysIso(today.date, -1);
    const from = addDaysIso(today.date, -SELF_HISTORY_WINDOW_DAYS);
    const history = await getCheckinHistory(tenantId, userId, { from, to });
    return { today, selfCompliance: summarizeSelfCompliance(history.checkins) };
  } catch {
    return null;
  }
}
