// SM-04 — THE dispatch choke-point (design §05/§11). Every paid provider pull in the search module
// goes through dispatchProviderOp(); there is no other path to spend money. It is fail-closed and,
// in ONE place, enforces the ordered stop-loss:
//
//   (0) SCOPE  — the op's tool_scope toggle must be enabled, else refuse NAMING the toggle,
//                regardless of budget or provider availability.
//   (1) BUDGET — month-to-date SUM(cost_usd) + this op's estimate vs, in order:
//                  engagement provider_budget_usd -> tenant monthly cap -> PROVIDER monthly cap
//                  (SM-40) -> global platform cap.
//                Any breach refuses, emits search.provider.budget_threshold (also a warn at 80%),
//                and records the blocked state in the ledger. Manual override (search:provider:admin,
//                audited by the CALLER) proceeds past a breach but still emits an audit event.
//
// SM-40 (design addendum §A3.5) — the PROVIDER tier protects a prepaid vendor's (Semrush, Ahrefs)
// shared subscription allowance: the ERP's config'd cap is its RESERVED SHARE of that allowance in
// amortized USD (config.ts computes it; default 50%, env-tunable per vendor), because the other
// share belongs to the team's own interactive use of the same paid console, which this platform
// cannot observe and must not starve by exhausting the whole allowance itself. For DataForSEO
// (genuinely pay-as-you-go) the same tier bounds real cash directly — an operator-set deposit-burn
// ceiling. It is a CROSS-TENANT aggregate exactly like the global tier below (same ledger, filtered
// to one provider instead of none), computed pre-lock the same way and for the same reason, and it
// fails CLOSED on the identical §4d reasoning: an uncomputable provider sum must refuse, never
// degrade to $0 (which would silently disarm the one tier standing between a misconfigured
// engagement and overrunning the humans' interactive share of a shared paid subscription). A
// provider with no configured cap (config.search.providerMonthlyCapUsd[key] == null) skips this
// tier ENTIRELY — the sum is never even attempted, so an unconfigured cap can never itself become a
// refusal reason.
//
// SM-33 (simulation provenance, addendum §A4): dispatch is ALSO the single place that stamps whether
// a call's data and dollars are synthetic. `simulated` = the resolved driver's own marker OR the
// platform's `providerMode`, and that ONE value drives four things that must never disagree: the
// ledger row's provenance column (including the fail-closed refusal rows), the cache row's column,
// the `simulated = <mode>` predicate on the cache READ, and the same predicate on BOTH budget
// month-to-date sums. Simulation changes NOTHING about the gates: a simulated pull passes the same
// pillar/scope/ceiling/budget checks against the simulated ledger, so a budget cap still refuses it —
// the demo is the real choke-point doing real arithmetic. The two mode predicates (§A4.1/§A4.2) are
// the review focus of this ticket's gate: a missed predicate here is the §4d fail-open class.
//
// Money-safety concurrency (the opus flag): the miss->dispatch->cache-write->ledger-write sequence
// runs inside runInCacheCriticalSection — one transaction, engagement + cache-key advisory locks
// held across the whole thing. So N identical concurrent queries dispatch EXACTLY ONCE (the rest
// find the row the first committed and log a cache hit), and the cache write + ledger posted-row are
// atomic. True-up (posted -> completed with the actual cost) UPDATEs the same row.
//
// SM-42 (design addendum §A8.7): when the resolved driver implements the OPTIONAL
// SearchDataProvider.takeActualCostUsd(), dispatch wraps the ONE invokeProvider() call in
// withActualCostCapture() and, if a value comes back, true-ups the row it JUST inserted — in the
// SAME transaction, immediately — from its pre-dispatch ESTIMATE to that ACTUAL figure, in EITHER
// direction. This never re-runs evaluateBudget: the stop-loss already decided against the estimate,
// before the critical section even opened the network call, and by the time an actual cost could
// exist the vendor call has already happened — re-deciding afterward would be pointless and would
// invent a new failure mode (see ledger.ts's trueUpLedgerOnConnection doc comment for the full
// argument). A driver with no takeActualCostUsd (DataForSEO's flat published price, every simulator)
// simply never triggers this path; the row stands at its estimate exactly as before SM-42.
//
// SM-50 (design addendum §A11, tracker §6x.2/§6w): the sequence above is atomic, which was itself the
// fail-open. A provider exception fires INSIDE the critical section's transaction, BEFORE
// insertLedgerRow, so the rollback takes any record of the call with it — correct before the vendor was
// engaged, WRONG after a billable side effect (DataForSEO Standard `task_post` is charged at post). The
// fix is a COMPENSATING WRITE outside the rolled-back transaction: the driver reports its charge at the
// billing point via recordIncurredCostUsd (types.ts), withActualCostCapture converts a rejection with a
// recorded charge into ProviderFailedAfterSpendError, and
// runCriticalSectionWithSpendCompensation (below) writes ONE `incurred` ledger row in a fresh
// transaction then rethrows the ORIGINAL typed provider error. No budget-sum query changed: every money
// sum over the ledger is status-blind, which is exactly why incurred burn binds all four tiers and the
// exec rollup for free (see ledger.ts's header for the standing prohibition on adding a status
// predicate there).
//
// SM-60 (tracker §6ak, inside the same §A11 ruling) — SM-50 closed that hole at the PROVIDER-CALL
// boundary only. The critical-section callback keeps running after invokeProvider RESOLVES: writeCache,
// insertLedgerRow, the SM-42 true-up, then the COMMIT. A fault in any of those rolls the transaction back
// exactly as a provider rejection does, but throws a PLAIN DB error — so SM-50's
// `err instanceof ProviderFailedAfterSpendError` guard rethrew it with no compensating write, and a
// vendor call that was charged AND DELIVERED left NO row at all, not even `posted`. Money spent,
// invisible to every budget tier and the exec rollup. The fix is not a wider catch (by the time a DB
// error surfaces, the capture scope that knew the amount has closed): the CHARGE is now handed out of
// that scope by the callback into a per-dispatch holder, and the catch compensates whenever a charge was
// reported — from the envelope OR from the holder — and NEVER otherwise, so no row can be invented for
// money nobody was charged. Same status (`incurred`), same $0-cost-`failed` invariant, no status
// predicate anywhere, one extra reason suffix in the `endpoint` column (`.incurred_write_failed` vs
// `.incurred_no_data`) to tell an operator which shape happened.
//
// Residual window, stated rather than hidden (the same honesty §A11.1.1 applies to its crash window): if
// the transaction actually COMMITTED and the failure arose strictly AFTER the COMMIT (in practice only a
// pool double-release fault can do that — cache.ts commits and then only returns), this catch would write
// an `incurred` row for a charge that also has its `posted` row, over-counting by one call. Recording is
// the fail-CLOSED direction of that trade and the shape is orders of magnitude rarer than a failed
// COMMIT (which loses the row and MUST compensate); distinguishing the two is not possible from outside
// runInCacheCriticalSection, and SM-41's ledger-vs-console reconciliation is the designed backstop.
import { trace, SpanStatusCode, type Attributes, type Span } from "@opentelemetry/api";
import type { PoolClient } from "pg";
import { withTenants } from "../../../db";
import { config } from "../../../config";
import { emitEvent } from "../../../events/outbox.service";
import {
  type BudgetTier,
  type OpKind,
  type ProviderOp,
  type SearchDataProvider,
  BudgetExceededError,
  GlobalCeilingUnavailableError,
  OP_PILLAR,
  OP_SCOPE_TOGGLE,
  PillarDisabledError,
  ProviderCeilingUnavailableError,
  ProviderFailedAfterSpendError,
  ScopeDisabledError,
  withActualCostCapture,
} from "./types";
import { pickProviderKey, resolveProvider } from "./registry";
import { buildCacheKey, readFreshCache, runInCacheCriticalSection, writeCache } from "./cache";
import { isSimulatedProvider, isSimulationMode, providerMode, type ProviderMode } from "./simulation";
import {
  insertLedgerRow,
  recordBlocked,
  recordIncurred,
  sumGlobalMonthToDate,
  sumMonthToDate,
  sumProviderMonthToDate,
  trueUpLedgerOnConnection,
} from "./ledger";
import {
  ON_DEMAND_ESTIMATE_RUNS_PER_MONTH,
  parseCadence,
  scheduledRunsPerMonth,
  SCHEDULED_TOOLS,
} from "../cadence";

const tracer = trace.getTracer("search.provider");

export interface DispatchInput {
  tenantId: string;
  engagementId: string;
  propertyId?: string | null;
  op: ProviderOp;
  /** `requested_by` on the ledger row: the human user id, or the OBO automation user for a pull
   *  driven by an n8n flow / MCP call (design §05). */
  requestedBy: string | null;
  correlationId?: string | null;
  /** Tracked-rank pulls bypass the cache entirely (design §05: "serp 24h with tracked-rank
   *  bypass") — they must capture the property's live position, and are always a real dispatch. */
  bypassCache?: boolean;
  /** search:provider:admin manual override — proceed past a would-be budget breach. The CALLER
   *  is responsible for the permission check + audit (design §05); dispatch only honors the flag
   *  and still emits an override audit event. */
  override?: boolean;
}

export interface DispatchResult {
  cacheHit: boolean;
  payload: unknown;
  /** For a hit: 0. For a real dispatch: the pre-dispatch ESTIMATE, unless SM-42's true-up seam fired
   *  (the resolved driver implements takeActualCostUsd and reported a value this call) — in that
   *  case this is already the vendor-reported ACTUAL figure, and `status` reads 'completed'. */
  costUsd: number;
  ledgerId: string;
  provider: string;
  /** 'completed' for a cache hit OR a real dispatch SM-42 trued up automatically; 'posted' for a
   *  real dispatch whose driver reported no actual cost (still correctable later via
   *  ledger.trueUpLedger, e.g. a future postback-driven reconciliation). */
  status: "completed" | "posted";
  /** SM-33 provenance: is `payload` SYNTHETIC and is `costUsd` a synthetic dollar figure? Stamped on
   *  the ledger row (0047) and on the cache row, and returned here so every caller that persists a
   *  derived snapshot (rank, backlinks, ai-visibility) can carry the badge forward instead of
   *  re-deriving it from the current platform mode. On a cache HIT this describes the ROW THAT WAS
   *  SERVED, not the current mode — provenance follows the bytes. */
  simulated: boolean;
}

/** Exported for SM-56's collect edge (rank.ts), which must apply the SAME scope test this
 *  choke-point applies — not a second implementation of it. A collect spends nothing, so it does not
 *  route through dispatchProviderOp; but "is this tool switched on for this engagement" has to have
 *  ONE answer across both paths, or the two drift and the free path becomes the lenient one. */
export function isToggleEnabled(toolScope: Record<string, unknown> | null | undefined, toggle: string): boolean {
  const t = toolScope?.[toggle];
  return !!(t && typeof t === "object" && (t as { enabled?: unknown }).enabled === true);
}

interface BudgetDecision {
  breach?: { tier: BudgetTier; cap: number; mtd: number };
  warnings: Array<{ tier: BudgetTier; cap: number; mtd: number; ratio: number }>;
}

/** Pure stop-loss arithmetic, evaluated engagement -> tenant -> provider -> global (first breach
 *  wins). A tier with a null cap (e.g. no tenant cap configured, or no SM-40 provider cap
 *  configured for this vendor) is skipped. */
export function evaluateBudget(inputs: {
  estimate: number;
  engagementCap: number;
  engagementMtd: number;
  tenantCap: number | null;
  tenantMtd: number;
  providerCap: number | null;
  providerMtd: number;
  globalCap: number;
  globalMtd: number;
}): BudgetDecision {
  const tiers: Array<{ tier: BudgetTier; cap: number | null; mtd: number }> = [
    { tier: "engagement", cap: inputs.engagementCap, mtd: inputs.engagementMtd },
    { tier: "tenant", cap: inputs.tenantCap, mtd: inputs.tenantMtd },
    { tier: "provider", cap: inputs.providerCap, mtd: inputs.providerMtd },
    { tier: "global", cap: inputs.globalCap, mtd: inputs.globalMtd },
  ];
  const warnings: BudgetDecision["warnings"] = [];
  for (const t of tiers) {
    // The `!Number.isFinite` half is CLARITY, NOT ENFORCEMENT, and saying so matters: entering a
    // NaN tier and skipping it are behaviourally identical (`projected > NaN` and
    // `projected >= ratio * NaN` are both false), so this condition changes no outcome. It is here
    // to make the intent unmissable to the next reader and to keep a NaN out of any warning payload
    // (a warning citing "$NaN" would reach an operator). The REAL guard against a malformed cap is
    // at the parse site — config.ts's moneyEnv() throws at boot rather than letting an
    // uninterpretable ceiling look configured (tracker §6r). Do not mistake this line for that
    // protection: deleting it breaks nothing, which is exactly why it cannot be the defence.
    if (t.cap == null || !Number.isFinite(t.cap)) continue;
    const projected = t.mtd + inputs.estimate;
    if (projected > t.cap) return { breach: { tier: t.tier, cap: t.cap, mtd: t.mtd }, warnings };
    if (projected >= config.search.budgetWarnRatio * t.cap) {
      warnings.push({ tier: t.tier, cap: t.cap, mtd: t.mtd, ratio: projected / t.cap });
    }
  }
  return { warnings };
}

/** Invoke the right provider method for an op, normalized to a payload + dispatched item count. */
async function invokeProvider(
  provider: SearchDataProvider,
  op: ProviderOp,
): Promise<{ payload: unknown; dispatchedItems: number }> {
  switch (op.kind) {
    case "serp": {
      const refs = await provider.postSerpTasks([
        { keyword: op.query, engine: op.engine, device: op.device, locale: op.locale, locationCode: op.locationCode },
      ]);
      const res = await provider.fetchSerpResults(refs);
      return { payload: res, dispatchedItems: res.length };
    }
    case "volume":
    case "suggestions": {
      const m = await provider.getKeywordMetrics([{ keyword: op.query, locale: op.locale, locationCode: op.locationCode }]);
      return { payload: m, dispatchedItems: m.length };
    }
    case "backlinks": {
      const b = await provider.getBacklinkSummary(op.query);
      return { payload: b, dispatchedItems: 1 };
    }
    case "ai_visibility": {
      const a = await provider.getAiVisibility({ query: op.query, engine: op.engine });
      return { payload: a, dispatchedItems: a.length };
    }
  }
}

/** Exported for SM-56's collect edge, for the same single-source reason as isToggleEnabled above. */
export async function loadEngagementScope(
  tenantId: string,
  engagementId: string,
): Promise<{ toolScope: Record<string, unknown>; providerBudgetUsd: number } | null> {
  const r = await withTenants(
    [tenantId],
    (c) => c.query<{ tool_scope: Record<string, unknown>; provider_budget_usd: string }>(
      `SELECT tool_scope, provider_budget_usd FROM search_engagements WHERE id = $1 AND deleted_at IS NULL`,
      [engagementId],
    ),
    { modules: ["search"] },
  );
  const row = r.rows[0];
  if (!row) return null;
  return { toolScope: row.tool_scope ?? {}, providerBudgetUsd: Number(row.provider_budget_usd) };
}

async function emitThreshold(
  tenantId: string,
  engagementId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await withTenants(
    [tenantId],
    (c) => emitEvent(c, tenantId, "search_engagement", engagementId, "search.provider.budget_threshold", payload),
    { modules: ["search"] },
  );
}

/** SM-60 (tracker §6ak) — the CHARGE, carried out of `withActualCostCapture`'s scope by hand.
 *
 *  Why a mutable holder rather than a return value: the compensating write happens in a wrapper AROUND
 *  the critical section, but the charge is only knowable INSIDE it — and on the failure path the
 *  critical section returns nothing at all, it throws. SM-50 solved that for one shape by smuggling the
 *  amount out inside `ProviderFailedAfterSpendError`, which works only when the PROVIDER CALL is what
 *  rejected. The writes that follow a SUCCESSFUL provider call (writeCache, insertLedgerRow, the
 *  in-transaction true-up, and the COMMIT itself) can each throw a plain DB error, by which time
 *  `withActualCostCapture`'s AsyncLocalStorage scope has closed and the amount is gone. So the callback
 *  hands the charge to a holder owned by the enclosing dispatch, the instant the provider call resolves
 *  and BEFORE the first write that can fail.
 *
 *  One holder per dispatchProviderOp() call, never shared: a concurrent dispatch has its own, exactly as
 *  it has its own ALS store (types.ts's isolation-by-construction argument applies unchanged). */
interface SpendLiability {
  /** What the vendor CONFIRMABLY charged for this dispatch, per the driver's own report at its billing
   *  point (§A11.1.3) — not the pre-dispatch estimate. For DataForSEO these coincide for a single-task
   *  op; for a driver whose response reports a real figure (Ahrefs, via recordActualCostUsd, which
   *  implies incurred) the charged figure is the one the vendor will actually bill, and recording the
   *  estimate instead would put a number in the ledger the vendor never charged. */
  chargedUsd: number;
  vendorRefs: string[];
}

/** Mutable by design — see SpendLiability. `recorded` stays null unless a charge was genuinely
 *  reported, which is what makes the phantom-row guard in the compensation catch a null check rather
 *  than a judgement call. */
interface LiabilityHolder {
  recorded: SpendLiability | null;
}

/** Everything recordIncurred() needs that is fixed for a given dispatch, resolved before the critical
 *  section opens (so the compensating write cannot itself depend on anything the rollback destroyed). */
interface IncurredContext {
  propertyId?: string | null;
  provider: string;
  endpoint: string;
  items: number;
  requestedBy: string | null;
  correlationId?: string | null;
  simulated: boolean;
}

/** SM-50 (design addendum §A11.1.1) — THE COMPENSATING-WRITE LOCUS. Runs the money-safe critical
 *  section and, when the vendor had already been charged, records that charge in a FRESH transaction
 *  outside the one that just rolled back.
 *
 *  Why here and not inside the critical section: nothing written inside a rolled-back transaction can
 *  survive it. The transaction is already gone by the time this catch runs — which is the point. The
 *  advisory locks it held were released by the ROLLBACK too, so this write contends with nothing.
 *
 *  ── SM-60 (tracker §6ak): the catch is decided by THE CHARGE, never by the error's TYPE ────────────
 *  SM-50 shipped this catch as `if (!(err instanceof ProviderFailedAfterSpendError)) throw err;`, which
 *  covers exactly one of the two ways a charged dispatch can lose its record. The critical-section
 *  callback does not end when the provider call resolves: `writeCache` then `insertLedgerRow` (then the
 *  SM-42 true-up, then the COMMIT) run on the same connection in the same transaction, and a fault in
 *  ANY of them — constraint violation, dropped connection, statement timeout, pool error, a failed
 *  COMMIT — rolls the transaction back exactly as a provider rejection does while throwing a PLAIN DB
 *  error. The type guard rethrew those with no compensating write, so a vendor call that was charged AND
 *  DELIVERED left nothing in the ledger at all: money spent, invisible to all four budget tiers and the
 *  exec rollup. That is the same fail-open class SM-50 exists to close, one step later in the same
 *  function, and it sat outside all nine of SM-50's mutation probes because every one of them attacks
 *  the provider-call boundary rather than the post-success write boundary.
 *
 *  So the question this catch asks is no longer "which error is this?" but "WAS THE VENDOR CHARGED?" —
 *  answered from exactly two sources, one per shape, and from nothing else:
 *    * `ProviderFailedAfterSpendError` — the provider call itself rejected after a recorded charge; the
 *      envelope carries the amount and refs (SM-50, unchanged).
 *    * `liability.recorded` — the provider call RESOLVED and reported a charge, handed out of the
 *      capture scope by the callback before the first write that could fail (SM-60).
 *  Widening the type guard alone would NOT have been sufficient and is the trap this ticket exists to
 *  avoid: by the time a DB error surfaces there is no amount to write, because the scope that knew it
 *  has closed.
 *
 *  THE PHANTOM-ROW GUARD, and why it is the same line as the fix: when NEITHER source reports a charge,
 *  the error is rethrown untouched and NO row is written. That keeps every pre-existing failure shape
 *  byte-for-byte — a budget-sum failure, an engagement-not-found, a cache read fault, a provider that
 *  died before its billing point, every simulator (which never records a charge, so its rollback loses
 *  nothing real) — and it forecloses the damage that a naive "compensate on any error after the provider
 *  call" would do: an `incurred` row for money nobody was charged would refuse real client work for
 *  phantom spend, which is worse in kind than the missing row, not merely different. Over-recording is
 *  never the safe direction on a money path; §A11.1.5's under-record posture is deliberate.
 *
 *  ── The two properties this function must never lose ────────────────────────────────────────────
 *  1. FAIL CLOSED, NEVER MASK. The caller receives the error it would have received with no
 *     compensation at all: `err.cause` on the envelope path (the ORIGINAL typed provider error,
 *     unchanged — the envelope is unwrapped here and never escapes), and on the SM-60 path the caught
 *     error OBJECT ITSELF, rethrown by identity — never re-wrapped, never re-messaged, so a DB fault
 *     reaches the caller as the DB fault it is. Every existing caller, the ProviderDispatchError HTTP
 *     filter, SM-58's last-resort filter and every existing assertion on a provider error message behave
 *     exactly as before. The compensating write is BOOKKEEPING; it is not a replacement for the failure,
 *     and it must not be able to become one. Assert this by IDENTITY, not by message: SM-50's own P4
 *     probe showed a message assertion still matches while a wrapper leaks, because the envelope quotes
 *     its cause.
 *  2. THE §4d SECONDARY-FAILURE GUARD. If recordIncurred (or the event emit) ALSO fails — plausible,
 *     since the same fault that broke the dispatch can break a write — that secondary error is
 *     swallowed into a span event and the ORIGINAL provider error still wins. This is the identical
 *     template the global- and provider-ceiling paths above already use for recordBlocked, and the
 *     reason it exists is that the alternative silently substitutes an unrelated error for the one the
 *     caller needs to act on. The cost of the guard is stated honestly: a lost audit write becomes a
 *     span event rather than a ledger row, which SM-41's reconciliation is the backstop for.
 *
 *  The ORDER inside the guard is deliberate: the LEDGER ROW FIRST, the notification second. The row is
 *  what every budget tier and the exec rollup read; the bell is how a human finds out. If only one of
 *  the two can happen, it must be the row — a silent-but-metered burn still refuses the next dispatch,
 *  whereas a notified-but-unmetered burn does not. The emit is separately guarded for the same reason,
 *  so a failing notification cannot cost us the row we just wrote. */
async function runCriticalSectionWithSpendCompensation<T>(
  args: {
    tenantId: string; engagementId: string; cacheKey: string; span: Span;
    incurredContext: IncurredContext;
    /** SM-60 — the charge the callback hands out of the capture scope on the SUCCESS path. */
    liability: LiabilityHolder;
  },
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const { tenantId, engagementId, cacheKey, span, incurredContext: ctx, liability } = args;
  try {
    return await runInCacheCriticalSection<T>(tenantId, engagementId, cacheKey, fn);
  } catch (err) {
    // SM-60: decided by THE CHARGE, from exactly two sources, never by the error's type. See the
    // function header for why widening the old `instanceof` guard would not have been enough.
    const envelope = err instanceof ProviderFailedAfterSpendError ? err : null;
    const charge: SpendLiability | null = envelope
      ? { chargedUsd: envelope.incurredUsd, vendorRefs: envelope.vendorRefs }
      : liability.recorded;
    // THE PHANTOM-ROW GUARD (header, property 3): no reported charge => no row, error untouched.
    if (!charge) throw err;

    // Did the vendor actually hand over the data it charged for? The envelope path means the provider
    // call itself rejected, so no. The SM-60 path means it resolved — the payload existed and our own
    // bookkeeping is what failed, and the rollback then discarded the payload, the cache row and the
    // ledger row together, so the platform retains nothing either way. This distinction changes NO
    // consumer disposition (see the `reason` suffix below), only what an operator reads.
    const dataDelivered = envelope === null;
    // Its own span event regardless of whether the bookkeeping below succeeds, so the trace shows the
    // liability even when the write cannot. Two names rather than one flag, so an operator can grep for
    // either shape directly.
    span.addEvent(dataDelivered ? "spend_recorded_but_bookkeeping_failed" : "provider_failed_after_spend", {
      provider: ctx.provider,
      endpoint: ctx.endpoint,
      "search.incurred_usd": charge.chargedUsd,
      "search.vendor_refs": charge.vendorRefs.join(","),
      "search.data_delivered": dataDelivered,
      error: (err as Error)?.message ?? String(err),
    });

    try {
      // `items` reflects WHAT WAS CHARGED, not what was asked for: for DataForSEO one vendorRef is one
      // accepted+billed task, so a mixed accept/reject response records the accepted count rather than
      // the op's requested item count. Falling back to the op's items covers a vendor that charges
      // without exposing per-call ids.
      const chargedItems = charge.vendorRefs.length > 0 ? charge.vendorRefs.length : ctx.items;
      const ledgerId = await recordIncurred({
        tenantId, engagementId, propertyId: ctx.propertyId,
        provider: ctx.provider,
        // ONE status, TWO reasons, distinguished in the `endpoint` column exactly as every other
        // reason-bearing row in this file already is (`.scope_disabled`, `.budget_blocked`,
        // `.global_ceiling_unavailable`). `incurred` stays the status because every disposition in
        // §A11.2 is identical for both: the money counts (status-blind sums), no deliverable exists
        // (nothing was persisted), `vendor_ref` reconciles it against the console line item, and the
        // §A11.1.4 callback interlock can still advance it to `completed` at the same cost if the data is
        // later retrieved. A second status would need a CHECK widening, a design gate and a BFF/legend
        // change, and would buy no consumer a different behaviour.
        endpoint: `${ctx.endpoint}.${dataDelivered ? "incurred_write_failed" : "incurred_no_data"}`,
        items: chargedItems,
        costUsd: charge.chargedUsd,
        requestedBy: ctx.requestedBy,
        correlationId: ctx.correlationId,
        // §A11.1.5: stamped from THIS dispatch's value, like every other row — never re-derived. A
        // simulator never records an incurred charge in the first place (its dollars are synthetic and
        // the rollback loses nothing real), so in practice this reaches a row only on a live-driver
        // path; deriving it from the dispatch value rather than special-casing it keeps the ONE
        // provenance value driving every write, which is the SM-33 invariant.
        simulated: ctx.simulated,
        // ONE column, so the FIRST ref. Per-op cache-key granularity is one subject per op (cache.ts),
        // so a real dispatch produces exactly one task id and this is lossless in practice; the full
        // list is on the span event above and in the emitted event payload below. A driver that
        // genuinely batches several billable tasks into one op is the case §A11.3's revisit trigger
        // already routes to write-ahead intent rows (any single-op incurred cost that can exceed ~$1),
        // so it must not ship on this path at all.
        vendorRef: charge.vendorRefs[0] ?? null,
      });

      try {
        await withTenants(
          [tenantId],
          (c) => emitEvent(c, tenantId, "search_engagement", engagementId, "search.provider.incurred_cost", {
            ledgerId,
            provider: ctx.provider,
            endpoint: ctx.endpoint,
            costUsd: charge.chargedUsd,
            vendorRef: charge.vendorRefs[0] ?? null,
            vendorRefs: charge.vendorRefs,
            items: chargedItems,
            correlationId: ctx.correlationId ?? null,
            simulated: ctx.simulated,
            // SM-60: the ONE event type is kept deliberately (a charge that bought the platform nothing
            // must reach a human whichever way it happened — §A11.2 #11), with the sub-case carried as
            // data rather than as a second event a consumer could forget to subscribe to. The bell
            // consumer (modules/search/notifications.ts, not this ticket's file) currently renders one
            // fixed title naming "returned no data"; with this flag it CAN distinguish, and a wording
            // widening there is reported as a follow-up rather than silently edited here.
            dataDelivered,
          }),
          { modules: ["search"] },
        );
      } catch (emitErr) {
        span.addEvent("incurred_cost_event_emit_failed", { error: (emitErr as Error).message, ledgerId });
      }
    } catch (auditErr) {
      span.addEvent("incurred_cost_audit_failed", { error: (auditErr as Error).message });
    }

    // ALWAYS the error the caller would have received without this bookkeeping — see property 1 above.
    // Envelope path: its `cause`, the original typed provider error. SM-60 path: `err` ITSELF, rethrown
    // by identity, because there is nothing to unwrap and inventing a wrapper here would hide a DB fault
    // behind a money message.
    throw envelope ? envelope.cause : err;
  }
}

/** The single dispatch entry point. See file header for the enforced stop-loss + concurrency model. */
export async function dispatchProviderOp(input: DispatchInput): Promise<DispatchResult> {
  const { tenantId, engagementId, op } = input;
  return tracer.startActiveSpan("search.provider.dispatch", async (span): Promise<DispatchResult> => {
    try {
      // (-1) PILLAR kill switch (SM-06) — an operator brake that outranks every per-engagement
      // setting, so it is checked before the engagement is even loaded. No ledger row: a disabled
      // pillar means "this capability does not exist right now", not "this client was refused".
      const pillar = OP_PILLAR[op.kind];
      if (!config.search.pillars[pillar]) throw new PillarDisabledError(pillar, op.kind);

      // SM-33 provenance, read ONCE per dispatch (the mode can be flipped at runtime, and a single
      // dispatch must not straddle two modes: the key it reads, the key it writes and the row it
      // bills all have to agree). In `simulate` mode EVERY row is stamped simulated — even if a real
      // driver somehow answers — because over-labelling costs a re-pull while under-labelling puts an
      // invented number into a client's record with no badge on it.
      const modeSimulated = isSimulationMode();

      const eng = await loadEngagementScope(tenantId, engagementId);
      if (!eng) throw new Error("engagement not found");

      // (0) SCOPE gate — before provider selection or any budget arithmetic. The ledger row records
      // which provider WOULD have been billed, but that resolution must never change the refusal:
      // pickProviderKey throws when no driver is registered (keyless dev, SM-06 flags off), and a
      // scope-disabled op has to be refused NAMING THE TOGGLE regardless (the AC). So the lookup is
      // best-effort and the blocked row falls back to the configured default key.
      const toggle = OP_SCOPE_TOGGLE[op.kind];
      if (!isToggleEnabled(eng.toolScope, toggle)) {
        let blockedProvider = config.search.defaultProvider;
        try {
          blockedProvider = pickProviderKey(eng.toolScope, op.kind);
        } catch {
          /* unregistered/incapable driver — irrelevant to a scope refusal */
        }
        await recordBlocked({
          tenantId, engagementId, propertyId: input.propertyId,
          provider: blockedProvider,
          endpoint: `${op.kind}.scope_disabled`, items: op.items ?? 1,
          requestedBy: input.requestedBy, correlationId: input.correlationId,
          simulated: modeSimulated,
        });
        throw new ScopeDisabledError(toggle, op.kind);
      }

      // Provider selection (registration + capability enforced) → estimate + cache key.
      const provider = resolveProvider(eng.toolScope, op.kind);
      const estimate = provider.estimateCostUsd(op);
      const items = op.items ?? 1;
      const endpoint = `${provider.key}.${op.kind}`;
      // SM-33: the resolved driver's own marker OR the platform mode. The driver's marker matters
      // independently of the mode because a simulated driver could be registered while the mode flag
      // says `live` (a misconfiguration) — and in that case the data is still synthetic, so the row
      // must still say so.
      const simulated = modeSimulated || isSimulatedProvider(provider);
      // The cache KEY is unchanged by mode (addendum §A4.2): mode is a row predicate on the read and
      // a stamped column on the write — see cache.ts.
      const cacheKey = buildCacheKey(provider.key, op);

      // (1a-provider) SM-40 — the per-provider ceiling, evaluated BEFORE the global tier (matches
      // the cascade order engagement -> tenant -> provider -> global). Cross-tenant, computed
      // pre-lock, same reasoning as the global sum immediately below. Unset cap => SKIP: the sum is
      // never attempted, so a provider nobody has configured a cap for can never itself become a
      // refusal reason (matches tenantMonthlyCapUsd's null-skips-tier semantics).
      const providerCap = config.search.providerMonthlyCapUsd[provider.key] ?? null;
      let providerMtd = 0;
      if (providerCap != null) {
        try {
          providerMtd = await sumProviderMonthToDate(provider.key, simulated);
        } catch (e) {
          const cause = (e as Error).message;
          span.addEvent("provider_mtd_compute_failed", { error: cause, provider: provider.key });
          // Same secondary-failure guard as the global tier below: if the audit write ALSO fails
          // (e.g. the same fault broke both reads and writes), the caller must still see
          // ProviderCeilingUnavailableError, never the recordBlocked failure.
          try {
            await recordBlocked({
              tenantId, engagementId, propertyId: input.propertyId, provider: provider.key,
              endpoint: `${endpoint}.provider_ceiling_unavailable`, items,
              requestedBy: input.requestedBy, correlationId: input.correlationId,
              simulated,
            });
          } catch (auditErr) {
            span.addEvent("provider_ceiling_unavailable_audit_failed", { error: (auditErr as Error).message });
          }
          throw new ProviderCeilingUnavailableError(provider.key, cause);
        }
      }

      // (1a) Global MTD is coarse (a platform ceiling) — computed pre-lock. It must FAIL CLOSED:
      // this used to degrade to 0 on error, which silently disabled the tier, because a $0
      // month-to-date can never breach. That was the only platform-wide ceiling on the default
      // config (tenantMonthlyCapUsd is optional and unset by default), so an error here turned an
      // enforced $150/mo cap into no cap at all, with nothing but a span event to show for it.
      // SM-33 §A4.1: the ceiling is evaluated against THIS dispatch's ledger — simulated spend binds
      // simulated pulls, real spend binds real ones. Passing the same `simulated` value that the row
      // about to be written will carry is what keeps the tier's arithmetic and its bookkeeping in
      // the same partition; there is no code path where they can disagree.
      let globalMtd: number;
      try {
        globalMtd = await sumGlobalMonthToDate(simulated);
      } catch (e) {
        const cause = (e as Error).message;
        span.addEvent("global_mtd_compute_failed", { error: cause });
        // The audit write is best-effort here: if the SAME underlying fault also breaks this
        // INSERT (plausible — e.g. a permission error wide enough to hit both reads and writes),
        // a secondary throw out of recordBlocked must never replace the refusal the caller is
        // about to see. Guarded so GlobalCeilingUnavailableError always wins; the audit failure
        // itself is still surfaced as a span event rather than silently dropped.
        try {
          await recordBlocked({
            tenantId, engagementId, propertyId: input.propertyId, provider: provider.key,
            endpoint: `${endpoint}.global_ceiling_unavailable`, items,
            requestedBy: input.requestedBy, correlationId: input.correlationId,
            simulated,
          });
        } catch (auditErr) {
          span.addEvent("global_ceiling_unavailable_audit_failed", { error: (auditErr as Error).message });
        }
        throw new GlobalCeilingUnavailableError(cause);
      }

      type Outcome =
        | { type: "hit"; payload: unknown; ledgerId: string; simulated: boolean }
        | { type: "dispatched"; payload: unknown; ledgerId: string; costUsd: number; status: "posted" | "completed" }
        | { type: "breach"; tier: BudgetTier; cap: number; mtd: number };

      // SM-60: one holder per dispatch, owned OUT HERE so it outlives the critical section's
      // transaction and the capture scope inside it. Written exactly once, by the callback, the instant
      // the provider call resolves with a reported charge.
      const liability: LiabilityHolder = { recorded: null };

      const outcome = await runCriticalSectionWithSpendCompensation<Outcome>({
        tenantId, engagementId, cacheKey, span, liability,
        incurredContext: {
          propertyId: input.propertyId, provider: provider.key, endpoint, items,
          requestedBy: input.requestedBy, correlationId: input.correlationId, simulated,
        },
      }, async (c) => {
        // Single-flight: the first committer's cache row makes every racing identical query a HIT.
        if (!input.bypassCache) {
          // SM-33 §A4.2: `simulated` is the read's MODE PREDICATE — a row written in the other mode
          // is not visible to this query at all, so it can never be served under the wrong badge;
          // this call takes the normal miss path and re-pulls instead.
          const hit = await readFreshCache(c, cacheKey, simulated);
          if (hit) {
            const ledgerId = await insertLedgerRow(c, {
              tenantId, engagementId, propertyId: input.propertyId, provider: provider.key,
              endpoint: `${endpoint}.cache_hit`, items, costUsd: 0, cacheHit: true, status: "completed",
              requestedBy: input.requestedBy, correlationId: input.correlationId,
              // The SERVED row's provenance, not the current mode (they are equal by construction
              // here, since the key is partitioned and the read refuses a mismatch — recorded this
              // way so the invariant is expressed in code, not just relied on).
              simulated: hit.simulated,
            });
            return { type: "hit", payload: hit.payload, ledgerId, simulated: hit.simulated };
          }
        }

        // (1) BUDGET gate on real spend (atomic with the ledger insert under the engagement lock).
        // Every tier is mode-filtered on the SAME `simulated` value the ledger row will carry
        // (§A4.1) — disjoint ledgers, identical gates. providerCap/providerMtd (SM-40) were computed
        // pre-lock above, alongside globalMtd, for the same cross-tenant-aggregate reason.
        const engagementMtd = await sumMonthToDate(c, engagementId, simulated);
        const tenantMtd = await sumMonthToDate(c, null, simulated);
        const decision = evaluateBudget({
          estimate,
          engagementCap: eng.providerBudgetUsd,
          engagementMtd,
          tenantCap: config.search.tenantMonthlyCapUsd,
          tenantMtd,
          providerCap,
          providerMtd,
          globalCap: config.search.globalMonthlyCapUsd,
          globalMtd,
        });

        if (decision.breach && !input.override) {
          return { type: "breach", ...decision.breach };
        }
        for (const w of decision.warnings) {
          await emitEvent(c, tenantId, "search_engagement", engagementId, "search.provider.budget_threshold", {
            tier: w.tier, capUsd: w.cap, monthToDateUsd: w.mtd, estimateUsd: estimate, ratio: w.ratio,
            level: "warn", opKind: op.kind,
          });
        }
        if (decision.breach && input.override) {
          await emitEvent(c, tenantId, "search_engagement", engagementId, "search.provider.budget_threshold", {
            tier: decision.breach.tier, capUsd: decision.breach.cap, monthToDateUsd: decision.breach.mtd,
            estimateUsd: estimate, ratio: (decision.breach.mtd + estimate) / decision.breach.cap,
            level: "override", opKind: op.kind,
          });
        }

        // Dispatch (network) under the lock, then cache + ledger, all in this one transaction.
        // SM-42: the ONE invokeProvider() call runs inside a fresh actual-cost capture scope — see
        // types.ts's withActualCostCapture for why AsyncLocalStorage (not an instance field) is what
        // makes this safe against a second, unrelated dispatch racing concurrently against the same
        // provider singleton (the getBacklinkSummary two-parallel-calls hazard, tracker §6j).
        // SM-50: the same wrapper is now also the failure boundary — if invokeProvider rejects AFTER
        // the driver recorded a vendor charge, it throws ProviderFailedAfterSpendError instead of the
        // raw error, and the compensating write happens in the wrapper around this critical section
        // (runCriticalSectionWithSpendCompensation, below). Nothing about the SUCCESS path changes,
        // except that `vendorRefs` now carries the vendor's own ids for this call so the posted row is
        // reconcilable against the vendor console (§A11.1.4, one column on both paths).
        // SM-60: the same wrapper is the failure boundary for the provider call, but NOT for what
        // follows it. Everything from here to this callback's return (and the COMMIT after it) can throw
        // a plain DB error, roll this transaction back, and take the charge's only record with it — so
        // the charge is handed to the enclosing dispatch's holder RIGHT HERE, before the first statement
        // that can fail. `> 0` mirrors withActualCostCapture's own rejection-path rule: a driver that
        // reported $0 told us nothing billable happened, and a $0 money row is the §A9.5 degenerate-input
        // class, not a liability. A driver that reports nothing (every simulator, and any live driver
        // whose vendor acknowledgement was never parsed) leaves this null, and the guard in the
        // compensation catch then writes nothing at all.
        const { result: { payload, dispatchedItems }, actualCostUsd, vendorRefs, incurredUsd } =
          await withActualCostCapture(provider, () => invokeProvider(provider, op));
        if (incurredUsd > 0) liability.recorded = { chargedUsd: incurredUsd, vendorRefs };
        if (!input.bypassCache) {
          await writeCache(c, cacheKey, op.kind, payload, provider.key, estimate, simulated);
        }
        const ledgerId = await insertLedgerRow(c, {
          tenantId, engagementId, propertyId: input.propertyId, provider: provider.key, endpoint,
          items: dispatchedItems, costUsd: estimate, cacheHit: false, status: "posted",
          requestedBy: input.requestedBy, correlationId: input.correlationId,
          simulated,
          vendorRef: vendorRefs[0] ?? null,
        });
        // SM-42: true-up the row just inserted, IN THIS SAME TRANSACTION, to the vendor-reported
        // actual cost when the resolved driver reported one — in EITHER direction. This is a
        // CORRECTION of the estimate evaluateBudget already decided against above, never a second
        // budget decision: the network call has already happened by this point, so there is nothing
        // left to refuse. A driver with no takeActualCostUsd (undefined here) leaves the row exactly
        // as it has always stood: 'posted' at the estimate.
        let costUsd = estimate;
        let status: "posted" | "completed" = "posted";
        if (actualCostUsd !== undefined) {
          await trueUpLedgerOnConnection(c, ledgerId, actualCostUsd);
          costUsd = actualCostUsd;
          status = "completed";
        }
        return { type: "dispatched", payload, ledgerId, costUsd, status };
      });

      if (outcome.type === "breach") {
        await recordBlocked({
          tenantId, engagementId, propertyId: input.propertyId, provider: provider.key,
          endpoint: `${endpoint}.budget_blocked`, items, requestedBy: input.requestedBy, correlationId: input.correlationId,
          simulated,
        });
        await emitThreshold(tenantId, engagementId, {
          tier: outcome.tier, capUsd: outcome.cap, monthToDateUsd: outcome.mtd, estimateUsd: estimate,
          ratio: (outcome.mtd + estimate) / outcome.cap, level: "blocked", opKind: op.kind,
        });
        throw new BudgetExceededError(outcome.tier, outcome.cap, outcome.mtd, estimate);
      }

      const cacheHit = outcome.type === "hit";
      // Provenance follows the bytes: a hit reports the served row's flag, a dispatch reports this
      // call's. (They agree by construction — the key is mode-partitioned — but deriving it from the
      // row is what keeps that true if the key scheme ever changes.)
      const resultSimulated = outcome.type === "hit" ? outcome.simulated : simulated;
      // SM-42: a real dispatch reports its TRUED-UP cost/status when the driver provided one
      // (outcome.costUsd/outcome.status already reflect that — see the critical section above),
      // otherwise the pre-dispatch estimate exactly as before this ticket.
      const finalCostUsd = outcome.type === "hit" ? 0 : outcome.costUsd;
      const finalStatus: "completed" | "posted" = outcome.type === "hit" ? "completed" : outcome.status;
      const attrs: Attributes = {
        "search.provider": provider.key,
        "search.endpoint": endpoint,
        "search.items": items,
        "search.cost_usd": finalCostUsd,
        "search.cache_hit": cacheHit,
        "search.simulated": resultSimulated,
      };
      span.setAttributes(attrs);
      span.setStatus({ code: SpanStatusCode.OK });
      return {
        cacheHit,
        payload: outcome.payload,
        costUsd: finalCostUsd,
        ledgerId: outcome.ledgerId,
        provider: provider.key,
        status: finalStatus,
        simulated: resultSimulated,
      };
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

// ── estimateCostUsd projection (design §05; feeds SM-29's per-toggle projected monthly cost) ────────
const TOGGLE_OP: Record<string, OpKind> = {
  rank: "serp",
  volume: "volume",
  suggestions: "suggestions",
  backlinks: "backlinks",
  ai_visibility: "ai_visibility",
};

// SM-61 (tracker §6au Ruling 1, clause 3 — binding): runs/month is now derived INLINE in
// `projectMonthlyCost` below via `modules/search/cadence.ts`'s no-default parser, not a second
// normalization of `cadence` in a local wrapper. A real cadence prices at its SCHEDULED runs/month;
// an absent/junk cadence prices at `ON_DEMAND_ESTIMATE_RUNS_PER_MONTH` (also 1 — deliberately
// IDENTICAL to the pre-SM-61 `default: 1` this replaced, so this projection's dollar figures do not
// move for any existing engagement). The two readings differ only in what they're LABELLED as on the
// wire — see `ProjectedToolCost.scheduled`.

function itemsPerRun(kind: OpKind, toggle: Record<string, unknown>): number {
  const max = typeof toggle.maxKeywords === "number" ? toggle.maxKeywords : undefined;
  switch (kind) {
    case "serp": return max ?? 50;
    case "volume":
    case "suggestions": return max ?? 50;
    case "backlinks": return 1;
    case "ai_visibility": {
      const q = Array.isArray(toggle.queries) ? toggle.queries.length : undefined;
      return (typeof toggle.maxQueries === "number" ? toggle.maxQueries : undefined) ?? q ?? max ?? 10;
    }
  }
}

export interface ProjectedToolCost {
  tool: string;
  opKind: OpKind;
  enabled: boolean;
  cadence: string | null;
  runsPerMonth: number;
  itemsPerRun: number;
  costPerRunUsd: number;
  projectedMonthlyUsd: number;
  provider: string | null;
  /** SM-33: would this tool's pulls be SIMULATED right now (so this price tag is a synthetic
   *  figure)? Per-tool rather than global because provider selection is per-tool: with SM-36's
   *  per-capability preference cascade one toggle can resolve to a live driver while another
   *  resolves to a simulated one, and a single page-level badge would then be a lie about half the
   *  grid. SM-38 renders this as the per-row SIMULATED chip. */
  simulated: boolean;
  /** SM-61 (§6au Ruling 1 clause 3, binding). `true` only when the platform-side pull scheduler
   *  will ACTUALLY select this row: `enabled && cadence !== null && tool ∈ SCHEDULED_TOOLS`
   *  (`pull-scheduler.ts`'s own four reassigned tools — `suggestions` can never be `true`, it has no
   *  scheduled flow). `false` means `runsPerMonth`/`projectedMonthlyUsd` above are the ON-DEMAND
   *  USAGE ESTIMATE, not a promise anything will run unattended — the scope panel must render this
   *  case with its own "on-demand est." label (§6aa's no-unlabelled-figures rule) rather than
   *  implying the number is a schedule. This is the field that keeps the projection and the
   *  scheduler from ever being able to silently disagree again: it is DERIVED here from the exact
   *  same `parseCadence` + `SCHEDULED_TOOLS` the scheduler itself reads, never a separate guess. */
  scheduled: boolean;
  note?: string;
}

/** Project the monthly provider cost per paid toggle for an engagement's tool_scope: for each of
 *  the five paid toggles (rank/volume/suggestions/backlinks/ai_visibility), costPerRun =
 *  provider.estimateCostUsd({kind, items}); projected = costPerRun x runsPerMonth(cadence). A
 *  disabled toggle projects $0; an unresolvable provider yields a note (no crash). SM-29 renders
 *  this in the scope panel so the human sees the price of each switch before flipping it. */
export function projectMonthlyCost(toolScope: Record<string, unknown> | null | undefined): {
  perTool: ProjectedToolCost[];
  totalMonthlyUsd: number;
  /** SM-33: the platform provider mode this projection was computed under, so the console can state
   *  it once in the engagement header (SM-38) instead of inferring it from the per-tool flags. */
  providerMode: ProviderMode;
} {
  const scope = toolScope ?? {};
  const mode = providerMode();
  const perTool: ProjectedToolCost[] = [];
  for (const [tool, kind] of Object.entries(TOGGLE_OP)) {
    const toggle = (scope[tool] ?? {}) as Record<string, unknown>;
    const enabled = toggle.enabled === true;
    // SM-61 (§6au clause 3): the SAME no-default parse the scheduler uses. Junk collapses to `null`
    // here too, exactly as it does in `pull-scheduler.ts` — this endpoint must never echo a typo
    // back as though it were a real cadence.
    const cadence = parseCadence(toggle.cadence);
    const items = itemsPerRun(kind, toggle);
    const runs = cadence === null ? ON_DEMAND_ESTIMATE_RUNS_PER_MONTH : scheduledRunsPerMonth(cadence);
    // `scheduled`: would `pull-scheduler.ts`'s sweep actually select this row? Derived from the
    // EXACT same two facts the sweep gates on (enabled + a real cadence) plus membership in the
    // identical `SCHEDULED_TOOLS` list it sweeps — never a separate guess (§6au clause 3's whole
    // point). `suggestions` can never be `true`: it is not in `SCHEDULED_TOOLS`.
    const scheduled = enabled && cadence !== null && (SCHEDULED_TOOLS as readonly string[]).includes(tool);
    let costPerRun = 0;
    let provider: string | null = null;
    let simulated = mode === "simulate";
    let note: string | undefined;
    try {
      const p = resolveProvider(scope, kind);
      provider = p.key;
      costPerRun = p.estimateCostUsd({ kind, query: "", items });
      simulated = simulated || isSimulatedProvider(p);
    } catch (e) {
      note = `no provider available to estimate (${(e as Error).message})`;
    }
    const projected = enabled ? costPerRun * runs : 0;
    perTool.push({
      tool, opKind: kind, enabled, cadence, scheduled,
      runsPerMonth: Number(runs.toFixed(4)), itemsPerRun: items,
      costPerRunUsd: Number(costPerRun.toFixed(6)),
      projectedMonthlyUsd: Number(projected.toFixed(6)),
      provider, simulated, note,
    });
  }
  const total = perTool.reduce((s, t) => s + t.projectedMonthlyUsd, 0);
  return { perTool, totalMonthlyUsd: Number(total.toFixed(6)), providerMode: mode };
}
