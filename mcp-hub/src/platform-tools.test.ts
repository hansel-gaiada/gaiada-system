// The knowledge-service-wrapping hub tools: knowledge.graph (read) and agent.feedback (WS8 trainer
// signal). Both forward the caller's OBO envelope so the knowledge service applies D9 downstream.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerPlatformTools } from "./platform-tools";
import { getTool, resetRegistry } from "./registry";
import { mintPrincipal } from "./principal";

const principal = mintPrincipal({ provider: "telegram", externalId: "tg:555" });

function mockFetch(status: number, json: unknown) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => json })) as unknown as typeof fetch;
}

describe("knowledge-wrapping hub tools", () => {
  beforeEach(() => {
    resetRegistry();
    registerPlatformTools();
  });
  afterEach(() => vi.restoreAllMocks());

  it("knowledge.graph forwards the OBO envelope to /graph/neighbors and returns nodes", async () => {
    const spy = mockFetch(200, { nodes: [{ entityKey: "project:web" }] });
    vi.stubGlobal("fetch", spy);
    const out = await getTool("knowledge.graph")!.handler({ startKey: "client:acme", scope: "public" }, principal);
    expect(JSON.parse(out)).toEqual([{ entityKey: "project:web" }]);
    const [url, init] = (spy as any).mock.calls[0];
    expect(url).toContain("/graph/neighbors");
    expect((init.headers as Record<string, string>)["x-obo-external-id"]).toBe("tg:555");
  });

  it("agent.feedback is a LOW write that forwards runId+rating with the OBO envelope", async () => {
    const t = getTool("agent.feedback")!;
    expect(t.write).toBe(true);
    expect(t.impact).toBe("low");
    const spy = mockFetch(200, { ok: true, trust: "trusted" });
    vi.stubGlobal("fetch", spy);
    const out = await t.handler({ runId: "eval:run-1", rating: "up", note: "good" }, principal);
    expect(JSON.parse(out)).toMatchObject({ trust: "trusted" });
    const [url, init] = (spy as any).mock.calls[0];
    expect(url).toContain("/feedback");
    expect(JSON.parse(init.body)).toMatchObject({ runId: "eval:run-1", rating: "up" });
    expect((init.headers as Record<string, string>)["x-obo-provider"]).toBe("telegram");
  });
});
