import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// SCP-4b (BFF §63.11): /portal/approvals carries the "Boost budgets" section beside the deliveries. What is pinned: the section is read for a portal client only (never for staff, whom the
// portal refuses), it is ABSENT when nothing waits and there is no history, it is drawn from the read when there is either, a signer's and a viewer's controls follow `canDecide`, and a
// read that fails says so in one line (an approval that waits for the client must never read as "nothing to approve"). The deliveries part is the page's own and is pinned only by the lead.
vi.mock("next/navigation", () => ({ redirect: vi.fn((to: string) => { throw new Error(`redirect:${to}`); }), useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-client") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => ({ userId: "u-client" })) }));
vi.mock("@/lib/portal-company", () => ({ getActivePortalCompany: vi.fn(async () => ({ id: "co-agency" })) }));
vi.mock("@/lib/portal-data", () => ({ listPortalRuns: vi.fn() }));
vi.mock("@/lib/socialBoosts-data", () => ({ getPortalSpend: vi.fn() }));
vi.mock("@/lib/portalSpendActions", () => ({ decideBoost: vi.fn(), decideBoostBudget: vi.fn() }));
vi.mock("@/components/portal/PortalLive", () => ({ PortalLive: () => null }));

import { listPortalRuns } from "@/lib/portal-data";
import { getPortalSpend } from "@/lib/socialBoosts-data";
import { asPortalSpend, PORTAL_VIEWER_LINE, type PortalSpend } from "@/lib/socialBoosts";
import type { ReadResult } from "@/lib/readResult";
import PortalApprovalsPage from "./page";

const runs = vi.mocked(listPortalRuns);
const spend = vi.mocked(getPortalSpend);
const ok = (data: PortalSpend): ReadResult<PortalSpend> => ({ kind: "ok", data });
const withItems = (canDecide: boolean) => asPortalSpend({
  budgets: [{ proposalId: "pr-1", clientName: "Northwind Traders", month: "2026-11", amountMinor: 1_200_000, agreedMinor: 1_000_000, committedMinor: 500_000, currency: "IDR", minorUnit: 0, note: "More for the holiday.", requestedAt: "2026-10-15T02:00:00Z" }],
  boosts: [{ boostId: "b-1", clientName: "Northwind Traders", postTitle: "Reader favourite reshare", thumbFileId: "p-1-f1", totalBudgetMinor: 600_000, days: 6, startsOn: "2026-10-27", currency: "IDR", minorUnit: 0, remainingMinor: 500_000 }],
  history: [], canDecide,
});
const mount = async () => render(await PortalApprovalsPage());

beforeEach(() => {
  runs.mockReset().mockResolvedValue({ runs: [], isPortalClient: true });
  spend.mockReset().mockResolvedValue(ok(withItems(true)));
});

describe("the Boost budgets section", () => {
  it("is read for the signed-in contact in their company, and drawn when something waits", async () => {
    await mount();
    expect(spend).toHaveBeenCalledWith("u-client", "co-agency");
    expect(screen.getByRole("heading", { name: "Boost budgets" })).toBeInTheDocument();
    expect(screen.getByText("Boost budget for November 2026")).toBeInTheDocument();
    expect(screen.getByText("Reader favourite reshare")).toBeInTheDocument();
    // the deliveries part is untouched
    expect(screen.getByRole("heading", { name: "Approvals & sign-offs" })).toBeInTheDocument();
  });

  it("is ABSENT when nothing waits and there is no history", async () => {
    spend.mockResolvedValue(ok(asPortalSpend({ budgets: [], boosts: [], history: [], canDecide: true })));
    await mount();
    expect(screen.queryByRole("heading", { name: "Boost budgets" })).toBeNull();
    expect(screen.queryByText(/boost budgets could not be loaded/)).toBeNull();
  });

  it("is drawn for a history alone", async () => {
    spend.mockResolvedValue(ok(asPortalSpend({ budgets: [], boosts: [], history: [{ id: "h", kind: "budget", title: "October 2026 budget", status: "agreed", amountMinor: 1_000_000, decidedAt: "2026-10-01T00:00:00Z" }], canDecide: true })));
    await mount();
    expect(screen.getByRole("heading", { name: "Boost budgets" })).toBeInTheDocument();
    expect(screen.getByText("Nothing is waiting for your decision on boost budgets.")).toBeInTheDocument();
  });

  it("a signer gets the Agree, Approve and Decline controls; a viewer gets the items and the line that only a signer can decide", async () => {
    const a = await mount();
    expect(screen.getByRole("button", { name: "Agree to the Boost budget for November 2026" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve the boost of Reader favourite reshare" })).toBeInTheDocument();
    a.unmount();
    spend.mockResolvedValue(ok(withItems(false)));
    await mount();
    expect(screen.getByText("Reader favourite reshare")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(PORTAL_VIEWER_LINE);
    expect(screen.queryByRole("button", { name: /Agree|Approve|Decline/ })).toBeNull();
  });

  it("is not read for a staff member (the portal refuses them), who gets the teach-state of the deliveries", async () => {
    runs.mockResolvedValue({ runs: [], isPortalClient: false });
    await mount();
    expect(spend).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Boost budgets" })).toBeNull();
    expect(screen.getByText(/You're signed in as a staff member/)).toBeInTheDocument();
  });

  it("a read that failed says so in one line, and is not left out silently", async () => {
    spend.mockResolvedValue({ kind: "unavailable", reason: "platform 500" });
    await mount();
    expect(screen.getByText("The boost budgets could not be loaded just now. Reload the page to try again.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Boost budgets" })).toBeNull();
  });

  it("a refusal (403) leaves the section out, as it does for anyone the portal does not serve", async () => {
    spend.mockResolvedValue({ kind: "forbidden" });
    await mount();
    expect(screen.queryByRole("heading", { name: "Boost budgets" })).toBeNull();
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
  });
});
