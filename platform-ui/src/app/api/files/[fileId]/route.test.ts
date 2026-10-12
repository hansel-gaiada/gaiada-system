import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// PV3-08 follow-up: the STAFF file download route. What is pinned:
//  - it forwards the caller's session auth to the platform's `/files/:id/content` for the ACTIVE company;
//  - whatever the platform sends, the response stays an attachment with nosniff and a sandbox CSP (the
//    stored-XSS guard) and never carries a storage location;
//  - a refusal (403, 404, a platform fault, an unreachable platform, a bad id, no session) is a sentence with
//    the right status, never a 500 and never an empty body;
//  - DEMO_MODE answers a small placeholder through the same headers.
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", () => ({
  getMe: vi.fn(async () => ({ userId: "u-1", companies: [], roles: [] })),
  platformAuthHeaders: vi.fn(async () => ({ authorization: "Bearer tok-u1" })),
}));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("@/lib/demoMode", () => ({ isDemoMode: vi.fn(() => false) }));

import { getSessionUserId } from "@/lib/session-server";
import { getActiveTenant } from "@/lib/tenant";
import { isDemoMode } from "@/lib/demoMode";
import { GET } from "./route";

const fetchMock = vi.fn();
const call = (fileId: string) => GET(new Request(`http://ui.test/api/files/${fileId}`), { params: Promise.resolve({ fileId }) });
const pdf = (headers: Record<string, string> = {}) =>
  new Response(new Uint8Array([37, 80, 68, 70]), {
    status: 200,
    headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="MSA.pdf"`, ...headers },
  });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(getSessionUserId).mockResolvedValue("u-1");
  vi.mocked(getActiveTenant).mockResolvedValue("co-1");
  vi.mocked(isDemoMode).mockReturnValue(false);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/files/:fileId (staff download)", () => {
  it("🔴 forwards the caller's auth to the platform's content route for the active company, and returns the bytes", async () => {
    fetchMock.mockResolvedValue(pdf());
    const res = await call("f-123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/co-1\/files\/f-123\/content$/);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-u1");
    expect(res.status).toBe(200);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([37, 80, 68, 70]);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="MSA.pdf"`);
  });

  it("🔴 keeps nosniff, a sandbox CSP and no-store on the response", async () => {
    fetchMock.mockResolvedValue(pdf());
    const res = await call("f-1");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toMatch(/sandbox/);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
  });

  it("🔴 stays an attachment with nosniff even if the platform sent an inline html file", async () => {
    fetchMock.mockResolvedValue(pdf({ "content-type": "text/html", "content-disposition": "inline" }));
    const res = await call("f-1");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("never uses the URL for the company: it asks the platform only for the active company", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue("co-9");
    fetchMock.mockResolvedValue(pdf());
    await call("f-1");
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/co-9\/files\//);
  });

  it("🔴 a refused read (403) answers 403 in words, not a 500", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 }));
    const res = await call("f-1");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/do not have permission/);
  });

  it("a missing file (404) says it cannot be found", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 404 }));
    const res = await call("f-1");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/cannot be found/);
  });

  it("a platform fault (500) becomes a 502 with a sentence, and the platform's body is not echoed", async () => {
    fetchMock.mockResolvedValue(new Response("secret stack trace", { status: 500 }));
    const res = await call("f-1");
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toMatch(/could not serve this file/);
    expect(text).not.toContain("secret stack trace");
  });

  it("an unreachable platform is a 502 with a sentence", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await call("f-1");
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/could not be reached/);
  });

  it("🔴 an id that is not a plain token never reaches the platform", async () => {
    for (const bad of ["../../admin", "a.b", "f 1", "a?x=1", "x".repeat(65)]) {
      const res = await call(bad);
      expect(res.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no session is a 401 in words and no platform call", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null as never);
    const res = await call("f-1");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toMatch(/Sign in again/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("DEMO_MODE answers a labelled placeholder as an attachment, with the same safety headers", async () => {
    vi.mocked(isDemoMode).mockReturnValue(true);
    const res = await call("f-1");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/DEMO MODE/);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="demo-f-1\.txt"/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
