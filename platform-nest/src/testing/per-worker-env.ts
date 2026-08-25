// Per-worker environment fixup. Runs as a vitest `setupFiles` entry, i.e. once inside EVERY
// worker process before any test file in it executes.
//
// WHY: enabling file parallelism (vitest.config.ts) made Postgres safe by construction — each test
// file already gets its own physical database — but Redis had no equivalent boundary. All 18
// Redis-touching suites read one `REDIS_URL_TEST` and therefore shared one logical Redis database,
// where they use fixed, non-unique stream and key names (`events:org_structure`, consumer-group
// names, and so on). Two such files running at the same instant would read each other's entries
// out of a shared stream, and `events/n8n-bridge.integration.test.ts` closes with a `flushdb()`
// that would delete a concurrently-running suite's fixtures outright.
//
// Redis ships with 16 logical databases (0-15) and `SELECT` isolates them completely, so pointing
// each worker at its own index restores the same "no two suites can touch the same object"
// property the per-file Postgres databases give. It is done by REWRITING the env var rather than
// by adding a helper the suites must call, so all 18 files keep working unchanged and — more to
// the point — a NEW Redis suite is isolated by default instead of only if its author remembers.
//
// `maxWorkers` is capped at 4 in vitest.config.ts, well inside the 16 available indexes. The
// modulo is a backstop: if that cap is ever raised past 15, workers start sharing indexes again
// (degrading to today's behaviour for those pairs) rather than silently addressing a database
// Redis does not have and failing every Redis suite at once.
const REDIS_LOGICAL_DATABASES = 16;

const url = process.env.REDIS_URL_TEST;
if (url) {
  // VITEST_WORKER_ID is 1-based and set by vitest in each worker. Absent only when something else
  // imports this file outside a worker, in which case index 0 (Redis's default) is correct.
  const workerId = Number(process.env.VITEST_WORKER_ID ?? 0) || 0;
  const index = workerId % REDIS_LOGICAL_DATABASES;
  const u = new URL(url);
  // ioredis reads the logical database from the URL path. Overwrite rather than append: a caller
  // may already have supplied one (`redis://host:6379/3`), and appending would produce `/3/2`,
  // which ioredis parses as database NaN and then quietly treats as 0 — putting every worker back
  // on one shared database, which is precisely the bug this file exists to prevent.
  u.pathname = `/${index}`;
  process.env.REDIS_URL_TEST = u.toString();
}
