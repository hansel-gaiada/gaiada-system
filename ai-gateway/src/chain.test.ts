import { describe, it, expect } from "vitest";
import { Chain } from "./chain";
import { config } from "./config";
import type { Provider } from "./providers";

function fake(name: string, impl: () => Promise<string>, available = true): Provider {
  return { name, available: () => available, complete: impl, media: impl, embed: async () => [0] };
}

describe("capability chain + circuit breaker", () => {
  it("fails over to the next provider on error", async () => {
    const chain = new Chain([
      fake("dead", async () => {
        throw new Error("boom");
      }),
      fake("alive", async () => "answer"),
    ]);
    const { result, provider } = await chain.run((p) => p.complete("x"));
    expect(result).toBe("answer");
    expect(provider).toBe("alive");
  });

  it("skips unconfigured providers", async () => {
    const chain = new Chain([fake("unset", async () => "never", false), fake("alive", async () => "ok")]);
    expect((await chain.run((p) => p.complete("x"))).provider).toBe("alive");
  });

  it("opens the breaker after repeated failures and skips the provider until cooldown", async () => {
    let now = 1_000_000;
    let deadCalls = 0;
    const dead = fake("dead", async () => {
      deadCalls++;
      throw new Error("down");
    });
    const chain = new Chain([dead, fake("alive", async () => "ok")], () => now);

    for (let i = 0; i < config.breakerThreshold; i++) await chain.run((p) => p.complete("x"));
    expect(deadCalls).toBe(config.breakerThreshold);
    expect(chain.state().dead).toBe("open");

    await chain.run((p) => p.complete("x")); // breaker open -> dead not called
    expect(deadCalls).toBe(config.breakerThreshold);

    now += config.breakerCooldownMs + 1; // cooldown elapsed -> probe again
    await chain.run((p) => p.complete("x"));
    expect(deadCalls).toBe(config.breakerThreshold + 1);
  });

  it("throws when every provider fails", async () => {
    const chain = new Chain([
      fake("a", async () => {
        throw new Error("x");
      }),
    ]);
    await expect(chain.run((p) => p.complete("q"))).rejects.toThrow(/all providers failed/);
  });
});
