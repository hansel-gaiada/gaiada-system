import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { NeedsMeQueue } from "./NeedsMeQueue";
import type { QueueItem } from "@/lib/queueUrgency";

function item(p: Partial<QueueItem> & Pick<QueueItem, "id" | "type" | "title">): QueueItem {
  return { companyId: "co-a", company: "Agency", createdAt: "2026-01-01", decidable: true, urgencyScore: 0, ...p };
}

describe("NeedsMeQueue", () => {
  it("renders the empty state when there is nothing to show", () => {
    render(<NeedsMeQueue items={[]} decide={vi.fn()} />);
    expect(screen.getByText("Nothing needs you right now.")).toBeInTheDocument();
  });

  it("renders Approve/Deny for a decidable approval and dispatches through the decide prop", async () => {
    const decide = vi.fn(async () => ({ ok: true }));
    render(
      <NeedsMeQueue
        items={[item({ id: "agency:a1", type: "approval", title: "Hero asset", origin: "agency", originId: "a1" })]}
        decide={decide}
      />,
    );
    expect(screen.getByText("Hero asset")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Approve"));
    await waitFor(() => expect(screen.queryByText("Hero asset")).not.toBeInTheDocument());
    expect(decide).toHaveBeenCalledWith("co-a", "agency", "a1", "approved");
  });

  it("renders a View link (no decide buttons) when the item is not decidable", () => {
    render(
      <NeedsMeQueue
        items={[item({ id: "agency:a2", type: "approval", title: "Someone else's call", origin: "agency", originId: "a2", decidable: false, href: "/agency/c1" })]}
        decide={vi.fn()}
      />,
    );
    expect(screen.queryByText("Approve")).not.toBeInTheDocument();
    expect(screen.getByText("View")).toBeInTheDocument();
  });

  it("renders an Open link for a task row, no Approve/Deny", () => {
    render(
      <NeedsMeQueue
        items={[item({ id: "task:co-a:t1", type: "task", title: "Ship SEO audit", href: "/tasks/t1" })]}
        decide={vi.fn()}
      />,
    );
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.queryByText("Approve")).not.toBeInTheDocument();
  });

  it("maps the urgency band to the dot class the alarm colour is keyed on (WSUX-11 Major-1 guard)", () => {
    // "now" (approvals/gates, overdue tasks) must render the alarm-mapped
    // `--now` dot class; "today" (due today, not yet late) must render the
    // calm-mapped `--today` class. dashboard.css keys its one alarm colour
    // (#B5622F) off `--now` — this locks the band→class wiring so a future
    // edit can't silently swap them without a red test.
    const { container, rerender } = render(
      <NeedsMeQueue
        items={[item({ id: "agency:a4", type: "approval", title: "Needs a decision", origin: "agency", originId: "a4" })]}
        decide={vi.fn()}
      />,
    );
    expect(container.querySelector(".needs-me-queue__dot--now")).toBeInTheDocument();
    expect(container.querySelector(".needs-me-queue__dot--today")).not.toBeInTheDocument();

    const todayIso = new Date().toISOString();
    rerender(
      <NeedsMeQueue
        items={[item({ id: "task:co-a:t2", type: "task", title: "Due today, on track", dueDate: todayIso, href: "/tasks/t2" })]}
        decide={vi.fn()}
      />,
    );
    expect(container.querySelector(".needs-me-queue__dot--today")).toBeInTheDocument();
    expect(container.querySelector(".needs-me-queue__dot--now")).not.toBeInTheDocument();
  });

  it("restores the row and shows an error toast when decide fails", async () => {
    const decide = vi.fn(async () => ({ ok: false, error: "nope" }));
    render(
      <NeedsMeQueue
        items={[item({ id: "agency:a3", type: "approval", title: "Flaky one", origin: "agency", originId: "a3" })]}
        decide={decide}
      />,
    );
    fireEvent.click(screen.getByText("Approve"));
    await waitFor(() => expect(screen.getByText("nope")).toBeInTheDocument());
    expect(screen.getByText("Flaky one")).toBeInTheDocument(); // restored, not lost
  });
});
