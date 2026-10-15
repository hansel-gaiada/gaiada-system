import { render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OVERVIEW_WIDGETS, hasOverviewWidget, type OverviewWidgetProps } from "./index";
import { MyActivity } from "./MyActivity";
import { WidgetBoundary } from "../WidgetBoundary";
import { selectBands } from "@/lib/overview";
import { WORKSPACES, isPlanned } from "@/lib/workspaces";
import { addDaysIso } from "@/lib/checkins";
import * as series from "@/lib/activitySeries";
import type { ActivitySeries } from "@/lib/activitySeriesFormat";
import { me as meFixture, member } from "@/lib/workspaceFixtures";

vi.mock("@/lib/activitySeries", () => ({ getActivitySeries: vi.fn() }));

const person = meFixture([member()]);
const getSeries = vi.mocked(series.getActivitySeries);
const TODAY = "2026-10-13";

const KINDS = [
  { key: "pm.tasks_completed", label: "Tasks completed", source: "pm" },
  { key: "github.commits", label: "Commits", source: "github" },
  { key: "webdesk.edits", label: "Site edits", source: "webdesk" },
  { key: "pm.comments", label: "Comments", source: "pm" },
];
/** The server's answer: a zero-filled year ending on its own `to`, with `over` counts on chosen days. */
const answer = (over: Record<string, Record<string, number>> = {}, extra: Record<string, unknown> = {}, to = TODAY): ActivitySeries => {
  const days: ActivitySeries["days"] = [];
  const totals: Record<string, number> = {};
  for (let d = addDaysIso(to, -364); d <= to; d = addDaysIso(d, 1)) {
    const counts = over[d] ?? {};
    days.push({ date: d, counts });
    for (const [k, n] of Object.entries(counts)) totals[k] = (totals[k] ?? 0) + n;
  }
  return { userId: "u-1", from: addDaysIso(to, -364), to, timezone: "Asia/Makassar", kinds: KINDS, days, totals, ...extra } as ActivitySeries;
};
const props = (extra: Partial<OverviewWidgetProps> = {}): OverviewWidgetProps => ({
  me: person, tenantId: "co-a", period: "month", deptId: "d-web", unitPath: ["d-web"], tools: [],
  widget: { key: "my-activity", band: "you", label: "My activity" }, ...extra,
});
const block = () => screen.getByRole("region", { name: "My activity" });

beforeEach(() => {
  getSeries.mockReset();
  // The machine's clock is deliberately a day AFTER the server's today: the window must still end on the server's `to`.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T08:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("My activity (the widget)", () => {
  it("reads the signed-in person's own all-work series, once, with neither from nor to (the server decides what today is)", async () => {
    getSeries.mockResolvedValue({ kind: "ok", data: answer() });
    await MyActivity(props());
    expect(getSeries).toHaveBeenCalledTimes(1);
    expect(getSeries).toHaveBeenCalledWith("u-1", "co-a", { subjectUserId: "u-1" });
  });

  it("draws 16 full weeks and this week's days so far, each cell with its volume and its kinds on its date", async () => {
    getSeries.mockResolvedValue({ kind: "ok", data: answer({ "2026-09-01": { "github.commits": 2, "webdesk.edits": 1 }, "2026-09-02": { "pm.comments": 1 } }) });
    const { container } = render(await MyActivity(props()));
    expect(within(block()).getByRole("heading", { level: 3, name: "My activity" })).toBeInTheDocument();
    expect(container.querySelectorAll(".prod-heatmap__cell[data-level]")).toHaveLength(16 * 7 + 2);
    expect(container.querySelector('[title^="01 Sep 2026: 3 things done. Commits 2, Site edits 1"]')).toBeTruthy();
    expect(container.querySelector('[title^="02 Sep 2026: 1 thing done. Comments 1"]')).toBeTruthy();
    expect(container.querySelector(".prod-heatmap__legend")).toBeTruthy();
  });

  it("ends the window on the server's own today, not on the machine's UTC date", async () => {
    getSeries.mockResolvedValue({ kind: "ok", data: answer({}, {}, "2026-10-13") });
    render(await MyActivity(props()));
    expect(block().querySelector(".prod-heatmap__grid")).toHaveAttribute("aria-label", "Activity calendar, 22 Jun 2026 to 13 Oct 2026");
  });

  it("no longer says it counts project-management work only, and links to Analytics > My activity", async () => {
    getSeries.mockResolvedValue({ kind: "ok", data: answer() });
    const { container } = render(await MyActivity(props()));
    expect(container.textContent).not.toMatch(/project-management work|for now/i);
    expect(screen.getByRole("link", { name: "Open my activity" })).toHaveAttribute("href", "/analytics/activity");
  });

  it("lists today's counts by the server's kinds, leaving out the kinds at zero", async () => {
    getSeries.mockResolvedValue({ kind: "ok", data: answer({ [TODAY]: { "pm.tasks_completed": 2, "github.commits": 5 } }) });
    render(await MyActivity(props()));
    const items = within(block()).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["2Tasks completed", "5Commits"]);
    expect(screen.getByRole("heading", { level: 4, name: "Today so far" })).toBeInTheDocument();
    expect(screen.queryByText("Nothing recorded yet today")).not.toBeInTheDocument();
    expect(screen.queryByText("Site edits")).not.toBeInTheDocument();
  });

  it("takes the kinds from the server, so a company with other modules sees its own", async () => {
    const kinds = [{ key: "seo.briefs", label: "Content briefs", source: "seo" }];
    getSeries.mockResolvedValue({ kind: "ok", data: answer({ [TODAY]: { "seo.briefs": 3 } }, { kinds }) });
    render(await MyActivity(props()));
    expect(within(block()).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["3Content briefs"]);
  });

  it("says Nothing recorded yet today on a day with nothing, and still draws the map", async () => {
    getSeries.mockResolvedValue({ kind: "ok", data: answer({ "2026-09-01": { "github.commits": 3 } }) });
    const { container } = render(await MyActivity(props()));
    expect(screen.getByText("Nothing recorded yet today")).toBeInTheDocument();
    expect(within(block()).queryAllByRole("listitem")).toHaveLength(0);
    expect(container.querySelectorAll(".prod-heatmap__cell[data-level]").length).toBeGreaterThan(0);
  });

  it("says nothing is shown on a refusal (403), never an empty map, a 0 or Unavailable", async () => {
    getSeries.mockResolvedValue({ kind: "forbidden" });
    const { container } = render(await MyActivity(props()));
    expect(screen.getByText("Nothing is shown: you can't read this activity")).toBeInTheDocument();
    expect(screen.queryByText("Nothing recorded yet today")).not.toBeInTheDocument();
    expect(screen.queryByText("Unavailable")).not.toBeInTheDocument();
    expect(container.querySelector(".prod-heatmap")).toBeNull();
    expect(screen.queryByRole("link", { name: "Open my activity" })).not.toBeInTheDocument();
  });

  it("throws when the read failed (a 404 included), and the frame's boundary says Unavailable, never an empty map or a 0", async () => {
    for (const reason of ["down", "not found", "unexpected answer from the activity endpoint"]) {
      getSeries.mockReset();
      getSeries.mockResolvedValue({ kind: "error", reason });
      const thrown = await MyActivity(props()).then(() => null, (e: unknown) => e);
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe(reason);
    }
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Boom = () => { throw new Error("down"); };
    render(<WidgetBoundary title="My activity"><Boom /></WidgetBoundary>);
    expect(screen.getByRole("heading", { name: "My activity" })).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Nothing recorded yet today")).not.toBeInTheDocument();
  });

  it("never renders a score, even if the API ever returned one", async () => {
    getSeries.mockResolvedValue({ kind: "ok", data: answer({ [TODAY]: { "pm.comments": 1 } }, { score: 430, total: 99, scoreNote: "Score 430 of 500" }) });
    const { container } = render(await MyActivity(props()));
    expect(container.textContent).not.toMatch(/430|500|99|score|rating|points/i);
    expect(container.textContent).not.toMatch(/total/i);
  });
});

describe("My activity is registered (DW-3j)", () => {
  it("has a component, and no ticket, in every department workspace, after Your numbers", () => {
    expect(hasOverviewWidget("my-activity")).toBe(true);
    expect(OVERVIEW_WIDGETS["my-activity"]).toBe(MyActivity);
    const ctx = { me: person, tenantId: "co-a", unitPath: ["d-web"] };
    for (const ws of WORKSPACES.filter((w) => w.overview[0].key !== "decisions")) {
      const activity = ws.overview.find((w) => w.key === "my-activity")!;
      expect(activity.ticket, ws.key).toBeUndefined();
      expect(isPlanned(activity), ws.key).toBe(false);
      const you = selectBands(ws.overview, ctx, (key) => hasOverviewWidget(key)).find((b) => b.band === "you");
      expect(you?.widgets.map((w) => w.key), ws.key).toEqual(["your-numbers", "my-activity"]);
    }
  });

  it("is not in the company frame", () => {
    const company = WORKSPACES.find((w) => w.overview[0].key === "decisions")!;
    expect(company.overview.some((w) => w.key === "my-activity")).toBe(false);
  });
});
