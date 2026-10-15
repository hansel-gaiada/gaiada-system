import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

import { OfferActions, type OfferActionsApi } from "./OfferActions";
import { OfferForm } from "./OfferForm";
import { ScorecardForm } from "./ScorecardForm";

// DW-7f-2 — scorecards, offers and the convert step: which buttons per status and capability, the convert
// confirmation naming what it creates, and that a refusal is shown in the server's own words.

function makeApi(): OfferActionsApi {
  return {
    setStatus: vi.fn(async () => ({ ok: true, status: "sent", notice: "Offer marked sent." })),
    convert: vi.fn(async () => ({ ok: true, employeeId: "emp-1", status: "pending_start", notice: "Employee record created, starting 2026-12-01, with the status pending start." })),
  };
}
function setup(over: Partial<React.ComponentProps<typeof OfferActions>> = {}) {
  const api = makeApi();
  render(
    <OfferActions tenantId="co-a" applicationId="ap-1" offerId="of-1" status="draft" startOn="2026-12-01T00:00:00.000Z"
      candidateName="Budi Santoso" canManage canConvert api={api} {...over} />,
  );
  return api;
}
const names = () => screen.queryAllByRole("button").map((b) => b.textContent);

beforeEach(() => refresh.mockReset());
afterEach(() => cleanup());

describe("OfferActions — buttons per status", () => {
  it.each([
    ["draft", ["Mark as sent", "Withdraw offer"]],
    ["sent", ["Candidate accepted", "Candidate declined", "Mark expired", "Withdraw offer"]],
    ["accepted", ["Withdraw offer", "Convert to employee"]],
    ["declined", []], ["expired", []], ["withdrawn", []], ["converted", []], ["pending_approval", []],
  ])("%s offers %j to someone who can manage and convert", (status, expected) => {
    setup({ status });
    expect(names()).toEqual(expected);
  });
});

describe("OfferActions — buttons per capability", () => {
  it("a manager who cannot convert never sees Convert", () => {
    setup({ status: "accepted", canConvert: false });
    expect(names()).toEqual(["Withdraw offer"]);
  });

  it("an approver who cannot manage sees Convert only", () => {
    setup({ status: "accepted", canManage: false });
    expect(names()).toEqual(["Convert to employee"]);
  });

  it("a reader sees no buttons, and an accepted offer cannot be converted until accepted", () => {
    setup({ status: "accepted", canManage: false, canConvert: false });
    expect(names()).toEqual([]);
    cleanup();
    setup({ status: "sent", canManage: false });
    expect(names()).toEqual([]);
  });

  it("a converted offer points at People", () => {
    setup({ status: "converted" });
    expect(screen.getByRole("link", { name: "Open People" })).toHaveAttribute("href", "/hr/people");
  });
});

describe("OfferActions — status moves", () => {
  it("Mark as sent calls the action straight away, shows the server's notice and re-reads the page", async () => {
    const api = setup();
    fireEvent.click(screen.getByRole("button", { name: "Mark as sent" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Offer marked sent."));
    expect(api.setStatus).toHaveBeenCalledWith("co-a", "ap-1", "of-1", "sent");
    expect(refresh).toHaveBeenCalled();
  });

  it("Withdraw asks first and does nothing until confirmed", async () => {
    const api = setup();
    fireEvent.click(screen.getByRole("button", { name: "Withdraw offer" }));
    expect(api.setStatus).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "Withdraw offer" })).toHaveTextContent("Withdraw this offer?");
    fireEvent.click(screen.getByRole("button", { name: "Yes, withdraw offer" }));
    await waitFor(() => expect(api.setStatus).toHaveBeenCalledWith("co-a", "ap-1", "of-1", "withdrawn", ""));
  });

  it("Candidate declined asks for the reason they gave and sends it", async () => {
    const api = setup({ status: "sent" });
    fireEvent.click(screen.getByRole("button", { name: "Candidate declined" }));
    fireEvent.change(screen.getByLabelText("Reason they gave (optional)"), { target: { value: "Took another job" } });
    fireEvent.click(screen.getByRole("button", { name: "Yes, candidate declined" }));
    await waitFor(() => expect(api.setStatus).toHaveBeenCalledWith("co-a", "ap-1", "of-1", "declined", "Took another job"));
  });

  it("a refusal is shown as the server worded it, does not claim success, and still re-reads", async () => {
    const api = setup();
    vi.mocked(api.setStatus).mockResolvedValue({ ok: false, error: "You don't have permission to change this offer's status." });
    fireEvent.click(screen.getByRole("button", { name: "Mark as sent" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("You don't have permission to change this offer's status."));
    expect(screen.queryByRole("status")).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });
});

describe("OfferActions — convert", () => {
  it("asks first, in words that name the employee record it creates, and calls nothing until confirmed", () => {
    const api = setup({ status: "accepted" });
    fireEvent.click(screen.getByRole("button", { name: "Convert to employee" }));
    expect(api.convert).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "Convert the offer to Budi Santoso" }))
      .toHaveTextContent("This creates an employee record for Budi Santoso.");
    expect(screen.getByText(/high-assurance sign-in/)).toBeInTheDocument();
  });

  it("sends the hire date (defaulting to the offer's start) and work email, then shows the server's account", async () => {
    const api = setup({ status: "accepted" });
    fireEvent.click(screen.getByRole("button", { name: "Convert to employee" }));
    expect(screen.getByLabelText(/^Hire date/)).toHaveValue("2026-12-01");
    fireEvent.change(screen.getByLabelText(/^Work email/), { target: { value: "budi@gaiada.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Create employee record" }));
    await waitFor(() => expect(api.convert).toHaveBeenCalledTimes(1));
    const [tenant, app, offer, fd] = vi.mocked(api.convert).mock.calls[0];
    expect([tenant, app, offer]).toEqual(["co-a", "ap-1", "of-1"]);
    expect(Object.fromEntries(fd.entries())).toEqual({ hireDate: "2026-12-01", workEmail: "budi@gaiada.com" });
    expect(await screen.findByRole("status")).toHaveTextContent("Employee record created, starting 2026-12-01");
    expect(refresh).toHaveBeenCalled();
  });

  it("an offer with no start date needs a hire date before the button works", () => {
    setup({ status: "accepted", startOn: null });
    fireEvent.click(screen.getByRole("button", { name: "Convert to employee" }));
    expect(screen.getByText(/required: the offer has no start date/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create employee record" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/^Hire date/), { target: { value: "2026-12-15" } });
    expect(screen.getByRole("button", { name: "Create employee record" })).toBeEnabled();
  });

  it("shows the server's refusal in its own words, with the form still open", async () => {
    const api = setup({ status: "accepted" });
    vi.mocked(api.convert).mockResolvedValue({
      ok: false, error: "You don't have permission to convert offers into employees. Converting an offer also needs a high-assurance sign-in.",
    });
    fireEvent.click(screen.getByRole("button", { name: "Convert to employee" }));
    fireEvent.click(screen.getByRole("button", { name: "Create employee record" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("high-assurance sign-in");
    expect(screen.queryByRole("status")).toBeNull();
    expect(await screen.findByRole("button", { name: "Create employee record" })).toBeInTheDocument();
  });

  it("Cancel backs out without calling the server", () => {
    const api = setup({ status: "accepted" });
    fireEvent.click(screen.getByRole("button", { name: "Convert to employee" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.convert).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: /Convert the offer/ })).toBeNull();
  });
});

describe("OfferForm", () => {
  it("sends the amount, currency and dates, and shows the server's band-ceiling refusal as sent", async () => {
    const ceiling = "offer of 11000000 exceeds the requisition's approved maximum of 10000000 — raise the requisition band first";
    const create = vi.fn(async (_t: string, _a: string, _f: FormData) => ({ ok: false, error: ceiling }));
    render(<OfferForm create={create} tenantId="co-a" applicationId="ap-1" defaultCurrency="IDR" />);
    fireEvent.click(screen.getByRole("button", { name: "Make offer" }));
    fireEvent.change(screen.getByLabelText(/^Base amount/), { target: { value: "11000000" } });
    fireEvent.change(screen.getByLabelText(/^Start date/), { target: { value: "2026-12-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Draft offer" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const [tenant, app, fd] = create.mock.calls[0];
    expect([tenant, app]).toEqual(["co-a", "ap-1"]);
    expect(Object.fromEntries(fd.entries())).toMatchObject({ baseAmount: "11000000", currency: "IDR", rateBasis: "monthly", startOn: "2026-12-01" });
    expect(await screen.findByRole("alert")).toHaveTextContent(ceiling);
    expect(refresh).toHaveBeenCalled();
  });

  it("closes and repeats the server's notice after a success", async () => {
    const create = vi.fn(async (_t: string, _a: string, _f: FormData) => ({ ok: true, notice: "Offer drafted. Mark it as sent when it goes to the candidate." }));
    render(<OfferForm create={create} tenantId="co-a" applicationId="ap-1" defaultCurrency="IDR" />);
    fireEvent.click(screen.getByRole("button", { name: "Make offer" }));
    fireEvent.change(screen.getByLabelText(/^Base amount/), { target: { value: "9000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Draft offer" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Offer drafted.");
    expect(screen.queryByLabelText(/^Base amount/)).toBeNull();
  });
});

describe("ScorecardForm", () => {
  const interviews = [{ id: "iv-1", label: "technical, 20 Oct 2026, 09:00" }];

  it("sends the interview, score, recommendation and notes, and shows the server's notice", async () => {
    const file = vi.fn(async (_t: string, _a: string, _f: FormData) => ({ ok: true, notice: "Scorecard filed. The application's rating is now 4.50." }));
    render(<ScorecardForm file={file} tenantId="co-a" applicationId="ap-1" interviews={interviews} />);
    fireEvent.click(screen.getByRole("button", { name: "Add scorecard" }));
    fireEvent.change(screen.getByLabelText(/^Interview/), { target: { value: "iv-1" } });
    fireEvent.change(screen.getByLabelText(/^Overall/), { target: { value: "4.5" } });
    fireEvent.change(screen.getByLabelText(/^Recommendation/), { target: { value: "yes" } });
    fireEvent.change(screen.getByLabelText(/^Notes/), { target: { value: "Sharp." } });
    fireEvent.click(screen.getByRole("button", { name: "File scorecard" }));
    await waitFor(() => expect(file).toHaveBeenCalledTimes(1));
    const [tenant, app, fd] = file.mock.calls[0];
    expect([tenant, app]).toEqual(["co-a", "ap-1"]);
    expect(Object.fromEntries(fd.entries())).toEqual({ interviewId: "iv-1", overall: "4.5", recommendation: "yes", notes: "Sharp." });
    expect(await screen.findByRole("status")).toHaveTextContent("rating is now 4.50");
  });

  it("shows a refusal as sent and keeps the form open", async () => {
    const file = vi.fn(async (_t: string, _a: string, _f: FormData) => ({ ok: false, error: "You don't have permission to file scorecards on this application." }));
    render(<ScorecardForm file={file} tenantId="co-a" applicationId="ap-1" interviews={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add scorecard" }));
    fireEvent.change(screen.getByLabelText(/^Notes/), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "File scorecard" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You don't have permission to file scorecards on this application.");
    expect(screen.getByLabelText(/^Notes/)).toBeInTheDocument();
  });
});
