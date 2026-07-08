import { describe, it, expect, vi, beforeEach } from "vitest";
import { platformFetch, PlatformError } from "./platform";

beforeEach(() => {
  process.env.PLATFORM_URL = "http://platform.test";
  process.env.PLATFORM_SERVICE_TOKEN = "svc-tok";
});

describe("platformFetch", () => {
  it("sends service token + acting user and parses JSON", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await platformFetch<{ ok: boolean }>("/api/me", "u-1");
    expect(out.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://platform.test/api/me");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer svc-tok");
    expect((init.headers as Record<string, string>)["x-user-id"]).toBe("u-1");
  });
  it("throws PlatformError with status on non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not authorized" }), { status: 403 })));
    await expect(platformFetch("/api/x", "u-1")).rejects.toMatchObject({ status: 403 });
    await expect(platformFetch("/api/x", "u-1")).rejects.toBeInstanceOf(PlatformError);
  });
});
