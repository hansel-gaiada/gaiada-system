import { describe, it, expect, vi, beforeEach } from "vitest";

// The rules write: through platformFetch PUT, only the API's own keys, authorize-first (a 403 is a sentence), refusals as sentences.

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
import { saveInterestRulesAction } from "./visitorsActions";

const P = "0194a3b2-aaaa-7000-8000-00000000000a";
const meOf = (role: string) => ({ userId: "u", name: "U", email: "u@x.com", title: null, assurance: "high", companies: [], roles: [{ role, scopeType: "company", scopeId: "co-1" }] });
const draft = { match: "path_prefix", pattern: "/a/", facet: "service", tag: "web", weight: 2 } as const;
const okBody = { propertyId: P, removed: 0, note: "Interests and scores follow the new rules at the next daily refresh.", rules: [{ id: "r1", ...draft }] };

beforeEach(() => {
  vi.mocked(getSessionUserId).mockReset().mockResolvedValue("u");
  vi.mocked(getActiveTenant).mockReset().mockResolvedValue("co-1");
  vi.mocked(getMe).mockReset().mockResolvedValue(meOf("search_manager") as never);
  vi.mocked(platformFetch).mockReset();
});

describe("saveInterestRulesAction", () => {
  it("PUTs exactly {rules} to the property's interest-rules route and returns the saved set", async () => {
    vi.mocked(platformFetch).mockResolvedValue(okBody);
    const r = await saveInterestRulesAction(P, [{ ...draft, ...({ extra: "dropped" } as object) } as never]);
    expect(r).toEqual({ ok: true, rules: [{ id: "r1", ...draft }], note: okBody.note });
    const [path, userId, init] = vi.mocked(platformFetch).mock.calls[0];
    expect(path).toBe(`/api/co-1/modules/search/properties/${P}/visitors/interest-rules`);
    expect(userId).toBe("u");
    expect((init as RequestInit).method).toBe("PUT");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ rules: [draft] });
  });

  it("a viewer without read_visitors is refused in words and nothing is sent", async () => {
    vi.mocked(getMe).mockResolvedValue(meOf("search_staff") as never);
    const r = await saveInterestRulesAction(P, [draft]);
    expect(r).toEqual({ ok: false, message: "You are not allowed to change the interest rules." });
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("the server's 403 is a sentence", async () => {
    vi.mocked(platformFetch).mockRejectedValue(new PlatformError(403, "cerbos denied update on resource_search_property"));
    expect(await saveInterestRulesAction(P, [draft])).toEqual({ ok: false, message: "You are not allowed to change the interest rules." });
  });

  it("a typed 400 reason becomes its sentence, never the code", async () => {
    vi.mocked(platformFetch).mockRejectedValue(new PlatformError(400, "rules[0].tag must be lower-case", undefined, undefined, "rule_tag_invalid"));
    const r = await saveInterestRulesAction(P, [draft]);
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toContain("lower-case letters");
    expect((r as { message: string }).message).not.toContain("rule_tag_invalid");
  });

  it("an off-contract success body is said, not swallowed", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ nope: true });
    const r = await saveInterestRulesAction(P, [draft]);
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toContain("did not match");
  });

  it("an outage is a sentence that says nothing was changed", async () => {
    vi.mocked(platformFetch).mockRejectedValue(new Error("fetch failed"));
    const r = await saveInterestRulesAction(P, [draft]);
    expect((r as { message: string }).message).toContain("Nothing was changed");
  });

  it("an invalid draft or property id never reaches the network", async () => {
    expect((await saveInterestRulesAction(P, [{ ...draft, tag: "Bad Tag" }])).ok).toBe(false);
    expect((await saveInterestRulesAction("not-a-uuid", [draft])).ok).toBe(false);
    expect((await saveInterestRulesAction(P, "nope" as never)).ok).toBe(false);
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("no session is a sentence", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null as never);
    expect((await saveInterestRulesAction(P, [draft]) as { message: string }).message).toContain("Sign in");
  });
});
