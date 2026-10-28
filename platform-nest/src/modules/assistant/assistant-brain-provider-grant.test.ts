// AIP-08b (owner ruling AIP-D5) — the `assistant.brain.choose_provider` grant in the assistant controller. No database and no Cerbos:
// the controller runs against a recording fake of `withTenants`, and `can()` is a controllable fake that records every question. The
// live halves are cerbos-assistant-brain.test.ts (the policy against a real Cerbos) and assistant.test.ts (HTTP + Postgres + Cerbos).
//
//   - create / PATCH with a named provider: 403 without the grant (nothing written), 200 with it;
//   - clearing the provider and any tier never ask for the grant;
//   - send time: a stored provider is forwarded only while the owner holds the grant, never errors, keeps the stored value;
//   - GET assistant/brains: `canChooseProvider`, and `brains: []` without the grant; the grant is per caller, never cached.
import { describe, it, expect, vi, beforeEach } from "vitest";

const queries: Array<{ sql: string; params: unknown[] }> = [];
let stored: Record<string, unknown> = {};

vi.mock("../../db", () => ({
  newId: () => "new-id",
  withTenants: async (_t: string[], fn: (c: unknown) => unknown) =>
    fn({
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (/content IS NULL AND error_kind IS NULL/.test(sql)) return { rows: [], rowCount: 0 }; // no turn in flight
        if (/COALESCE\(MAX\(seq\)/.test(sql)) return { rows: [{ n: "0" }], rowCount: 1 };
        if (/^\s*SELECT/i.test(sql)) return { rows: [stored], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
    }),
}));
vi.mock("../../core/http", () => ({ authorize: async () => undefined }));

const canCalls: Array<{ principal: { userId: string }; key: string; resource: Record<string, unknown> }> = [];
let grantHolders = new Set<string>();
let canThrows = false;
vi.mock("../../rbac/can", () => ({
  can: async (principal: { userId: string }, key: string, resource: Record<string, unknown>) => {
    canCalls.push({ principal, key, resource });
    if (canThrows) throw new Error("cerbos 503");
    return grantHolders.has(principal.userId);
  },
}));

const relayCalls: Array<Record<string, unknown>> = [];
vi.mock("./stream", async (orig) => ({
  ...(await orig<typeof import("./stream")>()),
  relayGeneration: vi.fn(async (_entry: unknown, input: Record<string, unknown>) => {
    relayCalls.push(input);
    return { text: "hi", tokensEstimate: 1, latencyMs: 1, outcome: "done", usageSource: "estimate" };
  }),
  persistGenerationOutcome: vi.fn(async () => undefined),
}));
vi.mock("./context", async (orig) => ({
  ...(await orig<typeof import("./context")>()),
  assembleContext: vi.fn(async () => ({ prompt: "p", citations: [] })),
}));
vi.mock("./brains", async (orig) => ({
  ...(await orig<typeof import("./brains")>()),
  getBrains: vi.fn(async () => ({
    brains: [{ value: "openai", available: true }, { value: "hermes", available: false }],
    tiers: ["fast", "standard", "strong"],
    checkedAt: "2026-10-28T00:00:00.000Z",
  })),
}));

import { AssistantController, BRAIN_PROVIDER_FORBIDDEN, CHOOSE_PROVIDER_PERMISSION } from "./assistant.controller";

const ctl = new AssistantController();
const reqFor = (userId: string) => ({ principal: { userId } }) as never;
const ADMIN = "u-admin";
const STAFF = "u-staff";
const patch = (userId: string, body: Record<string, unknown>) => ctl.patchThread(reqFor(userId), "t1", "th1", body as never);
const create = (userId: string, body: Record<string, unknown>) => ctl.createThread(reqFor(userId), "t1", body as never);
const writes = () => queries.filter((q) => /^\s*(UPDATE|INSERT)/i.test(q.sql));

beforeEach(() => {
  queries.length = 0;
  canCalls.length = 0;
  relayCalls.length = 0;
  canThrows = false;
  grantHolders = new Set([ADMIN]);
  stored = { id: "th1", ownerUserId: STAFF, brainProvider: null, brainTier: null, hermesSessionId: null };
});

describe("AIP-08b · the question asked", () => {
  it("is the per-resource can() on assistant.brain.choose_provider, for the route's company (id = tenantId)", async () => {
    await create(ADMIN, { brainProvider: "openai" });
    expect(canCalls).toEqual([{ principal: { userId: ADMIN }, key: "assistant.brain.choose_provider", resource: { id: "t1", tenantId: "t1" } }]);
    expect(CHOOSE_PROVIDER_PERMISSION).toBe("assistant.brain.choose_provider");
  });
});

describe("AIP-08b · POST /assistant/threads", () => {
  it("a named provider WITHOUT the grant is 403 brain_provider_forbidden and writes nothing", async () => {
    await expect(create(STAFF, { title: "x", brainProvider: "openai" })).rejects.toMatchObject({ status: 403 });
    await expect(create(STAFF, { brainProvider: "openai" })).rejects.toThrow(BRAIN_PROVIDER_FORBIDDEN);
    expect(writes()).toHaveLength(0);
  });
  it("a named provider WITH the grant is stored", async () => {
    expect(await create(ADMIN, { brainProvider: "openai" })).toEqual({ id: "new-id" });
    expect(writes().at(-1)!.params.slice(4, 6)).toEqual(["openai", null]);
  });
  it("a tier, Auto (nothing) and a blank provider never ask for the grant", async () => {
    await create(STAFF, { brainTier: "strong" });
    await create(STAFF, {});
    await create(STAFF, { brainProvider: "   " });
    await create(STAFF, { brainProvider: null });
    expect(canCalls).toHaveLength(0);
    expect(writes()).toHaveLength(4);
  });
  it("a tier together with a provider stays 400 brain_conflict (validation first; no grant question)", async () => {
    await expect(create(ADMIN, { brainTier: "fast", brainProvider: "openai" })).rejects.toMatchObject({ status: 400 });
  });
});

describe("AIP-08b · PATCH /assistant/threads/:id", () => {
  it("setting a named provider WITHOUT the grant is 403 and writes nothing (not even the title in the same body)", async () => {
    await expect(patch(STAFF, { title: "renamed", brainProvider: "openai" })).rejects.toMatchObject({ status: 403 });
    expect(writes()).toHaveLength(0);
  });
  it("setting a named provider WITH the grant is 200 and written", async () => {
    stored = { ...stored, ownerUserId: ADMIN };
    expect(await patch(ADMIN, { brainProvider: "openai" })).toEqual({ id: "th1" });
    expect(writes().at(-1)!.sql).toContain("brain_provider = $2");
  });
  it("re-sending the SAME stored provider without the grant is still a 403 (a non-null provider always needs it)", async () => {
    stored = { ...stored, brainProvider: "openai" };
    await expect(patch(STAFF, { brainProvider: "openai" })).rejects.toMatchObject({ status: 403 });
  });
  it("clearing the provider (null or blank) needs no grant", async () => {
    stored = { ...stored, brainProvider: "openai" };
    await patch(STAFF, { brainProvider: null });
    await patch(STAFF, { brainProvider: "" });
    expect(canCalls).toHaveLength(0);
    expect(writes()).toHaveLength(2);
  });
  it("any tier, and a plain rename, need no grant", async () => {
    stored = { ...stored, brainProvider: "openai" };
    for (const body of [{ brainTier: "fast" }, { brainTier: "strong" }, { brainTier: null }, { title: "t" }, { pinned: true }]) await patch(STAFF, body);
    expect(canCalls).toHaveLength(0);
    expect(writes()).toHaveLength(5);
  });
});

describe("AIP-08b · send time (POST /assistant/ask, the same rule as the stream route)", () => {
  const ask = (userId: string) => ctl.ask(reqFor(userId), "t1", { question: "q?", threadId: "th1" } as never);

  it("a stored provider is forwarded while the owner holds the grant, with its session", async () => {
    stored = { ...stored, ownerUserId: ADMIN, brainProvider: "hermes", hermesSessionId: "s1" };
    const out = await ask(ADMIN);
    expect(out.ok).toBe(true);
    expect(relayCalls[0]).toMatchObject({ provider: "hermes", providerSession: "s1" });
  });
  it("without the grant NOW: no provider hint and no session (the reply routes as Auto), no error, and the stored value is kept", async () => {
    stored = { ...stored, brainProvider: "hermes", brainTier: null, hermesSessionId: "s1" };
    const out = await ask(STAFF);
    expect(out.ok).toBe(true);
    expect(relayCalls[0].provider).toBeUndefined();
    expect(relayCalls[0].providerSession).toBeUndefined();
    expect(queries.some((q) => /brain_provider\s*=/.test(q.sql))).toBe(false);
  });
  it("a failed check is a dropped hint, never a refused reply", async () => {
    stored = { ...stored, brainProvider: "hermes" };
    canThrows = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await ask(STAFF);
    warn.mockRestore();
    expect(out.ok).toBe(true);
    expect(relayCalls[0].provider).toBeUndefined();
  });
  it("a thread with no stored provider asks nothing (no extra Cerbos call on an ordinary send), and its tier still goes out", async () => {
    stored = { ...stored, brainTier: "fast" };
    await ask(STAFF);
    expect(canCalls).toHaveLength(0);
    expect(relayCalls[0]).toMatchObject({ tier: "fast" });
    expect(relayCalls[0].provider).toBeUndefined();
  });
  it("the check is asked of the caller the thread route cleared as its owner (the principal in hand)", async () => {
    stored = { ...stored, brainProvider: "openai" };
    await ask(STAFF);
    expect(canCalls.map((c) => c.principal.userId)).toEqual([STAFF]);
  });
});

describe("AIP-08b · GET /assistant/brains", () => {
  it("with the grant: canChooseProvider true and the provider list as the gateway reports it; tiers unchanged", async () => {
    const r = await ctl.brains(reqFor(ADMIN), "t1");
    expect(r.canChooseProvider).toBe(true);
    expect(r.brains).toEqual([{ value: "openai", available: true }, { value: "hermes", available: false }]);
    expect(r.tiers).toEqual(["fast", "standard", "strong"]);
  });
  it("without the grant: canChooseProvider false and brains [] (the list never reaches the browser); tiers unchanged", async () => {
    const r = await ctl.brains(reqFor(STAFF), "t1");
    expect(r.canChooseProvider).toBe(false);
    expect(r.brains).toEqual([]);
    expect(r.tiers).toEqual(["fast", "standard", "strong"]);
    expect(JSON.stringify(r)).not.toContain("openai");
  });
  it("is per caller: each request asks Cerbos for that caller, and one answer never leaks into the next", async () => {
    const a = await ctl.brains(reqFor(ADMIN), "t1");
    const b = await ctl.brains(reqFor(STAFF), "t1");
    const c = await ctl.brains(reqFor(ADMIN), "t1");
    expect([a.canChooseProvider, b.canChooseProvider, c.canChooseProvider]).toEqual([true, false, true]);
    expect(b.brains).toEqual([]);
    expect(c.brains).toHaveLength(2);
    expect(canCalls.map((x) => x.principal.userId)).toEqual([ADMIN, STAFF, ADMIN]);
  });
  it("asks for the route's company", async () => {
    await ctl.brains(reqFor(ADMIN), "t9");
    expect(canCalls[0].resource).toEqual({ id: "t9", tenantId: "t9" });
  });
});

describe("AIP-08b · both relayGeneration call sites use the checked hint", () => {
  it("the stream route and the ask route pass `provider: providerHint`, never the stored column directly", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "assistant.controller.ts"), "utf8");
    expect(src.match(/relayGeneration\(generation, \{/g)).toHaveLength(2);
    expect(src.match(/provider: providerHint,/g)).toHaveLength(2);
    expect(src.match(/allowedProviderHint\(req\.principal, tenantId, thread\.brainProvider\)/g)).toHaveLength(2);
    expect(src).not.toContain("provider: thread.brainProvider");
  });
});
