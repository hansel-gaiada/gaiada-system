// SCP-2 — the staff notices of a portal decision wait out its undo window (FRONTEND-BFF-CONTRACT §63.9, §63.14).
//
// The client's approval or change request carries a ten second undo window (`undo_window_10s`). The fixture's
// `notify_after_undo_window:<who>` effects therefore do not notify at the commit: a one-shot timer is set for the end of the
// window (plus a second of grace), and when it fires the sender re-reads the decision and notifies only if it still stands
// (`decisionStands`, pipeline.service.ts). `client_undo`'s `drop_pending_notifications` cancels the timer; the re-check is the
// real guard (a cancel that was missed, or a decision taken apart by another route, still sends nothing). The re-check also
// refuses to send while the window is still open on the database clock: a job that fires early (clock skew between this process
// and the database, a flush) reschedules itself for the rest of the window instead of sending.
//
// ⚠ RESTART CAVEAT. The timers live in this process's memory. A restart or deploy inside the window drops the notices of the
// decisions that were waiting: the decision itself is committed and shows in the post and the Team's feed, but the officer's
// and the HoD's bell for it is never sent. The window is ten seconds, so the cost is one missed bell per restart, and a
// durable job would be the only way to avoid it (queue-backed, `lib/queue.ts`); it is not built.
//
// A leaf module on purpose: pipeline.service.ts and the portal runner both import it, and it imports neither.

/** One second past `undo_until`, so a timer that fires on the dot never races the database clock. */
export const DECISION_NOTICE_GRACE_MS = 1000;

interface Pending {
  timer: ReturnType<typeof setTimeout>;
  job: () => Promise<void>;
}

const pending = new Map<string, Pending>();
let delayOverrideMs: number | null = null;

/** The seam the tests use: a fixed delay in place of the window (0 fires on the next tick). `null` restores the real one. */
export function setDecisionNoticeDelayForTests(ms: number | null): void {
  delayOverrideMs = ms;
}

async function run(decisionId: string, job: () => Promise<void>): Promise<void> {
  try {
    await job();
  } catch (err) {
    // A notice never undoes a decision (BFF §63.14); a failure is logged loudly and never rethrown.
    // eslint-disable-next-line no-console
    console.error(`[scp] the delayed notices of decision ${decisionId} failed:`, (err as Error)?.message ?? err);
  }
}

/** Schedule `job` for the end of the decision's undo window. A second schedule for the same decision replaces the first. A
 *  `reschedule` (the job found the window still open) always waits the real remaining time, whatever the test seam says. */
export function scheduleDecisionNotices(
  decisionId: string, undoUntilIso: string | null, job: () => Promise<void>, opts: { reschedule?: boolean } = {},
): void {
  cancelDecisionNotices(decisionId);
  const until = undoUntilIso ? Date.parse(undoUntilIso) : NaN;
  const real = (Number.isFinite(until) ? Math.max(0, until - Date.now()) : 0) + DECISION_NOTICE_GRACE_MS;
  const delay = opts.reschedule ? real : (delayOverrideMs ?? real);
  const timer = setTimeout(() => {
    pending.delete(decisionId);
    void run(decisionId, job);
  }, delay);
  // A waiting notice never keeps the process (or a test run) alive.
  if (typeof timer.unref === "function") timer.unref();
  pending.set(decisionId, { timer, job });
}

/** Drop the decision's waiting notices. True when there were any. */
export function cancelDecisionNotices(decisionId: string): boolean {
  const p = pending.get(decisionId);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(decisionId);
  return true;
}

/** Run every waiting job now, without waiting for its timer, and answer how many ran. The tests' flush. It is NOT a way to
 *  send early and is not for shutdown: each job re-checks the decision and, if its undo window is still open, reschedules itself
 *  and sends nothing (a test that wants the notice closes the window first, by moving `undo_until` into the past). */
export async function flushDecisionNotices(): Promise<number> {
  const all = [...pending.entries()];
  pending.clear();
  for (const [id, p] of all) {
    clearTimeout(p.timer);
    await run(id, p.job);
  }
  return all.length;
}

export const pendingDecisionNoticeCount = (): number => pending.size;

/** Drop every waiting job without running it, and say so in the log (the number of notices that will never be sent). For a test's
 *  cleanup, and for a graceful shutdown: a flush there would be wrong (a notice must not go out inside its undo window), and a
 *  silent drop would hide the loss the restart caveat above describes. */
export function dropDecisionNotices(): number {
  const n = pending.size;
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
  if (n > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[scp] dropped the delayed notices of ${n} portal decision(s) still inside their undo window`);
  }
  return n;
}
