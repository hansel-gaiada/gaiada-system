import { render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OVERVIEW_WIDGETS, hasOverviewWidget, type OverviewWidgetProps } from "./index";
import { MyActivity } from "./MyActivity";
import { WidgetBoundary } from "../WidgetBoundary";
import { selectBands } from "@/lib/overview";
import { WORKSPACES, isPlanned } from "@/lib/workspaces";
import { addDaysIso } from "@/lib/checkins";
import { PlatformError } from "@/lib/platform";
import * as pm from "@/lib/pm";
import type { ProductivityDayPoint, ProductivityReport } from "@/lib/pm";
import { me as meFixture, member } from "@/lib/workspaceFixtures";

vi.mock("@/lib/pm", () => ({ getProductivity: vi.fn() }));

const person = meFixture([member()]);
const getActivity = vi.mocked(pm.getProductivity);
const TODAY = "2026-10-13";

const point = (date: string, over: Partial<ProductivityDayPoint> = {}): ProductivityDayPoint => ({
  date, completedTasks: 0, assignedCompleted: 0, involvedCompleted: 0, tasksAccepted: 0,
  reactionsGiven: 0, reactionsReceived: 0, notesContributions: 0, comments: 0, total: 0, ...over,
});
const report = (over: Record<string, Partial<ProductivityDayPoint>> = {}, extra: Partial<ProductivityReport> = {}): ProductivityReport => {
  const s: ProductivityDayPoint[] = [];
  for (let d = "2026-06-15"; d <= TODAY; d = addDaysIso(d, 1)) s.push(point(d, over[d]));
  return { userId: "u-1", from: "2026-06-15", to: TODAY, days: s.length, series: s, totals: point("x"), score: null, scoreNote: "No composite score is computed.", ...extra };
};
const props = (extra: Partial<OverviewWidgetProps> = {}): OverviewWidgetProps => ({
  me: person, tenantId: "co-a", period: "month", deptId: "d-web", unitPath: ["d-web"], tools: [],
  widget: { key: "my-activity", band: "you", label: "My activity" }, ...extra,
});
const block = () => screen.getByRole("region", { name: "My activity" });

beforeEach(() => {
  getActivity.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T08:00:00Z`));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("My activity (the widget)", () => {
  it("reads the signed-in person's own series, once, from the window's first week and without `to`", async () => {
    getActivity.mockResolvedValue(report());
    await MyActivity(props());
    expect(getActivity).toHaveBeenCalledTimes(1);
    expect(getActivity).toHaveBeenCalledWith("u-1", "co-a", { userId: "u-1", from: "2026-06-15" });
  });

  it("draws 16 full weeks and this week's days so far, each cell with its count on its date", async () => {
    getActivity.mockResolvedValue(report({ "2026-09-01": { total: 3 }, "2026-09-02": { total: 1 } }));
    const { container } = render(await MyActivity(props()));
    expect(within(block()).getByRole("heading", { level: 3, name: "My activity" })).toBeInTheDocument();
    expect(container.querySelectorAll(".prod-heatmap__cell[data-level]")).toHaveLength(16 * 7 + 2);
    expect(container.querySelector('[title^="3 things on 01 Sep"]')).toBeTruthy();
    expect(container.querySelector('[title^="1 thing on 02 Sep"]')).toBeTruthy();
    expect(container.querySelector(".prod-heatmap__legend")).toBeTruthy();
  });

  it("names what is counted, once, and links to where the full year lives", async () => {
    getActivity.mockResolvedValue(report());
    render(await MyActivity(props()));
    expect(screen.getAllByText("Counts project-management work for now")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Open my activity" })).toHaveAttribute("href", "/pm?view=productivity");
  });

  it("lists today's counts by kind, leaving out the kinds at zero", async () => {
    getActivity.mockResolvedValue(report({ [TODAY]: { completedTasks: 2, comments: 5, total: 7 } }));
    render(await MyActivity(props()));
    const items = within(block()).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["2Tasks completed", "5Comments"]);
    expect(screen.getByRole("heading", { level: 4, name: "Today so far" })).toBeInTheDocument();
    expect(screen.queryByText("Nothing recorded yet today")).not.toBeInTheDocument();
    expect(screen.queryByText("Notes")).not.toBeInTheDocument();
  });

  it("says Nothing recorded yet today on a day with nothing, and still draws the map", async () => {
    getActivity.mockResolvedValue(report({ "2026-09-01": { total: 3 } }));
    const { container } = render(await MyActivity(props()));
    expect(screen.getByText("Nothing recorded yet today")).toBeInTheDocument();
    expect(within(block()).queryAllByRole("listitem")).toHaveLength(0);
    expect(container.querySelectorAll(".prod-heatmap__cell[data-level]").length).toBeGreaterThan(0);
  });

  it("says the feature is not available when the read is a 404 (null), never an empty map or a 0", async () => {
    getActivity.mockResolvedValue(null);
    const { container } = render(await MyActivity(props()));
    expect(screen.getByText("Activity isn't available here yet")).toBeInTheDocument();
    expect(screen.queryByText("Nothing recorded yet today")).not.toBeInTheDocument();
    expect(screen.queryByText("Unavailable")).not.toBeInTheDocument();
    expect(container.querySelector(".prod-heatmap")).toBeNull();
    expect(screen.queryByRole("link", { name: "Open my activity" })).not.toBeInTheDocument();
  });

  it("throws when the read fails, and the frame's boundary says Unavailable, never the not-yet line or a 0", async () => {
    for (const failure of [new Error("down"), new PlatformError(403, "forbidden"), new PlatformError(500, "boom")]) {
      getActivity.mockReset();
      getActivity.mockRejectedValue(failure);
      const thrown = await MyActivity(props()).then(() => null, (e: unknown) => e);
      expect(thrown).toBe(failure);
    }
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Boom = () => { throw new Error("down"); };
    render(<WidgetBoundary title="My activity"><Boom /></WidgetBoundary>);
    expect(screen.getByRole("heading", { name: "My activity" })).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Activity isn't available here yet")).not.toBeInTheDocument();
  });

  it("never renders a score, even if the API ever returned one", async () => {
    getActivity.mockResolvedValue(report({ [TODAY]: { comments: 1, total: 1 } }, { score: 430, scoreNote: "Score 430 of 500" }));
    const { container } = render(await MyActivity(props()));
    expect(container.textContent).not.toMatch(/430|500|score|rating|points/i);
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
