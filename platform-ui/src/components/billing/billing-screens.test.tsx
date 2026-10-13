import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a>,
}));

import { IssueBlockers } from "./IssueBlockers";
import { MaskedAccount } from "./MaskedAccount";

// PV5-09 — the small shared pieces: the blocker list and the masked account number.

describe("IssueBlockers", () => {
  const blockers = [
    { code: "NO_BANK_DETAILS", message: "the billing profile has no bank account" },
    { code: "PKP_NOT_CONFIRMED", message: "a taxed invoice needs the PKP status confirmed" },
    { code: "SOMETHING_NEW", message: "a reason this UI has never heard of" },
  ];

  it("🔴 lists EVERY reason at once, each with the place that clears it, and no link for a code it does not know", () => {
    render(<IssueBlockers blockers={blockers} lead="Clear these first:" />);
    expect(screen.getByText("Clear these first:")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByRole("link", { name: "Open the billing profile" })).toHaveAttribute("href", "/finance/settings/billing-profile");
    expect(screen.getByRole("link", { name: "Open accounting settings" })).toHaveAttribute("href", "/finance/settings");
    // The third reason is shown in words and has no guessed link.
    expect(screen.getByText(/a reason this UI has never heard of/)).toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it("renders nothing for an empty list (nothing is missing, so nothing is claimed)", () => {
    const { container } = render(<IssueBlockers blockers={[]} lead="x" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("the answer to a click is announced at once (role alert); the list sitting on the page is not", () => {
    const { unmount } = render(<IssueBlockers blockers={blockers} lead="x" role="alert" />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    unmount();
    render(<IssueBlockers blockers={blockers} lead="x" />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("MaskedAccount", () => {
  it("🔴 is masked by default, and shows the full number only after Show; Hide masks it again", () => {
    render(<MaskedAccount value="1234567890" />);
    expect(screen.getByText("•••• 7890")).toBeInTheDocument();
    expect(screen.queryByText("1234567890")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Show account number" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(screen.getByText("1234567890")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide account number" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Hide account number" }));
    expect(screen.getByText("•••• 7890")).toBeInTheDocument();
  });

  it("says a dash, with no button, when there is no number", () => {
    render(<MaskedAccount value={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
