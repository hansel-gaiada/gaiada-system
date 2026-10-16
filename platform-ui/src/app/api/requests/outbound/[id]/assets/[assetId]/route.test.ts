import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// DW-10e (BFF §60.5): the SENDER's download of a delivered asset. Pinned: the caller's auth goes to the platform's
// `requests/outbound/:id/assets/:assetId/content` under the ASKING company (the active one, never a value from the URL); whatever the platform
// sends, the response stays an attachment with nosniff and a sandbox CSP; a refusal is a sentence with the right status, never a 500; a bad id
// never reaches the platform; DEMO_MODE answers a labelled stand-in.
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", () => ({
  getMe: vi.fn(async () => ({ userId: "u-1", companies: [], roles: [] })),
  platformAuthHeaders: vi.fn(async () => ({ authorization: "Bearer tok-u1" })),
}));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-resort") }));
vi.mock("@/lib/demoMode", () => ({ isDemoMode: vi.fn(() => false) }));

import { getSessionUserId } from "@/lib/session-server";
import { getActiveTenant } from "@/lib/tenant";
import { isDemoMode } from "@/lib/demoMode";
import { GET } from "./route";

const fetchMock = vi.fn();
const call = (id: string, assetId: string) =>
  GET(new Request(`http://ui.test/api/requests/outbound/${id}/assets/${assetId}`), { params: Promise.resolve({ id, assetId }) });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(getSessionUserId).mockResolvedValue("u-1");
  vi.mocked(getActiveTenant).mockResolvedValue("co-resort");
  vi.mocked(isDemoMode).mockReturnValue(false);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/requests/outbound/:id/assets/:assetId", () => {
  it("forwards the caller's auth to the sender's content route under the ASKING company, and serves the bytes as a sandboxed attachment", async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/svg+xml" } }));
    const res = await call("r-1", "a-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.endsWith("/api/co-resort/requests/outbound/r-1/assets/a-1/content")).toBe(true);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-u1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("takes the company from the session, never from the URL: the receiving company's id is never asked for", async () => {
    fetchMock.mockResolvedValue(new Response("x", { status: 200 }));
    await call("r-1", "a-1");
    expect(String(fetchMock.mock.calls[0][0])).not.toMatch(/co-agency/);
  });

  it("refuses an implausible id (either one) without calling the platform", async () => {
    expect((await call("../x", "a-1")).status).toBe(400);
    expect((await call("r-1", "../x")).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 401 with no session, and 400 in words with no active company", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null as never);
    expect((await call("r-1", "a-1")).status).toBe(401);
    vi.mocked(getSessionUserId).mockResolvedValue("u-1");
    vi.mocked(getActiveTenant).mockResolvedValue(null as never);
    const res = await call("r-1", "a-1");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/No active company/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes 403 and 404 through with words, and turns any other fault into a 502", async () => {
    for (const [upstream, expected] of [[403, 403], [404, 404], [500, 502]] as const) {
      fetchMock.mockResolvedValue(new Response("x", { status: upstream }));
      const res = await call("r-1", "a-1");
      expect(res.status).toBe(expected);
      expect(((await res.json()) as { error: string }).error.length).toBeGreaterThan(10);
    }
  });

  it("answers 502 in words when the platform cannot be reached", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    expect((await call("r-1", "a-1")).status).toBe(502);
  });

  it("in DEMO_MODE answers a labelled stand-in with the same headers, and never calls the platform", async () => {
    vi.mocked(isDemoMode).mockReturnValue(true);
    const res = await call("r-1", "a-1");
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/DEMO MODE/);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
