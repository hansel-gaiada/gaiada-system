import { describe, it, expect, vi, beforeEach } from "vitest";

// requireWebsiteCtx(…, "visitors"): the page 404s where the toolkit lacks the tab AND where the viewer lacks `read_visitors`
// (a search staff member gets a 404, never an empty list). Everything else about the Website context is unchanged.

class NotFound extends Error {}
vi.mock("next/navigation", () => ({ notFound: () => { throw new NotFound("404"); }, redirect: (u: string) => { throw new Error(`redirect ${u}`); } }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn() }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn() }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn() }));
vi.mock("@/lib/departments", () => ({ getDepartment: vi.fn() }));

import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { requireWebsiteCtx } from "./serverCtx";

const meWith = (role: string, scopeId = "co-1") => ({
  userId: "u", name: "U", email: "u@x.com", title: null, assurance: "high",
  companies: [{ id: "co-1", name: "Co", type: "agency", vertical: "agency" }], roles: [{ role, scopeType: "company", scopeId }],
});

function arrange(role: string, deptName = "Web Dev") {
  vi.mocked(getSessionUserId).mockResolvedValue("u");
  vi.mocked(getMe).mockResolvedValue(meWith(role) as never);
  vi.mocked(getActiveTenant).mockResolvedValue("co-1");
  vi.mocked(getDepartment).mockResolvedValue({ id: "dept-1", name: deptName } as never);
}

beforeEach(() => { vi.mocked(getSessionUserId).mockReset(); vi.mocked(getMe).mockReset(); vi.mocked(getActiveTenant).mockReset(); vi.mocked(getDepartment).mockReset(); });

describe("requireWebsiteCtx visitors tab", () => {
  it.each(["search_manager", "company_admin"])("a %s gets the context, with the visitors base", async (role) => {
    arrange(role);
    const c = await requireWebsiteCtx("dept-1", "visitors");
    expect(c.visitorsBase).toBe("/departments/dept-1/website/visitors");
    expect(c.company).toBe("co-1");
  });

  it("plain search staff gets a 404 (hidden, not an empty list)", async () => {
    arrange("search_staff");
    await expect(requireWebsiteCtx("dept-1", "visitors")).rejects.toBeInstanceOf(NotFound);
  });

  it("a manager of ANOTHER company gets a 404 for this company", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue("u");
    vi.mocked(getMe).mockResolvedValue(meWith("search_manager", "co-9") as never);
    vi.mocked(getActiveTenant).mockResolvedValue("co-1");
    vi.mocked(getDepartment).mockResolvedValue({ id: "dept-1", name: "Web Dev" } as never);
    await expect(requireWebsiteCtx("dept-1", "visitors")).rejects.toBeInstanceOf(NotFound);
  });

  it("a department whose toolkit lacks the tab gets a 404 even for a company admin", async () => {
    arrange("company_admin", "Legal");
    await expect(requireWebsiteCtx("dept-1", "visitors")).rejects.toBeInstanceOf(NotFound);
  });

  it("the other Website tabs still need no capability: plain search staff opens Analytics", async () => {
    arrange("search_staff");
    const c = await requireWebsiteCtx("dept-1", "analytics");
    expect(c.analyticsBase).toBe("/departments/dept-1/website/analytics");
  });
});
