// WD-29 (DEF-2 fix) — per-run serialization of pipeline state transitions.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────────────────────────
// `automation/workflows/pipeline-delivery.json`'s `Load + decide` node is a STATELESS RECOMPUTE: it
// reads the whole run (`pipeline.getRun` -> stages + gates + scopeSignoffs), decides what should
// happen next from that snapshot, and writes. It is triggered by BOTH `pipeline.gate.decided` and
// `scope.signed`. When a `prd_sign` decision and a completed scope sign-off land close together
// (each emits its own event; the bridge starts one workflow execution per event), two executions
// read the run BEFORE either's write lands, both independently evaluate `!design -> release_design`,
// and both call `pipeline.createStage(name='claude_design')`. Result: duplicate client-facing stages.
//
// Confirmed in live data (2026-07-30): 4 runs with duplicated `claude_design` rows. Consequences are
// not cosmetic — the duplicates surface in the run workspace AND the client portal, and WD-05's
// bounded revise loop counts DESIGN STAGES (`designs.length < MAX_DESIGNS`) rather than human
// decisions, so a raced duplicate silently burns the revise budget and escalates early.
//
// ── WHY A LOCK ALONE IS NOT THE FIX ──────────────────────────────────────────────────────────────
// An advisory lock by itself changes NOTHING here: both racing transactions would take it in turn
// and both would still insert, because each is executing a decision computed from a stale snapshot
// read OUTSIDE the lock (in n8n). The lock is only the *enabling* half. The fix is
// lock + RE-EVALUATE THE PRECONDITION SERVER-SIDE (see `existingStageForRepeatedCreate` in
// pipeline.controller.ts): the loser of the race re-reads the run under the lock, discovers the
// state that justified its create has already been consumed, and no-ops instead of inserting.
// A "fix" that adds the lock without the re-check passes every ordinary test and still produces
// duplicates — exactly the silent failure mode this ticket exists to close.
//
// ── LOCK SCOPE: WHY `run_id`, AND WHY NOT WIDER OR NARROWER ──────────────────────────────────────
// Key = (namespace, hashtext(run_id)). The pipeline run is the state machine's unit of consistency:
// `Load + decide` reads the ENTIRE run (all stages, all gates, all sign-offs) as one snapshot and
// derives a single `action` from it, so the run is exactly the granularity at which two deciders can
// disagree.
//   - WIDER (per-tenant) would be catastrophic here, not merely slow: every pipeline run in this
//     deployment belongs to the ONE agency tenant, so a tenant-keyed lock serializes the whole
//     pipeline — every concurrent run's every transition queues behind every other. The
//     "LOCK SCOPE: a run holding its lock does NOT block a DIFFERENT run's transition" test in
//     pipeline-race.test.ts exists specifically to falsify that mistake (it holds run A's lock open
//     and proves run B still transitions).
//   - NARROWER (per-stage, or per (run, stage-name)) leaves the race alive, because the racing
//     writes are DIFFERENT decisions about the SAME run derived from one shared snapshot: a
//     `release_design` and a `revise_design`, or a stage-create interleaved with the gate-open that
//     follows it. Two deciders holding two different narrow keys both proceed, and the duplicate
//     survives. Per-run is the narrowest key that still covers every pair that can disagree.
// `hashtext` is 32-bit, so two distinct run ids can theoretically collide and serialize
// unnecessarily. That is correctness-safe (only a negligible throughput cost) and is the same
// trade-off `src/modules/search/providers/cache.ts` already accepts for its two lock spaces.
//
// Xact-scoped (`pg_advisory_xact_lock`), so the lock is released by COMMIT or ROLLBACK and can never
// leak on a crashed handler. This REQUIRES a real transaction to be meaningful: `withTenants`
// wraps its callback in BEGIN/COMMIT (src/db/index.ts), so a lock taken inside that callback is held
// for the rest of the handler. Taken inside `withGlobal()` or on an autocommit connection it would
// be acquired and released by the same statement — a silent no-op. Only call this inside
// `withTenants` (or another explicit BEGIN, as `runInCacheCriticalSection` does).
import type { PoolClient } from "pg";

/** Advisory-lock namespace (int4) for pipeline-run serialization: 'PR' + 1. Deliberately distinct
 *  from the search module's SEARCH_ENG_LOCK_NS / SEARCH_CACHE_LOCK_NS so a run-id hash can never
 *  collide with an engagement-id or cache-key hash in the same shared lock space. */
export const PIPELINE_RUN_LOCK_NS = 0x50520001;

/** Serialize every state transition for ONE pipeline run.
 *
 *  Call this as the FIRST statement inside the `withTenants` callback, BEFORE any read whose
 *  result the handler then acts on — that ordering is what makes the handler's read-then-write
 *  sequence atomic with respect to a concurrent decider. Handlers that are addressed by a child id
 *  (a stage id, a gate id) must first read that child's `run_id`, then lock, then RE-READ whatever
 *  they intend to act on: `run_id` is immutable on those rows, so reading it before the lock is
 *  safe, but anything else read before the lock is a stale snapshot.
 *
 *  Every pipeline handler takes exactly this ONE lock, so no lock-ordering deadlock is possible. */
export async function lockPipelineRun(c: PoolClient, runId: string): Promise<void> {
  await c.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [PIPELINE_RUN_LOCK_NS, runId]);
}
