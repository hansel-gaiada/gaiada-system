// SM-14 — rank tracking (docs/blueprints/seo-sem-design.md §12; tracker §6j "SM-14 · rank tracking").
//
// This is the FIRST real caller of providers/dispatch.ts's dispatchProviderOp — until this file
// existed, `search_provider_calls` was empty in every environment because nothing dispatched a real
// (or simulated) provider op (tracker §6l "Honest limit — no ledger rows yet"). Everything below
// CALLS dispatchProviderOp; nothing here modifies it (providers/* is owned by a concurrent QA audit
// this ticket must not touch).
//
// Two writers live here, both governed by 0048's column-comment law (tracker §6j's five inherited
// ACs, verbatim):
//   1. Rank-snapshot persister (AC1) — one search_rank_snapshots row per pull, `simulated` stamped
//      from DispatchResult.simulated ONLY — never re-read from config.search.providerMode, never
//      derived from the nullable provider_call_id FK.
//   2. Keyword-metrics writer (AC2) — search_keywords.volume/difficulty/cpc_usd + metrics_provider +
//      metrics_simulated, all written in ONE UPDATE (discharges SM-36's carried-forward AC).
// AC3 (absent stays absent; a live re-pull overwrites value+provider+flag together) and AC5 (this
// module owns every platform route for rank pulls, including the Standard-queue completion callback
// n8n will hit) are implemented in search.controller.ts, which calls the functions below.
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { emitEvent } from "../../events/outbox.service";
import { dispatchProviderOp, isToggleEnabled, loadEngagementScope } from "./providers/dispatch";
import {
  advanceIncurredToCompletedOnConnection,
  findLedgerRowByVendorRef,
  ledgerRowScopeMatches,
} from "./providers/ledger";
import { resolveProvider } from "./providers/registry";
import {
  CollectUnsupportedError,
  OP_PILLAR,
  OP_SCOPE_TOGGLE,
  PillarDisabledError,
  ProviderDispatchError,
  ScopeDisabledError,
  UnknownVendorTaskError,
  type KeywordMetrics,
  type SerpResult,
} from "./providers/types";

// ── domain matching (the provider has no notion of "whose rank" — design §05: SerpRequest carries
// only the keyword; locating OUR property inside the returned top-N list is this module's job) ─────
export function normalizeDomain(d: string): string {
  return d.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}

export function hostnameOf(url: string): string | null {
  try {
    return normalizeDomain(new URL(url).hostname);
  } catch {
    return null;
  }
}

/** Locate the tracked property's own domain within a dispatched SERP's ranked items. Returns the
 *  BEST (lowest) position if the domain appears more than once (the migration only promises "not
 *  found ⇒ null", not uniqueness). `position: null` is the schema's own documented, honest "not
 *  found in this SERP" state (0034: "position integer -- nullable = not found in the SERP") — never
 *  an error, and never coerced into a guessed number. */
export function findPropertyPosition(
  items: SerpResult["items"],
  propertyDomain: string,
): { position: number | null; rankedUrl: string | null } {
  const target = normalizeDomain(propertyDomain);
  let best: { position: number; url: string } | null = null;
  for (const item of items) {
    const host = hostnameOf(item.url);
    if (!host) continue;
    if (host !== target && !host.endsWith(`.${target}`)) continue;
    if (!best || item.position < best.position) best = { position: item.position, url: item.url };
  }
  return best ? { position: best.position, rankedUrl: best.url } : { position: null, rankedUrl: null };
}

/** design §12 SM-14 AC: "drop emits event". A drop is (a) a keyword that WAS found and is now not
 *  found at all, or (b) found but at a numerically WORSE position than its immediately-prior
 *  snapshot. A keyword with no prior snapshot (first-ever pull), or one that stays not-found across
 *  two consecutive pulls, has nothing to regress FROM — never a drop. A newly-found keyword (prev
 *  null, new found) is a gain, not a drop, and is also excluded. */
export function isRankDrop(previousPosition: number | null, newPosition: number | null): boolean {
  if (previousPosition === null) return false;
  return newPosition === null || newPosition > previousPosition;
}

export interface TrackedKeywordRef {
  keywordId: string;
  keyword: string;
  locale: string | null;
}

export interface RankPullOutcome {
  keywordId: string;
  keyword: string;
  status: "pulled" | "skipped" | "failed";
  position?: number | null;
  rankedUrl?: string | null;
  provider?: string;
  simulated?: boolean;
  dropped?: boolean;
  previousPosition?: number | null;
  reason?: string;
}

interface PullRankParams {
  tenantId: string;
  engagementId: string;
  propertyId: string;
  propertyDomain: string;
  keyword: TrackedKeywordRef;
  engine?: string;
  device?: string;
  locationCode?: number;
  requestedBy: string | null;
  correlationId?: string | null;
}

/** Pull + persist ONE tracked keyword's rank snapshot — the unit both the batch engagement pull
 *  (below) and the Standard-queue completion callback (search.controller.ts) call. Tracked-rank
 *  pulls ALWAYS bypass the cache (dispatch.ts's own documented rule: "must capture the property's
 *  live position", design §05). search_rank_snapshots is append-only (0034's own comment) — a
 *  second call for the same keyword is a genuine new capture, not a duplicate to suppress. */
export async function pullRankForKeyword(p: PullRankParams): Promise<RankPullOutcome> {
  const engine = p.engine ?? "google";
  const device = p.device ?? "desktop";

  // The dispatch call is OUTSIDE any transaction of ours — dispatchProviderOp owns its own
  // connection + advisory-lock critical section (dispatch.ts's documented concurrency model); we
  // only persist the DERIVED snapshot after it returns, exactly like SM-16 will for backlinks.
  const result = await dispatchProviderOp({
    tenantId: p.tenantId,
    engagementId: p.engagementId,
    propertyId: p.propertyId,
    op: {
      kind: "serp", query: p.keyword.keyword, engine, device,
      locale: p.keyword.locale ?? undefined, locationCode: p.locationCode,
    },
    requestedBy: p.requestedBy,
    correlationId: p.correlationId,
    bypassCache: true,
  });

  const serpResults = result.payload as SerpResult[];
  const serp = serpResults[0] as SerpResult | undefined;
  const { position, rankedUrl } = serp
    ? findPropertyPosition(serp.items, p.propertyDomain)
    : { position: null, rankedUrl: null };
  const serpFeatures = serp?.serpFeatures ?? {};

  return withTenants(
    [p.tenantId],
    async (c: PoolClient) => {
      const prev = await c.query<{ position: number | null }>(
        `SELECT position FROM search_rank_snapshots
          WHERE property_id = $1 AND keyword_id = $2 AND engine = $3 AND device = $4
          ORDER BY captured_at DESC LIMIT 1`,
        [p.propertyId, p.keyword.keywordId, engine, device],
      );
      const previousPosition = prev.rows[0]?.position ?? null;

      const id = newId();
      await c.query(
        `INSERT INTO search_rank_snapshots
           (id, tenant_id, property_id, keyword_id, engine, device, location_code, position, ranked_url,
            serp_features, provider, provider_call_id, simulated, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          id, p.tenantId, p.propertyId, p.keyword.keywordId, engine, device, p.locationCode ?? null,
          position, rankedUrl, JSON.stringify(serpFeatures),
          // AC1 (tracker §6j / 0048 column-comment law): stamped from DispatchResult.simulated ONLY.
          // `result.provider` is the driver dispatch actually resolved and billed; `result.ledgerId`
          // is that dispatch's own search_provider_calls row (provider_call_id) — never re-derived
          // from config.search.providerMode, never inferred from this (nullable) FK being present.
          result.provider, result.ledgerId, result.simulated, config.originSite,
        ],
      );

      const dropped = isRankDrop(previousPosition, position);
      if (dropped) {
        await emitEvent(c, p.tenantId, "search_property", p.propertyId, "search.rank.dropped", {
          propertyId: p.propertyId, keywordId: p.keyword.keywordId, keyword: p.keyword.keyword,
          engine, device, previousPosition, newPosition: position,
        });
      }

      return {
        keywordId: p.keyword.keywordId, keyword: p.keyword.keyword, status: "pulled" as const,
        position, rankedUrl, provider: result.provider, simulated: result.simulated,
        dropped, previousPosition,
      };
    },
    { modules: ["search"] },
  );
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// SM-56 — THE COLLECT EDGE (design addendum §A11.1.4; tracker §6ad Ruling 3, §6ah, §6ak)
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// ── The defect this replaces, in one sentence ─────────────────────────────────────────────────────
// `POST rank-pulls/callback` called `pullRankForKeyword` — the unit a MANUAL pull uses — so a genuine
// DataForSEO postback re-entered `postSerpTasks` + `fetchSerpResults` and PAID A SECOND TIME for data
// already bought (~$0.0006/task, charged at post). QA reproduced it at the transport layer: two
// `task_post` requests and two cost-bearing ledger rows for ONE logical capture (§6ak).
//
// ── What a collect is, and the one property that defines it ───────────────────────────────────────
// A collect is RETRIEVAL OF SOMETHING ALREADY PAID FOR. It must cost nothing. Everything below is
// arranged around that single property, and the arrangement is deliberate in three ways:
//
//   1. IT DOES NOT GO THROUGH `dispatchProviderOp`, and that is the correct call rather than a bypass.
//      The choke-point's stated invariant is "there is no other path to SPEND MONEY" — a collect
//      spends nothing, so it does not violate it. Routing a collect through dispatch would have been
//      the WRONG kind of safe: `invokeProvider`'s `serp` case begins with `postSerpTasks`, so the
//      choke-point is precisely the thing that cannot retrieve without buying. It would also mean a
//      budget-exhausted engagement could never collect data it had ALREADY paid for — money spent and
//      the data forfeited, which is worse than either failure alone.
//   2. IT STILL ENFORCES THE FREE GATES, so "n8n gets no bypass" survives the change. The PILLAR kill
//      switch and the engagement's SCOPE toggle are both checked, through the very same
//      `isToggleEnabled` + `OP_SCOPE_TOGGLE`/`OP_PILLAR` the choke-point uses (exported for this
//      purpose rather than reimplemented, so the free path cannot drift into being the lenient one).
//      What is deliberately NOT applied is the BUDGET cascade — all four tiers price an ESTIMATE for
//      work about to be bought, and there is no estimate here because there is no purchase. Refusing a
//      $0 retrieval against a spend ceiling would forfeit paid-for data to protect a budget the
//      retrieval does not touch.
//      The scope toggle IS enforced even though the money is already gone, because `tool_scope` is the
//      standing human authorization for this tool on this engagement (§6ad Ruling 1) — a snapshot
//      written into a client's record for a tool that engagement has switched off is unauthorized
//      DATA, regardless of who paid. The charge stays recorded either way; nothing is concealed.
//   3. IT WRITES NO LEDGER ROW. Not a $0 `completed` row, not a `failed` row for a refusal. The ledger
//      is the SPEND record; `recordBlocked` exists to make a refused *spend attempt* visible in a
//      spend panel, and a collect is not one. A $0 row here would also break the idempotency AC
//      ("no two ledger rows for one task id") for nothing. The ONE ledger effect a collect can have is
//      the §A11.1.4 status advance below, which is an UPDATE of the original charge's own row.
//
// ── Idempotency, which is an AC and not a nicety ──────────────────────────────────────────────────
// Vendor postbacks are AT-LEAST-ONCE by nature, so the same task id WILL arrive twice. The key is
// already in the schema and needed no DDL to find: the original charge's ledger row carries
// `vendor_ref = <task id>` (0053), and `search_rank_snapshots.provider_call_id` FKs to that row. So
// "has this task already been collected?" is answerable exactly — a snapshot already attributed to
// THIS ledger row for THIS property+keyword — and the answer is a no-op, not a second capture.
// That the collected snapshot points at the ORIGINAL row is not just convenient; it is the honest
// provenance: this data came from THAT paid call, and no new call exists to point at.
// The check and the insert share one transaction under a task-scoped advisory lock, so two
// simultaneous redeliveries serialize instead of both passing a read-then-write race.
//
// ── What is NOT idempotency-suppressed, deliberately ──────────────────────────────────────────────
// A genuine SECOND PULL of the same keyword still produces a second snapshot — `search_rank_snapshots`
// is append-only by design (0034) and a re-pull is a real new capture. Only a redelivered COLLECT of
// ONE ALREADY-COLLECTED VENDOR TASK is suppressed. Keying on the task id rather than on
// (property, keyword, day) is what keeps those two cases apart.
//
// ── Attribution: what SM-63 closed, and the one residual it deliberately did NOT invent a fix for ────
// SM-63 added the scope half of the admission check (see it in place below): the resolved ledger row's own
// `engagement_id`/`property_id` must equal the caller's, or the collect is refused as if the task did not
// exist. That closes cross-ENGAGEMENT and cross-PROPERTY misattribution inside a tenant.
//
// WHAT REMAINS OPEN, stated rather than implied: cross-KEYWORD attribution inside ONE engagement+property.
// A task paid for keyword K1 can still be collected under keyword K2 of the same engagement and property,
// writing K1's SERP into K2's history. It is a materially smaller fault — same client, same property, no
// cross-relationship leak and no other engagement's charge touched — but it is real. It is NOT fixed here
// because it is not expressible with what we store: `search_provider_calls` has no keyword column (0034 +
// 0053: engagement/property/provider/endpoint/items/cost/status/vendor_ref, no query), so the row cannot
// witness which keyword it bought. The two closes both need a decision above this seam:
//   (a) stamp the keyword id (or the query) on the ledger row — DDL, senior-db, and a provenance decision
//       about a column that only one capability would populate; or
//   (b) compare the vendor's own echoed `serp.keyword` against the keyword we are writing. Rejected for
//       NOW on purpose: the mock echoes back whatever ref it is handed, so no test in this repo can prove
//       the real driver's echo is stable, and §A10 forbids treating an unverifiable vendor fact as one. A
//       hard refusal keyed on an unproven echo would forfeit already-paid data on any casing or whitespace
//       difference — a fail-closed break on the one path whose whole purpose is not losing paid data.
// Broadening the idempotency key from (provider_call_id, property, keyword) to provider_call_id alone was
// also considered and rejected: it would make the wrong-keyword write a `duplicate` only if the GENUINE
// collect happened first, and if the wrong one won the race it would additionally deny the genuine
// keyword its data — trading a misattribution for a misattribution plus a denial.

/** A task-id-scoped advisory lock namespace, distinct from cache.ts's engagement (0x53450001) and
 *  cache-key (0x53430001) namespaces so a task-id hash can never collide with either lock space.
 *  Defined here rather than in cache.ts because a collect is not a cache operation: it takes no
 *  engagement-spend lock (it makes no spend decision) and no cache-key lock (it writes no cache row),
 *  only this one, whose whole job is to serialize redeliveries of a single vendor task. */
const SEARCH_COLLECT_LOCK_NS = 0x53430002; // 'SC' + 2 — collect-by-task-id serialization

export interface RankCollectOutcome {
  keywordId: string;
  keyword: string;
  /** `collected` — a task_get retrieved the paid result and ONE snapshot was written.
   *  `duplicate` — this vendor task was already collected; nothing was fetched, nothing written. A
   *  redelivered postback is a SUCCESS (the platform holds the data), so this is a 200, not an error:
   *  returning 4xx would make a correctly-behaving at-least-once vendor look like it was failing and
   *  would invite a retry loop over an outcome that is already final. */
  status: "collected" | "duplicate";
  position?: number | null;
  rankedUrl?: string | null;
  provider?: string;
  simulated?: boolean;
  dropped?: boolean;
  previousPosition?: number | null;
  /** The vendor task id this collect resolved — echoed so a relay can correlate its own delivery. */
  taskId: string;
  /** True when this collect closed out a charge SM-50/SM-60 had written off as `incurred`, advancing
   *  that row `incurred -> completed` at the SAME cost (§A11.1.4). Surfaced because it is the one case
   *  where a free collect changes the ledger, and an operator watching orphaned charges wants to know. */
  reconciledIncurred?: boolean;
}

export interface CollectRankParams {
  tenantId: string;
  engagementId: string;
  propertyId: string;
  propertyDomain: string;
  keyword: TrackedKeywordRef;
  /** The vendor's own task id, from the postback. Untrusted input: it is used ONLY as a lookup key
   *  against this tenant's own ledger (§02/§03 — a postback carries an id and is never trusted as
   *  data), and an id with no matching paid row is refused before any vendor call happens. */
  taskId: string;
  engine?: string;
  device?: string;
  locationCode?: number;
  requestedBy: string | null;
}

/** SM-56 — collect ONE already-paid Standard-queue SERP task and persist its snapshot. Costs nothing.
 *
 *  Throws (all before or instead of any vendor call, so a refusal is always free):
 *    * `PillarDisabledError`     — the 'seo' operator brake is off (503 via the SM-53 filter).
 *    * `ScopeDisabledError`      — this engagement's `rank` toggle is off (409, names the toggle).
 *    * `UnknownVendorTaskError`  — no ledger row for (tenant, provider, taskId): no evidence we paid —
 *                                  OR (SM-63) a row exists but its OWN engagement/property is not the one
 *                                  this call claims, i.e. someone else paid for it. ONE error, ONE message,
 *                                  ONE 404 for both, so the edge cannot be used to discover that a task id
 *                                  exists under a different engagement.
 *    * `CollectUnsupportedError` — the resolved driver has no `fetchSerpByTaskId` (503). Never a
 *                                  fallback to the dispatch path; that fallback is the whole defect.
 *  A vendor-side failure (task still queued, per-task error) propagates the driver's own error and
 *  leaves NOTHING written — the original charge's row stands exactly as it was, which is the honest
 *  state: money spent, data not yet in hand, nothing invented. */
export async function collectRankForTask(p: CollectRankParams): Promise<RankCollectOutcome> {
  const engine = p.engine ?? "google";
  const device = p.device ?? "desktop";

  // (-1) PILLAR kill switch — the same operator brake dispatch checks first, and for the same reason:
  // a disabled pillar means "this capability does not exist right now", which includes writing new
  // snapshots from it. Checked before the engagement is even loaded.
  const pillar = OP_PILLAR.serp;
  if (!config.search.pillars[pillar]) throw new PillarDisabledError(pillar, "serp");

  const eng = await loadEngagementScope(p.tenantId, p.engagementId);
  if (!eng) throw new Error("engagement not found");

  // (0) SCOPE gate — same helper, same toggle map as the choke-point (see the block comment above for
  // why a free collect still honours this, and why no `failed` ledger row is written for the refusal).
  const toggle = OP_SCOPE_TOGGLE.serp;
  if (!isToggleEnabled(eng.toolScope, toggle)) throw new ScopeDisabledError(toggle, "serp");

  // Provider resolution runs the same registration + capability cascade a pull does, so a collect can
  // never reach a driver the engagement is not configured for. It selects WHICH vendor's namespace the
  // task id is interpreted in — which is exactly why the ledger lookup below is provider-scoped
  // (SM-59): a task id means nothing without knowing whose id it is.
  const provider = resolveProvider(eng.toolScope, "serp");

  // The admission check, and the anti-forgery property. A postback for a task this tenant has no paid
  // row for is refused HERE — before any socket to the vendor — so a forged or replayed-with-garbage
  // id costs one indexed lookup and nothing else. RLS on the scoped connection means a caller
  // authenticated for tenant A quoting tenant B's task id finds nothing: foreclosed, not filtered.
  const paidCall = await findLedgerRowByVendorRef(p.tenantId, provider.key, p.taskId);
  if (!paidCall) throw new UnknownVendorTaskError(provider.key, p.taskId);

  // SM-63 — THE SECOND HALF OF THE ADMISSION CHECK: the resolved row must belong to the SCOPE the caller
  // is claiming it for. Until SM-63 the check above was the whole test, and it is scoped to
  // (tenant, provider, vendor_ref) — so any engagement in the tenant could present any OTHER engagement's
  // task id and have a snapshot written under its own property, stamped `provider_call_id` = the other
  // engagement's paid row. RLS forecloses only the cross-TENANT shape; the same-tenant, wrong-engagement
  // shape is invisible to it, and the controller's own checks prove only that the caller's three ids are
  // consistent WITH EACH OTHER — never with the row that paid. Two things followed from that gap: data
  // bought for one client relationship was attributable to another that never posted or paid for it, and
  // (worse, because it is money) a wrong-scope collect against an `incurred` row would have run the
  // §A11.1.4 advance below, silently reconciling somebody else's orphaned charge as a side effect of a
  // request that named a different engagement entirely.
  //
  // THE REFUSAL IS DELIBERATELY THE SAME ERROR, THE SAME MESSAGE AND THE SAME 404 as an unknown task id,
  // and that is a security property, not laziness:
  //   * It must not become an oracle. A distinct status or message ("that task belongs to another
  //     engagement") would confirm the id EXISTS and is owned by someone else — turning this edge into an
  //     enumerator over other engagements' task ids for anyone holding the relay secret. The only honest
  //     thing to tell this caller is what is true from where it stands: there is no such paid task FOR
  //     YOU. `ledgerRowScopeMatches` returns a bare boolean for the same reason — the information needed
  //     to build a finer message is never produced.
  //   * It matches how the cross-tenant case already behaves (404 through RLS foreclosure), so the two
  //     shapes of "this task is not yours" answer identically instead of leaking which wall stopped you.
  //   * 403/409 were both rejected: 403 asserts the resource exists but is forbidden (the oracle again),
  //     and 409 claims a state conflict a correctly-behaving vendor could resolve by retrying — inviting a
  //     retry loop over an outcome that will never change.
  // Placed IMMEDIATELY after the null check — before the `fetchSerpByTaskId` capability check — so a
  // wrong-scope caller cannot even distinguish the two by which of 404/503 comes back first. Like every
  // other refusal here it costs one indexed lookup: no vendor socket, no write, no ledger row.
  if (!ledgerRowScopeMatches(paidCall, { engagementId: p.engagementId, propertyId: p.propertyId })) {
    throw new UnknownVendorTaskError(provider.key, p.taskId);
  }

  // Refuse rather than re-post. `fetchSerpByTaskId` is optional on the interface precisely so that a
  // driver which cannot collect says so instead of silently falling back to the paid path.
  if (!provider.fetchSerpByTaskId) throw new CollectUnsupportedError(provider.key);
  const fetchByTaskId = provider.fetchSerpByTaskId.bind(provider);

  return withTenants(
    [p.tenantId],
    async (c: PoolClient) => {
      // Serialize redeliveries of THIS task id. xact-scoped, so it is released by COMMIT/ROLLBACK and
      // cannot leak. Two simultaneous postbacks for one task now queue behind each other, and the
      // second sees the first's committed snapshot instead of racing past a read-then-write check.
      await c.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [SEARCH_COLLECT_LOCK_NS, p.taskId]);

      // IDEMPOTENCY (the AC). Keyed on the ORIGINAL paid call's row via provider_call_id — see the
      // block comment above for why that key is exact and why it needed no new column. Scoped to this
      // property+keyword as well, so the check answers "was THIS capture already collected" rather
      // than the looser "did anything ever cite this ledger row".
      const existing = await c.query<{ id: string }>(
        `SELECT id FROM search_rank_snapshots
          WHERE provider_call_id = $1 AND property_id = $2 AND keyword_id = $3
          LIMIT 1`,
        [paidCall.id, p.propertyId, p.keyword.keywordId],
      );
      if (existing.rows.length > 0) {
        return {
          keywordId: p.keyword.keywordId, keyword: p.keyword.keyword, status: "duplicate" as const,
          taskId: p.taskId, provider: paidCall.provider, simulated: paidCall.simulated,
        };
      }

      // THE COLLECT ITSELF — `task_get` only, no `task_post`, asserted at the transport layer in
      // dataforseo.sandbox.test.ts. Deliberately NOT wrapped in `withActualCostCapture`: there is no
      // charge to capture (the money was declared at the original post), and running outside that
      // scope makes any future stray `recordIncurredCostUsd` a documented no-op rather than a phantom
      // cost-bearing row. Inside the transaction, matching dispatch's own precedent of holding the
      // critical section across its network call.
      const serp = await fetchByTaskId({ id: p.taskId, keyword: p.keyword.keyword });

      const { position, rankedUrl } = findPropertyPosition(serp.items, p.propertyDomain);
      const serpFeatures = serp.serpFeatures ?? {};

      const prev = await c.query<{ position: number | null }>(
        `SELECT position FROM search_rank_snapshots
          WHERE property_id = $1 AND keyword_id = $2 AND engine = $3 AND device = $4
          ORDER BY captured_at DESC LIMIT 1`,
        [p.propertyId, p.keyword.keywordId, engine, device],
      );
      const previousPosition = prev.rows[0]?.position ?? null;

      const id = newId();
      await c.query(
        `INSERT INTO search_rank_snapshots
           (id, tenant_id, property_id, keyword_id, engine, device, location_code, position, ranked_url,
            serp_features, provider, provider_call_id, simulated, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          id, p.tenantId, p.propertyId, p.keyword.keywordId, engine, device, p.locationCode ?? null,
          position, rankedUrl, JSON.stringify(serpFeatures),
          // Provenance comes from the ORIGINAL PAID CALL's row, not from the current platform mode and
          // not from the collect: this data was produced by that call, so `provider`, `provider_call_id`
          // and `simulated` all describe it. That keeps 0048's column-comment law intact (AC1) with no
          // new ledger row to stamp — and it is why a collect can never mislabel a real capture as
          // simulated (or the reverse) after a mode flip between post and postback.
          paidCall.provider, paidCall.id, paidCall.simulated, config.originSite,
        ],
      );

      // §A11.1.4's reconciliation, IN THE SAME TRANSACTION as the snapshot. A charge SM-50/SM-60 wrote
      // off as `incurred` ("charged, platform retains nothing") has just delivered, so the honest
      // bookkeeping is ONE charge, ONE row, now completed — at the SAME cost, with no re-post and no
      // second cost-bearing row. Atomic with the snapshot so a reader can never see a snapshot claiming
      // data for a row that still says nothing was retained. A row in any other status is untouched:
      // the UPDATE's own `status = 'incurred'` guard makes that structural, not a branch here.
      const reconciledIncurred = paidCall.status === "incurred"
        ? await advanceIncurredToCompletedOnConnection(c, paidCall.id)
        : false;

      const dropped = isRankDrop(previousPosition, position);
      if (dropped) {
        await emitEvent(c, p.tenantId, "search_property", p.propertyId, "search.rank.dropped", {
          propertyId: p.propertyId, keywordId: p.keyword.keywordId, keyword: p.keyword.keyword,
          engine, device, previousPosition, newPosition: position,
        });
      }

      return {
        keywordId: p.keyword.keywordId, keyword: p.keyword.keyword, status: "collected" as const,
        position, rankedUrl, provider: paidCall.provider, simulated: paidCall.simulated,
        dropped, previousPosition, taskId: p.taskId, reconciledIncurred,
      };
    },
    { modules: ["search"] },
  );
}

export interface RankPullBatchResult {
  engagementId: string;
  propertyId: string;
  attempted: number;
  pulled: number;
  skipped: number;
  failed: number;
  results: RankPullOutcome[];
}

/** Pull ranks for a batch of tracked keywords under one engagement (search.controller.ts's
 *  POST .../rank-pull). Sequential, not parallel: dispatchProviderOp already serializes identical
 *  concurrent calls under the engagement's advisory lock, and a scope/pillar/budget refusal applies
 *  IDENTICALLY to every remaining keyword in the batch (none of those gates are per-keyword) — once
 *  one fires, retrying the rest would only add N more `recordBlocked` ledger rows for an outcome
 *  already known, so the loop stops there and reports what was already pulled. A per-KEYWORD failure
 *  (e.g. a malformed provider response for that one query) does NOT stop the batch. */
export async function pullRanksForEngagement(input: {
  tenantId: string;
  engagementId: string;
  propertyId: string;
  propertyDomain: string;
  keywords: TrackedKeywordRef[];
  requestedBy: string | null;
  correlationId?: string | null;
}): Promise<RankPullBatchResult> {
  const results: RankPullOutcome[] = [];
  let pulled = 0;
  let skipped = 0;
  let failed = 0;
  let stopped: string | null = null;

  for (const kw of input.keywords) {
    if (stopped) {
      results.push({ keywordId: kw.keywordId, keyword: kw.keyword, status: "skipped", reason: stopped });
      skipped++;
      continue;
    }
    try {
      const outcome = await pullRankForKeyword({
        tenantId: input.tenantId, engagementId: input.engagementId, propertyId: input.propertyId,
        propertyDomain: input.propertyDomain, keyword: kw,
        requestedBy: input.requestedBy, correlationId: input.correlationId,
      });
      results.push(outcome);
      pulled++;
    } catch (err) {
      if (err instanceof ProviderDispatchError) {
        results.push({ keywordId: kw.keywordId, keyword: kw.keyword, status: "skipped", reason: err.code });
        skipped++;
        stopped = err.code;
      } else {
        results.push({ keywordId: kw.keywordId, keyword: kw.keyword, status: "failed", reason: (err as Error).message });
        failed++;
      }
    }
  }

  return { engagementId: input.engagementId, propertyId: input.propertyId, attempted: input.keywords.length, pulled, skipped, failed, results };
}

// ── keyword-metrics writer (AC2/AC3) ────────────────────────────────────────────────────────────────
export interface MetricsPullOutcome {
  keywordId: string;
  keyword: string;
  status: "updated" | "absent" | "skipped" | "failed";
  volume?: number | null;
  difficulty?: number | null;
  cpcUsd?: number | null;
  provider?: string;
  simulated?: boolean;
  reason?: string;
}

export interface MetricsPullBatchResult {
  attempted: number;
  updated: number;
  absent: number;
  skipped: number;
  failed: number;
  results: MetricsPullOutcome[];
}

/** Pull volume/difficulty/cpc for a batch of keywords (search.controller.ts's POST
 *  .../metrics-pull) — the "keyword-metrics writer" tracker §6j's AC2 requires, discharging SM-36's
 *  carried-forward AC (search-marketing-execution-tracker §6j: "the keyword-metrics writer stamps
 *  metrics_provider + metrics_simulated in the SAME UPDATE as the metric values"). Same sequential /
 *  hard-stop-on-choke-point-refusal shape as pullRanksForEngagement, for the identical reason. */
export async function pullMetricsForKeywords(input: {
  tenantId: string;
  engagementId: string;
  propertyId: string | null;
  keywords: TrackedKeywordRef[];
  requestedBy: string | null;
  correlationId?: string | null;
}): Promise<MetricsPullBatchResult> {
  const results: MetricsPullOutcome[] = [];
  let updated = 0;
  let absent = 0;
  let skipped = 0;
  let failed = 0;
  let stopped: string | null = null;

  for (const kw of input.keywords) {
    if (stopped) {
      results.push({ keywordId: kw.keywordId, keyword: kw.keyword, status: "skipped", reason: stopped });
      skipped++;
      continue;
    }

    let dispatch: Awaited<ReturnType<typeof dispatchProviderOp>>;
    try {
      dispatch = await dispatchProviderOp({
        tenantId: input.tenantId, engagementId: input.engagementId, propertyId: input.propertyId,
        op: { kind: "volume", query: kw.keyword, locale: kw.locale ?? undefined },
        requestedBy: input.requestedBy, correlationId: input.correlationId,
      });
    } catch (err) {
      if (err instanceof ProviderDispatchError) {
        results.push({ keywordId: kw.keywordId, keyword: kw.keyword, status: "skipped", reason: err.code });
        skipped++;
        stopped = err.code;
      } else {
        results.push({ keywordId: kw.keywordId, keyword: kw.keyword, status: "failed", reason: (err as Error).message });
        failed++;
      }
      continue;
    }

    const metrics = (dispatch.payload as KeywordMetrics[])[0] as KeywordMetrics | undefined;
    // AC3: "Keywords absent from a pull's response keep NULL provider and prior values untouched
    // (absent stays absent)". A provider that genuinely returned nothing for this query must not
    // touch the row at all — not even to re-stamp provenance — so a keyword that was never pulled
    // stays honestly NULL, and one with prior (e.g. simulated) values is left exactly as it was.
    if (!metrics) {
      results.push({ keywordId: kw.keywordId, keyword: kw.keyword, status: "absent" });
      absent++;
      continue;
    }

    await withTenants(
      [input.tenantId],
      (c: PoolClient) => c.query(
        // AC2: metrics_provider + metrics_simulated set in the SAME UPDATE as the metric values —
        // provenance can never disagree with the payload it sits on (the writeCache atomicity
        // principle, tracker §6j). AC3's second clause ("a live re-pull over previously-simulated
        // metrics overwrites value+provider+flag together") falls out of this being an
        // UNCONDITIONAL overwrite whenever the keyword IS present — no branching on the row's prior
        // metrics_simulated value is needed or present here.
        `UPDATE search_keywords
            SET volume = $2, difficulty = $3, cpc_usd = $4,
                metrics_provider = $5, metrics_simulated = $6, metrics_fetched_at = now(), updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL`,
        [
          kw.keywordId,
          metrics.volume ?? null,
          metrics.difficulty ?? null,
          metrics.cpcUsd ?? null,
          dispatch.provider,
          dispatch.simulated,
        ],
      ),
      { modules: ["search"] },
    );
    results.push({
      keywordId: kw.keywordId, keyword: kw.keyword, status: "updated",
      volume: metrics.volume ?? null, difficulty: metrics.difficulty ?? null, cpcUsd: metrics.cpcUsd ?? null,
      provider: dispatch.provider, simulated: dispatch.simulated,
    });
    updated++;
  }

  return { attempted: input.keywords.length, updated, absent, skipped, failed, results };
}
