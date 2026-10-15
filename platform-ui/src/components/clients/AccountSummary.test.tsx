import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

// PV7-07 — the account summary's three pieces on the client hub's Reports tab: the draft control, the narrative editor, and the
// frozen-figures preview. Pins: the default month and its bounds, what the action is sent, refusals in words, the editor's
// save rules and its unsaved-changes warning, and that the preview says what it does not know (a null section is never zero).

vi.mock("@/lib/clientReportsActions", () => ({
  draftAccountSummaryAction: vi.fn(),
  saveSummaryNarrativeAction: vi.fn(),
}));

import { draftAccountSummaryAction, saveSummaryNarrativeAction } from "@/lib/clientReportsActions";
import type { SummarySnapshot } from "@/lib/clientReports";
import { AccountSummaryDraftForm } from "./AccountSummaryDraftForm";
import { AccountSummaryEditor } from "./AccountSummaryEditor";
import { AccountSummaryPreview } from "./AccountSummaryPreview";

const draft = vi.mocked(draftAccountSummaryAction);
const save = vi.mocked(saveSummaryNarrativeAction);
beforeEach(() => { draft.mockReset(); save.mockReset(); });

describe("AccountSummaryDraftForm", () => {
  it("offers a month picker defaulting to the month it is given, capped at this month, and one button", () => {
    render(<AccountSummaryDraftForm clientId="cl-1" defaultMonth="2026-09" maxMonth="2026-10" />);
    const month = screen.getByLabelText("Month") as HTMLInputElement;
    expect(month).toHaveAttribute("type", "month");
    expect(month).toHaveValue("2026-09");
    expect(month).toHaveAttribute("max", "2026-10");
    expect(month).toBeRequired();
    expect(screen.getByRole("button", { name: "Draft account summary" })).toBeEnabled();
    // Says what the summary holds and what it never does.
    expect(screen.getByText(/No money, tasks, time or people/)).toBeInTheDocument();
  });

  it("sends the client and the month, and says whether a new draft was made", async () => {
    draft.mockResolvedValue({ ok: true, id: "r1", notice: "Draft made for September 2026. Read it, edit the words if you want to, then publish." });
    render(<AccountSummaryDraftForm clientId="cl-1" defaultMonth="2026-09" maxMonth="2026-10" />);
    fireEvent.change(screen.getByLabelText("Month"), { target: { value: "2026-08" } });
    fireEvent.click(screen.getByRole("button", { name: "Draft account summary" }));
    await waitFor(() => expect(draft).toHaveBeenCalledTimes(1));
    const fd = draft.mock.calls[0][1] as FormData;
    expect(fd.get("clientId")).toBe("cl-1");
    expect(fd.get("period")).toBe("2026-08");
    expect(await screen.findByRole("status")).toHaveTextContent(/Draft made for September 2026/);
  });

  it("shows a refusal in words as an alert, never a code", async () => {
    draft.mockResolvedValue({ ok: false, error: "A summary for that month is already published. Withdraw it first if you want to draft a new one.", field: "period" });
    render(<AccountSummaryDraftForm clientId="cl-1" defaultMonth="2026-09" maxMonth="2026-10" />);
    fireEvent.click(screen.getByRole("button", { name: "Draft account summary" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Withdraw it first/);
    expect(alert).not.toHaveTextContent("summary_published");
    expect(screen.getByLabelText("Month")).toHaveAttribute("aria-invalid", "true");
  });
});

describe("AccountSummaryEditor", () => {
  const props = { reportId: "r1", clientId: "cl-1", narrativeMd: "In September, two milestones were completed.", narrativeSource: "deterministic" as const };

  it("shows the narrative in a Markdown textarea, says who wrote it, and Save waits for a change", () => {
    render(<AccountSummaryEditor {...props} />);
    const box = screen.getByLabelText(/Narrative/) as HTMLTextAreaElement;
    expect(box).toHaveValue(props.narrativeMd);
    expect(box).toHaveAttribute("maxlength", "20000");
    expect(screen.getByText(/Standard wording built from the figures below; not edited yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save narrative" })).toBeDisabled();
    expect(screen.queryByText(/Unsaved changes/)).toBeNull();
  });

  it("an edit enables Save and warns that Publish uses the text as saved", () => {
    render(<AccountSummaryEditor {...props} />);
    fireEvent.change(screen.getByLabelText(/Narrative/), { target: { value: "My own words." } });
    expect(screen.getByRole("button", { name: "Save narrative" })).toBeEnabled();
    expect(screen.getByText("Unsaved changes. Save before you publish.")).toBeInTheDocument();
  });

  it("an emptied text cannot be saved and says why", () => {
    render(<AccountSummaryEditor {...props} />);
    fireEvent.change(screen.getByLabelText(/Narrative/), { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Save narrative" })).toBeDisabled();
    expect(screen.getByText("The narrative can't be empty.")).toBeInTheDocument();
  });

  it("sends the report, the client and the text, and shows the result", async () => {
    save.mockResolvedValue({ ok: true, id: "r1", notice: "Saved." });
    render(<AccountSummaryEditor {...props} />);
    fireEvent.change(screen.getByLabelText(/Narrative/), { target: { value: "My own words." } });
    fireEvent.click(screen.getByRole("button", { name: "Save narrative" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const fd = save.mock.calls[0][1] as FormData;
    expect(fd.get("reportId")).toBe("r1");
    expect(fd.get("clientId")).toBe("cl-1");
    expect(fd.get("narrativeMd")).toBe("My own words.");
  });

  it("shows a refusal (no longer a draft) in words", async () => {
    save.mockResolvedValue({ ok: false, error: "This summary is no longer a draft, so it can't be edited. Refresh the page to see where it stands." });
    render(<AccountSummaryEditor {...props} />);
    fireEvent.change(screen.getByLabelText(/Narrative/), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save narrative" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/no longer a draft/);
  });

  it("each source reads in words", () => {
    const { rerender } = render(<AccountSummaryEditor {...props} narrativeSource="ai" />);
    expect(screen.getByText(/Drafted by AI from the figures below/)).toBeInTheDocument();
    rerender(<AccountSummaryEditor {...props} narrativeSource="human" />);
    expect(screen.getByText("Written by staff")).toBeInTheDocument();
  });
});

const snapshot = (over: Partial<SummarySnapshot> = {}): SummarySnapshot => ({
  version: 1, clientId: "cl-1", clientName: "Northwind Traders", period: "2026-09", periodStart: "2026-09-01", periodEnd: "2026-09-30",
  generatedAt: "2026-10-03T09:00:00.000Z",
  projects: [{
    projectId: "p1", name: "Website relaunch", status: "active",
    milestones: { total: 6, done: 4, upcoming: 1, late: 1, undated: 0 }, deliverables: { total: 5, delivered: 3, late: 0 },
    nextMilestone: { name: "Launch review", dueDate: "2026-11-12" },
  }],
  waiting: { onClient: { count: 2, oldestSince: "2026-09-12T08:00:00.000Z" }, onUs: { count: 0, oldestSince: null } },
  completed: {
    milestones: { count: 1, knownSince: "2026-09-15", wholeMonthKnown: false, items: [{ projectId: "p1", projectName: "Website relaunch", name: "Design approved", completedOn: "2026-09-20" }] },
    deliverables: { count: 1, basis: "status_changed_in_month", items: [{ projectId: "p1", projectName: "Website relaunch", name: "Brand guide", status: "delivered", on: "2026-09-17" }] },
  },
  turnaround: { windowDays: 90, windowEnd: "2026-09-30", client: { medianDays: 2.5, n: 6, withheld: false }, ours: { medianDays: null, n: 1, withheld: true } },
  results: {
    generatedAt: "2026-10-03T09:00:00.000Z", unavailable: ["website"],
    services: [{
      service: "search", areaId: "search", title: "Search", status: "active", since: "2026-01-12", items: [],
      kpis: [{ key: "search.organic_clicks", label: "Organic clicks", value: 4210, unit: "count", period: null, previous: 3890, target: null, asOf: null }],
      clientVisible: true,
    }],
  },
  reports: [{ id: "rep-1", title: "Social media performance, August 2026", source: "social_report", periodStart: "2026-08-01", periodEnd: "2026-08-31", publishedOn: "2026-09-03" }],
  unavailable: [],
  ...over,
});

describe("AccountSummaryPreview", () => {
  it("renders every section readably, with no list items (the Reports rows are the page's only listitems)", () => {
    const { container } = render(<AccountSummaryPreview snapshot={snapshot()} />);
    expect(container.querySelectorAll("li")).toHaveLength(0);
    expect(screen.getByRole("heading", { level: 3, name: "Projects" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Completed in September 2026" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "How quickly each side answers" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Services and results" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Reports published this month" })).toBeInTheDocument();
    expect(screen.getAllByText("Website relaunch", { selector: "td" }).length).toBeGreaterThan(0);
    expect(screen.getByText("4 of 6")).toBeInTheDocument();
    expect(screen.getByText("Design approved")).toBeInTheDocument();
    expect(screen.getByText("Brand guide")).toBeInTheDocument();
    expect(screen.getByText("4,210")).toBeInTheDocument();
    expect(screen.getByText("Social media performance, August 2026")).toBeInTheDocument();
    expect(screen.getByText(/Waiting on the client: 2, the oldest since 12 Sept? 2026/)).toBeInTheDocument();
    expect(screen.getByText(/Waiting on us: 0\./)).toBeInTheDocument();
  });

  it("says what it does not know: completion dates from a date, deliverables by status change, too few answers, services that failed", () => {
    render(<AccountSummaryPreview snapshot={snapshot()} />);
    expect(screen.getByText(/Milestone completion dates are recorded from 15 Sept? 2026/)).toBeInTheDocument();
    expect(screen.getByText(/counted in the month its status last changed/)).toBeInTheDocument();
    expect(screen.getByText(/The client: a typical answer took 2.5 days \(6 answers\)/)).toBeInTheDocument();
    expect(screen.getByText(/Us: too few answers in the window to give a typical time \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/These services could not be read: website/)).toBeInTheDocument();
  });

  it("a section that could not be read says so and is never shown as zero or as an empty table", () => {
    render(<AccountSummaryPreview snapshot={snapshot({
      projects: null, waiting: null, turnaround: null, results: null, reports: null,
      completed: { milestones: null, deliverables: null }, unavailable: ["projectHealth", "ball"],
    })} />);
    for (const what of ["The projects", "What is waiting on each side", "The completed milestones", "The delivered deliverables", "The turnaround", "The services results", "The published reports"]) {
      expect(screen.getByText(new RegExp(`${what} could not be read when this summary was drafted`))).toBeInTheDocument();
    }
    expect(screen.getByText(/Some figures could not be read: projectHealth, ball/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/No milestone was completed/)).toBeNull();
  });

  it("a month with nothing says so in words; a whole month of known completion dates carries no warning", () => {
    render(<AccountSummaryPreview snapshot={snapshot({
      completed: { milestones: { count: 0, knownSince: "2026-01-01", wholeMonthKnown: true, items: [] }, deliverables: { count: 0, basis: "status_changed_in_month", items: [] } },
      reports: [],
    })} />);
    expect(screen.getByText("No milestone was completed in this month.")).toBeInTheDocument();
    expect(screen.getByText("No deliverable changed to delivered in this month.")).toBeInTheDocument();
    expect(screen.getByText("No report was published to the client in this month.")).toBeInTheDocument();
    expect(screen.queryByText(/completion dates are recorded from/i)).toBeNull();
  });

  it("carries no money, task, time or person wording anywhere", () => {
    const { container } = render(<AccountSummaryPreview snapshot={snapshot()} />);
    expect(within(container).queryByText(/invoice|payment|amount|IDR|USD|task|hours|minutes|assignee|owner/i)).toBeNull();
  });
});
