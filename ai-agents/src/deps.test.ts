// D14-12 — the background, fail-soft registry-impact cache (`deps.ts`). Mirrors
// `mcp-hub/src/module-tools.test.ts`'s own bootstrap tests: retry/backoff + periodic refresh, and
// (the load-bearing property) a failed fetch NEVER throws and NEVER blocks — it just keeps the cache
// as it was. `agent.ts`'s write gate calls `getRegistryImpact` synchronously on every tool dispatch, so
// a version of this that could throw or hang would turn a hub blip into every agent run failing.
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  liveDeps,
  refreshRegistryImpacts,
  startRegistryImpactBootstrap,
  stopRegistryImpactBootstrap,
  resetRegistryImpactCache,
} from "./deps";

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
