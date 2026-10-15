import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// DW-4k — the report export download route. What is pinned:
//  - it forwards the caller's session auth to the platform's export download for the ACTIVE company;
//  - the platform's content type and attachment name pass through, with nosniff, a sandbox CSP and no-store, and the
//    body is the platform's stream;
//  - a refusal keeps the platform's status (400/403/404/422/5xx) and its sentence, as JSON with no attachment
//    headers, so a failed export never looks like a download; no session is 401;
//  - DEMO_MODE answers a small placeholder that says it is one.
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
const JOB = "550e8400-e29b-41d4-a716-446655440000";
const call = (jobId: string) => GET(new Request(`http://ui.test/api/reports/exports/${jobId}`), { params: Promise.resolve({ jobId }) });
const xlsx = (headers: Record<string, string> = {}) =>
  new Response(new Uint8Array([80, 75, 3, 4]), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": "attachment; filename=\"Web Dev - July 2026 - AD HOC.xlsx\"; filename*=UTF-8''Web%20Dev.xlsx",
      ...headers,
    },
  });
const refusal = (status: number, error?: string) =>
  new Response(error ? JSON.stringify({ error }) : "", { status, headers: { "content-type": "application/json" } });

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

describe("GET /api/reports/exports/:jobId", () => {
  it("forwards the caller's auth to the platform's download for the active company and returns the bytes", async () => {
    fetchMock.mockResolvedValue(xlsx());
    const res = await call(JOB);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(new RegExp(`/api/co-1/reports/exports/${JOB}/download$`));
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-u1");
    expect(res.status).toBe(200);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([80, 75, 3, 4]);
  });

  it("passes the content type and the attachment name through, and keeps nosniff, a sandbox CSP and no-store", async () => {
    fetchMock.mockResolvedValue(xlsx());
    const res = await call(JOB);
    expect(res.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="Web Dev - July 2026 - AD HOC\.xlsx"/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toMatch(/sandbox/);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
  });

  it("never uses the URL for the company: it asks the platform only for the active company", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue("co-9");
    fetchMock.mockResolvedValue(xlsx());
    await call(JOB);
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/co-9\/reports\//);
  });

  it.each([
    [403, "forbidden"],
    [404, "export job not found"],
    [422, "range_too_large"],
  ])("a %i from the platform stays a %i, with the platform's sentence, as JSON and not an attachment", async (status, sentence) => {
    fetchMock.mockResolvedValue(refusal(status, sentence));
    const res = await call(JOB);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: sentence });
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(res.headers.get("content-type")).toMatch(/json/);
  });

  it("a platform fault keeps its 5xx status; with no sentence of its own the answer is in words, not a blank page", async () => {
    fetchMock.mockResolvedValue(refusal(503));
    const res = await call(JOB);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error.length).toBeGreaterThan(20);
  });

  it("a redirect from the platform is a 502, and an unreachable platform is a 502", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 307, headers: { location: "/login" } }));
    expect((await call(JOB)).status).toBe(502);
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect((await call(JOB)).status).toBe(502);
  });

  it("no session is 401 and the platform is never called", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null as unknown as string);
    const res = await call(JOB);
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a malformed job id is 400 and never reaches the platform; no active company is 400", async () => {
    expect((await call("a.b")).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.mocked(getActiveTenant).mockResolvedValue(null as unknown as string);
    expect((await call(JOB)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("DEMO_MODE answers a text placeholder that says it is not a report, as an attachment, with no platform call", async () => {
    vi.mocked(isDemoMode).mockReturnValue(true);
    const res = await call("demo-pdf");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="demo-report-export-pdf.txt"');
    const text = await res.text();
    expect(text).toMatch(/^DEMO MODE: this is a placeholder, not a report\./);
    expect(text).toMatch(/PDF/);
  });
});
