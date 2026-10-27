// AIP-03b — usage-event.ts: the outcome mapping and the event shape every call site shares. Identical copies live in mcp-hub and wa-chat-bot.
//
// Proves: 429 is blocked_budget, 503 is blocked_dlp, any other failure (other status, or no answer at all) is error, otherwise ok; a failed call
// carries no tokens, cost or provider; the gateway's `usage` gives provider tokens and a provider cost (a reported 0 is kept); a malformed or
// non-provider usage gives 'none'; a label with a space becomes null, never a sentence; the attribution passes through unchanged.
import { describe, it, expect } from "vitest";
import { label, outcomeForStatus, readUsage, usageEvent } from "./usage-event";

const T = "11111111-1111-4111-8111-111111111111";
const U = "22222222-2222-4222-8222-222222222222";
const R = "33333333-3333-4333-8333-333333333333";
const base = { tenantId: T, userId: U, surface: "agent" as const, capability: "llm" as const, task: "statusReporter", runId: R };

describe("AIP-03b · usage-event", () => {
  it("maps the gateway status to an outcome: 429, 503, other, ok", () => {
    expect(usageEvent(base, 429).outcome).toBe("blocked_budget");
    expect(usageEvent(base, 503).outcome).toBe("blocked_dlp");
    expect(usageEvent(base, 500).outcome).toBe("error");
    expect(usageEvent(base, 401).outcome).toBe("error");
    expect(usageEvent(base, null).outcome).toBe("error");
    expect(usageEvent(base, 200, { provider: "openai" }).outcome).toBe("ok");
    expect([429, 503, 500, 404].map(outcomeForStatus)).toEqual(["blocked_budget", "blocked_dlp", "error", "error"]);
  });

  it("a failed call carries no tokens, cost or provider, but keeps its attribution", () => {
    const e = usageEvent(base, 503, { provider: "openai", usage: { promptTokens: 9, completionTokens: 9, costUsd: 1 } });
    expect(e).toMatchObject({ tenantId: T, userId: U, surface: "agent", capability: "llm", task: "statusReporter", runId: R, tokensSource: "none", promptTokens: null, completionTokens: null, costUsd: null, costSource: null, provider: null, outcome: "blocked_dlp" });
  });

  it("reads the gateway's usage: provider tokens and a provider cost; a reported zero cost is kept", () => {
    const e = usageEvent(base, 200, { provider: "openai", usage: { promptTokens: 120, completionTokens: 30, costUsd: 0.0021, source: "provider" } });
    expect(e).toMatchObject({ provider: "openai", tokensSource: "provider", promptTokens: 120, completionTokens: 30, costUsd: 0.0021, costSource: "provider" });
    const zero = usageEvent(base, 200, { usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 } });
    expect(zero).toMatchObject({ costUsd: 0, costSource: "provider" });
    const noCost = usageEvent(base, 200, { usage: { promptTokens: 1, completionTokens: 1 } });
    expect(noCost).toMatchObject({ tokensSource: "provider", costUsd: null, costSource: null });
  });

  it("no usage, or a malformed or non-provider usage, is tokens 'none' (these services estimate nothing)", () => {
    for (const usage of [undefined, null, "x", {}, { promptTokens: "5", completionTokens: 1 }, { promptTokens: -1, completionTokens: 1 }, { promptTokens: 1.5, completionTokens: 1 }, { promptTokens: 1, completionTokens: 1, source: "estimate" }]) {
      expect(usageEvent(base, 200, { usage }), JSON.stringify(usage)).toMatchObject({ tokensSource: "none", promptTokens: null, completionTokens: null, costUsd: null });
    }
    expect(readUsage({ promptTokens: 2147483648, completionTokens: 1 })).toBeNull();
    expect(usageEvent(base, 200).tokensSource).toBe("none");
  });

  it("a label that is not one plain token becomes null, never a sentence", () => {
    expect(label("ollama/kimi-k2.7-code:cloud")).toBe("ollama/kimi-k2.7-code:cloud");
    expect(label("summarise the contract")).toBeNull();
    expect(label("x".repeat(121))).toBeNull();
    expect(label(42)).toBeNull();
    const e = usageEvent({ ...base, task: "has a space" }, 200, { provider: "open ai" });
    expect(e.task).toBeNull();
    expect(e.provider).toBeNull();
  });

  it("absent attribution becomes explicit nulls; a missing tenant stays missing (the reporter drops it)", () => {
    const e = usageEvent({ tenantId: undefined, surface: "knowledge", capability: "embed" }, 200);
    expect(e).toMatchObject({ tenantId: undefined, userId: null, runId: null, task: null, surface: "knowledge", capability: "embed", outcome: "ok", tokensSource: "none" });
  });
});
