import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// SCP-Sb: the client page's social accounts line. Each SIMULATED account carries the chip and the sentence is said once; "Seed simulated accounts" shows for a client
// missing one of the three networks, posts through the action, shows the server's refusal in words (403, and 409 while the simulator is off), and says when a network
// cannot publish yet. A refused or failed read is said as such, never "no accounts".
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock("@/lib/socialSimulatedAccountsActions", () => ({ seedSimulatedAccounts: vi.fn() }));

import { seedSimulatedAccounts } from "@/lib/socialSimulatedAccountsActions";
import { seedRefusalText } from "@/lib/socialSimulatedAccounts";
import type { SocialAccount } from "@/lib/socialShared";
import { ClientAccounts } from "./ClientAccounts";

const seed = vi.mocked(seedSimulatedAccounts);
const acct = (network: string, o: Partial<SocialAccount> = {}) =>
  ({ id: `a-${network}`, clientId: "c1", network, handle: "@mock-brand-alpha", status: "connected", simulated: true, ...o }) as unknown as SocialAccount;
const all = [acct("instagram"), acct("facebook"), acct("tiktok")];

beforeEach(() => { seed.mockReset(); refresh.mockReset(); });

describe("the list", () => {
  it("marks every simulated account with the SIMULATED chip and says once, in words, that they are not real", () => {
    render(<ClientAccounts engagementId="e1" read={{ kind: "ok", accounts: all }} canPlan />);
    expect(screen.getAllByText("SIMULATED")).toHaveLength(3);
    expect(screen.getAllByText(/Not a real account/)).toHaveLength(1);
    expect(screen.getByText("Instagram")).toBeInTheDocument();
    expect(screen.getByText("TikTok")).toBeInTheDocument();
  });

  it("does not mark a real account, and says nothing about simulation when there is none", () => {
    render(<ClientAccounts engagementId="e1" read={{ kind: "ok", accounts: [acct("linkedin", { simulated: false, handle: "@gaiada" })] }} canPlan />);
    expect(screen.queryByText("SIMULATED")).toBeNull();
    expect(screen.queryByText(/Not a real account/)).toBeNull();
  });

  it("says 'none' only for a confirmed empty read; a denied or failed read says so instead", () => {
    const { rerender } = render(<ClientAccounts engagementId="e1" read={{ kind: "ok", accounts: [] }} canPlan={false} />);
    expect(screen.getByText("No social accounts yet.")).toBeInTheDocument();
    rerender(<ClientAccounts engagementId="e1" read={{ kind: "forbidden" }} canPlan />);
    expect(screen.getByText(/needs a Social Media read tier/)).toBeInTheDocument();
    expect(screen.queryByText("No social accounts yet.")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull(); // nothing to seed against an unreadable list
    rerender(<ClientAccounts engagementId="e1" read={{ kind: "unavailable" }} canPlan />);
    expect(screen.getByText(/could not be read just now/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("Seed simulated accounts", () => {
  it("is offered to an approver when a network lacks an account, and not when all three are there or the person cannot plan", () => {
    const { rerender } = render(<ClientAccounts engagementId="e1" read={{ kind: "ok", accounts: [acct("instagram")] }} canPlan />);
    expect(screen.getByRole("button", { name: "Seed simulated accounts" })).toBeEnabled();
    expect(screen.getByText(/Adds a simulated Facebook, TikTok accounts/)).toBeInTheDocument();
    rerender(<ClientAccounts engagementId="e1" read={{ kind: "ok", accounts: all }} canPlan />);
    expect(screen.queryByRole("button", { name: "Seed simulated accounts" })).toBeNull();
    rerender(<ClientAccounts engagementId="e1" read={{ kind: "ok", accounts: [] }} canPlan={false} />);
    expect(screen.queryByRole("button", { name: "Seed simulated accounts" })).toBeNull();
  });

  it("posts for this engagement, says what it added and that TikTok cannot publish yet, and refreshes", async () => {
    seed.mockResolvedValue({ ok: true, accounts: [
      { id: "1", network: "instagram", handle: "@mock-x", created: true, networkEnabled: true },
      { id: "2", network: "tiktok", handle: "@mock-x", created: true, networkEnabled: false },
    ] });
    render(<ClientAccounts engagementId="e-77" read={{ kind: "ok", accounts: [] }} canPlan />);
    fireEvent.click(screen.getByRole("button", { name: "Seed simulated accounts" }));
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    expect(seed).toHaveBeenCalledWith("e-77");
    expect(screen.getByRole("status")).toHaveTextContent("Seeded 2 simulated accounts.");
    expect(screen.getByRole("status")).toHaveTextContent(/TikTok cannot publish until the server's SOCIAL_NETWORKS_ENABLED names it/);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("says when everything was already there", async () => {
    seed.mockResolvedValue({ ok: true, accounts: [{ id: "1", network: "instagram", handle: "@mock-x", created: false, networkEnabled: true }] });
    render(<ClientAccounts engagementId="e1" read={{ kind: "ok", accounts: [] }} canPlan />);
    fireEvent.click(screen.getByRole("button", { name: "Seed simulated accounts" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("The simulated accounts were already there."));
  });

  it.each(["not_a_social_approver", "simulation_disabled", "account_exists_not_simulated"])("shows the refusal %s in words and does not refresh", async (code) => {
    seed.mockResolvedValue({ ok: false, error: code, message: seedRefusalText(code) });
    render(<ClientAccounts engagementId="e1" read={{ kind: "ok", accounts: [] }} canPlan />);
    fireEvent.click(screen.getByRole("button", { name: "Seed simulated accounts" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(seedRefusalText(code)));
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
