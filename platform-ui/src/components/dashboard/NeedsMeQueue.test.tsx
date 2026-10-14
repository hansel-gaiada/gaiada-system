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
    // (--status-critical) off `--now` — this locks the band→class wiring so a future
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

// DW-4j-2 — an off-track KPI alert in Needs you: ONE action, Acknowledge, with an optional note, never Approve/Deny.
describe("NeedsMeQueue: a KPI off-track alert", () => {
  const alertItem = (over: Partial<QueueItem> = {}) =>
    item({
      id: "alert:co-a:al-1", type: "alert", title: "Projects on time is off track · Web Dev", meta: "72% against 90%", originId: "al-1",
      href: "/appraisals/department?unit=dept-1", createdAt: "2026-10-03T06:30:00.000Z", ...over,
    });

  it("labels the row KPI off track, shows the reading, and links the title to the unit's KPI page", () => {
    render(<NeedsMeQueue items={[alertItem()]} decide={vi.fn()} acknowledge={vi.fn()} />);
    expect(screen.getByText("KPI off track")).toBeInTheDocument();
    expect(screen.getByText(/72% against 90%/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Projects on time is off track · Web Dev" })).toHaveAttribute("href", "/appraisals/department?unit=dept-1");
  });

  it("renders Acknowledge and never Approve, Deny, View or Open", () => {
    render(<NeedsMeQueue items={[alertItem()]} decide={vi.fn()} acknowledge={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Acknowledge" })).toBeInTheDocument();
    expect(screen.queryByText("Approve")).not.toBeInTheDocument();
    expect(screen.queryByText("Deny")).not.toBeInTheDocument();
    expect(screen.queryByText("View")).not.toBeInTheDocument();
    expect(screen.queryByText("Open")).not.toBeInTheDocument();
  });

  it("acknowledges through the acknowledge prop with the company and the alert id, and the row leaves the list", async () => {
    const decide = vi.fn();
    const acknowledge = vi.fn(async () => ({ ok: true }));
    render(<NeedsMeQueue items={[alertItem()]} decide={decide} acknowledge={acknowledge} />);
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(screen.queryByText("Projects on time is off track · Web Dev")).not.toBeInTheDocument());
    expect(acknowledge).toHaveBeenCalledWith("co-a", "al-1", "");
    expect(decide).not.toHaveBeenCalled();
  });

  it("keeps the note collapsed until asked for, and sends what was typed", async () => {
    const acknowledge = vi.fn(async () => ({ ok: true }));
    render(<NeedsMeQueue items={[alertItem()]} decide={vi.fn()} acknowledge={acknowledge} />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add a note" }));
    const box = screen.getByRole("textbox");
    expect(box).toHaveAttribute("maxlength", "1000");
    fireEvent.change(box, { target: { value: "Rebooked the two launches." } });
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(acknowledge).toHaveBeenCalledWith("co-a", "al-1", "Rebooked the two launches."));
  });

  it("gives a refused acknowledge its row back and shows the server's sentence as sent", async () => {
    const acknowledge = vi.fn(async () => ({ ok: false, error: "outside your reporting line" }));
    render(<NeedsMeQueue items={[alertItem()]} decide={vi.fn()} acknowledge={acknowledge} />);
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(screen.getByText("outside your reporting line")).toBeInTheDocument());
    expect(screen.getByText("Projects on time is off track · Web Dev")).toBeInTheDocument(); // restored, not lost
    expect(screen.getByRole("button", { name: "Acknowledge" })).toBeInTheDocument();
  });

  it("offers only Open (and nothing that would act) where no acknowledge action is wired", () => {
    render(<NeedsMeQueue items={[alertItem()]} decide={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Acknowledge" })).not.toBeInTheDocument();
    expect(screen.getByText("Open")).toHaveAttribute("href", "/appraisals/department?unit=dept-1");
  });
});
