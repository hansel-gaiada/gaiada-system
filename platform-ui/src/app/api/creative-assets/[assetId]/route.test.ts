import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// DW-5c UI: the staff download of a delivered creative asset. Pinned: the caller's auth goes to the platform's
// `creative/assets/:id/content` for the ACTIVE company; whatever the platform sends, the response stays an attachment with
// nosniff and a sandbox CSP; a refusal is a sentence with the right status, never a 500; a bad id never reaches the platform.
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", () => ({
  getMe: vi.fn(async () => ({ userId: "u-1", companies: [], roles: [] })),
  platformAuthHeaders: vi.fn(async () => ({ authorization: "Bearer tok-u1" })),
}));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("@/lib/demoMode", () => ({ isDemoMode: vi.fn(() => false) }));

import { getSessionUserId } from "@/lib/session-server";
import { GET } from "./route";

const fetchMock = vi.fn();
const call = (assetId: string) => GET(new Request(`http://ui.test/api/creative-assets/${assetId}`), { params: Promise.resolve({ assetId }) });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(getSessionUserId).mockResolvedValue("u-1");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/creative-assets/:assetId", () => {
  it("forwards the caller's auth to the content route of the active company, and serves the bytes as a sandboxed attachment", async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/svg+xml" } }));
    const res = await call("a-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/co-1\/creative\/assets\/a-1\/content$/);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-u1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("refuses an implausible id without calling the platform", async () => {
    const res = await call("../x");
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 401 with no session", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null as never);
    expect((await call("a-1")).status).toBe(401);
  });

  it("passes 403 and 404 through with words, and turns any other fault into a 502", async () => {
    for (const [upstream, expected] of [[403, 403], [404, 404], [500, 502]] as const) {
      fetchMock.mockResolvedValue(new Response("x", { status: upstream }));
      const res = await call("a-1");
      expect(res.status).toBe(expected);
      expect(((await res.json()) as { error: string }).error.length).toBeGreaterThan(10);
    }
  });

  it("answers 502 in words when the platform cannot be reached", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await call("a-1");
    expect(res.status).toBe(502);
  });
});
