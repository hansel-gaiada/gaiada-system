import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { addDaysIso } from "@/lib/checkins";
import type { ActivityDay, ActivitySeries } from "@/lib/activitySeriesFormat";
import { me as meFixture, member } from "@/lib/workspaceFixtures";

// DW-4i: Analytics > My activity. The year map of all work, the kinds legend from the server, and a day's detail on selecting
// a day. Server page: the readers are mocked, and what is under test is what the page makes of each answer.
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("redirect"); }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...r }: { href: string; children?: React.ReactNode; prefetch?: boolean; scroll?: boolean }) => <a href={href} {...r}>{children}</a>,
}));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn() }));
vi.mock("@/lib/platform", async () => {
  const actual = await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform");
  return { ...actual, getMe: vi.fn() };
});
vi.mock("@/lib/entities", () => ({ listMembers: vi.fn() }));
vi.mock("@/lib/activitySeries", () => ({ getActivitySeries: vi.fn(), getActivityDay: vi.fn() }));

import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listMembers } from "@/lib/entities";
import { getActivityDay, getActivitySeries } from "@/lib/activitySeries";
import MyActivityPage from "./page";

const TO = "2026-10-15";
const KINDS = [
  { key: "github.commits", label: "Commits", source: "github" },
  { key: "webdesk.edits", label: "Site edits", source: "webdesk" },
  { key: "seo.briefs", label: "Content briefs", source: "seo" },
];
function answer(over: Record<string, Record<string, number>> = {}, userId = "u-1"): ActivitySeries {
  const days: ActivitySeries["days"] = [];
  const totals: Record<string, number> = {};
  for (let d = addDaysIso(TO, -364); d <= TO; d = addDaysIso(d, 1)) {
    const counts = over[d] ?? {};
    days.push({ date: d, counts });
    for (const [k, n] of Object.entries(counts)) totals[k] = (totals[k] ?? 0) + n;
  }
  return { userId, from: addDaysIso(TO, -364), to: TO, timezone: "UTC", kinds: KINDS, days, totals };
}
const DAY: ActivityDay = {
  userId: "u-1", date: "2026-10-14",
  items: [
    { kind: "webdesk.edits", title: "Edited: Home page", at: "2026-10-14T10:30:00.000Z" },
    { kind: "github.commits", title: "Fix header spacing", at: "2026-10-14T09:15:00.000Z", link: "/tasks/t-1" },
    { kind: "github.commits", title: "Add sitemap route", at: "2026-10-14T08:00:00.000Z" },
  ],
};
const OVER = { "2026-10-14": { "github.commits": 2, "webdesk.edits": 1 }, "2026-10-13": { "github.commits": 1 } };

const seriesMock = vi.mocked(getActivitySeries);
const dayMock = vi.mocked(getActivityDay);

const mount = async (sp: { user?: string; date?: string; unit?: string } = {}) =>
  render(await MyActivityPage({ searchParams: Promise.resolve(sp) }));

beforeEach(() => {
  vi.mocked(getMe).mockResolvedValue(meFixture([member()]));
  vi.mocked(getActiveTenant).mockResolvedValue("co-a");
  vi.mocked(listMembers).mockResolvedValue([{ user_id: "u-2", name: "Made Putra", email: "m@x.test", title: null }]);
  seriesMock.mockReset();
  dayMock.mockReset();
  seriesMock.mockResolvedValue({ kind: "ok", data: answer(OVER) });
  dayMock.mockResolvedValue({ kind: "ok", data: DAY });
});

describe("Analytics > My activity: the year map", () => {
  it("reads the person's own series with neither from nor to, and draws a grid of weeks of days", async () => {
    await mount();
    expect(seriesMock).toHaveBeenCalledWith("u-1", "co-a", { subjectUserId: "u-1" });
    const grid = screen.getByRole("grid", { name: "Activity calendar, 16 Oct 2025 to 15 Oct 2026" });
    const weeks = within(grid).getAllByRole("row");
    expect(weeks.length).toBe(53);
    expect(within(grid).getAllByRole("gridcell")).toHaveLength(365);
  });

  it("labels every cell with its date, its volume and its kinds, and a quiet day as nothing recorded", async () => {
    await mount();
    expect(screen.getByRole("link", { name: "14 Oct 2026: 3 things done. Commits 2, Site edits 1" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "13 Oct 2026: 1 thing done. Commits 1" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "12 Oct 2026: nothing recorded" })).toBeInTheDocument();
  });

  it("shades by volume against the busiest day and says so in words, with the Less to More legend", async () => {
    const { container } = await mount();
    const cell = (label: string) => screen.getByRole("link", { name: label }).closest("[role=gridcell]");
    expect(cell("14 Oct 2026: 3 things done. Commits 2, Site edits 1")).toHaveAttribute("data-level", "4");
    expect(cell("13 Oct 2026: 1 thing done. Commits 1")).toHaveAttribute("data-level", "2");
    expect(cell("12 Oct 2026: nothing recorded")).toHaveAttribute("data-level", "0");
    expect(container.textContent).toMatch(/a volume, not a rating/);
    expect(container.querySelector(".prod-heatmap__legend")).toBeTruthy();
  });

  it("lists the kinds the SERVER lists, each with its count, zero included", async () => {
    await mount();
    const list = screen.getByRole("list", { name: "Kinds of work counted" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["3Commits", "1Site edits", "0Content briefs"]);
  });

  it("has no score, no total and no rank anywhere", async () => {
    const { container } = await mount();
    expect(container.textContent).not.toMatch(/\btotal\b|\brank/i);
    expect(container.textContent).toMatch(/there is no score/);
  });

  it("each cell links to the page with that day selected", async () => {
    await mount();
    expect(screen.getByRole("link", { name: "14 Oct 2026: 3 things done. Commits 2, Site edits 1" })).toHaveAttribute("href", "/analytics/activity?date=2026-10-14");
  });
});

describe("Analytics > My activity: a day's detail", () => {
  it("says to select a day, and reads no day, until one is selected", async () => {
    await mount();
    expect(screen.getByText("Select a day on the map to see what was done.")).toBeInTheDocument();
    expect(dayMock).not.toHaveBeenCalled();
  });

  it("on selecting a day, reads that day for that person and lists the items by kind, with time and a link when present", async () => {
    await mount({ date: "2026-10-14" });
    expect(dayMock).toHaveBeenCalledWith("u-1", "co-a", { subjectUserId: "u-1", date: "2026-10-14" });
    expect(screen.getByRole("heading", { level: 3, name: "What was done on 14 Oct 2026" })).toBeInTheDocument();
    // Groups follow the server's kind order: Commits before Site edits, whatever the order of the items.
    expect(screen.getAllByRole("heading", { level: 4 }).map((h) => h.textContent)).toEqual(["Commits", "Site edits"]);
    const items = screen.getAllByRole("listitem").map((li) => li.textContent).filter((t) => /\d\d:\d\d/.test(t ?? ""));
    expect(items).toEqual(["09:15Fix header spacing", "08:00Add sitemap route", "10:30Edited: Home page"]);
    expect(screen.getByRole("link", { name: "Fix header spacing" })).toHaveAttribute("href", "/tasks/t-1");
    expect(screen.queryByRole("link", { name: "Add sitemap route" })).not.toBeInTheDocument();
  });

  it("marks the selected day on the map", async () => {
    await mount({ date: "2026-10-14" });
    expect(screen.getByRole("link", { name: "14 Oct 2026: 3 things done. Commits 2, Site edits 1" })).toHaveAttribute("aria-current", "date");
    expect(screen.getByRole("link", { name: "13 Oct 2026: 1 thing done. Commits 1" })).not.toHaveAttribute("aria-current");
  });

  it("ignores a date that is not a date, and reads nothing for it", async () => {
    await mount({ date: "tomorrow; drop table" });
    expect(dayMock).not.toHaveBeenCalled();
    expect(screen.getByText("Select a day on the map to see what was done.")).toBeInTheDocument();
  });

  it("says a day with nothing recorded is empty, not unavailable", async () => {
    dayMock.mockResolvedValue({ kind: "ok", data: { userId: "u-1", date: "2026-10-12", items: [] } });
    await mount({ date: "2026-10-12" });
    expect(screen.getByText("Nothing recorded on this day.")).toBeInTheDocument();
    expect(screen.queryByText(/Unavailable/)).not.toBeInTheDocument();
  });

  it("says in words when the day was refused or could not be read, never an empty day", async () => {
    dayMock.mockResolvedValue({ kind: "forbidden" });
    const { unmount } = await mount({ date: "2026-10-14" });
    expect(screen.getByText(/No access: you can't read this person's work for 14 Oct 2026/)).toBeInTheDocument();
    expect(screen.queryByText("Nothing recorded on this day.")).not.toBeInTheDocument();
    unmount();
    dayMock.mockResolvedValue({ kind: "error", reason: "boom" });
    await mount({ date: "2026-10-14" });
    expect(screen.getByText(/Unavailable: this day's detail could not be read \(boom\)/)).toBeInTheDocument();
  });

  it("only follows links that are paths on this site", async () => {
    dayMock.mockResolvedValue({ kind: "ok", data: { ...DAY, items: [{ kind: "github.commits", title: "Odd one", at: "2026-10-14T09:00:00.000Z", link: "https://elsewhere.example/x" }] } });
    await mount({ date: "2026-10-14" });
    expect(screen.queryByRole("link", { name: "Odd one" })).not.toBeInTheDocument();
    expect(screen.getByText("Odd one")).toBeInTheDocument();
  });
});

describe("Analytics > My activity: refusals and failures", () => {
  it("says nothing is shown on a refusal, never an empty year", async () => {
    seriesMock.mockResolvedValue({ kind: "forbidden" });
    await mount();
    expect(screen.getByText(/Nothing is shown: you can't read this activity/)).toBeInTheDocument();
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    expect(dayMock).not.toHaveBeenCalled();
  });

  it("says Unavailable with the reason on a failed read (a 404 included), never an empty year", async () => {
    seriesMock.mockResolvedValue({ kind: "error", reason: "not found" });
    await mount({ date: "2026-10-14" });
    expect(screen.getByText(/Unavailable: the activity could not be read \(not found\)/)).toBeInTheDocument();
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    expect(dayMock).not.toHaveBeenCalled();
  });

  it("asks to select a company when there is none, and reads nothing", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue(null);
    await mount();
    expect(screen.getByText("Select a company from the top bar.")).toBeInTheDocument();
    expect(seriesMock).not.toHaveBeenCalled();
  });
});

describe("Analytics > My activity: the PM view stays, and links both ways", () => {
  it("points to Project Management > Productivity, which keeps its PM-only components", async () => {
    await mount();
    expect(screen.getByRole("link", { name: "Project Management › Productivity" })).toHaveAttribute("href", "/pm?view=productivity");
  });
});

describe("Analytics > My activity: another person's view (?user=)", () => {
  it("asks the server for that person, names them, and links back to Team activity for the unit", async () => {
    seriesMock.mockResolvedValue({ kind: "ok", data: answer(OVER, "u-2") });
    await mount({ user: "u-2", unit: "dept-1" });
    expect(seriesMock).toHaveBeenCalledWith("u-1", "co-a", { subjectUserId: "u-2" });
    expect(screen.getByRole("heading", { level: 1, name: "Made Putra's activity" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Team activity" })).toHaveAttribute("href", "/analytics/activity/team?unit=dept-1");
    // A day on this person's map keeps who and which unit.
    expect(screen.getByRole("link", { name: "14 Oct 2026: 3 things done. Commits 2, Site edits 1" })).toHaveAttribute("href", "/analytics/activity?user=u-2&unit=dept-1&date=2026-10-14");
  });

  it("reads the selected day for that person", async () => {
    seriesMock.mockResolvedValue({ kind: "ok", data: answer(OVER, "u-2") });
    dayMock.mockResolvedValue({ kind: "ok", data: { ...DAY, userId: "u-2" } });
    await mount({ user: "u-2", date: "2026-10-14" });
    expect(dayMock).toHaveBeenCalledWith("u-1", "co-a", { subjectUserId: "u-2", date: "2026-10-14" });
  });

  it("lets the SERVER refuse: another person the caller may not read says nothing is shown", async () => {
    seriesMock.mockResolvedValue({ kind: "forbidden" });
    await mount({ user: "u-9" });
    expect(screen.getByText(/Nothing is shown: you can't read this person's activity/)).toBeInTheDocument();
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
  });

  it("still works when the name cannot be read", async () => {
    vi.mocked(listMembers).mockRejectedValue(new Error("down"));
    seriesMock.mockResolvedValue({ kind: "ok", data: answer(OVER, "u-2") });
    await mount({ user: "u-2" });
    expect(screen.getByRole("heading", { level: 1, name: "Activity" })).toBeInTheDocument();
    expect(screen.getByRole("grid")).toBeInTheDocument();
  });
});
