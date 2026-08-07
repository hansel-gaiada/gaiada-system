import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeAll } from "vitest";
import { Gantt } from "./Gantt";
import type { PmTask, Timeline } from "@/lib/pm";

// Gantt reads the router/pathname/search-params hooks even in its read-only mode (collapsed-group
// state is stored in ?collapsed=) — same stub shape as Board.test.tsx.
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/projects/p-1",
  useSearchParams: () => new URLSearchParams(),
}));

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
