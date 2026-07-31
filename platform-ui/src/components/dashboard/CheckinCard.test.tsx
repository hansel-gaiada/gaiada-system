import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { CheckinCard } from "./CheckinCard";
import type { CheckinToday, SelfComplianceSummary } from "@/lib/checkins";

function draft(summaryText = "Logged 3h on Client site redesign. Completed: Draft onboarding flow."): CheckinToday["draft"] {
  return {
    summaryText, minutesLogged: 180, minutesBillable: 120,
    byProject: [{ projectId: "p-1", projectName: "Client site redesign", minutes: 180 }],
    tasksCompleted: [{ taskId: "t-1", title: "Draft onboarding flow" }],
    tasksCreated: [], tasksMoved: [], commentsAuthored: 1, docsUpdated: 0, otherActivityEvents: 0,
  };
}

function notYetSubmitted(): CheckinToday {
  return { date: "2026-07-31", expected: true, alreadySubmitted: false, existing: null, draft: draft() };
}

const emptyCompliance: SelfComplianceSummary = { windowDays: 0, submittedCount: 0, missedCount: 0, excusedCount: 0, rate: null, currentStreak: 0 };
const richCompliance: SelfComplianceSummary = { windowDays: 20, submittedCount: 17, missedCount: 2, excusedCount: 1, rate: 17 / 19, currentStreak: 4 };

describe("CheckinCard (TR-10 — the <30s My Work check-in flow)", () => {
  it("the confirm-and-edit form is prefilled with the live-derived draft, visibly labelled as a draft", () => {
    render(<CheckinCard tenantId="co-agency" today={notYetSubmitted()} selfCompliance={emptyCompliance} submitAction={vi.fn()} />);
    expect(screen.getByText(/Drafted from today.s logged time and activity/)).toBeInTheDocument();
    const textarea = screen.getByLabelText("Summary") as HTMLTextAreaElement;
    expect(textarea.value).toBe(draft().summaryText);
  });

  it("accepting the draft as-is takes exactly ONE interaction: clicking Confirm & submit", async () => {
    const submitAction = vi.fn(async (_fd: FormData) => ({ ok: true, result: { id: "c1", date: "2026-07-31", status: "submitted" as const, summary: draft().summaryText, blockers: null, edited: false, source: "ui" } }));
    render(<CheckinCard tenantId="co-agency" today={notYetSubmitted()} selfCompliance={emptyCompliance} submitAction={submitAction} />);

    // The ONE interaction: no textarea edit, straight to the submit click.
    fireEvent.click(screen.getByText("Confirm & submit"));

    await waitFor(() => expect(screen.getByText(draft().summaryText)).toBeInTheDocument());
    expect(submitAction).toHaveBeenCalledTimes(1);
    const sentFormData = submitAction.mock.calls[0][0] as FormData;
    expect(sentFormData.get("summary")).toBe(draft().summaryText);
    expect(sentFormData.get("tenantId")).toBe("co-agency");
    // Confirmed state is now clearly distinct — a "Submitted" pill, no form.
    expect(screen.getByText("Submitted")).toBeInTheDocument();
    expect(screen.queryByLabelText("Summary")).not.toBeInTheDocument();
  });

  it("editing the draft then submitting takes exactly TWO interactions: edit the field, click submit", async () => {
    const submitAction = vi.fn(async (fd: FormData) => ({ ok: true, result: { id: "c1", date: "2026-07-31", status: "submitted" as const, summary: String(fd.get("summary")), blockers: null, edited: true, source: "ui" } }));
    render(<CheckinCard tenantId="co-agency" today={notYetSubmitted()} selfCompliance={emptyCompliance} submitAction={submitAction} />);

    // Interaction 1: edit the field.
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Shipped the real thing, not what was drafted." } });
    // Interaction 2: submit.
    fireEvent.click(screen.getByText("Confirm & submit"));

    await waitFor(() => expect(screen.getByText("Shipped the real thing, not what was drafted.")).toBeInTheDocument());
    expect(submitAction).toHaveBeenCalledTimes(1);
  });

  it("shows an inline error and stays on the form when submission fails, without losing the edit", async () => {
    const submitAction = vi.fn(async () => ({ ok: false, error: "network hiccup" }));
    render(<CheckinCard tenantId="co-agency" today={notYetSubmitted()} selfCompliance={emptyCompliance} submitAction={submitAction} />);
    fireEvent.click(screen.getByText("Confirm & submit"));
    await waitFor(() => expect(screen.getByText("network hiccup")).toBeInTheDocument());
    expect(screen.getByLabelText("Summary")).toBeInTheDocument(); // form still there, nothing was silently lost
  });

  it("renders the already-submitted state distinctly, with an Edit affordance to reopen it", () => {
    const today: CheckinToday = {
      date: "2026-07-31", expected: true, alreadySubmitted: true,
      existing: { id: "c1", status: "submitted", summary: "Shipped the onboarding flow.", blockers: "Waiting on design review.", edited: true, source: "ui", submittedAt: "2026-07-31T09:00:00Z" },
      draft: draft(),
    };
    render(<CheckinCard tenantId="co-agency" today={today} selfCompliance={emptyCompliance} submitAction={vi.fn()} />);
    expect(screen.getByText("Submitted")).toBeInTheDocument();
    expect(screen.getByText("Shipped the onboarding flow.")).toBeInTheDocument();
    expect(screen.getByText(/Waiting on design review\./)).toBeInTheDocument();
    expect(screen.getByText("Edit")).toBeInTheDocument();
  });

  it("renders the excused state distinctly — never as a missed/blank prompt", () => {
    const today: CheckinToday = {
      date: "2026-07-31", expected: true, alreadySubmitted: false,
      existing: { id: "c1", status: "excused", summary: "", blockers: null, edited: false, source: "system", submittedAt: null },
      draft: draft(),
    };
    render(<CheckinCard tenantId="co-agency" today={today} selfCompliance={emptyCompliance} submitAction={vi.fn()} />);
    expect(screen.getByText("Excused")).toBeInTheDocument();
    expect(screen.queryByLabelText("Summary")).not.toBeInTheDocument();
    expect(screen.queryByText("Confirm & submit")).not.toBeInTheDocument();
  });

  it("renders the not-expected state distinctly from missed, with an opt-in to check in anyway", () => {
    const today: CheckinToday = { date: "2026-07-31", expected: false, alreadySubmitted: false, existing: null, draft: draft() };
    render(<CheckinCard tenantId="co-agency" today={today} selfCompliance={emptyCompliance} submitAction={vi.fn()} />);
    expect(screen.getByText("Not expected today")).toBeInTheDocument();
    expect(screen.queryByText("Missed")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Summary")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Check in anyway"));
    expect(screen.getByLabelText("Summary")).toBeInTheDocument();
  });

  it("shows the self-permitted streak/compliance strip, honestly separating excused from the rate", () => {
    render(<CheckinCard tenantId="co-agency" today={notYetSubmitted()} selfCompliance={richCompliance} submitAction={vi.fn()} />);
    expect(screen.getByText("4-day streak")).toBeInTheDocument();
    expect(screen.getByText(/17\/19 submitted \(89%\)/)).toBeInTheDocument();
    expect(screen.getByText(/1 excused — not counted against you/)).toBeInTheDocument();
  });

  it("shows nothing in the strip when there's no history yet (no fabricated 0/0)", () => {
    render(<CheckinCard tenantId="co-agency" today={notYetSubmitted()} selfCompliance={emptyCompliance} submitAction={vi.fn()} />);
    expect(screen.queryByText(/submitted \(/)).not.toBeInTheDocument();
  });
});
