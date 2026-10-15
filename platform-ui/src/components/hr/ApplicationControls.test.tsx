import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

import { ApplicationStageMove, type StageOption } from "./ApplicationStageMove";
import { ApplicationForm } from "./ApplicationForm";
import { InterviewForm, InterviewEditor } from "./InterviewForm";
import { PipelineStageForm } from "./PipelineStageForm";

// DW-7f-2 — the controls on an application: the stage move (terminal stages confirm and say what they do), adding a
// candidate to a requisition, scheduling and editing an interview, and the stage editor. A refusal is the server's words.

const stages: StageOption[] = [
  { key: "applied", label: "Applied", isTerminal: false, terminalKind: null },
  { key: "screen", label: "Screen", isTerminal: false, terminalKind: null },
  { key: "hired", label: "Hired", isTerminal: true, terminalKind: "hired" },
  { key: "rejected", label: "Rejected", isTerminal: true, terminalKind: "rejected" },
  { key: "withdrawn", label: "Withdrawn", isTerminal: true, terminalKind: "withdrawn" },
];

beforeEach(() => refresh.mockReset());
afterEach(() => cleanup());

describe("ApplicationStageMove", () => {
  function setup(result: { ok: boolean; error?: string; notice?: string } = { ok: true, notice: "Moved from applied to screen." }) {
    const move = vi.fn(async (_t: string, _a: string, _f: FormData) => result);
    render(<ApplicationStageMove tenantId="co-a" applicationId="ap-1" candidateName="Budi" currentStageKey="applied" stages={stages} move={move} />);
    fireEvent.click(screen.getByRole("button", { name: "Move Budi to another stage" }));
    return move;
  }
  const pick = (v: string) => fireEvent.change(screen.getByLabelText("Move to"), { target: { value: v } });

  it("lists every stage except the current one, and the move button waits for a choice", () => {
    setup();
    const options = Array.from((screen.getByLabelText("Move to") as HTMLSelectElement).options).map((o) => o.value);
    expect(options).toEqual(["", "screen", "hired", "rejected", "withdrawn"]);
    expect(screen.getByRole("button", { name: "Move" })).toBeDisabled();
  });

  it("an ordinary move sends the stage and note, shows the server's sentence and re-reads the page", async () => {
    const move = setup();
    pick("screen");
    fireEvent.change(screen.getByLabelText("Note (optional)"), { target: { value: "phone screen done" } });
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    const [tenant, app, fd] = move.mock.calls[0];
    expect([tenant, app]).toEqual(["co-a", "ap-1"]);
    expect(Object.fromEntries(fd.entries())).toEqual({ stageKey: "screen", note: "phone screen done" });
    expect(await screen.findByRole("status")).toHaveTextContent("Moved from applied to screen.");
    expect(refresh).toHaveBeenCalled();
  });

  it("a terminal stage says what it does and its button names the consequence", () => {
    setup();
    pick("hired");
    expect(screen.getByText(/does not create the employee/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm: mark hired" })).toBeInTheDocument();
    pick("withdrawn");
    expect(screen.getByRole("button", { name: "Confirm: withdraw" })).toBeInTheDocument();
  });

  it("a rejection asks for a reason and sends it", async () => {
    const move = setup({ ok: true, notice: "Moved to rejected; the application is now rejected." });
    pick("rejected");
    fireEvent.change(screen.getByLabelText("Reason for rejection"), { target: { value: "Not a fit" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm: reject" }));
    await waitFor(() => expect(move).toHaveBeenCalled());
    expect(Object.fromEntries(move.mock.calls[0][2].entries())).toEqual({ stageKey: "rejected", rejectionReason: "Not a fit" });
  });

  it("a refusal is shown as the server worded it, and the page is still re-read", async () => {
    setup({ ok: false, error: "application is 'hired' and cannot be moved" });
    pick("screen");
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("application is 'hired' and cannot be moved");
    expect(screen.queryByRole("status")).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });
});

describe("ApplicationForm", () => {
  const candidates = [{ id: "cd-1", name: "Ayu", email: "ayu@example.com" }, { id: "cd-2", name: "Budi", email: null }];
  function setup(create: (f: FormData) => Promise<{ ok: boolean; error?: string; notice?: string }>) {
    render(<ApplicationForm create={create} companyId="co-a" requisitionId="rq-1" candidates={candidates} stages={[{ key: "applied", label: "Applied" }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add candidate to this requisition" }));
  }

  it("sends the requisition, company and chosen candidate, and shows the server's notice", async () => {
    const create = vi.fn(async (_f: FormData) => ({ ok: true, notice: "Added to the pipeline at applied." }));
    setup(create);
    fireEvent.change(screen.getByLabelText(/^Candidate/), { target: { value: "cd-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to pipeline" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(Object.fromEntries(create.mock.calls[0][0].entries())).toMatchObject({ companyId: "co-a", requisitionId: "rq-1", candidateId: "cd-2" });
    expect(await screen.findByRole("status")).toHaveTextContent("Added to the pipeline at applied.");
  });

  it("shows the server's 409 sentence as sent", async () => {
    setup(vi.fn(async () => ({ ok: false, error: "this candidate already has a live application for that requisition" })));
    fireEvent.change(screen.getByLabelText(/^Candidate/), { target: { value: "cd-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to pipeline" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("this candidate already has a live application for that requisition");
  });
});

describe("InterviewForm", () => {
  it("sends the times, the zone and the chosen panelists to the schedule action", async () => {
    const schedule = vi.fn(async (_t: string, _a: string, _f: FormData) => ({ ok: true, notice: "Interview scheduled. 1 panelist(s) were notified." }));
    render(<InterviewForm schedule={schedule} tenantId="co-a" applicationId="ap-1" people={[{ userId: "u-a", name: "Made" }, { userId: "u-b", name: "Wayan" }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Schedule interview" }));
    fireEvent.change(screen.getByLabelText(/^Starts/), { target: { value: "2026-10-20T09:00" } });
    fireEvent.change(screen.getByLabelText(/^Ends/), { target: { value: "2026-10-20T10:00" } });
    const select = screen.getByLabelText(/^Panelists/) as HTMLSelectElement;
    Array.from(select.options).find((o) => o.value === "u-b")!.selected = true;
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(schedule).toHaveBeenCalledTimes(1));
    const [tenant, app, fd] = schedule.mock.calls[0];
    expect([tenant, app]).toEqual(["co-a", "ap-1"]);
    expect(fd.get("scheduledStart")).toBe("2026-10-20T09:00");
    expect(fd.get("timezone")).toBe("Asia/Makassar");
    expect(fd.getAll("panelists")).toEqual(["u-b"]);
    expect(await screen.findByRole("status")).toHaveTextContent("1 panelist(s) were notified.");
  });

  it("leaves the panelist picker out when there are no people, and shows a refusal as sent", async () => {
    const schedule = vi.fn(async (_t: string, _a: string, _f: FormData) => ({ ok: false, error: "You don't have permission to schedule interviews." }));
    render(<InterviewForm schedule={schedule} tenantId="co-a" applicationId="ap-1" people={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Schedule interview" }));
    expect(screen.queryByLabelText(/^Panelists/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/^Starts/), { target: { value: "2026-10-20T09:00" } });
    fireEvent.change(screen.getByLabelText(/^Ends/), { target: { value: "2026-10-20T10:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You don't have permission to schedule interviews.");
  });
});

describe("InterviewEditor", () => {
  const interview = {
    id: "iv-1", kind: "technical", scheduledStart: "2026-10-20T01:00:00.000Z", scheduledEnd: "2026-10-20T02:00:00.000Z",
    timezone: "Asia/Makassar", status: "scheduled", outcome: null,
  };

  it("opens prefilled with the times as the interview's own clock reads, and sends the changes", async () => {
    const update = vi.fn(async (_t: string, _a: string, _i: string, _f: FormData) => ({ ok: true, notice: "Interview updated." }));
    render(<InterviewEditor update={update} tenantId="co-a" applicationId="ap-1" interview={interview} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit technical interview" }));
    expect(screen.getByLabelText(/^Starts/)).toHaveValue("2026-10-20T09:00");
    expect(screen.getByLabelText(/^Ends/)).toHaveValue("2026-10-20T10:00");
    fireEvent.change(screen.getByLabelText(/^Status/), { target: { value: "completed" } });
    fireEvent.change(screen.getByLabelText(/^Outcome/), { target: { value: "advance" } });
    fireEvent.click(screen.getByRole("button", { name: "Save interview" }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const [tenant, app, id, fd] = update.mock.calls[0];
    expect([tenant, app, id]).toEqual(["co-a", "ap-1", "iv-1"]);
    expect(Object.fromEntries(fd.entries())).toMatchObject({ status: "completed", outcome: "advance", timezone: "Asia/Makassar" });
    expect(await screen.findByRole("status")).toHaveTextContent("Interview updated.");
  });

  it("shows a refusal as sent and keeps the form open", async () => {
    const update = vi.fn(async (_t: string, _a: string, _i: string, _f: FormData) => ({ ok: false, error: "interview not found" }));
    render(<InterviewEditor update={update} tenantId="co-a" applicationId="ap-1" interview={interview} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit technical interview" }));
    fireEvent.click(screen.getByRole("button", { name: "Save interview" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("interview not found");
    // the transition settles a tick after the message appears: wait for the button to come back from "Saving…"
    expect(await screen.findByRole("button", { name: "Save interview" })).toBeInTheDocument();
  });
});

describe("PipelineStageForm", () => {
  it("sends the stage with the company, and shows the server's refusal as sent", async () => {
    const save = vi.fn(async (_f: FormData) => ({ ok: false, error: "stage 'x' is terminal and needs terminalKind (hired|rejected|withdrawn)" }));
    render(<PipelineStageForm save={save} companyId="co-a" />);
    fireEvent.click(screen.getByRole("button", { name: "Add or update a stage" }));
    fireEvent.change(screen.getByLabelText(/^Key/), { target: { value: "tech_interview" } });
    fireEvent.change(screen.getByLabelText(/^Label/), { target: { value: "Technical interview" } });
    fireEvent.click(screen.getByRole("button", { name: "Save stage" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(Object.fromEntries(save.mock.calls[0][0].entries())).toMatchObject({ companyId: "co-a", key: "tech_interview", label: "Technical interview" });
    expect(await screen.findByRole("alert")).toHaveTextContent("stage 'x' is terminal and needs terminalKind");
  });
});
