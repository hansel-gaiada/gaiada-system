import { describe, it, expect, vi, beforeEach } from "vitest";

// The LinkedIn partner id's write: PUT exactly {webdeskTenant, site, partnerId}, capability and input checked first (nothing sent on a
// refusal), every server refusal a sentence, an off-contract answer said.

vi.mock("./session-server", () => ({ getSessionUserId: vi.fn() }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn() }));
vi.mock("./platform", () => {
  class PlatformError extends Error {
    constructor(public status: number, message: string, public field?: string, public existing?: unknown, public reason?: string, public body?: unknown) { super(message); }
  }
  return { PlatformError, getMe: vi.fn(), platformFetch: vi.fn() };
});

import { getSessionUserId } from "./session-server";
import { getActiveTenant } from "./tenant";
import { PlatformError, getMe, platformFetch } from "./platform";
import { saveLinkedinPartnerIdAction } from "./trackingTagsActions";

const P = "0194a3b2-aaaa-7000-8000-00000000000a";
const SITE = "0194a3b2-bbbb-7000-8000-00000000000b";
const meOf = (role: string) => ({ userId: "u", name: "U", email: "u@x.com", title: null, assurance: "high", companies: [], roles: [{ role, scopeType: "company", scopeId: "co-1" }] });
const target = { repo: "gaiadabali/gaiada-web-revamp", variable: "PUBLIC_LINKEDIN_PARTNER_ID" };
const ok = (result: string, partnerId: string | null) => ({ linkedin: { partnerId }, target, result, takesEffect: "next_rebuild" });
const args = (partnerId: string | null) => ({ propertyId: P, webdeskTenant: "gaiada", site: SITE, partnerId });

beforeEach(() => {
  vi.mocked(getSessionUserId).mockReset().mockResolvedValue("u");
  vi.mocked(getActiveTenant).mockReset().mockResolvedValue("co-1");
  vi.mocked(getMe).mockReset().mockResolvedValue(meOf("search_manager") as never);
  vi.mocked(platformFetch).mockReset();
});

describe("saveLinkedinPartnerIdAction", () => {
  it("PUTs exactly {webdeskTenant, site, partnerId} to the property's linkedin route and says it reaches the site at the next rebuild", async () => {
    vi.mocked(platformFetch).mockResolvedValue(ok("set", "1234567"));
    const r = await saveLinkedinPartnerIdAction(args(" 1234567 "));
    expect(r).toMatchObject({ ok: true, partnerId: "1234567", result: "set" });
    expect((r as { message: string }).message).toMatch(/next rebuild/);
    const [path, userId, init] = vi.mocked(platformFetch).mock.calls[0];
    expect(path).toBe(`/api/co-1/modules/search/properties/${P}/tracking-tags/linkedin`);
    expect(userId).toBe("u");
    expect((init as RequestInit).method).toBe("PUT");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ webdeskTenant: "gaiada", site: SITE, partnerId: "1234567" });
  });

  it("Clear sends partnerId null", async () => {
    vi.mocked(platformFetch).mockResolvedValue(ok("cleared", null));
    const r = await saveLinkedinPartnerIdAction(args(null));
    expect(r).toMatchObject({ ok: true, partnerId: null, result: "cleared" });
    expect(JSON.parse((vi.mocked(platformFetch).mock.calls[0][2] as RequestInit).body as string).partnerId).toBeNull();
  });

  it("a viewer without search.tags.manage is refused in words and nothing is sent", async () => {
    vi.mocked(getMe).mockResolvedValue(meOf("search_staff") as never);
    const r = await saveLinkedinPartnerIdAction(args("42"));
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/not allowed to change tracking tags/) });
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("a bad id is refused in plain words before any request", async () => {
    for (const bad of ["12a", "", "1".repeat(16)]) {
      const r = await saveLinkedinPartnerIdAction(args(bad));
      expect(r.ok, bad).toBe(false);
      expect((r as { message: string }).message.length).toBeGreaterThan(20);
    }
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("a malformed property or site never reaches the server", async () => {
    expect((await saveLinkedinPartnerIdAction({ ...args("42"), propertyId: "nope" })).ok).toBe(false);
    expect((await saveLinkedinPartnerIdAction({ ...args("42"), site: "nope" })).ok).toBe(false);
    expect((await saveLinkedinPartnerIdAction({ ...args("42"), webdeskTenant: "Bad Slug" })).ok).toBe(false);
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("no session and no company are sentences", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null as never);
    expect((await saveLinkedinPartnerIdAction(args("42"))).ok).toBe(false);
    vi.mocked(getSessionUserId).mockResolvedValue("u");
    vi.mocked(getActiveTenant).mockResolvedValue(null as never);
    expect(await saveLinkedinPartnerIdAction(args("42"))).toEqual({ ok: false, message: expect.stringMatching(/No company/) });
  });

  it.each([
    [409, "tracking_site_mismatch", /not the one for this website/],
    [409, "no_build_target", /no build repository/],
    [503, "github_permission_missing", /actions_variables/],
    [503, "github_app_not_installed", /cannot see this website's repository/],
    [503, "github_not_configured", /not set up on this server/],
    [403, null, /not allowed/],
  ] as const)("the server's %s %s is a sentence, never the code", async (status, reason, words) => {
    vi.mocked(platformFetch).mockRejectedValue(new PlatformError(status, "server words", undefined, undefined, reason ?? undefined));
    const r = await saveLinkedinPartnerIdAction(args("42"));
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toMatch(words);
    if (reason) expect((r as { message: string }).message).not.toContain(reason);
  });

  it("a reason carried only in the body is still read", async () => {
    vi.mocked(platformFetch).mockRejectedValue(new PlatformError(409, "x", undefined, undefined, undefined, { reason: "tracking_site_mismatch" }));
    expect((await saveLinkedinPartnerIdAction(args("42")) as { message: string }).message).toMatch(/not the one for this website/);
  });

  it("an off-contract success body is said, not swallowed", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ nope: true });
    const r = await saveLinkedinPartnerIdAction(args("42"));
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toContain("did not match");
  });

  it("an outage says nothing was changed", async () => {
    vi.mocked(platformFetch).mockRejectedValue(new Error("network down"));
    const r = await saveLinkedinPartnerIdAction(args("42"));
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toContain("Nothing was changed");
  });
});
