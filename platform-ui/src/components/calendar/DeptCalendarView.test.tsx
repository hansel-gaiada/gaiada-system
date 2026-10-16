import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));

import { DeptCalendarView } from "./DeptCalendarView";
import type { DeptCalendar } from "@/lib/deptCalendar";

// DW-10c-3 (BFF section 59.4): the department calendar's body. October 2026: the grid runs Mon 28 Sep to Sun 8 Nov; "today" is the 16th.
const empty = <T,>(): { included: true; items: T[] } => ({ included: true, items: [] });
const cal = (over: Partial<DeptCalendar> = {}): DeptCalendar => ({
  unit: { id: "dept-1", name: "Web Dev" }, from: "2026-09-28", to: "2026-11-08",
  holidays: { included: true, items: [{ day: "2026-10-09", name: "Nyepi (Day of Silence)", kind: "public" }] },
  away: { included: true, items: [
    { userId: "u1", name: "Andre Wijaya", startsOn: "2026-10-13", endsOn: "2026-10-15", leaveType: "vacation" },
    { userId: "u2", name: "Sari Dewi", startsOn: "2026-10-20", endsOn: "2026-10-20", leaveType: "sick" },
  ] },
  deadlines: { included: true, items: [{ milestoneId: "m1", name: "Staging sign-off", dueDate: "2026-10-21", projectId: "p-web-1", projectName: "Client site redesign" }] },
  events: { included: true, items: [
    { id: "e1", title: "Web Dev sprint review", startsAt: "2026-10-11T06:00:00.000Z", endsAt: "2026-10-11T07:00:00.000Z", startsOn: null, endsOn: null, visibility: "department", unitNodeId: "dept-1" },
    { id: "e2", title: "Gaia all-hands", startsAt: "2026-10-22T02:00:00.000Z", endsAt: "2026-10-22T03:00:00.000Z", startsOn: null, endsOn: null, visibility: "company", unitNodeId: null },
  ] },
  ...over,
});
const draw = (c: DeptCalendar = cal(), month = "2026-10") => render(<DeptCalendarView cal={c} tenantId="co-a" month={month} today="2026-10-16" />);
const grid = () => screen.getByRole("table");
const agenda = () => screen.getByRole("list", { name: "October 2026 agenda, by day" });

describe("the grid", () => {
  it("is a real table: a caption, seven weekday column headers Monday first, and six weeks of days", () => {
    draw();
    expect(within(grid()).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    const rows = within(grid()).getAllByRole("row");
    expect(rows).toHaveLength(7); // the header row and six weeks
    for (const r of rows.slice(1)) expect(within(r).getAllByRole("cell")).toHaveLength(7);
    expect(within(grid()).getByText("October 2026, weeks start on Monday")).toBeInTheDocument();
  });

  it("starts on the Monday before the 1st and ends on the Sunday six weeks on, and dims the days of the other months", () => {
    draw();
    const cells = within(grid()).getAllByRole("cell");
    expect(cells[0].querySelector("time")).toHaveAttribute("datetime", "2026-09-28");
    expect(cells[41].querySelector("time")).toHaveAttribute("datetime", "2026-11-08");
    expect(cells[0]).toHaveClass("cal-dept__cell--outside");
    expect(cells[3]).not.toHaveClass("cal-dept__cell--outside"); // 1 Oct
    expect(cells.filter((c) => c.classList.contains("cal-dept__cell--today"))).toHaveLength(1);
    expect(cells.find((c) => c.classList.contains("cal-dept__cell--today"))!.querySelector("time")).toHaveAttribute("datetime", "2026-10-16");
  });

  it("draws a chip for a holiday (its name), each away day (name · leave type), a milestone (project · milestone) and an event (time · title)", () => {
    draw();
    const g = within(grid());
    expect(g.getByText("Nyepi (Day of Silence)")).toBeInTheDocument();
    expect(g.getAllByText("Andre Wijaya · vacation")).toHaveLength(3); // 13, 14 and 15 October
    expect(g.getAllByText("Sari Dewi · sick")).toHaveLength(1);
    expect(g.getByText("Client site redesign · Staging sign-off")).toBeInTheDocument();
    expect(g.getByText("14:00 · Web Dev sprint review")).toBeInTheDocument();
    expect(g.getByText("10:00 · Gaia all-hands")).toBeInTheDocument();
  });

  it("links a milestone to its project and an event to its page, and leaves holidays and leave as plain text", () => {
    draw();
    const g = within(grid());
    expect(g.getByRole("link", { name: "Client site redesign · Staging sign-off" })).toHaveAttribute("href", "/projects/p-web-1");
    expect(g.getByRole("link", { name: "14:00 · Web Dev sprint review" })).toHaveAttribute("href", "/calendar/events/e1?company=co-a");
    expect(g.queryByRole("link", { name: /Nyepi/ })).not.toBeInTheDocument();
    expect(g.queryByRole("link", { name: /Andre/ })).not.toBeInTheDocument();
  });

  it("shows three chips a day and then '+N more', which jumps to that day in the agenda", () => {
    const busy = cal({ events: { included: true, items: [1, 2, 3, 4].map((n) => ({ id: `e${n}`, title: `Meeting ${n}`, startsAt: `2026-10-09T0${n}:00:00.000Z`, endsAt: `2026-10-09T0${n}:30:00.000Z`, startsOn: null, endsOn: null, visibility: "company" as const, unitNodeId: null })) } });
    draw(busy);
    const cell = within(grid()).getAllByRole("cell").find((c) => c.querySelector("time")?.getAttribute("datetime") === "2026-10-09")!;
    expect(within(cell).getAllByText(/Meeting|Nyepi/)).toHaveLength(3);
    const more = within(cell).getByRole("link", { name: "+2 more" });
    expect(more).toHaveAttribute("href", "#cal-dept-day-2026-10-09");
    // ... and every one of the five is in the agenda.
    const day = within(agenda()).getAllByRole("listitem").find((li) => li.id === "cal-dept-day-2026-10-09")!;
    expect(within(day).getAllByRole("listitem")).toHaveLength(5);
  });
});

describe("the legend and the agenda", () => {
  it("explains the four chips", () => {
    draw();
    const legend = screen.getByRole("list", { name: "Legend" });
    expect(within(legend).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Holiday", "Away (name · leave type)", "Milestone (project · milestone)", "Event (time · title)",
    ]);
  });

  it("lists the same items day by day, in date order, each with its kind in words", () => {
    draw();
    const days = within(agenda()).getAllByRole("listitem").filter((li) => li.id.startsWith("cal-dept-day-"));
    expect(days.map((d) => d.id)).toEqual([
      "cal-dept-day-2026-10-09", "cal-dept-day-2026-10-11", "cal-dept-day-2026-10-13", "cal-dept-day-2026-10-14", "cal-dept-day-2026-10-15",
      "cal-dept-day-2026-10-20", "cal-dept-day-2026-10-21", "cal-dept-day-2026-10-22",
    ]);
    expect(within(days[0]).getByRole("heading", { level: 5 })).toHaveTextContent("Fri 9 Oct 2026");
    expect(days[0]).toHaveTextContent("HolidayNyepi (Day of Silence)Public holiday");
    expect(days[1]).toHaveTextContent("Event14:00 · Web Dev sprint reviewWeb Dev");
    expect(days[2]).toHaveTextContent("AwayAndre Wijaya · vacation13 Oct to 15 Oct");
    expect(days[5]).toHaveTextContent("AwaySari Dewi · sick");
    expect(days[6]).toHaveTextContent("MilestoneClient site redesign · Staging sign-off");
    expect(days[7]).toHaveTextContent("Event10:00 · Gaia all-handsWhole company");
  });

  it("offers a way past the grid to the agenda", () => {
    draw();
    expect(screen.getByRole("link", { name: "Go to the agenda list" })).toHaveAttribute("href", "#cal-dept-agenda");
    expect(document.getElementById("cal-dept-agenda")).not.toBeNull();
  });

  it("draws a leave as a name, dates and a type and nothing else", () => {
    // The page can only draw what the wire carries; this pins that nothing but name, dates and type is drawn for a leave.
    const { container } = draw();
    expect(container.textContent ?? "").not.toMatch(/minutes|approved|pending|note/i);
  });
});

describe("a leg that did not load", () => {
  it("says so in one line, draws none of its chips, and never says 'nobody is away'", () => {
    draw(cal({ away: { included: false, reason: "read_failed" } }));
    expect(screen.getByText("Leave could not be loaded, so who is away is not shown.")).toBeInTheDocument();
    expect(within(grid()).queryByText(/vacation|sick/)).not.toBeInTheDocument();
    expect(screen.queryByText(/nobody|no one|everyone is in/i)).not.toBeInTheDocument();
    // The other legs still draw.
    expect(within(grid()).getByText("Nyepi (Day of Silence)")).toBeInTheDocument();
    expect(within(grid()).getByText("Client site redesign · Staging sign-off")).toBeInTheDocument();
  });

  it("says the HR module is off, once, when holidays and leave both are", () => {
    draw(cal({ holidays: { included: false, reason: "module_off" }, away: { included: false, reason: "module_off" } }));
    expect(screen.getAllByText(/The HR module is off for this company/)).toHaveLength(1);
    expect(screen.getByText("The HR module is off for this company, so holidays and who is away are not shown.")).toBeInTheDocument();
    expect(within(grid()).queryByText(/Nyepi|vacation|sick/)).not.toBeInTheDocument();
  });

  it("says Projects could not be loaded for a failed milestone leg", () => {
    draw(cal({ deadlines: { included: false, reason: "read_failed" } }));
    expect(screen.getByText("Projects could not be loaded, so milestones are not shown.")).toBeInTheDocument();
    expect(within(grid()).queryByText(/Staging sign-off/)).not.toBeInTheDocument();
  });

  it("says a leg that was cut at 200 is cut", () => {
    draw(cal({ away: { included: true, items: [], truncated: true } }));
    expect(screen.getByText("Only the first 200 leave entries are shown, so some may be missing.")).toBeInTheDocument();
  });

  it("says 'Nothing is scheduled' after a read that succeeded and was empty, and only then", () => {
    const first = draw(cal({ holidays: empty(), away: empty(), deadlines: empty(), events: empty() }));
    expect(screen.getByText("Nothing is scheduled for this period.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: /agenda, by day/ })).not.toBeInTheDocument();
    first.unmount();
    draw(cal({ holidays: empty(), away: { included: false, reason: "read_failed" }, deadlines: empty(), events: empty() }));
    expect(screen.queryByText("Nothing is scheduled for this period.")).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing is listed for this period from what could be loaded/)).toBeInTheDocument();
  });

  it("draws no note when every leg was read", () => {
    draw();
    expect(screen.queryByRole("list", { name: "What could not be loaded" })).not.toBeInTheDocument();
  });
});
