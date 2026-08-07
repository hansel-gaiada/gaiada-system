import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { PmHome, type PmHomeProps, type PmHomeTask } from "./PmHome";
import { PM_TERMS } from "@/lib/pmVocabulary";

function task(overrides: Partial<PmHomeTask> & { id: string }): PmHomeTask {
  return {
    href: `/tasks/${overrides.id}`,
    title: "Untitled",
    projectName: "Website Relaunch",
    statusLabel: "ToDo",
    statusColor: "var(--pm-status-todo)",
    dueDate: null,
    urgencyTier: "undated",
    assigneeName: null,
    ...overrides,
  };
}

const baseProps: PmHomeProps = {
  today: "2026-08-07",
  windowLabel: "7/31 – 8/7",
  todaysTodo: [],
  completedTasks: [],
  tasksWithActivity: [],
  upcomingSchedule: [],
};

describe("PmHome — P4-A8", () => {
  it("renders the 4 Repsona columns with the vocabulary's own labels", () => {
    const { container } = render(<PmHome {...baseProps} />);
    const titles = [...container.querySelectorAll(".pm-home__col-title")].map((n) => n.textContent);
    expect(titles.some((t) => t?.includes(PM_TERMS.todaysTodo))).toBe(true);
    expect(titles.some((t) => t?.includes(PM_TERMS.completedTasks))).toBe(true);
    expect(titles.some((t) => t?.includes(PM_TERMS.tasksWithActivity))).toBe(true);
    expect(titles.some((t) => t?.includes(PM_TERMS.upcomingSchedule))).toBe(true);
  });

  it("shows the explicit 7-day window on the activity + upcoming columns only", () => {
    const { container } = render(<PmHome {...baseProps} />);
    const windows = container.querySelectorAll(".pm-home__col-window");
    expect(windows.length).toBe(2);
    windows.forEach((w) => expect(w.textContent).toBe("7/31 – 8/7"));
  });

  it("renders a comment excerpt with its author on a Tasks-with-Activity card", () => {
    const props: PmHomeProps = {
      ...baseProps,
      tasksWithActivity: [
        {
          statusId: "todo",
          statusLabel: "ToDo",
          statusColor: "var(--pm-status-todo)",
          tasks: [task({ id: "t4", title: "Ship hero copy", commentExcerpt: "Looks good, ship it", commentAuthor: "Alice" })],
        },
      ],
    };
    const { container } = render(<PmHome {...props} />);
    const excerpt = container.querySelector(".pm-home__excerpt");
    expect(excerpt?.textContent).toContain("Looks good, ship it");
    expect(excerpt?.textContent).toContain("Alice");
  });

  it("never renders an excerpt block on a card that has none", () => {
    const props: PmHomeProps = { ...baseProps, todaysTodo: [task({ id: "t1", title: "Plain task" })] };
    const { container } = render(<PmHome {...props} />);
    expect(container.querySelector(".pm-home__excerpt")).toBeNull();
  });

  it("shows the empty state for a column with no tasks", () => {
    const { container } = render(<PmHome {...baseProps} />);
    expect(container.querySelectorAll(".pm-home__empty").length).toBe(4);
  });

  it("groups Tasks-with-Activity and Upcoming Schedule by status, each with its own count", () => {
    const props: PmHomeProps = {
      ...baseProps,
      upcomingSchedule: [
        { statusId: "todo", statusLabel: "ToDo", statusColor: "var(--pm-status-todo)", tasks: [task({ id: "a" }), task({ id: "b" })] },
        { statusId: "in_progress", statusLabel: "Doing", statusColor: "var(--pm-status-in-progress)", tasks: [task({ id: "c" })] },
      ],
    };
    const { container } = render(<PmHome {...props} />);
    const groupCounts = [...container.querySelectorAll(".pm-home__group-count")].map((n) => n.textContent);
    expect(groupCounts).toEqual(["2", "1"]);
  });

  it("renders an avatar with a real accessible name, and the empty state for no ball holder", () => {
    const props: PmHomeProps = {
      ...baseProps,
      todaysTodo: [task({ id: "t1", assigneeName: "Gede" }), task({ id: "t2", assigneeName: null })],
    };
    const { container } = render(<PmHome {...props} />);
    const srNames = [...container.querySelectorAll(".pm-home__avatar .pm-sr-only")].map((n) => n.textContent);
    expect(srNames).toContain("Gede");
    expect(srNames).toContain(PM_TERMS.unassigned);
  });
});
