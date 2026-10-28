import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

// SCP-3e (BFF §63.10, §59, §63.17; plan §6.2, §8 row 3e): `{D}/calendar`, the Social Media calendar. It reads the grid's window from `GET calendar`, the
// department calendar's holidays and leave, the Composer's posts and the clients, draws them Monday first with a legend, and says in a line what it could not load.
// A refusal or a failure of the one required read is said in words; the optional ones degrade on their own. The clock is pinned mid-month.
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(), notFound: vi.fn(() => { throw new Error("notFound"); }), useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", async (orig) => ({
  ...(await orig<typeof import("@/lib/platform")>()),
  getMe: vi.fn(async () => ({ userId: "u-1", roles: [], companies: [{ id: "co-a", vertical: "agency" }] })),
}));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/companyContext", () => ({ activeCompany: vi.fn(() => ({ id: "co-a", vertical: "agency" })) }));
vi.mock("@/lib/departments", () => ({ getDepartment: vi.fn() }));
vi.mock("@/lib/deptCalendar-data", () => ({ getDeptCalendar: vi.fn() }));
vi.mock("@/lib/socialAllocation-data", () => ({ getAllocation: vi.fn(), getOfficerCandidates: vi.fn() }));
vi.mock("@/lib/socialCycles-data", () => ({ getCycleTable: vi.fn(), getSocialSettings: vi.fn() }));
vi.mock("@/lib/socialCalendar-data", () => ({ getSocialCalendar: vi.fn(), getComposerPosts: vi.fn() }));
vi.mock("@/lib/socialPipelineActions", () => ({ runPostAction: vi.fn(), savePostFields: vi.fn() }));
vi.mock("@/lib/socialClientActions", () => ({ createClientPost: vi.fn(), bulkPostAction: vi.fn() }));

import { getDepartment } from "@/lib/departments";
import { getDeptCalendar } from "@/lib/deptCalendar-data";
import { getAllocation } from "@/lib/socialAllocation-data";
import { getCycleTable } from "@/lib/socialCycles-data";
import { getComposerPosts, getSocialCalendar } from "@/lib/socialCalendar-data";
import { asDeptCalendar } from "@/lib/deptCalendar";
import { asComposerEntries, placeItem, type DayItem } from "@/lib/socialCalendar";
import type { AllocationRow } from "@/lib/socialAllocation";
import type { ReadResult } from "@/lib/readResult";
import type { CycleTable } from "@/lib/socialCycles";
import SocialCalendarPage from "./page";

const ok = <T,>(data: T): ReadResult<T> => ({ kind: "ok", data });
const row = (over: Partial<AllocationRow> = {}): AllocationRow => ({
  engagementId: "e-alpha", clientId: "c-alpha", clientName: "Brand Alpha", status: "active", officer: { id: "u-2", name: "Sam Officer" }, postsPerCycle: 5,
  creativeSource: "creatives", deliveryBatch: "A", reportFormat: "email", reportDueDay: 5, platforms: ["instagram"], formats: ["feed"], defaultPostTime: "09:30",
  stepEstimates: {}, thisCycle: { cycleId: "cy-1", month: "2026-10", target: 5, counted: 1, extra: 0, stories: 0 }, canPlan: false, ...over,
});
const item = (over: Partial<DayItem> & { postId: string }): DayItem => placeItem({
  clientName: "Brand Alpha", title: "Harvest teaser", format: "feed", scheduledAt: "2026-10-20T01:30:00.000Z", pipelineStatus: "client", phase: "with_client", simulated: false, dateMove: "locked", dateMoveRefusal: "field_locked", ...over,
});
const dept = (over: Record<string, unknown> = {}) => asDeptCalendar({
  unit: { id: "d-soc", name: "Social Media" }, from: "2026-09-28", to: "2026-11-01",
  holidays: { included: true, items: [{ day: "2026-10-09", name: "Nyepi", kind: "public" }] },
  away: { included: true, items: [{ userId: "u-9", name: "Maya Putri", startsOn: "2026-10-13", endsOn: "2026-10-13", leaveType: "vacation" }] },
  deadlines: { included: true, items: [] }, events: { included: true, items: [] }, ...over,
});
const table: CycleTable = { month: "2026-10", bufferWorkingDays: 3, holidaysKnown: true, canPlan: false, rows: [] };

const mount = async (search: Record<string, string> = {}, params: { deptId?: string } = {}) =>
  render(await SocialCalendarPage({ params: Promise.resolve({ deptId: params.deptId ?? "d-soc" }), searchParams: Promise.resolve(search) }));

beforeEach(() => {
  // Friday 16 October 2026, midday in Singapore. Only Date is faked, so the awaits in the page still run.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
  vi.mocked(getDepartment).mockReset().mockResolvedValue({ id: "d-soc", name: "Social Media" } as never);
  vi.mocked(getSocialCalendar).mockReset().mockResolvedValue(ok([
    item({ postId: "p-1" }),
    item({ postId: "p-2", title: "Studio day", clientName: "Brand Beta", pipelineStatus: "approved", phase: "client_approved", scheduledAt: "2026-10-21T01:30:00.000Z", dateMove: "reschedule", dateMoveRefusal: null }),
  ]));
  vi.mocked(getDeptCalendar).mockReset().mockResolvedValue(ok(dept()));
  vi.mocked(getComposerPosts).mockReset().mockResolvedValue(ok(asComposerEntries([{ id: "c-1", title: "Weekly promo", status: "approved", engagementId: "e-alpha", scheduledAt: "2026-10-27T01:00:00.000Z" }])));
  vi.mocked(getAllocation).mockReset().mockResolvedValue(ok([row({ officer: { id: "u-1", name: "Me" } }), row({ engagementId: "e-beta", clientName: "Brand Beta" })]));
  vi.mocked(getCycleTable).mockReset().mockResolvedValue(ok(table));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("what is asked of the platform", () => {
  it("reads the posts calendar and the department calendar for the grid's own days, for the signed-in person", async () => {
    await mount();
    expect(getSocialCalendar).toHaveBeenCalledWith("u-1", "co-a", { from: "2026-09-28", to: "2026-11-01", engagementId: null });
    expect(getDeptCalendar).toHaveBeenCalledWith("u-1", "co-a", "d-soc", { from: "2026-09-28", to: "2026-11-01" });
    expect(getComposerPosts).toHaveBeenCalledWith("u-1", "co-a", null);
    expect(getAllocation).toHaveBeenCalledWith("u-1", "co-a");
    expect(getCycleTable).toHaveBeenCalledWith("u-1", "co-a", "2026-10");
  });

  it("asks for the month in ?month=, and for one client's posts with ?engagementId=, and ignores a value it cannot trust", async () => {
    await mount({ month: "2026-12", engagementId: "e-alpha" });
    expect(getSocialCalendar).toHaveBeenCalledWith("u-1", "co-a", { from: "2026-11-30", to: "2027-01-03", engagementId: "e-alpha" });
    expect(getCycleTable).toHaveBeenCalledWith("u-1", "co-a", "2026-12");
    cleanup();
    vi.mocked(getSocialCalendar).mockClear();
    await mount({ month: "2026-13", engagementId: "e-alpha; drop" });
    expect(getSocialCalendar).toHaveBeenCalledWith("u-1", "co-a", { from: "2026-09-28", to: "2026-11-01", engagementId: null });
  });

  it("is not found for a department that is not Social Media, or that does not exist", async () => {
    vi.mocked(getDepartment).mockResolvedValue({ id: "d-web", name: "Web Dev" } as never);
    await expect(mount({}, { deptId: "d-web" })).rejects.toThrow("notFound");
    vi.mocked(getDepartment).mockResolvedValue(null as never);
    await expect(mount()).rejects.toThrow("notFound");
  });
});

describe("the page", () => {
  it("draws every client's posts Monday first, with the legend, today marked and the month's links", async () => {
    await mount();
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader")[0]).toHaveTextContent("Mon");
    expect(within(table).getByRole("link", { name: /Harvest teaser/ })).toHaveAttribute("href", "/departments/d-soc/posts/p-1");
    expect(within(table).getByRole("link", { name: /Studio day/ })).toHaveTextContent("Brand Beta");
    expect(within(table).getByText(/2 pipeline posts from 2 clients in view, and 1 Composer post\./)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "October 2026" })).toBeInTheDocument();
    expect(table.querySelector("td.scp-cal__today")!.getAttribute("data-day")).toBe("2026-10-16");
    const legend = screen.getByRole("list", { name: "Phase colours" });
    expect(within(legend).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Brief", "In production", "With client", "Client changes", "Client approved", "Posted", "Composer post", "Holiday", "Away (approved leave)",
    ]);
    expect(screen.getByRole("link", { name: "Previous month, September 2026" })).toHaveAttribute("href", "/departments/d-soc/calendar?month=2026-09");
    expect(screen.getByRole("link", { name: "Next month, November 2026" })).toHaveAttribute("href", "/departments/d-soc/calendar?month=2026-11");
    expect(screen.queryByRole("link", { name: "This month" })).toBeNull();
  });

  it("offers a way back to this month from another one, and keeps the client filter in every link", async () => {
    await mount({ month: "2026-12", engagementId: "e-alpha" });
    expect(screen.getByRole("link", { name: "This month" })).toHaveAttribute("href", "/departments/d-soc/calendar?engagementId=e-alpha");
    expect(screen.getByRole("link", { name: "Next month, January 2027" })).toHaveAttribute("href", "/departments/d-soc/calendar?month=2027-01&engagementId=e-alpha");
    const select = screen.getByRole("combobox", { name: "Client" });
    expect(select).toHaveValue("e-alpha");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["All clients", "Brand Alpha", "Brand Beta"]);
    expect(document.querySelector('input[name="month"]')).toHaveAttribute("value", "2026-12");
  });

  it("merges the department's holidays and approved leave, and says nothing is missing when both legs loaded", async () => {
    await mount();
    expect(within(document.querySelector('td[data-day="2026-10-09"]')!).getByText("Nyepi")).toBeInTheDocument();
    expect(within(document.querySelector('td[data-day="2026-10-13"]')!).getByText("Maya Putri · vacation")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "What could not be loaded" })).toBeNull();
  });

  it("keeps the Composer's posts as links to the Composer", async () => {
    await mount();
    expect(screen.getByRole("link", { name: /Weekly promo/ })).toHaveAttribute("href", "/departments/d-soc/composer/c-1");
  });

  it("says an empty month is empty, only because the read succeeded", async () => {
    vi.mocked(getSocialCalendar).mockResolvedValue(ok([]));
    vi.mocked(getComposerPosts).mockResolvedValue(ok([]));
    await mount();
    expect(screen.getByText(/No pipeline posts are scheduled in view\./)).toBeInTheDocument();
  });
});

describe("what could not be read is said, never drawn as empty", () => {
  it("says the department calendar could not be loaded, and draws no holiday or leave", async () => {
    vi.mocked(getDeptCalendar).mockResolvedValue({ kind: "unavailable", reason: "boom" });
    await mount();
    const notes = screen.getByRole("list", { name: "What could not be loaded" });
    expect(within(notes).getByText("The department's calendar could not be loaded, so holidays and who is away are not shown.")).toBeInTheDocument();
    expect(screen.queryByText("Nyepi")).toBeNull();
    expect(screen.queryByText(/Maya Putri/)).toBeNull();
  });

  it("says so for a department calendar that refused the read", async () => {
    vi.mocked(getDeptCalendar).mockResolvedValue({ kind: "forbidden" });
    await mount();
    expect(screen.getByText("The department's calendar could not be read for you, so holidays and who is away are not shown.")).toBeInTheDocument();
  });

  it("says the HR module is off, in one line, when both legs say so, and still draws the posts", async () => {
    vi.mocked(getDeptCalendar).mockResolvedValue(ok(dept({ holidays: { included: false, reason: "module_off" }, away: { included: false, reason: "module_off" } })));
    await mount();
    expect(screen.getByText("The HR module is off for this company, so holidays and who is away are not shown.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Harvest teaser/ })).toBeInTheDocument();
  });

  it("says one leg failed while the other is drawn", async () => {
    vi.mocked(getDeptCalendar).mockResolvedValue(ok(dept({ away: { included: false, reason: "read_failed" } })));
    await mount();
    expect(screen.getByText("Leave could not be loaded, so who is away is not shown.")).toBeInTheDocument();
    expect(screen.getByText("Nyepi")).toBeInTheDocument();
    expect(screen.queryByText(/Maya Putri/)).toBeNull();
  });

  it("says the Composer's posts could not be loaded", async () => {
    vi.mocked(getComposerPosts).mockResolvedValue({ kind: "unavailable", reason: "boom" });
    await mount();
    expect(screen.getByText("Composer posts could not be loaded, so they are not shown.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Weekly promo/ })).toBeNull();
  });

  it("says the clients could not be loaded, and offers no + and no filter", async () => {
    vi.mocked(getAllocation).mockResolvedValue({ kind: "unavailable", reason: "boom" });
    await mount();
    expect(screen.getByText(/a post cannot be planned from here and the client filter is off/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Plan a post/ })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Client" })).toBeNull();
  });

  it("offers the + on the month's days once the clients are read, to the officer of a client", async () => {
    await mount();
    expect(screen.getAllByRole("button", { name: /^Plan a post on / })).toHaveLength(31);
    expect(screen.queryByText(/so the days have no/)).toBeNull();
  });

  it("offers the + to an approver (canPlan) for every client, and not to anyone else, with the reason in a line", async () => {
    vi.mocked(getAllocation).mockResolvedValue(ok([row({ canPlan: true }), row({ engagementId: "e-beta", clientName: "Brand Beta", canPlan: true })]));
    await mount();
    expect(screen.getAllByRole("button", { name: /^Plan a post on / })).toHaveLength(31);
    cleanup();
    vi.mocked(getAllocation).mockResolvedValue(ok([row(), row({ engagementId: "e-beta", clientName: "Brand Beta" })]));
    await mount();
    expect(screen.queryByRole("button", { name: /^Plan a post on / })).toBeNull();
    expect(screen.getByText(/officer or one of the four Social Media approvers, so the days have no "\+" for you/)).toBeInTheDocument();
  });

  it("refuses in words when the calendar itself is forbidden, instead of drawing an empty grid", async () => {
    vi.mocked(getSocialCalendar).mockResolvedValue({ kind: "forbidden" });
    await mount();
    expect(screen.getByText(/You don't have access to the content calendar\./)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("says it cannot tell when the calendar read failed, which is not a statement that nothing is scheduled", async () => {
    vi.mocked(getSocialCalendar).mockResolvedValue({ kind: "unavailable", reason: "the module is off" });
    await mount();
    expect(screen.getByText(/this is not a statement that there is nothing/)).toBeInTheDocument();
    expect(screen.getByText("the module is off")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
