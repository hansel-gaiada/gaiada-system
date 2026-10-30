// AIP-18 — the soft stop's decision, PURE and with fakes: the decision table of §6.3 item 9 (allowance at, below and above; an override row
// against the default; a department soft_stop over and under; report mode never; lifted this month against last month; the ancestor walk;
// both at once; the reset instants), the strict computation over a fake client (what it reads, in which order, and that a failure THROWS),
// and the cached send-path read (fails open on an error and on a slow miss, caches, never past the reset, forgets on invalidate).
// No database, no Cerbos: always runs. The DB/HTTP halves are lift.http.test.ts and ../assistant/assistant-soft-stop.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PoolClient } from "pg";
import { config } from "../../config";
import {
  NOT_STOPPED, budgetState, clearBudgetStateCacheForTests, computeBudgetState, decideBudgetState, invalidateBudgetState, isStopCandidate,
  nextUtcMidnight, nextUtcMonthStart, type BudgetState, type PathBudget,
} from "./soft-stop";

const NOW = new Date("2026-10-30T15:20:00.000Z");
const T = "11111111-1111-4111-8111-111111111111";
const U = "22222222-2222-4222-8222-222222222222";
const MIDNIGHT = "2026-10-31T00:00:00.000Z";
const NEXT_MONTH = "2026-11-01T00:00:00.000Z";

const unit = (over: Partial<PathBudget> & { unitNodeId: string }): PathBudget => ({
  mode: "soft_stop", monthlyUsd: "10.0000", stopLiftedMonth: null, spentUsd: "0", ...over,
});

describe("AIP-18 · the reset instants", () => {
  it("the allowance resets at the next 00:00 UTC, the department on the first of the next UTC month", () => {
    expect(nextUtcMidnight(NOW)).toBe(MIDNIGHT);
    expect(nextUtcMonthStart(NOW)).toBe(NEXT_MONTH);
    // month and year rollover
    expect(nextUtcMidnight(new Date("2026-12-31T23:59:59.999Z"))).toBe("2027-01-01T00:00:00.000Z");
    expect(nextUtcMonthStart(new Date("2026-12-15T00:00:00Z"))).toBe("2027-01-01T00:00:00.000Z");
    // exactly at midnight, the day has begun: the next reset is the following midnight
    expect(nextUtcMidnight(new Date("2026-10-30T00:00:00.000Z"))).toBe("2026-10-31T00:00:00.000Z");
    // a non-UTC wall clock changes nothing: the instant is what counts
    expect(nextUtcMidnight(new Date("2026-10-31T06:30:00+08:00"))).toBe("2026-10-31T00:00:00.000Z");
  });
});

describe("AIP-18 · the decision table (decideBudgetState)", () => {
  it("allowance: below is not stopped; AT the allowance and above it are", () => {
    expect(decideBudgetState({ repliesToday: 199, allowance: 200, path: [] }, NOW)).toEqual(NOT_STOPPED);
    expect(decideBudgetState({ repliesToday: 200, allowance: 200, path: [] }, NOW)).toEqual({ stopped: true, stop: { kind: "allowance", resetsAt: MIDNIGHT } });
    expect(decideBudgetState({ repliesToday: 450, allowance: 200, path: [] }, NOW)).toEqual({ stopped: true, stop: { kind: "allowance", resetsAt: MIDNIGHT } });
  });

  it("allowance: an override (a raised or lowered figure) is just the allowance it is given", () => {
    expect(decideBudgetState({ repliesToday: 250, allowance: 500, path: [] }, NOW).stopped).toBe(false);
    expect(decideBudgetState({ repliesToday: 5, allowance: 5, path: [] }, NOW).stopped).toBe(true);
  });

  it("allowance: a malformed count or allowance fails open", () => {
    expect(decideBudgetState({ repliesToday: Number.NaN, allowance: 1, path: [] }, NOW).stopped).toBe(false);
    expect(decideBudgetState({ repliesToday: 10, allowance: 0, path: [] }, NOW).stopped).toBe(false);
    expect(decideBudgetState({ repliesToday: 10, allowance: 1.5, path: [] }, NOW).stopped).toBe(false);
  });

  it("department: a soft_stop unit AT or over its figure stops, under it does not (exact decimals)", () => {
    const at = decideBudgetState({ repliesToday: 0, allowance: 200, path: [unit({ unitNodeId: "d-web", spentUsd: "10.00000000" })] }, NOW);
    expect(at).toEqual({ stopped: true, stop: { kind: "department", unitNodeId: "d-web", resetsAt: NEXT_MONTH } });
    expect(decideBudgetState({ repliesToday: 0, allowance: 200, path: [unit({ unitNodeId: "d-web", spentUsd: "12.5" })] }, NOW).stopped).toBe(true);
    expect(decideBudgetState({ repliesToday: 0, allowance: 200, path: [unit({ unitNodeId: "d-web", spentUsd: "9.99999999" })] }, NOW).stopped).toBe(false);
  });

  it("department: unknown cost (null) never counts, and a spend that was not computed never stops", () => {
    expect(decideBudgetState({ repliesToday: 0, allowance: 200, path: [unit({ unitNodeId: "d-web", spentUsd: null })] }, NOW).stopped).toBe(false);
    expect(decideBudgetState({ repliesToday: 0, allowance: 200, path: [unit({ unitNodeId: "d-web", spentUsd: undefined })] }, NOW).stopped).toBe(false);
  });

  it("department: report mode never stops anything, however far over (AIP-D7)", () => {
    expect(decideBudgetState({ repliesToday: 0, allowance: 200, path: [unit({ unitNodeId: "d-web", mode: "report", spentUsd: "999" })] }, NOW).stopped).toBe(false);
    expect(decideBudgetState({ repliesToday: 0, allowance: 200, path: [unit({ unitNodeId: "d-web", mode: null, spentUsd: "999" })] }, NOW).stopped).toBe(false);
  });

  it("department: lifted THIS month does not stop; lifted LAST month does", () => {
    expect(decideBudgetState({ repliesToday: 0, allowance: 200, path: [unit({ unitNodeId: "d-web", spentUsd: "50", stopLiftedMonth: "2026-10" })] }, NOW).stopped).toBe(false);
    expect(decideBudgetState({ repliesToday: 0, allowance: 200, path: [unit({ unitNodeId: "d-web", spentUsd: "50", stopLiftedMonth: "2026-09" })] }, NOW))
      .toEqual({ stopped: true, stop: { kind: "department", unitNodeId: "d-web", resetsAt: NEXT_MONTH } });
  });

  it("the ancestor walk: the NEAREST stopped unit is named; an unstopped or lifted nearer unit is passed over", () => {
    const path = [
      unit({ unitNodeId: "dv-fe", mode: "report", spentUsd: "999" }), // the home node: report only
      unit({ unitNodeId: "d-web", spentUsd: "50", stopLiftedMonth: "2026-10" }), // its department: lifted this month
      unit({ unitNodeId: "d-corp", spentUsd: "10" }), // the company root's unit budget: over
    ];
    expect(decideBudgetState({ repliesToday: 0, allowance: 200, path }, NOW)).toEqual({
      stopped: true, stop: { kind: "department", unitNodeId: "d-corp", resetsAt: NEXT_MONTH },
    });
    const twoOver = [unit({ unitNodeId: "dv-fe", spentUsd: "11" }), unit({ unitNodeId: "d-web", spentUsd: "50" })];
    expect(decideBudgetState({ repliesToday: 0, allowance: 200, path: twoOver }, NOW)).toMatchObject({ stop: { unitNodeId: "dv-fe" } });
  });

  it("both at once: the allowance is reported", () => {
    expect(decideBudgetState({ repliesToday: 200, allowance: 200, path: [unit({ unitNodeId: "d-web", spentUsd: "50" })] }, NOW)).toEqual({
      stopped: true, stop: { kind: "allowance", resetsAt: MIDNIGHT },
    });
  });

  it("an unparseable figure cannot stop anyone", () => {
    expect(decideBudgetState({ repliesToday: 0, allowance: 200, path: [unit({ unitNodeId: "d-web", spentUsd: "-1" })] }, NOW).stopped).toBe(false);
  });

  it("isStopCandidate: soft_stop and not lifted for the month", () => {
    expect(isStopCandidate({ mode: "soft_stop", stopLiftedMonth: null }, "2026-10")).toBe(true);
    expect(isStopCandidate({ mode: "soft_stop", stopLiftedMonth: "2026-09" }, "2026-10")).toBe(true);
    expect(isStopCandidate({ mode: "soft_stop", stopLiftedMonth: "2026-10" }, "2026-10")).toBe(false);
    expect(isStopCandidate({ mode: "report", stopLiftedMonth: null }, "2026-10")).toBe(false);
  });
});

// ── the strict computation over a fake client ────────────────────────────────────────────────────────────────────────────────────

interface FakeDb {
  allowance?: number;
  repliesToday: number;
  /** closure rows joined to budgets, nearest first, as the SQL returns them. */
  path: Array<{ unit_node_id: string; mode: string; monthly_usd: string; stop_lifted_month: string | null }>;
  spend: Record<string, string | null>;
}

function fakeTx(db: FakeDb, log: string[]) {
  const client = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      if (/FROM ai_person_allowances/.test(sql)) {
        log.push("allowance");
        return { rows: db.allowance === undefined ? [] : [{ daily_replies: db.allowance }] };
      }
      if (/count\(\*\)::int AS n FROM ai_usage_events/.test(sql)) {
        log.push(`replies:${String(params[2])}..${String(params[3])}`);
        expect(sql).toMatch(/surface = 'assistant' AND outcome = 'ok'/);
        return { rows: [{ n: db.repliesToday }] };
      }
      if (/FROM org_unit_closure cl\s+JOIN ai_budgets/.test(sql)) {
        log.push(`path:${String(params[1])}`);
        return { rows: db.path };
      }
      if (/WITH s AS/.test(sql)) {
        const node = String(params[3]);
        log.push(`spend:${node}`);
        return { rows: [{ calls: 1, prompt_tokens: null, completion_tokens: null, cost_usd: db.spend[node] ?? null, estimated_token_calls: 0, no_token_calls: 0, no_cost_calls: 0, provider_cost_calls: 0, table_cost_calls: 0 }] };
      }
      throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
    }),
  } as unknown as PoolClient;
  const withTenants = vi.fn(async (ids: string[], fn: (c: PoolClient) => Promise<unknown>) => {
    expect(ids).toEqual([T]); // always the one company: the tables are FORCE RLS
    return fn(client);
  });
  return withTenants as unknown as typeof import("../../db").withTenants;
}

describe("AIP-18 · computeBudgetState (strict, fresh)", () => {
  it("reads the override, then today's UTC window of assistant replies; with the allowance reached it never reads the department", async () => {
    const log: string[] = [];
    const placement = vi.fn();
    const s = await computeBudgetState(T, U, { now: () => NOW, withTenants: fakeTx({ allowance: 3, repliesToday: 3, path: [], spend: {} }, log), resolvePlacement: placement });
    expect(s).toEqual({ stopped: true, stop: { kind: "allowance", resetsAt: MIDNIGHT } });
    expect(log).toEqual(["allowance", `replies:2026-10-30T00:00:00Z..${MIDNIGHT}`]);
    expect(placement).not.toHaveBeenCalled();
  });

  it("with no override row the default allowance applies (AIP-D9)", async () => {
    const log: string[] = [];
    const placement = vi.fn(async () => ({ orgUnitId: null, unitNodeId: null }));
    const atDefault = await computeBudgetState(T, U, { now: () => NOW, withTenants: fakeTx({ repliesToday: config.aiUsage.dailyReplyAllowance, path: [], spend: {} }, log), resolvePlacement: placement });
    expect(atDefault.stopped && atDefault.stop.kind).toBe("allowance");
    const below = await computeBudgetState(T, U, { now: () => NOW, withTenants: fakeTx({ repliesToday: config.aiUsage.dailyReplyAllowance - 1, path: [], spend: {} }, []), resolvePlacement: placement });
    expect(below).toEqual(NOT_STOPPED);
  });

  it("walks UP from the home node and reads the spend ONLY of rows that can stop (soft_stop, not lifted)", async () => {
    const log: string[] = [];
    const db: FakeDb = {
      repliesToday: 0,
      path: [
        { unit_node_id: "dv-fe", mode: "report", monthly_usd: "1.0000", stop_lifted_month: null },
        { unit_node_id: "d-web", mode: "soft_stop", monthly_usd: "5.0000", stop_lifted_month: "2026-10" },
        { unit_node_id: "d-corp", mode: "soft_stop", monthly_usd: "5.0000", stop_lifted_month: "2026-09" },
      ],
      spend: { "dv-fe": "99", "d-web": "99", "d-corp": "5.00000000" },
    };
    const s = await computeBudgetState(T, U, { now: () => NOW, withTenants: fakeTx(db, log), resolvePlacement: async () => ({ orgUnitId: null, unitNodeId: "dv-fe" }) });
    expect(s).toEqual({ stopped: true, stop: { kind: "department", unitNodeId: "d-corp", resetsAt: NEXT_MONTH } });
    expect(log.filter((l) => l.startsWith("path:") || l.startsWith("spend:"))).toEqual(["path:dv-fe", "spend:d-corp"]);
  });

  it("a person with no home node has no department stop", async () => {
    const log: string[] = [];
    const s = await computeBudgetState(T, U, { now: () => NOW, withTenants: fakeTx({ repliesToday: 0, path: [], spend: {} }, log), resolvePlacement: async () => ({ orgUnitId: null, unitNodeId: null }) });
    expect(s).toEqual(NOT_STOPPED);
    expect(log.some((l) => l.startsWith("path:"))).toBe(false);
  });

  it("THROWS on a failure (the release relies on it: a failure keeps a hand-off held)", async () => {
    const boom = (async () => { throw new Error("db down"); }) as unknown as typeof import("../../db").withTenants;
    await expect(computeBudgetState(T, U, { now: () => NOW, withTenants: boom })).rejects.toThrow("db down");
  });
});

// ── the cached, fail-open read ───────────────────────────────────────────────────────────────────────────────────────────────────

describe("AIP-18 · budgetState (cached, fails open)", () => {
  beforeEach(() => clearBudgetStateCacheForTests());
  const stopped: BudgetState = { stopped: true, stop: { kind: "allowance", resetsAt: MIDNIGHT } };

  it("a failure to compute is NOT a stop, and is not cached", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const compute = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(stopped);
    expect(await budgetState(T, U, { compute, now: () => NOW })).toEqual(NOT_STOPPED);
    expect(await budgetState(T, U, { compute, now: () => NOW })).toEqual(stopped);
    expect(compute).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("a slow miss is NOT a stop (the send is never held up), and the late answer fills the cache", async () => {
    let finish!: (s: BudgetState) => void;
    const compute = vi.fn(() => new Promise<BudgetState>((r) => (finish = r)));
    expect(await budgetState(T, U, { compute, now: () => NOW, timeoutMs: 5 })).toEqual(NOT_STOPPED);
    finish(stopped);
    await new Promise((r) => setTimeout(r, 0));
    expect(await budgetState(T, U, { compute, now: () => NOW })).toEqual(stopped);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("caches for 60 seconds per company and person; concurrent misses compute once", async () => {
    const compute = vi.fn(async () => NOT_STOPPED);
    await Promise.all([budgetState(T, U, { compute, now: () => NOW }), budgetState(T, U, { compute, now: () => NOW })]);
    expect(compute).toHaveBeenCalledTimes(1);
    await budgetState(T, U, { compute, now: () => new Date(NOW.getTime() + 59_000) });
    expect(compute).toHaveBeenCalledTimes(1);
    await budgetState(T, U, { compute, now: () => new Date(NOW.getTime() + 60_001) });
    expect(compute).toHaveBeenCalledTimes(2);
    // another person, another company: their own entries
    await budgetState(T, "33333333-3333-4333-8333-333333333333", { compute, now: () => NOW });
    await budgetState("44444444-4444-4444-8444-444444444444", U, { compute, now: () => NOW });
    expect(compute).toHaveBeenCalledTimes(4);
  });

  it("a stop is never cached past its own reset instant", async () => {
    const lateNow = new Date("2026-10-30T23:59:30.000Z");
    const compute = vi.fn(async () => stopped);
    await budgetState(T, U, { compute, now: () => lateNow });
    await budgetState(T, U, { compute, now: () => new Date("2026-10-31T00:00:01.000Z") }); // past midnight, under 60 s later
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("invalidate forgets one person, or a whole company", async () => {
    const compute = vi.fn(async () => NOT_STOPPED);
    await budgetState(T, U, { compute, now: () => NOW });
    invalidateBudgetState(T, U);
    await budgetState(T, U, { compute, now: () => NOW });
    invalidateBudgetState(T);
    await budgetState(T, U, { compute, now: () => NOW });
    invalidateBudgetState("44444444-4444-4444-8444-444444444444"); // another company: nothing of T's is forgotten
    await budgetState(T, U, { compute, now: () => NOW });
    expect(compute).toHaveBeenCalledTimes(3);
  });

  it("no company or no person: not stopped, nothing asked", async () => {
    const compute = vi.fn();
    expect(await budgetState(T, null, { compute })).toEqual(NOT_STOPPED);
    expect(await budgetState("", U, { compute })).toEqual(NOT_STOPPED);
    expect(compute).not.toHaveBeenCalled();
  });
});
