import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

// SCP-5d (BFF §63.19, §63.17): the Social Media Team dashboard page. The read is the server's (`GET team`, the four approvers); the page draws its answer in the contract's
// order, words a refused read as "no access" and a failed one as "cannot tell" (never an empty dashboard), names a part the server could not work out as unknown (never as
// empty), says every empty section in its own sentence, steps through the months, and shows no last sign-in anywhere.
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("redirect"); }), notFound: vi.fn(() => { throw new Error("notFound"); }) }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", async (orig) => ({ ...(await orig<typeof import("@/lib/platform")>()), getMe: vi.fn(async () => ({ userId: "u-1", companies: [{ id: "co-a", vertical: "agency" }] })) }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/companyContext", () => ({ activeCompany: vi.fn(() => ({ id: "co-a", vertical: "agency" })) }));
vi.mock("@/lib/departments", () => ({ getDepartmentNode: vi.fn() }));
vi.mock("@/lib/socialTeam-data", () => ({ getTeamDashboard: vi.fn() }));
// The KPI strip and the pipeline tiles have their own tests; here they only hold their place in the page's order.
vi.mock("@/components/social/TeamDashboardKpis", () => ({ TeamDashboardKpis: ({ month }: { month: string }) => <div data-testid="kpis" data-month={month} /> }));
vi.mock("@/components/social/TeamDashboardTiles", () => ({ TeamDashboardTiles: ({ deptId }: { deptId: string }) => <div data-testid="tiles" data-dept={deptId} /> }));

import { getSessionUserId } from "@/lib/session-server";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartmentNode } from "@/lib/departments";
import { activeCompany } from "@/lib/companyContext";
import { getTeamDashboard } from "@/lib/socialTeam-data";
import { asTeamDashboard, type TeamDashboard } from "@/lib/socialTeam";
import type { ReadResult } from "@/lib/readResult";
import SocialTeamDashboardPage from "./page";

const health = (state: string) => ({ state, spareDays: 2, lateDays: null, lateWith: null, latestSafeHandoff: "2026-10-20", readyBy: "2026-10-25" });
const body = (over: Record<string, unknown> = {}) => ({
  month: "2026-10", needsAttention: [], clients: [], workload: [], waits: [], stepAverages: [], estimatesNotSet: [], personRowsLimited: false, partial: [], ...over,
});
const FULL = body({
  needsAttention: [
    { kind: "late", postId: "p-1", engagementId: "e-1", clientName: "Northwind Traders", title: "Five ways to style a scarf", since: "2026-10-13", holder: { role: "designer", label: "Kadek Surya" } },
    { kind: "boost_waiting", boostId: "b-1", engagementId: "e-1", clientName: "Northwind Traders", title: "Harvest collection arrives", since: "2026-10-13" },
    { kind: "report_due", engagementId: "e-2", clientName: "Saltmarsh Day Spa", since: "2026-10-01", holder: { role: "officer", label: "Wayan Sudira" } },
    { kind: "report_to_check", reportId: "r-1", engagementId: "e-3", clientName: "Harborlight Hotel", since: "2026-10-01" },
  ],
  clients: [
    { engagementId: "e-1", clientName: "Northwind Traders", officer: { id: "u-2", name: "Komang Lestari" }, target: 12, counted: 8, approved: 5, live: 3, extra: 1, stories: 2, health: health("late") },
    { engagementId: "e-3", clientName: "Harborlight Hotel", officer: null, target: null, counted: 2, approved: 0, live: 0, extra: 0, stories: 0, health: null },
  ],
  workload: [{ userId: "u-2", name: "Komang Lestari", role: "officer", holding: 4, late: 2, oldestSince: "2026-10-01" }],
  waits: [{ holderRole: "client", posts: 3, oldestSince: "2026-10-02", averageWorkingDays: 1.5, people: [] }, { holderRole: "officer", posts: 4, oldestSince: "2026-10-01", averageWorkingDays: 2, people: [{ userId: "u-2", name: "Komang Lestari", posts: 4, oldestSince: "2026-10-01" }] }],
  stepAverages: [{ step: "hod", averageWorkingDays: 1.4, samples: 6 }],
  estimatesNotSet: [{ engagementId: "e-3", clientName: "Harborlight Hotel" }],
});
const ok = (raw: unknown): ReadResult<TeamDashboard> => ({ kind: "ok", data: asTeamDashboard(raw) });

const mount = async (search: Record<string, string | string[]> = {}, deptId = "d-soc") =>
  render(await SocialTeamDashboardPage({ params: Promise.resolve({ deptId }), searchParams: Promise.resolve(search) }));
const section = (name: string) => document.querySelector(`[data-section="${name}"]`) as HTMLElement;

beforeEach(() => {
  // Thursday 29 October 2026, midday in Singapore. Only Date is faked, so the awaits in the page still run.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-29T04:00:00Z"));
  vi.mocked(getSessionUserId).mockReset().mockResolvedValue("u-1");
  vi.mocked(getActiveTenant).mockReset().mockResolvedValue("co-a");
  vi.mocked(activeCompany).mockReset().mockReturnValue({ id: "co-a", vertical: "agency" } as never);
  vi.mocked(getDepartmentNode).mockReset().mockResolvedValue({ id: "d-soc", name: "Social Media" } as never);
  vi.mocked(getTeamDashboard).mockReset().mockResolvedValue(ok(FULL));
});
afterEach(() => vi.useRealTimers());

describe("what is asked of the platform", () => {
  it("reads this month's dashboard for the signed-in person", async () => {
    await mount();
    expect(getTeamDashboard).toHaveBeenCalledWith("u-1", "co-a", "2026-10");
  });
  it("reads the month in ?month=, and this month for a bad one", async () => {
    await mount({ month: "2026-08" });
    expect(getTeamDashboard).toHaveBeenLastCalledWith("u-1", "co-a", "2026-08");
    await mount({ month: "2026-13" });
    expect(getTeamDashboard).toHaveBeenLastCalledWith("u-1", "co-a", "2026-10");
    await mount({ month: ["2026-07", "2026-06"] });
    expect(getTeamDashboard).toHaveBeenLastCalledWith("u-1", "co-a", "2026-07");
  });
  it("is not found for a department that is not Social Media, or that does not exist, and signs out to the login", async () => {
    vi.mocked(getDepartmentNode).mockResolvedValue({ id: "d-web", name: "Web Dev" } as never);
    await expect(mount({}, "d-web")).rejects.toThrow("notFound");
    vi.mocked(getDepartmentNode).mockResolvedValue(null as never);
    await expect(mount({}, "d-x")).rejects.toThrow("notFound");
    vi.mocked(getTeamDashboard).mockClear();
    vi.mocked(getSessionUserId).mockResolvedValue(null as never);
    await expect(mount()).rejects.toThrow("redirect");
    expect(getTeamDashboard).not.toHaveBeenCalled();
  });
});

describe("an answer", () => {
  it("draws the KPI strip, then the pipeline tiles, then the sections in the contract's order", async () => {
    await mount();
    const order = [
      screen.getByTestId("kpis"), screen.getByTestId("tiles"), section("needs-attention"), section("clients"), section("workload"), section("waits"), section("step-averages"),
      section("estimates-not-set"),
    ];
    for (let i = 1; i < order.length; i += 1) expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING, `${i}`).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Needs attention" })).toBeInTheDocument();
    for (const h of ["Clients this cycle", "Workload per person", "Where work waits longest", "Step averages", "Estimates not set"]) {
      expect(screen.getByRole("heading", { name: h })).toBeInTheDocument();
    }
    expect(screen.getByTestId("kpis")).toHaveAttribute("data-month", "2026-10");
    expect(screen.getByTestId("tiles")).toHaveAttribute("data-dept", "d-soc");
  });

  it("groups needs attention by kind with its sentence, and every row opens where it should: a post, the Boosting page, a report or the reports list", async () => {
    await mount();
    const att = within(section("needs-attention"));
    for (const t of ["Late", "Boost waiting", "Report due", "Report to check"]) expect(att.getByRole("heading", { name: new RegExp(`^${t}`) })).toBeInTheDocument();
    expect(att.getByText(/requested and is waiting for the client, or was approved and has not started/)).toBeInTheDocument();
    expect(att.getByText(/Due on the client.s report day and not yet sent/)).toBeInTheDocument();
    expect(att.getByRole("link", { name: /Five ways to style a scarf/ })).toHaveAttribute("href", "/departments/d-soc/posts/p-1");
    expect(att.getByRole("link", { name: /Harvest collection arrives/ })).toHaveAttribute("href", "/departments/d-soc/boosts");
    expect(att.getByRole("link", { name: /Saltmarsh Day Spa/ })).toHaveAttribute("href", "/departments/d-soc/social-reports");
    expect(att.getByRole("link", { name: /Harborlight Hotel/ })).toHaveAttribute("href", "/departments/d-soc/social-reports/r-1");
    for (const a of att.getAllByRole("link")) expect(a.getAttribute("href"), a.textContent ?? "").not.toContain("/profile/");
    expect(att.getByText(/Since 13 Oct · With Kadek Surya \(designer\)/)).toBeInTheDocument();
  });

  it("draws the clients with their health and officer, worst first, and a client with no cycle says so", async () => {
    await mount();
    const clients = within(section("clients"));
    const rows = clients.getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("Northwind Traders");
    expect(rows[0]).toHaveTextContent("Officer: Komang Lestari");
    expect(rows[0]).toHaveTextContent("8 of 12");
    expect(rows[0]).toHaveTextContent("1 extra · 2 stories");
    expect(rows[1]).toHaveTextContent("Harborlight Hotel");
    expect(rows[1]).toHaveTextContent("No officer yet");
    expect(rows[1]).toHaveTextContent("No cycle");
    expect(rows[1]).toHaveTextContent("Not set");
    expect(clients.getByRole("link", { name: "Northwind Traders" })).toHaveAttribute("href", "/departments/d-soc/profile/e-1");
  });

  it("draws the workload, the waits with the longest first, the step averages and the estimates not set with a link to Settings", async () => {
    await mount();
    expect(within(section("workload")).getByRole("row", { name: /Komang Lestari/ })).toHaveTextContent("4 posts");
    const waits = within(section("waits")).getAllByRole("listitem").filter((li) => li.hasAttribute("data-role"));
    expect(waits.map((w) => w.getAttribute("data-role"))).toEqual(["officer", "client"]);
    expect(waits[0]).toHaveTextContent("4 posts · Since 1 Oct · average 2 working days");
    expect(waits[0]).toHaveTextContent("Komang Lestari: 4 posts, since 1 oct");
    expect(within(section("step-averages")).getByRole("row", { name: /HoD approval/ })).toHaveTextContent("1.4 working days");
    const est = within(section("estimates-not-set"));
    expect(est.getByRole("link", { name: "Harborlight Hotel" })).toHaveAttribute("href", "/departments/d-soc/profile/e-3");
    expect(est.getByRole("link", { name: "Set them in Settings" })).toHaveAttribute("href", "/departments/d-soc/settings");
  });

  it("says once that waiting time is counted against the holder, and says so quietly when some people's rows are left out", async () => {
    await mount();
    expect(screen.getAllByText(/counted against whoever holds the post, not the client.s officer/)).toHaveLength(2);
    expect(screen.queryByTestId("limited")).not.toBeInTheDocument();
    vi.mocked(getTeamDashboard).mockResolvedValue(ok({ ...FULL, personRowsLimited: true }));
    document.body.innerHTML = "";
    await mount();
    expect(screen.getByTestId("limited")).toHaveTextContent("Some people's rows are not shown to you.");
  });

  it("shows no last sign-in anywhere: it is IT's data (BFF §63.19)", async () => {
    const { container } = await mount();
    expect(container.textContent ?? "").not.toMatch(/sign-?in|signed in|last seen|last login|last active/i);
  });
});

describe("empty sections are claims, each in its own sentence", () => {
  beforeEach(() => { vi.mocked(getTeamDashboard).mockResolvedValue(ok(body())); });

  it("says each section is empty in its own words", async () => {
    await mount();
    expect(within(section("needs-attention")).getByText("Nothing needs attention this month.")).toBeInTheDocument();
    expect(within(section("clients")).getByText("No client has an open engagement this month.")).toBeInTheDocument();
    expect(within(section("workload")).getByText("Nobody holds a post this month.")).toBeInTheDocument();
    expect(within(section("waits")).getByText("No post is waiting on anyone this month.")).toBeInTheDocument();
    expect(within(section("step-averages")).getByText(/No post has moved through a step this month/)).toBeInTheDocument();
    expect(within(section("estimates-not-set")).getByText("Every client has its step estimates set.")).toBeInTheDocument();
    expect(screen.queryByTestId("partial")).not.toBeInTheDocument();
  });

  it("an empty workload with some rows left out does not claim that nobody holds a post", async () => {
    vi.mocked(getTeamDashboard).mockResolvedValue(ok(body({ personRowsLimited: true })));
    await mount();
    expect(within(section("workload")).queryByText("Nobody holds a post this month.")).not.toBeInTheDocument();
    expect(within(section("workload")).getByText("No person's row is shown to you for this month.")).toBeInTheDocument();
  });
});

describe("a part the server could not work out (partial) is unknown, not empty", () => {
  it("names it at the top and in its own section, and does not draw that section's empty sentence", async () => {
    vi.mocked(getTeamDashboard).mockResolvedValue(ok(body({ partial: ["workload", "needsAttention"] })));
    await mount();
    expect(screen.getByTestId("partial")).toHaveTextContent("Not worked out this time: workload, needs attention. What is missing is unknown, not empty.");
    expect(within(section("workload")).getByText(/could not be worked out this time, so nothing is claimed about it/)).toBeInTheDocument();
    expect(within(section("needs-attention")).getByText(/could not be worked out this time, so nothing is claimed about it/)).toBeInTheDocument();
    expect(screen.queryByText("Nobody holds a post this month.")).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing needs attention this month.")).not.toBeInTheDocument();
    // A part that is not named stays an honest empty claim.
    expect(within(section("clients")).getByText("No client has an open engagement this month.")).toBeInTheDocument();
  });

  it("does not draw a named part's rows even when the server sent some", async () => {
    vi.mocked(getTeamDashboard).mockResolvedValue(ok({ ...FULL, partial: ["clients"] }));
    await mount();
    expect(within(section("clients")).queryByRole("table")).not.toBeInTheDocument();
    expect(within(section("clients")).getByText(/could not be worked out this time/)).toBeInTheDocument();
  });

  it("an unknown name is shown as the server sent it", async () => {
    vi.mocked(getTeamDashboard).mockResolvedValue(ok(body({ partial: ["mystery"] })));
    await mount();
    expect(screen.getByTestId("partial")).toHaveTextContent("mystery");
  });
});

describe("the read's other answers", () => {
  it("a refusal (403 not_a_social_approver) says there is no access, and draws no dashboard", async () => {
    vi.mocked(getTeamDashboard).mockResolvedValue({ kind: "forbidden" });
    const { container } = await mount();
    expect(screen.getByText(/You don.t have access to the Team dashboard/)).toBeInTheDocument();
    expect(screen.getByText(/Social Media head, the GM, the owner and the superadmin/)).toBeInTheDocument();
    expect(container.querySelector("[data-section]")).toBeNull();
    expect(screen.queryByTestId("kpis")).not.toBeInTheDocument();
  });

  it("a failed read says it cannot tell, with the server's own words, never an empty dashboard", async () => {
    vi.mocked(getTeamDashboard).mockResolvedValue({ kind: "unavailable", reason: "platform said 503" });
    const { container } = await mount();
    expect(screen.getByText(/this is not a statement that there is nothing here/)).toBeInTheDocument();
    expect(screen.getByText("platform said 503")).toBeInTheDocument();
    expect(container.querySelector("[data-section]")).toBeNull();
    expect(screen.queryByText("Nothing needs attention this month.")).not.toBeInTheDocument();
  });
});

describe("the month nav", () => {
  it("steps to the previous and next month, and the current month's links carry no query for this month", async () => {
    await mount();
    const nav = within(screen.getByRole("navigation", { name: "Month" }));
    expect(nav.getByRole("heading", { name: "October 2026" })).toBeInTheDocument();
    expect(nav.getByRole("link", { name: "Previous month, September 2026" })).toHaveAttribute("href", "/departments/d-soc/dashboard?month=2026-09");
    expect(nav.getByRole("link", { name: "Next month, November 2026" })).toHaveAttribute("href", "/departments/d-soc/dashboard?month=2026-11");
    expect(nav.queryByRole("link", { name: "This month" })).not.toBeInTheDocument();
  });

  it("on another month, titles it, steps from it and offers a way back to this month (no query)", async () => {
    vi.mocked(getTeamDashboard).mockResolvedValue(ok({ ...FULL, month: "2026-12" }));
    await mount({ month: "2026-12" });
    const nav = within(screen.getByRole("navigation", { name: "Month" }));
    expect(nav.getByRole("heading", { name: "December 2026" })).toBeInTheDocument();
    expect(nav.getByRole("link", { name: "Previous month, November 2026" })).toHaveAttribute("href", "/departments/d-soc/dashboard?month=2026-11");
    expect(nav.getByRole("link", { name: "Next month, January 2027" })).toHaveAttribute("href", "/departments/d-soc/dashboard?month=2027-01");
    expect(nav.getByRole("link", { name: "This month" })).toHaveAttribute("href", "/departments/d-soc/dashboard");
    expect(screen.getByTestId("kpis")).toHaveAttribute("data-month", "2026-12");
  });

  it("the previous month from the current one reaches this month again with no query", async () => {
    await mount({ month: "2026-09" });
    const nav = within(screen.getByRole("navigation", { name: "Month" }));
    expect(nav.getByRole("link", { name: "Next month, October 2026" })).toHaveAttribute("href", "/departments/d-soc/dashboard");
  });
});
