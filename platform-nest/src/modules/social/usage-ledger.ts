// SMM-22 — X metering: the `social_usage_ledger` read/write surface and design D-9's three-tier
// stop-loss arithmetic (engagement -> tenant -> global, fail-closed).
//
// Design: docs/blueprints/smm-design-addendum-2026-08-12.md (D-9, D-14, D-17), smm-design.md §05.
// Schema: migrations/0105_module_social.sql, `social_usage_ledger` (line ~582's own header —
// APPEND-ONLY, checked at ONE choke-point before dispatch AND re-checked inside the D14 execution
// precondition). Mirrors `modules/search/providers/ledger.ts` byte-for-byte where the shape
// transfers (design's own words: "byte-for-byte the SEO pattern") and departs deliberately where
// social's own architecture already differs — see each function's own note.
//
// ── WHAT "APPEND-ONLY" MEANS HERE, PRECISELY (read before "fixing" the UPDATEs below) ─────────────
// Nothing here ever DELETEs a row or re-inserts a second row for the same spend. `status` only ever
// moves forward — `posted -> completed` or `posted -> failed` — and a `failed` row's `cost_usd` is
// ALWAYS 0 (an invariant enforced by `markUsageLedgerFailed`, never a caller-supplied value): a
// spend that did not happen must not consume a client's cap. This is the exact same "append-only,
// but the row's OWN status/cost still trues up" idiom `search/providers/ledger.ts`'s header
// documents for `search_provider_calls` — `cost_usd`'s own column comment
// ("estimated at dispatch, trued-up on completion") requires precisely this kind of UPDATE.
//
// ── WHY X's TRUE-UP MOVES STATUS, NOT AMOUNT (unlike search's) ─────────────────────────────────────
// Search's true-up corrects the ESTIMATE to a vendor-reported ACTUAL cost, because a SERP call's
// real price can differ from its estimate. X's per-post price is FLAT (design §05: a fixed rate
// depending on link presence) — there is no "actual, different from the estimate" figure X ever
// reports back to us. So for `x_post`, the only fact left to true up is WHETHER THE POST ACTUALLY
// WENT OUT: `dispatch.ts` calls `markUsageLedgerFailed` synchronously the instant it already knows
// the network call did not land (nothing to true up later); `post-status-sync-job.ts`'s existing
// authoritative reconcile sweep calls `markUsageLedgerCompleted`/`markUsageLedgerFailed` for the
// residual "we don't yet know" window. Never `markUsageLedgerFailed` with a nonzero cost, and never
// a second ledger row for the same dispatch attempt.
import type { PoolClient } from "pg";
import { newId, withGlobal, withTenants } from "../../db";
import { config } from "../../config";
import { declareSocialModuleScope } from "./module-scope";
import type { XPricing } from "./media-rules";

export type UsageLedgerKind = "x_post" | "ai_image" | "ai_video" | "ai_cloud_text";
export type UsageLedgerStatus = "posted" | "completed" | "failed";

export interface UsageLedgerInsert {
  tenantId: string;
  engagementId: string | null;
  accountId?: string | null;
  kind: UsageLedgerKind;
  refId?: string | null;
  items?: number;
  costUsd: number;
  status: UsageLedgerStatus;
  requestedBy: string | null;
  correlationId?: string | null;
}

/** Insert one ledger row on the GIVEN (already tenant+module-scope-bound) connection. Returns its
 *  id. Never called directly by a dispatch caller for the METERED path — see `reserveUsageSpend`,
 *  which is the one place a `posted` row is created for a real dispatch attempt; exported mainly so
 *  a future `ai_cloud_text`/generative kind (D-17: inert in v1, nothing writes them yet) has a
 *  single insert path to reuse rather than growing a second one. */
export async function insertUsageLedgerRow(c: PoolClient, row: UsageLedgerInsert): Promise<string> {
  const id = newId();
  await c.query(
    `INSERT INTO social_usage_ledger
       (id, tenant_id, engagement_id, account_id, kind, ref_id, items, cost_usd, status, requested_by, correlation_id, origin_site)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      id, row.tenantId, row.engagementId, row.accountId ?? null, row.kind, row.refId ?? null,
      row.items ?? 1, row.costUsd, row.status, row.requestedBy, row.correlationId ?? null, config.originSite,
    ],
  );
  return id;
}

/** Month-to-date SUM(cost_usd) on THIS connection's tenant scope, optionally narrowed to one
 *  engagement. `status <> 'failed'` mirrors the EXISTING engagement-tier read SMM-09 shipped in
 *  `publish-precondition.ts` (kept for continuity, not reintroduced) — redundant with the
 *  `failed => cost_usd = 0` invariant above but harmless, and removing an already-shipped predicate
 *  without a reason is its own kind of risk. Caller must have already called
 *  `declareSocialModuleScope(c)` on this connection (same convention `evaluatePublishPrecondition`
 *  and `dispatchApprovedPublish` already use: declare once per transaction, not once per read). */
export async function sumUsageMonthToDate(c: PoolClient, engagementId?: string | null): Promise<number> {
  const params: unknown[] = [];
  const clauses = ["status <> 'failed'", "date_trunc('month', created_at) = date_trunc('month', now())"];
  if (engagementId) {
    params.push(engagementId);
    clauses.push(`engagement_id = $${params.length}`);
  }
  const r = await c.query<{ n: string }>(
    `SELECT coalesce(sum(cost_usd), 0)::text AS n FROM social_usage_ledger WHERE ${clauses.join(" AND ")}`,
    params,
  );
  return Number(r.rows[0]?.n ?? 0);
}

// ── THE GLOBAL TIER — a per-tenant FAN-OUT, never a single cross-tenant withTenants() call ────────
//
// `scripts/lint-withtenants.mjs`'s own header names the two ways a genuinely cross-tenant read may
// exist: an architect-ratified `crossRoot` allowlist entry (search's own `sumGlobalMonthToDate`
// takes this route), or — its own stated PREFERENCE — "refactor into a per-tenant fan-out of
// single-element calls the way service-assignments.controller.ts's envelope endpoints do." This
// ticket has no architect-ratified allowlist entry to spend, so it takes the preferred route: one
// single-element `withTenants([id], ...)` per company, summed in JS. Every call below is therefore
// invisible to the lint (each is exactly the single-tenant shape every other call in this module
// already uses) — nothing to allowlist, nothing to drift.
//
// TTL-cached for the same reason search's global sum is: this would otherwise run N queries on
// EVERY metered dispatch. 30s (matching search's own GLOBAL_MTD_CACHE_TTL_MS) accepts a small,
// stated race window on a ceiling whose purpose is a MONTHLY, not per-second, guard.
const GLOBAL_USAGE_MTD_CACHE_TTL_MS = 30_000;
let globalUsageMtdCache: { value: number; expiresAt: number } | null = null;

/** Test-only escape hatch, mirroring `search/providers/ledger.ts`'s
 *  `resetGlobalMonthToDateCache`. Production code never calls this. */
export function resetGlobalUsageMonthToDateCache(): void {
  globalUsageMtdCache = null;
}

export async function sumGlobalUsageMonthToDate(): Promise<number> {
  const now = Date.now();
  if (globalUsageMtdCache && globalUsageMtdCache.expiresAt > now) return globalUsageMtdCache.value;

  const companies = await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM companies`));
  let total = 0;
  for (const row of companies.rows) {
    total += await withTenants([row.id], (c) => sumUsageMonthToDate(c), { modules: ["social"] });
  }
  globalUsageMtdCache = { value: total, expiresAt: now + GLOBAL_USAGE_MTD_CACHE_TTL_MS };
  return total;
}

// ── THE PURE ARITHMETIC ─────────────────────────────────────────────────────────────────────────

export type UsageBudgetTier = "engagement" | "tenant" | "global";
export type UsageBudgetDecision = { ok: true } | { ok: false; tier: UsageBudgetTier };

/** Pure stop-loss arithmetic, evaluated engagement -> tenant -> global (first breach wins). A tier
 *  with a null cap (no tenant cap configured — the global cap always has one, see config.ts) is
 *  SKIPPED, matching search's own evaluateBudget convention exactly. A non-finite cap or MTD sum
 *  (a corrupted column, an unparseable config value that somehow slipped past config.ts's own
 *  boot-time guard) fails CLOSED at that tier rather than reading as "unlimited". */
export function evaluateUsageBudget(inputs: {
  estimate: number;
  engagementCap: number;
  engagementMtd: number;
  tenantCap: number | null;
  tenantMtd: number;
  globalCap: number;
  globalMtd: number;
}): UsageBudgetDecision {
  const tiers: Array<{ tier: UsageBudgetTier; cap: number | null; mtd: number }> = [
    { tier: "engagement", cap: inputs.engagementCap, mtd: inputs.engagementMtd },
    { tier: "tenant", cap: inputs.tenantCap, mtd: inputs.tenantMtd },
    { tier: "global", cap: inputs.globalCap, mtd: inputs.globalMtd },
  ];
  for (const t of tiers) {
    if (t.cap === null) continue;
    if (!Number.isFinite(t.cap) || !Number.isFinite(t.mtd) || t.mtd + inputs.estimate > t.cap) {
      return { ok: false, tier: t.tier };
    }
  }
  return { ok: true };
}

/** X's per-post price, resolved from config. `null` when either half is unset — see
 *  `config.social.usage`'s own header for why neither may default. */
export function resolveXPricing(): XPricing | null {
  const { xPerPostCostUsd, xPerPostWithLinkCostUsd } = config.social.usage;
  if (xPerPostCostUsd == null || xPerPostWithLinkCostUsd == null) return null;
  return { perPostUsd: xPerPostCostUsd, perPostWithLinkUsd: xPerPostWithLinkCostUsd };
}

// ── THE RESERVATION — the ledger's own "ONE choke-point before dispatch" ───────────────────────────

/** A distinct advisory-lock namespace from `APPROVAL_EXEC_LOCK_NS` (approval-execute.ts) and from
 *  `PIPELINE_RUN_LOCK_NS` — this is a MONEY lock, not a publish-mechanics lock, and it is keyed on
 *  the ENGAGEMENT (the unit money is budgeted against), never the variant (the unit publish
 *  mechanics serialize against). Two different variants on the SAME engagement dispatching
 *  concurrently MUST serialize here — that is precisely the race design's own ledger header names
 *  ("an approval sits between the estimate and the spend, and another post may consume budget in
 *  that window") — while two variants on DIFFERENT engagements must not block each other. */
export const SOCIAL_USAGE_LEDGER_LOCK_NS = 0x534d0001; // 'SM' — SMM-22 usage-ledger reservation

export type UsageReservationResult = { ok: true; ledgerId: string } | { ok: false; tier: UsageBudgetTier };

/**
 * THE RESERVATION. Takes the per-ENGAGEMENT money lock, re-sums all three tiers ONE LAST TIME under
 * it, and — only if still within budget — inserts the `posted` ledger row for the ESTIMATE, all in
 * ONE transaction. The row becomes visible to any OTHER concurrent reservation's re-sum the instant
 * this commits, and the lock forces that other reservation to wait for it rather than reading a
 * stale sum — this is what actually closes the TOCTOU race a single precondition check cannot.
 *
 * MUST be called BEFORE the network call and the lock MUST be released (this function's own
 * transaction committed) well before `schedulePost` is ever invoked — `dispatch.ts`'s own
 * "never hold a lock across network I/O" rule (approval-execute.ts's TRANSACTION BOUNDARY note)
 * applies here exactly as it does to the variant lock.
 *
 * On a lost race (`{ok:false}`), NO row is written — the reservation simply never happened, and the
 * caller must never call `schedulePost` for this attempt.
 */
export async function reserveUsageSpend(
  tenantId: string,
  engagementId: string,
  estimateUsd: number,
  engagementCapUsd: number,
  row: Pick<UsageLedgerInsert, "accountId" | "kind" | "refId" | "requestedBy" | "correlationId">,
): Promise<UsageReservationResult> {
  return withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    await c.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [SOCIAL_USAGE_LEDGER_LOCK_NS, engagementId]);

    const engagementMtd = await sumUsageMonthToDate(c, engagementId);
    const tenantMtd = await sumUsageMonthToDate(c);
    // Cross-tenant, computed under the lock but on a SEPARATE connection (see that function's own
    // header) — a small added latency while the engagement lock is held, the same trade-off
    // `evaluatePublishPrecondition`'s several sequential reads already accept.
    const globalMtd = await sumGlobalUsageMonthToDate();

    const decision = evaluateUsageBudget({
      estimate: estimateUsd,
      engagementCap: engagementCapUsd, engagementMtd,
      tenantCap: config.social.usage.tenantMonthlyCapUsd, tenantMtd,
      globalCap: config.social.usage.globalMonthlyCapUsd, globalMtd,
    });
    if (!decision.ok) return { ok: false as const, tier: decision.tier };

    const ledgerId = await insertUsageLedgerRow(c, {
      ...row, tenantId, engagementId, costUsd: estimateUsd, status: "posted",
    });
    return { ok: true as const, ledgerId };
  });
}

/** ON-CONNECTION variant — runs the release on a CALLER-SUPPLIED (already tenant+scope-bound)
 *  connection, mirroring search's `trueUpLedgerOnConnection`/`trueUpLedger` split. Used by
 *  `post-status-sync-job.ts`'s reconcile so the ledger release and the variant's own authoritative
 *  status flip land in ONE transaction — the same reason `advanceIncurredToCompletedOnConnection`
 *  exists in search's ledger.ts. `cost_usd` moves to 0 in the SAME statement (this file's own
 *  invariant), never left nonzero on a failed row. Idempotent-ish: only a row still `posted`
 *  advances. Returns whether a row was updated. */
export async function markUsageLedgerFailedOnConnection(c: PoolClient, ledgerId: string): Promise<boolean> {
  const res = await c.query(
    `UPDATE social_usage_ledger SET status = 'failed', cost_usd = 0 WHERE id = $1 AND status = 'posted'`,
    [ledgerId],
  );
  return (res.rowCount ?? 0) > 0;
}

/** ON-CONNECTION variant of the completion true-up — see `markUsageLedgerFailedOnConnection`'s doc
 *  for why an on-connection form exists at all. */
export async function markUsageLedgerCompletedOnConnection(c: PoolClient, ledgerId: string): Promise<boolean> {
  const res = await c.query(
    `UPDATE social_usage_ledger SET status = 'completed' WHERE id = $1 AND status = 'posted'`,
    [ledgerId],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Release a reservation that did NOT actually spend money — the network call failed, or never ran
 *  at all. Managed-connection entry point; `dispatch.ts`'s own synchronous failure path calls this
 *  (it has no other open transaction to piggyback on at that point — the network call already
 *  happened outside any transaction, per this module's own "never hold a lock across network I/O"
 *  rule). See `markUsageLedgerFailedOnConnection` for the semantics. */
export async function markUsageLedgerFailed(tenantId: string, ledgerId: string): Promise<boolean> {
  return withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    return markUsageLedgerFailedOnConnection(c, ledgerId);
  });
}

/** True-up a reservation to CONFIRMED — the post is authoritatively known to have gone out. Moves
 *  status only; X's cost is flat, so there is no amount to correct (see this file's header).
 *  Managed-connection entry point; see `markUsageLedgerCompletedOnConnection` for the semantics. */
export async function markUsageLedgerCompleted(tenantId: string, ledgerId: string): Promise<boolean> {
  return withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    return markUsageLedgerCompletedOnConnection(c, ledgerId);
  });
}

/** Find a variant's own `posted` reservation row, if one exists — the reconcile job's own lookup so
 *  it can true up the SAME row `dispatch.ts`'s reservation created, never a second one. At most one
 *  such row can exist per variant in the ordinary flow (a variant is dispatched at most once —
 *  SMM-10's own one-shot approval consumption); `ORDER BY created_at DESC LIMIT 1` is defensive
 *  rather than load-bearing. */
export async function findPostedLedgerRowByRefId(c: PoolClient, refId: string): Promise<{ id: string } | null> {
  const { rows } = await c.query<{ id: string }>(
    `SELECT id FROM social_usage_ledger WHERE ref_id = $1 AND status = 'posted' ORDER BY created_at DESC LIMIT 1`,
    [refId],
  );
  return rows[0] ?? null;
}

// ── THE USAGE PANEL'S OWN READ ──────────────────────────────────────────────────────────────────

export interface UsageSnapshot {
  engagement: { mtdUsd: number; capUsd: number };
  tenant: { mtdUsd: number; capUsd: number | null };
  global: { mtdUsd: number; capUsd: number };
  warnRatio: number;
}

/** Read-only snapshot of all three tiers for the usage panel. No lock — this is DISPLAY data, not a
 *  money decision, so staleness of a few seconds is the correct trade (the same one the global
 *  cache already accepts). Caller must have already declared the module scope on `c`. */
export async function readUsageSnapshot(
  c: PoolClient,
  engagementId: string,
  engagementCapUsd: number,
): Promise<UsageSnapshot> {
  const engagementMtd = await sumUsageMonthToDate(c, engagementId);
  const tenantMtd = await sumUsageMonthToDate(c);
  const globalMtd = await sumGlobalUsageMonthToDate();
  return {
    engagement: { mtdUsd: engagementMtd, capUsd: engagementCapUsd },
    tenant: { mtdUsd: tenantMtd, capUsd: config.social.usage.tenantMonthlyCapUsd },
    global: { mtdUsd: globalMtd, capUsd: config.social.usage.globalMonthlyCapUsd },
    warnRatio: config.social.usage.budgetWarnRatio,
  };
}
