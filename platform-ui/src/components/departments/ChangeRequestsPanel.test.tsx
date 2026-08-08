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
    fireEvent.click(screen.getByText("Convert"));
    expect(await screen.findByText(/webdesk phase 4/i)).toBeInTheDocument();
  });
});
