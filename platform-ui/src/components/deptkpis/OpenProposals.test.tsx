import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/deptKpiActions", () => ({
  decideTargetsBatchAction: vi.fn(), approveDeptKpiTarget: vi.fn(), rejectDeptKpiTarget: vi.fn(), proposeDeptKpiTarget: vi.fn(),
}));

import { decideTargetsBatchAction, approveDeptKpiTarget, rejectDeptKpiTarget } from "@/lib/deptKpiActions";
import { OpenProposals, type ProposalGroup } from "./OpenProposals";
import type { DeptKpiTargetRow } from "@/lib/deptKpiFormat";

// DW-10b-2 (BFF sections 58.3 and 58.4): the approver's view. Open proposals grouped by KPI, a checkbox on each (none on the viewer's own), one bar that
// decides the ticked ones in one batch, the single buttons still there, and a refusal that names the proposal that caused it.

const prop = (id: string, effectiveFrom: string, over: Partial<DeptKpiTargetRow> = {}): DeptKpiTargetRow => ({
  id, unitNodeId: "dept-1", kpiKey: "k", effectiveFrom, target: 0.9, tolerance: 0.05, status: "proposed", note: null,
  proposedBy: "u-webhead", proposedAt: "2026-10-15T08:00:00.000Z", decidedBy: null, decidedAt: null, ...over,
});
const groups: ProposalGroup[] = [
  { key: "projects-on-time", label: "Projects on time", unit: "percent", proposals: [prop("p1", "2026-11-01"), prop("p2", "2026-12-01", { note: "Peak" }), prop("p3", "2027-01-01", { proposedBy: "me" })] },
  { key: "reopened-work-rate", label: "Reopened work rate", unit: "percent", proposals: [prop("p4", "2026-11-01", { target: 0.04 })] },
  { key: "assets", label: "Assets delivered", unit: "count", proposals: [] },
];
const mount = (g = groups) => render(<OpenProposals groups={g} meId="me" />);
const box = (name: string) => screen.getByRole("checkbox", { name: `Select the proposal for ${name}` });

beforeEach(() => {
  refresh.mockReset();
  vi.mocked(decideTargetsBatchAction).mockReset();
  vi.mocked(approveDeptKpiTarget).mockReset();
  vi.mocked(rejectDeptKpiTarget).mockReset();
});

describe("Open proposals, grouped by KPI", () => {
  it("lists a section per KPI that has open proposals, and none for a KPI that has none", () => {
    mount();
    const g = screen.getByRole("group", { name: "Open proposals" });
    expect(within(g).getByRole("region", { name: "Open proposals: Projects on time" })).toBeInTheDocument();
    expect(within(g).getByRole("region", { name: "Open proposals: Reopened work rate" })).toBeInTheDocument();
    expect(within(g).queryByRole("region", { name: "Open proposals: Assets delivered" })).toBeNull();
    const first = within(screen.getByRole("region", { name: "Open proposals: Projects on time" })).getAllByRole("listitem");
    expect(first).toHaveLength(3);
    expect(first[0]).toHaveTextContent("Proposed: 90%, tolerance 5 pts, from November 2026. By u-webhead on 2026-10-15.");
    expect(first[1]).toHaveTextContent("Note: Peak");
  });

  it("gives a checkbox to every proposal but the viewer's own, which says You proposed this", () => {
    mount();
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    expect(box("Projects on time, November 2026")).toBeInTheDocument();
    expect(box("Projects on time, December 2026")).toBeInTheDocument();
    expect(box("Reopened work rate, November 2026")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /January 2027/ })).toBeNull();
    const own = screen.getByText(/You proposed this/).closest("li") as HTMLElement;
    expect(own).toHaveTextContent("By you on 2026-10-15");
    // DW-10b-4: no Approve and no Reject on one's own, only Withdraw.
    expect(within(own).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Withdraw your proposal for Projects on time, January 2027"]);
  });

  it("DW-10b-4: Withdraw on the viewer's own proposal is the single reject, and the page refreshes", async () => {
    vi.mocked(rejectDeptKpiTarget).mockResolvedValue({ ok: true });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Withdraw your proposal for Projects on time, January 2027" }));
    await waitFor(() => expect(rejectDeptKpiTarget).toHaveBeenCalledWith("p3"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("keeps the single Approve and Reject on every proposal that is not the viewer's own", async () => {
    vi.mocked(approveDeptKpiTarget).mockResolvedValue({ ok: true });
    mount();
    expect(screen.getAllByRole("button", { name: /^Approve the proposed target for / })).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: /^Reject the proposed target for / })).toHaveLength(3);
    fireEvent.click(screen.getAllByRole("button", { name: "Approve the proposed target for Projects on time" })[0]);
    await waitFor(() => expect(approveDeptKpiTarget).toHaveBeenCalledWith("p1"));
  });

  it("renders nothing when no KPI has an open proposal", () => {
    const { container } = mount(groups.map((g) => ({ ...g, proposals: [] })));
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Approve selected and Reject selected", () => {
  it("are disabled until something is ticked, and count the ticks", () => {
    mount();
    expect(screen.getByRole("button", { name: "Approve selected" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject selected" })).toBeDisabled();
    expect(screen.getByText("None selected")).toBeInTheDocument();
    fireEvent.click(box("Projects on time, November 2026"));
    fireEvent.click(box("Reopened work rate, November 2026"));
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve selected" })).toBeEnabled();
    fireEvent.click(box("Reopened work rate, November 2026"));
    expect(screen.getByText("1 selected")).toBeInTheDocument();
  });

  it("approve the ticked proposals across KPIs in ONE batch, then clear the selection and refresh", async () => {
    vi.mocked(decideTargetsBatchAction).mockResolvedValue({ ok: true, decided: [] });
    mount();
    fireEvent.click(box("Projects on time, November 2026"));
    fireEvent.click(box("Projects on time, December 2026"));
    fireEvent.click(box("Reopened work rate, November 2026"));
    fireEvent.click(screen.getByRole("button", { name: "Approve selected" }));
    await waitFor(() => expect(decideTargetsBatchAction).toHaveBeenCalledTimes(1));
    expect(vi.mocked(decideTargetsBatchAction).mock.calls[0][0]).toEqual({ decision: "approve", ids: ["p1", "p2", "p4"] });
    expect(await screen.findByRole("status")).toHaveTextContent("Approved 3 proposals.");
    expect(refresh).toHaveBeenCalled();
    expect(screen.getByText("None selected")).toBeInTheDocument();
    expect(box("Projects on time, November 2026")).not.toBeChecked();
  });

  it("reject the ticked proposals in one batch", async () => {
    vi.mocked(decideTargetsBatchAction).mockResolvedValue({ ok: true, decided: [] });
    mount();
    fireEvent.click(box("Projects on time, December 2026"));
    fireEvent.click(screen.getByRole("button", { name: "Reject selected" }));
    await waitFor(() => expect(decideTargetsBatchAction).toHaveBeenCalledWith({ decision: "reject", ids: ["p2"] }));
    expect(await screen.findByRole("status")).toHaveTextContent("Rejected 1 proposal.");
  });

  it("names the KPI and month the server refused (failedId), says nothing was decided, and keeps the selection", async () => {
    vi.mocked(decideTargetsBatchAction).mockResolvedValue({ ok: false, error: "not_proposed", failedId: "p2" });
    mount();
    fireEvent.click(box("Projects on time, November 2026"));
    fireEvent.click(box("Projects on time, December 2026"));
    fireEvent.click(screen.getByRole("button", { name: "Approve selected" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Projects on time, December 2026: This proposal was already decided. Refresh to see where it stands. Nothing was decided.");
    expect(refresh).not.toHaveBeenCalled();
    expect(box("Projects on time, November 2026")).toBeChecked();
  });

  it("says the refusal without a name when the server names no proposal, or one that is no longer listed", async () => {
    vi.mocked(decideTargetsBatchAction).mockResolvedValueOnce({ ok: false, error: "not authorized" });
    mount();
    fireEvent.click(box("Projects on time, November 2026"));
    fireEvent.click(screen.getByRole("button", { name: "Approve selected" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not authorized Nothing was decided.");
    vi.mocked(decideTargetsBatchAction).mockResolvedValueOnce({ ok: false, error: "target_not_found", failedId: "gone" });
    fireEvent.click(screen.getByRole("button", { name: "Reject selected" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("target_not_found Nothing was decided."));
  });
});
