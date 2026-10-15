import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { PayrollRunActions, type PayrollRunActionsApi } from "./PayrollRunActions";
import { PayrollRunForm } from "./PayrollRunForm";

// DW-7f-1 — the controls on a payroll run: which buttons per status and per capability, the override
// reason, the mark-paid confirmation, and that a refusal is shown in the server's words.

function makeApi(): PayrollRunActionsApi {
  return {
    calculate: vi.fn(async () => ({ ok: true, notice: "Calculated 3 employee(s)." })),
    approve: vi.fn(async () => ({ ok: true, status: "approved", notice: "Approved." })),
    publish: vi.fn(async () => ({ ok: true, notice: "3 payslip(s) published to their employees." })),
    markPaid: vi.fn(async () => ({ ok: true, status: "paid", notice: "Marked paid." })),
  };
}

function setup(over: Partial<React.ComponentProps<typeof PayrollRunActions>> = {}) {
  const api = makeApi();
  render(
    <PayrollRunActions tenantId="co-a" runId="run-1" reference="PAY-2026-10" status="draft"
      canManage canApprove needsOverride={false} api={api} {...over} />,
  );
  return api;
}
const names = () => screen.queryAllByRole("button").map((b) => b.textContent);

beforeEach(() => refresh.mockReset());
afterEach(() => cleanup());

describe("PayrollRunActions — buttons per status", () => {
  it.each([
    ["draft", ["Calculate"]],
    ["calculated", ["Recalculate", "Approve"]],
    ["pending_approval", ["Approve"]],
    ["approved", ["Publish payslips", "Mark paid"]],
    ["paid", ["Publish payslips"]],
    ["cancelled", []],
  ])("%s offers %j for someone who can manage and approve", (status, expected) => {
    setup({ status });
    expect(names()).toEqual(expected);
  });
});

describe("PayrollRunActions — buttons per capability", () => {
  it("a manager who cannot approve sees Calculate only, never Approve, Publish or Mark paid", () => {
    setup({ status: "calculated", canApprove: false });
    expect(names()).toEqual(["Recalculate"]);
    cleanup();
    setup({ status: "approved", canApprove: false });
    expect(names()).toEqual([]);
  });

  it("an approver who cannot manage never sees Calculate", () => {
    setup({ status: "draft", canManage: false });
    expect(names()).toEqual([]);
    cleanup();
    setup({ status: "calculated", canManage: false });
    expect(names()).toEqual(["Approve"]);
  });

  it("a viewer with neither sees no buttons at all", () => {
    setup({ status: "calculated", canManage: false, canApprove: false });
    expect(names()).toEqual([]);
  });
});

describe("PayrollRunActions — calling the server", () => {
  it("Calculate calls the action with the company and run, shows the server's notice and re-reads the page", async () => {
    const api = setup({ status: "draft" });
    fireEvent.click(screen.getByRole("button", { name: "Calculate" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Calculated 3 employee(s)."));
    expect(api.calculate).toHaveBeenCalledWith("co-a", "run-1");
    expect(refresh).toHaveBeenCalled();
  });

  it("shows the server's refusal in its own words, re-reads the page, and does not claim success", async () => {
    const api = setup({ status: "approved" });
    vi.mocked(api.publish).mockResolvedValue({ ok: false, error: "You don't have permission to publish payslips." });
    fireEvent.click(screen.getByRole("button", { name: "Publish payslips" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("You don't have permission to publish payslips."));
    expect(screen.queryByRole("status")).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });
});

describe("PayrollRunActions — approve", () => {
  it("for a run known ratified: asks to confirm, no override controls, sends no override", async () => {
    const api = setup({ status: "calculated", needsOverride: false });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(api.approve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm approval" }));
    await waitFor(() => expect(api.approve).toHaveBeenCalledWith("co-a", "run-1", {}));
  });

  it("for an unratified run: the reason box appears only when the override is ticked and Confirm stays disabled until a reason is typed", async () => {
    const api = setup({ status: "calculated", needsOverride: true });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(screen.queryByLabelText(/Reason for the override/)).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: /unratified statutory parameters/ }));
    const reason = screen.getByLabelText(/Reason for the override/);
    const confirm = screen.getByRole("button", { name: "Confirm approval" });
    expect(confirm).toBeDisabled();
    fireEvent.change(reason, { target: { value: "   " } });
    expect(confirm).toBeDisabled();
    fireEvent.change(reason, { target: { value: " Owner signed off by email. " } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(api.approve).toHaveBeenCalledWith("co-a", "run-1", { overrideUnratified: true, overrideReason: "Owner signed off by email." }),
    );
  });

  it("for an unratified run with the box left unticked, sends no override and lets the server refuse in words", async () => {
    const api = setup({ status: "calculated", needsOverride: true });
    vi.mocked(api.approve).mockResolvedValue({ ok: false, error: "the statutory parameter set this run used is NOT ratified." });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm approval" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("NOT ratified"));
    expect(api.approve).toHaveBeenCalledWith("co-a", "run-1", {});
  });
});

describe("PayrollRunActions — mark paid", () => {
  it("asks first, says the money left the bank, and calls nothing until confirmed", async () => {
    const api = setup({ status: "approved" });
    fireEvent.click(screen.getByRole("button", { name: "Mark paid" }));
    expect(screen.getByText(/This records that the money left the bank/)).toBeInTheDocument();
    expect(api.markPaid).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Yes, record as paid" }));
    await waitFor(() => expect(api.markPaid).toHaveBeenCalledWith("co-a", "run-1"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Marked paid."));
  });

  it("Cancel backs out without calling the server", () => {
    const api = setup({ status: "approved" });
    fireEvent.click(screen.getByRole("button", { name: "Mark paid" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/money left the bank/)).toBeNull();
    expect(api.markPaid).not.toHaveBeenCalled();
  });
});

describe("PayrollRunForm", () => {
  it("opens on demand, defaults to a regular run in the given currency, and shows a 409 as the server sent it", async () => {
    const create = vi.fn(async (_fd: FormData) => ({ ok: false, error: "that run reference is already in use" }));
    render(<PayrollRunForm create={create} companyId="co-a" defaultCurrency="IDR" />);
    expect(screen.queryByLabelText(/^Reference/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New payroll run" }));
    expect(screen.getByLabelText(/^Kind/)).toHaveValue("regular");
    expect(screen.getByLabelText(/^Currency/)).toHaveValue("IDR");
    fireEvent.change(screen.getByLabelText(/^Reference/), { target: { value: "PAY-2026-10" } });
    fireEvent.change(screen.getByLabelText("Period start"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("Period end"), { target: { value: "2026-10-31" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft run" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("that run reference is already in use"));
    const fd = create.mock.calls[0][0];
    expect(fd.get("companyId")).toBe("co-a");
    expect(fd.get("reference")).toBe("PAY-2026-10");
    expect(fd.get("kind")).toBe("regular");
    expect(fd.get("currency")).toBe("IDR");
  });

  it("closes and re-reads the page after the server confirms the draft", async () => {
    const create = vi.fn(async (_fd: FormData) => ({ ok: true, id: "run-9", status: "draft" }));
    render(<PayrollRunForm create={create} companyId="co-a" defaultCurrency="IDR" />);
    fireEvent.click(screen.getByRole("button", { name: "New payroll run" }));
    fireEvent.change(screen.getByLabelText(/^Reference/), { target: { value: "PAY-X" } });
    fireEvent.change(screen.getByLabelText("Period start"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("Period end"), { target: { value: "2026-10-31" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft run" }));
    await waitFor(() => expect(screen.queryByLabelText(/^Reference/)).toBeNull());
    expect(refresh).toHaveBeenCalled();
  });
});
