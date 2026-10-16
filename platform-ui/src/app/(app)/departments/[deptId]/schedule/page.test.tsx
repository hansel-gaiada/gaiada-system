import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

// DW-10c-3 (BFF section 59.4, DW-D33): a unit's calendar page. The read is the server's (its four legs, each read or not); this page asks for the
// six-week window of ?month=, words a refused read as the house "no access" state and a failed one as "cannot tell", never as an empty
// calendar, and links "Add an event" to the schedule form with the department preselected.
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn(() => { throw new Error("notFound"); }) }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", async (orig) => ({ ...(await orig<typeof import("@/lib/platform")>()), getMe: vi.fn(async () => ({ userId: "u-1" })) }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/deptCalendar-data", () => ({ getDeptCalendar: vi.fn() }));

import { getActiveTenant } from "@/lib/tenant";
import { getDeptCalendar } from "@/lib/deptCalendar-data";
import type { DeptCalendar } from "@/lib/deptCalendar";
import type { ReadResult } from "@/lib/readResult";
import DepartmentSchedulePage from "./page";

const cal = (over: Partial<DeptCalendar> = {}): DeptCalendar => ({
  unit: { id: "dept-1", name: "Web Dev" }, from: "2026-09-28", to: "2026-11-08",
  holidays: { included: true, items: [{ day: "2026-10-09", name: "Nyepi (Day of Silence)", kind: "public" }] },
  away: { included: true, items: [{ userId: "u1", name: "Andre Wijaya", startsOn: "2026-10-13", endsOn: "2026-10-13", leaveType: "vacation" }] },
  deadlines: { included: true, items: [] }, events: { included: true, items: [] },
  ...over,
});
const ok = (c: DeptCalendar = cal()): ReadResult<DeptCalendar> => ({ kind: "ok", data: c });
const mount = async (search: Record<string, string> = {}, deptId = "dept-1") =>
  render(await DepartmentSchedulePage({ params: Promise.resolve({ deptId }), searchParams: Promise.resolve(search) }));

beforeEach(() => {
  // Wednesday 16 October 2026, midday in Singapore. Only Date is faked, so the awaits in the page still run.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
  vi.mocked(getActiveTenant).mockReset().mockResolvedValue("co-a");
  vi.mocked(getDeptCalendar).mockReset().mockResolvedValue(ok());
});
afterEach(() => vi.useRealTimers());

describe("what is asked of the platform", () => {
  it("asks for the unit's six-week window of the current month for the signed-in person, 42 days both ends counted", async () => {
    await mount();
    expect(getDeptCalendar).toHaveBeenCalledWith("u-1", "co-a", "dept-1", { from: "2026-09-28", to: "2026-11-08" });
  });

  it("asks for the month in ?month=", async () => {
    await mount({ month: "2026-12" });
    expect(getDeptCalendar).toHaveBeenCalledWith("u-1", "co-a", "dept-1", { from: "2026-11-30", to: "2027-01-10" });
  });

  it("treats a bad ?month= as the current month", async () => {
    for (const bad of ["2026-13", "abc", "2026-1", ""]) {
      vi.mocked(getDeptCalendar).mockClear();
      await mount({ month: bad });
      expect(vi.mocked(getDeptCalendar).mock.calls[0][3], bad).toEqual({ from: "2026-09-28", to: "2026-11-08" });
    }
  });

  it("is not found without an active company", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue(null);
    await expect(mount()).rejects.toThrow("notFound");
  });
});

describe("the page", () => {
  it("is titled '<Department> calendar' and draws the month, the grid and the agenda", async () => {
    await mount();
    expect(screen.getByText("Web Dev calendar")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 4, name: "October 2026" })).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Agenda" })).toBeInTheDocument();
    expect(within(screen.getByRole("table")).getByText("Andre Wijaya · vacation")).toBeInTheDocument();
  });

  it("links the previous and next month, and 'This month' only when the month is not the current one", async () => {
    const first = await mount();
    const nav = screen.getByRole("navigation", { name: "Month" });
    expect(within(nav).getByRole("link", { name: "Previous month, September 2026" })).toHaveAttribute("href", "/departments/dept-1/schedule?month=2026-09");
    expect(within(nav).getByRole("link", { name: "Next month, November 2026" })).toHaveAttribute("href", "/departments/dept-1/schedule?month=2026-11");
    expect(within(nav).queryByRole("link", { name: "This month" })).not.toBeInTheDocument();
    first.unmount();
    await mount({ month: "2026-11" });
    const n2 = screen.getByRole("navigation", { name: "Month" });
    expect(within(n2).getByRole("link", { name: "This month" })).toHaveAttribute("href", "/departments/dept-1/schedule");
    // The previous month of November is October: the current month, so the bare address.
    expect(within(n2).getByRole("link", { name: "Previous month, October 2026" })).toHaveAttribute("href", "/departments/dept-1/schedule");
    expect(within(n2).getByRole("link", { name: "Next month, December 2026" })).toHaveAttribute("href", "/departments/dept-1/schedule?month=2026-12");
  });

  it("steps over a year end", async () => {
    await mount({ month: "2026-12" });
    const nav = screen.getByRole("navigation", { name: "Month" });
    expect(within(nav).getByRole("link", { name: "Next month, January 2027" })).toHaveAttribute("href", "/departments/dept-1/schedule?month=2027-01");
  });

  it("offers 'Add an event' with the department preselected", async () => {
    await mount();
    expect(screen.getByRole("link", { name: "Add an event" })).toHaveAttribute("href", "/calendar/new?visibility=department&unit=dept-1");
  });

  it("says in a note what did not load, and draws no chip for it", async () => {
    vi.mocked(getDeptCalendar).mockResolvedValue(ok(cal({ away: { included: false, reason: "module_off" }, holidays: { included: false, reason: "module_off" } })));
    await mount();
    expect(screen.getByText("The HR module is off for this company, so holidays and who is away are not shown.")).toBeInTheDocument();
    expect(within(screen.getByRole("table")).queryByText(/vacation|Nyepi/)).not.toBeInTheDocument();
  });
});

describe("a refused or failed read", () => {
  it("is the house 'no access' state for a 403, with no grid, no add link and no 'Nothing is scheduled'", async () => {
    vi.mocked(getDeptCalendar).mockResolvedValue({ kind: "forbidden" });
    await mount({}, "dept-3");
    expect(screen.getByText(/You don't have access to this department's calendar\./)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Add an event" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Nothing is scheduled/)).not.toBeInTheDocument();
  });

  it("says it cannot tell for a failure, with the platform's words, and is not a statement that there is nothing", async () => {
    vi.mocked(getDeptCalendar).mockResolvedValue({ kind: "unavailable", reason: "unit_not_found" });
    await mount();
    expect(screen.getByText(/cannot be read right now/)).toBeInTheDocument();
    expect(screen.getByText(/this is not a statement that there is nothing/)).toBeInTheDocument();
    expect(screen.getByText("unit_not_found")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
