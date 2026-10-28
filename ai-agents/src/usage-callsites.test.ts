// AIP-03b — the two gateway call sites in this package, each driven for real with a stubbed `fetch` and a spy on the reporter:
//   * the runner's /complete (`liveDeps.complete`, deps.ts): surface agent, the run's tenant, task = the goal's agent, the requesting person, the
//     run id, and the gateway's usage and cost;
//   * the knowledge service's /embed (`embedViaGateway`, knowledge/service.ts): surface knowledge, capability embed, tokens none, the company of the
//     ingest or the search.
// The runner's wiring of the context (task, person, run id per goal) is in runner/service.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { liveDeps, tenantContext, usageContext, goalUserId, type UsageAttribution } from "./deps";
import { usageReporter, type UsageEvent } from "./usage-reporter";
import { buildKnowledgeApp, embedUsageContext, embedViaGateway, knowledgeConfig, searchUsageContext } from "./knowledge/service";
import type { KnowledgeStore } from "./knowledge/store";

const T = "11111111-1111-4111-8111-111111111111";
const U = "22222222-2222-4222-8222-222222222222";
const R = "33333333-3333-4333-8333-333333333333";

let reported: UsageEvent[];
beforeEach(() => {
  reported = [];
  vi.spyOn(usageReporter, "report").mockImplementation((e) => { reported.push(e); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const gateway = (status: number, body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })));
const runAs = <T2,>(attr: UsageAttribution | undefined, tenant: string | undefined, fn: () => Promise<T2>): Promise<T2> => {
  const inner = attr ? () => usageContext.run(attr, fn) : fn;
  return tenant ? tenantContext.run(tenant, inner) : inner();
};

describe("AIP-03b · the runner's /complete", () => {
  it("reports an agent event with the run's tenant, the goal's task, person and run id, and the gateway's usage and cost", async () => {
    gateway(200, { text: "done", provider: "openai", usage: { promptTokens: 120, completionTokens: 30, costUsd: 0.0021, source: "provider" } });
    const text = await runAs({ task: "statusReporter", userId: U, runId: R }, T, () => liveDeps.complete("p"));
    expect(text).toBe("done");
    expect(reported).toEqual([{
      tenantId: T, userId: U, surface: "agent", capability: "llm", task: "statusReporter", runId: R, provider: "openai", model: null,
      promptTokens: 120, completionTokens: 30, tokensSource: "provider", costUsd: 0.0021, costSource: "provider", outcome: "ok",
    }]);
  });

  it("an answer with no usage is tokens 'none' and still ok", async () => {
    gateway(200, { text: "done", provider: "echo" });
    await runAs({ task: "reader", userId: null, runId: null }, T, () => liveDeps.complete("p"));
    expect(reported[0]).toMatchObject({ outcome: "ok", tokensSource: "none", promptTokens: null, costUsd: null, userId: null, runId: null, task: "reader" });
  });

  it("maps 429 to blocked_budget, 503 to blocked_dlp, any other failure to error, and the call still fails as before", async () => {
    for (const [status, outcome] of [[429, "blocked_budget"], [503, "blocked_dlp"], [500, "error"], [401, "error"]] as const) {
      reported.length = 0;
      gateway(status, {});
      await expect(runAs({ task: "t", userId: U, runId: R }, T, () => liveDeps.complete("p"))).rejects.toThrow(`gateway ${status}`);
      expect(reported).toHaveLength(1);
      expect(reported[0], String(status)).toMatchObject({ outcome, tokensSource: "none", promptTokens: null, costUsd: null, provider: null, tenantId: T });
    }
  });

  it("a network failure is an error row and the original error still propagates", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    await expect(runAs({ task: "t", userId: U, runId: R }, T, () => liveDeps.complete("p"))).rejects.toThrow("ECONNREFUSED");
    expect(reported[0]).toMatchObject({ outcome: "error", tokensSource: "none" });
  });

  it("a call outside a goal (no tenant, no attribution) is handed to the reporter without a tenant, which writes nothing", async () => {
    gateway(200, { text: "ok" });
    await runAs(undefined, undefined, () => liveDeps.complete("p"));
    expect(reported[0].tenantId).toBeUndefined();
    expect(reported[0]).toMatchObject({ task: null, userId: null, runId: null, surface: "agent" });
  });
});

describe("AIP-03b · goalUserId: the person a goal is for", () => {
  it("is requestedBy when it is a uuid, else a platform envelope's external id, else null", () => {
    expect(goalUserId({ requestedBy: U, envelopeProvider: "whatsapp", envelopeExternalId: "628123" })).toBe(U);
    expect(goalUserId({ requestedBy: "not-a-uuid", envelopeProvider: "platform", envelopeExternalId: R })).toBe(R);
    expect(goalUserId({ requestedBy: null, envelopeProvider: "platform", envelopeExternalId: U })).toBe(U);
    expect(goalUserId({ requestedBy: null, envelopeProvider: "whatsapp", envelopeExternalId: U })).toBeNull();
    expect(goalUserId({ requestedBy: "Jane Doe", envelopeProvider: "platform", envelopeExternalId: "u1" })).toBeNull();
    expect(goalUserId({ envelopeProvider: "n8n", envelopeExternalId: "wf" })).toBeNull();
  });
});

describe("AIP-03b · the knowledge service's /embed", () => {
  it("reports a knowledge embed with the company, tokens none, and the task of the route", async () => {
    gateway(200, { embedding: [0.1, 0.2] });
    const v = await embedUsageContext.run({ tenantId: T, userId: null, task: "knowledge.ingest" }, () => embedViaGateway("some chunk text"));
    expect(v).toEqual([0.1, 0.2]);
    expect(reported).toEqual([{
      tenantId: T, userId: null, surface: "knowledge", capability: "embed", task: "knowledge.ingest", runId: null, provider: null, model: null,
      promptTokens: null, completionTokens: null, tokensSource: "none", costUsd: null, costSource: null, outcome: "ok",
    }]);
    expect(JSON.stringify(reported)).not.toContain("chunk text");
  });

  it("maps 429, 503 and other failures, and the call still throws as before", async () => {
    for (const [status, outcome] of [[429, "blocked_budget"], [503, "blocked_dlp"], [502, "error"]] as const) {
      reported.length = 0;
      gateway(status, {});
      await expect(embedUsageContext.run({ tenantId: T, userId: null, task: "knowledge.search" }, () => embedViaGateway("q"))).rejects.toThrow(`gateway /embed ${status}`);
      expect(reported[0].outcome, String(status)).toBe(outcome);
    }
  });

  it("outside a route there is no company: the event has none (the reporter drops it)", async () => {
    gateway(200, { embedding: [1] });
    await embedViaGateway("q");
    expect(reported[0].tenantId).toBeUndefined();
  });

  it("searchUsageContext: the company only when the caller's set is exactly one; the person only for a platform envelope", () => {
    expect(searchUsageContext([T], "platform", U)).toEqual({ tenantId: T, userId: U, task: "knowledge.search" });
    expect(searchUsageContext([], "", "")).toEqual({ tenantId: null, userId: null, task: "knowledge.search" });
    expect(searchUsageContext([T, R], "whatsapp", "628123")).toEqual({ tenantId: null, userId: null, task: "knowledge.search" });
    expect(searchUsageContext([T], "platform", "u1").userId).toBeNull();
  });

  it("the routes open the context around the store call: /ingest under the document's company, /search under the caller's single company", async () => {
    const seen: Array<ReturnType<typeof embedUsageContext.getStore>> = [];
    const store = {
      ingest: async () => { seen.push(embedUsageContext.getStore()); return 1; },
      // The /ingest route calls ingestDetailed since the re-index fix (unchanged chunks are kept, not re-embedded).
      ingestDetailed: async () => { seen.push(embedUsageContext.getStore()); return { written: 1, embedded: 1, reused: 0 }; },
      search: async () => { seen.push(embedUsageContext.getStore()); return []; },
    } as unknown as KnowledgeStore;
    const saved = knowledgeConfig.serviceToken;
    knowledgeConfig.serviceToken = "k-token";
    const app = buildKnowledgeApp(store, async () => ({ tenantSet: [T], crossCompany: false }));
    try {
      const auth = { authorization: "Bearer k-token" };
      const ing = await app.inject({ method: "POST", url: "/ingest", headers: auth, payload: { tenantId: T, sourceRef: "doc-1", chunks: ["a"] } });
      expect(ing.statusCode).toBe(200);
      const sea = await app.inject({ method: "POST", url: "/search", headers: { ...auth, "x-obo-provider": "platform", "x-obo-external-id": U }, payload: { query: "what" } });
      expect(sea.statusCode).toBe(200);
      expect(seen).toEqual([
        { tenantId: T, userId: null, task: "knowledge.ingest" },
        { tenantId: T, userId: U, task: "knowledge.search" },
      ]);
    } finally {
      knowledgeConfig.serviceToken = saved;
      await app.close();
    }
  });
});
