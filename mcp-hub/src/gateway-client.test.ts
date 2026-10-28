import { describe, it, expect, afterEach, vi } from "vitest";
import { gatewayComplete } from "./gateway-client";

// M6-P4n: an empty generation, or the gateway's echo fallback, is a failure (never a stored artifact).
function gatewayAnswers(text: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ text, provider: "x" }) })));
}

describe("gatewayComplete refuses a non-generation (M6-P4n)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("passes a real answer through unchanged", async () => {
    gatewayAnswers("  # Prototype\nscreens...\n");
    await expect(gatewayComplete("p")).resolves.toBe("  # Prototype\nscreens...\n");
  });

  it("throws on an empty answer", async () => {
    gatewayAnswers("");
    await expect(gatewayComplete("p")).rejects.toThrow(/returned no text/);
  });

  it("throws on a whitespace-only answer", async () => {
    gatewayAnswers("  \n\t ");
    await expect(gatewayComplete("p")).rejects.toThrow(/returned no text/);
  });

  it("throws on the gateway's echo fallback", async () => {
    gatewayAnswers("[echo — no provider key configured] You are a senior product designer. From the PRD below");
    await expect(gatewayComplete("p")).rejects.toThrow(/echo fallback/);
  });

  it("a text that merely mentions echo mid-way is not refused", async () => {
    gatewayAnswers("The server should [echo — no provider key configured] nothing back.");
    await expect(gatewayComplete("p")).resolves.toContain("The server");
  });
});

describe("AIP-07 · the routing class and the tier", () => {
  afterEach(() => vi.unstubAllGlobals());
  const sent = (f: ReturnType<typeof vi.fn>) => JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));
  it("sends the caller's task, and no task key when it names none", async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ text: "real", provider: "x" }) }));
    vi.stubGlobal("fetch", f);
    await gatewayComplete("p", "summarise");
    expect(sent(f)).toEqual({ prompt: "p", task: "summarise" });
    f.mockClear();
    await gatewayComplete("p");
    expect(sent(f)).toEqual({ prompt: "p" });
  });
});
