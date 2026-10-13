import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { BillingProfile } from "@/lib/billingProfile";

// PV5-09 — the billing profile screen. The bank account is a section of its own ("Clients pay into this account"), masked by
// default, saved by its own button in its own request; the profile form never carries it. The server actions are mocked: what
// is pinned is what the components send and what they show for each answer. (The step-up redirect itself is the ACTION's,
// pinned in lib/billingProfileActions.test.ts.)
const saveBank = vi.fn();
const saveProfile = vi.fn();
vi.mock("@/lib/billingProfileActions", () => ({
  saveBankDetailsAction: (...a: unknown[]) => saveBank(...a),
  saveBillingProfileAction: (...a: unknown[]) => saveProfile(...a),
}));

import { BankDetailsForm, BillingProfileForm } from "./BillingProfileForms";

const BANK = { bankName: "Example Bank", accountName: "Example Agency Ltd", accountNo: "1234567890" };
const profile = (over: Partial<BillingProfile> = {}): BillingProfile => ({
  legalName: "Example Agency Ltd", address: "1 Example Street", invoicePrefix: "EX", defaultPaymentTermsDays: 30, currencyCode: "IDR",
  bank: BANK, bankLedgerAccountCode: "1010", defaultRevenueAccountCode: "4000", signatureThreshold: null, updatedBy: null,
  updatedAt: "2026-10-01T00:00:00Z", ...over,
});

beforeEach(() => { saveBank.mockReset(); saveProfile.mockReset(); });

describe("BankDetailsForm", () => {
  it("🔴 is its own section, headed 'Clients pay into this account', with its own Save button", () => {
    render(<BankDetailsForm bank={BANK} hasProfile assuranceHigh />);
    expect(screen.getByRole("heading", { name: "Clients pay into this account" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save bank account" })).toBeEnabled();
  });

  it("🔴 shows the account number masked by default, and the typed field starts EMPTY (the number is typed again)", () => {
    render(<BankDetailsForm bank={BANK} hasProfile assuranceHigh />);
    expect(screen.getByText("•••• 7890")).toBeInTheDocument();
    expect(screen.queryByText("1234567890")).toBeNull();
    expect(screen.getByLabelText("Account number", { selector: "input" })).toHaveValue("");
    expect(screen.getByLabelText("Bank")).toHaveValue("Example Bank");
    expect(screen.getByLabelText("Account name")).toHaveValue("Example Agency Ltd");
  });

  it("🔴 saves ONLY the three bank fields (never the profile's), and shows the notice that owners were told", async () => {
    saveBank.mockResolvedValue({ ok: true, notice: "Saved. Every owner of this company has been told the bank account changed." });
    render(<BankDetailsForm bank={BANK} hasProfile assuranceHigh />);
    fireEvent.change(screen.getByLabelText("Account number", { selector: "input" }), { target: { value: "9876543210" } });
    fireEvent.submit(screen.getByRole("form", { name: "Change the bank account clients pay into" }));
    await waitFor(() => expect(saveBank).toHaveBeenCalledTimes(1));
    const fd = saveBank.mock.calls[0][1] as FormData;
    expect([...fd.keys()].filter((key) => !key.startsWith("$")).sort()).toEqual(["accountName", "accountNo", "bankName"]);
    expect(fd.get("accountNo")).toBe("9876543210");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/Every owner of this company has been told/));
    expect(saveProfile).not.toHaveBeenCalled();
  });

  it("a refusal is shown in words next to the button, as an alert", async () => {
    saveBank.mockResolvedValue({ ok: false, error: "Only an owner or a finance manager of this company, or the platform administrator, can change the bank account clients pay into." });
    render(<BankDetailsForm bank={BANK} hasProfile assuranceHigh />);
    fireEvent.change(screen.getByLabelText("Account number", { selector: "input" }), { target: { value: "1" } });
    fireEvent.submit(screen.getByRole("form", { name: "Change the bank account clients pay into" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Only an owner or a finance manager/));
  });

  it("🔴 below high assurance it says up front that saving asks for a second factor; at high assurance it does not", () => {
    const { unmount } = render(<BankDetailsForm bank={BANK} hasProfile assuranceHigh={false} />);
    expect(screen.getByRole("note")).toHaveTextContent(/verify with a second factor/i);
    unmount();
    render(<BankDetailsForm bank={BANK} hasProfile assuranceHigh />);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("with no profile yet the bank fields and button are disabled, and it says to save the profile first", () => {
    render(<BankDetailsForm bank={null} hasProfile={false} assuranceHigh />);
    expect(screen.getByRole("button", { name: "Save bank account" })).toBeDisabled();
    expect(screen.getByLabelText("Bank")).toBeDisabled();
    expect(screen.getByText(/Save the billing profile above first/)).toBeInTheDocument();
    expect(screen.getByText(/No bank account is recorded yet/)).toBeInTheDocument();
  });
});

describe("BillingProfileForm", () => {
  it("🔴 has no bank fields at all: the bank block is not part of this form", () => {
    render(<BillingProfileForm profile={profile()} />);
    const form = screen.getByRole("form", { name: "Billing profile" });
    expect(within(form).queryByLabelText(/account number/i)).toBeNull();
    expect(within(form).queryByLabelText(/^bank$/i)).toBeNull();
    expect(within(form).getByLabelText("Legal name")).toHaveValue("Example Agency Ltd");
    expect(within(form).getByLabelText("Invoice number prefix")).toHaveValue("EX");
  });

  it("saves the issuer fields and says so", async () => {
    saveProfile.mockResolvedValue({ ok: true, notice: "Saved. Invoices issued from now on use these details; invoices already issued keep theirs." });
    render(<BillingProfileForm profile={profile()} />);
    fireEvent.change(screen.getByLabelText("Legal name"), { target: { value: "Example Agency Pte" } });
    fireEvent.submit(screen.getByRole("form", { name: "Billing profile" }));
    await waitFor(() => expect(saveProfile).toHaveBeenCalledTimes(1));
    const fd = saveProfile.mock.calls[0][1] as FormData;
    expect(fd.get("legalName")).toBe("Example Agency Pte");
    expect(fd.has("accountNo")).toBe(false);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/invoices already issued keep theirs/));
  });

  it("with no profile the button says Create, not Save", () => {
    render(<BillingProfileForm profile={null} />);
    expect(screen.getByRole("button", { name: "Create billing profile" })).toBeInTheDocument();
  });
});
