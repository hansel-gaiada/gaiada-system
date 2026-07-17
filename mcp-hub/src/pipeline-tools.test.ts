import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerPipelineTools } from "./pipeline-tools";
import { getTool, resetRegistry } from "./registry";
import { mintPrincipal } from "./principal";
import { AUTOMATION_ALLOWLIST } from "./automation-policy";

const principal = mintPrincipal({ provider: "n8n", externalId: "wf:mtg-dispatcher" });

function mockFetch(status: number, json: unknown) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => json })) as unknown as typeof fetch;
}

describe("WS11 pipeline hub tools", () => {
  beforeEach(() => {
    resetRegistry();
    registerPipelineTools();
  });
  afterEach(() => vi.restoreAllMocks());

  it("registers the pipeline + extraction tools", () => {
    for (const n of ["llm.extract", "pipeline.createRun", "pipeline.updateStage", "pipeline.openGate", "pipeline.getRun", "pipeline.listGates"]) {
      expect(getTool(n)).toBeDefined();
    }
  });

  it("the mutating pipeline tools are LOW-impact writes (auto-run; the real work is gated downstream)", () => {
    for (const n of ["pipeline.createRun", "pipeline.updateStage", "pipeline.openGate"]) {
      const t = getTool(n)!;
      expect(t.write).toBe(true);
      expect(t.impact).toBe("low");
    }
    // Reads + AI extraction are not writes.
    expect(getTool("pipeline.getRun")!.write).toBeUndefined();
    expect(getTool("llm.extract")!.write).toBeUndefined();
  });

  it("pipeline.createRun POSTs the run + forwards the OBO envelope", async () => {
    const spy = mockFetch(201, { id: "run-1", deduped: false });
    vi.stubGlobal("fetch", spy);
    const out = await getTool("pipeline.createRun")!.handler(
      { tenantId: "co-1", sourceMeetingId: "mtg-9", title: "Kickoff", stages: [{ track: "delivery", name: "prd_extract" }] },
      principal,
    );
    expect(JSON.parse(out)).toEqual({ id: "run-1", deduped: false });
    const [url, init] = (spy as any).mock.calls[0];
    expect(url).toContain("/api/co-1/pipeline/runs");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-obo-external-id"]).toBe("wf:mtg-dispatcher");
    expect(JSON.parse(init.body).sourceMeetingId).toBe("mtg-9");
  });

  it("pipeline.updateStage PATCHes the stage", async () => {
    const spy = mockFetch(200, { id: "s-1", status: "done" });
    vi.stubGlobal("fetch", spy);
    await getTool("pipeline.updateStage")!.handler({ tenantId: "co-1", stageId: "s-1", status: "done", confidence: 0.8 }, principal);
    const [url, init] = (spy as any).mock.calls[0];
    expect(url).toContain("/api/co-1/pipeline/stages/s-1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body).status).toBe("done");
  });

  it("pipeline.openGate POSTs a gate", async () => {
    const spy = mockFetch(201, { id: "g-1", status: "pending" });
    vi.stubGlobal("fetch", spy);
    await getTool("pipeline.openGate")!.handler({ tenantId: "co-1", runId: "run-1", kind: "prd_sign", actorSide: "client" }, principal);
    const [url, init] = (spy as any).mock.calls[0];
    expect(url).toContain("/api/co-1/pipeline/gates");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toMatchObject({ runId: "run-1", kind: "prd_sign", actorSide: "client" });
  });

  it("pipeline.listGates builds the query string and GETs", async () => {
    const spy = mockFetch(200, []);
    vi.stubGlobal("fetch", spy);
    await getTool("pipeline.listGates")!.handler({ tenantId: "co-1", actorSide: "client", kind: "prd_sign" }, principal);
    const [url, init] = (spy as any).mock.calls[0];
    expect(url).toContain("/api/co-1/pipeline/gates?");
    expect(url).toContain("actorSide=client");
    expect(url).toContain("kind=prd_sign");
    expect(init?.method).toBeUndefined(); // GET
  });

  it("llm.extract parses the model JSON into { kind, content, confidence } (clamped)", async () => {
    // gatewayComplete() reads {text} from the Gateway /complete response.
    vi.stubGlobal("fetch", mockFetch(200, { text: '{"content":"# PRD\\n...","confidence":1.7}' }));
    const out = await getTool("llm.extract")!.handler({ kind: "prd", text: "we discussed a login page" }, principal);
    expect(JSON.parse(out)).toEqual({ kind: "prd", content: "# PRD\n...", confidence: 1 }); // clamped to 1
  });

  it("llm.extract is robust to a non-JSON model reply (wraps raw, null confidence)", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { text: "sorry, here is a plain summary" }));
    const out = await getTool("llm.extract")!.handler({ kind: "report", text: "notes" }, principal);
    expect(JSON.parse(out)).toEqual({ kind: "report", content: "sorry, here is a plain summary", confidence: null });
  });

  it("llm.extract rejects an unknown kind and empty text", async () => {
    await expect(getTool("llm.extract")!.handler({ kind: "bogus", text: "x" }, principal)).rejects.toThrow(/kind must be/);
    await expect(getTool("llm.extract")!.handler({ kind: "prd", text: "" }, principal)).rejects.toThrow(/text required/);
  });

  it("maps a platform 403 to a thrown denial", async () => {
    vi.stubGlobal("fetch", mockFetch(403, { error: "not authorized: cerbos denied" }));
    await expect(getTool("pipeline.openGate")!.handler({ tenantId: "co-1", runId: "r", kind: "pm_review", actorSide: "internal" }, principal)).rejects.toThrow(/not authorized/);
  });

  it("the WS11 workflows are scoped to exactly their pipeline tools (deny-by-default)", () => {
    expect(AUTOMATION_ALLOWLIST["wf:mtg-dispatcher"]).toContain("llm.extract");
    expect(AUTOMATION_ALLOWLIST["wf:mtg-dispatcher"]).toContain("pipeline.createRun");
    expect(AUTOMATION_ALLOWLIST["wf:delivery"]).toContain("pipeline.openGate");
    // n8n never decides a gate: no workflow is scoped to a decide/sign tool (none exists on the hub).
    for (const scope of Object.values(AUTOMATION_ALLOWLIST)) {
      expect(scope).not.toContain("pipeline.decideGate");
    }
  });
});
