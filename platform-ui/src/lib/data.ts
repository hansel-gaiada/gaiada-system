import { platformFetch, PlatformError } from "./platform";

export interface ApprovalItem { id: string; tenantId: string; company: string; subject: string; campaign: string; campaignId?: string | null; created_at: string }
export interface DecidedApproval { id: string; tenantId: string; company: string; subject: string; campaign: string; decision: string; decided_at: string; decided_by?: string | null }
export interface TaskRow { id: string; title: string; status: string | null; priority: string | null; due_date: string | null; project_name: string }
export interface ActivityRow { id: string; actor_name: string | null; verb: string; target_entity_type: string; metadata: Record<string, unknown>; occurred_at: string }

export async function getPendingApprovals(userId: string, tenants: { id: string; name: string }[]): Promise<ApprovalItem[]> {
  const per = await Promise.all(
    tenants.map(async (t) => {
      try {
        const rows = await platformFetch<Omit<ApprovalItem, "tenantId" | "company">[]>(
          `/api/${t.id}/modules/agency/approvals/pending`, userId,
        );
        return rows.map((r) => ({ ...r, tenantId: t.id, company: t.name }));
      } catch (e) {
        if (e instanceof PlatformError && (e.status === 404 || e.status === 403)) return [];
        throw e;
      }
    }),
  );
  return per.flat().sort((a, b) => a.created_at.localeCompare(b.created_at));
}

// Decided-approval history across the user's companies. BFF contract:
//   GET /api/:t/modules/agency/approvals/decided -> Omit<DecidedApproval,"tenantId"|"company">[]
export async function getDecidedApprovals(userId: string, tenants: { id: string; name: string }[]): Promise<DecidedApproval[]> {
  const per = await Promise.all(
    tenants.map(async (t) => {
      try {
        const rows = await platformFetch<Omit<DecidedApproval, "tenantId" | "company">[]>(
          `/api/${t.id}/modules/agency/approvals/decided`, userId,
        );
        return rows.map((r) => ({ ...r, tenantId: t.id, company: t.name }));
      } catch (e) {
        if (e instanceof PlatformError && (e.status === 404 || e.status === 403)) return [];
        throw e;
      }
    }),
  );
  return per.flat().sort((a, b) => b.decided_at.localeCompare(a.decided_at));
}

export async function getMyTasks(userId: string, tenantId: string): Promise<TaskRow[]> {
  try {
    return await platformFetch<TaskRow[]>(`/api/${tenantId}/tasks?assignee=me`, userId);
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 403)) return [];
    throw e;
  }
}

export async function getActivity(userId: string, tenantId: string, limit = 20): Promise<ActivityRow[]> {
  try {
    return await platformFetch<ActivityRow[]>(`/api/${tenantId}/activity?limit=${limit}`, userId);
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 403)) return [];
    throw e;
  }
}

export function weeklyThroughput(rows: { occurred_at: string }[], weeks = 8): number[] {
  const wk = 7 * 24 * 3600 * 1000;
  const now = Date.now();
  const series = new Array(weeks).fill(0);
  for (const r of rows) {
    const age = Math.floor((now - Date.parse(r.occurred_at)) / wk);
    if (age >= 0 && age < weeks) series[weeks - 1 - age] += 1;
  }
  return series;
}
