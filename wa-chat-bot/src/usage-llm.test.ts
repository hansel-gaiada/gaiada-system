// AIP-03b — the bot's gateway call sites (llm.ts), driven with a stubbed `fetch` and a spy on the reporter. Proves what the bot knows at the call
// and what it sends: surface bot, the bot's company, NO person, task bot.complete / bot.media, the gateway's usage and cost, the outcome mapping
// (429 blocked_budget, 503 blocked_dlp, other failures and an unreachable gateway error), that the bot's own return values are unchanged, and that
// no prompt or answer text reaches the event.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { config } from "./config";
import { botTenantId, complete, describeMedia } from "./llm";
import { usageReporter, type UsageEvent } from "./usage-reporter";

const T = "11111111-1111-4111-8111-111111111111";
const T2 = "55555555-5555-4555-8555-555555555555";

let reported: UsageEvent[];
const saved = { d: config.defaultTenantId, t: config.tenantId };
beforeEach(() => {
  reported = [];
  config.defaultTenantId = T;
  config.tenantId = "trial";
  vi.spyOn(usageReporter, "report").mockImplementation((e) => { reported.push(e); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); config.defaultTenantId = saved.d; config.tenantId = saved.t; });

const gateway = (status: number, body: unknown, text = "") => vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => text })));

describe("AIP-03b · the bot's /complete", () => {
  it("reports a bot event under the bot's company, with no person, and the gateway's usage and cost", async () => {
    gateway(200, { text: "the digest", provider: "openai", usage: { promptTokens: 900, completionTokens: 120, costUsd: 0.004, source: "provider" } });
    expect(await complete("summarise the chat SECRET-CHAT-TEXT")).toBe("the digest");
    expect(reported).toEqual([{
      tenantId: T, userId: null, surface: "bot", capability: "llm", task: "bot.complete", runId: null, provider: "openai", model: null, tier: null,
      promptTokens: 900, completionTokens: 120, tokensSource: "provider", costUsd: 0.004, costSource: "provider", outcome: "ok",
    }]);
    expect(JSON.stringify(reported)).not.toMatch(/SECRET|digest/);
  });

  it("AIP-07: /complete carries task chat, /media carries no task, and the answer's tier is reported (an invalid one is dropped)", async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ text: "hi", provider: "openai", tier: "fast" }), text: async () => "" }));
    vi.stubGlobal("fetch", f);
    await complete("p");
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ prompt: "p", task: "chat" });
    expect(reported[0].tier).toBe("fast");
    gateway(200, { text: "hi", provider: "openai", tier: "turbo" });
    await complete("p");
    expect(reported[1].tier).toBeNull();
    const m = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ text: "seen", provider: "openai" }), text: async () => "" }));
    vi.stubGlobal("fetch", m);
    await describeMedia(Buffer.from("x"), "image/png");
    expect("task" in JSON.parse(String((m.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toBe(false);
  });

  it("an answer with no usage is tokens 'none' and ok", async () => {
    gateway(200, { text: "hi", provider: "echo" });
    await complete("p");
    expect(reported[0]).toMatchObject({ outcome: "ok", tokensSource: "none", promptTokens: null, completionTokens: null, costUsd: null });
  });

  it("maps 429 to blocked_budget, 503 to blocked_dlp, any other failure to error, and still returns the bot's placeholder text", async () => {
    for (const [status, outcome] of [[429, "blocked_budget"], [503, "blocked_dlp"], [500, "error"], [401, "error"]] as const) {
      reported.length = 0;
      gateway(status, {}, "gateway said no");
      expect(await complete("p")).toBe(`[Gateway ${status}: gateway said no]`);
      expect(reported).toHaveLength(1);
      expect(reported[0], String(status)).toMatchObject({ outcome, tokensSource: "none", promptTokens: null, costUsd: null, provider: null, userId: null, tenantId: T });
    }
  });

  it("an unreachable gateway is an error row, and the bot still gets its placeholder text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await complete("p")).toMatch(/^\[Gateway unreachable: ECONNREFUSED/);
    expect(reported[0]).toMatchObject({ outcome: "error", tokensSource: "none", surface: "bot" });
  });
});

describe("AIP-03b · the bot's /media", () => {
  it("is capability media, task bot.media, with no bytes in the event", async () => {
    gateway(200, { text: "a transcript", provider: "openai" });
    expect(await describeMedia(Buffer.from("SECRET-AUDIO-BYTES"), "audio/ogg")).toBe("a transcript");
    expect(reported[0]).toMatchObject({ capability: "media", task: "bot.media", surface: "bot", userId: null, tenantId: T, outcome: "ok" });
    expect(JSON.stringify(reported)).not.toMatch(/SECRET|transcript/);
  });

  it("a failure still throws as before, and is recorded with the matching outcome", async () => {
    for (const [status, outcome] of [[429, "blocked_budget"], [503, "blocked_dlp"], [502, "error"]] as const) {
      reported.length = 0;
      gateway(status, {});
      await expect(describeMedia(Buffer.from("x"), "image/png")).rejects.toThrow(`gateway /media ${status}`);
      expect(reported[0].outcome, String(status)).toBe(outcome);
    }
    reported.length = 0;
    gateway(200, { text: "" });
    await expect(describeMedia(Buffer.from("x"), "image/png")).rejects.toThrow(/returned no text/);
  });
});

describe("AIP-03b · botTenantId: where the bot knows its company", () => {
  it("is DEFAULT_TENANT_ID, else TENANT_ID when that is a uuid, else null (the default `trial` is not a company)", () => {
    expect(botTenantId()).toBe(T);
    config.defaultTenantId = "";
    expect(botTenantId()).toBeNull();
    config.tenantId = T2;
    expect(botTenantId()).toBe(T2);
  });

  it("with no company the event carries none (the reporter then writes nothing, and says so once)", async () => {
    config.defaultTenantId = "";
    gateway(200, { text: "x" });
    await complete("p");
    expect(reported[0].tenantId).toBeNull();
  });
});
