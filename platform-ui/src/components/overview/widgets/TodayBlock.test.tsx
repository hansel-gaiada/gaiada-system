import { render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { TodayBlock } from "./TodayBlock";
import type { QueueItem } from "@/lib/queueUrgency";
import type { CheckinCardData } from "@/lib/checkins-data";
import type { LauncherItem } from "@/components/departments/LauncherRow";

const checkin: CheckinCardData = {
  today: {
    date: "2026-10-13", expected: true, alreadySubmitted: false, existing: null,
    draft: {
      summaryText: "Logged 3h on the Kopi Lima rebuild.", minutesLogged: 180, minutesBillable: 120,
      byProject: [], tasksCompleted: [], tasksCreated: [], tasksMoved: [], commentsAuthored: 0, docsUpdated: 0, otherActivityEvents: 0,
    },
  },
  selfCompliance: { windowDays: 0, submittedCount: 0, missedCount: 0, excusedCount: 0, rate: null, currentStreak: 0 },
};
const due = (id: string, extra: Partial<QueueItem> = {}): QueueItem => ({
  id, type: "task", title: `Task ${id}`, companyId: "co-a", company: "Agency", createdAt: "2026-10-01",
  decidable: true, urgencyScore: 0, dueDate: "2026-10-13", href: `/tasks/${id}`, ...extra,
});
const tools: LauncherItem[] = [
  { key: "github", label: "GitHub", desc: "Repositories.", href: "https://github.com", glyph: "G" },
  { key: "claude", label: "Claude", desc: "Chat.", href: "https://claude.ai/new", glyph: "C", icon: "claude" },
];

const draw = (p: Partial<Parameters<typeof TodayBlock>[0]> = {}) =>
  render(<TodayBlock tenantId="co-a" checkin={checkin} submitAction={vi.fn()} dueToday={[]} partial={false} tools={tools} {...p} />);

describe("TodayBlock", () => {
  it("draws today's check-in card, so it can still be submitted from the Overview", () => {
    draw();
    expect(screen.getByRole("heading", { name: "Today" })).toBeInTheDocument();
    expect((screen.getByLabelText("Summary") as HTMLTextAreaElement).value).toBe("Logged 3h on the Kopi Lima rebuild.");
    expect(screen.getByRole("button", { name: "Confirm & submit" })).toBeInTheDocument();
    expect(screen.queryByText("Check-in unavailable")).not.toBeInTheDocument();
  });

  it("says Check-in unavailable when the check-in could not be read, and still draws the rest", () => {
    draw({ checkin: null, dueToday: [due("t1")] });
    expect(screen.getByText("Check-in unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm & submit" })).not.toBeInTheDocument();
    expect(screen.getByText("Task t1")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /GitHub/ })).toBeInTheDocument();
  });

  it("lists what is due today as links, with its project", () => {
    draw({ dueToday: [due("t1", { meta: "Kopi Lima" }), due("t2", { href: undefined })] });
    const part = screen.getByRole("heading", { name: "Due today" }).parentElement as HTMLElement;
    expect(within(part).getByRole("link", { name: "Task t1" })).toHaveAttribute("href", "/tasks/t1");
    expect(within(part).getByText(/Kopi Lima/)).toBeInTheDocument();
    // No link is invented for an item without a page.
    expect(within(part).getByText("Task t2")).toBeInTheDocument();
    expect(within(part).queryByRole("link", { name: "Task t2" })).not.toBeInTheDocument();
  });

  it("says Nothing due today when nothing is, and unavailable (never nothing) when the queue could not be read", () => {
    const { unmount } = draw({ dueToday: [] });
    expect(screen.getByText("Nothing due today")).toBeInTheDocument();
    unmount();
    draw({ dueToday: null });
    expect(screen.getByText("Due today is unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Nothing due today")).not.toBeInTheDocument();
  });

  it("does not call a partial empty list settled, and notes a partial one", () => {
    const { unmount } = draw({ dueToday: [], partial: true });
    expect(screen.queryByText("Nothing due today")).not.toBeInTheDocument();
    expect(screen.getByText("Nothing found in the sources that could be read.")).toBeInTheDocument();
    unmount();
    draw({ dueToday: [due("t1")], partial: true });
    expect(screen.getByText("Some sources could not be read")).toBeInTheDocument();
  });

  it("lists the workspace's tools like the department Home's row", () => {
    draw();
    const part = screen.getByRole("heading", { name: "Tools" }).parentElement as HTMLElement;
    const links = within(part).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://github.com", "https://claude.ai/new"]);
    expect(links[0]).toHaveAttribute("aria-label", "GitHub — Repositories.");
    expect(links[0]).toHaveAttribute("target", "_blank");
  });

  it("draws no Tools part for a workspace without tools (Company), and invents no calendar", () => {
    draw({ tools: [] });
    expect(screen.queryByRole("heading", { name: "Tools" })).not.toBeInTheDocument();
    expect(screen.queryByText(/calendar|meeting|agenda/i)).not.toBeInTheDocument();
  });
});
