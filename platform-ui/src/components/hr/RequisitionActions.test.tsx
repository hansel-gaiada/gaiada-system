import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

import { RequisitionActions, type RequisitionActionsApi } from "./RequisitionActions";
import { RequisitionForm } from "./RequisitionForm";
import { CandidateForm } from "./CandidateForm";
import { CandidateErasureButton } from "./CandidateErasureButton";

// DW-7f-2 — the controls on a requisition and the create forms: which buttons per status and capability, the
// confirmations, and that a refusal is shown in the server's own words.

const initial = {
  title: "Designer", openings: 2, filled: 1, employmentType: "permanent", location: "Denpasar", workMode: "hybrid",
  salaryMin: "8000000", salaryMax: "12000000", targetStartOn: "2026-12-01", hiringManagerUserId: null, recruiterUserId: null,
};
function makeApi(): RequisitionActionsApi {
  return {
    submit: vi.fn(async () => ({ ok: true, status: "pending_approval", approvalId: "ap-9", notice: "Submitted for approval." })),
    setStatus: vi.fn(async () => ({ ok: true, status: "closed", notice: "Requisition set to closed." })),
    update: vi.fn(async () => ({ ok: true, notice: "Requisition updated." })),
  };
}
function setup(over: Partial<React.ComponentProps<typeof RequisitionActions>> = {}) {
  const api = makeApi();
  render(
    <RequisitionActions tenantId="co-a" requisitionId="rq-1" reference="REQ-1" status="draft" canManage canUpdate
      initial={initial} people={[{ userId: "u-hm", name: "Made" }]} api={api} {...over} />,
  );
  return api;
}
const names = () => screen.queryAllByRole("button").map((b) => b.textContent);

beforeEach(() => refresh.mockReset());
afterEach(() => cleanup());

describe("RequisitionActions — buttons per status", () => {
  it.each([
    ["draft", ["Submit for approval", "Edit", "Cancel requisition"]],
    ["pending_approval", []],
    ["open", ["Edit", "Put on hold", "Close", "Cancel requisition"]],
    ["on_hold", ["Edit", "Return to draft", "Close", "Cancel requisition"]],
    ["filled", []], ["closed", []], ["cancelled", []],
  ])("%s offers %j to a manager", (status, expected) => {
    setup({ status });
    expect(names()).toEqual(expected);
  });

  it("a pending requisition points at the approvals queue instead of offering an approve button", () => {
    setup({ status: "pending_approval" });
    expect(screen.getByRole("link", { name: "approvals queue" })).toHaveAttribute("href", "/approvals");
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
  });
});

describe("RequisitionActions — buttons per capability", () => {
  it("a hiring manager (update, not manage) can edit and move status but never submit", () => {
    setup({ status: "draft", canManage: false });
    expect(names()).toEqual(["Edit", "Cancel requisition"]);
  });

  it("a reader with neither sees no buttons", () => {
    setup({ status: "open", canManage: false, canUpdate: false });
    expect(names()).toEqual([]);
  });

  it("compact (list rows) offers the submit button only, and only to a manager of a draft", () => {
    setup({ compact: true });
    expect(names()).toEqual(["Submit for approval"]);
    cleanup();
    setup({ compact: true, status: "open" });
    expect(names()).toEqual([]);
  });
});

describe("RequisitionActions — calling the server", () => {
  it("Submit calls the action, shows the server's notice with a link to the approval, and re-reads the page", async () => {
    const api = setup();
    fireEvent.click(screen.getByRole("button", { name: "Submit for approval" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Submitted for approval."));
    expect(api.submit).toHaveBeenCalledWith("co-a", "rq-1");
    expect(screen.getByRole("link", { name: "Open the approval" })).toHaveAttribute("href", "/approvals/ap-9");
    expect(refresh).toHaveBeenCalled();
  });

  it("shows a refusal in the server's words, does not claim success, and still re-reads", async () => {
    const api = setup();
    vi.mocked(api.submit).mockResolvedValue({ ok: false, error: "requisition is 'open', not draft" });
    fireEvent.click(screen.getByRole("button", { name: "Submit for approval" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("requisition is 'open', not draft"));
    expect(screen.queryByRole("status")).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });

  it("a status move that needs confirming asks first, and does nothing until confirmed", async () => {
    const api = setup({ status: "open" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(api.setStatus).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "Close REQ-1" })).toHaveTextContent("Close this requisition?");
    fireEvent.click(screen.getByRole("button", { name: "Yes, close" }));
    await waitFor(() => expect(api.setStatus).toHaveBeenCalledWith("co-a", "rq-1", "closed"));
    expect(await screen.findByRole("status")).toHaveTextContent("Requisition set to closed.");
  });

  it("Put on hold needs no confirmation", async () => {
    const api = setup({ status: "open" });
    fireEvent.click(screen.getByRole("button", { name: "Put on hold" }));
    await waitFor(() => expect(api.setStatus).toHaveBeenCalledWith("co-a", "rq-1", "on_hold"));
  });

  it("Edit opens the form prefilled and sends the changes to the update action", async () => {
    const api = setup({ status: "open" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Title")).toHaveValue("Designer");
    expect(screen.getByLabelText(/^Salary maximum/)).toHaveValue(12000000);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Senior Designer" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.update).toHaveBeenCalledTimes(1));
    const [tenant, id, fd] = vi.mocked(api.update).mock.calls[0];
    expect([tenant, id]).toEqual(["co-a", "rq-1"]);
    expect(fd.get("title")).toBe("Senior Designer");
    expect(await screen.findByRole("status")).toHaveTextContent("Requisition updated.");
  });

  it("an edit refused by the server stays open and shows the server's words", async () => {
    const api = setup({ status: "open" });
    vi.mocked(api.update).mockResolvedValue({ ok: false, error: "You don't have permission to edit this requisition." });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You don't have permission to edit this requisition.");
    expect(screen.getByLabelText("Title")).toBeInTheDocument();
  });
});

describe("RequisitionForm", () => {
  it("opens, sends the fields with the company, and shows the server's refusal as sent", async () => {
    const create = vi.fn(async (_f: FormData) => ({ ok: false, error: "that requisition reference is already in use" }));
    render(<RequisitionForm create={create} companyId="co-a" defaultCurrency="IDR" people={[{ userId: "u-hm", name: "Made" }]} />);
    fireEvent.click(screen.getByRole("button", { name: "New requisition" }));
    fireEvent.change(screen.getByLabelText(/^Reference/), { target: { value: "REQ-9" } });
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: "Cook" } });
    fireEvent.change(screen.getByLabelText(/^Hiring manager/), { target: { value: "u-hm" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft requisition" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(Object.fromEntries(create.mock.calls[0][0].entries())).toMatchObject({
      companyId: "co-a", reference: "REQ-9", title: "Cook", currency: "IDR", hiringManagerUserId: "u-hm",
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("that requisition reference is already in use");
    expect(refresh).toHaveBeenCalled();
  });

  it("without any people (the employee read failed) it leaves the manager pickers out rather than offering an empty list", () => {
    render(<RequisitionForm create={vi.fn()} companyId="co-a" defaultCurrency="IDR" people={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "New requisition" }));
    expect(screen.queryByLabelText(/^Hiring manager/)).toBeNull();
  });

  it("closes and says what the server said after a success", async () => {
    const create = vi.fn(async (_f: FormData) => ({ ok: true, notice: "Requisition REQ-9 created as a draft." }));
    render(<RequisitionForm create={create} companyId="co-a" defaultCurrency="IDR" people={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "New requisition" }));
    fireEvent.change(screen.getByLabelText(/^Reference/), { target: { value: "REQ-9" } });
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: "Cook" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft requisition" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Requisition REQ-9 created as a draft.");
    expect(screen.queryByLabelText(/^Reference/)).toBeNull();
  });
});

describe("CandidateForm", () => {
  it("sends the candidate and shows the server's duplicate-email sentence as sent", async () => {
    const create = vi.fn(async (_f: FormData) => ({ ok: false, error: "a candidate with this email already exists in the pool" }));
    render(<CandidateForm create={create} companyId="co-a" />);
    fireEvent.click(screen.getByRole("button", { name: "Add candidate" }));
    fireEvent.change(screen.getByLabelText(/^Full name/), { target: { value: "Ayu" } });
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: "ayu@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to talent pool" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(Object.fromEntries(create.mock.calls[0][0].entries())).toMatchObject({ companyId: "co-a", fullName: "Ayu", email: "ayu@example.com", source: "direct" });
    expect(await screen.findByRole("alert")).toHaveTextContent("a candidate with this email already exists in the pool");
  });
});

describe("CandidateErasureButton", () => {
  it("asks for confirmation naming the person, and calls nothing until confirmed", async () => {
    const erase = vi.fn(async (_t: string, _c: string) => ({ ok: true, notice: "Erasure requested." }));
    render(<CandidateErasureButton tenantId="co-a" candidateId="cd-1" name="Ayu" erase={erase} />);
    fireEvent.click(screen.getByRole("button", { name: "Request erasure of Ayu" }));
    expect(erase).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "Confirm erasure of Ayu" })).toHaveTextContent("Request erasure of Ayu's personal data?");
    fireEvent.click(screen.getByRole("button", { name: "Yes, request erasure" }));
    await waitFor(() => expect(erase).toHaveBeenCalledWith("co-a", "cd-1"));
    expect(await screen.findByRole("status")).toHaveTextContent("Erasure requested.");
    expect(refresh).toHaveBeenCalled();
  });

  it("Cancel backs out without calling the server; a refusal is shown as sent", async () => {
    const erase = vi.fn(async (_t: string, _c: string) => ({ ok: false, error: "You don't have permission to request erasure of candidate data." }));
    render(<CandidateErasureButton tenantId="co-a" candidateId="cd-1" name="Ayu" erase={erase} />);
    fireEvent.click(screen.getByRole("button", { name: "Request erasure of Ayu" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(erase).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Request erasure of Ayu" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, request erasure" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You don't have permission to request erasure of candidate data.");
  });
});
