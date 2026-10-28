// The sweep must stop when the AI gateway's daily budget is gone, and a stopped sweep must never
// retire anything (2026-10-28: a sweep made ~9,300 embed calls, 7,332 of them refused with 429, and
// the budget never recovered for the assistant, agents and drafts). No DB and no network: the
// knowledge service is a fake `fetch`, the ERP/site builders are stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../db", () => ({ withGlobal: vi.fn() }));
vi.mock("./erp-source", () => ({ buildErpDocuments: vi.fn() }));
vi.mock("./web-source", async (orig) => ({ ...(await orig<typeof import("./web-source")>()), crawlSite: vi.fn() }));

import { config } from "../../../config";
import { buildErpDocuments } from "./erp-source";
import { runFullIngest, runInternalIngest } from "./ingest.service";
import { runIngestSweep } from "./scheduler";
import { crawlSite } from "./web-source";
import type { IngestDocument } from "./types";

const T1 = "aaaaaaaa-0000-4000-8000-000000000001";
const T2 = "aaaaaaaa-0000-4000-8000-000000000002";
const T3 = "aaaaaaaa-0000-4000-8000-000000000003";

function docs(tenantId: string, n: number): IngestDocument[] {
  return Array.from({ length: n }, (_, i) => ({
    tenantId,
    sourceRef: `erp:project:${tenantId.slice(-1)}-${i}`,
    audience: "internal" as const,
    chunks: [`chunk of ${tenantId} ${i}`],
    label: `p${i}`,
  }));
}

/** A fake knowledge service. `budget` = how many /ingest calls succeed before every further one is 429. */
function fakeService(budget: number) {
  const calls: { ingest: string[]; erase: string[] } = { ingest: [], erase: [] };
  const stored = new Map<string, string>(); // sourceRef -> tenant
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/ingest")) {
      const body = JSON.parse(String(init?.body));
      calls.ingest.push(body.sourceRef);
      if (calls.ingest.length > budget) return new Response(JSON.stringify({ error: "embedding_budget_exhausted" }), { status: 429 });
      stored.set(body.sourceRef, body.tenantId);
      return new Response(JSON.stringify({ written: body.chunks.length }), { status: 200 });
    }
    if (url.includes("/sources")) {
      const tenant = new URL(url).searchParams.get("tenant");
      const rows = [...stored].filter(([, t]) => t === tenant).map(([sourceRef]) => ({ sourceRef, audience: "internal" }));
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    if (url.includes("/erase")) {
      const body = JSON.parse(String(init?.body));
      calls.erase.push(body.sourceRef);
      stored.delete(body.sourceRef);
      return new Response(JSON.stringify({ deleted: 1 }), { status: 200 });
    }
    return new Response("", { status: 404 });
  });
  return { calls, stored, fetchImpl };
}

describe("knowledge ingest: embedding budget", () => {
  const saved = { svc: { ...config.services.knowledge }, ki: { ...config.knowledgeIngest } };

  beforeEach(() => {
    config.services.knowledge.url = "http://knowledge.test";
    config.services.knowledge.token = "tok";
    config.knowledgeIngest.publicTenantId = "";
    config.knowledgeIngest.internalTenantIds = [T1, T2, T3];
    vi.mocked(crawlSite).mockResolvedValue([]);
  });
  afterEach(() => {
    Object.assign(config.services.knowledge, saved.svc);
    Object.assign(config.knowledgeIngest, saved.ki);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("a 429 midway stops the sweep: no further calls, no later company run, nothing retired", async () => {
    const svc = fakeService(3); // 3 documents succeed, the 4th is refused
    // The store already holds a STALE source for T1 and some chunks for T2/T3 that the sweep never reaches.
    svc.stored.set("erp:project:stale-1", T1);
    svc.stored.set("erp:project:keep-2", T2);
    svc.stored.set("erp:project:keep-3", T3);
    vi.stubGlobal("fetch", svc.fetchImpl);
    vi.mocked(buildErpDocuments).mockImplementation(async (t: string) => docs(t, 5));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const results = await runIngestSweep();

    // 3 ok + the one refused call, then nothing: the other 11 documents were never sent.
    expect(svc.calls.ingest).toHaveLength(4);
    // The public tier ran (and was a no-op: no tenant), T1 aborted, T2/T3 never started.
    expect(results.some((r) => r.aborted)).toBe(true);
    expect(buildErpDocuments).toHaveBeenCalledTimes(1);
    // Nothing retired anywhere: not the stale T1 source (the cut-off source), not T2/T3.
    expect(svc.calls.erase).toEqual([]);
    expect(svc.stored.has("erp:project:stale-1")).toBe(true);
    expect(svc.stored.has("erp:project:keep-2")).toBe(true);
    expect(svc.stored.has("erp:project:keep-3")).toBe(true);
    // ONE line naming the stop, counts only; no per-document error spam on the console.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/STOPPED on embedding budget/);
    expect(log).not.toHaveBeenCalled();
  });

  it("the source that was cut off is not marked written, and the run is flagged aborted", async () => {
    const svc = fakeService(1);
    vi.stubGlobal("fetch", svc.fetchImpl);
    vi.mocked(buildErpDocuments).mockResolvedValue(docs(T1, 4));
    const r = await runInternalIngest(T1);
    expect(r.aborted).toBe(true);
    expect(r.sources).toBe(1); // only the one that really went in
    expect(r.errors).toHaveLength(1);
    expect(r.retired).toBe(0);
    expect(svc.calls.ingest).toHaveLength(2);
  });

  it("runFullIngest returns at the aborted company: later companies are not built or ingested", async () => {
    const svc = fakeService(0);
    vi.stubGlobal("fetch", svc.fetchImpl);
    vi.mocked(buildErpDocuments).mockImplementation(async (t: string) => docs(t, 2));
    const results = await runFullIngest();
    expect(results.at(-1)?.aborted).toBe(true);
    expect(results.at(-1)?.tenantId).toBe(T1);
    expect(buildErpDocuments).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.tier === "internal")).toHaveLength(1);
    expect(svc.calls.ingest).toHaveLength(1);
  });

  it("a normal full pass still retires a source that vanished upstream (the safety gate is not over-broad)", async () => {
    const svc = fakeService(100);
    svc.stored.set("erp:project:gone", T1);
    vi.stubGlobal("fetch", svc.fetchImpl);
    vi.mocked(buildErpDocuments).mockResolvedValue(docs(T1, 2));
    const r = await runInternalIngest(T1);
    expect(r.aborted).toBeFalsy();
    expect(r.retired).toBe(1);
    expect(svc.calls.erase).toEqual(["erp:project:gone"]);
  });

  it("any other failure stays per-document: the sweep goes on and nothing is retired (unchanged behaviour)", async () => {
    const svc = fakeService(100);
    svc.stored.set("erp:project:gone", T1);
    const inner = svc.fetchImpl.getMockImplementation()!;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("/ingest") && String(init?.body).includes("1-0") ? new Response("boom", { status: 500 }) : inner(input, init),
    );
    vi.mocked(buildErpDocuments).mockResolvedValue(docs(T1, 3));
    const r = await runInternalIngest(T1);
    expect(r.aborted).toBeFalsy();
    expect(r.sources).toBe(2);
    expect(r.errors).toHaveLength(1);
    expect(r.retired).toBe(0);
    expect(svc.calls.erase).toEqual([]);
  });
});
