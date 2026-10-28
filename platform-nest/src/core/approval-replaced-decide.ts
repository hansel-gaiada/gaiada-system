// SCP-3g (PERMISSION-CONTRACT §53.12, FRONTEND-BFF-CONTRACT §8) — LISTING AND OPENING the D14 rows a caller may decide
// because an entry's `approverCheck` REPLACES the generic decide right (SCP-1b, owner ruling SCP-Q21).
//
// For a pipeline post's publish approval, passing `social_post · approve` on the post IS the decide right: the HoD and GM
// seats, the owner and `platform_admin` decide such a row by id without `company_admin`. They could not list or open it,
// because the approvals reads asked only `automation_approval · read`. This file is the one place the read routes ask the
// other question, "could this caller decide this row under the replacement?", so they show a caller exactly those rows:
//   - the unified inbox (`approvals.controller.ts`, the automation leg) lists them and marks them decidable;
//   - the detail (`GET :tenantId/automation-approvals/:id`) opens such a row when the generic read and the own-row rule fail;
//   - the per-tenant list (`GET :tenantId/automation-approvals`) adds them to the own-row slice, and flags them.
//
// NARROW BY CONSTRUCTION. A row is shown here only when ALL of these hold, every one read from the rows:
//   1. its origin is `automation` or `agent` (the only origins a registry row can have: the decide route's own rule);
//   2. its tool's registry entry declares `approverCheck.replacesDecide` AND the batched form (`replacedDecideAllowedMany`);
//   3. the entry's `replacesDecideFor` claims it (a Composer post's approval is never claimed: `pipeline_status IS NULL`);
//   4. the approverCheck passes for the caller, and for the person an act-for call acts for (the decide right itself).
// Rows are read under the caller's own `withTenants([tenantId])`, so another company's rows never reach the check. The
// maker/checker DENY on `social_post · approve` refuses the post's author and officer, so they are never listed here, and
// the automation DENY refuses `automation`/`bot` principals. Nothing here grants a decision: the decide route asks again.
import type { PoolClient } from "pg";
import type { Principal } from "../rbac/principal";
import { getExecutable, listExecutableApprovals, type ApprovalApprover } from "./approval-executables";
import { replacedDecideAllowedMany, toolArgsOf } from "./approval-execute";

/** The origins a registry row can carry (`AutomationApprovalsController.decide()` looks an entry up for these only). */
export const REPLACED_DECIDE_ORIGINS: readonly string[] = ["automation", "agent"];

/** How many candidate rows one read considers: the bound the inbox and the list already put on a read (LIMIT 200). */
export const REPLACED_DECIDE_CANDIDATE_LIMIT = 200;

/** The tools whose registry entry replaces the generic decide right AND answers the batched read question. */
export function replacedDecideTools(): string[] {
  return listExecutableApprovals()
    .filter((e) => e.approverCheck?.replacesDecide === true && typeof e.approverCheck.replacedDecideAllowedMany === "function")
    .map((e) => e.toolName)
    .sort();
}

/** One `automation_approvals` row as the per-tenant list returns it (the inbox reads a subset). */
export interface ReplacedDecideCandidate {
  id: string; workflow_id: string; tool_name: string; tool_args: unknown; impact: string; reason: string | null; status: string;
  origin: string; agent_name: string | null; requested_by: string | null; decided_by: string | null; decided_at: string | null;
  created_at: string; execution_status: string | null; executed_at: string | null; executed_by: string | null;
  execution_error: string | null; execution_result: unknown; execution_attempts: number | null;
}

/**
 * The rows of the caller's tenant that MIGHT be decidable under a replacement: tool in `replacedDecideTools()`, origin in
 * `origins` ∩ `REPLACED_DECIDE_ORIGINS`, status in `statuses` (null: any), newest first, at most 200. ONE query on `c` (the
 * caller's `withTenants([tenantId])` client); none at all when no entry or no origin qualifies. A candidate is not an
 * answer: `replacedDecidableIds` decides.
 */
export async function replacedDecideCandidates(
  c: PoolClient,
  opts: { origins: readonly string[]; statuses: readonly string[] | null },
): Promise<ReplacedDecideCandidate[]> {
  const tools = replacedDecideTools();
  const origins = opts.origins.filter((o) => REPLACED_DECIDE_ORIGINS.includes(o));
  if (tools.length === 0 || origins.length === 0 || (opts.statuses && opts.statuses.length === 0)) return [];
  const params: unknown[] = [origins, tools];
  let statusClause = "";
  if (opts.statuses) {
    params.push(opts.statuses);
    statusClause = `AND status = ANY($${params.length}::text[])`;
  }
  params.push(REPLACED_DECIDE_CANDIDATE_LIMIT);
  const { rows } = await c.query<ReplacedDecideCandidate>(
    `SELECT id, workflow_id, tool_name, tool_args, impact, reason, status, origin, agent_name, requested_by, decided_by, decided_at, created_at,
            execution_status, executed_at, executed_by, execution_error, execution_result, execution_attempts
       FROM automation_approvals
      WHERE deleted_at IS NULL AND origin = ANY($1::text[]) AND tool_name = ANY($2::text[]) ${statusClause}
      ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}

/** The approver the decide route would check for this caller: the caller, and the person an act-for call acts for. */
function approverOf(principal: Principal): ApprovalApprover | null {
  if (!principal.userId) return null;
  return {
    userId: principal.userId,
    ...(principal.actFor?.userId ? { actForUserId: principal.actFor.userId } : {}),
    assurance: principal.assurance,
  };
}

/**
 * Of `rows` (ONE tenant's `automation_approvals` rows, read on `c`), the ids `principal` may decide under a replacement: the
 * question the decide route answers by id, asked for the page at once. Rows of any other origin or tool are skipped without a
 * query. Per qualifying tool: the entry's batched check (a few queries, `checkMany` per human in batches of 50). A principal
 * with no user id gets nothing (the decide route refuses it too). A throw propagates: the caller fails closed.
 */
export async function replacedDecidableIds(
  c: PoolClient,
  principal: Principal,
  rows: ReadonlyArray<{ id: string; origin: string; tool_name: string; tool_args: unknown }>,
): Promise<Set<string>> {
  const out = new Set<string>();
  const approver = approverOf(principal);
  if (!approver) return out;
  const tools = new Set(replacedDecideTools());
  const byTool = new Map<string, Array<{ id: string; tool_args: unknown }>>();
  for (const r of rows) {
    if (!REPLACED_DECIDE_ORIGINS.includes(r.origin) || !tools.has(r.tool_name)) continue;
    byTool.set(r.tool_name, [...(byTool.get(r.tool_name) ?? []), r]);
  }
  for (const [toolName, list] of byTool) {
    const entry = getExecutable(toolName);
    if (!entry) continue;
    const answers = await replacedDecideAllowedMany(c, entry, list.map((r) => toolArgsOf(r.tool_args)), approver);
    list.forEach((r, i) => {
      if (answers[i]) out.add(r.id);
    });
  }
  return out;
}
