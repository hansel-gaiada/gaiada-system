// SM-54 — THE platform-side search pull scheduler (tracker §6ad Ruling 1 + SM-54 row, design
// addendum §A13.2 — both BINDING). The search department's first automation: until this file
// existed, every paid pull was a manual API call, so no cadence a human configured ever ran.
//
// ── WHY THIS IS A PLATFORM JOB AND NOT AN n8n FLOW (§A13.2, do not reopen — §6ac/§6ad) ────────────
// This loop does not decide to spend money. It EXECUTES CONFIGURATION A VERIFIED HUMAN ALREADY SET:
// an engagement's `tool_scope.<tool>` — its per-tool toggle, cadence and the engagement's budget cap,
// writable only under `search:scope:write` (Cerbos-gated, verified human) — IS the standing
// authorization for recurring vendor spend, exactly as an approved row is the authorization artifact
// for a one-off (§07). n8n was rejected as the host because every automation principal is minted
// `assurance: "low"` BY CONSTRUCTION (mcp-hub/src/principal.ts — since 2026-08-06 that means an
// explicit `isAutomation` refusal inside `elevateAssurance` rather than the absence of any minting path
// at all; see `modules/search/index.ts`'s §A13 note for why the distinction matters and which test
// pins it) and every `search.*` write tool is `minAssurance: "verified"`. Lowering that
// gate so a scheduled flow could spend unattended would have weakened TWO controls on the money path
// (the assurance gate AND the D14 medium-impact suspend) to avoid writing this file. The hard rule that
// came out of the same ruling and that this file must never undermine: **no allow-list may ever include
// a money-spending tool.** Nothing here is reachable from the MCP surface — it has no HTTP route, no
// tool binding, and no principal; it is started from `main.ts` like every other in-process job.
//
// ── WHAT IT MAY AND MAY NOT DO ────────────────────────────────────────────────────────────────────
// It dispatches ONLY through the existing module functions (`pullRanksForEngagement`,
// `pullMetricsForKeywords`, `pullBacklinksForProperty`, `pullAiVisibilityForProperty`), which route
// through `dispatchProviderOp` — so the pillar kill switch, the scope toggle, the four-tier budget
// stop-loss, the ledger, the cache and the advisory-lock critical section all apply UNCHANGED and are
// INHERITED, never re-implemented. There is deliberately no parallel dispatch path here, no direct
// provider call, and no `override: true` anywhere in this file: the manual cap-override
// (`search:provider:admin`) is a human-audited action and an unattended loop must never be able to
// spend past a cap.
//
// Attribution (§A13.2, verbatim): every scheduler-initiated ledger row carries `requested_by = NULL`
// (there is no human and there is no OBO automation user — inventing one would be exactly the
// fabricated-identity failure §6ac recorded as a standing rule) and `correlationId = 'sched:<tool>'`.
//
// ── CADENCE IS DERIVED, NEVER HARDCODED (hazard 1) ────────────────────────────────────────────────
// There is no schedule in this file. A tool is due when
//     now - lastRunAt >= cadenceDays(tool_scope.<tool>.cadence)
// where `lastRunAt` is read from the platform's OWN data (see `loadLastRuns`). The scope editor stays
// the single source of truth for what a client pays for: change the cadence and the next tick obeys it;
// switch the toggle off and the engagement is not selected at all (no dispatch, no refusal row).
// `SEARCH_SCHEDULER_INTERVAL_MS` controls only HOW OFTEN DUE-NESS IS RE-ASKED, never how often a pull
// happens — an interval shorter than the shortest cadence changes nothing about spend.
//
// ── SM-61 (tracker §6au, BINDING) — AN ABSENT CADENCE IS ON-DEMAND, NEVER A DEFAULT SCHEDULE ─────
// This file used to default an absent/unrecognized cadence to weekly-conservative (7 days) — a
// clause of THIS ticket's own original spec. That was wrong: `providers/dispatch.ts`'s projection
// had always priced an absent cadence as one on-demand refresh/month, so a cadence-less enabled tool
// (e.g. the `standard` preset's `volume`, pre-SM-61) was scheduled ~4x more often than the scope
// panel showed a human. The architect's ruling: `ScopeEditor.tsx`'s cadence <select> already renders
// an empty value as "on-demand" — so `enabled: true` with no cadence is not an omission, it is a
// configuration the UI has been naming all along, and this loop must never select it.
// `modules/search/cadence.ts`'s `parseCadence` is the single, no-default parser both this file and
// the projection now import — a cadence-less or junk-cadence enabled tool ticks `status: "on_demand"`
// below, exactly like `disabled` (no dispatch, no ledger row, no activity row), and is counted
// separately in `SweepResult.onDemand`.
//
// ── RETRY: ZERO, AND ONE STEP MORE CONSERVATIVE THAN SM-15 (hazard 4) ─────────────────────────────
// SM-15's ruling is preserved: a failed or refused tick is NEVER retried; the next tick re-derives
// due-ness. But SM-15 ran as a DAILY cron, so "the next tick" was a day later. This loop is polled
// (default hourly), and if due-ness were derived from the last successful CAPTURE alone, an engagement
// whose pull keeps failing would be re-attempted on EVERY tick — an eager retry on a paid pull by the
// back door, which is how a DataForSEO deposit drains (a `task_post` is charged at post, so a pull that
// fails *after* the billing point still costs money — SM-50/SM-60). So `lastRunAt` is
//     GREATEST(last successful capture, last SCHEDULER ATTEMPT recorded in the ledger)
// and a failed/refused attempt therefore consumes its cadence window exactly as a successful one does.
// Both halves are still derived from the platform's own tables, so a genuine miss still self-heals at
// the next window without any retry state. The one refusal that writes no ledger row and so does not
// consume a window is `PillarDisabledError` (the operator kill switch — checked before anything is
// loaded, costs one config read and touches nothing), and re-asking that every tick is correct: it is a
// brake an operator flips back on, not a failure to back off from.
//
// ── OVERLAP: WHAT SERIALIZES TWO TICKS (hazard 2) ─────────────────────────────────────────────────
// `dispatchProviderOp`'s advisory lock serializes concurrent IDENTICAL ops but DOES NOT DEDUPE A
// CHARGE, and rank pulls set `bypassCache: true` by design so there is no cache single-flight to fall
// back on. Two overlapping sweeps would therefore both spend. Three layers, in order:
//   1. The chained-setTimeout loop schedules the next tick only after the current one RESOLVES, so a
//      single process never overlaps itself (the reconcile/burndown precedent).
//   2. A **session-scoped Postgres advisory lock** (`SEARCH_SCHEDULER_LOCK_NS`) held for the whole
//      sweep on one dedicated connection. `pg_try_advisory_lock` is non-blocking: a second sweep —
//      another tick, another platform INSTANCE, or a test calling `runSearchPullSweep()` directly —
//      gets `false` and returns `skippedLocked` having dispatched nothing. Session-scoped (not
//      xact-scoped) because a sweep spans many transactions; released in `finally` and, on a crash,
//      by the connection dropping, so it cannot wedge.
//   3. Belt and braces for SEQUENTIAL ticks only: a later tick reads the earlier tick's own ledger
//      attempt row and finds the tool not due. Stated precisely because it is NOT a substitute for the
//      lock — two GENUINELY concurrent sweeps both read due-ness before either commits, so layer 2 is
//      the only thing standing between them and two charges. That is what the overlap test probes.
// What is deliberately NOT deduped — parity with today, per the SM-54 spec item 6: a MANUAL pull
// racing a scheduled one. Those are two humanly-distinct intents; `dispatchProviderOp`'s engagement
// lock serializes them, and the second is a genuine new capture (`search_rank_snapshots` is
// append-only, 0034), not a duplicate to suppress.
//
// ── MULTI-TENANCY (hazard 3) ──────────────────────────────────────────────────────────────────────
// There is no HTTP principal here. The company list is read with `withGlobal` (companies carry no
// tenant_id — they ARE the tenants; the `startBurndownSnapshotLoop` precedent), and EVERY tenant-owned
// read goes through `withTenants([tenantId], fn, { modules: ["search"] })` — one tenant per call, module
// scope always declared, because the `search_*` tables compose their RLS as
// `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('search')` and an omitted module scope
// reads ZERO rows (fail-closed, and a scheduler that silently sees nothing is indistinguishable from a
// scheduler with nothing to do). There is NO cross-tenant `withTenants` call in this file and there
// must never be one: `lint:withtenants` is content-keyed and would need an architect-ratified entry.
// Per-tenant enablement goes through `isModuleEnabled` — the ONE place the enabled_modules OR
// active-service_assignment clause lives — so a served tenant is scheduled and a disabled one is not.
//
// ── A WRONG CHEAP PASS SPENDS SILENTLY (hazard 5) ─────────────────────────────────────────────────
// The failure mode is not a crash. It is a loop that thinks everything is due, or that ignores a
// disabled toggle. So: the toggle is checked in this file BEFORE selection (a disabled tool is never
// dispatched and writes no refusal row) AND again inside `dispatchProviderOp` (which would refuse
// naming the toggle) — two independent gates, and the second one is the authoritative one. Spend is
// additionally bounded per tick by the toggle's own `maxKeywords`/`maxQueries` (see `applyScopeLimit`),
// so one tick can never cost more than the scope panel projected.
import type { PoolClient } from "pg";
import { withGlobal, withTenants } from "../../db";
import { config } from "../../config";
import { writeActivity } from "../../core/http";
import { isModuleEnabled } from "../registry";
import { isToggleEnabled } from "./providers/dispatch";
import { ProviderDispatchError } from "./providers/types";
import { pullMetricsForKeywords, pullRanksForEngagement, type TrackedKeywordRef } from "./rank";
import { pullBacklinksForProperty } from "./backlinks";
import { pullAiVisibilityForProperty } from "./ai-visibility";
import { cadenceDays, parseCadence, SCHEDULED_TOOLS, type Cadence, type ScheduledTool } from "./cadence";

// `SCHEDULED_TOOLS`/`ScheduledTool` now live in `./cadence` (SM-61, §6au clause 3 note) — the SAME
// list `providers/dispatch.ts` reads for `ProjectedToolCost.scheduled`, so this file's own sweep and
// that projection can never disagree about which tools are actually scheduled. Re-exported here so
// this module's existing callers/tests keep importing both names from ONE place.
export { SCHEDULED_TOOLS };
export type { ScheduledTool };

/** §A13.2's attribution half: `correlationId 'sched:<tool>'` on every scheduler-initiated ledger row.
 *  Exported because it is BOTH what dispatch stamps and what `loadLastRuns` reads back as the
 *  last-attempt timestamp — the two must never drift, so there is one function. */
export function schedulerCorrelationId(tool: ScheduledTool): string {
  return `sched:${tool}`;
}

// ── cadence derivation (SM-61, tracker §6au: via modules/search/cadence.ts, no local re-parse) ────
// `cadenceDays` is re-exported from `./cadence` so existing callers/tests of this module do not need
// to reach into a second file for the one arithmetic fact this loop needs from it.
export { cadenceDays };

/** Pure due-ness for a REAL (already-parsed, non-null) cadence — a caller holding `null` (on-demand,
 *  see `cadence.ts`) must never reach this function; that branch is handled by the `on_demand`
 *  status below, one level up, precisely so this function can never be asked to invent a schedule
 *  for "absent". No prior run at all => due (a newly-configured tool must produce its first capture).
 *
 *  NO EARLY-FIRE TOLERANCE, deliberately. A grace window (so a "daily" pull isn't pushed later by the
 *  poll interval) would let a daily tool fire up to 31 times a month instead of 30 — a real overspend
 *  against what the scope panel projected. Without it a daily tool fires every 24h + up to one poll
 *  interval, i.e. ~29 times a month. Under-running is the safe direction on an unattended money path
 *  and keeps the projection an upper bound; the cost is at most one deferred capture per period. */
export function isDue(now: Date, lastRunAt: Date | null, cadence: Cadence): boolean {
  if (!lastRunAt) return true;
  return now.getTime() - lastRunAt.getTime() >= cadenceDays(cadence) * 24 * 3600 * 1000;
}

/** The scope-configured per-run item bound. Applied so ONE TICK CAN NEVER COST MORE THAN THE SCOPE
 *  PANEL PROJECTED: `projectMonthlyCost` prices a run at `toggle.maxKeywords ?? 50` items (10 queries
 *  for ai_visibility), and the human approved THAT number. An unbounded scheduled batch over, say, 300
 *  tracked keywords would bill 6x the approved projection every single run.
 *
 *  When the toggle sets no bound we fall back to the SAME default the projection uses, and the applied
 *  limit + the eligible count are both reported in the tick outcome and the activity row — so an
 *  under-pull is visible rather than silent. The manual routes deliberately keep NO cap: a human
 *  clicking a button is accepting that spend interactively, which is not this loop's situation. */
export function applyScopeLimit<T>(items: T[], toggle: Record<string, unknown>, fallback: number, key = "maxKeywords"): {
  selected: T[];
  eligible: number;
  limit: number;
} {
  const raw = toggle[key];
  const limit = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
  return { selected: items.slice(0, limit), eligible: items.length, limit };
}

// ── outcomes ──────────────────────────────────────────────────────────────────────────────────────
export interface ToolTickOutcome {
  tool: ScheduledTool;
  /** `dispatched` — the module function ran (its own per-item skipped/failed counts ride along).
   *  `not_due`    — cadence window not elapsed since the last capture-or-attempt.
   *  `disabled`   — the engagement's toggle for this tool is off; NOT dispatched, no refusal row.
   *  `on_demand`  — SM-61 (§6au): the toggle IS enabled but carries no (or an unrecognized) cadence.
   *                 Behaves exactly like `disabled` — NOT dispatched, no refusal row, no activity
   *                 row — because an absent cadence is not an omission, it is the on-demand
   *                 configuration `ScopeEditor.tsx`'s cadence select has always named. Counted
   *                 separately in `SweepResult.onDemand`, never folded into `disabled`, so an
   *                 operator can tell "switched off" apart from "on, but never scheduled".
   *  `no_work`    — enabled + due, but the engagement has nothing to pull (no tracked keywords, no
   *                 configured GEO queries). No dispatch, no cost.
   *  `refused`    — the choke-point refused (pillar/scope/budget/provider-availability). `reason` is
   *                 the `ProviderDispatchError` code and `detail` its own message, which names the
   *                 toggle or the breached tier.
   *  `failed`     — anything else thrown. Contained to this tool; the sweep continues. */
  status: "dispatched" | "not_due" | "disabled" | "on_demand" | "no_work" | "refused" | "failed";
  reason?: string;
  detail?: string;
  /** The PARSED cadence (`cadence.ts`'s `Cadence | null`) — `null` covers both a genuinely absent
   *  key and an unrecognized one (SM-61: junk must read identically to absent, never as its own
   *  guessed schedule). */
  cadence: Cadence | null;
  lastRunAt: string | null;
  attempted?: number;
  pulled?: number;
  skipped?: number;
  failed?: number;
  /** Set when `applyScopeLimit` actually truncated — the honest record of a deliberate under-pull. */
  eligible?: number;
  limit?: number;
}

export interface EngagementTickOutcome {
  tenantId: string;
  engagementId: string;
  propertyId: string;
  tools: ToolTickOutcome[];
}

export interface SweepResult {
  /** True when another sweep held the advisory lock: this tick did NOTHING. Never an error. */
  skippedLocked: boolean;
  tenants: number;
  engagements: number;
  dispatched: number;
  refused: number;
  failed: number;
  notDue: number;
  disabled: number;
  /** SM-61 (§6au): cadence-less enabled tools, counted apart from `disabled` — see
   *  `ToolTickOutcome.status`'s `on_demand` header note. */
  onDemand: number;
  noWork: number;
  /** Per-tenant or per-engagement faults that were contained (never a refusal — those are `refused`). */
  errors: number;
  outcomes: EngagementTickOutcome[];
}

/** Session-scoped namespace for the sweep lock. Distinct from cache.ts's engagement (0x53450001) and
 *  cache-key (0x53430001) namespaces and rank.ts's collect (0x53430002), so a sweep can never contend
 *  with a dispatch's own critical section — it must not, since the sweep CONTAINS dispatches. */
const SEARCH_SCHEDULER_LOCK_NS = 0x53430003; // 'SC' + 3 — whole-sweep serialization
const SEARCH_SCHEDULER_LOCK_KEY = 0; // one global sweep; no per-tenant sharding (the sweep is serial)

interface EngagementCandidate {
  engagementId: string;
  propertyId: string;
  propertyDomain: string;
  toolScope: Record<string, unknown>;
}

/** Active engagements on active, non-deleted properties.
 *
 *  `p.status = 'active'` is a SCHEDULER-ONLY narrowing (the manual routes don't apply it): buying
 *  vendor data unattended for a paused or archived property is pure waste, and a human who wants it
 *  anyway can still pull manually. `e.status = 'active'` is the SM-54 spec's own wording ("active
 *  engagement") — a draft/paused/closed engagement is not a running client commitment. */
async function loadCandidates(c: PoolClient, tenantId: string): Promise<EngagementCandidate[]> {
  const { rows } = await c.query<{
    id: string; property_id: string; domain: string; tool_scope: Record<string, unknown> | null;
  }>(
    `SELECT e.id, e.property_id, p.domain, e.tool_scope
       FROM search_engagements e
       JOIN search_properties p ON p.id = e.property_id
      WHERE e.tenant_id = $1
        AND e.status = 'active' AND e.deleted_at IS NULL
        AND p.status = 'active' AND p.deleted_at IS NULL
      ORDER BY e.created_at ASC`,
    [tenantId],
  );
  return rows.map((r) => ({
    engagementId: r.id,
    propertyId: r.property_id,
    propertyDomain: r.domain,
    toolScope: r.tool_scope ?? {},
  }));
}

/** `lastRunAt` per tool = GREATEST(last successful CAPTURE, last scheduler ATTEMPT) — see the file
 *  header's retry section for why the attempt half is load-bearing rather than decorative.
 *
 *  The capture half reads the module's own append-only snapshot tables (and `search_keywords.
 *  metrics_fetched_at` for the metrics refresh, which is that tool's own cache stamp). Rank/backlinks/
 *  ai_visibility captures are keyed by PROPERTY rather than by engagement because that is what those
 *  tables record — two engagements sharing one property therefore share a cadence window, which is the
 *  honest reading: the second engagement's pull would buy data the first already paid for.
 *
 *  The attempt half reads `search_provider_calls` filtered to THIS scheduler's own correlation ids, so
 *  a manual pull never satisfies a scheduled cadence and vice versa. It counts every status — `posted`,
 *  `completed`, `failed`, the `incurred` compensation rows and the $0 `recordBlocked` refusal rows —
 *  because the question is "did we already attempt this window?", not "did it work". */
async function loadLastRuns(
  c: PoolClient,
  engagementId: string,
  propertyId: string,
): Promise<Record<ScheduledTool, Date | null>> {
  const caps = await c.query<{
    rank: Date | null; volume: Date | null; backlinks: Date | null; ai_visibility: Date | null;
  }>(
    `SELECT
       (SELECT max(captured_at) FROM search_rank_snapshots WHERE property_id = $2) AS rank,
       (SELECT max(k.metrics_fetched_at) FROM search_keywords k
          JOIN search_keyword_sets s ON s.id = k.set_id
         WHERE s.engagement_id = $1 AND k.deleted_at IS NULL) AS volume,
       (SELECT max(captured_at) FROM search_backlink_snapshots WHERE property_id = $2) AS backlinks,
       (SELECT max(captured_at) FROM search_ai_visibility WHERE property_id = $2) AS ai_visibility`,
    [engagementId, propertyId],
  );
  const attempts = await c.query<{ correlation_id: string; last_at: Date }>(
    `SELECT correlation_id, max(created_at) AS last_at
       FROM search_provider_calls
      WHERE engagement_id = $1 AND correlation_id = ANY($2)
      GROUP BY correlation_id`,
    [engagementId, SCHEDULED_TOOLS.map(schedulerCorrelationId)],
  );
  const attemptByTool = new Map<string, Date>();
  for (const row of attempts.rows) attemptByTool.set(row.correlation_id, new Date(row.last_at));

  const capRow = caps.rows[0];
  const out = {} as Record<ScheduledTool, Date | null>;
  for (const tool of SCHEDULED_TOOLS) {
    const captured = capRow?.[tool] ? new Date(capRow[tool] as unknown as string) : null;
    const attempted = attemptByTool.get(schedulerCorrelationId(tool)) ?? null;
    out[tool] = !captured ? attempted : !attempted ? captured : captured > attempted ? captured : attempted;
  }
  return out;
}

async function trackedKeywords(c: PoolClient, engagementId: string): Promise<TrackedKeywordRef[]> {
  // Same shape + ORDER BY as search.controller.ts's rank-pull, so a scheduled batch and a manual one
  // select the same keywords in the same order (which makes the `maxKeywords` truncation deterministic
  // rather than "whatever the planner returned this time").
  const { rows } = await c.query<{ id: string; keyword: string; locale: string }>(
    `SELECT k.id, k.keyword, k.locale FROM search_keywords k
       JOIN search_keyword_sets s ON s.id = k.set_id
      WHERE s.engagement_id = $1 AND k.is_tracked = true AND k.deleted_at IS NULL
      ORDER BY k.keyword ASC`,
    [engagementId],
  );
  return rows.map((r) => ({ keywordId: r.id, keyword: r.keyword, locale: r.locale }));
}

async function engagementKeywords(c: PoolClient, engagementId: string): Promise<TrackedKeywordRef[]> {
  const { rows } = await c.query<{ id: string; keyword: string; locale: string }>(
    `SELECT k.id, k.keyword, k.locale FROM search_keywords k
       JOIN search_keyword_sets s ON s.id = k.set_id
      WHERE s.engagement_id = $1 AND k.deleted_at IS NULL
      ORDER BY k.keyword ASC`,
    [engagementId],
  );
  return rows.map((r) => ({ keywordId: r.id, keyword: r.keyword, locale: r.locale }));
}

/** THE REFUSAL-VISIBILITY FIX, and it is not cosmetic — the first QA run caught this.
 *
 *  Three of the four module functions are BATCH functions, and they deliberately SWALLOW a choke-point
 *  refusal into per-item `skipped` outcomes carrying `reason = err.code` rather than throwing
 *  (rank.ts / ai-visibility.ts: "a scope/pillar/budget refusal applies IDENTICALLY to every remaining
 *  item... so the loop stops there and reports what was already pulled"). For a human caller that is
 *  exactly right: the HTTP response hands back the whole batch and the operator reads it.
 *
 *  For an UNATTENDED loop it is the difference between a working control and a silent one. A tick in
 *  which every keyword was refused for `budget_exceeded` returns `pulled: 0, skipped: N` and no
 *  exception — so reporting it as `dispatched` would put "the scheduler ran fine" in the log for an
 *  engagement that has hit its spend ceiling, and would have made the ticket's own
 *  "an over-budget engagement is refused" acceptance criterion unfalsifiable. The code is therefore
 *  lifted back out of the batch result here. Only `pullBacklinksForProperty` (a single-item pull) throws,
 *  which is why the caller below must handle BOTH shapes.
 *
 *  Every `skipped` item in these results is a choke-point code by construction — the module functions
 *  only ever produce `skipped` from an `instanceof ProviderDispatchError` branch; anything else becomes
 *  `failed` with a message. `absent` (a provider that genuinely returned nothing for a keyword) is NOT
 *  a refusal and is never in this set. */
function firstReason(results: Array<{ status: string; reason?: string }>, status: string): string | null {
  return results.find((r) => r.status === status && r.reason)?.reason ?? null;
}

/** Classify a batch outcome. Nothing pulled + a refusal code => the tick was REFUSED (the operator-
 *  visible outcome). Nothing pulled + only hard failures => FAILED. Anything pulled => dispatched, with
 *  a mid-batch refusal carried in `detail` because the window HAS been consumed (a capture was written)
 *  and the remainder is not retried — SM-54 item 5. */
function classifyBatch(
  counters: { attempted: number; pulled: number; skipped: number; failed: number },
  results: Array<{ status: string; reason?: string }>,
): Partial<ToolTickOutcome> {
  const refusal = firstReason(results, "skipped");
  if (counters.pulled === 0 && refusal) return { ...counters, status: "refused", reason: refusal };
  if (counters.pulled === 0 && counters.failed > 0) {
    return { ...counters, status: "failed", reason: firstReason(results, "failed") ?? "batch failed" };
  }
  return { ...counters, status: "dispatched", ...(refusal ? { detail: `partial: ${refusal}` } : {}) };
}

/** Run ONE tool for ONE engagement through the existing module function. Every branch here either
 *  calls a module function unchanged or returns without dispatching; nothing in this function talks to
 *  a provider, prices anything, or writes to the ledger. */
async function runTool(
  tenantId: string,
  cand: EngagementCandidate,
  tool: ScheduledTool,
  toggle: Record<string, unknown>,
): Promise<Partial<ToolTickOutcome>> {
  const correlationId = schedulerCorrelationId(tool);
  // `requestedBy: null` on every call — §A13.2's attribution. NOT an invented service user.
  const attribution = { requestedBy: null, correlationId } as const;

  if (tool === "rank") {
    const all = await withTenants([tenantId], (c) => trackedKeywords(c, cand.engagementId), { modules: ["search"] });
    if (all.length === 0) return { status: "no_work", reason: "no tracked keywords" };
    const { selected, eligible, limit } = applyScopeLimit(all, toggle, 50);
    const r = await pullRanksForEngagement({
      tenantId, engagementId: cand.engagementId, propertyId: cand.propertyId,
      propertyDomain: cand.propertyDomain, keywords: selected, ...attribution,
    });
    return {
      ...classifyBatch({ attempted: r.attempted, pulled: r.pulled, skipped: r.skipped, failed: r.failed }, r.results),
      eligible, limit,
    };
  }

  if (tool === "volume") {
    const all = await withTenants([tenantId], (c) => engagementKeywords(c, cand.engagementId), { modules: ["search"] });
    if (all.length === 0) return { status: "no_work", reason: "no keywords in this engagement" };
    const { selected, eligible, limit } = applyScopeLimit(all, toggle, 50);
    const r = await pullMetricsForKeywords({
      tenantId, engagementId: cand.engagementId, propertyId: cand.propertyId,
      keywords: selected, ...attribution,
    });
    // `absent` (the provider genuinely returned nothing for a keyword) is neither a pull nor a
    // failure — it is folded into `skipped` for the tick summary so the four counters still sum to
    // `attempted`, and the module's own per-keyword result keeps the distinction. It is deliberately
    // NOT part of the refusal detection (classifyBatch reads the results array, where an `absent`
    // item has status 'absent' and no reason) — an all-absent pull DID dispatch and DID spend.
    return {
      ...classifyBatch(
        { attempted: r.attempted, pulled: r.updated, skipped: r.skipped + r.absent, failed: r.failed },
        r.results,
      ),
      eligible, limit,
    };
  }

  if (tool === "backlinks") {
    // One property-level aggregate; no per-item batch and therefore no scope limit to apply
    // (`projectMonthlyCost` prices backlinks at exactly 1 item/run).
    const r = await pullBacklinksForProperty({
      tenantId, engagementId: cand.engagementId, propertyId: cand.propertyId,
      propertyDomain: cand.propertyDomain, ...attribution,
    });
    return { status: "dispatched", attempted: 1, pulled: r.status === "pulled" ? 1 : 0, skipped: 0, failed: 0 };
  }

  // ai_visibility — WHAT gets pulled is scope-driven too, not just WHEN (the same rule the manual
  // route follows when no body override is given: the query list comes from `tool_scope`).
  const scopeQueries = Array.isArray(toggle.queries)
    ? (toggle.queries as unknown[]).filter((q): q is string => typeof q === "string" && q.trim() !== "")
    : [];
  if (scopeQueries.length === 0) return { status: "no_work", reason: "tool_scope.ai_visibility.queries is empty" };
  const { selected, eligible, limit } = applyScopeLimit(scopeQueries, toggle, 10, "maxQueries");
  const r = await pullAiVisibilityForProperty({
    tenantId, engagementId: cand.engagementId, propertyId: cand.propertyId, queries: selected, ...attribution,
  });
  return {
    ...classifyBatch({ attempted: r.attempted, pulled: r.pulled, skipped: r.skipped, failed: r.failed }, r.results),
    eligible, limit,
  };
}

/** One engagement's tick: derive due-ness per tool, then run the due+enabled ones SEQUENTIALLY.
 *  Sequential because the tools share the engagement's budget cap — running them in parallel would
 *  race four dispatches against one month-to-date sum and could overshoot the cap by up to three ops. */
async function tickEngagement(
  tenantId: string,
  cand: EngagementCandidate,
  now: Date,
): Promise<EngagementTickOutcome> {
  const lastRuns = await withTenants(
    [tenantId],
    (c) => loadLastRuns(c, cand.engagementId, cand.propertyId),
    { modules: ["search"] },
  );

  const tools: ToolTickOutcome[] = [];
  for (const tool of SCHEDULED_TOOLS) {
    const toggle = (cand.toolScope[tool] ?? {}) as Record<string, unknown>;
    // SM-61 (§6au): the SINGLE no-default parse. `cadence` is `Cadence | null` — `null` covers an
    // absent key AND junk equally, never a guessed schedule (cadence.ts's own header note).
    const cadence = parseCadence(toggle.cadence);
    const lastRunAt = lastRuns[tool];
    const base: ToolTickOutcome = {
      tool, status: "not_due", cadence, lastRunAt: lastRunAt ? lastRunAt.toISOString() : null,
    };

    // Gate 1 (this file): a disabled toggle is NOT SELECTED — no dispatch, no refusal row. Gate 2 is
    // `dispatchProviderOp`'s own scope check, which stays the authoritative one; this one exists so an
    // unattended loop never manufactures a stream of $0 refusal rows for a switch a human turned off.
    if (!isToggleEnabled(cand.toolScope, tool)) {
      tools.push({ ...base, status: "disabled", reason: `tool_scope.${tool}.enabled is not true`, detail: tool });
      continue;
    }
    // Gate 1.5 (SM-61, §6au Ruling 1 clause 1): enabled but no (or unrecognized) cadence is
    // ON-DEMAND, never a default schedule — behaves exactly like `disabled` (no dispatch, no
    // refusal row), but counted separately so an operator can tell the two apart.
    if (cadence === null) {
      tools.push({
        ...base, status: "on_demand",
        reason: `tool_scope.${tool}.cadence is absent — on-demand only, never scheduled`, detail: tool,
      });
      continue;
    }
    if (!isDue(now, lastRunAt, cadence)) {
      tools.push({ ...base, reason: `cadence ${cadence} not elapsed` });
      continue;
    }

    try {
      const result = await runTool(tenantId, cand, tool, toggle);
      tools.push({ ...base, ...result } as ToolTickOutcome);
    } catch (err) {
      // A choke-point refusal is an EXPECTED outcome, not a fault: pillar off, toggle flipped off
      // between selection and dispatch, budget cap breached, no capable provider. It is recorded with
      // the code + the message (which names the toggle or the breached tier) and it NEVER aborts the
      // remaining tools, engagements or tenants — SM-54 spec item 5.
      if (err instanceof ProviderDispatchError) {
        tools.push({ ...base, status: "refused", reason: err.code, detail: err.message });
      } else {
        tools.push({ ...base, status: "failed", reason: (err as Error).message });
      }
    }
  }

  return { tenantId, engagementId: cand.engagementId, propertyId: cand.propertyId, tools };
}

/** SM-54 spec item 4's activity row: ONE row per engagement-tick, and only when the tick actually DID
 *  something (dispatched / refused / failed). A tick where nothing was due writes nothing — an hourly
 *  poll across every engagement would otherwise flood the feed with "nothing happened".
 *
 *  `actorId = null` (system), mirroring the ledger's `requested_by = NULL`, so the feed distinguishes a
 *  scheduled pull from a human one by the same absence the ledger uses. Written through the SAME
 *  `writeActivity` helper + `activities` table the manual pull routes use, so both show up in one feed;
 *  the `work_activity` table is outbox-consumer-fed and keyed `(source, source_ref)` for external
 *  work-detection, which is a different surface. Best-effort: a failed activity write must never lose
 *  the pull that already happened. */
async function recordTickActivity(outcome: EngagementTickOutcome): Promise<void> {
  const acted = outcome.tools.filter((t) => t.status === "dispatched" || t.status === "refused" || t.status === "failed");
  if (acted.length === 0) return;
  const total = (k: "attempted" | "pulled" | "skipped" | "failed"): number =>
    acted.reduce((s, t) => s + (t[k] ?? 0), 0);
  try {
    await writeActivity(outcome.tenantId, null, "scheduled_pull", "search_engagement", outcome.engagementId, {
      scheduled: true,
      attempted: total("attempted"),
      pulled: total("pulled"),
      skipped: total("skipped"),
      failed: total("failed"),
      tools: acted.map((t) => ({
        tool: t.tool, status: t.status, reason: t.reason ?? null, cadence: t.cadence,
        attempted: t.attempted ?? 0, pulled: t.pulled ?? 0, skipped: t.skipped ?? 0, failed: t.failed ?? 0,
        ...(t.eligible !== undefined && t.limit !== undefined && t.eligible > t.limit
          ? { eligible: t.eligible, limit: t.limit }
          : {}),
      })),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[SEARCH-SCHEDULER] activity write failed for engagement ${outcome.engagementId}:`, (err as Error).message);
  }
}

/** ONE sweep. Idempotent-by-cadence, serial, and a no-op when another sweep holds the lock.
 *  Exported so tests (and any future admin trigger) can drive a single tick without the loop. */
export async function runSearchPullSweep(now: Date = new Date()): Promise<SweepResult> {
  const result: SweepResult = {
    skippedLocked: false, tenants: 0, engagements: 0,
    dispatched: 0, refused: 0, failed: 0, notDue: 0, disabled: 0, onDemand: 0, noWork: 0, errors: 0, outcomes: [],
  };

  // `withGlobal` holds ONE pooled connection for the whole callback with no transaction, which is
  // exactly the lifetime a SESSION-scoped advisory lock needs. Nested `withTenants` calls below take
  // their own connections, so nothing here depends on this one's transaction state.
  return withGlobal(async (c) => {
    const lock = await c.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1, $2) AS locked",
      [SEARCH_SCHEDULER_LOCK_NS, SEARCH_SCHEDULER_LOCK_KEY],
    );
    if (!lock.rows[0]?.locked) {
      result.skippedLocked = true;
      return result;
    }
    try {
      // companies carry no tenant_id (they ARE the tenants) — read on this same connection, no tenant
      // context needed and none granted. Identical to startBurndownSnapshotLoop's own tenant discovery.
      const { rows: companies } = await c.query<{ id: string }>(
        `SELECT id FROM companies WHERE deleted_at IS NULL ORDER BY created_at ASC`,
      );

      for (const { id: tenantId } of companies) {
        try {
          // THE one place the enabled_modules-OR-active-service_assignment clause lives, so a served
          // tenant is swept and a tenant without search is not touched at all.
          if (!(await isModuleEnabled(tenantId, "search"))) continue;
          result.tenants += 1;

          const candidates = await withTenants([tenantId], (t) => loadCandidates(t, tenantId), { modules: ["search"] });
          for (const cand of candidates) {
            result.engagements += 1;
            try {
              const outcome = await tickEngagement(tenantId, cand, now);
              result.outcomes.push(outcome);
              for (const t of outcome.tools) {
                if (t.status === "dispatched") result.dispatched += 1;
                else if (t.status === "refused") result.refused += 1;
                else if (t.status === "failed") result.failed += 1;
                else if (t.status === "not_due") result.notDue += 1;
                else if (t.status === "disabled") result.disabled += 1;
                else if (t.status === "on_demand") result.onDemand += 1;
                else if (t.status === "no_work") result.noWork += 1;
              }
              await recordTickActivity(outcome);
            } catch (err) {
              // A fault reading ONE engagement must not cost every later engagement its tick.
              result.errors += 1;
              // eslint-disable-next-line no-console
              console.error(`[SEARCH-SCHEDULER] engagement ${cand.engagementId} tick failed:`, (err as Error).message);
            }
          }
        } catch (err) {
          result.errors += 1;
          // eslint-disable-next-line no-console
          console.error(`[SEARCH-SCHEDULER] tenant ${tenantId} sweep failed:`, (err as Error).message);
        }
      }
      return result;
    } finally {
      // Released even on a throw. A crashed process releases it by dropping the connection, so the
      // lock can never wedge the scheduler permanently.
      await c.query("SELECT pg_advisory_unlock($1, $2)", [SEARCH_SCHEDULER_LOCK_NS, SEARCH_SCHEDULER_LOCK_KEY]);
    }
  });
}

/** The loop. DARK BY DEFAULT — only started by `main.ts` when `config.search.schedulerEnabled` is set
 *  (`SEARCH_SCHEDULER_ENABLED=1`), the same dark-by-default posture as `startBurndownSnapshotLoop` /
 *  `startDriftSweepLoop` / the n8n+graph bridges, and here it is not merely conventional: a loop that
 *  spends vendor money must never start itself in a developer's environment, a test run, or a fresh
 *  deployment nobody has configured budgets for.
 *
 *  Chained `setTimeout`, never `setInterval`: the next tick is scheduled only after the current one
 *  RESOLVES, so a slow sweep can never stack up behind itself (layer 1 of the overlap defence). Fails
 *  soft — a thrown sweep is logged and the loop continues, because the correct response to a transient
 *  fault on a cadence-derived job is to re-derive next tick, not to die and stop all cadences. */
export function startSearchPullSchedulerLoop(intervalMs: number): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const result = await runSearchPullSweep();
      if (result.skippedLocked) {
        // eslint-disable-next-line no-console
        console.log("[SEARCH-SCHEDULER] tick skipped — another sweep holds the lock");
      } else if (result.dispatched > 0 || result.refused > 0 || result.failed > 0 || result.errors > 0) {
        // Surfaced whenever real money-path work happened. A tick where everything was merely not-due
        // is silent by design (hourly polling across every engagement, otherwise).
        // eslint-disable-next-line no-console
        console.log("[SEARCH-SCHEDULER] tick:", {
          tenants: result.tenants, engagements: result.engagements, dispatched: result.dispatched,
          refused: result.refused, failed: result.failed, errors: result.errors,
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[SEARCH-SCHEDULER] tick failed:", (err as Error).message);
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
