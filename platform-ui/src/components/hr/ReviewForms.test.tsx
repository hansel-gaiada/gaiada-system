import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { ReviewCycleForm, ReviewCycleEditForm, ParticipantsAddForm, ParticipantUpdateForm } from "./ReviewForms";
import type { PolicyFormApi } from "./PolicyFormShell";
import type { PolicyResult } from "@/lib/hrPolicyActions";

// DW-7f-4 — the review-cycle forms: each sends what was typed to its action with the tenant, shows the server's sentence as
// sent after a refusal (and keeps the form open), shows the server's notice after a success, and re-reads the page after
// every call.

const pick = (result: PolicyResult) => vi.fn<PolicyFormApi>(async () => result);
const open = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const submit = (name: string) => fireEvent.click(screen.getAllByRole("button", { name }).at(-1)!);
const sent = (action: ReturnType<typeof pick>, call = 0) => action.mock.calls[call][1];

beforeEach(() => refresh.mockReset());
afterEach(() => cleanup());

describe("ReviewCycleForm", () => {
  function fill() {
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "2026 H2" } });
    fireEvent.change(screen.getByLabelText(/^Kind/), { target: { value: "probation" } });
    fireEvent.change(screen.getByLabelText(/^Period start/), { target: { value: "2026-07-01" } });
    fireEvent.change(screen.getByLabelText(/^Period end/), { target: { value: "2026-12-31" } });
  }

  it("is closed until opened, sends the typed values with the tenant, shows the notice and re-reads", async () => {
    const action = pick({ ok: true, notice: "Review cycle created as a draft." });
    render(<ReviewCycleForm tenantId="co-a" action={action} />);
    expect(screen.queryByLabelText(/^Name/)).toBeNull();
    open("New review cycle");
    fill();
    submit("Create cycle");
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0][0]).toBe("co-a");
    expect(Object.fromEntries(sent(action).entries())).toMatchObject({
      name: "2026 H2", kind: "probation", periodStart: "2026-07-01", periodEnd: "2026-12-31", opensOn: "", closesOn: "",
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Review cycle created as a draft.");
    expect(refresh).toHaveBeenCalled();
  });

  it("shows the server's refusal as sent, keeps the form open and still re-reads", async () => {
    const action = pick({ ok: false, error: "periodEnd must be >= periodStart" });
    render(<ReviewCycleForm tenantId="co-a" action={action} />);
    open("New review cycle");
    fill();
    submit("Create cycle");
    expect(await screen.findByRole("alert")).toHaveTextContent("periodEnd must be >= periodStart");
    expect(screen.getByLabelText(/^Name/)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });
});

describe("ReviewCycleEditForm", () => {
  const initial = { name: "2026 H2", status: "draft", opensOn: "2027-01-02", closesOn: null };

  it("starts from what the server holds, binds the cycle id and sends all four fields", async () => {
    const action = vi.fn(async (_t: string, _id: string, _fd: FormData): Promise<PolicyResult> => ({ ok: true, notice: "Review cycle saved." }));
    render(<ReviewCycleEditForm tenantId="co-a" cycleId="c-9" initial={initial} action={action} />);
    open("Edit cycle");
    expect(screen.getByLabelText(/^Status/)).toHaveValue("draft");
    expect(screen.getByLabelText(/^Window opens/)).toHaveValue("2027-01-02");
    expect(screen.getByLabelText(/^Window closes/)).toHaveValue("");
    fireEvent.change(screen.getByLabelText(/^Status/), { target: { value: "open" } });
    submit("Save cycle");
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0][0]).toBe("co-a");
    expect(action.mock.calls[0][1]).toBe("c-9");
    expect(Object.fromEntries(action.mock.calls[0][2].entries())).toEqual({ name: "2026 H2", status: "open", opensOn: "2027-01-02", closesOn: "" });
    expect(await screen.findByRole("status")).toHaveTextContent("Review cycle saved.");
  });

  it("offers every status, since the server has no status machine, and shows a refusal as sent", async () => {
    const action = vi.fn(async (): Promise<PolicyResult> => ({ ok: false, error: "review cycle not found" }));
    render(<ReviewCycleEditForm tenantId="co-a" cycleId="c-9" initial={initial} action={action} />);
    open("Edit cycle");
    expect(Array.from((screen.getByLabelText(/^Status/) as HTMLSelectElement).options).map((o) => o.value).filter(Boolean)).toEqual(["draft", "open", "closed", "cancelled"]);
    submit("Save cycle");
    expect(await screen.findByRole("alert")).toHaveTextContent("review cycle not found");
    expect(refresh).toHaveBeenCalled();
  });
});

describe("ParticipantsAddForm", () => {
  const people = [{ value: "u-a", label: "Budi" }, { value: "u-b", label: "Sari" }];
  const reviewers = [{ value: "u-r", label: "Rina (lead)" }, ...people];

  function setup(over: { people?: typeof people; excluded?: number; result?: PolicyResult } = {}) {
    const action = vi.fn(async (_t: string, _id: string, _fd: FormData): Promise<PolicyResult> => over.result ?? { ok: true, notice: "2 people added." });
    render(<ParticipantsAddForm tenantId="co-a" cycleId="c-1" people={over.people ?? people} reviewers={reviewers} excluded={over.excluded ?? 0} action={action} />);
    open("Add participants");
    return action;
  }

  it("sends every ticked person under subjectUserId (user ids), with the reviewer and due date", async () => {
    const action = setup();
    fireEvent.click(screen.getByLabelText("Budi"));
    fireEvent.click(screen.getByLabelText("Sari"));
    fireEvent.change(screen.getByLabelText(/^Reviewer/), { target: { value: "u-r" } });
    fireEvent.change(screen.getByLabelText(/^Due on/), { target: { value: "2027-01-15" } });
    submit("Add to cycle");
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0][1]).toBe("c-1");
    const fd = action.mock.calls[0][2];
    expect(fd.getAll("subjectUserId")).toEqual(["u-a", "u-b"]);
    expect(fd.get("reviewerUserId")).toBe("u-r");
    expect(fd.get("dueOn")).toBe("2027-01-15");
    expect(await screen.findByRole("status")).toHaveTextContent("2 people added.");
    expect(refresh).toHaveBeenCalled();
  });

  it("sends only who was ticked", async () => {
    const action = setup();
    fireEvent.click(screen.getByLabelText("Sari"));
    submit("Add to cycle");
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0][2].getAll("subjectUserId")).toEqual(["u-b"]);
  });

  it("says who cannot be added, and when everyone already is", () => {
    setup({ people: [], excluded: 2 });
    expect(screen.getByText(/Nobody left to add/)).toBeInTheDocument();
    expect(screen.getByText(/2 employees have no login account and cannot be added/)).toBeInTheDocument();
  });

  it("shows the server's refusal as sent", async () => {
    setup({ result: { ok: false, error: "review cycle not found" } });
    fireEvent.click(screen.getByLabelText("Budi"));
    submit("Add to cycle");
    expect(await screen.findByRole("alert")).toHaveTextContent("review cycle not found");
  });
});

describe("ParticipantUpdateForm", () => {
  const participants = [{ value: "p-1", label: "Budi (pending)" }];
  const reviewers = [{ value: "u-r", label: "Rina" }];

  it("sends the participant id and what was changed; a blank field is left as it is", async () => {
    const action = pick({ ok: true, notice: "Participant updated." });
    render(<ParticipantUpdateForm tenantId="co-a" participants={participants} reviewers={reviewers} showOutcome action={action} />);
    open("Update a participant");
    fireEvent.change(screen.getByLabelText(/^Participant/), { target: { value: "p-1" } });
    fireEvent.change(screen.getByLabelText(/^Status/), { target: { value: "submitted" } });
    fireEvent.change(screen.getByLabelText(/^Outcome(?! note)/), { target: { value: "pass" } });
    submit("Save participant");
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(Object.fromEntries(sent(action).entries())).toEqual({
      participantId: "p-1", status: "submitted", reviewerUserId: "", outcome: "pass", outcomeNote: "",
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Participant updated.");
    expect(refresh).toHaveBeenCalled();
  });

  it("offers the outcome fields on probation cycles only", () => {
    render(<ParticipantUpdateForm tenantId="co-a" participants={participants} reviewers={reviewers} showOutcome={false} action={pick({ ok: true })} />);
    open("Update a participant");
    expect(screen.queryByLabelText(/^Outcome/)).toBeNull();
    expect(screen.getByLabelText(/^Reviewer/)).toBeInTheDocument();
  });

  it("shows a refusal as sent", async () => {
    render(<ParticipantUpdateForm tenantId="co-a" participants={participants} reviewers={reviewers} showOutcome
      action={pick({ ok: false, error: "outcome must be pass|extend|fail" })} />);
    open("Update a participant");
    fireEvent.change(screen.getByLabelText(/^Participant/), { target: { value: "p-1" } });
    submit("Save participant");
    expect(await screen.findByRole("alert")).toHaveTextContent("outcome must be pass|extend|fail");
    expect(refresh).toHaveBeenCalled();
  });
});
