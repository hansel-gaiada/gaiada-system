import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Freelancer, FlRate } from "@/lib/freelancers";
import type { ReadResult } from "@/lib/readResult";

// DW-10f-4b — Finance > Payables > Freelancers > Rates. The server is the boundary (Cerbos `vendor_master`, overlap, payroll, the vendor
// wall); what is tested here is what the screen offers, that every refusal reads as a sentence, that a refused or failed read is never an empty
// list, and that the rate goes to the action as the text typed.
const fa = vi.hoisted(() => ({ addRateAction: vi.fn(), endRateAction: vi.fn(), withdrawRateAction: vi.fn(), linkVendorAction: vi.fn() }));
vi.mock("@/lib/freelancersActions", () => fa);
const su = vi.hoisted(() => ({ getStepUpStatusAction: vi.fn(), simulateSecondFactorAction: vi.fn() }));
vi.mock("@/lib/stepUpActions", () => su);
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { FreelancerRates } from "./FreelancerRates";

const rate = (over: Partial<FlRate>): FlRate => ({
  id: "r1", userId: "u-dev", hourlyRate: 150000, currency: "IDR", expenseAccountCode: "6100",
  validFrom: "2026-04-01", validTo: null, note: null, used: false, ...over,
});
const made: Freelancer = {
  user: { id: "u-dev", name: "Made Putra", email: "made@gaiada.com" },
  vendor: { id: "vend-1", code: "V-001", name: "PT Kreatif", withholdingCode: "PPH23" },
  currentRate: rate({}),
  rates: [rate({}), rate({ id: "r0", hourlyRate: 125000, validFrom: "2025-09-01", validTo: "2026-03-31", used: true })],
  onPayroll: false,
};
const putu: Freelancer = {
  user: { id: "u-creative", name: "Putu Rani", email: "creative@gaiada.com" }, vendor: null,
  currentRate: rate({ id: "r9", userId: "u-creative", hourlyRate: 100000, validFrom: "2026-01-01" }),
  rates: [rate({ id: "r9", userId: "u-creative", hourlyRate: 100000, validFrom: "2026-01-01" })], onPayroll: false,
};
const gede: Freelancer = {
  user: { id: "gede-ic", name: "Gede Kusuma", email: "gede@gaiada.com" },
  vendor: { id: "vend-2", code: "V-002", name: "CV Sinar", withholdingCode: null },
  currentRate: null, rates: [], onPayroll: true,
};
const ok = (data: Freelancer[]): ReadResult<Freelancer[]> => ({ kind: "ok", data });
const people = [{ id: "u-dev", name: "Made Putra", email: "made@gaiada.com" }, { id: "u-social", name: "Komang Lestari", email: "social@gaiada.com" }];
const accounts = [{ code: "6100", name: "Beban Gaji" }, { code: "6200", name: "Beban Sewa" }];
const vendors = [{ id: "vend-1", code: "V-001", name: "PT Kreatif", userId: "u-dev" }, { id: "vend-3", code: "V-003", name: "Studio Lepas", userId: null }];
const mount = (freelancers: ReadResult<Freelancer[]>) =>
  render(<FreelancerRates freelancers={freelancers} people={people} accounts={accounts} vendors={vendors} />);

beforeEach(() => {
  Object.values(fa).forEach((f) => f.mockReset().mockResolvedValue({ ok: true, result: {} }));
  Object.values(su).forEach((f) => f.mockReset().mockResolvedValue(null));
});

describe("the list", () => {
  it("shows each person with their vendor, the withholding code or its absence, and every rate with its range", () => {
    mount(ok([made, putu, gede]));
    const m = within(screen.getByRole("region", { name: "Rates for Made Putra" }));
    expect(m.getByText(/Paid through V-001 · PT Kreatif/)).toBeInTheDocument();
    expect(m.getByText(/Withholding code PPH23/)).toBeInTheDocument();
    expect(m.getByText("from 2026-04-01, no end")).toBeInTheDocument();
    expect(m.getByText("2025-09-01 to 2026-03-31")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Rates for Gede Kusuma" })).getByText(/No withholding code on the vendor/)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Rates for Gede Kusuma" })).getByText(/No rate in force today/)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Rates for Gede Kusuma" })).getByText(/On payroll today/)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Rates for Putu Rani" })).getByText("No vendor.")).toBeInTheDocument();
  });

  it("offers End only on an open rate, and Withdraw only on a rate that priced nothing", () => {
    mount(ok([made]));
    // The open, unused rate: End and Withdraw. The ended, used rate: neither, and it says why.
    expect(screen.getAllByRole("button", { name: /^End / })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^Withdraw / })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Withdraw Made Putra, rate from 2026-04-01, no end" })).toBeInTheDocument();
    expect(screen.getByText("Used on a bill")).toBeInTheDocument();
  });

  it("a refused read says so and is never the empty note; a failed one says it cannot tell", () => {
    const { rerender } = mount({ kind: "forbidden" });
    expect(screen.getByText(/You don.t have access to the freelancer rates/)).toBeInTheDocument();
    expect(screen.queryByText(/No one has a freelancer rate/)).toBeNull();
    rerender(<FreelancerRates freelancers={{ kind: "unavailable", reason: "platform 502" }} people={people} accounts={accounts} vendors={vendors} />);
    expect(screen.getByText(/this is not a statement that there is nothing here/)).toBeInTheDocument();
    expect(screen.getByText("platform 502")).toBeInTheDocument();
  });

  it("an empty list from a real read says there are none yet", () => {
    mount(ok([]));
    expect(screen.getByText(/No one has a freelancer rate or a linked vendor yet/)).toBeInTheDocument();
  });
});

describe("End and Withdraw", () => {
  it("ends a rate on the picked date, and says so", async () => {
    mount(ok([made]));
    const end = screen.getByRole("button", { name: "End Made Putra, rate from 2026-04-01, no end" });
    expect(end).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Last day of Made Putra, rate from 2026-04-01, no end"), { target: { value: "2026-12-31" } });
    fireEvent.click(end);
    expect(await screen.findByRole("status")).toHaveTextContent("Made Putra's rate from 2026-04-01 now ends on 2026-12-31.");
    expect(fa.endRateAction).toHaveBeenCalledWith("u-dev", "r1", "2026-12-31");
  });

  it("withdraws an unused rate; a rate_used refusal is shown as the action's sentence", async () => {
    fa.withdrawRateAction.mockResolvedValue({ ok: false, error: "This rate priced hours that are already on a bill.", reason: "rate_used" });
    mount(ok([made]));
    fireEvent.click(screen.getByRole("button", { name: /^Withdraw / }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This rate priced hours that are already on a bill.");
    expect(fa.withdrawRateAction).toHaveBeenCalledWith("u-dev", "r1");
  });
});

describe("Link a vendor", () => {
  it("offers only vendors that name nobody, and links the chosen one", async () => {
    mount(ok([putu]));
    const select = screen.getByLabelText("Vendor for Putu Rani");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose a vendor", "V-003 · Studio Lepas"]);
    const link = screen.getByRole("button", { name: "Link a vendor to Putu Rani" });
    expect(link).toBeDisabled();
    fireEvent.change(select, { target: { value: "vend-3" } });
    fireEvent.click(link);
    expect(await screen.findByRole("status")).toHaveTextContent("Linked the vendor to Putu Rani.");
    expect(fa.linkVendorAction).toHaveBeenCalledWith("vend-3", "u-creative");
  });

  it("a person_has_vendor refusal reads as the sentence", async () => {
    fa.linkVendorAction.mockResolvedValue({ ok: false, error: "Another vendor already names this person.", reason: "person_has_vendor" });
    mount(ok([putu]));
    fireEvent.change(screen.getByLabelText("Vendor for Putu Rani"), { target: { value: "vend-3" } });
    fireEvent.click(screen.getByRole("button", { name: "Link a vendor to Putu Rani" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Another vendor already names this person.");
  });
});

describe("Add a rate", () => {
  const fill = () => {
    const form = within(screen.getByRole("form", { name: "Add a rate" }));
    fireEvent.change(form.getByLabelText("Person"), { target: { value: "u-social" } });
    fireEvent.change(form.getByLabelText("Hourly rate"), { target: { value: "140000" } });
    fireEvent.change(form.getByLabelText("Starts on"), { target: { value: "2026-10-01" } });
    fireEvent.change(form.getByLabelText("Expense account"), { target: { value: "6100" } });
    return form;
  };

  it("lists the company's people and expense accounts, and sends the rate as the text typed", async () => {
    fa.addRateAction.mockResolvedValue({ ok: true, result: { closedRate: { id: "r1", validTo: "2026-09-30" } } });
    mount(ok([]));
    const form = fill();
    expect(within(form.getByLabelText("Person")).getAllByRole("option").map((o) => o.textContent)).toContain("Komang Lestari (social@gaiada.com)");
    fireEvent.click(form.getByRole("button", { name: "Add rate" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Added a rate for Komang Lestari from 2026-10-01. The earlier rate now ends on 2026-09-30.");
    expect(fa.addRateAction).toHaveBeenCalledWith("u-social", { hourlyRate: "140000", validFrom: "2026-10-01", expenseAccountCode: "6100", note: "" });
  });

  it("each refusal reads as the action's sentence", async () => {
    fa.addRateAction.mockResolvedValue({ ok: false, error: "That range overlaps another rate for this person. End the other rate first, or choose other dates.", reason: "rate_overlap" });
    mount(ok([]));
    fireEvent.click(fill().getByRole("button", { name: "Add rate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That range overlaps another rate for this person.");
  });

  it("a refusal that names assurance asks for the second factor, and offers the simulation when the server does", async () => {
    su.getStepUpStatusAction.mockResolvedValue({ available: true, active: false, simulated: false, expiresAt: null, assurance: "linked", ttlSeconds: 900 });
    fa.addRateAction.mockResolvedValue({ ok: false, error: "You need a second factor before you can add a freelancer rate.", reason: "assurance_required" });
    mount(ok([]));
    fireEvent.click(fill().getByRole("button", { name: "Add rate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You need a second factor");
    expect(await screen.findByText("This action needs a second factor")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Simulate second factor/ })).toBeInTheDocument();
  });
});
