import { describe, it, expect, vi, beforeEach } from "vitest";

const getSessionUserId = vi.fn();
const getMe = vi.fn();
const platformFetch = vi.fn();
const isElevated = vi.fn();
const revalidatePath = vi.fn();

vi.mock("@/lib/session-server", () => ({ getSessionUserId: () => getSessionUserId() }));
vi.mock("@/lib/rbac", () => ({ isElevated: (me: unknown) => isElevated(me) }));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));
vi.mock("@/lib/platform", async () => {
  const actual = await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform");
  return {
    ...actual,
    getMe: (userId: string) => getMe(userId),
    platformFetch: (path: string, userId: string, init?: RequestInit) => platformFetch(path, userId, init),
  };
});

import { updateBotGroups } from "./group-actions";
import { PlatformError } from "@/lib/platform";

const GROUPS = [
  { id: "111@g.us", name: "Ops", category: "internal", isManagement: false },
  { id: "222@g.us", name: "Client A", category: "client", isManagement: true },
];

describe("updateBotGroups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionUserId.mockResolvedValue("u1");
    getMe.mockResolvedValue({ roles: [] });
    isElevated.mockReturnValue(true);
  });

  it("PUTs the full replacement group list to api/admin/bot/groups", async () => {
    platformFetch.mockResolvedValue({});
    const result = await updateBotGroups(GROUPS);

    expect(platformFetch).toHaveBeenCalledWith(
      "/api/admin/bot/groups",
      "u1",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ groups: GROUPS }) }),
    );
    expect(result).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith("/systems/bot");
  });

  it("blocks non-elevated callers before ever calling platformFetch", async () => {
    isElevated.mockReturnValue(false);
    const result = await updateBotGroups(GROUPS);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/limited to superadmins\/owners/i);
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("returns session-expired without calling platformFetch when unauthenticated", async () => {
    getSessionUserId.mockResolvedValue(null);
    const result = await updateBotGroups(GROUPS);

    expect(result).toEqual({ ok: false, error: "Session expired — sign in again." });
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("surfaces a 400 {error, field} validation failure with the field name attached", async () => {
    platformFetch.mockRejectedValue(new PlatformError(400, "at most one management group allowed", "isManagement"));
    const result = await updateBotGroups(GROUPS);

    expect(result).toEqual({
      ok: false,
      error: "at most one management group allowed",
      field: "isManagement",
    });
  });

  it("degrades to a friendly message on 404/502 (bot unconfigured/unreachable)", async () => {
    platformFetch.mockRejectedValue(new PlatformError(502, "bot admin unreachable"));
    const result = await updateBotGroups(GROUPS);

    expect(result).toEqual({ ok: false, error: "The bot isn't reachable right now — try again shortly." });
  });
});
