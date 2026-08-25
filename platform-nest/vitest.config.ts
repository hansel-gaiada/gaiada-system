import swc from "unplugin-swc";
import { defaultExclude, defineConfig } from "vitest/config";

// The one file excluded from this config, run instead by `npm run test:perf` (vitest.perf.config.ts).
// Exported so the perf config can use it as its `include` — one list, so a file can never end up in
// both runs or in neither.
export const PERF_TESTS = ["src/rbac/principal-perf.db.test.ts"];

// NestJS DI needs decorator METADATA, which esbuild (vitest's default transform) does not
// emit. unplugin-swc runs SWC instead, honoring .swcrc (legacyDecorator + decoratorMetadata),
// so injected constructor param types resolve — the same reason Nest+vitest setups use SWC.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],

    // The benchmark is excluded from THIS run because this run is parallel (see maxWorkers below),
    // and a benchmark sharing 4 vCPUs with three sibling workers measures contention rather than
    // the code. Two concrete consequences, both observed: its 300-iteration-per-persona
    // request-path timing blew the 20s testTimeout outright, and the p95s and EXPLAIN ANALYZE plans
    // it prints for a human to read were inflated by whatever happened to be running beside it.
    // Raising the timeout would have kept it green while leaving the numbers meaningless, which is
    // worse than either failing or being moved — so it moves, to a sequential run of its own.
    //
    // `defaultExclude` is spread back in deliberately: setting `exclude` REPLACES vitest's defaults
    // rather than adding to them, so omitting it would put node_modules and dist back in scope.
    exclude: [...defaultExclude, ...PERF_TESTS],

    // Migrates ONE template database per run; every test file then copies it instead of replaying
    // 166 migrations of its own. This is the single biggest cost in the whole `ci` workflow — see
    // src/testing/global-setup.ts for the measurements.
    globalSetup: ["./src/testing/global-setup.ts"],

    // Runs once per worker process. Gives each worker its own logical Redis database, which is the
    // Redis-side equivalent of the per-file Postgres databases and a precondition for the
    // parallelism enabled below. See src/testing/per-worker-env.ts.
    setupFiles: ["./src/testing/per-worker-env.ts"],

    // FILE PARALLELISM IS ON (it was previously `fileParallelism: false`).
    //
    // That flag predated the per-file physical databases in src/testing/setup.ts, and its own
    // header now records that it never actually bought isolation: separate module graphs meant a
    // finishing file's async teardown could still overlap the next file's DROP, so the sequencing
    // was load-bearing for nothing while costing the entire suite its concurrency. With one
    // physical database per file and one Redis logical database per worker, no two suites can
    // contend for a shared object regardless of overlap, so the flag is removed rather than kept
    // as a superstition.
    //
    // Capped at 4 deliberately, NOT left to default to the host's core count:
    //   * GitHub's standard ubuntu-latest runner has 4 vCPUs, so more workers would oversubscribe
    //     and add scheduler noise, not throughput.
    //   * Each worker holds several pg Pools (maintenance + admin + runtime). Postgres defaults to
    //     max_connections=100 and the CI service now raises it, but the cap is what keeps a
    //     developer's default local Postgres from hitting the connection ceiling — which surfaces
    //     as dozens of unrelated files failing in beforeAll, the least diagnosable outcome here.
    //   * 4 is inside Redis's 16 logical databases, so per-worker Redis isolation is exact.
    //
    // minWorkers is pinned too, and is NOT redundant. Left unset, vitest derives a floor from the
    // host's core count, and on any machine with more cores than this cap that floor exceeds it —
    // tinypool then rejects the pool outright with "options.minThreads and options.maxThreads must
    // not conflict" and NOTHING runs. Observed on the 2026-08-24 dev box: maxWorkers alone made
    // every file fail to collect.
    minWorkers: 1,
    maxWorkers: 4,

    hookTimeout: 40000,
    testTimeout: 20000,
  },
  plugins: [swc.vite()],
});
