import { describe, it, expect, vi, beforeEach } from "vitest";

// "Check DNS now": POST dns/recheck with no body, the capability checked first (nothing sent on a refusal), the server's 403/404 a sentence,
// an off-contract answer said.

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
import { recheckSiteDnsAction } from "./siteDnsActions";

const SITE = "0194a3b2-bbbb-7000-8000-00000000000b";
const meOf = (role: string) => ({ userId: "u", name: "U", email: "u@x.com", title: null, assurance: "high", companies: [], roles: [{ role, scopeType: "company", scopeId: "co-1" }] });
const task = { id: "l1", siteId: SITE, state: "open", domain: "a.example", taskId: "t1", records: [], assigneeSource: "project_owner", assigneeUserId: null, closedBy: null, closedAt: null, lastCheckedAt: null, lastCheckReason: null, erpSawPointing: false };
const message = (r: unknown) => (r as { message: string }).message;

beforeEach(() => {
  vi.mocked(getSessionUserId).mockReset().mockResolvedValue("u");
  vi.mocked(getActiveTenant).mockReset().mockResolvedValue("co-1");
  vi.mocked(getMe).mockReset().mockResolvedValue(meOf("company_admin") as never);
  vi.mocked(platformFetch).mockReset();
});

describe("recheckSiteDnsAction", () => {
  it("POSTs to the site's dns/recheck route with no body and returns the parsed task and check", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ task, check: { state: "pending", reason: "no_records" } });
    const r = await recheckSiteDnsAction(SITE);
    expect(r).toMatchObject({ ok: true, check: { state: "pending", reason: "no_records" } });
    const [path, userId, init] = vi.mocked(platformFetch).mock.calls[0];
    expect(path).toBe(`/api/co-1/modules/webdev/sites/${SITE}/dns/recheck`);
    expect(userId).toBe("u");
    expect(init).toEqual({ method: "POST" });
  });

  it("a null check comes back as null (nothing to check), not as a failure", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ task: { ...task, state: "none", taskId: null }, check: null });
    expect(await recheckSiteDnsAction(SITE)).toMatchObject({ ok: true, check: null });
  });

  it("a viewer without the capability sends nothing and is told so", async () => {
    vi.mocked(getMe).mockResolvedValue(meOf("member") as never);
    const r = await recheckSiteDnsAction(SITE);
    expect(r).toMatchObject({ ok: false });
    expect(message(r)).toMatch(/not allowed/);
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("a server 403 and 404 are sentences", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "denied"));
    expect(message(await recheckSiteDnsAction(SITE))).toMatch(/not allowed to run the DNS check/);
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(404, "nope"));
    expect(message(await recheckSiteDnsAction(SITE))).toMatch(/not found/);
    vi.mocked(platformFetch).mockRejectedValueOnce(new Error("boom"));
    expect(message(await recheckSiteDnsAction(SITE))).toMatch(/could not be run/);
  });

  it("an off-contract answer is said, and tells the person to reload", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ task: { state: "weird" }, check: null });
    const r = await recheckSiteDnsAction(SITE);
    expect(r).toMatchObject({ ok: false });
    expect(message(r)).toMatch(/did not match the contract/);
    expect(message(r)).toMatch(/Reload/);
  });

  it("no session and no company stop before any call", async () => {
    vi.mocked(getSessionUserId).mockResolvedValueOnce(null as never);
    expect(await recheckSiteDnsAction(SITE)).toMatchObject({ ok: false });
    vi.mocked(getActiveTenant).mockResolvedValueOnce(null as never);
    expect(await recheckSiteDnsAction(SITE)).toMatchObject({ ok: false });
    expect(platformFetch).not.toHaveBeenCalled();
  });
});
