import { describe, it, expect, vi, beforeEach } from "vitest";

// The server reads: one visitor's recordings (words for every failure) and the site's domains for the player's policy.

vi.mock("./platform", () => {
  class PlatformError extends Error {
    constructor(public status: number, message: string, public field?: string, public existing?: unknown, public reason?: string, public body?: unknown) { super(message); }
  }
  return { PlatformError, platformFetch: vi.fn() };
});
vi.mock("./webdeskContent", () => ({ listSites: vi.fn(), resultFromError: vi.fn(() => ({ kind: "unavailable", code: "network", reason: "boom" })) }));
vi.mock("./visitors", () => ({ resolveProperty: vi.fn() }));

import { PlatformError, platformFetch } from "./platform";
import { listSites } from "./webdeskContent";
import { resolveProperty } from "./visitors";
import { readRecordings, resolveSiteForReplay } from "./replays";

const P = "0194a3b2-aaaa-7000-8000-00000000000a";
const V = "0194a3b2-1111-7000-8000-000000000001";
const R = "0194a3b2-bbbb-7000-8000-0000000000b1";
const list = (recordings: unknown[]) => ({ propertyId: P, visitorId: V, recordings });
const rec = { recordingId: R, startedAt: "2026-10-12T09:00:00.000Z", lastChunkAt: "2026-10-12T09:03:20.000Z", durationSeconds: 200, pages: ["https://gaiada.com/"], chunks: 20 };
const fetchMock = vi.mocked(platformFetch);
beforeEach(() => { fetchMock.mockReset(); vi.mocked(listSites).mockReset(); vi.mocked(resolveProperty).mockReset(); });

describe("readRecordings", () => {
  it("reads GET …/visitors/:id/recordings with the user's own authority", async () => {
    fetchMock.mockResolvedValue(list([rec]));
    const r = await readRecordings("u", "co-1", P, V);
    expect(fetchMock).toHaveBeenCalledWith(`/api/co-1/modules/search/properties/${P}/visitors/${V}/recordings`, "u");
    expect(r).toMatchObject({ kind: "ok", list: { recordings: [{ recordingId: R, durationSeconds: 200 }] } });
  });

  it("an empty list stays an empty list (the store answered)", async () => {
    fetchMock.mockResolvedValue(list([]));
    expect(await readRecordings("u", "co-1", P, V)).toMatchObject({ kind: "ok", list: { recordings: [] } });
  });

  it("404 is 'visitor not found'; 403, 503 and a network failure are words", async () => {
    fetchMock.mockRejectedValue(new PlatformError(404, "x", undefined, undefined, "visitor_not_found"));
    expect(await readRecordings("u", "co-1", P, V)).toEqual({ kind: "visitor_not_found" });

    fetchMock.mockRejectedValue(new PlatformError(403, "x"));
    expect(await readRecordings("u", "co-1", P, V)).toMatchObject({ kind: "failed", failure: { kind: "forbidden" }, message: expect.stringMatching(/do not have access/) });

    fetchMock.mockRejectedValue(new PlatformError(503, "x", undefined, undefined, "collector_rejected"));
    const r = await readRecordings("u", "co-1", P, V);
    expect(r).toMatchObject({ kind: "failed", failure: { kind: "unavailable", reason: "collector_rejected" } });
    expect((r as { message: string }).message).toMatch(/refused/);
    expect((r as { message: string }).message).not.toContain("collector_rejected");

    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect(await readRecordings("u", "co-1", P, V)).toMatchObject({ kind: "failed", failure: { kind: "unavailable" } });
  });

  it("an off-contract body is a defect, not an empty list", async () => {
    fetchMock.mockResolvedValue({ recordings: [{ recordingId: "x" }] });
    expect(await readRecordings("u", "co-1", P, V)).toMatchObject({ kind: "drift" });
  });
});

describe("resolveSiteForReplay", () => {
  const sites = { kind: "ok", data: { tenants: [{ slug: "gaiada", sites: [{ siteId: "site-1", name: "gaiada.com", environments: [{ envId: "e1", name: "live", domain: "gaiada.com", status: "live" }, { envId: "e2", name: "staging", domain: null, status: "x" }, { envId: "e3", name: "s", domain: "staging.gaiada.com", status: "x" }] }] }] } };

  it("returns the property and the site's non-null environment domains", async () => {
    vi.mocked(listSites).mockResolvedValue(sites as never);
    vi.mocked(resolveProperty).mockResolvedValue({ kind: "ok", property: { id: P, domain: "gaiada.com", umamiSiteId: "u" } } as never);
    const r = await resolveSiteForReplay("u", "co-1", "gaiada", "site-1");
    expect(r).toEqual({ kind: "ok", siteName: "gaiada.com", property: { id: P, domain: "gaiada.com", umamiSiteId: "u" }, domains: ["gaiada.com", "staging.gaiada.com"] });
    expect(vi.mocked(resolveProperty).mock.calls[0][2]).toEqual(["gaiada.com", null, "staging.gaiada.com"]);
  });

  it("a site that is not this company's is no_site (the company wall is listSites)", async () => {
    vi.mocked(listSites).mockResolvedValue(sites as never);
    expect(await resolveSiteForReplay("u", "co-1", "gaiada", "someone-elses")).toEqual({ kind: "no_site" });
    expect(resolveProperty).not.toHaveBeenCalled();
  });

  it("no property is said, and a failed sites read is a refusal", async () => {
    vi.mocked(listSites).mockResolvedValue(sites as never);
    vi.mocked(resolveProperty).mockResolvedValue({ kind: "no_property" });
    expect(await resolveSiteForReplay("u", "co-1", "gaiada", "site-1")).toEqual({ kind: "no_property", siteName: "gaiada.com" });
    vi.mocked(listSites).mockResolvedValue({ kind: "unavailable", code: "network", reason: "down" } as never);
    expect(await resolveSiteForReplay("u", "co-1", "gaiada", "site-1")).toMatchObject({ kind: "unavailable" });
  });
});
