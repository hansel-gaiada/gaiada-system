// AIP-00c — the /health -> brains mapping, the failure cases (all `null`), the cache, and the exact keys.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { getBrains, mapHealthToBrains, resetBrainsCache, BRAINS_CACHE_TTL_MS } from "./brains";

const HEALTH = {
  ok: true,
  providers: {
    llm: { claude: "unconfigured", echo: "ok", gemini: "unconfigured", openai: "ok", hermes: "open" },
    media: { whisper: "ok" },
  },
  budget: { spentUsd: 1.5, capUsd: 10 },
  model: "glm-5.3-flash",
  endpoint: "https://openrouter.ai/api/v1",
};

function okFetch(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}
const base = { gatewayUrl: "http://gw:3002/", gatewayToken: "tok" };

beforeEach(() => resetBrainsCache());

describe("mapHealthToBrains", () => {
  it("only state ok is available; echo is dropped; every other state is unavailable", () => {
    expect(mapHealthToBrains(HEALTH)).toEqual([
      { value: "claude", available: false },
      { value: "gemini", available: false },
      { value: "openai", available: true },
      { value: "hermes", available: false },
    ]);
  });
  it("bad shapes give null", () => {
    for (const bad of [null, "x", {}, { providers: {} }, { providers: { llm: [] } }, { providers: { llm: { openai: 1 } } }]) {
      expect(mapHealthToBrains(bad)).toBeNull();
    }
  });
});

describe("getBrains", () => {
  it("returns exactly {brains:[{value,available}], checkedAt} and leaks nothing from /health", async () => {
    const r = await getBrains({ ...base, fetchImpl: okFetch(HEALTH), now: () => 1_000, warn: () => {} });
    expect(Object.keys(r).sort()).toEqual(["brains", "checkedAt"]);
    for (const b of r.brains!) expect(Object.keys(b).sort()).toEqual(["available", "value"]);
    const text = JSON.stringify(r);
    for (const leak of ["glm", "openrouter", "budget", "spentUsd", "endpoint", "unconfigured", "whisper"]) expect(text).not.toContain(leak);
    expect(r.checkedAt).toBe(new Date(1_000).toISOString());
  });

  it("calls <url>/health with the bearer token", async () => {
    const f = okFetch(HEALTH);
    await getBrains({ ...base, fetchImpl: f, warn: () => {} });
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://gw:3002/health");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("unreachable -> null with ONE warning", async () => {
    const warn = vi.fn();
    const f = vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const r = await getBrains({ ...base, fetchImpl: f, warn });
    expect(r.brains).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("timeout -> null (the fetch is given an abort signal)", async () => {
    const warn = vi.fn();
    let sawSignal = false;
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => {
      sawSignal = !!init?.signal;
      throw new DOMException("timed out", "TimeoutError");
    }) as unknown as typeof fetch;
    const r = await getBrains({ ...base, fetchImpl: f, warn });
    expect(sawSignal).toBe(true);
    expect(r.brains).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("non-2xx and bad shape -> null", async () => {
    expect((await getBrains({ ...base, fetchImpl: okFetch({}, 503), warn: () => {} })).brains).toBeNull();
    resetBrainsCache();
    expect((await getBrains({ ...base, fetchImpl: okFetch({ ok: true }), warn: () => {} })).brains).toBeNull();
  });

  it("caches for 60 s then refetches", async () => {
    const f = okFetch(HEALTH);
    let t = 0;
    const d = { ...base, fetchImpl: f, now: () => t, warn: () => {} };
    await getBrains(d);
    t = BRAINS_CACHE_TTL_MS - 1;
    await getBrains(d);
    expect(f).toHaveBeenCalledTimes(1);
    t = BRAINS_CACHE_TTL_MS;
    await getBrains(d);
    expect(f).toHaveBeenCalledTimes(2);
  });
});
