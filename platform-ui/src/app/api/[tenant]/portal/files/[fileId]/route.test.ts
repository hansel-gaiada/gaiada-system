import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// SCP-2 (BFF §63.8): the portal's file route as the browser reaches it (`GET /api/:t/portal/files/:fileId`). What is pinned: it forwards the CALLER's session
// auth to the platform's portal file route for the company in the URL, only when that company is one of the caller's own; it stays an attachment with
// nosniff and a sandbox CSP; only an image may be cached (privately); every refusal is a sentence with the right status; DEMO_MODE serves a generated
// placeholder for a post's image and the staff route's text stand-in for anything else.
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", () => ({
  getMe: vi.fn(async () => ({ userId: "u-1", companies: [], roles: [], clientOf: [{ companyId: "co-1", companyName: "Co" }] })),
  platformAuthHeaders: vi.fn(async () => ({ authorization: "Bearer tok-u1" })),
}));
vi.mock("@/lib/portal-company", () => ({ getPortalCompanies: vi.fn((me: { clientOf?: Array<{ companyId: string; companyName: string }> }) => me.clientOf ?? []) }));
vi.mock("@/lib/demoMode", () => ({ isDemoMode: vi.fn(() => false) }));
vi.mock("@/lib/demoSocialPortal", () => ({ demoPortalSocialFile: vi.fn() }));

import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { isDemoMode } from "@/lib/demoMode";
import { demoPortalSocialFile } from "@/lib/demoSocialPortal";
import { GET } from "./route";

const fetchMock = vi.fn();
const call = (tenant: string, fileId: string) => GET(new Request(`http://ui.test/api/${tenant}/portal/files/${fileId}`), { params: Promise.resolve({ tenant, fileId }) });
const png = (headers: Record<string, string> = {}) => new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { "content-type": "image/png", ...headers } });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(getSessionUserId).mockResolvedValue("u-1");
  vi.mocked(isDemoMode).mockReturnValue(false);
  vi.mocked(demoPortalSocialFile).mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("GET /api/:t/portal/files/:fileId", () => {
  it("🔴 forwards the caller's auth to the platform's PORTAL file route for the company in the URL, and returns the bytes", async () => {
    fetchMock.mockResolvedValue(png());
    const res = await call("co-1", "soc-post-n-3-f1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/co-1\/portal\/files\/soc-post-n-3-f1$/);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-u1");
    expect(res.status).toBe(200);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([137, 80, 78, 71]);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("🔴 a company that is not one of the caller's own is a 404 and nothing is asked of the platform (the route is no oracle for another company's ids)", async () => {
    const res = await call("co-other", "f-1");
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.mocked(getMe).mockResolvedValueOnce({ userId: "u-1", companies: [], roles: [] } as never); // staff: no clientOf
    expect((await call("co-1", "f-1")).status).toBe(404);
  });

  it("🔴 stays an attachment with nosniff and a sandbox CSP, whatever the platform sent", async () => {
    fetchMock.mockResolvedValue(png({ "content-type": "text/html", "content-disposition": "inline" }));
    const res = await call("co-1", "f-1");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toMatch(/sandbox/);
  });

  it("an image may be kept by the browser for five minutes, privately; anything else is never cached", async () => {
    fetchMock.mockResolvedValueOnce(png());
    expect((await call("co-1", "f-1")).headers.get("cache-control")).toBe("private, max-age=300");
    fetchMock.mockResolvedValueOnce(new Response("%PDF", { status: 200, headers: { "content-type": "application/pdf" } }));
    expect((await call("co-1", "f-2")).headers.get("cache-control")).toMatch(/no-store/);
    fetchMock.mockResolvedValueOnce(new Response("<svg/>", { status: 200, headers: { "content-type": "image/svg+xml" } }));
    expect((await call("co-1", "f-3")).headers.get("cache-control")).toMatch(/no-store/); // an SVG is script-capable: never cached as an image
  });

  it("refusals are sentences with the right status: 403, 404, a platform fault as 502 (its body not echoed), an unreachable platform as 502", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 403 }));
    expect(((await (await call("co-1", "f-1")).json()) as { error: string }).error).toMatch(/do not have permission/);
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 404 }));
    expect((await call("co-1", "f-1")).status).toBe(404);
    fetchMock.mockResolvedValueOnce(new Response("secret stack trace", { status: 500 }));
    const fault = await call("co-1", "f-1");
    expect(fault.status).toBe(502);
    expect(await fault.text()).not.toContain("secret stack trace");
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect((await call("co-1", "f-1")).status).toBe(502);
  });

  it("🔴 an id or a company that is not a plain token never reaches anything", async () => {
    for (const bad of ["../../admin", "a.b", "f 1", "a?x=1", "x".repeat(65)]) expect((await call("co-1", bad)).status).toBe(400);
    expect((await call("../co", "f-1")).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no session is a 401, and a session that cannot be turned into a person is a 401 too", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null as never);
    expect((await call("co-1", "f-1")).status).toBe(401);
    vi.mocked(getSessionUserId).mockResolvedValue("u-1");
    vi.mocked(getMe).mockRejectedValueOnce(new Error("platform 401"));
    expect((await call("co-1", "f-1")).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("DEMO_MODE", () => {
  beforeEach(() => vi.mocked(isDemoMode).mockReturnValue(true));

  it("serves a generated placeholder for a post's image, as an attachment with the same safety headers, and asks the platform for nothing", async () => {
    vi.mocked(demoPortalSocialFile).mockReturnValue({ status: 200, svg: "<svg>placeholder</svg>" });
    const res = await call("co-1", "soc-post-n-3-f1");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.mocked(demoPortalSocialFile)).toHaveBeenCalledWith("u-1", "soc-post-n-3-f1");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<svg>placeholder</svg>");
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
  });

  it("an image the demo post does not have, or a post the contact cannot see, is the demo's own 404; staff is 403", async () => {
    vi.mocked(demoPortalSocialFile).mockReturnValueOnce({ status: 404 });
    expect((await call("co-1", "soc-post-n-3-f9")).status).toBe(404);
    vi.mocked(demoPortalSocialFile).mockReturnValueOnce({ status: 403 });
    expect((await call("co-1", "soc-post-n-3-f1")).status).toBe(403);
  });

  it("a file that is not a post's gets the staff route's labelled text stand-in", async () => {
    vi.mocked(demoPortalSocialFile).mockReturnValue(null);
    const res = await call("co-1", "f-contract");
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/DEMO MODE/);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="demo-f-contract\.txt"/);
  });
});
