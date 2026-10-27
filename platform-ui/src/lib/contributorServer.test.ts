import { describe, it, expect, vi, beforeEach } from "vitest";

// M5-W1f: the contributor context. A contributor is in; the fence's refusal of `/api/me` is `fenced`; everyone else is sent away.
vi.mock("next/navigation", () => ({ redirect: vi.fn((to: string) => { throw new Error(`redirect:${to}`); }) }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", async () => ({ ...(await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform")), getMe: vi.fn() }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));

import { getMe, PlatformError, type Me } from "@/lib/platform";
import { getSessionUserId } from "@/lib/session-server";
import { contributorCtx } from "./contributorServer";

const me = (over: Partial<Me> = {}): Me => ({ userId: "u-1", name: "Ayu", email: "a@x", title: null, assurance: "high", companies: [{ id: "co-1", name: "Co", type: null }], roles: [{ role: "webdesk_writer", scopeType: "company", scopeId: "co-1" }], kind: "contributor", ...over });
beforeEach(() => { vi.mocked(getMe).mockReset(); vi.mocked(getSessionUserId).mockResolvedValue("u-1"); });

describe("contributorCtx", () => {
  it("a contributor is ok, with the active company", async () => {
    vi.mocked(getMe).mockResolvedValue(me());
    expect(await contributorCtx()).toMatchObject({ kind: "ok", userId: "u-1", company: "co-1" });
  });
  it("the fence's refusal of /api/me is `fenced` with its reason", async () => {
    vi.mocked(getMe).mockRejectedValue(new PlatformError(403, "contributor_route_forbidden", undefined, undefined, "assurance_high_required", { error: "contributor_route_forbidden", reason: "assurance_high_required" }));
    expect(await contributorCtx()).toEqual({ kind: "fenced", reason: "assurance_high_required" });
  });
  it("staff (an employee with the same role) is sent to the workspace, not shown the contributor screens", async () => {
    vi.mocked(getMe).mockResolvedValue(me({ kind: "employee" }));
    await expect(contributorCtx()).rejects.toThrow("redirect:/");
  });
  it("a client is sent to '/' too (which routes them on to the portal)", async () => {
    vi.mocked(getMe).mockResolvedValue(me({ kind: "employee", roles: [{ role: "client", scopeType: "global", scopeId: null }] }));
    await expect(contributorCtx()).rejects.toThrow("redirect:/");
  });
  it("no session, or any other failure of /api/me, goes to /login", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null as unknown as string);
    await expect(contributorCtx()).rejects.toThrow("redirect:/login");
    vi.mocked(getSessionUserId).mockResolvedValue("u-1");
    vi.mocked(getMe).mockRejectedValue(new PlatformError(500, "boom"));
    await expect(contributorCtx()).rejects.toThrow("redirect:/login");
  });
});
