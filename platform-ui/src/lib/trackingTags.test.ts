import { describe, it, expect, vi, beforeEach } from "vitest";

// The Tracking tags read: the view when the answer is on-contract, a sentence for everything else. Never an empty value.

vi.mock("./platform", () => {
  class PlatformError extends Error {
    constructor(public status: number, message: string, public field?: string, public existing?: unknown, public reason?: string, public body?: unknown) { super(message); }
  }
  return { PlatformError, platformFetch: vi.fn() };
});

import { PlatformError, platformFetch } from "./platform";
import { findTrackingSite, readTrackingTags } from "./trackingTags";

const target = { repo: "gaiadabali/gaiada-web-revamp", variable: "PUBLIC_LINKEDIN_PARTNER_ID" };
beforeEach(() => { vi.mocked(platformFetch).mockReset(); });

describe("readTrackingTags", () => {
  it("asks the property's tracking-tags route with the site, and returns the parsed view", async () => {
    const googleAds = { ids: ["AW-123456789"], conversions: { lead: "AW-123456789/abc" } };
    vi.mocked(platformFetch).mockResolvedValue({ linkedin: { partnerId: "42" }, googleAds, target, canManage: true, state: "ok" });
    const r = await readTrackingTags("u", "co-1", "p-1", "gaiada", "site-1");
    expect(r).toEqual({ state: "ok", data: { linkedin: { partnerId: "42" }, googleAds, target, canManage: true, state: "ok", reason: null } });
    expect(vi.mocked(platformFetch).mock.calls[0][0]).toBe("/api/co-1/modules/search/properties/p-1/tracking-tags?webdeskTenant=gaiada&site=site-1");
    expect(vi.mocked(platformFetch).mock.calls[0][1]).toBe("u");
  });

  it("an off-contract body is a defect sentence, not 'Not set'", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ nope: 1 });
    const r = await readTrackingTags("u", "co-1", "p-1", "gaiada", "site-1");
    expect(r.state).toBe("unavailable");
    expect((r as { message: string }).message).toContain("did not match the contract");
  });

  it("a refusal is words (a 409 mismatch, a 403, an outage)", async () => {
    vi.mocked(platformFetch).mockRejectedValue(new PlatformError(409, "x", undefined, undefined, "tracking_site_mismatch"));
    expect(((await readTrackingTags("u", "c", "p", "g", "s")) as { message: string }).message).toMatch(/not the one for this website/);
    vi.mocked(platformFetch).mockRejectedValue(new PlatformError(403, "denied"));
    expect(((await readTrackingTags("u", "c", "p", "g", "s")) as { message: string }).message).toMatch(/do not have access/);
    vi.mocked(platformFetch).mockRejectedValue(new Error("boom"));
    expect(((await readTrackingTags("u", "c", "p", "g", "s")) as { message: string }).message).toMatch(/could not be read just now/);
  });
});

describe("findTrackingSite (M5-P4g)", () => {
  const site = { webdeskTenant: "gaiada", site: "site-1", name: "gaiada.com" };
  it("asks the property's tracking-tags/site route and returns the site, or null as a real answer", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ site });
    expect(await findTrackingSite("u", "co-1", "p-1")).toEqual({ kind: "ok", data: { site } });
    expect(vi.mocked(platformFetch).mock.calls[0][0]).toBe("/api/co-1/modules/search/properties/p-1/tracking-tags/site");
    expect(vi.mocked(platformFetch).mock.calls[0][1]).toBe("u");
    vi.mocked(platformFetch).mockResolvedValue({ site: null });
    expect(await findTrackingSite("u", "co-1", "p-1")).toEqual({ kind: "ok", data: { site: null } });
  });

  it("an off-contract body is an unavailable sentence, never 'no website'", async () => {
    for (const bad of [{}, null, "x", { site: "gaiada" }, { site: { webdeskTenant: "g" } }, { site: { webdeskTenant: "", site: "s", name: "n" } }]) {
      vi.mocked(platformFetch).mockResolvedValue(bad);
      const r = await findTrackingSite("u", "c", "p");
      expect(r.kind, JSON.stringify(bad)).toBe("unavailable");
      expect((r as { message: string }).message).toContain("did not match the contract");
    }
  });

  it("a 403 is forbidden, a 503 / 404 / outage are unavailable, each in words", async () => {
    vi.mocked(platformFetch).mockRejectedValue(new PlatformError(403, "denied"));
    expect(await findTrackingSite("u", "c", "p")).toEqual({ kind: "forbidden", message: expect.stringMatching(/do not have access/) });
    vi.mocked(platformFetch).mockRejectedValue(new PlatformError(503, "x", undefined, undefined, "tracking_sites_unavailable"));
    expect(await findTrackingSite("u", "c", "p")).toEqual({ kind: "unavailable", message: expect.stringMatching(/could not list this company's websites/) });
    vi.mocked(platformFetch).mockRejectedValue(new PlatformError(404, "x", undefined, undefined, "property_not_found"));
    expect((await findTrackingSite("u", "c", "p")).kind).toBe("unavailable");
    vi.mocked(platformFetch).mockRejectedValue(new Error("boom"));
    expect(await findTrackingSite("u", "c", "p")).toEqual({ kind: "unavailable", message: expect.stringMatching(/could not be looked up/) });
  });
});
