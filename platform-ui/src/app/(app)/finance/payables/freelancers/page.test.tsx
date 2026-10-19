import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReadResult } from "@/lib/readResult";

// DW-10f-4b — the Freelancers page: ungated like Payables, one read per section, the period in the URL (default: last month), and a period the
// server would refuse is said and never sent.
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("redirect"); }), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => ({ userId: "u-1" })), PlatformError: class extends Error {} }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/format", async (orig) => ({ ...(await orig<typeof import("@/lib/format")>()), todayIsoInDisplayZone: () => "2026-10-19" }));
vi.mock("@/lib/finance", () => ({ listAccounts: vi.fn(), listApVendors: vi.fn() }));
vi.mock("@/lib/entities", () => ({ listMembers: vi.fn() }));
vi.mock("@/lib/freelancers-data", () => ({ listFreelancersResult: vi.fn(), listFreelancerBillsResult: vi.fn(), getFreelancerPreviewResult: vi.fn() }));
vi.mock("@/lib/freelancersActions", () => ({
  addRateAction: vi.fn(), endRateAction: vi.fn(), withdrawRateAction: vi.fn(), linkVendorAction: vi.fn(),
  draftBillAction: vi.fn(), draftAllReadyAction: vi.fn(), discardBillAction: vi.fn(),
}));
vi.mock("@/lib/stepUpActions", () => ({ getStepUpStatusAction: vi.fn(async () => null), simulateSecondFactorAction: vi.fn() }));

import { listAccounts, listApVendors } from "@/lib/finance";
import { listMembers } from "@/lib/entities";
import { getFreelancerPreviewResult, listFreelancerBillsResult, listFreelancersResult } from "@/lib/freelancers-data";
import FinanceFreelancersPage from "./page";

const rates = vi.mocked(listFreelancersResult);
const bills = vi.mocked(listFreelancerBillsResult);
const preview = vi.mocked(getFreelancerPreviewResult);

const okPreview = (): ReadResult<never> => ({ kind: "ok", data: { periodStart: "2026-09-01", periodEnd: "2026-09-30", freelancers: [] } as never });
const mount = async (sp: { from?: string | string[]; to?: string | string[] } = {}) =>
  render(await FinanceFreelancersPage({ searchParams: Promise.resolve(sp) }));

beforeEach(() => {
  rates.mockReset().mockResolvedValue({ kind: "ok", data: [] });
  bills.mockReset().mockResolvedValue({ kind: "ok", data: [] });
  preview.mockReset().mockResolvedValue(okPreview());
  vi.mocked(listMembers).mockReset().mockResolvedValue([{ user_id: "u-dev", name: "Made Putra", email: "made@gaiada.com", title: null }]);
  vi.mocked(listAccounts).mockReset().mockResolvedValue([
    { code: "6100", name: "Beban Gaji", accountType: "expense", isPostable: true, isControl: false, allowManualPosting: true, status: "active" },
    { code: "1120", name: "Bank", accountType: "asset", isPostable: true, isControl: false, allowManualPosting: true, status: "active" },
    { code: "6900", name: "Frozen", accountType: "expense", isPostable: true, isControl: false, allowManualPosting: true, status: "archived" },
  ] as never);
  vi.mocked(listApVendors).mockReset().mockResolvedValue([]);
});

describe("Finance > Payables > Freelancers page", () => {
  it("defaults the period to the whole of last month, reads each section once, and links back to Payables", async () => {
    await mount();
    expect(preview).toHaveBeenCalledWith("u-1", "co-a", "2026-09-01", "2026-09-30");
    expect(rates).toHaveBeenCalledTimes(1);
    expect(bills).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { level: 1, name: "Freelancers" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Payables" })).toHaveAttribute("href", "/finance/payables");
    expect(screen.getByLabelText("Period start")).toHaveValue("2026-09-01");
  });

  it("takes the period from the URL", async () => {
    await mount({ from: "2026-08-01", to: "2026-08-31" });
    expect(preview).toHaveBeenCalledWith("u-1", "co-a", "2026-08-01", "2026-08-31");
    expect(screen.getByLabelText("Period end")).toHaveValue("2026-08-31");
  });

  it("says a period the server would refuse and never sends it", async () => {
    await mount({ from: "2026-09-30", to: "2026-09-01" });
    expect(preview).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("The period ends before it starts.");
  });

  it("offers only live, postable expense accounts and the company's members in the add-a-rate form", async () => {
    await mount();
    const form = screen.getByRole("form", { name: "Add a rate" });
    expect(form).toHaveTextContent("6100 · Beban Gaji");
    expect(form).not.toHaveTextContent("1120");
    expect(form).not.toHaveTextContent("6900");
    expect(form).toHaveTextContent("Made Putra (made@gaiada.com)");
  });

  it("a refused rates read is said in its section and does not take the bills with it", async () => {
    rates.mockResolvedValue({ kind: "forbidden" });
    await mount();
    expect(screen.getByText(/You don.t have access to the freelancer rates/)).toBeInTheDocument();
    expect(screen.getByText(/No freelancer has unbilled hours/)).toBeInTheDocument();
  });
});
