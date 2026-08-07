import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { Gantt } from "./Gantt";
import type { PmTask, Timeline, MilestoneMarker } from "@/lib/pm";

// Gantt reads the router/pathname/search-params hooks even in its read-only mode (collapsed-group
// state is stored in ?collapsed=) — same stub shape as Board.test.tsx. `nav.search` is mutable
// (set per-test before render) so P4-C1/P4-C2 tests can simulate `?gz=`/`?gfrom=`/`?gto=` already
// present in the URL, and `nav.replace` is asserted against to prove a control writes the URL it
// claims to.
const nav = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  search: new URLSearchParams(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: nav.refresh, replace: nav.replace, push: nav.push }),
  usePathname: () => "/projects/p-1",
  useSearchParams: () => nav.search,
}));

beforeEach(() => {
  nav.search = new URLSearchParams();
  nav.replace.mockClear();
  nav.refresh.mockClear();
  nav.push.mockClear();
});

// jsdom has no ResizeObserver; Gantt's dependency-line effect observes its container
// unconditionally (even with zero dep edges, as here). Minimal no-op stub, test-local only.
beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

function task(p: Partial<PmTask> & Pick<PmTask, "id" | "title">): PmTask {
  return {
    projectId: "p-1", projectName: "Project", description: "", status: "todo",
    priority: "normal", progress: 0, assignee: null, subtasks: [], milestoneId: null,
    startDate: "2024-01-01", dueDate: "2024-01-10", estimateMinutes: null, loggedMinutes: 0,
    dependsOn: [], tags: [], customFields: {}, updatedAt: null, recurrence: null,
    projectShortCode: null, seq: null, displayCode: null, ...p,
  };
}

function timelineFor(tasks: PmTask[]): Timeline {
  return {
    start: "2024-01-01",
    end: "2024-01-10",
    days: 9,
    bars: tasks.map((t) => ({ task: t, offsetPct: 0, widthPct: 10, startsMissing: false })),
  };
}

describe("Gantt urgency indicator (P4-G5)", () => {
  it("renders the given tier as a dot next to the bar's label, keyed by task id", () => {
    const t = task({ id: "t1", title: "Overdue bar" });
    const { container } = render(<Gantt timeline={timelineFor([t])} taskUrgency={{ t1: "overdue" }} />);
    // Two elements share the text (the dot span + its sr-only child) — assert on the
    // container's class presence rather than screen.getByText, same pattern as
    // UrgencyChip.test.tsx uses for exactly this reason.
    expect(container.querySelector(".pm-urg--overdue")).toBeTruthy();
    expect(screen.getByText("Overdue bar")).toBeInTheDocument();
  });

  it("renders no indicator when the caller supplies no map — Gantt never derives it from task dates itself", () => {
    const t = task({ id: "t1", title: "No map bar" });
    const { container } = render(<Gantt timeline={timelineFor([t])} />);
    expect(container.querySelector(".pm-urg")).toBeNull();
  });

  it("renders nothing for a bar the map marks done or undated", () => {
    const tasks = [task({ id: "t1", title: "Done bar" }), task({ id: "t2", title: "Undated bar" })];
    const { container } = render(
      <Gantt timeline={timelineFor(tasks)} taskUrgency={{ t1: "done", t2: "undated" }} />,
    );
    expect(container.querySelector(".pm-urg")).toBeNull();
  });
});

describe("Gantt zoom — Day/Week/Month (P4-C1)", () => {
  it("renders three zoom controls, none pressed when ?gz= is absent (the adaptive heuristic stays the default)", () => {
    const t = task({ id: "t1", title: "Bar" });
    render(<Gantt timeline={timelineFor([t])} />);
    for (const label of ["Day", "Week", "Month"]) {
      expect(screen.getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "false");
    }
  });

  it("picking a zoom writes ?gz= to the URL, preserving the existing pathname", () => {
    const t = task({ id: "t1", title: "Bar" });
    render(<Gantt timeline={timelineFor([t])} />);
    fireEvent.click(screen.getByRole("button", { name: "Day" }));
    expect(nav.replace).toHaveBeenCalledWith("/projects/p-1?gz=day", { scroll: false });
  });

  it("clicking the already-active zoom clears it — back to automatic, not stuck", () => {
    nav.search = new URLSearchParams("gz=week");
    const t = task({ id: "t1", title: "Bar" });
    render(<Gantt timeline={timelineFor([t])} />);
    expect(screen.getByRole("button", { name: "Week" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Week" }));
    // No other params were present, so clearing `gz` leaves a bare path.
    expect(nav.replace).toHaveBeenCalledWith("/projects/p-1", { scroll: false });
  });

  it("Month zoom renders calendar-month ticks (with a year label) even past the 366-day dense cap, and suppresses weekend banding", () => {
    nav.search = new URLSearchParams("gz=month");
    const t = task({ id: "t1", title: "Long bar", startDate: "2024-01-01", dueDate: "2024-01-05" });
    const timeline: Timeline = {
      start: "2024-01-01", end: "2026-01-01", days: 731, // >366 days — the day/week dense cap alone would fall back to the plain axis
      bars: [{ task: t, offsetPct: 0, widthPct: 1, startsMissing: false }],
    };
    const { container } = render(<Gantt timeline={timeline} />);
    expect(container.querySelector(".pm-gantt__daxis")).toBeTruthy();
    expect(screen.getByText("Jan 2024")).toBeInTheDocument();
    expect(container.querySelector(".pm-gantt__axis")).toBeNull(); // the coarse start/end fallback did NOT render
    expect(container.querySelectorAll(".pm-gantt__weekend").length).toBe(0);
  });

  it("without an explicit zoom, a >366-day span still falls back to the plain start/end axis (unchanged heuristic behaviour)", () => {
    const t = task({ id: "t1", title: "Long bar" });
    const timeline: Timeline = {
      start: "2024-01-01", end: "2026-01-01", days: 731,
      bars: [{ task: t, offsetPct: 0, widthPct: 1, startsMissing: false }],
    };
    const { container } = render(<Gantt timeline={timeline} />);
    expect(container.querySelector(".pm-gantt__daxis")).toBeNull();
    expect(container.querySelector(".pm-gantt__axis")).toBeTruthy();
  });
});

describe("Gantt explicit date window (P4-C2)", () => {
  it("the two date fields default to the server-derived window when no override is present", () => {
    const t = task({ id: "t1", title: "Bar" });
    render(<Gantt timeline={timelineFor([t])} />);
    expect(screen.getByLabelText("Window start")).toHaveValue("2024-01-01");
    expect(screen.getByLabelText("Window end")).toHaveValue("2024-01-10");
    // No override active yet, so there is nothing to clear.
    expect(screen.queryByRole("button", { name: /clear date window/i })).toBeNull();
  });

  it("Apply writes ?gfrom=/?gto= to the URL", () => {
    const t = task({ id: "t1", title: "Bar" });
    render(<Gantt timeline={timelineFor([t])} />);
    fireEvent.change(screen.getByLabelText("Window start"), { target: { value: "2024-01-02" } });
    fireEvent.change(screen.getByLabelText("Window end"), { target: { value: "2024-01-08" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(nav.replace).toHaveBeenCalledWith("/projects/p-1?gfrom=2024-01-02&gto=2024-01-08", { scroll: false });
  });

  it("refuses an end date before the start date — no navigation, an announced reason instead", () => {
    const t = task({ id: "t1", title: "Bar" });
    render(<Gantt timeline={timelineFor([t])} />);
    fireEvent.change(screen.getByLabelText("Window start"), { target: { value: "2024-01-08" } });
    fireEvent.change(screen.getByLabelText("Window end"), { target: { value: "2024-01-02" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(nav.replace).not.toHaveBeenCalled();
    expect(screen.getByText("End date must be on or after the start date.")).toBeInTheDocument();
  });

  it("the × clears the window, removing only gfrom/gto and leaving other params alone", () => {
    nav.search = new URLSearchParams("gfrom=2024-01-02&gto=2024-01-08&collapsed=x");
    const t = task({ id: "t1", title: "Bar" });
    render(<Gantt timeline={timelineFor([t])} />);
    fireEvent.click(screen.getByRole("button", { name: /clear date window/i }));
    expect(nav.replace).toHaveBeenCalledWith("/projects/p-1?collapsed=x", { scroll: false });
  });

  it("drops a task whose dates fall entirely outside the window, and keeps one that overlaps it", () => {
    nav.search = new URLSearchParams("gfrom=2024-01-01&gto=2024-01-10");
    const inWindow = task({ id: "t1", title: "In window", startDate: "2024-01-01", dueDate: "2024-01-05" });
    const outside = task({ id: "t2", title: "Outside window", startDate: "2024-02-01", dueDate: "2024-02-05" });
    render(<Gantt timeline={timelineFor([inWindow, outside])} />);
    expect(screen.getByText("In window")).toBeInTheDocument();
    expect(screen.queryByText("Outside window")).toBeNull();
  });

  it("repositions a milestone inside the window and hides one outside it", () => {
    nav.search = new URLSearchParams("gfrom=2024-01-01&gto=2024-01-10");
    const t = task({ id: "t1", title: "Bar" });
    const milestones: MilestoneMarker[] = [
      { id: "m1", name: "Kickoff", date: "2024-01-03", offsetPct: 50 },
      { id: "m2", name: "Way later", date: "2024-03-01", offsetPct: 90 },
    ];
    const { container } = render(<Gantt timeline={timelineFor([t])} milestones={milestones} />);
    expect(container.querySelectorAll(".pm-gantt__milestone")).toHaveLength(1);
    expect(screen.getByTitle(/Kickoff/)).toBeInTheDocument();
  });
});
