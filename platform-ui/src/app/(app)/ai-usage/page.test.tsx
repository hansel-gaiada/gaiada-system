import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { UsageRead } from "@/lib/aiUsage-data";
import type { CompanyUsage } from "@/lib/aiUsage";
import { EMPTY_TOTALS, companyUsage } from "@/lib/aiUsageFixtures";
import { me as meFixture } from "@/lib/workspaceFixtures";

// AIP-16 (BFF section 66.5, owner ruling AIP-D18): the company's AI usage, Company area. Totals by surface, department, model and day; never a person.
// Each department line opens that department's month; "No department recorded" (the null bucket) and "Company, no person" (`noPerson`) are their own
// lines. A refusal is said as one, an empty month plainly, and the server decides who may read (the GM holds the read through a seat).
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("redirect"); }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...r }: { href: string; children?: React.ReactNode; prefetch?: boolean; scroll?: boolean }) => <a href={href} {...r}>{children}</a>,
}));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/platform", async () => {
  const actual = await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform");
  return { ...actual, getMe: vi.fn() };
});
vi.mock("@/lib/aiUsage-data", () => ({ getCompanyAiUsage: vi.fn() }));

import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getCompanyAiUsage } from "@/lib/aiUsage-data";
import CompanyAiUsagePage from "./page";

const readMock = vi.mocked(getCompanyAiUsage);
const ok = (data: CompanyUsage): UsageRead<CompanyUsage> => ({ kind: "ok", data });
const mount = async (sp: { month?: string } = {}) => render(await CompanyAiUsagePage({ searchParams: Promise.resolve(sp) }));
const card = (title: string) => screen.getByRole("heading", { name: new RegExp(`^${title}`) }).closest("section") as HTMLElement;
const cardTitles = () => [...document.querySelectorAll("section.lux-card h3")].map((h) => h.firstChild?.textContent);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
  vi.mocked(getMe).mockResolvedValue(meFixture([{ role: "company_admin", scopeType: "company", scopeId: "co-a" }]));
  vi.mocked(getActiveTenant).mockReset().mockResolvedValue("co-a");
  readMock.mockReset().mockResolvedValue(ok(companyUsage()));
});
afterEach(() => vi.useRealTimers());

describe("what is asked of the platform", () => {
  it("reads the current UTC month for the signed-in person in the active company, and passes a chosen month", async () => {
    await mount();
    expect(readMock).toHaveBeenCalledWith("u-1", "co-a", "2026-10");
    await mount({ month: "2026-09" });
    expect(readMock).toHaveBeenLastCalledWith("u-1", "co-a", "2026-09");
  });
  it("asks the server for anyone who opens the address: the server decides (the GM reads through a seat the UI cannot see)", async () => {
    vi.mocked(getMe).mockResolvedValue(meFixture([]));
    readMock.mockResolvedValue({ kind: "forbidden" });
    await mount();
    expect(readMock).toHaveBeenCalledTimes(1);
  });
  it("reads nothing, and says so, without an active company", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue(null as never);
    await mount();
    expect(screen.getByText("Select a company from the top bar.")).toBeInTheDocument();
    expect(readMock).not.toHaveBeenCalled();
  });
});

describe("the month", () => {
  it("is shown with the earlier month and keeps the company path in its links", async () => {
    await mount({ month: "2026-09" });
    const nav = screen.getByRole("navigation", { name: "Month" });
    expect(within(nav).getByRole("link", { name: /August 2026/ })).toHaveAttribute("href", "/ai-usage?month=2026-08");
    expect(within(nav).getByRole("link", { name: "This month" })).toHaveAttribute("href", "/ai-usage?month=2026-10");
  });
});

describe("what it shows", () => {
  it("leads with by surface, then the month total, the model, the departments and the no-person lines, and the days", async () => {
    await mount();
    expect(cardTitles()).toEqual(["By surface", "Month total", "By model", "By department", "Company, no person", "By day"]);
  });
  it("links each department line to that department's month, for the same month", async () => {
    await mount();
    const dept = within(card("By department"));
    expect(dept.getByRole("link", { name: "Web Dev" })).toHaveAttribute("href", "/analytics/ai-usage/department?unit=d-web&month=2026-10");
    expect(dept.getByRole("link", { name: "SEO" })).toHaveAttribute("href", "/analytics/ai-usage/department?unit=d-seo&month=2026-10");
  });
  it("shows the null bucket as 'No department recorded', its own line with no link and its unknown cost as unknown", async () => {
    await mount();
    const dept = within(card("By department"));
    expect(dept.queryByRole("link", { name: "No department recorded" })).not.toBeInTheDocument();
    const row = dept.getByText("No department recorded").closest(".lux-table__row") as HTMLElement;
    expect([...row.querySelectorAll(":scope > span")].map((c) => c.textContent)).toEqual(["No department recorded", "33", "1,000", "200", "unknown"]);
  });
  it("shows the 'Company, no person' lines by surface", async () => {
    await mount();
    const np = within(card("Company, no person"));
    expect(np.getByText("Knowledge (embedding and search)").closest(".lux-table__row")).toHaveTextContent("3,180");
  });
  it("draws no person anywhere: the company tier never sees one", async () => {
    await mount();
    expect(screen.queryByRole("heading", { name: /^By person/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Made Putra")).not.toBeInTheDocument();
  });
  it("leaves out the no-person section when the answer has no such line, and a department the tree no longer has is said so", async () => {
    readMock.mockResolvedValue(ok(companyUsage({ noPerson: [], byDepartment: [{ ...companyUsage().byDepartment[0], unitNodeId: "d-old", name: null }] })));
    await mount();
    expect(cardTitles()).not.toContain("Company, no person");
    expect(within(card("By department")).getByText("Department not in the organisation tree")).toBeInTheDocument();
  });
});

describe("an empty month, a refusal and a failed read", () => {
  it("says an empty month plainly", async () => {
    readMock.mockResolvedValue(ok(companyUsage({ month: "2026-07", totals: EMPTY_TOTALS, byDepartment: [], noPerson: [], bySurface: [], byModel: [], byDay: [] })));
    await mount({ month: "2026-07" });
    expect(screen.getByText("No AI use recorded in July 2026")).toBeInTheDocument();
    expect(cardTitles()).toEqual([]);
  });
  it("says a 403 as a refusal and points to the person's own use, never as an empty month", async () => {
    readMock.mockResolvedValue({ kind: "forbidden" });
    await mount();
    expect(screen.getByText(/You don't have access to the company's AI usage/)).toBeInTheDocument();
    expect(screen.getByText(/owner, the GM, company admins and the superadmin/)).toBeInTheDocument();
    expect(screen.queryByText(/No AI use recorded/)).not.toBeInTheDocument();
  });
  it("says a failed read cannot tell, with the reason", async () => {
    readMock.mockResolvedValue({ kind: "unavailable", reason: "upstream 502" });
    await mount();
    expect(screen.getByText(/cannot be read right now/)).toBeInTheDocument();
    expect(screen.getByText("upstream 502")).toBeInTheDocument();
  });
});
