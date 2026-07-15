// Dedicated media-worker process (5a.2): BullMQ consumer + slow reconciler.
//   npm run media-worker
// Requires REDIS_URL and DATABASE_URL (the file store is single-process; running a
// separate worker against it would corrupt data — refused at startup).
import "./telemetry"; // WS9: start OTel first (no-op unless OTEL_ENABLED)
import { fileURLToPath } from "node:url";
import { config } from "./config";
import { initStore } from "./store";
import { startMediaQueueWorker, queueEnabled } from "./media-queue";
import { startMediaWorker } from "./media";

async function main(): Promise<void> {
  if (!queueEnabled()) {
    console.error("REDIS_URL not set — the dedicated worker needs the queue. (Dev mode: the bot's in-process poller handles media.)");
    process.exit(1);
  }
  if (!config.databaseUrl) {
    console.error("DATABASE_URL not set — the dedicated worker requires the Postgres store (FileStore is single-process).");
    process.exit(1);
  }
  await initStore();
  startMediaQueueWorker();
  startMediaWorker(config.mediaReconcileSeconds); // reconciler cadence
  console.log(
    `Gaiada media worker: queue=${config.mediaQueueName} concurrency=${config.mediaWorkerConcurrency} reconcile=${config.mediaReconcileSeconds}s`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
