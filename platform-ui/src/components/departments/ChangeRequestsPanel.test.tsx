import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ChangeRequestsPanel, type ChangeRequestsPanelActions } from "./ChangeRequestsPanel";
import type { ChangeRequestRow } from "@/lib/webdevChangeRequests";

function row(over: Partial<ChangeRequestRow> & { id: string }): ChangeRequestRow {
  return {
    clientId: "cl-1", clientName: "Northwind Traders", projectId: null, projectName: null,
    source: "portal", kind: "feature", title: "A request", status: "new", route: null,
    pipelineRunId: null, pmTaskId: null, requestedBy: "demo-client", requestedByName: "Dana Whitfield",
    triagedBy: null, triagedByName: null, triagedAt: null, declinedReason: null,
    createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z",
    ...over,
  };
}

function actionsStub(over: Partial<ChangeRequestsPanelActions> = {}): ChangeRequestsPanelActions {
  return {
    getDetail: vi.fn().mockResolvedValue({ ok: true, row: { ...row({ id: "cr-1" }), body: "Some detail body.", runStatus: null, runTitle: null, taskStatus: null, taskTitle: null } }),
    triage: vi.fn().mockResolvedValue({ ok: true, status: "declined", route: null }),
    ...over,
  };
}

describe("ChangeRequestsPanel — empty state", () => {
  it("shows the teach-state when the queue is empty", () => {
    render(<ChangeRequestsPanel rows={[]} canTriage actions={actionsStub()} />);
    expect(screen.getByText(/No maintenance requests yet/i)).toBeInTheDocument();
  });
});

describe("ChangeRequestsPanel — queue ordering", () => {
  it("renders rows and orders 'new' first", () => {
    const rows = [
      row({ id: "cr-declined", status: "declined", title: "Old declined", createdAt: "2026-07-01T00:00:00Z" }),
      row({ id: "cr-new", status: "new", title: "Fresh ask", createdAt: "2026-08-05T00:00:00Z" }),
    ];
    render(<ChangeRequestsPanel rows={rows} canTriage actions={actionsStub()} />);
    const titles = screen.getAllByRole("button").map((b) => b.textContent).filter((t) => t === "Fresh ask" || t === "Old declined");
    expect(titles).toEqual(["Fresh ask", "Old declined"]);
  });
});

describe("ChangeRequestsPanel — RBAC (positive + negative control)", () => {
  const rows = [row({ id: "cr-1", status: "new" })];

  it("POSITIVE: a manager-tier fixture (canTriage=true) sees the triage actions", async () => {
    render(<ChangeRequestsPanel rows={rows} canTriage actions={actionsStub()} />);
    fireEvent.click(screen.getByText("A request"));
    await waitFor(() => expect(screen.getByText("Convert")).toBeInTheDocument());
    expect(screen.getByText("Decline")).toBeInTheDocument();
  });

  it("NEGATIVE: a member-tier fixture (canTriage=false) does NOT see the triage actions, only read-only detail", async () => {
    render(<ChangeRequestsPanel rows={rows} canTriage={false} actions={actionsStub()} />);
    fireEvent.click(screen.getByText("A request"));
    // The detail body loads (proves the drawer actually opened, not that render silently no-oped).
    await waitFor(() => expect(screen.getByText("Some detail body.")).toBeInTheDocument());
    expect(screen.queryByText("Convert")).not.toBeInTheDocument();
    expect(screen.queryByText("Decline")).not.toBeInTheDocument();
  });
});

describe("ChangeRequestsPanel — triage round-trip", () => {
  it("declining requires a reason and reports the outcome", async () => {
    const triage = vi.fn().mockResolvedValue({ ok: true, status: "declined", route: null });
    render(<ChangeRequestsPanel rows={[row({ id: "cr-1", status: "new" })]} canTriage actions={actionsStub({ triage })} />);
    fireEvent.click(screen.getByText("A request"));
    await waitFor(() => screen.getByText("Decline"));

    // No reason yet — refused client-side, backend never called.
    fireEvent.click(screen.getByText("Decline"));
    expect(await screen.findByText(/needs a reason/i)).toBeInTheDocument();
    expect(triage).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Decline reason/i), { target: { value: "Out of scope." } });
    fireEvent.click(screen.getByText("Decline"));
    await waitFor(() => expect(triage).toHaveBeenCalledWith("cr-1", expect.objectContaining({ action: "decline", reason: "Out of scope." })));
    expect(await screen.findByText("Declined.")).toBeInTheDocument();
  });

  it("converting sends the chosen (overridable) route, defaulting to §2.3's suggestion", async () => {
    const triage = vi.fn().mockResolvedValue({ ok: true, status: "in_progress", route: "mini_run", pipelineRunId: "run-9" });
    render(<ChangeRequestsPanel rows={[row({ id: "cr-1", status: "new", kind: "design" })]} canTriage actions={actionsStub({ triage })} />);
    fireEvent.click(screen.getByText("A request"));
    await waitFor(() => screen.getByText("Convert"));
    fireEvent.click(screen.getByLabelText("No"));
    fireEvent.click(screen.getByText("Convert"));
    // design's suggested route is mini_run (§2.3) and the drawer pre-fills it without forcing it.
    await waitFor(() => expect(triage).toHaveBeenCalledWith("cr-1", expect.objectContaining({ action: "convert", route: "mini_run" })));
    expect(await screen.findByText(/Converted/)).toBeInTheDocument();
  });

  it("a 409 (already triaged) shows the existing artifact, not an error toast", async () => {
    const triage = vi.fn().mockResolvedValue({
      ok: false, error: "change request already triaged (status in_progress)",
      existing: { status: "in_progress", route: "pm_task", pipelineRunId: null, pmTaskId: "task-77" },
    });
    render(<ChangeRequestsPanel rows={[row({ id: "cr-1", status: "new" })]} canTriage actions={actionsStub({ triage })} />);
    fireEvent.click(screen.getByText("A request"));
    await waitFor(() => screen.getByText("Convert"));
    fireEvent.click(screen.getByLabelText("No"));
    fireEvent.click(screen.getByText("Convert"));
    expect(await screen.findByText(/Already triaged/i)).toBeInTheDocument();
    expect(screen.getByText(/Open the existing task/i)).toBeInTheDocument();
  });

  it("a 501 (control_plane) surfaces the explicit webdesk-P4 message, not a generic failure", async () => {
    const triage = vi.fn().mockResolvedValue({
      ok: false, notImplemented: true,
      error: "route 'control_plane' needs the webdesk control plane (webdesk phase 4), which does not exist yet — convert to pm_task and make the edit by hand",
    });
    render(<ChangeRequestsPanel rows={[row({ id: "cr-1", status: "new", kind: "content" })]} canTriage actions={actionsStub({ triage })} />);
    fireEvent.click(screen.getByText("A request"));
    await waitFor(() => screen.getByText("Convert"));
    fireEvent.click(screen.getByLabelText("No"));
    fireEvent.click(screen.getByText("Convert"));
    expect(await screen.findByText(/webdesk phase 4/i)).toBeInTheDocument();
  });
});

describe("ChangeRequestsPanel — PV4-04b: does this change the price?", () => {
  async function openDrawer(triage: ChangeRequestsPanelActions["triage"], over: Partial<ChangeRequestRow> = {}) {
    render(<ChangeRequestsPanel rows={[row({ id: "cr-1", status: "new", ...over })]} canTriage actions={actionsStub({ triage })} />);
    fireEvent.click(screen.getByText("A request"));
    await waitFor(() => screen.getByText("Convert"));
  }
  const convertBtn = () => screen.getByRole("button", { name: /^Convert$/ });

  it("asks the question as a labelled radio group, with neither option preselected", async () => {
    await openDrawer(vi.fn());
    const group = screen.getByRole("group", { name: /Does this change the price\?/i });
    expect(group).toBeInTheDocument();
    const no = screen.getByLabelText("No") as HTMLInputElement;
    const yes = screen.getByLabelText("Yes, the price changes") as HTMLInputElement;
    expect(no.type).toBe("radio");
    expect(yes.type).toBe("radio");
    expect(no.checked).toBe(false);
    expect(yes.checked).toBe(false);
  });

  it("Convert is disabled until a price answer is chosen, and a click before then calls nothing", async () => {
    const triage = vi.fn();
    await openDrawer(triage);
    expect(convertBtn()).toBeDisabled();
    fireEvent.click(convertBtn());
    expect(triage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("No"));
    expect(convertBtn()).toBeEnabled();
  });

  it("the Yes note appears only on Yes", async () => {
    await openDrawer(vi.fn());
    expect(screen.queryByText(/draft amendment is created/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("No"));
    expect(screen.queryByText(/draft amendment is created/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Yes, the price changes"));
    expect(screen.getByText(/A draft amendment is created in Contracts & billing\. Work can't start until it is signed\./)).toBeInTheDocument();
  });

  it("choosing No sends priceImpact 'none' (exact payload)", async () => {
    const triage = vi.fn().mockResolvedValue({ ok: true, status: "in_progress", route: "mini_run", pipelineRunId: "run-9" });
    await openDrawer(triage, { kind: "design" });
    fireEvent.click(screen.getByLabelText("No"));
    fireEvent.click(convertBtn());
    await waitFor(() => expect(triage).toHaveBeenCalledTimes(1));
    expect(triage).toHaveBeenCalledWith("cr-1", { action: "convert", route: "mini_run", kindOverride: "design", priceImpact: "none" });
  });

  it("choosing Yes sends priceImpact 'changes_price' (exact payload, no amendsId)", async () => {
    const triage = vi.fn().mockResolvedValue({ ok: true, status: "new", route: null, priceImpact: "changes_price", blocked: true, amendmentContractId: "ct-1", amendmentKind: "amendment", amendsId: "ct-0" });
    await openDrawer(triage, { kind: "bug" });
    fireEvent.click(screen.getByLabelText("Yes, the price changes"));
    fireEvent.click(convertBtn());
    await waitFor(() => expect(triage).toHaveBeenCalledTimes(1));
    expect(triage).toHaveBeenCalledWith("cr-1", { action: "convert", route: "pm_task", kindOverride: "bug", priceImpact: "changes_price" });
  });

  it("a blocked response renders the waiting state with a link to the client's Contracts & billing", async () => {
    const triage = vi.fn().mockResolvedValue({ ok: true, status: "new", route: null, priceImpact: "changes_price", blocked: true, amendmentContractId: "ct-1", amendmentKind: "amendment", amendsId: "ct-0" });
    await openDrawer(triage);
    fireEvent.click(screen.getByLabelText("Yes, the price changes"));
    fireEvent.click(convertBtn());
    expect(await screen.findByText(/Waiting for the amendment to be signed/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/Converted/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Contracts & billing/ })).toHaveAttribute("href", "/clients/cl-1/billing");
  });

  it("a blocked response with no client id shows the text without a link", async () => {
    const triage = vi.fn().mockResolvedValue({ ok: true, status: "new", route: null, priceImpact: "changes_price", blocked: true, amendmentContractId: "ct-1", amendmentKind: "agreement", amendsId: null });
    await openDrawer(triage, { clientId: null, clientName: null });
    fireEvent.click(screen.getByLabelText("Yes, the price changes"));
    fireEvent.click(convertBtn());
    expect(await screen.findByText(/Waiting for the amendment to be signed/i)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("a 409 amendment_not_signed is a normal state, not an error or an 'already triaged'", async () => {
    const triage = vi.fn().mockResolvedValue({
      ok: false, error: "amendment_not_signed", code: "amendment_not_signed",
      amendment: { amendmentContractId: "ct-1", amendmentStatus: "draft" },
    });
    await openDrawer(triage);
    fireEvent.click(screen.getByLabelText("No"));
    fireEvent.click(convertBtn());
    expect(await screen.findByText(/This request waits for its amendment to be signed/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/Already triaged/i)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Contracts & billing/ })).toHaveAttribute("href", "/clients/cl-1/billing");
  });

  it("amendment_exists and client_required_for_price_change each get a plain-language message", async () => {
    const triage = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: "amendment_exists", code: "amendment_exists", amendment: { amendmentContractId: "ct-1", amendmentStatus: "sent" } })
      .mockResolvedValueOnce({ ok: false, error: "client_required_for_price_change", code: "client_required_for_price_change" });
    await openDrawer(triage);
    fireEvent.click(screen.getByLabelText("No"));
    fireEvent.click(convertBtn());
    expect(await screen.findByText(/already has an amendment in Contracts & billing/i)).toBeInTheDocument();
    expect(screen.queryByText(/amendment_exists/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Yes, the price changes"));
    fireEvent.click(convertBtn());
    expect(await screen.findByText(/needs a client/i)).toBeInTheDocument();
    expect(screen.queryByText(/client_required_for_price_change/)).not.toBeInTheDocument();
  });

  it("decline does not need the price answer and does not send one", async () => {
    const triage = vi.fn().mockResolvedValue({ ok: true, status: "declined", route: null });
    await openDrawer(triage);
    fireEvent.change(screen.getByLabelText(/Decline reason/i), { target: { value: "Out of scope." } });
    fireEvent.click(screen.getByText("Decline"));
    await waitFor(() => expect(triage).toHaveBeenCalledTimes(1));
    const payload = (triage.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(payload.action).toBe("decline");
    expect(payload).not.toHaveProperty("priceImpact");
  });
});

describe("ChangeRequestsPanel — PV4-09: the Amends picker", () => {
  const signed = [
    { id: "ct-master", title: "Master services agreement", reference: "MSA-2026" },
    { id: "ct-site", title: "Site redesign agreement", reference: null },
  ];
  async function open(listSignedContracts: ChangeRequestsPanelActions["listSignedContracts"], triage = vi.fn().mockResolvedValue({ ok: true, status: "new", route: null, blocked: true })) {
    render(<ChangeRequestsPanel rows={[row({ id: "cr-1", status: "new", kind: "design" })]} canTriage actions={actionsStub({ triage, listSignedContracts })} />);
    fireEvent.click(screen.getByText("A request"));
    await waitFor(() => screen.getByText("Convert"));
    return triage;
  }

  it("is not offered until the answer is Yes", async () => {
    await open(vi.fn().mockResolvedValue({ ok: true, contracts: signed }));
    expect(screen.queryByLabelText(/Amends/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("No"));
    expect(screen.queryByLabelText(/Amends/)).not.toBeInTheDocument();
  });

  it("on Yes, lists the client's signed contracts and defaults to 'Let the system choose'", async () => {
    const list = vi.fn().mockResolvedValue({ ok: true, contracts: signed });
    await open(list);
    fireEvent.click(screen.getByLabelText("Yes, the price changes"));
    const picker = (await screen.findByLabelText(/Amends/)) as HTMLSelectElement;
    await waitFor(() => expect(picker).toBeEnabled());
    expect(list).toHaveBeenCalledWith("cl-1");
    expect(picker.value).toBe("");
    expect(Array.from(picker.options).map((o) => o.textContent)).toEqual([
      "Let the system choose", "Master services agreement \u00b7 MSA-2026", "Site redesign agreement",
    ]);
  });

  it("leaving the default sends no amendsId", async () => {
    const triage = await open(vi.fn().mockResolvedValue({ ok: true, contracts: signed }));
    fireEvent.click(screen.getByLabelText("Yes, the price changes"));
    await waitFor(() => expect(screen.getByLabelText(/Amends/)).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /^Convert$/ }));
    await waitFor(() => expect(triage).toHaveBeenCalledTimes(1));
    expect(triage).toHaveBeenCalledWith("cr-1", { action: "convert", route: "mini_run", kindOverride: "design", priceImpact: "changes_price" });
  });

  it("choosing a contract sends it as amendsId", async () => {
    const triage = await open(vi.fn().mockResolvedValue({ ok: true, contracts: signed }));
    fireEvent.click(screen.getByLabelText("Yes, the price changes"));
    await waitFor(() => expect(screen.getByLabelText(/Amends/)).toBeEnabled());
    fireEvent.change(screen.getByLabelText(/Amends/), { target: { value: "ct-site" } });
    fireEvent.click(screen.getByRole("button", { name: /^Convert$/ }));
    await waitFor(() => expect(triage).toHaveBeenCalledWith("cr-1", { action: "convert", route: "mini_run", kindOverride: "design", priceImpact: "changes_price", amendsId: "ct-site" }));
  });

  it("a chosen contract is never sent with a No answer", async () => {
    const triage = await open(vi.fn().mockResolvedValue({ ok: true, contracts: signed }));
    fireEvent.click(screen.getByLabelText("Yes, the price changes"));
    await waitFor(() => expect(screen.getByLabelText(/Amends/)).toBeEnabled());
    fireEvent.change(screen.getByLabelText(/Amends/), { target: { value: "ct-site" } });
    fireEvent.click(screen.getByLabelText("No"));
    fireEvent.click(screen.getByRole("button", { name: /^Convert$/ }));
    await waitFor(() => expect(triage).toHaveBeenCalledTimes(1));
    expect((triage.mock.calls[0] as unknown[])[1]).not.toHaveProperty("amendsId");
  });

  it("a failed contracts read says so and keeps the system default", async () => {
    await open(vi.fn().mockResolvedValue({ ok: false, error: "platform 500" }));
    fireEvent.click(screen.getByLabelText("Yes, the price changes"));
    expect(await screen.findByText(/could not be listed, so the system will choose/)).toBeInTheDocument();
  });

  it("is not offered when the request has no client, or the action is not wired", async () => {
    render(<ChangeRequestsPanel rows={[row({ id: "cr-1", status: "new", clientId: null, clientName: null })]} canTriage actions={actionsStub({ listSignedContracts: vi.fn() })} />);
    fireEvent.click(screen.getByText("A request"));
    await waitFor(() => screen.getByText("Convert"));
    fireEvent.click(screen.getByLabelText("Yes, the price changes"));
    expect(screen.queryByLabelText(/Amends/)).not.toBeInTheDocument();
  });
});

describe("ChangeRequestsPanel — PV4-09: the price and amendment columns", () => {
  it("shows the price impact and the amendment status, linked to the client's billing", () => {
    render(
      <ChangeRequestsPanel
        rows={[row({ id: "a", title: "Wishlist", priceImpact: "changes_price", amendmentContractId: "ct-9", amendmentStatus: "draft" })]}
        canTriage
        actions={actionsStub()}
      />,
    );
    expect(screen.getByText("Price")).toBeInTheDocument();
    expect(screen.getByText("Amendment")).toBeInTheDocument();
    expect(screen.getByText("Changes the price")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Draft amendment" })).toHaveAttribute("href", "/clients/cl-1/billing");
  });

  it("says nothing for a field an older server omits, and a dash when no amendment is linked", () => {
    render(<ChangeRequestsPanel rows={[row({ id: "a", title: "Old row" }), row({ id: "b", title: "None", priceImpact: "none", amendmentStatus: null })]} canTriage actions={actionsStub()} />);
    expect(screen.queryByText("Not assessed")).not.toBeInTheDocument();
    expect(screen.getByText("No price change")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /amendment/i })).not.toBeInTheDocument();
  });

  it("a request with no client shows the amendment status without a link", () => {
    render(<ChangeRequestsPanel rows={[row({ id: "a", clientId: null, clientName: null, priceImpact: "changes_price", amendmentStatus: "signed" })]} canTriage actions={actionsStub()} />);
    expect(screen.getByText("Amendment signed")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Amendment signed" })).not.toBeInTheDocument();
  });
});

describe("ChangeRequestsPanel — origin (DW-5e)", () => {
  const rows = [row({ id: "cr-1", title: "From a request" }), row({ id: "cr-2", title: "From a client" })];

  it("shows no Origin column when the prop is absent (today's page)", () => {
    render(<ChangeRequestsPanel rows={rows} canTriage actions={actionsStub()} />);
    expect(screen.queryByText("Origin")).toBeNull();
  });

  it("shows the department, the person and a link to the request, and a dash for the rest", () => {
    render(
      <ChangeRequestsPanel
        rows={rows} canTriage actions={actionsStub()}
        origins={{ state: "ok", byChangeRequest: { "cr-1": { requestId: "req-9", from: "Marketing", person: "Dana" } } }}
      />,
    );
    expect(screen.getByText("Origin")).toBeInTheDocument();
    // One short link: the department is the visible text; the person is in the link's name and tooltip.
    const link = screen.getByRole("link", { name: "From Marketing, asked by Dana. Open the request." });
    expect(link).toHaveAttribute("href", "/requests/req-9");
    expect(link).toHaveTextContent(/^Marketing$/);
    expect(link).toHaveAttribute("title", "Asked by Dana. Open the request.");
  });

  it("says Unavailable on every row when the read failed, and still renders the queue", () => {
    render(<ChangeRequestsPanel rows={rows} canTriage actions={actionsStub()} origins={{ state: "unavailable" }} />);
    expect(screen.getAllByText("Unavailable")).toHaveLength(2);
    expect(screen.getByText("From a request")).toBeInTheDocument();
  });
});
