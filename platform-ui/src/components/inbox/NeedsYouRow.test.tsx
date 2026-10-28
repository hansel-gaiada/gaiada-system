import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import type { QueueItem } from "@/lib/queueUrgency";

// SCP-Kh (SCP-Q24): the Inbox's "Needs you" row. The queue read is mocked; the real NeedsYouBlock is drawn inside.
vi.mock("@/app/(app)/actions", () => ({ decideQueueItem: vi.fn() }));
vi.mock("@/lib/deptKpiAlertActions", () => ({ acknowledgeKpiAlert: vi.fn() }));
// readNowQueue is a plain wrapper, not a spy: a spy records the rejected promise of the failure case and reports it as unhandled.
let readImpl: () => Promise<unknown> = async () => ({});
vi.mock("@/lib/overviewQueue", () => ({ readNowQueue: () => readImpl(), unreadCompanyNames: (cs: { name: string; included: boolean; partialSources: string[] }[]) =>
  cs.filter((c) => !c.included || c.partialSources.length > 0).map((c) => c.name) }));

import { InboxNeedsYou, readInboxQueue } from "./InboxNeedsYou";
import { NeedsYouRow } from "./NeedsYouRow";

const me = { userId: "u-1", companies: [], roles: [] } as never;
const task = (id: string): QueueItem => ({
  id, type: "task", title: `Title ${id}`, companyId: "co-a", company: "Agency", createdAt: "2026-10-01", decidable: true, urgencyScore: 0, href: `/x/${id}`,
});
const approval = (id: string): QueueItem => ({ ...task(id), type: "approval", origin: "agency", originId: id });
const co = (over: Partial<{ included: boolean; partialSources: string[] }> = {}) => ({ id: "co-a", name: "Agency", included: true, partialSources: [], ...over });


const mount = async (queue: { items: QueueItem[]; companies: ReturnType<typeof co>[] } | Error) => {
  readImpl = queue instanceof Error ? async () => { throw queue; } : async () => queue;
  return render(await InboxNeedsYou({ read: readInboxQueue(me) }));
};

describe("NeedsYouRow", () => {
  it("is closed by default and wires aria-expanded / aria-controls to the panel", () => {
    render(<NeedsYouRow line="2 tasks" waiting><p>inside</p></NeedsYouRow>);
    const head = screen.getByRole("button", { name: /Needs you/ });
    expect(head).toHaveAttribute("aria-expanded", "false");
    const panel = document.getElementById(head.getAttribute("aria-controls")!)!;
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveAttribute("hidden");
    fireEvent.click(head);
    expect(head).toHaveAttribute("aria-expanded", "true");
    expect(panel).not.toHaveAttribute("hidden");
    fireEvent.click(head);
    expect(panel).toHaveAttribute("hidden");
  });

  it("shows the dot only while something waits", () => {
    const { rerender } = render(<NeedsYouRow line="2 tasks" waiting />);
    expect(screen.getByRole("img", { name: "Something is waiting" })).toBeInTheDocument();
    rerender(<NeedsYouRow line="Nothing needs you right now" />);
    expect(screen.queryByRole("img", { name: "Something is waiting" })).not.toBeInTheDocument();
  });

  it("does not expand when there is nothing to open", () => {
    render(<NeedsYouRow line="Needs you is unavailable right now" expandable={false} />);
    const head = screen.getByRole("button", { name: /Needs you/ });
    expect(head).toBeDisabled();
    expect(head).not.toHaveAttribute("aria-expanded");
    fireEvent.click(head);
    expect(document.querySelector(".ny-row__panel")).toBeNull();
  });
});

describe("InboxNeedsYou", () => {
  it("summarises ALL items, and opens to the Needs you block in place", async () => {
    const items = [approval("a1"), ...Array.from({ length: 8 }, (_, i) => task(`t${i}`))];
    await mount({ items, companies: [co()] });
    expect(screen.getByText("1 to decide, 8 tasks")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Something is waiting" })).toBeInTheDocument();
    const head = screen.getByRole("button", { name: /^Needs you/ });
    expect(head).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(head);
    expect(head).toHaveAttribute("aria-expanded", "true");
    // The row is the queue's only title: the block draws no "Needs you · 9" heading and no second "Needs you" region of its own.
    expect(screen.queryByRole("heading", { name: /Needs you/ })).toBeNull();
    expect(screen.getAllByRole("region", { name: "Needs you" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show all (9)" })).toBeInTheDocument();
  });

  it("empty and every source answered: nothing, no dot", async () => {
    await mount({ items: [], companies: [co()] });
    expect(screen.getByText("Nothing needs you right now", { selector: ".ny-row__line" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Something is waiting" })).not.toBeInTheDocument();
  });

  it("empty but a company could not be read: never says nothing", async () => {
    await mount({ items: [], companies: [co({ included: false }), { ...co(), id: "co-b", name: "Studio" }] });
    expect(screen.getByText("Some sources could not be read", { selector: ".ny-row__line" })).toBeInTheDocument();
    expect(screen.queryByText("Nothing needs you right now", { selector: ".ny-row__line" })).not.toBeInTheDocument();
  });

  it("the whole read failing says unavailable and does not expand", async () => {
    await mount(new Error("down"));
    expect(screen.getByText("Needs you is unavailable right now")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Needs you/ })).toBeDisabled();
  });
});
