import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));

import { AgencyLeadDetail, type Actions } from "./AgencyLeadDetail";
import type { LeadDetail, LeadStatus, PipelineReference, StageEvent } from "@/lib/agencyLeads";
import type { ReadResult } from "@/lib/readResult";

const REFERENCE: PipelineReference = {
  stages: [
    { key: "enquiry", position: 10, kind: "open", label: "Enquiry" },
    { key: "contacted", position: 20, kind: "open", label: "Contacted" },
    { key: "qualified", position: 30, kind: "open", label: "Qualified" },
    { key: "proposal", position: 40, kind: "open", label: "Proposal sent" },
    { key: "won", position: 90, kind: "won", label: "Won" },
    { key: "lost", position: 99, kind: "lost", label: "Lost" },
  ],
  currencies: [
    { code: "IDR", symbol: "Rp", minorUnit: 0 },
    { code: "USD", symbol: "$", minorUnit: 2 },
  ],
};
const refOk: ReadResult<PipelineReference> = { kind: "ok", data: REFERENCE };

function lead(over: Partial<LeadDetail> = {}): LeadDetail {
  return {
    id: "lead-1", orgName: "Northwind Traders", contactName: "Dana", contactEmail: "dana@n.test", contactPhone: null, source: "staff",
    status: "in_review", ownerId: null, ownerName: null, convertedClientId: null, convertedProjectId: null, pipelineRunId: null,
    declinedReason: null, triagedBy: null, triagedByName: null, triagedAt: null, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
    latestSubmissionId: null, latestSchemaVersion: null, latestAnswers: null, latestMeta: null, latestAnsweredCount: null,
    latestRequiredAnswered: null, latestRequiredTotal: null, latestRedactions: null, latestSupersedesId: null, latestSubmittedAt: null,
    stage: "contacted", dealValue: null, dealCurrency: null, stageEnteredAt: "2026-09-02T00:00:00Z", ...over,
  };
}

const ev = (id: string, from: string, to: string, at: string, extra: Partial<StageEvent> = {}): StageEvent => ({
  id, fromStage: from, toStage: to, dealValue: null, dealCurrency: null, actorId: "u1", actorName: "Clement Hansel", viaAgent: null, occurredAt: at, ...extra,
});
const NO_HISTORY: ReadResult<StageEvent[]> = { kind: "ok", data: [] };

function actions(over: Partial<Actions> = {}): Actions {
  return {
    invite: vi.fn(async (_p: unknown, _fd: FormData) => ({ ok: true })),
    revoke: vi.fn(async (_p: unknown, _fd: FormData) => ({ ok: true })),
    open: vi.fn(async (_p: unknown, _fd: FormData) => ({ ok: true })),
    decline: vi.fn(async (_p: unknown, _fd: FormData) => ({ ok: true })),
    nurture: vi.fn(async (_p: unknown, _fd: FormData) => ({ ok: true })),
    convert: vi.fn(async (_p: unknown, _fd: FormData) => ({ ok: true })),
    moveStage: vi.fn(async (_p: unknown, _fd: FormData) => ({ ok: true, changed: true })),
    setDeal: vi.fn(async (_p: unknown, _fd: FormData) => ({ ok: true, changed: true })),
    ...over,
  };
}

function renderDetail(props: Partial<React.ComponentProps<typeof AgencyLeadDetail>> = {}) {
  return render(
    <AgencyLeadDetail
      lead={lead()}
      submissionsResult={{ kind: "ok", data: [] }}
      members={[]}
      canWrite
      canTriage
      canConvert={false}
      reference={refOk}
      history={NO_HISTORY}
      actions={actions()}
      {...props}
    />,
  );
}

describe("Pipeline card: stage and moves", () => {
  it("shows the stepper of open stages with the current one marked", () => {
    renderDetail();
    const stepper = screen.getByRole("list", { name: "Pipeline stage" });
    const steps = within(stepper).getAllByRole("listitem");
    expect(steps.map((s) => s.textContent)).toEqual(["Enquiry", "Contacted", "Qualified", "Proposal sent"]);
    expect(within(stepper).getByText("Contacted")).toHaveAttribute("aria-current", "step");
  });

  it("offers a move button for each OTHER open stage, and never Won or Lost", () => {
    renderDetail();
    for (const name of ["Enquiry", "Qualified", "Proposal sent"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Contacted" })).toBeNull(); // the current stage
    expect(screen.queryByRole("button", { name: "Won" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Lost" })).toBeNull();
  });

  it("points at Convert and Decline for the two closing stages", () => {
    renderDetail();
    expect(screen.getByText(/Won happens only through/)).toHaveTextContent(/Convert/);
    expect(screen.getByText(/Won happens only through/)).toHaveTextContent(/Decline/);
  });

  it("without canTriage there are no move buttons, but the stage and history still render", () => {
    renderDetail({ canTriage: false, history: { kind: "ok", data: [ev("e1", "enquiry", "contacted", "2026-09-02T00:00:00Z")] } });
    expect(screen.queryByRole("button", { name: "Qualified" })).toBeNull();
    expect(screen.getByRole("list", { name: "Pipeline stage" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Stage history" })).toBeInTheDocument();
  });

  it("a converted lead has no moves and shows Won as its closed stage", () => {
    renderDetail({ lead: lead({ status: "converted", stage: "won", dealValue: "500.0000", dealCurrency: "USD" }), canConvert: true });
    expect(screen.queryByRole("button", { name: "Qualified" })).toBeNull();
    const current = screen.getAllByRole("listitem").filter((li) => li.getAttribute("aria-current") === "step");
    expect(current.map((li) => li.textContent)).toEqual(["Won"]);
    expect(screen.getByText(/Won at USD 500\.00/)).toBeInTheDocument();
  });

  it("clicking a move sends that stage and the lead id to the action", async () => {
    const moveStage = vi.fn(async (_p: unknown, _fd: FormData) => ({ ok: true, changed: true }));
    renderDetail({ actions: actions({ moveStage }) });
    fireEvent.click(screen.getByRole("button", { name: "Qualified" }));
    await waitFor(() => expect(moveStage).toHaveBeenCalledTimes(1));
    const fd = moveStage.mock.calls[0][1] as FormData;
    expect(fd.get("stage")).toBe("qualified");
    expect(fd.get("leadId")).toBe("lead-1");
  });

  it("a successful move shows no component-held message: the card re-renders from server state", async () => {
    const moveStage = vi.fn(async (_p: unknown, _fd: FormData) => ({ ok: true, changed: true }));
    renderDetail({ actions: actions({ moveStage }) });
    fireEvent.click(screen.getByRole("button", { name: "Qualified" }));
    await waitFor(() => expect(moveStage).toHaveBeenCalled());
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a same-stage move (changed:false) says nothing changed", async () => {
    const moveStage = vi.fn(async (_p: unknown, _fd: FormData) => ({ ok: true, changed: false, stage: "qualified" }));
    renderDetail({ actions: actions({ moveStage }) });
    fireEvent.click(screen.getByRole("button", { name: "Qualified" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Already at Qualified. Nothing changed.");
  });
});

describe("Pipeline card: typed refusals in plain words", () => {
  const MOVE_REFUSALS: [string, number, RegExp][] = [
    ["stage_unknown", 400, /stage does not exist/],
    ["stage_terminal", 400, /Use Convert to mark a lead won, or Decline to mark it lost/],
    ["lead_closed", 409, /already converted or declined/],
  ];
  it.each(MOVE_REFUSALS)("move: %s renders a sentence, not the code or the raw error", async (reason, httpStatus, words) => {
    const moveStage = vi.fn(async (_p: unknown, _fd: FormData) => ({ ok: false, error: `raw ${reason} text`, reason, httpStatus }));
    renderDetail({ actions: actions({ moveStage }) });
    fireEvent.click(screen.getByRole("button", { name: "Qualified" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(words);
    expect(alert.textContent).not.toContain(reason);
    expect(alert.textContent).not.toContain("raw");
  });

  it("move: a 403 renders a plain permission message", async () => {
    const moveStage = vi.fn(async (_p: unknown, _fd: FormData) => ({ ok: false, error: "forbidden", httpStatus: 403 }));
    renderDetail({ actions: actions({ moveStage }) });
    fireEvent.click(screen.getByRole("button", { name: "Qualified" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You don't have permission to do that.");
  });

  const DEAL_REFUSALS: [string, RegExp][] = [
    ["deal_incomplete", /both a value and a currency, or clear both/],
    ["deal_value_invalid", /must be a plain number/],
    ["deal_currency_unknown", /currency isn't available/],
    ["deal_value_precision", /more decimal places than the currency allows/],
  ];
  it.each(DEAL_REFUSALS)("deal: %s renders a sentence", async (reason, words) => {
    // A value that passes the local check, so the server refusal is what the person sees.
    const setDeal = vi.fn(async (_p: unknown, _fd: FormData) => ({ ok: false, error: `raw ${reason}`, reason, httpStatus: 400 }));
    renderDetail({ actions: actions({ setDeal }) });
    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "USD" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "10.25" } });
    fireEvent.click(screen.getByRole("button", { name: "Set value" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(words);
    expect(alert.textContent).not.toContain("raw");
  });

  it("deal: a 403 renders a plain permission message", async () => {
    const setDeal = vi.fn(async (_p: unknown, _fd: FormData) => ({ ok: false, error: "forbidden", httpStatus: 403 }));
    renderDetail({ actions: actions({ setDeal }) });
    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "USD" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "10.25" } });
    fireEvent.click(screen.getByRole("button", { name: "Set value" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You don't have permission to do that.");
  });
});

describe("Pipeline card: deal value", () => {
  it("only with canWrite is the value form rendered; the saved value is still shown", () => {
    renderDetail({ canWrite: false, lead: lead({ dealValue: "15000000.0000", dealCurrency: "IDR" }) });
    expect(screen.queryByLabelText("Value")).toBeNull();
    expect(screen.queryByRole("button", { name: /value/i })).toBeNull();
    expect(screen.getByText(/Deal value:/).parentElement).toHaveTextContent("IDR 15,000,000");
  });

  it("the currency picker lists the reference's active currencies, nothing hard-wired", () => {
    renderDetail();
    const options = within(screen.getByLabelText("Currency")).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Choose…", "IDR (Rp)", "USD ($)"]);
  });

  it("pre-selects the most recently used currency, and has no default when there is none", () => {
    const { unmount } = renderDetail({ recentCurrency: "USD" });
    expect(screen.getByLabelText("Currency")).toHaveValue("USD");
    unmount();
    renderDetail({ recentCurrency: null });
    expect(screen.getByLabelText("Currency")).toHaveValue("");
  });

  it("limits decimals to the currency's minor unit before the round trip", () => {
    const setDeal = vi.fn(async (_p: unknown, _fd: FormData) => ({ ok: true }));
    renderDetail({ actions: actions({ setDeal }) });
    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "IDR" } });
    expect(screen.getByText(/IDR has no decimals/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "1500.5" } });
    expect(screen.getByRole("alert")).toHaveTextContent(/more decimal places than the currency allows/);
    expect(screen.getByRole("button", { name: "Set value" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "USD" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Set value" })).not.toBeDisabled();
    expect(setDeal).not.toHaveBeenCalled();
  });

  it("saves the typed value and currency as typed (a string, never a number)", async () => {
    const setDeal = vi.fn(async (_p: unknown, _fd: FormData) => ({ ok: true, changed: true }));
    renderDetail({ actions: actions({ setDeal }) });
    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "USD" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "10.25" } });
    fireEvent.click(screen.getByRole("button", { name: "Set value" }));
    await waitFor(() => expect(setDeal).toHaveBeenCalledTimes(1));
    const fd = setDeal.mock.calls[0][1] as FormData;
    expect(fd.get("value")).toBe("10.25");
    expect(fd.get("currency")).toBe("USD");
    expect(fd.get("intent")).toBeNull();
  });

  it("Clear is an explicit separate action, offered only when a value exists", async () => {
    const setDeal = vi.fn(async (_p: unknown, _fd: FormData) => ({ ok: true, changed: true }));
    const { unmount } = renderDetail({ actions: actions({ setDeal }) });
    expect(screen.queryByRole("button", { name: "Clear value" })).toBeNull();
    unmount();
    renderDetail({ lead: lead({ dealValue: "10.2500", dealCurrency: "USD" }), actions: actions({ setDeal }) });
    expect(screen.getByLabelText("Value")).toHaveValue("10.25");
    fireEvent.click(screen.getByRole("button", { name: "Clear value" }));
    await waitFor(() => expect(setDeal).toHaveBeenCalledTimes(1));
    expect((setDeal.mock.calls[0][1] as FormData).get("intent")).toBe("clear");
  });

  it("an empty form cannot be submitted, so an empty value can never wipe one", () => {
    renderDetail({ lead: lead({ dealValue: "10.2500", dealCurrency: "USD" }) });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Update value" })).toBeDisabled();
  });

  it("when the reference is refused the value controls are withheld and the refusal is shown", () => {
    renderDetail({ reference: { kind: "forbidden" } });
    expect(screen.queryByLabelText("Value")).toBeNull();
    expect(screen.queryByRole("button", { name: "Qualified" })).toBeNull();
    expect(screen.getByText(/pipeline stages and currencies/i)).toBeInTheDocument();
  });
});

describe("Pipeline card: stage history", () => {
  const EVENTS: StageEvent[] = [
    ev("e3", "qualified", "proposal", "2026-09-05T12:00:00Z", { dealValue: "15000000.0000", dealCurrency: "IDR", actorName: "Gede Wirawan" }),
    ev("e2", "contacted", "qualified", "2026-09-03T12:00:00Z", { viaAgent: "Sales assistant" }),
    ev("e1", "enquiry", "contacted", "2026-09-02T12:00:00Z", { actorName: null }),
  ];

  it("lists newest first, with from to to, value, actor and time", () => {
    renderDetail({ history: { kind: "ok", data: EVENTS } });
    const items = within(screen.getByRole("list", { name: "Stage history" })).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("Qualified → Proposal sent");
    expect(items[0]).toHaveTextContent("IDR 15,000,000");
    expect(items[0]).toHaveTextContent("Gede Wirawan");
    expect(items[1]).toHaveTextContent("Contacted → Qualified");
    expect(items[1]).toHaveTextContent("via agent Sales assistant");
    expect(items[2]).toHaveTextContent("Enquiry → Contacted");
    expect(items[2]).toHaveTextContent("System");
  });

  it("keeps newest first even if the backend order were reversed", () => {
    renderDetail({ history: { kind: "ok", data: [...EVENTS].reverse() } });
    const items = within(screen.getByRole("list", { name: "Stage history" })).getAllByRole("listitem");
    expect(items.map((i) => i.textContent?.slice(0, 22))).toEqual([
      expect.stringContaining("Qualified → Proposal"),
      expect.stringContaining("Contacted → Qualified"),
      expect.stringContaining("Enquiry → Contacted"),
    ]);
  });

  it("an empty history says history starts at the first move", () => {
    renderDetail();
    expect(screen.getByText(/History starts at the first move/)).toBeInTheDocument();
  });

  it("a refused history read is a refusal, not an empty history", () => {
    renderDetail({ history: { kind: "unavailable", reason: "platform 500" } });
    expect(screen.queryByText(/History starts at the first move/)).toBeNull();
    expect(screen.getByText(/Stage history/)).toBeInTheDocument();
  });
});

describe("Decline is offered for every open status", () => {
  const OPEN: LeadStatus[] = ["new", "invited", "submitted", "in_review", "nurturing"];
  it.each(OPEN)("%s: a Decline control is present with canTriage", (status) => {
    renderDetail({ lead: lead({ status }) });
    expect(screen.getByRole("button", { name: "Decline" })).toBeInTheDocument();
  });
  it.each(["converted", "declined"] as LeadStatus[])("%s: no Decline control", (status) => {
    renderDetail({ lead: lead({ status, stage: status === "converted" ? "won" : "lost" }) });
    expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
  });
  it("without canTriage there is no Decline", () => {
    renderDetail({ canTriage: false });
    expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
  });
});

describe("Convert gains an optional deal", () => {
  const convertable = () => lead({ status: "submitted", stage: "proposal" });

  it("converting without a value sends no deal fields' value", async () => {
    const convert = vi.fn(async (_p: unknown, _fd: FormData) => ({ ok: true, runId: "r1" }));
    renderDetail({ lead: convertable(), canConvert: true, actions: actions({ convert }) });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Convert lead" }));
    await waitFor(() => expect(convert).toHaveBeenCalled());
    expect((convert.mock.calls[0][1] as FormData).get("dealValue")).toBe("");
  });

  it("a typed value and currency ride the form", async () => {
    const convert = vi.fn(async (_p: unknown, _fd: FormData) => ({ ok: true, runId: "r1" }));
    renderDetail({ lead: convertable(), canConvert: true, actions: actions({ convert }) });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.change(screen.getByLabelText("Deal currency"), { target: { value: "IDR" } });
    fireEvent.change(screen.getByLabelText("Deal value"), { target: { value: "15000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Convert lead" }));
    await waitFor(() => expect(convert).toHaveBeenCalled());
    const fd = convert.mock.calls[0][1] as FormData;
    expect(fd.get("dealValue")).toBe("15000000");
    expect(fd.get("dealCurrency")).toBe("IDR");
  });

  it("the deal input is absent without canWrite (the backend would 403 the deal part)", () => {
    renderDetail({ lead: convertable(), canConvert: true, canWrite: false });
    expect(screen.queryByLabelText("Deal value")).toBeNull();
    expect(screen.getByRole("button", { name: "Convert lead" })).toBeInTheDocument();
  });

  it("an invalid deal blocks the button before the round trip", () => {
    renderDetail({ lead: convertable(), canConvert: true });
    fireEvent.change(screen.getByLabelText("Deal currency"), { target: { value: "IDR" } });
    fireEvent.change(screen.getByLabelText("Deal value"), { target: { value: "1500.5" } });
    expect(screen.getByRole("button", { name: "Convert lead" })).toBeDisabled();
  });

  it("a deal refusal from the backend is shown in plain words", async () => {
    const convert = vi.fn(async (_p: unknown, _fd: FormData) => ({ ok: false, error: "raw", reason: "deal_incomplete", httpStatus: 400 }));
    renderDetail({ lead: convertable(), canConvert: true, actions: actions({ convert }) });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.change(screen.getByLabelText("Deal value"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "Convert lead" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/both a value and a currency, or clear both/);
  });
});

describe("summary", () => {
  it("labels a web lead's source as Website form, and the other sources in words", () => {
    const { unmount } = renderDetail({ lead: lead({ source: "web" }) });
    expect(screen.getByText("Website form")).toBeInTheDocument();
    unmount();
    renderDetail({ lead: lead({ source: "staff" }) });
    expect(screen.getByText("Staff entry")).toBeInTheDocument();
  });

  it("shows a stage chip beside the status chip", () => {
    renderDetail({ lead: lead({ status: "in_review", stage: "qualified" }) });
    expect(screen.getAllByText("Qualified").length).toBeGreaterThan(0);
    expect(screen.getAllByText("In review").length).toBeGreaterThan(0);
  });
});

// Next 16.3 applies the convert action's refresh at once: the lead comes back `converted`, ConvertCard unmounts, and
// the "what was delegated" report it held went with it (the page then said "already converted"). The report now
// lives in AgencyLeadDetail, which survives the refresh.
describe("the convert report survives the refresh that converts the lead", () => {
  it("after the refreshed lead is `converted`, the Converted card still shows what was delegated", async () => {
    const convert = vi.fn(async (_p: unknown, _fd: FormData) => ({
      ok: true, runId: "r1",
      delegations: [{ role: "pm", title: "Kick-off with the client", assigneeId: "m1", source: "position" as const }],
    }));
    const members = [{ id: "m1", name: "Ayu" }];
    const props = { submissionsResult: { kind: "ok" as const, data: [] }, members, canWrite: true, canTriage: true, canConvert: true, reference: refOk, history: NO_HISTORY, actions: actions({ convert }) };
    const { rerender } = render(<AgencyLeadDetail lead={lead({ status: "submitted", stage: "proposal" })} {...props} />);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Convert lead" }));
    await waitFor(() => expect(screen.getByText("Kick-off with the client")).toBeTruthy());
    // The refresh: the same component, the lead now converted (ConvertCard is gone).
    rerender(<AgencyLeadDetail lead={lead({ status: "converted", stage: "won", pipelineRunId: "r1" })} {...props} />);
    expect(screen.queryByRole("button", { name: "Convert lead" })).toBeNull();
    expect(screen.getByText("Kick-off with the client")).toBeTruthy();
    expect(screen.getByText(/What was delegated/)).toBeTruthy();
    expect(screen.queryByText(/already converted/)).toBeNull();
  });

  it("a lead that was converted earlier (no report in this view) still says it is already converted", () => {
    renderDetail({ lead: lead({ status: "converted", stage: "won", pipelineRunId: "r1" }) });
    expect(screen.getByText(/already converted/)).toBeTruthy();
    expect(screen.queryByText(/What was delegated/)).toBeNull();
  });
});
