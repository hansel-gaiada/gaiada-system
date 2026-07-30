// SM-09 — gateway-client tests. No real network: `fetchImpl` is injected (same pattern as
// providers/dataforseo.test.ts's mockServer). The load-bearing assertion per the ticket's
// non-negotiable AI-access rule (design §01): every call this file makes targets the ONE configured
// gateway URL — proving ai-gateway-go is the sole egress path for embeddings/completions, never a
// vendor SDK or a second host.
import { describe, it, expect } from "vitest";
import {
  embedViaGateway,
  completeViaGateway,
  GatewayNotConfiguredError,
} from "./gateway-client";

function mockServer(handler: (path: string, body: unknown) => unknown | { status: number }) {
  const calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const full = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: full, method: init?.method ?? "GET", body, headers: (init?.headers ?? {}) as Record<string, string> });
    const path = full.replace(/^https?:\/\/[^/]+/, "");
    const result = handler(path, body) as Record<string, unknown> & { status?: number };
    if (result && typeof result === "object" && "status" in result && typeof result.status === "number" && result.status >= 400) {
      return { ok: false, status: result.status, json: async () => ({}) } as Response;
    }
    return { ok: true, status: 200, json: async () => result } as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const GW = "https://gateway.test";

describe("embedViaGateway", () => {
  it("posts to exactly {gatewayUrl}/embed with a Bearer token and returns the embedding", async () => {
    const { calls, fetchImpl } = mockServer(() => ({ embedding: [0.1, 0.2, 0.3] }));
    const vec = await embedViaGateway("running shoes", { gatewayUrl: GW, gatewayToken: "tok-123", fetchImpl });
    expect(vec).toEqual([0.1, 0.2, 0.3]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${GW}/embed`);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ text: "running shoes" });
    expect(calls[0].headers.Authorization).toBe("Bearer tok-123");
  });

  it("throws (never falls back to a direct call) when the gateway is not configured", async () => {
    const { calls, fetchImpl } = mockServer(() => ({ embedding: [1] }));
    await expect(embedViaGateway("x", { gatewayUrl: "", gatewayToken: "", fetchImpl })).rejects.toThrow(GatewayNotConfiguredError);
    expect(calls).toHaveLength(0); // no egress attempted at all
  });

  it("propagates a gateway HTTP error", async () => {
    const { fetchImpl } = mockServer(() => ({ status: 503 }));
    await expect(embedViaGateway("x", { gatewayUrl: GW, gatewayToken: "t", fetchImpl })).rejects.toThrow(/HTTP 503/);
  });
});

describe("completeViaGateway", () => {
  it("posts to exactly {gatewayUrl}/complete and returns text + served provider", async () => {
    const { calls, fetchImpl } = mockServer(() => ({ text: "a cluster label", provider: "ollama" }));
    const res = await completeViaGateway("label this cluster", { gatewayUrl: GW, gatewayToken: "tok-123", fetchImpl });
    expect(res).toEqual({ text: "a cluster label", provider: "ollama" });
    expect(calls[0].url).toBe(`${GW}/complete`);
    expect(calls[0].body).toEqual({ prompt: "label this cluster" });
  });
});

describe("ai-gateway-go is the ONLY egress path (design §01 non-negotiable)", () => {
  it("every embed + complete call in a mixed batch targets the same single configured host", async () => {
    const { calls, fetchImpl } = mockServer((path) =>
      path === "/embed" ? { embedding: [1, 2] } : { text: "ok", provider: "ollama" },
    );
    await embedViaGateway("a", { gatewayUrl: GW, gatewayToken: "t", fetchImpl });
    await completeViaGateway("b", { gatewayUrl: GW, gatewayToken: "t", fetchImpl });
    await embedViaGateway("c", { gatewayUrl: GW, gatewayToken: "t", fetchImpl });
    expect(calls).toHaveLength(3);
    const hosts = new Set(calls.map((c) => new URL(c.url).origin));
    expect(hosts.size).toBe(1);
    expect([...hosts][0]).toBe(GW);
  });
});
