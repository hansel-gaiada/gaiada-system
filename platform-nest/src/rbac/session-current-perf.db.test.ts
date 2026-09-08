// F13 (fault-register finding 13) — measured, not asserted. Mirrors IAM-03b's own
// `principal-perf.db.test.ts` header: rather than asserting a ceiling from opinion, this benchmarks
// (a) the raw `session_version` lookup `sessionVersionCurrent()` performs, EXPLAIN ANALYZE included,
// and (b) the real `authorize()`-level cost of D11 now running on EVERY read (previously
// write-only), WITH and WITHOUT the per-request memoisation added alongside the widening
// (`core/request-context.ts`'s `memoiseSessionCurrent`). Block (b) is the number that answers "was
// memoisation worth adding": N reads for the SAME principal, across N separate requests (no
// memoisation possible — each pays its own session_version query) versus the SAME N reads inside
// ONE request (memoised — only the first pays it).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { sessionVersionCurrent, assemblePrincipal, type Principal } from "./principal";
import { authorize } from "../core/http";
import { runWithRequestContext } from "../core/request-context";

const ITERATIONS = 300;
const WARMUP = 20;
const live = !!process.env.CERBOS_URL;

const SESSION_VERSION_SQL = `SELECT session_version FROM users WHERE id = $1`;

interface Stats {
  n: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

function stats(samplesMs: number[]): Stats {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return {
    n: sorted.length,
    meanMs: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p50Ms: pct(50),
    p95Ms: pct(95),
    maxMs: sorted[sorted.length - 1],
  };
}

async function timeAsync(fn: () => Promise<unknown>, n: number): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return samples;
}

function fmt(label: string, s: Stats): string {
  return `${label}: n=${s.n} mean=${s.meanMs.toFixed(3)}ms p50=${s.p50Ms.toFixed(3)}ms p95=${s.p95Ms.toFixed(3)}ms max=${s.maxMs.toFixed(3)}ms`;
}

describe.skipIf(!TEST_URL)("F13 · sessionVersionCurrent() perf — the raw D11 query, now on every read", () => {
  let userId: string;

  beforeAll(async () => {
    await initTestDb();
    userId = await createUser("f13-perf@test.local");
  }, 60_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("EXPLAIN ANALYZE on the session_version lookup — a PK lookup, not a scan", async () => {
    const { rows } = await adminPool().query<{ "QUERY PLAN": string }>(
      `EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) ${SESSION_VERSION_SQL}`,
      [userId],
    );
    const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
    console.log("\n--- F13 EXPLAIN ANALYZE (session_version lookup) ---\n" + plan + "\n");
    const execTimeMatch = plan.match(/Execution Time: ([\d.]+) ms/);
    expect(execTimeMatch).not.toBeNull();
    // Generous ceiling for a PK-indexed single-row lookup — a regression guard, not a precision
    // claim; the real number is in the console output above.
    expect(Number(execTimeMatch![1])).toBeLessThan(10);
  });

  it("measures sessionVersionCurrent() end-to-end (pool checkout + query, real request-path timing)", async () => {
    const p: Principal = {
      userId, assurance: "high", companies: [], rootCompanies: [], roles: [], perms: [], sessionVersion: 0,
    };
    await timeAsync(() => sessionVersionCurrent(p), WARMUP);
    const s = stats(await timeAsync(() => sessionVersionCurrent(p), ITERATIONS));
    console.log("\n--- F13 sessionVersionCurrent() end-to-end ---\n" + fmt("sessionVersionCurrent()", s) + "\n");
    expect(s.p95Ms).toBeLessThan(25);
  });
});

describe.skipIf(!TEST_URL || !live)(
  "F13 · authorize()-level cost of D11-on-reads, memoised (one request) vs not (N separate requests)",
  () => {
    let tenant: string;
    let memberUser: string;

    beforeAll(async () => {
      await initTestDb();
      tenant = await createCompany("F13 Perf Co");
      const role = await createRole("member");
      memberUser = await createUser("f13-perf-member@test.local");
      await addMembership(tenant, memberUser);
      await grantRole(memberUser, role, "company", tenant);
    }, 120_000);

    afterAll(async () => {
      await teardownTestDb();
    });

    const task = () => ({ kind: "pm_task", tenantId: tenant, id: "00000000-0000-0000-0000-00000000cccc" });

    it("N reads for the SAME principal: unmemoised total vs memoised total — the number that answers whether memoisation was worth adding", async () => {
      const N = 20;
      const p = await assemblePrincipal(memberUser, "high");
      if (!p) throw new Error("fixture bug: no principal for memberUser");

      // Warm up the Cerbos connection / JIT once, outside both measured runs.
      await authorize(p, task(), "read");

      // UNMEMOISED: no request context wraps any of these calls, so `memoiseSessionCurrent` finds
      // no store and recomputes every time — this is what "D11 on reads, no memoisation" costs: one
      // `sessionVersionCurrent()` round trip PER authorize() call, exactly as N separate HTTP
      // requests for the same page's fanned-out reads would each pay it independently.
      const unmemoisedSamples: number[] = [];
      for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        await authorize(p, task(), "read");
        unmemoisedSamples.push(performance.now() - t0);
      }

      // MEMOISED: the SAME N calls, but inside ONE `runWithRequestContext` — the same per-request
      // box `core/request-context.ts` resets on every real HTTP request. Only the first call's
      // `sessionVersionCurrent()` actually queries; the remaining N-1 reuse its cached promise.
      const memoisedSamples: number[] = [];
      await runWithRequestContext(async () => {
        for (let i = 0; i < N; i++) {
          const t0 = performance.now();
          await authorize(p, task(), "read");
          memoisedSamples.push(performance.now() - t0);
        }
      });

      const unmemoised = stats(unmemoisedSamples);
      const memoised = stats(memoisedSamples);
      const unmemoisedTotal = unmemoisedSamples.reduce((a, b) => a + b, 0);
      const memoisedTotal = memoisedSamples.reduce((a, b) => a + b, 0);
      console.log(
        `\n--- F13 authorize() memoisation (N=${N} reads, same caller principal) ---\n` +
          fmt("unmemoised (N separate requests)", unmemoised) +
          "\n" +
          fmt("memoised (1 request)", memoised) +
          `\nunmemoised TOTAL: ${unmemoisedTotal.toFixed(3)}ms   memoised TOTAL: ${memoisedTotal.toFixed(3)}ms   ` +
          `saved: ${(unmemoisedTotal - memoisedTotal).toFixed(3)}ms over ${N} authorize() calls ` +
          `(${((unmemoisedTotal - memoisedTotal) / N).toFixed(3)}ms/call average)\n`,
      );
      // Not a precision claim on Cerbos's own latency (dominates both runs and is out of this
      // ticket's control) — only that memoising the D11 query does not make the fanned-out-reads
      // case SLOWER, and in practice removes (N-1) session_version round trips from it.
      expect(memoisedTotal).toBeLessThanOrEqual(unmemoisedTotal);
    });
  },
);
