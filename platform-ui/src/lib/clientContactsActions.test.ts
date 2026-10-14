import { describe, it, expect, vi, beforeEach } from "vitest";

// PV5-F4 - inviting someone who already has access is refused by the platform (409 already_active); the PM is told in
// plain words and nothing else happens. A fresh invitation still hands over the link.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn(async () => ({ userId: "u1", assurance: "high", roles: [], companies: [] })) };
});

import { platformFetch, PlatformError } from "./platform";
import { inviteClientContactAction } from "./clientContactsActions";

const fetchMock = vi.mocked(platformFetch);
const form = (fields: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

beforeEach(() => { fetchMock.mockReset(); });

describe("inviteClientContactAction", () => {
  it("a 409 already_active says the person already has access and that nothing changed, not the raw API text", async () => {
    fetchMock.mockRejectedValue(new PlatformError(409, "raw api wording", undefined, undefined, "already_active"));
    const r = await inviteClientContactAction(null, form({ clientId: "c1", email: "ana@client.test", capability: "signer" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("ana@client.test already has access");
    expect(r.error).toMatch(/nothing changed/);
    expect(r.error).toMatch(/revoke/i);
    expect(r.error).not.toContain("raw api wording");
  });

  it("any other refusal still shows the API's own message", async () => {
    fetchMock.mockRejectedValue(new PlatformError(400, "a valid email is required"));
    const r = await inviteClientContactAction(null, form({ clientId: "c1", email: "nope" }));
    expect(r).toEqual({ ok: false, error: "a valid email is required" });
  });

  it("a fresh invitation hands over the link", async () => {
    fetchMock.mockResolvedValue({
      contact: { email: "new@client.test" },
      invite: { token: "t", expiresAt: "2026-10-20T00:00:00Z", acceptPath: "/invite/t" },
    });
    const r = await inviteClientContactAction(null, form({ clientId: "c1", email: "new@client.test" }));
    expect(r).toMatchObject({ ok: true, email: "new@client.test" });
    if (r.ok) expect(r.acceptUrl).toContain("/invite/t");
  });
});
