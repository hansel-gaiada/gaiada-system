import "server-only";
// Automation-approvals reader — WS4 §3/D14 human-review inbox for suspended
// automation/agent writes (`platform-nest/src/core/automation-approvals.controller.ts`,
// see docs/FRONTEND-BFF-CONTRACT.md §8). No dedicated UI page yet — consumed
// here only to feed the department console's "Waiting on me" rail (P1-07,
// decision #12). Degrades to [] on 404/403, same house pattern as every other
// lib/*.ts reader (lib/pm.ts, lib/it.ts, lib/hr.ts).
//
// BFF CONTRACT (built):
//   GET  /api/:t/automation-approvals[?status&origin]     -> AutomationApproval[]
//   POST /api/:t/automation-approvals/:id/decide {decision,note?} -> {id,status}
import { platformFetch, PlatformError } from "./platform";

export interface AutomationApproval {
  id: string;
  workflow_id: string;
  tool_name: string;
  tool_args: Record<string, unknown>;
  impact: "medium" | "high" | "unclassified";
  reason: string | null;
  status: "pending" | "approved" | "rejected";
  origin: "automation" | "agent";
  agent_name: string | null;
  requested_by: string;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

async function skipUnavailable<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 403)) return fallback;
    throw e;
  }
}

export interface AutomationApprovalQuery {
  status?: string;
  origin?: string;
}

export function listAutomationApprovals(u: string, t: string, q: AutomationApprovalQuery = {}): Promise<AutomationApproval[]> {
  const params = new URLSearchParams();
  if (q.status) params.set("status", q.status);
  if (q.origin) params.set("origin", q.origin);
  const qs = params.toString();
  return skipUnavailable(
    platformFetch<AutomationApproval[]>(`/api/${t}/automation-approvals${qs ? `?${qs}` : ""}`, u),
    [] as AutomationApproval[],
  );
}
