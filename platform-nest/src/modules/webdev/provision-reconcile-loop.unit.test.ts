// M6-P4c2 — the scheduled reconcile's rules, with no database and no network: the selection predicate, the
// batch bound, the back-off schedule, the interval parsing, and the tick's error isolation (fakes at every port).
// The loop against real Postgres (RLS, the advisory lock, the real state machine) is
// provision-reconcile-loop.db.test.ts.
import { describe, it, expect, vi } from "vitest";
import { config, readIntervalMs } from "../../config";
import type { Principal } from "../../rbac/principal";
import type { CompletionReport } from "./provision-completion";
import { ErpRepoControlNotConfiguredError } from "./erp-repo-control-provider";
import {
  RECONCILE_BACKOFF, RECONCILE_BATCH, RECONCILE_STOP_AFTER_MS, isDue, minGapMs, planBatch, reconcileRoute,
  runProvisionReconcileTick, type ReconcileCandidate, type TickDeps,
} from "./provision-reconcile-loop";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse("2026-10-12T12:00:00Z");

let seq = 0;
function cand(over: Partial<ReconcileCandidate> = {}): ReconcileCandidate {
  seq += 1;
  return {
    id: `site-${String(seq).padStart(4, "0")}`,
    tenantId: "t1",
    provider: "erp_repo",
    status: "live",
    repoUrl: "https://github.com/acme-org/x",
    completionState: "tenant_ready",
    approvalApproved: false,
    requestedBy: "u-req",
    decidedBy: "u-dec",
    anchorMs: NOW - 10 * MIN,
    lastAttemptMs: null,
    createdMs: NOW - 20 * MIN,
    ...over,
  };
}

describe("selection predicate (reconcileRoute)", () => {
  it("a repo-done row that is not complete is advanced by the completion alone", () => {
    for (const status of ["provisioned", "live"] as const) {
      for (const completionState of [null, "registered", "tenant_ready"] as const) {
        expect(reconcileRoute(cand({ status, completionState }))).toBe("completion");
      }
    }
  });

  it("a complete row is never selected", () => {
    expect(reconcileRoute(cand({ completionState: "complete" }))).toBeNull();
    expect(reconcileRoute(cand({ status: "pending", completionState: "complete", approvalApproved: true }))).toBeNull();
  });

  it("a failed repo row is never selected, whatever its completion state", () => {
    expect(reconcileRoute(cand({ status: "failed", completionState: null }))).toBeNull();
    expect(reconcileRoute(cand({ status: "failed", completionState: "tenant_ready" }))).toBeNull();
  });

  it("a pending row is selected only once its repo request was APPROVED, and then via the repo reconcile", () => {
    expect(reconcileRoute(cand({ status: "pending", completionState: null, repoUrl: null, approvalApproved: true }))).toBe("repo_then_completion");
    expect(reconcileRoute(cand({ status: "pending", completionState: null, repoUrl: null, approvalApproved: false }))).toBeNull();
  });

  it("a row with no repo url (provisioned/live without one) is not ready", () => {
    expect(reconcileRoute(cand({ completionState: null, repoUrl: null }))).toBeNull();
  });

  it("only ERP repo control rows begin a completion (a mirror row from the dead `provision` host is left alone)", () => {
    expect(reconcileRoute(cand({ provider: "provision", completionState: null }))).toBeNull();
    expect(reconcileRoute(cand({ provider: "webdesk", completionState: null }))).toBeNull();
  });

  it("an unfinished request is not selected", () => {
    expect(reconcileRoute(cand({ status: "requested", completionState: null, repoUrl: null }))).toBeNull();
  });
});

describe("back-off schedule", () => {
  it("names the documented bands, in order", () => {
    expect(RECONCILE_BACKOFF).toEqual([
      { underMs: 1 * HOUR, gapMs: 0 },
      { underMs: 6 * HOUR, gapMs: 30 * MIN },
      { underMs: 24 * HOUR, gapMs: 2 * HOUR },
    ]);
    expect(RECONCILE_STOP_AFTER_MS).toBe(24 * HOUR);
  });

  it("minGapMs: every tick for an hour, then 30 min, then 2 h, then stop at 24 h", () => {
    expect(minGapMs(0)).toBe(0);
    expect(minGapMs(HOUR - 1)).toBe(0);
    expect(minGapMs(HOUR)).toBe(30 * MIN);
    expect(minGapMs(6 * HOUR - 1)).toBe(30 * MIN);
    expect(minGapMs(6 * HOUR)).toBe(2 * HOUR);
    expect(minGapMs(24 * HOUR - 1)).toBe(2 * HOUR);
    expect(minGapMs(24 * HOUR)).toBeNull();
    expect(minGapMs(30 * 24 * HOUR)).toBeNull();
  });

  it("a negative age (clock skew) reads as brand new", () => {
    expect(minGapMs(-5 * MIN)).toBe(0);
  });

  it("isDue: a young row is due every tick, even right after an attempt", () => {
    expect(isDue({ anchorMs: NOW - 10 * MIN, lastAttemptMs: NOW - 1000 }, NOW)).toBe(true);
  });

  it("isDue: a 2 h old row waits 30 min after its last attempt", () => {
    const anchorMs = NOW - 2 * HOUR;
    expect(isDue({ anchorMs, lastAttemptMs: NOW - 29 * MIN }, NOW)).toBe(false);
    expect(isDue({ anchorMs, lastAttemptMs: NOW - 30 * MIN }, NOW)).toBe(true);
  });

  it("isDue: a 10 h old row waits 2 h after its last attempt", () => {
    const anchorMs = NOW - 10 * HOUR;
    expect(isDue({ anchorMs, lastAttemptMs: NOW - 119 * MIN }, NOW)).toBe(false);
    expect(isDue({ anchorMs, lastAttemptMs: NOW - 120 * MIN }, NOW)).toBe(true);
  });

  it("isDue: never attempted is due inside the window; past 24 h nothing is due, attempted or not", () => {
    expect(isDue({ anchorMs: NOW - 10 * HOUR, lastAttemptMs: null }, NOW)).toBe(true);
    expect(isDue({ anchorMs: NOW - 24 * HOUR, lastAttemptMs: null }, NOW)).toBe(false);
    expect(isDue({ anchorMs: NOW - 25 * HOUR, lastAttemptMs: NOW - 10 * HOUR }, NOW)).toBe(false);
  });
});

describe("planBatch", () => {
  it("bounds the batch (20 by default) and keeps the least recently attempted", () => {
    const rows = Array.from({ length: 30 }, (_, i) => cand({ lastAttemptMs: NOW - (i + 1) * 1000 }));
    const plan = planBatch(rows, NOW);
    expect(RECONCILE_BATCH).toBe(20);
    expect(plan).toHaveLength(20);
    // The 20 longest-ago attempts: i = 29 .. 10.
    expect(new Set(plan.map((p) => p.id))).toEqual(new Set(rows.slice(10).map((r) => r.id)));
    // Oldest attempt first.
    expect(plan.map((p) => p.lastAttemptMs)).toEqual([...plan.map((p) => p.lastAttemptMs)].sort((a, b) => (a as number) - (b as number)));
  });

  it("a never-attempted row sorts by its transition age, so the oldest stuck row is first", () => {
    const old = cand({ anchorMs: NOW - 50 * MIN, lastAttemptMs: null });
    const young = cand({ anchorMs: NOW - 5 * MIN, lastAttemptMs: null });
    expect(planBatch([young, old], NOW).map((p) => p.id)).toEqual([old.id, young.id]);
  });

  it("drops rows that are not selected, not due, or past the stop", () => {
    const ok = cand();
    const complete = cand({ completionState: "complete" });
    const waiting = cand({ anchorMs: NOW - 2 * HOUR, lastAttemptMs: NOW - 5 * MIN });
    const stopped = cand({ anchorMs: NOW - 30 * HOUR });
    expect(planBatch([complete, waiting, stopped, ok], NOW).map((p) => p.id)).toEqual([ok.id]);
  });

  it("a batch of 0 or less attempts nothing", () => {
    expect(planBatch([cand()], NOW, 0)).toEqual([]);
    expect(planBatch([cand()], NOW, -3)).toEqual([]);
  });
});

describe("PROVISION_RECONCILE_INTERVAL_MS parsing (the empty env var must never become 0)", () => {
  const parse = (raw: string | undefined) => readIntervalMs(raw, 5 * MIN, 30_000);

  it("empty, blank, undefined, junk, zero and negative all fall back to 5 minutes", () => {
    for (const raw of [undefined, "", "   ", "soon", "5m", "0", "-1"]) expect(parse(raw)).toBe(5 * MIN);
  });

  it("under the 30 s floor falls back; the floor itself and above are honoured", () => {
    expect(parse("29999")).toBe(5 * MIN);
    expect(parse("30000")).toBe(30_000);
    expect(parse("600000")).toBe(600_000);
  });

  it("the shipped config default is 5 minutes with the variable unset", () => {
    if (process.env.PROVISION_RECONCILE_INTERVAL_MS === undefined || process.env.PROVISION_RECONCILE_INTERVAL_MS.trim() === "") {
      expect(config.provision.reconcileIntervalMs).toBe(5 * MIN);
    }
    expect(config.provision.reconcileIntervalMs).toBeGreaterThanOrEqual(30_000);
  });
});

describe("the tick", () => {
  const principal = (userId: string) => ({ userId, assurance: "linked", companies: [], roles: [], sessionVersion: 1 }) as unknown as Principal;
  const done = (over: Partial<CompletionReport> = {}): CompletionReport => ({ state: "complete", next: "done", advanced: ["contract"], error: null, ...over });

  function deps(over: Partial<TickDeps> & { rows?: Record<string, ReconcileCandidate[]> } = {}) {
    const { rows = {}, ...rest } = over;
    const advanced: string[] = [];
    const faults: Array<[string, string]> = [];
    const base: TickDeps = {
      listTenants: async () => Object.keys(rows),
      tenantEnabled: async () => true,
      readCandidates: async (t) => rows[t] ?? [],
      assemble: async (u) => principal(u),
      advance: async (c) => {
        advanced.push(c.id);
        return done();
      },
      recordFault: async (c, token) => {
        faults.push([c.id, token]);
      },
      log: () => undefined,
    };
    return { d: { ...base, ...rest } as TickDeps, advanced, faults };
  }

  it("reaches every tenant and drives each due row once", async () => {
    const a = cand({ tenantId: "ta" });
    const b = cand({ tenantId: "tb" });
    const { d, advanced } = deps({ rows: { ta: [a], tb: [b] } });
    const r = await runProvisionReconcileTick(d, NOW);
    expect(advanced.sort()).toEqual([a.id, b.id].sort());
    expect(r).toMatchObject({ tenants: 2, planned: 2, attempted: 2, progressed: 2, completed: 2, failed: 0 });
  });

  it("cuts the batch across the whole estate, not per tenant", async () => {
    const ta = Array.from({ length: 15 }, () => cand({ tenantId: "ta" }));
    const tb = Array.from({ length: 15 }, () => cand({ tenantId: "tb", lastAttemptMs: NOW - 10 * MIN }));
    const { d, advanced } = deps({ rows: { ta, tb } });
    const r = await runProvisionReconcileTick(d, NOW);
    expect(r.planned).toBe(RECONCILE_BATCH);
    expect(advanced).toHaveLength(RECONCILE_BATCH);
    expect(new Set(advanced).size).toBe(RECONCILE_BATCH);
  });

  it("one row throwing never stops the tick; the fault is recorded on that row only", async () => {
    const bad = cand({ anchorMs: NOW - 40 * MIN });
    const good = cand({ anchorMs: NOW - 5 * MIN });
    const advance = vi.fn(async (c: ReconcileCandidate) => {
      if (c.id === bad.id) throw new TypeError("boom");
      return done();
    });
    const { d, faults } = deps({ rows: { t1: [good, bad] }, advance });
    const r = await runProvisionReconcileTick(d, NOW);
    expect(advance).toHaveBeenCalledTimes(2);
    expect(faults).toEqual([[bad.id, "reconcile_failed: TypeError"]]);
    expect(r).toMatchObject({ attempted: 2, failed: 1, completed: 1 });
  });

  it("an unexpected completion fault reported by the service (completion_failed) is recorded so the back-off sees it", async () => {
    const c = cand();
    const { d, faults } = deps({ rows: { t1: [c] }, advance: async () => ({ state: "tenant_ready", next: "contract", advanced: [], error: "completion_failed" }) });
    const r = await runProvisionReconcileTick(d, NOW);
    expect(faults).toEqual([[c.id, "completion_failed"]]);
    expect(r).toMatchObject({ failed: 1, progressed: 0 });
  });

  it("a typed, already-recorded error (contract_not_published) is not re-recorded by the loop", async () => {
    const { d, faults } = deps({ rows: { t1: [cand()] }, advance: async () => ({ state: "tenant_ready", next: "contract", advanced: [], error: "contract_not_published" }) });
    const r = await runProvisionReconcileTick(d, NOW);
    expect(faults).toEqual([]);
    expect(r).toMatchObject({ attempted: 1, failed: 0, progressed: 0 });
  });

  it("a failing recordFault cannot break the tick", async () => {
    const { d } = deps({ rows: { t1: [cand(), cand()] }, advance: async () => { throw new Error("x"); }, recordFault: async () => { throw new Error("db down"); } });
    await expect(runProvisionReconcileTick(d, NOW)).resolves.toMatchObject({ attempted: 2, failed: 2 });
  });

  it("a tenant whose read throws is counted and the others still run", async () => {
    const ok = cand({ tenantId: "tb" });
    const { d, advanced } = deps({
      rows: { ta: [], tb: [ok] },
      readCandidates: async (t) => {
        if (t === "ta") throw new Error("rls");
        return [ok];
      },
    });
    const r = await runProvisionReconcileTick(d, NOW);
    expect(advanced).toEqual([ok.id]);
    expect(r.tenantErrors).toBe(1);
  });

  it("listing companies failing ends the tick quietly instead of throwing", async () => {
    const { d } = deps({ listTenants: async () => { throw new Error("db down"); } });
    await expect(runProvisionReconcileTick(d, NOW)).resolves.toMatchObject({ tenants: 0, tenantErrors: 1, attempted: 0 });
  });

  it("a tenant with the webdev module OFF is skipped, even though the third wall would have read its rows", async () => {
    const off = cand({ tenantId: "off" });
    const on = cand({ tenantId: "on" });
    const { d, advanced } = deps({ rows: { off: [off], on: [on] }, tenantEnabled: async (t) => t === "on" });
    await runProvisionReconcileTick(d, NOW);
    expect(advanced).toEqual([on.id]);
  });

  it("acts as the requester; falls back to the decider; with neither active the row is skipped, never run as someone else", async () => {
    const seen: Array<[string, string | null]> = [];
    const advance = async (c: ReconcileCandidate, p: Principal) => {
      seen.push([c.id, p.userId]);
      return done();
    };
    const both = cand({ requestedBy: "u-req", decidedBy: "u-dec" });
    const onlyDecider = cand({ requestedBy: "u-gone", decidedBy: "u-dec" });
    const nobody = cand({ requestedBy: null, decidedBy: "u-gone" });
    const { d } = deps({
      rows: { t1: [both, onlyDecider, nobody] },
      advance,
      assemble: async (u) => (u === "u-gone" ? null : principal(u)),
    });
    const r = await runProvisionReconcileTick(d, NOW);
    expect(Object.fromEntries(seen)).toEqual({ [both.id]: "u-req", [onlyDecider.id]: "u-dec" });
    expect(r).toMatchObject({ attempted: 2, noActor: 1 });
  });

  it("an unconfigured repo driver (GITHUB_ORG unset) skips the row without recording a fault", async () => {
    const { d, faults } = deps({ rows: { t1: [cand()] }, advance: async () => { throw new ErpRepoControlNotConfiguredError("GITHUB_ORG is not configured"); } });
    const r = await runProvisionReconcileTick(d, NOW);
    expect(r).toMatchObject({ notConfigured: 1, attempted: 0, failed: 0 });
    expect(faults).toEqual([]);
  });

  it("rows inside their back-off wait are not attempted", async () => {
    const waiting = cand({ anchorMs: NOW - 3 * HOUR, lastAttemptMs: NOW - 10 * MIN });
    const { d, advanced } = deps({ rows: { t1: [waiting] } });
    const r = await runProvisionReconcileTick(d, NOW);
    expect(advanced).toEqual([]);
    expect(r.planned).toBe(0);
  });

  it("the actor is assembled once per user per tick", async () => {
    const assemble = vi.fn(async (u: string) => principal(u));
    const { d } = deps({ rows: { t1: [cand(), cand(), cand()] }, assemble });
    await runProvisionReconcileTick(d, NOW);
    expect(assemble).toHaveBeenCalledTimes(1);
  });
});
