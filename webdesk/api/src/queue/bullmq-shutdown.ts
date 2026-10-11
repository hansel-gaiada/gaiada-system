// M3 T8 — closing a BullMQ Queue or Worker without leaving an unhandled rejection behind.
//
// THE RACE (bullmq 5.x, RedisConnection). A Queue/Worker starts connecting in its constructor, and
// `init()` runs in the background; its failure is re-emitted by `initializing.catch(err => emit('error'))`.
// close() on a connection that is still 'initializing' disconnects the client, which makes init() reject
// with ioredis' "Connection is closed.", and then close() calls `removeAllListeners()`, so by the time that
// rejection is re-emitted the connection has NO 'error' listener (not even the Queue's or Worker's own
// forwarder). EventEmitter throws on an 'error' with no listener, inside a promise handler nobody awaits:
// an unhandled rejection. An app closed right after boot (every spec that boots and closes the app) hits
// it, and whether it does depends on where Nest's deepest-first destroy order puts this module, which is
// why an unrelated change to the module graph could surface it. Listeners on the Queue/Worker cannot
// help; they are removed too.
//
// THE FIX is to close only a connection that has finished initialising: wait for `waitUntilReady()`
// (bounded, so an unreachable Redis cannot hold shutdown) and then close. A READY connection closes
// cleanly (quit), and every close failure is handed to `onError` instead of rejecting.
//
// Residual: if Redis is unreachable for the whole bound, the connection is still initialising and the
// close goes ahead anyway (the bound is there so shutdown never hangs); that case still carries the
// BullMQ race above. It needs Redis down at shutdown, and the process is exiting.
import type { Queue, Worker } from "bullmq";

/** How long a shutdown waits for a still-connecting BullMQ client before closing it anyway. */
export const BULLMQ_READY_WAIT_MS = 2_000;

export async function closeBullmq(
  handle: Pick<Queue, "waitUntilReady" | "close"> | Pick<Worker, "waitUntilReady" | "close">,
  onError: (err: unknown) => void,
  readyWaitMs: number = BULLMQ_READY_WAIT_MS,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      // A rejection here (client already ended) means there is nothing left to wait for.
      handle.waitUntilReady().then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, readyWaitMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  await handle.close().catch(onError);
}
