import swc from "unplugin-swc";
import { defaultExclude, defineConfig } from "vitest/config";
import { PERF_TESTS } from "./vitest.config";

// The benchmark half of the suite, run by `npm run test:perf`. vitest.config.ts excludes these
// files from the default run because that run is parallel, and a benchmark sharing a 4-vCPU runner
// with three sibling workers measures contention rather than the code — see the `exclude` comment
// there for the two failures that produced this split.
//
// ⚠ DELIBERATELY STANDALONE, NOT `mergeConfig(base, ...)`. mergeConfig CONCATENATES arrays instead
// of replacing them, so inheriting from the base config produced
//   include: ["src/**/*.test.ts", ...PERF_TESTS]   exclude: [...defaultExclude, ...PERF_TESTS]
// — i.e. this config collected all 428 files and then excluded the one benchmark it exists to run.
// It "passed" while running the entire suite sequentially and never executing the benchmark at all.
// Nothing about that is visible in a green result, so the duplication below is the safer shape:
// these two configs MUST disagree about include/exclude, and mergeConfig cannot express disagreement.
//
// The three settings that must stay in step with vitest.config.ts are the SWC plugin (NestJS DI
// needs decorator metadata), the template-database globalSetup, and the per-worker Redis setup file.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",

    // Exactly the files the default run leaves out — imported from one shared list so a file cannot
    // land in both runs or, worse, in neither.
    include: PERF_TESTS,
    exclude: defaultExclude,

    globalSetup: ["./src/testing/global-setup.ts"],
    setupFiles: ["./src/testing/per-worker-env.ts"],

    // Sequential and single-worker — the whole point of the split. A benchmark must be the only
    // thing running for its numbers to mean anything.
    fileParallelism: false,
    minWorkers: 1,
    maxWorkers: 1,

    hookTimeout: 40000,

    // Generous, because the performance bar lives in the test's own assertions, not here. A
    // testTimeout is a backstop against a hang; when it doubles as the bar, a slow or busy machine
    // reports "timed out" for what is really "slower than expected" and the measured numbers never
    // get printed — exactly what happened at the 20s the base config uses.
    testTimeout: 120000,
  },
  plugins: [swc.vite()],
});
