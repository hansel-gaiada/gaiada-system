// AIP-04 — `assistant_threads.total_cost_usd`, derived from the usage record.
//
// HOW IT IS MAINTAINED, AND WHY NOT LIKE total_tokens
// `total_tokens` is incremented by each reply's own figure inside persistGenerationOutcome. A cost cannot be: a reply's cost is the provider's
// figure OR the price table's, and the table's is computed by the usage writer (ai-usage/prices.ts) AFTER the reply is already persisted. So the
// thread's cost is DERIVED from `ai_usage_events` by thread_id, right after each usage row is written: the sum of every row of the thread that
// has a cost (replies and compactions alike, so the thread's cost is everything the thread spent through platform-nest). One statement that
// recomputes from the rows is idempotent and cannot drift from them under concurrent writes the way an increment could.
//
//   * Unknown is not zero: rows with no cost contribute nothing, and a thread with no costed row is left as it is (the column's default 0).
//   * The column is numeric(12,6); the usage rows are numeric(14,8), so the sum is rounded to 6 places.
//   * updated_at is NOT touched (the thread rail orders by it; a cost refresh is not activity).
//   * Never throws and is never awaited on a hot path: a failure leaves the previous total.
import { withTenants } from "../../db";

export const REFRESH_THREAD_COST_SQL =
  `UPDATE assistant_threads t
      SET total_cost_usd = round(s.total, 6)
     FROM (SELECT sum(cost_usd) AS total FROM ai_usage_events WHERE tenant_id = $1 AND thread_id = $2 AND cost_usd IS NOT NULL) s
    WHERE t.id = $2 AND t.tenant_id = $1 AND s.total IS NOT NULL AND t.total_cost_usd IS DISTINCT FROM round(s.total, 6)`;

export interface ThreadCostDeps {
  withTenants?: typeof withTenants;
}

/** Recompute the thread's total cost from its usage rows. Never throws. */
export async function refreshThreadCost(tenantId: string, threadId: string, deps: ThreadCostDeps = {}): Promise<void> {
  try {
    await (deps.withTenants ?? withTenants)([tenantId], (c) => c.query(REFRESH_THREAD_COST_SQL, [tenantId, threadId]), { modules: ["assistant"] });
  } catch {
    // The previous total stands; the usage rows are the record.
  }
}
