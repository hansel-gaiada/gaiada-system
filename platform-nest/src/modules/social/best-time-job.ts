// SMM-27 — `runBestTimePull`: the nightly sweep that recomputes and caches
// `social_best_time_suggestions` for every connected account, from `best-time.ts`'s classical stats.
// SHAPE mirrors `metrics-job.ts`/`inbox-triage-job.ts` deliberately: `withGlobal` for the tenant
// list, per-tenant `withTenants([tenantId])` (via `best-time.ts`'s own declared-scope calls),
// per-tenant errors caught and logged so one bad tenant/account can never abort the sweep for every
// other tenant, counts returned and logged. Dark by default, env-gated via `config.social.bestTime`
// (SMM-38a's parallel-worktree lock on `config.ts` that made `metrics-job.ts` read raw
// `process.env` is long resolved — this file uses `config.ts` directly, like `inbox-triage-job.ts`
// does).
//
// Runs AFTER `metrics-job.ts`'s own nightly pull in practice (both are daily; this sweep simply
// reads whatever `social_post_metrics` currently holds, so an out-of-order run is not a correctness
// bug — it would just compute over slightly staler numbers until the next tick, never over
// mismatched/partial ones, since `social_post_metrics` rows are themselves atomic per-post appends).
import { withGlobal, withTenants } from "../../db";
import { declareSocialModuleScope } from "./module-scope";
import { computeAccountBestTime, applyBestTimeSuggestion } from "./best-time";
import { config } from "../../config";

interface ConnectedAccountIdRow {
  id: string;
}

async function loadConnectedAccountIds(tenantId: string): Promise<string[]> {
  return withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    const { rows } = await c.query<ConnectedAccountIdRow>(
      `SELECT id FROM social_accounts WHERE status = 'connected' AND deleted_at IS NULL`,
    );
    return rows.map((r) => r.id);
  });
}

/** One tenant's sweep: recompute + upsert every connected account's suggestion. A single account's
 *  failure (a bad row, a driver error) is caught and logged so it cannot block the rest of the
 *  tenant's accounts, mirroring `pullTenantMetrics`'s per-account isolation. */
export async function pullTenantBestTime(tenantId: string, now: Date = new Date()): Promise<{ accounts: number; suggested: number; insufficientEvidence: number; unsupported: number; errors: number }> {
  const accountIds = await loadConnectedAccountIds(tenantId);
  let suggested = 0;
  let insufficientEvidence = 0;
  let unsupported = 0;
  let errors = 0;

  for (const accountId of accountIds) {
    try {
      const result = await computeAccountBestTime(tenantId, accountId, now);
      await applyBestTimeSuggestion(tenantId, accountId, result);
      if (result.status === "suggested") suggested += 1;
      else if (result.status === "insufficient_evidence") insufficientEvidence += 1;
      else unsupported += 1;
    } catch (err) {
      errors += 1;
      // eslint-disable-next-line no-console
      console.error(`[SOCIAL-BEST-TIME] account ${accountId} (tenant ${tenantId}) failed:`, (err as Error).message);
    }
  }

  return { accounts: accountIds.length, suggested, insufficientEvidence, unsupported, errors };
}

/** Sweep every tenant. Mirrors `runMetricsPull`/`runInboxRetentionPurge` verbatim: `withGlobal` for
 *  the company list, per-tenant failures logged and swallowed. */
export async function runBestTimePull(now: Date = new Date()): Promise<{
  tenants: number; accounts: number; suggested: number; insufficientEvidence: number; unsupported: number; errors: number;
}> {
  const { rows: tenants } = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL`),
  );
  let accounts = 0;
  let suggested = 0;
  let insufficientEvidence = 0;
  let unsupported = 0;
  let errors = 0;
  for (const { id: tenantId } of tenants) {
    try {
      const r = await pullTenantBestTime(tenantId, now);
      accounts += r.accounts;
      suggested += r.suggested;
      insufficientEvidence += r.insufficientEvidence;
      unsupported += r.unsupported;
      errors += r.errors;
    } catch (err) {
      errors += 1;
      // eslint-disable-next-line no-console
      console.error(`[SOCIAL-BEST-TIME] tenant ${tenantId} failed:`, (err as Error).message);
    }
  }
  return { tenants: tenants.length, accounts, suggested, insufficientEvidence, unsupported, errors };
}

/** Daily loop. Only started by main.ts when `config.social.bestTime.enabled` is true (dark by
 *  default) — see the module contract's own header for the exact line to add; this file is
 *  deliberately not one of the files this ticket may edit. */
export function startBestTimePullLoop(intervalMs: number): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const result = await runBestTimePull();
      // eslint-disable-next-line no-console
      console.log("[SOCIAL-BEST-TIME] sweep run:", result);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[SOCIAL-BEST-TIME] tick failed:", (err as Error).message);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  void tick();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
