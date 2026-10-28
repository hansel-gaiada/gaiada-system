// AIP-03b — the ingest rules behind POST /api/internal/ai-usage, pure unit tests (no database): every dependency is injected.
// The route over real Postgres is ingest.http.test.ts; the guard and the 400s without a database are ingest.controller.test.ts.
//
// Proves: a valid batch reaches the writer; a surface a service may not write is refused per index; an unknown key, a bad value and an
// unknown company are each refused per index with a short code that echoes nothing the caller sent; a person who is not a member of the
// company is stored as NULL and counted, never rejected; a caller-supplied department is never trusted; one bad event never fails the
// batch; and a failing membership read or department read costs the person, never the row.
import { describe, it, expect, vi } from "vitest";
import { INGEST_SURFACES, ingestAiUsage, reasonCode, type IngestDeps } from "./ingest";
import type { AiUsageEvent } from "./writer";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const U2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const UNIT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FOREIGN_UNIT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const ev = (over: Record<string, unknown> = {}) => ({
  tenantId: T1, surface: "agent", capability: "llm", tokensSource: "provider", outcome: "ok",
  task: "statusReporter", promptTokens: 10, completionTokens: 5, ...over,
});

function harness(over: Partial<IngestDeps> = {}) {
  const written: AiUsageEvent[] = [];
  const deps: IngestDeps = {
    existingCompanies: async (ids) => new Set(ids.filter((i) => i === T1)),
    members: async (_t, users) => new Set(users.filter((u) => u === U1)),
    resolveUnit: async () => UNIT,
    record: async (e) => { written.push(e); return { ok: true, id: "id" }; },
    ...over,
  };
  return { deps, written };
}

describe("AIP-03b · ingestAiUsage", () => {
  it("writes a valid batch through the writer and reports it accepted", async () => {
    const h = harness();
    const r = await ingestAiUsage([ev(), ev({ surface: "knowledge", capability: "embed", tokensSource: "none", promptTokens: null, completionTokens: null })], h.deps);
    expect(r).toEqual({ accepted: 2, rejected: [], counted: {} });
    expect(h.written.map((e) => e.surface)).toEqual(["agent", "knowledge"]);
  });

  it("a service may write agent, knowledge, bot and other, and nothing else", async () => {
    expect([...INGEST_SURFACES]).toEqual(["agent", "knowledge", "bot", "other"]);
    const h = harness();
    const surfaces = ["assistant", "compaction", "title", "search", "agent", "knowledge", "bot", "other"];
    const r = await ingestAiUsage(surfaces.map((surface) => ev({ surface })), h.deps);
    expect(r.accepted).toBe(4);
    expect(r.rejected).toEqual([0, 1, 2, 3].map((index) => ({ index, reason: "surface_not_allowed" })));
  });

  it("rejects an unknown key, a bad vocabulary value, a non-object and an unknown company, each per index with a code", async () => {
    const h = harness();
    const r = await ingestAiUsage(
      [ev(), ev({ content: "summarise the Q3 contract for Acme" }), ev({ outcome: "maybe" }), "nope", ev({ tenantId: T2 }), ev({ tenantId: "not-a-uuid" }), ev({ task: "has spaces in it" })],
      h.deps,
    );
    expect(r.accepted).toBe(1);
    expect(r.rejected).toEqual([
      { index: 1, reason: "unknown_field" },
      { index: 2, reason: "invalid_outcome" },
      { index: 3, reason: "not_an_object" },
      { index: 4, reason: "unknown_tenant" },
      { index: 5, reason: "invalid_tenantId" },
      { index: 6, reason: "invalid_task" },
    ]);
    expect(h.written).toHaveLength(1);
  });

  it("never echoes a value or a key name the caller sent", async () => {
    const h = harness();
    const secret = "SECRET-PAYLOAD-xyz";
    const r = await ingestAiUsage([ev({ [secret]: "x" }), ev({ task: secret + " with spaces" }), ev({ outcome: secret })], h.deps);
    expect(JSON.stringify(r)).not.toContain("SECRET");
    expect(r.rejected.every((x) => /^[a-zA-Z_]{1,40}$/.test(x.reason))).toBe(true);
  });

  it("a person who is not a member of the company is stored as null and counted, never rejected", async () => {
    const h = harness();
    const r = await ingestAiUsage([ev({ userId: U1 }), ev({ userId: U2 }), ev({ userId: null })], h.deps);
    expect(r).toEqual({ accepted: 3, rejected: [], counted: { user_not_member: 1 } });
    expect(h.written.map((e) => e.userId)).toEqual([U1, null, null]);
  });

  it("looks membership up once per company, for the people named in that company only", async () => {
    const members = vi.fn(async (_t: string, users: string[]) => new Set(users));
    const h = harness({ members, existingCompanies: async (ids) => new Set(ids) });
    await ingestAiUsage([ev({ userId: U1 }), ev({ userId: U1 }), ev({ userId: U2 }), ev({ tenantId: T2, userId: U1 }), ev()], h.deps);
    expect(members).toHaveBeenCalledTimes(2);
    expect(members).toHaveBeenCalledWith(T1, [U1, U2]);
    expect(members).toHaveBeenCalledWith(T2, [U1]);
  });

  it("the department is the member's own primary placement; a supplied department is never trusted", async () => {
    const resolveUnit = vi.fn(async () => UNIT);
    const h = harness({ resolveUnit });
    await ingestAiUsage([ev({ userId: U1, orgUnitId: FOREIGN_UNIT }), ev({ orgUnitId: FOREIGN_UNIT }), ev({ userId: U2, orgUnitId: FOREIGN_UNIT })], h.deps);
    expect(h.written.map((e) => e.orgUnitId)).toEqual([UNIT, null, null]);
    expect(resolveUnit).toHaveBeenCalledTimes(1);
    expect(resolveUnit).toHaveBeenCalledWith(T1, U1);
  });

  it("a failing membership read stores no person, and a failing department read stores no department; the row is still written", async () => {
    const h = harness({ members: async () => { throw new Error("db down"); } });
    expect(await ingestAiUsage([ev({ userId: U1 })], h.deps)).toEqual({ accepted: 1, rejected: [], counted: { user_not_member: 1 } });
    expect(h.written[0].userId).toBeNull();

    const h2 = harness({ resolveUnit: async () => { throw new Error("db down"); } });
    expect((await ingestAiUsage([ev({ userId: U1 })], h2.deps)).accepted).toBe(1);
    expect(h2.written[0]).toMatchObject({ userId: U1, orgUnitId: null });
  });

  it("a write the writer refuses is rejected for that index only", async () => {
    let n = 0;
    const h = harness({ record: async () => (++n === 2 ? { ok: false, reason: "database error 23514" } : { ok: true, id: "id" }) });
    const r = await ingestAiUsage([ev(), ev(), ev()], h.deps);
    expect(r).toEqual({ accepted: 2, rejected: [{ index: 1, reason: "write_failed" }], counted: {} });
    expect(JSON.stringify(r)).not.toContain("23514");
  });

  it("an all-invalid batch never reads the company table", async () => {
    const existingCompanies = vi.fn(async () => new Set<string>());
    const r = await ingestAiUsage([{ nope: 1 }], { ...harness().deps, existingCompanies });
    expect(r.accepted).toBe(0);
    expect(existingCompanies).not.toHaveBeenCalled();
  });
});

describe("AIP-03b · reasonCode", () => {
  it("turns a validator message into a code and never carries the message", () => {
    expect(reasonCode("event must be an object")).toBe("not_an_object");
    expect(reasonCode("unknown field: content")).toBe("unknown_field");
    expect(reasonCode("tenantId must be a uuid")).toBe("invalid_tenantId");
    expect(reasonCode("costSource is required when costUsd is set")).toBe("invalid_costSource");
    expect(reasonCode("something else entirely")).toBe("invalid_event");
  });
});

// The events the SERVICES really emit (usage-event.ts in ai-agents, mcp-hub and wa-chat-bot, plus the reporter's `occurredAt`), pinned byte for byte
// from the producer: one per call site. If a producer ever adds a key, renames a field or sends a value outside a vocabulary, this fails here instead of
// as a silent `rejected` on the live route.
const PRODUCER_EVENTS = JSON.parse(
  '[{"tenantId":"11111111-1111-4111-8111-111111111111","userId":"22222222-2222-4222-8222-222222222222","surface":"agent","capability":"llm","task":"statusReporter","runId":"33333333-3333-4333-8333-333333333333","provider":"openai","promptTokens":120,"completionTokens":30,"tokensSource":"provider","costUsd":0.0021,"costSource":"provider","outcome":"ok","occurredAt":"2026-10-28T01:02:03.000Z"},' +
    '{"tenantId":"11111111-1111-4111-8111-111111111111","userId":null,"surface":"knowledge","capability":"embed","task":"knowledge.ingest","runId":null,"provider":null,"promptTokens":null,"completionTokens":null,"tokensSource":"none","costUsd":null,"costSource":null,"outcome":"ok","occurredAt":"2026-10-28T01:02:03.000Z"},' +
    '{"tenantId":"11111111-1111-4111-8111-111111111111","userId":null,"surface":"other","capability":"media","task":"media.extract","runId":null,"provider":"openai","promptTokens":null,"completionTokens":null,"tokensSource":"none","costUsd":null,"costSource":null,"outcome":"ok","occurredAt":"2026-10-28T01:02:03.000Z"},' +
    '{"tenantId":"11111111-1111-4111-8111-111111111111","userId":null,"surface":"bot","capability":"llm","task":"bot.complete","runId":null,"provider":null,"promptTokens":null,"completionTokens":null,"tokensSource":"none","costUsd":null,"costSource":null,"outcome":"blocked_dlp","occurredAt":"2026-10-28T01:02:03.000Z"}]',
) as unknown[];

describe("AIP-03b · the producers' real events pass the platform's validation", () => {
  it("every event shape a service emits is accepted whole (no unknown key, no value outside a vocabulary)", async () => {
    const h = harness({ members: async (_t, users) => new Set(users) });
    const r = await ingestAiUsage(PRODUCER_EVENTS, h.deps);
    expect(r).toEqual({ accepted: 4, rejected: [], counted: {} });
    expect(h.written[0]).toMatchObject({ surface: "agent", costUsd: 0.0021, costSource: "provider", tokensSource: "provider", userId: "22222222-2222-4222-8222-222222222222" });
    expect(h.written.map((e) => e.outcome)).toEqual(["ok", "ok", "ok", "blocked_dlp"]);
  });
});

describe("AIP-07 · tier on the ingest", () => {
  it("accepts fast, standard, strong and an absent or null tier; anything else is refused for that index as invalid_tier", async () => {
    const h = harness();
    const r = await ingestAiUsage([
      ev({ tier: "fast" }), ev({ tier: "standard" }), ev({ tier: "strong" }), ev(), ev({ tier: null }),
      ev({ tier: "turbo" }), ev({ tier: "Fast" }), ev({ tier: 3 }),
    ], h.deps);
    expect(r.accepted).toBe(5);
    expect(r.rejected).toEqual([{ index: 5, reason: "invalid_tier" }, { index: 6, reason: "invalid_tier" }, { index: 7, reason: "invalid_tier" }]);
    expect(h.written.map((e) => e.tier ?? null)).toEqual(["fast", "standard", "strong", null, null]);
  });
});
