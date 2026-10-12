// M5-V6-b — the pure half of the recording routes: the collector reads, `from`, the 503 words and the O7 pin. No services needed.
// The DB half (app.inject: view_replay denial with valid ids, 403 vs 404, one activity row per opening, withdrawn visitors) is
// replays.db.test.ts (Linux gate; skipped without DATABASE_URL_TEST, NOT run on the dev laptop).
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  InsightsBadResponseError, InsightsNotConfiguredError, InsightsNotFoundError, InsightsAuthError, InsightsUnreachableError,
  readReplayChunks, readReplaySessions, type InsightsSettings,
} from "./insights-client";
import { REPLAY_WORDS, unavailableFrom } from "./replays.service";
import { REPLAY_FROM_MAX, parseFrom } from "./replays.controller";
import { REPLAY_MCP_TOOLS } from "./replays-mcp-tools";
import { searchModule } from "./index";

const W = "11111111-1111-4111-8111-111111111111";
const V = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const R = "44444444-4444-4444-8444-444444444444";
const S: InsightsSettings = { baseUrl: "http://collector.test", readKey: "rk-read", forgetKey: "fk-forget", timeoutMs: 1000 };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const session = (o: Record<string, unknown> = {}) => ({
  id: R, consentId: C, startedAt: "2026-10-12T10:00:00Z", lastChunkAt: "2026-10-12T10:03:00Z", durationSeconds: 180, chunks: 18, bytes: 4096, pages: ["https://x.example/a"], ...o,
});

describe("readReplaySessions", () => {
  it("asks the sessions route with the READ key, lower-cased ids and a clamped limit; keeps metadata, drops bytes", async () => {
    let seen: { url: string; auth: string } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, auth: (init.headers as Record<string, string>).Authorization };
      return reply(200, { website: W, visitorId: V, sessions: [session()] });
    }) as unknown as typeof fetch;
    const out = await readReplaySessions(W.toUpperCase(), V.toUpperCase(), 9999, { settings: S, fetchImpl });
    const u = new URL(seen!.url);
    expect(u.pathname).toBe("/ops/v1/replay/sessions");
    expect(Object.fromEntries(u.searchParams)).toEqual({ website: W, visitorId: V, limit: "200" });
    expect(seen!.auth).toBe("Bearer rk-read");
    expect(out).toEqual([{ id: R, consentId: C, startedAt: "2026-10-12T10:00:00Z", lastChunkAt: "2026-10-12T10:03:00Z", durationSeconds: 180, chunks: 18, pages: ["https://x.example/a"] }]);
    expect(JSON.stringify(out)).not.toContain("bytes");
  });
  it("an empty answer is an empty list (a real answer), a malformed row is a typed error, never a silent drop", async () => {
    const f = (body: unknown) => (async () => reply(200, body)) as unknown as typeof fetch;
    expect(await readReplaySessions(W, V, 10, { settings: S, fetchImpl: f({ sessions: [] }) })).toEqual([]);
    await expect(readReplaySessions(W, V, 10, { settings: S, fetchImpl: f({ sessions: [{ id: "nope" }] }) })).rejects.toBeInstanceOf(InsightsBadResponseError);
    await expect(readReplaySessions(W, V, 10, { settings: S, fetchImpl: f({}) })).rejects.toBeInstanceOf(InsightsBadResponseError);
  });
  it("not configured, a refused key, a 404 and a dead collector are four different typed errors", async () => {
    await expect(readReplaySessions(W, V, 10, { settings: null })).rejects.toBeInstanceOf(InsightsNotConfiguredError);
    const st = (n: number) => (async () => reply(n, {})) as unknown as typeof fetch;
    await expect(readReplaySessions(W, V, 10, { settings: S, fetchImpl: st(403) })).rejects.toBeInstanceOf(InsightsAuthError);
    await expect(readReplaySessions(W, V, 10, { settings: S, fetchImpl: st(404) })).rejects.toBeInstanceOf(InsightsNotFoundError);
    await expect(readReplaySessions(W, V, 10, { settings: S, fetchImpl: st(503) })).rejects.toBeInstanceOf(InsightsUnreachableError);
    await expect(readReplaySessions(W, V, 10, { settings: S, fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch }))
      .rejects.toBeInstanceOf(InsightsUnreachableError);
  });
  it("refuses a non-uuid id before any request is made", async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return reply(200, {}); }) as unknown as typeof fetch;
    await expect(readReplaySessions("x", V, 10, { settings: S, fetchImpl })).rejects.toBeInstanceOf(InsightsBadResponseError);
    await expect(readReplaySessions(W, "../etc", 10, { settings: S, fetchImpl })).rejects.toBeInstanceOf(InsightsBadResponseError);
    expect(called).toBe(false);
  });
});

describe("readReplayChunks", () => {
  const page = (o: Record<string, unknown> = {}) => ({
    website: W, recording: R, visitorId: V, consentId: C,
    chunks: [{ seq: 0, receivedAt: "t0", bytes: 10, events: [{ type: 4 }] }, { seq: 1, receivedAt: "t1", bytes: 11, events: [] }], next: 1, more: true, ...o,
  });
  it("asks the chunks route with `after` and a clamped limit and returns the attribution with the content", async () => {
    let url = "";
    const fetchImpl = (async (u: string) => { url = u; return reply(200, page()); }) as unknown as typeof fetch;
    const out = await readReplayChunks(W, R, -1, 500, { settings: S, fetchImpl });
    expect(Object.fromEntries(new URL(url).searchParams)).toEqual({ website: W, recording: R, after: "-1", limit: "50" });
    expect(out).toMatchObject({ recordingId: R, visitorId: V, consentId: C, next: 1, more: true });
    expect(out.chunks.map((c) => c.seq)).toEqual([0, 1]);
    expect(out.chunks[0]!.events).toEqual([{ type: 4 }]);
  });
  it("an unknown recording is the typed not-found error", async () => {
    await expect(readReplayChunks(W, R, -1, 20, { settings: S, fetchImpl: (async () => reply(404, { error: "unknown-recording" })) as unknown as typeof fetch }))
      .rejects.toBeInstanceOf(InsightsNotFoundError);
  });
  it.each([
    ["no attribution", { visitorId: undefined }],
    ["seq out of order", { chunks: [{ seq: 1, events: [] }, { seq: 1, events: [] }] }],
    ["seq at or before `after`", { chunks: [{ seq: 0, events: [] }] }],
    ["events not an array", { chunks: [{ seq: 5, events: "x" }] }],
    ["more with no chunk", { chunks: [], more: true }],
    ["more not a boolean", { more: "yes" }],
    ["next behind the page", { next: 0 }],
  ])("a body the contract does not describe is a typed error: %s", async (_n, over) => {
    const after = _n === "seq at or before `after`" ? 0 : -1;
    const fetchImpl = (async () => reply(200, page(over))) as unknown as typeof fetch;
    await expect(readReplayChunks(W, R, after, 20, { settings: S, fetchImpl })).rejects.toBeInstanceOf(InsightsBadResponseError);
  });
});

describe("parseFrom", () => {
  it("absent or empty is 0; whole numbers up to the collector's 1000 chunks are kept", () => {
    expect(parseFrom(undefined)).toBe(0);
    expect(parseFrom("")).toBe(0);
    expect(parseFrom("0")).toBe(0);
    expect(parseFrom("20")).toBe(20);
    expect(parseFrom(String(REPLAY_FROM_MAX))).toBe(REPLAY_FROM_MAX);
  });
  it.each(["-1", "1.5", "abc", "1000", "1e2", "0x10", " 5"])("%s is refused with a reason", (raw) => {
    try { parseFrom(raw); throw new Error("no-throw"); } catch (e) { expect((e as { reason?: string }).reason).toBe("from_invalid"); }
  });
});

describe("the 503 in words", () => {
  it("every collector failure becomes a typed reason with its own sentence, none empty", () => {
    expect(unavailableFrom(new InsightsNotConfiguredError()).reason).toBe("not_configured");
    expect(unavailableFrom(new InsightsUnreachableError("x")).reason).toBe("collector_unreachable");
    expect(unavailableFrom(new InsightsBadResponseError("x")).reason).toBe("collector_unreachable");
    expect(unavailableFrom(new InsightsAuthError(403)).reason).toBe("collector_rejected");
    expect(unavailableFrom(new InsightsNotFoundError()).reason).toBe("collector_rejected");
    for (const w of Object.values(REPLAY_WORDS)) expect(w.length).toBeGreaterThan(40);
    expect(REPLAY_WORDS.collector_unreachable).toMatch(/not an empty list/);
  });
});

// ── O7: in v1 no MCP tool returns recording content ────────────────────────────────────────────────────────────────
describe("O7: no MCP tool returns recording content", () => {
  const tools = searchModule.mcpTools ?? [];
  it("exactly one tool touches recordings: search.replays.list, a GET read, metadata only", () => {
    const touching = tools.filter((t) => /recording|replay|chunk/i.test(`${t.name} ${t.pathTemplate ?? ""}`));
    expect(touching.map((t) => t.name)).toEqual(["search.replays.list"]);
    const t = touching[0]!;
    expect(t.method).toBe("GET");
    expect(t.write).toBeFalsy();
    expect(t.impact).toBeUndefined();
    expect(t.pathTemplate).toBe("/api/:tenantId/modules/search/properties/:propertyId/visitors/:visitorId/recordings");
    expect(REPLAY_MCP_TOOLS.map((x) => x.name)).toEqual(["search.replays.list"]);
  });
  it("no search tool path reaches the chunk route or a download, and none is a write toward a recording", () => {
    for (const t of tools) {
      expect(t.pathTemplate ?? "", t.name).not.toMatch(/\/chunks|\/download|\/recordings\/:/);
    }
  });
  it("no source file of the search module except the controller names the chunk route (so no tool def can bind it)", () => {
    const dir = __dirname;
    const hits = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "replays.controller.ts")
      .filter((f) => /recordings\/:recordingId\/chunks|recordings\/:\w+\/chunks/.test(readFileSync(join(dir, f), "utf8")));
    expect(hits).toEqual([]);
  });
});
