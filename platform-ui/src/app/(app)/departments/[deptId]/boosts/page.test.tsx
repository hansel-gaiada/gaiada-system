import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// SCP-4b (BFF §63.11, §63.17): the Boosting page. The read is the server's (`GET boosts`); the page draws it: the three parts, the next page linked by the server's cursor, a refused read
// is "no access" and a failed one is "cannot tell" (never an empty list), and the page belongs to the Social Media workspace only. Server page: the readers are mocked, the element tree
// is rendered.
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => { throw new Error(`redirect:${to}`); }),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", async (orig) => ({
  ...(await orig<typeof import("@/lib/platform")>()),
  getMe: vi.fn(async () => ({ userId: "u-1", roles: [], companies: [{ id: "co-a", vertical: "agency" }] })),
}));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/companyContext", () => ({ activeCompany: vi.fn(() => ({ id: "co-a", vertical: "agency" })) }));
vi.mock("@/lib/departments", () => ({ getDepartment: vi.fn() }));
vi.mock("@/lib/socialBoosts-data", () => ({ getBoostList: vi.fn() }));
vi.mock("@/lib/socialBoostsActions", () => ({ requestBoost: vi.fn(), loadBoostEstimate: vi.fn(), loadBudgetForPost: vi.fn(), runBoostAction: vi.fn() }));

import { getSessionUserId } from "@/lib/session-server";
import { getDepartment } from "@/lib/departments";
import { getBoostList } from "@/lib/socialBoosts-data";
import { asBoostList, type BoostList } from "@/lib/socialBoosts";
import type { ReadResult } from "@/lib/readResult";
import BoostingPage from "./page";

const list = (over: Record<string, unknown> = {}): BoostList => asBoostList({
  items: [{
    id: "b-1", postId: "p-1", postTitle: "Harvest collection arrives", clientName: "Brand Alpha", cycleId: "cy-1", status: "running", goal: "website", audience: "automatic", audienceNote: null,
    dailyBudgetMinor: 50_000, days: 4, totalBudgetMinor: 200_000, currency: "IDR", minorUnit: 0, startsOn: "2026-10-15", approvedVia: "budget", approvedAt: null, startedAt: null, endedAt: null,
    spendMinor: null, paidReach: null, clicks: null, reachEstimate: null, simulated: false,
  }],
  candidates: [{ postId: "p-2", clientName: "Brand Alpha", title: "A day in the warehouse", engagementRate: 0.071, accountAverageRate: 0.035 }],
  totals: { committedMinor: 200_000, spendMinor: 0, currency: "IDR" }, nextCursor: null, ...over,
});
const ok = (data: BoostList): ReadResult<BoostList> => ({ kind: "ok", data });
const mount = async (search: Record<string, string> = {}, deptId = "d-soc") =>
  render(await BoostingPage({ params: Promise.resolve({ deptId }), searchParams: Promise.resolve(search) }));

beforeEach(() => {
  vi.mocked(getSessionUserId).mockReset().mockResolvedValue("u-1");
  vi.mocked(getDepartment).mockReset().mockResolvedValue({ id: "d-soc", name: "Social Media" } as never);
  vi.mocked(getBoostList).mockReset().mockResolvedValue(ok(list()));
});

describe("what is asked of the platform", () => {
  it("reads the list for the signed-in person in the active company, from the start", async () => {
    await mount();
    expect(getBoostList).toHaveBeenCalledWith("u-1", "co-a", { cursor: null });
  });
  it("passes the cursor of the page being read", async () => {
    await mount({ cursor: "o50" });
    expect(getBoostList).toHaveBeenCalledWith("u-1", "co-a", { cursor: "o50" });
  });
  it("sends a signed-out person to sign in", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null as never);
    await expect(mount()).rejects.toThrow("redirect:/login");
  });
  it("is not found for a department that is not Social Media, or that does not exist", async () => {
    vi.mocked(getDepartment).mockResolvedValue({ id: "d-web", name: "Web Dev" } as never);
    await expect(mount({}, "d-web")).rejects.toThrow("notFound");
    vi.mocked(getDepartment).mockResolvedValue(null as never);
    await expect(mount({}, "nope")).rejects.toThrow("notFound");
    expect(getBoostList).not.toHaveBeenCalled();
  });
});

describe("the page", () => {
  it("is titled Boosting, says nothing is bought from here, and has the three parts", async () => {
    await mount();
    expect(screen.getByRole("heading", { name: "Boosting" })).toBeInTheDocument();
    expect(screen.getByText(/nothing is bought from here/)).toBeInTheDocument();
    for (const h of ["Candidates", "Running and waiting", "Totals"]) expect(screen.getByRole("heading", { name: h })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Harvest collection arrives" })).toHaveAttribute("href", "/departments/d-soc/posts/p-1");
    expect(screen.getByRole("button", { name: "Boost A day in the warehouse" })).toBeInTheDocument();
  });

  it("links the next page by the server's cursor", async () => {
    vi.mocked(getBoostList).mockResolvedValue(ok(list({ nextCursor: "o50" })));
    await mount();
    expect(screen.getByRole("link", { name: "Show the next boosts" })).toHaveAttribute("href", "/departments/d-soc/boosts?cursor=o50");
  });

  it("a refused read is no access and a failed one is cannot tell, never an empty list", async () => {
    vi.mocked(getBoostList).mockResolvedValue({ kind: "forbidden" });
    const a = await mount();
    expect(screen.queryByRole("heading", { name: "Candidates" })).toBeNull();
    expect(screen.getByText(/You don.t have access to Boosting/)).toBeInTheDocument();
    a.unmount();
    vi.mocked(getBoostList).mockResolvedValue({ kind: "unavailable", reason: "boosts: not a boost list" });
    await mount();
    expect(screen.queryByRole("heading", { name: "Candidates" })).toBeNull();
    expect(screen.queryByText("No boosts yet. A boost is requested from a live post.")).toBeNull();
  });
});
