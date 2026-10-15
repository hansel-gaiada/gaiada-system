import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { me as meFixture, member } from "@/lib/workspaceFixtures";
import type { Me } from "@/lib/platform";
import type { Account } from "@/lib/finance";

// DW-7g-2: the Chart of accounts page reads the chart honestly (a refused or failed read is said as such, never "no chart") and
// draws the write controls for the people the server allows (company.manage, an elevated role, or a finance_manager grant in the
// company) and for nobody else. The table itself is `ChartOfAccounts` (tested on its own), mocked here to expose the props.
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("redirect"); }) }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(), PlatformError: class extends Error {} }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/finance-data", () => ({ listAccountsResult: vi.fn() }));
vi.mock("@/components/finance/ChartOfAccounts", () => ({
  ChartOfAccounts: ({ accounts, canEdit, query }: { accounts: Account[]; canEdit: boolean; query?: string }) => (
    <div data-testid="chart" data-can-edit={String(canEdit)} data-count={accounts.length} data-query={query ?? ""} />
  ),
}));

import { getMe } from "@/lib/platform";
import { listAccountsResult } from "@/lib/finance-data";
import FinanceAccountsPage from "./page";

const read = vi.mocked(listAccountsResult);
const acct = (over: Partial<Account> & Pick<Account, "code" | "name">): Account => ({
  accountType: "asset", normalBalance: "debit", isPostable: true, isControl: false, controlSubledger: null, allowManualPosting: true,
  status: "active", hasPostings: false, ...over,
});
const CHART = [
  acct({ code: "1120", name: "Bank" }),
  acct({ code: "1130", name: "Piutang", isControl: true, controlSubledger: "ar", allowManualPosting: false }),
  acct({ code: "6950", name: "Old", status: "archived" }),
];
const admin = meFixture([{ role: "company_admin", scopeType: "company", scopeId: "co-a" }]);
const manager = meFixture([{ role: "finance_manager", scopeType: "company", scopeId: "co-a" }]);
const managerElsewhere = meFixture([{ role: "finance_manager", scopeType: "company", scopeId: "co-b" }]);
const clerk = meFixture([{ role: "finance_staff", scopeType: "company", scopeId: "co-a" }]);
const staff = meFixture([member()]);
const operator = meFixture([{ role: "platform_admin", scopeType: "global", scopeId: null as unknown as string }]);
const mount = async (me: Me, sp: { q?: string } = {}) => {
  vi.mocked(getMe).mockResolvedValue(me);
  return render(await FinanceAccountsPage({ searchParams: Promise.resolve(sp) }));
};
const canEdit = () => screen.getByTestId("chart").getAttribute("data-can-edit");

beforeEach(() => { read.mockReset().mockResolvedValue({ kind: "ok", data: CHART }); });

describe("Chart of accounts page: who gets the controls", () => {
  it("a company admin, a finance manager of the company and the platform operator get them", async () => {
    for (const me of [admin, manager, operator]) {
      const view = await mount(me);
      expect(canEdit()).toBe("true");
      view.unmount();
    }
  });

  it("finance staff, a plain member and a finance manager of another company do not, but still get the chart", async () => {
    for (const me of [clerk, staff, managerElsewhere]) {
      const view = await mount(me);
      expect(canEdit()).toBe("false");
      expect(screen.getByTestId("chart").getAttribute("data-count")).toBe("3");
      view.unmount();
    }
  });
});

describe("Chart of accounts page: the read", () => {
  it("reads the active company's chart with the filter, passes the rows, and states the counts", async () => {
    await mount(admin, { q: "bank" });
    expect(read).toHaveBeenCalledWith("u-1", "co-a", "bank");
    expect(screen.getByTestId("chart").getAttribute("data-query")).toBe("bank");
    expect(screen.getByRole("heading", { name: "Chart of accounts" })).toBeInTheDocument();
    expect(screen.getByText(/3 accounts · 2 accept a manual journal/)).toBeInTheDocument();
    expect(screen.getByText(/1 archived/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Clear" })).toBeInTheDocument();
  });

  it("★ a refused read is said in words and draws no table, no controls and no 'no chart' claim", async () => {
    read.mockResolvedValue({ kind: "forbidden" });
    await mount(admin);
    expect(screen.getByText(/You don't have access to the chart of accounts/)).toBeInTheDocument();
    expect(screen.queryByTestId("chart")).toBeNull();
    expect(screen.queryByText(/no chart of accounts yet/)).toBeNull();
  });

  it("★ a failed read says it cannot tell, with the server's words, and is never an empty chart", async () => {
    read.mockResolvedValue({ kind: "unavailable", reason: "platform 503" });
    await mount(admin);
    expect(screen.getByText(/cannot be read right now/)).toHaveTextContent("this is not a statement that there is nothing here");
    expect(screen.getByText("platform 503")).toBeInTheDocument();
    expect(screen.queryByTestId("chart")).toBeNull();
  });
});
