// SM-04 — the metering ledger over `search_provider_calls` (design §05) + the month-to-date spend
// sums the stop-loss reads. The ledger is tenant-scoped (RLS, third wall); every write here runs on
// a connection that has declared the search module scope (either the critical-section connection
// from cache.ts, or withTenants([tenantId], { modules: ['search'] })).
//
// True-up (design §05/§11): a real dispatch is logged `posted` with the ESTIMATED cost at dispatch;
// completion UPDATEs that same row to `completed` with the trued-up actual cost — never inserts a
// second row. Cache hits are logged `completed`, cache_hit=true, cost 0 (savings visibility). A
// budget/scope refusal is logged `failed`, cost 0 (blocked-state visibility).
//
// SM-50 (design addendum §A11) adds a FOURTH status, `incurred`, and with it the one property this
// whole file must keep: EVERY MONEY SUM BELOW IS STATUS-BLIND. sumMonthToDate (the engagement and
// tenant tiers), GLOBAL_MTD_QUERY_SQL (the platform ceiling) and PROVIDER_MTD_QUERY_SQL (the
// per-provider ceiling) carry month + mode (+ engagement/provider) predicates and NO status
// predicate — as does the `search.provider_cost.month` exec rollup in modules/search/index.ts. That
// is not an accident to be tidied up: it is precisely why a vendor charge that delivered no data binds
// every budget tier and the exec rollup with zero changes to any query. Adding "AND status <>
// 'incurred'" anywhere here would silently exempt real deposit burn from the ceilings meant to bound
// it — the §4d fail-open class, and forbidden without a design gate (§A11.2 #1-#5). The only
// status-AWARE statement over this table is the generic true-up (`WHERE status = 'posted'`), which is
// deliberate and pinned: correcting an estimate on a DELIVERED call and reconciling an ORPHANED charge
// are different operations that keep different code paths (§A11.2 #7).
import type { PoolClient } from "pg";
import { newId, withGlobal, withTenants } from "../../../db";
import { config } from "../../../config";

/** SM-50 (addendum §A11.1.2) widens 0034's CHECK additively with `incurred` (migration 0053).
 *
 *  * `posted`    — dispatched; cost_usd is the pre-dispatch estimate.
 *  * `completed` — delivered (a cache hit, or a row trued up to a vendor-reported actual).
 *  * `failed`    — REFUSED, or failed BEFORE the vendor was engaged. INVARIANT, unchanged by SM-50
 *                  and the reason `incurred` had to exist at all: `failed => cost_usd = 0`, always.
 *  * `incurred`  — the vendor was engaged and confirmably CHARGED (standard-rate accounting, §A3) and
 *                  the platform RETAINS NO DATA for the charge. cost_usd > 0. Written by
 *                  recordIncurred() ONLY, in its own transaction, after the dispatch transaction has
 *                  already rolled back.
 *
 *                  SM-60 widens the PROSE of this one status, deliberately, and nothing else — no new
 *                  status, no CHECK change, no query change. §A11.1.2 wrote it as "no data was
 *                  DELIVERED", which covers only the vendor-side non-delivery SM-50 found. The second
 *                  shape (SM-60) is a charge whose data WAS delivered and whose own bookkeeping then
 *                  failed: the rollback discards the payload, the cache row and the ledger row together,
 *                  and the caller receives an error, so the platform retains exactly as little as in the
 *                  first shape. Every §A11.2 disposition is therefore identical — the money counts in
 *                  the status-blind sums, no deliverable/work row exists (§A11.2 #12: an incurred row is
 *                  money, never output), `vendor_ref` reconciles it against the vendor console (#13), and
 *                  the §A11.1.4 callback interlock can still advance it to `completed` at the SAME cost
 *                  if the data is retrieved later. The two shapes are distinguished by the `endpoint`
 *                  suffix (`.incurred_no_data` vs `.incurred_write_failed`) and by `dataDelivered` on the
 *                  emitted event — the same reason-in-the-endpoint convention `.scope_disabled` /
 *                  `.budget_blocked` / `.global_ceiling_unavailable` already use.
 *
 *  Encoding "charged but undelivered" as `failed` carrying cost was REJECTED by the ruling as an
 *  implicit semantic every consumer would have to know about and nothing would enforce (§A11.3). */
export type LedgerStatus = "posted" | "completed" | "failed" | "incurred";

export interface LedgerInsert {
  tenantId: string;
  engagementId: string | null;
  propertyId?: string | null;
  provider: string;
  endpoint: string;
  items: number;
  costUsd: number;
  cacheHit: boolean;
  status: LedgerStatus;
  requestedBy: string | null;
  correlationId?: string | null;
  /** SM-33 provenance (0047): true when the call was served by a simulated driver, or dispatched
   *  while the platform ran in `simulate` mode. The dollars on such a row are SYNTHETIC — every
   *  surface that renders spend must badge them (SM-38). Defaults to false (real), which is what
   *  every row written before 0047 asserts and what the live path keeps writing. Note the stop-loss
   *  deliberately does NOT exclude these rows from its month-to-date sums: routing simulation through
   *  the real choke-point is the point, so a simulated pull must still be able to exhaust a budget. */
  simulated?: boolean;
  /** SM-50 provenance for RECONCILIATION (0053, addendum §A11.1.4): the vendor's own id for this call
   *  — DataForSEO's task id. Stamped on `incurred` rows AND on successful rows wherever the driver
   *  exposes one (one column, both paths), because SM-41's staging reconciliation matches our ledger
   *  against the vendor console's line items on exactly this key: an incurred row is the reconciling
   *  entry for a console charge with no data row on our side. Absent (NULL) when the vendor exposes no
   *  per-call id — never defaulted to a placeholder. */
  vendorRef?: string | null;
}

/** Insert one ledger row on the given (already tenant+scope-bound) connection; returns its id. */
export async function insertLedgerRow(c: PoolClient, row: LedgerInsert): Promise<string> {
  const id = newId();
  await c.query(
    `INSERT INTO search_provider_calls
       (id, tenant_id, engagement_id, property_id, provider, endpoint, items, cost_usd, cache_hit, status, requested_by, correlation_id, origin_site, simulated, vendor_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      id, row.tenantId, row.engagementId, row.propertyId ?? null, row.provider, row.endpoint,
      row.items, row.costUsd, row.cacheHit, row.status, row.requestedBy, row.correlationId ?? null, config.originSite,
      row.simulated ?? false, row.vendorRef ?? null,
    ],
  );
  return id;
}

/** Month-to-date SUM(cost_usd) on THIS connection's tenant scope. Optionally filtered to one
 *  engagement. Uses the calendar month of now(); mirrors the search.provider_cost.month rollup.
 *
 *  SM-33 / addendum §A4.1 — MODE-FILTERED: `simulated` selects WHICH ledger this tier binds against.
 *  The two ledgers are disjoint, and the gates are identical:
 *    * simulate mode sums only simulated rows, so the stop-loss demo is the real choke-point doing
 *      real arithmetic on synthetic dollars (a budget cap must still refuse a simulated pull);
 *    * live mode sums only real rows, so a mode flip can neither refuse real clients for phantom
 *      dollars nor let a month of demo history mask real spend.
 *  Failure directions, deliberately: a wrong filter in SIMULATE mode under-counts synthetic spend
 *  (the demo lies; $0 real risk). A live-mode filter that wrongly INCLUDED simulated rows
 *  over-counts and refuses early — the fail-CLOSED direction. The only fail-open shape is live mode
 *  EXCLUDING real rows, which `simulated boolean NOT NULL DEFAULT false` (0047) forecloses: there is
 *  no NULL to make `simulated = false` go unknown, and every pre-0047 row was produced in live mode.
 *  Defaults to `false` (live) so every pre-SM-33 caller keeps its exact previous meaning. */
export async function sumMonthToDate(
  c: PoolClient,
  engagementId?: string | null,
  simulated = false,
): Promise<number> {
  const params: unknown[] = [simulated];
  const clauses = ["date_trunc('month', created_at) = date_trunc('month', now())", "simulated = $1"];
  if (engagementId) {
    params.push(engagementId);
    clauses.push(`engagement_id = $${params.length}`);
  }
  const r = await c.query<{ n: string }>(
    `SELECT COALESCE(sum(cost_usd), 0) AS n FROM search_provider_calls WHERE ${clauses.join(" AND ")}`,
    params,
  );
  return Number(r.rows[0].n);
}

/** Postgres `numeric` arrives over the wire as a STRING (node-pg does not lose precision silently),
 *  so every money column crossing an API boundary must be cast exactly once, here. Returning the raw
 *  string makes `typeof x === "number"` false downstream — a consumer calling `.toFixed()` on it
 *  throws at runtime, which is precisely how the SM-11 console broke at its architect review. */
export function moneyOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The exact SQL sumGlobalMonthToDate() runs, exported ONLY so a test can pin its shape (single
 *  scalar aggregate, no row-returning columns) without needing a live database — see
 *  ledger.test.ts. This is the ENFORCEMENT half of the lint-withtenants allowlist ratification
 *  (SM-04 architect review follow-up, 2026-07-28 gate): the ratification is conditional on this
 *  query staying read-only and aggregate-only forever, but lint-withtenants has zero SQL awareness
 *  — it only classifies the tenant-scoping call's first-argument SHAPE, never what the callback
 *  actually selects. A future edit that widened this to select rows (or added a second column) would sail
 *  past that lint silently; this constant + ledger.test.ts's shape assertion is what actually
 *  enforces the invariant the allowlist entry's prose only documents. */
// SM-33 / addendum §A4.1 amends this pinned shape DELIBERATELY (never worked around): the platform
// ceiling is mode-filtered like every other tier, so the query gains `AND simulated = $1`. What the
// ratification rests on is unchanged and still pinned by ledger.test.ts: ONE scalar aggregate
// column, read-only, no row-identifying or client-private column, single statement. The predicate is
// PARAMETERIZED, not interpolated — this string is the only cross-tenant SQL in the module and a
// string-built predicate here would be the place a future edit could smuggle something in.
export const GLOBAL_MTD_QUERY_SQL = `SELECT COALESCE(sum(cost_usd), 0) AS n FROM search_provider_calls
     WHERE date_trunc('month', created_at) = date_trunc('month', now()) AND simulated = $1`;

// Short TTL cache for the platform-wide ceiling (SM-04 architect review follow-up, 2026-07-28):
// this aggregate used to run on EVERY paid dispatch — BEFORE the cache critical section, so its
// cost lands even on pure cache hits — as two sequential pool checkouts (SELECT id FROM companies,
// then the cross-tenant SUM), with no supporting index (the table's only index leads with
// tenant_id; this query has no tenant_id predicate by definition, since it must sum ACROSS
// tenants). dispatch.ts already documents that evaluating this pre-lock accepts "a small race
// window" as coarse-by-design for a PLATFORM ceiling (not a per-client guardrail); a short cache is
// a strictly SMALLER relaxation of the same kind, not a new one — worst case the platform-wide cap
// is enforced against spend that is up to TTL-stale, on a cap whose whole purpose is a MONTHLY, not
// per-second, ceiling. Chosen over an index because it also removes the "two pool checkouts on the
// hot path" cost directly (an index would still pay both checkouts on every dispatch, just cheaper
// ones); a supporting expression index remains a worthwhile complementary follow-up for a
// senior-db ticket, just no longer an urgent one once this runs at most once per TTL window
// platform-wide instead of once per dispatch. In-process (not Redis-shared) deliberately: a
// multi-instance deployment simply re-evaluates independently every TTL window per instance, which
// is still a large reduction from "every dispatch" and proportionate to a $150/mo soft ceiling —
// not worth a shared-cache dependency.
const GLOBAL_MTD_CACHE_TTL_MS = 30_000;
// SM-33: keyed BY MODE. The two ledgers are disjoint (§A4.1), so one shared slot would let a flip
// serve the other mode's total for up to a TTL window — i.e. a live dispatch evaluated against
// simulated spend, which is the fail-open direction the mode filter exists to prevent.
const globalMtdCache = new Map<boolean, { value: number; expiresAt: number }>();

/** Test-only escape hatch: force the next sumGlobalMonthToDate() call to recompute rather than
 *  serve a cached value. Production code never calls this. */
export function resetGlobalMonthToDateCache(): void {
  globalMtdCache.clear();
}

/** Platform-wide month-to-date provider spend, for the global stop-loss ceiling. The ledger is
 *  RLS-scoped and the runtime role is NOBYPASSRLS, so we authorize the read for the FULL set of
 *  companies (readable — `companies` is no-RLS) and sum under the search module scope. Reads only
 *  an aggregate; touches no client-private column. Coarse by design (a platform ceiling, not a
 *  per-client guardrail) — computed just before dispatch; the small race window is acceptable, and
 *  the short TTL cache above (read first, below) is a strictly smaller version of that same
 *  acceptance, not a new relaxation.
 *
 *  SM-33 / §A4.1: mode-filtered like every other tier (see sumMonthToDate for the full
 *  failure-direction analysis) and TTL-cached PER MODE. Defaults to `false` (live). */
export async function sumGlobalMonthToDate(simulated = false): Promise<number> {
  const now = Date.now();
  const cached = globalMtdCache.get(simulated);
  if (cached && cached.expiresAt > now) return cached.value;

  const companies = await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM companies`));
  const ids = companies.rows.map((r) => r.id);
  let value = 0;
  if (ids.length > 0) {
    const r = await withTenants(ids, (c) => c.query<{ n: string }>(GLOBAL_MTD_QUERY_SQL, [simulated]), {
      modules: ["search"],
      // MON-00b: genuinely and correctly cross-root. This is the OPERATOR's vendor-spend
      // ceiling — one wallet paying one provider — so the sum must span every root or the cap
      // is not a cap. It returns a single scalar to us, never tenant rows to a caller, so there
      // is no audience for a cross-root read. Ratified in the 2026-08-20 boundary rulings
      // alongside the principal-less event relay; those two are the only opt-ins.
      crossRoot: { reason: "operator vendor-spend ceiling: one wallet, one provider, must sum across all roots" },
    });
    value = Number(r.rows[0].n);
  }
  globalMtdCache.set(simulated, { value, expiresAt: now + GLOBAL_MTD_CACHE_TTL_MS });
  return value;
}

/** The exact SQL sumProviderMonthToDate() runs, exported ONLY so a test can pin its shape without a
 *  live database — see ledger.test.ts, and the file-header note on GLOBAL_MTD_QUERY_SQL for why
 *  this constant exists at all (lint-withtenants has zero SQL awareness; this + the test is what
 *  actually enforces the read-only/aggregate-only invariant the SM-40 lint-withtenants allowlist
 *  entry's prose only documents).
 *
 *  SM-40 (design addendum §A3.5) — the per-provider tier of the stop-loss cascade
 *  (engagement -> tenant -> provider -> global). Structurally this is `GLOBAL_MTD_QUERY_SQL` with
 *  one more parameterized predicate: `AND provider = $2`. Same ratified shape rules apply — ONE
 *  scalar aggregate column, read-only, single statement, no row-identifying column in the
 *  PROJECTION (the WHERE clause legitimately references `provider`/`simulated`, which is the whole
 *  point of this tier — see ledger.test.ts for why the "no client-private column" assertion is
 *  scoped to the SELECT list, not the whole query string, for this constant). Both predicates are
 *  PARAMETERIZED, never interpolated, for the same reason as the mode predicate above: this string
 *  is cross-tenant SQL and a string-built predicate would be exactly the place a future edit could
 *  smuggle something in. Mode-filtered per §A4.1 like every other tier. */
export const PROVIDER_MTD_QUERY_SQL = `SELECT COALESCE(sum(cost_usd), 0) AS n FROM search_provider_calls
     WHERE date_trunc('month', created_at) = date_trunc('month', now()) AND simulated = $1 AND provider = $2`;

// SM-40: independent 30s TTL cache, same reasoning as GLOBAL_MTD_CACHE_TTL_MS above (this aggregate
// would otherwise run on every paid dispatch for a provider that HAS a configured cap, pre-lock,
// with no supporting index) — a strictly smaller relaxation on a MONTHLY ceiling, not a new kind of
// one. In-process, not Redis-shared, for the same proportionality argument as the global cache.
const PROVIDER_MTD_CACHE_TTL_MS = 30_000;
// Keyed by (provider, mode) — NOT provider alone. Exactly the SM-33 lesson the global cache already
// encodes: the two ledgers (simulated vs real) are disjoint, so a single slot per provider would let
// a mode flip serve the OTHER ledger's total for up to a TTL window — a live dispatch evaluated
// against simulated spend (or the reverse), which is the fail-open direction the mode filter exists
// to prevent. String-keyed (not a nested Map) because the key space is small (four provider keys x
// two modes) and a composite string key is simpler to reason about than a Map-of-Maps.
const providerMtdCache = new Map<string, { value: number; expiresAt: number }>();

function providerMtdCacheKey(providerKey: string, simulated: boolean): string {
  return `${providerKey}::${simulated}`;
}

/** Test-only escape hatch, mirroring resetGlobalMonthToDateCache(). Production code never calls this. */
export function resetProviderMonthToDateCache(): void {
  providerMtdCache.clear();
}

/** Platform-wide month-to-date spend for ONE provider, for the SM-40 per-provider ceiling. Same
 *  cross-tenant shape as sumGlobalMonthToDate (RLS-scoped ledger, NOBYPASSRLS runtime role, so the
 *  read is authorized for the FULL company set and summed under the search module scope), just
 *  filtered to `providerKey`. Coarse by design for the same reason as the global sum — computed
 *  pre-lock in dispatch.ts, the short TTL cache above is a strictly smaller version of that same
 *  acceptance. Mode-filtered + TTL-cached PER MODE (§A4.1); defaults to `false` (live). */
export async function sumProviderMonthToDate(providerKey: string, simulated = false): Promise<number> {
  const cacheKey = providerMtdCacheKey(providerKey, simulated);
  const now = Date.now();
  const cached = providerMtdCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;

  // SM-43: a NEW cross-tenant call in this file needs its OWN lint-withtenants allowlist entry —
  // deliberately not reusing sumGlobalMonthToDate's `ids` variable name, so this call cannot be
  // silently absorbed into that entry's match count (see scripts/lint-withtenants.mjs).
  const companies = await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM companies`));
  const companyIds = companies.rows.map((r) => r.id);
  let value = 0;
  if (companyIds.length > 0) {
    const r = await withTenants(
      companyIds,
      (c) => c.query<{ n: string }>(PROVIDER_MTD_QUERY_SQL, [simulated, providerKey]),
      {
        modules: ["search"],
        // MON-00b: same ratification as sumGlobalMonthToDate above, for the same reason — this is the
        // operator's per-PROVIDER spend against one vendor account, so a sum that stopped at a root
        // boundary would under-report the cap and let real spend past it. Returns a scalar, not rows.
        crossRoot: { reason: "operator per-provider spend ceiling: one vendor account, must sum across all roots" },
      },
    );
    value = Number(r.rows[0].n);
  }
  providerMtdCache.set(cacheKey, { value, expiresAt: now + PROVIDER_MTD_CACHE_TTL_MS });
  return value;
}

/** True-up a posted row to completed with the actual cost, on the GIVEN connection (design §05 /
 *  SM-42, design addendum §A8.7). Idempotent-ish: only a row still in 'posted' is advanced, so a
 *  double true-up (or a true-up after failure) is a no-op rather than a corruption. Moves the cost
 *  in EITHER direction — this is a CORRECTION of the pre-dispatch estimate, not a new decision, and
 *  in particular does NOT re-run evaluateBudget: the stop-loss already decided, against the estimate,
 *  before any money was spent, and the network call has already happened by the time a true-up value
 *  could even exist — re-deciding after the fact would be pointless (the vendor call already
 *  occurred) and would invent a new failure mode (retroactively "refusing" a client for a call that
 *  already cost real vendor money). Exposed as a raw-connection function (rather than only the
 *  tenant-scoping wrapper below) so dispatch.ts can call it ON THE SAME transaction as the row's own
 *  INSERT — the posted state is a bookkeeping fact recorded and then corrected atomically, never an
 *  externally observable intermediate state when the driver reports an actual cost. Returns whether a
 *  row was updated. */
export async function trueUpLedgerOnConnection(c: PoolClient, ledgerId: string, actualCostUsd: number): Promise<boolean> {
  const res = await c.query(
    `UPDATE search_provider_calls SET cost_usd = $2, status = 'completed'
       WHERE id = $1 AND status = 'posted'`,
    [ledgerId, actualCostUsd],
  );
  return (res.rowCount ?? 0) > 0;
}

/** True-up a posted row to completed with the actual cost (design §05), managing its own
 *  tenant-scoped connection. The general-purpose entry point — SM-41's future staging reconciliation
 *  and any manual/out-of-band true-up call this; dispatch.ts's automatic in-transaction true-up calls
 *  trueUpLedgerOnConnection directly instead (see its doc comment for why). Same semantics either
 *  way: idempotent-ish (only a 'posted' row advances), tenant-scoped (RLS on `c` forecloses reaching
 *  another tenant's row), never re-runs budget arithmetic. */
export async function trueUpLedger(tenantId: string, ledgerId: string, actualCostUsd: number): Promise<boolean> {
  return withTenants(
    [tenantId],
    (c) => trueUpLedgerOnConnection(c, ledgerId, actualCostUsd),
    { modules: ["search"] },
  );
}

/** Record a fail-closed refusal (scope or budget) as a cost-0 `failed` ledger row so the blocked
 *  attempt is visible in the usage panel. Its own tenant+scope transaction (the dispatch txn was
 *  rolled back). */
export async function recordBlocked(row: Omit<LedgerInsert, "status" | "costUsd" | "cacheHit">): Promise<string> {
  return withTenants(
    [row.tenantId],
    (c) => insertLedgerRow(c, { ...row, status: "failed", costUsd: 0, cacheHit: false }),
    { modules: ["search"] },
  );
}

/** SM-50 (design addendum §A11.1.1) — THE COMPENSATING WRITE. The vendor was engaged and confirmably
 *  charged, and the dispatch transaction (cache write + ledger row, atomic under the advisory locks)
 *  then rolled back and took any record of the charge with it — either because the call failed and
 *  delivered nothing (SM-50) or because the post-delivery writes themselves failed (SM-60). This records
 *  the charge in its OWN fresh, short transaction — the exact pattern `recordBlocked` above already
 *  establishes for a refusal whose dispatch transaction is gone.
 *
 *  WHY OUTSIDE, and why there was no third option: nothing written inside a rolled-back transaction
 *  can survive it, by definition. So the only candidates were this (write after the rollback) or
 *  write-ahead intent rows (commit a `posted` row BEFORE invoking the provider). Write-ahead was
 *  REJECTED for v1 (§A11.3): it dismantles SM-04's single-transaction atomicity, triples hot-path
 *  transactions, and buys only a crash-mid-poll window whose loss is bounded to cents and is caught by
 *  SM-41's monthly reconciliation. Its revisit trigger is recorded and binding: any driver whose
 *  SINGLE-OP incurred cost can exceed ~$1 (e.g. a bulk task_post batch) gets write-ahead for that
 *  driver before it ships.
 *
 *  The residual window this leaves is therefore stated rather than hidden: a process crash between the
 *  vendor's charge and this INSERT loses the row. That is the accepted v1 bound.
 *
 *  `cacheHit: false` is structural, not a default — a cache hit costs nothing and cannot be incurred.
 *  The CALLER (dispatch.ts) is responsible for wrapping this in the §4d secondary-failure guard so a
 *  failing audit write can never replace the provider error the caller is owed. */
export async function recordIncurred(
  row: Omit<LedgerInsert, "status" | "cacheHit">,
): Promise<string> {
  return withTenants(
    [row.tenantId],
    (c) => insertLedgerRow(c, { ...row, status: "incurred", cacheHit: false }),
    { modules: ["search"] },
  );
}

/** SM-50 (addendum §A11.1.4) — the RECONCILIATION seam for the SM-14 Standard-queue callback path.
 *
 *  When a task we already wrote off as `incurred` completes late and the callback finally retrieves
 *  its data, the honest bookkeeping is that ONE charge produced ONE row which has now delivered: the
 *  row advances `incurred -> completed` AT THE SAME COST. It must never become a second cost-bearing
 *  row for the same charge (that would double-count real money into every budget tier), and the
 *  callback must never re-POST a paid task to get there — `task_get` only.
 *
 *  Deliberately NOT folded into trueUpLedger*(), which stays `posted`-only: correcting an ESTIMATE on a
 *  delivered call and reconciling an ORPHANED charge are different operations, and this one changes no
 *  money at all. There is no cost parameter here, by design — a caller cannot re-price a charge while
 *  "reconciling" it.
 *
 *  Idempotent-ish in the same way as the true-up: only a row still in `incurred` advances, so a second
 *  callback for the same task is a no-op rather than a corruption. Returns whether a row advanced.
 *
 *  ✅ SM-56 WIRED IT. The seam note that stood here (a landed callback that re-ran the paid dispatch,
 *  because no driver-side task-id fetch existed) is discharged: `SearchDataProvider.fetchSerpByTaskId`
 *  is the collect surface, `rank.ts`'s `collectRankForTask` is its one caller, and it advances an
 *  `incurred` row through THIS function — never through a second dispatch, and never with a cost
 *  argument, because there is none to pass. The §A11.1.4 interlock is now enforced end to end.
 *
 *  ON-CONNECTION VARIANT, and why the collect uses it: `advanceIncurredToCompletedOnConnection` below
 *  runs the same UPDATE on a caller-supplied connection, so the collect can advance the row IN THE SAME
 *  TRANSACTION as the rank snapshot it just persisted. That matters for one specific reason: those two
 *  facts must become true together. A snapshot committed against a still-`incurred` row would claim the
 *  platform holds data for a charge the ledger simultaneously says delivered nothing — a contradiction
 *  a reader (or SM-41's reconciliation) would have to guess about. Atomic, so no such window exists.
 *  Exactly the split `trueUpLedger`/`trueUpLedgerOnConnection` above already establishes, for the same
 *  kind of reason. */
export async function advanceIncurredToCompleted(tenantId: string, ledgerId: string): Promise<boolean> {
  return withTenants(
    [tenantId],
    (c) => advanceIncurredToCompletedOnConnection(c, ledgerId),
    { modules: ["search"] },
  );
}

/** SM-56 — `advanceIncurredToCompleted` on a caller-supplied (already tenant+scope-bound) connection.
 *  See that function's doc comment for the semantics; they are identical, including the two properties
 *  that make this safe to call from a collect: there is NO cost parameter (a caller cannot re-price a
 *  charge while "reconciling" it), and the `status = 'incurred'` guard makes a duplicate advance a
 *  no-op rather than a corruption. Returns whether a row advanced. */
export async function advanceIncurredToCompletedOnConnection(c: PoolClient, ledgerId: string): Promise<boolean> {
  const res = await c.query(
    `UPDATE search_provider_calls SET status = 'completed'
       WHERE id = $1 AND status = 'incurred'`,
    [ledgerId],
  );
  return (res.rowCount ?? 0) > 0;
}

/** SM-50 — find a written-off charge by the vendor's own id, so the collect edge (and SM-41's
 *  reconciliation) can locate the row to advance without inventing a second one. Tenant-scoped: RLS on
 *  the connection forecloses reaching another tenant's row even if a forged callback supplied its
 *  vendor ref, which matters because a callback body is untrusted input by design (§02/§03 — a vendor
 *  postback carries a task id and is never trusted as data).
 *
 *  Returns the newest matching incurred row, or null. Newest rather than "the one" because a retry
 *  after an incurred failure legitimately produces two charges and two rows for the same subject
 *  (§A11.2, enumerated: ledger equals vendor truth, no deduplication is attempted) — though with
 *  DISTINCT vendor refs, so a same-ref pair should not arise.
 *
 *  ── SM-59 (tracker §6ai note 2) — THE PROVIDER PREDICATE, and why a `vendorRef` alone is not a key ──
 *  This matched `vendor_ref` + `status` and NOTHING ELSE, which quietly assumed that a `vendor_ref`
 *  value identifies a call. It does not: `vendor_ref` is whatever the VENDOR calls its own line item, so
 *  it is unique only WITHIN a vendor's namespace. Two providers can mint the same string — and the
 *  moment they do, a reconciliation for provider A can land on provider B's row inside the same tenant,
 *  advancing the wrong charge and telling SM-41's console reconciliation that B's orphan was collected.
 *  Wrong money attributed to the wrong vendor, silently, with a row that looks perfectly well-formed.
 *
 *  The senior-db review (§6ai) correctly classed this as an ACCEPTED SHAPE rather than a live defect,
 *  because today only DataForSEO stamps `vendor_ref` at all and its task ids are vendor-generated
 *  near-UUIDs — a collision needs a second stamping path to even be expressible. **SM-56 is that second
 *  path**, which is why these two land in one diff: the collect edge is the first code that looks a row
 *  up by vendor ref on the strength of a caller-supplied id, so the predicate stops being theoretical
 *  the same day. Fixed as the review specified — a `(vendor_ref, provider)` composite predicate,
 *  application-side, NO DDL.
 *
 *  INDEX JUDGEMENT (asked for explicitly, and the answer is "no change"): `ix_search_provider_calls_vendor_ref`
 *  is a partial index on `(vendor_ref) WHERE vendor_ref IS NOT NULL` (0053). It still serves this query
 *  well and needs no migration. `vendor_ref` remains the leading — and by far the most selective —
 *  column: it is a near-unique vendor id, so the index seek returns approximately one row, and Postgres
 *  then rechecks `provider` and `status` on that handful of heap tuples. Widening the index to
 *  `(vendor_ref, provider)` would add a second key column that eliminates essentially zero extra tuples,
 *  costing write amplification on an append-only hot-path table for no measurable read gain. Note also
 *  which direction the risk ran: the missing predicate was a CORRECTNESS bug, never a performance one —
 *  the index was already doing its job, it was the WHERE clause that under-specified the row. Adding an
 *  index would not have fixed it, and this predicate does not need one. */
export async function findIncurredByVendorRef(
  tenantId: string,
  provider: string,
  vendorRef: string,
): Promise<{ id: string; costUsd: number; provider: string } | null> {
  const r = await withTenants(
    [tenantId],
    (c) => c.query<{ id: string; cost_usd: string; provider: string }>(
      `SELECT id, cost_usd, provider FROM search_provider_calls
        WHERE vendor_ref = $1 AND provider = $2 AND status = 'incurred'
        ORDER BY created_at DESC LIMIT 1`,
      [vendorRef, provider],
    ),
    { modules: ["search"] },
  );
  const row = r.rows[0];
  return row ? { id: row.id, costUsd: Number(row.cost_usd), provider: row.provider } : null;
}

/** SM-56 — locate the PAID CALL a vendor postback refers to, whatever state its bookkeeping is in.
 *
 *  This is the collect edge's admission check, and it does two jobs at once. It finds the ledger row the
 *  new snapshot must be attributed to (`provider_call_id`), and — because it is the ONLY way in — it is
 *  what makes a forged or garbage task id cost nothing: no row means no vendor call is ever attempted,
 *  so an attacker cannot use this edge to make us spend, or even to make us open a socket.
 *
 *  ── Status-agnostic ON PURPOSE, and this is NOT the forbidden kind of status blindness ──────────────
 *  Deliberately DIFFERENT from `findIncurredByVendorRef` above, which is `incurred`-only. A postback can
 *  legitimately arrive for a call in either bookkeeping state, and both must be collectable:
 *    * `posted`   — the normal case. The post succeeded, the row records the charge at its estimate, and
 *                   the data simply had not arrived yet. Collecting changes NO money and NO status.
 *    * `incurred` — the post was charged and the dispatch then lost its record (SM-50/SM-60). Collecting
 *                   retrieves what was paid for, so the row advances `incurred -> completed` at the SAME
 *                   cost via `advanceIncurredToCompletedOnConnection` (§A11.1.4).
 *    * `completed`/`failed` — returned, and the CALLER decides. It does not filter them out here because
 *                   "no such task" and "that task's data is already collected" are different answers
 *                   that deserve different handling, and a lookup that collapsed them would force the
 *                   caller to guess.
 *  To be unambiguous about the standing prohibition in this file's header: that rule forbids adding a
 *  status predicate to a MONEY SUM, because it would exempt real spend from a ceiling. This is a
 *  single-row lookup that sums nothing and gates no budget, so it is neither an instance of that rule nor
 *  an exception to it. It is also, for the same reason, not a place a future edit should "optimize" by
 *  filtering to `posted`: an `incurred` row is exactly the case §A11.1.4 was written for.
 *
 *  Provider-scoped from birth (SM-59's predicate — see above for why a `vendor_ref` alone is not a key),
 *  tenant-scoped by RLS on the connection, newest-first for the same retry reason as `findIncurredByVendorRef`.
 *
 *  ── SM-63: it now also RETURNS THE ROW'S OWN SCOPE, and that widening is the whole fix ──────────────
 *  Until SM-63 this selected `id, status, cost_usd, provider, simulated` and nothing else. The omission
 *  had a consequence larger than a missing column: the collect edge physically COULD NOT compare the
 *  resolved row's `engagement_id`/`property_id` against the caller-supplied ones, because the data was
 *  never returned. So (tenant, provider, vendor_ref) was the entire admission test, and any engagement in
 *  the tenant could present any other engagement's task id — RLS forecloses the cross-TENANT shape and is
 *  structurally blind to the same-tenant one. `engagementId`/`propertyId` are now part of the contract so
 *  the comparison is expressible; `ledgerRowScopeMatches` below is the comparison, shared rather than
 *  re-hand-written at each call site (SM-62's planned collect sweep is the second one).
 *
 *  NOT a status predicate, NOT a money sum, and NOT scoped in SQL: this still selects one row by
 *  (vendor_ref, provider) and sums nothing, so the file-header prohibition is untouched. The scope is
 *  returned as DATA for the caller to judge, deliberately, rather than pushed into the WHERE clause —
 *  a lookup that filtered on the expected scope would return `null` for "wrong engagement" and could no
 *  longer tell a caller (or an operator reading a stack) apart from "no such task at all". The two answers
 *  are the same to the CALLER on purpose (see rank.ts), which is a property of the refusal, not of the
 *  query; conflating them here would also silently break `incurred-cost.test.ts`'s provider-collision
 *  probe, which looks a row up with no engagement in hand. */
export interface LedgerRowByVendorRef {
  id: string;
  status: LedgerStatus;
  costUsd: number;
  provider: string;
  simulated: boolean;
  /** The row's OWN scope — whose engagement and property actually paid for this vendor call. Nullable
   *  because 0034 declares both columns nullable (a non-property-bound op such as a `volume` pull logs
   *  a row with `property_id IS NULL`), never because "unknown means fine": see `ledgerRowScopeMatches`. */
  engagementId: string | null;
  propertyId: string | null;
}

export async function findLedgerRowByVendorRef(
  tenantId: string,
  provider: string,
  vendorRef: string,
): Promise<LedgerRowByVendorRef | null> {
  const r = await withTenants(
    [tenantId],
    (c) => c.query<{
      id: string; status: LedgerStatus; cost_usd: string; provider: string; simulated: boolean;
      engagement_id: string | null; property_id: string | null;
    }>(
      `SELECT id, status, cost_usd, provider, simulated, engagement_id, property_id
         FROM search_provider_calls
        WHERE vendor_ref = $1 AND provider = $2
        ORDER BY created_at DESC LIMIT 1`,
      [vendorRef, provider],
    ),
    { modules: ["search"] },
  );
  const row = r.rows[0];
  return row
    ? {
        id: row.id, status: row.status, costUsd: Number(row.cost_usd), provider: row.provider,
        simulated: row.simulated, engagementId: row.engagement_id, propertyId: row.property_id,
      }
    : null;
}

/** SM-63 — does this paid ledger row actually belong to the engagement/property a caller is claiming it
 *  for? The predicate a collect must satisfy before it may attribute anything to the row.
 *
 *  Exact equality on BOTH ids, and NULL on the row fails. That is the point rather than an oversight: a
 *  row whose scope is unknown cannot be evidence that THIS engagement paid for anything, and a Standard-
 *  queue SERP row always carries both ids (dispatch stamps them from the pull's own engagement/property).
 *  A NULL therefore means the caller is quoting a task id belonging to some other kind of call entirely —
 *  which is not a licence to proceed. Written as a shared predicate, not inline at the call site, for the
 *  same reason SM-61 centralized cadence parsing: the second call site (SM-62's stale-row collect sweep)
 *  must not be able to re-derive this rule slightly differently.
 *
 *  It answers only a boolean, and never which half disagreed — a caller-visible "engagement mismatch" vs
 *  "property mismatch" distinction would be an oracle over other engagements' task ids, and the way to
 *  not build one is to not produce the information. */
export function ledgerRowScopeMatches(
  row: Pick<LedgerRowByVendorRef, "engagementId" | "propertyId">,
  expected: { engagementId: string; propertyId: string },
): boolean {
  return row.engagementId === expected.engagementId && row.propertyId === expected.propertyId;
}
