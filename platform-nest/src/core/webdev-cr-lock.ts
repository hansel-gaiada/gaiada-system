// MI-03 (webdev maintenance intake, D-7 §3.2) — per-change-request serialization of the TRIAGE
// transition. Read `core/pipeline-lock.ts` first: this file is the same idiom applied to a different
// unit of consistency, and its header carries the full DEF-2 post-mortem this one only summarizes.
//
// ── WHY A LOCK, AND WHY THE LOCK ALONE IS NOT THE FIX ────────────────────────────────────────────
// `POST /:tenantId/webdev/change-requests/:id/triage` with `action:'convert'` is a read-then-write
// decision: it reads the CR's `status`, concludes "still 'new', so nothing has been spawned yet",
// and then spawns a pipeline run (or a pm_task) and links it. Three ordinary things replay that:
// a PM double-clicking Convert, two staff triaging the same queue item at once, and an HTTP retry
// of a request that actually committed.
//
// Without the lock, both racers read `status='new'` before either commits (neither transaction can
// see the other's uncommitted UPDATE — MVCC does not help here), both spawn, and the second UPDATE
// clobbers the first's `pipeline_run_id`: two runs, one change request, one of them orphaned and
// invisible to the CR that caused it.
//
// WITHOUT THE PRECONDITION RE-CHECK, THE LOCK CHANGES NOTHING. The racers merely take it in turn and
// both still spawn, because each is acting on a snapshot read BEFORE it held the lock (or, worse,
// read in a previous HTTP request). That is DEF-2's exact shipped shape, and it is the variant that
// passes every ordinary sequential test.
//
// ── EVIDENCE: the mutation probe was RUN FOR THIS FEATURE (2026-08-08) ───────────────────────────
// History first, because it matters to how much this paragraph is worth: an earlier revision of this
// header cited a probe that had never been run and named a test file that did not exist. That claim
// was removed on 2026-08-08 and replaced with an explicit UNVERIFIED banner, because a false evidence
// citation is worse than none — it retires the very check it names. What follows REPLACES that banner
// and is a first-hand result, not an inherited analogy.
//
// `src/core/webdev-cr-race.test.ts` now exists (11 tests, green). The probe: the `if (cr.status !==
// "new")` re-check in `webdev-change-requests.controller.ts` — and ONLY that block — was commented
// out, the file re-run, and it went **RED: 7 of 11 tests failed**. The load-bearing failure was
// `expected 2 to be 1` on the count of `pipeline_runs` spawned from ONE change request, plus a 4-way
// race in which all four converts returned 200 and spawned four runs. The block was then restored and
// the file re-verified green. Two properties of that test make the result trustworthy:
//   - THE COLLISION IS ASSERTED, not assumed: the driver pre-takes the CR's advisory lock on a
//     separate OWNER session and the test polls `pg_locks` until N ungranted advisory waiters exist
//     before releasing. (This matters precisely because pg advisory locks are SESSION-REENTRANT and
//     pg-pool reuses connections — a probe taken on a connection the app might reuse would be
//     re-granted and block nothing, and an earlier ticket in this estate shipped a 4-way "race" that
//     passed even with check-then-insert substituted for the real logic.)
//   - The run/stage/gate/event COUNTS are asserted before the status codes, because the status code is
//     only the symptom. A test asserting solely on the CR row would have passed on the broken
//     implementation: the loser's `UPDATE ... AND status = 'new'` is refused, so the CR still names
//     exactly ONE run while a second, orphaned, client-facing run exists. `ux_wcr_run` cannot help
//     either — it constrains the LINK, never the spawn. (`webdev-cr-race.test.ts`'s
//     `FALSIFIABILITY:` test reproduces that orphan at the SQL level on purpose.)
//
// So the mandatory order, all inside ONE `withTenants` transaction, is:
//
//     lock -> RE-READ the CR -> re-check `status = 'new'` -> spawn -> UPDATE the CR -> emit events
//
// The loser re-reads under the lock, sees `status <> 'new'`, and resolves to the ALREADY-SPAWNED
// artifact with a 409 instead of inserting — mirroring `existingStageForRepeatedCreate`'s
// "a second create is a stale retrigger, never an intent" ruling (pipeline.controller.ts:89–124).
//
// ── LOCK SCOPE: WHY THE CR ID ────────────────────────────────────────────────────────────────────
// Key = (namespace, hashtext(change_request_id)).
//   - The CR is the unit two deciders can disagree about: the whole disposition (decline vs convert,
//     and which route) is one decision derived from one row's state.
//   - NOT the run id: no run exists yet at lock time — that is the entire point. (And once minted,
//     the new run id cannot be addressed by any concurrent handler, so this transaction deliberately
//     does NOT also take PIPELINE_RUN_LOCK_NS: same reasoning `createRun` documents for its stage
//     loop, and with only one lock ever held there is no lock-ordering deadlock question.)
//   - NOT the tenant: every change request in this deployment belongs to the ONE agency tenant, so a
//     tenant-keyed lock would serialize every triage in the product (pipeline-lock.ts:32–37's
//     lesson, which its "LOCK SCOPE" test exists to falsify).
// `hashtext` is 32-bit, so two CR ids can theoretically collide and serialize unnecessarily —
// correctness-safe, negligible throughput cost, the same trade every other lock space here accepts.
//
// Xact-scoped, so COMMIT/ROLLBACK releases it and a crashed handler cannot leak it. This REQUIRES a
// real transaction: `withTenants` wraps its callback in BEGIN/COMMIT, so a lock taken inside that
// callback is held for the rest of the handler. Taken on an autocommit connection (`withGlobal`, or
// a bare pool query) it is acquired and released by the same statement — A SILENT NO-OP that leaves
// the race fully alive while every test still passes. Only call this inside `withTenants`.
import type { PoolClient } from "pg";

/** Advisory-lock namespace (int4) for change-request triage serialization: 'WC' + 1. Deliberately
 *  distinct from PIPELINE_RUN_LOCK_NS (0x50520001), APPROVAL_EXEC_LOCK_NS (0x41450001),
 *  ASSISTANT_THREAD_LOCK_NS (0x41535401) and the search module's spaces, so a CR-id hash can never
 *  collide with a run-id / approval-key / thread-id / cache-key hash in the same shared lock space. */
export const WEBDEV_CR_LOCK_NS = 0x57430001;

/** Serialize the triage transition for ONE change request.
 *
 *  Call this as the FIRST statement inside the `withTenants` callback, BEFORE the read whose result
 *  the handler acts on. Anything read before the lock is a stale snapshot; the only value safe to
 *  read earlier is one that is immutable on the row (nothing here needs to). */
export async function lockChangeRequest(c: PoolClient, changeRequestId: string): Promise<void> {
  await c.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [WEBDEV_CR_LOCK_NS, changeRequestId]);
}
