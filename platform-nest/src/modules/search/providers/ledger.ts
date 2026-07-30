// SM-04 — the metering ledger over `search_provider_calls` (design §05) + the month-to-date spend
// sums the stop-loss reads. The ledger is tenant-scoped (RLS, third wall); every write here runs on
// a connection that has declared the search module scope (either the critical-section connection
// from cache.ts, or withTenants([tenantId], { modules: ['search'] })).
//
// True-up (design §05/§11): a real dispatch is logged `posted` with the ESTIMATED cost at dispatch;
// completion UPDATEs that same row to `completed` with the trued-up actual cost — never inserts a
// second row. Cache hits are logged `completed`, cache_hit=true, cost 0 (savings visibility). A
// budget/scope refusal is logged `failed`, cost 0 (blocked-state visibility).
import type { PoolClient } from "pg";
import { newId, withGlobal, withTenants } from "../../../db";
import { config } from "../../../config";

export type LedgerStatus = "posted" | "completed" | "failed";

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
}

/** Insert one ledger row on the given (already tenant+scope-bound) connection; returns its id. */
export async function insertLedgerRow(c: PoolClient, row: LedgerInsert): Promise<string> {
  const id = newId();
  await c.query(
    `INSERT INTO search_provider_calls
       (id, tenant_id, engagement_id, property_id, provider, endpoint, items, cost_usd, cache_hit, status, requested_by, correlation_id, origin_site, simulated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      id, row.tenantId, row.engagementId, row.propertyId ?? null, row.provider, row.endpoint,
      row.items, row.costUsd, row.cacheHit, row.status, row.requestedBy, row.correlationId ?? null, config.originSite,
      row.simulated ?? false,
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
    const r = await withTenants(ids, (c) => c.query<{ n: string }>(GLOBAL_MTD_QUERY_SQL, [simulated]), { modules: ["search"] });
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
      { modules: ["search"] },
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
