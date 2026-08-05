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
//   POST /api/:t/automation-approvals/:id/retry            -> {id,status:"pending"} (D14-07)
import { platformFetch, PlatformError } from "./platform";
import type { ExecutionInfo, ExecutionStatus } from "./approvalsShared";

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
  // D14-02/D14-08 — additive. Optional (not `| undefined` narrowed away) so a row from an OLDER
  // deployment that omits these columns degrades to "no execution info" rather than an
  // undefined-reads-as-null misread (CLAUDE.md's "a missing field reads as null" trap) — callers
  // must treat a missing `execution_status` as "unknown", never coerce it to `not_applicable`.
  execution_status?: ExecutionStatus;
  executed_at?: string | null;
  executed_by?: string | null;
  execution_error?: string | null;
  execution_result?: unknown;
  execution_attempts?: number | null;
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

// D14-08 — the unified `/approvals` inbox (lib/approvals.ts's `listApprovals`, backing
// `/approvals/page.tsx`) reads `approvals.controller.ts`'s `UnifiedApprovalItem`, which does NOT
// carry execution_status/executed_at/executed_by/execution_error/execution_result/
// execution_attempts (confirmed by reading that controller's SELECT — it stops at `status`).
// Those columns only exist on the per-tenant `GET /:t/automation-approvals` list this file already
// wraps (`listAutomationApprovals`, D14-02). Rather than widen the unified endpoint's contract
// (out of scope — this ticket touches platform-ui only), the approvals page fans this reader out
// per tenant present among its automation/agent/hr-origin DECIDED items (execution only exists
// once a row is decided — a still-pending row is always `not_applicable`, per 0078's header) and
// merges the result back onto the unified rows by id. A row this reader can't see (403/404, or an
// older backend missing the columns) is simply absent from the returned map — callers must treat
// "no entry" as unknown, not as `not_applicable` (same rule as the optional fields above).
export async function fetchExecutionStates(
  u: string,
  items: { id: string; origin: string; tenantId: string }[],
): Promise<Record<string, ExecutionInfo>> {
  const relevant = items.filter((i) => i.origin === "automation" || i.origin === "agent" || i.origin === "hr");
  const tenantIds = [...new Set(relevant.map((i) => i.tenantId))];
  const out: Record<string, ExecutionInfo> = {};
  await Promise.all(
    tenantIds.map(async (t) => {
      // "decided" isn't a literal `automation_approvals.status` value (the column holds
      // pending|approved|rejected) — two explicit calls, not one "decided" filter, mirrors how
      // `approvals.controller.ts` itself maps its own `status=decided` query param onto `status IN
      // ('approved','rejected')` server-side.
      const [approved, rejected] = await Promise.all([
        listAutomationApprovals(u, t, { status: "approved" }),
        listAutomationApprovals(u, t, { status: "rejected" }),
      ]);
      for (const row of [...approved, ...rejected]) {
        if (row.execution_status === undefined) continue; // unknown, not not_applicable — see header.
        out[row.id] = {
          status: row.execution_status,
          error: row.execution_error ?? null,
          attempts: row.execution_attempts ?? null,
        };
      }
    }),
  );
  return out;
}

export function retryAutomationApproval(u: string, t: string, id: string): Promise<{ id: string; status: string }> {
  return platformFetch<{ id: string; status: string }>(`/api/${t}/automation-approvals/${id}/retry`, u, { method: "POST" });
}
