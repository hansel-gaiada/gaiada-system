import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { NeedsYouBlock } from "./NeedsYouBlock";
import type { QueueItem } from "@/lib/queueUrgency";

vi.mock("@/app/(app)/actions", () => ({ decideQueueItem: vi.fn() }));

const item = (id: string, type: QueueItem["type"], extra: Partial<QueueItem> = {}): QueueItem => ({
  id, type, title: `Title ${id}`, companyId: "co-a", company: "Agency", createdAt: "2026-10-01",
  decidable: true, urgencyScore: 0, href: `/x/${id}`, ...extra,
});
const tasks = (n: number) => Array.from({ length: n }, (_, i) => item(`t${i + 1}`, "task"));
const decide = () => vi.fn(async () => ({ ok: true }));
const approval = () => item("agency:co-a:a1", "approval", { origin: "agency", originId: "a1" });

describe("NeedsYouBlock", () => {
  it("shows the count in the title and the first six rows, with Show all for the rest", () => {
    render(<NeedsYouBlock items={tasks(9)} decide={decide()} />);
    expect(screen.getByRole("heading", { name: "Needs you · 9" })).toBeInTheDocument();
    expect(screen.getAllByText(/^Title t/)).toHaveLength(6);
    expect(screen.queryByText("Title t7")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show all (9)" })).toHaveAttribute("aria-expanded", "false");
  });

  it("expands the whole list in place on Show all, and folds it back", () => {
    render(<NeedsYouBlock items={tasks(9)} decide={decide()} />);
    fireEvent.click(screen.getByRole("button", { name: "Show all (9)" }));
    expect(screen.getAllByText(/^Title t/)).toHaveLength(9);
    expect(screen.getByText("Title t9")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(screen.getAllByText(/^Title t/)).toHaveLength(6);
  });

  it("offers no Show all when everything already fits", () => {
    render(<NeedsYouBlock items={tasks(6)} decide={decide()} />);
    expect(screen.getAllByText(/^Title t/)).toHaveLength(6);
    expect(screen.queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument();
  });

  it("keeps today's inline decide: Approve and Deny on a decidable approval, through the decide action", async () => {
    const d = decide();
    render(<NeedsYouBlock items={[approval()]} decide={d} />);
    const row = screen.getByText("Title agency:co-a:a1").closest(".needs-me-queue__row") as HTMLElement;
    expect(within(row).getByRole("button", { name: "Deny" })).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(d).toHaveBeenCalledWith("co-a", "agency", "a1", "approved"));
    // Decided: the row goes and the title no longer counts it; the block says nothing is waiting.
    await waitFor(() => expect(screen.queryByText("Title agency:co-a:a1")).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Needs you" })).toBeInTheDocument();
    expect(screen.getByText("Nothing needs you right now")).toBeInTheDocument();
  });

  it("a decided item makes room: the seventh row moves up into the top six", async () => {
    render(<NeedsYouBlock items={[approval(), ...tasks(6)]} decide={decide()} />);
    expect(screen.queryByText("Title t6")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByText("Title t6")).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Needs you · 6" })).toBeInTheDocument();
  });

  it("gives a refused decide back its row and says why", async () => {
    const d = vi.fn(async () => ({ ok: false, error: "Not allowed" }));
    render(<NeedsYouBlock items={[approval()]} decide={d} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByText("Not allowed")).toBeInTheDocument());
    expect(screen.getByText("Title agency:co-a:a1")).toBeInTheDocument();
  });

  it("says Nothing needs you right now for an empty queue, never a 0", () => {
    render(<NeedsYouBlock items={[]} decide={decide()} />);
    expect(screen.getByRole("heading", { name: "Needs you" })).toBeInTheDocument();
    expect(screen.getByText("Nothing needs you right now")).toBeInTheDocument();
    expect(screen.queryByText(/·\s*0/)).not.toBeInTheDocument();
    expect(screen.queryByText("Some sources could not be read")).not.toBeInTheDocument();
  });

  it("shows the items and a quiet note when some sources could not be read", () => {
    render(<NeedsYouBlock items={tasks(2)} unread={["Agency"]} decide={decide()} />);
    expect(screen.getByText("Title t1")).toBeInTheDocument();
    expect(screen.getByText("Some sources could not be read")).toBeInTheDocument();
  });

  it("does not claim a settled empty queue when it is also partial", () => {
    render(<NeedsYouBlock items={[]} unread={["Agency"]} decide={decide()} />);
    expect(screen.queryByText("Nothing needs you right now")).not.toBeInTheDocument();
    expect(screen.getByText("Nothing found in the sources that could be read.")).toBeInTheDocument();
    expect(screen.getByText("Some sources could not be read")).toBeInTheDocument();
  });

  it("tags each row with its company only when the person has more than one", () => {
    const rows = [item("a", "task", { company: "Agency" }), item("b", "task", { company: "Hotel", companyId: "co-h" })];
    const { container, unmount } = render(<NeedsYouBlock items={rows} multiCompany decide={decide()} />);
    expect([...container.querySelectorAll(".needs-me-queue__company")].map((n) => n.textContent)).toEqual(["Agency", "Hotel"]);
    unmount();
    const single = render(<NeedsYouBlock items={rows} decide={decide()} />);
    expect(single.container.querySelectorAll(".needs-me-queue__company")).toHaveLength(0);
  });

  it("names the companies that could not be read, with several companies", () => {
    render(<NeedsYouBlock items={tasks(1)} unread={["Hotel", "Spa"]} multiCompany decide={decide()} />);
    expect(screen.getByText("Some sources could not be read: Hotel, Spa")).toBeInTheDocument();
  });
});
