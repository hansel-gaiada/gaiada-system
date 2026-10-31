import { describe, it, expect, vi, beforeEach } from "vitest";

// The Tracking tags read: the view when the answer is on-contract, a sentence for everything else. Never an empty value.

vi.mock("./platform", () => {
  class PlatformError extends Error {
    constructor(public status: number, message: string, public field?: string, public existing?: unknown, public reason?: string, public body?: unknown) { super(message); }
  }
  return { PlatformError, platformFetch: vi.fn() };
});

import { PlatformError, platformFetch } from "./platform";
import { readTrackingTags } from "./trackingTags";

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
