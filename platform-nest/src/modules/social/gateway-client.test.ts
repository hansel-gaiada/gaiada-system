// SMM-19 — gateway-client tests. No real network: `fetchImpl` is injected (same pattern as
// search/providers/gateway-client.test.ts). The load-bearing assertion per the ticket's
// non-negotiable rule (root CLAUDE.md: "Only the Gateway holds provider keys"): every call this
// file makes targets the ONE configured gateway URL — never a vendor SDK, never a second host —
// and the cloudPolish provider hint is a pure reorder, never a vendor credential of its own.
import { describe, it, expect } from "vitest";
import { completeViaGateway, GatewayNotConfiguredError } from "./gateway-client";

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

describe("completeViaGateway (SMM-19)", () => {
  it("posts to exactly {gatewayUrl}/complete with a Bearer token, no provider hint by default", async () => {
    const { calls, fetchImpl } = mockServer(() => ({ text: "a caption draft", provider: "hermes" }));
    const res = await completeViaGateway("draft a caption", { gatewayUrl: GW, gatewayToken: "tok-123", fetchImpl });
    expect(res).toEqual({ text: "a caption draft", provider: "hermes" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${GW}/complete`);
    expect(calls[0].method).toBe("POST");
    // No `provider` key at all when cloudPolish is off — never a silent default vendor preference.
    expect(calls[0].body).toEqual({ prompt: "draft a caption" });
    expect(calls[0].headers.Authorization).toBe("Bearer tok-123");
  });

  it("passes the cloudPolish provider hint as a PURE reorder, still the same one host", async () => {
    const { calls, fetchImpl } = mockServer(() => ({ text: "a polished caption", provider: "claude" }));
    const res = await completeViaGateway("draft a caption", { gatewayUrl: GW, gatewayToken: "tok-123", fetchImpl, provider: "claude" });
    expect(res.provider).toBe("claude");
    expect(calls[0].body).toEqual({ prompt: "draft a caption", provider: "claude" });
    expect(calls[0].url).toBe(`${GW}/complete`); // same endpoint, same host — a hint, not a second path
  });

  it("throws (never falls back to a direct vendor call) when the gateway is not configured", async () => {
    const { calls, fetchImpl } = mockServer(() => ({ text: "x" }));
    await expect(completeViaGateway("x", { gatewayUrl: "", gatewayToken: "", fetchImpl })).rejects.toThrow(GatewayNotConfiguredError);
    expect(calls).toHaveLength(0); // no egress attempted at all — not even to try a fallback
  });

  it("propagates a gateway HTTP error rather than silently degrading to a vendor call", async () => {
    const { fetchImpl } = mockServer(() => ({ status: 503 }));
    await expect(completeViaGateway("x", { gatewayUrl: GW, gatewayToken: "t", fetchImpl })).rejects.toThrow(/HTTP 503/);
  });

  it("every call in a mixed batch (default + cloudPolish hint) targets the SAME single configured host", async () => {
    const { calls, fetchImpl } = mockServer(() => ({ text: "ok", provider: "hermes" }));
    await completeViaGateway("a", { gatewayUrl: GW, gatewayToken: "t", fetchImpl });
    await completeViaGateway("b", { gatewayUrl: GW, gatewayToken: "t", fetchImpl, provider: "claude" });
    await completeViaGateway("c", { gatewayUrl: GW, gatewayToken: "t", fetchImpl });
    expect(calls).toHaveLength(3);
    const hosts = new Set(calls.map((c) => new URL(c.url).origin));
    expect(hosts.size).toBe(1);
    expect([...hosts][0]).toBe(GW);
  });
});
