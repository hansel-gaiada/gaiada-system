import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// M5-W1q2 (WSK-D84): the reviewer's thumbnail of a quarantined upload. Pinned: the caller's auth goes to the platform's `review-preview` route of the ACTIVE
// company (never a company from the URL); the response carries EXACTLY the six headers, re-set from an allow-list and never copied from upstream
// (so a hostile upstream header, a different content type, a cookie or an attachment disposition does not survive); only a raster type is served; a
// refusal is a sentence with the right status and never a 500; a bad segment never reaches the platform; no session is 401.
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", () => ({
  getMe: vi.fn(async () => ({ userId: "u-1", companies: [], roles: [] })),
  platformAuthHeaders: vi.fn(async () => ({ authorization: "Bearer tok-u1" })),
}));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("@/lib/demoMode", () => ({ isDemoMode: vi.fn(() => false) }));

import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { isDemoMode } from "@/lib/demoMode";
import { GET } from "./route";

const fetchMock = vi.fn();
const ASSET = "0b9d6c52-8c2e-4c0e-9a6e-3a0b8f1d4e77";
const SITE = "7a7a7a7a-3d4a-4b5c-8d6e-7f8091a2b3c4";
const call = (tenantSlug = "gaiada", siteId = SITE, assetId = ASSET) =>
  GET(new Request(`http://ui.test/api/webdesk-media-preview/${tenantSlug}/${siteId}/${assetId}`), { params: Promise.resolve({ tenantSlug, siteId, assetId }) });
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const SIX = {
  "content-type": "image/png",
  "x-content-type-options": "nosniff",
  "content-security-policy": "sandbox; default-src 'none'",
  "content-disposition": 'inline; filename="preview.png"',
  "cache-control": "private, no-store",
  "cross-origin-resource-policy": "same-origin",
};

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

describe("GET /api/webdesk-media-preview/:tenantSlug/:siteId/:assetId", () => {
  it("forwards the caller's auth to the review-preview route of the ACTIVE company, and serves the bytes with exactly the six headers", async () => {
    fetchMock.mockResolvedValue(new Response(png, { status: 200, headers: { "content-type": "image/png" } }));
    const res = await call();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(new RegExp(`/api/co-1/modules/webdev/content/sites/gaiada/${SITE}/media/${ASSET}/review-preview$`));
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-u1");
    expect(init.redirect).toBe("manual");
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(png))).toBe(true);
    const got: Record<string, string> = {};
    res.headers.forEach((v, k) => { got[k] = v; });
    expect(got).toEqual(SIX); // exactly these six, and no others (no content-length, no cookie, nothing upstream)
    expect(res.headers.get("content-disposition")).toMatch(/^inline;/); // inline, NOT attachment
  });

  it("the company is the caller's active one: a company-looking value in the URL never reaches the platform path", async () => {
    fetchMock.mockResolvedValue(new Response(png, { status: 200, headers: { "content-type": "image/png" } }));
    await call("co-9", SITE, ASSET); // an attacker-chosen first segment is only a WebDesk tenant slug
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/co-1\/modules\/webdev\/content\/sites\/co-9\//);
    expect(url).not.toMatch(/\/api\/co-9\//);
  });

  it("NO upstream header is copied: a hostile type parameter, cookie, disposition, CSP, CORS grant, validator and length are all dropped", async () => {
    fetchMock.mockResolvedValue(
      new Response(png, {
        status: 200,
        headers: {
          "content-type": "image/png; charset=evil",
          "set-cookie": "sid=stolen; Path=/",
          "content-disposition": 'attachment; filename="../../evil.html"',
          "content-security-policy": "default-src *",
          "access-control-allow-origin": "*",
          "access-control-allow-credentials": "true",
          etag: '"abc"',
          "last-modified": "Wed, 21 Oct 2015 07:28:00 GMT",
          "cache-control": "public, max-age=31536000",
          "x-webdesk-internal": "leak",
          link: "<https://evil.example>; rel=preload",
          "content-length": String(png.length),
        },
      }),
    );
    const res = await call();
    expect(res.status).toBe(200);
    const got: Record<string, string> = {};
    res.headers.forEach((v, k) => { got[k] = v; });
    expect(got).toEqual(SIX);
    for (const h of ["set-cookie", "access-control-allow-origin", "access-control-allow-credentials", "etag", "last-modified", "x-webdesk-internal", "link", "content-length"]) {
      expect(res.headers.get(h), h).toBeNull();
    }
  });

  it("serves each of the five raster types as itself with its own fixed file name", async () => {
    for (const [mime, ext] of [["image/png", "png"], ["image/jpeg", "jpg"], ["image/gif", "gif"], ["image/webp", "webp"], ["image/avif", "avif"]] as const) {
      fetchMock.mockResolvedValue(new Response(png, { status: 200, headers: { "content-type": mime } }));
      const res = await call();
      expect(res.status, mime).toBe(200);
      expect(res.headers.get("content-type"), mime).toBe(mime);
      expect(res.headers.get("content-disposition"), mime).toBe(`inline; filename="preview.${ext}"`);
    }
  });

  it("a non-raster type from upstream is NOT served from our origin (svg, html, pdf, none): a 502 in words, no bytes", async () => {
    for (const type of ["image/svg+xml", "text/html", "application/pdf", "application/octet-stream", null]) {
      fetchMock.mockResolvedValue(new Response("<svg><script>alert(1)</script></svg>", { status: 200, headers: type ? { "content-type": type } : {} }));
      const res = await call();
      expect(res.status, String(type)).toBe(502);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      expect(JSON.stringify(await res.json())).not.toContain("<script>");
    }
  });

  it("answers 401 with no session and never calls the platform", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null as never);
    expect((await call()).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 400 with no active company and never calls the platform", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue(null as never);
    expect((await call()).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a failure to look up the caller or the active company is a 502 in words, never 'no company' and never a call to the platform's route", async () => {
    vi.mocked(getMe).mockRejectedValueOnce(new Error("platform down"));
    expect((await call()).status).toBe(502);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an implausible segment without calling the platform (a slash, a dot-dot, a query, an empty one)", async () => {
    for (const [a, b, c] of [["..", SITE, ASSET], ["gaiada", "a/b", ASSET], ["gaiada", SITE, "x?y=1"], ["gaiada", SITE, "x y"], ["", SITE, ASSET]] as const) {
      const res = await call(a, b, c);
      expect(res.status, `${a}|${b}|${c}`).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes the platform's 401/403/404/413/415 through with words, and turns any other fault into a 502 (never a 500)", async () => {
    for (const [upstream, expected] of [[401, 401], [403, 403], [404, 404], [413, 413], [415, 415], [409, 502], [500, 502], [503, 502]] as const) {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "platform words, internal detail" }), { status: upstream, headers: { "content-type": "application/json" } }));
      const res = await call();
      expect(res.status, String(upstream)).toBe(expected);
      const body = (await res.json()) as { error: string };
      expect(body.error.length).toBeGreaterThan(10);
      expect(body.error).not.toContain("internal detail"); // the platform's text is not echoed
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-security-policy")).toBeNull();
    }
  });

  it("answers 502 in words when the platform cannot be reached", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    expect((await call()).status).toBe(502);
  });

  it("demo mode holds no upload bytes: a 404 and no platform call", async () => {
    vi.mocked(isDemoMode).mockReturnValue(true);
    expect((await call()).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
