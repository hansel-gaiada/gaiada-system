// DW-D26 (BFF §46.9) — the hub's `knowledge.search` takes its INTERNAL hits from the platform's per-record-filtered
// `GET /api/:tenantId/knowledge/search`, and its PUBLIC hits from the knowledge service with `publicOnly: true`. A caller with
// no identity or no company gets the public tier only, as before, in the same plain-array answer.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerPlatformTools } from "./platform-tools";
import { getTool, resetRegistry } from "./registry";
import { mintPrincipal } from "./principal";
import { config } from "./config";

const T = "11111111-1111-4111-8111-111111111111";
const user = mintPrincipal({ provider: "whatsapp", externalId: "wa:628111" });
const anon = mintPrincipal({});

const pubHit = (n: number) => ({ tenantId: "public", sourceRef: `web:page:${n}`, kind: "doc", text: `PUBLIC_${n}`, provenance: "web", confidence: 1, score: 0.5 - n / 100, audience: "public" });
const platformResult = (n: number) => ({ sourceRef: `erp:project:${n}`, family: "project", title: `Project ${n}`, snippet: `snippet ${n}`, href: `/projects/${n}`, score: 0.9 - n / 100 });

interface Routes {
  platform?: { status: number; json?: unknown } | "throw";
  knowledge?: { status: number; json?: unknown } | "throw";
}
/** A fetch double that routes by URL and records every call. */
function stubFetch(r: Routes) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const spy = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const route = url.startsWith(config.platformUrl) ? r.platform : r.knowledge;
    if (!route || route === "throw") throw new Error("connection refused");
    return { ok: route.status >= 200 && route.status < 300, status: route.status, json: async () => route.json };
  });
  vi.stubGlobal("fetch", spy);
  return calls;
}
const run = (args: Record<string, unknown>, who = user) => getTool("knowledge.search")!.handler(args, who);
const bodyOf = (c: { init: RequestInit }) => JSON.parse(String(c.init.body));

describe("knowledge.search (DW-D26)", () => {
  beforeEach(() => {
    resetRegistry();
    registerPlatformTools();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("identity + tenantId: internal hits come from the platform route with the caller's envelope; public hits from the store with publicOnly", async () => {
    const calls = stubFetch({
      platform: { status: 200, json: { query: "acme", results: [platformResult(1), platformResult(2)], indexedAt: null } },
      knowledge: { status: 200, json: { hits: [pubHit(1), pubHit(2)] } },
    });
    const out = JSON.parse(await run({ query: "acme", tenantId: T, limit: 10 }));

    const platform = calls.find((c) => c.url.startsWith(config.platformUrl))!;
    expect(platform.url).toBe(`${config.platformUrl}/api/${T}/knowledge/search?q=acme&limit=10`);
    const h = platform.init.headers as Record<string, string>;
    expect(h["x-obo-provider"]).toBe("whatsapp");
    expect(h["x-obo-external-id"]).toBe("wa:628111");
    expect(h.Authorization).toBe(`Bearer ${config.platformToken}`);

    const store = calls.find((c) => c.url.startsWith(config.knowledgeUrl))!;
    expect(store.url).toBe(`${config.knowledgeUrl}/search`);
    expect(bodyOf(store)).toMatchObject({ query: "acme", publicOnly: true, topK: 10 });
    expect((store.init.headers as Record<string, string>)["x-obo-external-id"]).toBe("wa:628111");
    // the store is never asked for the internal tier: only the platform route's filtered answer carries it
    expect(calls).toHaveLength(2);

    // merged: internal first (mapped into the hit shape, title + snippet in `text`), then public
    expect(out.internal).toEqual({ status: "ok" });
    expect(out.public).toEqual({ status: "ok" });
    expect(out.hits.map((x: { sourceRef: string }) => x.sourceRef)).toEqual(["erp:project:1", "erp:project:2", "web:page:1", "web:page:2"]);
    expect(out.hits[0]).toMatchObject({ tenantId: T, sourceRef: "erp:project:1", kind: "project", text: "Project 1\nsnippet 1", audience: "internal", title: "Project 1", href: "/projects/1" });
    expect(out.hits[2].audience).toBe("public");
  });

  it("the merged answer never exceeds the requested limit, internal hits first", async () => {
    stubFetch({
      platform: { status: 200, json: { results: [platformResult(1), platformResult(2), platformResult(3)] } },
      knowledge: { status: 200, json: { hits: [pubHit(1), pubHit(2)] } },
    });
    const out = JSON.parse(await run({ query: "acme", tenantId: T, limit: 4 }));
    expect(out.hits).toHaveLength(4);
    expect(out.hits.map((x: { sourceRef: string }) => x.sourceRef)).toEqual(["erp:project:1", "erp:project:2", "erp:project:3", "web:page:1"]);
    const small = JSON.parse(await run({ query: "acme", tenantId: T, limit: 2 }));
    expect(small.hits.map((x: { audience: string }) => x.audience)).toEqual(["internal", "internal"]);
  });

  it("no identity: the public tier only, a plain array, and the platform is never called (even with a tenantId)", async () => {
    const calls = stubFetch({ platform: { status: 200, json: { results: [platformResult(1)] } }, knowledge: { status: 200, json: { hits: [pubHit(1)] } } });
    const out = JSON.parse(await run({ query: "opening hours", tenantId: T }, anon));
    expect(Array.isArray(out)).toBe(true);
    expect(out).toEqual([pubHit(1)]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${config.knowledgeUrl}/search`);
    expect(JSON.stringify(out)).not.toContain("erp:");
  });

  it("an identity with no tenantId: a plain-array answer of the PUBLIC tier only (the store is never asked for its unfiltered internal tier)", async () => {
    const calls = stubFetch({ knowledge: { status: 200, json: { hits: [pubHit(1)] } } });
    const out = JSON.parse(await run({ query: "hello", scope: "chat-1" }));
    expect(out).toEqual([pubHit(1)]);
    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0])).toEqual({ query: "hello", scope: "chat-1", publicOnly: true });
  });

  it("publicOnly: true skips the platform even with identity and tenantId", async () => {
    const calls = stubFetch({ knowledge: { status: 200, json: { hits: [pubHit(1)] } } });
    const out = JSON.parse(await run({ query: "hello", tenantId: T, publicOnly: true }));
    expect(out).toEqual([pubHit(1)]);
    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0]).publicOnly).toBe(true);
  });

  for (const [label, platform, status] of [
    ["403 (not a member / not permitted)", { status: 403, json: { error: "forbidden" } }, "not_permitted"],
    ["401 (identity not linked)", { status: 401, json: {} }, "not_permitted"],
    ["503 (knowledge unavailable)", { status: 503, json: { error: "knowledge_unavailable" } }, "unavailable"],
    ["a network failure", "throw", "unavailable"],
  ] as const) {
    it(`platform ${label}: public hits only, and the result SAYS internal was ${status}`, async () => {
      stubFetch({ platform, knowledge: { status: 200, json: { hits: [pubHit(1)] } } });
      const out = JSON.parse(await run({ query: "acme", tenantId: T }));
      expect(out.hits).toEqual([pubHit(1)]);
      expect(out.internal.status).toBe(status);
      expect(out.internal.note).toMatch(/only public knowledge is shown/);
      expect(out.public).toEqual({ status: "ok" });
    });
  }

  it("a malformed platform answer is reported as unavailable, never as zero internal hits", async () => {
    stubFetch({ platform: { status: 200, json: { nope: true } }, knowledge: { status: 200, json: { hits: [] } } });
    const out = JSON.parse(await run({ query: "acme", tenantId: T }));
    expect(out.hits).toEqual([]);
    expect(out.internal.status).toBe("unavailable");
  });

  it("an empty but healthy internal answer is `ok` with no hits (distinct from unavailable)", async () => {
    stubFetch({ platform: { status: 200, json: { results: [] } }, knowledge: { status: 200, json: { hits: [pubHit(1)] } } });
    const out = JSON.parse(await run({ query: "acme", tenantId: T }));
    expect(out.internal).toEqual({ status: "ok" });
    expect(out.hits).toEqual([pubHit(1)]);
  });

  it("the public tier failing is still an error, unless the internal tier answered", async () => {
    stubFetch({ platform: { status: 403, json: {} }, knowledge: { status: 500, json: {} } });
    await expect(run({ query: "acme", tenantId: T })).rejects.toThrow(/knowledge \/search 500/);

    stubFetch({ platform: { status: 200, json: { results: [platformResult(1)] } }, knowledge: { status: 500, json: {} } });
    const out = JSON.parse(await run({ query: "acme", tenantId: T }));
    expect(out.hits.map((x: { sourceRef: string }) => x.sourceRef)).toEqual(["erp:project:1"]);
    expect(out.public).toEqual({ status: "unavailable" });
  });

  it("a tenantId that could rewrite the platform path is refused before any call", async () => {
    const calls = stubFetch({ platform: { status: 200, json: { results: [] } }, knowledge: { status: 200, json: { hits: [] } } });
    await expect(run({ query: "acme", tenantId: "../admin" })).rejects.toThrow(/valid company id/);
    expect(calls).toHaveLength(0);
  });

  it("the query is URL-encoded on the platform call", async () => {
    const calls = stubFetch({ platform: { status: 200, json: { results: [] } }, knowledge: { status: 200, json: { hits: [] } } });
    await run({ query: "a&b=c d", tenantId: T });
    expect(calls.find((c) => c.url.startsWith(config.platformUrl))!.url).toContain("?q=a%26b%3Dc%20d&limit=5");
  });

  it("the description says internal hits are only records the caller may open", () => {
    const d = getTool("knowledge.search")!.description;
    expect(d).toMatch(/only records you could open/);
    expect(d).toMatch(/tenantId/);
  });
});
