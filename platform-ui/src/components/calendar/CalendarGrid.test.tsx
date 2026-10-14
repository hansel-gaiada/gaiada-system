import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));

import { DayView, MonthView, WeekView } from "./CalendarGrid";
import { mergeCalItems, type CalendarEventRow } from "@/lib/calendarEvents";
import type { CalItem } from "@/lib/calendar";

afterEach(cleanup);

const SG = "Asia/Singapore";
const ev = (id: string, o: Partial<CalendarEventRow> = {}): CalendarEventRow => ({
  id, tenantId: "co-a", company: "Agency", title: `Meeting ${id}`, startsAt: "2026-10-14T02:00:00.000Z", endsAt: "2026-10-14T03:00:00.000Z",
  allDay: false, startsOn: null, endsOn: null, location: null, videoUrl: null, status: "confirmed", myResponse: "accepted",
  organizer: { id: "u1", name: "Dewi" }, attendeeCount: 2, recording: null, client: null, project: null, href: `/calendar/events/${id}?company=co-a`, ...o,
});
const task: CalItem = { id: "t1", title: "Write brief", status: "todo", date: "2026-10-14", href: "/tasks/t1" };
const W = { firstDay: "2026-09-28", lastDay: "2026-11-01" };
const dayHref = (iso: string) => `/calendar?view=day&date=${iso}`;

describe("grids with events", () => {
  it("shows a task and an event in the same Month cell, the event with its start time, linking to its page", () => {
    const items = mergeCalItems([task], [ev("e1")], W, SG);
    render(<MonthView anchor="2026-10-14" today="2026-10-14" items={items} dayHref={dayHref} />);
    const taskLink = screen.getByRole("link", { name: /Write brief/ });
    const evLink = screen.getByRole("link", { name: /Meeting e1/ });
    expect(taskLink).toHaveAttribute("href", "/tasks/t1");
    expect(evLink).toHaveAttribute("href", "/calendar/events/e1?company=co-a");
    expect(within(evLink).getByText(/10:00/)).toBeInTheDocument();
    expect(evLink.className).toContain("cal-chip--event");
    expect(taskLink.className).not.toContain("cal-chip--event");
  });

  it("marks a cancelled event struck through and a declined one dimmed, and says so in words", () => {
    const items = mergeCalItems([], [ev("c", { status: "cancelled" }), ev("d", { myResponse: "declined" })], W, SG);
    render(<WeekView anchor="2026-10-14" today="2026-10-14" items={items} dayHref={dayHref} />);
    const cancelled = screen.getByRole("link", { name: /Meeting c/ });
    const declined = screen.getByRole("link", { name: /Meeting d/ });
    expect(cancelled.className).toContain("cal-chip--cancelled");
    expect(cancelled).toHaveTextContent("(cancelled)");
    expect(declined.className).toContain("cal-chip--declined");
    expect(declined).toHaveTextContent("(declined)");
  });

  it("never calls an event overdue, even one in the past", () => {
    const items = mergeCalItems([], [ev("old", { startsAt: "2026-10-01T02:00:00.000Z", endsAt: "2026-10-01T03:00:00.000Z" })], W, SG);
    render(<MonthView anchor="2026-10-14" today="2026-10-14" items={items} dayHref={dayHref} />);
    expect(screen.getByRole("link", { name: /Meeting old/ }).className).not.toContain("overdue");
  });

  it("an all-day event fills each of its days in the Week view", () => {
    const off = ev("off", { allDay: true, startsAt: null, endsAt: null, startsOn: "2026-10-14", endsOn: "2026-10-16" });
    const items = mergeCalItems([], [off], W, SG);
    render(<WeekView anchor="2026-10-14" today="2026-10-14" items={items} dayHref={dayHref} />);
    expect(screen.getAllByRole("link", { name: /Meeting off/ })).toHaveLength(3);
  });

  it("the Day view lists events with their time and keeps tasks beside them", () => {
    const items = mergeCalItems([task], [ev("e1"), ev("c", { status: "cancelled", startsAt: "2026-10-14T05:00:00.000Z", endsAt: "2026-10-14T06:00:00.000Z" })], W, SG);
    const { container } = render(<DayView anchor="2026-10-14" today="2026-10-14" items={items} />);
    expect(screen.getByText("10:00–11:00")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Write brief" })).toBeInTheDocument();
    expect(container.querySelector(".cal-day__row--cancelled")).not.toBeNull();
  });
});
