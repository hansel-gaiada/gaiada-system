// AIP-18 — what a stopped turn does, PURE and with fakes: the `turn_budget` part (three facts, never a figure), reading it back from a
// placeholder's parts, the trims (half the passages, never below 1; half the transcript budget), the routing (unstopped is exactly today's;
// stopped is `fast` with no hint and no session), and `assembleContext` under the trims: the knowledge store is asked for the trimmed count,
// the prompt keeps the newest message and drops older ones past half the budget, and compaction still folds on the FULL budget (the thread's
// stored summary is not moved by a lighter turn). No database, no Cerbos: always runs.
import { describe, it, expect, vi } from "vitest";
import type { PoolClient } from "pg";
import { assembleContext } from "./context";
import {
  STOPPED_TIER, readTurnBudget, stoppedContextOpts, trimmedCharBudget, trimmedKnowledgeTopK, turnBudgetPart, turnBudgetWire, turnRouting,
} from "./turn-budget";
import type { KnowledgeStoreHit } from "../search/knowledge-client";
import type { Principal } from "../../rbac/principal";

const RESETS = "2026-10-31T00:00:00.000Z";

describe("AIP-18 · the turn_budget part", () => {
  it("is null when not stopped, and names kind, unit (department only) and reset when stopped — never a figure", () => {
    expect(turnBudgetPart({ stopped: false })).toBeNull();
    expect(turnBudgetPart({ stopped: true, stop: { kind: "allowance", resetsAt: RESETS } })).toEqual({ type: "turn_budget", kind: "allowance", resetsAt: RESETS });
    const dept = turnBudgetPart({ stopped: true, stop: { kind: "department", unitNodeId: "d-web", resetsAt: "2026-11-01T00:00:00.000Z" } });
    expect(dept).toEqual({ type: "turn_budget", kind: "department", unitNodeId: "d-web", resetsAt: "2026-11-01T00:00:00.000Z" });
    expect(Object.keys(dept!).sort()).toEqual(["kind", "resetsAt", "type", "unitNodeId"]);
    // an allowance stop never carries a unit, even if one were handed in
    expect(turnBudgetPart({ stopped: true, stop: { kind: "allowance", unitNodeId: "d-web", resetsAt: RESETS } })).not.toHaveProperty("unitNodeId");
  });

  it("is read back from a placeholder's parts beside turn_mode and turn_context, re-validated", () => {
    const parts = [{ type: "turn_mode", mode: "tools", agent: "a" }, { type: "turn_context", department: null, page: "/x" }, { type: "turn_budget", kind: "allowance", resetsAt: RESETS }];
    expect(readTurnBudget(parts)).toEqual({ type: "turn_budget", kind: "allowance", resetsAt: RESETS });
    expect(readTurnBudget([])).toBeNull();
    expect(readTurnBudget(null)).toBeNull();
    expect(readTurnBudget([{ type: "turn_budget", kind: "everything", resetsAt: RESETS }])).toBeNull();
    expect(readTurnBudget([{ type: "turn_budget", kind: "allowance", resetsAt: "soon" }])).toBeNull();
    expect(readTurnBudget([{ type: "turn_budget", kind: "allowance" }])).toBeNull();
    // extra keys (a figure smuggled into a stored part) are not carried on
    expect(readTurnBudget([{ type: "turn_budget", kind: "department", unitNodeId: "d-web", resetsAt: RESETS, spentUsd: "9" }])).toEqual({
      type: "turn_budget", kind: "department", unitNodeId: "d-web", resetsAt: RESETS,
    });
  });

  it("the wire shape is the part without its type", () => {
    expect(turnBudgetWire({ type: "turn_budget", kind: "allowance", resetsAt: RESETS })).toEqual({ kind: "allowance", resetsAt: RESETS });
    expect(turnBudgetWire({ type: "turn_budget", kind: "department", unitNodeId: "d-seo", resetsAt: RESETS })).toEqual({ kind: "department", unitNodeId: "d-seo", resetsAt: RESETS });
  });
});

describe("AIP-18 · trims and routing", () => {
  it("half the passages, never below 1 while retrieval is on; off stays off", () => {
    expect(trimmedKnowledgeTopK(4)).toBe(2);
    expect(trimmedKnowledgeTopK(5)).toBe(2);
    expect(trimmedKnowledgeTopK(2)).toBe(1);
    expect(trimmedKnowledgeTopK(1)).toBe(1);
    expect(trimmedKnowledgeTopK(0)).toBe(0);
    expect(trimmedKnowledgeTopK(-1)).toBe(-1);
  });

  it("half the character budget", () => {
    expect(trimmedCharBudget(12_000)).toBe(6_000);
    expect(trimmedCharBudget(3)).toBe(1);
  });

  it("stoppedContextOpts is {} unstopped (the call is unchanged) and the halves stopped", () => {
    expect(stoppedContextOpts(null, { knowledgeTopK: 4, contextCharBudget: 12_000 })).toEqual({});
    expect(stoppedContextOpts({ type: "turn_budget", kind: "allowance", resetsAt: RESETS }, { knowledgeTopK: 4, contextCharBudget: 12_000 })).toEqual({
      knowledgeTopK: 2, promptCharBudget: 6_000,
    });
  });

  it("unstopped routing is exactly today's; stopped is fast with no provider hint and no session", () => {
    const today = { provider: "hermes", tier: "strong" as const, providerSession: "sess-1" };
    expect(turnRouting(false, today)).toBe(today);
    expect(turnRouting(true, today)).toEqual({ provider: undefined, tier: "fast", providerSession: undefined });
    expect(STOPPED_TIER).toBe("fast");
  });
});

// ── assembleContext under the trims ──────────────────────────────────────────────────────────────────────────────────────────────

const T = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const owner = { userId: OWNER, assurance: "linked", companies: [T], rootCompanies: [], roles: [], perms: [], sessionVersion: 1 } as unknown as Principal;

function client(messages: Array<{ seq: number; role: string; content: string }>): PoolClient {
  return {
    query: vi.fn(async (sql: string) => {
      if (/FROM assistant_messages/.test(sql)) return { rows: messages };
      return { rows: [] };
    }),
  } as unknown as PoolClient;
}
const thread = { ownerUserId: OWNER, compactionSummary: null, compactionSummaryUptoSeq: null };
const hit = (n: number): KnowledgeStoreHit =>
  ({ tenantId: T, sourceRef: `web:page:${n}`, kind: "doc", text: `PUBLIC_${n}`, provenance: "web", confidence: 1, score: 1 - n / 100, audience: "public" }) as unknown as KnowledgeStoreHit;

describe("AIP-18 · assembleContext with the stopped options", () => {
  it("the knowledge store is asked for the trimmed count and at most that many passages are used", async () => {
    const query = vi.fn(async () => [hit(1), hit(2), hit(3), hit(4)]);
    const out = await assembleContext(client([{ seq: 1, role: "user", content: "hello?" }]), "t", thread, 2, {
      tenantId: T, principal: owner, queryKnowledge: query, filterKnowledge: vi.fn(async () => []), ...stoppedContextOpts({ type: "turn_budget", kind: "allowance", resetsAt: RESETS }, { knowledgeTopK: 4, contextCharBudget: 12_000 }),
    });
    expect(out.citations.length).toBeLessThanOrEqual(2);
    expect(out.citations.map((c) => c.sourceRef)).toEqual(["web:page:1", "web:page:2"]);
    const unstopped = await assembleContext(client([{ seq: 1, role: "user", content: "hello?" }]), "t", thread, 2, {
      tenantId: T, principal: owner, queryKnowledge: query, filterKnowledge: vi.fn(async () => []), knowledgeTopK: 4,
    });
    expect(unstopped.citations.length).toBe(4);
  });

  it("the transcript is cut, oldest first, to half the budget for THIS prompt; the newest message is always kept; nothing is folded", async () => {
    const msgs = [
      { seq: 1, role: "user", content: `OLDEST_${"a".repeat(80)}` },
      { seq: 2, role: "assistant", content: `MIDDLE_${"b".repeat(80)}` },
      { seq: 3, role: "user", content: `NEWEST_${"c".repeat(40)}` },
    ];
    // full budget 300 fits all three (each rendered line is under 100 characters), so no compaction either way
    const full = await assembleContext(client(msgs), "t", thread, 4, { tenantId: T, knowledgeTopK: 0, charBudget: 300 });
    expect(full.prompt).toContain("OLDEST_");
    expect(full.compactionUpdate).toBeUndefined();
    const light = await assembleContext(client(msgs), "t", thread, 4, { tenantId: T, knowledgeTopK: 0, charBudget: 300, promptCharBudget: 150 });
    expect(light.prompt).not.toContain("OLDEST_");
    expect(light.prompt).not.toContain("MIDDLE_");
    expect(light.prompt).toContain("NEWEST_");
    expect(light.compactionUpdate).toBeUndefined(); // nothing about the thread changes because one turn was lighter
    // even a newest message longer than the budget is kept whole
    const tiny = await assembleContext(client(msgs), "t", thread, 4, { tenantId: T, knowledgeTopK: 0, charBudget: 300, promptCharBudget: 5 });
    expect(tiny.prompt).toContain(`NEWEST_${"c".repeat(40)}`);
  });

  it("without promptCharBudget the prompt is byte for byte what it was", async () => {
    const msgs = [{ seq: 1, role: "user", content: "one" }, { seq: 2, role: "assistant", content: "two" }, { seq: 3, role: "user", content: "three" }];
    const a = await assembleContext(client(msgs), "t", thread, 4, { tenantId: T, knowledgeTopK: 0 });
    const b = await assembleContext(client(msgs), "t", thread, 4, { tenantId: T, knowledgeTopK: 0, ...stoppedContextOpts(null) });
    expect(b.prompt).toBe(a.prompt);
  });
});
