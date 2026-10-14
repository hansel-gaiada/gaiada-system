import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// DW-6k UI: the thumbnail proxy. Pinned: the caller's auth goes to the platform's thumbnail route for the ACTIVE company; only a
// PNG is passed on, with the platform's private cache header and the sandbox headers; a refusal is words with the right status
// (never a 500); a bad id never reaches the platform; demo mode has no Figma data.
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", () => ({
  getMe: vi.fn(async () => ({ userId: "u-1", companies: [], roles: [] })),
  platformAuthHeaders: vi.fn(async () => ({ authorization: "Bearer tok-u1" })),
}));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("@/lib/demoMode", () => ({ isDemoMode: vi.fn(() => false) }));

import { getSessionUserId } from "@/lib/session-server";
import { isDemoMode } from "@/lib/demoMode";
import { GET } from "./route";

const fetchMock = vi.fn();
const call = (linkId: string) => GET(new Request(`http://ui.test/api/figma-links/${linkId}/thumbnail`), { params: Promise.resolve({ linkId }) });
const png = (status = 200) => new Response(new Uint8Array([137, 80, 78, 71]), { status, headers: { "content-type": "image/png" } });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(getSessionUserId).mockResolvedValue("u-1");
  vi.mocked(isDemoMode).mockReturnValue(false);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/figma-links/:linkId/thumbnail", () => {
  it("forwards the caller's auth to the platform's thumbnail route for the active company and serves the PNG, privately cached", async () => {
    fetchMock.mockResolvedValue(png());
    const res = await call("l-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/co-1\/figma-links\/l-1\/thumbnail$/);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-u1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("private, max-age=600");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
  });

  it("does not pass on anything that is not a PNG", async () => {
    fetchMock.mockResolvedValue(new Response("<script>alert(1)</script>", { status: 200, headers: { "content-type": "text/html" } }));
    expect((await call("l-1")).status).toBe(502);
  });

  it("refuses an implausible id without calling the platform", async () => {
    const res = await call("../x");
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 401 with no session", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null as never);
    expect((await call("l-1")).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("has no Figma data in demo mode and does not ask the platform", async () => {
    vi.mocked(isDemoMode).mockReturnValue(true);
    expect((await call("l-1")).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes 403, 404 and 409 through with words, and turns any other fault into a 502", async () => {
    for (const [upstream, expected] of [[403, 403], [404, 404], [409, 409], [500, 502], [503, 502]] as const) {
      fetchMock.mockResolvedValue(new Response("x", { status: upstream }));
      const res = await call("l-1");
      expect(res.status).toBe(expected);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(typeof (await res.json()).error).toBe("string");
    }
  });

  it("answers 502 when the platform cannot be reached", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
    expect((await call("l-1")).status).toBe(502);
  });
});
