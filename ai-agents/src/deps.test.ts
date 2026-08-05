// D14-12 — the background, fail-soft registry-impact cache (`deps.ts`). Mirrors
// `mcp-hub/src/module-tools.test.ts`'s own bootstrap tests: retry/backoff + periodic refresh, and
// (the load-bearing property) a failed fetch NEVER throws and NEVER blocks — it just keeps the cache
// as it was. `agent.ts`'s write gate calls `getRegistryImpact` synchronously on every tool dispatch, so
// a version of this that could throw or hang would turn a hub blip into every agent run failing.
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  liveDeps,
  tenantContext,
  envelopeContext,
  refreshRegistryImpacts,
  startRegistryImpactBootstrap,
  stopRegistryImpactBootstrap,
  resetRegistryImpactCache,
} from "./deps";
import type { Envelope } from "./agent";

function fetchOk(rows: unknown[]): typeof fetch {
  return (async () => ({ ok: true, json: async () => rows })) as unknown as typeof fetch;
}

function fetchFail(status = 503): typeof fetch {
  return (async () => ({ ok: false, status })) as unknown as typeof fetch;
}

function fetchThrows(): typeof fetch {
  return (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
}

afterEach(() => {
  stopRegistryImpactBootstrap();
  resetRegistryImpactCache();
  vi.restoreAllMocks();
});

describe("D14-12 — refreshRegistryImpacts()", () => {
  it("populates the cache from the hub's GET /tools shape, and getRegistryImpact reads it synchronously", async () => {
    const ok = await refreshRegistryImpacts(
      fetchOk([
        { name: "tasks.update", description: "d", minAssurance: "low", write: true, impact: "low", source: "platform-write" },
        { name: "projects.list", description: "d", minAssurance: "low", write: false, impact: null, source: "platform-read" },
      ]),
    );
    expect(ok).toBe(true);
    expect(liveDeps.getRegistryImpact?.("tasks.update")).toEqual({ write: true, impact: "low" });
    // impact: null (the hub's JSON spelling for "unset", per server.ts's `t.impact ?? null`) normalizes
    // to `impact: undefined` in RegistryToolImpact — the unclassified bucket, not a third JSON value.
    expect(liveDeps.getRegistryImpact?.("projects.list")).toEqual({ write: false, impact: undefined });
    expect(liveDeps.getRegistryImpact?.("no.such.tool")).toBeUndefined();
  });

  it("a non-OK response is fail-soft: returns false, throws nothing, and leaves the PREVIOUS snapshot intact", async () => {
    await refreshRegistryImpacts(fetchOk([{ name: "tasks.update", write: true, impact: "low" }]));
    const ok = await refreshRegistryImpacts(fetchFail(503));
    expect(ok).toBe(false);
    // the stale-but-good snapshot from before the failure is still there — a transient hub 503 must
    // not blank out reconciliation entirely.
    expect(liveDeps.getRegistryImpact?.("tasks.update")).toEqual({ write: true, impact: "low" });
  });

  it("a thrown fetch (network error) is equally fail-soft — never propagates", async () => {
    await expect(refreshRegistryImpacts(fetchThrows())).resolves.toBe(false);
  });
});

describe("D14-12 — startRegistryImpactBootstrap() (mirrors mcp-hub's module-tools.ts bootstrap)", () => {
  it("fires an immediate attempt without the caller awaiting anything, and is idempotent (a second call does not start a second concurrent loop)", async () => {
    let attempts = 0;
    const fetchImpl: typeof fetch = (async () => {
      attempts++;
      return { ok: true, json: async () => [{ name: "tasks.update", write: true, impact: "low" }] } as unknown as Response;
    }) as unknown as typeof fetch;

    startRegistryImpactBootstrap(fetchImpl); // does not return a promise the caller must await
    startRegistryImpactBootstrap(fetchImpl); // idempotent — must NOT double the in-flight attempt
    await vi.waitFor(() => expect(attempts).toBeGreaterThanOrEqual(1));
    expect(attempts).toBe(1); // exactly one attempt, not two, despite two start() calls
    await vi.waitFor(() => expect(liveDeps.getRegistryImpact?.("tasks.update")).toEqual({ write: true, impact: "low" }));
  });

  it("stopRegistryImpactBootstrap() allows a fresh start afterwards (test/shutdown hygiene)", async () => {
    let attempts = 0;
    const fetchImpl: typeof fetch = (async () => {
      attempts++;
      return { ok: true, json: async () => [] } as unknown as Response;
    }) as unknown as typeof fetch;
    startRegistryImpactBootstrap(fetchImpl);
    await vi.waitFor(() => expect(attempts).toBe(1));
    stopRegistryImpactBootstrap();
    startRegistryImpactBootstrap(fetchImpl);
    await vi.waitFor(() => expect(attempts).toBe(2));
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// D14-14 — the live `resolveApproval` transport. Unlike agent.ts/orchestrator.ts/write-agent.ts's own
// tests (which script `AgentDeps.resolveApproval` directly), THIS suite exercises the REAL
// implementation bound into `liveDeps`: does it call the hub's `approvals.resolveExecute` tool with the
// right envelope/tenant/body, does it recover both from the `tenantContext`/`envelopeContext`
// AsyncLocalStorage pair the way `runner/service.ts` wires them, and — the mandated negative — does a
// transport fault (hub down / 403 / unknown tool) THROW rather than ever resolve to `{ match: "none" }`.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
const envelope: Envelope = { provider: "telegram", externalId: "tg:555" };
const TENANT = "co-1";

/** Run `fn` inside the exact context pair `runner/service.ts` opens per goal. */
function withGoalContext<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run(TENANT, () => envelopeContext.run(envelope, fn));
}

function mockMcpFetch(status: number, rpcResult: { isError?: boolean; content: Array<{ text: string }> }) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: rpcResult })}\n\n`,
  })) as unknown as typeof fetch;
}

describe("D14-14 — liveDeps.resolveApproval", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetRegistryImpactCache();
    stopRegistryImpactBootstrap();
  });

  it("with no tenant/envelope context wired, resolves to `none` — NOT a throw (the CLI's unwired path)", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const res = await liveDeps.resolveApproval!({ agentName: "task-triager", toolName: "tasks.update", toolArgs: {} });
    expect(res).toEqual({ match: "none" });
    expect(spy).not.toHaveBeenCalled(); // never attempted a consultation — nothing to fault
  });

  it("calls the hub's approvals.resolveExecute tool with tenantId + the ORIGINAL requester's OBO envelope", async () => {
    const rpc = { match: "none" };
    const spy = mockMcpFetch(200, { content: [{ text: JSON.stringify(rpc) }] });
    vi.stubGlobal("fetch", spy);
    const out = await withGoalContext(() =>
      liveDeps.resolveApproval!({ agentName: "task-triager", toolName: "tasks.update", toolArgs: { taskId: "t1" } }),
    );
    expect(out).toEqual(rpc);
    const [url, init] = (spy as any).mock.calls[0];
    expect(url).toContain("/mcp");
    expect(init.headers["x-obo-provider"]).toBe(envelope.provider);
    expect(init.headers["x-obo-external-id"]).toBe(envelope.externalId);
    const body = JSON.parse(init.body);
    expect(body.params.name).toBe("approvals.resolveExecute");
    expect(body.params.arguments).toEqual({
      tenantId: TENANT,
      agentName: "task-triager",
      toolName: "tasks.update",
      toolArgs: { taskId: "t1" },
    });
  });

  it("`executed` round-trips through the hub call untouched", async () => {
    const rpc = { match: "executed", approvalId: "ap-1", consumed: false, result: "task t1 marked done", truncated: false };
    vi.stubGlobal("fetch", mockMcpFetch(200, { content: [{ text: JSON.stringify(rpc) }] }));
    const out = await withGoalContext(() =>
      liveDeps.resolveApproval!({ agentName: "task-triager", toolName: "tasks.update", toolArgs: {} }),
    );
    expect(out).toEqual(rpc);
  });

  // ── the mandated negative: a fault during consultation THROWS, never `{ match: "none" }` ─────────

  it("hub unreachable (network failure) ⇒ THROWS — never `{ match: none }`", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(
      withGoalContext(() => liveDeps.resolveApproval!({ agentName: "a", toolName: "t", toolArgs: {} })),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it("hub HTTP error (e.g. 500) ⇒ THROWS — never `{ match: none }`", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, text: async () => "" })),
    );
    await expect(
      withGoalContext(() => liveDeps.resolveApproval!({ agentName: "a", toolName: "t", toolArgs: {} })),
    ).rejects.toThrow(/hub 500/);
  });

  it("unknown tool (hub predates this ticket) ⇒ isError deny ⇒ THROWS — never `{ match: none }`", async () => {
    vi.stubGlobal(
      "fetch",
      mockMcpFetch(200, { isError: true, content: [{ text: "unknown tool: approvals.resolveExecute" }] }),
    );
    await expect(
      withGoalContext(() => liveDeps.resolveApproval!({ agentName: "a", toolName: "t", toolArgs: {} })),
    ).rejects.toThrow(/unknown tool/);
  });

  it("403 (a decided row exists but belongs to someone else) ⇒ isError deny ⇒ THROWS — never `{ match: none }`", async () => {
    vi.stubGlobal(
      "fetch",
      mockMcpFetch(200, {
        isError: true,
        content: [{ text: "tool failed: not authorized: an approved execution may be resolved only by the principal that filed it" }],
      }),
    );
    await expect(
      withGoalContext(() => liveDeps.resolveApproval!({ agentName: "a", toolName: "t", toolArgs: {} })),
    ).rejects.toThrow(/not authorized/);
  });

  it("a non-JSON hub response ⇒ THROWS (JSON.parse fault) — never `{ match: none }`", async () => {
    vi.stubGlobal("fetch", mockMcpFetch(200, { content: [{ text: "not json" }] }));
    await expect(
      withGoalContext(() => liveDeps.resolveApproval!({ agentName: "a", toolName: "t", toolArgs: {} })),
    ).rejects.toThrow();
  });

  it("concurrent goals under different tenantContext/envelopeContext runs never cross-talk (AsyncLocalStorage, not a module-level var)", async () => {
    const calls: Array<{ tenantId: unknown; provider: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string; headers: Record<string, string> }) => {
        const body = JSON.parse(init.body);
        calls.push({ tenantId: body.params.arguments.tenantId, provider: init.headers["x-obo-provider"] });
        return {
          ok: true,
          status: 200,
          text: async () =>
            `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ text: JSON.stringify({ match: "none" }) }] } })}\n\n`,
        };
      }),
    );
    const envA: Envelope = { provider: "telegram", externalId: "tg:A" };
    const envB: Envelope = { provider: "whatsapp", externalId: "wa:B" };
    await Promise.all([
      tenantContext.run("tenant-A", () =>
        envelopeContext.run(envA, () => liveDeps.resolveApproval!({ agentName: "a", toolName: "t", toolArgs: {} })),
      ),
      tenantContext.run("tenant-B", () =>
        envelopeContext.run(envB, () => liveDeps.resolveApproval!({ agentName: "a", toolName: "t", toolArgs: {} })),
      ),
    ]);
    expect(calls).toHaveLength(2);
    expect(calls.find((c) => c.tenantId === "tenant-A")?.provider).toBe("telegram");
    expect(calls.find((c) => c.tenantId === "tenant-B")?.provider).toBe("whatsapp");
  });
});
