// AIP-08a — the thread's brain TIER: POST/PATCH validation, mutual clearing with brain_provider, the ASST-16 session reset, the
// `/complete/stream` body, the `tiers` list of GET assistant/brains, and the migration's own text. No database: the controller runs
// against a recording fake of `withTenants`. The live half (the CHECKs on a real table) is in assistant.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

const queries: Array<{ sql: string; params: unknown[] }> = [];
let stored: Record<string, unknown> = {};

vi.mock("../../db", () => ({
  newId: () => "new-thread-id",
  withTenants: async (_t: string[], fn: (c: unknown) => unknown) =>
    fn({
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (/^\s*SELECT/i.test(sql)) return { rows: [stored], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
    }),
}));
vi.mock("../../core/http", () => ({ authorize: async () => undefined }));

import { AssistantController } from "./assistant.controller";
import { relayGeneration, reserveGeneration } from "./stream";
import { mapHealthToTiers, getBrains, resetBrainsCache } from "./brains";

const ctl = new AssistantController();
const req = { principal: { userId: "u1" } } as never;
const patch = (body: Record<string, unknown>) => ctl.patchThread(req, "t1", "th1", body as never);
const create = (body: Record<string, unknown>) => ctl.createThread(req, "t1", body as never);
const isUpdate = (q: { sql: string }) => /^\s*UPDATE/i.test(q.sql);
const lastWrite = () => queries.filter((q) => /^\s*(UPDATE|INSERT)/i.test(q.sql)).at(-1)!;

beforeEach(() => {
  queries.length = 0;
  stored = { id: "th1", ownerUserId: "u1", brainProvider: null, brainTier: null, hermesSessionId: null };
});

describe("AIP-08a · POST /assistant/threads", () => {
  it("stores a valid tier and no provider", async () => {
    await create({ brainTier: "strong" });
    const w = lastWrite();
    expect(w.sql).toContain("brain_tier");
    expect(w.params.slice(4, 6)).toEqual([null, "strong"]);
  });
  it("no brainTier key stores NULL", async () => {
    await create({ brainProvider: "openai" });
    expect(lastWrite().params.slice(4, 6)).toEqual(["openai", null]);
  });
  it.each(["turbo", "Fast", "", 3, {}, true])("rejects brainTier %j with 400", async (bad) => {
    await expect(create({ brainTier: bad })).rejects.toMatchObject({ status: 400 });
    expect(queries).toHaveLength(0);
  });
  it("a tier together with a provider is 400 brain_conflict", async () => {
    await expect(create({ brainTier: "fast", brainProvider: "openai" })).rejects.toThrow(/brain_conflict/);
    expect(queries).toHaveLength(0);
  });
  it("a tier with a blank provider string is not a conflict", async () => {
    await create({ brainTier: "fast", brainProvider: "  " });
    expect(lastWrite().params.slice(4, 6)).toEqual([null, "fast"]);
  });
});

describe("AIP-08a · PATCH /assistant/threads/:id", () => {
  it.each(["turbo", "Fast", "", 3, {}, false])("rejects brainTier %j with 400 and writes nothing", async (bad) => {
    await expect(patch({ brainTier: bad })).rejects.toMatchObject({ status: 400 });
    expect(queries.some(isUpdate)).toBe(false);
  });
  it("a tier together with a non-null provider is 400 brain_conflict", async () => {
    await expect(patch({ brainTier: "fast", brainProvider: "openai" })).rejects.toThrow(/brain_conflict/);
    expect(queries.some(isUpdate)).toBe(false);
  });
  it("a non-null tier clears the provider in the same UPDATE and leaves brain_model alone", async () => {
    await patch({ brainTier: "fast" });
    const w = lastWrite();
    expect(w.sql).toContain("brain_tier = $2");
    expect(w.sql).toContain("brain_provider = NULL");
    expect(w.sql).not.toContain("brain_model");
    expect(w.params).toEqual(["th1", "fast"]);
  });
  it("each of the three tiers is accepted", async () => {
    for (const t of ["fast", "standard", "strong"]) {
      queries.length = 0;
      await patch({ brainTier: t });
      expect(lastWrite().params).toEqual(["th1", t]);
    }
  });
  it("a non-null provider clears the tier in the same UPDATE", async () => {
    await patch({ brainProvider: "openai" });
    const w = lastWrite();
    expect(w.sql).toContain("brain_provider = $2");
    expect(w.sql).toContain("brain_tier = NULL");
  });
  it("brainTier null touches only brain_tier", async () => {
    stored = { ...stored, brainTier: "fast" };
    await patch({ brainTier: null });
    const w = lastWrite();
    expect(w.sql).toContain("brain_tier = $2");
    expect(w.sql).not.toContain("brain_provider");
    expect(w.sql).not.toContain("hermes_session_id");
  });
  it("brainProvider null touches only brain_provider (and the session reset), never the tier", async () => {
    stored = { ...stored, brainProvider: "hermes", hermesSessionId: "s1" };
    await patch({ brainProvider: null });
    const w = lastWrite();
    expect(w.sql).not.toContain("brain_tier");
    expect(w.sql).toContain("hermes_session_id = NULL");
  });
  it("Auto (both null) after a provider resets the session and assigns each column once", async () => {
    stored = { ...stored, brainProvider: "hermes", hermesSessionId: "s1" };
    await patch({ brainProvider: null, brainTier: null });
    const w = lastWrite();
    expect(w.sql.match(/brain_provider =/g)).toHaveLength(1);
    expect(w.sql.match(/brain_tier =/g)).toHaveLength(1);
    expect(w.sql).toContain("hermes_session_id = NULL");
  });
  it("provider -> tier resets hermes_session_id", async () => {
    stored = { ...stored, brainProvider: "hermes", hermesSessionId: "s1" };
    await patch({ brainTier: "strong" });
    expect(lastWrite().sql).toContain("hermes_session_id = NULL");
  });
  it("tier -> tier (no stored provider) leaves the session alone", async () => {
    stored = { ...stored, brainTier: "fast" };
    await patch({ brainTier: "strong" });
    expect(lastWrite().sql).not.toContain("hermes_session_id");
  });
  it("brainTier null together with a provider is allowed and assigns each column once", async () => {
    await patch({ brainTier: null, brainProvider: "openai" });
    const w = lastWrite();
    expect(w.sql.match(/brain_tier =/g)).toHaveLength(1);
    expect(w.sql.match(/brain_provider =/g)).toHaveLength(1);
  });
  it("brainProvider null with a tier assigns each column once", async () => {
    stored = { ...stored, brainProvider: "hermes", hermesSessionId: "s1" };
    await patch({ brainProvider: null, brainTier: "fast" });
    const w = lastWrite();
    expect(w.sql.match(/brain_provider =/g)).toHaveLength(1);
    expect(w.sql.match(/hermes_session_id =/g)).toHaveLength(1);
  });
});

describe("AIP-08a · relayGeneration sends tier only when set", () => {
  async function bodyFor(extra: Record<string, unknown>) {
    let sent: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_u: unknown, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return new Response("event: done\ndata: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const entry = reserveGeneration(`th-${Math.random()}`, "m1");
    await relayGeneration(entry as never, {
      tenantId: "t1", prompt: "hi", gatewayUrl: "http://gw", gatewayToken: "tok", fetchImpl,
      attribution: { tenantId: "t1", userId: "u1", surface: "assistant", threadId: "th", task: "assistant.reply" },
      emit: { token() {}, meta() {}, session() {}, usage() {}, done() {}, error() {} },
      ...extra,
    } as never);
    return sent;
  }
  it.each(["fast", "standard", "strong"])("sends tier %s", async (tier) => {
    expect((await bodyFor({ tier })).tier).toBe(tier);
  });
  it("an Auto thread body has no tier key at all", async () => {
    const withUndefined = await bodyFor({ tier: undefined });
    const without = await bodyFor({});
    expect(Object.keys(withUndefined)).not.toContain("tier");
    expect(JSON.stringify(withUndefined)).toBe(JSON.stringify(without));
  });
  it("a value outside the three tiers is never sent", async () => {
    expect(Object.keys(await bodyFor({ tier: "turbo" }))).not.toContain("tier");
  });
});

describe("AIP-08a · mapHealthToTiers / getBrains tiers", () => {
  const llm = { providers: { llm: { openai: "ok" } } };
  beforeEach(() => resetBrainsCache());
  it("lists the reported names", () => {
    expect(mapHealthToTiers({ ...llm, tiers: ["fast", "standard", "strong"] })).toEqual(["fast", "standard", "strong"]);
  });
  it("an absent key is none configured", () => {
    expect(mapHealthToTiers(llm)).toEqual([]);
  });
  it("invalid names are dropped, and a non-array is none", () => {
    expect(mapHealthToTiers({ tiers: ["strong", "turbo", 3, null, "fast"] })).toEqual(["fast", "strong"]);
    expect(mapHealthToTiers({ tiers: "fast" })).toEqual([]);
  });
  it("an unreadable body is null", () => {
    expect(mapHealthToTiers(null)).toBeNull();
    expect(mapHealthToTiers("x")).toBeNull();
  });
  const ok = (body: unknown, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const base = { gatewayUrl: "http://gw", gatewayToken: "t", warn: () => {} };
  it("getBrains carries tiers, and forwards nothing else from /health", async () => {
    const r = await getBrains({ ...base, fetchImpl: ok({ ...llm, tiers: ["fast", "strong"], model: "secret-model" }) });
    expect(r.tiers).toEqual(["fast", "strong"]);
    expect(Object.keys(r).sort()).toEqual(["brains", "checkedAt", "tiers"]);
    expect(JSON.stringify(r)).not.toContain("secret-model");
  });
  it("no tiers key gives [], and an unreadable /health gives null", async () => {
    expect((await getBrains({ ...base, fetchImpl: ok(llm) })).tiers).toEqual([]);
    resetBrainsCache();
    expect((await getBrains({ ...base, fetchImpl: ok({}, 503) })).tiers).toBeNull();
    resetBrainsCache();
    expect((await getBrains({ ...base, fetchImpl: ok({ tiers: ["fast"] }) })).tiers).toBeNull();
    resetBrainsCache();
    expect((await getBrains({ ...base, gatewayUrl: "" })).tiers).toBeNull();
  });
});

describe("AIP-08a · the migration file", () => {
  const sql = readFileSync(join(__dirname, "..", "..", "..", "migrations", "202610281200_assistant_thread_brain_tier.sql"), "utf8");
  const code = sql.split("\n").map((l) => (l.includes("--") ? l.slice(0, l.indexOf("--")) : l)).join("\n");
  it("adds brain_tier text NULL with no default", () => {
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS brain_tier text;/);
  });
  it("carries the tier vocabulary CHECK", () => {
    expect(code).toContain("CHECK (brain_tier IS NULL OR brain_tier IN ('fast', 'standard', 'strong'))");
  });
  it("carries the one-choice CHECK", () => {
    expect(code).toContain("CHECK (brain_tier IS NULL OR brain_provider IS NULL)");
  });
  it("is LF only, with no backfill or grant", () => {
    expect(sql).not.toMatch(/\r/);
    expect(code).not.toMatch(/^\s*(UPDATE|INSERT|DELETE|GRANT)\b/im);
  });
});
