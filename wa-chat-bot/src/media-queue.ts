// Media queue (5a.1/5a.2): BullMQ over Redis. Enqueue eagerly on receipt; a dedicated
// worker process consumes; the slow store-poller reconciles anything that missed the
// queue (crashed enqueue, worker downtime) — a pending row can never be silently lost.
import { Queue, Worker } from "bullmq";
import { config } from "./config";
import { getPendingMedia, updateMedia } from "./store";
import { processMediaRow } from "./media";

export const queueEnabled = (): boolean => config.redisUrl.length > 0;

let queue: Queue | null = null;

function connection() {
  const u = new URL(config.redisUrl);
  return { host: u.hostname, port: Number(u.port || 6379), password: u.password || undefined };
}

function getQueue(): Queue {
  if (!queue) queue = new Queue(config.mediaQueueName, { connection: connection() });
  return queue;
}

/** Fire-and-forget enqueue on media receipt. Failure is fine — the reconciler catches it. */
export async function enqueueMedia(waMessageId: string): Promise<boolean> {
  if (!queueEnabled() || !waMessageId) return false;
  try {
    await getQueue().add(
      "process",
      { waMessageId },
      { jobId: waMessageId, attempts: 3, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: true, removeOnFail: 100 },
    );
    return true;
  } catch (err) {
    console.warn(`[media-queue] enqueue failed (reconciler will catch it): ${(err as Error).message}`);
    return false;
  }
}

/** Job handler: settle exactly the row named by the job; already-settled rows are no-ops. */
export async function handleMediaJob(waMessageId: string): Promise<"settled" | "not-pending"> {
  const rows = await getPendingMedia(100);
  const row = rows.find((r) => r.waMessageId === waMessageId);
  if (!row) return "not-pending";
  await processMediaRow(row);
  return "settled";
}

/** BullMQ consumer (runs in the dedicated media-worker process). */
export function startMediaQueueWorker(): Worker {
  const worker = new Worker<{ waMessageId: string }>(
    config.mediaQueueName,
    async (job) => handleMediaJob(job.data.waMessageId),
    { connection: connection(), concurrency: config.mediaWorkerConcurrency },
  );
  worker.on("failed", async (job, err) => {
    console.warn(`[media-queue] job ${job?.id} failed: ${err.message}`);
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      await updateMedia(String(job.data.waMessageId), {
        status: "failed",
        text: `[media processing failed after ${job.attemptsMade} attempts: ${err.message}]`,
      }).catch(() => undefined);
    }
  });
  return worker;
}

export async function closeMediaQueue(): Promise<void> {
  await queue?.close();
  queue = null;
}
