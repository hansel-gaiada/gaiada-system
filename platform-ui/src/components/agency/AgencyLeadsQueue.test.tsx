import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));

import { AgencyLeadsQueue } from "./AgencyLeadsQueue";
import type { LeadQueueRow, PipelineCurrency, PipelineStage } from "@/lib/agencyLeads";

const STAGES: PipelineStage[] = [
  { key: "enquiry", position: 10, kind: "open", label: "Enquiry" },
  { key: "contacted", position: 20, kind: "open", label: "Contacted" },
  { key: "qualified", position: 30, kind: "open", label: "Qualified" },
  { key: "proposal", position: 40, kind: "open", label: "Proposal sent" },
  { key: "won", position: 90, kind: "won", label: "Won" },
  { key: "lost", position: 99, kind: "lost", label: "Lost" },
];
const CURRENCIES: PipelineCurrency[] = [
  { code: "IDR", symbol: "Rp", minorUnit: 0 },
  { code: "USD", symbol: "$", minorUnit: 2 },
];

function row(id: string, orgName: string, status: LeadQueueRow["status"], stage: string, extra: Partial<LeadQueueRow> = {}): LeadQueueRow {
  return {
    id, orgName, contactName: null, contactEmail: null, contactPhone: null, source: "staff", status,
    ownerId: null, ownerName: null, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
    ageSeconds: 100, hasSubmission: false, stage, dealValue: null, dealCurrency: null, stageEnteredAt: "2026-09-01T00:00:00Z", ...extra,
  };
}

// In the BFF's whose-move-it-is order (submitted, new, invited, the rest). Neither alphabetical nor by stage.
const ROWS: LeadQueueRow[] = [
  row("1", "Zeta Co", "submitted", "proposal", { dealValue: "15000000.0000", dealCurrency: "IDR" }),
  row("2", "Alpha Co", "new", "enquiry"),
  row("3", "Mid Co", "invited", "contacted"),
  row("4", "Beta Co", "in_review", "proposal", { dealValue: "10.2500", dealCurrency: "USD" }),
  row("5", "Won Co", "converted", "won", { dealValue: "500.0000", dealCurrency: "USD" }),
  row("6", "Lost Co", "declined", "lost"),
];

const create = vi.fn(async () => ({ ok: true }));
const renderQueue = (props: Partial<React.ComponentProps<typeof AgencyLeadsQueue>> = {}) =>
  render(<AgencyLeadsQueue rows={ROWS} stages={STAGES} currencies={CURRENCIES} canCreate={false} createAction={create} {...props} />);

/** The organisation names in the table, top to bottom. */
function orgOrder(): string[] {
  return screen.getAllByRole("link").map((a) => a.textContent ?? "").filter((t) => /Co$/.test(t));
}

describe("AgencyLeadsQueue: Stage and Value columns", () => {
  it("renders a Stage and a Value column header", () => {
    renderQueue();
    expect(screen.getByText("Stage")).toBeInTheDocument();
    expect(screen.getByText("Value")).toBeInTheDocument();
  });

  it("shows the stage label, and the value by the currency's minor unit", () => {
    renderQueue();
    expect(screen.getAllByText("Proposal sent").length).toBeGreaterThan(0);
    expect(screen.getByText("IDR 15,000,000")).toBeInTheDocument();
    expect(screen.getByText("USD 10.25")).toBeInTheDocument();
  });

  it("a lead with no value shows an em-dash, not zero", () => {
    renderQueue({ rows: [row("2", "Alpha Co", "new", "enquiry")] });
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.queryByText(/(IDR|USD)/)).toBeNull();
  });

  it("still renders when the reference was refused: labels from keys, chips from the stages present", () => {
    renderQueue({ stages: null, currencies: null });
    expect(screen.getByRole("button", { name: /Proposal 2/ })).toBeInTheDocument();
    expect(screen.getByText("USD 10.25")).toBeInTheDocument();
  });
});

describe("AgencyLeadsQueue: stage filters FILTER and never re-sort", () => {
  it("the unfiltered order is the order received", () => {
    renderQueue();
    expect(orgOrder()).toEqual(["Zeta Co", "Alpha Co", "Mid Co", "Beta Co", "Won Co", "Lost Co"]);
  });

  it("chips show a count per stage, over all rows", () => {
    renderQueue();
    expect(screen.getByRole("button", { name: /^All 6$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Proposal sent 2$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Qualified 0$/ })).toBeInTheDocument();
  });

  it("filtering by a stage keeps the received order inside it", () => {
    renderQueue();
    fireEvent.click(screen.getByRole("button", { name: /^Proposal sent 2$/ }));
    // Zeta before Beta is the BFF order; an alphabetical or by-age re-sort would flip it.
    expect(orgOrder()).toEqual(["Zeta Co", "Beta Co"]);
    expect(screen.getByText("Queue (2 of 6)")).toBeInTheDocument();
    // The counts do not change as the filter does.
    expect(screen.getByRole("button", { name: /^All 6$/ })).toBeInTheDocument();
  });

  it("a second click on the active chip clears the filter and restores the full order", () => {
    renderQueue();
    const chip = screen.getByRole("button", { name: /^Proposal sent 2$/ });
    fireEvent.click(chip);
    fireEvent.click(chip);
    expect(orgOrder()).toEqual(["Zeta Co", "Alpha Co", "Mid Co", "Beta Co", "Won Co", "Lost Co"]);
  });

  it("hide closed drops won and lost and leaves the rest in order", () => {
    renderQueue();
    fireEvent.click(screen.getByLabelText(/Hide closed/));
    expect(orgOrder()).toEqual(["Zeta Co", "Alpha Co", "Mid Co", "Beta Co"]);
  });

  it("an empty filter result is its own state, distinct from an empty queue", () => {
    renderQueue();
    fireEvent.click(screen.getByRole("button", { name: /^Qualified 0$/ }));
    expect(screen.getByText("No leads match this filter")).toBeInTheDocument();
    expect(screen.queryByText("No leads in the queue")).toBeNull();
  });

  it("a truly empty queue keeps its own message and shows no filters", () => {
    renderQueue({ rows: [] });
    expect(screen.getByText("No leads in the queue")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /Filter by pipeline stage/ })).toBeNull();
  });

  it("marks the active chip", () => {
    renderQueue();
    const chip = screen.getByRole("button", { name: /^Enquiry 1$/ });
    expect(chip).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByRole("group", { name: /Filter by pipeline stage/ })).getByRole("button", { name: /^All 6$/ })).toHaveAttribute("aria-pressed", "false");
  });
});
