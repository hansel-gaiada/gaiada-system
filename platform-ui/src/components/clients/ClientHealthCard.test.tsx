import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ClientHealthCard } from "./ClientHealthCard";
import type { ClientHealthDetail } from "@/lib/clientHealth";

// PV7-03 — the staff hub's Health card. What it must never do: turn a failed read into a state, list the waiting items the
// hub already lists above it, or mark a part "Client sees this" without the backend's `clientVisible`.

const signals: ClientHealthDetail["signals"] = {
  waitingOnUs: { count: 2, oldestSince: "2026-10-01T12:00:00.000Z" }, waitingOnClient: { count: 1, oldestSince: "2026-10-12T12:00:00.000Z" },
  lateDeliverables: { count: 1, oldestDue: "2026-09-20" }, lateMilestones: { count: 0, oldestDue: null },
  openChangeRequests: 1, conversationsAwaitingReply: 1, overdueInvoices: { count: 0, oldestDue: null },
  site: null, deliveryOnTime: null, activeProjects: 1, activeServices: 0,
};

function detail(over: Partial<ClientHealthDetail> = {}): ClientHealthDetail {
  return {
    clientId: "cl-1", name: "Northwind Traders", status: "active", ownerUserId: null, ownerName: null,
    state: "off_track",
    reasons: [
      { code: "waiting_on_us_14d", count: 2, since: "2026-10-01T12:00:00.000Z" },
      { code: "late_work", count: 1, since: "2026-09-20" },
    ],
    signals, asOf: "2026-10-15T12:00:00.000Z", onTimeKnownSince: "2026-10-15T09:00:00.000Z", unavailable: [],
    projects: [
      {
        projectId: "p-1", name: "Client site redesign", status: "active", clientVisible: true,
        milestones: { total: 4, done: 2, upcoming: 1, late: 1, undated: 0 },
        deliverables: { total: 3, delivered: 1, late: 1 },
        nextMilestone: { id: "m-3", name: "Build and content load", dueDate: "2026-10-24" },
      },
      {
        projectId: "p-2", name: "Quiet side project", status: "active", clientVisible: false,
        milestones: { total: 0, done: 0, upcoming: 0, late: 0, undated: 0 },
        deliverables: { total: 0, delivered: 0, late: 0 }, nextMilestone: null,
      },
    ],
    turnaround: {
      windowDays: 90,
      client: {
        medianDays: 2, n: 11, withheld: false,
        parts: [
          { kind: "client_gate", medianDays: 2, n: 4, withheld: false, clientVisible: true },
          { kind: "contract_signed", medianDays: null, n: 2, withheld: true, clientVisible: true },
          { kind: "post_review", medianDays: 1.5, n: 5, withheld: false, clientVisible: true },
        ],
      },
      ours: {
        medianDays: 1, n: 17, withheld: false,
        parts: [
          { kind: "change_request_triage", medianDays: 1, n: 6, withheld: false, clientVisible: true },
          { kind: "payment_confirmed", medianDays: 2.5, n: 3, withheld: false, clientVisible: false },
          { kind: "conversation_reply", medianDays: 0.5, n: 8, withheld: false, clientVisible: true },
        ],
      },
    },
    ...over,
  };
}

describe("ClientHealthCard", () => {
  it("shows the state chip, the plain-words reasons with their oldest dates, and says the waiting items are listed above", () => {
    render(<ClientHealthCard health={detail()} />);
    const chip = screen.getByText("Off track");
    expect(chip.getAttribute("data-state")).toBe("off_track");
    expect(screen.getByText("2 items awaiting us for 14 days or more (oldest 01 Oct 2026)")).toBeTruthy();
    expect(screen.getByText("1 late deliverable or milestone (oldest 20 Sep 2026)")).toBeTruthy();
    expect(screen.getByText("The waiting items themselves are listed above.")).toBeTruthy();
  });

  it("🔴 does not list the waiting items (the hub already lists them): no item links, no ball-list rows", () => {
    const { container } = render(<ClientHealthCard health={detail()} />);
    expect(container.querySelector(".ch-ball__item")).toBeNull();
    expect(screen.queryByText(/Confirm a client-recorded payment|Triage a new change request/)).toBeNull();
  });

  it("an on-track client has no reasons and no 'listed above' note", () => {
    render(<ClientHealthCard health={detail({ state: "on_track", reasons: [] })} />);
    expect(screen.getByText("On track")).toBeTruthy();
    expect(screen.queryByText(/listed above/)).toBeNull();
    expect(screen.getByText("Nothing is waiting too long, late or overdue.")).toBeTruthy();
  });

  it("every state renders its own label", () => {
    for (const [state, label] of [["at_risk", "At risk"], ["quiet", "Quiet"], ["unknown", "Unknown"]] as const) {
      const { unmount } = render(<ClientHealthCard health={detail({ state, reasons: [] })} />);
      expect(screen.getByText(label).getAttribute("data-state")).toBe(state);
      unmount();
    }
  });

  it("per-project health: milestones, deliverables, next milestone, and the PV-3 marker from the backend's clientVisible", () => {
    render(<ClientHealthCard health={detail()} />);
    const row = screen.getByText("Client site redesign").closest("tr") as HTMLElement;
    expect(within(row).getByText(/2 done · 1 upcoming ·/)).toBeTruthy();
    expect(within(row).getByText(/1 of 3 delivered ·/)).toBeTruthy();
    expect(within(row).getByText(/Build and content load, 24 Oct 2026/)).toBeTruthy();
    expect(within(row).getByText("Client sees this")).toBeTruthy();
    const other = screen.getByText("Quiet side project").closest("tr") as HTMLElement;
    expect(within(other).getByText("Internal")).toBeTruthy();
    expect(within(other).getByText("None dated")).toBeTruthy();
  });

  it("turnaround, both sides: days, 'Not enough yet' for a withheld part, markers per part", () => {
    render(<ClientHealthCard health={detail()} />);
    const ta = document.querySelector('[data-part="turnaround"]') as HTMLElement;
    const t = within(ta);
    expect(t.getByText("Client, all together").closest("div")!.textContent).toContain("2 days (11 replies)");
    expect(t.getByText("Us, all together").closest("div")!.textContent).toContain("1 day (17 replies)");
    const signed = t.getByText("Agreements the client signed").closest("div") as HTMLElement;
    expect(signed.textContent).toContain("Not enough yet");
    expect(signed.textContent).toContain("2 so far, 3 needed");
    expect(within(t.getByText("Client payments we confirmed").closest("div") as HTMLElement).getByText("Internal")).toBeTruthy();
    expect(within(t.getByText("Change requests we triaged").closest("div") as HTMLElement).getByText("Client sees this")).toBeTruthy();
  });

  it("🔴 a failed read is not a state: no chip, 'Could not be loaded', and the lists above stay current", () => {
    render(<ClientHealthCard health={null} />);
    expect(screen.getByText(/Health: Could not be loaded/)).toBeTruthy();
    expect(document.querySelector("[data-state]")).toBeNull();
    expect(screen.queryByText(/On track|At risk|Off track/)).toBeNull();
  });

  it("🔴 projects: null and turnaround: null read 'Could not be loaded', never an empty list or a zero", () => {
    render(<ClientHealthCard health={detail({ projects: null, turnaround: null, unavailable: ["projects", "turnaround"] })} />);
    expect(screen.getByText(/Projects: Could not be loaded/)).toBeTruthy();
    expect(screen.getByText(/Reply times: Could not be loaded/)).toBeTruthy();
    expect(screen.queryByText(/no projects yet/i)).toBeNull();
    expect(screen.getByText(/Could not be loaded: projects, reply times\./)).toBeTruthy();
  });

  it("an empty project list is said as empty (a real answer), and the on-time note names its date", () => {
    render(<ClientHealthCard health={detail({ projects: [] })} />);
    expect(screen.getByText("This client has no projects yet.")).toBeTruthy();
    expect(screen.getByText(/On-time history is recorded from 15 Oct 2026/)).toBeTruthy();
  });

  it("a part with no clientVisible from the server draws no marker (never defaulted)", () => {
    const d = detail();
    const parts = d.turnaround!.client.parts as unknown as Array<Record<string, unknown>>;
    delete parts[0].clientVisible;
    render(<ClientHealthCard health={d} />);
    const gate = screen.getByText("Approvals the client decided").closest("div") as HTMLElement;
    expect(within(gate).queryByText("Client sees this")).toBeNull();
    expect(within(gate).queryByText("Internal")).toBeNull();
  });
});
