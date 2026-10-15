import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Account } from "@/lib/finance";

// DW-7g-2 — the chart of accounts with its write controls. The server is the boundary (Cerbos `finance_config`, the freeze
// trigger, the archive guards); what is pinned here is that the controls follow the capability, archived accounts hide behind
// their switch and are marked when shown, the code field locks once an account has postings, every refusal is shown in the
// server's words with its reason (and `usedBy` for an account still in use), and the form sends what the person entered.
const fa = vi.hoisted(() => ({ addAccount: vi.fn(), editAccount: vi.fn(), archiveAccount: vi.fn(), restoreAccount: vi.fn() }));
vi.mock("@/lib/financeAccountActions", () => fa);

import { ChartOfAccounts } from "./ChartOfAccounts";

const acct = (over: Partial<Account> & Pick<Account, "code" | "name">): Account => ({
  accountType: "asset", normalBalance: "debit", isPostable: true, isControl: false, controlSubledger: null, allowManualPosting: true,
  status: "active", hasPostings: false, description: null, parentCode: null, currencyCode: null, ...over,
});
const ACCOUNTS: Account[] = [
  acct({ code: "1000", name: "ASET", isPostable: false }),
  acct({ code: "1120", name: "Bank", hasPostings: true, parentCode: "1000" }),
  acct({ code: "1130", name: "Piutang Usaha", isControl: true, controlSubledger: "ar", allowManualPosting: false }),
  acct({ code: "2110", name: "Utang Usaha", accountType: "liability", normalBalance: "credit", isControl: true, controlSubledger: "ap", allowManualPosting: false }),
  acct({ code: "4900", name: "Other revenue", accountType: "revenue", normalBalance: "credit", isPostable: false }),
  acct({ code: "4910", name: "Interest income", accountType: "revenue", normalBalance: "credit", parentCode: "4900", description: "bank interest" }),
  acct({ code: "6950", name: "Old expense", accountType: "expense", status: "archived" }),
];
const view = (over: Partial<Parameters<typeof ChartOfAccounts>[0]> = {}) =>
  render(<ChartOfAccounts accounts={ACCOUNTS} canEdit {...over} />);

beforeEach(() => {
  fa.addAccount.mockReset().mockResolvedValue({ ok: true, result: { code: "X" } });
  fa.editAccount.mockReset().mockResolvedValue({ ok: true, result: { code: "X" } });
  fa.archiveAccount.mockReset().mockResolvedValue({ ok: true, result: { code: "X", status: "archived" } });
  fa.restoreAccount.mockReset().mockResolvedValue({ ok: true, result: { code: "X", status: "active" } });
});
afterEach(cleanup);

describe("the read-only view", () => {
  it("lists the accounts grouped in statement order, with the manual-posting and control columns", () => {
    view({ canEdit: false });
    expect(screen.getByText("Assets")).toBeInTheDocument();
    expect(screen.getByText("Liabilities")).toBeInTheDocument();
    expect(screen.getByText("Revenue")).toBeInTheDocument();
    expect(screen.getByText("Piutang Usaha")).toBeInTheDocument();
    expect(screen.getAllByText("subledger only")).toHaveLength(2);
    expect(screen.getByText("ar")).toBeInTheDocument();
  });

  it("without the capability there is no New account, Rename, Archive or Restore, and the list is still there", () => {
    view({ canEdit: false });
    expect(screen.queryByRole("heading", { name: /New account/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Rename/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Archive/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Restore/ })).toBeNull();
    expect(screen.getByText("Bank")).toBeInTheDocument();
  });

  it("an empty chart is said as empty only for a read that returned nothing, and a filter says what it filtered", () => {
    view({ accounts: [] });
    expect(screen.getByText(/no chart of accounts yet/)).toBeInTheDocument();
    cleanup();
    view({ accounts: [], query: "zzz" });
    expect(screen.getByText(/No account matches "zzz"/)).toBeInTheDocument();
  });
});

describe("with the capability", () => {
  it("offers Rename and Archive on an active row, and Restore (not Archive) on an archived one", () => {
    view();
    fireEvent.click(screen.getByRole("switch", { name: "Show archived" }));
    expect(screen.getByRole("button", { name: "Rename 1120" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive 1120" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore 1120" })).toBeNull();
    expect(screen.getByRole("button", { name: "Restore 6950" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive 6950" })).toBeNull();
    expect(screen.getByRole("heading", { name: /New account/ })).toBeInTheDocument();
  });
});

describe("archived accounts", () => {
  it("are hidden by default, with a count; the switch lists them, marked", () => {
    view();
    expect(screen.queryByText("Old expense")).toBeNull();
    expect(screen.getByText(/1 archived account is hidden/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Show archived" }));
    expect(screen.getByText("Old expense")).toBeInTheDocument();
    expect(screen.getByText("(archived)")).toBeInTheDocument();
    expect(screen.queryByText(/is hidden/)).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Show archived" }));
    expect(screen.queryByText("Old expense")).toBeNull();
  });

  it("says so when every account in the view is archived", () => {
    view({ accounts: [acct({ code: "6950", name: "Old expense", status: "archived" })] });
    expect(screen.getByText(/Every account in this view is archived/)).toBeInTheDocument();
  });
});

describe("archiving and restoring", () => {
  it("Archive asks the server for that code and says what happened; Restore likewise", async () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: "Archive 4910" }));
    const status = await screen.findByRole("status");
    expect(fa.archiveAccount).toHaveBeenCalledWith("4910");
    expect(status).toHaveTextContent("Archived 4910 (Interest income). It refuses new postings; its history stays.");
    fireEvent.click(screen.getByRole("switch", { name: "Show archived" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore 6950" }));
    await waitFor(() => expect(fa.restoreAccount).toHaveBeenCalledWith("6950"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Restored 6950 (Old expense). It accepts postings again."));
  });

  it("★ shows a refusal in the server's words with its reason, and does not claim success", async () => {
    fa.archiveAccount.mockResolvedValue({ ok: false, error: "1120 (Bank) still holds a balance (net 250000000 debit); archiving it would hide the money from every statement.", reason: "account_has_balance" });
    view();
    fireEvent.click(screen.getByRole("button", { name: "Archive 1120" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("1120 (Bank) still holds a balance (net 250000000 debit)");
    expect(alert).toHaveTextContent("Reason: account_has_balance");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("★ account_in_use lists which tables still use the account, in words", async () => {
    fa.archiveAccount.mockResolvedValue({
      ok: false, error: "R100 (Rule target) is still used for new postings.", reason: "account_in_use",
      usedBy: [{ table: "finance_posting_rules", count: 2 }, { table: "finance_tax_codes", count: 1 }],
    });
    view();
    fireEvent.click(screen.getByRole("button", { name: "Archive 4910" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Still used by: posting rules (2), tax codes (1).");
    expect(alert).toHaveTextContent("Reason: account_in_use");
  });

  it("a restore under an archived parent shows parent_archived; a 403 shows the permission sentence", async () => {
    fa.restoreAccount.mockResolvedValue({ ok: false, error: "PC (Child) sits under PH (Parent header), which is archived; restore the parent first", reason: "parent_archived" });
    view();
    fireEvent.click(screen.getByRole("switch", { name: "Show archived" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore 6950" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Reason: parent_archived");
    fa.archiveAccount.mockResolvedValue({ ok: false, error: "You don't have permission to archive accounts." });
    // the buttons are disabled while an action is in flight
    await waitFor(() => expect(screen.getByRole("button", { name: "Archive 4910" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Archive 4910" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("You don't have permission to archive accounts."));
  });
});

describe("renaming", () => {
  const open = (code: string) => fireEvent.click(screen.getByRole("button", { name: `Rename ${code}` }));
  // The New account form is on the page too and shares the Name and Code labels, so the Rename card is queried on its own.
  const card = (code: string) => within(screen.getByRole("heading", { name: new RegExp(`^Rename ${code} `) }).closest("section") as HTMLElement);

  it("prefills the name, the code and the description, and sends only what changed", async () => {
    view();
    open("4910");
    const c = card("4910");
    expect(c.getByLabelText("Name")).toHaveValue("Interest income");
    expect(c.getByLabelText("Code")).toHaveValue("4910");
    expect(c.getByLabelText("Description")).toHaveValue("bank interest");
    fireEvent.change(c.getByLabelText("Name"), { target: { value: "Interest earned" } });
    fireEvent.change(c.getByLabelText("Code"), { target: { value: "4915" } });
    fireEvent.click(c.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fa.editAccount).toHaveBeenCalledWith("4910", { name: "Interest earned", newCode: "4915" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved");
    // the form closes: the page re-reads the chart, this component carries nothing over
    expect(screen.queryByRole("heading", { name: /^Rename 4910 / })).toBeNull();
  });

  it("clearing the description sends an empty one (the action turns it into null)", async () => {
    view();
    open("4910");
    fireEvent.change(card("4910").getByLabelText("Description"), { target: { value: "" } });
    fireEvent.click(card("4910").getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fa.editAccount).toHaveBeenCalledWith("4910", { description: "" }));
  });

  it("★ the code is locked once the account has postings, with the reason; name and description still edit", async () => {
    view();
    open("1120");
    const c = card("1120");
    const code = c.getByLabelText("Code");
    expect(code).toBeDisabled();
    expect(code).toHaveAccessibleDescription(/this account has postings/);
    expect(c.getByText(/Archive it and create a new one instead/)).toBeInTheDocument();
    fireEvent.change(c.getByLabelText("Name"), { target: { value: "Bank BCA" } });
    fireEvent.click(c.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fa.editAccount).toHaveBeenCalledWith("1120", { name: "Bank BCA" }));
  });

  it("an unposted account's code is editable", () => {
    view();
    open("4910");
    expect(card("4910").getByLabelText("Code")).toBeEnabled();
    expect(card("4910").getByText(/Free to change until the first posting/)).toBeInTheDocument();
  });

  it("shows the server's refusal (a taken code, a frozen code) and keeps the form open", async () => {
    fa.editAccount.mockResolvedValue({ ok: false, error: "account code 4900 is already used by a live account in this company", reason: "code_taken" });
    view();
    open("4910");
    fireEvent.change(card("4910").getByLabelText("Code"), { target: { value: "4900" } });
    fireEvent.click(card("4910").getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("account code 4900 is already used");
    expect(alert).toHaveTextContent("Reason: code_taken");
    expect(card("4910").getByLabelText("Code")).toHaveValue("4900");
    fa.editAccount.mockResolvedValue({ ok: false, error: "account 4910 has postings; code cannot change. Archive this account and create a new one.", reason: "account_frozen" });
    fireEvent.click(card("4910").getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Reason: account_frozen"));
  });

  it("Cancel closes the form without a request", () => {
    view();
    open("4910");
    fireEvent.click(card("4910").getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("heading", { name: /^Rename 4910 / })).toBeNull();
    expect(fa.editAccount).not.toHaveBeenCalled();
  });
});

describe("the New account form", () => {
  const form = () => within(screen.getByRole("heading", { name: /New account/ }).closest("section") as HTMLElement);

  it("defaults the normal balance by type and lets a contra account override it", () => {
    view();
    const f = form();
    expect(f.getByLabelText("Normal balance")).toHaveValue("debit");
    fireEvent.change(f.getByLabelText("Type"), { target: { value: "revenue" } });
    expect(f.getByLabelText("Normal balance")).toHaveValue("credit");
    fireEvent.change(f.getByLabelText("Normal balance"), { target: { value: "debit" } });
    fireEvent.change(f.getByLabelText("Type"), { target: { value: "liability" } });
    // once overridden, the type no longer drives it
    expect(f.getByLabelText("Normal balance")).toHaveValue("debit");
  });

  it("offers only active headers of the chosen type as parents", () => {
    view();
    const f = form();
    const options = () => within(f.getByLabelText(/Parent/)).getAllByRole("option").map((o) => o.textContent);
    expect(options()).toEqual(["No parent (top level)", "1000 · ASET"]);
    fireEvent.change(f.getByLabelText("Type"), { target: { value: "revenue" } });
    expect(options()).toEqual(["No parent (top level)", "4900 · Other revenue"]);
    fireEvent.change(f.getByLabelText("Type"), { target: { value: "expense" } });
    expect(options()).toEqual(["No parent (top level)"]);
  });

  it("is armed only with a valid code and a name, sends what was entered, and clears after success", async () => {
    view();
    const f = form();
    const go = f.getByRole("button", { name: "Add account" });
    expect(go).toBeDisabled();
    fireEvent.change(f.getByLabelText("Code"), { target: { value: "bad code" } });
    fireEvent.change(f.getByLabelText("Name"), { target: { value: "Sales returns" } });
    expect(go).toBeDisabled();
    fireEvent.change(f.getByLabelText("Code"), { target: { value: "4930" } });
    expect(go).toBeEnabled();
    fireEvent.change(f.getByLabelText("Type"), { target: { value: "revenue" } });
    fireEvent.change(f.getByLabelText("Normal balance"), { target: { value: "debit" } });
    fireEvent.change(f.getByLabelText(/Parent/), { target: { value: "4900" } });
    fireEvent.change(f.getByLabelText(/Currency/), { target: { value: "idr" } });
    fireEvent.click(f.getByRole("checkbox", { name: /Postable/ }));
    fireEvent.change(f.getByLabelText(/Description/), { target: { value: "contra revenue" } });
    fa.addAccount.mockResolvedValue({ ok: true, result: { code: "4930" } });
    fireEvent.click(go);
    await waitFor(() => expect(fa.addAccount).toHaveBeenCalledWith({
      code: "4930", name: "Sales returns", accountType: "revenue", normalBalance: "debit", parentCode: "4900",
      isPostable: false, currencyCode: "IDR", description: "contra revenue",
    }));
    expect(await screen.findByRole("status")).toHaveTextContent("Added account 4930.");
    expect(f.getByLabelText("Code")).toHaveValue("");
  });

  it("shows the server's refusal (a duplicate code, a parent of another type) and keeps what was typed", async () => {
    fa.addAccount.mockResolvedValue({ ok: false, error: "account code 4910 is already used by a live account in this company", reason: "code_taken" });
    view();
    const f = form();
    fireEvent.change(f.getByLabelText("Code"), { target: { value: "4910" } });
    fireEvent.change(f.getByLabelText("Name"), { target: { value: "Again" } });
    fireEvent.click(f.getByRole("button", { name: "Add account" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("account code 4910 is already used");
    expect(alert).toHaveTextContent("Reason: code_taken");
    expect(f.getByLabelText("Code")).toHaveValue("4910");
  });
});
